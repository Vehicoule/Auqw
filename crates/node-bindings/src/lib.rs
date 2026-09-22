//! napi-rs bindings over `auqw-host-surface` for the Electron
//! utility process.
//!
//! Thin Node-API shim: all behavior lives in `auqw-host-surface`
//! (shared with `mobile-bindings`); this crate maps its outcomes onto
//! JS objects/promises. `start_*` calls return promises that settle
//! once per request; `requestId` is caller-minted so `cancel` can
//! land before the promise resolves. `streamRead` is deliberately a
//! promise — the seam's blocking read parks a runtime worker, never
//! the libuv main thread. The URL inside `ResolvedResource.url` is a
//! real signed stream URL — it must never be logged at any layer.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use auqw_host_surface as surface;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::sync::oneshot;

/// Host-side budgets the app may tune; all other dimensions take
/// `Budgets::default()`.
#[napi(object)]
pub struct HostConfig {
    /// Fuel granted to each guest entry.
    #[napi(js_name = "fuelPerEntry")]
    pub fuel_per_entry: f64,
    /// Total fuel across one invocation.
    #[napi(js_name = "fuelTotal")]
    pub fuel_total: f64,
    /// Base URL of a bgutil-compatible PO-token service
    /// (`POST {provider}/get_pot`). `None` leaves resolves anonymous.
    #[napi(js_name = "potProviderUrl")]
    pub pot_provider_url: Option<String>,
    /// Path of the on-disk KV store the native shell supplies;
    /// `None` keeps plugin state volatile.
    #[napi(js_name = "statePath")]
    pub state_path: Option<String>,
    /// Directory for the sparse stream cache; `None` disables the
    /// streaming seam — every `stream*` call then fails
    /// `Unavailable` and `startPrepare` rejects synchronously.
    #[napi(js_name = "streamPath")]
    pub stream_path: Option<String>,
    /// Container preference order sent on `playback.resolve` — the
    /// surface's `prefer` hint (webm-first on desktop). `None` leaves
    /// the guest's own default order.
    #[napi(js_name = "prefer")]
    pub prefer: Option<Vec<String>>,
    /// Initial OAuth access token for session-trust `Authorization:
    /// Bearer` on InnerTube calls. `None` starts anonymous; update it
    /// later with `setAuthToken`. Never logged. Values outside the
    /// contract (`minLength: 1`, `maxLength: 8192`) are treated as
    /// unset.
    #[napi(js_name = "authToken")]
    pub auth_token: Option<String>,
}

impl From<HostConfig> for surface::HostConfig {
    fn from(c: HostConfig) -> Self {
        Self {
            fuel_per_entry: c.fuel_per_entry as u64,
            fuel_total: c.fuel_total as u64,
            pot_provider_url: c.pot_provider_url,
            state_path: c.state_path,
            stream_path: c.stream_path,
            prefer: c.prefer,
            auth_token: c.auth_token,
        }
    }
}

/// One HTTP call from the attempt trace. `url` is already stripped of
/// query and fragment by the host — the signed parameters never cross
/// this boundary.
#[napi(object)]
pub struct HttpTraceSummary {
    /// HTTP method.
    #[napi(js_name = "method")]
    pub method: String,
    /// URL without query or fragment.
    #[napi(js_name = "url")]
    pub url: String,
    /// Response status when one was received.
    #[napi(js_name = "status")]
    pub status: Option<u16>,
    /// Body bytes received.
    #[napi(js_name = "bytes")]
    pub bytes: f64,
    /// Round-trip milliseconds.
    #[napi(js_name = "elapsedMs")]
    pub elapsed_ms: f64,
}

impl From<surface::HttpTraceSummary> for HttpTraceSummary {
    fn from(s: surface::HttpTraceSummary) -> Self {
        Self {
            method: s.method,
            url: s.url,
            status: s.status,
            bytes: s.bytes as f64,
            elapsed_ms: s.elapsed_ms as f64,
        }
    }
}

