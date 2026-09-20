#!/usr/bin/env bash
# Build libauqw_mobile_bindings.so for Android (arm64-v8a) and
# regenerate the Kotlin UniFFI bindings into the Expo module.
# Requires: cargo-ndk, ANDROID NDK at $ANDROID_NDK_HOME (or the SDK
# default below).
set -euo pipefail

cd "$(dirname "$0")/.."

export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$HOME/Library/Android/sdk/ndk/30.0.16248370}"
JNILIBS="modules/auqw-expo/android/src/main/jniLibs"
JAVA_OUT="modules/auqw-expo/android/src/main/java"

cargo ndk -t arm64-v8a -o "$JNILIBS" build -p auqw-mobile-bindings --release

cargo run -p auqw-mobile-bindings --bin uniffi-bindgen -- generate \
  --library "$JNILIBS/arm64-v8a/libauqw_mobile_bindings.so" \
  --language kotlin \
  --no-format \
  --out-dir "$JAVA_OUT"

echo "done: $JNILIBS/arm64-v8a/libauqw_mobile_bindings.so + $JAVA_OUT/uniffi/"
