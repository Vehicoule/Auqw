//! Artifact loading and the per-invocation step loop.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::Digest;
use tokio_util::sync::CancellationToken;
use wasmi::{
    Config, Engine, ExternType, Linker, Module, Store, StoreLimits, StoreLimitsBuilder, TrapCode,
    TypedFunc, ValType, WasmParams, WasmResults,
};

use crate::attempt::{Attempt, GuestLogEntry, HttpTraceEntry};
use crate::budgets::{BudgetDimension, Budgets};
use crate::error::{HttpErrorKind, InvokeError, KvError, LoadError, GUEST_FAIL_KINDS};
use crate::http::HttpRequest;
use crate::kv::{MAX_KV_KEY_BYTES, MAX_KV_NAMESPACE_BYTES, MAX_KV_VALUE_BYTES};
use crate::manifest::Manifest;
use crate::redact::{redact_text, redact_url};
use crate::services::HostServices;
use crate::{ABI_VERSION, SUPPORTED_ABI_VERSIONS};

/// Largest guest→host step message accepted (1 MiB).
const MAX_GUEST_MESSAGE_BYTES: usize = 1024 * 1024;

/// Guest `log` message cap, in UTF-8 bytes.
const MAX_LOG_MESSAGE_BYTES: usize = 4096;
/// Guest `log` entries stored per invocation.
const MAX_GUEST_LOG_ENTRIES: usize = 128;
/// Levels a guest `log` request may use.
const LOG_LEVELS: &[&str] = &["debug", "info", "warn", "error"];

/// Header names an `http_request` may not set (matched
/// ASCII-case-insensitively): `Host` must come from the authorized URL,
/// never the guest, and the rest are hop-by-hop or body-framing fields
/// the client computes itself.
const HOST_OWNED_HEADERS: &[&str] = &[
    "connection",
    "content-length",
    "expect",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
];

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Host-side state for one Wasmi store.
struct HostState {
    limits: StoreLimits,
}

/// A validated plugin artifact ready for invocation.
///
/// Loading performs every cheap rejection: size cap, digest pin, ABI
/// version, zero imports, no start section, required exports with exact
/// signatures, and `wasmi` validation.
pub struct LoadedPlugin {
    engine: Engine,
    module: Module,
    manifest: Manifest,
    digest: String,
}

impl std::fmt::Debug for LoadedPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadedPlugin")
            .field("id", &self.manifest.id)
            .field("version", &self.manifest.version)
            .field("digest", &self.digest)
            .finish_non_exhaustive()
    }
}

impl LoadedPlugin {
    /// The validated manifest.
    #[must_use]
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// The `sha256:<hex>` digest of the artifact bytes.
    #[must_use]
    pub fn digest(&self) -> &str {
        &self.digest
    }
}

/// Validate `wasm` against `manifest` and `budgets`, returning a plugin
/// ready for [`invoke`].
///
/// # Errors
/// Returns [`LoadError`] for any contract or policy violation.
pub fn load(wasm: &[u8], manifest: Manifest, budgets: &Budgets) -> Result<LoadedPlugin, LoadError> {
    // A programmatically built manifest never passed through
    // `from_json`'s grammar check — `network:*.` would otherwise reach
    // the allowlist matcher and bless any trailing-dot host.
    manifest.validate()?;
    if wasm.len() > budgets.max_artifact_bytes {
        return Err(LoadError::ArtifactTooLarge {
            max: budgets.max_artifact_bytes,
            actual: wasm.len(),
        });
    }
    if !SUPPORTED_ABI_VERSIONS.contains(&manifest.abi.as_str()) {
        return Err(LoadError::AbiMismatch {
            manifest: manifest.abi.clone(),
            host: ABI_VERSION,
        });
    }
    let digest = format!("sha256:{}", hex_sha256(wasm));
    if manifest.artifact.digest != digest {
        return Err(LoadError::DigestMismatch {
            expected: manifest.artifact.digest.clone(),
            actual: digest,
        });
    }
    check_module_shape(wasm, budgets)?;
    let mut config = Config::default();
    config.consume_fuel(true);
    let engine = Engine::new(&config);
    let module = Module::new(&engine, wasm).map_err(|e| LoadError::Malformed(e.to_string()))?;
    check_exports(&module)?;
    Ok(LoadedPlugin {
        engine,
        module,
        manifest,
        digest,
    })
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = sha2::Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Zero-import, no-start-section, and declared-resource checks via
/// `wasmparser`. The store limiter only bites at instantiation — a
/// module that declares two memories or a 4 GiB minimum would pass
/// `load` and then `guest-trap` on every invoke; reject it here as a
/// load error so the artifact pipeline sees the real verdict.
fn check_module_shape(wasm: &[u8], budgets: &Budgets) -> Result<(), LoadError> {
    use wasmparser::Payload;
    let mut memories = 0u32;
    let mut tables = 0u32;
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        let payload = payload.map_err(|e| LoadError::Malformed(e.to_string()))?;
        match payload {
            Payload::ImportSection(reader) => {
                let count = reader.count() as usize;
                if count > 0 {
                    return Err(LoadError::ImportsDeclared { count });
                }
            }
            Payload::StartSection { .. } => return Err(LoadError::StartSection),
            Payload::MemorySection(reader) => {
                for mem in reader {
                    let mem = mem.map_err(|e| LoadError::Malformed(e.to_string()))?;
                    memories += 1;
                    let page_bytes = 1u64 << mem.page_size_log2.unwrap_or(16);
                    let min_bytes = mem.initial.saturating_mul(page_bytes);
                    if mem.memory64 || min_bytes > budgets.max_memory_bytes as u64 {
                        return Err(LoadError::ExceedsLimits(format!(
                            "memory minimum {min_bytes} bytes exceeds {}",
                            budgets.max_memory_bytes
                        )));
                    }
                }
            }
            Payload::TableSection(reader) => {
                for table in reader {
                    let table = table.map_err(|e| LoadError::Malformed(e.to_string()))?;
                    tables += 1;
                    // The element cap is per-table — the same bound the
                    // store applies — so summing across tables would
                    // reject artifacts that are within policy.
                    if table.ty.initial > budgets.max_table_elements as u64 {
                        return Err(LoadError::ExceedsLimits(format!(
                            "table declares {} elements; per-table cap is {}",
                            table.ty.initial, budgets.max_table_elements
                        )));
                    }
                }
            }
            _ => {}
        }
    }
    if memories > 1 {
        return Err(LoadError::ExceedsLimits(format!(
            "module declares {memories} memories; ABI allows 1"
        )));
    }
    if tables > 16 {
        return Err(LoadError::ExceedsLimits(format!(
            "module declares {tables} tables; the store caps at 16"
        )));
    }
    Ok(())
}

