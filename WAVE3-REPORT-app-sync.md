# Wave-3 LoC-reduction — shard `packages/application/src/sync`

Base: `a675a7b` → HEAD `84a983c` on `devin/w3-app-sync`. 14 commits.
Tests unchanged (0 test LoC delta). Behavior-identical; all gates green.

## Per-file LoC (base → head)

| file | before | after | Δ |
|---|---:|---:|---:|
| sync-engine.ts | 3068 | 2893 | −175 |
| sync-projection.ts | 2205 | 2098 | −107 |
| sync-wire.ts | 787 | 755 | −32 |
| engine-port.ts | 105 | 87 | −18 |
| noise.ts | 543 | 528 | −15 |
| sync-host.ts | 518 | 503 | −15 |
| sync-responder.ts | 918 | 907 | −11 |
| hlc.ts | 131 | 125 | −6 |
| lan.ts | 249 | 243 | −6 |
| delta-docs.ts | 194 | 190 | −4 |
| sync-client.ts | 1456 | 1453 | −3 |
| custody.ts | 280 | 277 | −3 |
| sync-scheduler.ts | 630 | 629 | −1 |
| entry-order.ts | 0 | 62 | +62 |
| **shard total** | **20037** | **19703** | **−334** |

`entry-order.ts` is new — shared pure helpers (entry total order, entry key,
JSON deep-equal, `KEY_SEP`) extracted from sync-engine/sync-projection; the
+62 there was already counted against −175/−107 in the source files.

## What was deleted, and why it was safe

- **Write-only tombstone sets** in sync-projection
  (`tombstoned{Entity,Playlist,Count,Review}Ids`): assigned but never read —
  only their `changedKinds` side effects were live. Deleted; side effects kept.
- **`resolveSignal` wrapper** in sync-engine: single caller (`runOp`) used only
  `.signal`; inlined.
- **Unused `ChangeEntry` type import** in sync-projection.
- **Dead exports unexported** (verified by repo-wide `rg` for each name —
  zero external importers): `NOISE_SUITE_NAME`, `bytesEqual`,
  `createNoiseCodec` (noise.ts); `ResponderDeviceRecord`, `ResponderDeviceRow`,
  `ResponderPrior`, `ResponderRead`, `ResponderWrite`, `ResponderTouch`,
  `SyncResponderCustody`, `ResponderPhase`, `ResponderTimer`,
  `ResponderSocket` (sync-responder.ts); `SyncPairHost` (sync-host.ts).
  Same precedent as the earlier noise.ts unexport; consumers instantiate
  structural types (`SyncResponderDeps`, `createSyncPairHost` return) without
  importing these names — mobile/desktop typecheck confirms.

## Simplifications applied

- **sync-engine**: merge-winner selection, binary searches, and write
  unwrapping deduplicated (49ffcd7); `runOp` envelope now owns the
  resolve-signal / pre-cancel / serialize / safe-clock / deadline / wrap-cancel
  sequence shared by `writeChanges`, `exportDelta`, `applyDelta` (20b464c);
  `syncedRecordKey` reuses `KEY_SEP` instead of a raw `\u001f` literal;
  `compareStamp` terse form `a.l - b.l || a.c - b.c` (all call sites are
  sign-based: `> 0` / `!== 0` — safe).
- **engine-port**: byte-fitting export loop reuses `exportFittedDeltaDoc` from
  delta-docs with its original error text
  (`sync: single sync entry exceeds the wire bound`).
- **sync-projection**: shared `diffRows`, `applyRecordingPlans` serving both
  projection pass and `recordingsMerge` (pending-filtered plan map),
  shared entry-order helpers from entry-order.ts, `numField`/`strField`
  widened to `Map | undefined` dropping six `fields ?? new Map()` allocations
  (missing map ≡ empty map — both returned `null`).
