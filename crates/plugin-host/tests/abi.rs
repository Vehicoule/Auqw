//! ABI v0 contract tests: load-time rejection, budgets, permissions,
//! cancellation. Synthetic guests are hand-written WAT; `spin.wasm` /
//! `echo.wasm` are the checked-in Rust conformance artifacts.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use auqw_plugin_host::{
    invoke, load, BudgetDimension, Budgets, HostServices, HttpClient, HttpError, HttpErrorKind,
    HttpRequest, HttpResponse, Invocation, InvokeError, LoadError, Manifest, ManifestError,
    MemoryKeyValueStore, SystemClock,
};
use serde_json::Value;
use sha2::Digest;
use tokio_util::sync::CancellationToken;

/// Host services for tests that exercise only HTTP/PO behavior: a
/// shared volatile KV (never touched by these guests) and the system
/// clock.
fn svc<'a>(http: &'a dyn HttpClient, pot_provider: Option<&'a str>) -> HostServices<'a> {
    HostServices {
        http,
        kv: test_kv(),
        clock: &CLOCK,
        pot_provider,
    }
}

static CLOCK: SystemClock = SystemClock;

fn test_kv() -> &'static MemoryKeyValueStore {
    static KV: std::sync::OnceLock<MemoryKeyValueStore> = std::sync::OnceLock::new();
    KV.get_or_init(MemoryKeyValueStore::new)
}

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

fn manifest_text(wasm: &[u8], abi: &str, permissions: &[&str]) -> String {
    let digest = format!("sha256:{:x}", sha2::Sha256::digest(wasm));
    let perms: Vec<String> = permissions.iter().map(|p| format!("\"{p}\"")).collect();
    format!(
        "{{\"id\":\"test-plugin\",\"version\":\"0.1.0\",\"abi\":\"{abi}\",\
         \"capabilities\":[\"playback.resolve\"],\"permissions\":[{}],\
         \"artifact\":{{\"path\":\"test.wasm\",\"digest\":\"{digest}\"}}}}",
        perms.join(",")
    )
}

fn manifest_for_abi(wasm: &[u8], abi: &str, permissions: &[&str]) -> Manifest {
    ok(Manifest::from_json(&manifest_text(wasm, abi, permissions)))
}

fn manifest_for(wasm: &[u8], permissions: &[&str]) -> Manifest {
    manifest_for_abi(wasm, "0.1.0", permissions)
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
                bytes_received: 0,
            })
        })
    }
}

/// Records (url, body) of every request and answers `{poToken}`.
type RecordedRequests = Arc<std::sync::Mutex<Vec<(String, String)>>>;

struct RecordingHttp {
    reqs: RecordedRequests,
}

impl RecordingHttp {
    fn new() -> (Self, RecordedRequests) {
        let reqs = RecordedRequests::default();
        (
            Self {
                reqs: Arc::clone(&reqs),
            },
            reqs,
        )
    }
}

