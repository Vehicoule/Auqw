# Kill the full-player tab-switch reload — REPORT

Branch `devin/ui-tabs`. HEAD already carried the first half of the fix
(`466659b fix(stage): keep-alive stage panes — visited tabs hide instead of
remounting`); this pass verified it, found it was defeated by a second
remount boundary plus one regression it introduced, and finished the job.

## Root cause

The stage renders three panes (`queue` / `player` / `lyrics`) under one
mode state (`useStageMode`; mode owned by `useAppShell` → `stageMode`).
Two separate mechanisms caused the per-switch "freeze":

1. **Conditional mounting (fixed at 466659b).**
   `packages/ui-native/src/stage-sheet.tsx` and
   `packages/ui-web/src/now-playing-screen.tsx` rendered
   `{activeMode === 'x' && …}` — every switch unmounted the outgoing pane
   and cold-mounted the incoming one. What re-ran per switch:

   - `QueueList` → `FlatList` remount (`queue-list.tsx:112`): row
     re-inflation (`initialNumToRender={15}`), scroll offset reset,
     virtualization state dropped.
   - Lyrics `ScrollView` + the whole owed-scroll measurement apparatus
     (`stage-sheet.tsx` `lyricsScrollRef`/`lyricLayouts`/`lyricsScrollH`)
     re-zeroed and re-measured every line's `onLayout`.
   - Web `QueueList` pending-move bookkeeping refs
     (`ui-web/queue-list.tsx:106-114`) reset.
   - Player pane: `ScrollView`, `WaveformSeek`, `TransportControls`,
     `GestureDetector`s all recreated.

   Player felt "smoother" only because its subtree is shallower than a
   list — it paid the same remount.

2. **The immersive boundary still remounted everything (fixed here).**
   `stage-sheet.tsx` ended with
   `{immersive ? <ThemeProvider theme="dark">…content…</ThemeProvider> : content}`
   (`immersive = activeMode === 'player' && player.artworkUrl !== null`).
   A `ThemeProvider`↔`View` type change at one position unmounts and
   remounts the entire `content` subtree — so with artwork present (the
   common case), every switch **to or from** player mode remounted all
   three kept-alive panes at once, defeating 466659b exactly where it
   mattered. queue↔lyrics switches (both non-immersive) were already
   fixed by HEAD; anything touching player was not.

3. **Regression introduced by 466659b (fixed here).**
   `chromePan` was one `Gesture.Pan()` instance shared by the lyrics
   pane's chrome `GestureDetector`s and the queue pane's — legal while
   only one pane mounted at a time. With keep-alive both panes are
   mounted concurrently and a gesture object binds a single detector:
   the later-mounted pane stole the recognizer, leaving the other's
   dismiss-drag chrome dead.

## Not the cause (verified)

- Lyrics fetch is not restarted per switch: `useAppShell` caches
  `lyricsFetch` per `recordingId`, gates the fetch on
  `stageOpen && (lyricsWhileOpen || mode==='lyrics')`
  (`packages/app-shell/src/app-shell.ts:1906-1963`), and mobile preloads
  via `lyricsWhileOpen`.
- The backdrop is already pinned mounted across tabs (wave-1):
  `stage-sheet.tsx` `risenOn` + `display` toggle; web
  `.uw-stage:not(.uw-stage--immersive) > .uw-stage__backdrop {display:none}`.
- Desktop chrome keeps the stage column mounted (`data-stage` hides it
  via CSS, `chrome.tsx:164-166`).

## The fix

- `theme.tsx`: new `DarkThemeScope({on, children})` — one provider
  identity that flips the provided value between the enclosing theme and
  `{...outer, scheme:'dark', colors: schemes.dark}`. The latter is
  field-for-field what `ThemeProvider theme="dark"` produced here
  (same scheme/colors; `textScale`/`reducedMotion` already resolved on
  the outer value), so the provided value is identical — only the
  boundary is now stable. `adaptive` palettes pass through untouched
  when off, which a re-resolve by scheme name could not guarantee.
- `stage-sheet.tsx`: the `{immersive ? <ThemeProvider>…` swap becomes
  `<DarkThemeScope on={immersive}>{content}</DarkThemeScope>`.
- `chromePan` split into `lyricsChromePan` / `queueChromePan` (same
  memoized `makeSheetPan` factory — the comment already documented that
  each detector needs its own instance).
- Pane wrappers get `accessibilityElementsHidden` +
  `importantForAccessibility` (the `mini-player.tsx:247` idiom) so a
  `display:none` pane stays unreachable to screen readers, matching the
  old unmounted semantics.
