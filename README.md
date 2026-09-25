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
`providers.lock.json` into `apps/mobile/assets/plugins/` (pass an output
dir for the desktop set). Each lock `source` is either a `release:` path
to a signed release in a sibling `auqw-plugins` checkout — sync verifies
digest, manifest, provenance, and the ed25519 signature against the
lock's pinned key before anything is copied — or a `local-build:` path
for the dev loop (digest + manifest checks only). Clone `auqw-plugins`
next to this repository, then sync. Fetching release artifacts over the
network instead of from a sibling checkout is post–Slice 1 tooling
([../docs/specs/plugin-system.md](../docs/specs/plugin-system.md) §7).

## Layout

| Path | Contents |
| --- | --- |
| `crates/plugin-host` | Wasmi host that loads and invokes provider plugins |
| `crates/mobile-bindings` | UniFFI `PluginHost` over the host (Android + iOS) |
| `modules/auqw-expo` | Expo module wrapping the UniFFI bindings and the Android Media3 stream player |
| `apps/mobile` | Expo daily-driver app — see `apps/mobile/README.md` |
| `packages/application` | Pure TypeScript application core (domain, ports, session) |
| `packages/design-tokens` | DTCG token source and generated TS/CSS design tokens |
| `packages/storage-sqlite` | Platform-neutral SQLite `StoragePort` with injected drivers |
| `sdk/contract` | ABI v0 specification and message/manifest schemas |
| `sdk/conformance` | Minimal conformance guests (`echo`, `spin`) |
| `providers.lock.json` | Pin of known plugin artifact digests |
| `tooling` | `build-android-bindings.sh`, `build-ios-bindings.sh`, `checksums.mjs`, `stamp-version.mjs`, `sync-plugins.mjs`, `version-code.mjs` |

## Smoke test

```sh
cargo run -p auqw-plugin-host --example resolve -- \
    <path-to-wasm> <path-to-manifest> <video-id>
```