impl HttpClient for RecordingHttp {
    fn send(
        &self,
        req: HttpRequest,
        _timeout: Duration,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        if let Ok(mut reqs) = self.reqs.lock() {
            reqs.push((
                req.url.clone(),
                String::from_utf8_lossy(req.body.as_deref().unwrap_or(&[])).to_string(),
            ));
        }
        Box::pin(async {
            Ok(HttpResponse {
                status: 200,
                headers: vec![],
                body: br#"{"poToken":"tok-test"}"#.to_vec(),
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
                    bytes_received: 0,
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

/// Guest that immediately returns `done` with `result_json` (raw JSON
/// text) as its result.
fn done_wat(result_json: &str) -> String {
    let raw = format!("{{\"type\":\"done\",\"result\":{result_json}}}");
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

/// Guest that burns fuel inside `alloc` or `handle` before answering.
/// `busy_in` is `"alloc"` or `"handle"`.
fn busy_wat(busy_in: &str) -> String {
    let busy = "(local $i i32) (local.set $i (i32.const 1000000)) (loop $spin \
                (local.set $i (i32.sub (local.get $i) (i32.const 1))) \
                (br_if $spin (local.get $i)))";
    let raw = "{\"type\":\"done\",\"result\":{\"ok\":true}}";
    format!(
        "(module\n  (memory (export \"memory\") 1)\n  \
         (func (export \"alloc\") (param i32) (result i32) {} (i32.const 1024))\n  \
         (func (export \"handle\") (param i32 i32) (result i64) {} (i64.const {}))\n  \
         (data (i32.const 2048) \"{}\"))",
        if busy_in == "alloc" { busy } else { "" },
        if busy_in == "handle" { busy } else { "" },
        (2048u64 << 32) | raw.len() as u64,
        raw.replace('"', "\\\""),
    )
}

/// Guest that emits `raw` (a literal step message) as its output.
fn raw_wat(raw: &str) -> String {
    format!(
        "(module\n  (memory (export \"memory\") 1)\n  \
         (func (export \"alloc\") (param i32) (result i32) (i32.const 1024))\n  \
         (func (export \"handle\") (param i32 i32) (result i64) (i64.const {}))\n  \
         (data (i32.const 2048) \"{}\"))",
        (2048u64 << 32) | raw.len() as u64,
        raw.replace('"', "\\\""),
    )
}

/// Guest that emits a `pot_token` host request on every step, forever.
/// `payload` is the JSON object text placed under `"payload"`.
fn potter_wat(payload: &str) -> String {
    let raw = format!(
        "{{\"type\":\"host_request\",\"id\":1,\"kind\":\"pot_token\",\"payload\":{payload}}}"
    );
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

// ---------- ABI version isolation ----------

/// Only `0.1.0`/`0.2.0` exist; an unknown ABI is a manifest rejection,
/// not an implicit member of the newest capability set.
#[test]
fn manifest_rejects_unknown_abi() {
    let wasm = ok(wat::parse_str(DONE_WAT));
    let e = err(Manifest::from_json(&manifest_text(&wasm, "0.9.9", &[])));
    assert!(matches!(e, ManifestError::InvalidField(_)), "{e:?}");
}

/// `kv` is a 0.2 permission; a 0.1 manifest is a strict immutable
/// subset and cannot grow it.
#[test]
fn manifest_0_1_rejects_kv_permission() {
    let wasm = ok(wat::parse_str(DONE_WAT));
    let e = err(Manifest::from_json(&manifest_text(&wasm, "0.1.0", &["kv"])));
    assert!(matches!(e, ManifestError::InvalidField(_)), "{e:?}");
}

/// Under a 0.1 manifest the 0.2 service kinds are a protocol
/// violation — `invalid-message`, never `permission-denied`.
#[tokio::test]
async fn abi_0_1_rejects_0_2_host_request_kinds() {
    let messages = [
        r#"{"type":"host_request","id":1,"kind":"kv_get","payload":{"key":"k"}}"#,
        r#"{"type":"host_request","id":1,"kind":"kv_set","payload":{"key":"k","value":null}}"#,
        r#"{"type":"host_request","id":1,"kind":"log","payload":{"level":"info","message":"m"}}"#,
        r#"{"type":"host_request","id":1,"kind":"now_ms","payload":{}}"#,
    ];
    for msg in messages {
        let wasm = ok(wat::parse_str(raw_wat(msg)));
        let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &default_budgets()));
        let (http, _calls) = CannedHttp::new();
        let Invocation { result, .. } = invoke(
            &plugin,
            "playback.resolve",
            serde_json::json!({}),
            &default_budgets(),
            CancellationToken::new(),
            svc(&http, None),
        )
        .await;
        assert!(
            matches!(err(result), InvokeError::InvalidMessage(_)),
            "{msg}"
        );
    }
}

fn manifest_text_caps(wasm: &[u8], abi: &str, caps: &[&str], permissions: &[&str]) -> String {
    let digest = format!("sha256:{:x}", sha2::Sha256::digest(wasm));
    let caps: Vec<String> = caps.iter().map(|c| format!("\"{c}\"")).collect();
    let perms: Vec<String> = permissions.iter().map(|p| format!("\"{p}\"")).collect();
    format!(
        "{{\"id\":\"test-plugin\",\"version\":\"0.1.0\",\"abi\":\"{abi}\",\
         \"capabilities\":[{}],\"permissions\":[{}],\
         \"artifact\":{{\"path\":\"test.wasm\",\"digest\":\"{digest}\"}}}}",
        caps.join(","),
        perms.join(",")
    )
}

/// `0.3.0` accepts the full 0.2 set plus the new capabilities.
#[test]
fn manifest_accepts_0_3_capabilities() {
    let wasm = ok(wat::parse_str(DONE_WAT));
    let m = ok(Manifest::from_json(&manifest_text_caps(
        &wasm,
        "0.3.0",
        &[
            "catalog.search",
            "catalog.metadata",
            "catalog.artwork",
            "catalog.entity",
            "playback.resolve",
            "playback.candidates",
            "lyrics.plain",
            "lyrics.synced",
            "radio.seed",
        ],
        &["network:allowed.test"],
    )));
    assert_eq!(m.capabilities.len(), 9);
}

/// A `0.2.0` manifest is immutable — the 0.3 capabilities are a
/// rejection under it, not a forward-compatible surprise.
#[test]
fn manifest_0_2_rejects_0_3_capabilities() {
    let wasm = ok(wat::parse_str(DONE_WAT));
    for cap in [
        "catalog.entity",
        "lyrics.plain",
        "lyrics.synced",
        "radio.seed",
    ] {
        let e = err(Manifest::from_json(&manifest_text_caps(
            &wasm,
            "0.2.0",
            &[cap],
            &[],
        )));
        assert!(matches!(e, ManifestError::InvalidField(_)), "{cap}");
    }
}

/// Under a pre-0.3 manifest the `resume` service kind is a protocol
/// violation — `invalid-message`, never `permission-denied`.
#[tokio::test]
async fn abi_pre_0_3_rejects_resume_kind() {
    let msg = r#"{"type":"host_request","id":1,"kind":"resume","payload":{"url":"https://allowed.test/x","offset":5}}"#;
    for abi in ["0.1.0", "0.2.0"] {
        let wasm = ok(wat::parse_str(raw_wat(msg)));
        let plugin = ok(load(
            &wasm,
            manifest_for_abi(&wasm, abi, &["network:allowed.test"]),
            &default_budgets(),
        ));
        let (http, _calls) = CannedHttp::new();
        let Invocation { result, .. } = invoke(
            &plugin,
            "playback.resolve",
            serde_json::json!({}),
            &default_budgets(),
            CancellationToken::new(),
            svc(&http, None),
        )
        .await;
        assert!(
            matches!(err(result), InvokeError::InvalidMessage(_)),
            "{abi}"
        );
    }
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
        svc(&http, None),
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
        svc(&http, None),
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
    // Wall-clock smoke bound (load-tolerant): the trap is the real
    // assertion; this only guards against pathological slowdown.
    assert!(elapsed < Duration::from_secs(15), "trap took {elapsed:?}");
}

/// A guest entry that outlives the deadline is detached and reported
/// `deadline` at the deadline — fuel still bounds the detached burn —
/// instead of holding the caller to fuel-out. The spin guest loops
/// forever inside `handle`, so without the cap this test would run to
/// the 200 M fuel grant (seconds to minutes on a loaded emulator).
#[tokio::test]
async fn deadline_caps_a_running_guest_entry() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../sdk/conformance/spin/spin.wasm"
    );
    let wasm = read_wasm(path);
    let mut budgets = default_budgets();
    budgets.deadline = Duration::from_millis(50);
    budgets.fuel_per_entry = 200_000_000;
    budgets.fuel_total = 2_000_000_000;
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &budgets));
    let (http, _calls) = CannedHttp::new();
    let t0 = Instant::now();
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        svc(&http, None),
    )
    .await;
    let elapsed = t0.elapsed();
    assert!(
        matches!(
            err(result),
            InvokeError::BudgetExceeded {
                dimension: BudgetDimension::Deadline
            }
        ),
        "expected deadline cap, fuel_used={}",
        attempt.fuel_used
    );
    assert!(
        elapsed < Duration::from_secs(10),
        "deadline took {elapsed:?}"
    );
}

/// A cancel that lands while a guest entry runs is reported at once —
/// the detached entry keeps burning fuel in the background — rather
/// than waiting for the entry to return.
#[tokio::test]
async fn cancel_preempts_a_running_guest_entry() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../sdk/conformance/spin/spin.wasm"
    );
    let wasm = read_wasm(path);
    let mut budgets = default_budgets();
    budgets.deadline = Duration::from_secs(60);
    budgets.fuel_per_entry = 200_000_000;
    budgets.fuel_total = 2_000_000_000;
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &budgets));
    let (http, _calls) = CannedHttp::new();
    let cancel = CancellationToken::new();
    let cancel2 = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel2.cancel();
    });
    let t0 = Instant::now();
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        cancel,
        svc(&http, None),
    )
    .await;
    let elapsed = t0.elapsed();
    assert!(
        matches!(err(result), InvokeError::Cancelled),
        "expected cancellation"
    );
    assert!(elapsed < Duration::from_secs(10), "cancel took {elapsed:?}");
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
        svc(&http, None),
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
        svc(&http, None),
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
        svc(&http, None),
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

