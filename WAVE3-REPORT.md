# Wave-3 LoC-reduction — shard: desktop-utility

Base `a675a7b` → `devin/w3-desktop-utility` HEAD `742427a`.
Final diff: **28 files, +532 / −1108 → net −576 LoC.**

## Gates

```bash
export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
pnpm -C apps/desktop typecheck   # tsc --noEmit — clean
pnpm -C apps/desktop test        # all desktop shell tests pass
```

Evidence (final run): `desktop shell tests passed` — includes sync-log,
sync-engine adapter, supervisor, ipc, theme-monitor, sync-keys, and the
preload/utility boundary suites; the informational `[auqw] sync emission
failed; writes retained for retry` and `downloads: dl-1 file vanished —
degrading to streaming` lines are expected test-path output, unchanged
from baseline.

## Per-file LoC (before → after)

| file | before | after | Δ |
|---|---|---|---|
| main/ipc.ts | 885 | 583 | −302 |
| preload/index.ts | 523 | 444 | −79 |
| shared/contract.ts | 1513 | 1490 | −23 |
| shared/check.ts | 43 | 37 | −6 |
| shared/errors.ts | 71 | 61 | −10 |
| shared/local-paths.ts | 124 | 124 | 0 |
| shared/audio-mime.ts | 34 | 34 | 0 |
| main/supervisor.ts | 404 | 403 | −1 |
| main/sync-events.ts | 72 | 68 | −4 |
| main/window-state.ts | 152 | 152 | 0 |
| utility/host.ts | 412 | 405 | −7 |
| utility/index-db.ts | 77 | 77 | 0 |
| utility/index.ts | 405 | 393 | −12 |
| utility/local.ts | 743 | 730 | −13 |
| utility/pot-minter-engine.ts | 366 | 358 | −8 |
| utility/pot-service.ts | 1492 | 1492 | 0 |
| utility/router.ts | 55 | 72 | +17 |
| utility/service.ts | 161 | 160 | −1 |
| utility/storage.ts | 509 | 493 | −16 |
| utility/stream.ts | 270 | 239 | −31 |
| utility/sync-dialer.ts | 422 | 416 | −6 |
| utility/sync-handlers.ts | 553 | 552 | −1 |
| utility/sync-journal.ts | 445 | 438 | −7 |
| utility/sync-log.ts | 663 | 645 | −18 |
| utility/sync-mdns.ts | 325 | 325 | 0 |
| utility/sync-server.ts | 1066 | 1058 | −8 |
| utility/tags.ts | 454 | 438 | −16 |
| utility/transfer.ts | 875 | 851 | −24 |

(`router.ts` grew because it now hosts the shared `guarded` helper the
four service files used to duplicate; `window-state`/`sync-mdns`/
`local-paths`/`audio-mime`/`index-db`/`pot-service` count as 0 on pure
unexports where the line count is unchanged.)

## Dead code deleted (proven by repo-wide `rg`)

- `check.ts`: `isStringOrUndefined` — zero references repo-wide.
- `contract.ts`: 11 type aliases with no consumer inside or outside the
  file (`HttpTracePayload`, `GuestLogPayload`, `LocalEntryPayload`,
  `FileFingerprintPayload`, `LocalTagsPayload`, `StorageQueryArgs`,
  `SyncListenerState`, `SyncLocalWriteDoc`, `TransferSweptResult`,
  `TransferRemovedResult`, `LocalRemovedResult`). Their runtime
  validators stay — several remain referenced by boundary checks.
- Unexported dead exports (kept for internal use, zero external
  importers): `ServiceClient`, `IndexDb`, `TransferService`/`Options`,
  `PotService`/`Deps`, `LocalService`/`Options`, `TagService`/`Options`,
  `StorageService`/`Options`, `SyncServiceView`/`NearbyBrowse`/
  `createNearbyBrowse` (internal use only), `LoadedWindowState`,
  `SupervisorOptions`/`UtilitySupervisor`, `AUDIO_MIME`,
  `pickedFilePath`, plus ~30 contract type aliases that exist only to
  back `AuqwApi`/validators.
- `sync-server.ts`: unreachable `srv === null` branch — the variable is
  assigned synchronously before the Promise executor runs.
- `local.ts`: dead `return`s after `asIo(...)` (typed `never`).
- `transfer.ts`: single-call-site `sweepPartials` wrapper — `sweep`
  passed directly.
- `sync-events.ts`: single-use `AppliedPushService`/`NearbyPushService`
  aliases inlined to `PushService<…>`.

## Simplifications

- `ipc.ts` (~−302): the ~50 handlers that were verbatim
  `deps.utility.request(CHANNELS.x, args)` forwarders collapse into a
  `fwd` helper producing `[channel-key, handler]` tuples; the four
  subscribe/unsubscribe pairs became a table.
