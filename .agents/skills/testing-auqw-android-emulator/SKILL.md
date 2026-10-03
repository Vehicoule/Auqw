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
(cd apps/mobile && pnpm exec expo prebuild --platform android --no-install)
cd apps/mobile/android && ./gradlew assembleDebug   # ~5-10 min cold
adb install -r app/build/outputs/apk/debug/app-x86_64-debug.apk
```

Plugins ship OTA — nothing is bundled into the APK or assets. On first
open the app syncs the signed `releases/feed.json` from Auqw-plugins
main into `<documents>/plugins` (ed25519 verify against the embedded
release key), so a first boot needs the emulator to reach
raw.githubusercontent.com; an unreachable feed with an empty cache =
zero providers. `EXPO_PUBLIC_PLUGIN_FEED` overrides the feed URL for a
fixture feed.
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
- **The toast pill mounts a copy inside EVERY screen layer** (post-#277)
  — root/pushed copies float at `bottom: insets.bottom + 88`; in-sheet
  copies render in-flow BELOW the sheet's rows (the fit-to-contents
  sheet grows to fit, canvas bg on the raised layer). A toast fired
  while a sheet is open IS visible there — e.g. `toast.storefrontCode`
  under the storefront sheet's rows.
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
- `searchRecents` hydrates from the `search_history` sqlite table
  (schema v12, `SearchHistoryStore` port) — recents SURVIVE a relaunch
  (deep links re-launch MainActivity). A missing committed query after
  relaunch is a real regression, not a state reset.

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

## Native bindings .so missing → build it (post-#215)

'couldn't start' with `UnsatisfiedLinkError: libauqw_mobile_bindings.so`
means `modules/auqw-expo/android/src/main/jniLibs/` was never populated
and no sibling worktree exists to copy from. Build instead:

```bash
rustup target add x86_64-linux-android          # once per box
AUQW_ANDROID_ABIS=x86_64 \
ANDROID_NDK_HOME=$HOME/Android/Sdk/ndk/30.0.16248370 \
  bash tooling/build-android-bindings.sh        # ~2-4 min cold
cd apps/mobile/android && ./gradlew assembleDebug  # incremental ~10 s
adb install -r app/build/outputs/apk/debug/app-x86_64-debug.apk
```


## Local recordings + stage-sheet tricks (post-#215)

- `auqw://local-add` imports surface in **search**, not library rows —
  library `items` renders likes only (`toLibraryModel`). Imported rows
  appear in search results as `local:<id>` keys with a `local ·` prefix
  note and play fully offline.
- `auqw://open?tab=queue` expands the stage sheet directly into QUEUE
  mode — skips the flaky mini-player tap/morph; then tap the `player`
  segment to reach transport + the `add to playlist` icon (top-right of
  metadata). Fire `auqw://pause` right after starting short probe
  tracks so the mini player stays alive during multi-step flows.
- `add to playlist` → 'new playlist' dashed row → `input text <name>` +
  `keyevent 66` submits.
- `wmctrl -b add,maximized_*` is ignored by the emulator window —
  resize explicitly: `wmctrl -i -r <winid> -e 0,10,30,430,710`.

## Persistence ground truth (post-#215)

Settings → DIAGNOSTICS → `persistence` row reads ok/degraded/failed
straight from `state.persistenceError` — the on-screen verdict for
silent write failures (dead-driver class). `attempt trace` shows
`lf-req-N` local resolves. Cross-check with collection tiles
(liked/downloads/top 50/history counts, tap for rows) and
`[journey] local-add …` / `rescan <id>: +added` logcat lines.

## Downloads ledger + instrumented-mint gate notes (post-#219)

### SQLite ledger on-device (run-as quoting)
- The app's sqlite is `files/SQLite/auqw.db` (expo-sqlite — NOT `databases/`).
- `adb shell` strips inner quotes → SQL with spaces fragments into
  "incomplete input". Nest single quotes inside one double-quoted
  command: `adb shell "run-as com.vehicoule.auqw sqlite3 files/SQLite/auqw.db 'SELECT ...'"`.
- `downloads` ledger columns worth polling: `state, committed_offset,
  bytes, file_path, error_json, checksum, downloaded_ms`.
  `error_json` carries the failure kind verbatim — distinguish
  `invalid-response` (decode bug) from `transient: bot-check` (env wall).
- Owned-bytes dir is `files/downloads/` — `<name>.part` stages bytes,
  atomic rename on finalize; `.part` size ≥ `committed_offset`
  (last chunk may be written-not-committed).

### Remote indices for download — st.recordings, not search results
`auqw://download?i=N` indexes `st.recordings` (the materialized
library). `auqw://search` only publishes the page + advisory prewarm
— it writes NO library rows, so on an empty library every index is
"out of range". Materialize first: `auqw://play-result?i=N` calls
addAndPlay → upserts exactly that item — but ONLY when the result
isn't already queued; a repeat of the same index now replaces the
queue (dedupe is gone — `playRecordings`/`playMetadata` clear then
enqueue) and still adds no row. Fire DISTINCT indices for N rows. In the API-36 gate one fresh play grew
the table to ~50 rows — playback-driven ingest (queue-context/radio)
materializes more; don't rely on the count, verify:
`adb shell "run-as com.vehicoule.auqw sqlite3 files/SQLite/auqw.db
'SELECT count(*) FROM recordings'"`.

### Instrumented-mint pattern when the provider wall is ~100%
When real resolves are environmentally blocked (bot-check rate too
high to ever land a mint), exercise the full on-device path with a
TEMPORARY stub — revert before finishing, label evidence provisional:
- Stub `request()` in `apps/mobile/src/adapters/plugin-provider.ts`:
  `if (capability === 'playback.resolve')` return
  `decodeProviderOutcome({type:'succeeded', resultJson}, kindOf, decode)`
  — the REAL wire decoder still runs (toMintHeaders →
  PlayableResource.headers); everything downstream is real.
