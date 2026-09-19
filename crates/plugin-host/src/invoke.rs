//! Artifact loading and the per-invocation step loop.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::Digest;
use tokio_util::sync::CancellationToken;
use wasmi::{
    Config, Engine, ExternType, Linker, Module, Store, StoreLimits, StoreLimitsBuilder, TrapCode,
    TypedFunc, ValType, WasmParams, WasmResults,
};

use crate::attempt::{Attempt, HttpTraceEntry};
use crate::budgets::{BudgetDimension, Budgets};
use crate::error::{HttpErrorKind, InvokeError, LoadError, GUEST_FAIL_KINDS};
use crate::http::{HttpClient, HttpRequest};
use crate::manifest::Manifest;
use crate::redact::{redact_text, redact_url};
use crate::ABI_VERSION;

/// Largest guest→host step message accepted (1 MiB).
const MAX_GUEST_MESSAGE_BYTES: usize = 1024 * 1024;

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
    if wasm.len() > budgets.max_artifact_bytes {
        return Err(LoadError::ArtifactTooLarge {
            max: budgets.max_artifact_bytes,
            actual: wasm.len(),
        });
    }
    if manifest.abi != ABI_VERSION {
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
    check_module_shape(wasm)?;
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

/// Zero-import and no-start-section checks via `wasmparser`.
fn check_module_shape(wasm: &[u8]) -> Result<(), LoadError> {
    use wasmparser::Payload;
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
            _ => {}
        }
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
    http: &'a dyn HttpClient,
    pot_provider: Option<&'a str>,
    started: Instant,
}

/// Invoke `capability` on a loaded plugin with the ABI v0 step loop.
///
/// A fresh Wasmi instance is created per invocation; guest state lives
/// only in that instance's linear memory for the duration of the call.
/// `pot_provider` is the base URL of a bgutil-compatible PO-token
/// service (`POST {provider}/get_pot`); `None` makes `pot_token` host
/// requests answer `unsupported`. Empty or whitespace-only values
/// normalize to `None` here so every shell boundary behaves the same.
pub async fn invoke(
    plugin: &LoadedPlugin,
    capability: &str,
    payload: Value,
    budgets: &Budgets,
    cancel: CancellationToken,
    http: &dyn HttpClient,
    pot_provider: Option<&str>,
) -> Invocation {
    let started = Instant::now();
    let pot_provider = pot_provider.map(str::trim).filter(|s| !s.is_empty());
    let mut attempt = Attempt {
        request_id: format!("invoke-{}", REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)),
        steps: 0,
        http_calls: 0,
        bytes: 0,
        fuel_used: 0,
        elapsed: std::time::Duration::ZERO,
        http_trace: Vec::new(),
    };
    let ctx = StepCtx {
        plugin,
        budgets,
        cancel: &cancel,
        http,
        pot_provider,
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
        let ptr = call_entry(&mut store, &alloc, len, ctx.budgets, attempt)?;
        if len > 0 && ptr == 0 {
            return Err(InvokeError::InvalidMessage("alloc returned null".into()));
        }
        memory
            .write(&mut store, ptr as usize, &input)
            .map_err(|_| InvokeError::InvalidMessage("alloc buffer out of bounds".into()))?;
        // `alloc` and `handle` are separate entries — the token and the
        // deadline are checked before each, not just at the loop top.
        check_preemption(ctx)?;
        let packed = call_entry(&mut store, &handle, (ptr, len), ctx.budgets, attempt)?;
        attempt.steps += 1;
        // A cancellation or deadline that landed while the guest ran
        // outranks whatever the entry produced: the caller's intent
        // wins over a result it no longer wants. Wasmi cannot preempt
        // a CPU-bound entry mid-run — fuel is that bound — but the
        // outcome is still reported as cancelled/deadline-exceeded.
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
                return Ok(result);
            }
            Some("fail") => {
                let error = &msg["error"];
                let kind = error
                    .get("kind")
                    .and_then(Value::as_str)
                    .ok_or_else(|| InvokeError::InvalidMessage("fail.error.kind missing".into()))?;
                if !GUEST_FAIL_KINDS.contains(&kind) {
                    return Err(InvokeError::InvalidMessage(format!(
                        "fail.error.kind {kind:?} is not in the ABI taxonomy"
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
                    message: redact_text(message),
                });
            }
            Some("host_request") => {
                input = host_request_step(&msg, ctx, attempt).await?;
            }
            _ => {
                return Err(InvokeError::InvalidMessage(format!(
                    "unknown message type in guest output: {}",
                    redact_text(&msg.to_string())
                )));
            }
        }
    }
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

