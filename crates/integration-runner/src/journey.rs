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
    /// Request headers the matching upstream asserts: each declared
    /// name must arrive (case-insensitive) with a value containing
    /// the given substring. A request that matches the URL but not
    /// the headers is an uncanned upstream — the canned response must
    /// never answer a probe the spec declared differently.
    #[serde(default)]
    pub request_headers: BTreeMap<String, String>,
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

/// First violated request-header assertion, if any: `name`
/// matches case-insensitively and ANY of its values may carry the
/// declared substring (repeated headers are legal on the wire).
/// Diagnostics name the header but never values — the spec's
/// assertion and the request's credentials both stay out of logs.
fn header_miss(req: &HttpRequest, want: &BTreeMap<String, String>) -> Option<String> {
    'outer: for (name, needle) in want {
        let mut present = false;
        for (k, v) in &req.headers {
            if !k.eq_ignore_ascii_case(name) {
                continue;
            }
            present = true;
            if v.contains(needle.as_str()) {
                continue 'outer;
            }
        }
        return Some(if present {
            format!("header {name}: assertion failed")
        } else {
            format!("header {name}: missing")
        });
    }
    None
}

/// URL minus query and fragment — signed params and token-bearing
/// query strings never reach logs or guest-visible errors.
fn safe_url(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or(url)
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
/// order. Misses (URLs with query stripped) are recorded for the
/// report and fail the journey — the guest call only sees a typed
/// transient error, never the request's credentials.
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
                    request_headers: u.request_headers.clone(),
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
                if let Some(miss) = header_miss(&req, &up.request_headers) {
                    let url = safe_url(&req.url).to_string();
                    if let Ok(mut misses) = self.misses.lock() {
                        misses.push(format!("{url} ({miss})"));
                    }
                    return Box::pin(async move {
                        Err(HttpError {
                            kind: HttpErrorKind::Transient,
                            message: format!("canned upstream for {url} refused request: {miss}"),
                            bytes_received: 0,
                        })
                    });
                }
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
    // Every outbound request must be canned: a miss the guest
    // absorbed still means the script left a hole — absorbable
    // transient errors can't let a spec pass against a request it
    // never declared (a failed header assertion above all).
    if passed {
        let misses = http.misses.lock().map(|m| m.clone()).unwrap_or_default();
        if !misses.is_empty() {
            passed = false;
            detail = format!("uncanned upstreams: {}", misses.join("; "));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn req(url: &str, headers: &[(&str, &str)]) -> HttpRequest {
        HttpRequest {
            method: "GET".into(),
            url: url.into(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: None,
            max_response_bytes: 1 << 20,
        }
    }

    fn want(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn header_miss_satisfied_by_any_repeated_value() {
        // Repeated header: the second value carries the substring.
        let r = req(
            "https://x/",
            &[("range", "bytes=0-1"), ("Range", "bytes=100-200")],
        );
        assert_eq!(header_miss(&r, &want(&[("RANGE", "bytes=100")])), None);
    }

    #[test]
    fn header_miss_reports_first_violated_assertion() {
        let r = req("https://x/", &[("a", "yes"), ("b", "wrong")]);
        assert_eq!(
            header_miss(&r, &want(&[("a", "yes"), ("b", "needle"), ("c", "m")])),
            Some("header b: assertion failed".to_string())
        );
    }

    #[test]
    fn header_miss_distinguishes_missing_from_mismatched() {
        let r = req("https://x/", &[("a", "value")]);
        assert_eq!(
            header_miss(&r, &want(&[("absent", "x")])),
            Some("header absent: missing".to_string())
        );
        assert_eq!(
            header_miss(&r, &want(&[("a", "other")])),
            Some("header a: assertion failed".to_string())
        );
    }

    fn canned(upstreams: Vec<Upstream>) -> CannedHttp {
        CannedHttp {
            bodies: vec![vec![1, 2, 3]; upstreams.len()],
            upstreams,
            misses: std::sync::Mutex::new(Vec::new()),
            calls: std::sync::atomic::AtomicU32::new(0),
        }
    }

    fn upstream(url: &str, headers: &[(&str, &str)]) -> Upstream {
        Upstream {
            url_contains: url.into(),
            request_headers: want(headers),
            status: 200,
            headers: BTreeMap::new(),
            body_file: "body.bin".into(),
        }
    }

    async fn send(c: &CannedHttp, r: HttpRequest) -> Result<HttpResponse, HttpError> {
        c.send(r, Duration::from_secs(1), CancellationToken::new())
            .await
    }

    fn misses(c: &CannedHttp) -> Vec<String> {
        c.misses.lock().map(|m| m.clone()).unwrap_or_default()
    }

    #[tokio::test]
    async fn send_serves_canonical_response_on_full_match() {
        let c = canned(vec![upstream("videoplayback", &[("range", "bytes=0-")])]);
        let out = send(
            &c,
            req(
                "https://h/videoplayback?sig=1",
                &[("Range", "bytes=0-1023")],
            ),
        )
        .await;
        let Ok(resp) = out else {
            panic!("expected canned response");
        };
        assert_eq!(resp.body, vec![1, 2, 3]);
        assert!(misses(&c).is_empty());
    }

    #[tokio::test]
    async fn send_refuses_and_records_header_violation() {
        let c = canned(vec![upstream("videoplayback", &[("range", "bytes=0-")])]);
        let out = send(
            &c,
            req(
                "https://h/videoplayback?sig=SECRET",
                &[("Range", "bytes=99-")],
            ),
        )
        .await;
        let Err(err) = out else {
            panic!("expected refusal");
        };
        assert_eq!(err.kind, HttpErrorKind::Transient);
        let misses = misses(&c);
        assert_eq!(
            misses,
            vec!["https://h/videoplayback (header range: assertion failed)"]
        );
        // The signed query never reaches diagnostics.
        assert!(!misses[0].contains("SECRET") && !err.message.contains("SECRET"));
    }

    #[tokio::test]
    async fn send_records_uncanned_url() {
        let c = canned(vec![upstream("videoplayback", &[])]);
        let out = send(&c, req("https://elsewhere.example/x", &[])).await;
        let Err(err) = out else {
            panic!("expected refusal");
        };
        assert_eq!(err.kind, HttpErrorKind::Transient);
        assert_eq!(misses(&c), vec!["https://elsewhere.example/x"]);
    }

    #[test]
    fn safe_url_strips_query_and_fragment() {
        assert_eq!(
            safe_url("https://h/videoplayback?sig=x&expire=1#frag"),
            "https://h/videoplayback"
        );
        assert_eq!(safe_url("https://h/path"), "https://h/path");
    }
}
