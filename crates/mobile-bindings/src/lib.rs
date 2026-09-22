//! UniFFI bindings over `auqw-plugin-host`.
//!
//! Thin FFI shim: all behavior lives in `auqw-host-surface` (shared
//! with the desktop napi-rs binding); this crate maps its outcomes
//! onto UniFFI records/callbacks for Kotlin/Swift. The URL inside
//! [`ResolvedResource`] is a real signed stream URL — it must never be
//! logged at any layer.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use auqw_host_surface as surface;

uniffi::setup_scaffolding!();

/// Host-side budgets the app may tune; all other dimensions take
/// `Budgets::default()`.
#[derive(uniffi::Record)]
pub struct HostConfig {
    /// Fuel granted to each guest entry.
    pub fuel_per_entry: u64,
    /// Total fuel across one invocation.
    pub fuel_total: u64,
    /// Base URL of a bgutil-compatible PO-token service
    /// (`POST {provider}/get_pot`). `None` leaves resolves anonymous.
    pub pot_provider_url: Option<String>,
    /// Path of the on-disk KV store the native shell supplies;
    /// `None` keeps plugin state volatile.
    pub state_path: Option<String>,
    /// Directory for the sparse stream cache; `None` disables the
    /// streaming seam — every `stream_*` call then fails
    /// [`StreamError::Unavailable`] and `start_prepare` fails
    /// synchronously.
    pub stream_path: Option<String>,
    /// Container preference order sent on `playback.resolve` — the
    /// surface's `prefer` hint (webm-first on Android+desktop, mp4-only
    /// on iOS). `None` leaves the guest's own default order.
    pub prefer: Option<Vec<String>>,
    /// Initial OAuth access token for session-trust `Authorization:
    /// Bearer` on InnerTube calls. `None` starts anonymous; update it
    /// later with [`PluginHost::set_auth_token`]. Never logged. Values
    /// outside the contract (`minLength: 1`, `maxLength: 8192`) are
    /// treated as unset.
    pub auth_token: Option<String>,
}

