#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-linux-flatpak}"

case "$target" in
  linux-flatpak|android-linux)
    ;;
  windows)
    echo "windows container builds require a Windows host with Windows containers enabled." >&2
    echo "Use ci/container-build.ps1 windows on that host." >&2
    exit 2
    ;;
  *)
    echo "usage: $0 {linux-flatpak|android-linux|windows}" >&2
    exit 2
    ;;
esac

if command -v podman >/dev/null 2>&1; then
  engine="podman"
elif command -v docker >/dev/null 2>&1; then
  engine="docker"
else
  echo "podman or docker is required" >&2
  exit 127
fi

image="auqw-${target}:dev"
containerfile="$root/containers/$target/Containerfile"
build_dir="/workspace/build/$target"

"$engine" build -t "$image" -f "$containerfile" "$root"

case "$target" in
  linux-flatpak)
    "$engine" run --rm \
      -v "$root:/workspace:Z" \
      -w /workspace \
      -e AUQW_BUILD_QT=ON \
      -e AUQW_BUILD_DIR="$build_dir" \
      -e AUQW_ZIG_CACHE_DIR=/tmp/auqw-zig-cache \
      -e AUQW_ZIG_GLOBAL_CACHE_DIR=/tmp/auqw-zig-global-cache \
      "$image" \
      bash -lc './ci/build-local.sh && ./ci/deploy-linux-runtime.sh "$AUQW_BUILD_DIR"'
    bash "$root/ci/check-linux-runtime.sh" "$root/build/$target/bin/auqw"
    ;;
  android-linux)
    "$engine" run --rm \
      -v "$root:/workspace:Z" \
      -w /workspace \
      -e AUQW_BUILD_DIR="$build_dir" \
      -e AUQW_ZIG_CACHE_DIR=/tmp/auqw-zig-cache \
      -e AUQW_ZIG_GLOBAL_CACHE_DIR=/tmp/auqw-zig-global-cache \
      "$image" \
      ./ci/android-build.sh
    ;;
esac
