#!/usr/bin/env bash
# Build libauqw_mobile_bindings.a for iOS (device + simulator) and
# regenerate the Swift UniFFI bindings in the Expo module, packaged as
# an xcframework the podspec vendors as AuqwMobileBindingsFFI.
# Requires: rustup targets aarch64-apple-ios{,-sim} (rust-toolchain.toml).
set -euo pipefail

cd "$(dirname "$0")/.."

IOS_DIR="modules/auqw-expo/ios"

# aws-lc-sys C objects reference __chkstk_darwin, which lives in the
# toolchain's compiler-rt archive — rustc doesn't link it on iOS
# device builds. Match the pod's deployment floor while we're at it.
CLANG_RT_DIR="$(dirname "$(find "$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang" -name 'libclang_rt.ios.a' | head -1)")"
export IPHONEOS_DEPLOYMENT_TARGET=16.4
export RUSTFLAGS="-C link-arg=-lclang_rt.ios -C link-arg=-L$CLANG_RT_DIR"

cargo build -p auqw-mobile-bindings --release --target aarch64-apple-ios
cargo build -p auqw-mobile-bindings --release --target aarch64-apple-ios-sim
unset RUSTFLAGS

# UniFFI codegen from either built library (metadata is identical).
cargo run -p auqw-mobile-bindings --bin uniffi-bindgen -- generate \
  --library "target/aarch64-apple-ios-sim/release/libauqw_mobile_bindings.a" \
  --language swift \
  --no-format \
  --out-dir "$IOS_DIR"

# Stage the generated FFI header + clang modulemap (renamed to the
# conventional module.modulemap) so the xcframework embeds them per
# slice — that is what makes `import auqw_mobile_bindingsFFI` resolve.
HEADERS="$(mktemp -d)"
trap 'rm -rf "$HEADERS"' EXIT
cp "$IOS_DIR/auqw_mobile_bindingsFFI.h" "$HEADERS/"
cp "$IOS_DIR/auqw_mobile_bindingsFFI.modulemap" "$HEADERS/module.modulemap"
rm -f "$IOS_DIR/auqw_mobile_bindingsFFI.h" "$IOS_DIR/auqw_mobile_bindingsFFI.modulemap"

rm -rf "$IOS_DIR/AuqwMobileBindingsFFI.xcframework"
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libauqw_mobile_bindings.a -headers "$HEADERS" \
  -library target/aarch64-apple-ios-sim/release/libauqw_mobile_bindings.a -headers "$HEADERS" \
  -output "$IOS_DIR/AuqwMobileBindingsFFI.xcframework"

echo "done: $IOS_DIR/auqw_mobile_bindings.swift + $IOS_DIR/AuqwMobileBindingsFFI.xcframework"
