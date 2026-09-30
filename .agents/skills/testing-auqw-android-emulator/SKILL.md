---
name: testing-auqw-android-emulator
description: How to build, install, and exercise the Auqw Expo Android app on the "auqw" emulator (AVD API 36 x86_64) — build prerequisites, Metro wiring, adb driving, media-session ground truth, and per-feature gate techniques learned from device gates.
---

# Auqw Android emulator testing

## Environment prerequisites

The box has the Android SDK at `$HOME/Android/Sdk` but two env vars are
NOT exported by default — every Gradle build needs them:

```bash
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME=$HOME/Android/Sdk
export ANDROID_NDK_HOME=$HOME/Android/Sdk/ndk/30.0.16248370
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH
export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
```

## Emulator

AVD `auqw` (API 36 x86_64). Boot if needed:

```bash
emulator -avd auqw -no-snapshot-load &   # verify: adb wait-for-device
```

## Build + install

`apps/mobile/android/` is GITIGNORED (Expo CNG since wave 3) — a fresh
worktree must generate it first. The uniffi/native module lives at repo
root `modules/auqw-expo/` (NOT under `apps/mobile`) and is wired into
the generated project; its `android/src/main/jniLibs/` + `java/uniffi/`
build outputs can be COPIED from a sibling worktree's built module when
a PR only touches TypeScript (saves a cold native rebuild). For PRs that
TOUCH `modules/auqw-expo` Kotlin, copy ONLY `jniLibs/` + `java/uniffi/` —
staging a sibling's whole `java/` tree clobbers the PR's own Kotlin.

```bash
cd <worktree>
pnpm install --frozen-lockfile        # once per worktree
pnpm sync-plugins                     # REQUIRED on a fresh worktree — see below
(cd apps/mobile && pnpm exec expo prebuild --platform android --no-install)
cd apps/mobile/android && ./gradlew assembleDebug   # ~5-10 min cold
adb install -r app/build/outputs/apk/debug/app-x86_64-debug.apk
```

`apps/mobile/assets/plugins/*.wasm` and `apps/desktop/plugins/` are
gitignored build outputs — a brand-new worktree lacks them and the
Gradle bundle fails with missing-asset errors (desktop shell starts but
providers never load). `pnpm sync-plugins` rebuilds them, BUT it fails
when `~/wt/auqw-plugins/releases/<plugin>/<pinned-version>` is absent —
then stage the asset set by copying `apps/mobile/assets/plugins/` (and
`apps/desktop/plugins/` for desktop) from `~/repos/Auqw` instead.
Fresh worktrees may also lack `node_modules/<rn-module>/android/build/
generated/` codegen dirs — the set includes `react-native-bottom-tabs`
(post-mmkv); if Gradle fails on missing generated code, re-run
`pnpm install` or copy those dirs from a sibling worktree.

CI does NOT build Android — Kotlin compile errors reach only this gate.

## Metro

```bash
cd <worktree>/apps/mobile && pnpm expo start --port 8081 &
adb reverse tcp:8081 tcp:8081
```

Restart Metro against the right worktree when switching PRs — the bundle
serves the worktree you started it in, not the installed APK's origin.

## Driving the app

- `adb shell input tap x y`, `input swipe`, `input keyevent` — get
  coordinates from `adb exec-out uiautomator dump /dev/stdout` +
  `exec-out screencap -p > shot.png` as ground truth.
- `adb shell input draganddrop x1 y1 x2 y2 <ms>` — lifts RN reorder
  handles (works on `DraggableFlatList` handles; a plain swipe does not).
- Media keys: `adb shell input keyevent KEYCODE_MEDIA_NEXT` /
  `KEYCODE_MEDIA_PREVIOUS` route through the native session.
- Long-press asymmetry: swipe-holds open action sheets on
  **metadata-kind** rows (search/explore results) but NOT on
  **recording-kind** rows (downloads, history, queue pane, locals) —
  the gesture is swallowed there. Per-row action sheets on recording
  rows need espresso/appium `longPress`; don't burn time on `input`.
- Deep links (`auqw://...`) exist for journeys — e.g.
  `auqw://download?i=N`, `auqw://downloads`, `auqw://corrections`,
  `auqw://transfer` — check the app's link config for the current
  list; `adb shell am start -a android.intent.action.VIEW -d <url>`.
- The stage sheet's backdrop keeps `close sheet` in the a11y tree even
  when the sheet is COLLAPSED — don't trust its presence as open-state;
  verify with pixels (screenshot) instead.

## Ground truth

- `adb shell dumpsys media_session` — authoritative for what the player
  believes is current (buffered position jumps reveal skips).
- `adb logcat` — `[journey]` lines report live counters
  (`downloads=N rows`, etc.) for cross-checking UI vs ledger.
- uiautomator pane trees can go STALE when a pane isn't foregrounded —
  trust screenshots (pixels) over dumps for the queue/stage panes. A
  PLAYING waveform (reanimated frame loop) can starve uiautomator dumps
  entirely — use `screencap` while audio plays.
