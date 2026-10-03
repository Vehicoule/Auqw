---
name: testing-auqw-desktop-electron
description: How to launch and exercise the auqw Electron desktop shell (apps/desktop) live on the X desktop — env knobs, plugin staging required for product-UI boot, dev-gate audio path, product-UI driving (dialogs, tabs, transport, waveform capture), ranged fixture, counted-play seeding via local files, sqlite ground truth, and how to prove sound on a VM with no audio device.
---

# Testing the auqw desktop Electron shell end-to-end

Prerequisites: the desktop legs must be on the checkout — `apps/desktop`
lands with the s4 PRs (`s4/desktop-shell` base, `s4/desktop-player` for
`stream:*`/`host:*` channels, `s4/desktop-sound` for the player page and
CSP), and `AUQW_NODE_BINDINGS` needs a real `libauqw_node_bindings.so`
built from `crates/node-bindings` (`s4/node-bindings`). On `main` before
those merge, this skill has nothing to run against.

## Launch

- Build once: `cd apps/desktop && pnpm build` (needs
  `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`). Building on a
  different branch overwrites `apps/desktop/dist` — always rebuild after
  switching, or test on the branch the dist was built from.
- If `node_modules/electron/dist/electron` is missing (Electron 44 ships no
  binary in the npm tarball — and `pnpm build` can wipe an installed one):
  `cd node_modules/electron && node install.js`.
  Warm `~/.cache/electron/*.zip` makes it instant; cold it downloads ~230 MB.
- Kill stale instances first or the single-instance lock silently quits the
  new one: `pgrep -f "dist/electron \." | xargs -r kill` (the npm wrapper PID
  differs from the real binary — match the binary path pattern). FOOTGUN:
  never put that kill inside a compound shell command whose own cmdline
  contains `dist/electron .` — pgrep matches the shell itself and xargs kills
  it mid-run. Run the kill as its own command, or use a self-immunizing
  pattern like `"[d]ist/electron"`.
- Launch on the visible desktop, in a pollable shell:
  `cd apps/desktop && env DISPLAY=:0 <repo>/node_modules/electron/dist/electron .`
  (electron lives at the repo-root node_modules). The default resolves
  `target/debug/libauqw_node_bindings.so` under the launch checkout — when
  that artifact is missing, pass a real one explicitly:
  `env DISPLAY=:0 AUQW_NODE_BINDINGS=/abs/path/libauqw_node_bindings.so ...`
- `AUQW_NODE_BINDINGS` only matters when the default can't resolve:
  `AUQW_REPO_ROOT` points at the launch checkout's `target/debug`, which
  may lack the artifact — pass the absolute path of a real
  `libauqw_node_bindings.so` (cargo debug build). The host stages it to
  `userData/node-bindings/auqw_node_bindings.node` before `require()`.
  Missing/broken → `host:plugins: unavailable` in diagnostics.
- Branch switches touching `crates/plugin-host` need a bindings rebuild
  (`cargo build -p auqw-node-bindings`): a stale .so built against an old
  ABI silently rejects EVERY plugin → zero providers → `[ui] boot failed:
  internal` before storage init (sqlite `user_version` stays behind).
- `AUQW_DEV_GATE` needs no setup: main sets it to `'1'` whenever
  `app.isPackaged` is false (`src/main/index.ts` `utilityEnv`). Utility env
  is filtered to `AUQW_*` + platform vars — parent credentials never reach it.
- Window title is `auqw`; arrange with `wmctrl -r auqw -e 0,x,y,w,h`.

## The dev-gate audio path (earliest sound)

- UI contract (`src/renderer/index.html/.ts`): `#source` text input,
  `#provider` select, `#dev-gate` checkbox (default ON), `#prepare/#play/
  #pause/#stop` buttons, `#player-state` div, `#events` log, `#status` dl.
- Dev-gate ON → `stream:dev-prepare` → napi `devPrepareUrl` (still requires
  bindings `loaded`); log shows `dev-prepared <handle> (<mime>)`. OFF →
  provider path; with no plugins it logs `prepare failed — no plugins
  loaded` — a free negative test that proves the checkbox routes.
- `mimeFor` maps only mp3/flac/ogg/oga/opus/webm; `.wav` falls back to
  `audio/mp4` — prefer a real `.mp3` fixture so mime stays honest.
- play → `stream:serve-url` → `audio.src` = Rust loopback URL → Chromium
  fetches through the utility; the auqw-stream pump is **strict-206** —
  every upstream request is ranged and requires a valid `Content-Range`.
  `python -m http.server` does NOT qualify; use a node:http fixture
  (~20 lines) or the blueprint's range server. A `Range bytes=0-65535`
  probe fires already at prepare time — watch the fixture log to see the
  seam move bytes before play is even clicked.
- Status union has NO `stopped`: after stop the state reads `idle · 0ms`.
  Playback states observed: `prepared`, `buffering`, `ready`, `playing`,
  `paused`, `ended`, `failed`, `idle`.
- `phase <name> +<N>ms` event-log lines render the stream's phase marks,
  but `crates/auqw-stream/src/marks.rs` defines `first_byte_ms`/`head_ready_ms`
  /`attach_ms` as wall-clock EPOCH ms (only `resolve_ms`/`mint_ms` are
  durations) — so those lines print `+1.7e12ms`-style values. Cosmetic
  mislabel when reading the log, not a playback failure.
- `window.auqw.storage.*` (`storage:begin/commit/execute/query/backup…`,
  utility-side node:sqlite) is exposed via preload but NO UI control drives
  it — untestable from the page; probe via IPC only if a test needs it.
- Utility supervision: the app forks one `--utility-sub-type=node.mojom.
  NodeService` child lazily on the first `utility:*` request. Respawn-storm
  check: `ps -eo pid,cmd | grep utility-sub-type=node.mojom | grep -v grep`
  must stay a single stable PID across the run, and the launch log must show
  no respawn/crash lines (dbus + ALSA noise is normal on this box).
- The button row Y-position drifts as the `#events` log grows — each
  appended `phase`/`dev-prepared` line shifts prepare/play/pause/stop up
  ~15 px. A click using coordinates from an earlier screenshot lands on
  empty space and silently no-ops; re-screenshot before each click.
- Each `play` press serves a FRESH stream (new `attach`/`head-ready`/
  `first-byte` phase lines, position restarts at 0) — there is no
  resume-from-pause on this page; pause → play restarts the track.

## Driving the product UI (app.html)

