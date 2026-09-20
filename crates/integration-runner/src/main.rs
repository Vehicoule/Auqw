//! Headless integration pipeline for signed plugin releases.
//!
//!   integration-runner --pubkey <pem> --release <dir> [--release <dir>...]
//!                        --journeys <dir>
//!
//! Per release: digest + provenance + ed25519 signature verify, host
//! `load()` (manifest/artifact validation), then every journey naming
//! that plugin through the production step loop against canned
//! upstreams. Exit code 0 only when everything verifies and passes.

mod journey;
mod verify;

use std::path::PathBuf;
use std::process::ExitCode;

use auqw_plugin_host::{load, Budgets};
use journey::{load_journeys, manifest_of, run_journey, Journey};
use verify::{key_id_of_der, load_public_key, verify_release, VerifiedRelease};

struct Args {
    pubkey: PathBuf,
    releases: Vec<PathBuf>,
    journeys: PathBuf,
}

fn parse_args() -> Result<Args, String> {
    let mut pubkey = None;
    let mut releases = Vec::new();
    let mut journeys = None;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--pubkey" => pubkey = Some(PathBuf::from(it.next().ok_or("--pubkey needs a path")?)),
            "--release" => releases.push(PathBuf::from(it.next().ok_or("--release needs a path")?)),
            "--journeys" => {
                journeys = Some(PathBuf::from(it.next().ok_or("--journeys needs a path")?))
            }
            "--help" | "-h" => {
                println!(
                    "usage: integration-runner --pubkey <pem> --release <dir> [--release <dir>...] --journeys <dir>"
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    if releases.is_empty() {
        return Err("at least one --release <dir> is required".into());
    }
    Ok(Args {
        pubkey: pubkey.ok_or("--pubkey is required")?,
        releases,
        journeys: journeys.ok_or("--journeys is required")?,
    })
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("integration-runner: {e}");
            return ExitCode::from(2);
        }
    };

    let (key, der) = match load_public_key(&args.pubkey) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("FAIL pubkey: {e}");
            return ExitCode::FAILURE;
        }
    };
    let key_id = key_id_of_der(&der);
    println!("signer key_id: {key_id}");

    let journeys = match load_journeys(&args.journeys) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("FAIL journeys: {e}");
            return ExitCode::FAILURE;
        }
    };

    let mut failures = 0usize;
    let mut releases: Vec<(VerifiedRelease, auqw_plugin_host::LoadedPlugin)> = Vec::new();

    for dir in &args.releases {
        let label = dir.display();
        let release = match verify_release(dir, &key, &key_id) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("FAIL verify {label}: {e}");
                failures += 1;
                continue;
            }
        };
        let manifest = match manifest_of(&release.manifest_json) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("FAIL manifest {label}: {e}");
                failures += 1;
                continue;
            }
        };
        let plugin = match load(&release.wasm, manifest, &Budgets::default()) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("FAIL load {} {}: {e:?}", release.plugin, release.version);
                failures += 1;
                continue;
            }
        };
        println!(
            "verify ok — {} {} ({} caps)",
            release.plugin,
            release.version,
            plugin.manifest().capabilities.join(", ")
        );
        releases.push((release, plugin));
    }

    for (release, plugin) in &releases {
        let for_plugin: Vec<&Journey> = journeys
            .iter()
            .filter(|j| j.spec.plugin == release.plugin)
            .collect();
        if for_plugin.is_empty() {
            eprintln!("FAIL journeys: no journey names plugin {}", release.plugin);
            failures += 1;
            continue;
        }
        for journey in for_plugin {
            let outcome = run_journey(plugin, journey).await;
            if outcome.passed {
                println!("journey ok — {} ({})", outcome.name, outcome.detail);
            } else {
                eprintln!(
                    "FAIL journey {} ({} upstream calls): {}",
                    outcome.name, outcome.http_calls, outcome.detail
                );
                for miss in &outcome.misses {
                    eprintln!("  uncanned upstream: {miss}");
                }
                failures += 1;
            }
        }
    }

    // A journey naming a plugin with no matching release is a spec bug —
    // flag it rather than silently passing a shorter suite.
    for journey in &journeys {
        if !releases
            .iter()
            .any(|(r, _)| r.plugin == journey.spec.plugin)
        {
            eprintln!(
                "FAIL journey {}: no release for plugin {}",
                journey.spec.name, journey.spec.plugin
            );
            failures += 1;
        }
    }

    if failures == 0 {
        println!("integration-runner: all releases verified, all journeys passed");
        ExitCode::SUCCESS
    } else {
        eprintln!("integration-runner: {failures} failure(s)");
        ExitCode::FAILURE
    }
}
