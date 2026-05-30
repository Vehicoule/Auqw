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
target="aarch64-linux-android"
artifact="$root/auqw-core/zig-out/lib/libauqw_core.a"
cmake_fetchcontent_args=()

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

"$qt_cmake" -S "$root" -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug \
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

mapfile -t apks < <(find "$build_dir" -type f -name "*.apk" | sort)
if [[ "${#apks[@]}" -eq 0 ]]; then
  echo "missing Android APK under $build_dir" >&2
  exit 1
fi

mkdir -p "$apk_dir"
cp "${apks[0]}" "$apk_dir/auqw-android-arm64-debug.apk"

echo "Android SDK root: $sdk_root"
echo "Android NDK: $sdk_root/ndk/$android_ndk"
echo "Qt Android kit: $qt_prefix"
echo "Qt host kit: $qt_host_path"
echo "Android Zig target: $target"
echo "Android core artifact: $artifact"
echo "Android APK: $apk_dir/auqw-android-arm64-debug.apk"