/// Required exports with exact signatures.
fn check_exports(module: &Module) -> Result<(), LoadError> {
    let mut memory_ok = false;
    let mut alloc_ok = false;
    let mut handle_ok = false;
    for export in module.exports() {
        match (export.name(), export.ty()) {
            ("memory", ExternType::Memory(_)) => memory_ok = true,
            ("alloc", ExternType::Func(ft)) => {
                alloc_ok = ft.params() == [ValType::I32] && ft.results() == [ValType::I32];
            }
            ("handle", ExternType::Func(ft)) => {
                handle_ok =
                    ft.params() == [ValType::I32, ValType::I32] && ft.results() == [ValType::I64];
            }
            _ => {}
        }
    }
    if !memory_ok {
        return Err(LoadError::BadExport { name: "memory" });
    }
    if !alloc_ok {
        return Err(LoadError::BadExport { name: "alloc" });
    }
    if !handle_ok {
        return Err(LoadError::BadExport { name: "handle" });
    }
    Ok(())
}

/// The outcome of one invocation: the typed result plus accounting.
///
/// `attempt` is populated on both success and failure paths.
pub struct Invocation {
    /// `Ok` with the capability result value, or the typed failure.
    pub result: Result<Value, InvokeError>,
    /// Per-invocation accounting.
    pub attempt: Attempt,
}

impl Invocation {
    /// Split into the bare `Result` and the [`Attempt`].
    pub fn into_parts(self) -> (Result<Value, InvokeError>, Attempt) {
        (self.result, self.attempt)
    }
}

/// Read-only per-invocation context shared by every step.
struct StepCtx<'a> {
    plugin: &'a LoadedPlugin,
    budgets: &'a Budgets,
    cancel: &'a CancellationToken,
    services: HostServices<'a>,
    started: Instant,
}

/// Invoke `capability` on a loaded plugin with the ABI v0 step loop.
///
/// A fresh Wasmi instance is created per invocation; guest state lives
/// only in that instance's linear memory for the duration of the call.
/// `services.pot_provider` is the base URL of a bgutil-compatible
/// PO-token service (`POST {provider}/get_pot`); `None` makes `pot_token`
/// host requests answer `unsupported`. Empty or whitespace-only values
/// normalize to `None` here so every shell boundary behaves the same.
pub async fn invoke(
    plugin: &LoadedPlugin,
    capability: &str,
    payload: Value,
    budgets: &Budgets,
    cancel: CancellationToken,
    services: HostServices<'_>,
) -> Invocation {
    let started = Instant::now();
    let pot_provider = services
        .pot_provider
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let mut attempt = Attempt {
        request_id: format!("invoke-{}", REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)),
        steps: 0,
        http_calls: 0,
        bytes: 0,
        fuel_used: 0,
        elapsed: std::time::Duration::ZERO,
        http_trace: Vec::new(),
        guest_log: Vec::new(),
        secrets: Vec::new(),
    };
    let ctx = StepCtx {
        plugin,
        budgets,
        cancel: &cancel,
        services: HostServices {
            pot_provider,
            ..services
        },
        started,
    };
    let result = run(&ctx, capability, payload, &mut attempt).await;
    attempt.elapsed = started.elapsed();
    Invocation { result, attempt }
}

