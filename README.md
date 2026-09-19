# Auqw

A music player that resolves playback through sandboxed WebAssembly provider
plugins. This repository holds the host runtime, the ABI contract, and the
application code.

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

For Android work there is no system JDK — export the Android Studio JBR
(also in `.envrc.example`):

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

## Layout

| Path | Contents |
| --- | --- |
| `crates/plugin-host` | Wasmi host that loads and invokes provider plugins |
| `crates/mobile-bindings` | UniFFI `PluginHost` over the host (Android + iOS) |
| `modules/plugin-host-expo` | Expo module wrapping the UniFFI bindings (Android + iOS) |
| `apps/mobile` | Expo app (Slice 0 play screen) — see `apps/mobile/README.md` |
| `sdk/contract` | ABI v0 specification and message/manifest schemas |
| `sdk/conformance` | Minimal conformance guests (`echo`, `spin`) |
| `providers.lock.json` | Pin of known plugin artifact digests |
| `tooling` | `build-android-bindings.sh`, `sync-plugins.mjs` |

## Smoke test

```sh
cargo run -p auqw-plugin-host --example resolve -- \
    <path-to-wasm> <path-to-manifest> <video-id>
```