/// One guest `log` entry, already redacted by the host.
#[napi(object)]
pub struct GuestLogSummary {
    /// `debug` | `info` | `warn` | `error`.
    #[napi(js_name = "level")]
    pub level: String,
    /// Redacted message text.
    #[napi(js_name = "message")]
    pub message: String,
}

impl From<surface::GuestLogSummary> for GuestLogSummary {
    fn from(s: surface::GuestLogSummary) -> Self {
        Self {
            level: s.level,
            message: s.message,
        }
    }
}

/// Per-invocation accounting for diagnostics.
#[napi(object)]
pub struct AttemptSummary {
    /// Caller-facing request id.
    #[napi(js_name = "requestId")]
    pub request_id: String,
    /// `handle` steps executed.
    #[napi(js_name = "steps")]
    pub steps: u32,
    /// HTTP requests performed for the guest.
    #[napi(js_name = "httpCalls")]
    pub http_calls: u32,
    /// HTTP bytes moved, in and out.
    #[napi(js_name = "bytes")]
    pub bytes: f64,
    /// Fuel consumed across all guest entries.
    #[napi(js_name = "fuelUsed")]
    pub fuel_used: f64,
    /// Wall-clock elapsed.
    #[napi(js_name = "elapsedMs")]
    pub elapsed_ms: f64,
    /// Sanitized HTTP trace entries.
    #[napi(js_name = "httpTrace")]
    pub http_trace: Vec<HttpTraceSummary>,
    /// Guest log entries.
    #[napi(js_name = "guestLog")]
    pub guest_log: Vec<GuestLogSummary>,
}

impl From<surface::AttemptSummary> for AttemptSummary {
    fn from(s: surface::AttemptSummary) -> Self {
        Self {
            request_id: s.request_id,
            steps: s.steps,
            http_calls: s.http_calls,
            bytes: s.bytes as f64,
            fuel_used: s.fuel_used as f64,
            elapsed_ms: s.elapsed_ms as f64,
            http_trace: s.http_trace.into_iter().map(Into::into).collect(),
            guest_log: s.guest_log.into_iter().map(Into::into).collect(),
        }
    }
}

/// A resolved stream. `url` is signed — never log it.
#[napi(object)]
pub struct ResolvedResource {
    /// Direct stream URL (signed; redact everywhere).
    #[napi(js_name = "url")]
    pub url: String,
    /// MIME type, e.g. `audio/mp4`.
    #[napi(js_name = "mime")]
    pub mime: String,
    /// Bitrate in kbps when the guest reported one.
    #[napi(js_name = "bitrateKbps")]
    pub bitrate_kbps: Option<u32>,
    /// `expire=` converted to epoch milliseconds.
    #[napi(js_name = "expiresAtMs")]
    pub expires_at_ms: Option<f64>,
    /// Ladder rung that produced the URL.
    #[napi(js_name = "client")]
    pub client: String,
    /// Reported `contentLength` of the picked format in bytes.
    #[napi(js_name = "contentLength")]
    pub content_length: Option<f64>,
    /// Provider format itag when the guest reported one.
    #[napi(js_name = "itag")]
    pub itag: Option<u32>,
}

impl From<surface::ResolvedResource> for ResolvedResource {
    fn from(r: surface::ResolvedResource) -> Self {
        Self {
            url: r.url,
            mime: r.mime,
            bitrate_kbps: r.bitrate_kbps,
            expires_at_ms: r.expires_at_ms.map(|v| v as f64),
            client: r.client,
            content_length: r.content_length.map(|v| v as f64),
            itag: r.itag,
        }
    }
}

/// Terminal outcome of one `startResolve` invocation — a tagged
/// union: `type: "resolved"` carries `resource`; `type: "failed"`
/// carries `kind` + `message` (`attempt` is always present).
#[napi(object)]
pub struct ResolveOutcome {
    /// `resolved` | `failed`.
    #[napi(js_name = "type")]
    pub kind_tag: String,
    /// The stream, when `resolved`.
    #[napi(js_name = "resource")]
    pub resource: Option<ResolvedResource>,
    /// Taxonomy kind (`no-result`, `cancelled`, ...), when `failed`.
    #[napi(js_name = "kind")]
    pub kind: Option<String>,
    /// Human-readable detail (never contains the URL), when `failed`.
    #[napi(js_name = "message")]
    pub message: Option<String>,
    /// Invocation accounting.
    #[napi(js_name = "attempt")]
    pub attempt: AttemptSummary,
}

