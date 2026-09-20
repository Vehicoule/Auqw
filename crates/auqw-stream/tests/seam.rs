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
    c.read_deadline = Duration::from_millis(400);
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

/// What the fake answers for one request.
enum Step {
    Reply(FetchResponse),
    /// Park forever — the request is still recorded.
    Hang,
}

/// Offset-keyed fetch: `pages` maps a requested offset to a queue of
/// replies (queue length covers re-mint retry sequences); anything
/// unscripted hangs. `in_flight` counts requests actually issued so
/// tests can wait for the pump to be inside a fetch.
struct MapFetch {
    pages: Mutex<HashMap<u64, VecDeque<Step>>>,
    requests: Mutex<Vec<(u64, u64)>>,
    in_flight: AtomicU32,
}

impl MapFetch {
    fn new(pages: HashMap<u64, VecDeque<Step>>) -> Self {
        Self {
            pages: Mutex::new(pages),
            requests: Mutex::new(Vec::new()),
            in_flight: AtomicU32::new(0),
        }
    }

    fn issued(&self, offset: u64) -> bool {
        self.requests
            .lock()
            .map(|r| r.iter().any(|(o, _)| *o == offset))
            .unwrap_or(false)
    }
}

impl Fetch for MapFetch {
    fn get_range<'a>(
        &'a self,
        _url: &'a str,
        offset: u64,
        max_len: u64,
        _stall: Duration,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<FetchResponse, StreamError>> + Send + 'a>> {
        if let Ok(mut r) = self.requests.lock() {
            r.push((offset, max_len));
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
        let b = reg
            .prepare(source(1024), Arc::new(NeverRemint))
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
        let _b = reg
            .prepare(source(1024), Arc::new(NeverRemint))
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
    // Closed sessions are unattached again — a new prepare supersedes.
    let _b = reg
        .prepare(source(1024), Arc::new(NeverRemint))
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
