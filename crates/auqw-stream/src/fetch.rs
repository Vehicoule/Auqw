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

/// One raw range response, unvalidated — the pump applies the wire
/// rules (206-only, `Content-Range`, empty/oversized) itself.
pub struct FetchResponse {
    /// HTTP status code.
    pub status: u16,
    /// Raw `Content-Range` header value, when the server sent one.
    pub content_range: Option<String>,
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
    /// `GET url` with `Range: bytes=offset..offset+max_len-1`.
    ///
    /// `max_len` is always positive and bounded by the configured chunk
    /// size — full-file GETs are never issued (they throttle).
    fn get_range<'a>(
        &'a self,
        url: &'a str,
        offset: u64,
        max_len: u64,
        stall: Duration,
        deadline: Duration,
        cancel: CancellationToken,
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

/// Is `target_host` inside the mint's trust scope: the mint host
/// itself, one of its subdomains, or a sibling under the parent domain
/// (CDN edges re-issue across siblings: `rr1` → `rr2---sn-x`). The
/// parent rule applies only when the parent's leading label is a real
/// registrable name (≥3 chars) — mints like `example.co.uk` must not
/// widen the scope to every `*.co.uk` site.
fn redirect_in_scope(target_host: &str, mint_host: &str) -> bool {
    if target_host == mint_host || target_host.ends_with(&format!(".{mint_host}")) {
        return true;
    }
    match mint_host.split_once('.') {
        Some((_, parent)) => match parent.split('.').next() {
            Some(first) if first.len() >= 3 => target_host.ends_with(&format!(".{parent}")),
            _ => false,
        },
        None => false,
    }
}

impl Fetch for ReqwestFetch {
    fn get_range<'a>(
        &'a self,
        url: &'a str,
        offset: u64,
        max_len: u64,
        stall: Duration,
        deadline: Duration,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<FetchResponse, StreamError>> + Send + 'a>> {
        Box::pin(async move {
            let end = offset.saturating_add(max_len.saturating_sub(1));
            let t0 = std::time::Instant::now();
            let range = format!("bytes={offset}-{end}");
            let headers = async {
                let mut current = url.to_string();
                for hop in 0..2 {
                    let req = self
                        .client
                        .get(&current)
                        .header(reqwest::header::RANGE, range.clone());
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
                body,
            })
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::follow_target;

    // Real local HTTP verifies the production adapter, independently of pump fakes.
    fn serve_body(
        body: &'static [u8],
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
            assert!(String::from_utf8_lossy(&request).contains("range: bytes=0-3"));
            socket.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 100\r\nContent-Range: bytes 0-3/100\r\n\r\n").unwrap();
            socket.write_all(body).unwrap();
            let _ = wait.recv_timeout(std::time::Duration::from_secs(5));
        });
        (url, release, worker)
    }

    #[tokio::test]
    async fn body_yield_is_capped_at_requested_length_plus_one() {
        use super::*;
        let (url, release, worker) = serve_body(b"01234567890123456789");
        let fetch = ReqwestFetch::new().unwrap();
        let mut response = fetch
            .get_range(
                &url,
                0,
                4,
                Duration::from_secs(2),
                Duration::from_secs(3),
                CancellationToken::new(),
            )
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
    async fn cancellation_wakes_a_pending_body_read() {
        use super::*;
        let (url, release, worker) = serve_body(b"");
        let token = CancellationToken::new();
        let fetch = ReqwestFetch::new().unwrap();
        let mut response = fetch
            .get_range(
                &url,
                0,
                4,
                Duration::from_secs(2),
                Duration::from_secs(3),
                token.clone(),
            )
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
        // A mint on a shared-suffix shape does not widen to it.
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
            Some("https://edge2.example.co.uk/x")
        );
    }
}
