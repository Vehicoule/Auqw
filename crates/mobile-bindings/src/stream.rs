//! The streaming-seam surface of the UniFFI boundary.
//!
//! `start_prepare` runs a `playback.resolve` through the normal
//! invocation path and registers the result with the seam's
//! [`StreamRegistry`]; the `stream_*` calls are the player's
//! synchronous session surface (attach, blocking read, close,
//! release, marks). The signed URL never crosses this boundary —
//! outcomes carry handles and metadata only.

use std::pin::Pin;
use std::sync::Arc;

use auqw_plugin_host::{
    invoke, Attempt, Budgets, HostServices, KeyValueStore, LoadedPlugin, ReqwestClient, SystemClock,
};
use auqw_stream::{PhaseMarks, PrepareInfo, PreparedSource, Remint, StreamRegistry};
use serde_json::{json, Value};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::{lock, resource_from, AttemptSummary, HostError, PluginHost};

/// A prepared stream session as reported to the player: the opaque
/// handle plus metadata. The signed URL never crosses this boundary.
#[derive(uniffi::Record)]
pub struct PreparedStream {
    /// Opaque session handle for `stream_open`/`stream_read`/...
    pub handle: String,
    /// MIME type; pinned across re-mints.
    pub mime: String,
    /// Format itag when reported.
    pub itag: Option<u32>,
    /// Bitrate hint in kbps.
    pub bitrate_kbps: Option<u32>,
    /// Reported length in bytes, when known.
    pub content_length: Option<u64>,
    /// URL expiry, epoch ms.
    pub expires_at_ms: Option<u64>,
}

impl From<PrepareInfo> for PreparedStream {
    fn from(i: PrepareInfo) -> Self {
        Self {
            handle: i.handle,
            mime: i.mime,
            itag: i.itag,
            bitrate_kbps: i.bitrate_kbps,
            content_length: i.content_length,
            expires_at_ms: i.expires_at_ms,
        }
    }
}

/// Terminal outcome of one `start_prepare` invocation.
#[derive(uniffi::Enum)]
pub enum PrepareOutcome {
    /// The resolve produced a source and the seam registered it.
    Prepared {
        /// The prepared session handle + metadata.
        stream: PreparedStream,
        /// Invocation accounting for the resolve.
        attempt: AttemptSummary,
    },
    /// The resolve or the seam registration failed.
    Failed {
        /// Taxonomy kind (`no-result`, `cancelled`, ...).
        kind: String,
        /// Human-readable detail (never contains the URL).
        message: String,
        /// Invocation accounting for the resolve.
        attempt: AttemptSummary,
    },
}

/// Receives the terminal outcome of [`PluginHost::start_prepare`].
#[uniffi::export(callback_interface)]
pub trait PrepareListener: Send + Sync {
    /// Called exactly once per request, on a runtime worker thread.
    fn on_outcome(&self, request_id: String, outcome: PrepareOutcome);
}

/// Errors raised synchronously by the `stream_*` calls.
///
/// Field names avoid `message` for the same reason as [`HostError`].
#[derive(uniffi::Error, Error, Debug)]
pub enum StreamError {
    /// `HostConfig.stream_path` was unset — the seam is not running.
    #[error("stream seam unavailable (stream_path unset)")]
    Unavailable,
    /// The session operation failed; `kind` is the ABI taxonomy.
    #[error("{kind}: {detail}")]
    Failed {
        /// Kebab-case error kind.
        kind: String,
        /// Failure detail (never contains the signed URL).
        detail: String,
    },
}

/// Lifecycle marks for one stream session: epoch-ms timestamps plus
/// durations, for joining intent → prepared → attached → rendered.
#[derive(uniffi::Record)]
pub struct StreamPhaseMarks {
    /// Epoch ms when `prepare` registered the session.
    pub prepare_started_ms: u64,
    /// Duration of the minting `playback.resolve`, when known.
    pub resolve_ms: Option<u64>,
    /// Duration of the most recent re-mint, when one ran.
    pub mint_ms: Option<u64>,
    /// Epoch ms when the first byte landed.
    pub first_byte_ms: Option<u64>,
    /// Epoch ms when the head-fill bound was covered.
    pub head_ready_ms: Option<u64>,
    /// Epoch ms of the first attach.
    pub attach_ms: Option<u64>,
}

