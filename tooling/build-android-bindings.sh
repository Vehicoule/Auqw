#!/usr/bin/env bash
# Build libauqw_mobile_bindings.so for Android (arm64-v8a devices and
# x86_64 emulators) and regenerate the Kotlin UniFFI bindings into the
# Expo module.
# Requires: cargo-ndk, ANDROID NDK at $ANDROID_NDK_HOME (or the SDK
# default below).
# AUQW_ANDROID_ABIS narrows the built targets (comma-separated); the
# release workflow ships arm64 only and sets it accordingly. The first
# entry's .so feeds uniffi-bindgen.
set -euo pipefail

cd "$(dirname "$0")/.."

export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$HOME/Library/Android/sdk/ndk/30.0.16248370}"
JNILIBS="modules/auqw-expo/android/src/main/jniLibs"
JAVA_OUT="modules/auqw-expo/android/src/main/java"

IFS=',' read -ra ABIS <<< "${AUQW_ANDROID_ABIS:-arm64-v8a,x86_64}"
TARGETS=()
for abi in "${ABIS[@]}"; do TARGETS+=(-t "$abi"); done

cargo ndk "${TARGETS[@]}" -o "$JNILIBS" build -p auqw-mobile-bindings --release

cargo run -p auqw-mobile-bindings --bin uniffi-bindgen -- generate \
  --library "$JNILIBS/${ABIS[0]}/libauqw_mobile_bindings.so" \
  --language kotlin \
  --no-format \
  --out-dir "$JAVA_OUT"

echo "done: $JNILIBS/${ABIS[0]}/libauqw_mobile_bindings.so + $JAVA_OUT/uniffi/"
