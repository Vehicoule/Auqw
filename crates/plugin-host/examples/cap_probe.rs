//! Slice 0 cap probe: does a *freshly minted* stream URL serve ranges
//! the previous mint refused? This is the re-mint leapfrog the old
//! app relied on (stream_file.rs "permissive-per-budget" mode).
//!
//! Usage:
//!   cap_probe <plugin.wasm> <manifest.json> [video_id]
//!
//! Prints only redacted URLs and statuses.

use std::process::ExitCode;
use std::time::Instant;

use auqw_plugin_host::{invoke, load, redact_url, Budgets, Manifest, ReqwestClient};
use tokio_util::sync::CancellationToken;

const CAP_OFFSET: u64 = 2 * 1024 * 1024; // probe past the ~1 MiB cap

#[tokio::main(flavor = "multi_thread")]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(wasm_path), Some(manifest_path)) = (args.first(), args.get(1)) else {
        eprintln!("usage: cap_probe <plugin.wasm> <manifest.json> [video_id]");
        return ExitCode::FAILURE;
    };
    let video_id = args.get(2).map_or("kJQP7kiw5Fk", |s| s.as_str());

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

    // Mint 1
    let Some((url1, client1)) = mint(&plugin, &budgets, &http, video_id).await else {
        return ExitCode::FAILURE;
    };
    println!(
        "mint1: client={client1} url={} (redacted)",
        redact_url(&url1)
    );

    // Mint 2 immediately (fresh signature/budget)
    let Some((url2, client2)) = mint(&plugin, &budgets, &http, video_id).await else {
        return ExitCode::FAILURE;
    };
    println!(
        "mint2: client={client2} url={} (redacted)",
        redact_url(&url2)
    );
    println!("mints differ: {}", url1 != url2);

    let Ok(client) = reqwest::Client::builder().use_rustls_tls().build() else {
        return ExitCode::FAILURE;
    };

    // Baselines on mint1: first MiB should serve; past-cap should refuse.
    probe(&client, &url1, "mint1", 0, 1_048_575).await;
    probe(&client, &url1, "mint1", CAP_OFFSET, CAP_OFFSET + 1_048_575).await;

    // The decisive probes on mint2: same past-cap window.
    probe(&client, &url2, "mint2", CAP_OFFSET, CAP_OFFSET + 1_048_575).await;
    probe_query(&client, &url2, "mint2", CAP_OFFSET, CAP_OFFSET + 1_048_575).await;

    // And mint2's own prefix still works (sanity).
    probe(&client, &url2, "mint2", 0, 1_048_575).await;

    ExitCode::SUCCESS
}

async fn mint(
    plugin: &auqw_plugin_host::LoadedPlugin,
    budgets: &Budgets,
    http: &ReqwestClient,
    video_id: &str,
) -> Option<(String, String)> {
    let outcome = invoke(
        plugin,
        "playback.resolve",
        serde_json::json!({ "source_ref": video_id }),
        budgets,
        CancellationToken::new(),
        http,
        None,
    )
    .await;
    let (result, _attempt) = outcome.into_parts();
    let Ok(value) = result else {
        eprintln!("resolve failed for {video_id}");
        return None;
    };
    let url = value.get("url")?.as_str()?.to_string();
    let client = value
        .get("client")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();
    Some((url, client))
}

async fn probe(client: &reqwest::Client, url: &str, tag: &str, start: u64, end: u64) {
    let t0 = Instant::now();
    match client
        .get(url)
        .header("Range", format!("bytes={start}-{end}"))
        .send()
        .await
    {
        Ok(resp) => println!(
            "{tag}: Range bytes={start}-{end} -> {} len={} in {:?}",
            resp.status().as_u16(),
            resp.content_length().unwrap_or(0),
            t0.elapsed()
        ),
        Err(e) => println!(
            "{tag}: Range bytes={start}-{end} -> failed: {}",
            e.without_url()
        ),
    }
}

async fn probe_query(client: &reqwest::Client, url: &str, tag: &str, start: u64, end: u64) {
    let t0 = Instant::now();
    let q = format!("{url}&range={start}-{end}");
    match client.get(&q).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let len = resp.bytes().await.map_or(0, |b| b.len());
            println!(
                "{tag}: &range={start}-{end} -> {status} len={len} in {:?}",
                t0.elapsed()
            );
        }
        Err(e) => println!("{tag}: &range={start}-{end} -> failed: {}", e.without_url()),
    }
}
