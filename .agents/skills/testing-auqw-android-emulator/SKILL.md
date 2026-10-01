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

## sync-plugins: sibling releases can lag origin/main (post-#215)

`pnpm sync-plugins` fails `ENOENT ... releases/<plugin>/<pinned>` when
the releases checkout that sits NEXT to the worktree is behind the
lock's pinned version (`~/wt/auqw-plugins` for `~/wt/*` worktrees,
`~/repos/Auqw-plugins` for the main clone). Stage the pinned dirs into
that sibling without switching its branch:

```bash
# Sibling checkout — the script's lookup is case-insensitive but the
# shell is not (~/repos/Auqw-plugins vs ~/wt/auqw-plugins).
PLUGINS=$(compgen -G '../[Aa]uqw-plugins' | head -1)
git -C "$PLUGINS" fetch
git -C "$PLUGINS" checkout origin/main -- releases/<plugin>/<version>
pnpm sync-plugins
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
isn't already queued; a repeat of the same index hits the
queuedOccurrenceForRef → playOccurrence path and adds no row. Fire
DISTINCT indices for N rows. In the API-36 gate one fresh play grew
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
