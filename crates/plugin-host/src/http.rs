//! The `HttpClient` boundary: guests request HTTP via host steps; the host
//! performs requests through an injected implementation.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use tokio_util::sync::CancellationToken;

use crate::error::{HttpError, HttpErrorKind};

/// An HTTP request the guest asked the host to perform.
#[derive(Debug, Clone)]
pub struct HttpRequest {
    /// `GET` or `POST`.
    pub method: String,
    /// `https://` destination.
    pub url: String,
    /// Header name/value pairs.
    pub headers: Vec<(String, String)>,
    /// Optional request body.
    pub body: Option<Vec<u8>>,
    /// Maximum response body bytes the host will accept.
    pub max_response_bytes: u64,
}

/// A completed HTTP response, body already collected.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    /// Status code.
    pub status: u16,
    /// Response header name/value pairs.
    pub headers: Vec<(String, String)>,
    /// Response body, capped at `HttpRequest::max_response_bytes`.
    pub body: Vec<u8>,
}

/// Performs HTTP on behalf of guest `host_request` steps.
///
/// Implementations must honor `timeout` and `cancel`; dropping the returned
/// future must abort any in-flight request.
pub trait HttpClient: Send + Sync {
    /// Send `req`, bounded by `timeout` and abortable via `cancel`.
    fn send(
        &self,
        req: HttpRequest,
        timeout: Duration,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>>;
}

/// [`HttpClient`] backed by `reqwest` with rustls (no OpenSSL; the host
/// must cross-compile to Android).
pub struct ReqwestClient {
    client: reqwest::Client,
}

impl ReqwestClient {
    /// Build a client with rustls TLS.
    ///
    /// Redirects are never followed: a 3xx from an allow-listed host would
    /// otherwise be chased to an arbitrary (possibly non-https, non-listed)
    /// destination, defeating the manifest destination policy. The guest
    /// sees the 3xx verbatim and may re-request the `Location` target
    /// through the normal authorization path.
    ///
    /// # Errors
    /// Returns [`HttpError`] if the TLS backend cannot be initialized.
    pub fn new() -> Result<Self, HttpError> {
        let builder = reqwest::Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::none())
            // Guests reach allow-listed hosts directly — ambient
            // HTTP(S)_PROXY/ALL_PROXY env in the host process must not
            // reroute plugin traffic through a middlebox that sees
            // every destination and answers routing for it.
            .no_proxy();
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let builder = {
            // rustls-platform-verifier needs an Android Context over JNI
            // that a plain cdylib never receives; verify against the
            // bundled Mozilla roots instead — same path on iOS so both
            // mobile targets share one trust store.
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let tls = rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            builder.use_preconfigured_tls(tls)
        };
        let client = builder.build().map_err(|e| HttpError {
            kind: HttpErrorKind::Transient,
            message: format!("client init: {e}"),
            bytes_received: 0,
        })?;
        Ok(Self { client })
    }
}

impl HttpClient for ReqwestClient {
    fn send(
        &self,
        req: HttpRequest,
        timeout: Duration,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        Box::pin(async move {
            let method =
                reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| HttpError {
                    kind: HttpErrorKind::InvalidRequest,
                    message: format!("method: {e}"),
                    bytes_received: 0,
                })?;
            let mut rb = self.client.request(method, &req.url);
            for (name, value) in &req.headers {
                rb = rb.header(name.as_str(), value.as_str());
            }
            if let Some(body) = req.body {
                rb = rb.body(body);
            }
            // Bytes pulled off the wire so far, shared with the
            // timeout/cancel arms: a response that errors or is aborted
            // mid-body still spent those bytes.
            let received = Arc::new(AtomicU64::new(0));
            let seen = Arc::clone(&received);
            let work = async move {
                let resp = rb.send().await.map_err(|e| HttpError {
                    kind: if e.is_timeout() {
                        HttpErrorKind::Timeout
                    } else {
                        HttpErrorKind::Transient
                    },
                    // reqwest's Display embeds the request URL — signed
                    // params and `pot=` must never reach the guest.
                    message: e.without_url().to_string(),
                    bytes_received: 0,
                })?;
                let status = resp.status().as_u16();
                let headers = resp
                    .headers()
                    .iter()
                    .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                    .collect::<Vec<_>>();
                let cap = usize::try_from(req.max_response_bytes).unwrap_or(usize::MAX);
                let mut body = Vec::new();
                let mut stream = resp.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| HttpError {
                        kind: HttpErrorKind::Transient,
                        message: e.without_url().to_string(),
                        bytes_received: seen.load(Ordering::Relaxed),
                    })?;
                    seen.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                    if body.len() + chunk.len() > cap {
                        return Err(HttpError {
                            kind: HttpErrorKind::BodyTooLarge,
                            message: format!("response body exceeds {cap} byte cap"),
                            bytes_received: seen.load(Ordering::Relaxed),
                        });
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(HttpResponse {
                    status,
                    headers,
                    body,
                })
            };
            tokio::select! {
                () = cancel.cancelled() => Err(HttpError {
                    kind: HttpErrorKind::Cancelled,
                    message: "cancelled".into(),
                    bytes_received: received.load(Ordering::Relaxed),
                }),
                res = tokio::time::timeout(timeout, work) => match res {
                    Ok(inner) => inner,
                    Err(_) => Err(HttpError {
                        kind: HttpErrorKind::Timeout,
                        message: format!("request exceeded {timeout:?}"),
                        bytes_received: received.load(Ordering::Relaxed),
                    }),
                },
            }
        })
    }
}
