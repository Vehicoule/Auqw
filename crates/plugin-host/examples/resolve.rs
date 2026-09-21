//! Slice 0 desktop smoke: invoke a plugin's `playback.resolve` against
//! real provider endpoints, print the typed result (URLs redacted), then
//! prove the URL is fetchable with a Range GET.
//!
//! Usage:
//!   resolve <plugin.wasm> <manifest.json> [video_id] [--cancel-after-ms N] [--download <path>]
//!   resolve --spin <spin.wasm>

use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use auqw_plugin_host::{
    invoke, load, redact_url, Budgets, HostServices, Manifest, MemoryKeyValueStore, ReqwestClient,
    SystemClock,
};
use tokio_util::sync::CancellationToken;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build();
    let Ok(rt) = rt else {
        eprintln!("failed to start tokio runtime");
        return ExitCode::FAILURE;
    };
    rt.block_on(run(&args))
}

async fn run(args: &[String]) -> ExitCode {
    if let Some(pos) = args.iter().position(|a| a == "--spin") {
        let Some(path) = args.get(pos + 1) else {
            eprintln!("--spin requires a wasm path");
            return ExitCode::FAILURE;
        };
        return run_spin(path).await;
    }
    let cancel_after = args
        .iter()
        .position(|a| a == "--cancel-after-ms")
        .and_then(|pos| args.get(pos + 1))
        .and_then(|v| v.parse::<u64>().ok());
    let pot_provider = args
        .iter()
        .position(|a| a == "--pot-provider")
        .and_then(|pos| args.get(pos + 1))
        .cloned();
    let download = args
        .iter()
        .position(|a| a == "--download")
        .and_then(|pos| args.get(pos + 1))
        .cloned();

    let mut positional: Vec<&String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--cancel-after-ms" | "--pot-provider" | "--download" => i += 2,
            a if a.starts_with("--") => i += 1,
            _ => {
                positional.push(&args[i]);
                i += 1;
            }
        }
    }
    let (Some(wasm_path), Some(manifest_path)) = (positional.first(), positional.get(1)) else {
        eprintln!("usage: resolve <plugin.wasm> <manifest.json> [video_id] [--cancel-after-ms N]");
        return ExitCode::FAILURE;
    };
    let video_id = positional
        .get(2)
        .map_or("dQw4w9WgXcQ", |s| s.as_str())
        .to_string();

    let Ok(wasm) = std::fs::read(wasm_path) else {
        eprintln!("cannot read wasm at {wasm_path}");
        return ExitCode::FAILURE;
    };
    let Ok(manifest_text) = std::fs::read_to_string(manifest_path) else {
        eprintln!("cannot read manifest at {manifest_path}");
        return ExitCode::FAILURE;
    };
    let manifest = match Manifest::from_json(&manifest_text) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("manifest error: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("plugin: {} {}", manifest.id, manifest.version);
    let budgets = Budgets::default();
    let plugin = match load(&wasm, manifest, &budgets) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("load error: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("digest: {}", plugin.digest());

    let http = match ReqwestClient::new() {
        Ok(h) => h,
        Err(e) => {
            eprintln!("http client init failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    let cancel = CancellationToken::new();
    let payload = serde_json::json!({ "source_ref": video_id });

    let kv = Arc::new(MemoryKeyValueStore::new());
    let clock = SystemClock;
    let fut = invoke(
        &plugin,
        "playback.resolve",
        payload,
        &budgets,
        cancel.clone(),
        HostServices {
            http: &http,
            kv: kv.clone(),
            clock: &clock,
            pot_provider: pot_provider.as_deref(),
        },
    );
    tokio::pin!(fut);
    let outcome = if let Some(ms) = cancel_after {
        let timer = tokio::time::sleep(Duration::from_millis(ms));
        tokio::pin!(timer);
        tokio::select! {
            o = &mut fut => o,
            () = &mut timer => {
                let t0 = Instant::now();
                cancel.cancel();
                let o = fut.await;
                println!("cancel-after-ms: {ms} -> abort latency {:?}", t0.elapsed());
                o
            }
        }
    } else {
        fut.await
    };

    let (result, attempt) = outcome.into_parts();
    match result {
        Ok(value) => {
            print_result(&value);
            print_attempt(&attempt);
            if let Some(url) = value.get("url").and_then(|v| v.as_str()) {
                range_check(url).await;
                if let Some(path) = download {
                    download_to(url, &path).await;
                }
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            println!("invoke failed: kind={} error={err}", err.kind());
            print_attempt(&attempt);
            ExitCode::FAILURE
        }
    }
}

async fn run_spin(path: &str) -> ExitCode {
    let Ok(wasm) = std::fs::read(path) else {
        eprintln!("cannot read wasm at {path}");
        return ExitCode::FAILURE;
    };
    let digest = {
        use sha2::Digest as _;
        format!("sha256:{:x}", sha2::Sha256::digest(&wasm))
    };
    // The manifest goes through `from_json` so the example exercises the
    // same schema validation a shipped plugin gets — no hand-built
    // `Manifest` bypassing `validate()`.
    let manifest_text = serde_json::json!({
        "id": "conformance-spin",
        "version": "0.1.0",
        "abi": "0.1.0",
        "capabilities": ["playback.resolve"],
        "permissions": [],
        "artifact": { "path": path, "digest": digest },
    })
    .to_string();
    let manifest = match Manifest::from_json(&manifest_text) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("manifest error: {e}");
            return ExitCode::FAILURE;
        }
    };
    let budgets = Budgets::default();
    let plugin = match load(&wasm, manifest, &budgets) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("load error: {e}");
            return ExitCode::FAILURE;
        }
    };
    let Ok(http) = ReqwestClient::new() else {
        eprintln!("http client init failed");
        return ExitCode::FAILURE;
    };
    let kv = Arc::new(MemoryKeyValueStore::new());
    let clock = SystemClock;
    let t0 = Instant::now();
    let outcome = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({}),
        &budgets,
        CancellationToken::new(),
        HostServices {
            http: &http,
            kv: kv.clone(),
            clock: &clock,
            pot_provider: None,
        },
    )
    .await;
    let (result, attempt) = outcome.into_parts();
    match result {
        Err(err) => {
            println!(
                "spin: trapped after {:?} (kind={}, fuel_used={}, elapsed={:?})",
                t0.elapsed(),
                err.kind(),
                attempt.fuel_used,
                attempt.elapsed
            );
            ExitCode::SUCCESS
        }
        Ok(_) => {
            eprintln!("spin: unexpected success");
            ExitCode::FAILURE
        }
    }
}