- Use a real public https Range endpoint for `url` — verify 206 first
  (`curl -H 'Range: bytes=0-1048575'`). `speed.cloudflare.com/__down`
  does NOT honor Range; `www.soundhelix.com/examples/mp3/*.mp3` does
  (~9MB real mp3 — stored file can even play as owned bytes).
- ALWAYS include `content_length` in the fixture: omitting it makes
  the re-mint's `contentLength=null` mismatch the persisted
  `expectedEncoding` (=`live.bytes` wire total) → honest restart at 0
  that masquerades as broken resume. With matching length, resume
  continues AT `committed_offset`.
- To prove mint headers ride the wire, log header NAMES only —
  `console.log(Object.keys(init.headers ?? {}))` at the download
  `fetchImpl` wiring (`apps/mobile/src/session/controller.ts`) —
  shows `[...mintKeys, 'range']` per chunk in logcat. Never log raw
  values: mint headers can carry signed request data and logcat
  persists them (same rule as redacted tokens/URLs). Revert both
  edits.

### Reactive force-stop for mid-flight catches
Timed `am force-stop` is racy — chunk commits land in bursts
(~1-3 s apart on this egress). Poll the ledger (~1 s cadence) and
force-stop the MOMENT `committed_offset` > 0. At-offset resume
signature post-relaunch: the next fetch's Range starts at
`committed_offset`, not `bytes=0`; the row returns `requested` →
`transferring` → `available` via the init() sweep + pump.

### Misc device gotchas
- The React Native DevTools window pops open on stray taps near the
  debug warning bar / 'player' segment area — `wmctrl` close it
  immediately or it steals the recording frame.

## Stage-sheet drag mechanics + transient ended pill (post-#236)

Techniques worked out for the stage-pane-morph gate; generalize to any
gate that needs to collapse/expand the stage sheet or reach ended-queue
states deterministically.

- Sheet drag surfaces are per-region, not whole-surface: the parked
  mini-player pill has its own `swipe` pan (`mini-player.tsx`); on the
  OPEN sheet the draggable chrome is the top grab handle, the player
  pane body (`playerPanePan` — disabled by `playerCanScroll` when the
  player content overflows its viewport, so a body swipe then scrolls
  instead; use the grab handle), and the queue/lyrics chrome regions
  (`queueChromePan`/`lyricsChromePan` in `stage-sheet.tsx`) — gaps
  between them start no recognizer. `input swipe` DOES drive
  `onUpdate` on those regions — but Pressables inside (transport
  buttons, queue rows) may swallow the touch if the drag starts dead on
  a button. Start drags on the pill body (~x400), the grab handle
  (~36px centered at the sheet top), or a pane's chrome area.
- `input tap` DOES trigger MiniPlayer Pressables — the pill's play/pause
  button and the pill body `onPress` (a SYNCHRONOUS expand commit:
  anchor→1 + spring→1). Useful when a drag is impractical.
- `resolveSheetTarget` thresholds (`stage-motion.ts`,
  SHEET_FLING_VELOCITY=250): release velocity ≤ −250 px/s → 'expanded'
  regardless of distance; ≥ +250 px/s below the collapsed anchor →
  'dismissed' (DELETES the pill); raw ≥ travel/2 → 'expanded';
  raw < −collapsed/2 → 'dismissed'; else 'collapsed'.
  Consequences for `input swipe` collapse pulls:
  - MODERATE pulls that end mid-travel resolve 'collapsed' (pill parks).
  - A pull ending below the anchor at ≥ 250 px/s fling speed DISMISSES
    the sheet entirely — the pill vanishes. Stay under fling
    (< ~240 px/s → duration ≥ distance/0.24) or end the pull above the
    −collapsed/2 cutoff.
  - HOLD-AT-PARK simulation without root: a slow sub-fling pull ending
    AT the collapsed bound (raw ≈ 0 — e.g.
    `input swipe 541 200 541 2095 8000` — ~240 px/s) lands 'collapsed'
    and dwells at progress 0 for the tail of the gesture — this
    exercises the "parked at progress 0 before release" shape. Sub-fling
    alone does NOT park: a pull ending below −collapsed/2 resolves
    'dismissed' regardless of speed — the recipe's end y must land at
    the parked position.
- ENDED + IDLE pill is a ~450 ms TRANSIENT: when playback is idle the
  collapse commit schedules an end-hold release (STAGE_RELEASE_MS=450)
  — the parked pill unmounts ~0.5 s after collapse. Reopen evidence must
  land inside the window: `input tap` on the pill body works
  (tap-expand). A real DRAG on the transient pill is NOT reliably
  injectable via `input swipe` — the settle outpaces `input`'s spawn
  latency and the down event lands on the settled/background UI. For
  morph-pane evidence use the in-window tap-expand (the spring morph
  renders the same stageMode a drag would).
- `auqw://open?tab=queue` mints stageMode='queue'+expanded but CANNOT
  remount a released stage (sheetPlayer=null → nothing renders) — it
  only works while a live hold keeps the mount alive.
- Deterministic IDLE+ENDED recipe: play a LOCAL fixture row →
  `auqw://open?tab=queue` → `auqw://seek?ms=<durMs−4000>` → wait ~5 s →
  verify `queue_state.current_occurrence_id` empty + `mode='stopped'`
  + dumpsys `state=NONE`. The sheet STAYS OPEN on the ended queue
  (stageOpen holds the mount) even though the pane shows no NOW PLAYING.
- SQLite queue ground truth:
  `adb shell "run-as com.vehicoule.auqw sqlite3 files/SQLite/auqw.db 'SELECT * FROM queue_state'"`
  → `id|revision|current_occurrence_id|position_ms|mode|blocked_error_json`;
  an EMPTY `current_occurrence_id` = ended cursor.
- Tapping an ended queue's UP NEXT row restarts playback and the sheet
  auto-lands on the PLAYER pane.
- Reliable leg recording: run screenrecord + gestures in ONE adb shell
  so the mp4 finalizes before pull —
  `adb shell "screenrecord --time-limit N /sdcard/f.mp4 & RP=\$!; sleep 0.8; <gestures>; wait \$RP"; adb pull /sdcard/f.mp4 …`.
  Pulling early yields `moov atom not found` truncated files.
