//! Canned-upstream journeys: a journey file names a plugin, a
//! capability, a request payload, canned upstream responses, and an
//! expectation. The production host runs the real step loop; only the
//! network is scripted.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use auqw_plugin_host::{
    Budgets, HostServices, HttpClient, HttpError, HttpErrorKind, HttpRequest, HttpResponse,
    Invocation, KeyValueStore, LoadedPlugin, Manifest, SystemClock,
};
use serde::Deserialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
pub struct JourneySpec {
    pub name: String,
    /// Plugin id; must match a loaded release.
    pub plugin: String,
    pub capability: String,
    #[serde(default)]
    pub request: Value,
    #[serde(default)]
    pub upstreams: Vec<Upstream>,
    pub expect: Expect,
}

#[derive(Deserialize)]
pub struct Upstream {
    /// Substring matched against the outbound request URL. First
    /// matching upstream wins; an unmatched request fails the journey.
    pub url_contains: String,
    #[serde(default = "default_status")]
    pub status: u16,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Response body file, resolved relative to the journey file.
    pub body_file: String,
}

fn default_status() -> u16 {
    200
}

#[derive(Deserialize)]
pub struct Expect {
    /// `ok` asserts a successful result; otherwise the expected
    /// error-kind string.
    pub result: String,
    /// Optional JSON subset the successful result must match:
    /// every expected key must be present and equal (recursively);
    /// array expectations subset-match element-wise over their length.
    #[serde(default)]
    pub result_subset: Option<Value>,
    /// Optional cap on upstream calls the journey may make.
    #[serde(default)]
    pub max_http_calls: Option<u32>,
}

pub struct Journey {
    pub spec: JourneySpec,
    pub dir: PathBuf,
}

pub fn load_journeys(dir: &Path) -> Result<Vec<Journey>, String> {
    let mut out = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("journeys {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("readdir: {e}"))?;
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            let text =
                std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let spec: JourneySpec =
                serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
            out.push(Journey {
                spec,
                dir: path
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| dir.to_path_buf()),
            });
        }
    }
    out.sort_by(|a, b| a.spec.name.cmp(&b.spec.name));
    Ok(out)
}

/// Scripted network: upstreams matched by `url_contains` in declared
/// order. Misses and their URLs are recorded for the report.
struct CannedHttp {
    upstreams: Vec<Upstream>,
    bodies: Vec<Vec<u8>>,
    misses: std::sync::Mutex<Vec<String>>,
    calls: std::sync::atomic::AtomicU32,
}

impl CannedHttp {
    fn build(journey: &Journey) -> Result<Self, String> {
        let mut bodies = Vec::with_capacity(journey.spec.upstreams.len());
        for up in &journey.spec.upstreams {
            let path = journey.dir.join(&up.body_file);
            bodies.push(
                std::fs::read(&path)
                    .map_err(|e| format!("upstream body {}: {e}", path.display()))?,
            );
        }
        Ok(Self {
            upstreams: journey
                .spec
                .upstreams
                .iter()
                .map(|u| Upstream {
                    url_contains: u.url_contains.clone(),
                    status: u.status,
                    headers: u.headers.clone(),
                    body_file: u.body_file.clone(),
                })
                .collect(),
            bodies,
            misses: std::sync::Mutex::new(Vec::new()),
            calls: std::sync::atomic::AtomicU32::new(0),
        })
    }
}

impl HttpClient for CannedHttp {
    fn send(
        &self,
        req: HttpRequest,
        _timeout: Duration,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        self.calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let idx = self
            .upstreams
            .iter()
            .position(|u| req.url.contains(&u.url_contains));
        match idx {
            Some(i) => {
                let up = &self.upstreams[i];
                let response = HttpResponse {
                    status: up.status,
                    headers: up
                        .headers
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                    body: self.bodies[i].clone(),
                };
                Box::pin(async move { Ok(response) })
            }
            None => {
                let url = req.url.clone();
                if let Ok(mut misses) = self.misses.lock() {
                    misses.push(url.clone());
                }
                Box::pin(async move {
                    Err(HttpError {
                        kind: HttpErrorKind::Transient,
                        message: format!("no canned upstream for {url}"),
                        bytes_received: 0,
                    })
                })
            }
        }
    }
}

struct NullKv;

