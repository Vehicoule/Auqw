//! UniFFI bindings over `auqw-plugin-host`.
//!
//! The Expo modules call these via the generated Kotlin/Swift
//! bindings; the slice's TypeScript surface mirrors them. The URL inside
//! [`ResolvedResource`] is a real signed stream URL — it must never be
//! logged at any layer.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use auqw_plugin_host::{
    invoke, load, Attempt, Budgets, FileKeyValueStore, GuestLogEntry, HostServices, HttpTraceEntry,
    KeyValueStore, LoadedPlugin, Manifest, MemoryKeyValueStore, ReqwestClient, SystemClock,
};
use auqw_stream::{StreamConfig, StreamRegistry};
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
    /// later with [`PluginHost::set_auth_token`]. Never logged.
    pub auth_token: Option<String>,
}

/// Capabilities whose payloads reach InnerTube — the host-owned
/// `access_token` is merged into these at the `start_typed` funnel so
/// every path (seam resolve, prepare, generic `start_request`) carries
/// the same session trust.
const SESSION_TRUST_CAPABILITIES: &[&str] =
    &["playback.resolve", "playback.candidates", "radio.seed"];

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

/// One guest `log` entry, already redacted by the host.
#[derive(uniffi::Record, Clone)]
pub struct GuestLogSummary {
    /// `debug` | `info` | `warn` | `error`.
    pub level: String,
    /// Redacted message text.
    pub message: String,
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

impl From<&Attempt> for AttemptSummary {
    fn from(a: &Attempt) -> Self {
        Self {
            request_id: a.request_id.clone(),
            steps: a.steps,
            http_calls: a.http_calls,
            bytes: a.bytes,
            fuel_used: a.fuel_used,
            elapsed_ms: u64::try_from(a.elapsed.as_millis()).unwrap_or(u64::MAX),
            http_trace: a.http_trace.iter().map(HttpTraceSummary::from).collect(),
            guest_log: a.guest_log.iter().map(GuestLogSummary::from).collect(),
        }
    }
}

impl From<&HttpTraceEntry> for HttpTraceSummary {
    fn from(e: &HttpTraceEntry) -> Self {
        Self {
            method: e.method.clone(),
            url: e.url.clone(),
            status: e.status,
            bytes: e.bytes,
            elapsed_ms: u64::try_from(e.elapsed.as_millis()).unwrap_or(u64::MAX),
        }
    }
}

impl From<&GuestLogEntry> for GuestLogSummary {
    fn from(e: &GuestLogEntry) -> Self {
        Self {
            level: e.level.clone(),
            message: e.message.clone(),
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

/// Receives the terminal outcome of an invocation started with
/// [`PluginHost::start_request`].
#[uniffi::export(callback_interface)]
pub trait RequestListener: Send + Sync {
    /// Called exactly once per request, on a runtime worker thread.
    fn on_outcome(&self, request_id: String, outcome: RequestOutcome);
}

/// The plugin host object: owns a tokio runtime, an HTTP client, the
/// loaded plugin set, and per-request cancellation tokens.
#[derive(uniffi::Object)]
pub struct PluginHost {
    runtime: Runtime,
    http: Arc<ReqwestClient>,
    kv: Arc<dyn KeyValueStore>,
    budgets: Budgets,
    pot_provider_url: Option<String>,
    /// Surface `prefer` hint merged into every `playback.resolve`.
    prefer: Option<Vec<String>>,
    /// App-held OAuth access token merged as `access_token` into every
    /// session-trust payload — the `Authorization: Bearer` source.
    /// Shared with each prepared session's remint so a refreshed token
    /// reaches re-mints.
    auth_token: Arc<RwLock<Option<String>>>,
    stream: Option<Arc<StreamRegistry>>,
    plugins: Mutex<HashMap<String, Arc<LoadedPlugin>>>,
    cancels: Arc<Mutex<HashMap<String, CancellationToken>>>,
    /// `prepare` request id → produced stream handle, so a
    /// `cancelPrepare` landing after `prepared` can abandon the session
    /// (only while still unattached — see `cancel`).
    prepared_handles: Arc<Mutex<HashMap<String, String>>>,
    /// `cancel` ids that arrived while the prepare was still inside
    /// its window — neither `cancels` nor `prepared_handles` knew it
    /// yet. The outcome path checks the tombstone before registering
    /// the handle so a late cancel can't orphan a live session.
    cancelled_requests: Arc<Mutex<HashSet<String>>>,
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
        // A configured state path must yield a working durable store;
        // falling back to volatile memory would silently lose plugin
        // state, so a failure here fails the host.
        let kv: Arc<dyn KeyValueStore> = match &config.state_path {
            Some(path) => {
                Arc::new(
                    FileKeyValueStore::new(path).map_err(|e| HostError::Runtime {
                        detail: format!("kv store: {e}"),
                    })?,
                )
            }
            None => Arc::new(MemoryKeyValueStore::new()),
        };
        let budgets = Budgets {
            fuel_per_entry: config.fuel_per_entry,
            fuel_total: config.fuel_total,
            ..Budgets::default()
        };
        // A configured stream path must yield a working cache dir;
        // silently degrading to "unavailable" would hide a broken
        // shell config, so a failure here fails the host.
        let stream = match &config.stream_path {
            Some(path) => Some(Arc::new(
                StreamRegistry::new(StreamConfig::new(path.into()), runtime.handle().clone())
                    .map_err(|e| HostError::Runtime {
                        detail: format!("stream: {e}"),
                    })?,
            )),
            None => None,
        };
        Ok(Arc::new(Self {
            runtime,
            http: Arc::new(http),
            kv,
            budgets,
            pot_provider_url: config.pot_provider_url,
            prefer: config.prefer,
            auth_token: Arc::new(RwLock::new(config.auth_token)),
            stream,
            plugins: Mutex::new(HashMap::new()),
            cancels: Arc::new(Mutex::new(HashMap::new())),
            prepared_handles: Arc::new(Mutex::new(HashMap::new())),
            cancelled_requests: Arc::new(Mutex::new(HashSet::new())),
            counter: AtomicU64::new(0),
        }))
    }

    /// Set or clear the OAuth access token merged as `access_token`
    /// into every session-trust payload (`Authorization: Bearer` on
    /// InnerTube calls). Prepared sessions read the same slot at
    /// re-mint, so a refreshed token applies to in-flight playback
    /// recovery. Never logged.
    pub fn set_auth_token(&self, token: Option<String>) {
        if let Ok(mut slot) = self.auth_token.write() {
            *slot = token;
        }
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
        // `prefer` is a key, not a value: absent means guest default,
        // never a null that fails payload validation. `access_token`
        // rides via the `start_typed` merge, so the bare path carries
        // the same session trust as the prepared one.
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
                let mut summary = AttemptSummary::from(&attempt);
                // The summary must join by the caller-facing id —
                // the inner `invoke-N` never leaves this closure.
                summary.request_id = request_id.clone();
                let outcome = match result {
                    // `done.result` is untyped past the boundary — a result
                    // without a url is an invalid response, never Resolved.
                    Ok(value) => {
                        let resource = resource_from(&value);
                        if resource.url.is_empty() {
                            ResolveOutcome::Failed {
                                kind: "invalid-response".to_string(),
                                message: "resolve result missing url".to_string(),
                                attempt: summary,
                            }
                        } else {
                            ResolveOutcome::Resolved {
                                resource,
                                attempt: summary,
                            }
                        }
                    }
                    Err(e) => ResolveOutcome::Failed {
                        kind: e.kind().to_string(),
                        message: e.to_string(),
                        attempt: summary,
                    },
                };
                listener.on_outcome(request_id, outcome);
            },
        )
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
        let payload: Value =
            serde_json::from_str(&payload_json).map_err(|e| HostError::Runtime {
                detail: format!("payload_json: {e}"),
            })?;
        if !payload.is_object() {
            return Err(HostError::Runtime {
                detail: "payload_json must be a JSON object".into(),
            });
        }
        self.start_typed(
            plugin_id,
            capability,
            payload,
            move |request_id, invocation| async move {
                let (result, attempt) = invocation.into_parts();
                let mut summary = AttemptSummary::from(&attempt);
                // The summary must join by the caller-facing id —
                // the inner `invoke-N` never leaves this closure.
                summary.request_id = request_id.clone();
                let outcome = match result {
                    Ok(value) => RequestOutcome::Succeeded {
                        result_json: value.to_string(),
                        attempt: summary,
                    },
                    Err(e) => RequestOutcome::Failed {
                        kind: e.kind().to_string(),
                        message: e.to_string(),
                        attempt: summary,
                    },
                };
                listener.on_outcome(request_id, outcome);
            },
        )
    }

