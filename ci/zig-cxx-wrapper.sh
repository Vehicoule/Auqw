#!/usr/bin/env bash
set -euo pipefail

resolve_zig() {
  local candidate="${ZIG_REAL:-}"

  if [[ -z "$candidate" ]]; then
    candidate="$(command -v zig || true)"
  fi

  if [[ "$candidate" == "/snap/bin/zig" && -x "/snap/zig/current/zig" ]]; then
    candidate="/snap/zig/current/zig"
  fi

  if [[ -z "$candidate" || ! -x "$candidate" ]]; then
    printf 'zig-cxx-wrapper: set ZIG_REAL to a real zig binary\n' >&2
    exit 127
  fi

  printf '%s\n' "$candidate"
}

zig_real="$(resolve_zig)"

export ZIG_LOCAL_CACHE_DIR="${AUQW_ZIG_CXX_CACHE_DIR:-/tmp/auqw-zig-cxx-cache}"
export ZIG_GLOBAL_CACHE_DIR="${AUQW_ZIG_CXX_GLOBAL_CACHE_DIR:-/tmp/auqw-zig-cxx-global-cache}"

mkdir -p "$ZIG_LOCAL_CACHE_DIR" "$ZIG_GLOBAL_CACHE_DIR"

exec "$zig_real" c++ "$@"
