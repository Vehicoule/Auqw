#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exe="${1:-$root/build/linux-flatpak/bin/auqw}"

if [[ ! -x "$exe" ]]; then
  echo "runtime executable not found: $exe" >&2
  exit 2
fi

if ! command -v ldd >/dev/null 2>&1; then
  echo "ldd is required for Linux runtime checks" >&2
  exit 127
fi

missing="$(ldd "$exe" | awk '/not found/ { print }')"
if [[ -n "$missing" ]]; then
  echo "missing Linux runtime libraries for $exe:" >&2
  echo "$missing" >&2
  exit 1
fi

if ldd "$exe" | awk '$1 == "libQt6Multimedia.so.6" { found = 1 } END { exit found ? 0 : 1 }'; then
  build_dir="$(cd "$(dirname "$exe")/.." && pwd)"
  if [[ ! -f "$build_dir/plugins/multimedia/libffmpegmediaplugin.so" ]]; then
    echo "missing Qt Multimedia backend plugin: $build_dir/plugins/multimedia/libffmpegmediaplugin.so" >&2
    exit 1
  fi
fi
