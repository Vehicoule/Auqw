# Auqw Platform Gate

First milestone uses build proof plus local display where available.

## Shared Requirements

- Zig 0.16.0 or newer
- CMake 3.27 or newer
- Ninja
- Qt 6.4 or newer for the QML shell

Use temporary Zig caches on Windows-mounted WSL paths:

```bash
export AUQW_ZIG_CACHE_DIR=/tmp/auqw-zig-cache
export AUQW_ZIG_GLOBAL_CACHE_DIR=/tmp/auqw-zig-global-cache
```

The experimental Zig C++ bridge preset uses separate writable caches and a
wrapper that resolves `/snap/bin/zig` to the real snap payload before Ninja
invokes it:

```bash
export AUQW_ZIG_CXX_CACHE_DIR=/tmp/auqw-zig-cxx-cache
export AUQW_ZIG_CXX_GLOBAL_CACHE_DIR=/tmp/auqw-zig-cxx-global-cache
# Optional, when zig is not on PATH or /snap/bin/zig should be bypassed:
export ZIG_REAL=/path/to/zig
```

## Release Publishing

Release tags use plain semver only:

- `v0.0.1`: Alpha 1
- `v0.0.2`: Alpha 2
- `v0.1.0`: Beta 1
- `v0.1.1`: Beta 2
- `v1.0.0`: first stable

GitHub Releases are the canonical installer download location. In this repo,
plain semver tags publish stable GitHub Releases and are promoted to GitHub Latest.
Installer files are published only as GitHub Release assets.

## Linux Desktop

```bash
ZIG=zig AUQW_BUILD_QT=ON ./ci/build-local.sh
./build/local/bin/auqw
```

Reproducible container build:

```bash
./ci/container-build.sh linux-flatpak
./build/linux-flatpak/bin/auqw
```

The Linux container build copies its Qt Multimedia runtime dependency into
`build/linux-flatpak/lib` and checks the resulting executable with `ldd`.

Linux release staging:

```bash
AUQW_BUILD_DIR=/tmp/auqw-linux-package AUQW_FLATPAK_BUILD=OFF ./ci/linux-package.sh
```

The package script builds Release artifacts, installs to a staged `/usr`
layout under `build/linux-package/stage`, and validates the installed desktop
file and AppStream metadata when `desktop-file-validate` and `appstreamcli` are
available. It also deploys a portable runtime tree, validates it with
`ci/check-linux-runtime.sh`, and writes `auqw-linux-x64.tar.gz` or the path set
by `AUQW_LINUX_TARBALL`.

Full Flatpak build:

```bash
flatpak --user remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
AUQW_BUILD_DIR=/tmp/auqw-linux-package AUQW_FLATPAK_BUILD=ON AUQW_FLATPAK_INSTALLATION=user ./ci/linux-package.sh
flatpak install --user ./auqw-linux-x64.flatpak
```

The Flatpak manifest uses `org.kde.Platform` / `org.kde.Sdk` runtime branch
`6.9` and pins Zig
0.16.0. A full build exports `auqw-linux-x64.flatpak`, or the path set by
`AUQW_LINUX_FLATPAK_BUNDLE`. Release bundles include the Flathub runtime
repository hint so `flatpak install --user ./auqw-linux-x64.flatpak` can resolve
`org.kde.Platform//6.9`; if the local Flatpak setup still refuses, add the
Flathub remote manually with the command above and retry the install. If
`flatpak-builder` or the Flathub remote is missing, the script prints the
missing dependency instead of claiming package success. The manifest defaults
Qt Quick to software rendering with `QT_QUICK_BACKEND=software`,
`QSG_RHI_BACKEND=software`, and `QT_OPENGL=software` so WSL/Flatpak launches do
not depend on `/dev/dri` or Zink. The manifest disables Flatpak debuginfo
extraction and repository AppStream compose for hosted CI bundle exports; the
package script still validates the installed AppStream metadata before invoking
Flatpak packaging. The package script runs the full host CTest suite before
invoking Flatpak packaging; the manifest reruns only package-safe smoke tests
inside the Flatpak builder sandbox. The sandboxed CMake build is capped at two
parallel jobs so low-memory WSL hosts can validate the same package path.

## Bridge-Only Baseline

```bash
ZIG=zig AUQW_BUILD_QT=OFF ./ci/build-local.sh
```

Experimental Zig C++ support is bridge-only:

```bash
cmake --preset zig-cxx-bridge
cmake --build --preset zig-cxx-bridge
ctest --preset zig-cxx-bridge
```

Do not use Zig C++ for the distro Qt shell build. Current Linux Qt packages are
built against libstdc++; Zig C++ emits libc++ ABI symbols such as `std::__1`,
which leaves Qt C++ entry points unresolved at link time.

## Windows

Hosted GitHub Actions Windows build is enabled through the manual `Build`
workflow dispatch and release tag pushes. CI does not run automatically on
branch pushes or pull request updates. The hosted job installs Zig 0.16.0, Qt 6.8.3 for
`win64_msvc2022_64` with Qt Multimedia, enters the MSVC developer environment,
zips `build/windows/bin`, and uploads `auqw-windows-x64.zip`.

Windows native runner/host:

```powershell
.\ci\windows-build.ps1
```

