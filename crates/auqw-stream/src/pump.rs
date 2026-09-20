//! The session pump: sequential fill, read-ahead window, fetch-through
//! at any offset — and the wire rules in full.
//!
//! Wire rules enforced here (every range response):
//! - strict `206`-only acceptance — any other 2xx (a server ignoring
//!   `Range`) is `InvalidResponse`, never a silent full-file GET;
//! - `Content-Range` must parse and its start must equal the requested
//!   offset;
//! - the reported total length must stay stable across chunks;
//! - empty bodies and bodies larger than requested are rejected;
//! - every request is a range request — full-file GETs throttle;
//! - `403`/`416` re-mints through [`Remint`](crate::Remint) and resumes
//!   at the same offset, bounded by `mint_budget` and the zero-progress
//!   counter; a re-minted mime that differs from the prepared mime is
//!   terminal `InvalidResponse` (a silent container swap is a bug);
//! - a second consecutive `416` (or a `416` at/past a known total) is
//!   honest end-of-stream evidence, not an error.
//!
//! Priority: a demand fetch-through outranks speculative fill — an
//! in-flight fill request is aborted on `ft_notify` and re-picked
//! later; a fetch-through request is itself never preempted.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use crate::error::StreamError;
use crate::fetch::{Fetch, FetchResponse};
use crate::session::{Action, SessionInner};
use crate::Remint;

/// The pump task: decide → fetch → commit until the session is
/// terminal or the file is fully covered.
pub(crate) async fn pump_loop(session: Arc<SessionInner>, fetch: Arc<dyn Fetch>) {
    loop {
        match session.next_action() {
            Err(_) | Ok(Action::Stop) => return,
            Ok(Action::Park { on_demand }) => {
                if on_demand {
                    // `drained` fires `notify_waiters`, which wakes only
                    // already-registered waiters and stores no permit —
                    // register interest first, then re-check demand so a
                    // drain landing between the decide and this
                    // registration is observed, not missed.
                    let drained = session.pool.drained.notified();
                    tokio::pin!(drained);
                    let _ = drained.as_mut().enable();
                    if session.pool.demand.load(Ordering::Relaxed) == 0 {
                        continue;
                    }
                    tokio::select! {
                        () = session.pump_notify.notified() => {}
                        () = &mut drained => {}
                        () = session.cancel.cancelled() => {}
                    }
                } else {
                    tokio::select! {
                        () = session.pump_notify.notified() => {}
                        () = session.cancel.cancelled() => {}
                    }
                }
            }
            Ok(Action::Fetch {
                offset,
                len,
                through,
            }) => match fetch_chunk(&session, &*fetch, offset, len, through).await {
                Outcome::Bytes(body) => {
                    if let Err(e) = session
                        .commit(offset, &body, through.then_some(offset))
                        .await
                    {
                        session.terminate(e);
                        return;
                    }
                }
                Outcome::Eof(at) => session.mark_eof_below(at),
                Outcome::Preempted => {}
                Outcome::Failed(e) => {
                    session.terminate(e);
                    return;
                }
            },
        }
    }
}

/// One chunk-fetch cycle's result.
enum Outcome {
    /// Validated `206` body bytes (committed at the requested offset).
    Bytes(Vec<u8>),
    /// Confirmed end-of-stream at this offset (`416` evidence).
    Eof(u64),
    /// A demand read arrived mid-fill; re-decide.
    Preempted,
    /// Terminal failure for the session.
    Failed(StreamError),
}

/// Intermediate result of the select around an in-flight request.
enum FetchWait {
    /// The fetch completed.
    Done(Result<FetchResponse, StreamError>),
    /// A demand read preempted speculative fill.
    Preempted,
    /// Session cancel landed mid-flight.
    Cancelled,
}

/// Await one range request; cancel and (for speculative fill) demand
/// preemption both abort it.
async fn await_fetch(
    session: &Arc<SessionInner>,
    fetch: &dyn Fetch,
    url: &str,
    offset: u64,
    len: u64,
    through: bool,
) -> FetchWait {
    let fut = fetch.get_range(
        url,
        offset,
        len,
        session.config.stall,
        session.config.request_deadline,
        session.cancel.clone(),
    );
    tokio::pin!(fut);
    tokio::select! {
        r = &mut fut => FetchWait::Done(r),
        () = session.cancel.cancelled() => FetchWait::Cancelled,
        () = session.ft_notify.notified(), if !through => FetchWait::Preempted,
    }
}

