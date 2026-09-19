//! UniFFI bindings over `auqw-plugin-host`.
//!
//! The Android Expo module calls these via the generated Kotlin
//! bindings; the slice's TypeScript surface mirrors them. The URL inside
//! [`ResolvedResource`] is a real signed stream URL — it must never be
//! logged at any layer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use auqw_plugin_host::{invoke, load, Attempt, Budgets, LoadedPlugin, Manifest, ReqwestClient};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::runtime::Runtime;
use tokio_util::sync::CancellationToken;

uniffi::setup_scaffolding!();

/// Host-side budgets the app may tune; all other dimensions take
/// `Budgets::default()`.
#[derive(uniffi::Record)]
pub struct HostConfig {
    /// Fuel granted to each guest entry.
    pub fuel_per_entry: u64,
    /// Total fuel across one invocation.
    pub fuel_total: u64,
}

/// Per-invocation accounting, minus the HTTP trace (kept host-side —
/// its URLs are signed).
#[derive(uniffi::Record)]
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
}

impl From<&Attempt> for AttemptSummary {
    fn from(a: &Attempt) -> Self {
        Self {
            request_id: a.request_id.clone(),
            steps: a.steps,
            http_calls: a.http_calls,
            bytes: a.bytes,
            fuel_used: a.fuel_used,
            elapsed_ms: u64::try_from(a.elapsed.as_millis()).unwrap_or(u64::MAX),
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
    /// Provider caps anonymous fetches of this URL to a prefix
    /// (e.g. GVS PO-token enforcement); hosts label it honestly.
    pub prefix_limited: bool,
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

/// Errors raised synchronously by [`PluginHost`] calls.
///
/// Field names avoid `message`: in the Kotlin binding an exception
/// property named `message` collides with `Throwable.message`.
#[derive(uniffi::Error, Error, Debug)]
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
    /// Internal runtime failure.
    #[error("runtime: {detail}")]
    Runtime {
        /// Detail.
        detail: String,
    },
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

/// Receives the terminal outcome of an invocation started with
/// [`PluginHost::start_resolve`].
#[uniffi::export(callback_interface)]
pub trait ResolveListener: Send + Sync {
    /// Called exactly once per request, on a runtime worker thread.
    fn on_outcome(&self, request_id: String, outcome: ResolveOutcome);
}

/// The plugin host object: owns a tokio runtime, an HTTP client, the
/// loaded plugin set, and per-request cancellation tokens.
#[derive(uniffi::Object)]
pub struct PluginHost {
    runtime: Runtime,
    http: Arc<ReqwestClient>,
    budgets: Budgets,
    plugins: Mutex<HashMap<String, Arc<LoadedPlugin>>>,
    cancels: Arc<Mutex<HashMap<String, CancellationToken>>>,
    counter: AtomicU64,
}

fn lock<'a, T>(m: &'a Mutex<T>) -> Result<MutexGuard<'a, T>, HostError> {
    m.lock().map_err(|_| HostError::Runtime {
        detail: "lock poisoned".into(),
    })
}

fn parse_manifest_and_load(
    wasm: &[u8],
    manifest_json: &str,
    budgets: &Budgets,
) -> Result<LoadedPlugin, HostError> {
    let manifest = Manifest::from_json(manifest_json).map_err(|e| HostError::Load {
        detail: e.to_string(),
    })?;
    load(wasm, manifest, budgets).map_err(|e| HostError::Load {
        detail: e.to_string(),
    })
}

#[uniffi::export]
impl PluginHost {
    /// Create a host with a two-worker tokio runtime.
    ///
    /// # Errors
    /// [`HostError::Runtime`] if the runtime or TLS backend cannot start.
    #[uniffi::constructor]
    pub fn new(config: HostConfig) -> Result<Arc<Self>, HostError> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| HostError::Runtime {
                detail: e.to_string(),
            })?;
        let http = ReqwestClient::new().map_err(|e| HostError::Runtime {
            detail: e.to_string(),
        })?;
        let budgets = Budgets {
            fuel_per_entry: config.fuel_per_entry,
            fuel_total: config.fuel_total,
            ..Budgets::default()
        };
        Ok(Arc::new(Self {
            runtime,
            http: Arc::new(http),
            budgets,
            plugins: Mutex::new(HashMap::new()),
            cancels: Arc::new(Mutex::new(HashMap::new())),
            counter: AtomicU64::new(0),
        }))
    }

    /// Validate and register a plugin artifact. Returns the manifest id.
    ///
    /// # Errors
    /// [`HostError::Load`] on any contract or policy violation.
    pub fn load_plugin(&self, wasm: Vec<u8>, manifest_json: String) -> Result<String, HostError> {
        let plugin = parse_manifest_and_load(&wasm, &manifest_json, &self.budgets)?;
        let id = plugin.manifest().id.clone();
        lock(&self.plugins)?.insert(id.clone(), Arc::new(plugin));
        Ok(id)
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
        let plugin = {
            let plugins = lock(&self.plugins)?;
            match plugins.get(&plugin_id) {
                Some(p) => Arc::clone(p),
                None => return Err(HostError::UnknownPlugin { id: plugin_id }),
            }
        };
        let request_id = format!("req-{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let token = CancellationToken::new();
        lock(&self.cancels)?.insert(request_id.clone(), token.clone());
        let budgets = self.budgets.clone();
        let http = Arc::clone(&self.http);
        let cancels = Arc::clone(&self.cancels);
        let rid = request_id.clone();
        self.runtime.spawn(async move {
            let invocation = invoke(
                &plugin,
                "playback.resolve",
                json!({ "source_ref": source_ref }),
                &budgets,
                token,
                &*http,
            )
            .await;
            let (result, attempt) = invocation.into_parts();
            let summary = AttemptSummary::from(&attempt);
            let outcome = match result {
                Ok(value) => ResolveOutcome::Resolved {
                    resource: resource_from(&value),
                    attempt: summary,
                },
                Err(e) => ResolveOutcome::Failed {
                    kind: e.kind().to_string(),
                    message: e.to_string(),
                    attempt: summary,
                },
            };
            listener.on_outcome(rid.clone(), outcome);
            if let Ok(mut m) = cancels.lock() {
                m.remove(&rid);
            }
        });
        Ok(request_id)
    }

    /// Cancel an in-flight request; unknown ids are a no-op.
    pub fn cancel(&self, request_id: String) {
        if let Ok(m) = self.cancels.lock() {
            if let Some(token) = m.get(&request_id) {
                token.cancel();
            }
        }
    }

    /// Run the spin conformance guest to measure the fuel trap latency
    /// on-device. Blocks the calling thread on the runtime.
    ///
    /// # Errors
    /// [`HostError::Load`] if the artifact fails validation.
    pub fn run_spin(&self, wasm: Vec<u8>, manifest_json: String) -> Result<SpinReport, HostError> {
        let plugin = parse_manifest_and_load(&wasm, &manifest_json, &self.budgets)?;
        let invocation = self.runtime.block_on(invoke(
            &plugin,
            "playback.resolve",
            json!({}),
            &self.budgets,
            CancellationToken::new(),
            &*self.http,
        ));
        let (result, attempt) = invocation.into_parts();
        let kind = match &result {
            Ok(_) => "resolved".to_string(),
            Err(e) => e.kind().to_string(),
        };
        Ok(SpinReport {
            elapsed_ms: u64::try_from(attempt.elapsed.as_millis()).unwrap_or(u64::MAX),
            fuel_used: attempt.fuel_used,
            kind,
        })
    }
}

