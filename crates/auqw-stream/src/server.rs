//! The `127.0.0.1` range-serving fallback adapter — the only real
//! HTTP hop the seam ever makes, and only on surfaces whose player
//! cannot take the random-access byte seam directly (desktop MSE
//! rejecting a non-fragmented container; the web LAN relay). Serving
//! is grant-based: `serve` mints an unguessable path token over a
//! live session handle, and a session that ends stops answering
//! (`410`) without explicit revocation.
//!
//! Per-connection OS threads park on the seam's blocking-read
//! `Condvar` — exactly the foreign-thread case that bridge exists
//! for; runtime workers are never parked. Every response is
//! `Connection: close`: the audio element opens one socket per range
//! request and keep-alive buys nothing on loopback.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::error::lock;
use crate::{StreamError, StreamRegistry};

/// Bytes requested per seam read while streaming a response.
const READ_CHUNK: u64 = 256 * 1024;
/// Request-head cap — anything larger is a malformed client.
const MAX_HEAD_BYTES: usize = 16 * 1024;
/// Header-count cap alongside the byte cap.
const MAX_HEAD_LINES: usize = 128;
/// Accept-loop poll interval while the listener stays nonblocking.
const ACCEPT_POLL: Duration = Duration::from_millis(20);
/// How long a connection may sit mid-request before the head read
/// gives up. Loopback clients answer promptly; this is only a leak
/// bound for a stalled socket.
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);

/// A body write blocks only this long on client backpressure — a
/// stalled or dead reader holds a conn slot (and the session's
/// attach) only up to the timeout, then the conn reaps like any
/// client-gone end.
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// Concurrent connection threads — an accept flood can't exhaust the
/// process, the accept loop just waits for a slot to drain.
const MAX_CONN_THREADS: usize = 64;

/// A served handle as reported to connections.
struct Grant {
    handle: String,
    mime: String,
}

/// A parsed `Range: bytes=…` request. Multi-interval and malformed
/// syntax both surface as `Invalid` → `416`.
enum RangeSpec {
    /// `bytes=S-E` (E inclusive).
    Interval(u64, u64),
    /// `bytes=S-`.
    From(u64),
    /// `bytes=-N` — the last N bytes (mp4 `moov` sniffing).
    Suffix(u64),
    /// Present but unparseable or unsupported — answers `416`.
    Invalid,
}

struct Request {
    /// `HEAD` carries headers only.
    head_only: bool,
    method: String,
    path: String,
    range: Option<RangeSpec>,
}

struct Shared {
    addr: SocketAddr,
    registry: Arc<StreamRegistry>,
    grants: Mutex<HashMap<String, Grant>>,
    shutdown: AtomicBool,
    /// Live conn-thread count + slot-free signal (`Mutex`, `Condvar`).
    conn_slots: Arc<(Mutex<usize>, Condvar)>,
    /// Open conns per session handle — `close` runs only when the
    /// last one ends; an eager close would bump the detach epoch
    /// and cancel sibling conns' parked reads.
    attaches: Mutex<HashMap<String, usize>>,
}

/// The bound loopback adapter. `Drop` stops the accept loop; live
/// per-connection threads unwind on their session's terminal error
/// or on the socket closing.
pub struct StreamServer {
    shared: Arc<Shared>,
    accept: Mutex<Option<JoinHandle<()>>>,
}

impl StreamServer {
    /// Bind `127.0.0.1` on an ephemeral port and start accepting.
    /// One server per host; the registry owns session lifecycle.
    ///
    /// # Errors
    /// [`StreamError::Internal`] when the socket can't bind, go
    /// nonblocking, or spawn the accept thread.
    pub fn start(registry: Arc<StreamRegistry>) -> Result<Self, StreamError> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| StreamError::Internal {
            message: format!("loopback bind: {e}"),
        })?;
        listener
            .set_nonblocking(true)
            .map_err(|e| StreamError::Internal {
                message: format!("loopback nonblocking: {e}"),
            })?;
        let addr = listener.local_addr().map_err(|e| StreamError::Internal {
            message: format!("loopback addr: {e}"),
        })?;
        let shared = Arc::new(Shared {
            addr,
            registry,
            grants: Mutex::new(HashMap::new()),
            shutdown: AtomicBool::new(false),
            conn_slots: Arc::new((Mutex::new(0), Condvar::new())),
            attaches: Mutex::new(HashMap::new()),
        });
        let accept = {
            let shared = Arc::clone(&shared);
            thread::Builder::new()
                .name("auqw-stream-accept".into())
                .spawn(move || accept_loop(listener, shared))
                .map_err(|e| StreamError::Internal {
                    message: format!("accept spawn: {e}"),
                })?
        };
        Ok(Self {
            shared,
            accept: Mutex::new(Some(accept)),
        })
    }

    /// Mint a serving URL for a live session handle:
    /// `http://127.0.0.1:{port}/s/{token}`. Dead grants are pruned on
    /// the way in; a request for a handle that has since ended
    /// answers the session's terminal error mapped to HTTP.
    ///
    /// # Errors
    /// [`StreamError::NotFound`] for an unknown handle; the session's
    /// terminal error if it already ended; [`StreamError::Internal`]
    /// on token RNG or lock failure.
    pub fn serve(&self, handle: &str) -> Result<String, StreamError> {
        if let Some(e) = self.shared.registry.terminal_err(handle)? {
            return Err(e);
        }
        let (mime, _hint) = self.shared.registry.source_meta(handle)?;
        let mut grants = lock(&self.shared.grants)?;
        grants.retain(|_, g| self.shared.registry.is_live(&g.handle));
        // A live grant for this handle is already a valid URL —
        // minting per call would grow the map for the session's
        // whole lifetime.
        if let Some((token, _)) = grants.iter().find(|(_, g)| g.handle == handle) {
            return Ok(format!("http://{}/s/{token}", self.shared.addr));
        }
        let token = loop {
            let mut raw = [0u8; 16];
            getrandom::fill(&mut raw).map_err(|e| StreamError::Internal {
                message: format!("grant token: {e}"),
            })?;
            let t = raw.iter().map(|b| format!("{b:02x}")).collect::<String>();
            if !grants.contains_key(&t) {
                break t;
            }
        };
        grants.insert(
            token.clone(),
            Grant {
                handle: handle.to_string(),
                mime,
            },
        );
        Ok(format!("http://{}/s/{token}", self.shared.addr))
    }

    /// The bound loopback port.
    #[must_use]
    pub fn port(&self) -> u16 {
        self.shared.addr.port()
    }
}