/// Fetch one chunk at `offset`, looping through `403`/`416` re-mints.
/// Always issues range requests — never a full-file GET.
async fn fetch_chunk(
    session: &Arc<SessionInner>,
    fetch: &dyn Fetch,
    offset: u64,
    len: u64,
    through: bool,
) -> Outcome {
    let mut retried_416 = false;
    loop {
        if let Err(e) = session.check_live() {
            return Outcome::Failed(e);
        }
        let resp = match session.current_url() {
            Ok(url) => match await_fetch(session, fetch, &url, offset, len, through).await {
                FetchWait::Done(r) => r,
                FetchWait::Preempted => return Outcome::Preempted,
                FetchWait::Cancelled => return Outcome::Failed(StreamError::Cancelled),
            },
            Err(e) => return Outcome::Failed(e),
        };
        let resp = match resp {
            Ok(r) => r,
            Err(e) => return Outcome::Failed(e),
        };
        match resp.status {
            206 => {
                return match validate_206(session, &resp, offset, len) {
                    Ok(()) => Outcome::Bytes(resp.body),
                    Err(e) => Outcome::Failed(e),
                }
            }
            416 if eof_confirmed(session, offset, retried_416) => return Outcome::Eof(offset),
            403 => {
                retried_416 = false;
                if let Err(e) = remint(session).await {
                    return Outcome::Failed(e);
                }
            }
            416 => {
                retried_416 = true;
                if let Err(e) = remint(session).await {
                    return Outcome::Failed(e);
                }
            }
            status => return Outcome::Failed(classify_status(status, offset)),
        }
    }
}

/// Whether a `416` proves end-of-stream: the offset is at/past a known
/// total, or the same request already failed `416` once across a
/// re-mint — a second refusal means the resource ends below `offset`.
fn eof_confirmed(session: &Arc<SessionInner>, offset: u64, retried: bool) -> bool {
    if retried {
        return true;
    }
    session
        .effective_total()
        .map(|t| t.is_some_and(|t| offset >= t))
        .unwrap_or(false)
}

/// Re-resolve the source through the host's [`Remint`]; budgets and
/// the mime pin are enforced by the session. Cancel-safe and bounded
/// by `mint_deadline` — a hung resolve must not zombie the session.
async fn remint(session: &Arc<SessionInner>) -> Result<(), StreamError> {
    session.begin_mint()?;
    let remint: Arc<dyn Remint> = session.remint_fn()?;
    let t0 = Instant::now();
    let source = tokio::select! {
        r = tokio::time::timeout(session.config.mint_deadline, remint.remint()) => match r {
            Ok(r) => r?,
            Err(_) => {
                return Err(StreamError::Transient {
                    message: format!("re-mint stalled for {:?}", session.config.mint_deadline),
                });
            }
        },
        () = session.cancel.cancelled() => return Err(StreamError::Cancelled),
    };
    session.finish_mint(source, t0.elapsed())
}

/// Apply the `206` wire rules to `resp` for a request at `offset` of
/// `max_len` bytes.
fn validate_206(
    session: &Arc<SessionInner>,
    resp: &FetchResponse,
    offset: u64,
    max_len: u64,
) -> Result<(), StreamError> {
    let invalid = |m: String| StreamError::InvalidResponse { message: m };
    let Some(cr) = resp.content_range.as_deref() else {
        return Err(invalid(format!("206 without Content-Range at {offset}")));
    };
    let (start, end, total) =
        parse_content_range(cr).map_err(|m| invalid(format!("{m} at {offset}")))?;
    if start != offset {
        return Err(invalid(format!(
            "Content-Range start {start} != requested {offset}"
        )));
    }
    if end < start {
        return Err(invalid(format!("Content-Range {start}-{end} inverted")));
    }
    if let Some(t) = total {
        if end >= t {
            return Err(invalid(format!(
                "Content-Range end {end} at/past declared total {t}"
            )));
        }
        session.check_total(t)?;
    }
    if resp.body.is_empty() {
        return Err(invalid(format!("empty body at {offset}")));
    }
    if resp.body.len() as u64 > max_len {
        return Err(invalid(format!(
            "body {} bytes exceeds requested {max_len} at {offset}",
            resp.body.len()
        )));
    }
    if resp.body.len() as u64 != end - start + 1 {
        return Err(invalid(format!(
            "body {} bytes != declared {start}-{end} at {offset}",
            resp.body.len()
        )));
    }
    Ok(())
}

