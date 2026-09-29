# Wave-2 report — desktop `provider:'local'` adapter

Desktop can now play owned bytes end-to-end. Before this change,
`web-player.ts` rejected every `provider:'local'` prepare with
`emitFailed('unavailable', 'desktop local files not implemented')` and
`controller.ts` hard-gated the `localPlaybackFor` session hook behind
`const localPlaybackCapable = false`, so `DownloadManager` downloads and
imported `LocalFileSource` files sat on disk but never attached.

## Attach mechanism chosen: direct `file://` on the audio element

`provider:'local'` sourceRefs already ARE `file://` URIs (the
`toFileUri` convention shared by `local-playback.ts` and the utility's
`local:probe`). The player mints an `lf-*` handle keyed to that URI —
the mobile adapter's `lf-*` convention — and `attachUrl` returns the URI
straight to the element. No new protocol, no ranged IPC pump.

Two utility channels DO ride the attach — they landed after review:
`local:resolve` realpath-gates the mint to an indexed, grant-confined
path (renderer URIs are lexical; only the utility can realpath), and
`local:read` feeds waveform peaks the same gated ranged read. Both gate
through `allowedLocalPath` (mediaDir confinement OR indexed `local_files`
row + tree-root confinement).

Why this leg over the alternatives evaluated:

- **Direct `file://`** — zero new machinery: Chromium decodes the
  container and seeks the file with native random access. `currentTime`
  seeks work (verified live: `seeked` event at t=6 s on an 8 s WAV).
  The only dependency was CSP: `media-src` now admits `file:` next to
  `'self'` in `app.html` and the dev-harness `index.html`. `'self'` does
  not cover `file:` even for a `file:`-origin document.
- **Ranged-read seam via the utility** — `src/utility/` exposes no
  generic file-read IPC the renderer can borrow. `local:probe` /
  `local:playback` only resolve names/indexes to URIs. The `stream:*`
  channels are the remote/plugin pump; `stream:dev-prepare` is
  dev-gated. Building a file-read pump would be a *new* seam — out of
  scope and strictly more code than the leg that already plays.
- **Existing custom protocol** — none is registered in
  `main/index.ts`; the task also forbids registering one for this.

`localPlaybackFor` wiring: `controller.ts` now answers
`probe?.(id) ?? uriForHook(id)` — `createLocalPlayback` resolves
download-ledger names to `file://<mediaDir>/<name>` first, then falls
through to `LocalFileSource.uriFor` for imported files. A null answer
still means "cannot attach" and stays separate from ownership
(`fileFor`/`uriMap().has`), which `app.tsx` reads unchanged.

## What `localPlaybackCapable = false` was protecting

The gate compensated for a player that rejected every local prepare.
Had the probe answered real URIs while the player emitted
`unavailable`, the session's `#pickRef` would have preferred
*unplayable* local refs over good provider refs (owned bytes outrank
auto-picks online and are the *only* picks offline) — every owned track
would have resolved to a guaranteed-dead `provider:'local'` prepare,
and the offline play-marking would have advertised presses that could
only fail. The constant was a whole-leg circuit breaker, not a runtime
probe. It can now be true unconditionally because the player owns the
leg: `provider:'local'` is handled for `prepare`, `prewarm`,
`attachItem`, `play`, `cancelPrepare`, `release`, marks, and the
element `error` path — there is no reachable local op the port still
punts on.

## Handle and lifecycle conventions (mobile parity)

- `prepare`/`prewarm` mint `lf-req-*` request ids + `lf-*` handles;
  the outcome emits on a microtask so the requestId registers
  session-side first, exactly like the stream leg's `.then`.
- `cancelPrepare` routes `lf-req-*` locally — deletes the
  request→handle entry and reclaims the minted handle; the seam's
  `stream.cancel` is never invoked.
- `release` drops the handle's `localHandles`/`localPrepares`/
  `handleMimes` entries and returns `ok` without a host call; all
  element teardown (`audio.src=''`, `dropMse`, pending-attach abort)
  runs first, unchanged.
- `attachItem` (the queue-projection successor leg) mints through the
  same `mintLocalHandle` path and reaps via `releaseMinted` on stale
  generations — same superseding rules as `stream.prepare`.
- `emitMarks` skips local handles (no seam session to mark); the
  element `error` listener reports `unavailable` — never the
  dead-handle `released`/`not-found` kinds that would loop re-prepares
  over a file that cannot play.
- `opGen++` + `abortPendingAttaches()` run on every `prepare`,
  local included — the same superseding guarantee the stream leg has.

## MIME derivation

`src/shared/audio-mime.ts` hoists the extension→mime table out of
`utility/tags.ts` (same rows — the scanner's admitted types stay the
types the player names). Chain in `mintLocalHandle`:

1. `mimeForPath(uri)` — extension on the URI (imported files always
   have one).
2. `deps.localMime(uri)` — extensionless `dl-*` download names resolve
   through the download ledger's recorded `mime` (controller maps a
   `file://<mediaDir>/<name>` URI back to its `DownloadRecord`).
3. `'audio/*'` — "container unknown, the element sniffs", matching the
   mobile adapter.

## Diffstat

