//! The platform-neutral plugin-host surface.
//!
//! Everything the native shells reach for — plugin loading,
//! invocation outcomes, the stream-seam session surface, prepare
//! bookkeeping, cancellation — lives here once, as plain Rust. The
//! platform bindings are thin shims: `mobile-bindings` wraps it in
//! UniFFI records/callbacks for Kotlin/Swift, `node-bindings` wraps it
//! in napi-rs objects/promises for the Electron utility process.
//!
//! Boundary conventions both bindings keep:
//!
//! - Outcomes are delivered through a caller-supplied `deliver`
//!   closure invoked exactly once per request, on a runtime worker
//!   thread. The binding decides how delivery reaches its caller
//!   (UniFFI listener vs. resolving a promise).
//! - Request ids are caller-supplied: the UniFFI shim mints `req-N`,
//!   napi callers pass their own. A `cancel` tombstones only where a
//!   delivery race can exist — never-admitted ids (consumed at
//!   admission) and mid-flight prepares — so a cancelled generic
//!   request leaves nothing for a later generation to trip over
//!   (bounded: 64 tombstones, 60 s TTL).
//! - The URL inside [`ResolvedResource`] is a real signed stream URL —
//!   it must never be logged at any layer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock};
use std::time::Instant;

use auqw_plugin_host::{
    invoke, load, Attempt, Budgets, FileKeyValueStore, GuestLogEntry, HostServices, HttpTraceEntry,
    KeyValueStore, LoadedPlugin, Manifest, MemoryKeyValueStore, ReqwestClient, SystemClock,
};
use auqw_stream::{StreamConfig, StreamRegistry};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::runtime::Runtime;
use tokio_util::sync::CancellationToken;

/// Host-side budgets the app may tune; all other dimensions take
/// `Budgets::default()`.
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

/// Capabilities whose payloads reach InnerTube — the host-owned
/// `access_token` is merged into these at the `start_typed` funnel so
/// every path (seam resolve, prepare, generic `start_request`) carries
/// the same session trust.
const SESSION_TRUST_CAPABILITIES: &[&str] =
    &["playback.resolve", "playback.candidates", "radio.seed"];

/// A cancel tombstone only needs to outlive its race window — the
/// cancel-to-delivery gap is milliseconds; a minute is far past any
/// real delivery while still short enough that unconsumed tombstones
/// (a cancel that arrived on an id never admitted) can't pin the
/// cap forever.
const CANCEL_TOMBSTONE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// One HTTP call from the attempt trace. `url` is already stripped of
/// query and fragment by the host — the signed parameters never cross
/// this boundary.
#[derive(Clone)]
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
#[derive(Clone)]
pub struct GuestLogSummary {
    /// `debug` | `info` | `warn` | `error`.
    pub level: String,
    /// Redacted message text.
    pub message: String,
}