impl From<surface::ResolveOutcome> for ResolveOutcome {
    fn from(o: surface::ResolveOutcome) -> Self {
        match o {
            surface::ResolveOutcome::Resolved { resource, attempt } => Self {
                kind_tag: "resolved".to_string(),
                resource: Some(resource.into()),
                kind: None,
                message: None,
                attempt: attempt.into(),
            },
            surface::ResolveOutcome::Failed {
                kind,
                message,
                attempt,
            } => Self {
                kind_tag: "failed".to_string(),
                resource: None,
                kind: Some(kind),
                message: Some(message),
                attempt: attempt.into(),
            },
        }
    }
}

/// Terminal outcome of one `startRequest` invocation. The result is
/// raw JSON — the typed `ResolveOutcome` remains for resolve callers.
#[napi(object)]
pub struct RequestOutcome {
    /// `succeeded` | `failed`.
    #[napi(js_name = "type")]
    pub kind_tag: String,
    /// `done.result` serialized to JSON, when `succeeded`.
    #[napi(js_name = "resultJson")]
    pub result_json: Option<String>,
    /// Taxonomy kind, when `failed`.
    #[napi(js_name = "kind")]
    pub kind: Option<String>,
    /// Human-readable detail (never contains signed URLs), when
    /// `failed`.
    #[napi(js_name = "message")]
    pub message: Option<String>,
    /// Invocation accounting.
    #[napi(js_name = "attempt")]
    pub attempt: AttemptSummary,
}

impl From<surface::RequestOutcome> for RequestOutcome {
    fn from(o: surface::RequestOutcome) -> Self {
        match o {
            surface::RequestOutcome::Succeeded {
                result_json,
                attempt,
            } => Self {
                kind_tag: "succeeded".to_string(),
                result_json: Some(result_json),
                kind: None,
                message: None,
                attempt: attempt.into(),
            },
            surface::RequestOutcome::Failed {
                kind,
                message,
                attempt,
            } => Self {
                kind_tag: "failed".to_string(),
                result_json: None,
                kind: Some(kind),
                message: Some(message),
                attempt: attempt.into(),
            },
        }
    }
}

/// Result of the fuel-gate measurement (spin conformance guest).
#[napi(object)]
pub struct SpinReport {
    /// Wall-clock time until the trap.
    #[napi(js_name = "elapsedMs")]
    pub elapsed_ms: f64,
    /// Fuel consumed before the trap.
    #[napi(js_name = "fuelUsed")]
    pub fuel_used: f64,
    /// Terminal error kind (`budget-exceeded` expected).
    #[napi(js_name = "kind")]
    pub kind: String,
}

impl From<surface::SpinReport> for SpinReport {
    fn from(r: surface::SpinReport) -> Self {
        Self {
            elapsed_ms: r.elapsed_ms as f64,
            fuel_used: r.fuel_used as f64,
            kind: r.kind,
        }
    }
}

/// A prepared stream session as reported to the player: the opaque
/// handle plus metadata. The signed URL never crosses this boundary.
#[napi(object)]
pub struct PreparedStream {
    /// Opaque session handle for `streamOpen`/`streamRead`/...
    #[napi(js_name = "handle")]
    pub handle: String,
    /// MIME type; pinned across re-mints.
    #[napi(js_name = "mime")]
    pub mime: String,
    /// Format itag when reported.
    #[napi(js_name = "itag")]
    pub itag: Option<u32>,
    /// Bitrate hint in kbps.
    #[napi(js_name = "bitrateKbps")]
    pub bitrate_kbps: Option<u32>,
    /// Reported length in bytes, when known.
    #[napi(js_name = "contentLength")]
    pub content_length: Option<f64>,
    /// URL expiry, epoch ms.
    #[napi(js_name = "expiresAtMs")]
    pub expires_at_ms: Option<f64>,
}

