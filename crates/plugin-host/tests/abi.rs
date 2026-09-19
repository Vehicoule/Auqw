//! ABI v0 contract tests: load-time rejection, budgets, permissions,
//! cancellation. Synthetic guests are hand-written WAT; `spin.wasm` /
//! `echo.wasm` are the checked-in Rust conformance artifacts.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use auqw_plugin_host::{
    invoke, load, BudgetDimension, Budgets, HttpClient, HttpError, HttpErrorKind, HttpRequest,
    HttpResponse, Invocation, InvokeError, LoadError, Manifest,
};
use serde_json::Value;
use sha2::Digest;
use tokio_util::sync::CancellationToken;

fn ok<T, E: std::fmt::Debug>(r: Result<T, E>) -> T {
    match r {
        Ok(v) => v,
        Err(e) => panic!("expected Ok, got {e:?}"),
    }
}

fn err<T: std::fmt::Debug, E>(r: Result<T, E>) -> E {
    match r {
        Err(e) => e,
        Ok(v) => panic!("expected Err, got {v:?}"),
    }
}

fn read_wasm(path: &str) -> Vec<u8> {
    match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => panic!("{path}: {e}"),
    }
}

fn manifest_for(wasm: &[u8], permissions: &[&str]) -> Manifest {
    let digest = format!("sha256:{:x}", sha2::Sha256::digest(wasm));
    let perms: Vec<String> = permissions.iter().map(|p| format!("\"{p}\"")).collect();
    let text = format!(
        "{{\"id\":\"test-plugin\",\"version\":\"0.1.0\",\"abi\":\"0.1.0\",\
         \"capabilities\":[\"playback.resolve\"],\"permissions\":[{}],\
         \"artifact\":{{\"path\":\"test.wasm\",\"digest\":\"{digest}\"}}}}",
        perms.join(",")
    );
    ok(Manifest::from_json(&text))
}

fn default_budgets() -> Budgets {
    Budgets::default()
}

// ---------- fake HttpClient implementations ----------

/// Always returns a fixed small response; counts calls.
struct CannedHttp {
    calls: Arc<AtomicU32>,
}

impl CannedHttp {
    fn new() -> (Self, Arc<AtomicU32>) {
        let calls = Arc::new(AtomicU32::new(0));
        (
            Self {
                calls: Arc::clone(&calls),
            },
            calls,
        )
    }
}

impl HttpClient for CannedHttp {
    fn send(
        &self,
        _req: HttpRequest,
        _timeout: Duration,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Box::pin(async {
            Ok(HttpResponse {
                status: 200,
                headers: vec![],
                body: b"{}".to_vec(),
            })
        })
    }
}

/// Never resolves; only cancellation or the caller dropping the future
/// ends the wait.
struct SleepHttp;

impl HttpClient for SleepHttp {
    fn send(
        &self,
        _req: HttpRequest,
        _timeout: Duration,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        Box::pin(async {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            Err(HttpError {
                kind: HttpErrorKind::Timeout,
                message: "unreachable".into(),
            })
        })
    }
}

/// Returns a response body larger than the cap the host requests.
struct BigBodyHttp {
    size: usize,
}

impl HttpClient for BigBodyHttp {
    fn send(
        &self,
        req: HttpRequest,
        _timeout: Duration,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        let n = self.size;
        let cap = req.max_response_bytes;
        Box::pin(async move {
            if n as u64 > cap {
                return Err(HttpError {
                    kind: HttpErrorKind::BodyTooLarge,
                    message: "over cap".into(),
                });
            }
            Ok(HttpResponse {
                status: 200,
                headers: vec![],
                body: vec![0u8; n],
            })
        })
    }
}

// ---------- WAT guests ----------

/// Guest that immediately returns `done` (`{"ok":true}`).
const DONE_WAT: &str = r#"(module
  (memory (export "memory") 1)
  (func (export "alloc") (param i32) (result i32) (i32.const 1024))
  (func (export "handle") (param i32 i32) (result i64)
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.const 2048)) (i64.const 32))
      (i64.extend_i32_u (i32.const 36))))
  (data (i32.const 2048) "{\"type\":\"done\",\"result\":{\"ok\":true}}"))"#;

fn requester_msg(url: &str) -> String {
    format!(
        "{{\"type\":\"host_request\",\"id\":1,\"kind\":\"http_request\",\
         \"payload\":{{\"method\":\"GET\",\"url\":\"{url}\",\"headers\":[],\"body\":null}}}}"
    )
}

