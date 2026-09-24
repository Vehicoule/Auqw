---
name: testing-auqw-desktop-electron
description: How to launch and exercise the auqw Electron desktop shell (apps/desktop) live on the X desktop — env knobs, dev-gate audio path, ranged fixture, and how to prove sound on a VM with no audio device.
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
  binary in the npm tarball): `cd node_modules/electron && node install.js`.
  Warm `~/.cache/electron/*.zip` makes it instant; cold it downloads ~230 MB.
- Kill stale instances first or the single-instance lock silently quits the
  new one: `pgrep -f "dist/electron \." | xargs -r kill` (the npm wrapper PID
  differs from the real binary — match the binary path pattern). FOOTGUN:
  never put that kill inside a compound shell command whose own cmdline
  contains `dist/electron .` — pgrep matches the shell itself and xargs kills
  it mid-run. Run the kill as its own command, or use a self-immunizing
  pattern like `"[d]ist/electron"`.
- Launch on the visible desktop, in a pollable shell:
  `cd apps/desktop && env DISPLAY=:0 AUQW_NODE_BINDINGS=/abs/path/libauqw_node_bindings.so <repo>/node_modules/electron/dist/electron .`
  (electron lives at the repo-root node_modules).
- `AUQW_NODE_BINDINGS` matters: `AUQW_REPO_ROOT` only points at the launch
  checkout's `target/debug`, which may lack the artifact — pass the absolute
  path of a real `libauqw_node_bindings.so` (cargo debug build). The host
  stages it to `userData/node-bindings/auqw_node_bindings.node` before
  `require()`. Missing/broken → `host:plugins: unavailable` in diagnostics.
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

## Proving sound on a VM with no audio hardware

This box has no `/dev/snd`, no pulseaudio/pipewire, and `pactl` is absent —
physical audibility cannot be captured. Two proxies constitute the
end-to-end proof:

1. `posMs` advancing in `playing` state — the element's clock is driven by
   the audio render pipeline; a failed fetch/decode yields `failed` or a
   frozen `buffering`, never advancing time.
2. The fixture's request log showing `-> 206` responses — proves bytes
   flowed upstream → Rust loopback → renderer.

Show `tail -f` of the fixture log in a konsole beside the window during the
recording so reviewers see range pulls live.

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
  A stale peer record (old port) must be `unpair`ed first; same-fingerprint
  re-pair updates endpoints+pot in place.
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
- Plugins do NOT load in dev mode unless you pass
  `AUQW_PLUGIN_DIR=/abs/path/to/apps/desktop/plugins` — main only defaults it
  for packaged builds. Without it `#provider` stays empty and the provider
  path logs `prepare failed — no plugins loaded`.
- youtube-music `playback.resolve` takes an 11-char video ID as `source_ref`
  (e.g. `kJQP7kiw5Fk`), not a URL.
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

The utility binds two `0.0.0.0:<ephemeral>` sockets — the POT service and
the sync listener. `GET /ping` answers `{"ok":true}` ONLY on the pot port;
the sync listener answers nothing. `POST /get_pot` confirms (200 + token).
`ss -tlnp` shows both owned by the `node.mojom.NodeService` child PID.

## FOOTGUN reinforcement

The pgrep footgun above applies to ANY compound command whose own cmdline
contains `dist/electron` — including one that later launches electron with
env vars on the same line. Write launcher scripts to a file (or run the
kill as its own command).

||||||| 4ccc375
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

## Devin Secrets Needed

None — the napi artifact is a local cargo build output.
