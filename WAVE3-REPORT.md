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