- Mid-morph pane identity is read from extracted frames:
  `ffmpeg -i f.mp4 -vf fps=8 f-%02d.png` — the rising/descending card
  shows which pane (artwork+waveform = player, UP NEXT/NOW PLAYING rows
  = queue, lyric lines = lyrics) is painting mid-morph vs which it
  lands on.
- `sendevent` on /dev/input/event* is permission-denied (no root) —
  true multi-tap touch injection isn't available; `input swipe/tap` are
  the tools.
- The RN "Open debugger to view warnings" bar can cover the stage's
  floating segment pill — dismiss it via its X (~device 1000,2211)
  before tapping the segment.

## Stage-sheet device coords + end-of-queue variance (post-#319)

### Device coords (1080x2400 auqw AVD, verified 2026-10-02)

- Parked mini-player pill body center ≈ **(540,2090)** — `input tap` =
  sync expand commit; `input swipe 540 2090 540 400 300` (fast up-fling)
  = gesture expand.
- Segment pill on the EXPANDED sheet: queue ≈ (165,2240), player ≈
  (540,2240), lyrics ≈ (865,2240).
- Grab handle ≈ (540,152); collapse chevron ≈ (134,218) (second
  collapse affordance, same commit path as KEYCODE_BACK).
- Player-pane waveform ≈ y1860 spanning x53–1020 — a plain `input tap`
  seeks (25% tap at x≈295 lands position ≈ duration·0.25).
- Transport play/pause ≈ (540,2074).
- The RN LogBox bar spans ~y2150–2256 with X at ≈ (994,2200) — it
  overlaps BOTH the segment pill zone and the parked pill's lower edge;
  dismiss it before ANY pill tap (not just segment taps).

### End-of-queue semantics vary with queue shape — read, don't assume

- The deterministic IDLE+ENDED recipe above (`current_occurrence_id`
  empty + `mode='stopped'` + dumpsys NONE) is queue-shape-dependent.
  On a queue built from a home **recents-card** tap (recording-keyed
  playRecordings), a natural end instead lands **PAUSED at position 0
  with the occurrence RETAINED** — `queue_state` keeps
  `current_occurrence_id` with `mode='paused'`, dumpsys `PAUSED pos=0`,
  and home shows a `PAUSED · CONTINUE` card. The ENDED+IDLE 450 ms
  transient-pill window did NOT reproduce on this queue shape.
- A first natural end was observed RESTARTING the same occurrence id
  PLAYING (queue tail behavior); later ends landed paused@0. Treat
  end-of-queue state as evidence to READ (dumpsys + queue_state), not
  assume.
- **`auqw://seek?ms=N` does NOT resume a paused player** — it lands
  PAUSED at the new position (the deep link calls `seekTo` only). To
  race a natural end you must be PLAYING first (`auqw://resume`), then
  seek, then time the trigger.

### Dismiss + remount

- A full-fling drag-dismiss (`input swipe 540 160 540 2300 300` from the
  grab handle, ≥250 px/s) fires `emitDismiss` and RELEASES the stage
  player: pill + sheet unmount, dumpsys → NONE, and `auqw://resume`
  then returns the honest typed failure toast `resume failed — nothing
  came back — try again` (NOT a defect). Recovery is a real re-play
  (home recents card tap or `auqw://play-result?i=N`), which remounts
  the whole gated subtree — good remount coverage for mount-crash-class
  fixes.
- A second `input keyevent 4` while the sheet is collapsing is consumed
  by APP-LEVEL back navigation (previous tab), not the sheet — safe.
- Re-expand taps during the collapse morph do NOT win: the BACK commit
  takes precedence and `rowGate` may already be `pointerEvents=none` —
  landing parked is correct, not a missed expand.
- Mid-morph dismiss-surface taps: (540,500) at +0.3 s hits the
  uncovered backdrop and collapses via `dismissBackdrop`; by +0.5 s the
  rising card already covers the upper region (tap lands on the sheet,
  expand completes). For hit-the-backdrop evidence stay ≤0.35 s or aim
  lower.

### Verifying a TS fix is in the SERVED bundle

