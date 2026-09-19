# auqw-plugin-host-expo

Expo module (Android only, Slice 0) wrapping the UniFFI `PluginHost`
from `crates/mobile-bindings`. Headless: functions + one event, no view.

## Generated code

`android/src/main/java/uniffi/auqw_mobile_bindings/auqw_mobile_bindings.kt`
is **generated** by uniffi-bindgen and checked in — regenerate it after
any change to `crates/mobile-bindings`:

```sh
../../tooling/build-android-bindings.sh
```

The script also rebuilds
`android/src/main/jniLibs/arm64-v8a/libauqw_mobile_bindings.so`
(gitignored build product — required before `assembleDebug`).

## API (src/index.ts)

`createHost`, `loadPlugin`, `startResolve`, `cancel`, `runSpin`,
`addResolveOutcomeListener`. `ResolvedResource.url` is a signed stream
URL — never log it (the Kotlin layer logs only client/mime/kind).
