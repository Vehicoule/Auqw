# Auqw

Auqw is a Qt/QML shell backed by a Zig core through a tiny C ABI.

## Identity

- App name: `Auqw`
- Executable: `auqw`
- App id / developer domain: `com.Vehicoule.auqw`
- Core library: `libauqw_core`

## First Milestone

The first milestone proves the architecture with one visible string:

```text
Hello from Auqw Core
```

The text comes from Zig, crosses the C ABI, enters C++, and displays in QML.

## Build Order

```bash
cd auqw-core
zig build test
zig build

cd ..
cmake -S . -B build -GNinja -DAUQW_BUILD_QT=OFF
cmake --build build
ctest --test-dir build --output-on-failure
```

Enable the Qt shell when Qt 6 Quick/QML development files are installed:

```bash
cmake -S . -B build-qt -GNinja -DAUQW_BUILD_QT=ON
cmake --build build-qt
./build-qt/bin/auqw
```

## Reproducible Build Environments

Use native local builds for quick debugging:

```bash
AUQW_BUILD_QT=ON ./ci/build-local.sh
./build/local/bin/auqw
```

Use container builds when dependency reproducibility matters:

```bash
./ci/container-build.sh linux-flatpak
./ci/container-build.sh android-linux
```

Windows containers require a Windows host with Windows containers enabled:

```powershell
.\ci\container-build.ps1 windows
```

macOS and iOS use native macOS host recipes under `containers/macos` and `containers/ios`.
