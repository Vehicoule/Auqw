//! Seam-level tests: the registry's blocking-read bridge, lifecycle
//! transitions, startup sweep, and one real `ReqwestFetch` exchange
//! against an in-process HTTP/1.1 range server (127.0.0.1 only).
//!
//! `read` parks foreign threads — tests call it from `std::thread`,
//! never a runtime worker, matching the JNI contract.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use auqw_stream::{
    Fetch, FetchResponse, PreparedSource, Remint, ReqwestFetch, StreamConfig, StreamError,
    StreamRegistry,
};
use tokio_util::sync::CancellationToken;

fn unique() -> u64 {
    static N: AtomicU32 = AtomicU32::new(0);
    N.fetch_add(1, Ordering::Relaxed).into()
}

struct TestDir(std::path::PathBuf);

impl TestDir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "auqw-stream-seam-{tag}-{}-{}",
            std::process::id(),
            unique()
        ));
        std::fs::create_dir_all(&p)
            .map(|_| Self(p))
            .unwrap_or_else(|e| panic!("mkdir {e}"))
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn config(dir: &TestDir) -> StreamConfig {
    let mut c = StreamConfig::new(dir.0.clone());
    c.chunk_bytes = 128;
    c.head_bytes = 256;
    c.read_ahead = 512;
    c.stall = Duration::from_millis(300);
    // Backstop, not the mechanism under test: tests that assert a woken
    // outcome must never lose to the deadline on a slow CI — the tests
    // that exercise the deadline itself set it explicitly.
    c.read_deadline = Duration::from_secs(5);
    c.prepare_ttl = Duration::from_secs(60);
    c
}

fn source(len: u64) -> PreparedSource {
    PreparedSource {
        url: "https://signed.example/s?sig=SECRET".into(),
        mime: "audio/mp4".into(),
        itag: Some(140),
        bitrate_kbps: Some(129),
        content_length: Some(len),
        expires_at_ms: None,
        source_ref: "vid".into(),
        provider: "test".into(),
    }
}

/// `Result::unwrap_err` without the denied method.
fn err_of<T>(r: Result<T, StreamError>) -> StreamError {
    match r {
        Err(e) => e,
        Ok(_) => panic!("expected Err"),
    }
}

struct NeverRemint;

impl Remint for NeverRemint {
    fn remint(&self) -> Pin<Box<dyn Future<Output = Result<PreparedSource, StreamError>> + Send>> {
        Box::pin(std::future::pending())
    }
}

/// A re-mint that counts calls and yields a fresh source — the
/// registry-level counterpart of the pump tests' `CountingRemint`.
struct OkRemint {
    calls: AtomicU32,
}

impl Remint for OkRemint {
    fn remint(&self) -> Pin<Box<dyn Future<Output = Result<PreparedSource, StreamError>> + Send>> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Box::pin(async { Ok(source(1024)) })
    }
}

/// What the fake answers for one request.
enum Step {
    Reply(FetchResponse),
    /// Fail with the typed error (transient-stall scripts).
    Fail(StreamError),
    /// Park forever — the request is still recorded.
    Hang,
}

/// Offset-keyed fetch: `pages` maps a requested offset to a queue of
/// replies (queue length covers re-mint retry sequences); anything
/// unscripted hangs. `in_flight` counts requests actually issued so
/// tests can wait for the pump to be inside a fetch. `urls` parallels
/// `requests` — cross-session tests cannot tell two sessions apart by
/// offset alone.
struct MapFetch {
    pages: Mutex<HashMap<u64, VecDeque<Step>>>,
    requests: Mutex<Vec<(u64, u64)>>,
    urls: Mutex<Vec<String>>,
    in_flight: AtomicU32,
}

impl MapFetch {
    fn new(pages: HashMap<u64, VecDeque<Step>>) -> Self {
        Self {
            pages: Mutex::new(pages),
            requests: Mutex::new(Vec::new()),
            urls: Mutex::new(Vec::new()),
            in_flight: AtomicU32::new(0),
        }
    }

    fn issued(&self, offset: u64) -> bool {
        self.requests
            .lock()
            .map(|r| r.iter().any(|(o, _)| *o == offset))
            .unwrap_or(false)
    }

    fn count_at(&self, offset: u64) -> usize {
        self.requests
            .lock()
            .map(|r| r.iter().filter(|(o, _)| *o == offset).count())
            .unwrap_or(0)
    }

    fn count_url(&self, url: &str) -> usize {
        self.urls
            .lock()
            .map(|u| u.iter().filter(|s| s.as_str() == url).count())
            .unwrap_or(0)
    }

    /// Queue another reply for `offset` — tests script the recovery
    /// fetch after a stall has been observed.
    fn push(&self, offset: u64, step: Step) {
        if let Ok(mut p) = self.pages.lock() {
            p.entry(offset).or_default().push_back(step);
        }
    }
}