impl Drop for StreamServer {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::Relaxed);
        if let Ok(mut a) = self.accept.lock() {
            if let Some(h) = a.take() {
                let _ = h.join();
            }
        }
    }
}

/// A held conn-thread slot; `Drop` frees it for the accept loop.
struct ConnPermit {
    slots: Arc<(Mutex<usize>, Condvar)>,
}

impl Drop for ConnPermit {
    fn drop(&mut self) {
        if let Ok(mut n) = self.slots.0.lock() {
            *n = n.saturating_sub(1);
        }
        self.slots.1.notify_one();
    }
}

/// Take a conn-thread slot, parking while the pool is full. `None`
/// means the slot counter is poisoned or the server is shutting
/// down — the caller drops the conn and the client retries.
fn conn_permit(shared: &Shared) -> Option<ConnPermit> {
    let mut n = shared.conn_slots.0.lock().ok()?;
    loop {
        if *n < MAX_CONN_THREADS {
            *n += 1;
            return Some(ConnPermit {
                slots: Arc::clone(&shared.conn_slots),
            });
        }
        if shared.shutdown.load(Ordering::Relaxed) {
            return None;
        }
        let (guard, _) = match shared.conn_slots.1.wait_timeout(n, ACCEPT_POLL) {
            Ok(r) => r,
            Err(p) => p.into_inner(),
        };
        n = guard;
    }
}

fn accept_loop(listener: TcpListener, shared: Arc<Shared>) {
    loop {
        match listener.accept() {
            Ok((conn, _)) => {
                // A connection we cannot service is closed by dropping
                // it — the client retries. A full conn pool just parks
                // the accept loop until a slot drains (or shutdown).
                let Some(permit) = conn_permit(&shared) else {
                    if shared.shutdown.load(Ordering::Relaxed) {
                        return;
                    }
                    continue;
                };
                let shared = Arc::clone(&shared);
                let _ = thread::Builder::new()
                    .name("auqw-stream-conn".into())
                    .spawn(move || {
                        let _permit = permit;
                        let _ = serve_conn(conn, &shared);
                    });
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => {
                if shared.shutdown.load(Ordering::Relaxed) {
                    return;
                }
                // Nonblocking accept polls; the interval is the
                // shutdown latency, fine for a session-scoped adapter.
                thread::sleep(ACCEPT_POLL);
            }
        }
    }
}

/// Status code for a seam failure surfaced before headers were sent.
fn status_for(e: &StreamError) -> u16 {
    match e {
        StreamError::NotFound => 404,
        StreamError::Cancelled
        | StreamError::Released
        | StreamError::Superseded
        | StreamError::Evicted
        | StreamError::Expired => 410,
        StreamError::Transient { .. } | StreamError::AuthRequired { .. } => 503,
        StreamError::RateLimited { .. }
        | StreamError::StreamsCapped { .. }
        | StreamError::InvalidResponse { .. } => 502,
        StreamError::Internal { .. } => 500,
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        410 => "Gone",
        416 => "Range Not Satisfiable",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "Service Unavailable",
    }
}

fn write_head(
    out: &mut TcpStream,
    status: u16,
    headers: &[(String, String)],
) -> Result<(), StreamError> {
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (k, v) in headers {
        head.push_str(k);
        head.push_str(": ");
        head.push_str(v);
        head.push_str("\r\n");
    }
    head.push_str("Connection: close\r\n\r\n");
    out.write_all(head.as_bytes())
        .map_err(|e| StreamError::Internal {
            message: format!("response head: {e}"),
        })
}

fn write_status(out: &mut TcpStream, status: u16, extra: &[(String, String)]) {
    let mut headers = vec![("Content-Length".to_string(), "0".to_string())];
    headers.extend(extra.iter().cloned());
    let _ = write_head(out, status, &headers);
}

/// One bounded line read: the `take` cap means a newline-free client
/// cannot make the buffer allocate past the head cap it never
/// reaches; a NUL or an oversized head is malformed.
fn read_line(
    reader: &mut BufReader<TcpStream>,
    total: &mut usize,
    lines: &mut usize,
) -> Result<String, StreamError> {
    let mut line = String::new();
    let headroom = (MAX_HEAD_BYTES + 1).saturating_sub(*total) as u64;
    let n = Read::by_ref(reader)
        .take(headroom)
        .read_line(&mut line)
        .map_err(|e| StreamError::InvalidResponse {
            message: format!("request head: {e}"),
        })?;
    *total += n;
    *lines += 1;
    if n == 0 || *total > MAX_HEAD_BYTES || *lines > MAX_HEAD_LINES {
        return Err(StreamError::InvalidResponse {
            message: "request head over cap".into(),
        });
    }
    Ok(line)
}

fn parse_range(value: &str) -> Option<RangeSpec> {
    // A unit other than `bytes` is uninterpretable — RFC 9110 lets a
    // server ignore it entirely, which answers with a normal `200`.
    // Range units are ASCII tokens and case-insensitive.
    let (unit, spec) = value.split_once('=')?;
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return None;
    }
    let spec = spec.trim();
    if spec.contains(',') {
        return Some(RangeSpec::Invalid);
    }
    Some(match spec.split_once('-') {
        Some(("", n)) => match n.trim().parse::<u64>() {
            Ok(n) if n > 0 => RangeSpec::Suffix(n),
            _ => RangeSpec::Invalid,
        },
        Some((s, "")) => match s.trim().parse::<u64>() {
            Ok(s) => RangeSpec::From(s),
            _ => RangeSpec::Invalid,
        },
        Some((s, e)) => match (s.trim().parse::<u64>(), e.trim().parse::<u64>()) {
            (Ok(s), Ok(e)) if s <= e => RangeSpec::Interval(s, e),
            _ => RangeSpec::Invalid,
        },
        None => RangeSpec::Invalid,
    })
}

fn parse_request(reader: &mut BufReader<TcpStream>) -> Result<Request, StreamError> {
    let mut total = 0usize;
    let mut lines = 0usize;
    let request_line = read_line(reader, &mut total, &mut lines)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    // `HTTP/1.x` and anything after are ignored — this server answers
    // the first request only.
    let mut range = None;
    loop {
        let line = read_line(reader, &mut total, &mut lines)?;
        if line.trim_end().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("range") {
                range = parse_range(value.trim());
            }
        }
    }
    Ok(Request {
        head_only: method == "HEAD",
        method,
        path,
        range,
    })
}