/// Cancellation aborts an in-flight HTTP request promptly. The invoke
/// future must actually be polled past the guest's `host_request` first —
/// polling `invoke` only after `cancel()` would exercise the pre-loop
/// check, not the in-flight abort.
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
        svc(&SleepHttp, None),
    );
    tokio::pin!(fut);
    // Drive the invocation until it is parked inside the HTTP send
    // (SleepHttp never resolves on its own).
    tokio::select! {
        _ = &mut fut => panic!("invoke returned before cancel"),
        () = tokio::time::sleep(Duration::from_millis(50)) => {}
    }
    let t0 = Instant::now();
    cancel.cancel();
    let Invocation { result, attempt } = fut.await;
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
    // The cancelled call is accounted: counted and traced.
    assert_eq!(attempt.http_calls, 1);
    assert_eq!(attempt.http_trace.len(), 1);
    assert_eq!(attempt.http_trace[0].status, None);
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
        svc(&BigBodyHttp { size: 4096 }, None),
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

// ---------- pot_token host request ----------

/// With permission and a configured provider the host POSTs to
/// `{provider}/get_pot` itself; the guest never sees the URL.
#[tokio::test]
async fn pot_token_reaches_configured_provider() {
    let wasm = ok(wat::parse_str(potter_wat(
        r#"{"content_binding":"vid12345678"}"#,
    )));
    let mut budgets = default_budgets();
    budgets.max_steps = 2;
    let plugin = ok(load(
        &wasm,
        manifest_for(&wasm, &["pot-provider"]),
        &budgets,
    ));
    let (http, reqs) = RecordingHttp::new();
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        svc(&http, Some("http://pot.local:4416")),
    )
    .await;
    assert!(matches!(
        err(result),
        InvokeError::BudgetExceeded {
            dimension: BudgetDimension::Steps
        }
    ));
    assert_eq!(attempt.http_calls, 2);
    let reqs = reqs.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(reqs.len(), 2);
    assert!(reqs.iter().all(|(url, body)| {
        url == "http://pot.local:4416/get_pot" && body.contains("vid12345678")
    }));
}

/// Without the `pot-provider` manifest permission the mint is denied
/// and consumes no HTTP budget.
#[tokio::test]
async fn pot_token_denied_without_permission() {
    let wasm = ok(wat::parse_str(potter_wat(
        r#"{"content_binding":"vid12345678"}"#,
    )));
    let mut budgets = default_budgets();
    budgets.max_steps = 2;
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &budgets));
    let (http, reqs) = RecordingHttp::new();
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        svc(&http, Some("http://pot.local:4416")),
    )
    .await;
    assert!(matches!(
        err(result),
        InvokeError::BudgetExceeded {
            dimension: BudgetDimension::Steps
        }
    ));
    assert_eq!(attempt.http_calls, 0);
    assert!(reqs.lock().map(|r| r.is_empty()).unwrap_or(false));
}

