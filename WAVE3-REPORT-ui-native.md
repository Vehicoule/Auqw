<<<<<<< HEAD
# Wave-3 LoC-reduction report — shard: ui-web

Branch: `devin/w3-ui-web` · base: `a675a7b`
Scope: `packages/ui-web/src/**` only.
Gates green before every commit (`pnpm -C packages/ui-web typecheck && pnpm -C packages/ui-web test` — 166 assertions, unchanged test file).

## Totals

| Metric | Base `a675a7b` | Final | Δ |
|---|---|---|---|
| `packages/ui-web/src` total (incl. CSS, tests, loader) | 11,454 | 9,904 | −1,550 |
| `git diff --stat` vs base | — | — | +1,213 / −2,763 (net −1,550) |

## Per-file LoC (before → after)

| File | Base | Final | Δ |
|---|---|---|---|
| gallery.tsx | 798 | deleted | −798 |
| index.ts | 167 | 45 | −122 |
| progress.tsx | 797 | 657 | −140 |
| settings-screen.tsx | 651 | 574 | −77 |
| sheets.tsx | 753 | 762 | +9 |
| primitives.tsx | 656 | 726 | +70 |
| now-playing-screen.tsx | 646 | 597 | −49 |
| library-screen.tsx | 385 | 333 | −52 |
| queue-list.tsx | 378 | 353 | −25 |
| track-row.tsx | 288 | 302 | +14 |
| playlist-screen.tsx | 291 | 257 | −34 |
| search-screen.tsx | 270 | 210 | −60 |
| entity-screen.tsx | 240 | 207 | −33 |
| chrome.tsx | 228 | 212 | −16 |
| transfer-screen.tsx | 197 | 175 | −22 |
| stack.tsx | 180 | 174 | −6 |
| corrections-screen.tsx | 174 | 154 | −20 |
| home-screen.tsx | 165 | 165 | 0 |
| collection-screen.tsx | 130 | 100 | −30 |
| keyboard.ts | 124 | 121 | −3 |
| mini-player.tsx | 114 | 107 | −7 |
| theme.tsx | 112 | 112 | 0 |
| states.tsx | 98 | 98 | 0 |
| queue-screen.tsx | 90 | 84 | −6 |
| qr-code.tsx | 47 | 40 | −7 |
| index.ts | (above) | | |
| settings-focus.ts | 31 | 23 | −8 |
| motion.ts | 18 | deleted | −18 |
| styles.css | 2,628 | 2,518 | −110 |

Files where a shared abstraction landed show a small increase (primitives +70 absorbs `ScreenHead`, `SegmentItem`, `DiagPressRow`, `CapsLabel`; track-row +14 absorbs `indexAdapter`/`bindTo` used by six files; sheets +9 absorbed `Field`/`SheetRow`/`PillAction`/`DiagPressRow` while deleting more duplication than it added — net effect is measured across the shard, not per-file).

## Deleted code (verified dead repo-wide with `rg`)

