//! The workspace release profile must keep panic=unwind: `call_entry`
//! and `race_blocking` in `invoke` run guest calls and kv
//! snapshot/commit legs on `tokio::task::spawn_blocking` and rely on
//! `JoinError` to map a panicked leg to `GuestTrap`/`HostService`.
//! `panic = "abort"` turns any panic reachable through
//! remote-delivered plugin wasm into a host-process abort — a typed
//! error becoming a crash. A panic escaping an `extern "C"` export
//! still aborts at the FFI boundary, so abort buys size only.

/// Profiles only apply from the workspace root manifest — a `panic`
/// key anywhere in `[profile.release]` disables the spawn_blocking /
/// `JoinError` containment `invoke` relies on, whatever the value.
#[test]
fn release_profile_sets_no_panic_strategy() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.toml");
    let manifest = match std::fs::read_to_string(path) {
        Ok(m) => m,
        Err(e) => panic!("{path}: {e}"),
    };
    let mut in_release = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_release = line == "[profile.release]";
            continue;
        }
        if in_release && line.starts_with("panic") {
            panic!("[profile.release] must not set a panic strategy — got `{line}`");
        }
    }
}