/// Permission declared but no provider configured: `unsupported`, and
/// again no HTTP budget is consumed.
#[tokio::test]
async fn pot_token_unsupported_without_provider() {
    let wasm = ok(wat::parse_str(potter_wat(
        r#"{"content_binding":"vid12345678"}"#,
    )));
    let mut budgets = default_budgets();
    budgets.max_steps = 2;
    let plugin = ok(load(
        &wasm,
        manifest_for(&wasm, &["pot-provider"]),
        &budgets,
    ));
    let (http, reqs) = RecordingHttp::new();
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        svc(&http, None),
    )
    .await;
    assert!(matches!(
        err(result),
        InvokeError::BudgetExceeded {
            dimension: BudgetDimension::Steps
        }
    ));
    assert_eq!(attempt.http_calls, 0);
    assert!(reqs.lock().map(|r| r.is_empty()).unwrap_or(false));
}

/// A `pot_token` request without a `content_binding` is a protocol
/// violation: the invocation ends `invalid-message` and no HTTP is spent.
#[tokio::test]
async fn pot_token_without_binding_is_invalid_message() {
    let wasm = ok(wat::parse_str(potter_wat("{}")));
    let mut budgets = default_budgets();
    budgets.max_steps = 2;
    let plugin = ok(load(
        &wasm,
        manifest_for(&wasm, &["pot-provider"]),
        &budgets,
    ));
    let (http, reqs) = RecordingHttp::new();
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        svc(&http, Some("http://pot.local:4416")),
    )
    .await;
    assert!(matches!(err(result), InvokeError::InvalidMessage(_)));
    assert_eq!(attempt.http_calls, 0);
    assert!(reqs.lock().map(|r| r.is_empty()).unwrap_or(false));
}

// ---------- done.result.url policy ----------

/// A `done` result `url` is the fetch target handed to the caller; it
/// must be an https destination the manifest's `network:` permissions
/// already allow — the plugin cannot mint fetch targets outside its own
/// sandbox. Non-string `url` values are rejected as malformed.
#[tokio::test]
async fn done_url_outside_allowlist_is_rejected() {
    for result in [
        r#"{"url":"https://evil.example.net/stream"}"#,
        r#"{"url":"http://192.168.1.1/admin"}"#,
        r#"{"url":123}"#,
    ] {
        let wasm = ok(wat::parse_str(done_wat(result)));
        let plugin = ok(load(
            &wasm,
            manifest_for(&wasm, &["network:example.com"]),
            &default_budgets(),
        ));
        let (http, _calls) = CannedHttp::new();
        let Invocation { result: r, .. } = invoke(
            &plugin,
            "playback.resolve",
            serde_json::json!({}),
            &default_budgets(),
            CancellationToken::new(),
            svc(&http, None),
        )
        .await;
        assert!(
            matches!(err(r), InvokeError::InvalidMessage(_)),
            "result {result} must be rejected"
        );
    }
}

#[tokio::test]
async fn done_url_within_allowlist_passes() {
    let wasm = ok(wat::parse_str(done_wat(
        r#"{"url":"https://cdn.example.net/stream","mime":"audio/mp4"}"#,
    )));
    let plugin = ok(load(
        &wasm,
        manifest_for(&wasm, &["network:*.example.net"]),
        &default_budgets(),
    ));
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &default_budgets(),
        CancellationToken::new(),
        svc(&http, None),
    )
    .await;
    assert_eq!(ok(result)["url"], "https://cdn.example.net/stream");
}

// ---------- HTTP client redirect policy ----------

/// The host HTTP client never follows redirects: a 3xx from an
/// allow-listed host would otherwise be chased to an arbitrary
/// destination the guest never declared. A local server answers
/// `POST /get_pot` with a 302 to `/redirected`; if the client followed
/// it, the second path would appear in the hit log.
#[tokio::test]
async fn host_http_never_follows_redirects() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => panic!("bind: {e}"),
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => panic!("addr: {e}"),
    };
    let hits = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let hits_task = Arc::clone(&hits);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let mut buf = vec![0u8; 8192];
            let Ok(n) = socket.read(&mut buf).await else {
                continue;
            };
            let text = String::from_utf8_lossy(&buf[..n]);
            let path = text
                .split_whitespace()
                .nth(1)
                .unwrap_or_default()
                .to_string();
            if let Ok(mut h) = hits_task.lock() {
                h.push(path.clone());
            }
            let response = if path == "/redirected" {
                let body = br#"{"poToken":"followed"}"#;
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    String::from_utf8_lossy(body)
                )
            } else {
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
            };
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });

    let wasm = ok(wat::parse_str(potter_wat(
        r#"{"content_binding":"vid12345678"}"#,
    )));
    let mut budgets = default_budgets();
    budgets.max_steps = 2;
    let plugin = ok(load(
        &wasm,
        manifest_for(&wasm, &["pot-provider"]),
        &budgets,
    ));
    let http = match auqw_plugin_host::ReqwestClient::new() {
        Ok(h) => h,
        Err(e) => panic!("client: {e}"),
    };
    let provider = format!("http://127.0.0.1:{port}");
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        svc(&http, Some(&provider)),
    )
    .await;
    assert!(matches!(
        err(result),
        InvokeError::BudgetExceeded {
            dimension: BudgetDimension::Steps
        }
    ));
    let seen = hits.lock().map(|h| h.clone()).unwrap_or_default();
    assert_eq!(
        seen,
        vec!["/get_pot".to_string(); 2],
        "redirect must not be followed; http_calls={}",
        attempt.http_calls
    );
}

