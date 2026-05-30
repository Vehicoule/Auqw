#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exe="${1:-$root/build/freebsd/bin/auqw}"

if [[ ! -x "$exe" ]]; then
  echo "runtime executable not found: $exe" >&2
  exit 2
fi

if ! command -v ldd >/dev/null 2>&1; then
  echo "ldd is required for FreeBSD runtime checks" >&2
  exit 127
fi

ldd_output="$(ldd "$exe")"
missing="$(printf '%s\n' "$ldd_output" | awk '/not found/ { print }')"
if [[ -n "$missing" ]]; then
  echo "missing FreeBSD runtime libraries for $exe:" >&2
  echo "$missing" >&2
  exit 1
fi

if printf '%s\n' "$ldd_output" | grep -q "libQt6Multimedia"; then
  build_dir="$(cd "$(dirname "$exe")/.." && pwd)"
  plugin_candidates=(
    "$build_dir/plugins/multimedia"
    "$build_dir/lib/qt6/plugins/multimedia"
    "/usr/local/lib/qt6/plugins/multimedia"
  )

  if command -v qtpaths6 >/dev/null 2>&1; then
    qt_plugin_root="$(qtpaths6 --plugin-dir)"
    plugin_candidates+=("$qt_plugin_root/multimedia")
  fi

  for plugin_dir in "${plugin_candidates[@]}"; do
    if [[ -d "$plugin_dir" ]] && find "$plugin_dir" -type f -name "*.so" | grep -q .; then
      exit 0
    fi
  done

  echo "missing Qt Multimedia backend plugin under plugins/multimedia search paths:" >&2
  printf '  %s\n' "${plugin_candidates[@]}" >&2
  exit 1
fi
