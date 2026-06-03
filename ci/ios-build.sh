#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zig_bin="${ZIG:-zig}"
build_dir="${AUQW_BUILD_DIR:-$root/build/ios}"
host_test_build_dir="${AUQW_IOS_HOST_TEST_BUILD_DIR:-$root/build/ios-host-tests}"
zig_cache="${AUQW_ZIG_CACHE_DIR:-/tmp/auqw-zig-cache}"
zig_global_cache="${AUQW_ZIG_GLOBAL_CACHE_DIR:-/tmp/auqw-zig-global-cache}"
core_lib="$root/auqw-core/zig-out/lib/libauqw_core.a"

require_file() {
  local path="$1"
  local description="$2"
  if [[ ! -f "$path" ]]; then
    echo "missing iOS dependency: $description: $path" >&2
    exit 1
  fi
}

require_dir() {
  local path="$1"
  local description="$2"
  if [[ ! -d "$path" ]]; then
    echo "missing iOS dependency: $description: $path" >&2
    exit 1
  fi
}

first_path_entry() {
  local value="${1:-}"
  if [[ -z "$value" ]]; then
    return 0
  fi
  value="${value%%;*}"
  printf '%s\n' "${value%%:*}"
}

discover_qt_ios_prefix() {
  if [[ -n "${QT_IOS_PREFIX:-}" ]]; then
    printf '%s\n' "$QT_IOS_PREFIX"
    return 0
  fi
  if [[ -n "${CMAKE_PREFIX_PATH:-}" ]]; then
    first_path_entry "$CMAKE_PREFIX_PATH"
    return 0
  fi
}

find_ios_app_bundle() {
  if [[ -n "${AUQW_IOS_APP_PATH:-}" ]]; then
    printf '%s\n' "$AUQW_IOS_APP_PATH"
    return 0
  fi
  find "$build_dir" -type d -name "auqw.app" -print | sort | head -n 1
}

validate_ios_bundle() {
  local app_path="$1"
  local plist="$app_path/Info.plist"
  local binary="$app_path/auqw"

  require_file "$plist" "Info.plist"
  require_file "$binary" "iOS app binary"

  if command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$plist" | grep -q "com.Vehicoule.auqw"
    /usr/libexec/PlistBuddy -c "Print :CFBundleName" "$plist" | grep -q "Auqw"
  else
    grep -q "com.Vehicoule.auqw" "$plist"
    grep -q "Auqw" "$plist"
  fi

  if ! command -v otool >/dev/null 2>&1; then
    echo "missing iOS dependency: otool" >&2
    exit 127
  fi
  if ! otool -L "$binary" | grep -q "AVFoundation"; then
    echo "missing AVFoundation linkage in iOS app binary: $binary" >&2
    exit 1
  fi
  if ! otool -L "$binary" | grep -q "MediaPlayer"; then
    echo "missing MediaPlayer linkage in iOS app binary: $binary" >&2
    exit 1
  fi
}

run_host_source_tests() {
  if [[ ! -f "$qt_host_path/lib/cmake/Qt6/Qt6Config.cmake" ]]; then
    echo "skipping iOS host source CTest: missing host Qt at $qt_host_path" >&2
    return 0
  fi

  cmake -S "$root" -B "$host_test_build_dir" -GNinja \
    -DAUQW_BUILD_QT=ON \
    -DAUQW_REQUIRE_QT_MULTIMEDIA=ON \
    -DCMAKE_PREFIX_PATH="$qt_host_path" \
    -DAUQW_CORE_LIB="$core_lib"
  cmake --build "$host_test_build_dir" --target auqw_qt_ios_platform_wiring_test auqw_qt_platform_package_test
  ctest --test-dir "$host_test_build_dir" --output-on-failure -R "auqw_qt_(ios_platform_wiring|platform_package)_test"
}

qt_ios_prefix="$(discover_qt_ios_prefix)"
qt_host_path="${QT_HOST_PATH:-}"

if [[ -z "$qt_ios_prefix" ]]; then
  echo "missing iOS dependency: Qt iOS kit (set QT_IOS_PREFIX or CMAKE_PREFIX_PATH)" >&2
  exit 1
fi
if [[ -z "$qt_host_path" ]]; then
  echo "missing iOS dependency: Qt host tools path (set QT_HOST_PATH)" >&2
  exit 1
fi

qt_cmake="${QT_CMAKE:-$qt_ios_prefix/bin/qt-cmake}"
require_file "$qt_ios_prefix/lib/cmake/Qt6/Qt6Config.cmake" "Qt6Config.cmake"
require_file "$qt_ios_prefix/lib/cmake/Qt6Multimedia/Qt6MultimediaConfig.cmake" "Qt6MultimediaConfig.cmake"
require_file "$qt_ios_prefix/qml/QtQuick/Effects/qmldir" "QtQuick/Effects QML runtime"
require_file "$qt_host_path/lib/cmake/Qt6/Qt6Config.cmake" "host Qt6Config.cmake"
require_file "$qt_cmake" "qt-cmake"

(
  cd "$root/auqw-core"
  "$zig_bin" build --cache-dir "$zig_cache" --global-cache-dir "$zig_global_cache" -Dtarget=aarch64-ios
)

run_host_source_tests

"$qt_cmake" -S "$root" -B "$build_dir" -GXcode \
  -DAUQW_BUILD_QT=ON \
  -DAUQW_REQUIRE_QT_MULTIMEDIA=ON \
  -DCMAKE_SYSTEM_NAME=iOS \
  -DCMAKE_PREFIX_PATH="$qt_ios_prefix" \
  -DQT_HOST_PATH="$qt_host_path" \
  -DAUQW_CORE_LIB="$core_lib"

cmake --build "$build_dir"

app_path="$(find_ios_app_bundle)"
if [[ -z "$app_path" ]]; then
  echo "missing iOS app bundle under $build_dir" >&2
  exit 1
fi

validate_ios_bundle "$app_path"
AUQW_IOS_APP_PATH="$app_path" ctest --test-dir "$host_test_build_dir" --output-on-failure -R "auqw_qt_platform_package_test"
