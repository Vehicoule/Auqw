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
- Kill stale instances first or the single-instance lock silently quits the
  new one: `pgrep -f "dist/electron \." | xargs -r kill` (the npm wrapper PID
  differs from the real binary — match the binary path pattern).
- Launch on the visible desktop, in a pollable shell:
  `cd apps/desktop && env DISPLAY=:0 AUQW_NODE_BINDINGS=/abs/path/libauqw_node_bindings.so /tmp/dshell/node_modules/electron/dist/electron .`
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

## Devin Secrets Needed

None — the napi artifact is a local cargo build output.