impl From<surface::PreparedStream> for PreparedStream {
    fn from(s: surface::PreparedStream) -> Self {
        Self {
            handle: s.handle,
            mime: s.mime,
            itag: s.itag,
            bitrate_kbps: s.bitrate_kbps,
            content_length: s.content_length.map(|v| v as f64),
            expires_at_ms: s.expires_at_ms.map(|v| v as f64),
        }
    }
}

/// Terminal outcome of one `startPrepare` invocation.
#[napi(object)]
pub struct PrepareOutcome {
    /// `prepared` | `failed`.
    #[napi(js_name = "type")]
    pub kind_tag: String,
    /// The prepared session handle + metadata, when `prepared`.
    #[napi(js_name = "stream")]
    pub stream: Option<PreparedStream>,
    /// Handles this prepare superseded or pruned — the caller's
    /// handle routing must drop these so a dead session's entry can
    /// never serve a later attach.
    #[napi(js_name = "superseded")]
    pub superseded: Vec<String>,
    /// Taxonomy kind, when `failed`.
    #[napi(js_name = "kind")]
    pub kind: Option<String>,
    /// Human-readable detail (never contains the URL), when `failed`.
    #[napi(js_name = "message")]
    pub message: Option<String>,
    /// Invocation accounting for the resolve.
    #[napi(js_name = "attempt")]
    pub attempt: AttemptSummary,
}

impl From<surface::PrepareOutcome> for PrepareOutcome {
    fn from(o: surface::PrepareOutcome) -> Self {
        match o {
            surface::PrepareOutcome::Prepared {
                stream,
                superseded,
                attempt,
            } => Self {
                kind_tag: "prepared".to_string(),
                stream: Some(stream.into()),
                superseded,
                kind: None,
                message: None,
                attempt: attempt.into(),
            },
            surface::PrepareOutcome::Failed {
                kind,
                message,
                attempt,
            } => Self {
                kind_tag: "failed".to_string(),
                stream: None,
                superseded: Vec::new(),
                kind: Some(kind),
                message: Some(message),
                attempt: attempt.into(),
            },
        }
    }
}

/// Lifecycle marks for one stream session: epoch-ms timestamps plus
/// durations, for joining intent → prepared → attached → rendered.
#[napi(object)]
pub struct StreamPhaseMarks {
    /// Epoch ms when `prepare` registered the session.
    #[napi(js_name = "prepareStartedMs")]
    pub prepare_started_ms: f64,
    /// Duration of the minting `playback.resolve`, when known.
    #[napi(js_name = "resolveMs")]
    pub resolve_ms: Option<f64>,
    /// Duration of the most recent re-mint, when one ran.
    #[napi(js_name = "mintMs")]
    pub mint_ms: Option<f64>,
    /// Epoch ms when the first byte landed.
    #[napi(js_name = "firstByteMs")]
    pub first_byte_ms: Option<f64>,
    /// Epoch ms when the head-fill bound was covered.
    #[napi(js_name = "headReadyMs")]
    pub head_ready_ms: Option<f64>,
    /// Epoch ms of the first attach.
    #[napi(js_name = "attachMs")]
    pub attach_ms: Option<f64>,
}

impl From<surface::StreamPhaseMarks> for StreamPhaseMarks {
    fn from(m: surface::StreamPhaseMarks) -> Self {
        Self {
            prepare_started_ms: m.prepare_started_ms as f64,
            resolve_ms: m.resolve_ms.map(|v| v as f64),
            mint_ms: m.mint_ms.map(|v| v as f64),
            first_byte_ms: m.first_byte_ms.map(|v| v as f64),
            head_ready_ms: m.head_ready_ms.map(|v| v as f64),
            attach_ms: m.attach_ms.map(|v| v as f64),
        }
    }
}

fn host_err(e: surface::HostError) -> Error {
    Error::from_reason(e.to_string())
}

fn stream_err(e: surface::StreamError) -> Error {
    Error::from_reason(e.to_string())
}