// ---------- manifest validation vs schema ----------

/// `permissions` is a required field in the schema — absent must fail.
#[test]
fn manifest_requires_permissions_field() {
    let wasm = ok(wat::parse_str(DONE_WAT));
    let digest = format!("sha256:{:x}", sha2::Sha256::digest(&wasm));
    let text = format!(
        "{{\"id\":\"p\",\"version\":\"0.1.0\",\"abi\":\"0.1.0\",\
         \"capabilities\":[\"playback.resolve\"],\
         \"artifact\":{{\"path\":\"p.wasm\",\"digest\":\"{digest}\"}}}}"
    );
    assert!(
        matches!(
            Manifest::from_json(&text),
            Err(ManifestError::InvalidJson(_))
        ),
        "missing permissions must fail"
    );
}

/// Field shapes the schema enforces that serde alone does not.
#[test]
fn manifest_field_grammar_matches_schema() {
    let wasm = ok(wat::parse_str(DONE_WAT));
    let digest = format!("sha256:{:x}", sha2::Sha256::digest(&wasm));
    let manifest_json = |id: &str, version: &str, caps: &str, path: &str, digest: &str| {
        format!(
            "{{\"id\":\"{id}\",\"version\":\"{version}\",\"abi\":\"0.1.0\",\
             \"capabilities\":{caps},\"permissions\":[],\
             \"artifact\":{{\"path\":\"{path}\",\"digest\":\"{digest}\"}}}}"
        )
    };
    let caps = "[\"playback.resolve\"]";
    for bad in [
        manifest_json("Bad-Id", "0.1.0", caps, "p.wasm", &digest),
        manifest_json("-bad", "0.1.0", caps, "p.wasm", &digest),
        manifest_json("p", "0.1", caps, "p.wasm", &digest),
        manifest_json("p", "0.1.0", "[\"catalog.search\"]", "p.wasm", &digest),
        manifest_json("p", "0.1.0", caps, "", &digest),
        manifest_json("p", "0.1.0", caps, "p.wasm", "sha256:xyz"),
        manifest_json("p", "0.1.0", caps, "p.wasm", "md5:000"),
    ] {
        assert!(
            matches!(
                Manifest::from_json(&bad),
                Err(ManifestError::InvalidField(_))
            ),
            "{bad} must be rejected"
        );
    }
    ok(Manifest::from_json(&manifest_json(
        "youtube-music",
        "0.1.0",
        caps,
        "dist/p.wasm",
        &digest,
    )));
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
        svc(&http, None),
    )
    .await;
    let result: Value = ok(result);
    assert_eq!(
        result["payload"]["source_ref"],
        serde_json::json!("dQw4w9WgXcQ")
    );
}

// ---------- step-message strictness (audit round 5) ----------

/// `done` without a `result` key is malformed — the schema requires
/// the field even when the value is null.
#[tokio::test]
async fn done_without_result_is_invalid_message() {
    let wasm = ok(wat::parse_str(raw_wat("{\"type\":\"done\"}")));
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &default_budgets()));
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &default_budgets(),
        CancellationToken::new(),
        svc(&http, None),
    )
    .await;
    assert!(matches!(err(result), InvokeError::InvalidMessage(_)));
}

/// An explicit `result: null` is well-formed and stays `Ok(Null)`.
#[tokio::test]
async fn done_with_null_result_is_ok() {
    let wasm = ok(wat::parse_str(raw_wat(
        "{\"type\":\"done\",\"result\":null}",
    )));
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &default_budgets()));
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &default_budgets(),
        CancellationToken::new(),
        svc(&http, None),
    )
    .await;
    assert_eq!(ok(result), Value::Null);
}

/// A `fail` kind outside the ABI taxonomy is a protocol violation, not
/// a guest failure — the host must not invent kinds it cannot classify.
#[tokio::test]
async fn fail_with_unknown_kind_is_invalid_message() {
    let wasm = ok(wat::parse_str(raw_wat(
        "{\"type\":\"fail\",\"error\":{\"kind\":\"BANANA\",\"message\":\"x\"}}",
    )));
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &default_budgets()));
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &default_budgets(),
        CancellationToken::new(),
        svc(&http, None),
    )
    .await;
    assert!(matches!(err(result), InvokeError::InvalidMessage(_)));
}

/// A `fail` message is guest-controlled text: a signed URL quoted into
/// it must reach the error surface only in redacted form.
#[tokio::test]
async fn fail_message_is_redacted() {
    let wasm = ok(wat::parse_str(raw_wat(
        "{\"type\":\"fail\",\"error\":{\"kind\":\"transient\",\
         \"message\":\"see https://media.invalid/play?token=SYNTHETIC_SECRET bye\"}}",
    )));
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &default_budgets()));
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &default_budgets(),
        CancellationToken::new(),
        svc(&http, None),
    )
    .await;
    let e = err(result);
    let InvokeError::GuestFail { kind, message } = &e else {
        panic!("expected GuestFail, got {e:?}");
    };
    assert_eq!(kind, "transient");
    assert_eq!(message, "see https://media.invalid/play?… bye");
    assert!(!e.to_string().contains("SYNTHETIC_SECRET"), "{e}");
}

// ---------- preemption between guest entries ----------

