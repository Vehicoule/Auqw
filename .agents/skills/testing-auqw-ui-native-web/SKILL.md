---
name: testing-auqw-ui-native-web
description: How to exercise the Auqw Expo app end-to-end on a VM with no Android SDK/device — expo web export + Metro resolveRequest aliases for fake native ports, controllable connectivity, and an HTTPS range-serving media endpoint.
---

# Testing Auqw slice-3+ UI on web (no Android SDK)

The app boots and the full domain stack runs in Chrome via an `expo export --platform web` bundle, provided you inject fakes for the native surface. `createSessionController(host, opts)` is the seam — nothing else needs patching.

**Evidence status: provisional.** Per AGENTS.md, results from this harness never close a real-target exit gate — use it for interaction/state verification only, and label any report "web harness (provisional)".

## Environment
- Node 24 + pnpm via `~/.nvm` (`export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`); `pnpm install` first.
- One Chrome window only — wa-sqlite uses OPFS `createSyncAccessHandle`; a second window on the same profile fails boot with `NoModificationAllowedError`.
- Chrome must trust the self-signed media endpoint. Prefer a scoped bypass over the blanket flag:
  ```sh
  openssl x509 -in web-harness/cert.pem -pubkey -noout | \
    openssl pkey -pubin -outform der | \
    openssl dgst -sha256 -binary | openssl enc -base64
  google-chrome --ignore-certificate-errors-spki-list=<that fingerprint> \
    --user-data-dir=/tmp/auqw-chrome http://localhost:8087
  ```
  `--ignore-certificate-errors` alone disables ALL certificate validation for the profile — do not use it.
- Harness files are runtime-only and live outside `src/` so `pnpm -r typecheck` is unaffected.

## Recipe — all files are committed under `reference/`

1. Copy the harness into place (uncommitted working-tree files):
   ```sh
   cp -r .agents/skills/testing-auqw-ui-native-web/reference/web-harness apps/mobile/
   cp .agents/skills/testing-auqw-ui-native-web/reference/server.mjs apps/mobile/web-harness/
   cp .agents/skills/testing-auqw-ui-native-web/reference/metro.config.js apps/mobile/metro.config.js
   bash .agents/skills/testing-auqw-ui-native-web/reference/make-plugin-assets.sh
   ```
2. `pnpm add -D react-dom react-native-web` in `apps/mobile` (export fails without them). **Pin react-dom EXACTLY to the app's react version** (`pnpm add -D react-dom@<react version>` then strip the `^` in package.json or use `--save-exact`) — a caret range resolves to the newest minor (19.2.3 → 19.3.0) and the page renders blank with minified React error #527 "args[]=19.2.3&args[]=19.3.0" in the log sink.
3. Cert: `openssl req -x509 -newkey rsa:2048 -nodes -keyout apps/mobile/web-harness/key.pem -out apps/mobile/web-harness/cert.pem -days 7 -subj "/CN=localhost"`.
4. `(cd apps/mobile && pnpm exec expo export --platform web)` → `node apps/mobile/web-harness/server.mjs`.
5. If driving via computer tool, patch `dist/index.html` after EACH export with a `<pre id="__logSink">` console capture (`pointer-events:none` or it eats sheet clicks) and a small control strip calling `__auqwConn.set(online, metered)`. Put the sink top-left, not bottom-left — bottom-left overlays the navbar and ruins navbar captures (or hide it via the DevTools console when shooting the bar: `document.getElementById('__logSink').style.display='none'`).

## Contract pitfalls (all verified by hitting them)

- Canned catalog `source_ref.provider` MUST equal `settings.playbackProvider` (`'youtube-music'`); `storefront` must be `/^[A-Z]{2}$/`.
- `playback.resolve` `content_length` MUST equal the served file's exact byte count — the fake host reads it live from the server's `/media-meta.json`, so a custom media file (`node server.mjs path/to/song.wav`) stays consistent automatically.
- The fs fake exposes `File.base64()`/`move()` (the plugin loader and artwork commit need them) and shares its byte store with the `expo-asset` stub via `globalThis.__auqwFsStore`.
- Media endpoint MUST be **https** — transfer-policy rejects `http://` mints (`invalid-response: non-https stream url`).
- Cross-origin range fetches need `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length` + OPTIONS — otherwise `headers.get('Content-Range')` is null.
- Seam stubs: `setQueueProjection` must resolve normally — a throwing stub wedges the queue and sets session `persistenceError`.
- Manifest placeholders carry the real ABI fields (`capabilities`, `permissions`, `artifact`) so `manifestCapabilities` filtering runs the real path; the fake host never reads the bytes.
- The in-memory `expo-file-system` means downloads degrade to `streaming` on every reload — the integrity sweep fires and that is expected/correct, not a bug.

## What you can/can't verify

- Works: boot, plugin load (real `loadBundledPlugin`), sqlite persistence (wa-sqlite/OPFS), search via real request/outcome correlation, downloads end-to-end (resolve → range fetch → FS commit → ledger → `stored` chip), downloads collection, settings rows (usage bytes, cellular toggle), offline banner + row marking, queue gating offline/metered, resume on restore, owned-plays-offline, integrity sweep, `downloadsActiveChanged` FGS edges (count `__fgsCalls`).
- Not testable (device-only): real FGS lifecycle + notification, airplane-mode OS behavior, ≥200-file scan, storage-full (fake `Paths.availableDiskSpace` is a stub point if needed), Media3 audio output, SAF folder picker, `auqw://` journey deep links (`__DEV__`-gated out of export builds).

## Cleanup (from repo root)