- **GTK "Add a local folder" dialog recipe**: Enter key and the "Select
  Folder" button both return `no-result` cancellations. Works reliably:
  `wmctrl -a "Add a local folder"` to activate the separate GTK window,
  `Ctrl+L` → type the absolute path → click **"Open"** (bottom right).
  `settings.addLocalFolder failed: no-result` console lines mean the pick
  was cancelled — retry with the recipe, not a bug.
- **Nav tab coordinates MOVE when the stage column toggles**: the
  home/explore/library strip is centered in the world column. With the
  stage pane open they sit around x≈440/500/560; after hiding the stage
  (≡ at ~934,13) they shift right to ≈590/650/710. Re-zoom the strip
  before clicking instead of reusing coordinates.
- **Enqueue vs switch**: during an active queue/radio session, pressing a
  search-result row ENQUEUES (the "radio · growing" chip auto-fills
  UP NEXT). Pressing a row inside the queue pane (stage "queue" tab)
  switches playback immediately. To switch fast, use the transport next
  (>) button at ~(197,672).
- **Waveform baseline capture**: the flat zero-amplitude placeholder only
  renders for ~1-2s after a track switch — click next (>) and screenshot
  within ~1s. Bars are flat lines at 0:00, then real amplitude bars land.
  Seek = click anywhere on the WaveformSeek strip (~y620); position
  display + played region jump.
- **Artwork surfaces**: provider catalog rows (deezer search — e.g.
  "daft punk") all carry https art. Art also renders on queue
  NOW PLAYING/UP NEXT rows, liked collection rows, home "recently liked"
  + "search results" tiles, artist tiles, and the stage album-art
  backdrop. Local files honestly have `artwork: []` — monogram tiles are
  correct, NOT missing-art bugs.

## Search screen: recents rail, drafts, and commits

- The **recents rail only renders on the search `idle` phase** — after
  submitting, results own the pane. To see the rail again without a
  restart, click the field's ✕ "clear search" control (right edge of
  the field, ~x993 at 1024px wide): clearing to empty republishes
  `idle`. Re-screenshot for the ✕ position first.
- **Typing is draft mode, not a commit.** Keystrokes debounce (150 ms)
  into `suggest` and render a SUGGESTIONS section (`search for "…"`
  commit row + provider completions). Only Enter (or a row tap)
  commits a query — typed-but-unsubmitted text must never appear in
  recents; verify by closing the app with the draft still in the
  field.
- **Direct sqlite cross-checks:** the app's whole persisted state is
  one file, `~/.config/auqw-desktop/auqw.db` (`search_history`,
  `peaks_cache`, `settings`, `queue_state`, …). `sqlite3` is already
  on the box at `$HOME/Android/Sdk/platform-tools/sqlite3`. MRU order
  is `ORDER BY rowid DESC` — re-records take a FRESH rowid via
  `INSERT OR REPLACE`, so a deduped re-search visibly jumps to a new
  max rowid. Read while the app is CLOSED (`wmctrl -c auqw`, then poll
  `pgrep -f "[d]ist/electron"` to empty) to avoid lock noise.

## Proving sound on a VM with no audio hardware

This box has no `/dev/snd`, no pulseaudio/pipewire, and `pactl` is absent —
physical audibility cannot be captured. Two proxies constitute the
end-to-end proof:

1. `posMs` advancing in `playing` state — the element's clock is driven by
   the audio render pipeline; a failed fetch/decode yields `failed` or a
   frozen `buffering`, never advancing time.
2. The fixture's request log showing `-> 206` responses — proves bytes
   flowed upstream → Rust loopback → renderer.

`player phase observed` console lines also confirm state transitions.
Show `tail -f` of the fixture log in a konsole beside the window during the
recording so reviewers see range pulls live.

In the product UI the lyrics surface corroborates `positionMs`: on a
synced-lyrics track the active-line highlight + auto-scroll follow the
position clock. Hiding the window (`wmctrl -r auqw -b add,hidden` then
`wmctrl -a auqw`) exercises the appActive gate — after restore the
highlight should sit several lines further along (audio keeps playing
while hidden).

## Fixture recipe

- `ffmpeg -f lavfi -i "sine=frequency=440:duration=5:sample_rate=44100" -codec:a libmp3lame -q:a 4 /tmp/tone.mp3`
- node:http server on 127.0.0.1:PORT handling `Range: bytes=a-b` →
  206 + `Content-Range: bytes a-b/SIZE` + `Accept-Ranges: bytes`;
  out-of-range → 416 + `Content-Range: bytes */SIZE`.

## POT minter legs (s4/pot-service)

- The desktop utility binds a SECOND `0.0.0.0:ephemeral` listener for the
  bundled poToken minter (bgutil `/get_pot`). Tell the two ports apart by
  probing: `curl -s -X POST -d '{}' http://127.0.0.1:<port>/get_pot` → the
  minter answers `400 pot: content_binding must be a bounded string`;
  the sync port won't answer HTTP at all.
- The pairing offer + welcome carry `pot` = `<endpoints()[0]>:<minterport>`
  (visible in the copied payload JSON). The client `rebasePot`s it onto the
  DIALED host — a phone pairing via `10.0.2.2` stores `10.0.2.2:<pot>` and
  the emulator reaches it fine (`nc -w 3 10.0.2.2 <pot>` exit 0). Phone→pot
  traffic appears on the host as `lo 127.0.0.1→127.0.0.1` (emulator NAT
  rewrites 10.0.2.2 to host loopback) — `tcpdump -i any -nn port <pot>`
  proves whether a phone resolve actually consulted the minter.
- `potProviderUrl` is a ONE-SHOT `createHost` input (App.tsx) — pairing
  must precede app boot: pair → `am force-stop` + relaunch → resolve.
  A stale peer record (old port) heals on re-pair or resume — the
  same-fingerprint record is updated in place (endpoints + welcome pot),
  no unpair needed.
- Branch JS that changes the host-call shape breaks a stale APK with a
  UniFFI `Structure.getFieldOrder() … does not provide enough names`
  crash at `createHost` — rebuild bindings (`build-android-bindings.sh`)
  + `assembleDebug` on the branch. Metro also caches `app.config.ts`
  plugin resolution across branch switches — `expo start --clear` or the
  app 500s on deleted plugin files (e.g. `with-release-abis.cjs`).
- First playback needs the Android media-notification permission granted
  (`Allow Auqw to send notifications?`) — until allowed, Media3 won't
  start and the play button stays inert.