impl From<PhaseMarks> for StreamPhaseMarks {
    fn from(m: PhaseMarks) -> Self {
        Self {
            prepare_started_ms: m.prepare_started_ms,
            resolve_ms: m.resolve_ms,
            mint_ms: m.mint_ms,
            first_byte_ms: m.first_byte_ms,
            head_ready_ms: m.head_ready_ms,
            attach_ms: m.attach_ms,
        }
    }
}

fn seam_err(e: auqw_stream::StreamError) -> StreamError {
    StreamError::Failed {
        kind: e.kind().to_string(),
        detail: e.to_string(),
    }
}

/// Map an invocation failure kind onto the seam's taxonomy — remint
/// results are terminal for the session, so the kind is diagnostic.
fn invoke_err_as_seam(kind: &str, message: String) -> auqw_stream::StreamError {
    use auqw_stream::StreamError as E;
    match kind {
        "cancelled" => E::Cancelled,
        "expired" => E::Expired,
        "rate-limit" => E::RateLimited { message },
        "streams-capped" => E::StreamsCapped { message },
        "transient" => E::Transient { message },
        "invalid-response" | "no-result" | "not-applicable" => E::InvalidResponse { message },
        _ => E::Internal { message },
    }
}

/// Re-mints a session's source by re-running `playback.resolve` with
/// the same plugin, budgets, and services as a normal invocation. The
/// pump pins the prepared mime on the returned source.
struct PluginRemint {
    plugin: Arc<LoadedPlugin>,
    source_ref: String,
    budgets: Budgets,
    http: Arc<ReqwestClient>,
    kv: Arc<dyn KeyValueStore>,
    pot_provider: Option<String>,
}

impl Remint for PluginRemint {
    fn remint(
        &self,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<PreparedSource, auqw_stream::StreamError>>
                + Send,
        >,
    > {
        let plugin = Arc::clone(&self.plugin);
        let source_ref = self.source_ref.clone();
        let budgets = self.budgets.clone();
        let http = Arc::clone(&self.http);
        let kv = Arc::clone(&self.kv);
        let pot_provider = self.pot_provider.clone();
        Box::pin(async move {
            let clock = SystemClock;
            let invocation = invoke(
                &plugin,
                "playback.resolve",
                json!({ "source_ref": source_ref }),
                &budgets,
                CancellationToken::new(),
                HostServices {
                    http: &*http,
                    kv: &*kv,
                    clock: &clock,
                    pot_provider: pot_provider.as_deref(),
                },
            )
            .await;
            let (result, _attempt) = invocation.into_parts();
            let value = result.map_err(|e| invoke_err_as_seam(e.kind(), e.to_string()))?;
            let resource = resource_from(&value);
            if resource.url.is_empty() {
                return Err(auqw_stream::StreamError::InvalidResponse {
                    message: "remint resolve missing url".into(),
                });
            }
            Ok(PreparedSource {
                url: resource.url,
                mime: resource.mime,
                itag: resource.itag,
                bitrate_kbps: resource.bitrate_kbps,
                content_length: resource.content_length,
                expires_at_ms: resource.expires_at_ms,
                source_ref,
            })
        })
    }
}

/// Turn a successful resolve value into a [`PrepareOutcome`]: register
/// the source with the seam, or explain why it cannot play.
fn prepare_outcome(
    value: &Value,
    stream: &StreamRegistry,
    remint: PluginRemint,
    attempt: &Attempt,
    source_ref: String,
) -> PrepareOutcome {
    let resource = resource_from(value);
    let summary = AttemptSummary::from(attempt);
    if resource.url.is_empty() {
        return PrepareOutcome::Failed {
            kind: "invalid-response".to_string(),
            message: "resolve result missing url".to_string(),
            attempt: summary,
        };
    }
    let source = PreparedSource {
        url: resource.url,
        mime: resource.mime,
        itag: resource.itag,
        bitrate_kbps: resource.bitrate_kbps,
        content_length: resource.content_length,
        expires_at_ms: resource.expires_at_ms,
        source_ref,
    };
    match stream.prepare_timed(source, Arc::new(remint), Some(attempt.elapsed)) {
        Ok(info) => PrepareOutcome::Prepared {
            stream: PreparedStream::from(info),
            attempt: summary,
        },
        Err(e) => PrepareOutcome::Failed {
            kind: e.kind().to_string(),
            message: e.to_string(),
            attempt: summary,
        },
    }
}

#[uniffi::export]
impl PluginHost {
    /// Resolve `source_ref` and register the result as a prepared
    /// stream session (bounded speculative head fill). The outcome —
    /// including the opaque stream handle — arrives on `listener`.
    ///
    /// # Errors
    /// [`HostError::UnknownPlugin`] if `plugin_id` was never loaded;
    /// [`HostError::Runtime`] when the seam is not configured.
    pub fn start_prepare(
        &self,
        plugin_id: String,
        source_ref: String,
        listener: Box<dyn PrepareListener>,
    ) -> Result<String, HostError> {
        let stream = match &self.stream {
            Some(s) => Arc::clone(s),
            None => {
                return Err(HostError::Runtime {
                    detail: "stream seam unavailable (stream_path unset)".into(),
                });
            }
        };
        // The remint needs the plugin handle inside the outcome closure
        // — resolve it now so an unknown id fails synchronously.
        let plugin = {
            let plugins = lock(&self.plugins)?;
            match plugins.get(&plugin_id) {
                Some(p) => Arc::clone(p),
                None => return Err(HostError::UnknownPlugin { id: plugin_id }),
            }
        };
        let remint = PluginRemint {
            plugin,
            source_ref: source_ref.clone(),
            budgets: self.budgets.clone(),
            http: Arc::clone(&self.http),
            kv: Arc::clone(&self.kv),
            pot_provider: self.pot_provider_url.clone(),
        };
        self.start_typed(
            plugin_id,
            "playback.resolve".to_string(),
            json!({ "source_ref": source_ref }),
            move |request_id, invocation| {
                let (result, attempt) = invocation.into_parts();
                let outcome = match result {
                    Ok(value) => prepare_outcome(&value, &stream, remint, &attempt, source_ref),
                    Err(e) => PrepareOutcome::Failed {
                        kind: e.kind().to_string(),
                        message: e.to_string(),
                        attempt: AttemptSummary::from(&attempt),
                    },
                };
                listener.on_outcome(request_id, outcome);
            },
        )
    }