```
 apps/desktop/src/renderer/app.html           |   2 +-
 apps/desktop/src/renderer/app.tsx            |   4 +-
 apps/desktop/src/renderer/controller.test.ts |  45 ++--
 apps/desktop/src/renderer/controller.ts      |  35 ++-
 apps/desktop/src/renderer/index.html         |   2 +-
 apps/desktop/src/renderer/index.ts           |  15 +-
 apps/desktop/src/renderer/web-player.test.ts | 323 ++++++++++++++++++++++++++-
 apps/desktop/src/renderer/web-player.ts      | 259 ++++++++++++++++++---
 apps/desktop/src/shared/audio-mime.ts        |  37 +++
 apps/desktop/src/utility/local.ts            |   2 +-
 apps/desktop/src/utility/tags.ts             |  30 +--
 docs/decisions.md                            |   3 +-
 12 files changed, 655 insertions(+), 102 deletions(-)
```

(`shared/audio-mime.ts` is new; everything else is in place. Mobile
untouched; no changes under `packages/` — session/provider routing
already spoke `provider:'local'`.)

## Test evidence

Unit (all passing):

- `pnpm -C apps/desktop typecheck` — `tsc --noEmit`, clean.
- `pnpm -C apps/desktop test` — `desktop shell tests passed`. New
  `web-player.test.ts` coverage: lf-* mint + `lf-req-*` request ids,
  extension-mime, ledger-mime fallback, `audio/*` fallback, typed
  `invalid-response` on a non-`file://` sourceRef, `file://` element
  attach with zero seam calls, seek/pause/release element-local,
  `cancelPrepare` reclaim, supersession across local plays, a local
  `attachItem` queue transition, and the `unavailable` element-error
  verdict. `controller.test.ts` 10/11/14 re-pointed: download row →
  `provider:'local'` + `file:///tmp/auqw-test/media/dl-1`, scanned
  local file → `file:///music/rips/sub/rip.flac`, probe answers the
  real URI.
- `pnpm -C packages/application typecheck && test` — clean.
- `pnpm -C packages/ui-shared typecheck && test` — clean.

Live (Electron 44, dev harness, `DISPLAY=:0`, test-only `--no-sandbox`):

- Provider `local (file://)` + `file:///tmp/tone.wav` (8 s PCM WAV) →
  event log `prepared lf-2 (audio/wav)`.
- `play` → `#player-state` advanced `playing · 2311ms` →
  `4171ms / 8000ms`, then natural `ended · 8000ms` — full decode of the
  file URI. (No audio device exists on this VM; advancing element
  position is the established decode proxy.)
- Fresh `Audio` element on the same URI: `loadedmetadata` →
  `duration 8`, `currentTime = 6` → `seeked` — native file seeking.
- Graceful `app.quit()`; no crash/respawn noise in the launch log
  beyond the usual dbus/ALSA VM chatter.

## Honest limitations

- **Chromium decode is the ceiling.** The scanner's extension table
  admits `.ape`, `.dsf`, `.wv`, `.mpc` — Chromium cannot decode those
  containers; an attach of one fails at the element with an honest
  `unavailable` status (the row is marked unplayable, never looped).
  `.mp3/.flac/.ogg/.oga/.opus/.webm/.m4a/.mp4/.aac/.wav/.aif` play
  subject to the codecs shipped in Electron's Chromium (Proprietary
  codecs — AAC/M4A — depend on the Electron build's ffmpeg flags).
- **Extensionless downloads report the ledger's mime** but Chromium
  still sniffs the bytes itself — a `dl-*` whose recorded mime disagrees
  with reality (corrupt/mislabeled) fails the same honest way.
- **`audio/*` fallback** means "container unknown": some exotic-
  extensioned files may attach but fail decode — same outcome path as
  undecodable known types.
- **No integrity re-check at attach.** `localPlaybackFor` probes the
  ledger/index; a file deleted or swapped after the probe still gets an
  `lf-*` handle and fails at the element — the same TOCTOU the stream
  leg has with dead URLs, resolved the same way (honest `unavailable`).
- **No marks/trace data** — local attempts report a zeroed
  `AttemptTrace` (no resolve/mint/attach phases exist outside the
  seam); per-file telemetry stays empty.
- **`picked-file:`/`docUri` URIs** resolve to `file://` before they
  reach the port, so confinement is enforced upstream — the port
  accepts any `file://` URI it is handed (within the 8 KiB bound —
  picked-dir URI plus nested docId can exceed a path bound alone);
  there is no additional sandboxing at the attach point, matching the
  stream leg's trust in its own prepares.
- **`file:` in `media-src`** widens the element's fetchable surface to
  any local path the renderer can name — URI minting stays inside
  `localPlaybackFor`/`localMime` (ledger names and source docIds), but
  the CSP itself no longer distinguishes media-dir files from other
  paths. Acceptable because the renderer mints URIs only from
  first-party data; a custom protocol would be the tighter answer if
  that trust ever breaks (reopen condition recorded in decisions.md).
- **Seeking is element-level** (`currentTime`) — no journal/Cues
  re-anchor exists for local files, unlike the MSE pump leg; for
  Chromium-fragmented types the element handles sparse reads itself.
