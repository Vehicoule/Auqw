# Wave-3 shard report — app-session

Scope: `packages/application/src/session/**`
Base: `a675a7b` (pre-squash appshell tip — rebased onto `origin/main` for the PR).

## Result

7 files changed, +1025/−1257 = **net −232 LoC** (src only — `session.test.ts` untouched, it is the contract).

| file | before | after | note |
|---|---|---|---|
| session.ts | ~3050 | ~2699 | queue-mutation tails + restore branches folded |
| playback-engine.ts | ~4100 | ~3913 | warm-candidate head, dealt-walk, wrap-to-head, port-call tails |
| sync-ingress.ts | ~1020 | ~804 | two ~140-line apply methods → one generic `#runSyncApply` lane |
| radio-coordinator.ts | ~870 | ~793 | `boundedOp`/`boundedCommit`/`withSource` folds |
| library-service.ts | ~680 | ~643 | `boundedLoad`/`withSource` folds |
| ready.ts | ~250 | ~192 | shared `SessionHostCore` seam |
| util.ts | ~90 | ~131 | hosts the new shared helpers |

## What was done

- One `SessionHostCore` object shared across the service seams instead of
  re-deriving `{deadline, context, host}` triples per call site.
- `#mutateQueue` / `#commitAndDerive` helpers collapsing the repeated
  `snapshot → marks → try → persistQueue → derived` tails. **Fix applied
  mid-sweep:** the first fold ticked `derived()` inside the helper's
  continuation — the serializer defers the radio arm via a microtask, so
  the deferred work ran *before* callers reached `startAttempt` and the
  `radio-tail` test caught the ref never seeding. Helpers now leave the
  tick to the caller continuation; three unwrap-only sites keep the
  folded form (observably identical).
- `boundedCall`/`boundedOp`/`boundedCommit`/`boundedLoad`/`withSource` —
  the repeated `withDeadline + CancellationSource + trackSource +
  try/finally untrack` scaffolding across the shard (8 `withSource`
  sites). Context-free calls get `boundedCall` so `requestId` mint
  sequences are not shifted.
- `#warmCandidates` — shared seen-mark→route→candidates→stale head of
  `#warmOne`/`#warmOneQuery`.
- `#dealtWalk` — the `snapshot → dealtOrder ?? occurrences → pos` walk at
  three sites.
- `#wrapToHead` — the `ended` branch's wrap block shared with `advance`.
- `#runSyncApply` — `applySyncedEntries` and `applyMaterializedEntries`
  were ~140 lines each at ~80% identical; now lane objects + one body.

## Deliberately not touched

- `session.test.ts` — the behavior contract.
- `#persist`/`#commitStaged` tails — differ on failure paths; shared tail
  is ~4 lines, folding buys nothing.
- `advance`'s `persistQueue` sites — need `after` captured mid-op, can't
  fold without moving a seam.
- Context-mint-before-`enqueueStorage` sites (`importLibrary`) — folding
  the mint inside the op shifts requestId sequences.
- `maybeMapSuccessor` warm head — differs on mappingSource bookkeeping.
- Dead-export sweep: every session export is consumed inside or outside
  the package — nothing provably dead.

## Gates

- `pnpm -C packages/application typecheck && test` — green.
- Cross-package: `pnpm -C apps/mobile typecheck`, `pnpm -C apps/desktop typecheck` — green.
