//! Slice 1 service tests against the checked-in `scenario.wasm`
//! conformance guest: staged KV commit/rollback, file-store
//! persistence, deterministic clock, redacted logs, permission and
//! size-cap enforcement.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use auqw_plugin_host::{
    invoke, load, Budgets, FileKeyValueStore, HostClock, HostServices, HttpClient, HttpError,
    HttpErrorKind, HttpRequest, HttpResponse, Invocation, InvokeError, KeyValueStore, KvError,
    Manifest, MemoryKeyValueStore,
};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::json;
use sha2::Digest;
use tokio_util::sync::CancellationToken;

const SCENARIO_WASM: &[u8] = include_bytes!("../../../sdk/conformance/scenario/scenario.wasm");

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

/// ABI-parameterized manifest; capabilities stay on `playback.resolve`
/// — the scenario payload selects the behavior.
fn manifest_for_abi(wasm: &[u8], abi: &str, permissions: &[&str]) -> Manifest {
    let digest = format!("sha256:{:x}", sha2::Sha256::digest(wasm));
    let perms: Vec<String> = permissions.iter().map(|p| format!("\"{p}\"")).collect();
    let text = format!(
        "{{\"id\":\"test-plugin\",\"version\":\"0.1.0\",\"abi\":\"{abi}\",\
         \"capabilities\":[\"playback.resolve\"],\"permissions\":[{}],\
         \"artifact\":{{\"path\":\"scenario.wasm\",\"digest\":\"{digest}\"}}}}",
        perms.join(",")
    );
    ok(Manifest::from_json(&text))
}

/// ABI 0.2 manifest.
fn manifest_for(wasm: &[u8], permissions: &[&str]) -> Manifest {
    manifest_for_abi(wasm, "0.2.0", permissions)
}

struct CannedHttp {
    status: u16,
    body: Vec<u8>,
}

impl HttpClient for CannedHttp {
    fn send(
        &self,
        _req: HttpRequest,
        _timeout: Duration,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        let status = self.status;
        let body = self.body.clone();
        Box::pin(async move {
            Ok(HttpResponse {
                status,
                headers: vec![],
                body,
            })
        })
    }
}

/// Never resolves; only cancellation ends the wait.
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

struct FixedClock(u64);

impl HostClock for FixedClock {
    fn now_ms(&self) -> u64 {
        self.0
    }
}

fn services<'a>(
    http: &'a dyn HttpClient,
    kv: Arc<dyn KeyValueStore>,
    clock: &'a dyn HostClock,
) -> HostServices<'a> {
    HostServices {
        http,
        kv,
        clock,
        pot_provider: None,
    }
}

/// A staged `kv_set` commits on `done` and is visible to read-your-writes
/// inside the same invocation.
#[tokio::test]
async fn kv_commit_writes_and_reads_back() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = CannedHttp {
        status: 200,
        body: vec![],
    };
    let clock = FixedClock(7_777);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for(SCENARIO_WASM, &["kv"]),
        &Budgets::default(),
    ));
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        json!({"scenario": "kv_commit", "key": "k", "value": "v1"}),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    let result = ok(result);
    assert_eq!(result["read_back"], "v1");
    assert_eq!(result["now_ms"], 7_777);
    assert_eq!(attempt.http_calls, 0);
    assert_eq!(attempt.guest_log.len(), 1);
    assert_eq!(attempt.guest_log[0].level, "info");
    let committed = ok(kv.snapshot("test-plugin"));
    assert_eq!(
        committed.get("k").map(Vec::as_slice),
        Some(b"v1".as_slice())
    );
}

/// A `fail` after staging must not commit anything.
#[tokio::test]
async fn kv_fail_discards_staged_writes() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = CannedHttp {
        status: 200,
        body: vec![],
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for(SCENARIO_WASM, &["kv"]),
        &Budgets::default(),
    ));
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        json!({"scenario": "kv_fail", "key": "k", "value": "v1"}),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    let e = err(result);
    assert_eq!(e.kind(), "transient");
    assert!(ok(kv.snapshot("test-plugin")).is_empty());
}

