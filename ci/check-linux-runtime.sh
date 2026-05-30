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

build_dir="$(cd "$(dirname "$exe")/.." && pwd)"
runtime_dir="$build_dir/lib"

if [[ -d "$runtime_dir" ]]; then
  export LD_LIBRARY_PATH="$runtime_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

ldd_output="$(ldd "$exe")"
missing="$(printf '%s\n' "$ldd_output" | awk '/not found/ { print }')"
if [[ -n "$missing" ]]; then
  echo "missing Linux runtime libraries for $exe:" >&2
  echo "$missing" >&2
  exit 1
fi

if printf '%s\n' "$ldd_output" | awk '$1 == "libQt6Multimedia.so.6" { found = 1 } END { exit found ? 0 : 1 }'; then
  plugin="$build_dir/plugins/multimedia/libffmpegmediaplugin.so"
  if [[ ! -f "$plugin" ]]; then
    echo "missing Qt Multimedia backend plugin: $plugin" >&2
    exit 1
  fi

  plugin_missing="$(ldd "$plugin" | awk '/not found/ { print }')"
  if [[ -n "$plugin_missing" ]]; then
    echo "missing Qt Multimedia backend plugin libraries for $plugin:" >&2
    echo "$plugin_missing" >&2
    exit 1
  fi
fi