- **sync-wire / lan / custody**: shared tag guards; `ERROR_KINDS` derives from
  `ERROR_KIND_BY_SLUG` instead of restating the taxonomy; shared v4/v6 parse
  and `isFp`; shared `isEndpoint`/`isEndpointList` validators across
  `isClientHello`/`isWelcomeMsg`/`isPairingPayload`; shared `isStringList`
  for the loose custody readers.
- **sync-client**: request-fail/bye/custody-drop triples shared; `sessionRequest`
  cancel/timeout/send-fail paths ride one `fail` (finish + killSession) with
  settled guards kept at call sites.
- **sync-responder**: one-shot `ping`/`devices`/`sync`/`bye` wire-message
  guards tightened (`isResumeMsg`/`isPairMsg` kept `typeof` checks — `String(x)`
  would wrongly accept `123456`); file-local types unexported.
- **sync-scheduler**: `floorAt()` owns the hint×now guard + `notBeforeMs` at all
  three verdict sites (each site still takes exactly one clock read); backoff
  advance shared.
- **sync-host**: `registryFind` serves `custody.find` + `ownDeviceRows`;
  best-effort close blocks ride one `quiet`; listener/advertiser teardown tail
  shared.
- **noise**: `noiseRawPublic/Private` share `derUnwrap`; challenge built via
  shared `encodeJson`; `concatBytes` reduced; `seqIv` uses the fresh buffer's
  DataView; both handshake roles share the `hkdf(concatBytes(dh1,dh2,dh3),…)`
  session-key block.

## Cross-shard dedup opportunities (not touched — outside shard)

- The 64-hex fingerprint guard `/^[0-9a-f]{64}$/` is re-implemented in
  `lan.ts` (`isFp`, ours), `apps/mobile/src/adapters/secure-sync-keys.ts`
  (`isFpList`), `apps/mobile/src/adapters/expo-sync-discovery.ts`,
  `apps/desktop/src/shared/contract.ts` (×2), `apps/desktop/src/utility/
  sync-mdns.ts` (×2). One exported `isFp`/`isFpList` from the application
  package could serve all of them.
- `apps/mobile` `secure-sync-keys.ts` `isFpList` mirrors `custody.ts`'s
  `isStringList` pattern.

## Deliberately NOT touched

- `sync-client.ts` `exportFittedPage` was not merged into
  `exportFittedDeltaDoc`: it additionally enforces the sealed-frame/session
  cap, not just the delta-document cap — different contract.
- All guard semantics preserved verbatim: `Object.hasOwn` vs `in`, strict
  `typeof x === 'string' && x.length > 0` checks, `try/catch` around
  `JSON.parse`/seal paths (throw ≠ absent), explicit `=== undefined` branches
  where throw/invalid/absent/cancel have distinct outcomes.
- No test files modified; no new `any`/`as`/`@ts-ignore`;
  `exactOptionalPropertyTypes` untouched.
- Remaining bulk in sync-engine (2893), sync-projection (2098), sync-client
  (1453), sync-responder (907) is protocol/state-machine code and per-shape
  validation — irreducible without behavior risk.

## Gates

`pnpm -C packages/application typecheck` ✓ · `pnpm -C packages/application
test` ✓ (incl. `harness/reliability-measure.ts`, all scenarios recovered) ·
`pnpm -C apps/mobile typecheck` ✓ · `pnpm -C apps/desktop typecheck` ✓ —
run before every commit and on the final tree.

## Final diff stat vs `a675a7b`

```
 custody.ts         |  15 +-
 delta-docs.ts      |  12 +-
 engine-port.ts     |  44 +-
 entry-order.ts     |  62 +++
 hlc.ts             |   8 +-
 lan.ts             |  84 ++-
 noise.ts           |  91 ++--
 sync-client.ts     |  67 ++-
 sync-engine.ts     | 629 +++++++--------------
 sync-host.ts       | 117 ++---
 sync-projection.ts | 557 ++++++++----------
 sync-responder.ts  |  63 +--
 sync-scheduler.ts  |  75 ++-
 sync-wire.ts       |  122 ++--
 14 files changed, 806 insertions(+), 1140 deletions(-)
```