/// Committed state survives into a new store instance over the same file.
#[tokio::test]
async fn file_store_persists_across_instances() {
    let dir = std::env::temp_dir().join(format!("auqw-kv-test-{}", std::process::id()));
    let path = dir.join("plugin-kv.json");
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir_all(&dir);
    ok(std::fs::create_dir_all(&dir).map_err(|e| format!("{e:?}")));
    let http = CannedHttp {
        status: 200,
        body: vec![],
    };
    let clock = FixedClock(0);
    {
        let kv = Arc::new(ok(FileKeyValueStore::new(&path)));
        let plugin = ok(load(
            SCENARIO_WASM,
            manifest_for(SCENARIO_WASM, &["kv"]),
            &Budgets::default(),
        ));
        let Invocation { result, .. } = invoke(
            &plugin,
            "playback.resolve",
            json!({"scenario": "kv_commit", "key": "k", "value": "v1"}),
            &Budgets::default(),
            CancellationToken::new(),
            services(&http, kv.clone(), &clock),
        )
        .await;
        ok(result);
    }
    let kv = Arc::new(ok(FileKeyValueStore::new(&path)));
    let committed: BTreeMap<String, Vec<u8>> = ok(kv.snapshot("test-plugin"));
    assert_eq!(
        committed.get("k").map(Vec::as_slice),
        Some(b"v1".as_slice())
    );
    // The file is JSON with base64 values — `v1` is stored as `djE=`.
    let text = ok(std::fs::read_to_string(&path).map_err(|e| format!("{e:?}")));
    assert!(text.contains("djE="), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A malformed store file is a typed error, never a silent reset.
#[test]
fn corrupt_file_store_is_typed_error() {
    let dir = std::env::temp_dir().join(format!("auqw-kv-bad-{}", std::process::id()));
    ok(std::fs::create_dir_all(&dir).map_err(|e| format!("{e:?}")));
    let path = dir.join("plugin-kv.json");
    ok(std::fs::write(&path, b"not json").map_err(|e| format!("{e:?}")));
    match FileKeyValueStore::new(&path) {
        Err(KvError::Corrupt(_)) => {}
        Err(e) => panic!("expected Corrupt, got {e:?}"),
        Ok(_) => panic!("expected Corrupt, got store"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Guest log text is redacted before it lands on the attempt.
#[tokio::test]
async fn guest_log_is_redacted() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = CannedHttp {
        status: 200,
        body: vec![],
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for(SCENARIO_WASM, &["kv"]),
        &Budgets::default(),
    ));
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        json!({
            "scenario": "kv_commit", "key": "k", "value": "v",
            "message": "see https://rr1---sn.x/stream?sig=SYNTHETIC_SECRET ok",
        }),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    ok(result);
    let entry = &attempt.guest_log[0];
    assert!(
        !entry.message.contains("SYNTHETIC_SECRET"),
        "{}",
        entry.message
    );
    assert!(entry.message.contains("https://rr1---sn.x/stream"));
}

/// Without the `kv` permission the guest gets `permission-denied` and
/// nothing is staged.
#[tokio::test]
async fn kv_without_permission_is_denied() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = CannedHttp {
        status: 200,
        body: vec![],
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for(SCENARIO_WASM, &[]),
        &Budgets::default(),
    ));
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        json!({"scenario": "kv_commit", "key": "k", "value": "v"}),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    let e = err(result);
    assert_eq!(e.kind(), "permission-denied");
    assert!(ok(kv.snapshot("test-plugin")).is_empty());
}

/// A decoded value over 64 KiB is refused with `invalid-response` and
/// mutates nothing.
#[tokio::test]
async fn kv_value_over_cap_is_refused() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = CannedHttp {
        status: 200,
        body: vec![],
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for(SCENARIO_WASM, &["kv"]),
        &Budgets::default(),
    ));
    let big = "x".repeat(80 * 1024);
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        json!({"scenario": "kv_commit", "key": "k", "value": big}),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    let e = err(result);
    assert_eq!(e.kind(), "invalid-response");
    assert!(ok(kv.snapshot("test-plugin")).is_empty());
}

