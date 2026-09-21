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
        /// Handles this prepare superseded or pruned — the caller's
        /// handle routing must drop these so a dead session's entry
        /// can never serve a later attach.
        superseded: Vec<String>,
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
        detail: e.detail(),
    }
}

/// Map an invocation failure kind onto the seam's taxonomy — remint
/// results are terminal for the session, so the kind is diagnostic.
fn invoke_err_as_seam(kind: &str, message: String) -> auqw_stream::StreamError {
    use auqw_stream::StreamError as E;
    match kind {
        "cancelled" => E::Cancelled,
        "expired" | "expired-resource" | "auth-expired" => E::Expired,
        "rate-limit" => E::RateLimited { message },
        "streams-capped" => E::StreamsCapped { message },
        "transient" | "timeout" => E::Transient { message },
        "invalid-response" | "no-result" | "not-applicable" => E::InvalidResponse { message },
        "not-found" => E::NotFound,
        _ => E::Internal { message },
    }
}

/// Re-mints a session's source by re-running `playback.resolve` with
/// the same plugin, budgets, and services as a normal invocation. The
/// resolve carries `pin_itag` for the minted format so a re-mint
/// cannot silently land a different encode, and the session still
/// pins mime and itag on the returned source — a swap is terminal
/// even if a guest ignores the pin.
struct PluginRemint {
    plugin: Arc<LoadedPlugin>,
    /// The manifest id — the minted source's provider identity, part
    /// of the session's coalescing key.
    provider: String,
    source_ref: String,
    /// The itag the first resolve minted, set by `prepare_outcome` —
    /// sent as `pin_itag` on every re-mint.
    pin_itag: Option<u32>,
    /// The surface `prefer` hint — identical to the first resolve's so
    /// a re-mint never re-picks under a different container order.
    prefer: Option<Vec<String>>,
    /// The host's live token slot — read at re-mint so a refreshed
    /// token reaches mid-stream recovery, not the snapshot from
    /// prepare time.
    auth_token: Arc<std::sync::RwLock<Option<String>>>,
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
        let provider = self.provider.clone();
        let source_ref = self.source_ref.clone();
        let pin_itag = self.pin_itag;
        let prefer = self.prefer.clone();
        // Read the live slot at re-mint time — a token refreshed since
        // prepare is exactly what a cap-death recovery should carry.
        let auth_token = self.auth_token.read().ok().and_then(|slot| slot.clone());
        let budgets = self.budgets.clone();
        let http = Arc::clone(&self.http);
        let kv = Arc::clone(&self.kv);
        let pot_provider = self.pot_provider.clone();
        Box::pin(async move {
            let clock = SystemClock;
            let invocation = invoke(
                &plugin,
                "playback.resolve",
                remint_payload(&source_ref, pin_itag, &prefer, &auth_token),
                &budgets,
                CancellationToken::new(),
                HostServices {
                    http: &*http,
                    kv,
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
                provider,
            })
        })
    }
}

/// The `playback.resolve` payload for a re-mint: `source_ref` plus
/// `pin_itag` when the first resolve minted one — the guest keeps the
/// same encode across cap-death recovery instead of re-walking the
/// format ladder into a different itag under the same mime. The
/// surface `prefer` hint and the live `access_token` ride verbatim —
/// the re-mint path bypasses `start_typed`, so it carries the merge
/// itself.
fn remint_payload(
    source_ref: &str,
    pin_itag: Option<u32>,
    prefer: &Option<Vec<String>>,
    auth_token: &Option<String>,
) -> Value {
    let mut payload = serde_json::Map::new();
    payload.insert("source_ref".to_string(), json!(source_ref));
    if let Some(itag) = pin_itag {
        payload.insert("pin_itag".to_string(), json!(itag));
    }
    if let Some(prefer) = prefer {
        payload.insert("prefer".to_string(), json!(prefer));
    }
    if let Some(token) = auth_token {
        payload.insert("access_token".to_string(), json!(token));
    }
    Value::Object(payload)
}

