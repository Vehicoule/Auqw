# Wave-3 LoC-reduction report — shard: `packages/ui-native/src`

Base: `a675a7b` · Branch: `devin/w3-ui-native` · 18 commits.

**Cumulative delta vs base: +978 / −1468 → net −490 LoC across 25 files**
(counts `packages/ui-native/src` only; the PR diff's −338/−339 nets
further include this report file's own lines).
(shard total 12 561 → 12 071 lines).

Gates, green before every commit and at HEAD:

```
pnpm -C packages/ui-native typecheck   # tsc --noEmit — clean
pnpm -C packages/ui-native test        # ui-native tests passed
```

## Per-file LoC (base → now, net)

| Δ | before → after | file |
|---:|---|---|
| −138 | 1041 → 903 | progress.tsx |
| −68 | 1499 → 1431 | stage-sheet.tsx |
| −53 | 309 → 256 | entity-screen.tsx |
| −42 | 303 → 261 | track-row.tsx |
| −41 | 221 → 180 | queue-list.native.tsx |
| −41 | 250 → 209 | corrections-screen.tsx |
| −39 | 318 → 279 | search-screen.tsx |
| −38 | 547 → 509 | sheets.tsx |
| −34 | 1012 → 978 | gallery.tsx |
| −30 | 125 → 95 | collection-screen.tsx |
| −30 | 299 → 269 | playlist-screen.tsx |
| −24 | 262 → 238 | transfer-screen.tsx |
| −23 | 143 → 120 | queue-screen.tsx |
| −16 | 508 → 492 | library-screen.tsx |
| −12 | 139 → 127 | index.ts |
| −9 | 796 → 787 | sync-screen.tsx |
| −6 | 224 → 218 | platform-tabs.native.tsx |
| −2 | 258 → 256 | home-screen.tsx |
| −2 | 277 → 275 | settings-screen.tsx |
| +89 | 978 → 1067 | primitives.tsx |
| +45 | 130 → 175 | states.tsx |
| +21 | 134 → 155 | queue-list.tsx |
| +2 | 56 → 58 | platform-tabs.tsx |
| +1 | 381 → 382 | mini-player.tsx |
| 0 | 87 → 87 | artwork.tsx |

Untouched: `navbar.tsx` (206), `stage-motion.ts` (111),
`stack.native.tsx` (96), `stack.tsx` (90), `theme.tsx` (89),
`motion.ts` (87), `qr-code.tsx` (56), `ui-native.test.ts`.

The three "+" files are shared-infra hosts: `primitives.tsx` absorbed
`BackButton`, `bind`, `PlayingArtwork`, `BackRow`, `IconButton`'s
inert-disabled contract; `states.tsx` absorbed `StateShell`/
`StateCopy`/`StateFor`; `queue-list.tsx` hosts `QueueRowChrome` for its
native twin. Each pays for itself many times over at the call sites.

## Dead code removed

- **index.ts** — deleted 10 exports with zero importers anywhere in the
  repo (verified by repo-wide `rg -w` per symbol, excluding the file
  itself): `AndroidNavbar`, `IosGlassNavbar`, `AppNavbar`, `NavbarProps`,
  `AppNavbarProps`, `PlatformTabsProps`, `SyncScreenProps`,
  `useArtworkResolver`, `useResolvedArtworkUri`,
  `ArtworkResolverProviderProps`. The components/hooks remain for
  internal use; only the dead public surface went away.
- **artwork.tsx** — `useArtworkResolver` unexported (same-file use only).
- **progress.tsx** — dropped the ring-sampling machinery superseded by
  `SQUARED_RING_PATH`/`SQUARED_RING_LENGTH` constants, and the `scrubbing`
  shared value (written on every drag frame, never read).
- **stage-sheet.tsx** — `playSize` field of `transportVariant`: computed
  and carried, never consumed (removed together with mini-player).
- **queue-list.native.tsx** — removed the duplicated `QueueListProps`
  type; re-exports the shared one.

## Simplifications applied

- `stage-sheet.tsx`: shared `button()` render helper collapses five
  near-identical `IconButton`s in `TransportControls`; `settle` worklet
  merges the two spring-back paths in `onFinalize`; lyrics error/empty/
  loading branches → shared `StateFor`; immersive/flat content wrapper
  hoisted to a single `content` node.
- `progress.tsx`: `clamp01` + `frac`/`drag` worklets replace six inline
  clamp sites; `skeletonBars` removes the second copy of the shimmer-Rect
  list (rendered once, reused in the `ClipPath`); `dTerciles` collapses
  the three near-identical `AnimatedPath` layers.
- `mini-player.tsx`: `settleBack` worklet folds the three
  restore-progress branches; `emit`/`callbacks` ref pattern keeps gesture
  objects stable across position ticks.
- `track-row.tsx`: `trailIcon` helper for the three identical trailing
  state badges (download/warn/static-heart).
- `settings-screen.tsx`: `bind` for row callbacks; redundant `disabled`
  props dropped (`Pressable` infers inert from missing handler).
- `entity/search/collection/playlist/corrections/transfer screens`:
  controller-driven `StateFor`/`BackRow`/`bind` collapse the repeated
  header, state, and curried-handler shells.
- `queue-list.tsx` + `queue-list.native.tsx`: `QueueRowChrome` owns the
  section-header/repeat-badge/row chrome shared verbatim by both
  variants.
- `primitives.tsx`: `PlayingArtwork` (artwork + scrim + EqBars overlay)
  replaces identical blocks in `track-row` and `queue-screen`; `Icon`'s
  three-case shape switch now shares common props; `BackRow` for the
  pushed-screen header.
- `gallery.tsx`: `ShowcaseFrame` for the repeated caption+frame
  showcase maps; `stagePlayer` and per-screen handler objects shared;
  PLATFORMS hoisted; four state cells mapped.
- `sheets.tsx`: `SheetRow` collapses six identical row styles;
  `SheetScaffold` owns the title/dismiss chrome for all five sheets.
- `sync-screen.tsx`: shared `fieldBox`/`digits6`, delta buttons mapped.
- `library-screen.tsx`: grid/list card-layout branches merged.
- `platform-tabs.native.tsx`: `routeFor` condensed; `onIndexChange`
  simplified. `platform-tabs.tsx`: hidden-branch guard merged.
- `states.tsx`: `StateShell`+`StateCopy` factor the four state views;
  `StateFor` maps controller `StatePhase` unions to them.

## Deliberately NOT touched

- **`navbar.tsx`** — a shared `NavItem` was tried and reverted: the
  source-based test (`testNavbarTextScale`) requires ≥2 literal
  `adjustsFontSizeToFit` occurrences, one per platform variant; the
  abstraction also made the file *larger* (206 → 210). The Android/iOS
  label duplication is structural and intentional.
- **`stage-sheet.tsx` gesture/anchor core** — shared values, worklet
  identity, velocity-carrying springs and the `anchor`/`risen` ownership
  protocol are behavior-critical; further dedup risks cancelling
  in-flight gestures or restarting springs.
- **Worklet twins (`motion.ts`, `progress.tsx`, `stage-motion.ts`
  `clamp01`)** — reanimated worklets cannot call non-workletized
  cross-module helpers; the per-file twins are documented and required
  by the runtime, not accidental duplication.
- **`ui-native.test.ts`** — the contract; untouched.
- **`TransferScreen` reset Pressables** — `done` and `error` footers
  differ in padding (`xs` vs `sm`); hoisting would change layout.

## Cross-shard opportunities (noted, not edited — outside `src/**` scope is owned elsewhere)

- `packages/ui-web` carries near-copies of `TrackRow`, `queue-screen`,
  progress primitives and `index.ts` export tables — a shared
  composition layer in `@auqw/ui-shared` could dedup the RN/web twins,
  but that is a ui-web shard decision.
- `apps/mobile` consumes the trimmed index surface only — the deleted
  exports had zero references in any app/package.

## Final `git diff --stat` vs `a675a7b`

```
25 files changed, 978 insertions(+), 1468 deletions(-)
```

Full per-file stat is reproduced in the table above (`git diff a675a7b
--stat -- packages/ui-native/src` on `devin/w3-ui-native`).