fn serve_conn(conn: TcpStream, shared: &Shared) -> Result<(), StreamError> {
    // Accepted sockets inherit nonblocking mode from the listener on
    // Windows; the conn protocol assumes blocking-with-timeout I/O.
    conn.set_nonblocking(false).ok();
    conn.set_read_timeout(Some(HEAD_TIMEOUT)).ok();
    conn.set_write_timeout(Some(WRITE_TIMEOUT)).ok();
    let mut out = conn.try_clone().map_err(|e| StreamError::Internal {
        message: format!("conn clone: {e}"),
    })?;
    let mut reader = BufReader::new(conn);
    let result = match parse_request(&mut reader) {
        Ok(req) => respond(&mut out, shared, &req),
        Err(e) => {
            write_status(&mut out, 400, &[]);
            Err(e)
        }
    };
    graceful_close(&mut reader);
    result
}

/// Windows RSTs a socket closed with unread inbound data, which can
/// erase the just-written reply before the client's next `recv`.
/// `Connection: close` semantics only need a FIN: shut the write
/// side, drain whatever the client still had buffered (bounded — a
/// chatty client cannot stall the thread), then let the drop close
/// an empty receive buffer cleanly.
fn graceful_close(reader: &mut BufReader<TcpStream>) {
    let conn = reader.get_ref();
    if conn.shutdown(std::net::Shutdown::Write).is_err() {
        return;
    }
    if conn
        .set_read_timeout(Some(Duration::from_millis(300)))
        .is_err()
    {
        return;
    }
    let mut sink = [0u8; 8192];
    let mut drained = 0usize;
    loop {
        match reader.read(&mut sink) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                drained += n;
                if drained > 64 * 1024 {
                    return;
                }
            }
        }
    }
}

/// Attach under the server's per-handle conn count — the
/// DataSource-open semantic. The count is what keeps sibling conns'
/// reads alive when one conn ends: `close` runs only when the last
/// conn releases. Held under the same lock as the decrement so a
/// racing attach is ordered against the detach.
fn attach_counted(shared: &Shared, handle: &str, position: u64) -> Result<(), StreamError> {
    let mut counts = lock(&shared.attaches)?;
    shared.registry.attach(handle, position)?;
    *counts.entry(handle.to_string()).or_insert(0) += 1;
    Ok(())
}

/// Detaches the session a request attached when the connection ends
/// — the DataSource-close semantic, applied once the LAST conn
/// holding the handle ends. Without it a served conn pins the
/// session attached forever, invisible to detached reaping and
/// immune to supersede; with a per-conn close, an ending conn would
/// cancel its still-reading siblings.
struct AttachClose<'a> {
    shared: &'a Shared,
    handle: Option<String>,
}

impl Drop for AttachClose<'_> {
    fn drop(&mut self) {
        let Some(h) = self.handle.take() else {
            return;
        };
        match lock(&self.shared.attaches) {
            Ok(mut counts) => {
                let last = match counts.get_mut(&h) {
                    Some(n) if *n > 1 => {
                        *n -= 1;
                        false
                    }
                    _ => {
                        counts.remove(&h);
                        true
                    }
                };
                if last {
                    // Still under the counts lock: a racing conn's
                    // attach is ordered — it either incremented
                    // first (its count survives) or lands after and
                    // re-attaches the now-detached session, the
                    // documented re-open path.
                    let _ = self.shared.registry.close(&h);
                }
            }
            // A poisoned count lock still unpins the session.
            Err(_) => {
                let _ = self.shared.registry.close(&h);
            }
        }
    }
}

/// Resolve `(start, end_inclusive)` for the request's range against
/// the session's best-known total; `None` end = serve until EOF.
fn resolve_range(range: &RangeSpec, total: Option<u64>) -> Result<(u64, Option<u64>), u16> {
    match *range {
        RangeSpec::Interval(s, e) => match total {
            Some(t) if s >= t => Err(416),
            Some(t) => Ok((s, Some(e.min(t - 1)))),
            // An unknown total can't anchor an explicit end —
            // `bytes S-E/*` isn't a Content-Range, so this answers 416.
            None => Err(416),
        },
        RangeSpec::From(s) => match total {
            Some(t) if s >= t => Err(416),
            Some(t) => Ok((s, Some(t - 1))),
            None => Err(416),
        },
        RangeSpec::Suffix(n) => match total {
            // A suffix range on an empty resource satisfies nothing.
            Some(0) => Err(416),
            Some(t) => {
                let n = n.min(t);
                Ok((t - n, Some(t - 1)))
            }
            None => Err(416),
        },
        RangeSpec::Invalid => Err(416),
    }
}

/// Write the response head for a GET/HEAD: `206` + `Content-Range`
/// when the request was ranged, else `200` — no `Content-Length`
/// when no bound exists (the body is then close-delimited).
fn write_reply_head(
    out: &mut TcpStream,
    mime: &str,
    ranged: bool,
    start: u64,
    end: Option<u64>,
    total: Option<u64>,
) -> Result<(), StreamError> {
    let mut headers = vec![
        ("Content-Type".to_string(), mime.to_string()),
        ("Accept-Ranges".to_string(), "bytes".to_string()),
        ("Cache-Control".to_string(), "no-store".to_string()),
    ];
    if let Some(len) = end
        .and_then(|e| e.checked_sub(start).map(|d| d + 1))
        .or_else(|| (total == Some(0)).then_some(0))
    {
        headers.push(("Content-Length".to_string(), len.to_string()));
    }
    if ranged {
        // `resolve_range` guarantees both bounds when it returns Ok.
        let e = end.unwrap_or(start);
        let t = total.unwrap_or(0);
        headers.push((
            "Content-Range".to_string(),
            format!("bytes {start}-{e}/{t}"),
        ));
        write_head(out, 206, &headers)
    } else {
        // Unknown total: no Content-Length, the body is delimited by
        // the connection closing.
        write_head(out, 200, &headers)
    }
}