async fn run(
    ctx: &StepCtx<'_>,
    capability: &str,
    payload: Value,
    attempt: &mut Attempt,
) -> Result<Value, InvokeError> {
    if !ctx
        .plugin
        .manifest
        .capabilities
        .iter()
        .any(|c| c == capability)
    {
        return Err(InvokeError::CapabilityNotDeclared(capability.to_string()));
    }
    // Token material the host merged into the payload must never echo
    // back into logs or errors — seed the redaction set before the
    // guest speaks.
    if let Some(token) = payload
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        // No length floor: a short token is still credential material,
        // and the no-secrets-in-logs rule outranks log legibility.
        attempt.secrets.push(token.to_string());
    }
    // The namespace snapshot is staged for the whole invocation; on a
    // valid `done` only the staged patch commits — every other
    // terminal path drops it. A file-backed store does a blocking
    // read+parse here — hand it to the blocking pool so a runtime
    // worker never stalls on fs I/O.
    let staged_base = if ctx.plugin.manifest.allows_kv() {
        let kv = Arc::clone(&ctx.services.kv);
        let plugin_id = ctx.plugin.manifest.id.clone();
        tokio::task::spawn_blocking(move || kv.snapshot(&plugin_id))
            .await
            .map_err(|e| InvokeError::HostService(format!("kv worker: {e}")))?
            .map_err(|e| InvokeError::HostService(e.to_string()))?
    } else {
        BTreeMap::new()
    };
    let mut staged_kv = StagedKv::new(staged_base);
    let limits = StoreLimitsBuilder::new()
        .memory_size(ctx.budgets.max_memory_bytes)
        .table_elements(ctx.budgets.max_table_elements)
        // ABI v0 shape: one instance, one linear memory, a handful of
        // indirect-call tables. These counts are structural caps, not
        // budgets — a module needing more is out of contract.
        .instances(1)
        .memories(1)
        .tables(16)
        .build();
    let mut store = Store::new(&ctx.plugin.engine, HostState { limits });
    store.limiter(|s| &mut s.limits);
    let linker = Linker::new(&ctx.plugin.engine);
    let instance = linker
        .instantiate_and_start(&mut store, &ctx.plugin.module)
        .map_err(|e| InvokeError::GuestTrap(e.to_string()))?;
    let alloc: TypedFunc<u32, u32> = instance
        .get_typed_func(&store, "alloc")
        .map_err(|e| InvokeError::GuestTrap(e.to_string()))?;
    let handle: TypedFunc<(u32, u32), u64> = instance
        .get_typed_func(&store, "handle")
        .map_err(|e| InvokeError::GuestTrap(e.to_string()))?;
    let memory = instance
        .get_memory(&store, "memory")
        .ok_or_else(|| InvokeError::InvalidMessage("no memory export".into()))?;

    let mut input = serde_json::to_vec(&json!({
        "type": "invoke",
        "request_id": attempt.request_id,
        "capability": capability,
        "payload": payload,
    }))
    .map_err(|e| InvokeError::InvalidMessage(e.to_string()))?;

    loop {
        check_preemption(ctx)?;
        if attempt.steps >= ctx.budgets.max_steps {
            return Err(InvokeError::BudgetExceeded {
                dimension: BudgetDimension::Steps,
            });
        }
        let len = u32::try_from(input.len())
            .map_err(|_| InvokeError::InvalidMessage("step input exceeds u32".into()))?;
        let (s, ptr) = call_entry(store, alloc, len, ctx, attempt).await?;
        store = s;
        if len > 0 && ptr == 0 {
            return Err(InvokeError::InvalidMessage("alloc returned null".into()));
        }
        memory
            .write(&mut store, ptr as usize, &input)
            .map_err(|_| InvokeError::InvalidMessage("alloc buffer out of bounds".into()))?;
        // `alloc` and `handle` are separate entries — the token and the
        // deadline are checked before each, not just at the loop top.
        check_preemption(ctx)?;
        let (s, packed) = call_entry(store, handle, (ptr, len), ctx, attempt).await?;
        store = s;
        attempt.steps += 1;
        // A cancellation or deadline that lands while the guest runs
        // preempts the entry itself: `call_entry` detaches it at the
        // remaining deadline (fuel still bounds the background burn)
        // and the outcome is reported as cancelled/deadline-exceeded —
        // the caller's intent wins over a result it no longer wants.
        check_preemption(ctx)?;
        let out_ptr = usize::try_from(packed >> 32)
            .map_err(|_| InvokeError::InvalidMessage("response pointer overflow".into()))?;
        let out_len = usize::try_from(packed & 0xFFFF_FFFF)
            .map_err(|_| InvokeError::InvalidMessage("response length overflow".into()))?;
        if out_len > MAX_GUEST_MESSAGE_BYTES {
            return Err(InvokeError::InvalidMessage(format!(
                "guest response {out_len} bytes exceeds {MAX_GUEST_MESSAGE_BYTES} cap"
            )));
        }
        let mut buf = vec![0u8; out_len];
        memory
            .read(&store, out_ptr, &mut buf)
            .map_err(|_| InvokeError::InvalidMessage("response pointer out of bounds".into()))?;
        let msg: Value = serde_json::from_slice(&buf)
            .map_err(|e| InvokeError::InvalidMessage(format!("response is not JSON: {e}")))?;

        match msg.get("type").and_then(Value::as_str) {
            Some("done") => {
                check_keys(&msg, &["type", "result"], "done", &attempt.secrets)?;
                // `result` is required by the schema — its absence is a
                // malformed message, not a null result.
                let result = msg
                    .get("result")
                    .cloned()
                    .ok_or_else(|| InvokeError::InvalidMessage("done.result missing".into()))?;
                // A result `url` is the fetch target the caller will open
                // on the plugin's behalf; it must be an https destination
                // the manifest already permits — same policy as the
                // guest's own requests, no trust by origin.
                if let Some(url) = result.get("url") {
                    let permitted = url
                        .as_str()
                        .is_some_and(|u| ctx.plugin.manifest.allows_destination(u));
                    if !permitted {
                        return Err(InvokeError::InvalidMessage(
                            "done.result.url is not an allowed destination".into(),
                        ));
                    }
                }
                // A cancel landing in the commit's fsync+rename window
                // must not commit — check once more on the doorstep.
                check_preemption(ctx)?;
                // The result survived every check — only now does the
                // staged patch apply against the committed namespace.
                // Committing means the fsync+rename chain of a
                // file-backed store — offloaded for the same reason as
                // the snapshot above.
                if ctx.plugin.manifest.allows_kv() && staged_kv.has_writes() {
                    let kv = Arc::clone(&ctx.services.kv);
                    let plugin_id = ctx.plugin.manifest.id.clone();
                    let writes = staged_kv.writes();
                    let token = ctx.cancel.clone();
                    // The cancel token is the commit's admission gate:
                    // the store evaluates it under its write lock on
                    // the doorstep of publication, so a cancel can
                    // never be beaten by a commit it should have
                    // stopped — the two are one critical section.
                    let outcome = tokio::task::spawn_blocking(move || {
                        kv.commit_admitting(&plugin_id, writes, &move || !token.is_cancelled())
                    })
                    .await
                    .map_err(|e| InvokeError::HostService(format!("kv worker: {e}")))?;
                    match outcome {
                        // Admission declined = the cancel won before
                        // publication — report cancelled, not a host error.
                        Err(KvError::Rejected(_)) => return Err(InvokeError::Cancelled),
                        Err(e) => return Err(InvokeError::HostService(e.to_string())),
                        Ok(()) => check_preemption(ctx)?,
                    }
                }
                return Ok(result);
            }
            Some("fail") => {
                check_keys(&msg, &["type", "error"], "fail", &attempt.secrets)?;
                let error = &msg["error"];
                check_keys(error, &["kind", "message"], "fail.error", &attempt.secrets)?;
                let kind = error
                    .get("kind")
                    .and_then(Value::as_str)
                    .ok_or_else(|| InvokeError::InvalidMessage("fail.error.kind missing".into()))?;
                if !GUEST_FAIL_KINDS.contains(&kind) {
                    return Err(InvokeError::InvalidMessage(format!(
                        "fail.error.kind {:?} is not in the ABI taxonomy",
                        redact_text(kind, &attempt.secrets)
                    )));
                }
                // Guest-controlled text: a message can quote a signed
                // URL the guest legitimately saw — redact before it can
                // reach a log or the caller's error surface.
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        InvokeError::InvalidMessage("fail.error.message missing".into())
                    })?;
                return Err(InvokeError::GuestFail {
                    kind: kind.to_string(),
                    message: redact_text(message, &attempt.secrets),
                });
            }
            Some("host_request") => {
                input = host_request_step(&msg, ctx, attempt, &mut staged_kv).await?;
            }
            _ => {
                return Err(InvokeError::InvalidMessage(format!(
                    "unknown message type in guest output: {}",
                    redact_text(&msg.to_string(), &attempt.secrets)
                )));
            }
        }
    }
}

