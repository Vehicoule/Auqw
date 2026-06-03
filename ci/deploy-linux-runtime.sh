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

runtime_ldd_output="$(ldd "$exe")"

should_skip_runtime_library() {
  case "$(basename "$1")" in
    ld-linux*.so*|libc.so*|libdl.so*|libgcc_s.so*|libm.so*)
      return 0
      ;;
    libpthread.so*|libresolv.so*|librt.so*|libstdc++.so*|libutil.so*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

declare -A copied_runtime_libs=()

copy_runtime_libraries() {
  local binary="$1"
  local dest
  local key
  local lib
  local -a runtime_libs
  mapfile -t runtime_libs < <(
    ldd "$binary" | sed -n -E \
      -e 's/^[[:space:]]*[^=]+=>[[:space:]]*(\/.*)[[:space:]]+\(0x[[:xdigit:]]+\).*$/\1/p' \
      -e 's/^[[:space:]]*(\/.*)[[:space:]]+\(0x[[:xdigit:]]+\).*$/\1/p'
  )

  for lib in "${runtime_libs[@]}"; do
    if should_skip_runtime_library "$lib"; then
      continue
    fi

    key="$(readlink -f "$lib")"
    if [[ -n "${copied_runtime_libs[$key]:-}" ]]; then
      continue
    fi
    copied_runtime_libs[$key]=1

    dest="$runtime_dir/$(basename "$lib")"
    if [[ "$key" != "$(readlink -m "$dest")" ]]; then
      cp -L "$lib" "$dest"
    fi
    copy_runtime_libraries "$dest"
  done
}

copy_runtime_libraries "$exe"

if printf '%s\n' "$runtime_ldd_output" | awk '$1 == "libQt6Multimedia.so.6" { found = 1 } END { exit found ? 0 : 1 }'; then
  qt_plugin_root="$(qtpaths6 --plugin-dir)"
  multimedia_plugin="$qt_plugin_root/multimedia/libffmpegmediaplugin.so"

  if [[ ! -f "$multimedia_plugin" ]]; then
    echo "Qt Multimedia backend plugin not found: $multimedia_plugin" >&2
    exit 1
  fi

  mkdir -p "$plugin_dir/multimedia"
  cp -L "$multimedia_plugin" "$plugin_dir/multimedia/libffmpegmediaplugin.so"
  copy_runtime_libraries "$plugin_dir/multimedia/libffmpegmediaplugin.so"
fi