/// Per-invocation accounting for diagnostics.
#[derive(Clone)]
pub struct AttemptSummary {
    /// Caller-facing request id.
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
#[derive(Error, Debug)]
pub enum HostError {
    /// Artifact or manifest rejected at load.
    #[error("load: {detail}")]
    Load {
        /// Rejection detail.
        detail: String,
    },
    /// A request referenced an id that is not loaded.
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
    /// The caller-minted request id is still owned by a live
    /// invocation or an unreleased prepared session — ids must be
    /// unique while live or they corrupt cancellation and
    /// prepared-session ownership. Kept last: it was added after the
    /// original three, so stable discriminant order (Load, Unknown,
    /// Runtime) doesn't shift for stale generated decoders.
    #[error("request id {id} still in flight")]
    RequestInFlight {
        /// The colliding request id.
        id: String,
    },
}

/// Result of the fuel-gate measurement (spin conformance guest).
pub struct SpinReport {
    /// Wall-clock time until the trap.
    pub elapsed_ms: u64,
    /// Fuel consumed before the trap.
    pub fuel_used: u64,
    /// Terminal error kind (`budget-exceeded` expected).
    pub kind: String,
}

/// A request admitted through `start_typed`: its cancel token plus
/// whether it drives a `start_prepare`. Only prepares can leave a
/// mid-delivery handle-registration race, so `cancel` tombstones
/// prepares and never-admitted ids — a cancelled generic request
/// (resolve/request) has no handle to orphan and leaves no stone for
/// a later generation of the same id to trip over.
struct LiveRequest {
    token: CancellationToken,
    is_prepare: bool,
    /// Flipped right before `deliver` runs: a settled generic entry is
    /// re-admissible — the invocation ended, so its id is free even
    /// while the outcome callback is still on the wire. A settled
    /// prepare is NOT evictable: its delivery registers the
    /// `prepared_handles` slot that owns the id until release.
    settled: bool,
    /// Unique per admission — the post-delivery cleanup removes only
    /// the entry this task inserted, never a next generation that
    /// claimed the id mid-delivery.
    generation: u64,
}

/// A produced session slot in `prepared_handles`. `delivered` flips
/// once the `Prepared` outcome is on the wire: `cancel` releases a
/// delivered handle (the app cancelled an unattached session) but
/// waits out a mid-delivery one — the `Prepared` never names a
/// session that died before it arrived.
struct PreparedSlot {
    handle: String,
    delivered: bool,
}

/// Counts deliveries inside their insert→wire→flip window per
/// request id, so a `cancel` that finds a not-yet-delivered slot waits
/// only for its own request's delivery instead of every in-flight one
/// — an unrelated slow binding callback can't delay it.
/// `PreparedSlot { delivered: false }` always implies `in_flight > 0`
/// for that request's own delivery — the increment precedes the
/// insert — so `await_idle` lands strictly past the flip.
#[derive(Default)]
struct PrepareDelivery {
    in_flight: Mutex<HashMap<String, u64>>,
    done: Condvar,
}

impl PrepareDelivery {
    /// Enter the delivery window for `request_id`. The returned
    /// ticket decrements the count on drop, so a panic mid-callback
    /// can't strand waiters.
    fn track(&self, request_id: String) -> PrepareDeliveryTicket<'_> {
        if let Ok(mut m) = self.in_flight.lock() {
            *m.entry(request_id.clone()).or_insert(0) += 1;
        }
        PrepareDeliveryTicket {
            delivery: self,
            request_id,
        }
    }

    /// Block until `request_id` has no delivery inside its window.
    /// Poisoned locks degrade to "no wait" — a lost wakeup must not
    /// wedge `cancel`.
    fn await_idle(&self, request_id: &str) {
        let Ok(mut m) = self.in_flight.lock() else {
            return;
        };
        while m.get(request_id).copied().unwrap_or(0) > 0 {
            match self.done.wait(m) {
                Ok(guard) => m = guard,
                Err(_) => return,
            }
        }
    }
}

struct PrepareDeliveryTicket<'a> {
    delivery: &'a PrepareDelivery,
    request_id: String,
}

impl Drop for PrepareDeliveryTicket<'_> {
    fn drop(&mut self) {
        if let Ok(mut m) = self.delivery.in_flight.lock() {
            if let Some(n) = m.get_mut(&self.request_id) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    m.remove(&self.request_id);
                }
            }
            self.delivery.done.notify_all();
        }
    }
}

/// The plugin host object: owns a tokio runtime, an HTTP client, the
/// loaded plugin set, and per-request cancellation tokens.
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
    cancels: Arc<Mutex<HashMap<String, LiveRequest>>>,
    /// Per-admission generation counter — lets the post-delivery
    /// cleanup remove only the entry its own task inserted.
    request_generation: AtomicU64,
    /// `prepare` request id → produced session slot, so a
    /// `cancelPrepare` landing after `prepared` can abandon the session
    /// (only while still unattached AND already delivered — see
    /// `cancel` and [`PreparedSlot`]).
    prepared_handles: Arc<Mutex<HashMap<String, PreparedSlot>>>,
    /// `cancel` ids that arrived while the prepare was still inside
    /// its window — neither `cancels` nor `prepared_handles` knew it
    /// yet, or the invocation token was already spent while delivery
    /// was still registering the handle. The outcome path checks the
    /// tombstone before registering the handle so a late cancel can't
    /// orphan a live session. Tombstones expire — one never consumed
    /// by a delivery is swept on the next insert.
    cancelled_requests: Arc<Mutex<HashMap<String, Instant>>>,
    /// Delivery window gate — see [`PrepareDelivery`]. A `cancel`
    /// landing mid-delivery waits here for the flip, then releases
    /// synchronously. `deliver` closures must not call back into
    /// `cancel` for the in-flight request (Kotlin hops threads; a
    /// synchronous re-entry would wait on itself).
    prepared_delivery: Arc<PrepareDelivery>,
}

fn lock<T>(m: &Mutex<T>) -> Result<MutexGuard<'_, T>, HostError> {
    m.lock().map_err(|_| HostError::Runtime {
        detail: "lock poisoned".into(),
    })
}

