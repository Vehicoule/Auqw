---
name: testing-auqw-ui-native-web
description: How to exercise the Auqw Expo app end-to-end on a VM with no Android SDK/device — expo web export + Metro resolveRequest aliases for fake native ports, controllable connectivity, and an HTTPS range-serving media endpoint.
---

# Testing Auqw slice-3+ UI on web (no Android SDK)

The app boots and the full domain stack runs in Chrome via an `expo export --platform web` bundle, provided you inject fakes for the native surface. `createSessionController(host, opts)` is the seam — nothing else needs patching.

## Environment
- Node 24 + pnpm via `~/.nvm` (PATH: `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`); `pnpm install` first.
- Chrome: `google-chrome --ignore-certificate-errors --user-data-dir=/tmp/auqw-chrome http://localhost:8087` (flag needed for the self-signed media endpoint).
- One Chrome window only — wa-sqlite uses OPFS `createSyncAccessHandle`; a second window on the same profile fails boot with `NoModificationAllowedError`.

## Recipe (temp, uncommitted — revert after)
1. `pnpm add -D react-dom react-native-web` in `apps/mobile` (export fails without them).
2. `metro.config.js`: add `config.resolver.resolveRequest` that redirects, when `platform === 'web'`:
   - `auqw-expo` → fake module: canned `startRequest` outcomes keyed by capability (catalog.search / playback.resolve), `connectivitySnapshot/Watch` over a `window.__auqwConn.set(online, metered)` singleton, `downloadsActiveChanged` → `window.__fgsCalls`, seam player stubs (`setQueueProjection` MUST resolve a `Result` `{ok:true,value:undefined}` — a bare `void` makes the session log `queue projection failed` and sets `persistenceError`).
   - specifier ending `expo-connectivity.ts` → same controllable connectivity singleton (the app resolves the module by path, not package name).
   - `expo-file-system` → in-memory `File`/`Directory`/`FileHandle`/`FileMode`/`Paths` (enum members `ReadOnly='r'`, `Append='wa'`, etc.; handle has `readBytes/writeBytes/size/close`). NOTE: in-memory = downloads degrade to streaming on every reload (integrity sweep runs — visible as `file vanished — degrading to streaming` warns).
   - `expo-asset`, `expo-audio` → minimal stubs.
3. `assets/plugins/{itunes,youtube-music,deezer,lyrics-lrclib}.{wasm,manifest.json}` placeholders (8-byte wasm magic + `{id,name,abi:'0.3.0',capabilities}`) so static `require()` resolves — content is never parsed by the fake host.
4. `(cd apps/mobile && pnpm exec expo export --platform web)` → `node server.mjs` serving `dist/` on :8087 plus `/media/track.wav` over **https** on :8088 (self-signed pem).
5. Canned catalog `source_ref.provider` MUST equal `settings.playbackProvider` (`'youtube-music'`) and `storefront` must be `/^[A-Z]{2}$/` (`'US'`).
6. Canned `playback.resolve` `contentLength` MUST equal the served file's exact byte count — transfer-policy fails with `Content-Range total changed mid-stream` otherwise.
7. Serve media over **https** — transfer-policy rejects `http://` mints (`invalid-response: non-https stream url`). And because the http page fetches https cross-origin, set `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length` + handle OPTIONS — otherwise `headers.get('Content-Range')` is null and every chunk is rejected.
8. If driving a browser: patch `dist/index.html` after EACH export — a small on-page console-capture pane (`<pre id="__logSink">` with `pointer-events:none` — otherwise it eats sheet clicks) and conn/FGS control strip.

## What you can/can't verify
- Works: boot, plugin load (real `loadBundledPlugin`), sqlite persistence (wa-sqlite/OPFS), search through real request/outcome correlation, downloads end-to-end (resolve→range fetch→FS commit→ledger→`stored` chip), downloads collection, settings rows (usage bytes, cellular toggle), offline banner + row marking, queue gating offline/metered, resume on restore, owned-plays-offline, integrity sweep, `downloadsActiveChanged` FGS edges.
- Not testable: real FGS on-device, airplane-mode OS behavior, ≥200-file scan, storage-full, Media3 audio output, SAF folder picker, `auqw://` journey deep links (`__DEV__`-gated out of export builds).
- Known cosmetic gaps to expect: `queue projection failed` warn if the fake player returns a bare void (fix per #2); playlist overlay rows do NOT get the `unavailable`/`offline` decoration that library/collection rows get (as of s3/ui).

## Devin Secrets Needed
- none

## Cleanup
`git checkout` metro.config.js, package.json, pnpm-lock.yaml, pnpm-workspace.yaml (esbuild `allowBuilds` stub); delete `apps/mobile/web-harness/`, `assets/plugins/*.{wasm,manifest.json}`, `dist/`; `fuser -k 8087/tcp 8088/tcp`.