/// Turn a successful resolve value into a [`PrepareOutcome`]: register
/// the source with the seam, or explain why it cannot play.
fn prepare_outcome(
    value: &Value,
    stream: &StreamRegistry,
    mut remint: PluginRemint,
    attempt: &Attempt,
    source_ref: String,
    provider: String,
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
    remint.pin_itag = resource.itag;
    let source = PreparedSource {
        url: resource.url,
        mime: resource.mime,
        itag: resource.itag,
        bitrate_kbps: resource.bitrate_kbps,
        content_length: resource.content_length,
        expires_at_ms: resource.expires_at_ms,
        source_ref,
        provider,
    };
    match stream.prepare_timed(source, Arc::new(remint), Some(attempt.elapsed)) {
        Ok(info) => PrepareOutcome::Prepared {
            superseded: info.superseded.clone(),
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
            provider: plugin_id.clone(),
            source_ref: source_ref.clone(),
            pin_itag: None,
            prefer: self.prefer.clone(),
            auth_token: Arc::clone(&self.auth_token),
            budgets: self.budgets.clone(),
            http: Arc::clone(&self.http),
            kv: Arc::clone(&self.kv),
            pot_provider: self.pot_provider_url.clone(),
        };
        let provider = plugin_id.clone();
        let prepared_handles = Arc::clone(&self.prepared_handles);
        // `prefer` is a key, not a value: absent means "guest default",
        // never a null that fails payload validation. `access_token`
        // rides via the `start_typed` merge.
        let mut payload = serde_json::Map::new();
        payload.insert("source_ref".to_string(), json!(source_ref));
        if let Some(prefer) = &self.prefer {
            payload.insert("prefer".to_string(), json!(prefer));
        }
        self.start_typed(
            plugin_id,
            "playback.resolve".to_string(),
            Value::Object(payload),
            move |request_id, invocation| async move {
                let (result, attempt) = invocation.into_parts();
                let summary = AttemptSummary::from(&attempt);
                // `stream` is moved into the blocking closure below —
                // keep a clone for the bookkeeping prune.
                let registry = Arc::clone(&stream);
                let outcome = match result {
                    Ok(value) => {
                        // Session creation does file I/O — run it on the
                        // blocking pool, not a runtime worker shared
                        // with guest wasm.
                        let work = tokio::task::spawn_blocking(move || {
                            prepare_outcome(&value, &stream, remint, &attempt, source_ref, provider)
                        });
                        match work.await {
                            Ok(o) => o,
                            Err(_) => PrepareOutcome::Failed {
                                kind: "internal".to_string(),
                                message: "prepare worker panicked".to_string(),
                                attempt: summary,
                            },
                        }
                    }
                    Err(e) => PrepareOutcome::Failed {
                        kind: e.kind().to_string(),
                        message: e.to_string(),
                        attempt: summary,
                    },
                };
                if let PrepareOutcome::Prepared {
                    stream: prepared, ..
                } = &outcome
                {
                    if let Ok(mut m) = prepared_handles.lock() {
                        // Sessions ended by supersede/evict/expiry saw
                        // neither cancel nor release — drop their stale
                        // mappings so the map tracks live handles only.
                        m.retain(|_, h| *h == prepared.handle || registry.is_live(h));
                        m.insert(request_id.clone(), prepared.handle.clone());
                    }
                }
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
        self.stream_registry()?.release(&handle).map_err(seam_err)?;
        if let Ok(mut m) = self.prepared_handles.lock() {
            m.retain(|_, h| *h != handle);
        }
        Ok(())
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

    /// Dev-gate entry: register a session for a bare URL, skipping the
    /// guest `playback.resolve` (same convention as the Kotlin
    /// `devAttachFile`). Everything downstream of resolve is the real
    /// path — sparse store, pump, fetch-through, marks — so the seam
    /// gates can be exercised while the provider's resolve is
    /// unreachable. Re-mint is pinned to fail `Expired` unless
    /// `remintable` opts the session into re-minting the same source —
    /// the fixture URL is its own provider, letting the forced-cap
    /// gate exercise the real 403 → re-mint → resume path on-device.
    /// A one-hour expiry keeps it out of the measured window.
    ///
    /// # Errors
    /// [`StreamError::Unavailable`] when the seam is not configured;
    /// [`StreamError::Failed`] with the prepare's kind otherwise.
    pub fn dev_prepare_url(
        &self,
        url: String,
        mime: String,
        content_length: Option<u64>,
        remintable: bool,
    ) -> Result<PreparedStream, StreamError> {
        let expires_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| u64::try_from(d.as_millis()).ok())
            .map(|now| now + 3_600_000);
        let source = PreparedSource {
            source_ref: url.clone(),
            provider: "dev-url".to_string(),
            url,
            mime,
            itag: None,
            bitrate_kbps: None,
            content_length,
            expires_at_ms,
        };
        let remint: Arc<dyn Remint> = if remintable {
            Arc::new(DevRemint {
                source: Some(source.clone()),
            })
        } else {
            Arc::new(DevRemint { source: None })
        };
        let info = self
            .stream_registry()?
            .prepare_timed(source, remint, None)
            .map_err(seam_err)?;
        Ok(PreparedStream::from(info))
    }
}

/// Remint for [`PluginHost::dev_prepare_url`] sessions — a dev fixture
/// has no provider to re-resolve, so expiry is terminal unless the
/// caller pinned the source for re-mint (the fixture serving the same
/// URL stands in for a provider mint).
struct DevRemint {
    source: Option<PreparedSource>,
}

impl Remint for DevRemint {
    fn remint(
        &self,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<PreparedSource, auqw_stream::StreamError>>
                + Send,
        >,
    > {
        let source = self.source.clone();
        Box::pin(async move {
            match source {
                Some(source) => Ok(source),
                None => Err(auqw_stream::StreamError::Expired),
            }
        })
    }
}

impl PluginHost {
    fn stream_registry(&self) -> Result<&StreamRegistry, StreamError> {
        self.stream.as_deref().ok_or(StreamError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The re-mint payload carries the itag pin verbatim when the
    /// first resolve minted one, and omits the key entirely when it
    /// did not — a guest must never observe a null pin. The surface
    /// `prefer` hint and `access_token` ride verbatim and are likewise
    /// omitted when unset.
    #[test]
    fn remint_payload_carries_the_pin() {
        let prefer = Some(vec!["audio/webm".to_string(), "audio/mp4".to_string()]);
        let token = Some("tok".to_string());
        assert_eq!(
            remint_payload("vid", Some(140), &prefer, &token),
            json!({
                "source_ref": "vid",
                "pin_itag": 140,
                "prefer": ["audio/webm", "audio/mp4"],
                "access_token": "tok"
            })
        );
        assert_eq!(
            remint_payload("vid", None, &None, &None),
            json!({ "source_ref": "vid" })
        );
        let bare = remint_payload("vid", None, &None, &None);
        assert!(
            bare.get("pin_itag").is_none()
                && bare.get("prefer").is_none()
                && bare.get("access_token").is_none(),
            "no pin/prefer/token keys may be emitted when unset"
        );
    }
}
