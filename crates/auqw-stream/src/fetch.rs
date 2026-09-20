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

/// [`Fetch`] over `reqwest` + rustls, redirect-free (same policy as the
/// plugin host: chasing a redirect would leave the minted target).
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
            let req = self
                .client
                .get(url)
                .header(reqwest::header::RANGE, format!("bytes={offset}-{end}"));
            // The deadline covers headers *and* body from this instant;
            // `stall` bounds each gap inside the body stream.
            let t0 = std::time::Instant::now();
            let resp = tokio::select! {
                () = cancel.cancelled() => return Err(StreamError::Cancelled),
                r = tokio::time::timeout(stall.min(deadline), req.send()) => {
                    r.map_err(|_| StreamError::Transient {
                        // Name the bound that actually fired.
                        message: if deadline <= stall {
                            format!("request exceeded deadline {deadline:?}")
                        } else {
                            format!("headers stalled for {stall:?}")
                        },
                    })?
                    .map_err(|e| StreamError::Transient {
                        // `without_url`: reqwest errors embed the request
                        // URL — signed params must never reach an error.
                        message: e.without_url().to_string(),
                    })?
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
                            match tokio::time::timeout(stall.min(left), stream.next()).await {
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
                                    let got = got + c.len() as u64;
                                    Some((Ok(c.to_vec()), got))
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