/// Parse `bytes START-END/TOTAL` (TOTAL may be `*`). The header value
/// is server-controlled text — error messages never embed it (the
/// redact invariant: a server could echo the signed request URL).
fn parse_content_range(cr: &str) -> Result<(u64, u64, Option<u64>), String> {
    // RFC 9110 range units are case-insensitive.
    let body = cr
        .get(..6)
        .filter(|unit| unit.eq_ignore_ascii_case("bytes "))
        .map(|_| &cr[6..])
        .ok_or_else(|| "Content-Range is not a byte range".to_string())?;
    let (range, total_s) = body
        .split_once('/')
        .ok_or_else(|| "Content-Range missing '/'".to_string())?;
    let (start_s, end_s) = range
        .split_once('-')
        .ok_or_else(|| "Content-Range missing '-'".to_string())?;
    // `str::parse::<u64>` accepts a leading `+` — digits only.
    let parse = |s: &str| {
        let t = s.trim();
        if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
            return Err("bad Content-Range number".to_string());
        }
        t.parse::<u64>()
            .map_err(|_| "bad Content-Range number".to_string())
    };
    let start = parse(start_s)?;
    let end = parse(end_s)?;
    let total = if total_s.trim() == "*" {
        None
    } else {
        Some(parse(total_s)?)
    };
    Ok((start, end, total))
}

