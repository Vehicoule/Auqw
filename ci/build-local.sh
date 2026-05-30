#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zig_bin="${ZIG:-zig}"
build_qt="${AUQW_BUILD_QT:-OFF}"
require_qt_multimedia="${AUQW_REQUIRE_QT_MULTIMEDIA:-OFF}"
build_dir="${AUQW_BUILD_DIR:-$root/build/local}"

zig_cache="${AUQW_ZIG_CACHE_DIR:-/tmp/auqw-zig-cache}"
zig_global_cache="${AUQW_ZIG_GLOBAL_CACHE_DIR:-/tmp/auqw-zig-global-cache}"

core_lib="$root/auqw-core/zig-out/lib/libauqw_core.a"

(
  cd "$root/auqw-core"
  "$zig_bin" build --cache-dir "$zig_cache" --global-cache-dir "$zig_global_cache" test
  "$zig_bin" build --cache-dir "$zig_cache" --global-cache-dir "$zig_global_cache"
)

cmake -S "$root" -B "$build_dir" -GNinja \
  -DAUQW_BUILD_QT="$build_qt" \
  -DAUQW_REQUIRE_QT_MULTIMEDIA="$require_qt_multimedia" \
  -DAUQW_CORE_LIB="$core_lib"

cmake --build "$build_dir"
ctest --test-dir "$build_dir" --output-on-failure
