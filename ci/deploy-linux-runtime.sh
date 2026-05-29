#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="${1:-${AUQW_BUILD_DIR:-$root/build/linux-flatpak}}"
exe="$build_dir/bin/auqw"
runtime_dir="$build_dir/lib"
plugin_dir="$build_dir/plugins"

if [[ ! -x "$exe" ]]; then
  echo "runtime executable not found: $exe" >&2
  exit 2
fi

if ! command -v ldd >/dev/null 2>&1; then
  echo "ldd is required for Linux runtime deployment" >&2
  exit 127
fi

mkdir -p "$runtime_dir"

mapfile -t qt_multimedia_libs < <(
  ldd "$exe" | awk '$1 ~ /^libQt6Multimedia/ && $3 ~ /^\// { print $3 }'
)

for lib in "${qt_multimedia_libs[@]}"; do
  dest="$runtime_dir/$(basename "$lib")"
  if [[ "$(readlink -f "$lib")" != "$(readlink -m "$dest")" ]]; then
    cp -L "$lib" "$dest"
  fi
done

if ((${#qt_multimedia_libs[@]} > 0)); then
  qt_plugin_root="$(qtpaths6 --plugin-dir)"
  multimedia_plugin="$qt_plugin_root/multimedia/libffmpegmediaplugin.so"

  if [[ ! -f "$multimedia_plugin" ]]; then
    echo "Qt Multimedia backend plugin not found: $multimedia_plugin" >&2
    exit 1
  fi

  mkdir -p "$plugin_dir/multimedia"
  cp -L "$multimedia_plugin" "$plugin_dir/multimedia/libffmpegmediaplugin.so"
fi