/// Classify a non-`206`, non-remint status into the seam taxonomy.
fn classify_status(status: u16, offset: u64) -> StreamError {
    let msg = || format!("status {status} at offset {offset}");
    match status {
        404 => StreamError::NotFound,
        429 => StreamError::RateLimited { message: msg() },
        200..=399 => StreamError::InvalidResponse {
            message: format!("range request answered {status}, not 206, at {offset}"),
        },
        _ => StreamError::Transient { message: msg() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::lock;
    use crate::fetch::Fetch;
    use crate::session::PoolSignals;
    use crate::testkit::*;
    use crate::{PreparedSource, StreamConfig};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    fn resp(status: u16, offset: u64, len: u64, total: u64) -> FetchResponse {
        let end = offset + len - 1;
        FetchResponse {
            status,
            content_range: Some(format!("bytes {offset}-{end}/{total}")),
            body: vec![1u8; usize::try_from(len).unwrap_or(0)],
        }
    }

    /// A fetch whose every call is answered from a script; requests are
    /// recorded so tests can assert range requests at exact offsets.
    struct ScriptedFetch {
        steps: Mutex<std::collections::VecDeque<Step>>,
        requests: Mutex<Vec<(u64, u64)>>,
    }

    enum Step {
        Reply(FetchResponse),
        Fail(StreamError),
        Hang,
    }

    impl ScriptedFetch {
        fn new(steps: Vec<Step>) -> Self {
            Self {
                steps: Mutex::new(steps.into()),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl Fetch for ScriptedFetch {
        fn get_range<'a>(
            &'a self,
            _url: &'a str,
            offset: u64,
            max_len: u64,
            _stall: Duration,
            _deadline: Duration,
            _cancel: tokio_util::sync::CancellationToken,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<FetchResponse, StreamError>> + Send + 'a>,
        > {
            if let Ok(mut r) = self.requests.lock() {
                r.push((offset, max_len));
            }
            let step = self
                .steps
                .lock()
                .ok()
                .and_then(|mut s| s.pop_front())
                .unwrap_or(Step::Hang);
            Box::pin(async move {
                match step {
                    Step::Reply(r) => Ok(r),
                    Step::Fail(e) => Err(e),
                    Step::Hang => std::future::pending().await,
                }
            })
        }
    }

    /// A re-mint that counts calls and yields a canned source.
    struct CountingRemint {
        calls: AtomicU32,
        mime: String,
        fail: Mutex<Option<StreamError>>,
    }

    impl Remint for CountingRemint {
        fn remint(
            &self,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<PreparedSource, StreamError>> + Send>,
        > {
            self.calls.fetch_add(1, Ordering::Relaxed);
            let fail = self.fail.lock().ok().and_then(|mut f| f.take());
            let mime = self.mime.clone();
            Box::pin(async move {
                if let Some(e) = fail {
                    return Err(e);
                }
                Ok(PreparedSource {
                    url: "https://reminted.example/s".into(),
                    mime,
                    itag: Some(140),
                    bitrate_kbps: None,
                    content_length: Some(1024),
                    expires_at_ms: None,
                    source_ref: "vid".into(),
                })
            })
        }
    }

    fn source() -> PreparedSource {
        PreparedSource {
            url: "https://signed.example/s?sig=SECRET".into(),
            mime: "audio/mp4".into(),
            itag: Some(140),
            bitrate_kbps: Some(129),
            content_length: Some(1024),
            expires_at_ms: None,
            source_ref: "vid".into(),
        }
    }

    fn session(cfg: StreamConfig, remint: Arc<dyn Remint>) -> Arc<SessionInner> {
        let handle = format!("t-{}", unique());
        SessionInner::new(handle, source(), remint, cfg, PoolSignals::new())
            .unwrap_or_else(|e| panic!("session: {e}"))
    }

    fn config(dir: &TestDir) -> StreamConfig {
        test_config(dir)
    }

    /// `n` steps answering `status` with an empty body.
    fn status_steps(status: u16, n: usize) -> Vec<Step> {
        (0..n)
            .map(|_| {
                Step::Reply(FetchResponse {
                    status,
                    content_range: (status == 416).then(|| "bytes */1024".to_string()),
                    body: vec![],
                })
            })
            .collect()
    }

    fn remint_ok() -> Arc<CountingRemint> {
        Arc::new(CountingRemint {
            calls: AtomicU32::new(0),
            mime: "audio/mp4".into(),
            fail: Mutex::new(None),
        })
    }

    async fn drive(s: &Arc<SessionInner>, f: Arc<dyn Fetch>) {
        pump_loop(Arc::clone(s), f).await;
    }

    /// Spawn the pump on the test runtime; the caller waits on
    /// [`wait_until`], asserts, then joins via [`stop_pump`].
    fn spawn_pump(s: &Arc<SessionInner>, f: Arc<dyn Fetch>) -> tokio::task::JoinHandle<()> {
        let s2 = Arc::clone(s);
        tokio::spawn(async move { drive(&s2, f).await })
    }

    /// Poll `pred` until true or ~2 s elapse — a pump that never gets
    /// there fails the test honestly, not by sleep-timing luck.
    async fn wait_until(pred: impl Fn() -> bool) {
        for _ in 0..400 {
            if pred() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("pump did not reach the expected state");
    }

    /// End the session and join the pump task.
    async fn stop_pump(s: &Arc<SessionInner>, task: tokio::task::JoinHandle<()>) {
        s.terminate(StreamError::Cancelled);
        let _ = task.await;
    }

    fn head_ready(s: &Arc<SessionInner>) -> bool {
        lock(&s.shared)
            .map(|sh| sh.marks.head_ready_ms.is_some())
            .unwrap_or(false)
    }

    fn eof_below(s: &Arc<SessionInner>) -> Option<u64> {
        lock(&s.shared).ok().and_then(|sh| sh.eof_below)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fills_head_and_parks_prepared() {
        let d = TestDir::new("fill");
        let s = session(config(&d), remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(vec![
            Step::Reply(resp(206, 0, 128, 1024)),
            Step::Reply(resp(206, 128, 128, 1024)),
        ]));
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        wait_until(|| head_ready(&s) || s.is_terminal()).await;
        let (committed, head_ready) = lock(&s.shared)
            .map(|sh| (sh.committed, sh.marks.head_ready_ms.is_some()))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(committed, 256);
        assert!(head_ready);
        stop_pump(&s, task).await;
        let reqs = fetch
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        assert_eq!(reqs, vec![(0, 128), (128, 128)]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn non_206_2xx_is_invalid_response() {
        let d = TestDir::new("n206");
        let s = session(config(&d), remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
            status: 200,
            content_range: None,
            body: vec![0u8; 16],
        })]));
        let task = spawn_pump(&s, fetch);
        wait_until(|| s.is_terminal()).await;
        assert!(matches!(
            s.terminal_err(),
            Some(StreamError::InvalidResponse { .. })
        ));
        stop_pump(&s, task).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn content_range_checks_are_strict() {
        for (cr, name) in [
            (None, "missing"),
            (Some("bytes 64-127/1024"), "wrong-start"),
            (Some("items 0-127/1024"), "bad-unit"),
            (Some("bytes 0-63"), "no-total"),
        ] {
            let d = TestDir::new(name);
            let s = session(config(&d), remint_ok());
            let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
                status: 206,
                content_range: cr.map(str::to_string),
                body: vec![1u8; 64],
            })]));
            let task = spawn_pump(&s, fetch);
            wait_until(|| s.is_terminal()).await;
            assert!(
                matches!(s.terminal_err(), Some(StreamError::InvalidResponse { .. })),
                "{name}: {:?}",
                s.terminal_err()
            );
            stop_pump(&s, task).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unstable_total_is_invalid_response() {
        let d = TestDir::new("unstable");
        let s = session(config(&d), remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(vec![
            Step::Reply(resp(206, 0, 128, 1024)),
            Step::Reply(resp(206, 128, 128, 2048)),
        ]));
        let task = spawn_pump(&s, fetch);
        wait_until(|| s.is_terminal()).await;
        assert!(matches!(
            s.terminal_err(),
            Some(StreamError::InvalidResponse { .. })
        ));
        stop_pump(&s, task).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn empty_and_oversized_bodies_are_rejected() {
        for (body_len, name) in [(0usize, "empty"), (129usize, "oversized")] {
            let d = TestDir::new(name);
            let s = session(config(&d), remint_ok());
            let mut r = resp(206, 0, 128, 1024);
            r.body = vec![1u8; body_len];
            let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(r)]));
            let task = spawn_pump(&s, fetch);
            wait_until(|| s.is_terminal()).await;
            assert!(
                matches!(s.terminal_err(), Some(StreamError::InvalidResponse { .. })),
                "{name}: {:?}",
                s.terminal_err()
            );
            stop_pump(&s, task).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cap_death_remints_and_resumes_at_offset() {
        let d = TestDir::new("capdeath");
        let remint = remint_ok();
        let s = session(config(&d), remint.clone());
        let fetch = Arc::new(ScriptedFetch::new(vec![
            Step::Reply(resp(206, 0, 128, 1024)),
            Step::Reply(FetchResponse {
                status: 403,
                content_range: None,
                body: vec![],
            }),
            Step::Reply(resp(206, 128, 128, 1024)),
        ]));
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        wait_until(|| head_ready(&s) || s.is_terminal()).await;
        assert_eq!(remint.calls.load(Ordering::Relaxed), 1);
        let reqs = fetch
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        // The post-remint request resumed at the same offset, still ranged.
        assert_eq!(reqs[2], (128, 128));
        let (committed, minted) = lock(&s.shared)
            .map(|sh| (sh.committed, sh.marks.mint_ms.is_some()))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(committed, 256);
        assert!(minted);
        stop_pump(&s, task).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mime_swap_on_remint_is_terminal() {
        let d = TestDir::new("mimeswap");
        let remint = Arc::new(CountingRemint {
            calls: AtomicU32::new(0),
            mime: "audio/webm".into(), // different container — must fail
            fail: Mutex::new(None),
        });
        let s = session(config(&d), remint);
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
            status: 403,
            content_range: None,
            body: vec![],
        })]));
        let task = spawn_pump(&s, fetch);
        wait_until(|| s.is_terminal()).await;
        match s.terminal_err() {
            Some(StreamError::InvalidResponse { message }) => {
                assert!(message.contains("mime"), "{message}");
                assert!(!message.contains("reminted.example"), "{message}");
            }
            other => panic!("expected InvalidResponse, got {other:?}"),
        }
        stop_pump(&s, task).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn zero_progress_mints_abort() {
        let d = TestDir::new("zeroprog");
        let mut cfg = config(&d);
        cfg.max_zero_progress_mints = 2;
        cfg.mint_budget = 10;
        let remint = remint_ok();
        let s = session(cfg, remint.clone());
        let fetch = Arc::new(ScriptedFetch::new(status_steps(403, 5)));
        let task = spawn_pump(&s, fetch);
        wait_until(|| s.is_terminal()).await;
        assert!(matches!(
            s.terminal_err(),
            Some(StreamError::StreamsCapped { .. })
        ));
        // First 403 mints, then two zero-progress mints abort.
        assert_eq!(remint.calls.load(Ordering::Relaxed), 3);
        stop_pump(&s, task).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mint_budget_bounds_remint_loop() {
        let d = TestDir::new("mintbudget");
        let mut cfg = config(&d);
        cfg.mint_budget = 2;
        cfg.max_zero_progress_mints = 100; // budget hits first
        let remint = remint_ok();
        let s = session(cfg, remint.clone());
        let fetch = Arc::new(ScriptedFetch::new(status_steps(403, 6)));
        let task = spawn_pump(&s, fetch);
        wait_until(|| s.is_terminal()).await;
        assert!(matches!(
            s.terminal_err(),
            Some(StreamError::StreamsCapped { .. })
        ));
        assert_eq!(remint.calls.load(Ordering::Relaxed), 2);
        stop_pump(&s, task).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repeated_416_is_eof_not_error() {
        let d = TestDir::new("eof416");
        let mut cfg = config(&d);
        cfg.mint_budget = 4;
        let remint = remint_ok();
        let s = session(cfg, remint.clone());
        // Seek-read lands far past the end: 416, remint, 416 again →
        // eof_below marks the ceiling instead of an error.
        let fetch = Arc::new(ScriptedFetch::new(status_steps(416, 2)));
        {
            let mut sh = lock(&s.shared).unwrap_or_else(|e| panic!("{e}"));
            sh.fetch_through.insert(900, 1);
        }
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        wait_until(|| eof_below(&s).is_some() || s.is_terminal()).await;
        // The EOF ceiling must prune the demand position — otherwise
        // the pump refetches it, burns a remint per cycle, and the mint
        // budget kills the whole session (regression: remint storm).
        tokio::time::sleep(Duration::from_millis(100)).await;
        let reqs = fetch
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        assert_eq!(
            reqs.iter().filter(|(o, _)| *o == 900).count(),
            2,
            "demand position refetched past the EOF ceiling: {reqs:?}"
        );
        assert!(!s.is_terminal(), "session died on a localized EOF");
        stop_pump(&s, task).await;
        assert_eq!(remint.calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rate_limit_and_not_found_map_kinds() {
        for (status, want) in [
            (429u16, "rate-limit"),
            (404, "not-found"),
            (503, "transient"),
        ] {
            let d = TestDir::new(want);
            let s = session(config(&d), remint_ok());
            let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
                status,
                content_range: None,
                body: vec![],
            })]));
            let task = spawn_pump(&s, fetch);
            wait_until(|| s.is_terminal()).await;
            assert_eq!(
                s.terminal_err().map(|e| e.kind().to_string()),
                Some(want.to_string()),
                "status {status}"
            );
            stop_pump(&s, task).await;
        }
    }

    /// A file shorter than `head_bytes` still marks head-ready: the
    /// mark means "everything the prepare policy wanted is covered",
    /// not the bound itself.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn head_ready_marks_when_file_shorter_than_bound() {
        let d = TestDir::new("shortready");
        let s = session(config(&d), remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(resp(
            206, 0, 100, 100,
        ))]));
        let task = spawn_pump(&s, fetch);
        wait_until(|| head_ready(&s) || s.is_terminal()).await;
        assert!(head_ready(&s), "short file never marked head-ready");
        stop_pump(&s, task).await;
    }

    /// A demand-read position covered by an overlapping chunk commit is
    /// pruned, not refetched — each stale entry would otherwise cost a
    /// redundant range request.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn covered_fetch_through_is_not_refetched() {
        let d = TestDir::new("ftskip");
        let s = session(config(&d), remint_ok());
        {
            let mut sh = lock(&s.shared).unwrap_or_else(|e| panic!("{e}"));
            // 64 becomes covered when the fetch at 0 commits; 500 stays
            // a real hole. Scripted replies are consumed in pump order.
            sh.fetch_through.insert(0, 1);
            sh.fetch_through.insert(64, 1);
            sh.fetch_through.insert(500, 1);
        }
        let fetch = Arc::new(ScriptedFetch::new(vec![
            Step::Reply(resp(206, 0, 128, 1024)),
            Step::Reply(resp(206, 500, 128, 1024)),
            Step::Reply(resp(206, 128, 128, 1024)),
        ]));
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        wait_until(|| {
            s.is_terminal() || fetch.requests.lock().map(|r| r.len() >= 3).unwrap_or(false)
        })
        .await;
        stop_pump(&s, task).await;
        let reqs = fetch
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        assert_eq!(reqs[1].0, 500, "{reqs:?}");
        assert!(reqs.iter().all(|(o, _)| *o != 64), "{reqs:?}");
    }

    /// The supersede scan re-checks `attached` inside the terminal
    /// transition — an attach that lands after the scan wins.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn attached_session_wins_the_supersede_race() {
        let d = TestDir::new("supersederace");
        let s = session(config(&d), remint_ok());
        s.terminate_if(StreamError::Superseded, |sh| !sh.attached);
        assert!(s.is_terminal(), "unattached session must supersede");
        let s = session(config(&d), remint_ok());
        s.attach(0).unwrap_or_else(|e| panic!("attach: {e}"));
        s.terminate_if(StreamError::Superseded, |sh| !sh.attached);
        assert!(!s.is_terminal(), "attached session superseded anyway");
        s.terminate(StreamError::Cancelled);
    }

    /// A remint failure propagates its own kind.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remint_failure_propagates() {
        let d = TestDir::new("remintfail");
        let remint = Arc::new(CountingRemint {
            calls: AtomicU32::new(0),
            mime: "audio/mp4".into(),
            fail: Mutex::new(Some(StreamError::Expired)),
        });
        let s = session(config(&d), remint);
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
            status: 403,
            content_range: None,
            body: vec![],
        })]));
        let task = spawn_pump(&s, fetch);
        wait_until(|| s.is_terminal()).await;
        assert!(matches!(s.terminal_err(), Some(StreamError::Expired)));
        stop_pump(&s, task).await;
    }

    /// The pump errors surface the fetch's typed error.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fetch_error_terminates() {
        let d = TestDir::new("fetcherr");
        let s = session(config(&d), remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Fail(
            StreamError::Transient {
                message: "conn reset".into(),
            },
        )]));
        let task = spawn_pump(&s, fetch);
        wait_until(|| s.is_terminal()).await;
        assert!(matches!(
            s.terminal_err(),
            Some(StreamError::Transient { .. })
        ));
        stop_pump(&s, task).await;
    }

    /// A hung `playback.resolve` must not zombie the session — the
    /// re-mint is bounded by `mint_deadline` and ends `Transient`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hung_remint_times_out() {
        struct HangingRemint;
        impl Remint for HangingRemint {
            fn remint(
                &self,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<PreparedSource, StreamError>> + Send>,
            > {
                Box::pin(std::future::pending())
            }
        }
        let d = TestDir::new("hangremint");
        let mut cfg = config(&d);
        cfg.mint_deadline = Duration::from_millis(100);
        let s = session(cfg, Arc::new(HangingRemint));
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
            status: 403,
            content_range: None,
            body: vec![],
        })]));
        let task = spawn_pump(&s, fetch);
        wait_until(|| s.is_terminal()).await;
        assert!(matches!(
            s.terminal_err(),
            Some(StreamError::Transient { .. })
        ));
        stop_pump(&s, task).await;
    }

    /// A commit landing after a terminal transition is a data write
    /// only — it must not resurrect the evicted sidecar.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn commit_after_terminal_does_not_resurrect_sidecar() {
        let d = TestDir::new("latecommit");
        let s = session(config(&d), remint_ok());
        s.terminate(StreamError::Released);
        let _ = s.commit(0, &[7u8; 64], None).await;
        assert!(!s.paths.sidecar.exists(), "sidecar resurrected post-evict");
    }

    #[test]
    fn content_range_parsing_is_strict() {
        assert_eq!(
            parse_content_range("bytes 0-127/1024"),
            Ok((0, 127, Some(1024)))
        );
        // RFC 9110: the range unit is case-insensitive.
        assert_eq!(
            parse_content_range("Bytes 0-127/1024"),
            Ok((0, 127, Some(1024)))
        );
        assert_eq!(parse_content_range("bytes 0-127/*"), Ok((0, 127, None)));
        for bad in [
            "items 0-127/1024",
            "bytes 0-127",
            "bytes 0/1024",
            "bytes +0-127/1024",
            "bytes 0-+127/1024",
            "bytes 0--127/1024",
            "bytes -/1024",
        ] {
            assert!(parse_content_range(bad).is_err(), "{bad}");
        }
    }
}
