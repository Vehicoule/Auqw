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
//!   honest end-of-stream evidence, not an error;
//! - any other permanent `4xx` is a terminal verdict on this URL —
//!   `401` is a dead mint (`Expired`), `404`/`410` are `NotFound`, the
//!   rest `InvalidResponse`; only `408`/`425`/`429` and `5xx` stay
//!   retriable. A permanent refusal must never latch as `Transient`:
//!   the session would stall forever on a verdict that cannot change.
//!
//! Priority: a demand fetch-through outranks speculative fill — an
//! demand outside an in-flight fill aborts it and re-picks immediately.
//! Covered demand rides the current request up to the stall bound;
//! a fetch-through request is itself never preempted.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;

use crate::error::StreamError;
use crate::fetch::Fetch;
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
                // Body pieces already committed as the wire streamed.
                Outcome::Bytes => {}
                Outcome::Eof(at) => session.mark_eof_below(at),
                Outcome::Preempted => {}
                Outcome::Stalled(e) => session.stall_transient(e),
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
    /// A validated `206` — its body already committed piecewise.
    Bytes,
    /// Confirmed end-of-stream at this offset (`416` evidence).
    Eof(u64),
    /// A demand read arrived mid-fill; re-decide.
    Preempted,
    /// Retriable failure after the bounded retries ran out — the
    /// session latches it and parks instead of dying.
    Stalled(StreamError),
    /// Terminal failure for the session.
    Failed(StreamError),
}

/// Intermediate result of the select around an in-flight request.
enum FetchWait {
    /// The fetch completed.
    Done(Result<FetchOutcome, StreamError>),
    /// A demand read preempted speculative fill.
    Preempted,
    /// Session cancel landed mid-flight.
    Cancelled,
}

/// What one range request produced once headers arrived.
enum FetchOutcome {
    /// A validated `206` — its body streamed into piecewise commits.
    Committed,
    /// Any other status for the caller's dispatch (403/416/…); the
    /// body stream was dropped unread. On a `416`, the parsed
    /// `bytes */N` total rides along — the wire's authoritative EOF
    /// evidence.
    Status(u16, Option<u64>),
}

/// Drive one range request end to end: await headers, and on a `206`
/// validate the range *before* trusting a byte, then commit each body
/// piece as it lands — a parked reader wakes at the first network
/// frame instead of the whole chunk. Any other status returns for the
/// caller's remint/classify dispatch with the body unread.
async fn drive_fetch(
    session: &Arc<SessionInner>,
    fetch: &dyn Fetch,
    url: &str,
    offset: u64,
    len: u64,
) -> Result<FetchOutcome, StreamError> {
    let resp = fetch
        .get_range(
            url,
            offset,
            len,
            session.config.stall,
            session.config.request_deadline,
            session.cancel.clone(),
        )
        .await?;
    if resp.status != 206 {
        // `416` carries `Content-Range: bytes */N` — keep the total;
        // it confirms EOF without spending a re-mint. Range units are
        // case-insensitive (RFC 9110 §14.1.1).
        let range_total = if resp.status == 416 {
            resp.content_range
                .as_deref()
                .and_then(unsatisfied_range_total)
        } else {
            None
        };
        return Ok(FetchOutcome::Status(resp.status, range_total));
    }
    let declared = validate_206_head(session, resp.content_range.as_deref(), offset, len)?;
    let mut body = resp.body;
    let mut got = 0u64;
    while let Some(piece) = body.next().await {
        let piece = piece?;
        // Commit at most the declared span — an overrun means the
        // server lied about the range, so the excess never reaches
        // the store.
        let take = usize::try_from((declared - got).min(piece.len() as u64)).unwrap_or(usize::MAX);
        if take > 0 {
            session.commit(offset.saturating_add(got), &piece[..take])?;
            got += take as u64;
        }
        if take < piece.len() {
            return Err(StreamError::InvalidResponse {
                message: format!("body overruns declared range at {offset}"),
            });
        }
    }
    if got != declared {
        return Err(StreamError::InvalidResponse {
            message: format!("body {got} bytes != declared range at {offset}"),
        });
    }
    Ok(FetchOutcome::Committed)
}