The script honors `ZIG`, `AUQW_BUILD_DIR`, `AUQW_ZIG_TARGET`,
`AUQW_ZIG_CACHE_DIR`, and `AUQW_ZIG_GLOBAL_CACHE_DIR`; defaults the Zig core to
`x86_64-windows-msvc` for the hosted Qt kit; bundles Zig compiler-rt helpers
for MSVC static library links; configures a Release CMake build for release Qt
runtime deployment; requires Qt Multimedia for platform playback; deploys
`build\windows\bin\auqw.exe` with `windeployqt`; and validates the deployed Qt
DLLs, bundled MSVC runtime DLLs, and Multimedia plugin before smoke-launching
the packaged executable and running CTest. The Visual C++ redistributable
installer is copied beside the app when the hosted Visual Studio image exposes
it, but the zip does not depend on users installing it first.

Windows container on a Windows host with Windows containers enabled:

```powershell
.\ci\container-build.ps1 windows
```

The Windows container flow is a local/manual host option only; GitHub Actions
uses hosted `windows-latest`.

## macOS

Use a native macOS host with Xcode command line tools. Install dependencies with:

```bash
brew bundle --file containers/macos/Brewfile
```

```bash
./ci/macos-build.sh
```

The script honors `ZIG`, `AUQW_BUILD_DIR`, `AUQW_ZIG_CACHE_DIR`, and
`AUQW_ZIG_GLOBAL_CACHE_DIR`; requires Qt Multimedia for platform playback;
deploys the `.app` bundle with `macdeployqt`; and validates `otool -L`,
`QtMultimedia.framework`, bundle metadata, and `Contents/PlugIns/multimedia`
before running CTest. It creates a compressed `auqw-macos.dmg`, or the path set
by `AUQW_MACOS_DMG_PATH`, from the deployed app bundle.

## Android

Use a Qt Android kit for APK builds. Current container proves the Android SDK/NDK and Zig Android core path first.

```bash
./ci/container-build.sh android-linux
```

Tag releases require a signed release APK. Configure repository secrets before
pushing release tags:

- `AUQW_ANDROID_KEYSTORE_BASE64`
- `AUQW_ANDROID_KEYSTORE_PASSWORD`
- `AUQW_ANDROID_KEY_ALIAS`
- `AUQW_ANDROID_KEY_PASSWORD`

The Android build targets API 35 with build tools 35.0.0. For Qt 6.7's older
Android Gradle plugin, the script forces Gradle to use the SDK build-tools
`aapt2` binary so API 35 resources link correctly. On tag runs,
`ci/android-build.sh` fails clearly if any signing secret is missing. The
signed output is `build/android-linux/apk/auqw-android-arm64.apk`; non-release
local builds still emit `auqw-android-arm64-debug.apk`.

Runtime smoke requires an attached emulator/device in `adb device` state. The
smoke builds the APK when `AUQW_ANDROID_APK_PATH` is not set, installs it,
launches `com.Vehicoule.auqw.AuqwActivity`, validates the installed playback
service declaration, and captures `dumpsys media_session` evidence.

```bash
./ci/android-runtime-smoke.sh
```

For source-only CI where no emulator/device is attached, use:

```bash
AUQW_ANDROID_SMOKE_SOURCE_ONLY=ON ./ci/android-runtime-smoke.sh
```

That mode validates the build artifact path only and does not claim runtime
pass. Set `AUQW_ANDROID_REQUIRE_ACTIVE_MEDIA_SESSION=ON` after manually
starting playback when active MediaSession evidence must be required.

## iOS

Use a native macOS host with Xcode and a Qt iOS kit. Install shared command-line dependencies with:

```bash
brew bundle --file containers/ios/Brewfile
./ci/ios-build.sh
```

GitHub Actions job `ios` is gated behind repository variable:

```text
AUQW_ENABLE_IOS=true
```

Enable it after the runner has a Qt iOS kit available through `CMAKE_PREFIX_PATH`.
Set `QT_HOST_PATH` to the matching host Qt tools kit. `ci/ios-build.sh` builds
the Zig core for `aarch64-ios`, runs source/package CTest with the host kit,
configures the artifact build with `CMAKE_SYSTEM_NAME=iOS`, and validates
`Info.plist`, `AVFoundation`, and `MediaPlayer` linkage when an `.app` bundle
is produced. Runtime smoke on a physical device or simulator remains a separate
step until an attached iOS target exists.

Runtime smoke requires a booted iOS simulator on macOS/Xcode. The smoke builds
the `.app` when `AUQW_IOS_APP_PATH` is not set, validates `Info.plist` plus
`AVFoundation`/`MediaPlayer` linkage, installs the app through `xcrun simctl`,
and launches bundle id `com.Vehicoule.auqw`.

```bash
./ci/ios-runtime-smoke.sh
```

For source-only CI where no simulator/device is attached, use:

```bash
AUQW_IOS_SMOKE_SOURCE_ONLY=ON ./ci/ios-runtime-smoke.sh
```

That mode validates the build artifact path only and does not claim runtime
pass.

## FreeBSD

FreeBSD support starts as source-build proof with Qt 6 from ports/packages.

```sh
sudo pkg install cmake ninja qt6-base qt6-declarative qt6-multimedia qt6-quickcontrols2 zig
cd auqw-core
zig build test && zig build
cd ..
cmake -S . -B build/freebsd -GNinja \
  -DAUQW_BUILD_QT=ON \
  -DAUQW_REQUIRE_QT_MULTIMEDIA=ON \
  -DAUQW_CORE_LIB="$PWD/auqw-core/zig-out/lib/libauqw_core.a"
cmake --build build/freebsd
ctest --test-dir build/freebsd --output-on-failure
./ci/check-freebsd-runtime.sh build/freebsd/bin/auqw
```

FreeBSD uses the native compiler/toolchain for the Qt shell and native `ldd`
for runtime validation. Zig remains responsible for the core library and bridge
smoke path, not the Qt C++ shell compiler.