/// The container values `playbackResolvePayload.prefer` permits
/// (enum `audio/webm`|`audio/mp4`, `maxItems: 2`, `uniqueItems`).
const PREFER_CONTAINERS: &[&str] = &["audio/webm", "audio/mp4"];

/// `access_token` contract bound — `minLength: 1`, `maxLength: 8192`.
const ACCESS_TOKEN_MAX_LEN: usize = 8192;

/// `prefer` arrives from the shell unchecked and is merged into the
/// invoke payload verbatim, so it is normalized once at intake:
/// filtered to the contract enum, deduplicated, capped at
/// `maxItems: 2`. An empty result means "no hint" — the key stays
/// absent rather than failing payload validation in the guest.
fn sanitize_prefer(prefer: Option<Vec<String>>) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for value in prefer.into_iter().flatten() {
        if out.len() == PREFER_CONTAINERS.len() {
            break;
        }
        if PREFER_CONTAINERS.contains(&value.as_str()) && !out.contains(&value) {
            out.push(value);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// An off-contract token (empty, or over `maxLength`) is worse than
/// none — it would fail payload validation in the guest — so it
/// clears the slot instead of being merged.
fn valid_auth_token(token: Option<String>) -> Option<String> {
    token.filter(|t| !t.is_empty() && t.chars().count() <= ACCESS_TOKEN_MAX_LEN)
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

impl PluginHost {
    /// Create a host with a two-worker tokio runtime.
    ///
    /// # Errors
    /// [`HostError::Runtime`] if the runtime or TLS backend cannot start.
    pub fn new(config: HostConfig) -> Result<Self, HostError> {
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
        Ok(Self {
            runtime,
            http: Arc::new(http),
            kv,
            budgets,
            pot_provider_url: config.pot_provider_url,
            prefer: sanitize_prefer(config.prefer),
            auth_token: Arc::new(RwLock::new(valid_auth_token(config.auth_token))),
            stream,
            plugins: Mutex::new(HashMap::new()),
            cancels: Arc::new(Mutex::new(HashMap::new())),
            request_generation: AtomicU64::new(0),
            prepared_handles: Arc::new(Mutex::new(HashMap::new())),
            cancelled_requests: Arc::new(Mutex::new(HashMap::new())),
            prepared_delivery: Arc::new(PrepareDelivery::default()),
        })
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
        if let Ok(mut slot) = self.auth_token.write() {
            *slot = valid_auth_token(token);
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

    /// Start a `playback.resolve` invocation on the runtime.
    /// `request_id` is caller-minted and passed back through `deliver`.
    ///
    /// # Errors
    /// [`HostError::UnknownPlugin`] if `plugin_id` was never loaded.
    pub fn start_resolve<F, Fut>(
        &self,
        plugin_id: String,
        source_ref: String,
        request_id: String,
        deliver: F,
    ) -> Result<(), HostError>
    where
        F: FnOnce(String, ResolveOutcome) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
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
            request_id,
            false,
            move |request_id, invocation| async move {
                let (result, attempt) = invocation.into_parts();
                let mut summary = AttemptSummary::from(&attempt);
                // The summary must join by the caller-facing id —
                // the inner `invoke-N` never leaves this closure.
                summary.request_id = request_id.clone();
                let outcome = match result {
                    // `done.result` is untyped past the boundary — a result
                    // missing a schema-required field is an invalid
                    // response, never Resolved.
                    Ok(value) => match resolve_resource_from(&value) {
                        Err(field) => ResolveOutcome::Failed {
                            kind: "invalid-response".to_string(),
                            message: format!("resolve result missing or invalid {field}"),
                            attempt: summary,
                        },
                        Ok(resource) => ResolveOutcome::Resolved {
                            resource,
                            attempt: summary,
                        },
                    },
                    Err(e) => ResolveOutcome::Failed {
                        kind: e.kind().to_string(),
                        message: e.to_string(),
                        attempt: summary,
                    },
                };
                deliver(request_id, outcome).await;
            },
        )
    }

    /// Start any declared capability with a JSON object payload. The
    /// outcome carries the raw `done.result` JSON.
    ///
    /// # Errors
    /// [`HostError::Runtime`] when `payload_json` is not a JSON object;
    /// [`HostError::UnknownPlugin`] for an unloaded `plugin_id`.
    pub fn start_request<F, Fut>(
        &self,
        plugin_id: String,
        capability: String,
        payload_json: String,
        request_id: String,
        deliver: F,
    ) -> Result<(), HostError>
    where
        F: FnOnce(String, RequestOutcome) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
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
            request_id,
            false,
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
                deliver(request_id, outcome).await;
            },
        )
    }

    /// Cancel an in-flight request. Tombstones exist only where a
    /// delivery race is possible: a mid-flight prepare (its `Prepared`
    /// can be registering while this cancel reads the maps) or an id
    /// that was never admitted (the cancel-before-start ordering,
    /// consumed at admission). A cancelled resolve/request has no
    /// handle to orphan, so its cancel leaves no stone for a later
    /// generation of the id. The TTL + 64-entry cap bound unconsumed
    /// tombstones. A `cancelPrepare` landing after `prepared`
    /// also abandons the produced session — but only while it is
    /// still unattached: a playing consumer is never cancelled out
    /// from under playback. And only once the `prepared` outcome is on
    /// the wire — a slot still mid-delivery is consumed but its handle
    /// left live, or the listener would get a `Prepared` naming a
    /// released session.
    pub fn cancel(&self, request_id: String) {
        let mut live_found = false;
        let mut live_was_prepare = false;
        // A settled generic entry is a completed request whose delivery
        // is still on the wire — a cancel now is indistinguishable from
        // one that landed before admission, but tombstoning it would
        // pre-cancel the NEXT generation of this id. Treat it as spent:
        // no token to spend, nothing to stone.
        let mut completed_generic = false;
        if let Ok(m) = self.cancels.lock() {
            if let Some(req) = m.get(&request_id) {
                if req.settled && !req.is_prepare {
                    completed_generic = true;
                } else {
                    req.token.cancel();
                    live_found = true;
                    live_was_prepare = req.is_prepare;
                }
            }
        }
        // Coalesced prepares hand one session handle to several
        // request ids — abandoning it is only safe once the cancelled
        // request was its last owner, or a surviving request's
        // `stream_open` would hit `cancelled`.
        let mut m = match self.prepared_handles.lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        if matches!(m.get(&request_id), Some(slot) if !slot.delivered) {
            // Mid-delivery: the slot is committed but its `Prepared`
            // is still en route to the listener. `Pending` strictly
            // implies this request's delivery is inside the counted
            // window, so idle ⇒ the flip ran (or the callback panicked
            // — released below the same way, since nothing saw it).
            // The map lock is dropped for the wait: the flip needs it.
            drop(m);
            self.prepared_delivery.await_idle(&request_id);
            match self.prepared_handles.lock() {
                Ok(again) => m = again,
                Err(_) => return,
            }
        }
        let slot = m.remove(&request_id);
        let delivered = slot.is_some();
        let handle = slot.and_then(|slot| {
            if m.values().any(|v| v.handle == slot.handle) {
                None
            } else {
                Some(slot.handle)
            }
        });
        drop(m);
        if let (Some(stream), Some(handle)) = (&self.stream, handle) {
            let _ = stream.cancel_if_unattached(&handle);
        }
        // Tombstone when no delivered handle was found AND a race
        // still exists: a never-admitted id (cancel-before-start),
        // or a live prepare whose `Prepared` is mid-registration.
        // A spent generic request (`live_found && !is_prepare`)
        // tombstones nothing — its delivery can't orphan a handle;
        // a settled generic (`completed_generic`) is already past
        // delivery-adjacent state and stoning it would poison the
        // next generation. Tombstones expire: arbitrary ids can't
        // fill the cap and starve a real race.
        if !delivered && !completed_generic && (!live_found || live_was_prepare) {
            if let Ok(mut m) = self.cancelled_requests.lock() {
                // Sweep expired tombstones before the cap check — a
                // stale set must not masquerade as a full one.
                let now = Instant::now();
                m.retain(|_, t| now.duration_since(*t) < CANCEL_TOMBSTONE_TTL);
                if m.len() < 64 {
                    m.insert(request_id, now);
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
                kv: Arc::clone(&self.kv),
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
    /// `is_prepare` also gates re-admission: a request flips
    /// `settled` right before `deliver` runs, and a settled GENERIC
    /// entry no longer blocks its id — the next admission evicts it,
    /// so a caller whose promise just settled may reuse the id
    /// immediately. A settled prepare keeps blocking: its delivery
    /// registers the `prepared_handles` ownership slot that then
    /// guards the id itself.
    fn start_typed<F, Fut>(
        &self,
        plugin_id: String,
        capability: String,
        payload: Value,
        request_id: String,
        is_prepare: bool,
        deliver: F,
    ) -> Result<(), HostError>
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
        let token = CancellationToken::new();
        // Caller-minted ids must be unique while live: a duplicate
        // would replace the first invocation's token (and, for
        // prepare, steal the earlier session's ownership slot) —
        // reject rather than corrupt. The `prepared_handles` check
        // runs before admission, never nested under `cancels`:
        // `prepared_handles` is only populated by a request whose
        // `cancels` entry still exists or has just been delivered, so
        // the atomic contains+insert below closes the race.
        {
            let mut m = lock(&self.prepared_handles)?;
            // A slot can outlive its registry entry once the
            // abandoned-session reaper evicts the stream — prune
            // slots whose sessions are no longer live first, or a
            // dead session still blocks the id's reuse.
            if let Some(stream) = &self.stream {
                m.retain(|_, s| stream.is_live(&s.handle));
            }
            if m.contains_key(&request_id) {
                return Err(HostError::RequestInFlight { id: request_id });
            }
        }
        let generation = {
            let mut m = lock(&self.cancels)?;
            // A settled generic entry no longer blocks its id — the
            // invocation ended; evict it so this generation owns the
            // id even while the previous outcome is still on the wire.
            if m.get(&request_id)
                .is_some_and(|r| r.settled && !r.is_prepare)
            {
                m.remove(&request_id);
            }
            if m.contains_key(&request_id) {
                return Err(HostError::RequestInFlight { id: request_id });
            }
            // Admission consumes a tombstone for this id: a cancel
            // that outran the bookkeeping still lands on the request
            // it was meant for (the token starts cancelled), but a
            // stone left by an earlier, settled generation can't
            // poison a later reuse — it dies with this admission.
            // An EXPIRED stone dies without cancelling: the TTL
            // bounds the race window, so it is honored on the consume
            // side too, not only on insert.
            if self
                .cancelled_requests
                .lock()
                .map(|mut c| {
                    c.remove(&request_id)
                        .is_some_and(|t| t.elapsed() < CANCEL_TOMBSTONE_TTL)
                })
                .unwrap_or(false)
            {
                token.cancel();
            }
            let generation = self.request_generation.fetch_add(1, Ordering::Relaxed);
            m.insert(
                request_id.clone(),
                LiveRequest {
                    token: token.clone(),
                    is_prepare,
                    settled: false,
                    generation,
                },
            );
            generation
        };
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
                    kv,
                    clock: &clock,
                    pot_provider: pot_provider.as_deref(),
                },
            )
            .await;
            // Settled before `deliver`: the invocation ended, so a
            // generic id is free even while its outcome is still on
            // the wire (admission evicts this entry). A prepare's
            // entry stays — its delivery registers the ownership
            // slot that then guards the id.
            if let Ok(mut m) = cancels.lock() {
                if let Some(req) = m.get_mut(&rid) {
                    req.settled = true;
                }
            }
            deliver(rid.clone(), invocation).await;
            // Generation-aware cleanup: remove only the entry this
            // task inserted — a next generation may already own the
            // id if this one was settled-generic and got evicted.
            if let Ok(mut m) = cancels.lock() {
                if m.get(&rid).is_some_and(|r| r.generation == generation) {
                    m.remove(&rid);
                }
            }
        });
        Ok(())
    }
}