/// The schema marks every step-message object `additionalProperties:
/// false` — an unknown key is a protocol violation, not trivia to skip.
///
/// A key name is guest-controlled text reaching an error surface, so it
/// is redacted with the attempt's token material like every other one —
/// a guest that names a key after a secret must not write that secret
/// into diagnostics.
fn check_keys(
    obj: &Value,
    allowed: &[&str],
    what: &str,
    secrets: &[String],
) -> Result<(), InvokeError> {
    let Some(map) = obj.as_object() else {
        return Err(InvokeError::InvalidMessage(format!(
            "{what} must be an object"
        )));
    };
    for key in map.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(InvokeError::InvalidMessage(format!(
                "{what}.{} is not in the ABI schema",
                redact_text(key, secrets)
            )));
        }
    }
    Ok(())
}

/// The caller-side preemption check: cancellation first (intent), then
/// the wall-clock deadline. Runs before every guest entry and once more
/// after `handle` returns, so a cancel/expiry that landed while the
/// guest ran is still the reported outcome.
fn check_preemption(ctx: &StepCtx<'_>) -> Result<(), InvokeError> {
    if ctx.cancel.is_cancelled() {
        return Err(InvokeError::Cancelled);
    }
    if ctx.started.elapsed() >= ctx.budgets.deadline {
        return Err(InvokeError::BudgetExceeded {
            dimension: BudgetDimension::Deadline,
        });
    }
    Ok(())
}

/// Global bound on concurrently-executing guest entries. Wasmi cannot
/// preempt a running `call`, so a deadline/cancel expiry leaves a
/// detached `spawn_blocking` task burning its fuel grant. Without a
/// bound, repeated timeouts would pile detached CPU work onto the
/// shared blocking pool; permits sized to `available_parallelism` keep
/// the zombie count at the CPU budget.
fn entry_permits() -> &'static tokio::sync::Semaphore {
    static PERMITS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    PERMITS.get_or_init(|| {
        let n = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        tokio::sync::Semaphore::new(n.max(2))
    })
}

/// Enter a guest export with fuel accounting and a wall-clock cap.
/// Per-entry fuel is the smaller of `fuel_per_entry` and the remaining
/// total; an out-of-fuel trap maps to `BudgetExceeded { Fuel }`.
///
/// Wasmi cannot preempt a running entry mid-call, and fuel is a
/// CPU-work bound, not a time bound — a slow interpreter holds the
/// caller until fuel-out. The call therefore runs on the blocking pool
/// under `remaining-deadline` (and races the cancel token): on expiry
/// the entry detaches — fuel still bounds its background burn — and the
/// invocation reports `deadline`/`cancelled` at the deadline rather
/// than at guest completion. Fuel booked on a detach is the full grant:
/// the entry may still be consuming it where the caller can't see.
async fn call_entry<P, R>(
    mut store: Store<HostState>,
    func: TypedFunc<P, R>,
    params: P,
    ctx: &StepCtx<'_>,
    attempt: &mut Attempt,
) -> Result<(Store<HostState>, R), InvokeError>
where
    P: WasmParams + Send + 'static,
    R: WasmResults + Send + 'static,
{
    let budgets = ctx.budgets;
    let allowance = budgets
        .fuel_per_entry
        .min(budgets.fuel_total.saturating_sub(attempt.fuel_used));
    if allowance == 0 {
        return Err(InvokeError::BudgetExceeded {
            dimension: BudgetDimension::Fuel,
        });
    }
    store
        .set_fuel(allowance)
        .map_err(|e| InvokeError::GuestTrap(e.to_string()))?;
    // A deadline/cancel expiry detaches the spawn_blocking task — wasmi
    // has no mid-call interrupt, so the guest keeps burning its fuel
    // grant in the background. A global permit pool bounds that
    // detached burn — but queueing for a permit is itself wall-clock
    // work, so the wait races the same deadline: an expired waiter
    // reports Deadline instead of starting a call the caller already
    // gave up on.
    let deadline_at = tokio::time::Instant::from_std(ctx.started + budgets.deadline);
    let permit = tokio::select! {
        biased;
        () = ctx.cancel.cancelled() => return Err(InvokeError::Cancelled),
        () = tokio::time::sleep_until(deadline_at) => {
            return Err(InvokeError::BudgetExceeded {
                dimension: BudgetDimension::Deadline,
            });
        }
        p = entry_permits().acquire() => {
            p.map_err(|_| InvokeError::GuestTrap("entry permits closed".to_string()))?
        }
    };
    // A permit may arrive in the same instant the deadline crossed —
    // re-check so no guest entry starts past its deadline.
    let remaining = budgets.deadline.saturating_sub(ctx.started.elapsed());
    if remaining.is_zero() {
        return Err(InvokeError::BudgetExceeded {
            dimension: BudgetDimension::Deadline,
        });
    }
    let join = tokio::task::spawn_blocking(move || {
        // Held until the call returns — a detached task still counts.
        let _permit = permit;
        let result = func.call(&mut store, params);
        (store, result)
    });
    tokio::select! {
        // Cancel outranks expiry — same ordering as `check_preemption`.
        biased;
        () = ctx.cancel.cancelled() => {
            attempt.fuel_used += allowance;
            Err(InvokeError::Cancelled)
        }
        outcome = tokio::time::timeout(remaining, join) => match outcome {
            Err(_elapsed) => {
                attempt.fuel_used += allowance;
                Err(InvokeError::BudgetExceeded {
                    dimension: BudgetDimension::Deadline,
                })
            }
            Ok(Err(join_err)) => Err(InvokeError::GuestTrap(join_err.to_string())),
            Ok(Ok((store, result))) => {
                let fuel_remaining = store.get_fuel().unwrap_or(0);
                attempt.fuel_used += allowance.saturating_sub(fuel_remaining);
                match result {
                    Ok(value) => Ok((store, value)),
                    Err(e) if e.as_trap_code() == Some(TrapCode::OutOfFuel) => {
                        Err(InvokeError::BudgetExceeded {
                            dimension: BudgetDimension::Fuel,
                        })
                    }
                    Err(e) => Err(InvokeError::GuestTrap(e.to_string())),
                }
            }
        },
    }
}