- `ss -tni 'sport = :<peerport>'` on the host shows per-socket byte
  counters — a handshake alone proves nothing; real sync rounds move
  bytes both directions.

## Provider caveat

From this box's datacenter IP the youtube-music provider resolves fail
fast at `bot-check` (~200 ms) — so every playback attempt lands on the
honest 'failed' path. That makes failed/retry/remove cheap to verify but
`prepared` playback, `stored` download states, and mid-transfer cancel
unreachable from here. Mark those 'untested — environmental', not failed.

## SAF / folder import

Add local folder: SAF picker → grant Music dir → ALLOW. The picker runs
in the OS UI, not the app — drive it with plain taps after `uiautomator`
dump of the picker window.

## Useful checks per feature

- Queue pane: section order NOW PLAYING → UP NEXT → HISTORY; reorder
  confines to UP NEXT; out-of-bounds drops snap back; failed rows keep
  ⚠ and are skipped forward but reachable backward via
  `KEYCODE_MEDIA_PREVIOUS`.
- `start radio` pill renders only on REMOTE-provider tracks — `lf-*`
  local rows never show it; absence on a local track is conditional UI,
  not a defect.
- After a real pairing, desktop-originated items (likes, queue rows,
  playlists) materialize live in home/queue/search — a mid-run
  appearance is positive sync-ingress evidence, not flakiness.
- Downloads: cross-check FOUR sources — collection header 'N tracks',
  row count, settings `remove all downloads` badge `· N`, and the
  `[journey] downloads=N` logcat line — they must agree.
- Transient states (queued/downloading/removing) resolve sub-second —
  usually uncapturable; verify code + settled states instead.

## Sync pairing device gate (cross-version wire compat)

For PRs touching the sync stack (noise/custody/engine/wire): pair the
emulator app against a REAL desktop sync service and prove a round trip
of data — handshake alone proves nothing about delta materialization.

The runner template is `apps/desktop/src/utility/gate178-host.ts`
(uncommitted — copy/adapt it for the PR being gated). It stands up
`createSyncService` bound to 0.0.0.0 on port 0 over an in-memory engine
seeded with real playlist entries, mints a fresh 6-digit pair code every
45 s, and polls custody — all reachable from the emulator at `10.0.2.2`
(the host-loopback alias; no adb reverse needed for LAN sync). Run it
with `node --experimental-strip-types` from `apps/desktop`.

Phone side: sync overlay → type-code pairing → host `10.0.2.2`, port
from the runner log. Gate proof has three legs, cheapest first:

1. `[gate178] custody devices=1` + phone lists the paired device —
   handshake + custody write.
2. The runner's seeded playlists appear in the phone's library — real
   delta materialization on the wire.
3. Cross-version: `adb install -r` the OLD build's APK over its own data
   (keeps stored records), pair, then install the NEW build over it —
   the new code must loose-read the legacy custody row AND complete a
   fresh handshake on the new wire path. Byte-level compat proof without
   needing two devices.

## SQLite writer/reader caveat for service tests

`PRAGMA data_version` only reports commits from OTHER connections on the
same database file. Production splits a read-only indexDb accessor from
the storage service's writer connection, so a service test that writes
on its ONLY `DatabaseSync` handle never bumps the stamp — cached-verdict
invalidation tests pass vacuously. Open two handles: one reader, one
writer that runs MIGRATIONS + every INSERT/UPDATE/DELETE.

## Sheets, toasts, and failure surfaces

