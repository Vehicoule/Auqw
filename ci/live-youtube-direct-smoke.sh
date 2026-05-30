#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="${AUQW_BUILD_DIR:-$root/build/local}"
smoke_bin="$build_dir/auqw-qt/auqw_qt_youtube_sabr_live_smoke"
query="${1:-rolling in the}"

if [[ ! -x "$smoke_bin" ]]; then
  AUQW_BUILD_QT=ON AUQW_BUILD_DIR="$build_dir" "$root/ci/build-local.sh"
fi

"$smoke_bin" "$query"