/// Enter a guest export with fuel accounting. Per-entry fuel is the
/// smaller of `fuel_per_entry` and the remaining total; an out-of-fuel
/// trap maps to `BudgetExceeded { Fuel }`.
fn call_entry<P, R>(
    store: &mut Store<HostState>,
    func: &TypedFunc<P, R>,
    params: P,
    budgets: &Budgets,
    attempt: &mut Attempt,
) -> Result<R, InvokeError>
where
    P: WasmParams,
    R: WasmResults,
{
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
    let result = func.call(&mut *store, params);
    let remaining = store.get_fuel().unwrap_or(0);
    attempt.fuel_used += allowance.saturating_sub(remaining);
    match result {
        Ok(value) => Ok(value),
        Err(e) if e.as_trap_code() == Some(TrapCode::OutOfFuel) => {
            Err(InvokeError::BudgetExceeded {
                dimension: BudgetDimension::Fuel,
            })
        }
        Err(e) => Err(InvokeError::GuestTrap(e.to_string())),
    }
}

/// Handle one `host_request` step and produce the next `handle` input
/// (either `http_response` or `host_error`).
async fn host_request_step(
    msg: &Value,
    ctx: &StepCtx<'_>,
    attempt: &mut Attempt,
) -> Result<Vec<u8>, InvokeError> {
    let id = msg
        .get("id")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| InvokeError::InvalidMessage("host_request.id missing".into()))?;
    let authorized = match msg.get("kind").and_then(Value::as_str) {
        Some("http_request") => authorize_http_request(&msg["payload"], id, ctx)?,
        Some("pot_token") => authorize_pot_token(&msg["payload"], id, ctx)?,
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

/// Validate and authorize an `http_request` payload against the
/// manifest destination allowlist.
fn authorize_http_request(
    payload: &Value,
    id: u32,
    ctx: &StepCtx<'_>,
) -> Result<Authorized, InvokeError> {
    let req = parse_http_request(payload)?;
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
) -> Result<Authorized, InvokeError> {
    let binding = payload
        .get("content_binding")
        .and_then(Value::as_str)
        .filter(|b| !b.is_empty())
        .ok_or_else(|| InvokeError::InvalidMessage("pot_token.content_binding missing".into()))?;
    if !ctx.plugin.manifest.allows_pot_provider() {
        return host_error(id, "permission-denied", "pot-provider not permitted")
            .map(Authorized::Denied);
    }
    let Some(provider) = ctx.pot_provider else {
        return host_error(id, "unsupported", "no pot provider configured").map(Authorized::Denied);
    };
    let body = serde_json::to_vec(&json!({ "content_binding": binding }))
        .map_err(|e| InvokeError::InvalidMessage(e.to_string()))?;
    Ok(Authorized::Call(ParsedHttpRequest {
        method: "POST".to_string(),
        url: format!("{}/get_pot", provider.trim_end_matches('/')),
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: Some(body),
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
    let method = req.method.clone();
    let traced_url = redact_url(&req.url);
    let call = ctx.http.send(
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
            if attempt.bytes > ctx.budgets.max_bytes {
                return Err(InvokeError::BudgetExceeded {
                    dimension: BudgetDimension::Bytes,
                });
            }
            attempt.http_trace.push(HttpTraceEntry {
                method,
                url: traced_url,
                status: Some(resp.status),
                bytes: resp.body.len() as u64,
                elapsed,
            });
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
                        &redact_text(&e.message),
                    )
                }
            }
        }
    }
}

/// Validate the `payload` of an `http_request` host request.
fn parse_http_request(payload: &Value) -> Result<ParsedHttpRequest, InvokeError> {
    let invalid = |m: &str| InvokeError::InvalidMessage(m.to_string());
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
            .ok_or_else(|| invalid("http_request header must be a pair"))?;
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
        headers.push((name.to_string(), value.to_string()));
    }
    let body = match payload.get("body") {
        None | Some(Value::Null) => None,
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
    })
}

struct ParsedHttpRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
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
