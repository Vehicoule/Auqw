#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zig_bin="${ZIG:-zig}"
build_dir="${AUQW_BUILD_DIR:-$root/build/macos}"
dmg_path="${AUQW_MACOS_DMG_PATH:-$build_dir/auqw-macos.dmg}"
zig_cache="${AUQW_ZIG_CACHE_DIR:-/tmp/auqw-zig-cache}"
zig_global_cache="${AUQW_ZIG_GLOBAL_CACHE_DIR:-/tmp/auqw-zig-global-cache}"
core_lib="$root/auqw-core/zig-out/lib/libauqw_core.a"

require_file() {
  local path="$1"
  local description="$2"
  if [[ ! -f "$path" ]]; then
    echo "missing macOS dependency: $description: $path" >&2
    exit 1
  fi
}

require_dir() {
  local path="$1"
  local description="$2"
  if [[ ! -d "$path" ]]; then
    echo "missing macOS dependency: $description: $path" >&2
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

discover_qt_prefix() {
  if [[ -n "${QT_PREFIX:-}" ]]; then
    printf '%s\n' "$QT_PREFIX"
    return 0
  fi
  if [[ -n "${QT_HOST_PATH:-}" ]]; then
    printf '%s\n' "$QT_HOST_PATH"
    return 0
  fi
  if [[ -n "${CMAKE_PREFIX_PATH:-}" ]]; then
    first_path_entry "$CMAKE_PREFIX_PATH"
    return 0
  fi
  if command -v qtpaths6 >/dev/null 2>&1; then
    qtpaths6 --install-prefix
    return 0
  fi
  if command -v brew >/dev/null 2>&1; then
    brew --prefix qt 2>/dev/null || true
  fi
}

find_app_bundle() {
  if [[ -n "${AUQW_MACOS_APP_PATH:-}" ]]; then
    printf '%s\n' "$AUQW_MACOS_APP_PATH"
    return 0
  fi
  find "$build_dir" -type d -name "auqw.app" -print | sort | head -n 1
}

validate_macos_bundle() {
  local app_path="$1"
  local binary="$app_path/Contents/MacOS/auqw"

  require_file "$app_path/Contents/Info.plist" "app bundle metadata"
  require_file "$binary" "app bundle executable"
  require_dir "$app_path/Contents/Frameworks/QtMultimedia.framework" "QtMultimedia.framework"

  if ! command -v otool >/dev/null 2>&1; then
    echo "missing macOS dependency: otool" >&2
    exit 127
  fi
  if ! otool -L "$binary" | grep -q "QtMultimedia"; then
    echo "missing Qt Multimedia linkage in macOS bundle executable: $binary" >&2
    exit 1
  fi

  local multimedia_plugin_dir="$app_path/Contents/PlugIns/multimedia"
  require_dir "$multimedia_plugin_dir" "Qt Multimedia plugin directory"
  if ! find "$multimedia_plugin_dir" -type f | grep -q .; then
    echo "missing Qt Multimedia backend plugin under $multimedia_plugin_dir" >&2
    exit 1
  fi
}

create_macos_dmg() {
  local app_path="$1"
  local output_path="$2"

  if ! command -v hdiutil >/dev/null 2>&1; then
    echo "missing macOS dependency: hdiutil" >&2
    exit 127
  fi

  mkdir -p "$(dirname "$output_path")"
  rm -f "$output_path"
  hdiutil create \
    -volname Auqw \
    -srcfolder "$app_path" \
    -format UDZO \
    "$output_path"
  hdiutil verify "$output_path"
}

qt_prefix="$(discover_qt_prefix)"
if [[ -z "$qt_prefix" ]]; then
  echo "missing macOS dependency: Qt prefix (set QT_PREFIX, QT_HOST_PATH, or CMAKE_PREFIX_PATH)" >&2
  exit 1
fi

qt_cmake="${QT_CMAKE:-$qt_prefix/bin/qt-cmake}"
macdeployqt="${MACDEPLOYQT:-$qt_prefix/bin/macdeployqt}"
if [[ ! -x "$macdeployqt" ]] && command -v macdeployqt >/dev/null 2>&1; then
  macdeployqt="$(command -v macdeployqt)"
fi

require_file "$qt_prefix/lib/cmake/Qt6/Qt6Config.cmake" "Qt6Config.cmake"
require_file "$qt_prefix/lib/cmake/Qt6Multimedia/Qt6MultimediaConfig.cmake" "Qt6MultimediaConfig.cmake"
require_file "$qt_prefix/qml/QtQuick/Effects/qmldir" "QtQuick/Effects QML runtime"
require_file "$qt_cmake" "qt-cmake"
require_file "$macdeployqt" "macdeployqt"

(
  cd "$root/auqw-core"
  "$zig_bin" build --cache-dir "$zig_cache" --global-cache-dir "$zig_global_cache" test
  "$zig_bin" build --cache-dir "$zig_cache" --global-cache-dir "$zig_global_cache"
)

"$qt_cmake" -S "$root" -B "$build_dir" -GNinja \
  -DAUQW_BUILD_QT=ON \
  -DAUQW_REQUIRE_QT_MULTIMEDIA=ON \
  -DCMAKE_PREFIX_PATH="$qt_prefix" \
  -DAUQW_CORE_LIB="$core_lib"

cmake --build "$build_dir"

app_path="$(find_app_bundle)"
if [[ -z "$app_path" ]]; then
  echo "missing macOS app bundle under $build_dir" >&2
  exit 1
fi

"$macdeployqt" "$app_path" -qmldir="$root/auqw-qt/qml"
validate_macos_bundle "$app_path"

AUQW_MACOS_APP_PATH="$app_path" ctest --test-dir "$build_dir" --output-on-failure
create_macos_dmg "$app_path" "$dmg_path"
echo "macOS DMG: $dmg_path"
