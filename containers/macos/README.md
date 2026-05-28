# Auqw macOS Build Environment

macOS builds require native macOS with Xcode command line tools. Use this recipe on a macOS host or macOS CI runner.

## Host Requirements

- macOS runner or local Mac
- Xcode command line tools
- Homebrew
- Qt macOS kit
- Zig 0.16.0
- CMake
- Ninja

## Setup

```bash
xcode-select --install
brew bundle --file containers/macos/Brewfile
```

If Homebrew `qt` is not the Qt version used for release builds, install the official Qt kit and pass `CMAKE_PREFIX_PATH` to CMake.

## Build

```bash
./ci/macos-build.sh
```