    /// Attach a consumer at `position` (DataSource open). Returns
    /// `content_length - position` when the stream total is known.
    ///
    /// # Errors
    /// [`StreamError::Unavailable`] when the seam is not configured;
    /// [`StreamError::Failed`] with the session's kind otherwise.
    pub fn stream_open(&self, handle: String, position: u64) -> Result<Option<u64>, StreamError> {
        self.stream_registry()?
            .attach(&handle, position)
            .map_err(seam_err)
    }

    /// Blocking read — **foreign (JNI/DataSource) threads only**;
    /// parking a runtime worker is a bug. Empty bytes = EOF. Bounded by
    /// the seam's read deadline; terminal transitions wake into their
    /// typed error.
    ///
    /// # Errors
    /// [`StreamError::Unavailable`] when the seam is not configured;
    /// [`StreamError::Failed`] with the session's kind otherwise.
    pub fn stream_read(
        &self,
        handle: String,
        position: u64,
        max_len: u64,
    ) -> Result<Vec<u8>, StreamError> {
        self.stream_registry()?
            .read(&handle, position, max_len)
            .map_err(seam_err)
    }

    /// DataSource close: detaches the consumer; the session stays live
    /// for re-attach.
    ///
    /// # Errors
    /// [`StreamError::Unavailable`] when the seam is not configured;
    /// [`StreamError::Failed`] for an unknown handle.
    pub fn stream_close(&self, handle: String) -> Result<(), StreamError> {
        self.stream_registry()?.close(&handle).map_err(seam_err)
    }

    /// Terminal release: parked readers unwind `released`, in-flight
    /// work aborts, the partial file is evicted. Idempotent.
    ///
    /// # Errors
    /// [`StreamError::Unavailable`] when the seam is not configured.
    pub fn stream_release(&self, handle: String) -> Result<(), StreamError> {
        self.stream_registry()?.release(&handle).map_err(seam_err)
    }

    /// The session's lifecycle marks — available even after terminal
    /// states.
    ///
    /// # Errors
    /// [`StreamError::Unavailable`] when the seam is not configured;
    /// [`StreamError::Failed`] for an unknown handle.
    pub fn stream_phase_marks(&self, handle: String) -> Result<StreamPhaseMarks, StreamError> {
        self.stream_registry()?
            .phase_marks(&handle)
            .map(StreamPhaseMarks::from)
            .map_err(seam_err)
    }
}

impl PluginHost {
    fn stream_registry(&self) -> Result<&StreamRegistry, StreamError> {
        self.stream.as_deref().ok_or(StreamError::Unavailable)
    }
}