- Stale comment corrected: the lyrics scroller no longer "unmounts with"
  the pane-leaving reset.

## Why behavior is identical

- Layout: hidden panes were `display:none` and stay so; active pane
  wrapper is `flex:1` (native) / `display:contents` (web), so the pane
  contents occupy the same flex slot the fragment did. No child
  selectors on `.uw-stage__body` exist to break (only
  `.uw-stage:not(--immersive) > .uw-stage__backdrop`, whose target is
  still a direct child).
- `DarkThemeScope on`/`off` provides exactly the values the old
  conditional provider/no-provider did; context consumers re-render on
  the flip instead of remounting — same output, preserved state.
- Scroll/selection/gesture behavior unchanged: panes never leave the
  tree, so offsets, FlatList window state, and gesture attachment
  survive; the lyrics owed-scroll still settles on re-entry because the
  scroller's `onLayout` refires when `display` restores.
- Lazily mounted: `visited` still mounts a pane on first visit, so the
  sheet's first paint doesn't pay for three lists.

## Evidence

- Remount path (pre-fix, HEAD): `stage-sheet.tsx` `{immersive ? <ThemeProvider …` —
  element-type change at a fixed position forces React unmount+mount of
  the `content` subtree (all visited panes) on every player↔queue/lyrics
  switch whenever `artworkUrl !== null`.
- Gesture-sharing: HEAD bound `chromePan` to detectors at stage-sheet
  1215/1271 (lyrics) and 1290/1298 (queue) — two concurrently mounted
  detectors after keep-alive.
- Measured (`packages/ui-web/probe-tabs.mjs` — jsdom `createRoot`,
  160-row queue + 80-line synced lyrics, React Profiler + MutationObserver
  counting real DOM adds/removes per mode prop switch):

  | switch | before (466659b~1) | after |
  | --- | --- | --- |
  | player → lyrics (1st visit) | +2 −3 nodes, 10.5 ms render | +1 −0, 12.2 ms |
  | lyrics → queue (1st visit) | +1 −2, 159.2 ms | +1 −0, 190.7 ms |
  | queue → player | +3 −1 | +0 −0, 16.7 ms |
  | player → lyrics (2nd) | +2 −3 | +0 −0, 10.8 ms |
  | lyrics → queue (2nd) | +1 −2, 118.0 ms | +0 −0, 13.2 ms |

  Before: every switch tore down one pane and cold-mounted the next —
  the 160-row queue mount cost ~120–160 ms *every* visit. After: first
  visits still pay one mount (lazy `visited`), revisits mutate zero DOM
  nodes and render in ~11–16 ms. (`dom ±` counts top-level mutation
  records, so `+1` = one subtree insertion.)
- Gates (all green, this branch):
  `pnpm install --frozen-lockfile`;
  `pnpm -C packages/ui-native typecheck` (+`test`: ui-native tests passed);
  `pnpm -C packages/ui-web typecheck && test` (166 assertions);
  `pnpm -C packages/ui-shared typecheck && test`;
  `pnpm -C packages/app-shell typecheck && test`;
  `pnpm -C apps/mobile typecheck && test` (mobile shell tests passed);
  `pnpm -C apps/desktop typecheck && test` (desktop shell tests passed).
- No device run this pass — markup-level keep-alive can't be asserted by
  the `renderToStaticMarkup` harness (effects never run), so on-device
  scroll/gesture verification stays provisional for the lead. The jsdom
  probe is the closest harness-level evidence and shows zero DOM churn
  on revisit.

## Diffstat (this pass, on top of 466659b)

```
 apps/desktop/src/renderer/app.tsx      |  5 ++-
 apps/mobile/App.tsx                    |  3 +-
 packages/app-shell/src/app-shell.ts    |  6 +++
 packages/ui-native/src/stage-sheet.tsx | 77 ++++++++++++++++------------------
 packages/ui-native/src/theme.tsx       | 23 ++++++++++
 packages/ui-web/probe-tabs.mjs         | new (evidence harness)
```

The app diffs finish the "unstable callback props" leg the same pass
started: `onRemoveQueueItem` was a fresh inline closure per app render
(`(id) => void session.removeOccurrence(id)`), now a memoized
`removeQueueOccurrence` beside the already-memoized `onMoveQueueItem*`
in `useAppShell`.

466659b (already on branch): `stage-sheet.tsx` +40/-4-ish,
`now-playing-screen.tsx` +19/-10-ish keep-alive wrappers.