/// Await one outcome delivered through a oneshot: `spawn` registers
/// the deliver closure synchronously (so synchronous rejections —
/// unknown plugin, seam unavailable, duplicate id — still throw),
/// then the promise settles with whatever the closure sent.
async fn outcome<T, F>(spawn: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(oneshot::Sender<T>) -> std::result::Result<(), surface::HostError>,
{
    let (tx, rx) = oneshot::channel();
    spawn(tx).map_err(host_err)?;
    rx.await
        .map_err(|_| Error::from_reason("host dropped request"))
}

/// The plugin host object exposed to the utility process. Request
/// ids are caller-minted — the caller needs the id for `cancel`
/// before the outcome promise settles; the surface rejects an id
/// that is still live with `RequestInFlight`.
#[napi(js_name = "PluginHost")]
pub struct JsPluginHost {
    inner: Arc<surface::PluginHost>,
    counter: AtomicU64,
}

impl JsPluginHost {
    fn mint_request_id(&self) -> String {
        format!("req-{}", self.counter.fetch_add(1, Ordering::Relaxed))
    }
}

#[napi]
impl JsPluginHost {
    /// Create a host with a two-worker tokio runtime.
    #[napi(constructor)]
    pub fn new(config: HostConfig) -> Result<Self> {
        let inner = surface::PluginHost::new(config.into()).map_err(host_err)?;
        Ok(Self {
            inner: Arc::new(inner),
            counter: AtomicU64::new(0),
        })
    }

    /// Mint a request id for a call the caller will `cancel` —
    /// `startResolve`/`startRequest`/`startPrepare` also accept any
    /// caller-supplied id when this convenience isn't used.
    #[napi(js_name = "mintRequestId")]
    pub fn mint_request_id_export(&self) -> String {
        self.mint_request_id()
    }

    /// Set or clear the OAuth access token merged as `access_token`
    /// into every session-trust payload (`Authorization: Bearer` on
    /// InnerTube calls). Prepared sessions read the same slot at
    /// re-mint, so a refreshed token applies to in-flight playback
    /// recovery. Never logged. An off-contract value (empty or over
    /// the contract `maxLength`) clears the slot.
    #[napi(js_name = "setAuthToken")]
    pub fn set_auth_token(&self, token: Option<String>) {
        self.inner.set_auth_token(token);
    }

    /// Validate and register a plugin artifact. Returns the manifest
    /// id.
    #[napi(js_name = "loadPlugin")]
    pub fn load_plugin(&self, wasm: Buffer, manifest_json: String) -> Result<String> {
        self.inner
            .load_plugin(wasm.to_vec(), manifest_json)
            .map_err(host_err)
    }

    /// Start a `playback.resolve` invocation on the runtime. The
    /// returned promise settles exactly once; `requestId` is echoed
    /// back on `attempt.requestId`.
    #[napi(js_name = "startResolve")]
    pub async fn start_resolve(
        &self,
        plugin_id: String,
        source_ref: String,
        request_id: String,
    ) -> Result<ResolveOutcome> {
        let inner = Arc::clone(&self.inner);
        outcome(move |tx| {
            inner.start_resolve(
                plugin_id,
                source_ref,
                request_id,
                move |_id, o| async move {
                    let _ = tx.send(o.into());
                },
            )
        })
        .await
    }

    /// Start any declared capability with a JSON object payload. The
    /// outcome carries the raw `done.result` JSON.
    #[napi(js_name = "startRequest")]
    pub async fn start_request(
        &self,
        plugin_id: String,
        capability: String,
        payload_json: String,
        request_id: String,
    ) -> Result<RequestOutcome> {
        let inner = Arc::clone(&self.inner);
        outcome(move |tx| {
            inner.start_request(
                plugin_id,
                capability,
                payload_json,
                request_id,
                move |_id, o| async move {
                    let _ = tx.send(o.into());
                },
            )
        })
        .await
    }

    /// Resolve `source_ref` and register the result as a prepared
    /// stream session (bounded speculative head fill). The outcome —
    /// including the opaque stream handle — resolves the promise.
    #[napi(js_name = "startPrepare")]
    pub async fn start_prepare(
        &self,
        plugin_id: String,
        source_ref: String,
        request_id: String,
    ) -> Result<PrepareOutcome> {
        let inner = Arc::clone(&self.inner);
        outcome(move |tx| {
            inner.start_prepare(
                plugin_id,
                source_ref,
                request_id,
                move |_id, o| async move {
                    let _ = tx.send(o.into());
                },
            )
        })
        .await
    }

    /// Cancel an in-flight request. Unknown ids are a no-op except a
    /// brief tombstone (see the surface docs); a cancel landing after
    /// `prepared` abandons the produced session while it is still
    /// unattached.
    #[napi(js_name = "cancel")]
    pub fn cancel(&self, request_id: String) {
        self.inner.cancel(request_id);
    }

    /// Run the spin conformance guest to measure the fuel trap
    /// latency on-device. Blocks a libuv worker on the runtime.
    #[napi(js_name = "runSpin")]
    pub async fn run_spin(&self, wasm: Buffer, manifest_json: String) -> Result<SpinReport> {
        let inner = Arc::clone(&self.inner);
        let wasm = wasm.to_vec();
        tokio::task::spawn_blocking(move || {
            inner
                .run_spin(wasm, manifest_json)
                .map(SpinReport::from)
                .map_err(host_err)
        })
        .await
        .map_err(|_| Error::from_reason("spin worker panicked"))?
    }

    /// Attach a consumer at `position` (session open). Returns
    /// `content_length - position` when the stream total is known.
    #[napi(js_name = "streamOpen")]
    pub fn stream_open(&self, handle: String, position: f64) -> Result<Option<f64>> {
        self.inner
            .stream_open(handle, position as u64)
            .map(|v| v.map(|n| n as f64))
            .map_err(stream_err)
    }

    /// Blocking read — deliberately a promise so the seam parks a
    /// runtime worker, never the libuv main thread. Empty buffer =
    /// EOF. Bounded by the seam's read deadline; terminal transitions
    /// reject with their typed error.
    #[napi(js_name = "streamRead")]
    pub async fn stream_read(&self, handle: String, position: f64, max_len: f64) -> Result<Buffer> {
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            inner
                .stream_read(handle, position as u64, max_len as u64)
                .map(Buffer::from)
                .map_err(stream_err)
        })
        .await
        .map_err(|_| Error::from_reason("stream read worker panicked"))?
    }

    /// Session close: detaches the consumer; the session stays live
    /// for re-attach.
    #[napi(js_name = "streamClose")]
    pub fn stream_close(&self, handle: String) -> Result<()> {
        self.inner.stream_close(handle).map_err(stream_err)
    }

    /// Terminal release: parked readers unwind `released`, in-flight
    /// work aborts, the partial file is evicted. Idempotent.
    #[napi(js_name = "streamRelease")]
    pub fn stream_release(&self, handle: String) -> Result<()> {
        self.inner.stream_release(handle).map_err(stream_err)
    }

    /// The session's lifecycle marks — available even after terminal
    /// states.
    #[napi(js_name = "streamPhaseMarks")]
    pub fn stream_phase_marks(&self, handle: String) -> Result<StreamPhaseMarks> {
        self.inner
            .stream_phase_marks(handle)
            .map(StreamPhaseMarks::from)
            .map_err(stream_err)
    }

    /// Dev-gate entry: register a session for a bare URL, skipping
    /// the guest `playback.resolve` (same convention as the mobile
    /// `devAttachFile`). Everything downstream of resolve is the real
    /// path — sparse store, pump, fetch-through, marks — so seam
    /// gates can be exercised while the provider's resolve is
    /// unreachable. `remintable` opts the session into re-minting the
    /// same source for the forced-cap gate.
    #[napi(js_name = "devPrepareUrl")]
    pub fn dev_prepare_url(
        &self,
        url: String,
        mime: String,
        content_length: Option<f64>,
        remintable: bool,
    ) -> Result<PreparedStream> {
        self.inner
            .dev_prepare_url(url, mime, content_length.map(|v| v as u64), remintable)
            .map(PreparedStream::from)
            .map_err(stream_err)
    }
}
