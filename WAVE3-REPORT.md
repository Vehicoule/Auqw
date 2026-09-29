# WAVE3-REPORT — shard: app-shell-pkg

Scope: `packages/app-shell/src/**` only. Base commit: `a675a7b`.

## Line counts

Measured with `wc -l packages/app-shell/src/*.ts` on `a675a7b` (`git show a675a7b:<path> | wc -l`) and `HEAD`.

| file                  | base | head | delta |
|-----------------------|------|------|-------|
| `app-shell.ts`        | 3336 | 3084 | −252  |
| `types.ts`            |  538 |  482 |  −56  |
| `app-shell.test.ts`   |  362 |  362 |    0  |
| `index.ts`            |   17 |   17 |    0  |
| **total**             | 4253 | 3945 | −308 (−7.2%) |

## What was deleted, and why it was safe

- **~40 dead bindings on/inside `useAppShell`** — a repo-wide
  destructure check showed apps consumed none of them: unused return
  fields (`diagnostics`, `pendingReviews`, `reviewFilter`,
  `storageText`, `suggestionMeta`, `attempts`, `fetchLyrics`, …) and
  unused internal intermediates (`canPlayMeta`, `playMeta`,
  `dispatchPlay`, `runSearch`, `recordRecentSearch`, `playing`,
  `currentRecordingId`, `positionMs`, …). Verified against
  `AppShellController` so every remaining field is either destructured
  by desktop/mobile or part of the declared contract.
- **Dead single-caller aliases** `openStage`, `openRowActions`,
  `openPlaylistPicker` — each forwarded to the overlay stack unchanged.
- **Dead imports**: `appError`, `appErrorKind`, `err`, `TrackMetadata` —
  referenced nowhere in the package or repo.
- **Duplicated `ActionTargetLike` union** — was a structural copy of
  `ActionTarget` from `@auqw/ui-shared`; now
  `export type ActionTargetLike = ActionTarget` (export preserved).
- **Redundant `provenance === 'local'` re-check** in `libraryModel` —
  `LocalFileSource.recordings()` already filters to local provenance.
- **Redundant `switch` default** on an exhaustive union switch.
- **Dead `eslint-disable`** positioned over a `}` token where nothing
  can be flagged; the live disable on the deps array was kept.
- **Doc comments in `types.ts` that restated the signature** — port
  names already say what the member does; operational comments kept.

## Simplifications applied

- **Shared throttles**: `usageTimer`/`downloadsTimer` duplicated a
  trailing-throttle pattern — now one `Throttle` struct + `trailing()`
  helper, one cleanup loop.
- **Shared op funnels**: `opContext`, `freshSignal`, `reporter`,
  `refKey` deduplicated across ~a dozen `void op(...).then(...)` sites.
- **Deduped helpers (all preserve call order and stale/cancel guards)**:
  - `cancelSuggest` — shared search-generation supersession.
  - `playRows` — shared `canPlay` filter + `session.playRecordings`
    dispatch for collection/playlist/recent entry points.
  - `updateEntityFetch` — stale-ref-guarded `setEntityFetches` updates.
  - `playMetaRow` — shared metadata-tap gate: playability check *before*
    recent-search recording, preserving side-effect order.
  - `createPlaylistThen` — shared playlist create + report funnel.
  - `failImport` — shared import-error transfer patch.
  - `startRadio` — shared `session.startRadio` + `radioSeedable` guard.
  - `clearOverlays` — merged overlay reset + `setEntityFetches({})`.
  - Hoisted `setPickerOpen`/`setImportOpen`/`setExportOpen`-style
    `set(false)` closers shared by commit callbacks and the return.
- **Verbosity**: declaration+init joins, expression-bodied callbacks
  where the deps array didn't re-wrap, `let` in place of a building
  IIFE (`libraryModel`), shared `decorate` map, one `local().list()`
  read instead of two (pure read), `committedQuery` expression reused
  by `localResults`, single-use `playing` flag inlined.
- **Comment trims**: removed comments restating the next line; kept
  comments that record non-obvious invariants (ownership vs. playback
  capability, offline honesty, provider-ref visibility, retry
  reporting, section headers for the ~2900-line function body).

## Cross-shard dedup opportunities (not edited — outside shard)

- Both apps wire `ports` for `useAppShell` by hand and duplicate small
  seams (`local()`, connectivity, toast adapters). A shared
  `makeAppShellPorts` factory or default-impl objects could collapse
  the app-side boilerplate — lives in `apps/desktop` + `apps/mobile`.
- `index.ts` re-exports `advanceTargetId`, `playlistDownloadPlan`,
  `reportStoredDownloadError`, `rowActionsModel`, `stageDownloadChip`
  plus type exports; today only `useAppShell` and `AppShellPorts` are
  imported by apps. If the public-surface contract is ever relaxed,
  `index.ts` could shrink to ~4 lines and the helpers could unexport.
- The `download missing` / retry-report funnel shape in app-shell
  mirrors the desktop sync-adapter's guarded-write pattern; a shared
  `reportThenRetry` combinator could live in `ui-shared`.

## Deliberately not touched

- `app-shell.test.ts` (362 lines) — tests are the contract, unchanged.
- `index.ts` — public export surface, contract preserved verbatim.
- `AppShellPorts` member set — platform seams are a decided boundary
  (`decisions.md`); collapsing ports would redesign the shard's edge.
- The `setEntityFetches` write that spreads a *captured* `cur`
  (`loadingMore` patch): it deliberately re-adds an entry that
  `clearOverlays` may have wiped — rewriting it through
  `updateEntityFetch` (which reads `prev[key]`) would silently drop the
  update in that race. Kept verbatim.
- `useCallback`/`useMemo` wrappers and deps arrays — required for
  reference stability; suppression comments that encode intentional
  deps choices were kept.
- Reset of `importText`/`importPreviewRaw` in the export/import cases
  could not reuse the `resetTransfer` helper (TDZ: helper is defined
  below the callback); extracting it module-level would type the refs
  awkwardly for a 2-line saving — skipped.
- Section-header comments (`// ---- … ----`) — the only navigation
  aid in a ~3000-line function; removal saves ~40 lines at a real
  readability cost.

## Gates

All run on the final tree, all green:

```bash
pnpm -C packages/app-shell typecheck && pnpm -C packages/app-shell test   # tsc clean; "app-shell tests passed"
pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test               # tsc clean; "desktop shell tests passed"
pnpm -C apps/mobile typecheck && pnpm -C apps/mobile test                 # tsc clean; "mobile shell tests passed"
```

## Final `git diff --stat` vs `a675a7b`

```text
 packages/app-shell/src/app-shell.ts | 1946 +++++++++++++++--------------------
 packages/app-shell/src/types.ts     |  350 +++----
 2 files changed, 994 insertions(+), 1302 deletions(-)
```

Net source delta: −308 lines (−252 `app-shell.ts`, −56 `types.ts`),
accumulated over 7 commits (`121076e`…`abc4d8d`). No behavior change:
all reductions are dead-code removal, mechanical dedup behind
order-preserving helpers, or comment/whitespace compression; every
public export and signature is intact.
