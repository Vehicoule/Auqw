<div align="center">

# Auqw — for Android, Linux, macOS & Windows

[![Latest release](https://img.shields.io/github/v/release/Vehicoule/Auqw?include_prereleases&label=latest%20release&style=for-the-badge)](https://github.com/Vehicoule/Auqw/releases) [![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue?style=for-the-badge)](LICENSE) [![Platforms](https://img.shields.io/badge/platforms-Android%20%C2%B7%20Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-informational?style=for-the-badge)](#download--install)

Auqw is a music player for all your devices: search for a track, build
your queue, like what you love, and sync your library between your
phone and desktop over your local network — no account, no cloud.

</div>

## Download & Install

Grab the file for your platform from the
[Releases page](https://github.com/Vehicoule/Auqw/releases):

| Platform | Download | Install |
| --- | --- | --- |
| **Android** (arm64) | [![APK](https://img.shields.io/badge/download-.APK-3DDC84?style=for-the-badge&logo=android&logoColor=white)](https://github.com/Vehicoule/Auqw/releases) | Open the APK on your phone |
| **Linux** (x86-64) | [![AppImage](https://img.shields.io/badge/download-.AppImage-555555?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/Vehicoule/Auqw/releases) [![Flatpak](https://img.shields.io/badge/download-.Flatpak-4A90D9?style=for-the-badge&logo=flatpak&logoColor=white)](https://github.com/Vehicoule/Auqw/releases) | `chmod +x` the AppImage, or `flatpak install` the bundle |
| **macOS** (Apple Silicon) | [![DMG](https://img.shields.io/badge/download-.DMG-999999?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/Vehicoule/Auqw/releases) | Drag auqw into Applications |
| **Windows** (x64) | [![EXE](https://img.shields.io/badge/download-.EXE-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/Vehicoule/Auqw/releases) | Run the setup installer |

Alpha builds are unsigned, so your OS may warn before running — on
macOS run `xattr -dr com.apple.quarantine /Applications/auqw.app`, on
Windows click "More info → Run anyway". Desktop downloads ship with a
`SHA256SUMS-<os>.txt` to verify the file.

## Development

Auqw resolves playback through sandboxed WebAssembly provider plugins.
This repository holds the host runtime, the ABI contract, and the
application code.

### Setup

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

### Provider artifacts

`pnpm sync-plugins` bundles the pinned provider artifacts from
`providers.lock.json` into `apps/mobile/assets/plugins/`. Each lock
`source` is a `release:` path into a signed release directory inside a
sibling `auqw-plugins` checkout — clone it next to this repository,
then sync. The digest, manifest, provenance, and ed25519 signature are
all verified against the lock's pinned key before anything is copied.
(`local-build:` sources also exist for the dev loop — digest and
manifest checks only.)

### Layout

| Path | Contents |
| --- | --- |
| `crates/plugin-host` | Wasmi host that loads and invokes provider plugins |
| `crates/mobile-bindings` | UniFFI `PluginHost` over the host (Android + iOS) |
| `modules/auqw-expo` | Expo module wrapping the UniFFI bindings and the Android Media3 stream player |
| `apps/mobile` | Expo daily-driver app — see `apps/mobile/README.md` |
| `apps/desktop` | Electron desktop shell |
| `packages/application` | Pure TypeScript application core (domain, ports, session) |
| `packages/design-tokens` | DTCG token source and generated TS/CSS design tokens |
| `packages/storage-sqlite` | Platform-neutral SQLite `StoragePort` with injected drivers |
| `sdk/contract` | ABI v0 specification and message/manifest schemas |
| `sdk/conformance` | Minimal conformance guests (`echo`, `spin`) |
| `providers.lock.json` | Pin of known plugin artifact digests |
| `tooling` | `build-android-bindings.sh`, `sync-plugins.mjs` |

### Smoke test

```sh
cargo run -p auqw-plugin-host --example resolve -- \
    <path-to-wasm> <path-to-manifest> <video-id>
```
