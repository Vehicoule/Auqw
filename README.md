# Auqw

A music player that resolves playback through sandboxed WebAssembly provider
plugins. This repository holds the host runtime, the ABI contract, and the
application code (application code arrives in later slices).

The product, architecture, and slice plan live in
[../docs/README.md](../docs/README.md).

## Setup

Requires Rust (see `rust-toolchain.toml`; `wasm32-unknown-unknown` and
`aarch64-linux-android` targets are pinned), Node.js, and pnpm
(`packageManager` field in `package.json`).

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Layout

| Path | Contents |
| --- | --- |
| `crates/plugin-host` | Wasmi host that loads and invokes provider plugins |
| `sdk/contract` | ABI v0 specification and message/manifest schemas |
| `sdk/conformance` | Minimal conformance guests (`echo`, `spin`) |
| `providers.lock.json` | Pin of known plugin artifact digests |

## Smoke test

```sh
cargo run -p auqw-plugin-host --example resolve -- \
    <path-to-wasm> <path-to-manifest> <video-id>
```
