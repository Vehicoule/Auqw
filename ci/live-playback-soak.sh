#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="${AUQW_BUILD_DIR:-$root/build/local}"
smoke_bin="$build_dir/auqw-qt/auqw_qt_youtube_sabr_live_smoke"
runs=1
max_results=3
playback=0
timeout_ms=45000
min_position_ms=1000
playback_window_ms=5000
queries=()

usage() {
  cat <<'USAGE'
Usage: ci/live-playback-soak.sh [options] [query...]

Options:
  --runs N                 Repeat the query matrix N times.
  --max-results N          Try up to N search results per query.
  --playback               Require Qt Multimedia playback progress.
  --timeout-ms N           Per-query timeout in milliseconds.
  --min-position-ms N      Playback progress threshold in milliseconds.
  --playback-window-ms N   Playback observation window in milliseconds.
  -h, --help               Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs)
      runs="${2:?--runs requires a value}"
      shift 2
      ;;
    --max-results)
      max_results="${2:?--max-results requires a value}"
      shift 2
      ;;
    --playback)
      playback=1
      shift
      ;;
    --timeout-ms)
      timeout_ms="${2:?--timeout-ms requires a value}"
      shift 2
      ;;
    --min-position-ms)
      min_position_ms="${2:?--min-position-ms requires a value}"
      shift 2
      ;;
    --playback-window-ms)
      playback_window_ms="${2:?--playback-window-ms requires a value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        queries+=("$1")
        shift
      done
      ;;
    *)
      queries+=("$1")
      shift
      ;;
  esac
done

if [[ "${#queries[@]}" -eq 0 ]]; then
  queries=(
    "around the world"
    "rolling in the"
    "one more time daft punk"
    "blinding lights"
    "lofi hip hop"
  )
fi

for value_name in runs max_results timeout_ms min_position_ms playback_window_ms; do
  value="${!value_name}"
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$value_name must be a positive integer" >&2
    exit 64
  fi
done

if [[ ! -x "$smoke_bin" ]]; then
  AUQW_BUILD_QT=ON AUQW_BUILD_DIR="$build_dir" "$root/ci/build-local.sh"
fi

failures=0
for ((run = 1; run <= runs; ++run)); do
  for query in "${queries[@]}"; do
    echo "soak_run=$run query=$query"
    if ! AUQW_SABR_SMOKE_MAX_RESULTS="$max_results" \
      AUQW_SABR_SMOKE_PLAYBACK="$playback" \
      AUQW_SABR_SMOKE_TIMEOUT_MS="$timeout_ms" \
      AUQW_SABR_SMOKE_MIN_POSITION_MS="$min_position_ms" \
      AUQW_SABR_SMOKE_PLAYBACK_WINDOW_MS="$playback_window_ms" \
      "$smoke_bin" "$query"; then
      failures=$((failures + 1))
    fi
  done
done

if [[ "$failures" -gt 0 ]]; then
  echo "live playback soak failures: $failures" >&2
  exit 1
fi