`curl ".../apps/mobile/index.bundle?platform=android&dev=true"` — dev
bundles may partially strip comments, so match CODE not comments: e.g.
`grep -n -B1 'animatedProps: dismissSurfaceProps' bundle.js` shows
`collapsable: false` on the preceding line for the pinned-wrapper fix
(the prop compiles before `animatedProps` — `-A1` can't show it).
Bundle-curl beats guessing which worktree Metro serves.

### Process notes (auqw AVD)

- `adb shell monkey -p com.vehicoule.auqw -c android.intent.category.LAUNCHER 1`
  is a clean relaunch (no component name needed). After relaunch,
  `queue_state` persists but dumpsys is NONE and the stage is
  unmounted — `auqw://resume` re-attaches playback and re-parks the
  pill.
- First PLAYING after relaunch can raise the system
  notification-permission dialog ("Allow Auqw to send you
  notifications?") — Allow at ≈ (540,1255) before driving pill taps.
- Emulator window ignores maximize; `wmctrl -i -r <winid> -e
  0,10,25,430,715` landed it at 321x714 (aspect-locked) — fully inside
  a 1024x768 frame. The `Emulator Running in Nested Virtualization`
  notice steals taps — dismiss its OK first.

## Waveform peaks gates (post-#waveform-fast)

The UI waveform (`WaveformSeek` in the stage `player` segment) is fed by
`useWaveformPeaks` only when `state.playback` exists — i.e. a SESSION
queue play. Dev `auqw://seam-url`/`seam-queue` plays produce no
peaksTarget and no mini player; they cannot show the UI path.

### The segment pill floats at the sheet's BOTTOM
`auqw://open?tab=queue` expands the stage into QUEUE mode; the mode
segment is a floating pill near the bottom nav inset
(`queue | player | lyrics`, 'player' center ≈ device 665,2245 on the
1080x2400 pixel_6 profile). Tap it for transport + waveform.

### logcat marks (native tag `AuqwWaveformPeaks`)
- Info-level sweep marks: `peaks[<requestId>] head-probe +Xms total=N
  head=B` → `coarse +Xms` (first real bars — fires at min(~20 s of
  audio, 35% of duration) decoded) → `streamed-done +Xms slices=N
  fetched=N probes=N`.
- Enable with `adb shell setprop log.tag.AuqwWaveformPeaks DEBUG`
  BEFORE the run (re-set after every emulator reboot).
- `fetched=` counts bytes DELIVERED through lane probes — committed
  hits count too (bytes the player already pulled) — it can exceed
  `total=`; `probes=` counts probe calls (~256 KiB each).
- JS-side `seam-peaks` dev leg logs `[s1.5] seam-peaks coarse +Xms n=`
  / `resolved +Xms n= nonzero=` / `failed kind=K +Xms` (tag
  ReactNativeJS). Measured on the auqw AVD: coarse +883 ms cold WAN,
  +464 ms committed, done ~8 s at ~1.1 MB/s pull pace; dead handle
  `released` +4 ms; refused stream `transient` ~1.5 s.

### The stripe-pull path — no size gate
`streamedStream` handles every stream size: a head probe learns the
total, ≤4 contiguous stripe lanes of `streamProbe(fetch=true)` pull
the file through the session's own Fetch (every probed byte is player
prefetch), and ONE forward demux+decode lane over a blocking sparse
reader folds PCM into 50 ms slices as bytes land. >256 MiB total or a
>8 min parsed duration fails `budget-exceeded`/`not-applicable`; a
lane abandoning after 3 refused probes truncates decode at its hole
and surfaces a typed refusal. `lf-*` local files always decode
whole-file off disk — INVALID evidence for this path.

### Getting a REAL session play when provider search is walled
`catalog.search` can die JS-side on this egress with ZERO `request`
host logs (deezer API itself is curl-reachable — the failure is in-app,
before transport). `playback.resolve` stubs do NOT help session plays:
`module.prepare` → `h.startPrepare` resolves INSIDE the Rust host, the
JS `request()` seam never sees it. Working stub — same file/pattern as
the download mint stub but intercept `catalog.search` and return real
youtube-music source_ref ids so the host-internal resolve still mints a
genuine ranged stream:

```ts
// in request() of apps/mobile/src/adapters/plugin-provider.ts — REVERT after
if (capability === 'catalog.search') {
  return Promise.resolve(decodeProviderOutcome(
    { type: 'succeeded', resultJson: JSON.stringify({ items: [
      { source_ref: { provider: 'youtube-music', kind: 'track', id: '<real-yt-id>' },
        title: 'X', artist: 'Y', album: null, duration_ms: 260000,
        release_year: null, artwork: [], explicit: false, genre: null,
        storefront: null } ], storefront: null }) },
    (slug) => appErrorKind(slug ?? ''), decode));
}
```
Then `auqw://search?q=x` (one row per `items` entry renders — add a
second object for two) → `auqw://play-result?i=0` →
real innertube resolve → `prepare req-N prepared handle=st-* mime=audio/webm`
→ PLAYING. The radio seed auto-grows a 50+ item UP NEXT queue with real
provider metadata — plenty of tracks to skip through for size variety.
To hit the sampled path keep skipping (`input keyevent 87`) until a
`head-probe` mark appears instead of `legacy pull`.

### Persisted peaks_cache (v11)
`peaks_cache` keyed by `recording_id`; rows are
`[{"up":f,"down":f},...]` (256 entries for the sampled path). Recordings
dedupe by provider source_ref — replaying the same youtube id (fresh
search → play-result) reuses the SAME recording_id → `store.load` hit:
bars render with ZERO new `peaks[` marks and no row-count change.
`queue_state`/`queue_occurrences` persist across `am force-stop` — the
relaunch home looks empty but the queue restores on the next play.

### Cancellation honesty check
Skip (`input keyevent 87`) mid-sweep. The sampled sweep completes in
~1.5 s on WAN streams — the cancel window is tight; the legacy path
gives ~8-9 s (decode dominates). Poll logcat at ~0.4 s for the new
`peaks[peaks-rec-…]` mark, then fire the skip. Honest cancel signature:
the old requestId shows its last mark BEFORE the switch and never a
completion mark after; no `peaks_cache` row for its recording_id; the
next track's sweep proceeds under its own requestId; zero
FATAL/ANR lines for the app pid (grep `AndroidRuntime` false-positives
from uiautomator's shell process, uid 2000 — filter by app pid).

### Wall-window realities (verified 2026-10-01, PR #256 leg)
- The innertube resolve wall is per-request-burst, NOT per-provider:
  during a ~47 min burst `catalog.search` (deezer fanout) returned 25
  real matches and every `request req-N` metadata call `succeeded`,
  while ~48 stream prepares all failed `kind=transient … bot-check`
  (media session never left NONE(0)). Distinguish metadata-OK /
  resolve-denied — do not call it 'provider down'.
- Denial-robustness evidence is free while walled: each `play-result`
  drive emits `[journey] play-result` + `prepare req-N failed
  bot-check`, the queue walk-forward tries subsequent rows (~30 tracks
  attempted), the mini player lands the last target with the
  `couldn't play` badge — and after ~10 denials the single row marks
  unplayable so later journeys emit no prepares at all (re-search to
  reseed rows). Zero FATAL/ANR across ~50 min of denial retries.
- Read `peaks_cache` without root: `adb shell run-as com.vehicoule.auqw
  "cat files/SQLite/auqw.db" > /tmp/auqw.db`, then query with
  `~/Android/Sdk/platform-tools/sqlite3` (the file lives under
  `files/SQLite/`, not `databases/`). The cat can tear mid-write —
  verify the copy opens cleanly (`PRAGMA integrity_check` /
  `SELECT count(*) FROM sqlite_master`) and re-snapshot before treating
  a MISSING row as evidence; a present row is proof regardless.
- TLOG process: any in-tree gate stub in the shared worktree gets
  swept by a lead-side `git add -A` — apply → leg →
  `git checkout -- <file>` IMMEDIATELY (a stub reached a pushed PR once
  and broke CI).

## Search-TextInput + stale-bundle + frame evidence (post-#274/275)

- `input keyevent 66` does NOT reliably fire `onSubmitEditing` on the
  search TextInput (Gboard consumes it — field clears or re-focuses; the
  playlist-name field above DOES accept it). Submit by tapping the app's
  own `search for "<query>"` suggestion row (uiautomator bounds →
  device-px center tap). Mark the soft-keyboard submit path unverified
  rather than passed.
- A Gboard "Try out your stylus" overlay can appear after `input text` —
  dismiss (Cancel) or it swallows later taps/keys.
- Switching worktrees under the same dev-client keeps the PREVIOUS
  branch's JS bundle (the client only refetches on a Metro reconnect).
  First restart Metro against the right worktree per the Metro section
  above — force-stop alone refetches from whatever Metro is still
  serving. Then `am force-stop com.vehicoule.auqw` + relaunch (clears
  in-memory state too), and sanity-check which bundle is running via a
  marker symbol or the served bundle itself
  (`curl ".../apps/mobile/index.bundle?platform=android&dev=true"` —
  ~12MB real bundle vs ~5KB JSON error). The dev-client entry is
  `apps/mobile/index.bundle`, not the repo-root index.
- Spring-vs-snap proof from screenrecord frames: `ffmpeg -vf fps=30`
  strip, crop a horizontal line through the control, mask the accentSoft
  fill color, track min/max x per frame — trajectory + overshoot/settle
  = spring glide; a 1-2 frame jump = snap. The same static-pixel crop
  proves overlay presence/absence where uiautomator exposes no node
  (e.g. the floating loupe under the player sheet).
- Pulse/skeleton verification without a11y: crop the row area and
  measure luminance across frames — oscillating = animation running,
  flat = reduce-motion static.

## Toast + clipboard triggers (post-#277)

- Deterministic in-sheet toast: settings → storefront field → enter an
  invalid code ('zz9') → save — `toast.storefrontCode` fires while the
  sheet stays open. In-sheet toasts render in-flow BELOW the sheet's
  rows (sheet grows to fit); root/pushed copies float at
  `insets.bottom + 88`.
- The emulator's primary clip is STICKY across `adb reboot` (persists
  to disk) and selection-toolbar Cut/Copy taps do not reliably update
  it — the paste-preview chip reads the CURRENT clip, so
  'clipboard has no delta' toast paths may stay unreachable via UI;
  report them untested rather than faked.
- Pushed screens' back chevron sits ~y180 device-px (not y57 — that's
  the status bar).

