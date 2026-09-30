//! The byte-fetch boundary. The pump owns every wire rule — a [`Fetch`]
//! implementation only moves bytes for one `Range` request — so tests
//! inject fakes and never open sockets.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use futures_util::{Stream, StreamExt};
use tokio_util::sync::CancellationToken;

use crate::error::StreamError;

/// Body pieces of one range response, in wire order.
pub type BodyStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>, StreamError>> + Send>>;

/// One ranged fetch issued by a session's pump: `GET url` with
/// `Range: bytes=offset..offset+max_len-1`, carrying the mint's
/// `headers` verbatim on this request and on any same-host redirect it
/// re-issues; `range` is host-controlled and always wins over a
/// same-named entry.
///
/// `max_len` is always positive and bounded by the configured chunk
/// size — full-file GETs are never issued (they throttle). `headers`
/// are the mint's required request headers (the
/// [`PreparedSource::headers`](crate::PreparedSource) contract) — e.g.
/// the `User-Agent` the minting client impersonates. `url` is signed —
/// never log it.
pub struct RangeRequest<'a> {
    /// Absolute `https` URL of the minted stream.
    pub url: &'a str,
    /// First byte to fetch.
    pub offset: u64,
    /// Maximum bytes the pump accepts for this window.
    pub max_len: u64,
    /// Mint-supplied request headers, sent verbatim.
    pub headers: &'a [(String, String)],
    /// No-progress bound (headers wait, or any gap between body chunks).
    pub stall: Duration,
    /// Bound on the whole request.
    pub deadline: Duration,
    /// Cooperative abort.
    pub cancel: CancellationToken,
}

/// One raw range response, unvalidated — the pump applies the wire
/// rules (206-only, `Content-Range`, empty/oversized) itself.
pub struct FetchResponse {
    /// HTTP status code.
    pub status: u16,
    /// Raw `Content-Range` header value, when the server sent one.
    pub content_range: Option<String>,
    /// `Retry-After` as milliseconds, when the server sent a
    /// delta-seconds value — carried for the 429 path's cooldown.
    pub retry_after_ms: Option<u64>,
    /// Body pieces in wire order — the impl caps total yield at
    /// `max_len + 1` so a bad server cannot stream unbounded memory.
    /// Dropping the stream aborts the request.
    pub body: BodyStream,
}

/// Performs `GET` range requests on behalf of one session's pump.
///
/// Contract: implementations must honor `stall` as a no-progress bound
/// (headers wait, or any gap between body chunks), `deadline` as a
/// bound on the whole request, and `cancel` as a cooperative abort.
/// Error messages must never contain `url` — it is signed. The future
/// resolves once headers arrive; dropping it or the returned body
/// stream must abort the request.
pub trait Fetch: Send + Sync {
    /// Issue one [`RangeRequest`].
    fn get_range<'a>(
        &'a self,
        req: RangeRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<FetchResponse, StreamError>> + Send + 'a>>;
}

/// [`Fetch`] over `reqwest` + rustls. Redirects are not chased by the
/// client — but googlevideo edge-balances range requests with a 302
/// to a sibling host, so [`get_range`](Fetch::get_range) re-issues the
/// same bounded request once against an absolute `https://` `Location`.
/// One hop is the bound: a longer chain is serving weather, and the
/// pump's wire rules still run on wherever the chain lands.
pub struct ReqwestFetch {
    client: reqwest::Client,
}

impl ReqwestFetch {
    /// Build a client with rustls TLS and no redirect chasing.
    ///
    /// # Errors
    /// [`StreamError::Internal`] if the TLS backend cannot start.
    pub fn new() -> Result<Self, StreamError> {
        let builder = reqwest::Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::none())
            // Signed CDN URLs must never route through an ambient
            // proxy — and skipping the per-request env scan shaves
            // work off every cold fetch.
            .no_proxy();
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let builder = {
            // A bare cdylib has no JNI Context for the platform
            // verifier; bundle the Mozilla roots (same path as the
            // plugin host, so mobile targets share one trust store).
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let mut tls = rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            // Advertise only what the build speaks — reqwest is
            // compiled without http2, so an h2 ALPN offer would be
            // negotiated into a protocol hyper can't serve.
            tls.alpn_protocols = vec![b"http/1.1".to_vec()];
            builder.use_preconfigured_tls(tls)
        };
        let client = builder.build().map_err(|e| StreamError::Internal {
            message: format!("http client init: {e}"),
        })?;
        Ok(Self { client })
    }

    /// Wrap a shared [`reqwest::Client`].
    ///
    /// The host shares one client (one connection pool) between guest
    /// HTTP and stream fetches: a plugin's last-byte resolve probe to a
    /// CDN host keeps its connection pooled, so the pump's first range
    /// request to the same origin skips TCP+TLS setup.
    #[must_use]
    pub fn with_client(client: reqwest::Client) -> Self {
        Self { client }
    }
}

