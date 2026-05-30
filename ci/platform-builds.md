# Auqw Platform Gate

First milestone uses build proof plus local display where available.

## Shared Requirements

- Zig 0.16.0 or newer
- CMake 3.27 or newer
- Ninja
- Qt 6.5 or newer for the QML shell

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

Windows native runner/host:

```powershell
cd auqw-core
zig build test
zig build
cd ..
cmake -S . -B build/windows -G Ninja -DAUQW_BUILD_QT=ON -DAUQW_CORE_LIB="$PWD/auqw-core/zig-out/lib/auqw_core.lib"
cmake --build build/windows
ctest --test-dir build/windows --output-on-failure
```

Windows container on a Windows host with Windows containers enabled:

```powershell
.\ci\container-build.ps1 windows
```

GitHub Actions job `windows-container` is gated behind repository variable:

```text
AUQW_ENABLE_WINDOWS_CONTAINER=true
```

## macOS

Use a native macOS host with Xcode command line tools. Install dependencies with:

```bash
brew bundle --file containers/macos/Brewfile
```

```bash
./ci/macos-build.sh
```

## Android

Use a Qt Android kit for APK builds. Current container proves the Android SDK/NDK and Zig Android core path first.

```bash
./ci/container-build.sh android-linux
```

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

## FreeBSD

FreeBSD support starts as source-build proof with Qt 6 from ports/packages.

```sh
cd auqw-core
zig build test
zig build
cd ..
cmake -S . -B build/freebsd -GNinja -DAUQW_BUILD_QT=ON -DAUQW_CORE_LIB="$PWD/auqw-core/zig-out/lib/libauqw_core.a"
cmake --build build/freebsd
ctest --test-dir build/freebsd --output-on-failure
```
