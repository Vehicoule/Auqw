#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_path="${AUQW_IOS_APP_PATH:-}"
bundle_id="${AUQW_IOS_BUNDLE_ID:-com.Vehicoule.auqw}"
device="${AUQW_IOS_SIMULATOR_UDID:-}"
source_only="${AUQW_IOS_SMOKE_SOURCE_ONLY:-OFF}"

is_on() {
  case "${1:-}" in
    1|ON|on|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

find_app_bundle() {
  find "$root/build/ios" -type d -name "auqw.app" -print 2>/dev/null | sort | head -n 1
}

require_file() {
  local path="$1"
  local description="$2"
  if [[ ! -f "$path" ]]; then
    echo "missing iOS dependency: $description: $path" >&2
    exit 1
  fi
}

if [[ -z "$app_path" ]]; then
  "$root/ci/ios-build.sh"
  app_path="$(find_app_bundle)"
fi

if [[ -z "$app_path" || ! -d "$app_path" ]]; then
  echo "missing iOS app bundle: ${app_path:-$root/build/ios}" >&2
  exit 1
fi

plist="$app_path/Info.plist"
binary="$app_path/auqw"
require_file "$plist" "Info.plist"
require_file "$binary" "iOS app binary"

if ! command -v otool >/dev/null 2>&1; then
  echo "missing iOS dependency: otool" >&2
  exit 127
fi
if ! otool -L "$binary" | grep -q "AVFoundation"; then
  echo "iOS runtime smoke failed: AVFoundation linkage missing in $binary" >&2
  exit 1
fi
if ! otool -L "$binary" | grep -q "MediaPlayer"; then
  echo "iOS runtime smoke failed: MediaPlayer linkage missing in $binary" >&2
  exit 1
fi

if is_on "$source_only"; then
  echo "iOS source-only smoke complete; runtime pass not claimed without attached target."
  echo "iOS app: $app_path"
  exit 0
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "missing iOS dependency: xcrun; attach iOS target on macOS with Xcode" >&2
  exit 127
fi

if [[ -z "$device" ]]; then
  device="$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-Fa-f-][0-9A-Fa-f-]*\)) (Booted).*/\1/p' | head -n 1)"
fi

if [[ -z "$device" ]]; then
  xcrun simctl list devices booted >&2 || true
  echo "attach iOS target: boot an iOS simulator or set AUQW_IOS_SIMULATOR_UDID" >&2
  exit 2
fi

xcrun simctl install "$device" "$app_path"
xcrun simctl launch "$device" "$bundle_id" >/tmp/auqw-ios-smoke-launch.txt

echo "iOS runtime smoke passed"
echo "iOS target: $device"
echo "iOS app: $app_path"
echo "iOS bundle id: $bundle_id"
echo "iOS launch: $(cat /tmp/auqw-ios-smoke-launch.txt)"
echo "iOS framework evidence: AVFoundation MediaPlayer"