- A queue occurrence that failed `match requires confirmation` (ambiguous
  domain match — the youtube-music SEARCH already succeeded, proving the
  minter worked upstream) does NOT retry on play-press — it stays a dead
  item. Dismiss the mini-player (swipe it down) and pick a different
  track, or clear it from the queue tab. Resolve via settings →
  `match reviews` → pick a candidate → re-tap the row.
- The 'Open debugger to view warnings' toast has an invisible hitbox over
  the bottom rows — taps on `desktop sync`/`match reviews` silently die
  while it shows. Dismiss it (its X, or `keyevent 4`) before tapping
  bottom-of-list rows.

## Page selection + provider/plugin path

- `AUQW_DEV_HARNESS=1` in the launch env selects the dev-gate harness
  (`index.html`, the UI documented above); without it the window loads the
  product UI (`app.html`) — a different surface (search/home/settings).
- Plugins ship OTA (decisions.md — Plugin guests): NOTHING is bundled.
  The utility fetches `releases/feed.json` (default
  `https://raw.githubusercontent.com/Vehicoule/Auqw-plugins/main/releases/feed.json`),
  verifies the ed25519 sig + `sha256:<hex>` digests per artifact, and
  caches ONE self-describing `<id>.json` pair doc per plugin under
  `<userData>/plugins` (default `~/.config/auqw-desktop/plugins`) —
  every load re-verifies sig+digests offline, so no .wasm/.manifest.json
  files exist on disk anymore. A first boot needs outbound network to
  raw.githubusercontent.com — an unreachable feed with an empty cache
  fails closed at BootGate.
- Env seams: `AUQW_PLUGIN_FEED` (feed URL override — point at a local
  mirror for tamper legs), `AUQW_PLUGIN_DIR` (unsigned dev set, LEGACY
  two-file `<id>.wasm`+`<id>.manifest.json` format only), `AUQW_USER_DATA`
  (cache root). `AUQW_DEV_HARNESS=1` shares the same OTA plugin path.
- Local mirror recipe: node static file server under a `releases/` tree,
  log every request's path + `accept-encoding`. The request log is the
  ground truth for cache-hit vs refetch (hit = feed.json only; miss =
  feed.json + `<id>/<ver>/plugin.manifest.json` + `<id>-<ver>.wasm`).
- Dev staging (`tooling/sync-plugins.mjs apps/desktop/plugins`):
  `providers.lock.json` `release:../auqw-plugins/...` sources resolve
  case-sensitively against a sibling literally named `~/repos/auqw-plugins`
  (lowercase). If that clone is stale or another clone owns the releases
  (`~/repos/auqw-plugins-*`), sync fails `ENOENT … releases/<id>/<ver>` —
  `git -C ~/repos/Auqw-plugins pull --ff-only` or `ln -sfn <clone> ~/repos/auqw-plugins`,
  then re-run sync (one `synced <id> <ver>` line per plugin, no `synced spin`).
- Feed entry digests are `sha256:<64hex>` — a bare-hex tamper fails the
  WHOLE-feed shape check (all-or-nothing → LKG), not a per-plugin skip.
- Observable semantics: feed reachable = authority — a valid cached doc
  for a feed-dropped id is refused + swept. The retry gate arms when
  `ready < compatible` (undeliverable newer release) → the NEXT
  pluginsReady/status call re-syncs → a SECOND feed.json fetch in the
  mirror request log is the armed-gate proof.
- Dead-feed legs: `AUQW_PLUGIN_FEED=http://127.0.0.1:1/x.json` — port 1
  refuses instantly. Empty cache → BootGate; populated cache → LKG boot,
  stale files NOT swept (sweep only runs on a successful sync).
- Pair-doc tamper that discriminates sig-vs-digest: edit `"version"` in
  a cached `<id>.json` — digests+manifest stay valid so only the
  sig-over-payload re-verify catches it → that provider is skipped.
- Electron utility-process `fetch` advertises gzip but does NOT decode
  it (plain node does). Feed fetch sends `accept-encoding: identity`;
  verify via mirror request log `ae=`.
- ALWAYS `cargo build --locked -p auqw-node-bindings` after branch
  switches — a stale debug `.so` rejects current manifests
  ('capabilities outside the set this ABI serves') even when bytes are
  perfect. Post-#340 (ABI 0.1.0 collapse) the failure is sharper: a
  pre-#340 `.so` rejects EVERY synced plugin → zero providers →
  `[ui] boot failed: internal` at `controller.ts:154`, thrown BEFORE
  storage init so the DB stays on the old schema_version — a boot
  that dies before migrations, not a playback fault. Rebuild fixes it.
  If the worktree gains commits mid-run, check `git log` +
  `stat dist/utility/index.cjs` mtime — dist may be behind HEAD.
- youtube-music resolve bot-walls on datacenter egress — typed
  `provider-wall` is weather, not a defect; the diagnostics
  `attempt trace` (steps/http) is proof the wasm guest ran.
- The PRODUCT UI is stricter: `src/renderer/controller.ts` throws
  `'no plugin providers available'` when zero providers load → boot dies
  at `[ui] boot failed: internal` and nothing interactive ever renders.
  Offline first boot or a feed signed by a different key lands here.
- In-UI load proof: the `host:plugins` console line is dev-harness only.
  The product-UI signal is settings → diagnostics → providers row, which
  lists the loaded providerIds (e.g. `deezer, itunes, lyrics-lrclib,
  youtube-music`) — the row's contents are the proof, since the adjacent
  `last failure` field tracks playback, not plugin loading. Settings via
  the hamburger (≡) in the world toolbar → `settings` row. A broken/empty
  staged dir throws `no plugin providers available` at boot; an empty
  provider slot shows `sheets.noProvider` in the picker sheet.
- youtube-music `playback.resolve` takes an 11-char video ID as `source_ref`
  (e.g. `kJQP7kiw5Fk`), not a URL.
- Dev loops that need a fixture set WITHOUT the network: stage
  `<id>.wasm` + `<id>.manifest.json` pairs (legacy two-file format) into
  a scratch dir and pass `AUQW_PLUGIN_DIR=<dir>` — the utility skips the
  feed entirely and loads the set unsigned-set-style (host verifies only
  `artifact.digest` vs wasm bytes, no signature).
- youtube-music CAN resolve on this box — a bot-check on datacenter IPs is
  a possible failure, not a guaranteed one. A deezer search row pressed
  with no active queue starts a `radio · growing · youtube-music` session
  that fully plays (position + synced lrclib lyrics observed). Only a
  typed `guest failure (transient): transient: bot-check` is the known-bad
  path.
