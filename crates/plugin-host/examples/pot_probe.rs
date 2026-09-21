//! Slice 0 PO-token probe: does a `pot=` parameter on a minted stream
//! URL lift a GVS serving cap? Resolves anonymously, probes the file's
//! tail window bare, then with a video-id-bound token from a bgutil
//! provider.
//!
//! Usage:
//!   pot_probe <plugin.wasm> <manifest.json> <provider_url> [video_id]
//!
//! Prints only redacted URLs and statuses.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Instant;

use auqw_plugin_host::{
    invoke, load, redact_url, Budgets, HostServices, Manifest, MemoryKeyValueStore, ReqwestClient,
    SystemClock,
};
use tokio_util::sync::CancellationToken;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(wasm_path), Some(manifest_path), Some(provider)) =
        (args.first(), args.get(1), args.get(2))
    else {
        eprintln!("usage: pot_probe <wasm> <manifest> <provider_url> [video_id]");
        return ExitCode::FAILURE;
    };
    let video_id = args.get(3).map_or("kJQP7kiw5Fk", |s| s.as_str());

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

    // Anonymous resolve: the returned URL carries no `pot=` so the bare
    // probe is a true baseline.
    let kv = Arc::new(MemoryKeyValueStore::new());
    let clock = SystemClock;
    let outcome = invoke(
        &plugin,
        "playback.resolve",
        serde_json::json!({ "source_ref": video_id }),
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
    let Ok(value) = outcome.into_parts().0 else {
        eprintln!("resolve failed");
        return ExitCode::FAILURE;
    };
    let Some(url) = value.get("url").and_then(|v| v.as_str()) else {
        eprintln!("no url in result");
        return ExitCode::FAILURE;
    };
    let client_name = value.get("client").and_then(|v| v.as_str()).unwrap_or("?");
    let Some(total) = value.get("content_length").and_then(|v| v.as_u64()) else {
        eprintln!("no content_length");
        return ExitCode::FAILURE;
    };
    println!(
        "resolved via {client_name} len={total} url={} (redacted)",
        redact_url(url)
    );

    let Ok(client) = reqwest::Client::builder().use_rustls_tls().build() else {
        return ExitCode::FAILURE;
    };
    let (start, end) = (total.saturating_sub(65536), total - 1);

    probe(&client, url, "bare", start, end).await;

    let Some(tok_video) = mint(&client, provider, video_id).await else {
        return ExitCode::FAILURE;
    };
    probe(
        &client,
        &with_pot(url, &tok_video),
        "pot(video)",
        start,
        end,
    )
    .await;
    probe(&client, url, "bare-sanity", 0, 65535).await;
    ExitCode::SUCCESS
}

fn with_pot(url: &str, token: &str) -> String {
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}pot={token}")
}

async fn mint(client: &reqwest::Client, provider: &str, binding: &str) -> Option<String> {
    let resp = client
        .post(format!("{}/get_pot", provider.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&serde_json::json!({ "content_binding": binding })).ok()?)
        .send()
        .await
        .ok()?;
    let body: serde_json::Value = serde_json::from_slice(&resp.bytes().await.ok()?).ok()?;
    let token = body.get("poToken")?.as_str()?.to_string();
    println!("mint({binding}): ok len={}", token.len());
    Some(token)
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