/// Handle one `host_request` step and produce the next `handle` input.
async fn host_request_step(
    msg: &Value,
    ctx: &StepCtx<'_>,
    attempt: &mut Attempt,
    staged_kv: &mut StagedKv,
) -> Result<Vec<u8>, InvokeError> {
    check_keys(
        msg,
        &["type", "id", "kind", "payload"],
        "host_request",
        &attempt.secrets,
    )?;
    let id = msg
        .get("id")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| InvokeError::InvalidMessage("host_request.id missing".into()))?;
    // Host-local kinds never reach the HTTP counters; they still cost
    // the step that carried them. A 0.1 manifest predates the 0.2
    // service kinds — emitting one is a protocol violation, not a
    // permission question.
    match msg.get("kind").and_then(Value::as_str) {
        Some(kind)
            if ctx.plugin.manifest.abi == "0.1.0"
                && matches!(kind, "kv_get" | "kv_set" | "log" | "now_ms") =>
        {
            return Err(InvokeError::InvalidMessage(format!(
                "host_request kind {:?} requires ABI 0.2.0",
                redact_text(kind, &attempt.secrets)
            )));
        }
        // `resume` is the 0.3.0 service kind — an older manifest is an
        // immutable contract and cannot grow host services either.
        Some("resume") if ctx.plugin.manifest.abi != "0.3.0" => {
            return Err(InvokeError::InvalidMessage(
                "host_request kind \"resume\" requires ABI 0.3.0".into(),
            ));
        }
        _ => {}
    }
    match msg.get("kind").and_then(Value::as_str) {
        Some("kv_get") => {
            return kv_get_step(&msg["payload"], id, ctx, staged_kv, &attempt.secrets);
        }
        Some("kv_set") => {
            return kv_set_step(&msg["payload"], id, ctx, staged_kv, &attempt.secrets);
        }
        Some("log") => return log_step(&msg["payload"], id, attempt),
        Some("now_ms") => return now_ms_step(&msg["payload"], id, ctx, &attempt.secrets),
        _ => {}
    }
    let authorized = match msg.get("kind").and_then(Value::as_str) {
        Some("http_request") => authorize_http_request(&msg["payload"], id, ctx, &attempt.secrets)?,
        Some("pot_token") => authorize_pot_token(&msg["payload"], id, ctx, &attempt.secrets)?,
        Some("resume") => authorize_resume(&msg["payload"], id, ctx, &attempt.secrets)?,
        _ => {
            return Err(InvokeError::InvalidMessage(
                "unsupported host_request kind".into(),
            ));
        }
    };
    match authorized {
        Authorized::Denied(reply) => Ok(reply),
        Authorized::Call(req) => perform_call(req, id, ctx, attempt).await,
    }
}

/// The outcome of authorizing a host request: an outbound call to
/// perform, or the `host_error` reply that denies it.
enum Authorized {
    Call(ParsedHttpRequest),
    Denied(Vec<u8>),
}

/// Authorize a `resume` host request: a ranged continuation of a prior
/// fetch. The payload carries no arbitrary headers — the host builds
/// the `Range` header itself and verifies the `206`/`Content-Range`
/// pair in `perform_call`. Same destination allowlist as
/// `http_request`; same budget counters.
fn authorize_resume(
    payload: &Value,
    id: u32,
    ctx: &StepCtx<'_>,
    secrets: &[String],
) -> Result<Authorized, InvokeError> {
    let invalid = |m: &str| InvokeError::InvalidMessage(m.to_string());
    check_keys(
        payload,
        &["url", "offset", "length"],
        "resume.payload",
        secrets,
    )?;
    let url = payload
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("resume.url missing"))?;
    if !url.starts_with("https://") {
        return Err(invalid("resume.url must be https"));
    }
    let offset = payload
        .get("offset")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("resume.offset missing"))?;
    let length = match payload.get("length") {
        None => None,
        Some(v) => match v.as_u64().filter(|l| *l >= 1) {
            Some(l) => Some(l),
            None => return Err(invalid("resume.length must be a positive integer")),
        },
    };
    if !ctx.plugin.manifest.allows_destination(url) {
        return host_error(id, "permission-denied", "destination not permitted")
            .map(Authorized::Denied);
    }
    let end = length.map(|l| offset.saturating_add(l).saturating_sub(1));
    let range = match end {
        Some(e) => format!("bytes={offset}-{e}"),
        None => format!("bytes={offset}-"),
    };
    Ok(Authorized::Call(ParsedHttpRequest {
        method: "GET".to_string(),
        url: url.to_string(),
        headers: vec![("Range".to_string(), range)],
        body: None,
        expected_range: Some((offset, length)),
        collect_secrets: false,
    }))
}

/// Collect every non-empty string leaf of a JSON value into `out` —
/// used to register pot-provider token material in the redaction set;
/// a short leaf is still token material, so no length floor.
fn collect_secret_strings(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) if !s.is_empty() => out.push(s.clone()),
        Value::Array(a) => a.iter().for_each(|i| collect_secret_strings(i, out)),
        Value::Object(m) => m.values().for_each(|i| collect_secret_strings(i, out)),
        _ => {}
    }
}

/// Whether a `206` response's `Content-Range` agrees with the range a
/// `resume` request asked for: the start must equal `offset`, and when
/// `length` was given the end must either span the request or be the
/// last byte of the resource — an early EOF is a valid shorter range,
/// a misaligned start is the upstream lying.
fn content_range_matches(headers: &[(String, String)], offset: u64, length: Option<u64>) -> bool {
    let Some(range) = headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("content-range"))
        .map(|(_, v)| v.trim())
    else {
        return false;
    };
    let Some(body) = range.strip_prefix("bytes ") else {
        return false;
    };
    let Some((span, total)) = body.split_once('/') else {
        return false;
    };
    let Some((start, end)) = span.split_once('-') else {
        return false;
    };
    let (Ok(start), Ok(end)) = (start.parse::<u64>(), end.parse::<u64>()) else {
        return false;
    };
    if start != offset {
        return false;
    }
    match length {
        None => true,
        Some(len) => {
            let want = offset.saturating_add(len).saturating_sub(1);
            if end == want {
                return true;
            }
            total
                .parse::<u64>()
                .is_ok_and(|t| t > 0 && end == t - 1 && end < want)
        }
    }
}