/// Host (sans port/userinfo) of an `https://` URL — case-insensitive
/// scheme per RFC 3986. Anything else returns `None`.
fn https_host(url: &str) -> Option<&str> {
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let no_user = authority.rsplit('@').next()?;
    if no_user.starts_with('[') {
        // Literal v6: host is inside the brackets.
        let end = no_user.find(']')?;
        return Some(&no_user[1..end]);
    }
    no_user.split(':').next()
}

/// The redirect target worth one re-issue: a 3xx carrying an absolute
/// `https://` `Location` on the mint host itself or one of its
/// subdomain siblings (CDN edge re-issues land under the same parent
/// domain). Anything else — non-3xx, no header, relative/plain-http
/// target, or a foreign host — is answered verbatim so the caller
/// sees the same response a redirect-blind fetch would have returned.
fn follow_target<'a>(status: u16, location: Option<&'a str>, mint_url: &str) -> Option<&'a str> {
    if !(300..400).contains(&status) {
        return None;
    }
    let target = location?;
    let target_host = https_host(target)?.to_ascii_lowercase();
    let mint_host = https_host(mint_url)?.to_ascii_lowercase();
    if redirect_in_scope(&target_host, &mint_host) {
        Some(target)
    } else {
        None
    }
}

/// Parent zones whose sibling hosts form one operator trust zone —
/// CDN edges re-issue across siblings (`rr1` → `rr2---sn-x`), so a
/// redirect between them is a load-balance, not a boundary hop. Only
/// zones wholly operated by the provider's CDN qualify:
/// `googleusercontent.com` is excluded because user-uploaded content
/// lives under it (`lh3.googleusercontent.com` et al.) — a sibling
/// there could be attacker data wearing the mint's signature, while
/// every `*.googlevideo.com`/`*.dzcdn.net` sibling is provider edge
/// infrastructure.
const EDGE_PARENT_ZONES: &[&str] = &["googlevideo.com", "dzcdn.net"];

/// Names the host owns outright on the wire — a mint entry under one
/// of these is dropped here too, not just at the ABI boundary:
/// `PreparedSource`/`RangeRequest` are public seams a direct caller
/// can fill, and `reqwest::header()` appends rather than replaces, so
/// a mint `range` or `host` would otherwise ride beside the real one.
/// Mirrors `resolve_resource_from`'s blocklist.
const HOST_OWNED_HEADERS: &[&str] = &[
    "range",
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "accept-encoding",
    "te",
    "trailer",
    "upgrade",
    "expect",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "www-authenticate",
    "authorization",
    "cookie",
    "set-cookie",
];

/// Is `target_host` inside the mint's trust scope: the mint host
/// itself, one of its subdomains, or — when the mint sits under a
/// known edge parent zone — a sibling under that parent.
fn redirect_in_scope(target_host: &str, mint_host: &str) -> bool {
    if target_host == mint_host || target_host.ends_with(&format!(".{mint_host}")) {
        return true;
    }
    match mint_host.split_once('.') {
        Some((_, parent)) => {
            EDGE_PARENT_ZONES.contains(&parent) && target_host.ends_with(&format!(".{parent}"))
        }
        None => false,
    }
}