- `preload/index.ts` (−79): four identical listener-registry
  subscription bodies replaced by one `subscribeTo` helper; redundant
  literal annotations dropped (contextual `AuqwApi` typing).
- `stream.ts` (−31): repeated `validate + try/napiError-map` folded
  into `napiCall`/`napiRun` seam helpers. The asymmetric placement is
  preserved: marks/devPrepare validate *inside* the mapped region
  (malformed → `internal`), request/prepare validate *outside*
  (malformed → `invalid-request`) — matching the originals exactly.
- `utility/router.ts` (+17): hosts shared `guarded()` — the
  validate-then-throw-`invalid-request` wrapper formerly duplicated in
  `local.ts`, `tags.ts`, `storage.ts`, `transfer.ts`. `noArgs` closures
  replaced by `isUndefinedResult`.
- `sync-dialer.ts` (−6 net of +48/−54): six `SyncClientKeys` methods
  shared a cancel-check→try→`toError` frame — now one `guard` helper;
  the device-record literal is a `peerRecord` builder fed by a
  `disclosed` type predicate (narrowing, no cast).
- `sync-log.ts` (−18): `isWriteDoc`'s per-field blocks collapsed via
  `hasOnlyKeys` + a shared non-negative-int check.
- `sync-journal.ts` (−7): the `then(()=>undefined, ()=>undefined)`
  tail-settle appears 3× — now `settled`.
- `utility/index.ts` (−12): `lazyBonjour`/`lazyBrowse` slimmed to
  `??=` closures; the two fire-and-forget `serviceClient.request` pushes
  share one `push` helper.
- `errors.ts` (−10): `ShellErrorKind` is derived from the
  `ERROR_KINDS` tuple — the union and the membership set no longer
  duplicate the same 12 strings.
- `host.ts` (−7): `manifestFields`' string-field reads share a `str`
  helper; env-empty checks simplified (`x !== undefined && x !== ''` →
  truthy, equivalent for `string | undefined`).
- `sync-server.ts` (−8): `status()` spreads `idleStatus(listener)`
  instead of restating the dormant fields.
- `sync-mdns.ts` (0): `txtFp` helper shared by `peerOf`/`fpOf`.
- `window-state.ts` (0): `loadWindowState`'s four fallback literals
  share a `fallback(error)` constructor.
- Micro: `nextId` increments (`service.ts`, `supervisor.ts`).

## Deliberately NOT touched

- `pot-service.ts` (1492): remote-JS sandbox + token minter — every
  branch is a bound, rate-limit, or leak guard. Only dead `export`
  keywords removed.
- `main/sync-keys.ts`, `utility/sync-keys.ts`: pairing custody +
  safeStorage — dense, load-bearing.
- `theme-monitor.ts`, `main/index.ts`: lifecycle/refcount/stale-read
  guards; cosmetic churn risks the invariants the comments document.
- `net-monitor.ts` vs `sync-events.ts`: similar refcounted sender
  registries, but `net-monitor` guards its `'destroyed'` hook with a
  `WeakSet` so reattach can't stack listeners while `sync-events`
  registers per first-attach. Unifying changes observable listener
  counts — noted, not done.
- `transfer.ts` `errorCode` extraction sites: one uses `errorCode()`,
  another deliberately checks `instanceof Error`/`code` — merging
  conflates thrown-value semantics.
- `sync-log.ts` fold loops kept `for…of push` (not `push(...spread)`):
  the entry arrays are unbounded (multi-MB lines) and spread can hit
  the arg-count limit.
- `schema.ts`: all 16 combinators are live (verified via `v.*` usage
  in contract.ts).
- Contract arg/result type aliases exported-but-unused-externally were
  left exported only where they name the `AuqwApi` surface; purely dead
  ones were deleted or unexported per the table above.

## Cross-shard opportunities (not taken — outside my dirs)

- `renderer/` has its own mse/local-playback/controller layer that
  likely shares patterns with the utility services; a follow-up shard
  owns it.
- `isShellError`-style kind-lists also exist in `@auqw/application`'s
  `appError` taxonomy — a shared single-source would live upstream.

## Commits

```
071b0c0 refactor(desktop): delete dead exports, unreachable branches, dead wrappers
ddca2da refactor(desktop): collapse ipc.ts handler table into fwd() tuples
a6ae800 refactor(desktop): dedup preload push-channel subscriptions
d045aaf refactor(desktop): shared guarded() + napiCall/napiRun seam helpers
0a61acf refactor(desktop): tighten sync-log validation, drop single-use aliases
1679e26 refactor(desktop): custody-keys guard frame, spill-tail settled, mdns txtFp
742427a refactor(desktop): single-source shell error kinds, unexport self-only symbols
```

## `git diff --stat` vs base

```
28 files changed, 532 insertions(+), 1108 deletions(-)
```