- **Sheet action buttons render LOW on the device** — a bottom sheet's
  `save`/`cancel`/`close` nodes land around device y1197-1527 (the
  store-front sheet's buttons were at ~y1325, its close ✕ at ~y1225),
  NOT at the scaled-screenshot position you might estimate. Tapping
  the scrim ABOVE a sheet dismisses it silently — always dump the
  sheet's nodes for exact bounds before tapping a button.
- **The toast pill renders at `bottom: insets.bottom + 88`** in the root
  StackItem — it sits BEHIND any pushed overlay (sheets, the stage), so
  a toast fired while a sheet is open is invisible (e.g. the
  `toast.storefrontCode` pill on a failed storefront save). Don't waste
  screenshots hunting it there.
- **Provider play failures do NOT reach the toast.** A bot-check prepare
  marks the queue occurrence 'couldn't play' and surfaces the humanized
  'still loading — try again' line on the player — no `reportResult`,
  no `[ui]` log, no pill. The queue pane is the failure surface.
- **For a VISIBLE toast** fire an op-level failure that goes through
  `reportResult` on a non-occluded surface: `start radio` on the stage
  player hits `stage.radio.start` → `budget-exceeded` once the fuel
  budget is spent → the humanized pill ('start radio failed — over a
  limit — slim it down or try later') renders over the stage and is
  capturable. The `[ui] <action> failed: <kind>` logcat line is the
  tell that reportResult ran even when the pill is occluded.
- **The ⚠ download chip on a collection row is decorative**
  (`accessible={false}` — a status glyph, not a button). A
  `failed_with_retry` row's retry is re-armed by a SECOND
  `auqw://download?i=N` deep link on the same recording (same
  downloadId back to `requested`, fresh transfer attempt fires).
- **Enqueue dedupe**: tapping an already-queued result row REUSES its
  occurrence (cursor jumps, no new row). Decisive check: play a fresh
  provider track twice — exactly one occurrence exists afterward.

## Home-card routing (post-#179)

- Two rails: `recently liked` (recording keys) and `search results`
  (suggestion `${provider}:${id}` keys). `ports.strictHomeCardKeys`
  makes mobile resolve recents-rail keys recording-first; a suggestion
  card press re-records the search query via `recordRecentSearch` (it
  dedupes, so recents stay clean) and must NOT enqueue a provider key
  as a recording-id.
- Verify by tapping cards with SAME-ISH titles (e.g. a liked 'Ulveham'
  card vs a 'Ulveham (Full Version)' suggestion card) and checking the
  mini player's current title — each lands on its own target.
- `searchRecents` is `useState` — it resets on any app relaunch (deep
  links re-launch MainActivity), so an earlier committed query vanishing
  from recents is a state reset, not a regression.

## OAuth auth surface (post-#202)

- Drive the **typed-failure** path deterministically (no Google account
  needed): Settings → ACCOUNT → `oauth client id` → save a bogus value
  → open sign-in → the device-flow request fails typed ('got an
  unexpected reply — try again', row flips to `failed — tap to retry`).
  `reset to the built-in client` restores the success path (real code
  issued, 'waiting for you to approve…' polls).
- `authSignOut` rows (settings + sheet) render ONLY while
  `media.auth.state === 'signed-in'` — don't hunt for them while
  signed out; they need a real account to exercise.
- The sheet's `copy code` flips to `✓ copied` and the code lands on
  the Android clipboard (a clipboard pill shows it verbatim).

## Remote provider traffic (post-#183)

Bot-check on this box's egress is INTERMITTENT (~1/3 of resolves) —
remote playback and remote downloads DO succeed now; retry failed
attempts before marking a gate step failed. `auqw://download?i=N`
indexes into `st.recordings` (library order — local 'gate-tone' rows
return 'no playable ref', use a remote index). Downloads complete via
`AuqwDownloadService` FGS → `stored ✓` rows. `react_native_expect …
vector<RawValue>` E-lines are dev-mode exception-report marshal noise
following warning dumps, not a defect (verify the involved type is
unchanged before flagging).

## Release-build verification (post-#208)

- **Verify shipped fixes on the installed binary, not the worktree** —
  `adb shell pm path <pkg>` → `adb pull` the `base.apk` →
  `aapt2 dump xmltree <apk> --file AndroidManifest.xml` for merged
  manifest attrs + scan `res/*.xml` for embedded configs (e.g.
  `network_security_config.xml`). Release manifests and merged
  resources can differ from what the source tree implies.
- **Build a release APK for a gate**: `cd apps/mobile/android &&
  ./gradlew :app:assembleRelease -x lint` →
  `app/build/outputs/apk/release/app-x86_64-release.apk` (debug-signed).
  Release installs need `adb uninstall` first — signature mismatch vs
  debug builds (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) and versionCode
  1001 downgrades vs shipped stamps (`INSTALL_FAILED_VERSION_DOWNGRADE`).
- **Two distinct 'transient' families — don't conflate.** A
  loopback/cleartext pump failure surfaces the toast
  'something interrupted — try again' AFTER a successful resolve; a
  bot-check wall surfaces 'the provider is refusing requests — try
  again later' at the resolve stage (logcat
  `kind=transient message=…transient: bot-check`). Seeing ONLY
  bot-check verdicts across many plays is positive evidence the
  pump path is healthy.
- When the youtube wall blocks stream resolves, **search/catalog
  requests may still succeed** — that split distinguishes 'IP wall'
  from 'app down'.
- The #202 `sign in to fix playback` CTA renders organically under
  bot-check error lines — an easy live check whenever walls are active.
- The sync-pairing runner template `gate178-host.ts` was removed from
  the checkout — recreate it from the recipe in the sync section above
  (createSyncService on 0.0.0.0:0, in-memory engine, 45 s pair codes,
  reachable at 10.0.2.2).

## Auth / device-flow gates (post-#209)

- **Metro is `pnpm start` (expo start) from `apps/mobile/`** — `pnpm exec react-native start` fails (no @react-native-community/cli dep).
- **Poll-lifecycle proof without log lines**: the OAuth token poll emits no logs. Verify via the settings row: it stays 'working...' ('authorizing') after sheet dismissal, and the reopened sheet shows the SAME userCode (a fresh begin always mints a new code — same code = resume proof).
- **Process-death resume**: `adb shell am force-stop com.vehicoule.auqw` mid-authorizing → cold relaunch → row still 'working...' → sheet shows same code (pendingFlow survived in expo-secure-store).
- **Cold-boot recovery**: if the emulator is down — `DISPLAY=:0 emulator -avd auqw -no-snapshot-save -gpu swiftshader_indirect` + `adb wait-for-device` + wait for `sys.boot_completed`.
- **Debug ↔ release installs**: both variants share the debug signing key — `adb install -r` between them preserves app data.