- **`gallery.tsx` (798 lines)** — the component gallery was unreachable: not exported from `index.ts`, no importer anywhere in `packages/` or `apps/`.
- **`motion.ts` (18 lines)** — single helper left behind by earlier consolidation; no references.
- **Dead re-exports in `index.ts` (−122)** — pruned the re-export list to what the tests and external consumers actually import (the package's only entry points are `.` and `./styles.css`).
- **Dead CSS (~166 lines in the last pass, more earlier)** — the entire `/* ---- gallery ---- */` section (`.uw-gallery*`, `.uw-icon-swatch`, `.uw-frame`), `.uw-pairing__payload`, `.uw-sidebar__item`, plus dead rows in two selector groups. Zero class references in any `.ts`/`.tsx`/`.js` in the repo.
- **`.uw-libcard--row` rules** — never matched: `LibraryCard` emits `uw-libcard--${'grid'|'list'}`. See "latent bug" note below.
- **`SheetScaffold` export** — internal-only; kept the function, dropped the `export`.
- **`LinearScrubber`** — superseded by `WaveformSeek`; no consumers.
- **`TrackListController.listProps`** — its `role` field was dead; every consumer only read `onKeyDown`. Flattened to `onKeyDown` directly.

## Simplifications applied

- **Shared row-handler adapters** (`track-row.tsx`): `indexAdapter(items, fn)` (item-callback → index-callback for `useTrackList`) and `bindTo(fn, item)` replace ~15 inline adapters across entity/search/playlist/collection/library screens.
- **Handler forwarding**: screens destructure `...handlers` straight into `use*ScreenController({model, ...handlers})` instead of re-listing every prop (entity, search, library, transfer, corrections, now-playing transport via `...transport` rest — the eight transport keys are a contiguous tail matching `TransportProps`).
- **Shared primitives**: `ScreenHead` (back + title + meta — transfer, corrections), `SegmentItem` (WorldTabs and stage `ModeSegment` pills), `DiagPressRow` (`uw-diag-row--action` shell — settings `DiagAction`, nearby-peer row, copy-payload row), `CapsLabel` (uppercase section label ×5), `Field`/`SheetRow`/`PillAction` inside sheets, `DiagV`/`DiagBtn` inside settings, `TBtn`/`MiniBtn`/`TailBtn` sized `IconButton` wrappers.
- **progress.tsx**: `clearDrag`/`killDrag` unify the five gesture-teardown tails; `stopHoldTimer`/`releaseHold` unify the three timer-clear sites + unmount cleanup; the five `enabled ? fn : undefined` input handlers collapse into `scrubHandlers`; `wavePath` covers the five identical SVG bar paths; `progressOf` exported for home + mini-player (three copies of the same clamp).
- **queue-list**: `applyMoves` as a `reduce`, compacted ordered-items derivation, shared `canMoveTo`/`moveCtl` guards for the chevron pair, `.uw-dup-badge` moved from inline style to CSS.
- **stack.tsx**: `PushScreen`/`SheetScreen` share `OverlayScreenProps`.
- **states.tsx**: `LoadingState` folds into `StateShell` (icon optional → `Spinner`, `live` flag → `aria-live`, absent `tone` → no `data-state`) — DOM verified attribute-identical.

## Behavior-preserving calls (verified, not assumed)

- `option.detail != null` kept — `ProviderPickerOption.detail` is `string | null | undefined`; `!== null` would change semantics.
- `SegmentItem.onPress` accepts `undefined` — `stageModeTabs` emits `onPress: (() => void) | undefined`; `Pressable` treats it as inert, as before.
- `DiagBtn.ariaLabel` defaults to `label` but is overridable — the unpair button's aria-label is `unpairA11y(name)`, not the visible label (test asserts `aria-label="unpair pixel"`).
- `wavePath` passes `key` through instead of wrapping in `<g>` — no extra DOM.
- Disabled scrub controls keep zero pointer handlers — `scrubHandlers` spreads only when `enabled`.
- `shuffle`/`repeat` destructure defaults dropped at `NowPlayingScreen` only because `useTransportView` applies the identical `= false`/`= 'off'` defaults.
- The `useOverlayDismiss` ref/effect ordering in stack.tsx left untouched — registration order is observable.
- No `any`, no added `as` casts, no `@ts-ignore`; `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` intact (typecheck green).

## Cross-shard notes (NOT edited — outside shard)

- **Latent bug surfaced:** `LibraryCard` emits class `uw-libcard--list` for the list layout, but `styles.css` defined the row flex/hover rules under `.uw-libcard--row` — those styles never applied. The dead rules were deleted (rendered output unchanged); if the hover/flex treatment was intended, the fix belongs to a behavior change, not this refactor. Flag for the design owner.
- **`uw-toast`** is emitted by `apps/desktop/src/renderer/app.tsx` and styled by `ui-web/styles.css` — a style owned outside this package's markup. Consider moving it to the desktop's own stylesheet.
- **`SheetScreen` (stack.tsx) vs `SheetDialog` (sheets.tsx)** build near-identical scrim+dialog hosts but with different attributes (`data-stack` vs `data-sheet="panel"`, label source); a shared host would need attr-parameterization that costs more than it saves.
- **`useTransportView`/`radioRowView`/etc.** in `ui-shared` still hand-roll `undefined`-gated callbacks — the `bindTo`/`indexAdapter` pattern could move down a layer to benefit `ui-native` too.
- **`ui-native/src/stage-sheet.tsx`** has the same `useTransportView` consumption shape — the transport-button table pattern could be shared if a cross-platform transport row ever lands.

## Deliberately untouched

- `ui-web.test.ts`, `tsx-loader.mjs`, `test-node.d.ts` — test contract + harness.
- `theme.tsx` — already minimal; its one `as CSSProperties` is required by the custom-property key and predates this work.
- GLYPHS table in `primitives.tsx` — data, not code.
- `useScrubCommit`'s ref topology — pointer-identity tracking is timing/identity-sensitive; only the teardown tails were shared.
- `TrackRow`'s aria-label template and `QueueList`'s pending-op bookkeeping — correctness-critical strings/logic; restructuring buys nothing but risk.
- `index.ts` exports consumed only by the package's own test via `./index.ts` (keyboard helpers, queue pending-move fns) — still live exports.
- `RadioRowView`-driven markup, settings focus-recovery effect — accessibility semantics preserved verbatim.

## Final stat

```
27 files changed, 1213 insertions(+), 2763 deletions(-)
packages/ui-web/src: 9,904 lines total
  styles.css:        2,518
  tests + harness:     782  (ui-web.test.ts + tsx-loader.mjs + test-node.d.ts)
  implementation:    6,604
```

17 commits on `devin/w3-ui-web`, each gated green.
||||||| parent of 0e398eb (docs: WAVE3-REPORT — cumulative -490 LoC across ui-native shard)
=======
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
>>>>>>> 0e398eb (docs: WAVE3-REPORT — cumulative -490 LoC across ui-native shard)
