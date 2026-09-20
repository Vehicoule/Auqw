//! Generic capability request: invoke any declared manifest capability
//! and print the typed result. Every object key exactly named `url` is
//! redacted recursively before printing — signed stream URLs and
//! artwork URLs alike.
//!
//! Usage:
//!   request <plugin.wasm> <manifest.json> <capability> '<payload-json>'

use std::process::ExitCode;

use auqw_plugin_host::{
    invoke, load, Attempt, Budgets, HostServices, Manifest, MemoryKeyValueStore, ReqwestClient,
    SystemClock,
};
use serde_json::Value;
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
    if args.len() != 4 {
        eprintln!("usage: request <plugin.wasm> <manifest.json> <capability> '<payload-json>'");
        return ExitCode::FAILURE;
    }
    let (wasm_path, manifest_path, capability, payload_text) =
        (&args[0], &args[1], &args[2], &args[3]);
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
    let payload: Value = match serde_json::from_str::<Value>(payload_text) {
        Ok(v) if v.is_object() => v,
        Ok(_) => {
            eprintln!("payload must be a JSON object");
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("payload is not JSON: {e}");
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
    let http = match ReqwestClient::new() {
        Ok(h) => h,
        Err(e) => {
            eprintln!("http client init failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    let kv = MemoryKeyValueStore::new();
    let clock = SystemClock;
    let outcome = invoke(
        &plugin,
        capability,
        payload,
        &budgets,
        CancellationToken::new(),
        HostServices {
            http: &http,
            kv: &kv,
            clock: &clock,
            pot_provider: None,
        },
    )
    .await;

    let (result, attempt) = outcome.into_parts();
    match result {
        Ok(value) => {
            let redacted = redact_urls(&value);
            match serde_json::to_string_pretty(&redacted) {
                Ok(s) => println!("result: {s}"),
                Err(_) => println!("result: <unprintable>"),
            }
            print_attempt(&attempt);
            ExitCode::SUCCESS
        }
        Err(err) => {
            println!("invoke failed: kind={} error={err}", err.kind());
            print_attempt(&attempt);
            ExitCode::FAILURE
        }
    }
}

/// Recursively replace the value of every object key exactly named
/// `url` with `"<redacted>"`.
fn redact_urls(v: &Value) -> Value {
    match v {
        Value::Object(map) => map
            .iter()
            .map(|(k, val)| {
                (
                    k.clone(),
                    if k == "url" {
                        Value::String("<redacted>".into())
                    } else {
                        redact_urls(val)
                    },
                )
            })
            .collect(),
        Value::Array(items) => Value::Array(items.iter().map(redact_urls).collect()),
        _ => v.clone(),
    }
}

fn print_attempt(attempt: &Attempt) {
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
    for g in &attempt.guest_log {
        println!("  log: {} {}", g.level, g.message);
    }
}