/// The `http` scenario relays a canned response; the destination must
/// be allow-listed.
#[tokio::test]
async fn http_scenario_relays_response() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = CannedHttp {
        status: 503,
        body: b"hello".to_vec(),
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for(SCENARIO_WASM, &["kv", "network:allowed.test"]),
        &Budgets::default(),
    ));
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        json!({"scenario": "http", "url": "https://allowed.test/x"}),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    let result = ok(result);
    assert_eq!(result["status"], 503);
    assert_eq!(result["body_len"], 5);
    assert_eq!(attempt.http_calls, 1);
}

/// A canned ranged response for `resume` tests.
struct RangeHttp {
    status: u16,
    content_range: Option<&'static str>,
    body: Vec<u8>,
}

impl HttpClient for RangeHttp {
    fn send(
        &self,
        _req: HttpRequest,
        _timeout: Duration,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        let status = self.status;
        let body = self.body.clone();
        let headers = self
            .content_range
            .map(|v| vec![("content-range".to_string(), v.to_string())])
            .unwrap_or_default();
        Box::pin(async move {
            Ok(HttpResponse {
                status,
                headers,
                body,
            })
        })
    }
}

/// A `resume` continuation relays the ranged body when `Content-Range`
/// agrees with the request.
#[tokio::test]
async fn resume_relays_206_body() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = RangeHttp {
        status: 206,
        content_range: Some("bytes 5-9/20"),
        body: b"hello".to_vec(),
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for_abi(SCENARIO_WASM, "0.3.0", &["network:allowed.test"]),
        &Budgets::default(),
    ));
    let Invocation { result, attempt } = invoke(
        &plugin,
        "playback.resolve",
        json!({"scenario": "resume", "url": "https://allowed.test/x", "offset": 5, "length": 5}),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    let result = ok(result);
    assert_eq!(result["status"], 206);
    assert_eq!(result["body_len"], 5);
    assert_eq!(attempt.http_calls, 1);
}

/// A `206` whose `Content-Range` doesn't start at the requested offset
/// is a failed host request — the guest sees `invalid-response`, never
/// a misaligned body.
#[tokio::test]
async fn resume_rejects_mismatched_range() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = RangeHttp {
        status: 206,
        content_range: Some("bytes 4-9/20"),
        body: b"hello".to_vec(),
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for_abi(SCENARIO_WASM, "0.3.0", &["network:allowed.test"]),
        &Budgets::default(),
    ));
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        json!({"scenario": "resume", "url": "https://allowed.test/x", "offset": 5, "length": 5}),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    let result = ok(result);
    assert_eq!(result["host_error"], "invalid-response");
}

/// `resume` uses the same destination allowlist as `http_request`.
#[tokio::test]
async fn resume_denied_without_permission() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = RangeHttp {
        status: 206,
        content_range: Some("bytes 5-9/20"),
        body: vec![],
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for_abi(SCENARIO_WASM, "0.3.0", &[]),
        &Budgets::default(),
    ));
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        json!({"scenario": "resume", "url": "https://allowed.test/x", "offset": 5}),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    let result = ok(result);
    assert_eq!(result["host_error"], "permission-denied");
}

/// A non-`206` answer is the upstream's real answer — it passes
/// through instead of being range-checked.
#[tokio::test]
async fn resume_passes_non_206_through() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = RangeHttp {
        status: 200,
        content_range: None,
        body: b"full".to_vec(),
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for_abi(SCENARIO_WASM, "0.3.0", &["network:allowed.test"]),
        &Budgets::default(),
    ));
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        json!({"scenario": "resume", "url": "https://allowed.test/x", "offset": 5}),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    let result = ok(result);
    assert_eq!(result["status"], 200);
    assert_eq!(result["body_len"], 4);
}

