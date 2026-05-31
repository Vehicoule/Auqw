#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zig_bin="${ZIG:-zig}"
zig_cache="${AUQW_ZIG_CACHE_DIR:-/tmp/auqw-zig-cache}"
zig_global_cache="${AUQW_ZIG_GLOBAL_CACHE_DIR:-/tmp/auqw-zig-global-cache}"
sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
android_platform="${ANDROID_PLATFORM:-android-35}"
android_build_tools="${ANDROID_BUILD_TOOLS:-35.0.0}"
android_ndk="${ANDROID_NDK:-28.2.13676358}"
qt_version="${QT_VERSION:-6.7.3}"
qt_android_arch="${QT_ANDROID_ARCH:-android_arm64_v8a}"
qt_android_abi="${QT_ANDROID_ABI:-arm64-v8a}"
qt_root="${QT_ROOT:-/opt/Qt}"
qt_prefix="${QT_ANDROID_PREFIX:-$qt_root/$qt_version/$qt_android_arch}"
qt_host_path="${QT_HOST_PATH:-$qt_root/$qt_version/gcc_64}"
android_openssl_source_dir="${ANDROID_OPENSSL_SOURCE_DIR:-}"
qt_cmake="$qt_prefix/bin/qt-cmake"
build_dir="${AUQW_BUILD_DIR:-$root/build/android-linux}"
apk_dir="$build_dir/apk"
release_mode="${AUQW_ANDROID_RELEASE_BUILD:-auto}"
target="aarch64-linux-android"
artifact="$root/auqw-core/zig-out/lib/libauqw_core.a"
cmake_fetchcontent_args=()
release_build=0

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