impl From<HostConfig> for surface::HostConfig {
    fn from(c: HostConfig) -> Self {
        Self {
            fuel_per_entry: c.fuel_per_entry,
            fuel_total: c.fuel_total,
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
#[derive(uniffi::Record, Clone)]
pub struct HttpTraceSummary {
    /// HTTP method.
    pub method: String,
    /// URL without query or fragment.
    pub url: String,
    /// Response status when one was received.
    pub status: Option<u16>,
    /// Body bytes received.
    pub bytes: u64,
    /// Round-trip milliseconds.
    pub elapsed_ms: u64,
}

impl From<surface::HttpTraceSummary> for HttpTraceSummary {
    fn from(s: surface::HttpTraceSummary) -> Self {
        Self {
            method: s.method,
            url: s.url,
            status: s.status,
            bytes: s.bytes,
            elapsed_ms: s.elapsed_ms,
        }
    }
}

/// One guest `log` entry, already redacted by the host.
#[derive(uniffi::Record, Clone)]
pub struct GuestLogSummary {
    /// `debug` | `info` | `warn` | `error`.
    pub level: String,
    /// Redacted message text.
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
#[derive(uniffi::Record, Clone)]
pub struct AttemptSummary {
    /// Host-generated request id.
    pub request_id: String,
    /// `handle` steps executed.
    pub steps: u32,
    /// HTTP requests performed for the guest.
    pub http_calls: u32,
    /// HTTP bytes moved, in and out.
    pub bytes: u64,
    /// Fuel consumed across all guest entries.
    pub fuel_used: u64,
    /// Wall-clock elapsed.
    pub elapsed_ms: u64,
    /// Sanitized HTTP trace entries.
    pub http_trace: Vec<HttpTraceSummary>,
    /// Guest log entries.
    pub guest_log: Vec<GuestLogSummary>,
}

impl From<surface::AttemptSummary> for AttemptSummary {
    fn from(s: surface::AttemptSummary) -> Self {
        Self {
            request_id: s.request_id,
            steps: s.steps,
            http_calls: s.http_calls,
            bytes: s.bytes,
            fuel_used: s.fuel_used,
            elapsed_ms: s.elapsed_ms,
            http_trace: s.http_trace.into_iter().map(Into::into).collect(),
            guest_log: s.guest_log.into_iter().map(Into::into).collect(),
        }
    }
}

/// A resolved stream. `url` is signed — never log it.
#[derive(uniffi::Record)]
pub struct ResolvedResource {
    /// Direct stream URL (signed; redact everywhere).
    pub url: String,
    /// MIME type, e.g. `audio/mp4`.
    pub mime: String,
    /// Bitrate in kbps when the guest reported one.
    pub bitrate_kbps: Option<u32>,
    /// `expire=` converted to epoch milliseconds.
    pub expires_at_ms: Option<u64>,
    /// Ladder rung that produced the URL.
    pub client: String,
    /// Reported `contentLength` of the picked format in bytes.
    pub content_length: Option<u64>,
    /// Provider format itag when the guest reported one.
    pub itag: Option<u32>,
}

impl From<surface::ResolvedResource> for ResolvedResource {
    fn from(r: surface::ResolvedResource) -> Self {
        Self {
            url: r.url,
            mime: r.mime,
            bitrate_kbps: r.bitrate_kbps,
            expires_at_ms: r.expires_at_ms,
            client: r.client,
            content_length: r.content_length,
            itag: r.itag,
        }
    }
}

/// Terminal outcome of one `start_resolve` invocation.
#[derive(uniffi::Enum)]
pub enum ResolveOutcome {
    /// A plain audio URL was produced.
    Resolved {
        /// The stream.
        resource: ResolvedResource,
        /// Invocation accounting.
        attempt: AttemptSummary,
    },
    /// The invocation failed; `kind` is the ABI error taxonomy.
    Failed {
        /// Taxonomy kind (`no-result`, `cancelled`, ...).
        kind: String,
        /// Human-readable detail (never contains the URL).
        message: String,
        /// Invocation accounting.
        attempt: AttemptSummary,
    },
}

impl From<surface::ResolveOutcome> for ResolveOutcome {
    fn from(o: surface::ResolveOutcome) -> Self {
        match o {
            surface::ResolveOutcome::Resolved { resource, attempt } => Self::Resolved {
                resource: resource.into(),
                attempt: attempt.into(),
            },
            surface::ResolveOutcome::Failed {
                kind,
                message,
                attempt,
            } => Self::Failed {
                kind,
                message,
                attempt: attempt.into(),
            },
        }
    }
}

/// Terminal outcome of one `start_request` invocation. The result is
/// raw JSON — the typed [`ResolveOutcome`] remains for resolve callers.
#[derive(uniffi::Enum)]
pub enum RequestOutcome {
    /// The invocation produced a `done` result.
    Succeeded {
        /// `done.result` serialized to JSON.
        result_json: String,
        /// Invocation accounting.
        attempt: AttemptSummary,
    },
    /// The invocation failed; `kind` is the ABI error taxonomy.
    Failed {
        /// Taxonomy kind.
        kind: String,
        /// Human-readable detail (never contains signed URLs).
        message: String,
        /// Invocation accounting.
        attempt: AttemptSummary,
    },
}

impl From<surface::RequestOutcome> for RequestOutcome {
    fn from(o: surface::RequestOutcome) -> Self {
        match o {
            surface::RequestOutcome::Succeeded {
                result_json,
                attempt,
            } => Self::Succeeded {
                result_json,
                attempt: attempt.into(),
            },
            surface::RequestOutcome::Failed {
                kind,
                message,
                attempt,
            } => Self::Failed {
                kind,
                message,
                attempt: attempt.into(),
            },
        }
    }
}

/// Errors raised synchronously by [`PluginHost`] calls.
///
/// Field names avoid `message`: in the Kotlin binding an exception
/// property named `message` collides with `Throwable.message`.
#[derive(uniffi::Error, thiserror::Error, Debug)]
pub enum HostError {
    /// Artifact or manifest rejected at load.
    #[error("load: {detail}")]
    Load {
        /// Rejection detail.
        detail: String,
    },
    /// `start_resolve`/`cancel` referenced an id that is not loaded.
    #[error("unknown plugin {id}")]
    UnknownPlugin {
        /// The missing plugin id.
        id: String,
    },
    /// The caller-minted request id is still owned by a live
    /// invocation or an unreleased prepared session — ids must be
    /// unique while live.
    #[error("request id {id} still in flight")]
    RequestInFlight {
        /// The colliding request id.
        id: String,
    },
    /// Internal runtime failure.
    #[error("runtime: {detail}")]
    Runtime {
        /// Detail.
        detail: String,
    },
}

impl From<surface::HostError> for HostError {
    fn from(e: surface::HostError) -> Self {
        match e {
            surface::HostError::Load { detail } => Self::Load { detail },
            surface::HostError::UnknownPlugin { id } => Self::UnknownPlugin { id },
            surface::HostError::RequestInFlight { id } => Self::RequestInFlight { id },
            surface::HostError::Runtime { detail } => Self::Runtime { detail },
        }
    }
}

/// Result of the fuel-gate measurement (spin conformance guest).
#[derive(uniffi::Record)]
pub struct SpinReport {
    /// Wall-clock time until the trap.
    pub elapsed_ms: u64,
    /// Fuel consumed before the trap.
    pub fuel_used: u64,
    /// Terminal error kind (`budget-exceeded` expected).
    pub kind: String,
}

impl From<surface::SpinReport> for SpinReport {
    fn from(r: surface::SpinReport) -> Self {
        Self {
            elapsed_ms: r.elapsed_ms,
            fuel_used: r.fuel_used,
            kind: r.kind,
        }
    }
}

/// Receives the terminal outcome of an invocation started with
/// [`PluginHost::start_resolve`].
#[uniffi::export(callback_interface)]
pub trait ResolveListener: Send + Sync {
    /// Called exactly once per request, on a runtime worker thread.
    fn on_outcome(&self, request_id: String, outcome: ResolveOutcome);
}

/// Receives the terminal outcome of an invocation started with
/// [`PluginHost::start_request`].
#[uniffi::export(callback_interface)]
pub trait RequestListener: Send + Sync {
    /// Called exactly once per request, on a runtime worker thread.
    fn on_outcome(&self, request_id: String, outcome: RequestOutcome);
}

/// The plugin host object exposed to Kotlin/Swift: delegates to the
/// shared surface and mints `req-N` request ids here — the surface's
/// caller-supplied-id contract leaves id minting to each binding.
#[derive(uniffi::Object)]
pub struct PluginHost {
    inner: surface::PluginHost,
    counter: AtomicU64,
}

impl PluginHost {
    fn next_request_id(&self) -> String {
        format!("req-{}", self.counter.fetch_add(1, Ordering::Relaxed))
    }
}

#[uniffi::export]
impl PluginHost {
    /// Create a host with a two-worker tokio runtime.
    ///
    /// # Errors
    /// [`HostError::Runtime`] if the runtime or TLS backend cannot start.
    #[uniffi::constructor]
    pub fn new(config: HostConfig) -> Result<Arc<Self>, HostError> {
        let inner = surface::PluginHost::new(config.into()).map_err(HostError::from)?;
        Ok(Arc::new(Self {
            inner,
            counter: AtomicU64::new(0),
        }))
    }

    /// Set or clear the OAuth access token merged as `access_token`
    /// into every session-trust payload (`Authorization: Bearer` on
    /// InnerTube calls). Prepared sessions read the same slot at
    /// re-mint, so a refreshed token applies to in-flight playback
    /// recovery. Never logged. An off-contract value (empty or over
    /// the contract `maxLength`) clears the slot — the guest resolves
    /// anonymous rather than receiving a payload that fails
    /// validation.
    pub fn set_auth_token(&self, token: Option<String>) {
        self.inner.set_auth_token(token);
    }

    /// Validate and register a plugin artifact. Returns the manifest id.
    ///
    /// # Errors
    /// [`HostError::Load`] on any contract or policy violation.
    pub fn load_plugin(&self, wasm: Vec<u8>, manifest_json: String) -> Result<String, HostError> {
        self.inner
            .load_plugin(wasm, manifest_json)
            .map_err(HostError::from)
    }

    /// Start a `playback.resolve` invocation on the runtime. The
    /// returned request id is passed back through the listener.
    ///
    /// # Errors
    /// [`HostError::UnknownPlugin`] if `plugin_id` was never loaded.
    pub fn start_resolve(
        &self,
        plugin_id: String,
        source_ref: String,
        listener: Box<dyn ResolveListener>,
    ) -> Result<String, HostError> {
        let request_id = self.next_request_id();
        self.inner.start_resolve(
            plugin_id,
            source_ref,
            request_id.clone(),
            move |request_id, outcome| async move {
                listener.on_outcome(request_id, outcome.into());
            },
        )?;
        Ok(request_id)
    }

    /// Start any declared capability with a JSON object payload. The
    /// outcome carries the raw `done.result` JSON.
    ///
    /// # Errors
    /// [`HostError::Runtime`] when `payload_json` is not a JSON object;
    /// [`HostError::UnknownPlugin`] for an unloaded `plugin_id`.
    pub fn start_request(
        &self,
        plugin_id: String,
        capability: String,
        payload_json: String,
        listener: Box<dyn RequestListener>,
    ) -> Result<String, HostError> {
        let request_id = self.next_request_id();
        self.inner.start_request(
            plugin_id,
            capability,
            payload_json,
            request_id.clone(),
            move |request_id, outcome| async move {
                listener.on_outcome(request_id, outcome.into());
            },
        )?;
        Ok(request_id)
    }

    /// Cancel an in-flight request. Unknown ids are a no-op except
    /// that a plausible issued-id is tombstoned briefly so a cancel
    /// that outran the bookkeeping still abandons the session it was
    /// about to receive. A `cancelPrepare` landing after `prepared`
    /// also abandons the produced session — but only while it is still
    /// unattached: a playing consumer is never cancelled out from
    /// under playback. And only once the `prepared` outcome is on the
    /// wire — a slot still mid-delivery is consumed but its handle
    /// left live, or the listener would get a `Prepared` naming a
    /// released session.
    pub fn cancel(&self, request_id: String) {
        self.inner.cancel(request_id);
    }

    /// Run the spin conformance guest to measure the fuel trap latency
    /// on-device. Blocks the calling thread on the runtime.
    ///
    /// # Errors
    /// [`HostError::Load`] if the artifact fails validation.
    pub fn run_spin(&self, wasm: Vec<u8>, manifest_json: String) -> Result<SpinReport, HostError> {
        self.inner
            .run_spin(wasm, manifest_json)
            .map(SpinReport::from)
            .map_err(HostError::from)
    }
}

mod stream;
pub use stream::*;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use sha2::Digest as _;
    use std::sync::mpsc;

    const ECHO_WASM: &[u8] = include_bytes!("../../../sdk/conformance/echo/echo.wasm");
    const SPIN_WASM: &[u8] = include_bytes!("../../../sdk/conformance/spin/spin.wasm");

    fn manifest_json(id: &str, wasm: &[u8], permissions: &str) -> String {
        let digest = format!("sha256:{:x}", sha2::Sha256::digest(wasm));
        format!(
            "{{\"id\":\"{id}\",\"version\":\"0.1.0\",\"abi\":\"0.1.0\",\
             \"capabilities\":[\"playback.resolve\"],\"permissions\":{permissions},\
             \"artifact\":{{\"path\":\"{id}.wasm\",\"digest\":\"{digest}\"}}}}"
        )
    }

    fn config() -> HostConfig {
        HostConfig {
            fuel_per_entry: 200_000_000,
            fuel_total: 2_000_000_000,
            pot_provider_url: None,
            state_path: None,
            stream_path: None,
            prefer: None,
            auth_token: None,
        }
    }

    struct ChannelListener {
        tx: mpsc::Sender<(String, ResolveOutcome)>,
    }

    impl ResolveListener for ChannelListener {
        fn on_outcome(&self, request_id: String, outcome: ResolveOutcome) {
            let _ = self.tx.send((request_id, outcome));
        }
    }

    /// Guest that answers `done` with a fully populated resolve result.
    fn done_wat(result: &str) -> String {
        let raw = format!("{{\"type\":\"done\",\"result\":{result}}}");
        let msg = raw.replace('"', "\\\"");
        format!(
            "(module\n  (memory (export \"memory\") 1)\n  \
             (func (export \"alloc\") (param i32) (result i32) (i32.const 1024))\n  \
             (func (export \"handle\") (param i32 i32) (result i64)\n    \
             (i64.or\n      \
             (i64.shl (i64.extend_i32_u (i32.const 2048)) (i64.const 32))\n      \
             (i64.extend_i32_u (i32.const {}))))\n  \
             (data (i32.const 2048) \"{}\"))",
            raw.len(),
            msg,
        )
    }

    #[test]
    fn resolve_result_fields_reach_the_channel() {
        let wasm = match wat::parse_str(done_wat(
            "{\"url\":\"https://example.com/a.m4a\",\"mime\":\"audio/mp4\",\
             \"bitrate_kbps\":129,\"expires_at_ms\":42,\"client\":\"IOS\",\
             \"content_length\":1234}",
        )) {
            Ok(w) => w,
            Err(e) => panic!("wat: {e}"),
        };
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let id = match host.load_plugin(
            wasm.clone(),
            manifest_json("done", &wasm, "[\"network:example.com\"]"),
        ) {
            Ok(id) => id,
            Err(e) => panic!("load: {e}"),
        };
        let (tx, rx) = mpsc::channel();
        let request_id =
            match host.start_resolve(id, "vid12345678".into(), Box::new(ChannelListener { tx })) {
                Ok(r) => r,
                Err(e) => panic!("start: {e}"),
            };
        let (rid, outcome) = match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(v) => v,
            Err(e) => panic!("listener: {e}"),
        };
        assert_eq!(rid, request_id);
        match outcome {
            ResolveOutcome::Resolved { resource, attempt } => {
                assert_eq!(resource.url, "https://example.com/a.m4a");
                assert_eq!(resource.mime, "audio/mp4");
                assert_eq!(resource.client, "IOS");
                assert_eq!(resource.content_length, Some(1234));
                assert!(attempt.steps >= 1);
            }
            ResolveOutcome::Failed { kind, message, .. } => {
                panic!("expected Resolved, got Failed {kind}: {message}");
            }
        }
    }

    #[test]
    fn resolve_without_url_reports_invalid_response() {
        // The echo guest returns the invoke message as `result` — it has
        // no `url`, so the outcome must be Failed, never Resolved{""}.
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let id = match host.load_plugin(ECHO_WASM.to_vec(), manifest_json("echo", ECHO_WASM, "[]"))
        {
            Ok(id) => id,
            Err(e) => panic!("load: {e}"),
        };
        assert_eq!(id, "echo");
        let (tx, rx) = mpsc::channel();
        let request_id =
            match host.start_resolve(id, "vid12345678".into(), Box::new(ChannelListener { tx })) {
                Ok(r) => r,
                Err(e) => panic!("start: {e}"),
            };
        let (rid, outcome) = match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(v) => v,
            Err(e) => panic!("listener: {e}"),
        };
        assert_eq!(rid, request_id);
        match outcome {
            ResolveOutcome::Failed { kind, .. } => {
                assert_eq!(kind, "invalid-response");
            }
            ResolveOutcome::Resolved { .. } => {
                panic!("echo result has no url — expected Failed");
            }
        }
    }

    #[test]
    fn resolve_missing_required_fields_report_invalid_response() {
        // `playbackResolveResult` requires `url`, `mime`, `client`,
        // `bitrate_kbps`, and `expires_at_ms` — a result missing,
        // emptying, or mistyping any of them is Failed
        // invalid-response, never Resolved{""}. `content_length`
        // below its `minimum: 1` bound fails the same way.
        for (i, result) in [
            "{\"url\":\"https://example.com/a\",\"client\":\"IOS\"}",
            "{\"url\":\"https://example.com/a\",\"mime\":\"audio/mp4\"}",
            "{\"url\":\"https://example.com/a\",\"mime\":\"\",\"client\":\"IOS\"}",
            // Present strings but the nullable integer keys absent.
            "{\"url\":\"https://example.com/a\",\"mime\":\"audio/mp4\",\"client\":\"IOS\"}",
            // Out-of-bounds `content_length` (minimum is 1).
            "{\"url\":\"https://example.com/a\",\"mime\":\"audio/mp4\",\"client\":\"IOS\",\"bitrate_kbps\":null,\"expires_at_ms\":null,\"content_length\":0}",
        ]
        .iter()
        .enumerate()
        {
            let wasm = match wat::parse_str(done_wat(result)) {
                Ok(w) => w,
                Err(e) => panic!("wat: {e}"),
            };
            let host = match PluginHost::new(config()) {
                Ok(h) => h,
                Err(e) => panic!("host: {e}"),
            };
            let id = match host.load_plugin(
                wasm.clone(),
                manifest_json(&format!("done{i}"), &wasm, "[\"network:example.com\"]"),
            ) {
                Ok(id) => id,
                Err(e) => panic!("load: {e}"),
            };
            let (tx, rx) = mpsc::channel();
            if let Err(e) =
                host.start_resolve(id, "vid12345678".into(), Box::new(ChannelListener { tx }))
            {
                panic!("start: {e}");
            }
            let (_rid, outcome) = match rx.recv_timeout(std::time::Duration::from_secs(10)) {
                Ok(v) => v,
                Err(e) => panic!("listener: {e}"),
            };
            match outcome {
                ResolveOutcome::Failed { kind, .. } => {
                    assert_eq!(kind, "invalid-response", "result {result}");
                }
                ResolveOutcome::Resolved { .. } => {
                    panic!("result {result} missing a required field — expected Failed");
                }
            }
        }
    }

    #[test]
    fn unknown_plugin_errors() {
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let (tx, _rx) = mpsc::channel();
        match host.start_resolve("nope".into(), "x".into(), Box::new(ChannelListener { tx })) {
            Err(HostError::UnknownPlugin { id }) => assert_eq!(id, "nope"),
            other => panic!("expected UnknownPlugin, got {other:?}"),
        }
    }

    #[test]
    fn spin_traps_as_budget_exceeded() {
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let report = match host.run_spin(SPIN_WASM.to_vec(), manifest_json("spin", SPIN_WASM, "[]"))
        {
            Ok(r) => r,
            Err(e) => panic!("spin: {e}"),
        };
        assert_eq!(report.kind, "budget-exceeded");
        assert!(report.fuel_used > 0);
    }

    #[test]
    fn cancel_on_inflight_reports_terminal_failure() {
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let id = match host.load_plugin(SPIN_WASM.to_vec(), manifest_json("spin", SPIN_WASM, "[]"))
        {
            Ok(id) => id,
            Err(e) => panic!("load: {e}"),
        };
        let (tx, rx) = mpsc::channel();
        let request_id = match host.start_resolve(id, "x".into(), Box::new(ChannelListener { tx }))
        {
            Ok(r) => r,
            Err(e) => panic!("start: {e}"),
        };
        host.cancel(request_id);
        let (_rid, outcome) = match rx.recv_timeout(std::time::Duration::from_secs(60)) {
            Ok(v) => v,
            Err(e) => panic!("listener: {e}"),
        };
        match outcome {
            ResolveOutcome::Failed { kind, .. } => {
                assert!(
                    kind == "cancelled" || kind == "budget-exceeded",
                    "expected cancelled|budget-exceeded, got {kind}"
                );
            }
            ResolveOutcome::Resolved { .. } => panic!("spin resolved?"),
        }
    }

    struct PrepareChannelListener {
        tx: mpsc::Sender<(String, PrepareOutcome)>,
    }

    impl PrepareListener for PrepareChannelListener {
        fn on_outcome(&self, request_id: String, outcome: PrepareOutcome) {
            let _ = self.tx.send((request_id, outcome));
        }
    }

    #[test]
    fn itag_reaches_the_resource() {
        let wasm = match wat::parse_str(done_wat(
            "{\"url\":\"https://example.com/a.m4a\",\"mime\":\"audio/mp4\",\
             \"bitrate_kbps\":null,\"expires_at_ms\":null,\
             \"itag\":140,\"client\":\"IOS\"}",
        )) {
            Ok(w) => w,
            Err(e) => panic!("wat: {e}"),
        };
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let id = match host.load_plugin(
            wasm.clone(),
            manifest_json("done", &wasm, "[\"network:example.com\"]"),
        ) {
            Ok(id) => id,
            Err(e) => panic!("load: {e}"),
        };
        let (tx, rx) = mpsc::channel();
        let _ = match host.start_resolve(id, "vid12345678".into(), Box::new(ChannelListener { tx }))
        {
            Ok(r) => r,
            Err(e) => panic!("start: {e}"),
        };
        let (_rid, outcome) = match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(v) => v,
            Err(e) => panic!("listener: {e}"),
        };
        match outcome {
            ResolveOutcome::Resolved { resource, .. } => {
                assert_eq!(resource.itag, Some(140));
            }
            ResolveOutcome::Failed { kind, message, .. } => {
                panic!("expected Resolved, got Failed {kind}: {message}");
            }
        }
    }

