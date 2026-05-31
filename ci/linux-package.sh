#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zig_bin="${ZIG:-zig}"
build_dir="${AUQW_BUILD_DIR:-$root/build/linux-package}"
install_root="${AUQW_INSTALL_ROOT:-$build_dir/stage}"
flatpak_mode="${AUQW_FLATPAK_BUILD:-auto}"
flatpak_build_dir="${AUQW_FLATPAK_BUILD_DIR:-$build_dir/flatpak-build}"
flatpak_repo="${AUQW_FLATPAK_REPO:-$build_dir/flatpak-repo}"
flatpak_bundle="${AUQW_LINUX_FLATPAK_BUNDLE:-$build_dir/auqw-linux-x64.flatpak}"
flatpak_branch="${AUQW_FLATPAK_BRANCH:-master}"
flatpak_installation="${AUQW_FLATPAK_INSTALLATION:-system}"
manifest="$root/packaging/linux/com.vehicoule.auqw.yml"

zig_cache="${AUQW_ZIG_CACHE_DIR:-/tmp/auqw-zig-cache}"
zig_global_cache="${AUQW_ZIG_GLOBAL_CACHE_DIR:-/tmp/auqw-zig-global-cache}"
core_lib="$root/auqw-core/zig-out/lib/libauqw_core.a"

is_off() {
  case "${1,,}" in
    0|false|no|off)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_on() {
  case "${1,,}" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

flatpak_scope_args=()
case "${flatpak_installation,,}" in
  system|"")
    ;;
  user)
    flatpak_scope_args=(--user)
    ;;
  *)
    echo "invalid AUQW_FLATPAK_INSTALLATION: $flatpak_installation" >&2
    exit 2
    ;;
esac

(
  cd "$root/auqw-core"
  "$zig_bin" build --cache-dir "$zig_cache" --global-cache-dir "$zig_global_cache" test
  "$zig_bin" build --cache-dir "$zig_cache" --global-cache-dir "$zig_global_cache"
)

cmake -S "$root" -B "$build_dir" -GNinja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/usr \
  -DAUQW_BUILD_QT=ON \
  -DAUQW_REQUIRE_QT_MULTIMEDIA=ON \
  -DAUQW_CORE_LIB="$core_lib"

cmake --build "$build_dir"
ctest --test-dir "$build_dir" --output-on-failure

rm -rf "$install_root"
DESTDIR="$install_root" cmake --install "$build_dir"

desktop_file="$install_root/usr/share/applications/com.vehicoule.auqw.desktop"
appstream_file="$install_root/usr/share/metainfo/com.vehicoule.auqw.metainfo.xml"
icon_file="$install_root/usr/share/icons/hicolor/scalable/apps/com.vehicoule.auqw.svg"

for required in "$install_root/usr/bin/auqw" "$desktop_file" "$appstream_file" "$icon_file"; do
  if [[ ! -e "$required" ]]; then
    echo "missing Linux package artifact: $required" >&2
    exit 1
  fi
done

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$desktop_file"
else
  echo "skipping desktop-file-validate: command not found"
fi

if command -v appstreamcli >/dev/null 2>&1; then
  appstreamcli validate --no-net "$appstream_file"
else
  echo "skipping appstreamcli validate: command not found"
fi

if is_off "$flatpak_mode"; then
  echo "Flatpak build disabled by AUQW_FLATPAK_BUILD=$flatpak_mode"
  exit 0
fi

if ! command -v flatpak-builder >/dev/null 2>&1; then
  if is_on "$flatpak_mode"; then
    echo "missing Linux packaging dependency: flatpak-builder" >&2
    exit 127
  fi
  echo "skipping flatpak-builder: command not found"
  exit 0
fi

if ! flatpak "${flatpak_scope_args[@]}" remotes --columns=name 2>/dev/null | grep -qx flathub; then
  echo "missing Flatpak remote: flathub" >&2
  echo "Add it with: flatpak ${flatpak_scope_args[*]} remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo" >&2
  exit 1
fi

flatpak-builder "${flatpak_scope_args[@]}" --force-clean \
  --repo="$flatpak_repo" \
  --install-deps-from=flathub \
  "$flatpak_build_dir" \
  "$manifest"

mkdir -p "$(dirname "$flatpak_bundle")"
flatpak build-bundle \
  "$flatpak_repo" \
  "$flatpak_bundle" \
  com.vehicoule.auqw \
  "$flatpak_branch"

echo "Linux Flatpak bundle: $flatpak_bundle"