/// A cancel that lands while a CPU-bound `alloc` runs is observed
/// before `handle` is entered — the token is checked between entries,
/// not only at the loop top.
#[tokio::test]
async fn cancel_during_alloc_is_observed() {
    let wasm = ok(wat::parse_str(busy_wat("alloc")));
    let mut budgets = default_budgets();
    budgets.deadline = Duration::from_secs(60);
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &budgets));
    let cancel = CancellationToken::new();
    let c = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(20));
        c.cancel();
    });
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        cancel,
        svc(&http, None),
    )
    .await;
    assert!(matches!(err(result), InvokeError::Cancelled));
}

/// A cancel that lands mid-`handle` outranks the `done` the entry
/// produced — the caller cancelled the result itself.
#[tokio::test]
async fn cancel_during_handle_outranks_done() {
    let wasm = ok(wat::parse_str(busy_wat("handle")));
    let mut budgets = default_budgets();
    budgets.deadline = Duration::from_secs(60);
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &budgets));
    let cancel = CancellationToken::new();
    let c = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(20));
        c.cancel();
    });
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        cancel,
        svc(&http, None),
    )
    .await;
    assert!(matches!(err(result), InvokeError::Cancelled));
}

/// Wasmi cannot preempt a CPU-bound entry mid-run — fuel bounds it —
/// but a deadline crossed while the guest ran is still the reported
/// outcome, not the guest's `done`.
#[tokio::test]
async fn deadline_crossed_during_entry_wins() {
    let wasm = ok(wat::parse_str(busy_wat("handle")));
    let mut budgets = default_budgets();
    budgets.deadline = Duration::from_millis(5);
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &budgets));
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        svc(&http, None),
    )
    .await;
    assert!(
        matches!(
            err(result),
            InvokeError::BudgetExceeded {
                dimension: BudgetDimension::Deadline
            }
        ),
        "expected deadline budget error"
    );
}

// ---------- byte budget on failed calls ----------

/// Bytes pulled before a mid-body failure still count toward the byte
/// budget — a flaky/capping server cannot stream unaccounted data.
struct PartialThenFailHttp;

impl HttpClient for PartialThenFailHttp {
    fn send(
        &self,
        _req: HttpRequest,
        _timeout: Duration,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        Box::pin(async {
            Err(HttpError {
                kind: HttpErrorKind::Transient,
                message: "body truncated".into(),
                bytes_received: 1500,
            })
        })
    }
}

#[tokio::test]
async fn partial_response_bytes_count_toward_budget() {
    let wasm = ok(wat::parse_str(requester_wat("https://example.com/")));
    let mut budgets = default_budgets();
    budgets.max_bytes = 2048;
    budgets.max_steps = 10;
    let plugin = ok(load(
        &wasm,
        manifest_for(&wasm, &["network:example.com"]),
        &budgets,
    ));
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        svc(&PartialThenFailHttp, None),
    )
    .await;
    assert!(
        matches!(
            err(result),
            InvokeError::BudgetExceeded {
                dimension: BudgetDimension::Bytes
            }
        ),
        "expected byte-cap error from partial bodies"
    );
    // Two calls of 1500 received bytes each cross the 2048 cap.
    assert_eq!(attempt.bytes, 3000);
    assert_eq!(attempt.http_calls, 2);
}

// ---------- envelope strictness (audit round 6) ----------

/// Guest emitting one literal step message, then checking the result.
/// `check` inspects the invoke outcome.
async fn raw_step_outcome(raw: &str, permissions: &[&str]) -> InvokeError {
    let wasm = ok(wat::parse_str(raw_wat(raw)));
    let plugin = ok(load(
        &wasm,
        manifest_for(&wasm, permissions),
        &default_budgets(),
    ));
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &default_budgets(),
        CancellationToken::new(),
        svc(&http, None),
    )
    .await;
    err(result)
}

/// `done` carrying an extra key violates `additionalProperties: false`.
#[tokio::test]
async fn done_with_unknown_key_is_invalid_message() {
    let e = raw_step_outcome("{\"type\":\"done\",\"result\":null,\"extra\":1}", &[]).await;
    assert!(matches!(e, InvokeError::InvalidMessage(_)), "{e:?}");
}

/// `fail.error` carrying an extra key is likewise off-schema.
#[tokio::test]
async fn fail_error_with_unknown_key_is_invalid_message() {
    let e = raw_step_outcome(
        "{\"type\":\"fail\",\"error\":{\"kind\":\"transient\",\"message\":\"x\",\"hint\":1}}",
        &[],
    )
    .await;
    assert!(matches!(e, InvokeError::InvalidMessage(_)), "{e:?}");
}

/// A `host_request` envelope with an unknown key is rejected before
/// the request is authorized.
#[tokio::test]
async fn host_request_with_unknown_key_is_invalid_message() {
    let e = raw_step_outcome(
        "{\"type\":\"host_request\",\"id\":1,\"kind\":\"http_request\",\"note\":\"x\",\
         \"payload\":{\"method\":\"GET\",\"url\":\"https://example.com/\",\"headers\":[],\"body\":null}}",
        &["network:example.com"],
    )
    .await;
    assert!(matches!(e, InvokeError::InvalidMessage(_)), "{e:?}");
}

/// `http_request.payload` accepts no keys beyond the schema's four.
#[tokio::test]
async fn http_payload_with_unknown_key_is_invalid_message() {
    let e = raw_step_outcome(
        "{\"type\":\"host_request\",\"id\":1,\"kind\":\"http_request\",\
         \"payload\":{\"method\":\"GET\",\"url\":\"https://example.com/\",\"headers\":[],\"body\":null,\"meta\":{}}}",
        &["network:example.com"],
    )
    .await;
    assert!(matches!(e, InvokeError::InvalidMessage(_)), "{e:?}");
}

