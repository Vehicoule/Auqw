//! Slice 0 window walk: fetch sequential 1 MiB windows from ONE minted
//! URL to find where (and whether) GVS stops serving — per-URL byte
//! budget vs. absolute offset cap.
//!
//! Usage:
//!   window_walk <plugin.wasm> <manifest.json> [video_id] [windows]

use std::process::ExitCode;
use std::time::Instant;

use auqw_plugin_host::{invoke, load, Budgets, Manifest, ReqwestClient};
use tokio_util::sync::CancellationToken;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(wasm_path), Some(manifest_path)) = (args.first(), args.get(1)) else {
        eprintln!("usage: window_walk <plugin.wasm> <manifest.json> [video_id] [windows]");
        return ExitCode::FAILURE;
    };
    let video_id = args.get(2).map_or("kJQP7kiw5Fk", |s| s.as_str());
    let windows: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(8);

    let Ok(wasm) = std::fs::read(wasm_path) else {
        eprintln!("cannot read wasm");
        return ExitCode::FAILURE;
    };
    let Ok(manifest_text) = std::fs::read_to_string(manifest_path) else {
        eprintln!("cannot read manifest");
        return ExitCode::FAILURE;
    };
    let Ok(manifest) = Manifest::from_json(&manifest_text) else {
        eprintln!("manifest error");
        return ExitCode::FAILURE;
    };
    let budgets = Budgets::default();
    let Ok(plugin) = load(&wasm, manifest, &budgets) else {
        eprintln!("load error");
        return ExitCode::FAILURE;
    };
    let Ok(http) = ReqwestClient::new() else {
        eprintln!("http init failed");
        return ExitCode::FAILURE;
    };

    let outcome = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({ "source_ref": video_id }),
        &budgets,
        CancellationToken::new(),
        &http,
        None,
    )
    .await;
    let (result, _) = outcome.into_parts();
    let Ok(value) = result else {
        eprintln!("resolve failed");
        return ExitCode::FAILURE;
    };
    let url = value.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let client_name = value.get("client").and_then(|v| v.as_str()).unwrap_or("?");
    println!("minted via {client_name}");

    let Ok(client) = reqwest::Client::builder().use_rustls_tls().build() else {
        return ExitCode::FAILURE;
    };
    let mib = 1024u64 * 1024;
    for i in 0..windows {
        let (start, end) = (i * mib, (i + 1) * mib - 1);
        let t0 = Instant::now();
        match client
            .get(url)
            .header("Range", format!("bytes={start}-{end}"))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let len = resp.bytes().await.map_or(0, |b| b.len());
                println!(
                    "window {i} bytes={start}-{end} -> {status} len={len} in {:?}",
                    t0.elapsed()
                );
                if status != 206 {
                    println!("STOP at window {i}");
                    break;
                }
            }
            Err(e) => {
                println!("window {i} -> transport fail: {e}");
                break;
            }
        }
    }
    ExitCode::SUCCESS
}