fn print_result(result: &serde_json::Value) {
    let url = result.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let mime = result.get("mime").and_then(|v| v.as_str()).unwrap_or("");
    let bitrate = result
        .get("bitrate_kbps")
        .map_or_else(|| "null".to_string(), |v| v.to_string());
    let client = result.get("client").and_then(|v| v.as_str()).unwrap_or("");
    let expiry = result
        .get("expires_at_ms")
        .and_then(serde_json::Value::as_u64)
        .map(|ms| {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64);
            format!("{}s", ms.saturating_sub(now) / 1000)
        })
        .unwrap_or_else(|| "unknown".to_string());
    let content_length = result
        .get("content_length")
        .map_or_else(|| "null".to_string(), |v| v.to_string());
    println!("result: url={} (query redacted)", redact_url(url));
    println!(
        "        mime={mime} bitrate_kbps={bitrate} expires_in={expiry} client={client} content_length={content_length}"
    );
}

fn print_attempt(attempt: &auqw_plugin_host::Attempt) {
    println!(
        "attempt: request_id={} steps={} http_calls={} bytes={} fuel_used={} elapsed={:?}",
        attempt.request_id,
        attempt.steps,
        attempt.http_calls,
        attempt.bytes,
        attempt.fuel_used,
        attempt.elapsed
    );
    for t in &attempt.http_trace {
        println!(
            "  http: {} {} -> status={:?} bytes={} {:?}",
            t.method, t.url, t.status, t.bytes, t.elapsed
        );
    }
}

