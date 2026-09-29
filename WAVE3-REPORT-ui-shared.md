# Wave-3 LoC reduction — `packages/ui-shared`

Base: `a675a7b` · Branch: `devin/w3-ui-shared` (10 commits)

Total: **11 243 → 10 669 lines (−574, −5.1%)** across `src/**`
`git diff --stat` vs base: 11 files, +1 055 / −1 629.

## Per-file LoC

| file | before | after | Δ |
|---|---:|---:|---:|
| view-models.ts | 2 171 | 1 911 | −260 |
| controllers.ts | 1 840 | 1 785 | −55 |
| ui-shared.test.ts | 1 419 | 1 398 | −21 |
| fixtures.ts | 1 450 | 1 342 | −108 |
| locales/es.ts | 579 | 579 | 0 |
| locales/fr.ts | 573 | 573 | 0 |
| locales/de.ts | 572 | 572 | 0 |
| locales/en.ts | 552 | 552 | 0 |
| locales/zh.ts | 548 | 548 | 0 |
| shell.ts | 580 | 545 | −35 |
| peaks.ts | 244 | 211 | −33 |
| i18n.ts | 210 | 195 | −15 |
| error-text.test.ts | 141 | 141 | 0 |
| waveform.ts | 144 | 122 | −22 |
| error-text.ts | 72 | 72 | 0 |
| use-waveform-peaks.ts | 68 | 67 | −1 |
| motion.ts | 53 | 38 | −15 |
| index.ts | 27 | 18 | −9 |

## Dead code removed (verified by repo-wide `rg`, incl. apps + sibling packages)

- **`getLocale()`** (i18n.ts + index export + its sole test assertion) — no
  consumer anywhere except the shard's own test for it.
- **`fromTag` from the public index** — still used internally by
  `resolveLocale`/`view-models`, just not part of the package surface.
- **`staggerProgress`, `shimmerHighlight`** (waveform.ts) — superseded
  helpers left behind by earlier consolidations; zero importers.
- **Merged i18n lookups** — duplicate catalog-resolution branches in
  `resolveLocale`/`t` collapsed.

A full dead-export sweep (`rg` for every exported identifier, repo-wide,
excluding the shard itself) found no other removable values — remaining
"externally unused" names are type exports that cost nothing to keep.

## Simplifications

- **controllers.ts**: `MaybeFn` alias + one `bind()` helper replaces every
  `x === undefined ? undefined : () => x(...)` wrapper (handler fields keep
  `undefined` semantics); `queueSectionLabel` is a key-driven `t()` call;
  search-status ternary flattened; filter chips / stage modes / provider
  slots are data tables.
- **view-models.ts**: shared row builders (`collectionRow`,
  `missingRecordingRow`, `countByRecordingId`, `headArtwork`); queue-walk
  dedup; key-driven labels (`review.*`, `sync.state.*`, `player.title.*`);
  player-model switch merged on identical branches; `languageOptions`
  maps a locale tuple; `toRadioModel(null)` compacted.
- **shell.ts**: `NAV_KEYS`/`QUALITY_TIERS`/`THEME_ORDER`+`THEME_DETAIL`
  tables; merged provider-slot tables; `useOverlayStack` shares one
  `run()` around `setStack`.
- **fixtures.ts**: builders for every repeated literal family —
  `trackMeta`, `candidate`, `recording`, `like`, `ownedEntity`,
  `playlistEntry`, `playEvent`, `occ`, `searchState`, `entityModel`,
  `correctionsFixture`, `syncModel`, `playlistModelFor`, `lyricsState`,
  `transferModel`; deezer `EntityRef`s hoisted to consts;
  `fixtureHomeModel` recents/suggestions via `slice().map(toRailCard)`.
- **peaks.ts**: stereo/mono accumulation loops merged; `flatMap` +
  `map` replace manual index loops; `out` alloc moved past the
  early return.
- **i18n.ts**: `fromTag` non-Chinese branch is a boolean expression.
- **motion.ts**: quad constants one-lined.
- **index.ts**: re-exports merged.

## Cross-shard opportunities (not implemented — out of scope)

- `fixtureNavItems` mirrors `NAV_ITEMS` in `apps/mobile/App.tsx` by
  comment contract only — a shared constant would pin them together.
- `quadPath`/`progressPathState` have worklet twins in `ui-native`
  (reanimated can't call non-workletized cross-package imports) —
  structural constraint, not real dup.
- `TEXT_BY_KIND` (error-text.ts) enumerates `ErrorKind` for the
  `error.*` catalog — the taxonomy lives in `@auqw/application`; a
  generated map could keep them in lockstep.
- Sync peer/status fixture literals overlap shape-wise with app-shell
  sync test data; a shared fixture-builder package could dedupe.

## Deliberately untouched

- **locales/*.ts** (2 794 lines): all 473 `MessageId` keys verified live
  — every key is referenced by a literal `t()` call, a constants table,
  or one of the 17 dynamic template prefixes. Pure catalog data.
- **ui-shared.test.ts / error-text.test.ts**: tests are the contract;
  only the `getLocale` assertion was removed (it tested deleted code).
- **use-waveform-peaks.ts**: the two `useEffect`s have deliberately
  different dep lists (cancel-vs-fold lifecycle); merging them changes
  behavior.
- **resamplePeaks max-guards**: `>` comparisons differ from `Math.max`
  on NaN input — kept.
- **error-text.ts**: exhaustive `Record<ErrorKind, MessageId>` is the
  taxonomy contract; one line per kind is already minimal.
- Fixtures' remaining literals (sync peers, queue snapshot, reviews):
  distinct data values — builder-cost would exceed savings.

## Gates (all green on the final tree)

```text
pnpm -C packages/ui-shared typecheck   → tsc --noEmit clean
pnpm -C packages/ui-shared test        → ui-shared + error-text tests passed
pnpm -C apps/mobile typecheck          → tsc --noEmit clean
pnpm -C apps/desktop typecheck         → tsc --noEmit clean
```