/// `body` is a required key — `null` is bodiless, absent is malformed.
#[tokio::test]
async fn http_payload_missing_body_key_is_invalid_message() {
    let e = raw_step_outcome(
        "{\"type\":\"host_request\",\"id\":1,\"kind\":\"http_request\",\
         \"payload\":{\"method\":\"GET\",\"url\":\"https://example.com/\",\"headers\":[]}}",
        &["network:example.com"],
    )
    .await;
    assert!(matches!(e, InvokeError::InvalidMessage(_)), "{e:?}");
}

/// A header tuple is exactly `[name, value]` — three elements is not
/// a pair the schema admits.
#[tokio::test]
async fn http_header_triplet_is_invalid_message() {
    let e = raw_step_outcome(
        "{\"type\":\"host_request\",\"id\":1,\"kind\":\"http_request\",\
         \"payload\":{\"method\":\"GET\",\"url\":\"https://example.com/\",\
         \"headers\":[[\"Accept\",\"*/*\",\"extra\"]],\"body\":null}}",
        &["network:example.com"],
    )
    .await;
    assert!(matches!(e, InvokeError::InvalidMessage(_)), "{e:?}");
}

/// `pot_token` payload accepts only `content_binding`.
#[tokio::test]
async fn pot_payload_with_unknown_key_is_invalid_message() {
    let e = raw_step_outcome(
        "{\"type\":\"host_request\",\"id\":1,\"kind\":\"pot_token\",\
         \"payload\":{\"content_binding\":\"vid\",\"scope\":\"all\"}}",
        &["pot-provider"],
    )
    .await;
    assert!(matches!(e, InvokeError::InvalidMessage(_)), "{e:?}");
}

// ---------- guest log budget ----------

/// Guest that emits a `log` host_request on every step, forever.
fn logger_wat() -> String {
    raw_wat(
        "{\"type\":\"host_request\",\"id\":1,\"kind\":\"log\",\
         \"payload\":{\"level\":\"info\",\"message\":\"m\"}}",
    )
}

/// The 129th log entry of one invocation is a typed budget failure,
/// not silent allocation growth.
#[tokio::test]
async fn guest_log_cap_stops_logger() {
    let wasm = ok(wat::parse_str(logger_wat()));
    let plugin = ok(load(
        &wasm,
        manifest_for_abi(&wasm, "0.2.0", &[]),
        &default_budgets(),
    ));
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &default_budgets(),
        CancellationToken::new(),
        svc(&http, None),
    )
    .await;
    assert!(
        matches!(
            err(result),
            InvokeError::BudgetExceeded {
                dimension: BudgetDimension::GuestLog
            }
        ),
        "expected guest-log budget error"
    );
    assert_eq!(attempt.guest_log.len(), 128);
    assert_eq!(attempt.http_calls, 0);
}

// ---------- hardening regression tests ----------

/// A guest-supplied `Host` header would let a shared-frontend edge
/// serve a destination the manifest never permitted — the header is
/// host-controlled, not guest-settable. Same for framing/hop-by-hop
/// headers, which are a smuggling surface under any proxy.
#[tokio::test]
async fn host_controlled_headers_are_rejected() {
    for header in [
        "Host",
        "Connection",
        "Keep-Alive",
        "Transfer-Encoding",
        "Content-Length",
        "TE",
        "Trailer",
        "Upgrade",
        "Expect",
        "Via",
        "Proxy-Authorization",
        "Proxy-Connection",
    ] {
        let msg = format!(
            "{{\"type\":\"host_request\",\"id\":1,\"kind\":\"http_request\",\
             \"payload\":{{\"method\":\"GET\",\"url\":\"https://allowed.test/x\",\
             \"headers\":[[\"{header}\",\"v\"]],\"body\":null}}}}"
        );
        let wasm = ok(wat::parse_str(raw_wat(&msg)));
        let plugin = ok(load(
            &wasm,
            manifest_for(&wasm, &["network:allowed.test"]),
            &default_budgets(),
        ));
        let (http, _calls) = CannedHttp::new();
        let Invocation { result, .. } = invoke(
            &plugin,
            "playback.resolve",
            serde_json::json!({}),
            &default_budgets(),
            CancellationToken::new(),
            svc(&http, None),
        )
        .await;
        assert!(
            matches!(err(result), InvokeError::InvalidMessage(_)),
            "{header}"
        );
    }
}

/// `access_token` merged into the invoke payload is session material
/// the guest must not echo into diagnostics — a `log` quoting it is
/// masked, not recorded verbatim.
#[tokio::test]
async fn access_token_is_masked_in_guest_log() {
    let wasm = ok(wat::parse_str(raw_wat(
        "{\"type\":\"host_request\",\"id\":1,\"kind\":\"log\",\
         \"payload\":{\"level\":\"info\",\"message\":\"saw tok-secret-value-9 ok\"}}",
    )));
    let plugin = ok(load(
        &wasm,
        manifest_for_abi(&wasm, "0.2.0", &[]),
        &default_budgets(),
    ));
    let (http, _calls) = CannedHttp::new();
    let Invocation { attempt, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({"access_token": "tok-secret-value-9"}),
        &default_budgets(),
        CancellationToken::new(),
        svc(&http, None),
    )
    .await;
    let entry = &attempt.guest_log[0];
    assert!(!entry.message.contains("tok-secret-value-9"), "{entry:?}");
    assert!(entry.message.contains("***"));
}

