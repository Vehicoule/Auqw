# Wave-3 LoC-reduction report — SHARD: app-core

Branch `devin/w3-app-core`, base `a675a7b`. Scope: `packages/application/src`
minus `session/` and `sync/`. Behavior-identical throughout; all gates green.

## Totals

- Non-test source in shard: **13859 → 13091 lines (−768, −5.5%)**
- `git diff --stat a675a7b..HEAD`: 24 files changed, 1162 insertions(+),
  1930 deletions(−), net **−768**
- 25 commits, one per file or logical unit, each landed with the full gate
  suite green (shard typecheck+test, apps/mobile + apps/desktop typecheck).

## Per-file LoC before → after

| File | Before | After | Δ |
|---|---|---|---|
| testing/fakes.ts | 1552 | 1392 | −160 |
| downloads/download-manager.ts | 1060 | 1023 | −37 |
| domain.ts | 935 | 856 | −79 |
| local/local-source.ts | 873 | 851 | −22 |
| library/artwork-cache.ts | 852 | 797 | −55 |
| library/library.ts | 807 | 751 | −56 |
| providers/provider-wire.ts | 772 | 709 | −63 |
| queue/queue-engine.ts | 682 | 650 | −32 |
| library/corrections.ts | 677 | 587 | −90 |
| matching/matching-engine.ts | 584 | 569 | −15 |
| downloads/transfer-policy.ts | 497 | 494 | −3 |
| queue/radio-tail.ts | 399 | 358 | −41 |
| library/lyrics.ts | 389 | 364 | −25 |
| ports/player.ts | 311 | 294 | −17 |
| search/search-session.ts | 306 | 300 | −6 |
| library/playlists.ts | 268 | 267 | −1 |
| providers/provider-router.ts | 259 | 254 | −5 |
| peaks-tracker.ts | 255 | 255 | 0 |
| retry.ts | 254 | 226 | −28 |
| library/history.ts | 240 | 236 | −4 |
| downloads/sha256.ts | 140 | 134 | −6 |
| errors.ts | 135 | 138 | +3 |
| runtime-impls.ts | 130 | 109 | −21 |
| library/likes.ts | 74 | 69 | −5 |

## Dead code deleted (proven with repo-wide `rg`)

`testing/fakes.ts` — 17 members with zero references anywhere in the repo
(exports are consumed cross-package, so each was checked repo-wide, not
just in-shard):

- `settleResolveAt`, `settleDetailsAt`, `settleEntityAt`, `settleArtworkAt`,
  `settleLyricsAt`, `settleRadioAt`, `settleSuggestAt`, `settlePrepareAt`
  — indexed settle variants superseded by the plain `settleX` forms.
- `pendingPrewarms`, `MAX_ATTEMPTS`, `writesLog`, `commitsLog`,
  `sweptPartials`, `dirReady`, `pickCalls`, `enumerateCalls`,
  `readTagsCalls`, `snapshotCalls`, `storedDivergenceFloor`,
  `storedDivergenceReplayOffset` — counters/logs no test reads.
- `queue-engine.ts`: private `sameRef` duplicate — replaced by the
  exported `sameRef` from `session/util.ts` (identical semantics).
- `local/local-source.ts`, `download-manager.ts`: internal types
  unexported where nothing outside the file referenced them.

## Over-abstraction collapsed

- `corrections.ts`: one shared serialized load/persist skeleton for all
  ops; single-use `resolveSignal` helper inlined to
  `signal ?? new CancellationSource().signal`.
- `sha256.ts`: `createSha256` returned an adapter object wrapping the
  state class — now returns `new Sha256State()` (structurally satisfies
  `ChunkHasher`; callers only use method calls, so `this` binding is safe).
- `likes.ts`: `like`/`unlike` collapsed into one internal toggle.
- `library.ts`: `hasUniqueIds` reused for the like/entityRef key loops.
- `radio-tail.ts`: local `winningMapping` removed in favor of
  `collapseByRef` shared with matching-engine.
- `errors.ts`: added `cancelledError()` (canonical
  `appError('cancelled','cancelled')`), adopted at all ~10 in-shard sites
  — identical error kind/message. `runtime-impls.ts`'s private copy
  deleted (a self-recursive shadow briefly introduced mid-edit was
  repaired before commit).
- `peaks-tracker.ts`/`retry.ts`: reused shared `internalError` /
  `timeoutError` / `sameRef` from `session/util.ts` where messages
  already matched.

## Duplicated logic consolidated

- `domain.ts`: new `isIn(set, v)` string-membership guard replaces ~9
  copy-pasted enum-membership chains (version labels, mapping statuses,
  themes, like kinds, provenance, download states, source-ref kinds);
  shared `audioFields(metadata)` spread feeds both
  `recordingFromMetadata` and `mergeRecordingMetadata`.