/// Fetch the whole stream to `path` so the desktop leg can play real
/// audio (afplay). 1 MiB Range chunks mirror the app's mint loop; a
/// mid-stream cap just stops the download early. The URL is never
/// printed.
async fn download_to(url: &str, path: &str) {
    let Ok(client) = reqwest::Client::builder()
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        println!("download: client init failed");
        return;
    };
    let mut file = match std::fs::File::create(path) {
        Ok(f) => f,
        Err(e) => {
            println!("download: cannot create {path}: {e}");
            return;
        }
    };
    let mut start = 0u64;
    loop {
        let end = start + 1_048_575;
        let res = client
            .get(url)
            .header("Range", format!("bytes={start}-{end}"))
            .send()
            .await;
        match res {
            Ok(resp) => {
                let status = resp.status().as_u16();
                // A 200 is only valid at offset 0 — the whole file is the
                // answer to a range the server ignored. Mid-stream it would
                // append the full body at the resume offset and corrupt the
                // evidence file.
                let acceptable = status == 206 || (status == 200 && start == 0);
                if !acceptable {
                    println!("download: bytes={start}-{end} -> {status} (stop)");
                    break;
                }
                let Ok(bytes) = resp.bytes().await else {
                    println!("download: body read failed at {start}");
                    break;
                };
                if bytes.is_empty() {
                    break;
                }
                use std::io::Write as _;
                if file.write_all(&bytes).is_err() {
                    println!("download: write failed at {start}");
                    break;
                }
                start += bytes.len() as u64;
            }
            Err(e) => {
                println!("download: request failed at {start}: {}", e.without_url());
                break;
            }
        }
    }
    println!("download: wrote {start} bytes to {path}");
}

/// Prove the resolved URL is fetchable: GET the first 64 KiB with a Range
/// header and print status/content-type/bytes. The URL is never printed.
async fn range_check(url: &str) {
    let Ok(client) = reqwest::Client::builder()
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        println!("range-check: client init failed");
        return;
    };
    let t0 = Instant::now();
    let plain = client.get(url).send().await;
    match plain {
        Ok(resp) => println!(
            "plain-check: GET {} -> {} in {:?}",
            redact_url(url),
            resp.status().as_u16(),
            t0.elapsed()
        ),
        Err(e) => println!("plain-check: request failed: {}", e.without_url()),
    }
    let t0 = Instant::now();
    let open = client.get(url).header("Range", "bytes=0-").send().await;
    match open {
        Ok(resp) => println!(
            "open-range-check: GET {} Range bytes=0- -> {} in {:?}",
            redact_url(url),
            resp.status().as_u16(),
            t0.elapsed()
        ),
        Err(e) => println!("open-range-check: request failed: {}", e.without_url()),
    }
    for probe in [
        "0-2097151",
        "0-3145727",
        "0-4194303",
        "1048576-2097151",
        "1000000-1999999",
    ] {
        let t0 = Instant::now();
        let r = client
            .get(url)
            .header("Range", format!("bytes={probe}"))
            .send()
            .await;
        match r {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let clen = resp.content_length().unwrap_or(0);
                println!(
                    "range-probe: GET {} Range bytes={probe} -> {status} len={clen} in {:?}",
                    redact_url(url),
                    t0.elapsed()
                );
            }
            Err(e) => println!("range-probe {probe}: request failed: {}", e.without_url()),
        }
    }
    let mut probe_list = vec![(0u64, 1048575u64)];
    while let Some(&(_, e)) = probe_list.last().filter(|(_, e)| *e < 3_500_000) {
        probe_list.push((e + 1, e + 65536));
    }
    for (ps, pe) in probe_list {
        let t0 = Instant::now();
        let q = format!("{url}&range={ps}-{pe}");
        let r = client.get(&q).send().await;
        match r {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let clen = resp.bytes().await.map_or(0, |b| b.len() as u64);
                if status != 200 {
                    println!("seq-probe: &range={ps}-{pe} -> {status} (STOP)");
                    break;
                }
                println!(
                    "seq-probe: &range={ps}-{pe} -> {status} len={clen} in {:?}",
                    t0.elapsed()
                );
            }
            Err(e) => {
                println!("seq-probe {ps}-{pe}: request failed: {}", e.without_url());
                break;
            }
        }
    }
    let t0 = Instant::now();
    let res = client
        .get(url)
        .header("Range", "bytes=0-65535")
        .send()
        .await;
    match res {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let content_type = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let crange = resp
                .headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            println!("range-check: content-range={crange}");
            let bytes = resp.bytes().await.map_or(0, |b| b.len());
            println!(
                "range-check: GET {} Range bytes=0-65535 -> {status} {content_type} {bytes}B in {:?}",
                redact_url(url),
                t0.elapsed()
            );
        }
        Err(e) => println!("range-check: request failed: {}", e.without_url()),
    }
}