fn respond(out: &mut TcpStream, shared: &Shared, req: &Request) -> Result<(), StreamError> {
    if req.method != "GET" && !req.head_only {
        write_status(out, 405, &[("Allow".to_string(), "GET, HEAD".to_string())]);
        return Ok(());
    }
    let token = req
        .path
        .strip_prefix("/s/")
        .filter(|t| t.len() == 32 && t.bytes().all(|b| b.is_ascii_hexdigit()));
    let Some(token) = token else {
        write_status(out, 404, &[]);
        return Ok(());
    };
    let grant = {
        let grants = lock(&shared.grants)?;
        grants
            .get(token)
            .map(|g| (g.handle.clone(), g.mime.clone()))
    };
    let Some((handle, mime)) = grant else {
        write_status(out, 404, &[]);
        return Ok(());
    };
    // The session detaches when the LAST conn holding it ends — a
    // parked attachment would shield the session from detached
    // reaping and supersede forever, while a per-conn close would
    // cancel sibling conns' parked reads.
    let mut detach = AttachClose {
        shared,
        handle: None,
    };
    let hinted = match shared.registry.effective_total(&handle) {
        Ok(t) => t,
        Err(e) => {
            write_status(out, status_for(&e), &[]);
            return Ok(());
        }
    };
    // A session that already ended answers its typed terminal error —
    // not a range-coherence verdict computed for a dead stream.
    match shared.registry.terminal_err(&handle) {
        Ok(None) => {}
        Ok(Some(e)) | Err(e) => {
            write_status(out, status_for(&e), &[]);
            return Ok(());
        }
    }
    let star = |total: Option<u64>| total.map_or_else(|| "*".to_string(), |t| t.to_string());
    // Malformed range syntax needs no total to fail — and a `200`
    // that starts mid-resource would lie, so `416` is the honest
    // answer RFC 9110 gives a range that cannot be satisfied.
    if matches!(req.range, Some(RangeSpec::Invalid)) {
        write_status(
            out,
            416,
            &[("Content-Range".into(), format!("bytes */{}", star(hinted)))],
        );
        return Ok(());
    }
    if hinted == Some(0) {
        // An empty representation: every range is unsatisfiable and
        // an unranged reply is `Content-Length: 0`. No attach or
        // probe read can learn more — a read at 0 is already at the
        // hinted end and declared EOF, so a wire-discovered total is
        // unreachable for a hint-zero stream regardless.
        if req.range.is_some() {
            write_status(out, 416, &[("Content-Range".into(), "bytes */0".into())]);
        } else {
            write_reply_head(out, &mime, false, 0, None, Some(0))?;
        }
        return Ok(());
    }
    if req.head_only {
        // HEAD proves liveness and reports bounds — no body bytes are
        // spent on it, so the verdict resolves on the resolve-time
        // hint (the wire's correction needs a read a HEAD never
        // spends).
        let (start, end) = match &req.range {
            None => (0u64, hinted.and_then(|t| t.checked_sub(1))),
            Some(spec) => match resolve_range(spec, hinted) {
                Ok(r) => r,
                Err(status) => {
                    write_status(
                        out,
                        status,
                        &[("Content-Range".into(), format!("bytes */{}", star(hinted)))],
                    );
                    return Ok(());
                }
            },
        };
        if let Err(e) = attach_counted(shared, &handle, start) {
            write_status(out, status_for(&e), &[]);
            return Ok(());
        }
        detach.handle = Some(handle.clone());
        return write_reply_head(out, &mime, req.range.is_some(), start, end, hinted);
    }
    // GET: the resolve-time hint can lie until the wire's
    // `Content-Range` lands, so the verdict resolves on the freshest
    // total — while a read at or past the known end is declared EOF
    // and fetches nothing. Where to probe: the spec's own position
    // when it lands inside the hinted bounds, else the boundary just
    // before the hinted end — a read on an uncovered position
    // triggers a fetch that can reveal the real total (a covered
    // probe can't — the hinted verdict then stands).
    let provisional = match &req.range {
        Some(RangeSpec::Interval(s, _) | RangeSpec::From(s)) => {
            (*s).min(hinted.map_or(*s, |t| t.saturating_sub(1)))
        }
        Some(RangeSpec::Suffix(n)) => hinted.map_or(0, |t| t.saturating_sub(*n)),
        _ => 0,
    };
    // Attaching per-request marks consumer intent exactly once (the
    // session's attach gate runs only on the first) while a detached
    // re-open is a fresh attach at the requested offset — the same
    // semantics the DataSource close→open gives the native surfaces.
    // A session that already ended returns its typed terminal error
    // here — the honest status, not a blanket `410`.
    if let Err(e) = attach_counted(shared, &handle, provisional) {
        write_status(out, status_for(&e), &[]);
        return Ok(());
    }
    detach.handle = Some(handle.clone());
    // One read before headers: an immediate terminal error still
    // maps to an honest status, a healthy session starts the body,
    // and a fetch it triggers can advance upstream discovery.
    let mut first = match shared.registry.read(&handle, provisional, READ_CHUNK) {
        Ok(b) => b,
        Err(e) => {
            write_status(out, status_for(&e), &[]);
            return Ok(());
        }
    };
    // Re-resolve on the freshest total — the wire's `Content-Range`
    // beats the hint once seen: a suffix re-anchors to the real end,
    // an interval re-clamps, a range that collapsed under the real
    // total answers honest `416` while headers are still unsent, and
    // a wire-proven total bounds a previously unbounded body so
    // truncation shows up as a byte shortfall rather than a clean
    // FIN.
    let total = shared
        .registry
        .effective_total(&handle)
        .ok()
        .flatten()
        .or(hinted);
    let (start, end) = match &req.range {
        None => (0u64, total.and_then(|t| t.checked_sub(1))),
        Some(spec) => match resolve_range(spec, total) {
            Ok(r) => r,
            Err(status) => {
                write_status(
                    out,
                    status,
                    &[("Content-Range".into(), format!("bytes */{}", star(total)))],
                );
                return Ok(());
            }
        },
    };
    if start != provisional {
        // The bounds moved under the wire total — re-seed intent and
        // re-read where the resolved range actually begins.
        if let Err(e) = shared.registry.attach(&handle, start) {
            write_status(out, status_for(&e), &[]);
            return Ok(());
        }
        let want = end.map_or(READ_CHUNK, |e| (e - start + 1).min(READ_CHUNK));
        first = match shared.registry.read(&handle, start, want) {
            Ok(b) => b,
            Err(e) => {
                write_status(out, status_for(&e), &[]);
                return Ok(());
            }
        };
    }
    write_reply_head(out, &mime, req.range.is_some(), start, end, total)?;
    // The probe read ran unbounded — serve only the resolved span;
    // a mid-body failure can only close the connection truncated —
    // the status is already out.
    let first_take = end.map_or(first.len(), |e| {
        ((e - start + 1).min(first.len() as u64)) as usize
    });
    out.write_all(&first[..first_take])
        .map_err(|e| StreamError::Internal {
            message: format!("response body: {e}"),
        })?;
    let mut pos = start + first_take as u64;
    loop {
        let Some(e) = end else {
            match shared.registry.read(&handle, pos, READ_CHUNK) {
                Ok(b) if b.is_empty() => return Ok(()),
                Ok(b) => {
                    pos += u64::try_from(b.len()).unwrap_or(u64::MAX);
                    if out.write_all(&b).is_err() {
                        return Ok(());
                    }
                }
                Err(_) => return Ok(()),
            }
            continue;
        };
        if pos > e {
            return Ok(());
        }
        match shared
            .registry
            .read(&handle, pos, (e - pos + 1).min(READ_CHUNK))
        {
            Ok(b) if b.is_empty() => return Ok(()),
            Ok(b) => {
                pos += u64::try_from(b.len()).unwrap_or(u64::MAX);
                if out.write_all(&b).is_err() {
                    return Ok(());
                }
            }
            Err(_) => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::FetchResponse;
    use crate::testkit::*;
    use std::io::Read;
    use tokio::runtime::Handle;

    /// One parsed reply — `Connection: close` means the body runs to
    /// EOF.
    struct Reply {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Reply {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.as_str())
        }
    }

    /// One synchronous `GET`/`HEAD` against the loopback server.
    fn http(url: &str, method: &str, headers: &[(&str, &str)]) -> Reply {
        let rest = url.strip_prefix("http://").unwrap_or(url);
        let (addr, path) = rest
            .split_once('/')
            .unwrap_or_else(|| panic!("bad url {url}"));
        let mut conn = TcpStream::connect(addr).unwrap_or_else(|e| panic!("connect {addr}: {e}"));
        conn.set_read_timeout(Some(Duration::from_secs(10))).ok();
        let mut req = format!("{method} /{path} HTTP/1.1\r\nHost: {addr}\r\n");
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        conn.write_all(req.as_bytes())
            .unwrap_or_else(|e| panic!("send: {e}"));
        let mut raw = Vec::new();
        conn.read_to_end(&mut raw)
            .unwrap_or_else(|e| panic!("read: {e}"));
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| i + 4)
            .unwrap_or_else(|| panic!("no head end in {}", String::from_utf8_lossy(&raw)));
        let head = String::from_utf8_lossy(&raw[..split - 4]).to_string();
        let mut lines = head.lines();
        let status: u16 = lines
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let headers = lines
            .filter_map(|l| {
                l.split_once(':')
                    .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            })
            .collect();
        Reply {
            status,
            headers,
            body: raw[split..].to_vec(),
        }
    }

    /// Registry → prepared session → bound server → serve URL +
    /// session handle. `head_bytes` covers the whole 1024-byte canned
    /// resource so one scripted reply fills it; `hint` is the
    /// resolve-time length hint.
    fn served(
        steps: Vec<Step>,
        hint: Option<u64>,
    ) -> (StreamServer, Arc<StreamRegistry>, String, String, TestDir) {
        let dir = TestDir::new("srv");
        let mut cfg = test_config(&dir);
        cfg.head_bytes = 1024;
        cfg.read_ahead = 2048;
        let reg = Arc::new(
            StreamRegistry::with_fetch(cfg, Handle::current(), Arc::new(ScriptedFetch::new(steps)))
                .unwrap_or_else(|e| panic!("registry: {e}")),
        );
        let mut src = source();
        src.content_length = hint;
        let info = reg
            .prepare(src, Arc::new(StaticRemint))
            .unwrap_or_else(|e| panic!("prepare: {e}"));
        let server =
            StreamServer::start(Arc::clone(&reg)).unwrap_or_else(|e| panic!("server: {e}"));
        let url = server
            .serve(&info.handle)
            .unwrap_or_else(|e| panic!("serve: {e}"));
        (server, reg, url, info.handle, dir)
    }

    /// The default script: the head fill fetches `chunk_bytes`-sized
    /// ranges — 8 replies of 128 B cover the whole 1024-byte resource.
    /// A reply larger than the request is a pump `InvalidResponse`.
    fn filled() -> Vec<Step> {
        (0..1024)
            .step_by(128)
            .map(|off| Step::Reply(resp(206, off, 128, 1024)))
            .collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn full_get_answers_200_with_length_and_body() {
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(1024));
        let r = http(&url, "GET", &[]);
        assert_eq!(r.status, 200);
        assert_eq!(r.header("content-type"), Some("audio/mp4"));
        assert_eq!(r.header("accept-ranges"), Some("bytes"));
        assert_eq!(r.header("content-length"), Some("1024"));
        assert_eq!(r.body.len(), 1024);
        assert!(r.body.iter().all(|b| *b == 0xAB));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn serve_url_is_loopback_with_unguessable_token() {
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(1024));
        let rest = url
            .strip_prefix("http://127.0.0.1:")
            .unwrap_or_else(|| panic!("not loopback: {url}"));
        let (port, path) = rest.split_once('/').unwrap_or_else(|| panic!("{url}"));
        assert!(port.parse::<u16>().is_ok());
        let token = path
            .strip_prefix("s/")
            .unwrap_or_else(|| panic!("bad path {path}"));
        assert_eq!(token.len(), 32);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn interval_range_answers_206_with_content_range() {
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(1024));
        let r = http(&url, "GET", &[("Range", "bytes=4-131")]);
        assert_eq!(r.status, 206);
        assert_eq!(r.header("content-range"), Some("bytes 4-131/1024"));
        assert_eq!(r.header("content-length"), Some("128"));
        assert_eq!(r.body.len(), 128);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn open_ended_range_answers_to_eof() {
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(1024));
        let r = http(&url, "GET", &[("Range", "bytes=512-")]);
        assert_eq!(r.status, 206);
        assert_eq!(r.header("content-range"), Some("bytes 512-1023/1024"));
        assert_eq!(r.body.len(), 512);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn suffix_range_answers_last_n_bytes() {
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(1024));
        let r = http(&url, "GET", &[("Range", "bytes=-64")]);
        assert_eq!(r.status, 206);
        assert_eq!(r.header("content-range"), Some("bytes 960-1023/1024"));
        assert_eq!(r.body.len(), 64);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn range_past_eof_answers_416_with_star_total() {
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(1024));
        for range in ["bytes=1024-", "bytes=2000-2200"] {
            let r = http(&url, "GET", &[("Range", range)]);
            assert_eq!(r.status, 416, "{range}");
            assert_eq!(r.header("content-range"), Some("bytes */1024"), "{range}");
            assert_eq!(r.body.len(), 0, "{range}");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn malformed_and_multi_ranges_answer_416() {
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(1024));
        for range in ["bytes=50-10", "bytes=0-1,4-5", "bytes=abc", "bytes="] {
            let r = http(&url, "GET", &[("Range", range)]);
            assert_eq!(r.status, 416, "{range}");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn non_bytes_range_unit_is_ignored() {
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(1024));
        let r = http(&url, "GET", &[("Range", "items=0-10")]);
        assert_eq!(r.status, 200);
        assert_eq!(r.body.len(), 1024);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unknown_token_and_path_answer_404() {
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(1024));
        let token = &url[url.len() - 32..];
        // A well-shaped grant that was never minted is a 404, and a
        // path outside `/s/{token}` is a 404 — never a session.
        let r = http(&url.replace(token, &"f".repeat(32)), "GET", &[]);
        assert_eq!(r.status, 404);
        let base = url.strip_suffix(token).unwrap_or(&url);
        let r = http(&format!("{base}nope"), "GET", &[]);
        assert_eq!(r.status, 404);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ended_session_answers_410() {
        let (_srv, reg, url, handle, _dir) = served(filled(), Some(1024));
        // A minted grant whose session has since ended is `410 Gone`
        // — distinct from the never-issued grant's 404.
        reg.release(&handle)
            .unwrap_or_else(|e| panic!("release: {e}"));
        let r = http(&url, "GET", &[]);
        assert_eq!(r.status, 410);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn head_sends_headers_without_body() {
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(1024));
        let r = http(&url, "HEAD", &[("Range", "bytes=0-127")]);
        assert_eq!(r.status, 206);
        assert_eq!(r.header("content-range"), Some("bytes 0-127/1024"));
        assert_eq!(r.header("content-length"), Some("128"));
        assert_eq!(r.body.len(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn post_is_405_with_allow() {
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(1024));
        let r = http(&url, "POST", &[]);
        assert_eq!(r.status, 405);
        assert_eq!(r.header("allow"), Some("GET, HEAD"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unknown_total_gets_close_delimited_200_and_416_on_range() {
        // No resolve-time hint and no wire `Content-Range` — the only
        // honest answers are a close-delimited 200 and `bytes */*`.
        let steps: Vec<Step> = (0..1024)
            .step_by(128)
            .map(|off| {
                Step::Reply(FetchResponse {
                    status: 206,
                    // `bytes s-e/*` — the wire's unknown-total form.
                    content_range: Some(format!("bytes {}-{}/*", off, off + 127)),
                    body: stream_body(vec![0xCDu8; 128]),
                })
            })
            .collect();
        let (_srv, _reg, url, _h, _dir) = served(steps, None);
        let r = http(&url, "GET", &[]);
        assert_eq!(r.status, 200);
        assert_eq!(r.header("content-length"), None);
        let ranged = http(&url, "GET", &[("Range", "bytes=0-9")]);
        assert_eq!(ranged.status, 416);
        assert_eq!(ranged.header("content-range"), Some("bytes */*"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ranged_request_on_ended_session_answers_410_not_416() {
        // The terminal probe runs before range resolution — a dead
        // session answers its honest error, never a range verdict
        // computed for a stream that cannot serve.
        let (_srv, reg, url, handle, _dir) = served(filled(), Some(1024));
        reg.release(&handle)
            .unwrap_or_else(|e| panic!("release: {e}"));
        let r = http(&url, "GET", &[("Range", "bytes=0-9")]);
        assert_eq!(r.status, 410);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn case_insensitive_bytes_unit_ranges() {
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(1024));
        let r = http(&url, "GET", &[("Range", "Bytes=4-131")]);
        assert_eq!(r.status, 206);
        assert_eq!(r.header("content-range"), Some("bytes 4-131/1024"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn suffix_range_on_empty_resource_answers_416() {
        // total 0 — `t - 1` must never underflow; the honest answer
        // is unsatisfiable.
        let (_srv, _reg, url, _h, _dir) = served(filled(), Some(0));
        let r = http(&url, "GET", &[("Range", "bytes=-64")]);
        assert_eq!(r.status, 416);
        assert_eq!(r.header("content-range"), Some("bytes */0"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn conn_end_detaches_the_session() {
        // After the response finishes, the session must be
        // unattached again — detached-close lets an intent-flip
        // cancel reach it; without it the session is shielded
        // forever.
        let (_srv, reg, url, handle, _dir) = served(filled(), Some(1024));
        let r = http(&url, "GET", &[("Range", "bytes=0-63")]);
        assert_eq!(r.status, 206);
        reg.cancel_if_unattached(&handle)
            .unwrap_or_else(|e| panic!("cancel: {e}"));
        let r = http(&url, "GET", &[]);
        assert_eq!(r.status, 410, "cancelled session must answer 410");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn head_reports_bounds_without_spending_a_read() {
        // Upstream dead past the cached head — a HEAD still answers
        // 206 headers because no body read is spent on it.
        let mut steps = vec![Step::Reply(resp(206, 0, 64, 1024))];
        steps.extend((0..16).map(|_| {
            Step::Fail(StreamError::Transient {
                message: "upstream dead".into(),
            })
        }));
        let dir = TestDir::new("srv-head");
        let mut cfg = test_config(&dir);
        cfg.head_bytes = 64;
        cfg.read_ahead = 64;
        cfg.stall = Duration::from_millis(50);
        cfg.read_deadline = Duration::from_millis(400);
        let reg = Arc::new(
            StreamRegistry::with_fetch(cfg, Handle::current(), Arc::new(ScriptedFetch::new(steps)))
                .unwrap_or_else(|e| panic!("registry: {e}")),
        );
        let info = reg
            .prepare(source(), Arc::new(StaticRemint))
            .unwrap_or_else(|e| panic!("prepare: {e}"));
        let server = StreamServer::start(reg).unwrap_or_else(|e| panic!("server: {e}"));
        let url = server
            .serve(&info.handle)
            .unwrap_or_else(|e| panic!("serve: {e}"));
        let r = http(&url, "HEAD", &[("Range", "bytes=64-127")]);
        assert_eq!(r.status, 206);
        assert_eq!(r.header("content-range"), Some("bytes 64-127/1024"));
        assert_eq!(r.header("content-length"), Some("64"));
        assert_eq!(r.body.len(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wire_total_reanchors_the_hinted_bounds() {
        // Hint says 1024 but the wire reports 512 — headers must
        // carry the freshly discovered total, not the stale hint.
        let steps: Vec<Step> = (0..512)
            .step_by(128)
            .map(|off| Step::Reply(resp(206, off, 128, 512)))
            .collect();
        let dir = TestDir::new("srv-fresh");
        let mut cfg = test_config(&dir);
        cfg.head_bytes = 512;
        cfg.read_ahead = 512;
        let reg = Arc::new(
            StreamRegistry::with_fetch(cfg, Handle::current(), Arc::new(ScriptedFetch::new(steps)))
                .unwrap_or_else(|e| panic!("registry: {e}")),
        );
        let mut src = source();
        src.content_length = Some(1024);
        let info = reg
            .prepare(src, Arc::new(StaticRemint))
            .unwrap_or_else(|e| panic!("prepare: {e}"));
        let server = StreamServer::start(reg).unwrap_or_else(|e| panic!("server: {e}"));
        let url = server
            .serve(&info.handle)
            .unwrap_or_else(|e| panic!("serve: {e}"));
        let r = http(&url, "GET", &[("Range", "bytes=500-")]);
        assert_eq!(r.status, 206);
        assert_eq!(r.header("content-range"), Some("bytes 500-511/512"));
        assert_eq!(r.header("content-length"), Some("12"));
        assert_eq!(r.body.len(), 12);
        // An unranged GET on the same handle also bounds itself once
        // the wire total is known — truncation can then surface as a
        // byte shortfall instead of a clean EOF.
        let r = http(&url, "GET", &[]);
        assert_eq!(r.status, 200);
        assert_eq!(r.header("content-length"), Some("512"));
        assert_eq!(r.body.len(), 512);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn serve_reuses_the_live_grant() {
        // Repeated serve calls for one handle return the same token —
        // minting per call would grow the grant map for the session's
        // whole lifetime.
        let (server, reg, url, handle, _dir) = served(filled(), Some(1024));
        assert_eq!(
            server
                .serve(&handle)
                .unwrap_or_else(|e| panic!("serve: {e}")),
            url
        );
        let mut alt = source();
        alt.source_ref = "vid-2".into();
        alt.url = "https://signed.example/s2?sig=SECRET".into();
        let other = reg
            .prepare(alt, Arc::new(StaticRemint))
            .unwrap_or_else(|e| panic!("prepare: {e}"));
        assert_ne!(
            server
                .serve(&other.handle)
                .unwrap_or_else(|e| panic!("serve: {e}")),
            url
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ending_conn_leaves_sibling_reads_attached() {
        // Two conns share the session: when the first ends, the
        // second's parked read must keep its epoch — an eager close
        // would wake it `Cancelled`.
        // Head replies cover 0..1024 but declare the real 2048-byte
        // total — the park target must sit inside it.
        let mut steps: Vec<Step> = (0..1024)
            .step_by(128)
            .map(|off| Step::Reply(resp(206, off, 128, 2048)))
            .collect();
        steps.push(Step::Hang); // anything past the head parks forever
        let dir = TestDir::new("srv-overlap");
        let mut cfg = test_config(&dir);
        cfg.head_bytes = 1024;
        cfg.read_ahead = 1024;
        cfg.read_deadline = Duration::from_secs(4);
        let reg = Arc::new(
            StreamRegistry::with_fetch(cfg, Handle::current(), Arc::new(ScriptedFetch::new(steps)))
                .unwrap_or_else(|e| panic!("registry: {e}")),
        );
        let mut src = source();
        src.content_length = Some(2048);
        let info = reg
            .prepare(src, Arc::new(StaticRemint))
            .unwrap_or_else(|e| panic!("prepare: {e}"));
        let server =
            StreamServer::start(Arc::clone(&reg)).unwrap_or_else(|e| panic!("server: {e}"));
        let url = server
            .serve(&info.handle)
            .unwrap_or_else(|e| panic!("serve: {e}"));
        // Conn B opens a range past the cached head and parks on the
        // hung fetch; conn A completes on cached bytes and ends.
        let (tx, rx) = std::sync::mpsc::channel();
        let b_url = url.clone();
        let b = thread::spawn(move || {
            let rest = b_url.strip_prefix("http://").unwrap_or(&b_url);
            let (addr, path) = rest.split_once('/').unwrap_or_else(|| panic!("{b_url}"));
            let mut conn =
                TcpStream::connect(addr).unwrap_or_else(|e| panic!("connect {addr}: {e}"));
            conn.set_read_timeout(Some(Duration::from_secs(6))).ok();
            conn.write_all(
                format!("GET /{path} HTTP/1.1\r\nHost: {addr}\r\nRange: bytes=1500-\r\n\r\n")
                    .as_bytes(),
            )
            .unwrap_or_else(|e| panic!("send: {e}"));
            let mut byte = [0u8; 1];
            let _ = tx.send(conn.read(&mut byte).map(|n| (n, byte[0])));
        });
        thread::sleep(Duration::from_millis(400));
        let r = http(&url, "GET", &[("Range", "bytes=0-63")]);
        assert_eq!(r.status, 206);
        // B's read must still be parked — nothing may arrive yet (an
        // eager close would wake B `Cancelled` and FIN the conn).
        assert!(
            rx.recv_timeout(Duration::from_millis(800)).is_err(),
            "sibling conn must stay attached"
        );
        reg.release(&info.handle)
            .unwrap_or_else(|e| panic!("release: {e}"));
        let _ = b.join();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stale_hint_suffix_reanchors_to_wire_total() {
        // Hint says 512 but the wire reports 2048 — the probe fetch
        // at the hinted anchor reveals the real total, and the
        // suffix re-anchors to it instead of serving the hint's tail.
        let steps: Vec<Step> = vec![
            Step::Reply(FetchResponse {
                status: 206,
                content_range: Some("bytes 0-127/*".into()),
                body: stream_body(vec![0xABu8; 128]),
            }),
            Step::Reply(FetchResponse {
                status: 206,
                content_range: Some("bytes 128-255/*".into()),
                body: stream_body(vec![0xABu8; 128]),
            }),
            Step::Reply(resp(206, 448, 128, 2048)),
            Step::Reply(resp(206, 1984, 64, 2048)),
        ];
        let dir = TestDir::new("srv-suffix");
        let mut cfg = test_config(&dir);
        cfg.head_bytes = 256;
        cfg.read_ahead = 128;
        let reg = Arc::new(
            StreamRegistry::with_fetch(cfg, Handle::current(), Arc::new(ScriptedFetch::new(steps)))
                .unwrap_or_else(|e| panic!("registry: {e}")),
        );
        let mut src = source();
        src.content_length = Some(512);
        let info = reg
            .prepare(src, Arc::new(StaticRemint))
            .unwrap_or_else(|e| panic!("prepare: {e}"));
        let server = StreamServer::start(reg).unwrap_or_else(|e| panic!("server: {e}"));
        let url = server
            .serve(&info.handle)
            .unwrap_or_else(|e| panic!("serve: {e}"));
        let r = http(&url, "GET", &[("Range", "bytes=-64")]);
        assert_eq!(r.status, 206);
        assert_eq!(r.header("content-range"), Some("bytes 1984-2047/2048"));
        assert_eq!(r.header("content-length"), Some("64"));
        assert_eq!(r.body.len(), 64);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn past_hint_interval_serves_when_wire_proves_it() {
        // Hint says 512 but the wire reports 2048 — `bytes=1500-`
        // fails under the hint yet is satisfiable: the boundary
        // probe at 511 uncovers the real total and the request
        // serves 1500-2047 instead of a stale 416.
        let steps: Vec<Step> = vec![
            Step::Reply(FetchResponse {
                status: 206,
                content_range: Some("bytes 0-127/*".into()),
                body: stream_body(vec![0xABu8; 128]),
            }),
            Step::Reply(FetchResponse {
                status: 206,
                content_range: Some("bytes 128-255/*".into()),
                body: stream_body(vec![0xABu8; 128]),
            }),
            Step::Reply(resp(206, 511, 128, 2048)),
            Step::Reply(resp(206, 1500, 128, 2048)),
            Step::Reply(resp(206, 1628, 128, 2048)),
            Step::Reply(resp(206, 1756, 128, 2048)),
            Step::Reply(resp(206, 1884, 128, 2048)),
            Step::Reply(resp(206, 2012, 36, 2048)),
        ];
        let dir = TestDir::new("srv-boundary");
        let mut cfg = test_config(&dir);
        cfg.head_bytes = 256;
        cfg.read_ahead = 128;
        let reg = Arc::new(
            StreamRegistry::with_fetch(cfg, Handle::current(), Arc::new(ScriptedFetch::new(steps)))
                .unwrap_or_else(|e| panic!("registry: {e}")),
        );
        let mut src = source();
        src.content_length = Some(512);
        let info = reg
            .prepare(src, Arc::new(StaticRemint))
            .unwrap_or_else(|e| panic!("prepare: {e}"));
        let server = StreamServer::start(reg).unwrap_or_else(|e| panic!("server: {e}"));
        let url = server
            .serve(&info.handle)
            .unwrap_or_else(|e| panic!("serve: {e}"));
        let r = http(&url, "GET", &[("Range", "bytes=1500-")]);
        assert_eq!(r.status, 206);
        assert_eq!(r.header("content-range"), Some("bytes 1500-2047/2048"));
        assert_eq!(r.header("content-length"), Some("548"));
        assert_eq!(r.body.len(), 548);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn empty_resource_answers_content_length_zero() {
        // total 0 — an unranged GET is `200 Content-Length: 0` with
        // no body, not a close-delimited unknown-length reply.
        let (_srv, _reg, url, _h, _dir) = served(vec![], Some(0));
        let r = http(&url, "GET", &[]);
        assert_eq!(r.status, 200);
        assert_eq!(r.header("content-length"), Some("0"));
        assert_eq!(r.body.len(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unknown_total_reaches_clean_eof_on_wire_refusal() {
        // Every chunk answers `bytes S-E/*` — the total stays unknown
        // until a `bytes */*` 416 at the boundary, which is itself
        // wire EOF evidence: the read past the end returns empty and
        // the body finishes clean, without spending a re-mint.
        let mut steps: Vec<Step> = (0..1024)
            .step_by(128)
            .map(|off| {
                Step::Reply(FetchResponse {
                    status: 206,
                    content_range: Some(format!("bytes {off}-{}/*", off + 127)),
                    body: stream_body(vec![0xABu8; 128]),
                })
            })
            .collect();
        steps.push(Step::Reply(FetchResponse {
            status: 416,
            content_range: Some("bytes */*".into()),
            body: stream_body(vec![]),
        }));
        let dir = TestDir::new("srv-eof");
        let mut cfg = test_config(&dir);
        cfg.head_bytes = 128;
        cfg.read_ahead = 128;
        let fetch = Arc::new(ScriptedFetch::new(steps));
        let reg = Arc::new(
            StreamRegistry::with_fetch(cfg, Handle::current(), fetch.clone())
                .unwrap_or_else(|e| panic!("registry: {e}")),
        );
        let mut src = source();
        src.content_length = None;
        let info = reg
            .prepare(src, Arc::new(StaticRemint))
            .unwrap_or_else(|e| panic!("prepare: {e}"));
        let server = StreamServer::start(reg).unwrap_or_else(|e| panic!("server: {e}"));
        let url = server
            .serve(&info.handle)
            .unwrap_or_else(|e| panic!("serve: {e}"));
        let r = http(&url, "GET", &[]);
        assert_eq!(r.status, 200);
        assert_eq!(r.body.len(), 1024, "full body must arrive before FIN");
        // Exactly one refusal at the boundary — the EOF ceiling is
        // latched from the wire's own answer, no re-mint re-tries it.
        let boundary = fetch
            .requests
            .lock()
            .map(|rs| rs.iter().filter(|(o, _)| *o == 1024).count())
            .unwrap_or(0);
        assert_eq!(boundary, 1, "one 416 fetch proves EOF — no re-mint");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stream_errors_map_before_headers() {
        // Reads past the committed window fetch upstream; with the
        // upstream dead the seam retries then fails Transient — the
        // client sees 503, not a bogus 200.
        let mut steps = vec![Step::Reply(resp(206, 0, 64, 1024))];
        steps.extend((0..16).map(|_| {
            Step::Fail(StreamError::Transient {
                message: "upstream dead".into(),
            })
        }));
        let dir = TestDir::new("srv-fail");
        let mut cfg = test_config(&dir);
        cfg.head_bytes = 64;
        cfg.read_ahead = 64;
        cfg.stall = Duration::from_millis(50);
        cfg.read_deadline = Duration::from_millis(400);
        let reg = Arc::new(
            StreamRegistry::with_fetch(cfg, Handle::current(), Arc::new(ScriptedFetch::new(steps)))
                .unwrap_or_else(|e| panic!("registry: {e}")),
        );
        let info = reg
            .prepare(source(), Arc::new(StaticRemint))
            .unwrap_or_else(|e| panic!("prepare: {e}"));
        let server = StreamServer::start(reg).unwrap_or_else(|e| panic!("server: {e}"));
        let url = server
            .serve(&info.handle)
            .unwrap_or_else(|e| panic!("serve: {e}"));
        let r = http(&url, "GET", &[("Range", "bytes=128-255")]);
        assert_eq!(r.status, 503);
    }
}
