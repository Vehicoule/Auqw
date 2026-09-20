//! Conformance guest driving the host-service step kinds through the
//! guest SDK's async dispatch (not a hand-written state machine). The
//! `payload.scenario` field selects the behavior; invocations run under
//! `playback.resolve` so no product-only capability is needed.
//!
//! Scenarios:
//! - `echo`: returns `payload.echo` verbatim.
//! - `kv_commit`: `kv_set`, read-your-write `kv_get`, `now_ms`, one
//!   `log` entry, then `done` with the observed values.
//! - `kv_fail`: `kv_set` then a typed `fail` — the staged write must
//!   not commit.
//! - `kv_http`: `kv_set` then one GET of `payload.url` — used to prove
//!   a staged write parked behind HTTP survives neither cancel nor
//!   failure.
//! - `http`: one GET of `payload.url` through `http_request`.
//! - `resume`: one ranged continuation of `payload.url` at
//!   `payload.offset`/`payload.length` through the 0.3.0 `resume`
//!   step; a `host_error` surfaces as `{"host_error": kind}`.
//!
//! Rebuild: `cargo build --target wasm32-unknown-unknown --release -p
//! auqw-conformance-scenario`, then copy `target/wasm32-unknown-unknown/
//! release/auqw_conformance_scenario.wasm` next to this source as
//! `scenario.wasm`.

use auqw_guest_sdk::{export_plugin, GuestError, GuestFuture, HttpRequest, Invocation, LogLevel};
use serde::Deserialize;
use serde_json::{json, Value};

export_plugin!(dispatch);

#[derive(Deserialize)]
struct ScenarioPayload {
    scenario: String,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    echo: Option<Value>,
    #[serde(default)]
    offset: Option<u64>,
    #[serde(default)]
    length: Option<u64>,
}

fn missing(field: &str) -> GuestError {
    GuestError::Failed {
        kind: "invalid-response".into(),
        message: format!("payload.{field} required"),
    }
}

fn dispatch(inv: Invocation) -> GuestFuture {
    Box::pin(run(inv))
}

async fn run(inv: Invocation) -> Result<Value, GuestError> {
    let p: ScenarioPayload =
        serde_json::from_value(inv.payload).map_err(|e| GuestError::Failed {
            kind: "invalid-response".into(),
            message: format!("payload: {e}"),
        })?;
    match p.scenario.as_str() {
        "echo" => Ok(p.echo.unwrap_or(Value::Null)),
        "kv_commit" => kv_commit(p).await,
        "kv_fail" => kv_fail(p).await,
        "kv_http" => kv_http(p).await,
        "http" => http(p).await,
        "resume" => resume(p).await,
        other => Err(GuestError::Failed {
            kind: "not-applicable".into(),
            message: format!("unknown scenario {other}"),
        }),
    }
}

async fn kv_commit(p: ScenarioPayload) -> Result<Value, GuestError> {
    let key = p.key.ok_or_else(|| missing("key"))?;
    let value = p.value.unwrap_or_default();
    kv_set_pub(&key, value.as_bytes()).await?;
    let read = auqw_guest_sdk::kv_get(&key).await?;
    let now = auqw_guest_sdk::now_ms().await?;
    auqw_guest_sdk::log(
        LogLevel::Info,
        &p.message.unwrap_or_else(|| "kv_commit".into()),
    )
    .await?;
    Ok(json!({
        "read_back": read.map(|v| String::from_utf8_lossy(&v).into_owned()),
        "now_ms": now,
    }))
}

async fn kv_set_pub(key: &str, value: &[u8]) -> Result<(), GuestError> {
    auqw_guest_sdk::kv_set(key, Some(value)).await
}

async fn kv_fail(p: ScenarioPayload) -> Result<Value, GuestError> {
    let key = p.key.ok_or_else(|| missing("key"))?;
    let value = p.value.unwrap_or_default();
    kv_set_pub(&key, value.as_bytes()).await?;
    Err(GuestError::Failed {
        kind: "transient".into(),
        message: "kv_fail scenario".into(),
    })
}

async fn kv_http(p: ScenarioPayload) -> Result<Value, GuestError> {
    let key = p.key.ok_or_else(|| missing("key"))?;
    kv_set_pub(&key, p.value.unwrap_or_default().as_bytes()).await?;
    let url = p.url.ok_or_else(|| missing("url"))?;
    let resp = auqw_guest_sdk::http_request(HttpRequest {
        method: "GET".into(),
        url,
        headers: Vec::new(),
        body: None,
    })
    .await?;
    Ok(json!({ "status": resp.status }))
}

async fn http(p: ScenarioPayload) -> Result<Value, GuestError> {
    let url = p.url.ok_or_else(|| missing("url"))?;
    let resp = auqw_guest_sdk::http_request(HttpRequest {
        method: "GET".into(),
        url,
        headers: Vec::new(),
        body: None,
    })
    .await?;
    Ok(json!({
        "status": resp.status,
        "body_len": resp.body.len(),
    }))
}

/// One `resume` continuation at `payload.offset`/`payload.length`.
/// A `host_error` surfaces as `{"host_error": kind}` so tests can
/// assert both the pass-through and the denial paths.
async fn resume(p: ScenarioPayload) -> Result<Value, GuestError> {
    let url = p.url.ok_or_else(|| missing("url"))?;
    match auqw_guest_sdk::resume(&url, p.offset.unwrap_or(0), p.length).await {
        Ok(resp) => Ok(json!({
            "status": resp.status,
            "body_len": resp.body.len(),
        })),
        Err(GuestError::Host { kind, .. }) => Ok(json!({ "host_error": kind })),
        Err(e) => Err(e),
    }
}
