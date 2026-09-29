# Wave 3 — LoC-reduction report: desktop-renderer shard

Base: `a675a7b` · Branch: `devin/w3-desktop-renderer` · Scope: `apps/desktop/src/renderer/**`
Net: **-856 lines** (1159 insertions, 2015 deletions) across 19 files. Gates green
(`pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` — desktop shell tests passed)
before every commit.

## Per-file LoC

| file | before | after | Δ |
|---|---:|---:|---:|
| web-player.test.ts | 2184 | 2164 | -20 |
| app.tsx | 1465 | 1397 | -68 |
| web-player.ts | 1508 | 1306 | -202 |
| controller.test.ts | 928 | 919 | -9 |
| controller.ts | 979 | 891 | -88 |
| mse-source.ts | 868 | 838 | -30 |
| provider.test.ts | 783 | 775 | -8 |
| mse-source.test.ts | 832 | 743 | -89 |
| containers.ts | 645 | 621 | -24 |
| sqlite-driver.test.ts | 397 | 391 | -6 |
| index.ts | 407 | 381 | -26 |
| web-peaks.ts | 369 | 348 | -21 |
| transfer-port.ts | 340 | 290 | -50 |
| tag-reader.test.ts | 204 | 161 | -43 |
| provider.ts | 227 | 160 | -67 |
| tag-reader.ts | 269 | 132 | -137 |
| sqlite-driver.ts | 104 | 101 | -3 |
| ipc-errors.ts | 35 | 89 | +54 |
| local-playback.ts | 56 | 37 | -19 |
| **total** | 12600 | 11744 | **-856** |

`ipc-errors.ts` grew deliberately — it absorbed `ifCancelled`/`settleIpc`/`rawToAppError`
seams that were duplicated across four files; net win shard-wide.

## Deleted — and why it was safe

- **`pickLocalFiles` + `stagePick` + the staged-pick queue** (tag-reader.ts):
  zero call sites anywhere in the repo (`rg` whole-repo, including apps/mobile and
  packages). `pickFiles` was dropped from the test `fakeApi` dialog surface
  accordingly; the deleted code's tests were the only test deletions made.
- **`pickFiles` fake** (tag-reader.test.ts): only existed to feed `pickLocalFiles`.
- **Per-call tagread helper duplication** (tag-reader.ts): the tagread path had a
  batch loop and a single-item path doing the same chunk bookkeeping; collapsed to
  the batched loop over `MAX_TAGREAD_BATCH`.
- **Dead narrowing** (app.tsx): two `state.type === 'ready' ? …` ternaries inside a
  scope where `state: ReadySession` — the type is the literal `'ready'`, so the
  alternate branches were unreachable.
- **`HOST_KIND` table** (provider.ts): exact duplicate of the shared
  `ERROR_KIND_BY_SLUG` map — dropped, shared the canonical one.
- **Internal-only type exports**: `LocalPlaybackDeps`, `PeaksDecoder`,
  `SessionControllerOptions` lost `export` (repo-wide importer check: none).
- **Stale docs**: local-playback wiring block describing a seam that was already
  wired in `controller.ts`; assorted narration comments restating the next line.

## Simplifications applied

- **Shared seam helpers** (`ipc-errors.ts`): `ifCancelled` (suppress-after-cancel
  wrapper), `settleIpc` (await → `ok`/`err` settle), `rawToAppError` (raw →
  `AppError` with fallback) — previously duplicated in transfer-port, tag-reader,
  provider (`hostError`), web-player (`toError`).
- **web-player.ts**: collapsed the trace/stream payload mappers, shared the
  attach-teardown path, hoisted the `pending?.positionMs` recompute in `play`,
  extracted the reverse-lookup `localPrepares` reap.
- **controller.ts**: shared `SLOT_CAPABILITIES` use, single `retryApply` seam,
  `warn()` sink for the five `log.write({level:'warn',…})` sites, collapsed the
  settings repick ladder and the `reconcileTail` swallow, merged adjacent
  `mediaUnsubs.push`.