/// Validate and authorize an `http_request` payload against the
/// manifest destination allowlist.
fn authorize_http_request(
    payload: &Value,
    id: u32,
    ctx: &StepCtx<'_>,
    secrets: &[String],
) -> Result<Authorized, InvokeError> {
    let req = parse_http_request(payload, secrets)?;
    if !ctx.plugin.manifest.allows_destination(&req.url) {
        return host_error(id, "permission-denied", "destination not permitted")
            .map(Authorized::Denied);
    }
    Ok(Authorized::Call(req))
}

/// Authorize a `pot_token` host request: the host mints the token
/// itself against the configured provider (`POST {provider}/get_pot`),
/// so a LAN `http://` service stays reachable while guests remain
/// HTTPS-only. The provider's response — status, headers, body —
/// passes through verbatim as `http_response`; the bgutil contract is
/// JSON-only, and the guest can only see what an operator-configured
/// endpoint chose to send.
fn authorize_pot_token(
    payload: &Value,
    id: u32,
    ctx: &StepCtx<'_>,
    secrets: &[String],
) -> Result<Authorized, InvokeError> {
    check_keys(payload, &["content_binding"], "pot_token.payload", secrets)?;
    let binding = payload
        .get("content_binding")
        .and_then(Value::as_str)
        .filter(|b| !b.is_empty())
        .ok_or_else(|| InvokeError::InvalidMessage("pot_token.content_binding missing".into()))?;
    if !ctx.plugin.manifest.allows_pot_provider() {
        return host_error(id, "permission-denied", "pot-provider not permitted")
            .map(Authorized::Denied);
    }
    let Some(provider) = ctx.services.pot_provider else {
        return host_error(id, "unsupported", "no pot provider configured").map(Authorized::Denied);
    };
    let body = serde_json::to_vec(&json!({ "content_binding": binding }))
        .map_err(|e| InvokeError::InvalidMessage(e.to_string()))?;
    Ok(Authorized::Call(ParsedHttpRequest {
        method: "POST".to_string(),
        url: format!("{}/get_pot", provider.trim_end_matches('/')),
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: Some(body),
        expected_range: None,
        collect_secrets: true,
    }))
}

/// Spend budget on one authorized outbound call and relay the outcome
/// to the guest as `http_response` or `host_error`.
async fn perform_call(
    req: ParsedHttpRequest,
    id: u32,
    ctx: &StepCtx<'_>,
    attempt: &mut Attempt,
) -> Result<Vec<u8>, InvokeError> {
    if ctx.cancel.is_cancelled() {
        return Err(InvokeError::Cancelled);
    }
    if attempt.http_calls >= ctx.budgets.max_http_calls {
        return Err(InvokeError::BudgetExceeded {
            dimension: BudgetDimension::HttpCalls,
        });
    }
    let out_bytes = req.body.as_ref().map_or(0, Vec::len) as u64;
    if attempt.bytes.saturating_add(out_bytes) > ctx.budgets.max_bytes {
        return Err(InvokeError::BudgetExceeded {
            dimension: BudgetDimension::Bytes,
        });
    }
    attempt.http_calls += 1;
    let remaining = ctx
        .budgets
        .max_bytes
        .saturating_sub(attempt.bytes + out_bytes);
    let timeout = ctx
        .budgets
        .http_timeout
        .min(ctx.budgets.deadline.saturating_sub(ctx.started.elapsed()));
    let expected_range = req.expected_range;
    let collect_secrets = req.collect_secrets;
    let method = req.method.clone();
    // The pot provider URL is an operator LAN address — it must not
    // reach the trace even redacted.
    let traced_url = if collect_secrets {
        "<pot-provider>".to_string()
    } else {
        redact_url(&req.url)
    };
    let call = ctx.services.http.send(
        HttpRequest {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: req.body,
            max_response_bytes: remaining,
        },
        timeout,
        ctx.cancel.clone(),
    );
    let t0 = Instant::now();
    let result = tokio::select! {
        () = ctx.cancel.cancelled() => None,
        r = call => Some(r),
    };
    let elapsed = t0.elapsed();
    let Some(result) = result else {
        // http_calls counts the attempt; the trace must record it too.
        attempt.http_trace.push(HttpTraceEntry {
            method,
            url: traced_url,
            status: None,
            bytes: 0,
            elapsed,
        });
        return Err(InvokeError::Cancelled);
    };
    match result {
        Ok(resp) => {
            attempt.bytes += out_bytes + resp.body.len() as u64;
            // The response spent bytes whether or not it fit the
            // budget — trace it first so an over-cap call isn't
            // silently absent from the attempt's record.
            attempt.http_trace.push(HttpTraceEntry {
                method,
                url: traced_url,
                status: Some(resp.status),
                bytes: resp.body.len() as u64,
                elapsed,
            });
            if attempt.bytes > ctx.budgets.max_bytes {
                return Err(InvokeError::BudgetExceeded {
                    dimension: BudgetDimension::Bytes,
                });
            }
            // The pot provider's JSON carries token material — register
            // its string leaves so a guest echo into `log`/`fail` is
            // masked rather than leaked.
            if collect_secrets {
                if let Ok(v) = serde_json::from_slice::<Value>(&resp.body) {
                    collect_secret_strings(&v, &mut attempt.secrets);
                }
            }
            // A `resume` call that lands a `206` must agree with the
            // range it asked for — a lying `Content-Range` is a failed
            // host request, not a body the guest has to re-verify.
            if let Some((offset, length)) = expected_range {
                if resp.status == 206 && !content_range_matches(&resp.headers, offset, length) {
                    return host_error(id, "invalid-response", "content-range mismatch");
                }
            }
            let headers: Vec<Value> = resp.headers.iter().map(|(k, v)| json!([k, v])).collect();
            serde_json::to_vec(&json!({
                "type": "http_response",
                "id": id,
                "status": resp.status,
                "headers": headers,
                "body": base64::engine::general_purpose::STANDARD.encode(resp.body),
            }))
            .map_err(|e| InvokeError::InvalidMessage(e.to_string()))
        }
        Err(e) => {
            // Bytes pulled before the failure still belong to the byte
            // budget — a mid-stream error is not a refund.
            attempt.bytes += out_bytes + e.bytes_received;
            attempt.http_trace.push(HttpTraceEntry {
                method,
                url: traced_url,
                status: None,
                bytes: e.bytes_received,
                elapsed,
            });
            match e.kind {
                HttpErrorKind::Cancelled => Err(InvokeError::Cancelled),
                HttpErrorKind::BodyTooLarge => Err(InvokeError::BudgetExceeded {
                    dimension: BudgetDimension::Bytes,
                }),
                _ if attempt.bytes > ctx.budgets.max_bytes => Err(InvokeError::BudgetExceeded {
                    dimension: BudgetDimension::Bytes,
                }),
                kind => {
                    // Client messages are host-trusted but still scrubbed
                    // before they cross into the guest.
                    host_error(
                        id,
                        kind.guest_kind().unwrap_or("transient"),
                        &redact_text(&e.message, &attempt.secrets),
                    )
                }
            }
        }
    }
}

