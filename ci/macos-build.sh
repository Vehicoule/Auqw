#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zig_bin="${ZIG:-zig}"
build_dir="${AUQW_BUILD_DIR:-$root/build/macos}"
core_lib="$root/auqw-core/zig-out/lib/libauqw_core.a"

(
  cd "$root/auqw-core"
  "$zig_bin" build test
  "$zig_bin" build
)

cmake -S "$root" -B "$build_dir" -GNinja \
  -DAUQW_BUILD_QT=ON \
  -DAUQW_CORE_LIB="$core_lib"

cmake --build "$build_dir"
ctest --test-dir "$build_dir" --output-on-failure