/// Guest that requests one URL on every step, forever.
fn requester_wat(url: &str) -> String {
    let msg = requester_msg(url).replace('"', "\\\"");
    format!(
        "(module\n  (memory (export \"memory\") 1)\n  \
         (func (export \"alloc\") (param i32) (result i32) (i32.const 1024))\n  \
         (func (export \"handle\") (param i32 i32) (result i64)\n    \
         (i64.or\n      \
         (i64.shl (i64.extend_i32_u (i32.const 2048)) (i64.const 32))\n      \
         (i64.extend_i32_u (i32.const {}))))\n  \
         (data (i32.const 2048) \"{}\"))",
        requester_msg(url).len(),
        msg,
    )
}

// ---------- load-time rejection ----------

#[test]
fn load_rejects_imports() {
    let wasm = ok(wat::parse_str(
        r#"(module
          (import "auqw" "clock" (func $clock (result i64)))
          (memory (export "memory") 1)
          (func (export "alloc") (param i32) (result i32) (i32.const 0))
          (func (export "handle") (param i32 i32) (result i64) (i64.const 0)))"#,
    ));
    let e = err(load(&wasm, manifest_for(&wasm, &[]), &default_budgets()));
    assert!(matches!(e, LoadError::ImportsDeclared { .. }), "{e:?}");
}

#[test]
fn load_rejects_start() {
    let wasm = ok(wat::parse_str(
        r#"(module
          (func $s)
          (start $s)
          (memory (export "memory") 1)
          (func (export "alloc") (param i32) (result i32) (i32.const 0))
          (func (export "handle") (param i32 i32) (result i64) (i64.const 0)))"#,
    ));
    let e = err(load(&wasm, manifest_for(&wasm, &[]), &default_budgets()));
    assert!(matches!(e, LoadError::StartSection), "{e:?}");
}

#[test]
fn load_rejects_missing_export() {
    let wasm = ok(wat::parse_str(
        r#"(module
          (memory (export "memory") 1)
          (func (export "alloc") (param i32) (result i32) (i32.const 0)))"#,
    ));
    let e = err(load(&wasm, manifest_for(&wasm, &[]), &default_budgets()));
    assert!(
        matches!(e, LoadError::BadExport { name: "handle" }),
        "{e:?}"
    );
}

#[test]
fn load_rejects_digest_mismatch() {
    let wasm = ok(wat::parse_str(DONE_WAT));
    let mut manifest = manifest_for(&wasm, &[]);
    manifest.artifact.digest = format!("sha256:{}", "0".repeat(64));
    let e = err(load(&wasm, manifest, &default_budgets()));
    assert!(matches!(e, LoadError::DigestMismatch { .. }), "{e:?}");
}

// ---------- happy path ----------

#[tokio::test]
async fn done_result_round_trips() {
    let wasm = ok(wat::parse_str(DONE_WAT));
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &default_budgets()));
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({"source_ref": "x"}),
        &default_budgets(),
        CancellationToken::new(),
        &http,
    )
    .await;
    assert_eq!(ok(result), serde_json::json!({"ok": true}));
    assert_eq!(attempt.steps, 1);
    assert_eq!(attempt.http_calls, 0);
    assert!(attempt.fuel_used > 0);
    assert!(attempt.elapsed > Duration::ZERO);
}

// ---------- budgets ----------

/// Fuel trap on an infinite loop, using the checked-in Rust spin guest.
#[tokio::test]
async fn fuel_traps_infinite_loop() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../sdk/conformance/spin/spin.wasm"
    );
    let wasm = read_wasm(path);
    let mut budgets = default_budgets();
    budgets.fuel_per_entry = 40_000_000;
    budgets.fuel_total = 40_000_000;
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &budgets));
    let (http, _calls) = CannedHttp::new();
    let t0 = Instant::now();
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        &http,
    )
    .await;
    let elapsed = t0.elapsed();
    eprintln!(
        "fuel trap latency: {elapsed:?} (fuel_used={})",
        attempt.fuel_used
    );
    assert!(
        matches!(
            err(result),
            InvokeError::BudgetExceeded {
                dimension: BudgetDimension::Fuel
            }
        ),
        "expected fuel budget trap"
    );
    assert!(elapsed < Duration::from_secs(5), "trap took {elapsed:?}");
}

#[tokio::test]
async fn step_limit_stops_requester() {
    let wasm = ok(wat::parse_str(requester_wat("https://example.com/")));
    let mut budgets = default_budgets();
    budgets.max_steps = 5;
    let plugin = ok(load(
        &wasm,
        manifest_for(&wasm, &["network:example.com"]),
        &budgets,
    ));
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        &http,
    )
    .await;
    assert!(
        matches!(
            err(result),
            InvokeError::BudgetExceeded {
                dimension: BudgetDimension::Steps
            }
        ),
        "expected step-limit error"
    );
    assert_eq!(attempt.steps, 5);
}