fn resource_from(value: &Value) -> ResolvedResource {
    let get = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    ResolvedResource {
        url: get("url"),
        mime: get("mime"),
        bitrate_kbps: value
            .get("bitrate_kbps")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok()),
        expires_at_ms: value.get("expires_at_ms").and_then(Value::as_u64),
        client: get("client"),
        prefix_limited: value
            .get("prefix_limited")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest as _;
    use std::sync::mpsc;

    const ECHO_WASM: &[u8] = include_bytes!("../../../sdk/conformance/echo/echo.wasm");
    const SPIN_WASM: &[u8] = include_bytes!("../../../sdk/conformance/spin/spin.wasm");

    fn manifest_json(id: &str, wasm: &[u8]) -> String {
        let digest = format!("sha256:{:x}", sha2::Sha256::digest(wasm));
        format!(
            "{{\"id\":\"{id}\",\"version\":\"0.1.0\",\"abi\":\"0.1.0\",\
             \"capabilities\":[\"playback.resolve\"],\"permissions\":[],\
             \"artifact\":{{\"path\":\"{id}.wasm\",\"digest\":\"{digest}\"}}}}"
        )
    }

    fn config() -> HostConfig {
        HostConfig {
            fuel_per_entry: 200_000_000,
            fuel_total: 2_000_000_000,
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

    #[test]
    fn echo_resolves_through_the_channel() {
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let id = match host.load_plugin(ECHO_WASM.to_vec(), manifest_json("echo", ECHO_WASM)) {
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
            ResolveOutcome::Resolved { attempt, .. } => {
                assert!(attempt.steps >= 1);
            }
            ResolveOutcome::Failed { kind, message, .. } => {
                panic!("expected Resolved, got Failed {kind}: {message}");
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
        let report = match host.run_spin(SPIN_WASM.to_vec(), manifest_json("spin", SPIN_WASM)) {
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
        let id = match host.load_plugin(SPIN_WASM.to_vec(), manifest_json("spin", SPIN_WASM)) {
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
}