- **mse-source.ts**: inlined single-caller helpers, hoisted state decls, shared
  the `MAX_UNIT_BYTES` message; tests got `beginAttach()` for the 16 identical
  media+port+mse preambles.
- **containers.ts**: one vint-width scan helper for both walks;
  `resyncScan`'s WebM leg reuses `findClusterSig(buf, 0)`; init walk reuses
  `findClusterSig`.
- **app.tsx**: shared gate frame + sheet wrapper, unified pairing-mint gating and
  dial settle; `.finally` flag-clear consolidation in `mintOffer`.
- **web-peaks.ts**: slug→kind lookup table replaces the switch; read-leg
  selection hoisted; single-use `BITRATE_FLOOR_BPS` inlined.
- **index.ts** (dev harness): `releaseHandle` shared; the thrice-repeated
  `pendingRegistrations === 0 → drainEarlyPrepares` guard became `drainIfIdle`.
- **provider.ts**: deadline-abort helper shared across request kinds.
- **Test preambles**: `rig()` in web-player.test.ts (25 sites), sqlite-driver.test.ts
  (14 sites), provider.test.ts (15 sites); `boot(api, deps)` in controller.test.ts
  (18 sites); `beginAttach()` in mse-source.test.ts (16 sites). Assertions,
  ordering, and call sequences unchanged — pure preamble extraction.
- **sqlite-driver.ts**: `void storage.cancel(txId).catch(() => undefined)` for the
  fire-and-forget rejection swallow (identical observable behavior).

## Cross-shard dedup opportunities (noted, not touched)

- `apps/mobile/src/session/controller.ts` + `apps/mobile/src/adapters/plugin-provider.ts`
  re-implement `createSessionController`/`createPluginProvider`/`manifestCapabilities`
  logic parallel to this shard — a shared package home (e.g. `@auqw/application`)
  could host both; owner boundary prevented the move.
- `packages/application/src/providers/provider-wire.ts` holds the canonical
  `manifestCapabilities` this shard re-exports (`provider.ts` re-export kept as
  the shard's import seam).
- `decodeAudio`/peaks decode seams resemble shared-media candidates alongside
  `web-peaks.ts`.

## Deliberately not touched

- **Core orchestration** in web-player.ts (generation/identity guards, MSE
  fallback ordering, media-session wiring), mse-source.ts (eviction windows,
  pump epochs, journal bookkeeping), controller.ts (restore → sync drain →
  online subscription sequencing): remaining bulk is behavior-dense; further
  compression would risk timing/identity/ordering changes.
- **waveform-seek.dom.test.ts**: the 56 `act()` blocks are distinct behavioral
  steps, not boilerplate.
- **web-peaks.test.ts**: the 12 `createWebPeaksPort` sites each pass different
  decode/limit options — a `rig` would just re-wrap the same surface.
- **`MseAttach`** stays exported: it is the return contract of `attachMseSource`.
- **Test assertions**: none weakened, none retyped; only tests for deleted dead
  code were removed.

## Final diff stat vs base

```
19 files changed, 1159 insertions(+), 2015 deletions(-)
 apps/desktop/src/renderer/web-player.ts         -202 net
 apps/desktop/src/renderer/tag-reader.ts         -137 net
 apps/desktop/src/renderer/mse-source.test.ts     -89 net
 apps/desktop/src/renderer/controller.ts          -88 net
 apps/desktop/src/renderer/app.tsx                -68 net
 apps/desktop/src/renderer/provider.ts            -67 net
 apps/desktop/src/renderer/transfer-port.ts       -50 net
 … (see `git diff --stat a675a7b..HEAD`)
```

Untracked at worktree root: `AGENT.md`, `CONTINUE.md`, `.agent-loop.log`
(task scaffolding — intentionally left out of the commit set).