## Queue pane + autoplay legs (post-#289)

- The in-product mobile queue surface is the stage sheet's 'queue'
  segment — standalone `QueueScreen` exists only via `auqw://gallery`
  fixtures (same queue-list code). Segment buttons sit ~y2248
  device-px, sometimes covered by the dev-client warnings toast —
  dismiss it first. `auqw://open?tab=queue` remains the reliable open.
- `input draganddrop x1 y1 x2 y2 ~1200` drives DraggableFlatList
  long-press drags (handle a11y label 'drag') — a plain `input swipe`
  moves before the long-press fires.
- Screencap↔device scale ~1.525 (images read ~708×1568 on the
  1080×2400 device) — taps are DEVICE px; prefer uiautomator bounds
  for targets, screencaps for verification only.
- `radio.seed` is NOT bot-checked (unlike `playback.resolve`) — the
  stage player's 'start radio' chip arms a real tail and the queue
  gains 'autoplay · similar to {seed}' (dimmed rows, no × removes).
  The chip requires `selectedRef ?? sourceRefs[0]` on a
  radioSeed-capable provider — youtube-music-first rows work
  directly; a deezer-first row needs a youtube-music PIN
  (`selectedRef`) to expose it.

## Update-apply seam + SAF picker (post-#299)

- The update check hits `api.github.com` unauthenticated — this box's
  shared egress burns the 60/hr limit, so the app's own check fails
  `transient`. Use the env seam:
  `EXPO_PUBLIC_UPDATE_RELEASES_URL=http://localhost:8088/releases.json`
  exported when starting Metro (inlined at bundle time), plus
  `adb reverse tcp:8088 tcp:8088` and a `python3 -m http.server`
  serving `gh api 'repos/Vehicoule/Auqw/releases?per_page=3'` verbatim
  — real asset URLs keep download+SHA256SUMS honest (fetchText has no
  allowlist; the APK download port enforces the releases/download/
  prefix itself). The loopback-only networkSecurityConfig is a
  RELEASE-manifest overlay (with-loopback-cleartext.cjs): debug builds
  keep the debug manifest's broad cleartext flag, so `10.0.2.2` works
  there too — serve via adb reverse + localhost anyway so the recipe
  holds on both build types.
- APK asset ABI comes from the asset NAME (`…-android-<abi>.apk`);
  x86_64 emulator abilist is `x86_64,arm64-v8a` (ARM translation), so
  arm64-only splits still resolve 'install' on this AVD.
- Unknown-sources gate is appops-driven:
  `adb shell appops set com.vehicoule.auqw REQUEST_INSTALL_PACKAGES deny|allow`
  (`appops get` reads it). A fresh install defaults deny → first apply
  lands needs-permission naturally; installApk opens
  `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` — the real grant path
  is toggling 'Allow from this source' on that page.
- needs-permission parked state: card shows `install needs
  permission`/`allow installs from this app, then retry`/warn
  chip/`retry`; settings row `needs install permission — tap to
  retry`. `retry` while still denied refires installApk INSTANTLY on
  the retained stage — no download progress is the no-re-download
  proof. Staged APK: `run-as com.vehicoule.auqw ls -la
  cache/auqw-update/` vs the release asset's `size`.
- Do NOT confirm the OS install sheet on a debug build: the release
  APK is release-signed → update fails signature-match
  (environmental). 'applied' is proven the moment the
  PackageInstaller sheet appears.
