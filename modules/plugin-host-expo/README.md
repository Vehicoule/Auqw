# auqw-plugin-host-expo

Expo module (Android + iOS, Slice 0) wrapping the UniFFI `PluginHost`
from `crates/mobile-bindings`. Headless: functions + one event, no view.

## Generated code

`android/src/main/java/uniffi/auqw_mobile_bindings/auqw_mobile_bindings.kt`
and `ios/auqw_mobile_bindings.swift` are **generated** by uniffi-bindgen
and checked in — regenerate them after any change to
`crates/mobile-bindings`:

```sh
../../tooling/build-android-bindings.sh   # Kotlin + jniLibs .so
../../tooling/build-ios-bindings.sh       # Swift + .a + xcframework
```

The scripts also rebuild the gitignored native products —
`android/src/main/jniLibs/arm64-v8a/libauqw_mobile_bindings.so` and
`ios/AuqwMobileBindingsFFI.xcframework` — required before
`assembleDebug` / the Xcode build.

## API (src/index.ts)

`createHost`, `loadPlugin`, `startResolve`, `cancel`, `runSpin`,
`addResolveOutcomeListener`. `ResolvedResource.url` is a signed stream
URL — never log it (the native layers log only client/mime/kind).
