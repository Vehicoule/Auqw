# Auqw iOS Build Environment

iOS builds require native macOS with Xcode and an iOS-capable Qt kit. This cannot be replaced by a Linux or Docker container.

## Host Requirements

- macOS runner or local Mac
- Xcode with iOS SDK
- Homebrew
- Qt iOS kit from the Qt installer
- Zig 0.16.0
- CMake
- Ninja or Xcode generator

## Setup

```bash
xcode-select --install
brew bundle --file containers/ios/Brewfile
```

Install the Qt iOS kit separately and point CMake at it through `CMAKE_PREFIX_PATH`.

## Build

```bash
./ci/ios-build.sh
```

