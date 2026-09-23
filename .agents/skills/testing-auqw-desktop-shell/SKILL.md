---
name: testing-auqw-desktop-shell
description: How to run and exercise the apps/desktop Electron shell on this box — PATH, lazy Electron install, real display vs xvfb, frameless-window quirks (KWin shadow margins, wmctrl close), single-instance and window-state checks.
source: session s4/desktop-shell testing
---

# Testing the auqw desktop shell (apps/desktop)

> **Scope:** `apps/desktop` lands via PR #22 (`s4/desktop-shell`). Until it merges, check out that branch before running anything here.

## Run it

- Node is NOT on the default PATH — always `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH` first.
- Build: `cd apps/desktop && pnpm build` (esbuild → `dist/`; `dist/` is gitignored, rebuild if stale).
- Electron 44's npm package ships no binary: if `node_modules/electron/dist/electron` is missing, run `cd node_modules/electron && node install.js` from repo root — it lazily downloads (~230 MB).
- Launch on the real KDE display: `cd apps/desktop && DISPLAY=:0 ../../node_modules/.bin/electron . --no-sandbox --disable-gpu --enable-logging > /tmp/auqw-electron.log 2>&1 &`
  - `--no-sandbox` is required on this box (SUID chrome-sandbox is not set up) — it is a **test-only** flag for this throwaway VM; the app's own `webPreferences` keep `sandbox: true` + `contextIsolation: true`, so the flag only strips Chromium's OS-level isolation here, never in shipped config.
  - `--enable-logging` pipes renderer `console.log` to stdout as `INFO:CONSOLE` lines — grep the log for `auqw meta`, `auqw utility:ping`, `auqw net:snapshot` as IPC evidence.
  - Headless alternative: `xvfb-run -a ... electron .` works too, but a visible window on :0 is better for recordings (display :0 is KDE Plasma @1600x1200 VNC; the lead's smoke runs may occupy xvfb :99 with `--user-data-dir=/tmp/auqw-smoke` — different display, don't kill it).

## Frameless-window quirks (titleBarStyle: 'hidden' on Linux)

- No native titlebar. Objective check: `xprop -id <wid> _NET_FRAME_EXTENTS` → property absent (=0 extents). The — □ × glyphs at the window's top-right are Electron's in-window overlay buttons, not WM decorations.
- KWin adds invisible drop-shadow margins, so `wmctrl -lG` reports frame geometry ~16px left / 10px top / +32w / +42h LARGER than Electron's `getNormalBounds()` (what lands in window-state.json). When verifying persistence, compare relaunch `wmctrl -lG` against the PRE-CLOSE `wmctrl -lG`, not against your `wmctrl -e` args.
- No drag handles — move/resize via `wmctrl -r auqw -e 0,x,y,w,h` (real resize/move events fire; state debounce is 400 ms, wait ~1 s before checking the file).
- NEVER kill -9 to close: the sync save runs on the 'close' event. Use `wmctrl -c auqw` (WM_DELETE → close → saveWindowStateSync → window-all-closed → app.quit). A graceful close also proves the quit path.
- Minimize for the single-instance test with `xdotool windowminimize <wid>`; find wid via `xdotool search --name '^auqw$'`.

## What to verify (state locations)

- Placeholder page: heading "auqw — desktop shell up" + dl fields `version` 0.1.0, `platform` linux, `userData` ~/.config/auqw-desktop, `utility:ping` "pong (hello from renderer)", `net` online, `net transition` online (subscribe pushes current state immediately).
- Window state: `~/.config/auqw-desktop/window-state.json` (JSON {width,height,x,y,maximized}); delete it + stale `Singleton*` files for a clean run.
- Seeded x/y are only applied when they intersect a connected display's workArea (`intersectsDisplay` in `apps/desktop/src/main/index.ts`) — an off-screen position is silently dropped and the WM places the window; on-screen positions restore exactly. To test the gate: seed x=4000,y=3000, expect the window on-screen anyway.
- Single-instance: a second `electron .` exits ~0.2 s (lock refused → app.quit); the first window un-minimizes + focuses. `wmctrl -l` must still show exactly one `auqw` window.

## Devin Secrets Needed

None — all local.

## Sync service (`window.auqw.sync.*`, s4/sync-transport)

Renderer API is `window.auqw` (preload exposes `api` as `auqw`), not `window.api`: `status / pairing / devices / unpair / deltas / importDelta / trigger`. DevTools = Ctrl+Shift+I separate window; top-level `await` works in its console. Rejections surface as `Error` with `.kind` set.

`status()` → `{listener, endpoint, boundPort, advertise, pairedDevices, sessions, lastSyncAt, engine, name, fingerprint}`; `engine:'absent'` until the sync-engine leg lands. Pairing mints a fresh 6-digit code + payload `{v,endpoint,code,fp}` (~90 s TTL, `codeTtlMs`).

### No OS keystore on this VM → safeStorage degrades honestly

kwalletd5 crashes on dbus activation; Electron 44 ignores `--password-store=basic|mock`; no gnome-keyring → `safeStorage.isEncryptionAvailable()` is false → custody `unavailable` → sync `start()` fails before binding → `status()` reports `listener:'unavailable'` honestly (on a real desktop with a keyring this does not happen).

Test-only unlock (plain-text backend — exercises the real SecureStore→safeStorage IPC; never production evidence):

1. Launch electron with `--inspect=9330` + `--remote-debugging-port=9222`.
2. `node scripts/cdp-inspect.mjs 'process.mainModule.require("electron").safeStorage.setUsePlainTextEncryption(true); ""+process.mainModule.require("electron").safeStorage.isEncryptionAvailable()'` → `true`.
3. `kill $(pgrep -f "node.mojom.NodeServic[e]" | head -1)` — the auqw utility child respawns after ~100 ms and re-runs `start()` → `listener:'listening'` + real `boundPort`. Keys persist under `~/.config/auqw-desktop/secure/*.b64`; wipe `~/.config/auqw-desktop` for a fresh identity.

### Proving the sync seam end-to-end

- Cross-evidence: `ss -tlnp | grep <boundPort>` → `LISTEN 0.0.0.0:<port>` owned by the electron utility pid; `/dev/tcp` connect proves accept.
- `node scripts/sync-client.mjs <host> <port> <code|resume> <deviceId> [holdSecs]` speaks the real wire protocol (hello→challenge→noise-v1 seal→pair/welcome→open ping/devices/sync→push listen). Rejected pair → sealed `{t:'reject',reason:'no-pairing'}`; unpair while connected → server closes the socket mid-hold.
- `trigger()` → `{triggered:true}` only with a phase-open session; offline paired devices → `{pending:true}`.
- `unpair` resolves `undefined` — the utility envelope normalizes null→undefined before the renderer validator.

### Gotchas

- `pkill -f`/`pgrep -f` self-match: use the bracket trick (`pgrep -f "nod[e].mojom"`) or kill by PID.
- `konsole -e 'bash -c "..."'` is not interactive; launch plain `konsole`.
- `scripts/cdp-eval.mjs`/`cdp-inspect.mjs` need `(async()=>{...})()` wrappers; bare `require`/`import()` don't work in inspector eval — use `process.mainModule.require`.
- Rebuild `dist/` if it predates branch HEAD — stale dist silently tests old code.