is_tag_release() {
  [[ "${GITHUB_REF_TYPE:-}" == "tag" || "${GITHUB_REF:-}" == refs/tags/* ]]
}

case "${release_mode,,}" in
  auto)
    if is_tag_release; then
      release_build=1
    fi
    ;;
  *)
    if is_on "$release_mode"; then
      release_build=1
    elif is_off "$release_mode"; then
      release_build=0
    else
      echo "invalid AUQW_ANDROID_RELEASE_BUILD: $release_mode" >&2
      exit 2
    fi
    ;;
esac

patch_gradle_wrapper_timeout() {
  local wrapper
  while IFS= read -r wrapper; do
    if [[ ! -w "$wrapper" ]]; then
      echo "warning: cannot patch Gradle wrapper timeout: $wrapper" >&2
      continue
    fi
    if grep -q '^networkTimeout=' "$wrapper"; then
      sed -i 's/^networkTimeout=.*/networkTimeout=60000/' "$wrapper"
    fi
  done < <(find "$qt_root/$qt_version" -path '*/gradle/wrapper/gradle-wrapper.properties' -type f 2>/dev/null)
}

set_gradle_property() {
  local file="$1"
  local key="$2"
  local value="$3"
  local temp_file

  if grep -q "^${key}=" "$file"; then
    temp_file="$(mktemp)"
    awk -v key="$key" -v value="$value" '
      BEGIN { prefix = key "=" }
      index($0, prefix) == 1 { $0 = prefix value }
      { print }
    ' "$file" > "$temp_file"
    cat "$temp_file" > "$file"
    rm -f "$temp_file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

patch_android_gradle_api35_compatibility() {
  if [[ "$android_platform" != "android-35" ]]; then
    return
  fi

  local gradle_properties="$qt_prefix/src/3rdparty/gradle/gradle.properties"
  local aapt2="$sdk_root/build-tools/$android_build_tools/aapt2"

  if [[ ! -w "$gradle_properties" ]]; then
    echo "missing writable Android Gradle template: $gradle_properties" >&2
    exit 1
  fi

  set_gradle_property "$gradle_properties" "android.aapt2FromMavenOverride" "$aapt2"
  set_gradle_property "$gradle_properties" "android.suppressUnsupportedCompileSdk" "35"
}

patch_android_deployment_qml_settings() {
  local settings="$build_dir/auqw-qt/android-Auqw-deployment-settings.json"
  local module_build_dir="$build_dir/auqw-qt"

  if [[ ! -f "$settings" ]]; then
    echo "missing Android deployment settings: $settings" >&2
    exit 1
  fi

  python3 - "$settings" "$module_build_dir" <<'PY'
import json
import sys
from pathlib import Path

settings_path = Path(sys.argv[1])
module_build_dir = Path(sys.argv[2]).resolve()
data = json.loads(settings_path.read_text(encoding="utf-8"))

qml_import_paths = data.get("qml-import-paths", "")
if qml_import_paths:
    kept_paths = []
    for path_text in qml_import_paths.split(","):
        if not path_text:
            continue
        candidate = Path(path_text).resolve()
        try:
            candidate.relative_to(module_build_dir)
        except ValueError:
            continue
        kept_paths.append(candidate.as_posix())
    data["qml-import-paths"] = ",".join(kept_paths)

data.pop("qml-root-path", None)
settings_path.write_text(json.dumps(data, indent=3) + "\n", encoding="utf-8")
PY
}

configure_gradle_java() {
  local selected_java_home="${AUQW_JAVA_HOME:-${JAVA_HOME:-}}"
  local java_version
  local java_major

  if [[ -z "$selected_java_home" && -d /usr/lib/jvm/java-17-openjdk-amd64 ]]; then
    selected_java_home=/usr/lib/jvm/java-17-openjdk-amd64
  fi

  if [[ -n "$selected_java_home" ]]; then
    if [[ ! -x "$selected_java_home/bin/java" ]]; then
      echo "invalid Java home for Android build: $selected_java_home" >&2
      exit 1
    fi
    export JAVA_HOME="$selected_java_home"
    export PATH="$JAVA_HOME/bin:$PATH"
  fi

  if ! command -v java >/dev/null 2>&1; then
    echo "missing Java runtime for Android Gradle build" >&2
    exit 1
  fi

  java_version="$(java -version 2>&1 | awk -F '"' '/version/ { print $2; exit }')"
  java_major="${java_version%%.*}"
  if [[ "$java_major" == "1" ]]; then
    java_major="${java_version#1.}"
    java_major="${java_major%%.*}"
  fi

  if [[ ! "$java_major" =~ ^[0-9]+$ || "$java_major" -lt 17 || "$java_major" -gt 20 ]]; then
    echo "Qt Android Gradle wrapper requires Java 17-20; found ${java_version:-unknown}." >&2
    echo "Set AUQW_JAVA_HOME or JAVA_HOME to a compatible JDK to avoid Gradle 'Unsupported class file major version' failures." >&2
    exit 1
  fi
}

require_android_release_signing() {
  local -a missing=()
  local name

  for name in \
    AUQW_ANDROID_KEYSTORE_BASE64 \
    AUQW_ANDROID_KEYSTORE_PASSWORD \
    AUQW_ANDROID_KEY_ALIAS \
    AUQW_ANDROID_KEY_PASSWORD; do
    if [[ -z "${!name:-}" ]]; then
      missing+=("$name")
    fi
  done

  if [[ "${#missing[@]}" -ne 0 ]]; then
    echo "missing Android release signing secrets: ${missing[*]}" >&2
    exit 1
  fi
}

sign_release_apk() {
  local unsigned_apk="$1"
  local signed_apk="$apk_dir/auqw-android-arm64.apk"
  local aligned_apk="$apk_dir/auqw-android-arm64-aligned.apk"
  local keystore="$build_dir/auqw-android-release.keystore"
  local apksigner="$sdk_root/build-tools/$android_build_tools/apksigner"
  local zipalign="$sdk_root/build-tools/$android_build_tools/zipalign"

  cleanup_signing_artifacts() {
    rm -f "$aligned_apk" "$keystore"
  }
  trap cleanup_signing_artifacts RETURN

  for required in "$apksigner" "$zipalign"; do
    if [[ ! -x "$required" ]]; then
      echo "missing Android release signing dependency: $required" >&2
      exit 1
    fi
  done

  printf '%s' "$AUQW_ANDROID_KEYSTORE_BASE64" | base64 --decode > "$keystore"
  "$zipalign" -f -p 4 "$unsigned_apk" "$aligned_apk"
  "$apksigner" sign \
    --ks "$keystore" \
    --ks-pass "pass:$AUQW_ANDROID_KEYSTORE_PASSWORD" \
    --ks-key-alias "$AUQW_ANDROID_KEY_ALIAS" \
    --key-pass "pass:$AUQW_ANDROID_KEY_PASSWORD" \
    --out "$signed_apk" \
    "$aligned_apk"
  "$apksigner" verify --verbose "$signed_apk"
  cleanup_signing_artifacts
  trap - RETURN
}

if [[ "$release_build" -eq 1 ]]; then
  require_android_release_signing
fi

configure_gradle_java

if [[ -z "$sdk_root" ]]; then
  echo "ANDROID_SDK_ROOT or ANDROID_HOME is required" >&2
  exit 1
fi

for required in \
  "$sdk_root/platforms/$android_platform/android.jar" \
  "$sdk_root/build-tools/$android_build_tools/aapt2" \
  "$sdk_root/ndk/$android_ndk/ndk-build" \
  "$qt_cmake" \
  "$qt_prefix/lib/cmake/Qt6/Qt6Config.cmake" \
  "$qt_prefix/lib/cmake/Qt6Multimedia/Qt6MultimediaConfig.cmake" \
  "$qt_host_path/lib/cmake/Qt6/Qt6Config.cmake"; do
  if [[ ! -e "$required" ]]; then
    echo "missing Android dependency: $required" >&2
    exit 1
  fi
done

(
  cd "$root/auqw-core"
  "$zig_bin" build \
    --cache-dir "$zig_cache" \
    --global-cache-dir "$zig_global_cache" \
    -Dtarget="$target" \
    -Dandroid_ndk_root="$sdk_root/ndk/$android_ndk"
)

if [[ ! -f "$artifact" ]]; then
  echo "missing Android core artifact: $artifact" >&2
  exit 1
fi

if [[ -n "$android_openssl_source_dir" ]]; then
  android_openssl_cmake="$android_openssl_source_dir/android_openssl.cmake"
  if [[ ! -f "$android_openssl_cmake" ]]; then
    echo "missing Android OpenSSL source: $android_openssl_cmake" >&2
    exit 1
  fi
  cmake_fetchcontent_args+=("-DFETCHCONTENT_SOURCE_DIR_ANDROID_OPENSSL=$android_openssl_source_dir")
fi

patch_gradle_wrapper_timeout
patch_android_gradle_api35_compatibility

cmake -E rm -rf "$build_dir"
build_type="Debug"
if [[ "$release_build" -eq 1 ]]; then
  build_type="Release"
fi

"$qt_cmake" -S "$root" -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE="$build_type" \
  -DAUQW_BUILD_QT=ON \
  -DAUQW_CORE_LIB="$artifact" \
  -DANDROID_SDK_ROOT="$sdk_root" \
  -DANDROID_NDK_ROOT="$sdk_root/ndk/$android_ndk" \
  -DANDROID_ABI="$qt_android_abi" \
  -DANDROID_PLATFORM="$android_platform" \
  -DQT_HOST_PATH="$qt_host_path" \
  -DQt6_DIR="$qt_prefix/lib/cmake/Qt6" \
  "${cmake_fetchcontent_args[@]}"

patch_android_deployment_qml_settings

cmake --build "$build_dir" --target Auqw_make_apk

if [[ "$release_build" -eq 1 ]]; then
  mapfile -t apks < <(find "$build_dir" -type f \( -name "*release*.apk" -o -name "*unsigned*.apk" \) | sort)
  if [[ "${#apks[@]}" -eq 0 ]]; then
    mapfile -t apks < <(find "$build_dir" -type f -name "*.apk" | sort)
  fi
else
  mapfile -t apks < <(find "$build_dir" -type f -name "*debug*.apk" | sort)
  if [[ "${#apks[@]}" -eq 0 ]]; then
    mapfile -t apks < <(find "$build_dir" -type f -name "*.apk" | sort)
  fi
fi
if [[ "${#apks[@]}" -eq 0 ]]; then
  echo "missing Android APK under $build_dir" >&2
  exit 1
fi

mkdir -p "$apk_dir"
if [[ "$release_build" -eq 1 ]]; then
  sign_release_apk "${apks[0]}"
  output_apk="$apk_dir/auqw-android-arm64.apk"
else
  output_apk="$apk_dir/auqw-android-arm64-debug.apk"
  cp "${apks[0]}" "$output_apk"
fi

echo "Android SDK root: $sdk_root"
echo "Android NDK: $sdk_root/ndk/$android_ndk"
echo "Qt Android kit: $qt_prefix"
echo "Qt host kit: $qt_host_path"
echo "Android Zig target: $target"
echo "Android core artifact: $artifact"
echo "Android APK: $output_apk"
