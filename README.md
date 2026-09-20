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

## Provider artifacts

`pnpm sync-plugins` bundles the pinned provider artifacts from
`providers.lock.json` into `apps/mobile/assets/plugins/`. Each lock
`source` is a `local-build:` path into a sibling `auqw-plugins`
checkout — clone it next to this repository, build the pinned artifact
(`./tooling/build.sh <plugin-id>`), then sync. Fetching signed release
artifacts instead of a sibling build is post–Slice 0 tooling
([../docs/specs/plugin-system.md](../docs/specs/plugin-system.md) §7).

## Layout

| Path | Contents |
| --- | --- |
| `crates/plugin-host` | Wasmi host that loads and invokes provider plugins |
| `crates/mobile-bindings` | UniFFI `PluginHost` over the host (Android + iOS) |
| `modules/auqw-expo` | Expo module wrapping the UniFFI bindings + Media3 player (Android + iOS) |
| `apps/mobile` | Expo app (Slice 0 play screen) — see `apps/mobile/README.md` |
| `packages/application` | Pure TypeScript application core (domain, ports, session) |
| `packages/design-tokens` | DTCG token source and generated TS/CSS design tokens |
| `packages/storage-sqlite` | Platform-neutral SQLite `StoragePort` with injected drivers |
| `sdk/contract` | ABI v0 specification and message/manifest schemas |
| `sdk/conformance` | Minimal conformance guests (`echo`, `spin`) |
| `providers.lock.json` | Pin of known plugin artifact digests |
| `tooling` | `build-android-bindings.sh`, `sync-plugins.mjs` |

## Smoke test

```sh
cargo run -p auqw-plugin-host --example resolve -- \
    <path-to-wasm> <path-to-manifest> <video-id>
```