#[tokio::test]
async fn http_call_limit_stops_requester() {
    let wasm = ok(wat::parse_str(requester_wat("https://example.com/")));
    let mut budgets = default_budgets();
    budgets.max_http_calls = 2;
    let plugin = ok(load(
        &wasm,
        manifest_for(&wasm, &["network:example.com"]),
        &budgets,
    ));
    let (http, calls) = CannedHttp::new();
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        &http,
    )
    .await;
    assert!(
        matches!(
            err(result),
            InvokeError::BudgetExceeded {
                dimension: BudgetDimension::HttpCalls
            }
        ),
        "expected http-call-limit error"
    );
    assert_eq!(attempt.http_calls, 2);
    assert_eq!(calls.load(Ordering::Relaxed), 2);
}

/// A denied destination produces a `host_error` and consumes no HTTP
/// budget: the requester loops on `host_error` until the step limit.
#[tokio::test]
async fn destination_denied_consumes_no_http() {
    let wasm = ok(wat::parse_str(requester_wat("https://evil.example.net/")));
    let mut budgets = default_budgets();
    budgets.max_steps = 3;
    let plugin = ok(load(
        &wasm,
        manifest_for(&wasm, &["network:example.com"]),
        &budgets,
    ));
    let (http, calls) = CannedHttp::new();
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        &http,
    )
    .await;
    assert!(
        matches!(
            err(result),
            InvokeError::BudgetExceeded {
                dimension: BudgetDimension::Steps
            }
        ),
        "denied requester still loops to step limit"
    );
    assert_eq!(attempt.http_calls, 0);
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

// ---------- permission grammar ----------

#[test]
fn permission_grammar() {
    let m = |perms: &[&str]| manifest_for(b"", perms);
    // exact match
    assert!(m(&["network:music.youtube.com"]).allows_destination("https://music.youtube.com/x"));
    assert!(!m(&["network:music.youtube.com"]).allows_destination("https://www.youtube.com/"));
    // wildcard: subdomains at any depth, not the apex
    assert!(
        m(&["network:*.googlevideo.com"]).allows_destination("https://rr1---sn.googlevideo.com/v")
    );
    assert!(m(&["network:*.googlevideo.com"]).allows_destination("https://a.b.googlevideo.com/"));
    assert!(!m(&["network:*.googlevideo.com"]).allows_destination("https://googlevideo.com/"));
    assert!(!m(&["network:*.googlevideo.com"]).allows_destination("https://notgooglevideo.com/"));
    // scheme: http is never permitted
    assert!(!m(&["network:music.youtube.com"]).allows_destination("http://music.youtube.com/"));
    // port is stripped for matching
    assert!(m(&["network:music.youtube.com"]).allows_destination("https://music.youtube.com:443/"));
}

// ---------- cancellation ----------

/// Cancellation aborts an in-flight HTTP request promptly.
#[tokio::test]
async fn cancel_aborts_inflight_http() {
    let wasm = ok(wat::parse_str(requester_wat("https://example.com/")));
    let plugin = ok(load(
        &wasm,
        manifest_for(&wasm, &["network:example.com"]),
        &default_budgets(),
    ));
    let cancel = CancellationToken::new();
    let budgets = default_budgets();
    let fut = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        cancel.clone(),
        &SleepHttp,
    );
    tokio::pin!(fut);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let t0 = Instant::now();
    cancel.cancel();
    let Invocation { result, .. } = fut.await;
    let latency = t0.elapsed();
    eprintln!("cancel abort latency: {latency:?}");
    assert!(
        matches!(err(result), InvokeError::Cancelled),
        "expected Cancelled"
    );
    assert!(
        latency < Duration::from_millis(500),
        "abort took {latency:?}"
    );
}

// ---------- byte budget ----------

#[tokio::test]
async fn byte_cap_on_response_body() {
    let wasm = ok(wat::parse_str(requester_wat("https://example.com/")));
    let mut budgets = default_budgets();
    budgets.max_bytes = 1024;
    budgets.max_steps = 10;
    let plugin = ok(load(
        &wasm,
        manifest_for(&wasm, &["network:example.com"]),
        &budgets,
    ));
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        &BigBodyHttp { size: 4096 },
    )
    .await;
    assert!(
        matches!(
            err(result),
            InvokeError::BudgetExceeded {
                dimension: BudgetDimension::Bytes
            }
        ),
        "expected byte-cap error"
    );
}

// ---------- conformance echo guest ----------

#[tokio::test]
async fn echo_guest_returns_step_input() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../sdk/conformance/echo/echo.wasm"
    );
    let wasm = read_wasm(path);
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &default_budgets()));
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({"source_ref": "dQw4w9WgXcQ"}),
        &default_budgets(),
        CancellationToken::new(),
        &http,
    )
    .await;
    let result: Value = ok(result);
    assert_eq!(
        result["payload"]["source_ref"],
        serde_json::json!("dQw4w9WgXcQ")
    );
}