impl Fetch for MapFetch {
    fn get_range<'a>(
        &'a self,
        url: &'a str,
        offset: u64,
        max_len: u64,
        _stall: Duration,
        _deadline: Duration,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<FetchResponse, StreamError>> + Send + 'a>> {
        if let Ok(mut r) = self.requests.lock() {
            r.push((offset, max_len));
        }
        if let Ok(mut u) = self.urls.lock() {
            u.push(url.to_string());
        }
        let step = self
            .pages
            .lock()
            .ok()
            .and_then(|mut p| p.get_mut(&offset).and_then(VecDeque::pop_front))
            .unwrap_or(Step::Hang);
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move {
            match step {
                Step::Reply(r) => Ok(r),
                Step::Fail(e) => Err(e),
                Step::Hang => std::future::pending().await,
            }
        })
    }
}

fn chunk(offset: u64, len: u64, total: u64, byte: u8) -> FetchResponse {
    FetchResponse {
        status: 206,
        content_range: Some(format!("bytes {}-{}/{}", offset, offset + len - 1, total)),
        body: vec![byte; usize::try_from(len).unwrap_or(0)],
    }
}

async fn wait_until(pred: impl Fn() -> bool) {
    for _ in 0..400 {
        if pred() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition never reached");
}

fn head_ready(reg: &StreamRegistry, handle: &str) -> bool {
    reg.phase_marks(handle)
        .map(|m| m.head_ready_ms.is_some())
        .unwrap_or(false)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attach_returns_remaining_length() {
    let d = TestDir::new("remaining");
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let info = reg
        .prepare(source(1000), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"));
    assert_eq!(
        reg.attach(&info.handle, 300)
            .unwrap_or_else(|e| panic!("attach: {e}")),
        Some(700)
    );
    // Re-attach at a new position is allowed (DataSource reopen).
    assert_eq!(
        reg.attach(&info.handle, 0)
            .unwrap_or_else(|e| panic!("attach: {e}")),
        Some(1000)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_serves_prepared_head_bytes() {
    let d = TestDir::new("headread");
    let mut pages = HashMap::new();
    pages.insert(0u64, VecDeque::from([Step::Reply(chunk(0, 128, 1024, 1))]));
    pages.insert(
        128u64,
        VecDeque::from([Step::Reply(chunk(128, 128, 1024, 2))]),
    );
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(pages)),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    wait_until(|| head_ready(&reg, &h)).await;
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    let got = std::thread::scope(|s| {
        s.spawn(|| reg.read(&h, 0, 64))
            .join()
            .unwrap_or_else(|e| panic!("join: {e:?}"))
    })
    .unwrap_or_else(|e| panic!("read: {e}"));
    assert_eq!(got, vec![1u8; 64]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blocked_read_wakes_into_release() {
    let d = TestDir::new("wakerelease");
    let fetch = Arc::new(MapFetch::new(HashMap::new())); // every fetch hangs
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::clone(&fetch) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    std::thread::scope(|s| {
        let t = s.spawn(|| reg.read(&h, 0, 64));
        // The reader registers its fetch-through then parks; once the
        // pump is inside the hung request the reader is parked.
        wait_until_blocking(|| fetch.issued(0));
        reg.release(&h).unwrap_or_else(|e| panic!("release: {e}"));
        let e = err_of(t.join().unwrap_or_else(|e| panic!("join: {e:?}")));
        assert_eq!(e.kind(), "released", "{e}");
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blocked_read_wakes_into_cancel() {
    let d = TestDir::new("wakecancel");
    let fetch = Arc::new(MapFetch::new(HashMap::new()));
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::clone(&fetch) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    std::thread::scope(|s| {
        let t = s.spawn(|| reg.read(&h, 0, 64));
        wait_until_blocking(|| fetch.issued(0));
        reg.cancel(&h).unwrap_or_else(|e| panic!("cancel: {e}"));
        let e = err_of(t.join().unwrap_or_else(|e| panic!("join: {e:?}")));
        assert_eq!(e.kind(), "cancelled", "{e}");
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn new_prepare_supersedes_unattached_reader() {
    let d = TestDir::new("supersede");
    let fetch = Arc::new(MapFetch::new(HashMap::new()));
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::clone(&fetch) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let a = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    // A parked read on the *unattached* session unwinds with Superseded.
    std::thread::scope(|s| {
        let t = s.spawn(|| reg.read(&a, 0, 64));
        wait_until_blocking(|| fetch.issued(0));
        let mut sb = source(1024);
        sb.source_ref = "b".into(); // same-ref prepares coalesce instead
        let b = reg
            .prepare(sb, Arc::new(NeverRemint))
            .unwrap_or_else(|e| panic!("prepare: {e}"));
        let e = err_of(t.join().unwrap_or_else(|e| panic!("join: {e:?}")));
        assert_eq!(e.kind(), "superseded", "{e}");
        // The partial file is evicted.
        assert!(!d.0.join(format!("{a}.bin")).exists(), "partial file kept");
        // A's handle is gone — later calls report the terminal kind or
        // not-found, never success.
        assert!(reg.attach(&a, 0).is_err());
        let _ = b.handle;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attached_session_is_exempt_from_supersede() {
    let d = TestDir::new("exempt");
    let fetch = Arc::new(MapFetch::new(HashMap::new()));
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::clone(&fetch) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let a = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.attach(&a, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    std::thread::scope(|s| {
        let t = s.spawn(|| reg.read(&a, 0, 64));
        wait_until_blocking(|| fetch.issued(0));
        let mut sb = source(1024);
        sb.source_ref = "b".into();
        let _b = reg
            .prepare(sb, Arc::new(NeverRemint))
            .unwrap_or_else(|e| panic!("prepare: {e}"));
        // Attached A survives; release wakes its parked reader.
        reg.release(&a).unwrap_or_else(|e| panic!("release: {e}"));
        let e = err_of(t.join().unwrap_or_else(|e| panic!("join: {e:?}")));
        assert_eq!(e.kind(), "released", "{e}");
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expired_source_fails_attach() {
    let d = TestDir::new("expired");
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let mut src = source(1024);
    src.expires_at_ms = Some(1); // long past any margin
    let h = reg
        .prepare(src, Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    let e = err_of(reg.attach(&h, 0));
    assert_eq!(e.kind(), "expired", "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_deadline_is_a_named_bound() {
    let d = TestDir::new("deadline");
    let fetch = Arc::new(MapFetch::new(HashMap::new()));
    let mut c = config(&d);
    c.read_deadline = Duration::from_millis(400);
    let reg = StreamRegistry::with_fetch(
        c,
        tokio::runtime::Handle::current(),
        Arc::clone(&fetch) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    let t0 = std::time::Instant::now();
    let e = err_of(
        std::thread::scope(|s| s.spawn(|| reg.read(&h, 0, 64)).join())
            .unwrap_or_else(|e| panic!("join: {e:?}")),
    );
    assert_eq!(e.kind(), "transient", "{e}");
    assert!(t0.elapsed() >= Duration::from_millis(350), "too fast");
    assert!(t0.elapsed() < Duration::from_secs(5), "too slow");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_at_known_end_is_eof() {
    let d = TestDir::new("eofread");
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(100), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    let got = std::thread::scope(|s| s.spawn(|| reg.read(&h, 100, 64)).join())
        .unwrap_or_else(|e| panic!("join: {e:?}"))
        .unwrap_or_else(|e| panic!("read: {e}"));
    assert!(got.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fetch_through_serves_seek_beyond_head() {
    let d = TestDir::new("through");
    let mut pages = HashMap::new();
    pages.insert(0u64, VecDeque::from([Step::Reply(chunk(0, 128, 1024, 1))]));
    pages.insert(
        128u64,
        VecDeque::from([Step::Reply(chunk(128, 128, 1024, 2))]),
    );
    pages.insert(
        500u64,
        VecDeque::from([Step::Reply(chunk(500, 128, 1024, 9))]),
    );
    let fetch = Arc::new(MapFetch::new(pages));
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::clone(&fetch) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    wait_until(|| head_ready(&reg, &h)).await;
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    let got = std::thread::scope(|s| s.spawn(|| reg.read(&h, 500, 128)).join())
        .unwrap_or_else(|e| panic!("join: {e:?}"))
        .unwrap_or_else(|e| panic!("read: {e}"));
    assert_eq!(got, vec![9u8; 128]);
    assert!(fetch.issued(500));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn release_is_idempotent_and_unknown_handles_are_safe() {
    let d = TestDir::new("idem");
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    reg.release("nope")
        .unwrap_or_else(|e| panic!("release: {e}"));
    reg.cancel("nope").unwrap_or_else(|e| panic!("cancel: {e}"));
    assert_eq!(err_of(reg.read("nope", 0, 1)).kind(), "not-found");
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.release(&h).unwrap_or_else(|e| panic!("release: {e}"));
    reg.release(&h).unwrap_or_else(|e| panic!("release2: {e}"));
    // Terminal sessions still answer phase_marks for diagnostics.
    assert!(reg.phase_marks(&h).is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn empty_url_is_rejected() {
    let d = TestDir::new("emptyurl");
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let mut src = source(1);
    src.url.clear();
    let e = err_of(reg.prepare(src, Arc::new(NeverRemint)));
    assert_eq!(e.kind(), "invalid-response", "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_detaches_and_prepare_supersedes() {
    let d = TestDir::new("close");
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let a = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.attach(&a, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    reg.close(&a).unwrap_or_else(|e| panic!("close: {e}"));
    // Closed sessions are unattached again — a different-source prepare
    // supersedes (a same-source one would coalesce onto the live handle).
    let mut sb = source(1024);
    sb.source_ref = "b".into();
    let _b = reg
        .prepare(sb, Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"));
    assert!(reg.attach(&a, 0).is_err());
    assert_eq!(err_of(reg.read("missing", 0, 1)).kind(), "not-found");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sweep_evicts_valid_corrupt_and_orphan_leftovers() {
    let d = TestDir::new("sweep");
    std::fs::write(d.0.join("a.bin"), b"data").unwrap_or_else(|e| panic!("w: {e}"));
    std::fs::write(
        d.0.join("a.json"),
        br#"{"source_ref":"v","mime":"m","extents":[[0,4]]}"#,
    )
    .unwrap_or_else(|e| panic!("w: {e}"));
    std::fs::write(d.0.join("b.bin"), b"data").unwrap_or_else(|e| panic!("w: {e}"));
    std::fs::write(d.0.join("b.json"), b"{corrupt").unwrap_or_else(|e| panic!("w: {e}"));
    std::fs::write(d.0.join("c.bin"), b"orphan").unwrap_or_else(|e| panic!("w: {e}"));
    std::fs::write(d.0.join("d.json.tmp"), b"x").unwrap_or_else(|e| panic!("w: {e}"));
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let report = reg.sweep_report();
    assert_eq!(report.evicted, 3, "{report:?}"); // a pair, c.bin, d.tmp
    assert_eq!(report.corrupt, 1, "{report:?}"); // b
    assert_eq!(reg.swept(), 4);
    for f in ["a.bin", "a.json", "b.bin", "b.json", "c.bin", "d.json.tmp"] {
        assert!(!d.0.join(f).exists(), "{f} still present");
    }
}

/// Poll a predicate from a non-async context (scoped reader threads).
fn wait_until_blocking(pred: impl Fn() -> bool) {
    for _ in 0..400 {
        if pred() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("condition never reached");
}

// ---------- real transport over an in-process HTTP/1.1 server ----------

/// Serve one request per connection: parse `Range: bytes=A-B` and
/// answer a strict `206` slice of `data`.
fn serve_ranges(listener: TcpListener, data: Arc<Vec<u8>>) {
    for conn in listener.incoming() {
        let Ok(mut sock) = conn else { break };
        let data = Arc::clone(&data);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(match sock.try_clone() {
                Ok(s) => s,
                Err(_) => return,
            });
            let mut line = String::new();
            let mut range = None;
            loop {
                line.clear();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                let l = line.trim();
                if l.is_empty() {
                    break;
                }
                if let Some(v) = l.to_ascii_lowercase().strip_prefix("range:") {
                    range = v.trim().strip_prefix("bytes=").and_then(|r| {
                        let (a, b) = r.split_once('-')?;
                        Some((a.parse::<u64>().ok()?, b.parse::<u64>().ok()?))
                    });
                }
            }
            let Some((start, end)) = range else { return };
            let total = data.len() as u64;
            let end = end.min(total - 1);
            let body =
                &data[usize::try_from(start).unwrap_or(0)..usize::try_from(end + 1).unwrap_or(0)];
            let head = format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes());
            let _ = sock.write_all(body);
            let _ = sock.flush();
        });
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reqwest_fetch_round_trip_through_registry() {
    let data: Vec<u8> = (0..2048u32).map(|i| (i % 251) as u8).collect();
    let data = Arc::new(data);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("bind: {e}"));
    let port = listener
        .local_addr()
        .unwrap_or_else(|e| panic!("addr: {e}"))
        .port();
    let serving = Arc::clone(&data);
    std::thread::spawn(move || serve_ranges(listener, serving));

    let d = TestDir::new("real");
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(ReqwestFetch::new().unwrap_or_else(|e| panic!("fetch: {e}"))),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let mut src = source(2048);
    src.url = format!("http://127.0.0.1:{port}/track");
    let h = reg
        .prepare(src, Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    wait_until(|| head_ready(&reg, &h)).await;
    assert_eq!(
        reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}")),
        Some(2048)
    );
    let got = std::thread::scope(|s| s.spawn(|| reg.read(&h, 100, 64)).join())
        .unwrap_or_else(|e| panic!("join: {e:?}"))
        .unwrap_or_else(|e| panic!("read: {e}"));
    assert_eq!(got, data[100..164].to_vec());
    let marks = reg.phase_marks(&h).unwrap_or_else(|e| panic!("marks: {e}"));
    assert!(marks.first_byte_ms.is_some());
    assert!(marks.head_ready_ms.is_some());
    assert!(marks.attach_ms.is_some());
}

// ---------- prepare policy, lifecycle, and pool priority ----------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_prepare_coalesces_to_the_live_handle() {
    let d = TestDir::new("coalesce");
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let a = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"));
    let b = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"));
    assert_eq!(a.handle, b.handle, "same source_ref must coalesce");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn racing_prepares_leave_one_unattached_session() {
    let d = TestDir::new("racing");
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let mut sa = source(1024);
    sa.source_ref = "a".into();
    let mut sb = source(1024);
    sb.source_ref = "b".into();
    let (ha, hb) = std::thread::scope(|s| {
        let ta = s.spawn(|| {
            reg.prepare(sa, Arc::new(NeverRemint))
                .unwrap_or_else(|e| panic!("prepare a: {e}"))
                .handle
        });
        let tb = s.spawn(|| {
            reg.prepare(sb, Arc::new(NeverRemint))
                .unwrap_or_else(|e| panic!("prepare b: {e}"))
                .handle
        });
        (
            ta.join().unwrap_or_else(|e| panic!("join a: {e:?}")),
            tb.join().unwrap_or_else(|e| panic!("join b: {e:?}")),
        )
    });
    // The serialized supersede means exactly one of the two handles is
    // already dead — never two live unattached sessions.
    let outcomes: Vec<Result<Option<u64>, StreamError>> =
        [ha, hb].iter().map(|h| reg.attach(h, 0)).collect();
    let superseded = outcomes
        .iter()
        .filter(|r| matches!(r, Err(e) if e.kind() == "superseded"))
        .count();
    let live = outcomes.iter().filter(|r| r.is_ok()).count();
    assert_eq!((superseded, live), (1, 1), "{outcomes:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoned_prepare_is_evicted_by_the_reaper() {
    let d = TestDir::new("ttl");
    let mut c = config(&d);
    c.prepare_ttl = Duration::from_millis(10);
    c.reap_interval = Duration::from_millis(10);
    let reg = StreamRegistry::with_fetch(
        c,
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let e = err_of(reg.read(&h, 0, 1));
    assert_eq!(e.kind(), "evicted", "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attached_session_is_exempt_from_the_reaper() {
    let d = TestDir::new("ttlattached");
    let mut c = config(&d);
    c.prepare_ttl = Duration::from_millis(10);
    c.reap_interval = Duration::from_millis(10);
    let reg = StreamRegistry::with_fetch(
        c,
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    reg.attach(&h, 0)
        .unwrap_or_else(|e| panic!("attached session reaped: {e}"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_cancels_sessions_and_blocks_prepare() {
    let d = TestDir::new("shutdown");
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.shutdown();
    let e = err_of(reg.read(&h, 0, 1));
    assert_eq!(e.kind(), "cancelled", "{e}");
    let e = err_of(reg.prepare(source(1024), Arc::new(NeverRemint)));
    assert_eq!(e.kind(), "cancelled", "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_wakes_a_parked_reader() {
    let d = TestDir::new("closewake");
    let fetch = Arc::new(MapFetch::new(HashMap::new())); // fetches hang
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::clone(&fetch) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    std::thread::scope(|s| {
        // Offset 900 is outside the attached fill window — only the
        // reader's demand queues it, so `issued(900)` proves the read
        // is in flight.
        let t = s.spawn(|| reg.read(&h, 900, 64));
        wait_until_blocking(|| fetch.issued(900));
        // The owning DataSource closed: the in-flight read must not
        // wait out its deadline.
        reg.close(&h).unwrap_or_else(|e| panic!("close: {e}"));
        let e = err_of(t.join().unwrap_or_else(|e| panic!("join: {e:?}")));
        assert_eq!(e.kind(), "cancelled", "{e}");
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_if_unattached_leaves_attached_sessions_alone() {
    let d = TestDir::new("cancelif");
    let fetch = Arc::new(MapFetch::new(HashMap::new()));
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::clone(&fetch) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    // The intent-flip path must not kill a playing consumer.
    reg.cancel_if_unattached(&h)
        .unwrap_or_else(|e| panic!("cancel_if_unattached: {e}"));
    reg.attach(&h, 0)
        .unwrap_or_else(|e| panic!("attached session was cancelled: {e}"));
    reg.release(&h).unwrap_or_else(|e| panic!("release: {e}"));

    let h2 = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare2: {e}"))
        .handle;
    reg.cancel_if_unattached(&h2)
        .unwrap_or_else(|e| panic!("cancel_if_unattached2: {e}"));
    let e = err_of(reg.read(&h2, 0, 1));
    assert_eq!(e.kind(), "cancelled", "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hung_remint_is_bounded_by_mint_deadline() {
    let d = TestDir::new("mintdeadline");
    let mut c = config(&d);
    c.mint_deadline = Duration::from_millis(50);
    let mut pages = HashMap::new();
    pages.insert(
        0u64,
        VecDeque::from([Step::Reply(FetchResponse {
            status: 403,
            content_range: None,
            body: vec![],
        })]),
    );
    let reg = StreamRegistry::with_fetch(
        c,
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(pages)),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    let e = err_of(
        std::thread::scope(|s| s.spawn(|| reg.read(&h, 0, 64)).join())
            .unwrap_or_else(|e| panic!("join: {e:?}")),
    );
    assert_eq!(e.kind(), "transient", "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_mime_fails_prepare() {
    let d = TestDir::new("badmime");
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    for bad in ["", "not-a-mime", "audio/", "/mp4", "audio/ mp4"] {
        let mut src = source(1024);
        src.mime = bad.into();
        let e = err_of(reg.prepare(src, Arc::new(NeverRemint)));
        assert_eq!(e.kind(), "invalid-response", "mime {bad:?}: {e}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_content_range_never_echoes_server_text() {
    let d = TestDir::new("crredact");
    let mut pages = HashMap::new();
    // The server answers a 206 whose Content-Range embeds the signed
    // request — the error must carry structure, never the raw value.
    // Two replies are scripted: a demand read may preempt the in-flight
    // speculative fetch, whose already-issued reply is then discarded —
    // the fetch-through re-issues and must get the same malformed
    // answer, or the outcome depends on the decide order.
    let malformed = || {
        Step::Reply(FetchResponse {
            status: 206,
            content_range: Some("bytes sig=SECRET-echo/9".into()),
            body: vec![1u8],
        })
    };
    pages.insert(0u64, VecDeque::from([malformed(), malformed()]));
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(pages)),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    let e = err_of(
        std::thread::scope(|s| s.spawn(|| reg.read(&h, 0, 64)).join())
            .unwrap_or_else(|e| panic!("join: {e:?}")),
    );
    assert_eq!(e.kind(), "invalid-response", "{e}");
    assert!(!e.to_string().contains("SECRET"), "{e}");
}

/// A double-`416` confirms the resource ends below the demand offset:
/// the reader gets EOF, later reads above the ceiling are EOF too,
/// and the pruned demand position is never refetched (the remint-storm
/// regression at seam level).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn eof_ceiling_serves_reads_and_prunes_demand() {
    let d = TestDir::new("eofdemand");
    let mut pages = HashMap::new();
    pages.insert(
        900u64,
        VecDeque::from([
            Step::Reply(FetchResponse {
                status: 416,
                content_range: Some("bytes */1024".into()),
                body: vec![],
            }),
            Step::Reply(FetchResponse {
                status: 416,
                content_range: Some("bytes */1024".into()),
                body: vec![],
            }),
        ]),
    );
    let fetch = Arc::new(MapFetch::new(pages));
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::clone(&fetch) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let mut src = source(4096); // the hint lies: real length is 1024
    src.content_length = None;
    let h = reg
        .prepare(
            src,
            Arc::new(OkRemint {
                calls: AtomicU32::new(0),
            }),
        )
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    let got = std::thread::scope(|s| s.spawn(|| reg.read(&h, 900, 64)).join())
        .unwrap_or_else(|e| panic!("join: {e:?}"))
        .unwrap_or_else(|e| panic!("read: {e}"));
    assert!(got.is_empty(), "expected EOF, got {} bytes", got.len());
    // Reads above the ceiling are EOF without another fetch.
    let got = std::thread::scope(|s| s.spawn(|| reg.read(&h, 950, 64)).join())
        .unwrap_or_else(|e| panic!("join: {e:?}"))
        .unwrap_or_else(|e| panic!("read: {e}"));
    assert!(got.is_empty());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        fetch.count_at(900),
        2,
        "demand position refetched past the EOF ceiling"
    );
    assert_eq!(fetch.count_at(950), 0);
}

/// Cross-session priority: while an attached session's demand read is
/// in flight, another session's speculative head-fill must not issue
/// requests — it parks on the shared pool until demand drains.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn speculative_fill_yields_to_demand_across_sessions() {
    const A_URL: &str = "https://a.example/s";
    const B_URL: &str = "https://b.example/s";
    let d = TestDir::new("poolyield");
    let fetch = Arc::new(MapFetch::new(HashMap::new())); // fetches hang
                                                         // A's demand must outlive the whole yield window — a read deadline
                                                         // expiring mid-test would dequeue it legitimately.
    let mut c = config(&d);
    c.read_deadline = Duration::from_secs(30);
    let reg = StreamRegistry::with_fetch(
        c,
        tokio::runtime::Handle::current(),
        Arc::clone(&fetch) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let mut sa = source(1024);
    sa.source_ref = "a".into();
    sa.url = A_URL.into();
    let a = reg
        .prepare(sa, Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare a: {e}"))
        .handle;
    reg.attach(&a, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    std::thread::scope(|s| {
        let _reader = s.spawn(|| reg.read(&a, 900, 64));
        wait_until_blocking(|| fetch.issued(900));
        // The demand position stays queued for the whole window: the
        // hung fetch never commits, so nothing dequeues it before the
        // cancel below. Offsets alone cannot separate A's requests
        // from B's — B carries its own url, so a policy violation is
        // observable as a request issued with B's url, nothing else.
        let mut sb = source(1024);
        sb.source_ref = "b".into();
        sb.url = B_URL.into();
        let b = reg
            .prepare(sb, Arc::new(NeverRemint))
            .unwrap_or_else(|e| panic!("prepare b: {e}"));
        // Give B's pump ample time to run its decide. Whether it parked
        // on the queued demand or has not been scheduled yet, it must
        // not have issued a request.
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(
            fetch.count_url(B_URL),
            0,
            "B's speculative fill ran while demand was queued"
        );
        // A's session ending drains the demand: B's parked fill must
        // resume — this leg exercises the `drained` wakeup path.
        reg.cancel(&a).unwrap_or_else(|e| panic!("cancel a: {e}"));
        wait_until_blocking(|| fetch.count_url(B_URL) > 0);
        reg.cancel(&b.handle)
            .unwrap_or_else(|e| panic!("cancel b: {e}"));
    });
}

/// Two readers parked on the same hole share one refcounted demand
/// entry: when the first read's deadline drops its hold, the position
/// must stay queued — the surviving reader's demand is still real, and
/// another session's speculative fill must not slip into the gap.
/// Only the last departing holder dequeues it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_reader_keeps_siblings_demand_visible() {
    const B_URL: &str = "https://b.example/s";
    let d = TestDir::new("tworeader");
    let mut pages: HashMap<u64, VecDeque<Step>> = HashMap::new();
    pages.insert(900, VecDeque::from(vec![Step::Hang]));
    let fetch = Arc::new(MapFetch::new(pages));
    // Reader 1's deadline lands 600ms in; reader 2's ~300ms later —
    // the window between them is where the refcount is proven.
    let mut c = config(&d);
    c.read_deadline = Duration::from_millis(600);
    let reg = StreamRegistry::with_fetch(
        c,
        tokio::runtime::Handle::current(),
        Arc::clone(&fetch) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    std::thread::scope(|s| {
        let r1 = s.spawn(|| reg.read(&h, 900, 64));
        wait_until_blocking(|| fetch.issued(900));
        // Reader 2 joins the same hole while the through-fetch is hung;
        // the shared entry's count becomes two.
        std::thread::sleep(Duration::from_millis(300));
        let r2 = s.spawn(|| reg.read(&h, 900, 64));
        // Session B's speculative fill must yield while *any* demand
        // holds position 900 — reader 1's deadline drops one count but
        // reader 2's keeps the position queued.
        let mut sb = source(1024);
        sb.source_ref = "b".into();
        sb.url = B_URL.into();
        let b = reg
            .prepare(sb, Arc::new(NeverRemint))
            .unwrap_or_else(|e| panic!("prepare b: {e}"));
        // Reader 1 hits its deadline: its hold drops, reader 2's holds.
        let e = err_of(r1.join().unwrap_or_else(|e| panic!("join r1: {e:?}")));
        assert_eq!(e.kind(), "transient", "{e}");
        // Inside the ~300ms before reader 2's own deadline, B's fill
        // must still be parked — the demand is not drained.
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(
            fetch.count_url(B_URL),
            0,
            "B's fill ran while reader 2 still held the demand position"
        );
        // The last holder's deadline dequeues the position — demand
        // drains for real and B's fill resumes.
        let e = err_of(r2.join().unwrap_or_else(|e| panic!("join r2: {e:?}")));
        assert_eq!(e.kind(), "transient", "{e}");
        wait_until_blocking(|| fetch.count_url(B_URL) > 0);
        reg.cancel(&b.handle)
            .unwrap_or_else(|e| panic!("cancel b: {e}"));
    });
}

/// Coalescing keys on (provider, source_ref): a different provider
/// answering the same ref mints a different URL/mime — it must never
/// inherit the first session, and the supersede list must name the
/// ended handle so routing maps can drop it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prepare_coalescing_requires_same_provider() {
    let d = TestDir::new("procoalesce");
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let mut a = source(1024);
    a.provider = "provider-a".into();
    let first = reg
        .prepare(a, Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"));
    // Same provider, same ref: the repeated intent coalesces.
    let mut again_src = source(1024);
    again_src.provider = "provider-a".into();
    let again = reg
        .prepare(again_src, Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("reprepare: {e}"));
    assert_eq!(again.handle, first.handle, "same provider+ref coalesces");
    assert!(
        again.superseded.is_empty(),
        "a coalesced prepare ends nothing: {:?}",
        again.superseded
    );
    // A different provider, same ref: a new session, and the old one
    // is named on the supersede list.
    let mut b = source(1024);
    b.provider = "provider-b".into();
    b.mime = "audio/webm".into();
    let second = reg
        .prepare(b, Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare b: {e}"));
    assert_ne!(
        second.handle, first.handle,
        "provider B must not coalesce onto A's session"
    );
    assert!(
        second.superseded.contains(&first.handle),
        "superseded list must name A's handle: {:?}",
        second.superseded
    );
    // And A's ended session answers attach with its typed error.
    assert_eq!(err_of(reg.attach(&first.handle, 0)).kind(), "superseded");
}

/// The named read bound must outlive the recovery path a parked read
/// waits on: one re-mint plus one bounded fetch attempt. A shorter
/// deadline would surface cap death to the player as `transient`.
#[test]
fn read_deadline_covers_mint_plus_fetch() {
    let c = StreamConfig::new(std::path::PathBuf::from("/nonexistent-auqw-test"));
    assert!(
        c.read_deadline > c.mint_deadline + c.request_deadline,
        "read_deadline {:?} must exceed mint {:?} + request {:?}",
        c.read_deadline,
        c.mint_deadline,
        c.request_deadline
    );
}

/// A retriable failure latches instead of killing the session: the
/// parked reader observes `transient` once, and the next read's
/// demand re-drives the pump to a successful fetch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_pump_surfaces_transient_once_then_demand_recovers() {
    let d = TestDir::new("stallread");
    let mut pages: HashMap<u64, VecDeque<Step>> = HashMap::new();
    // Head fill covers 0..256; the demand read at 500 fails
    // transiently for the first attempt plus fetch_retries retries.
    pages.insert(0u64, VecDeque::from([Step::Reply(chunk(0, 128, 1024, 1))]));
    pages.insert(
        128u64,
        VecDeque::from([Step::Reply(chunk(128, 128, 1024, 2))]),
    );
    let fail = || {
        Step::Fail(StreamError::Transient {
            message: "conn reset".into(),
        })
    };
    pages.insert(500u64, VecDeque::from([fail(), fail(), fail()]));
    let fetch = Arc::new(MapFetch::new(pages));
    let reg = StreamRegistry::with_fetch(
        config(&d),
        tokio::runtime::Handle::current(),
        Arc::clone(&fetch) as Arc<dyn Fetch>,
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    // The parked read observes the latched error once — the session
    // stays live, so this is a hint to retry, not a terminal verdict.
    let e = err_of(
        std::thread::scope(|s| s.spawn(|| reg.read(&h, 500, 64)).join())
            .unwrap_or_else(|e| panic!("join: {e:?}")),
    );
    assert_eq!(e.kind(), "transient", "{e}");
    assert!(reg.is_live(&h), "network wobble must not kill the session");
    // The recovery fetch is scripted to succeed; a re-read queues the
    // demand and the pump serves it.
    fetch.push(500, Step::Reply(chunk(500, 128, 1024, 9)));
    let got = std::thread::scope(|s| s.spawn(|| reg.read(&h, 500, 64)).join())
        .unwrap_or_else(|e| panic!("join: {e:?}"))
        .unwrap_or_else(|e| panic!("read: {e}"));
    assert_eq!(got, vec![9u8; 64]);
    assert!(reg.is_live(&h));
}

/// A session that played past the prepare TTL and then detached —
/// the Media3 DataSource close→open on a seek — re-attaches on its
/// detached clock, not its creation clock: the expiry/TTL gate is
/// first-attach only, and the pump's re-mint path owns staleness
/// from there.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reattach_past_prepare_ttl_is_not_expired() {
    let d = TestDir::new("reattach");
    let mut c = config(&d);
    c.prepare_ttl = Duration::from_millis(120);
    let reg = StreamRegistry::with_fetch(
        c,
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    // The first attach lands inside the TTL; the session then ages
    // past it while attached — attached sessions are reaper-exempt.
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    tokio::time::sleep(Duration::from_millis(200)).await;
    reg.close(&h).unwrap_or_else(|e| panic!("close: {e}"));
    // The DataSource close→open gap stays well under the TTL, but the
    // session's creation age is already past it — a re-attach gated
    // on age dies Expired here.
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        reg.attach(&h, 0)
            .unwrap_or_else(|e| panic!("re-attach: {e}")),
        Some(1024)
    );
}

/// The prepare TTL still gates a session that was never attached —
/// an abandoned speculative prepare dies `Expired` on first attach.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_attach_past_prepare_ttl_is_expired() {
    let d = TestDir::new("firstattach");
    let mut c = config(&d);
    c.prepare_ttl = Duration::from_millis(120);
    let reg = StreamRegistry::with_fetch(
        c,
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let e = err_of(reg.attach(&h, 0));
    assert_eq!(e.kind(), "expired", "{e}");
}

/// The reaper's clock is detached duration, not session age: a
/// session that played past the TTL and closed survives its
/// post-close window, and is only evicted once it has sat detached
/// past the TTL.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn detached_session_evicted_by_detached_age() {
    let d = TestDir::new("detachevict");
    let mut c = config(&d);
    c.prepare_ttl = Duration::from_millis(150);
    c.reap_interval = Duration::from_millis(40);
    let reg = StreamRegistry::with_fetch(
        c,
        tokio::runtime::Handle::current(),
        Arc::new(MapFetch::new(HashMap::new())),
    )
    .unwrap_or_else(|e| panic!("registry: {e}"));
    let h = reg
        .prepare(source(1024), Arc::new(NeverRemint))
        .unwrap_or_else(|e| panic!("prepare: {e}"))
        .handle;
    reg.attach(&h, 0).unwrap_or_else(|e| panic!("attach: {e}"));
    // Attached well past the TTL — the session is reaper-exempt even
    // though its creation age is already stale.
    tokio::time::sleep(Duration::from_millis(220)).await;
    assert!(reg.is_live(&h), "attached session reaped");
    reg.close(&h).unwrap_or_else(|e| panic!("close: {e}"));
    // Partway through the detached window the session must still be
    // live: an age-based reaper would have evicted it at the first
    // post-close scan, the creation age already being past the TTL.
    tokio::time::sleep(Duration::from_millis(70)).await;
    assert!(reg.is_live(&h), "reaped on session age, not detached age");
    // Once the detached window itself reaches the TTL the reaper ends
    // it — Evicted, the abandon verdict.
    wait_until(|| !reg.is_live(&h)).await;
    let e = err_of(reg.attach(&h, 0));
    assert_eq!(e.kind(), "evicted", "{e}");
}