- SAF picker on API 36: `auqw://open?tab=settings` → LOCAL FILES →
  'add local folder' drives ACTION_OPEN_DOCUMENT_TREE; DocumentsUI
  root is a folder TILE GRID — tap tile → tap subfolder → 'USE THIS
  FOLDER' (~y2274) → consent 'Allow …?' → ALLOW. Scan evidence:
  `local: scan <sourceId> entries=N added=N removed=N unreadable=N
  unlisted=N` in ReactNativeJS logcat; `auqw://local-list` prints
  per-source files=/recordings=.
- `local.recordings()` filters `provenance === 'local'` — a vanished
  FILE drops its file row but the recording persists (owned data), so
  recordings > files after a rescan-removal is expected, not a bug.
- No stock way to force an unlistable SAF subtree (sdcardfs ignores
  chmod) — the `failedTrees` keep-rows leg stays static-evidence on
  device; verify `unlisted=` counter presence in scan lines instead.
- Dev-mode LogBox (PR #289, not PR-specific): 'Maximum update depth
  exceeded' can surface as a dismissable overlay; app state survives.
  SUPERSEDED cause note: earlier revisions blamed the
  `subscribeAppActive` flap on OS-surface returns — the 2026-10-02
  hunt below disproved that (the flap is benign). The real trigger
  was uSES tearing on the position channel during synced-lyrics
  playback, fixed in #312 — verify App.tsx blame before attributing
  any new depth storm.
- **2026-10-02 depth-error hunt — NOT reproduced.** ~79 appActive
  transitions across ~46 legs (SAF tree/file pickers grant+cancel,
  export dir-picker, camera grant+deny, unknown-sources page direct +
  in-app needs-permission, PackageInstaller sheet, dev menu, HOME,
  screen off/on, recents, lyrics-open+playing, mid-morph, end-hold,
  rapid-fire) produced ZERO 'Maximum update depth' in a full-session
  logcat. TLOG markers (temporary `console.log` in
  `subscribeAppActive`, strip before commit) show every surface return
  is a clean `bg→active→bg` flap (~40-90 ms) + single `active` — the
  flap itself is benign; the loop (if real) needs a state/race this
  fixture doesn't build. Mechanism observed: picker OPEN produces a
  ~50 ms `bg→active→bg` triple — the app briefly believes it's
  foreground mid-transition.
- **Found instead — deterministic removeViewAt hard-kill (3/3).**
  KEYCODE_BACK while the stage sheet is expanded AND SETTLED throws
  `java.lang.IllegalStateException: Unable to remove a view from a
  view that is not a ViewGroup` at `SurfaceMountingManager.kt:444`
  (Fabric mount dispatch inside `Choreographer.doFrame`) → redbox →
  DISMISS leaves a DEAD SURFACE (white screen; JS still logs, SAF
  intents fail `no-result`; only `am force-stop` recovers). BACK
  mid-morph does NOT crash — it navigates cleanly; the sheet must
  have settled to progress=1 first. This is a genuine stage-sheet
  unmount-ordering bug, worse than the reported depth LogBox.
- `input keyevent 82` (KEYCODE_MENU) opens the RN dev menu — a
  deterministic extra OS surface; BACK dismisses it (does NOT flap
  AppState — it's a dialog activity).
- The RN "Open debugger to view warnings" toast's parent window spans
  ~`[26,2016][1054,2348]` — it eats ALL taps on the update card's
  action row (retry/dismiss at y2031-2146) AND the stage segment
  pill. On this box it re-fires whenever the dev client can't reach
  Metro (`Cannot connect to Expo CLI` via 10.0.2.2:8081 — the dev
  client uses the emulator NAT alias, NOT adb reverse; the reverse
  tunnel serves the JS bundle fine, this warning is cosmetic but its
  window blocks UI). Dismiss via its X (~device 1000,2208) before
  tapping anything in that band.
- Update-seam checksums leg detail: `parseRelease` drops asset URLs
  that aren't `https://` — a localhost-served SHA256SUMS is filtered
  at parse time (fetchText itself would take it; the LIST parse is
  the gate). Serving the REAL `releases.json` verbatim works because
  abilist `x86_64,arm64-v8a` resolves the arm64 asset anyway — no
  faked files needed. `appops set … REQUEST_INSTALL_PACKAGES deny`
  before install lands needs-permission deterministically.
- Fresh checkout needs, in order: `pnpm install --frozen-lockfile`,
  `rustup target add x86_64-linux-android` +
  `tooling/build-android-bindings.sh` when
  `modules/auqw-expo/android/src/main/jniLibs/<abi>/libauqw_mobile_bindings.so`
  is absent, then `(cd apps/mobile && pnpm exec expo prebuild
  --platform android --no-install)` only when `android/` is missing.


## Synced-lyrics fixture + boot wedges + removeViewAt mode-switch trigger (post-#312)

- **Deterministic synced-lyrics fixture (no deezer needed):** tag a generated audio
  file with an LRCLIB-known identity — e.g.
  `ffmpeg -f lavfi -i "sine=frequency=440:duration=223" -metadata artist="Daft Punk"
  -metadata title="One More Time" -metadata album="Discovery" -b:a 96k /tmp/omt.mp3`.
  The app-side acceptance filter rejects sheets whose `matched.durationMs` differs
  from the recording's by >5 s (`LYRICS_DURATION_DRIFT_MS=5000`). Why 223 s works
  here despite the Discovery tag: LRCLIB currently has NO Discovery-album record,
  so the match falls back to the 219 s synced 'NRJ Energy Music Awards 2002'
  record (4 s drift — inside the gate). If LRCLIB later gains a canonical ~320 s
  Discovery record it would win the match and FAIL the gate — regenerate the file
  at `duration=320` in that case (the ~320 s 'Eurotrip' record accepts 0 s drift),
  or pick a song with a single canonical record. Push to the SAF-granted folder,
  rescan, search — the local row shows, play it, lyrics pane renders
  `synced · lyrics-lrclib` timed lines and the orange active line tracks position.
  Sine audio is fine — the pane only needs timed lines + positionMs.
- **`invalid-response` boot wedge:** the app can boot into a
  full-screen `couldn't restore your library — got an unexpected reply — try again`
  with `[auqw] local boot load failed: invalid-response` — storage-sqlite snapshot
  validation rejects the persisted state. Cause UNCONFIRMED (writes are
  transactional — `SqliteStorage.commit` wraps each delta in
  `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`, so a torn write can't produce this;
  suspect a version/schema or write-path bug — worth a real investigation,
  not just a workaround). PRESERVE EVIDENCE FIRST on a debuggable build:
  `adb exec-out run-as com.vehicoule.auqw tar -cf - files/SQLite > wedge.tar`
  before wiping — the tar captures every db plus the -wal/-shm/-journal
  sidecars (a `cat *.db` glob concatenates multiple dbs and drops the WAL,
  so it can miss the malformed state entirely).
  `pm clear com.vehicoule.auqw` is the reliable recovery on throwaway dev
  installs (it erases the library — never the first move on real data),
  then re-grant SAF (`auqw://local-add`
  → DocumentsUI `USE THIS FOLDER` → `ALLOW` at `[790,1325][968,1451]`) and reseed
  fixtures. Also seen once: a different wedge where chrome (header+navbar) renders but
  every tab body stays empty and search returns nothing — session never reaches ready;
  force-stop+relaunch recovered. Retry taps on the error card did nothing observable.
- **`auqw://play-result?i=N` can no-op:** the journey logs `[journey] play-result` but
  `playMetadata(items,{startAt})` silently did not start playback in one session —
  the search-row UI tap and the home `recently played` card are the reliable play paths.
- **`auqw://search` at cold boot races:** booting directly into `am start -d
  auqw://search?...` wrote the query into the field but results never rendered on that
  boot (even after Enter, query nudges, re-fires — `[journey] search` logged, zero
  results). Boot via `auqw://open` first, let it warm, then fire the search link — or
  use UI taps.
- **removeViewAt crash — more triggers on the settled expanded sheet:** beyond
  KEYCODE_BACK (post-#299 finding), tapping a different `ModeSegmentPill` segment
  (lyrics→player) on the settled lyrics pane also throws `IllegalStateException:
  Unable to remove a view ... (ParentTag: 1402 - Tag: 1400)` → same redbox → dismiss →
  dead white surface → force-stop. #311's pin-the-panes fix does NOT cover these paths
  on the #312 build — BACK-collapse and mid-song mode-switch both fire it. A mid-song
  tap that misses the pill hitbox does nothing (no switch, no crash); a landed tap
  crashes. Track-end while the pane is open is also a plausible trigger (coincided with
  one fire).
- **First play after `pm clear` prompts POST_NOTIFICATIONS** ("Allow Auqw to send you
  notifications?") — it overlays the UI; Allow at ~(540,1312).
- **Mini-player expand doesn't register via `input tap`/`input swipe`** on this build —
  taps on the mini bar body and fling swipes across it left it collapsed (no crash, no
  expand). The expanded 'player' pane (WaveformSeek) is only reachable via the
  crash-prone mode-switch until the unmount bug is fixed.

## Theme switching on-device (post-#314 palette legs)

- Pure `input tap` flow, no CDP: settings tab → 'theme' row (~[76,374][798,424]) → scheme cards at fixed bounds on the 1080×2400 device — system/adaptive ~y1580, dark/light ~y1920, oled ~y2235.
- The scheme applies live on selection — verify by screencap palette (e.g. OLED canvas stays pure black vs the GTK charcoal dark), or `uiautomator dump` for the active card's `selected` state.

## Native-dock asserts + dev-build noise (post-#344)

- **Recording-time window sizing on this box:** the VNC display is 3200×2400 real px but the computer tool sees 1024×768 (~3.125× downscale) — `wmctrl -e 0,10,30,430,710` leaves the phone a ~100×230 thumbnail. Use `wmctrl -lG` to find the "Android Emulator - auqw:5554" winid, then `wmctrl -i -r <winid> -e 0,30,50,620,1420` (~200×440 phone in tool space). The sibling `Emulator` tool-strip frame may need its own `-e` to stay attached.
- **Bottom overlays corrupt dock measurements** — dismiss before asserting bar geometry: the "update available" card (in-flow, ✕ ~x994,y2053 device px — a real release surface, not dev-only: if it obstructs a release-build check, report it) and the RN dev "Open debugger to view warnings" toast (full-width pill covering the dock icon row, ⊗ ~x1000,y2210 — dev-build-only noise, never a defect).
- **uiautomator starvation → screencap + PIL:** `uiautomator dump` returns empty/33-byte output or hangs while the mini-player waveform runs and during sheet/theme transitions. `adb exec-out screencap -p` always works — assert layout in pixels.
- **Native M3E dock pixel recipe (post-#344):** bar surface = `mixHex(deep, accent, .08)` — the fixed values below cover the named light/dark schemes only (OLED has different `deep`/`accent`, adaptive derives per-source — recompute `mixHex` from the theme's tokens there): light `#d6cccc` (214,204,204) / dark `#2b221c` (43,34,28), edge-to-edge under the gesture pill (a separate ~10px dash over it). Active tab = filled PNG glyph tinted accent inside the ~64dp platform indicator pill (accentSoft-over-mix composite — light ~(211,189,183) / dark ~(77,51,33), pixel-exact); idle = outlined glyph in textSecondary. Mini-player accessory band ends the row immediately above the bar's top edge (`bottom: tabBarHeight` anchoring — no gap, no overlap).
- **Dev-mode PNG decode pop-in (cosmetic):** dock `<Image>` glyphs decode on FIRST mount — a tab's "active" variant mounts on its first activation, so a screencap <1 s after a first-visit tap can catch a blank glyph. Re-capture before flagging; release builds bundle the asset.
- **Dock test shortcuts:** stage-sheet expand without the flaky mini-player morph — `auqw://open?tab=queue` deep link opens queue mode directly. Keyboard-hide check — explore loupe ~device (995,190) expands the field and opens the IME; wait ~1.5 s before screencapping.

## Entity pages + stage meta links (post-#347, verified 2026-10-03)

- Hero reads the kind: artist art is a CIRCLE (`cornerRadius:80` on the
  160px tile), album/playlist SQUARE — playlist shares the album branch
  so a square-corner check covers it by code-identity. Blurred backdrop
  (RN `Image` blurRadius 40 + Svg gradient fade to canvas) sits behind
  art+title; accent 'play' pill left of '≡ shuffle' plays ordered from
  track 1 (header 'playing from <entity> · N tracks').
- Stage-sheet meta links (title→album, artist→artist, album→album)
  FOLD the sheet on navigate (`closeStageOnContextNav`) — unlike the
  desktop stage column, which stays open. Fold + pushed page is the
  assert; player keeps playing underneath. Meta lines sit ~y1450
  (title)/1570 (artist)/1678 (album) device-px on the 1080x2400 AVD.
- Back chevron on pushed entity overlays spans [42,149][105,212] —
  tap x~73, not the icon's visual ~134.
- Inert-recording recipe ON DEVICE: `auqw://local-add` deep link opens
  the SAF picker (folder tile → USE THIS FOLDER → ALLOW); a local file
  gets provenance `local` → NULL artist/album refs → meta lines render
  plain text and taps no-op. itunes rows are NOT inert — they emit
  `artist_ref`/`album_ref` now. sqlite ground truth: 53 provider rows
  carried `*_ref_json` post-v17; the local row NULL.
- `auqw://search?q=...` commits still apply under pushed overlays —
  back-nav surfaces the result list, not lost state.
- `POST_NOTIFICATIONS` dialog can fire ANYTIME (not just on play) and
  swallows taps until handled — Allow ~x540,y1312.
- 'Maximum update depth exceeded' resurfaced post-#312-fix (artist
  entity page + over search results, playback re-renders active) —
  writer NAMED: `VirtualizedList._updateCellsToRender`, fixed in #356
  (stable `data` refs + session `#statePending`). If a new fire lands,
  capture its stack per the hunt section below before dismissing.

## Update-depth storm hunt (post-#355 — writer NAMED)

- **screencap ≠ device px:** `adb exec-out screencap` PNGs are
  ~706×1568 while the AVD is 1080×2400 — multiply screencap coords by
  ~1.525 before `input tap` (chip taps land wrong otherwise).
- **a11y hit-area proof:** `uiautomator dump` while paused — a
  stretched Pressable's bounds span the full row (~right edge 807
  device px) regardless of text ink; `flex-start` hugs the ink.
- **TLOG method that worked:** temporary `console.warn('[TLOG] …')`
  + `adb logcat -d -v threadtime | grep TLOG` windows — render markers
  show burst structure, publish markers prove/disprove uSES churn,
  useState counters show convergence. Strip with
  `git checkout HEAD -- <files>` right after legs — a lead-side
  `git add -A` can sweep them.
- **Capturing the LogBox stack:** the error's component stack reaches
  NEITHER logcat NOR metro — the on-device LogBox pill is the only
  path to 'in <Component>' lines. It auto-dismisses but reappears per
  fire (~1/15-70s under deezer playback, ANY content surface — home
  fires too): tap fast, 'Collapse all N frames' is already expanded,
  app-side frames sit at the bottom of Call Stack.
- **The named writer:** `setState` → `StateSafePureComponent.js:40` →
  `VirtualizedList.js:1909 _updateCellsToRender` ← `setTimeout`
  VL.js:1806 — the ~50ms `updateCellsBatchingPeriod` timer
  `componentDidUpdate` arms on each `data` prop change. It trips
  inside an already-nested ticking flush — class-component setState,
  so ui-web CANNOT produce it (desktop: 0 fires / ~1500 identical
  silent syncs under the same ticks).
- **Why the publish path looked clean:** `#publishPosition()` calls
  `#syncState()` too — silently swaps `this.#state` (queue+playback
  refs rebuild per tick — `queue.snapshot()` embeds positionMs)
  WITHOUT notifying listeners. A `[TLOG]` section-diff inside
  `#syncState` before `return true` exposes ~1Hz 'queue,playback'
  syncs the `session.publish` counter never sees — instrument SECTION
  diffs, not just publish calls. Fixed in #356: `#statePending` marks
  the undelivered install so the next publish can't dedupe it away
  (a queue write mutates the engine before its commit await — a tick
  in that window installs the change unseen).
- **Fresh-`data` churn (the fix's other half):** every ui-native
  FlatList got a new `data` array each render — queue list built
  `queue.sections.flatMap` inline, DraggableFlatList sliced per pass,
  entity/search/home lists fed view-model rows remapped per render.
  #356 memoizes on the (frozen, shared) source: `queue.sections`
  deps, `useScopedMap` model caches, `useStableRows(rows, pick)` for
  controller-mapped wrappers + `useLatestCallback` so retained
  wrappers still hit the latest handlers.
- **Storms need LIVE playback ticks:** a 'radio · growing' queue with
  a refused stream produced zero TLOG lines — no position publishes,
  no renders. Check stream health first ('provider is refusing
  requests' in the player pane = youtube-music bot-wall on this IP —
  retries DO eventually succeed: keep tapping play, watch for
  `request succeeded` + media_session PLAYING).
- **Why local files don't reproduce:** local playback ticks
  identically but emits ~0 whole-state publishes (autoplay can't
  seed a local track — no radio growth — and no remote prepare/
  buffering transitions) → VL timers fire into empty flushes → no
  cap. Deezer catalog tracks resolve audio through youtube-music;
  remote playback is required for repro.
- **#312 disease class:** `app-shell.ts` documents the prior fix
  (ticking store marking itself mutated mid-render → synchronous
  retries → nested-update cap). Any new ticking-path setState —
  `bumpLyricLayout` in lyric-row onLayout, effects whose deps rebuild
  per render — is the same class.
