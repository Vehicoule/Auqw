# auqw-mobile

Expo daily-driver app: search, matching, playback, queue, likes,
settings, and restart-restore. Android plays through the `auqw-expo`
Media3 stream seam; iOS keeps the provisional `expo-audio` path until
its native seam adapter lands. The pinned provider guests run inside
the Wasmi host through UniFFI. `auqw://seam-*` dev links exercise the
transport gates directly (`seam-dev.ts`).

## Prerequisites

- JDK: none is installed system-wide. Use the Android Studio JBR:

  ```sh
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  ```

  (also in the repo-root `.envrc.example`)
- Android SDK + NDK 30.0.16248370 (`~/Library/Android/sdk`)
- Rust `aarch64-linux-android` target + `cargo-ndk`
- pnpm 12 (`pnpm install` at the repo root)

## Build order

From the repo root, in order — every step is required on a fresh
checkout because the outputs are gitignored:

Optional: PO-token provider — set `EXPO_PUBLIC_POT_PROVIDER_URL` at
bundle time to a bgutil-compatible service (`POST {url}/get_pot`).
From the Android emulator, `http://10.0.2.2:4416` reaches a provider
on the host machine. Unset: the resolve stays on the anonymous
ladder.

```sh
# 1. Rust → .so + generated Kotlin bindings
./tooling/build-android-bindings.sh

# 2. JS deps
pnpm install

# 3. Pinned plugin artifacts → apps/mobile/assets/plugins/
pnpm sync-plugins

# 4. Generate the android/ project (gitignored)
cd apps/mobile
npx expo prebuild --platform android

# 5. APK
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./android/gradlew -p android assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk

# 6. Emulator
~/Library/Android/sdk/emulator/emulator -avd Auqw_API_34_ARM64 &
adb install android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.vehicoule.auqw/.MainActivity
```

iOS, same prerequisites minus JDK/NDK — the Rust `aarch64-apple-ios{,-sim}`
targets take their place:

```sh
# 1. Rust → .a + generated Swift bindings + xcframework
./tooling/build-ios-bindings.sh

# 2-3. Same as Android: pnpm install, pnpm sync-plugins

# 4-5. Project + pods + simulator build
cd apps/mobile
npx expo prebuild --platform ios
pod install --project-directory=ios
xcodebuild -workspace ios/Auqw.xcworkspace -scheme Auqw \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath ios/build build
xcrun simctl install booted \
  ios/build/Build/Products/Debug-iphonesimulator/Auqw.app
xcrun simctl launch booted com.vehicoule.auqw
```

## Background audio

Android uses the `AuqwMediaSessionService` foreground service, its
MediaSession lock-screen controls, and the service-owned queue
projection. The provisional iOS player requests background playback
with `setAudioModeAsync`. The `expo-audio` config plugin supplies the
Android manifest permissions and keeps recording disabled.

## Notes

- No Expo Router (coding rules: named exports only).
- Android playback uses opaque stream handles and the `auqw://stream`
  Media3 data source; the signed URL stays below the Rust seam and is
  never rendered or logged. The sparse store commits body pieces as
  they arrive, persists extents for restart recovery, and the pump
  enforces strict range responses, remint budgets, cancellation, and
  seek-driven fetch-through.
- The provisional iOS adapter still downloads through bounded
  `Range: bytes=` requests to a growing cache file and plays it with
  `expo-audio`; cap recovery and response validation follow the same
  typed-error rules until the iOS seam replaces it.
- `metro.config.js` registers `.wasm` as an asset type; the manifest
  JSONs are `require`d as modules.
