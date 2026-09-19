//! The `HttpClient` boundary: guests request HTTP via host steps; the host
//! performs requests through an injected implementation.

use std::future::Future;
use std::pin::Pin;
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
    /// # Errors
    /// Returns [`HttpError`] if the TLS backend cannot be initialized.
    pub fn new() -> Result<Self, HttpError> {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .build()
            .map_err(|e| HttpError {
                kind: HttpErrorKind::Transient,
                message: format!("client init: {e}"),
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
                })?;
            let mut rb = self.client.request(method, &req.url);
            for (name, value) in &req.headers {
                rb = rb.header(name.as_str(), value.as_str());
            }
            if let Some(body) = req.body {
                rb = rb.body(body);
            }
            let work = async {
                let resp = rb.send().await.map_err(|e| HttpError {
                    kind: if e.is_timeout() {
                        HttpErrorKind::Timeout
                    } else {
                        HttpErrorKind::Transient
                    },
                    message: e.to_string(),
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
                        message: e.to_string(),
                    })?;
                    if body.len() + chunk.len() > cap {
                        return Err(HttpError {
                            kind: HttpErrorKind::BodyTooLarge,
                            message: format!("response body exceeds {cap} byte cap"),
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
                }),
                res = tokio::time::timeout(timeout, work) => match res {
                    Ok(inner) => inner,
                    Err(_) => Err(HttpError {
                        kind: HttpErrorKind::Timeout,
                        message: format!("request exceeded {timeout:?}"),
                    }),
                },
            }
        })
    }
}