- `Ctrl+Shift+I` opens devtools in the window; the preload surface is then
  callable directly (`window.auqw.sync.pairing()`, `.status()`, `.stream.*`)
  — the fastest way to hit IPC paths with no UI control in the harness.

## Sync/pairing needs a secrets backend on this box

The pairing path is gated: `sync:pairing` throws
`unavailable — sync listener is unavailable` until the LAN listener binds,
and binding first needs the sync identity — a `sync:keys` custody round-trip
through main's `safeStorage`. With no `DBUS_SESSION_BUS_ADDRESS` and no
keyring running, `safeStorage.isEncryptionAvailable()` is false and custody
fails `unavailable` (status `fingerprint: null`). `--password-store=basic`
does NOT fix it on this box (Electron ignores it here). Working recipe:

```bash
dbus-run-session -- bash -c 'echo "" | gnome-keyring-daemon --unlock --components=secrets || gnome-keyring-daemon --start --components=secrets; exec env DISPLAY=:0 AUQW_DEV_HARNESS=1 AUQW_NODE_BINDINGS=… AUQW_PLUGIN_DIR=… <electron> <appdir> --no-sandbox --password-store=gnome-libsecret'
```

With secrets on the bus, custody succeeds, TWO wildcard listeners appear
(sync + pot), and `sync:pairing` returns a payload. The state survives
launches (`~/.config/auqw-desktop/secure/`); fresh userData needs a fresh
identity mint (a few extra seconds).

## Discriminating the utility's listeners

The utility binds two sockets — the POT service and the sync listener.
`GET /ping` answers `{"ok":true}` ONLY on the pot port;
the sync listener answers nothing. `POST /get_pot` confirms (200 + token).
`ss -tlnp` shows both owned by the `node.mojom.NodeService` child PID.

