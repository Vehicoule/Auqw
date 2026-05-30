#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
apk_path="${AUQW_ANDROID_APK_PATH:-}"
package_name="${AUQW_ANDROID_PACKAGE:-com.Vehicoule.auqw}"
activity_name="${AUQW_ANDROID_ACTIVITY:-com.Vehicoule.auqw.AuqwActivity}"
serial="${AUQW_ANDROID_SERIAL:-}"
source_only="${AUQW_ANDROID_SMOKE_SOURCE_ONLY:-OFF}"
require_active_session="${AUQW_ANDROID_REQUIRE_ACTIVE_MEDIA_SESSION:-OFF}"

is_on() {
  case "${1:-}" in
    1|ON|on|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ -z "$apk_path" ]]; then
  "$root/ci/android-build.sh"
  apk_path="$root/build/android-linux/apk/auqw-android-arm64-debug.apk"
fi

if [[ ! -f "$apk_path" ]]; then
  echo "missing Android APK: $apk_path" >&2
  exit 1
fi

if is_on "$source_only"; then
  echo "Android source-only smoke complete; runtime pass not claimed without attached target."
  echo "Android APK: $apk_path"
  exit 0
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "missing Android dependency: adb; attach Android target and install platform tools" >&2
  exit 127
fi

if [[ -z "$serial" ]]; then
  serial="$(adb devices | awk '$2 == "device" { print $1; exit }')"
fi

if [[ -z "$serial" ]]; then
  adb devices >&2 || true
  echo "attach Android target: no emulator/device is in adb device state" >&2
  exit 2
fi

adb_args=(-s "$serial")
adb "${adb_args[@]}" install -r "$apk_path"
adb "${adb_args[@]}" shell am force-stop "$package_name" >/dev/null 2>&1 || true
adb "${adb_args[@]}" shell am start -W -n "$package_name/$activity_name"

package_dump="$(adb "${adb_args[@]}" shell dumpsys package "$package_name" 2>/dev/null || true)"
if [[ "$package_dump" != *"AuqwPlaybackService"* ]]; then
  echo "Android runtime smoke failed: AuqwPlaybackService missing from installed package dump" >&2
  exit 1
fi

session_dump="$(adb "${adb_args[@]}" shell dumpsys media_session 2>/dev/null || true)"
if is_on "$require_active_session" && [[ "$session_dump" != *"$package_name"* ]]; then
  echo "Android runtime smoke failed: active MediaSession evidence missing for $package_name" >&2
  exit 1
fi

echo "Android runtime smoke passed"
echo "Android target: $serial"
echo "Android APK: $apk_path"
echo "Android package: $package_name"
echo "Android activity launch: ok"
echo "Android service evidence: AuqwPlaybackService"
if [[ "$session_dump" == *"$package_name"* ]]; then
  echo "Android MediaSession evidence: present"
else
  echo "Android MediaSession evidence: not active; set AUQW_ANDROID_REQUIRE_ACTIVE_MEDIA_SESSION=ON after starting playback"
fi