/// Decode a `playbackResolveResult` object — the raw JSON is checked
/// against the full contract shape, not field-by-field leniency:
/// every required key must be present (nullable keys may carry `null`,
/// never an absent key), strings are nonempty, integers sit inside
/// their declared bounds, and unknown keys reject
/// (`additionalProperties: false`). `Err(field)` names the first
/// offending member; `"result"` means the value was not an object.
fn resolve_resource_from(value: &Value) -> Result<ResolvedResource, &'static str> {
    const KEYS: &[&str] = &[
        "url",
        "mime",
        "bitrate_kbps",
        "expires_at_ms",
        "client",
        "content_length",
        "itag",
    ];
    let o = value.as_object().ok_or("result")?;
    if o.keys().any(|k| !KEYS.contains(&k.as_str())) {
        return Err("additionalProperties");
    }
    let req_str = |key: &'static str| match o.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
        _ => Err(key),
    };
    // A required nullable integer: the key is present, and its value
    // is either null or an integer inside [min, max] — the schema's
    // declared bounds, which match the field widths this record uses.
    let req_int = |key: &'static str, min: u64, max: u64| match o.get(key) {
        None => Err(key),
        Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => match n.as_u64() {
            Some(v) if (min..=max).contains(&v) => Ok(Some(v)),
            _ => Err(key),
        },
        Some(_) => Err(key),
    };
    // An optional nullable integer: an absent key reads as null; a
    // present non-null value must satisfy the bound.
    let opt_int = |key: &'static str, min: u64, max: u64| match o.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => match n.as_u64() {
            Some(v) if (min..=max).contains(&v) => Ok(Some(v)),
            _ => Err(key),
        },
        Some(_) => Err(key),
    };
    Ok(ResolvedResource {
        url: req_str("url")?,
        mime: req_str("mime")?,
        bitrate_kbps: req_int("bitrate_kbps", 0, u64::from(u32::MAX))?.map(|v| v as u32),
        expires_at_ms: req_int("expires_at_ms", 0, u64::MAX)?,
        client: req_str("client")?,
        content_length: opt_int("content_length", 1, u64::MAX)?,
        itag: opt_int("itag", 0, u64::from(u32::MAX))?.map(|v| v as u32),
    })
}