/// The `echo` scenario passes the payload through unchanged.
#[tokio::test]
async fn echo_scenario_returns_payload() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = CannedHttp {
        status: 200,
        body: vec![],
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for(SCENARIO_WASM, &[]),
        &Budgets::default(),
    ));
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        json!({"scenario": "echo", "echo": {"n": 3}}),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    assert_eq!(ok(result), json!({"n": 3}));
}

/// A staged write parked behind an HTTP request must not survive
/// cancellation: the `kv_http` scenario stages `k`, then blocks in a
/// send that never resolves until cancelled.
#[tokio::test]
async fn kv_http_cancel_discards_staged_write() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for(SCENARIO_WASM, &["kv", "network:allowed.test"]),
        &Budgets::default(),
    ));
    let cancel = CancellationToken::new();
    let budgets = Budgets::default();
    let fut = invoke(
        &plugin,
        "playback.resolve",
        json!({
            "scenario": "kv_http", "key": "k", "value": "v1",
            "url": "https://allowed.test/x",
        }),
        &budgets,
        cancel.clone(),
        services(&SleepHttp, kv.clone(), &clock),
    );
    tokio::pin!(fut);
    // Drive the invocation until it is parked inside the HTTP send.
    tokio::select! {
        _ = &mut fut => panic!("invoke returned before cancel"),
        () = tokio::time::sleep(Duration::from_millis(50)) => {}
    }
    cancel.cancel();
    let Invocation { result, .. } = fut.await;
    assert!(matches!(err(result), InvokeError::Cancelled));
    assert!(ok(kv.snapshot("test-plugin")).is_empty());
}

/// Individually legal values whose committed total exceeds the
/// 256 KiB namespace cap are refused and mutate nothing.
#[tokio::test]
async fn kv_namespace_total_cap_is_refused() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    // Prefill ~240 KiB of committed namespace across four keys.
    let patch: BTreeMap<String, Option<Vec<u8>>> = (0..4)
        .map(|i| (format!("k{i}"), Some(vec![b'x'; 60 * 1024])))
        .collect();
    ok(kv.commit("test-plugin", patch));
    let http = CannedHttp {
        status: 200,
        body: vec![],
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for(SCENARIO_WASM, &["kv"]),
        &Budgets::default(),
    ));
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        json!({
            "scenario": "kv_commit", "key": "k4",
            "value": "y".repeat(30 * 1024),
        }),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    let e = err(result);
    assert_eq!(e.kind(), "invalid-response");
    let committed = ok(kv.snapshot("test-plugin"));
    assert_eq!(committed.len(), 4);
    assert!(!committed.contains_key("k4"));
}

/// A 129-UTF-8-byte key is a malformed message — terminal
/// `invalid-message`, not a staged write.
#[tokio::test]
async fn kv_key_over_128_bytes_is_invalid_message() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = CannedHttp {
        status: 200,
        body: vec![],
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for(SCENARIO_WASM, &["kv"]),
        &Budgets::default(),
    ));
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        json!({
            "scenario": "kv_commit", "key": "k".repeat(129), "value": "v",
        }),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    let e = err(result);
    assert_eq!(e.kind(), "invalid-message");
    assert!(ok(kv.snapshot("test-plugin")).is_empty());
}

/// A `log` message over 4096 bytes is a malformed message; the staged
/// write dies with the invocation.
#[tokio::test]
async fn log_message_over_cap_is_invalid_message() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    let http = CannedHttp {
        status: 200,
        body: vec![],
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for(SCENARIO_WASM, &["kv"]),
        &Budgets::default(),
    ));
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        json!({
            "scenario": "kv_commit", "key": "k", "value": "v",
            "message": "m".repeat(4097),
        }),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    let e = err(result);
    assert_eq!(e.kind(), "invalid-message");
    assert!(ok(kv.snapshot("test-plugin")).is_empty());
}