- `provider-wire.ts`: removed a local `isStorefront` byte-identical to
  domain's export; `isOptWireString` for the repeated
  `null | nonempty string` checks; `matchedField`, `staticLyrics`,
  `lyricsBase` and `toLyricsLine` share the synced/plain lyrics decoders'
  preamble and per-line validation; `hasKeys` used for optional wire keys.
- `matching-engine.ts` ↔ `corrections.ts`: dice multiset scoring and
  `collapseByRef` moved to the matching module and shared.
- `download-manager.ts`: triplicated connectivity/metered eligibility
  check became one private `#netEligible` used by the subscription,
  `reevaluateEligibility`, and the transfer pump.
- `artwork-cache.ts`: dest-removal and `??=` first-error capture
  factored; `invalid-response` constructor shared across 7 sites.
- `radio-tail.ts`: shares `refKey`/`sameRef`/`sameError`/`collapseByRef`
  instead of local reimplementations.
- `retry.ts`/`downloads`: `sameRef` reuse; shared internal/timeout error
  helpers.

## Verbosity reduced (control flow only)

- `matching-engine.ts`: merged the eligible-collection and scoring
  passes into one loop (short-circuit order preserved — `evidence()` is
  pure); `for…of entries()` drops `??` index guards; bigram builder and
  duration-adjustment chain condensed.
- `queue-engine.ts`: `previous()`'s two rewind branches merged into one
  predicate — case analysis verified: pos>0 at head rewinds, pos>3000
  live rewinds, blocked rows step, pos=0 at head is a no-op.
- `transfer-policy.ts`: `raise()` converts failed port Results to typed
  `DownloadFailure`s; `sinkOpen` bookkeeping folded into `openSink`.
- `library/lyrics.ts`: `lyricsSheet` is `{ ...accepted, ...source }`
  (structural spread over the same discriminated union — identical
  fields); LRC timestamp guards merged; `Math.max` replaces manual
  clamp.
- `corrections.ts`, `library.ts`, `playlists.ts`, `search-session.ts`,
  `provider-router.ts`, `runtime-impls.ts`, `history.ts`: early returns,
  `hasKeys`/`hasExactKeys` domain guards replacing hand-rolled key
  loops, ternary dispatch tails, dynamic console-level lookup.
- `fakes.ts`: shared `deferred`/`clone`/`cancelled` helpers,
  spread-merge for staged batches, folded lyrics capability ladder,
  `err()` replaces hand-built `{ ok:false, error }` literals.

## Deliberately NOT touched

- **`local/local-source.ts` (851)** — SAF enumeration, fingerprinting,
  move detection, duplicate disambiguation, tag reads, tombstones and
  concurrent commit merging. Cosmetic-only yield; the bulk is real
  scan bookkeeping. −22 came from type unexports only.
- **`ports/*.ts`** — interface/type contracts; comments document the
  seam semantics. Nothing removable without an API change.
- **`cancellation.ts`, `race.ts`, `index.ts`, `errors.ts` core** —
  already minimal primitives.
- **`testing/assert.ts`, `testing/noise-test-peer.ts`,
  `library/export-import.ts`** — tight as written; a `previewImport`
  condensation attempt netted zero and was left at base state.
- Repeated `appError('internal','clock returned an unsafe timestamp')`
  literal (5 sites) — a shared helper would net ~0 lines after
  export+imports; messages differ across other `internal` sites so no
  broader consolidation is exact.

## Cross-shard dedup opportunities (noted, not edited)

- `session/util.ts` and `errors.ts` both mint `'internal'`/timeout
  errors — could converge on one error-helper module (this shard now
  imports session's helpers rather than duplicating; `cancelledError`
  lives in errors.ts and session/ could adopt it).
- `sync/sync-engine.ts` has ~6 more `'clock returned an unsafe
  timestamp'`/`'local write produced no entry'` literals matching the
  in-shard pattern — a `clockUnsafeError()`/`internalError(message)`
  helper would serve both shards.
- `fakes.ts` `sameRef`-equivalents and `err` literals remain in other
  shards' test utilities.

## Verification

```bash
pnpm -C packages/application typecheck   # green
pnpm -C packages/application test        # green (unit + reliability harness)
pnpm -C apps/mobile typecheck            # green
pnpm -C apps/desktop typecheck           # green
```

All four gates re-run before every `src/` commit and after the final
edit. Reliability-harness scenarios (playback recovery, transient
search/lyrics/entity, artwork negative cache, sync scheduler triggers)
all report recovered/expected values.