/// Await one range request; cancel and (for speculative fill) demand
/// preemption both abort it. A demand that lands *inside* the
/// in-flight range does not preempt immediately: the commit already
/// serves it — aborting just to re-request the same bytes wastes a
/// connect + round-trip and delays the reader by a whole request. It
/// still preempts once the fetch has outlived the stall budget, so a
/// hung fill cannot hold a reader hostage.
async fn await_fetch(
    session: &Arc<SessionInner>,
    fetch: &dyn Fetch,
    url: &str,
    offset: u64,
    len: u64,
    through: bool,
) -> FetchWait {
    use crate::session::DemandCover;
    let fut = drive_fetch(session, fetch, url, offset, len);
    tokio::pin!(fut);
    if through {
        return tokio::select! {
            r = &mut fut => FetchWait::Done(r),
            () = session.cancel.cancelled() => FetchWait::Cancelled,
        };
    }
    // When a covered demand first appears, the in-flight fetch gets
    // `stall` to finish and serve it; past that it is treated as hung
    // and the demand jumps in as its own request.
    let mut covered_deadline: Option<tokio::time::Instant> = None;
    loop {
        // Register before the coverage re-check so a notify landing
        // between the check and the wait isn't missed (same pattern
        // as the `drained` wait in `pump_loop`).
        let notified = session.ft_notify.notified();
        tokio::pin!(notified);
        let _ = notified.as_mut().enable();
        match session.demand_cover(offset, len) {
            DemandCover::Outside => return FetchWait::Preempted,
            DemandCover::None => covered_deadline = None,
            DemandCover::Covered => {
                covered_deadline
                    .get_or_insert_with(|| tokio::time::Instant::now() + session.config.stall);
            }
        }
        // Copy, not borrow: the bail arm reassigns `covered_deadline`
        // when it fires on drained demand.
        let bail_deadline = covered_deadline;
        let bail = async move {
            match bail_deadline {
                Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(bail);
        tokio::select! {
            r = &mut fut => return FetchWait::Done(r),
            () = session.cancel.cancelled() => return FetchWait::Cancelled,
            () = &mut bail => {
                // The deadline armed on covered demand expired — but
                // demand removal never signals `ft_notify`, so the
                // demand it tracked may already be served and gone.
                // Preempt only if demand is still live; a drained
                // demand leaves the fill undisturbed.
                match session.demand_cover(offset, len) {
                    DemandCover::None => covered_deadline = None,
                    _ => return FetchWait::Preempted,
                }
            }
            // Wake only re-arms the coverage check — an in-range
            // demand lets this fetch finish and serve it.
            () = &mut notified => {}
        }
    }
}

/// Fetch one chunk at `offset`, looping through `403`/`416` re-mints
/// and bounded `Transient` retries. Always issues range requests —
/// never a full-file GET.
async fn fetch_chunk(
    session: &Arc<SessionInner>,
    fetch: &dyn Fetch,
    offset: u64,
    len: u64,
    through: bool,
) -> Outcome {
    let mut retried_416 = false;
    let mut transient_left = session.config.fetch_retries;
    loop {
        if let Err(e) = session.check_live() {
            return Outcome::Failed(e);
        }
        let outcome = match session.current_url() {
            Ok(url) => match await_fetch(session, fetch, &url, offset, len, through).await {
                FetchWait::Done(r) => r,
                FetchWait::Preempted => return Outcome::Preempted,
                FetchWait::Cancelled => return Outcome::Failed(StreamError::Cancelled),
            },
            Err(e) => return Outcome::Failed(e),
        };
        let outcome = match outcome {
            Ok(r) => r,
            Err(e) => match retry_or_stall(session, through, e, &mut transient_left).await {
                Retry::Again => continue,
                Retry::Stop(o) => return o,
            },
        };
        match outcome {
            // Pieces already committed as the body streamed.
            FetchOutcome::Committed => return Outcome::Bytes,
            FetchOutcome::Status(status, range_total) => match status {
                416 => {
                    // Adopt the wire total before any mint spend: when
                    // it is already authoritative, this 416 confirms
                    // EOF at its real ceiling.
                    if let Some(total) = range_total {
                        match session.check_total(total) {
                            Ok(()) => session.mark_eof_below(total),
                            Err(e) => return Outcome::Failed(e),
                        }
                        if offset >= total {
                            return Outcome::Eof(offset);
                        }
                        // `offset < total`: the server calls this range
                        // unsatisfiable while declaring an extent that
                        // satisfies it — self-contradictory, and the
                        // retry-only EOF rule must not truncate below a
                        // wire-declared ceiling.
                        return Outcome::Failed(StreamError::InvalidResponse {
                            message: format!(
                                "416 at offset {offset} but Content-Range declares total {total}"
                            ),
                        });
                    }
                    if eof_confirmed(session, offset, retried_416) {
                        return Outcome::Eof(offset);
                    }
                    retried_416 = true;
                    match remint(session).await {
                        Err(e) => {
                            return if stallable(&e) {
                                Outcome::Stalled(e)
                            } else {
                                Outcome::Failed(e)
                            };
                        }
                        // A fresh mint is a fresh attempt — the
                        // transient budget resets with the URL.
                        Ok(()) => transient_left = session.config.fetch_retries,
                    }
                }
                403 => match remint(session).await {
                    Err(e) => {
                        return if stallable(&e) {
                            Outcome::Stalled(e)
                        } else {
                            Outcome::Failed(e)
                        };
                    }
                    Ok(()) => transient_left = session.config.fetch_retries,
                },
                s => {
                    let e = classify_status(s, offset);
                    match retry_or_stall(session, through, e, &mut transient_left).await {
                        Retry::Again => continue,
                        Retry::Stop(o) => return o,
                    }
                }
            },
        }
    }
}

/// What a failed fetch attempt resolved to.
enum Retry {
    /// Transient budget remained — backoff slept, retry the request.
    Again,
    /// The fetch cycle ends with this outcome.
    Stop(Outcome),
}

/// Whether a failure is retriable network wobble that must never kill
/// a session on its own: it latches (`Outcome::Stalled`) so a parked
/// reader observes it once and demand re-drives the pump. Every other
/// kind is a terminal verdict — `InvalidResponse`, `NotFound`,
/// `StreamsCapped`, `Expired`, `Internal`, and the lifecycle kinds.
fn stallable(e: &StreamError) -> bool {
    matches!(
        e,
        StreamError::Transient { .. } | StreamError::RateLimited { .. }
    )
}

/// Apply the retry policy to one failed attempt: `Transient` retries
/// with backoff until `fetch_retries` runs out, `RateLimited` latches
/// straight away (a 429 wants real cooldown, not a 250 ms hammer),
/// and everything else is terminal.
async fn retry_or_stall(
    session: &Arc<SessionInner>,
    through: bool,
    e: StreamError,
    transient_left: &mut u32,
) -> Retry {
    if matches!(e, StreamError::Transient { .. }) && *transient_left > 0 {
        *transient_left -= 1;
        return match retry_backoff(session, through).await {
            Backoff::Waited => Retry::Again,
            Backoff::Preempted => Retry::Stop(Outcome::Preempted),
            Backoff::Cancelled => Retry::Stop(Outcome::Failed(StreamError::Cancelled)),
        };
    }
    Retry::Stop(if stallable(&e) {
        Outcome::Stalled(e)
    } else {
        Outcome::Failed(e)
    })
}

/// How the retry backoff ended.
enum Backoff {
    /// The sleep elapsed.
    Waited,
    /// A demand read preempted a speculative fill's backoff.
    Preempted,
    /// Session cancel landed mid-sleep.
    Cancelled,
}

/// Interruptible sleep between transient retries — a speculative
/// fill's backoff yields to demand reads the same way its fetch does.
async fn retry_backoff(session: &Arc<SessionInner>, through: bool) -> Backoff {
    let sleep = tokio::time::sleep(session.config.retry_backoff);
    tokio::pin!(sleep);
    if through {
        tokio::select! {
            () = &mut sleep => Backoff::Waited,
            () = session.cancel.cancelled() => Backoff::Cancelled,
        }
    } else {
        tokio::select! {
            () = &mut sleep => Backoff::Waited,
            () = session.ft_notify.notified() => Backoff::Preempted,
            () = session.cancel.cancelled() => Backoff::Cancelled,
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

/// Apply the `206` wire rules to a response's headers for a request
/// at `offset` of `max_len` bytes — run *before* any body byte is
/// trusted, so a lying server can't place pieces at wrong offsets.
/// Returns the declared body length (`end - start + 1`).
fn validate_206_head(
    session: &Arc<SessionInner>,
    content_range: Option<&str>,
    offset: u64,
    max_len: u64,
) -> Result<u64, StreamError> {
    let invalid = |m: String| StreamError::InvalidResponse { message: m };
    let Some(cr) = content_range else {
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
    let declared = end
        .checked_sub(start)
        .and_then(|span| span.checked_add(1))
        .ok_or_else(|| invalid(format!("Content-Range {start}-{end} overflows")))?;
    if declared > max_len {
        return Err(invalid(format!(
            "declared {start}-{end} exceeds requested {max_len} at {offset}"
        )));
    }
    if let Some(t) = total {
        if end >= t {
            return Err(invalid(format!(
                "Content-Range end {end} at/past declared total {t}"
            )));
        }
        session.check_total(t)?;
    }
    Ok(declared)
}

/// Parse the total from a `416`'s `Content-Range: <unit> */N` —
/// the range unit is case-insensitive; the `*/` unsatisfied form is
/// required (a satisfiable span on a 416 is a lie and is ignored).
fn unsatisfied_range_total(cr: &str) -> Option<u64> {
    let (unit, range) = cr.split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    // `str::parse::<u64>` accepts a leading `+` — digits only.
    let n = range.strip_prefix("*/")?.trim();
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    n.parse::<u64>().ok()
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
/// `5xx` and the retriable `408`/`425` are `Transient`, `429` is
/// `RateLimited`; every other `4xx` is a permanent verdict on this
/// URL and ends the session honestly rather than parking retriable
/// forever.
fn classify_status(status: u16, offset: u64) -> StreamError {
    let msg = || format!("status {status} at offset {offset}");
    match status {
        401 => StreamError::Expired,
        404 | 410 => StreamError::NotFound,
        408 | 425 => StreamError::Transient { message: msg() },
        429 => StreamError::RateLimited { message: msg() },
        200..=499 => StreamError::InvalidResponse {
            message: format!("range request answered {status}, not 206, at {offset}"),
        },
        _ => StreamError::Transient { message: msg() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::lock;
    use crate::fetch::{Fetch, FetchResponse};
    use crate::session::PoolSignals;
    use crate::testkit::*;
    use crate::{PreparedSource, StreamConfig};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    /// A re-mint that counts calls and yields a canned source.
    struct CountingRemint {
        calls: AtomicU32,
        mime: String,
        itag: Option<u32>,
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
            let itag = self.itag;
            Box::pin(async move {
                if let Some(e) = fail {
                    return Err(e);
                }
                Ok(PreparedSource {
                    url: "https://reminted.example/s".into(),
                    mime,
                    itag,
                    bitrate_kbps: None,
                    content_length: Some(1024),
                    expires_at_ms: None,
                    source_ref: "vid".into(),
                    provider: "test".into(),
                })
            })
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
                    body: stream_body(vec![]),
                })
            })
            .collect()
    }

    fn remint_ok() -> Arc<CountingRemint> {
        Arc::new(CountingRemint {
            calls: AtomicU32::new(0),
            mime: "audio/mp4".into(),
            itag: Some(140),
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

    /// The session's latched retriable error, if the pump stalled.
    fn latched(s: &Arc<SessionInner>) -> Option<StreamError> {
        lock(&s.shared)
            .ok()
            .and_then(|sh| sh.transient_error.clone())
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
            body: stream_body(vec![0u8; 16]),
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
            // `end` at u64::MAX overflows `end - start + 1` —
            // unrepresentable, never a debug panic or a wrapped len.
            (Some("bytes 0-18446744073709551615/*"), "end-overflow"),
        ] {
            let d = TestDir::new(name);
            let s = session(config(&d), remint_ok());
            let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
                status: 206,
                content_range: cr.map(str::to_string),
                body: stream_body(vec![1u8; 64]),
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
            r.body = stream_body(vec![1u8; body_len]);
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
                body: stream_body(vec![]),
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
            itag: Some(140),
            fail: Mutex::new(None),
        });
        let s = session(config(&d), remint);
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
            status: 403,
            content_range: None,
            body: stream_body(vec![]),
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

    /// The itag pin is the mime pin's twin: a re-mint that returns a
    /// different encode under the *same* container is terminal
    /// `InvalidResponse` — a silent itag swap spliced into the extents
    /// is a bug, not a recovery.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn itag_swap_on_remint_is_terminal() {
        let d = TestDir::new("itagswap");
        let remint = Arc::new(CountingRemint {
            calls: AtomicU32::new(0),
            mime: "audio/mp4".into(), // same container — the itag differs
            itag: Some(599),          // the source minted Some(140)
            fail: Mutex::new(None),
        });
        let s = session(config(&d), remint);
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
            status: 403,
            content_range: None,
            body: stream_body(vec![]),
        })]));
        let task = spawn_pump(&s, fetch);
        wait_until(|| s.is_terminal()).await;
        match s.terminal_err() {
            Some(StreamError::InvalidResponse { message }) => {
                assert!(message.contains("itag"), "{message}");
                assert!(!message.contains("reminted.example"), "{message}");
            }
            other => panic!("expected InvalidResponse, got {other:?}"),
        }
        stop_pump(&s, task).await;
    }

    /// A re-mint that keeps the same itag under the pinned mime is
    /// adopted — the pin rejects swaps, not re-mints. The pump takes
    /// the fresh URL and resumes the fill at the cap-death offset.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn matching_itag_remint_adopts() {
        let d = TestDir::new("itagmatch");
        let remint = remint_ok(); // same mime, same itag Some(140)
        let s = session(config(&d), remint.clone());
        let fetch = Arc::new(ScriptedFetch::new(vec![
            Step::Reply(resp(206, 0, 128, 1024)),
            Step::Reply(FetchResponse {
                status: 403,
                content_range: None,
                body: stream_body(vec![]),
            }),
            Step::Reply(resp(206, 128, 128, 1024)),
        ]));
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        wait_until(|| head_ready(&s) || s.is_terminal()).await;
        assert!(
            !s.is_terminal(),
            "a matching-itag re-mint must not be terminal"
        );
        assert_eq!(remint.calls.load(Ordering::Relaxed), 1);
        let (committed, minted) = lock(&s.shared)
            .map(|sh| (sh.committed, sh.marks.mint_ms.is_some()))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(committed, 256);
        assert!(minted);
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
        // eof_below marks the ceiling instead of an error. Bare 416s —
        // a declared total above the offset is a contradiction, not
        // EOF evidence.
        let fetch = Arc::new(ScriptedFetch::new(
            (0..2)
                .map(|_| {
                    Step::Reply(FetchResponse {
                        status: 416,
                        content_range: None,
                        body: stream_body(vec![]),
                    })
                })
                .collect(),
        ));
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

    /// `404` is a terminal verdict; `429` and `5xx` are retriable and
    /// latch instead of killing the session.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn not_found_terminates_retriable_statuses_latch() {
        let d = TestDir::new("nf404");
        let s = session(config(&d), remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
            status: 404,
            content_range: None,
            body: stream_body(vec![]),
        })]));
        let task = spawn_pump(&s, fetch);
        wait_until(|| s.is_terminal()).await;
        assert!(matches!(s.terminal_err(), Some(StreamError::NotFound)));
        stop_pump(&s, task).await;

        // 429 latches immediately — a rate-limit wants real cooldown,
        // not a backoff hammer.
        let d = TestDir::new("rl429");
        let s = session(config(&d), remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
            status: 429,
            content_range: None,
            body: stream_body(vec![]),
        })]));
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        wait_until(|| latched(&s).is_some() || s.is_terminal()).await;
        assert!(
            matches!(latched(&s), Some(StreamError::RateLimited { .. })),
            "{:?}",
            latched(&s)
        );
        assert!(!s.is_terminal(), "a 429 must never kill a session");
        assert_eq!(
            fetch
                .requests
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len(),
            1,
            "rate-limit must not be retried inline"
        );
        stop_pump(&s, task).await;

        // 5xx classifies Transient: retried `fetch_retries` times, then
        // latched — still not terminal.
        let d = TestDir::new("t503");
        let s = session(config(&d), remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(status_steps(503, 3)));
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        wait_until(|| latched(&s).is_some() || s.is_terminal()).await;
        assert!(
            matches!(latched(&s), Some(StreamError::Transient { .. })),
            "{:?}",
            latched(&s)
        );
        assert!(!s.is_terminal(), "a 503 must never kill a session");
        assert_eq!(
            fetch
                .requests
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len(),
            3,
            "transient retry budget is fetch_retries + the first attempt"
        );
        stop_pump(&s, task).await;
    }

    /// A permanent `4xx` is a terminal verdict on the URL, never a
    /// latch: `401` reports `Expired` (a dead mint — retriable upstream
    /// via re-resolve), `410` joins `404` as `NotFound`, and any other
    /// permanent refusal is `InvalidResponse`. Only `408`/`425` among
    /// `4xx` stay retriable, like `5xx`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn permanent_4xx_terminates_instead_of_stalling() {
        for (status, kind) in [
            (400u16, "invalid-response"),
            (401, "expired"),
            (410, "not-found"),
            (418, "invalid-response"),
        ] {
            let d = TestDir::new(&format!("p{status}"));
            let s = session(config(&d), remint_ok());
            let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
                status,
                content_range: None,
                body: stream_body(vec![]),
            })]));
            let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
            wait_until(|| s.is_terminal()).await;
            assert_eq!(s.terminal_err().map(|e| e.kind()), Some(kind), "{status}");
            assert_eq!(
                fetch
                    .requests
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .len(),
                1,
                "a permanent {status} must not burn the retry budget"
            );
            stop_pump(&s, task).await;
        }
        // `408` (and `425`) are retriable `4xx`: retried within
        // `fetch_retries`, then latched — still not terminal.
        let d = TestDir::new("t408");
        let s = session(config(&d), remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(status_steps(408, 3)));
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        wait_until(|| latched(&s).is_some() || s.is_terminal()).await;
        assert!(
            matches!(latched(&s), Some(StreamError::Transient { .. })),
            "{:?}",
            latched(&s)
        );
        assert!(!s.is_terminal(), "a 408 must never kill a session");
        assert_eq!(
            fetch
                .requests
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len(),
            3,
            "retriable 4xx spend the same retry budget as 5xx"
        );
        stop_pump(&s, task).await;
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
            itag: Some(140),
            fail: Mutex::new(Some(StreamError::Expired)),
        });
        let s = session(config(&d), remint);
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
            status: 403,
            content_range: None,
            body: stream_body(vec![]),
        })]));
        let task = spawn_pump(&s, fetch);
        wait_until(|| s.is_terminal()).await;
        assert!(matches!(s.terminal_err(), Some(StreamError::Expired)));
        stop_pump(&s, task).await;
    }

    /// A transient transport failure retries within `fetch_retries`,
    /// then latches — the session stays live, and an attach (fresh
    /// intent) clears the latch and re-drives the pump to success.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transient_fetch_latches_then_attach_recovers() {
        let d = TestDir::new("fetcherr");
        let s = session(config(&d), remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(vec![
            Step::Fail(StreamError::Transient {
                message: "conn reset".into(),
            }),
            Step::Fail(StreamError::Transient {
                message: "conn reset".into(),
            }),
            Step::Fail(StreamError::Transient {
                message: "conn reset".into(),
            }),
        ]));
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        wait_until(|| latched(&s).is_some() || s.is_terminal()).await;
        assert!(
            matches!(latched(&s), Some(StreamError::Transient { .. })),
            "{:?}",
            latched(&s)
        );
        assert!(
            !s.is_terminal(),
            "network wobble must never be session death"
        );
        assert_eq!(
            fetch
                .requests
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len(),
            3,
            "first attempt plus fetch_retries retries"
        );
        // Fresh intent (a DataSource open) clears the latch — the next
        // fetch is scripted to succeed and the fill completes.
        fetch
            .steps
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push_back(Step::Reply(resp(206, 0, 128, 1024)));
        s.attach(0).unwrap_or_else(|e| panic!("attach: {e}"));
        wait_until(|| {
            s.is_terminal()
                || lock(&s.shared)
                    .map(|sh| sh.committed >= 128)
                    .unwrap_or(false)
        })
        .await;
        assert_eq!(
            lock(&s.shared).map(|sh| sh.committed).unwrap_or(0),
            128,
            "the re-driven pump must commit the recovered fetch"
        );
        stop_pump(&s, task).await;
    }

    /// A hung `playback.resolve` must not zombie the session — the
    /// re-mint is bounded by `mint_deadline` and ends `Transient`,
    /// which latches: a stalled mint is retriable, so the session
    /// survives it for the next attempt.
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
            body: stream_body(vec![]),
        })]));
        let task = spawn_pump(&s, fetch);
        wait_until(|| latched(&s).is_some() || s.is_terminal()).await;
        assert!(
            matches!(latched(&s), Some(StreamError::Transient { .. })),
            "{:?}",
            latched(&s)
        );
        assert!(!s.is_terminal(), "a stalled mint must not kill the session");
        stop_pump(&s, task).await;
    }

    /// A commit landing after a terminal transition is a data write
    /// only — it must not resurrect the evicted sidecar.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn commit_after_terminal_does_not_resurrect_sidecar() {
        let d = TestDir::new("latecommit");
        let s = session(config(&d), remint_ok());
        s.terminate(StreamError::Released);
        let _ = s.commit(0, &[7u8; 64]);
        assert!(!s.paths.sidecar.exists(), "sidecar resurrected post-evict");
    }

    /// Requests recorded against one offset — offset-keyed assertions
    /// survive the pump issuing unrelated fill alongside.
    fn count_at(fetch: &ScriptedFetch, offset: u64) -> usize {
        fetch
            .requests
            .lock()
            .map(|r| r.iter().filter(|(o, _)| *o == offset).count())
            .unwrap_or(0)
    }

    /// Whether the store covers `pos` — fail-closed for `wait_until`.
    fn covers(s: &Arc<SessionInner>, pos: u64) -> bool {
        lock(&s.store).map(|st| st.covers(pos)).unwrap_or(false)
    }

    /// Queue a demand position the way `queue_through` does (insert +
    /// `ft_notify`) — mid-flight demand is what `await_fetch` watches.
    fn queue_demand(s: &Arc<SessionInner>, pos: u64) {
        {
            let mut sh = lock(&s.shared).unwrap_or_else(|e| panic!("{e}"));
            sh.fetch_through.insert(pos, 1);
        }
        s.ft_notify.notify_one();
    }

    /// Probe sizing: the first fill rides a small request so first-byte
    /// and head-ready land a `chunk_bytes` transfer sooner; steady-state
    /// fill is back to `chunk_bytes`; demand fetches stay probe-sized —
    /// a parked reader wants unblocking, not bulk fill. An out-of-range
    /// demand still preempts an in-flight fill outright.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn probe_sizes_first_fill_and_demand_outside_still_preempts() {
        let d = TestDir::new("probe");
        let mut cfg = config(&d);
        cfg.probe_bytes = 32;
        let s = session(cfg, remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(vec![
            Step::Reply(resp(206, 0, 32, 1024)),
            Step::Reply(resp(206, 32, 128, 1024)),
            Step::Hang,
            Step::Reply(resp(206, 500, 32, 1024)),
        ]));
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        // (0,32) is the probe fill; (32,128) proves the chunk is back;
        // (160,96) is the in-flight fill the demand below preempts.
        wait_until(|| {
            s.is_terminal() || fetch.requests.lock().map(|r| r.len() >= 3).unwrap_or(false)
        })
        .await;
        queue_demand(&s, 500);
        wait_until(|| {
            s.is_terminal() || fetch.requests.lock().map(|r| r.len() >= 4).unwrap_or(false)
        })
        .await;
        stop_pump(&s, task).await;
        let reqs = fetch
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        assert_eq!(
            reqs[..4],
            [(0, 32), (32, 128), (160, 96), (500, 32)],
            "{reqs:?}"
        );
    }

    /// A demand that lands inside the in-flight fill's range rides it:
    /// no preempt, no second request — the arriving body commits and
    /// serves the reader's position.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn covered_demand_rides_the_in_flight_fill() {
        let d = TestDir::new("covered");
        let s = session(config(&d), remint_ok());
        // Headers in, body gated on the test — the fetch is provably
        // in flight while the demand queues.
        let open = Arc::new(tokio::sync::Notify::new());
        let open2 = Arc::clone(&open);
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Reply(FetchResponse {
            status: 206,
            content_range: Some("bytes 0-127/1024".into()),
            body: Box::pin(futures_util::stream::once(async move {
                open2.notified().await;
                Ok(vec![1u8; 128])
            })),
        })]));
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        wait_until(|| s.is_terminal() || count_at(&fetch, 0) == 1).await;
        queue_demand(&s, 0);
        // The covered deadline is `stall` (2 s) out — far past this
        // window; a preempt would have issued a second request at 0.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            count_at(&fetch, 0),
            1,
            "covered demand re-issued the in-flight range"
        );
        open.notify_one();
        wait_until(|| s.is_terminal() || covers(&s, 0)).await;
        stop_pump(&s, task).await;
        assert_eq!(count_at(&fetch, 0), 1);
    }

    /// Past the stall budget the covered demand stops riding: a fill
    /// that cannot serve it in time is preempted and the demand's own
    /// request goes out.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn covered_deadline_preempts_a_hung_fill() {
        let d = TestDir::new("bail");
        let mut cfg = config(&d);
        cfg.stall = Duration::from_millis(300);
        let s = session(cfg, remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(vec![
            Step::Hang,
            Step::Reply(resp(206, 0, 128, 1024)),
        ]));
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        wait_until(|| s.is_terminal() || count_at(&fetch, 0) == 1).await;
        queue_demand(&s, 0);
        // ~stall of covered riding, then the demand's own fetch — and
        // its commit lands.
        wait_until(|| s.is_terminal() || count_at(&fetch, 0) == 2).await;
        wait_until(|| s.is_terminal() || covers(&s, 0)).await;
        stop_pump(&s, task).await;
    }

    /// A covered demand that drains before the deadline must disarm
    /// it: `drop_through` never signals `ft_notify`, so the bail has
    /// to re-check demand before preempting — a dead demand must not
    /// abort a healthy fill.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn drained_demand_disarms_the_covered_deadline() {
        let d = TestDir::new("disarm");
        let mut cfg = config(&d);
        cfg.stall = Duration::from_millis(300);
        let s = session(cfg, remint_ok());
        let fetch = Arc::new(ScriptedFetch::new(vec![Step::Hang]));
        let task = spawn_pump(&s, Arc::clone(&fetch) as Arc<dyn Fetch>);
        wait_until(|| s.is_terminal() || count_at(&fetch, 0) == 1).await;
        queue_demand(&s, 0);
        // Let the pump arm the deadline, then drain the demand the way
        // a departing reader does — silently, no `ft_notify`.
        tokio::time::sleep(Duration::from_millis(150)).await;
        {
            let mut sh = lock(&s.shared).unwrap_or_else(|e| panic!("{e}"));
            sh.fetch_through.remove(&0);
        }
        // The deadline fires ~stall after arming; give it ample room
        // and prove no second request ever went out.
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(
            count_at(&fetch, 0),
            1,
            "drained demand still preempted the fill"
        );
        assert!(!s.is_terminal());
        stop_pump(&s, task).await;
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