/// The same masking applies to a guest `fail` message.
#[tokio::test]
async fn access_token_is_masked_in_fail() {
    let wasm = ok(wat::parse_str(raw_wat(
        "{\"type\":\"fail\",\"error\":{\"kind\":\"transient\",\
         \"message\":\"abort at tok-secret-value-9\"}}",
    )));
    let plugin = ok(load(
        &wasm,
        manifest_for_abi(&wasm, "0.2.0", &[]),
        &default_budgets(),
    ));
    let (http, _calls) = CannedHttp::new();
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({"access_token": "tok-secret-value-9"}),
        &default_budgets(),
        CancellationToken::new(),
        svc(&http, None),
    )
    .await;
    match err(result) {
        InvokeError::GuestFail { message, .. } => {
            assert!(!message.contains("tok-secret-value-9"), "{message}");
            assert!(message.contains("***"));
        }
        e => panic!("expected GuestFail, got {e:?}"),
    }
}

/// `attempt`'s `Debug` output must not carry secrets — the field is
/// crate-private and excluded from the impl.
#[test]
fn attempt_debug_does_not_leak_secrets() {
    let wasm = ok(wat::parse_str(DONE_WAT));
    let plugin = ok(load(&wasm, manifest_for(&wasm, &[]), &default_budgets()));
    let rt = ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build());
    let (http, _calls) = CannedHttp::new();
    let invocation = rt.block_on(invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({"access_token": "tok-secret-value-9"}),
        &default_budgets(),
        CancellationToken::new(),
        svc(&http, None),
    ));
    let dbg = format!("{:?}", invocation.attempt);
    assert!(!dbg.contains("tok-secret-value-9"), "{dbg}");
    assert!(!dbg.contains("secrets"), "{dbg}");
}

/// `load` must refuse modules that can never instantiate under the
/// store limits — not admit them as valid artifacts that trap later.
#[test]
fn load_rejects_modules_beyond_store_limits() {
    // Two memories: multi-memory is off in the ABI shape.
    let wasm = ok(wat::parse_str(
        r#"(module
          (memory (export "memory") 1)
          (memory 1)
          (func (export "alloc") (param i32) (result i32) (i32.const 0))
          (func (export "handle") (param i32 i32) (result i64) (i64.const 0)))"#,
    ));
    assert!(
        matches!(
            err(load(&wasm, manifest_for(&wasm, &[]), &default_budgets())),
            LoadError::ExceedsLimits(_)
        ),
        "two memories"
    );

    // 4 GiB minimum memory — the store caps at `max_memory_bytes`.
    let wasm = ok(wat::parse_str(
        r#"(module
          (memory (export "memory") 65536)
          (func (export "alloc") (param i32) (result i32) (i32.const 0))
          (func (export "handle") (param i32 i32) (result i64) (i64.const 0)))"#,
    ));
    assert!(
        matches!(
            err(load(&wasm, manifest_for(&wasm, &[]), &default_budgets())),
            LoadError::ExceedsLimits(_)
        ),
        "4 GiB memory"
    );

    // 17 tables — the store allows 16.
    let tables = "(table 1 funcref)".repeat(17);
    let wasm = ok(wat::parse_str(format!(
        "(module\n  (memory (export \"memory\") 1)\n  {tables}\n  \
         (func (export \"alloc\") (param i32) (result i32) (i32.const 0))\n  \
         (func (export \"handle\") (param i32 i32) (result i64) (i64.const 0)))"
    )));
    assert!(
        matches!(
            err(load(&wasm, manifest_for(&wasm, &[]), &default_budgets())),
            LoadError::ExceedsLimits(_)
        ),
        "17 tables"
    );
}

/// A manifest deserialized outside `from_json` is re-validated by
/// `load` — the digest check runs against a policy that was verified,
/// not just parsed.
#[test]
fn load_revalidates_a_deserialized_manifest() {
    let wasm = ok(wat::parse_str(DONE_WAT));
    // `network:` names a public DNS destination or loopback — a
    // non-loopback IP, a bare label, a TLD wildcard, or a broken name
    // must not self-authorize.
    for perm in [
        "network:169.254.169.254",
        "network:10.0.0.5",
        "network:*.com",
        "network:internal",
        "network:bad..dots",
        "network:sub.localhost",
    ] {
        let e = err(Manifest::from_json(&manifest_text(&wasm, "0.1.0", &[perm])));
        assert!(matches!(e, ManifestError::InvalidField(_)), "{perm}");
    }
    // And the same inputs rejected when a Manifest is materialized
    // without going through `from_json`'s validation.
    for perm in ["network:169.254.169.254", "network:*.com"] {
        let mut manifest = manifest_for(&wasm, &[]);
        manifest.permissions = vec![perm.to_string()];
        let e = err(load(&wasm, manifest, &default_budgets()));
        assert!(matches!(e, LoadError::Manifest(_)), "{perm}: {e:?}");
    }
    // The legitimate forms — dotted names and loopback literals — pass.
    for perm in [
        "network:example.com",
        "network:*.googlevideo.com",
        "network:127.0.0.1",
        "network:localhost",
    ] {
        ok(Manifest::from_json(&manifest_text(&wasm, "0.1.0", &[perm])));
    }
}
