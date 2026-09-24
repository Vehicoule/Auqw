//! napi-rs bindings over `auqw-host-surface` for the Electron
//! utility process.
//!
//! Thin Node-API shim: all behavior lives in `auqw-host-surface`
//! (shared with `mobile-bindings`); this crate maps its outcomes onto
//! JS objects/promises. `start_*` calls return promises that settle
//! once per request; `requestId` is caller-minted so `cancel` can
//! land before the promise resolves. `streamRead` is deliberately a
//! promise — the seam's blocking read parks a runtime worker, never
//! the libuv main thread; it parks a `spawn_blocking` worker instead.
//! The URL inside `ResolvedResource.url` is a
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

impl TryFrom<HostConfig> for surface::HostConfig {
    type Error = Error;

    fn try_from(c: HostConfig) -> Result<Self> {
        Ok(Self {
            // Fuel of zero starves every guest entry — a budget is
            // meaningful only when positive, and a JS number must be
            // a safe integer before it can be a u64.
            fuel_per_entry: u64_field(c.fuel_per_entry, "fuelPerEntry", 1)?,
            fuel_total: u64_field(c.fuel_total, "fuelTotal", 1)?,
            pot_provider_url: c.pot_provider_url,
            state_path: c.state_path,
            stream_path: c.stream_path,
            prefer: c.prefer,
            auth_token: c.auth_token,
        })
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

impl TryFrom<surface::HttpTraceSummary> for HttpTraceSummary {
    type Error = Error;

    fn try_from(s: surface::HttpTraceSummary) -> Result<Self> {
        Ok(Self {
            method: s.method,
            url: s.url,
            status: s.status,
            bytes: u64_out(s.bytes, "bytes")?,
            elapsed_ms: u64_out(s.elapsed_ms, "elapsedMs")?,
        })
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

impl TryFrom<surface::AttemptSummary> for AttemptSummary {
    type Error = Error;

    fn try_from(s: surface::AttemptSummary) -> Result<Self> {
        Ok(Self {
            request_id: s.request_id,
            steps: s.steps,
            http_calls: s.http_calls,
            bytes: u64_out(s.bytes, "bytes")?,
            fuel_used: u64_out(s.fuel_used, "fuelUsed")?,
            elapsed_ms: u64_out(s.elapsed_ms, "elapsedMs")?,
            http_trace: s
                .http_trace
                .into_iter()
                .map(TryFrom::try_from)
                .collect::<Result<Vec<_>>>()?,
            guest_log: s.guest_log.into_iter().map(Into::into).collect(),
        })
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

impl TryFrom<surface::ResolvedResource> for ResolvedResource {
    type Error = Error;

    fn try_from(r: surface::ResolvedResource) -> Result<Self> {
        Ok(Self {
            url: r.url,
            mime: r.mime,
            bitrate_kbps: r.bitrate_kbps,
            expires_at_ms: opt_u64_out(r.expires_at_ms, "expiresAtMs")?,
            client: r.client,
            content_length: opt_u64_out(r.content_length, "contentLength")?,
            itag: r.itag,
        })
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

impl TryFrom<surface::ResolveOutcome> for ResolveOutcome {
    type Error = Error;

    fn try_from(o: surface::ResolveOutcome) -> Result<Self> {
        Ok(match o {
            surface::ResolveOutcome::Resolved { resource, attempt } => Self {
                kind_tag: "resolved".to_string(),
                resource: Some(resource.try_into()?),
                kind: None,
                message: None,
                attempt: attempt.try_into()?,
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
                attempt: attempt.try_into()?,
            },
        })
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

impl TryFrom<surface::RequestOutcome> for RequestOutcome {
    type Error = Error;

    fn try_from(o: surface::RequestOutcome) -> Result<Self> {
        Ok(match o {
            surface::RequestOutcome::Succeeded {
                result_json,
                attempt,
            } => Self {
                kind_tag: "succeeded".to_string(),
                result_json: Some(result_json),
                kind: None,
                message: None,
                attempt: attempt.try_into()?,
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
                attempt: attempt.try_into()?,
            },
        })
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

impl TryFrom<surface::SpinReport> for SpinReport {
    type Error = Error;

    fn try_from(r: surface::SpinReport) -> Result<Self> {
        Ok(Self {
            elapsed_ms: u64_out(r.elapsed_ms, "elapsedMs")?,
            fuel_used: u64_out(r.fuel_used, "fuelUsed")?,
            kind: r.kind,
        })
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

impl TryFrom<surface::PreparedStream> for PreparedStream {
    type Error = Error;

    fn try_from(s: surface::PreparedStream) -> Result<Self> {
        Ok(Self {
            handle: s.handle,
            mime: s.mime,
            itag: s.itag,
            bitrate_kbps: s.bitrate_kbps,
            content_length: opt_u64_out(s.content_length, "contentLength")?,
            expires_at_ms: opt_u64_out(s.expires_at_ms, "expiresAtMs")?,
        })
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

impl TryFrom<surface::PrepareOutcome> for PrepareOutcome {
    type Error = Error;

    fn try_from(o: surface::PrepareOutcome) -> Result<Self> {
        Ok(match o {
            surface::PrepareOutcome::Prepared {
                stream,
                superseded,
                attempt,
            } => Self {
                kind_tag: "prepared".to_string(),
                stream: Some(stream.try_into()?),
                superseded,
                kind: None,
                message: None,
                attempt: attempt.try_into()?,
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
                attempt: attempt.try_into()?,
            },
        })
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

impl TryFrom<surface::StreamPhaseMarks> for StreamPhaseMarks {
    type Error = Error;

    fn try_from(m: surface::StreamPhaseMarks) -> Result<Self> {
        Ok(Self {
            prepare_started_ms: u64_out(m.prepare_started_ms, "prepareStartedMs")?,
            resolve_ms: opt_u64_out(m.resolve_ms, "resolveMs")?,
            mint_ms: opt_u64_out(m.mint_ms, "mintMs")?,
            first_byte_ms: opt_u64_out(m.first_byte_ms, "firstByteMs")?,
            head_ready_ms: opt_u64_out(m.head_ready_ms, "headReadyMs")?,
            attach_ms: opt_u64_out(m.attach_ms, "attachMs")?,
        })
    }
}

/// Machine-readable boundary rejection. napi's `Status` is a fixed
/// enum — the taxonomy slug and the variant's fields can't ride in
/// `code`, so they go in `cause`: `err.cause` is a nested `Error`
/// whose `message` is the JSON `{"code": slug, ...fields}`. Callers
/// that need to distinguish failure kinds read it instead of parsing
/// prose; `err.code` stays the napi status (`InvalidArg` for boundary
/// validation, `GenericFailure` otherwise) and `err.message` the
/// human-readable detail.
fn typed_err(code: &str, reason: String, fields: serde_json::Value) -> Error {
    let mut payload = match fields {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    payload.insert("code".to_string(), serde_json::json!(code));
    let mut e = Error::new(Status::GenericFailure, reason);
    e.set_cause(Error::new(
        Status::GenericFailure,
        serde_json::Value::Object(payload).to_string(),
    ));
    e
}

/// Rejection for a number that can't be the field's u64 — non-finite,
/// fractional, negative, or past the JS safe-integer bound (which is
/// stricter than `u64::MAX`, so it covers both).
fn invalid_arg(field: &str, detail: String) -> Error {
    let mut e = typed_err(
        "invalid-argument",
        format!("{field}: {detail}"),
        serde_json::json!({"field": field, "detail": detail}),
    );
    e.status = Status::InvalidArg;
    e
}

/// Validate a JS number as an integer in `[min, 2^53-1]` before the
/// u64 cast — `as` saturates `NaN`/negatives to 0 and truncates
/// fractions, which would silently masquerade as EOF, offset zero,
/// or a zero budget.
fn u64_field(value: f64, field: &str, min: u64) -> Result<u64> {
    if !value.is_finite()
        || value.fract() != 0.0
        || value < min as f64
        || value > 9_007_199_254_740_991.0
    {
        return Err(invalid_arg(
            field,
            format!("expected an integer in [{min}, 2^53-1], got {value}"),
        ));
    }
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    Ok(value as u64)
}

/// Validate a host-side `u64` before it becomes an `f64`: the JS
/// safe-integer bound is the widest exact integer JS has, so a value
/// past it can't cross the boundary without silent rounding. That is
/// a malformed host result, not a caller bug — the conversion
/// typed-fails `invalid-response`.
fn u64_out(v: u64, field: &str) -> Result<f64> {
    if v > 9_007_199_254_740_991 {
        return Err(typed_err(
            "invalid-response",
            format!("outbound {field} {v} exceeds the JS safe-integer bound"),
            serde_json::json!({"field": field, "value": v}),
        ));
    }
    Ok(v as f64)
}

fn opt_u64_out(v: Option<u64>, field: &str) -> Result<Option<f64>> {
    v.map(|n| u64_out(n, field)).transpose()
}

fn host_err(e: surface::HostError) -> Error {
    match e {
        surface::HostError::Load { detail } => typed_err(
            "load",
            format!("plugin load failed: {detail}"),
            serde_json::json!({"detail": detail}),
        ),
        surface::HostError::UnknownPlugin { id } => typed_err(
            "unknown-plugin",
            format!("unknown plugin {id}"),
            serde_json::json!({"id": id}),
        ),
        surface::HostError::RequestInFlight { id } => typed_err(
            "request-in-flight",
            format!("request id {id} still in flight"),
            serde_json::json!({"id": id}),
        ),
        surface::HostError::Runtime { detail } => typed_err(
            "runtime",
            format!("host runtime: {detail}"),
            serde_json::json!({"detail": detail}),
        ),
    }
}

/// A `JoinError` on a parked worker is an internal runtime fault —
/// panic or cancellation — never a caller slug, so it rides
/// `runtime` with the join error's own detail.
fn worker_err(task: &str, e: tokio::task::JoinError) -> Error {
    typed_err(
        "runtime",
        format!("{task} failed: {e}"),
        serde_json::json!({"detail": e.to_string()}),
    )
}

fn stream_err(e: surface::StreamError) -> Error {
    match e {
        surface::StreamError::Unavailable => typed_err(
            "unavailable",
            e.to_string(),
            serde_json::json!({"detail": e.to_string()}),
        ),
        surface::StreamError::Failed { kind, detail } => typed_err(
            &kind,
            format!("{kind}: {detail}"),
            serde_json::json!({"kind": kind, "detail": detail}),
        ),
    }
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
    rx.await.map_err(|_| {
        typed_err(
            "runtime",
            "host dropped request".to_string(),
            serde_json::json!({"detail": "outcome channel closed before delivery"}),
        )
    })
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
        let inner = surface::PluginHost::new(config.try_into()?).map_err(host_err)?;
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

    /// Set or clear the bgutil-compatible PO-token provider URL
    /// (`POST {url}/get_pot`) on the running host — resolves read the
    /// slot at invocation spawn, so a provider learned after
    /// construction (mid-session pairing, minter bind retry) applies
    /// without recreating the host. Never logged.
    #[napi(js_name = "setPotProvider")]
    pub fn set_pot_provider(&self, url: Option<String>) {
        self.inner.set_pot_provider(url);
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
                    let _ = tx.send(o);
                },
            )
        })
        .await
        .and_then(ResolveOutcome::try_from)
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
                    let _ = tx.send(o);
                },
            )
        })
        .await
        .and_then(RequestOutcome::try_from)
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
                    let _ = tx.send(o);
                },
            )
        })
        .await
        .and_then(|o| {
            // A conversion failure still owes the host the session it
            // just registered — release it before rejecting, or the
            // handle never reaches JS and leaks live.
            let handle = match &o {
                surface::PrepareOutcome::Prepared { stream, .. } => Some(stream.handle.clone()),
                surface::PrepareOutcome::Failed { .. } => None,
            };
            match o.try_into() {
                Ok(v) => Ok(v),
                Err(e) => {
                    if let Some(h) = handle {
                        let _ = self.inner.stream_release(h);
                    }
                    Err(e)
                }
            }
        })
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
    /// latency on-device. Parks a Tokio `spawn_blocking` worker.
    #[napi(js_name = "runSpin")]
    pub async fn run_spin(&self, wasm: Buffer, manifest_json: String) -> Result<SpinReport> {
        let inner = Arc::clone(&self.inner);
        let wasm = wasm.to_vec();
        tokio::task::spawn_blocking(move || {
            inner
                .run_spin(wasm, manifest_json)
                .map_err(host_err)
                .and_then(SpinReport::try_from)
        })
        .await
        .map_err(|e| worker_err("spin worker", e))?
    }

    /// Attach a consumer at `position` (session open). Returns
    /// `content_length - position` when the stream total is known.
    #[napi(js_name = "streamOpen")]
    pub fn stream_open(&self, handle: String, position: f64) -> Result<Option<f64>> {
        self.inner
            .stream_open(handle, u64_field(position, "position", 0)?)
            .map_err(stream_err)?
            .map(|n| u64_out(n, "remaining"))
            .transpose()
    }

    /// Blocking read — deliberately a promise so the seam parks a
    /// runtime's blocking pool, never the libuv main thread. Empty buffer =
    /// EOF. Bounded by the seam's read deadline; terminal transitions
    /// reject with their typed error.
    #[napi(js_name = "streamRead")]
    pub async fn stream_read(&self, handle: String, position: f64, max_len: f64) -> Result<Buffer> {
        // Validation stays on the caller's thread — a bad `max_len`
        // must reject as `invalid-argument`, never masquerade as EOF.
        let position = u64_field(position, "position", 0)?;
        let max_len = u64_field(max_len, "maxLen", 1)?;
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            inner
                .stream_read(handle, position, max_len)
                .map(Buffer::from)
                .map_err(stream_err)
        })
        .await
        .map_err(|e| worker_err("stream read worker", e))?
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
            .map_err(stream_err)
            .and_then(StreamPhaseMarks::try_from)
    }

    /// Serve a prepared session over the loopback range adapter and
    /// return its `http://127.0.0.1:{port}/s/{token}` URL — the
    /// desktop PlayerPort's fallback leg for containers renderer MSE
    /// can't take. The token is unguessable; the grant dies with the
    /// session.
    #[napi(js_name = "streamServeUrl")]
    pub fn stream_serve_url(&self, handle: String) -> Result<String> {
        self.inner.stream_serve_url(handle).map_err(stream_err)
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
        let stream = self
            .inner
            .dev_prepare_url(
                url,
                mime,
                content_length
                    .map(|v| u64_field(v, "contentLength", 1))
                    .transpose()?,
                remintable,
            )
            .map_err(stream_err)?;
        // Same rule as `startPrepare`: a conversion that can't be
        // represented releases the just-registered session rather
        // than leaking it without a handle.
        let handle = stream.handle.clone();
        match PreparedStream::try_from(stream) {
            Ok(v) => Ok(v),
            Err(e) => {
                let _ = self.inner.stream_release(handle);
                Err(e)
            }
        }
    }
}