fn patch(entries: &[(&str, Option<&[u8]>)]) -> BTreeMap<String, Option<Vec<u8>>> {
    entries
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).map(<[u8]>::to_vec)))
        .collect()
}

/// Two commits staged from the same base snapshot: disjoint keys both
/// survive — the store applies each patch to current committed state,
/// not a stale replacement map.
#[test]
fn disjoint_kv_commits_both_survive() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    ok(kv.commit("p", patch(&[("a", Some(b"1"))])));
    ok(kv.commit("p", patch(&[("b", Some(b"2"))])));
    let snap = ok(kv.snapshot("p"));
    assert_eq!(snap.get("a").map(Vec::as_slice), Some(b"1".as_slice()));
    assert_eq!(snap.get("b").map(Vec::as_slice), Some(b"2".as_slice()));
}

/// Two commits to the same key: the last committer wins; `None`
/// deletes.
#[test]
fn same_key_last_commit_wins_and_none_deletes() {
    let kv = Arc::new(MemoryKeyValueStore::new());
    ok(kv.commit("p", patch(&[("k", Some(b"1"))])));
    ok(kv.commit("p", patch(&[("k", Some(b"2"))])));
    assert_eq!(
        ok(kv.snapshot("p")).get("k").map(Vec::as_slice),
        Some(b"2".as_slice())
    );
    ok(kv.commit("p", patch(&[("k", None)])));
    assert!(ok(kv.snapshot("p")).is_empty());
}

/// A `done` with nothing staged performs no store mutation — the
/// backing file is not even created.
#[tokio::test]
async fn no_write_done_does_not_touch_store() {
    let dir = std::env::temp_dir().join(format!("auqw-kv-empty-{}", std::process::id()));
    let path = dir.join("plugin-kv.json");
    let _ = std::fs::remove_dir_all(&dir);
    ok(std::fs::create_dir_all(&dir).map_err(|e| format!("{e:?}")));
    let kv = Arc::new(ok(FileKeyValueStore::new(&path)));
    let http = CannedHttp {
        status: 200,
        body: vec![],
    };
    let clock = FixedClock(0);
    let plugin = ok(load(
        SCENARIO_WASM,
        manifest_for(SCENARIO_WASM, &["kv"]),
        &Budgets::default(),
    ));
    let Invocation { result, .. } = invoke(
        &plugin,
        "playback.resolve",
        json!({"scenario": "echo", "echo": {"ok": true}}),
        &Budgets::default(),
        CancellationToken::new(),
        services(&http, kv.clone(), &clock),
    )
    .await;
    ok(result);
    assert!(!path.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

/// An on-disk namespace over the committed cap is corruption — the
/// store refuses it at open instead of serving it to a guest.
#[test]
fn over_cap_on_disk_namespace_is_corrupt() {
    let dir = std::env::temp_dir().join(format!("auqw-kv-overcap-{}", std::process::id()));
    ok(std::fs::create_dir_all(&dir).map_err(|e| format!("{e:?}")));
    let path = dir.join("plugin-kv.json");
    // Five individually legal 60 KiB values total ~293 KiB committed.
    let ns: BTreeMap<String, String> = (0..5)
        .map(|i| (format!("k{i}"), B64.encode(vec![b'x'; 60 * 1024])))
        .collect();
    let file = json!({ "test-plugin": ns });
    ok(
        std::fs::write(&path, serde_json::to_vec(&file).unwrap_or_default())
            .map_err(|e| format!("{e:?}")),
    );
    match FileKeyValueStore::new(&path) {
        Err(KvError::Corrupt(_)) => {}
        Err(e) => panic!("expected Corrupt, got {e:?}"),
        Ok(_) => panic!("expected Corrupt, got store"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}