Address shape depends on custody (see 'Sync/pairing needs a secrets
backend'): with `AUQW_POT_LAN` unset the pot port binds `127.0.0.1`
immediately — `bindHost()` returns loopback without ever consulting
`lanReady`/custody, so a plain launch (no dbus-run-session, no keyring)
still gets a working pot listener while the SYNC listener stays dormant.
Only under LAN opt-in + successful custody do BOTH appear as
`0.0.0.0:<ephemeral>` wildcards.

## FOOTGUN reinforcement

The pgrep footgun above applies to ANY compound command whose own cmdline
contains `dist/electron` — including one that later launches electron with
env vars on the same line. Write launcher scripts to a file (or run the
kill as its own command).

## Sync / LAN-pairing legs (Slice 4)

- The utility-process sync server binds `0.0.0.0` on an **ephemeral port** —
  read it from the settings sync panel's `this device` row (`ip:port`), not
  from code. It needs `org.freedesktop.secrets` (gnome-keyring) up or
  safeStorage fails and no sync identity can mint — launch with
  `DBUS_SESSION_BUS_ADDRESS=$(cat /tmp/dbus-addr)` + a live keyring daemon
  and `--password-store=gnome-libsecret`.
- `sync:pairing` IPC mints a 6-digit offer (90s TTL, single-slot — each mint
  replaces the last). On `s4/alpha-fixes`+ the `pair a device` row opens a
  real sheet: QR (uqr single-path SVG, decodable with `zbarimg -q --raw`
  on a zoomed screenshot), big PIN, `…or type the code and address ip:port
  · expires in 2m`, `copy payload`; mint failures surface inline under the
  row as `pairErrorLabel`. Fallback mint via devtools still works:
  `window.auqw.sync.pairing().then(o=>document.title='C'+o.code)` then read
  the title via `wmctrl -l`. Reject reasons map client-side: 'no-pairing' /
  'pairing-expired' both render as 'no live pairing window on the desktop'.
  STALE-ERROR TRAP: that error text persists in the phone UI until the next
  attempt lands — a tap that MISSES the pair button leaves the old error
  looking like a fresh rejection. Confirm each attempt actually fired (peer
  row state changes, or desktop sessions count), don't trust the label.
- Emulator→host path: the emulator reaches the host listener at
  `10.0.2.2:<port>`; mDNS will never cross the NAT, so the typed-code +
  manual-endpoint form is the only path (it exists in
  `packages/ui-native/src/sync-screen.tsx` — code/address/port + `pair`).
- **Gboard floating toolbar trap**: focusing a phone TextInput pops a
  floating toolbar that can overlay the `pair` button; `input tap` then hits
  the toolbar, not the button — silent no-op while a stale error label makes
  it look like a failed attempt. Press `keyevent 111` (ESCAPE) after typing
  to dismiss it, then verify the button is unobscured before tapping.
  SECOND TRAP: the `pair` button MOVES when the keyboard opens/closes —
  compute tap coordinates from the CURRENT screencap, not a stale one
  (adb screencap px → device px scale ≈1.53 on a 1080×2400 screen in a
  706-px-wide PNG).
- Phone TextInput quirks: `input text "10.0.2.2"` may drop the periods
  (only `10` lands) — type digits via `input text` and periods via
  `input keyevent 56` (KEYCODE_PERIOD), then screencap to verify before
  tapping pair.
- Emulator launch needs `kvm` group membership on this box even though
  /dev/kvm exists: `sudo -n gpasswd -a ubuntu kvm` once, then run the
  emulator via `sg kvm -c "DISPLAY=:0 $HOME/Android/Sdk/emulator/emulator
  -avd auqw -gpu swiftshader_indirect -no-snapshot"` — `sg` applies the
  group without a re-login. `x86_64 emulation requires hardware
  acceleration` + silent death otherwise.
- Release APKs are per-ABI after the split (`outputs/apk/release/
  app-<abi>-release.apk`). R8/shrink can break JNI-reflected classes —
  smoke-test a release APK, don't assume debug parity: install + launch +
  `adb logcat` for `UnsatisfiedLinkError`/`NoClassDefFoundError`. Real
  catch on this branch: R8 stripped JNA's `com.sun.jna.Pointer.peer` (the
  .so ships, the Java field doesn't survive `-dontwarn` alone) → dead on
  boot, fixed by `-keep class com.sun.jna.** { *; }` +
  `-keepclassmembers` appended by `with-release-abis.cjs`.
- The sync journal is on disk at `~/.config/auqw-desktop/sync-log.jsonl` —
  one delta doc per line with `entries[]` + `watermarks`; diff it to prove a
  round applied (`cursor` shows both device ids after a real sync).
- `copy delta` / `paste delta` (delta exchange row in the settings sync
  panel) round-trips the whole journal via clipboard — `xclip -o -selection
  clipboard > file` to capture, `xclip -i < file` to re-seed before pasting
  (clipboard dies when the owning app quits). Fresh-profile check:
  `rm -rf ~/.config/auqw-desktop` → relaunch → paste delta → library
  collections repopulate.
- ui-web clipping bug (FIXED on `s4/alpha-fixes`+, present on earlier
  branches): `.uw-screen{flex-column}` + `.uw-card{overflow:hidden}`
  invisibly clips trailing settings rows + the transfer preview's
  `apply import` when the CSS viewport is short — rows exist in the DOM but
  paint nothing. Workaround on old branches: `ctrl+minus` zoom-out.
- Desktop `import library` cancel latch (FIXED on `s4/alpha-fixes`+):
  cancelling the GTK dialog now resets `importPhase` to `idle` — the
  `showOpenFilePicker` AbortError path (the one Electron always takes,
  Chromium ≥86) and the hidden-input fallback `cancel` event (webviews
  without the API) both recover. On older branches a cancelled pick latches
  `reading` forever; recovery was `ctrl+r` renderer reload.
- Phone-side LogBox noise: tapping catalog results fires uncaught promise
  rejections — artwork cache race `FileSystemFile.move` →
  `NoSuchFileException …/cache/artwork/<hash>.img.dl`. In dev builds they
  surface as red LogBox toasts that eat screen space and taps; dismiss via
  the toast's X or `keyevent 4` to close the expanded LogBox.
- youtube-music resolve bot-checks on datacenter IPs — expected, NOT a
  regression. Verify it surfaces cleanly: tapping a track opens the player
  sheet which shows the typed inline error `guest failure (transient):
  transient: bot-check` — that's the correct surface, not a crash.

## Capturing precise pipeline timings (no stopwatch needed)

`ELECTRON_ENABLE_LOGGING=1` in the launch env forwards renderer
`console.*` to the launch shell's stderr as `[INFO:CONSOLE:line]`
lines — including logs from `packages/*` code bundled into app.js.
For latency evidence, temporarily add `console.log('MARK', Math.round(
performance.now()), ...)` lines at the points of interest (e.g.
peaks-tracker's pull/store-load/onCoarse/settle, and a render-signature
log inside `useWaveformPeaks`'s return). Build (`pnpm build`) — esbuild
bundles @auqw/* from source so edits land in dist — then grep the
launch log for the marks. Revert the edits and rebuild when done;
console.log in tracker code also runs under node in unit tests
(harmless noise) but should not be committed.

## peaks_cache / sqlite verification

The app DB is `~/.config/auqw-desktop/auqw.db` (userData). sqlite3
lives at `~/Android/Sdk/platform-tools/sqlite3` on this box:

```
~/Android/Sdk/platform-tools/sqlite3 ~/.config/auqw-desktop/auqw.db \
  "select recording_id, length(peaks_json), fetched_ms from peaks_cache; \
   select version from schema_version;"
```

`delete from peaks_cache` before a run forces an honest cold
(store-miss) extraction; a relaunch then replays to a store-hit.

## stream:probe / IPC seam probing via devtools

Every `window.auqw.stream.*` call is usable from devtools
(Ctrl+Shift+I) on either page. The dev-gate harness prints the handle
(`dev-prepared st-0-0 (audio/webm)`), so a probe can be driven
directly:

```
window.auqw.stream.probe({handle:'st-0-0',position:4000000,maxLen:65536,fetch:false})
// hole -> {data:'', total:N, eof:false}; fetch:true -> bytes + ONE ranged
// GET at that offset; same fetch:false after -> bytes with NO new request
```

Peek (fetch:false) proves sparse-store commit; the ranged fixture log
proves the positional fetch. Probe at an offset past the prepare-time
speculative head fill (~3 MiB on the box) or it serves committed bytes
and you learn nothing.

## New IPC channels need fwd() in main's table — easy to miss

A new `CHANNELS.*` entry + preload invoke + utility napiCall is NOT
enough: `src/main/ipc.ts` must also forward it (`fwd(CHANNELS.x, isXArgs)`).
Missing fwd → renderer sees `Error invoking remote method 'x': Error:
No handler registered for 'x'` and feature code silently falls back.
Found live on the waveform PR (stream:probe unwired → sampled path
never ran). A contract sweep now exists in ipc.test.ts asserting every
preload invoke has a main-side registration.

## youtube-music waveform-path specifics

- Product UI radio sessions resolve audio/webm opus on this box —
  exercises the sampled webm extractor (needs >4 MiB total AND <8 min
  declared duration; a 7-min track at ~130 kbps is ~7 MB — safe pick).
- Cold sampled run observed: pull->store-miss ~4ms, coarse profile
  ~335ms, first rendered bars ~340ms, refined profile ~790ms.
- Store-hit replay after app restart: pull->hit ~5ms, bars same tick,
  zero probe traffic. In-session replays hit the tracker's MEMORY
  cache instead — store-load never fires; app restart is required to
  prove the persisted path.
- itunes/deezer catalog rows feed metadata only; playback always
  resolves through youtube-music regardless of catalog provider.

# Suggested additions to testing-auqw-desktop-electron (verified 2026-09-30 on devin/1790807912-tab-latency)

## World (top-level) tab notes — keep-alive era
- **Settings is NOT a tab pill on desktop.** WorldTabs shows only
  home/explore/library; settings = the `≡` WorldMenu at the world-bar's
  right end → "settings" row. Automation should click ≡ then the row.
- **World-bar start icons move to the far left when the stage column is
  hidden.** With the stage open they sit at ~x389/412 (screenshot space);
  stage closed they jump to ~x82/104. The ≡ menu and window controls stay
  far-right regardless. Re-map before clicking.
- **<860px real width breakpoint**: the stage column becomes a floating
  overlay with a dimming scrim (`uw-stage-scrim`) over the world column —
  the whole world column looks dimmed + a small ✕ appears. Click the dim
  area to dismiss (collapses the stage back). This is designed behavior,
  not a modal bug.
- **Electron enforces a ~522px real minimum window height** — `wmctrl -e`
  requests below that get clamped silently (`wmctrl -lG` reports the
  clamped size). And a maximized window ignores `-e` entirely — remove
  `maximized_vert,maximized_horz` first.
- **Scroll-preservation trick for keep-alive testing**: shrink the window
  (e.g. 700x522) so a short pane's content overflows — then scroll,
  switch tabs, back. The library pane is nearly empty on a fresh profile
  and won't scroll at desktop size.
- **Local folder scans land recordings in sqlite but NOT in the library
  pane list.** `settings → add local folder` (GTK dialog) imports files —
  verify via `sqlite3 ~/.config/auqw-desktop/auqw.db
  "select count(*) from recordings"`. Local recordings surface ONLY via
  search (`local:` provenance, same as mobile). To give the library pane
  content, create a playlist via a catalog row's list-plus tail button →
  "new playlist" → name → the card lands in "your library".
- **Row actions sheet on catalog rows has NO 'like'** — only
  enqueue/playlist/album/artist. Liking is recording-kind only.
- **Keep-alive instrumentation (devtools Ctrl+Shift+I)**: stash node refs
  then switch tabs via UI and re-check identity — the definitive
  no-remount proof:
  `window.__p=document.querySelector('.uw-world__content').children[2];
   window.__inp=document.querySelector('input[data-autofocus]')` → after
  switches `children[2]===__p` and `querySelector('input[data-autofocus]')===__inp`.
  Pane divs: active = inline `display:contents`, hidden = `display:none`
  + `inert` + `aria-hidden="true"`, each with mounted children.
- **`/` global shortcut**: document keydown on the chrome —
  focus-search action selects explore + refocuses the input in place
  (no remount). While the input is focused, '/' inserts literally
  (editable guard) — correct, not a bug.
- **youtube-music bot-check surface**: row press → NOW PLAYING shows the
  track with 'couldn't play' + warn glyph + 'radio · growing' UP NEXT
  fills; player pane shows 'the provider is refusing requests right now
  · sign in to fix playback'. Expected on datacenter IPs — the queue
  still populates and stage panes stay exercisable.

## Devin Secrets Needed

None — the napi artifact is a local cargo build output.

## Verified 2026-10-01 on devin/1790860626-desktop-sidebar (PR #240)

- **HiDPI click geometry**: this box's display is 3200×2400 while the
  computer-tool space is 1024×768 (scale 3.125). An `800×700` window
  covers only ~255×224 tool px, and KDE adds ~16px x / ~0px y frame
  offset (innerW 768 vs outer 800) so real_x = window_x + 16 + css_x.
  A 32-css-px control is ~10 tool px — a 1-2 px mapping slip lands in
  the `-webkit-app-region:drag` strip and silently no-ops. When a small
  control "won't click", verify the real rect before calling it a bug.
- **CDP ground truth**: relaunch with `--remote-debugging-port=9222`,
  then `curl localhost:9222/json` → `webSocketDebuggerUrl`. Python
  `websocket-client` needs `suppress_origin=True` (else 403). Use
  `Runtime.evaluate` for DOM state (`data-stage` on `.uw-chrome`,
  `elementFromPoint`, `getBoundingClientRect`) and
  `Input.dispatchMouseEvent` press+release for trusted input.
- **JS `.click()` DOES fire IconButton onPress** — `IconButton` binds
  `onClick={onPress}` (primitives.tsx), and `el.click()` dispatches
  directly on the element with NO hit-testing — it fires even when the
  button is covered. If `.click()` appeared to no-op, the element was
  wrong (e.g. `data-stage`-first-button vs a different control),
  disabled (`uw-off` clears onClick), or the instance was corrupted —
  coverage/coordinate misses only affect REAL pointer input, never
  programmatic clicks.
- **Stage toggle = `.uw-world-bar__start button[0]`** with aria
  'show player'/'hide player' (NOT 'stage'); `data-stage` on
  `.uw-chrome` flips open/closed — the cheapest state probe.
- **'update available' notification pill** is the renderer's separate
  `updateBanner` render (app.tsx) — `position:fixed; z-index:40`,
  centered top (stacks under the offline pill when both are up), NOT
  an overlayStack entry — while shown it can COVER world-bar controls
  (observed over `__start`: toggle + search); elementFromPoint returns
  its `uw-text` span and real clicks on the controls hit the pill. If
  bar controls seem dead, check for the banner first.
- **Escape is NOT bound on the stage overlay** — Escape lives in
  stack.tsx sheets (menu popover, pushed pages). Escape doing nothing
  on the floating stage is correct-by-design, not a regression.
- **GPU FATAL flake**: `GPU process isn't usable. Goodbye` killed one
  instance mid-run on this GPU-less box; a respawned window appeared
  shortly after (different PIDs, parented to a foreign shell).
  Verify process parentage/env before trusting a "recovered" window —
  a foreign-shell instance may lack AUQW_NODE_BINDINGS/PLUGIN_DIR.

# Learned while E2E-testing history dedup

## Verify the build actually contains the code under test

- `git branch --show-current` is not enough: the shared checkout drifts
  between branches mid-session. Grep the BUNDLE for a code marker unique to
  the change: `grep -o "unique-fragment" apps/desktop/dist/renderer/app.js`.
  (For the history-dedup change: `hist-${recording` = new, `hist-${event` =
  old.) Building `main` overwrites dist — after any branch switch, rebuild.
- `/tmp/electron-dist` survives the shared-checkout node_modules churn —
  copy `node_modules/electron/dist` there once and launch from it.

## Clean-slate database prep

- `rm -rf ~/.config/auqw-desktop` — deleting only `auqw.db*` leaves
  `sync-log.jsonl`/`streams/` which REPLAY persisted events on next boot
  (old play_history rows reappear; local recordings get double-committed).
  The local-folder grant lives in renderer Local Storage + `local_sources`
  rows — deleting `auqw.db*` keeps neither intact (sync-log replays it),
  but a full `rm -rf` wipe removes both, so re-add the folder afterward.
- Ground truth: `sqlite3 "file:$HOME/.config/auqw-desktop/auqw.db?mode=ro&immutable=1"`
  (expand `$HOME` — `~` fails inside the URI). Key tables:
  `recordings` (title, provenance), `source_refs`, `queue_occurrences`,
  `queue_state`, `play_history` (played_ms, occurrence_id), `play_counts`.

## Deleting queue rows without breaking restore

- Deleting `queue_occurrences` + `queue_state` → next boot shows
  "couldn't restore your library". Fix WITHOUT losing other data:
  keep (or reinsert) the singleton row
  `INSERT INTO queue_state VALUES (1,0,NULL,0,'stopped',NULL)` and do a
  FULL relaunch — the UI's "retry" button does NOT re-run restore.
- play_history.occurrence_id may reference deleted occurrences — harmless.

## Counted plays via local files (provider playback is often dead — bot-check)

- Counted-play rule: a play counts once listenedMs ≥ 120s OR ≥ 50% of
  duration. ~4s ffmpeg sine fixtures count in ~2s of real playback.
  Fixtures: `ffmpeg -f lavfi -i "sine=frequency=440:duration=4" -metadata
  title="Alpha Song" -metadata artist="Test Artist" /tmp/auqw-music/a.mp3`.
- Desktop surfaces no `local:` search rows unless the renderer ports memo
  sets `localCatalog: true` (apps/desktop/src/renderer/app.tsx ~line 674) —
  test-only flip; rebuild + revert after.
- Add the folder via menu → settings → "add local folder"; GTK dialog:
  Ctrl+L, type the absolute path, click the "Open" BUTTON — pressing Enter
  returns "nothing came back" (empty selection).
- Dedupe key is `${occurrenceId}#${listenCycle}` — a plain replay of the
  same occurrence does NOT re-count, but `bumpListenCycle` gives repeat-one
  loops and repeat-all wraps a fresh cycle, so each loop counts once
  (playback-engine.ts `#maybeRecordPlay`). Easiest second play of the same
  song: put the ~4s fixture on repeat-one and let it loop — it counts per
  pass. When repeat is hard to drive, the deterministic path is:
  empty the queue (`delete from queue_occurrences`, keep `queue_state`),
  relaunch, then press the row — `session.playRecordings` replaces the
  queue (dedupe is gone) and mints a fresh occurrence → a real counted
  play.
  Alternatives (repeat-all wrap / 'add to queue' sheet) are hard to drive:
  the transport only renders on the 'player' segment DURING playback (~4s
  window on fixtures; icons ~y721: pause≈199, next≈220, repeat≈231 tool
  coords on 1024x768) and the `local:` row's action sheet did not open via
  right-click or its trailing hover icons (observed).
- xdotool XF86 media keys / playerctl do NOT reach the app (no MPRIS wiring
  observed on this box).

## Verification pattern that discriminates dedup

- Seed events [A,B,C,A] → deduped History shows exactly 3 rows
  [A,C,B-newest-first]; old behavior shows 4 rows with A at positions 1 & 4.
  Cross-check: `top 50` collection shows per-recording play counts
  (A = "2 plays") proving raw play_history events stay intact.

## CDP input + measurement (post-#274/275)

- `dispatchEvent(new MouseEvent('click'))` may not reach React's
  synthetic handlers — use CDP `Input.dispatchMouseEvent`
  (mousePressed/mouseReleased at real coords). `Input.insertText` types
  into focused inputs; `Input.dispatchKeyEvent` Enter submits.
- File inputs can't drive the native dialog — `DOM.setFileInputFiles`
  on the input + dispatch a `change` event; the app's real onChange
  path consumes the file and runs the full flow.
- Scoped CSS custom props: `getComputedStyle(el).getPropertyValue('--x')`
  — documentElement returns "" for vars defined on a subtree.
- Transient states (skeleton flashes, sub-100ms phases) — instrument a
  MutationObserver logging mount/attribute changes with timestamps;
  don't chase screenshots. A slower catalog provider (itunes) widens
  the window when a visual is needed.
- CSS-animation proof without video: sample `getComputedStyle(el)` props
  (opacity/transform) via repeated `Runtime.evaluate` at ~45ms intervals
  — changing values = animation running; sample in wall time since rAF
  may be throttled.

## Engine internals + media-session OS surface (MPRIS) probes

- The built bundle (`apps/desktop/dist/renderer/app.js`) is MINIFIED
  since #320 — one giant line, and `keepNames` preserves a name only
  as the string arg in a `__name(fn,"publishMetadata")` wrapper —
  `function publishMetadata` does NOT survive as text. Verified anchor:
  grep the quoted name (`rg -o '.\{60\}"publishMetadata".\{20\}'`)
  to find the `__name` call site, which names the minified identifier
  (`je` there) — splice `console.warn('parkdbg', ...)` inside that
  function or at its call sites. No source edits; wiped by the next
  rebuild (`pnpm --filter desktop build`). Pre-#320 builds were
  unminified — same recipe, nicer anchor points.
- Chromium deactivates `navigator.mediaSession` AT the element's `ended`
  event: the bus reads `Stopped` + `mpris:length=0` + `CanPlay=false`,
  `playerctl play` is refused, and neither `playbackState` writes,
  metadata republishes, nor rewinding `currentTime` revives it — only a
  real `play()` call resurrects the card. Since the queue-end keep-alive
  work, the web port intercepts ~80 ms short of the real end instead, so
  `ended` never fires: a parked card reads `Paused` + `CanPlay=true`
  with position ≈ duration−80 ms while the queue row reads 0 — expected,
  not a bug (the element rewinds on the OS `play` press).
- On a checkout that already has the built binding, launch needs no
  `AUQW_NODE_BINDINGS` — the default resolves
  `target/debug/libauqw_node_bindings.so`; a wrong explicit value is the
  common cause of "couldn't start". Pass it only when the checkout lacks
  the built piece (see Launch). `AUQW_PLUGIN_DIR`'s dev-mode default covers
  this checkout's staged set (see the provider/plugin-path notes).
- mp3 fixtures are `doc_id`-bound by PATH: fingerprint/size are
  scan-time fields and play does not re-verify, so a same-path file with
  different audio still plays under the fixture's doc.
- `/tmp` wipes between sessions — keep fixtures and launch scripts
  re-createable from scratch (seeded local dirs, feed configs).
- `playerctl position N` absolute-seek compresses long tracks for
  end-of-track tests — seek near the tail instead of waiting out the
  duration.

## Queue restore + autoplay legs (post-#289)

- `queue_state`/`queue_occurrences` rows DO rehydrate on relaunch —
  `restore()` loads them into the QueueEngine and parks the cursor
  paused (restore never auto-plays), so the player surface reads
  'nothing playing' even with a full queue — check the queue pane,
  not the player, for seeded rows. A malformed seed (missing columns,
  bad mode enum) instead surfaces 'couldn't restore your library'.
- Reaching an autoplay section: `playback.resolve` is bot-checked so
  `selected_provider` stays null, and the 'start radio' chip gates on
  `selectedRef ?? sourceRefs[0]` being radioSeed-capable (only
  youtube-music). Trick: while the app is stopped, seed
  `INSERT INTO likes VALUES ('track', <id of a youtube-music:0
  recording>, <ms>)`, relaunch → it tops 'your latest liked tracks' →
  play it → the queue auto-arms the tail ('autoplay · similar to
  {title}', 49+ rows). Delete the like afterwards.

## Verified 2026-10-02 on devin/1790972281-build-size-wins (PR #320)

## POT legs without a secrets backend

- `pot.bind()` is NOT gated on sync custody: with `AUQW_POT_LAN` unset,
  `bindHost()` returns `127.0.0.1` immediately — the lanOptIn check
  never consults `lanReady`/custody. A plain launch still gets a working
  `127.0.0.1:<ephemeral>` pot listener; only the SYNC listener stays
  dormant. `ss -tlnp | grep <utility-pid>` then shows exactly one
  listener; `/ping` → `{"ok":true}` and
  `POST /get_pot -d '{}'` → `{"error":"invalid-request","message":
  "pot: content_binding must be a bounded string"}` — the envelope is
  `{"error","message"}`, not bare text.

## /get_pot as a runtime probe of the pot-minter child

- A real mint `POST /get_pot {"content_binding":"<str>"}` forks
  `dist/utility/pot-minter-child.cjs` as a node child of the utility
  PID (`ps -eo pid,ppid,cmd | grep pot-minter`). The child stays
  resident after the request (shared session engine).
- On datacenter egress the mint ends in typed
  `{"error":"unavailable","message":"pot: no ytAtN challenge on
  homepage"}` — the child fetched + regex-parsed the homepage
  (`challengeFromHomepage` matches `window.ytAtN(…)` in raw html — no
  jsdom yet) but no BotGuard challenge was served. `new JSDOM` only
  runs later in `botGuardSandbox`, so this response proves the child
  fetched the page, NOT that its jsdom bundle works — that needs a
  served challenge, or static proof: `pot-minter-child.cjs` is a
  separate esbuild bundle the stub alias never touches (size ~6 MB
  ≈ jsdom inside). That is the DESIGNED honest-degradation path — the
  utility logs `pot: session build failed (…)` once, no crash.
  Distinguish wiring bugs: they'd print `jsdom is not bundled in the
  utility process` (stub throw, post-#320) or kill the utility.
- youtube-music playback resolve does NOT depend on a successful
  mint — resolves/plays fine with the pot session unavailable.

## Diagnostics 'attempt trace' = resolve ground truth

- settings → DIAGNOSTICS → `attempt trace` prints
  `N attempt · last: wreq-<n> · <steps> steps · <http> http · <dur>`
  after any playback resolve — cheap proof a resolve ran without
  scraping logs. Adjacent `last failure` reads `none` after success.


## Typed discovery/search UI (verified 2026-10-03, deezer catalog)

- Chips row `.uw-search__chips` tops the explore pane (~y28 tool-px
  maximized; all, songs, artists, albums, playlists, 'in your library').
  Chips are ~25 px apart — re-zoom before clicking; a 2-3 px slip hits
  the neighbor.
- Kind chips re-query scoped (`kinds=artist` etc.): results head
  becomes `<kind> · N`, entity rails only. 'all'/'in your library' do
  NOT refetch — 'in your library' narrows the live page locally.
- Hero (`uw-topres`) tracks the scoped kind — a kind chip can swap a
  track hero for an entity hero.
- Entity pages push as overlays (back chevron ≈ x396,y9). Artist page:
  'discography' + 'related' rails sit BELOW a long top-songs list —
  scroll the world pane. A 'partial page — some sections are
  unavailable upstream' warn banner is the designed honesty notice.
- Pagination is an EXPLICIT 'load more' button (`uw-load-more`) at the
  bottom of the track list, not scroll-append. Small target
  (~x709,y736); a few-px miss silently no-ops. Verify append via
  results-head growth (55 → 104) + row indices past SEARCH_LIMIT=25;
  base rows stay mounted, no skeleton.

## sqlite ground truth for entity likes/pages

`~/.config/auqw-desktop/auqw.db`:
- `entities(entity_id, kind, title, artist_name, artwork_json)` — one
  row per materialized entity page/like.
- `entity_source_refs(entity_id, provider, ref_json)` — ref_json
  carries `{"id","kind","provider"}`.
- `likes(entity_kind, target_id, liked_ms)` — entity_kind in
  track/album/artist/playlist; target_id = entity_id for entity likes.

Fastest like→library closed loop: heart a playlist on its entity page,
open the 'in your library' chip — shows exactly that card, head
'in your library · 1' (persistence AND local filtering in one screen).

## Entity pages + stage meta links (verified 2026-10-03, PR #347)

- Hero tells kind at a glance: artist art is a CIRCLE, album/playlist
  square; blurred backdrop wash behind art+title; accent 'play' pill
  sits left of '≡ shuffle'. Play pill → ordered playback (queue
  replaced, starts at track 1, origin 'playing from <entity>').
- Full-player meta links are ~8px text bands — re-zoom before
  clicking; a few-px slip lands on the adjacent line and a click on
  the album line while that album page is already open is an
  invisible no-op (looks like a dead link — verify at ink).
- Inert-recording recipe: seed a LOCAL file (counted-play recipe
  works) — provenance `local` means NULL artist/album refs → meta
  lines render plain text, clicks navigate nowhere. itunes rows are
  NOT an inert case: itunes emits `artist_ref`/`album_ref` on its
  track rows (links render live).
- sqlite: recordings carry `artist_ref_json`/`album_ref_json`
  (schema v17) — provider rows filled (e.g.
  `{"id":"27","kind":"artist","provider":"deezer"}`), local row NULL.

## Misc legs

- `/` and other chrome keyboard shortcuts need the auqw window to hold
  X focus first — click inside the window once, THEN send keys; a bare
  `key slash` on a freshly-mapped window may go nowhere.
- Verifying a minified build actually landed (post-#320): `wc -l
  apps/desktop/dist/renderer/app.js` (a handful of lines, not
  thousands) + grep the utility bundle for feature markers (e.g.
  `jsdom is not bundled` for the stub).
- The settings menu (≡) rows sit ~6px lower than first-glance
  coordinates on this display scale — zoom the popover before
  clicking; a click on the row's top edge dead-zones.
- sqlite only keeps the LATEST queue — `queue_occurrences` is replaced
  wholesale per queue write. Grab 'playing from {entity}' origins and
  ordered up-next lists visually before playing something else; the db
  can't reproduce prior queue state.