/// Validate the `payload` of an `http_request` host request.
fn parse_http_request(
    payload: &Value,
    secrets: &[String],
) -> Result<ParsedHttpRequest, InvokeError> {
    let invalid = |m: &str| InvokeError::InvalidMessage(m.to_string());
    check_keys(
        payload,
        &["method", "url", "headers", "body"],
        "http_request.payload",
        secrets,
    )?;
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("http_request.method missing"))?;
    if method != "GET" && method != "POST" {
        return Err(invalid("http_request.method must be GET or POST"));
    }
    let url = payload
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("http_request.url missing"))?;
    if !url.starts_with("https://") {
        return Err(invalid("http_request.url must be https"));
    }
    let raw_headers = payload
        .get("headers")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("http_request.headers missing"))?;
    let mut headers = Vec::with_capacity(raw_headers.len());
    for h in raw_headers {
        let pair = h
            .as_array()
            .filter(|p| p.len() == 2)
            .ok_or_else(|| invalid("http_request header must be a [name, value] pair"))?;
        let name = pair
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("http_request header name must be a string"))?;
        let value = pair
            .get(1)
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("http_request header value must be a string"))?;
        if name.is_empty()
            || !name.bytes().all(|b| (33..=126).contains(&b) && b != b':')
            || value.bytes().any(|b| b == b'\r' || b == b'\n')
        {
            return Err(invalid("http_request header malformed"));
        }
        // The wire stack owns these: a guest-set `Host` would let the
        // request's authority diverge from the allowlisted URL host
        // (domain fronting), and hop-by-hop/framing names
        // (`Connection`, `TE`, `Transfer-Encoding`, `Content-Length`)
        // are smuggling surfaces — the client sets them itself. A
        // `proxy-` prefix is denied wholesale: proxy field names are
        // host policy, not guest input.
        if HOST_OWNED_HEADERS
            .iter()
            .any(|r| name.eq_ignore_ascii_case(r))
            || name.to_ascii_lowercase().starts_with("proxy-")
        {
            return Err(invalid("http_request header name is reserved"));
        }
        headers.push((name.to_string(), value.to_string()));
    }
    // `body` is a required key — `null` means bodiless, but its absence
    // is a malformed envelope per the schema.
    let body = match payload.get("body") {
        None => return Err(invalid("http_request.body missing")),
        Some(Value::Null) => None,
        Some(Value::String(s)) => Some(
            base64::engine::general_purpose::STANDARD
                .decode(s)
                .map_err(|_| invalid("http_request.body is not valid base64"))?,
        ),
        _ => return Err(invalid("http_request.body must be base64 or null")),
    };
    Ok(ParsedHttpRequest {
        method: method.to_string(),
        url: url.to_string(),
        headers,
        body,
        expected_range: None,
        collect_secrets: false,
    })
}

struct ParsedHttpRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    /// Set for `resume` calls: the `(offset, length)` the `Range`
    /// header was built from, verified against a `206`'s
    /// `Content-Range`.
    expected_range: Option<(u64, Option<u64>)>,
    /// Set for `pot_token` calls: the provider's JSON response carries
    /// token material — collect its string leaves into the redaction
    /// set so the guest can't echo them into logs.
    collect_secrets: bool,
}

/// Serialize a `host_error` step message for the guest.
fn host_error(id: u32, kind: &str, message: &str) -> Result<Vec<u8>, InvokeError> {
    serde_json::to_vec(&json!({
        "type": "host_error",
        "id": id,
        "error": { "kind": kind, "message": message },
    }))
    .map_err(|e| InvokeError::InvalidMessage(e.to_string()))
}

/// Serialize a `host_ok` ack for the guest.
fn host_ok(id: u32) -> Result<Vec<u8>, InvokeError> {
    serde_json::to_vec(&json!({ "type": "host_ok", "id": id }))
        .map_err(|e| InvokeError::InvalidMessage(e.to_string()))
}

/// Per-invocation staged KV state: the committed snapshot plus pending
/// writes (`None` is a delete tombstone, so read-your-writes sees the
/// deletion). The patch commits only on a valid `done`.
struct StagedKv {
    base: BTreeMap<String, Vec<u8>>,
    staged: BTreeMap<String, Option<Vec<u8>>>,
    /// Effective namespace size (keys + values) after staged ops.
    total: usize,
}

impl StagedKv {
    fn new(base: BTreeMap<String, Vec<u8>>) -> Self {
        let total = base.iter().map(|(k, v)| k.len() + v.len()).sum();
        Self {
            base,
            staged: BTreeMap::new(),
            total,
        }
    }

    fn get(&self, key: &str) -> Option<&Vec<u8>> {
        match self.staged.get(key) {
            Some(v) => v.as_ref(),
            None => self.base.get(key),
        }
    }