    #[test]
    fn stream_calls_fail_unavailable_without_stream_path() {
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        for result in [
            host.stream_open("st-0".into(), 0).map(|_| ()),
            host.stream_read("st-0".into(), 0, 64).map(|_| ()),
            host.stream_close("st-0".into()),
            host.stream_release("st-0".into()),
            host.stream_phase_marks("st-0".into()).map(|_| ()),
        ] {
            match result {
                Err(StreamError::Unavailable) => {}
                other => panic!("expected Unavailable, got {other:?}"),
            }
        }
    }

    #[test]
    fn prepare_fails_synchronously_without_stream_path() {
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let (tx, _rx) = mpsc::channel();
        match host.start_prepare(
            "any".into(),
            "x".into(),
            Box::new(PrepareChannelListener { tx }),
        ) {
            Err(HostError::Runtime { detail }) => {
                assert!(detail.contains("stream"), "{detail}");
            }
            other => panic!("expected Runtime, got {other:?}"),
        }
    }

    #[test]
    fn prepare_with_urlless_result_reports_failed() {
        // The echo guest resolves to a url-less result; the seam is
        // configured, so the outcome must be Failed invalid-response —
        // and no session (or pump, or network) is ever started.
        let dir = std::env::temp_dir().join(format!(
            "auqw-mb-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let mut cfg = config();
        cfg.stream_path = Some(dir.to_string_lossy().into_owned());
        let host = match PluginHost::new(cfg) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let id = match host.load_plugin(ECHO_WASM.to_vec(), manifest_json("echo", ECHO_WASM, "[]"))
        {
            Ok(id) => id,
            Err(e) => panic!("load: {e}"),
        };
        let (tx, rx) = mpsc::channel();
        let request_id = match host.start_prepare(
            id,
            "vid12345678".into(),
            Box::new(PrepareChannelListener { tx }),
        ) {
            Ok(r) => r,
            Err(e) => panic!("start_prepare: {e}"),
        };
        let (rid, outcome) = match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(v) => v,
            Err(e) => panic!("listener: {e}"),
        };
        assert_eq!(rid, request_id);
        match outcome {
            PrepareOutcome::Failed { kind, .. } => {
                assert_eq!(kind, "invalid-response");
            }
            PrepareOutcome::Prepared { .. } => {
                panic!("echo result has no url — expected Failed");
            }
        }
    }

    #[test]
    fn cancel_on_coalesced_request_keeps_the_shared_session() {
        // Two prepares for the same (provider, source_ref) coalesce
        // onto one session handle. Cancelling one request must not
        // abandon a session the other still owns — its `stream_open`
        // would otherwise die `cancelled` with no signal to re-prepare.
        // The URL's host passes the destination check, but the bare
        // listener never answers the TLS hello: the speculative head
        // fetch parks and the session stays live and detached instead
        // of racing the test to a terminal fetch error.
        let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(e) => panic!("bind: {e}"),
        };
        let port = match listener.local_addr() {
            Ok(a) => a.port(),
            Err(e) => panic!("addr: {e}"),
        };
        let wasm = match wat::parse_str(done_wat(&format!(
            "{{\"url\":\"https://127.0.0.1:{port}/a\",\"mime\":\"audio/mp4\",\"client\":\"IOS\",\"bitrate_kbps\":null,\"expires_at_ms\":null}}"
        ))) {
            Ok(w) => w,
            Err(e) => panic!("wat: {e}"),
        };
        let dir = std::env::temp_dir().join(format!(
            "auqw-mb-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let mut cfg = config();
        cfg.stream_path = Some(dir.to_string_lossy().into_owned());
        let host = match PluginHost::new(cfg) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let id = match host.load_plugin(
            wasm.clone(),
            manifest_json("done", &wasm, "[\"network:127.0.0.1\"]"),
        ) {
            Ok(id) => id,
            Err(e) => panic!("load: {e}"),
        };
        let (tx, rx) = mpsc::channel();
        let mut request_ids = Vec::new();
        let mut handles = Vec::new();
        for _ in 0..2 {
            let request_id = match host.start_prepare(
                id.clone(),
                "vid12345678".into(),
                Box::new(PrepareChannelListener { tx: tx.clone() }),
            ) {
                Ok(r) => r,
                Err(e) => panic!("start_prepare: {e}"),
            };
            let (_rid, outcome) = match rx.recv_timeout(std::time::Duration::from_secs(10)) {
                Ok(v) => v,
                Err(e) => panic!("listener: {e}"),
            };
            request_ids.push(request_id);
            match outcome {
                PrepareOutcome::Prepared { stream, .. } => handles.push(stream.handle),
                PrepareOutcome::Failed { kind, message, .. } => {
                    panic!("expected Prepared, got Failed {kind}: {message}");
                }
            }
        }
        assert_eq!(
            handles[0], handles[1],
            "coalesced prepares share one session handle"
        );
        let handle = handles.into_iter().next().unwrap_or_default();
        // The first request's cancel leaves the second as sole owner —
        // the session must survive and still attach.
        host.cancel(request_ids[0].clone());
        if let Err(e) = host.stream_open(handle.clone(), 0) {
            panic!("shared session died with the cancelled request: {e}");
        }
        if let Err(e) = host.stream_close(handle.clone()) {
            panic!("close: {e}");
        }
        // Cancelling the last owner abandons the still-unattached session.
        host.cancel(request_ids[1].clone());
        match host.stream_open(handle, 0) {
            Err(StreamError::Failed { kind, .. }) => assert_eq!(kind, "cancelled"),
            other => panic!("expected cancelled, got {other:?}"),
        }
    }

    struct RequestChannelListener {
        tx: mpsc::Sender<(String, RequestOutcome)>,
    }

    impl RequestListener for RequestChannelListener {
        fn on_outcome(&self, request_id: String, outcome: RequestOutcome) {
            let _ = self.tx.send((request_id, outcome));
        }
    }

    /// Run one `start_request` against the echo guest and return the
    /// invoke `payload` it reported back verbatim.
    fn invoke_payload(
        host: &PluginHost,
        plugin_id: &str,
        capability: &str,
        payload_json: &str,
    ) -> Value {
        let (tx, rx) = mpsc::channel();
        let request_id = match host.start_request(
            plugin_id.to_string(),
            capability.to_string(),
            payload_json.to_string(),
            Box::new(RequestChannelListener { tx }),
        ) {
            Ok(r) => r,
            Err(e) => panic!("start_request: {e}"),
        };
        let (rid, outcome) = match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(v) => v,
            Err(e) => panic!("listener: {e}"),
        };
        assert_eq!(rid, request_id);
        let result_json = match outcome {
            RequestOutcome::Succeeded { result_json, .. } => result_json,
            RequestOutcome::Failed { kind, message, .. } => {
                panic!("expected Succeeded, got Failed {kind}: {message}")
            }
        };
        let message: Value = match serde_json::from_str(&result_json) {
            Ok(v) => v,
            Err(e) => panic!("result_json: {e}"),
        };
        message.get("payload").cloned().unwrap_or(Value::Null)
    }

    #[test]
    fn session_trust_merge_reaches_the_invoke_payload() {
        // The echo guest returns the invoke message verbatim, so the
        // merged `access_token` is observable inside `payload`: a live
        // slot replaces a stale caller-supplied key on session-trust
        // capabilities, while non-trust capabilities pass untouched.
        let mut cfg = config();
        cfg.auth_token = Some("tok-live".to_string());
        let host = match PluginHost::new(cfg) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let digest = format!("sha256:{:x}", sha2::Sha256::digest(ECHO_WASM));
        let manifest = format!(
            "{{\"id\":\"echo2\",\"version\":\"0.1.0\",\"abi\":\"0.2.0\",\
             \"capabilities\":[\"playback.resolve\",\"catalog.search\"],\
             \"permissions\":[],\"artifact\":{{\"path\":\"echo.wasm\",\"digest\":\"{digest}\"}}}}"
        );
        let id = match host.load_plugin(ECHO_WASM.to_vec(), manifest) {
            Ok(id) => id,
            Err(e) => panic!("load: {e}"),
        };
        let payload = invoke_payload(
            &host,
            &id,
            "playback.resolve",
            "{\"source_ref\":\"vid\",\"access_token\":\"stale\"}",
        );
        assert_eq!(payload["access_token"], json!("tok-live"));
        assert_eq!(payload["source_ref"], json!("vid"));

        // A capability outside the session-trust set is not merged —
        // the caller's keys pass through verbatim.
        let payload = invoke_payload(
            &host,
            &id,
            "catalog.search",
            "{\"query\":{\"text\":\"x\"},\"limit\":1,\"access_token\":\"caller\"}",
        );
        assert_eq!(payload["access_token"], json!("caller"));

        // An off-contract token clears the slot — the payload then
        // passes untouched, so a caller-supplied key survives (the
        // dev seam journey path).
        host.set_auth_token(Some(String::new()));
        let payload = invoke_payload(
            &host,
            &id,
            "playback.resolve",
            "{\"source_ref\":\"vid\",\"access_token\":\"caller\"}",
        );
        assert_eq!(payload["access_token"], json!("caller"));
        host.set_auth_token(Some("tok2".to_string()));
        let payload = invoke_payload(&host, &id, "playback.resolve", "{\"source_ref\":\"v\"}");
        assert_eq!(payload["access_token"], json!("tok2"));
    }
}