impl Fetch for ReqwestFetch {
    fn get_range<'a>(
        &'a self,
        req: RangeRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<FetchResponse, StreamError>> + Send + 'a>> {
        Box::pin(async move {
            let RangeRequest {
                url,
                offset,
                max_len,
                headers: mint_headers,
                stall,
                deadline,
                cancel,
            } = req;
            let end = offset.saturating_add(max_len.saturating_sub(1));
            let t0 = std::time::Instant::now();
            let range = format!("bytes={offset}-{end}");
            // The mint's required identity rides every hop. An entry
            // that fails wire parsing is dropped — the boundary
            // screens names/values upstream, so this is belt, not the
            // boundary. When the mint left `user-agent` out entirely
            // the request still identifies itself: an empty-UA fetch
            // reads as bot traffic to providers that score headers.
            let mut extra = Vec::with_capacity(mint_headers.len() + 1);
            let mut has_ua = false;
            for (k, v) in mint_headers {
                let (Ok(name), Ok(value)) = (
                    reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                    reqwest::header::HeaderValue::from_str(v),
                ) else {
                    continue;
                };
                // HeaderName canonicalizes to lowercase — an exact
                // match here is a case-insensitive one on the wire.
                if HOST_OWNED_HEADERS.contains(&name.as_str()) {
                    continue;
                }
                has_ua |= name == reqwest::header::USER_AGENT;
                extra.push((name, value));
            }
            if !has_ua {
                extra.push((
                    reqwest::header::USER_AGENT,
                    reqwest::header::HeaderValue::from_static(concat!(
                        "auqw/",
                        env!("CARGO_PKG_VERSION")
                    )),
                ));
            }
            let headers = async {
                let mut current = url.to_string();
                for hop in 0..2 {
                    let mut req = self.client.get(&current);
                    for (name, value) in &extra {
                        req = req.header(name.clone(), value.clone());
                    }
                    let req = req.header(reqwest::header::RANGE, range.clone());
                    let resp = tokio::time::timeout(stall, req.send())
                        .await
                        .map_err(|_| StreamError::Transient {
                            message: format!("headers stalled for {stall:?}"),
                        })?
                        .map_err(|e| StreamError::Transient {
                            message: e.without_url().to_string(),
                        })?;
                    if hop == 0 {
                        let location = resp
                            .headers()
                            .get(reqwest::header::LOCATION)
                            .and_then(|v| v.to_str().ok());
                        if let Some(target) = follow_target(resp.status().as_u16(), location, url) {
                            current = target.to_string();
                            continue;
                        }
                    }
                    return Ok(resp);
                }
                Err(StreamError::Internal {
                    message: "redirect loop exhausted".into(),
                })
            };
            // One deadline spans both header attempts and the streamed body.
            let resp = tokio::select! {
                () = cancel.cancelled() => return Err(StreamError::Cancelled),
                r = tokio::time::timeout(deadline, headers) => {
                    r.map_err(|_| StreamError::Transient {
                        message: format!("request exceeded deadline {deadline:?}"),
                    })??
                }
            };
            let status = resp.status().as_u16();
            let content_range = resp
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let retry_after_ms = retry_after_ms(resp.headers());
            let cap = max_len.saturating_add(1);
            let body_cancel = cancel.clone();
            let body: BodyStream = Box::pin(futures_util::stream::unfold(
                (resp.bytes_stream(), 0u64),
                move |(mut stream, got)| {
                    let body_cancel = body_cancel.clone();
                    async move {
                        if got >= cap {
                            return None;
                        }
                        // The cooperative abort the contract promises:
                        // cancel is checked per piece, not only on the
                        // header wait.
                        let left = deadline.saturating_sub(t0.elapsed());
                        let item = if body_cancel.is_cancelled() {
                            Some((Err(StreamError::Cancelled), cap))
                        } else if left.is_zero() {
                            Some((
                                Err(StreamError::Transient {
                                    message: format!("request exceeded deadline {deadline:?}"),
                                }),
                                // An error item also ends the stream.
                                cap,
                            ))
                        } else {
                            let next = tokio::select! {
                                biased;
                                () = body_cancel.cancelled() => {
                                    return Some((Err(StreamError::Cancelled), (stream, cap)));
                                }
                                next = tokio::time::timeout(stall.min(left), stream.next()) => next,
                            };
                            match next {
                                Err(_) => Some((
                                    Err(StreamError::Transient {
                                        message: format!("body stalled for {stall:?}"),
                                    }),
                                    cap,
                                )),
                                Ok(None) => None,
                                Ok(Some(Err(e))) => Some((
                                    Err(StreamError::Transient {
                                        message: e.without_url().to_string(),
                                    }),
                                    cap,
                                )),
                                Ok(Some(Ok(c))) => {
                                    let take = c
                                        .len()
                                        .min(usize::try_from(cap - got).unwrap_or(usize::MAX));
                                    Some((Ok(c[..take].to_vec()), got + take as u64))
                                }
                            }
                        };
                        item.map(|(r, got)| (r, (stream, got)))
                    }
                },
            ));
            Ok(FetchResponse {
                status,
                content_range,
                retry_after_ms,
                body,
            })
        })
    }
}