impl KeyValueStore for NullKv {
    fn snapshot(
        &self,
        _plugin_id: &str,
    ) -> Result<std::collections::BTreeMap<String, Vec<u8>>, auqw_plugin_host::KvError> {
        Ok(std::collections::BTreeMap::new())
    }
    fn commit_admitting(
        &self,
        _plugin_id: &str,
        _writes: std::collections::BTreeMap<String, Option<Vec<u8>>>,
        _admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<(), auqw_plugin_host::KvError> {
        Ok(())
    }
}

pub struct JourneyOutcome {
    pub name: String,
    pub passed: bool,
    pub detail: String,
    pub http_calls: u32,
    pub misses: Vec<String>,
}

fn subset(expected: &Value, actual: &Value, path: &str) -> Result<(), String> {
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => {
            for (key, ev) in e {
                let next = format!("{path}.{key}");
                match a.get(key) {
                    Some(av) => subset(ev, av, &next)?,
                    None => return Err(format!("{next}: missing")),
                }
            }
            Ok(())
        }
        (Value::Array(e), Value::Array(a)) => {
            for (i, ev) in e.iter().enumerate() {
                let next = format!("{path}[{i}]");
                match a.get(i) {
                    Some(av) => subset(ev, av, &next)?,
                    None => return Err(format!("{next}: missing")),
                }
            }
            Ok(())
        }
        (e, a) if e == a => Ok(()),
        (e, a) => Err(format!("{path}: expected {e}, got {a}")),
    }
}

/// Run one journey against an already-loaded plugin.
pub async fn run_journey(plugin: &LoadedPlugin, journey: &Journey) -> JourneyOutcome {
    let name = journey.spec.name.clone();
    let http = match CannedHttp::build(journey) {
        Ok(h) => h,
        Err(e) => {
            return JourneyOutcome {
                name,
                passed: false,
                detail: e,
                http_calls: 0,
                misses: vec![],
            }
        }
    };
    let kv = std::sync::Arc::new(NullKv);
    let clock = SystemClock;
    let Invocation { result, attempt } = auqw_plugin_host::invoke(
        plugin,
        &journey.spec.capability,
        journey.spec.request.clone(),
        &Budgets::default(),
        CancellationToken::new(),
        HostServices {
            http: &http,
            kv: kv.clone(),
            clock: &clock,
            pot_provider: None,
        },
    )
    .await;

    let mut detail = String::new();
    let mut passed = match (&journey.spec.expect.result.as_str(), &result) {
        (&"ok", Ok(value)) => {
            if let Some(expected) = &journey.spec.expect.result_subset {
                match subset(expected, value, "$") {
                    Ok(()) => true,
                    Err(e) => {
                        detail = format!("result subset: {e}");
                        false
                    }
                }
            } else {
                true
            }
        }
        (&"ok", Err(e)) => {
            detail = format!("expected ok, got error: {e:?}");
            false
        }
        (expected_kind, Err(e)) => {
            let actual = e.kind();
            if actual == *expected_kind {
                true
            } else {
                detail = format!("expected error kind {expected_kind}, got {actual} ({e:?})");
                false
            }
        }
        (expected_kind, Ok(v)) => {
            detail = format!("expected error kind {expected_kind}, got ok {v}");
            false
        }
    };
    if passed {
        if let Some(cap) = journey.spec.expect.max_http_calls {
            let calls = http.calls.load(std::sync::atomic::Ordering::Relaxed);
            if calls > cap {
                passed = false;
                detail = format!("http calls {calls} exceeded cap {cap}");
            }
        }
    }
    if passed {
        detail = format!(
            "{} steps, {} http calls, {} bytes",
            attempt.steps, attempt.http_calls, attempt.bytes
        );
    }
    JourneyOutcome {
        name,
        passed,
        detail,
        http_calls: http.calls.load(std::sync::atomic::Ordering::Relaxed),
        misses: http.misses.lock().map(|m| m.clone()).unwrap_or_default(),
    }
}

/// Parse the release manifest into a host `Manifest` (manifest.json is
/// verbatim the signed file).
pub fn manifest_of(release_manifest_json: &str) -> Result<Manifest, String> {
    Manifest::from_json(release_manifest_json).map_err(|e| format!("manifest: {e}"))
}