```sh
git checkout -- apps/mobile/metro.config.js apps/mobile/package.json pnpm-lock.yaml pnpm-workspace.yaml
rm -rf apps/mobile/web-harness apps/mobile/dist apps/mobile/assets/plugins
fuser -k 8087/tcp 8088/tcp 2>/dev/null || true
```

## Alternative: gallery-only harness (no app wiring)

When you only need `packages/ui-native` components — not the session/download stack — the lighter path still works: `index.web.ts` registering a `web-gallery.tsx` that wraps `GalleryScreen` in `GestureHandlerRootView` + `SafeAreaProvider` with `useFonts(JetBrainsMono_*)`, `main: index.web.ts` + `@expo/metro-runtime`, then export + static-serve. No fake ports needed; everything is fixtures — callbacks are `noop`, gestures don't track mouse drags (use the state chips), and App-level wiring (tab bar, sheets, theme picker) is unreachable.

- Gallery `Frame`s are full-width, not phone-width: at ~950px desktop width the `StageSheet` artwork (`aspectRatio: 1`, `fill`) is taller than the 620px frame and clips the transport controls — resize the Chrome window to ~530px wide (`wmctrl -r Auqw -e 0,10,40,530,720`) so sheet content renders fully before judging it.
- `browser_console` CDP may attach to a different Chrome window when several are open (evals returning `querySelectorAll('div').length === 0` = wrong target). Visual assertions from screenshots are sufficient; close extra windows if you need console evals.
- CorrectionsScreen's `onRetry` prop isn't wired in the gallery fixtures, so the corrections "error" frame shows no retry button — expected coverage gap, not a bug.
- Token/colour assertions: use `getComputedStyle` in the browser console (e.g. secondary text = `rgb(143, 153, 194)` for `#8f99c2`).

## Merge-shell (post `main` merge) notes — verified on s3/schema-domain

- **Navigation is an overlay stack**: library collections/entity pages are `PushScreen`s (press the 'back' chevron), action sheets are `SheetScreen` modals (dismiss via the backdrop's `dismiss` button), mini-player lives in the PlatformTabs accessory, StageSheet inside the root item.
- **TrackRow context = long-press** (`onLongPress`, hint "long-press for more actions"): `mouse_move` → `left_mouse_down` → wait ~1s → `left_mouse_up`. No 'more actions' button in the DOM.
- **Catalog/search rows have NO download action** — the sheet only offers download when `recordFor()`/`downloadRefFor()` resolves (persisted recordings). Like a track first, then use 'recently liked'/collection rows.
- **Local recordings surface ONLY via search** (key `local:<id>`) — search the title, not a library list.
- **StageSheet**: player/lyrics/queue tabs and transport buttons ARE pressable; the transport 'download' button works. Pan-down collapse is NOT exercisable — synthetic drags only select text (RNGH pan doesn't track mouse on web). Expand it last; F5 resets.
- **Coordinate calibration**: the computer-tool space ≠ CSS px (Chrome window is ~560x1140 real on a 1600x1200 display; scale ≈0.64 with ~65-72px Y offset — it drifts). Instrument once: `document.addEventListener('pointerdown', e => log(e.clientX,e.clientY), true)`, click, read the actual CSS point, then nudge.
- **Fake TagReader entries need every field** (`fp`, `docId`, `modifiedMs`, `size`, `title`, `artist`, `album`, `durationMs`, `genre`) — a malformed entry makes `tagEnumerate` emit a decode failure that `local.rescan` swallows silently (`scanned.ok` guard → no log, no UI feedback). If a scan click does nothing, inspect the fake entries, not the click.
- **Fake fs pitfalls** (fixed in local copies — keep them): `dirs` store must live on `globalThis.__auqwFsDirs` (separately-bundled module instances disagree otherwise); `norm()` must add a `file:/`→`file:///` case; `list()` must compare the remainder after the dir prefix (a dir uri's trailing slash gives children the same token depth — a token-count check returns [] forever → `usage()` always 0 kb).
- **Catalog search items need `artwork: []`** — `isTrackMetadata` requires an array; `null` → 'plugin result failed validation'. Artwork urls must be `https://` — for real art on rows drop a `cover.png` next to server.mjs and add a `/media/cover.png` route on the https endpoint (Content-Type `image/png`), then `artwork: [{ url: 'https://localhost:8088/media/cover.png', width: 300, height: 300 }]`. The artwork cache resolves to a `file:///cache/artwork/*.img` uri that web `<img>` can't load — `markRemote` falls back to the remote url and art still renders; `Not allowed to load local resource` console errors are expected web noise.
- **metro ≥0.84 (expo ~57)**: `config.resolver.resolveRequest` can be a non-function OBJECT — reference/metro.config.js must guard `typeof defaultResolve === 'function'` and fall back to `context.resolveRequest`, else `expo export` dies with `TypeError: defaultResolve is not a function` before bundling.
- **Playing-state surfaces**: `toSearchRowModel` hardcodes `playing: false` — search-result rows never show the eq overlay/accent title. Playing-row evidence comes from an occurrence-backed row: the StageSheet `queue` seg (NOW PLAYING) or a library/collection row after playback lands it there.
- **Mid-flight download states**: add a `/harness/latency?ms=N` delay knob on the media endpoint so transfers stay in flight long enough to toggle metered/offline mid-transfer (eligibility re-eval demotes active transfers to resumable).
- **Known stale-display bug** (real app bug, reported): after a successful library import, wiped downloads can still render as stored until the next download-ledger emit — `init()` only emits 'removing' on the failure path.
- Expected harness noise: `queue projection failed` warns (expo-audio provisional player → diagnostics `persistence: failed`), `downloads: … file vanished — degrading to streaming` on reload (in-memory fs + integrity sweep).

## Devin Secrets Needed
- none
