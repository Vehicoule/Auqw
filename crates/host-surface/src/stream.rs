//! The streaming-seam surface of the host boundary.
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

use crate::PreparedSlot;
use auqw_stream::{PhaseMarks, PrepareInfo, PreparedSource, Remint, StreamRegistry};
use serde_json::{json, Value};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::{lock, resolve_resource_from, AttemptSummary, HostError, PluginHost};

/// A prepared stream session as reported to the player: the opaque
/// handle plus metadata. The signed URL never crosses this boundary.
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

/// Errors raised synchronously by the `stream_*` calls.
#[derive(Error, Debug)]
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
        "auth-required" => E::AuthRequired { message },
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
            let resource = resolve_resource_from(&value).map_err(|field| {
                auqw_stream::StreamError::InvalidResponse {
                    message: format!("remint resolve missing or invalid {field}"),
                }
            })?;
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
    let summary = AttemptSummary::from(attempt);
    let resource = match resolve_resource_from(value) {
        Err(field) => {
            return PrepareOutcome::Failed {
                kind: "invalid-response".to_string(),
                message: format!("resolve result missing or invalid {field}"),
                attempt: summary,
            };
        }
        Ok(resource) => resource,
    };
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

impl PluginHost {
    /// Resolve `source_ref` and register the result as a prepared
    /// stream session (bounded speculative head fill). The outcome —
    /// including the opaque stream handle — arrives through `deliver`.
    /// `request_id` is caller-minted and passed back through `deliver`.
    ///
    /// # Errors
    /// [`HostError::UnknownPlugin`] if `plugin_id` was never loaded;
    /// [`HostError::Runtime`] when the seam is not configured.
    pub fn start_prepare<F, Fut>(
        &self,
        plugin_id: String,
        source_ref: String,
        request_id: String,
        deliver: F,
    ) -> Result<(), HostError>
    where
        F: FnOnce(String, PrepareOutcome) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
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
        let cancels = Arc::clone(&self.cancels);
        let cancelled_requests = Arc::clone(&self.cancelled_requests);
        let prepared_delivery = Arc::clone(&self.prepared_delivery);
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
            request_id,
            // The delivery registers the `prepared_handles` slot that
            // owns this id until release — freeing `cancels` first
            // would open a re-admission gap before the slot lands.
            true,
            move |request_id, invocation| async move {
                let (result, attempt) = invocation.into_parts();
                let mut summary = AttemptSummary::from(&attempt);
                // The summary must join by the caller-facing id —
                // the inner `invoke-N` never leaves this closure.
                summary.request_id = request_id.clone();
                // `stream` is moved into the blocking closure below —
                // keep a clone for the bookkeeping prune.
                let registry = Arc::clone(&stream);
                // Counts this delivery's window for `cancel` — see
                // `PrepareDelivery`. Held until the post-callback flip.
                let mut delivery_ticket = None;
                let mut outcome = match result {
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
                                attempt: summary.clone(),
                            },
                        }
                    }
                    Err(e) => PrepareOutcome::Failed {
                        kind: e.kind().to_string(),
                        message: e.to_string(),
                        attempt: summary.clone(),
                    },
                };
                // A cancel that outran both `cancels` and the handle
                // map left a tombstone: the session just produced is
                // orphaned-on-arrival — abandon it instead of handing
                // out a live handle nobody will ever release.
                let mut abandoned = None;
                if let PrepareOutcome::Prepared {
                    stream: prepared, ..
                } = &outcome
                {
                    let tombstoned = cancelled_requests
                        .lock()
                        .map(|mut m| m.remove(&request_id).is_some())
                        .unwrap_or(false);
                    if tombstoned {
                        let _ = registry.cancel_if_unattached(&prepared.handle);
                        deliver(
                            request_id,
                            PrepareOutcome::Failed {
                                kind: "cancelled".to_string(),
                                message: "prepare cancelled".to_string(),
                                attempt: summary.clone(),
                            },
                        )
                        .await;
                        return;
                    }
                    if let Ok(mut m) = prepared_handles.lock() {
                        // Sessions ended by supersede/evict/expiry saw
                        // neither cancel nor release — drop their stale
                        // mappings so the map tracks live handles only.
                        m.retain(|_, s| s.handle == prepared.handle || registry.is_live(&s.handle));
                        // A `cancel` that landed while the resolve was
                        // completing already flipped the token —
                        // deciding under this lock keeps the paths
                        // exclusive: a later `cancel` sees the recorded
                        // handle and abandons via `prepared_handles`,
                        // while this one abandons directly instead of
                        // delivering a live `Prepared`. The insert IS
                        // the delivery commit — `delivered: false`
                        // tells `cancel` the outcome is committed but
                        // not yet on the wire, so it consumes the slot
                        // without releasing the handle out from under
                        // the listener.
                        let was_cancelled = cancels
                            .lock()
                            .ok()
                            .and_then(|c| c.get(&request_id).map(|r| r.token.is_cancelled()))
                            .unwrap_or(false);
                        if was_cancelled {
                            abandoned = Some(prepared.handle.clone());
                        } else {
                            // `track` precedes `insert`: a `Pending`
                            // slot always implies an in-flight count
                            // for this request, so a `cancel` that
                            // sees one waits for this window to close.
                            delivery_ticket = Some(prepared_delivery.track(request_id.clone()));
                            m.insert(
                                request_id.clone(),
                                PreparedSlot {
                                    handle: prepared.handle.clone(),
                                    delivered: false,
                                },
                            );
                        }
                    }
                } else if let Ok(mut m) = cancelled_requests.lock() {
                    // A tombstone for a request that failed on its own
                    // is spent — don't let it poison a future request
                    // that happens to reuse the id space.
                    m.remove(&request_id);
                }
                if let Some(handle) = abandoned {
                    let _ = registry.cancel_if_unattached(&handle);
                    outcome = match outcome {
                        PrepareOutcome::Prepared { attempt, .. } => PrepareOutcome::Failed {
                            kind: "cancelled".to_string(),
                            message: "cancelled".to_string(),
                            attempt,
                        },
                        other => other,
                    };
                }
                deliver(request_id.clone(), outcome).await;
                // The outcome is on the wire: flip `delivered` so a
                // later `cancel` may release an unattached handle. A
                // `cancel` parked mid-delivery stays asleep until the
                // ticket drops below — `Prepared` always precedes its
                // own teardown.
                if delivery_ticket.is_some() {
                    if let Ok(mut m) = prepared_handles.lock() {
                        if let Some(slot) = m.get_mut(&request_id) {
                            slot.delivered = true;
                        }
                    }
                    drop(delivery_ticket);
                }
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

    /// Blocking read — callers must be non-runtime threads (JNI/DataSource
    /// on mobile, the libuv pool on Node); parking a runtime worker is a
    /// bug. Empty bytes = EOF. Bounded by the seam's read deadline;
    /// terminal transitions wake into their typed error.
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
            m.retain(|_, s| s.handle != handle);
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
        // `source_ref` persists into the `{handle}.json` sidecar and
        // shows in `{:?}` — a raw URL (possibly signed) can't be it.
        // Hash the URL so coalescing still dedupes the same fixture.
        let ref_hash = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            url.hash(&mut h);
            format!("dev-url:{:016x}", h.finish())
        };
        let source = PreparedSource {
            source_ref: ref_hash,
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