mod stream;
pub use stream::*;

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

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
            // Fuel sized so a spin burn finishes in ~seconds: the
            // global entry-permit pool serializes guest entries to
            // the core count, and a cancelled entry detaches and
            // keeps burning while holding its permit — on a 2-core
            // runner two full-budget burns can queue a third well
            // past a 30 s outcome wait.
            fuel_per_entry: 20_000_000,
            fuel_total: 200_000_000,
            pot_provider_url: None,
            state_path: None,
            stream_path: None,
            prefer: None,
            auth_token: None,
        }
    }

    #[test]
    fn duplicate_inflight_request_id_is_rejected() {
        // Caller-minted ids must be unique while live: a duplicate
        // would replace the first invocation's cancel token and steal
        // any prepared-session ownership slot. The spin guest keeps
        // the first request in flight so the check is deterministic.
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let id = match host.load_plugin(SPIN_WASM.to_vec(), manifest_json("spin", SPIN_WASM, "[]"))
        {
            Ok(id) => id,
            Err(e) => panic!("load: {e}"),
        };
        let deliver = |_: String, _: ResolveOutcome| async move {};
        match host.start_resolve(id.clone(), "x".into(), "dup".into(), deliver) {
            Ok(()) => {}
            Err(e) => panic!("start: {e}"),
        }
        match host.start_resolve(id, "x".into(), "dup".into(), deliver) {
            Err(HostError::RequestInFlight { id }) => assert_eq!(id, "dup"),
            other => panic!("expected RequestInFlight, got {other:?}"),
        }
    }

    #[test]
    fn tombstoned_id_is_consumed_at_admission() {
        // A cancel that outran admission still lands on the request it
        // targeted — the token starts cancelled and the outcome reports
        // `cancelled`. But the tombstone is spent by that admission, so
        // a later reuse of the same id is clean (the spin guest then
        // burns through its fuel instead of reporting cancelled).
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let id = match host.load_plugin(SPIN_WASM.to_vec(), manifest_json("spin", SPIN_WASM, "[]"))
        {
            Ok(id) => id,
            Err(e) => panic!("load: {e}"),
        };
        let kind_of = |_: String, o: ResolveOutcome| match o {
            ResolveOutcome::Failed { kind, .. } => kind,
            ResolveOutcome::Resolved { .. } => "resolved".to_string(),
        };
        host.cancel("pre".to_string());
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        match host.start_resolve(id.clone(), "x".into(), "pre".into(), move |id, o| {
            let _ = tx.send(kind_of(id, o));
            async move {}
        }) {
            Ok(()) => {}
            Err(e) => panic!("start: {e}"),
        }
        let kind = match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(kind) => kind,
            Err(e) => panic!("outcome: {e}"),
        };
        assert_eq!(kind, "cancelled");
        // Same id again: no stone left, so this admission is clean.
        // The settled task removes its `cancels` slot a beat after the
        // outcome is delivered — retry past that cleanup window (the
        // same race `midflight_generic_cancel_leaves_no_tombstone`
        // retries past).
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let mut admitted = false;
        for _ in 0..50 {
            let tx = tx.clone();
            match host.start_resolve(id.clone(), "x".into(), "pre".into(), move |id, o| {
                let _ = tx.send(kind_of(id, o));
                async move {}
            }) {
                Ok(()) => {
                    admitted = true;
                    break;
                }
                Err(HostError::RequestInFlight { .. }) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => panic!("restart: {e}"),
            }
        }
        assert!(admitted, "second admission never landed");
        let kind = match rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(kind) => kind,
            Err(e) => panic!("outcome: {e}"),
        };
        assert_eq!(kind, "budget-exceeded");
    }

    #[test]
    fn expired_tombstone_does_not_precancel_admission() {
        // The TTL bounds the race window on the consume side too: a
        // stone older than the TTL must not pre-cancel the reused id —
        // admission still removes it, but the token starts fresh.
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let id = match host.load_plugin(SPIN_WASM.to_vec(), manifest_json("spin", SPIN_WASM, "[]"))
        {
            Ok(id) => id,
            Err(e) => panic!("load: {e}"),
        };
        match host.cancelled_requests.lock() {
            Ok(mut c) => {
                c.insert(
                    "stale".to_string(),
                    Instant::now() - std::time::Duration::from_secs(120),
                );
            }
            Err(e) => panic!("tombstones: {e}"),
        }
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        match host.start_resolve(id, "x".into(), "stale".into(), move |_id, o| {
            let kind = match o {
                ResolveOutcome::Failed { kind, .. } => kind,
                ResolveOutcome::Resolved { .. } => "resolved".to_string(),
            };
            let _ = tx.send(kind);
            async move {}
        }) {
            Ok(()) => {}
            Err(e) => panic!("start: {e}"),
        }
        let kind = match rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(kind) => kind,
            Err(e) => panic!("outcome: {e}"),
        };
        assert_eq!(kind, "budget-exceeded");
    }

    #[test]
    fn midflight_generic_cancel_leaves_no_tombstone() {
        // A cancel landing while a resolve is still in flight flips
        // its token — but a generic request has no handle to orphan,
        // so it must NOT tombstone: a later generation of the same id
        // runs its own course instead of starting pre-cancelled. The
        // spin guest keeps the first resolve in flight long enough
        // for the cancel to land deterministically.
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let id = match host.load_plugin(SPIN_WASM.to_vec(), manifest_json("spin", SPIN_WASM, "[]"))
        {
            Ok(id) => id,
            Err(e) => panic!("load: {e}"),
        };
        let kind_of = |_: String, o: ResolveOutcome| match o {
            ResolveOutcome::Failed { kind, .. } => kind,
            ResolveOutcome::Resolved { .. } => "resolved".to_string(),
        };
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        match host.start_resolve(id.clone(), "x".into(), "dup".into(), move |id, o| {
            let _ = tx.send(kind_of(id, o));
            async move {}
        }) {
            Ok(()) => {}
            Err(e) => panic!("start: {e}"),
        }
        host.cancel("dup".to_string());
        let kind = match rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(kind) => kind,
            Err(e) => panic!("outcome: {e}"),
        };
        assert_eq!(kind, "cancelled");
        // The settled task removes its `cancels` slot a beat after the
        // outcome is delivered — retry past that cleanup window, then
        // assert the reused id is not pre-cancelled by a leftover
        // tombstone.
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let mut admitted = false;
        for _ in 0..50 {
            let tx = tx.clone();
            match host.start_resolve(id.clone(), "x".into(), "dup".into(), move |id, o| {
                let _ = tx.send(kind_of(id, o));
                async move {}
            }) {
                Ok(()) => {
                    admitted = true;
                    break;
                }
                Err(HostError::RequestInFlight { .. }) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => panic!("restart: {e}"),
            }
        }
        assert!(admitted, "second admission never landed");
        let kind = match rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(kind) => kind,
            Err(e) => panic!("outcome: {e}"),
        };
        assert_eq!(kind, "budget-exceeded");
    }

    #[test]
    fn settled_generic_id_is_readmissible_and_cleanup_is_generation_aware() {
        // Contract: once a generic invocation ends, its id is free —
        // a caller whose outcome just settled may reuse it while the
        // previous delivery is still on the wire. The old generation's
        // post-delivery cleanup must then not delete the NEW entry
        // (that would strand a live request: uncancellable, and a
        // third generation could double-admit).
        let host = match PluginHost::new(config()) {
            Ok(h) => h,
            Err(e) => panic!("host: {e}"),
        };
        let id = match host.load_plugin(SPIN_WASM.to_vec(), manifest_json("spin", SPIN_WASM, "[]"))
        {
            Ok(id) => id,
            Err(e) => panic!("load: {e}"),
        };
        let kind_of = |_: String, o: ResolveOutcome| match o {
            ResolveOutcome::Failed { kind, .. } => kind,
            ResolveOutcome::Resolved { .. } => "resolved".to_string(),
        };
        // Gen A: its delivery parks on a gate so `settled` is already
        // flipped while the callback is still mid-wire.
        let (tx_a, rx_a) = std::sync::mpsc::channel::<String>();
        let (gate_tx, gate_rx) = std::sync::mpsc::channel::<()>();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        match host.start_resolve(id.clone(), "x".into(), "gen".into(), move |id, o| {
            let _ = tx_a.send(kind_of(id, o));
            async move {
                let _ = gate_rx.recv_timeout(std::time::Duration::from_secs(60));
                let _ = done_tx.send(());
            }
        }) {
            Ok(()) => {}
            Err(e) => panic!("start A: {e}"),
        }
        match rx_a.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(_) => {}
            Err(e) => panic!("gen A outcome: {e}"),
        }

        // A cancel landing while A's delivery is still parked targets
        // a COMPLETED request — it must not tombstone the id, or the
        // next generation would start pre-cancelled.
        host.cancel("gen".to_string());

        // A's delivery is still parked on the gate — yet the id must
        // already admit a new generation.
        let (tx_b, rx_b) = std::sync::mpsc::channel::<String>();
        match host.start_resolve(id.clone(), "x".into(), "gen".into(), move |id, o| {
            let _ = tx_b.send(kind_of(id, o));
            async move {}
        }) {
            Ok(()) => {}
            Err(e) => panic!("re-admission of a settled id: {e}"),
        }

        // Let A's delivery finish; its cleanup must leave B's entry.
        let _ = gate_tx.send(());
        match done_rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(()) => {}
            Err(e) => panic!("gen A delivery: {e}"),
        }
        // The cleanup runs right after the deliver future returns —
        // yield a beat so it can commit (or, on a regression, erase B).
        std::thread::sleep(std::time::Duration::from_millis(200));

        // A third generation must still hit `RequestInFlight` — B's
        // entry is live and unsettled. If A's cleanup erased it, this
        // admission would double-admit on a burning request.
        let deliver = |_: String, _: ResolveOutcome| async move {};
        match host.start_resolve(id.clone(), "x".into(), "gen".into(), deliver) {
            Err(HostError::RequestInFlight { id }) => assert_eq!(id, "gen"),
            other => panic!("expected RequestInFlight for third generation, got {other:?}"),
        }

        // B is live: cancel must find ITS entry — under an
        // unconditional removal it would already be gone. And since
        // the parked-delivery cancel left no tombstone, B ran as a
        // normal generation until now.
        host.cancel("gen".to_string());
        let kind = match rx_b.recv_timeout(std::time::Duration::from_secs(60)) {
            Ok(kind) => kind,
            Err(e) => panic!("gen B outcome: {e}"),
        };
        assert_eq!(kind, "cancelled");
    }

    #[test]
    fn prefer_config_is_normalized_to_the_contract() {
        // The merged `prefer` must satisfy the contract enum,
        // `uniqueItems`, and `maxItems: 2` — off-contract entries are
        // dropped and an empty result stays absent.
        assert_eq!(sanitize_prefer(None), None);
        assert_eq!(sanitize_prefer(Some(vec![])), None);
        assert_eq!(sanitize_prefer(Some(vec!["video/mp4".to_string()])), None);
        assert_eq!(
            sanitize_prefer(Some(vec![
                "audio/mp4".to_string(),
                "audio/ogg".to_string(),
                "audio/mp4".to_string(),
                "audio/webm".to_string(),
                "audio/mp4".to_string(),
            ])),
            Some(vec!["audio/mp4".to_string(), "audio/webm".to_string()])
        );
    }

    #[test]
    fn off_contract_auth_tokens_clear_the_slot() {
        assert_eq!(valid_auth_token(None), None);
        assert_eq!(valid_auth_token(Some(String::new())), None);
        assert_eq!(valid_auth_token(Some("x".repeat(8193))), None);
        assert_eq!(
            valid_auth_token(Some("tok".to_string())),
            Some("tok".to_string())
        );
        let max = "x".repeat(8192);
        assert_eq!(valid_auth_token(Some(max.clone())), Some(max));
    }
}