    /// The namespace size `stage(key, value)` would leave behind.
    fn effective_total(&self, key: &str, value: Option<&Vec<u8>>) -> usize {
        let mut total = self.total;
        if let Some(old) = self.get(key) {
            total -= key.len() + old.len();
        }
        if let Some(v) = value {
            total += key.len() + v.len();
        }
        total
    }

    fn stage(&mut self, key: String, value: Option<Vec<u8>>) {
        if let Some(old) = self.get(&key) {
            self.total -= key.len() + old.len();
        }
        if let Some(v) = &value {
            self.total += key.len() + v.len();
        }
        self.staged.insert(key, value);
    }

    /// Whether anything was staged — an empty patch never reaches the
    /// store.
    fn has_writes(&self) -> bool {
        !self.staged.is_empty()
    }

    /// The staged patch for the store: `Some` sets, `None` deletes.
    fn writes(self) -> BTreeMap<String, Option<Vec<u8>>> {
        self.staged
    }
}

/// The `key` field shared by `kv_get`/`kv_set` payloads. Shape
/// violations (missing, wrong type, empty) end the invocation like
/// any malformed step message; the byte cap is a *cap* like the value
/// and namespace ones — a recoverable `host_error`, not a protocol
/// violation that kills the call.
fn parse_kv_key(payload: &Value, what: &str) -> Result<String, InvokeError> {
    let invalid = |m: &str| InvokeError::InvalidMessage(format!("{what}.{m}"));
    let key = payload
        .get("key")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("key missing or not a string"))?;
    if key.is_empty() {
        return Err(invalid("key is empty"));
    }
    Ok(key.to_string())
}

/// Handle a `kv_get` payload: shape, permission, then a staged read.
fn kv_get_step(
    payload: &Value,
    id: u32,
    ctx: &StepCtx<'_>,
    staged: &StagedKv,
    secrets: &[String],
) -> Result<Vec<u8>, InvokeError> {
    check_keys(payload, &["key"], "kv_get.payload", secrets)?;
    let key = parse_kv_key(payload, "kv_get")?;
    if key.len() > MAX_KV_KEY_BYTES {
        return host_error(id, "invalid-response", "kv key exceeds 128 bytes");
    }
    if !ctx.plugin.manifest.allows_kv() {
        return host_error(id, "permission-denied", "kv not permitted");
    }
    let value = staged
        .get(&key)
        .map_or(Value::Null, |v| Value::String(B64.encode(v)));
    serde_json::to_vec(&json!({ "type": "kv_response", "id": id, "value": value }))
        .map_err(|e| InvokeError::InvalidMessage(e.to_string()))
}

/// Handle a `kv_set` payload: shape, permission, caps, then stage.
/// `null` stages a delete. A refused write mutates nothing.
fn kv_set_step(
    payload: &Value,
    id: u32,
    ctx: &StepCtx<'_>,
    staged: &mut StagedKv,
    secrets: &[String],
) -> Result<Vec<u8>, InvokeError> {
    check_keys(payload, &["key", "value"], "kv_set.payload", secrets)?;
    let key = parse_kv_key(payload, "kv_set")?;
    if key.len() > MAX_KV_KEY_BYTES {
        return host_error(id, "invalid-response", "kv key exceeds 128 bytes");
    }
    let value = match payload.get("value") {
        None => {
            return Err(InvokeError::InvalidMessage("kv_set.value missing".into()));
        }
        Some(Value::Null) => None,
        Some(Value::String(s)) => Some(
            B64.decode(s)
                .map_err(|_| InvokeError::InvalidMessage("kv_set.value is not base64".into()))?,
        ),
        _ => {
            return Err(InvokeError::InvalidMessage(
                "kv_set.value must be base64 or null".into(),
            ));
        }
    };
    if !ctx.plugin.manifest.allows_kv() {
        return host_error(id, "permission-denied", "kv not permitted");
    }
    if value.as_ref().is_some_and(|v| v.len() > MAX_KV_VALUE_BYTES) {
        return host_error(id, "invalid-response", "kv value exceeds 64 KiB");
    }
    if staged.effective_total(&key, value.as_ref()) > MAX_KV_NAMESPACE_BYTES {
        return host_error(id, "invalid-response", "kv namespace exceeds 256 KiB");
    }
    staged.stage(key, value);
    host_ok(id)
}

/// Handle a `log` payload: append a redacted entry to the attempt.
fn log_step(payload: &Value, id: u32, attempt: &mut Attempt) -> Result<Vec<u8>, InvokeError> {
    check_keys(
        payload,
        &["level", "message"],
        "log.payload",
        &attempt.secrets,
    )?;
    let level = payload
        .get("level")
        .and_then(Value::as_str)
        .filter(|l| LOG_LEVELS.contains(l))
        .ok_or_else(|| InvokeError::InvalidMessage("log.level missing or unknown".into()))?;
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| InvokeError::InvalidMessage("log.message missing".into()))?;
    if message.len() > MAX_LOG_MESSAGE_BYTES {
        return host_error(id, "invalid-response", "log message exceeds 4096 bytes");
    }
    if attempt.guest_log.len() >= MAX_GUEST_LOG_ENTRIES {
        return Err(InvokeError::BudgetExceeded {
            dimension: BudgetDimension::GuestLog,
        });
    }
    // Guest text can quote a signed URL it legitimately saw or echo
    // token material the host handed it; redact before it can reach
    // diagnostics.
    attempt.guest_log.push(GuestLogEntry {
        level: level.to_string(),
        message: redact_text(message, &attempt.secrets),
    });
    host_ok(id)
}

/// Handle a `now_ms` payload: the host clock's epoch milliseconds.
fn now_ms_step(
    payload: &Value,
    id: u32,
    ctx: &StepCtx<'_>,
    secrets: &[String],
) -> Result<Vec<u8>, InvokeError> {
    check_keys(payload, &[], "now_ms.payload", secrets)?;
    serde_json::to_vec(&json!({
        "type": "now_response",
        "id": id,
        "now_ms": ctx.services.clock.now_ms(),
    }))
    .map_err(|e| InvokeError::InvalidMessage(e.to_string()))
}
