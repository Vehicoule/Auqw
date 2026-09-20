# auqw-expo

Expo module (Android + iOS, Slice 1.5) wrapping the UniFFI `PluginHost`
from `crates/mobile-bindings` plus the app's Android Media3 player —
the streaming-seam transport side of `PlayerPort`. Strict superset of
the retired `plugin-host-expo`: same host functions and events, same
payload shapes. Headless: functions + events, no view.

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
`assembleDebug` / the Xcode build. This module is the app's only
generated UniFFI surface; nothing else vendors a second copy.

## API (src/index.ts)

Host surface: `createHost`, `loadPlugin`, `startResolve`,
`startRequest`, `cancel`, `runSpin`, `addResolveOutcomeListener`,
`addRequestOutcomeListener`. `ResolvedResource.url` is a signed stream
URL — never log it (the native layers log only client/mime/kind).

Player surface (docs/specs/playback.md "PlayerPort transport
contract"): `prepare` → `onPrepareOutcome`, `play`/`pause`/`seekTo`/
`stop`, `cancelPrepare`, `releaseStream`, `phaseMarks`, `devAttachFile`
→ `onPlaybackStatus`/`onPhaseMark`. The Kotlin `AuqwMediaSessionService`
owns ONE warm ExoPlayer + MediaSession (reused across attaches — a
per-attach build would blow the ≤200 ms prepared-path budget); the
`AuqwStreamDataSource` bridges `stream_open`/`stream_read`/`stream_close`
into `ProgressiveMediaSource`. iOS is host-surface only — the
`AVAssetResourceLoaderDelegate` player adapter is post-release.
