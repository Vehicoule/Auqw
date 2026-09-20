//! The byte-fetch boundary. The pump owns every wire rule — a [`Fetch`]
//! implementation only moves bytes for one `Range` request — so tests
//! inject fakes and never open sockets.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use futures_util::StreamExt;
use tokio_util::sync::CancellationToken;

use crate::error::StreamError;

/// One raw range response, unvalidated — the pump applies the wire
/// rules (206-only, `Content-Range`, empty/oversized) itself.
pub struct FetchResponse {
    /// HTTP status code.
    pub status: u16,
    /// Raw `Content-Range` header value, when the server sent one.
    pub content_range: Option<String>,
    /// Response body bytes, at most `max_len + 1` (one byte over is
    /// enough for the pump to reject oversized bodies without letting
    /// a bad server stream unbounded memory).
    pub body: Vec<u8>,
}

/// Performs `GET` range requests on behalf of one session's pump.
///
/// Contract: implementations must honor `stall` as a no-progress bound
/// (headers wait, or any gap between body chunks) and `cancel` as a
/// cooperative abort. Error messages must never contain `url` — it is
/// signed. Dropping the returned future must abort the request.
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
            .redirect(reqwest::redirect::Policy::none());
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let builder = {
            // A bare cdylib has no JNI Context for the platform
            // verifier; bundle the Mozilla roots (same path as the
            // plugin host, so mobile targets share one trust store).
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let tls = rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            builder.use_preconfigured_tls(tls)
        };
        let client = builder.build().map_err(|e| StreamError::Internal {
            message: format!("http client init: {e}"),
        })?;
        Ok(Self { client })
    }
}

/// Collect a streaming body with a per-chunk stall bound and a hard
/// `max_len + 1` cap (see [`FetchResponse::body`]).
async fn collect_body(
    resp: reqwest::Response,
    max_len: u64,
    stall: Duration,
) -> Result<Vec<u8>, StreamError> {
    let cap = usize::try_from(max_len.saturating_add(1)).unwrap_or(usize::MAX);
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while body.len() < cap {
        let next = tokio::time::timeout(stall, stream.next()).await;
        let chunk = match next {
            Err(_) => {
                return Err(StreamError::Transient {
                    message: format!("body stalled for {stall:?}"),
                })
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => {
                return Err(StreamError::Transient {
                    // `without_url`: reqwest errors embed the request
                    // URL — signed params must never reach an error.
                    message: e.without_url().to_string(),
                });
            }
            Ok(Some(Ok(c))) => c,
        };
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

impl Fetch for ReqwestFetch {
    fn get_range<'a>(
        &'a self,
        url: &'a str,
        offset: u64,
        max_len: u64,
        stall: Duration,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<FetchResponse, StreamError>> + Send + 'a>> {
        Box::pin(async move {
            let end = offset.saturating_add(max_len.saturating_sub(1));
            let req = self
                .client
                .get(url)
                .header(reqwest::header::RANGE, format!("bytes={offset}-{end}"));
            let work = async move {
                let resp = tokio::time::timeout(stall, req.send())
                    .await
                    .map_err(|_| StreamError::Transient {
                        message: format!("headers stalled for {stall:?}"),
                    })?
                    .map_err(|e| StreamError::Transient {
                        message: e.without_url().to_string(),
                    })?;
                let status = resp.status().as_u16();
                let content_range = resp
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                let body = collect_body(resp, max_len, stall).await?;
                Ok(FetchResponse {
                    status,
                    content_range,
                    body,
                })
            };
            tokio::select! {
                () = cancel.cancelled() => Err(StreamError::Cancelled),
                r = work => r,
            }
        })
    }
}
