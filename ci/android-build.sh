#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zig_bin="${ZIG:-zig}"
zig_cache="${AUQW_ZIG_CACHE_DIR:-/tmp/auqw-zig-cache}"
zig_global_cache="${AUQW_ZIG_GLOBAL_CACHE_DIR:-/tmp/auqw-zig-global-cache}"
sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
android_platform="${ANDROID_PLATFORM:-android-34}"
android_build_tools="${ANDROID_BUILD_TOOLS:-34.0.0}"
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