    /// Cancel an in-flight request. Unknown ids are a no-op except
    /// that a plausible issued-id (`req-N`) is tombstoned briefly so a
    /// cancel that outran the bookkeeping still abandons the session
    /// it was about to receive. A `cancelPrepare` landing after
    /// `prepared` also abandons the produced session — but only while
    /// it is still unattached: a playing consumer is never cancelled
    /// out from under playback.
    pub fn cancel(&self, request_id: String) {
        let mut known = false;
        if let Ok(m) = self.cancels.lock() {
            if let Some(token) = m.get(&request_id) {
                token.cancel();
                known = true;
            }
        }
        // Coalesced prepares hand one session handle to several
        // request ids — abandoning it is only safe once the cancelled
        // request was its last owner, or a surviving request's
        // `stream_open` would hit `cancelled`.
        let handle = self.prepared_handles.lock().ok().and_then(|mut m| {
            if m.contains_key(&request_id) {
                known = true;
            }
            m.remove(&request_id)
                .filter(|h| !m.values().any(|v| v == h))
        });
        if let (Some(stream), Some(handle)) = (&self.stream, handle) {
            let _ = stream.cancel_if_unattached(&handle);
        }
        if !known {
            // The cancel outran the bookkeeping: the request is past
            // its token but the handle isn't registered yet. Leave a
            // tombstone — the outcome path consumes it and abandons
            // the session it was about to hand out. The set is capped
            // and only ids shaped like an issued `req-N` (N no higher
            // than the counter) land in it — arbitrary strings can
            // never fill the cap and starve a real cancel race.
            let plausible = request_id
                .strip_prefix("req-")
                .and_then(|n| n.parse::<u64>().ok())
                .is_some_and(|n| n <= self.counter.load(Ordering::Relaxed));
            if plausible {
                if let Ok(mut m) = self.cancelled_requests.lock() {
                    if m.len() < 64 {
                        m.insert(request_id);
                    }
                }
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
        let clock = SystemClock;
        let invocation = self.runtime.block_on(invoke(
            &plugin,
            "playback.resolve",
            json!({}),
            &self.budgets,
            CancellationToken::new(),
            HostServices {
                http: &*self.http,
                kv: &*self.kv,
                clock: &clock,
                pot_provider: self.pot_provider_url.as_deref(),
            },
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

impl PluginHost {
    /// Spawn one invocation on the runtime and deliver it to `deliver`
    /// on a worker thread — `deliver` returns a future so callers can
    /// offload blocking work with `spawn_blocking` instead of stalling
    /// a runtime worker.
    fn start_typed<F, Fut>(
        &self,
        plugin_id: String,
        capability: String,
        payload: Value,
        deliver: F,
    ) -> Result<String, HostError>
    where
        F: FnOnce(String, auqw_plugin_host::Invocation) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let plugin = {
            let plugins = lock(&self.plugins)?;
            match plugins.get(&plugin_id) {
                Some(p) => Arc::clone(p),
                None => return Err(HostError::UnknownPlugin { id: plugin_id }),
            }
        };
        // Session trust: the host-owned token is merged as a key, not a
        // value — absent slot means the payload passes untouched (a
        // caller-supplied key stays, e.g. a dev seam journey); a live
        // slot replaces it, so a stale caller value can't override the
        // app's current credential.
        let payload = if SESSION_TRUST_CAPABILITIES.contains(&capability.as_str()) {
            match self.auth_token.read().ok().and_then(|s| s.clone()) {
                Some(token) => {
                    let mut obj = payload.as_object().cloned().unwrap_or_default();
                    obj.insert("access_token".to_string(), json!(token));
                    Value::Object(obj)
                }
                None => payload,
            }
        } else {
            payload
        };
        let request_id = format!("req-{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let token = CancellationToken::new();
        lock(&self.cancels)?.insert(request_id.clone(), token.clone());
        let budgets = self.budgets.clone();
        let http = Arc::clone(&self.http);
        let kv = Arc::clone(&self.kv);
        let pot_provider = self.pot_provider_url.clone();
        let cancels = Arc::clone(&self.cancels);
        let rid = request_id.clone();
        self.runtime.spawn(async move {
            let clock = SystemClock;
            let invocation = invoke(
                &plugin,
                &capability,
                payload,
                &budgets,
                token,
                HostServices {
                    http: &*http,
                    kv: &*kv,
                    clock: &clock,
                    pot_provider: pot_provider.as_deref(),
                },
            )
            .await;
            deliver(rid.clone(), invocation).await;
            if let Ok(mut m) = cancels.lock() {
                m.remove(&rid);
            }
        });
        Ok(request_id)
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
        content_length: value.get("content_length").and_then(Value::as_u64),
        itag: value
            .get("itag")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok()),
    }
}

mod stream;
pub use stream::*;

#[cfg(test)]
mod tests {
    use super::*;
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
            "{{\"url\":\"https://127.0.0.1:{port}/a\",\"mime\":\"audio/mp4\",\"client\":\"IOS\"}}"
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
}
