---
name: testing-auqw-desktop-shell
description: How to run and exercise the apps/desktop Electron shell on this box — PATH, lazy Electron install, real display vs xvfb, frameless-window quirks (KWin shadow margins, wmctrl close), single-instance and window-state checks.
source: session s4/desktop-shell testing
---

# Testing the auqw desktop shell (apps/desktop)

## Run it

- Node is NOT on the default PATH — always `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH` first.
- Build: `cd apps/desktop && pnpm build` (esbuild → `dist/`; `dist/` is gitignored, rebuild if stale).
- Electron 44's npm package ships no binary: if `node_modules/electron/dist/electron` is missing, run `cd node_modules/electron && node install.js` from repo root — it lazily downloads (~230 MB).
- Launch on the real KDE display: `cd apps/desktop && DISPLAY=:0 ../../node_modules/.bin/electron . --no-sandbox --disable-gpu --enable-logging > /tmp/auqw-electron.log 2>&1 &`
  - `--no-sandbox` is required (SUID chrome-sandbox is not set up on this box).
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
- Seeded x/y are only applied when they intersect a connected display's workArea (`intersectsDisplay`, added in cd83d00) — an off-screen position is silently dropped and the WM places the window; on-screen positions restore exactly. To test the gate: seed x=4000,y=3000, expect the window on-screen anyway.
- Single-instance: a second `electron .` exits ~0.2 s (lock refused → app.quit); the first window un-minimizes + focuses. `wmctrl -l` must still show exactly one `auqw` window.

## Devin Secrets Needed

None — all local.