/// `Retry-After` in milliseconds — delta-seconds only. The HTTP-date
/// form (rare on API 429s, and a clock comparison the seam would have
/// to trust) is treated as absent: no hint is still an honest
/// rate-limit. Digits-only parse — a leading `+` is not a duration.
fn retry_after_ms(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim();
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u64>().ok().map(|s| s.saturating_mul(1000))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::{follow_target, retry_after_ms};

    /// `Retry-After` extraction: delta-seconds only — digits parse to
    /// milliseconds (saturating), everything else (HTTP-date, sign,
    /// fraction, empty) is no-hint, which is still an honest
    /// rate-limit rather than a malformed cooldown.
    #[test]
    fn retry_after_parses_delta_seconds() {
        let cases = [
            ("1", Some(1_000)),
            ("0", Some(0)),
            (" 5 ", Some(5_000)),
            ("18446744073709552", Some(u64::MAX)), // seconds ×1000 overflows → saturate
            ("Wed, 21 Oct 2015 07:28:00 GMT", None),
            ("-1", None),
            ("1.5", None),
            ("", None),
        ];
        for (raw, want) in cases {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(
                reqwest::header::RETRY_AFTER,
                raw.parse().unwrap_or_else(|_| panic!("header {raw:?}")),
            );
            assert_eq!(retry_after_ms(&headers), want, "header {raw:?}");
        }
    }

    // Real local HTTP verifies the production adapter, independently of pump fakes.
    // `want` are request-line/header fragments the wire request must carry;
    // `unwanted` are fragments that must never appear (host-owned mint
    // entries dropped before the wire).
    fn serve_body(
        body: &'static [u8],
        want: &'static [&'static str],
        unwanted: &'static [&'static str],
    ) -> (
        String,
        std::sync::mpsc::Sender<()>,
        std::thread::JoinHandle<()>,
    ) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/range", listener.local_addr().unwrap());
        let (release, wait) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let request = String::from_utf8_lossy(&request).to_lowercase();
            for w in want {
                assert!(request.contains(w), "request missing '{w}': {request}");
            }
            for w in unwanted {
                assert!(
                    !request.contains(w),
                    "request must not carry '{w}': {request}"
                );
            }
            socket.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 100\r\nContent-Range: bytes 0-3/100\r\n\r\n").unwrap();
            socket.write_all(body).unwrap();
            let _ = wait.recv_timeout(std::time::Duration::from_secs(5));
        });
        (url, release, worker)
    }

    /// A raw one-shot reply — arbitrary status line + extra headers,
    /// empty body. For wire-verifying non-206 branches of the adapter.
    fn serve_raw(
        status: &'static str,
        headers: &'static [&'static str],
    ) -> (
        String,
        std::sync::mpsc::Sender<()>,
        std::thread::JoinHandle<()>,
    ) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/range", listener.local_addr().unwrap());
        let (release, wait) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            socket
                .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n").as_bytes())
                .unwrap();
            for h in headers {
                socket.write_all(format!("{h}\r\n").as_bytes()).unwrap();
            }
            socket.write_all(b"\r\n").unwrap();
            let _ = wait.recv_timeout(std::time::Duration::from_secs(5));
        });
        (url, release, worker)
    }

    /// A real `429` wire response carrying `Retry-After` must surface
    /// on [`FetchResponse::retry_after_ms`] — the whole seam depends on
    /// the header reaching the pump, not being dropped at the socket.
    #[tokio::test]
    async fn retry_after_header_rides_the_response() {
        use super::*;
        let (url, release, worker) = serve_raw("429 Too Many Requests", &["Retry-After: 2"]);
        let fetch = ReqwestFetch::new().unwrap();
        let response = fetch
            .get_range(RangeRequest {
                url: &url,
                offset: 0,
                max_len: 4,
                headers: &[],
                stall: Duration::from_secs(2),
                deadline: Duration::from_secs(3),
                cancel: CancellationToken::new(),
            })
            .await
            .unwrap();
        assert_eq!(response.status, 429);
        assert_eq!(response.retry_after_ms, Some(2_000));
        let _ = release.send(());
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn body_yield_is_capped_at_requested_length_plus_one() {
        use super::*;
        let (url, release, worker) = serve_body(
            b"01234567890123456789",
            &["range: bytes=0-3", "user-agent: auqw/"],
            &[],
        );
        let fetch = ReqwestFetch::new().unwrap();
        let mut response = fetch
            .get_range(RangeRequest {
                url: &url,
                offset: 0,
                max_len: 4,
                headers: &[],
                stall: Duration::from_secs(2),
                deadline: Duration::from_secs(3),
                cancel: CancellationToken::new(),
            })
            .await
            .unwrap();
        let mut bytes = Vec::new();
        while let Some(piece) = response.body.next().await {
            bytes.extend(piece.unwrap());
        }
        let _ = release.send(());
        worker.join().unwrap();
        assert_eq!(bytes, b"01234");
    }

    #[tokio::test]
    async fn mint_headers_reach_the_wire_and_own_user_agent() {
        use super::*;
        let (url, release, worker) = serve_body(
            b"abcd",
            &[
                "range: bytes=0-3",
                "user-agent: rung-client/1.2",
                "x-rung-mark: minted",
            ],
            &[],
        );
        let fetch = ReqwestFetch::new().unwrap();
        let mint_headers = vec![
            ("user-agent".to_string(), "rung-client/1.2".to_string()),
            ("x-rung-mark".to_string(), "minted".to_string()),
        ];
        let _response = fetch
            .get_range(RangeRequest {
                url: &url,
                offset: 0,
                max_len: 4,
                headers: &mint_headers,
                stall: Duration::from_secs(2),
                deadline: Duration::from_secs(3),
                cancel: CancellationToken::new(),
            })
            .await
            .unwrap();
        let _ = release.send(());
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn host_owned_mint_headers_never_reach_the_wire() {
        use super::*;
        // A directly-constructed source can name what the boundary
        // would have rejected — the fetch leg drops them regardless:
        // `reqwest.header()` appends, so a mint `range`/`host` would
        // otherwise ride beside the real one.
        let (url, release, worker) = serve_body(
            b"abcd",
            &["range: bytes=0-3", "host: 127.0.0.1"],
            &["bytes=0-0", "host: evil.example", "authorization:"],
        );
        let fetch = ReqwestFetch::new().unwrap();
        let mint_headers = vec![
            ("range".to_string(), "bytes=0-0".to_string()),
            ("host".to_string(), "evil.example".to_string()),
            ("authorization".to_string(), "Bearer x".to_string()),
        ];
        let _response = fetch
            .get_range(RangeRequest {
                url: &url,
                offset: 0,
                max_len: 4,
                headers: &mint_headers,
                stall: Duration::from_secs(2),
                deadline: Duration::from_secs(3),
                cancel: CancellationToken::new(),
            })
            .await
            .unwrap();
        let _ = release.send(());
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn cancellation_wakes_a_pending_body_read() {
        use super::*;
        let (url, release, worker) = serve_body(b"", &["range: bytes=0-3"], &[]);
        let token = CancellationToken::new();
        let fetch = ReqwestFetch::new().unwrap();
        let mut response = fetch
            .get_range(RangeRequest {
                url: &url,
                offset: 0,
                max_len: 4,
                headers: &[],
                stall: Duration::from_secs(2),
                deadline: Duration::from_secs(3),
                cancel: token.clone(),
            })
            .await
            .unwrap();
        let mut next = Box::pin(response.body.next());
        assert!(futures_util::poll!(&mut next).is_pending());
        token.cancel();
        let result = tokio::time::timeout(Duration::from_millis(200), next).await;
        let _ = release.send(());
        worker.join().unwrap();
        assert!(matches!(result, Ok(Some(Err(StreamError::Cancelled)))));
    }

    /// Shared-pool contract behind `with_client`: a range fetch must
    /// reuse a keep-alive connection an earlier request on the same
    /// `reqwest::Client` opened — the host relies on this for the
    /// probe → pump handoff (the guest's last-byte resolve probe warms
    /// the connection the first range fetch would otherwise
    /// re-handshake).
    #[tokio::test]
    async fn with_client_reuses_the_pooled_connection() {
        use super::*;
        use std::io::{Read, Write};
        use std::sync::mpsc;

        // One handler per accepted socket; it reports the socket's id
        // for every request it serves. Connection reuse ⇒ both
        // requests report the same id.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/range", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel::<usize>();
        // The acceptor stays blocked in `accept` after the assertions —
        // it dies with the test binary; each served socket gets its own
        // handler thread that exits on the read timeout.
        std::thread::spawn(move || {
            for (id, stream) in listener.incoming().enumerate() {
                let mut socket = match stream {
                    Ok(socket) => socket,
                    Err(_) => return,
                };
                socket
                    .set_read_timeout(Some(Duration::from_millis(800)))
                    .unwrap();
                let tx = tx.clone();
                std::thread::spawn(move || loop {
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        let mut byte = [0];
                        if socket.read_exact(&mut byte).is_err() {
                            return;
                        }
                        request.push(byte[0]);
                    }
                    if socket
                        .write_all(
                            b"HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nContent-Range: bytes 0-3/100\r\n\r\nxxxx",
                        )
                        .is_err()
                    {
                        return;
                    }
                    let _ = tx.send(id);
                });
            }
        });

        let client = reqwest::Client::new();
        // The guest's resolve probe — same origin, keep-alive conn.
        let probe = client.get(&url).send().await.unwrap();
        drop(probe.bytes().await);

        let fetch = ReqwestFetch::with_client(client);
        let mut response = fetch
            .get_range(RangeRequest {
                url: &url,
                offset: 0,
                max_len: 4,
                headers: &[],
                stall: Duration::from_secs(2),
                deadline: Duration::from_secs(3),
                cancel: CancellationToken::new(),
            })
            .await
            .unwrap();
        while let Some(_piece) = response.body.next().await {}

        let mut served = Vec::new();
        while served.len() < 2 {
            served.push(rx.recv_timeout(Duration::from_secs(2)).unwrap());
        }
        assert_eq!(
            served,
            [0, 0],
            "probe and range fetch must ride one pooled connection"
        );
    }

    const MINT: &str = "https://rr1---sn-x.googlevideo.com/videoplayback?sig=1";

    #[test]
    fn follow_target_accepts_same_host_https_location_on_3xx() {
        assert_eq!(
            follow_target(
                302,
                Some("https://rr1---sn-x.googlevideo.com/videoplayback?rn=1"),
                MINT
            ),
            Some("https://rr1---sn-x.googlevideo.com/videoplayback?rn=1")
        );
    }

    #[test]
    fn follow_target_accepts_subdomain_of_mint_host() {
        assert_eq!(
            follow_target(302, Some("https://cdn.rr1---sn-x.googlevideo.com/x"), MINT),
            Some("https://cdn.rr1---sn-x.googlevideo.com/x")
        );
        // Sibling edge under the same parent domain (rr1 -> rr2).
        assert_eq!(
            follow_target(
                302,
                Some("https://rr2---sn-x.googlevideo.com/videoplayback"),
                MINT
            ),
            Some("https://rr2---sn-x.googlevideo.com/videoplayback")
        );
    }

    #[test]
    fn follow_target_refuses_foreign_host_downgrade_and_non_3xx() {
        assert_eq!(
            follow_target(302, Some("https://attacker.example.com/x"), MINT),
            None
        );
        // A lookalike name under the mint's parent is still inside the
        // provider's trust zone — the parent domain owns the policy.
        assert_eq!(
            follow_target(302, Some("https://evil-rr1---sn-x.googlevideo.com/x"), MINT),
            Some("https://evil-rr1---sn-x.googlevideo.com/x")
        );
        // A lookalike on the full mint host (no dot boundary) is not.
        assert_eq!(
            follow_target(
                302,
                Some("https://evil-rr1---sn-x.googlevideo.com.evil.com/x"),
                MINT
            ),
            None
        );
        assert_eq!(
            follow_target(
                302,
                Some("http://rr1---sn-x.googlevideo.com/videoplayback"),
                MINT
            ),
            None
        );
        assert_eq!(follow_target(302, Some("/relative/path"), MINT), None);
        assert_eq!(follow_target(302, None, MINT), None);
        assert_eq!(
            follow_target(206, Some("https://rr1---sn-x.googlevideo.com/x"), MINT),
            None
        );
        // `HTTPS` in mixed case still counts as https.
        assert_eq!(
            follow_target(302, Some("HTTPS://rr1---sn-x.googlevideo.com/x"), MINT),
            Some("HTTPS://rr1---sn-x.googlevideo.com/x")
        );
        // Sibling widening applies only under a known edge parent zone —
        // an arbitrary sibling is a foreign host.
        assert_eq!(
            follow_target(
                302,
                Some("https://evil.example.com/x"),
                "https://media.example.com/a"
            ),
            None
        );
        assert_eq!(
            follow_target(
                302,
                Some("https://other.co.uk/x"),
                "https://example.co.uk/a"
            ),
            None
        );
        assert_eq!(
            follow_target(
                302,
                Some("https://edge2.example.co.uk/x"),
                "https://media.example.co.uk/a"
            ),
            None
        );
    }
}
