# auqw-mobile

Expo app (Slice 0): one screen, one Play button. The pinned
`youtube-music` guest resolves inside the Wasmi host → UniFFI →
`auqw-plugin-host-expo` → `expo-audio`.

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

`setAudioModeAsync({ shouldPlayInBackground: true,
interruptionMode: 'doNotMix' })` plus
`player.setActiveForLockScreen(true, metadata)` — on Android the
lock-screen activation is what keeps playback alive past ~3 min in
the background (per Expo SDK 57 docs). The `expo-audio` config plugin
in `app.config.ts` enables background playback (FOREGROUND_SERVICE +
AudioControlsService); recording permissions are disabled.

## Notes

- No Expo Router (coding rules: named exports only).
- The signed stream URL is passed to `expo-audio` but never rendered
  or logged.
- The resolved URL is downloaded to the cache in 1 MiB
  `Range: bytes=` chunks; playback starts once the first 256 KiB are
  on disk (the player keeps reading the growing file). A 403
  mid-download — the stochastic GVS per-mint cap — re-resolves for a
  fresh mint and resumes at the written offset; a mint that serves no
  new bytes counts as zero progress, and after 2 in a row (or 8 mints
  total) the cap fails honestly as `expired-resource`. A re-mint that
  returns a different encoding restarts the file. Every chunk is a
  strict `206` (anything else is a serving violation) with a 60 s
  stall timeout, and Cancel aborts the loop.
- `metro.config.js` registers `.wasm` as an asset type; the manifest
  JSONs are `require`d as modules.
