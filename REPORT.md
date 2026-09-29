# Kill the full-player tab-switch reload — REPORT

Branch `devin/ui-tabs`. HEAD already carried the first half of the fix
(`466659b fix(stage): keep-alive stage panes — visited tabs hide instead of
remounting`); this pass verified it, found it was defeated by a second
remount boundary plus one regression it introduced, then eliminated the
remaining per-switch render cost the keep-alive alone could not touch.

## Root cause

The stage renders three panes (`queue` / `player` / `lyrics`) under one
mode state (`useStageMode`; mode owned by `useAppShell` → `stageMode`).
Four separate mechanisms caused the per-switch "freeze":

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

2. **The immersive boundary still remounted everything (fixed at 25b1e06).**
   `stage-sheet.tsx` ended with
   `{immersive ? <ThemeProvider theme="dark">…content…</ThemeProvider> : content}`
   (`immersive = activeMode === 'player' && player.artworkUrl !== null`).
   A `ThemeProvider`↔`View` type change at one position unmounts and
   remounts the entire `content` subtree — so with artwork present (the
   common case), every switch **to or from** player mode remounted all
   three kept-alive panes at once, defeating 466659b exactly where it
   mattered.

3. **Regression introduced by 466659b (fixed at 25b1e06).**
   `chromePan` was one `Gesture.Pan()` instance shared by the lyrics
   pane's chrome `GestureDetector`s and the queue pane's — legal while
   only one pane mounted at a time. With keep-alive both panes are
   mounted concurrently and a gesture object binds a single detector:
   the later-mounted pane stole the recognizer, leaving the other's
   dismiss-drag chrome dead.

4. **Kept-alive panes still reconciled on every render (fixed in this
   commit).** The `visited` set mounted each pane lazily — so the first
   visit still paid the cold-mount on a user gesture (the freeze
   survived for the queue's first entry) — and nothing isolated hidden
   panes from the parent's render. Every `stageMode` change, and every
   position tick the shell emits (`session.subscribePosition` feeds the
   `player` model at tick rate), reconciled all mounted subtrees:
   ~160 `TrackRow`s on web, the 15-row FlatList window + 80 lyric
   `Text`s on native. The inputs were stable — `queue`/`lyrics` models
   are `useMemo`d in `useAppShell` — but two deps forced them to churn
   at tick rate anyway: `queueModel` listed the whole `state.playback`
   object (which carries `positionMs`, `session.ts:142`) though the
   body only reads `type`/`occurrenceId` for `failedQueueIds`
   bookkeeping (`app-shell.ts:928-938`), and `lyricsModel` listed
   `lyricsPositionMs`, which `useSmoothedPosition` still re-anchors on
   every engine tick while the pane is hidden (`ui-shared/shell.ts:375-378`).
   `onRemoveQueueItem` also arrived as a fresh inline closure per app
   render, which would have busted any memo regardless.

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
- **`visited` dropped — all three panes mount eagerly** (`stage-sheet.tsx`,
  `now-playing-screen.tsx`). The lazy set was the last thing remounting
  under a user gesture: first entry into queue still paid the cold
  160-row mount. The mount cost moves to the sheet mount — on mobile
  that is the collapsed sheet created at playback start, not a UI
  interaction; on desktop it is the stage column's first open.
- **Element-level memoization of the two heavy subtrees** — `useMemo`
  returns a `QueueList` element and a lyric-lines element array
  (`queueListEl`/`lyricLineEls` on both platforms) plus the
  `lyricsPane` view model. React bails out of reconciliation on an
  identical element, so a mode switch, a position tick, or an unrelated
  shell render leaves the kept-alive rows/lines untouched instead of
  diffing every row.
- **`useAppShell` dep narrowing so the memos hold at tick rate**:
  `queueModel` deps drop `state.playback` for the two fields the body
  actually reads (`playbackType`, `playbackOccurrenceId`) — position
  publishes no longer rebuild the row model; `lyricsModel`'s position
  dep is gated by pane visibility (`lyricsPositionDep`) — the model
  still reads the live `lyricsPositionMs` whenever the pane is visible,
  but a hidden pane no longer rebuilds per engine tick.
- **Stable `onRemoveQueueItem`**: `removeQueueOccurrence` is a
  `useCallback` in `useAppShell` beside `onMoveQueueItem*`, replacing
  the per-render `(id) => void session.removeOccurrence(id)` closure
  at all three call sites (mobile stage, desktop stage, desktop
  QueueScreen).

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
  Context changes propagate through the memoized elements, so the
  scoped dark scheme still reaches every `useTheme` consumer inside
  `queueListEl`/`lyricLineEls` the moment `immersive` flips.
- Scroll/selection/gesture behavior unchanged: panes never leave the
  tree, so offsets, FlatList window state, and gesture attachment
  survive; the lyrics owed-scroll still settles on re-entry because the
  scroller's `onLayout` refires when `display` restores.
- The memoized elements are pure projections of their props: an element
  that bails out is provably identical to the one it replaces (same
  inputs, same JSX), so a skipped reconcile can't diverge. Every input
  the JSX reads is a dep — callbacks included, which is exactly why
  `removeQueueOccurrence` had to be stabilized first.
- The `queueModel` narrowing lists every field the memo body reads —
  `failedQueueIds` bookkeeping is edge-triggered on
  (type, occurrenceId), which is what the new deps track; a skipped
  rebuild would have produced a bit-identical model.
- The `lyricsModel` gate only freezes the position input while the pane
  is invisible — no consumer can observe it. On re-entry the dep flips
  back to the live value and the model rebuilds in the same frame, so
  the first visible line state is correct; the 200 ms smoothed clock
  then resumes exactly as before.
- `t()` strings and a11y labels stay outside the memos (header texts,
  `EmptyState`, reorder label are inline JSX), so locale flips still
  repaint immediately.

## Evidence

- Remount path (pre-fix, 466659b): `stage-sheet.tsx` `{immersive ? <ThemeProvider …` —
  element-type change at a fixed position forces React unmount+mount of
  the `content` subtree (all visited panes) on every player↔queue/lyrics
  switch whenever `artworkUrl !== null`.
- Gesture-sharing: 466659b bound `chromePan` to detectors at stage-sheet
  1215/1271 (lyrics) and 1290/1298 (queue) — two concurrently mounted
  detectors after keep-alive.
- Measured (`packages/ui-web/probe-tabs.mjs` — jsdom `createRoot` +
  `Profiler`, 160-row queue + 80-line synced lyrics, MutationObserver
  counting real DOM adds/removes per mode prop switch; wall = commit
  window, render = Profiler actualDuration):

  | step | keep-alive only | eager + memoized |
  | --- | --- | --- |
  | mount (player) | 39.3 ms / 30.2 render | 201.4 ms / 178.0 render |
  | player → lyrics (1st) | 21.0 ms / 10.8, 2 commits | 11.8 ms / 3.0 |
  | lyrics → queue (1st) | 221.4 ms / 192.8, 2 commits | 3.5 ms / 1.8 |
  | queue → player | 38.5 ms / 17.2 | 7.0 ms / 4.9 |
  | player → lyrics (2nd) | 26.6 ms / 13.1 | 3.3 ms / 1.8 |
  | lyrics → queue (2nd) | 25.4 ms / 10.4 | 3.1 ms / 1.9 |
  | queue → queue (no-op) | 27.4 ms / 12.6 | 2.5 ms / 1.6 |
  | position tick in queue | 34.6 ms / 11.9 | 6.6 ms / 4.0 |

  Before: the first queue visit paid ~193 ms of React work *on the
  switch itself* (lazy mount + the `visited` bookkeeping render), and
  every later switch still reconciled the whole mounted tree — the DOM
  never changed (`+0 −0` after the first visits), so the 10–17 ms was
  pure re-render. After: every switch is one commit under ~5 ms with
  zero DOM mutation; the pane-mount cost moved to the one sheet mount
  (~178 ms jsdom for all three panes — hidden panes, `display:none`).
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
  on every switch.

## Diffstat (vs merge-base, all three commits)

```
 REPORT.md                              | report
 apps/desktop/src/renderer/app.tsx      | onRemoveQueueItem → removeQueueOccurrence ×2
 apps/mobile/App.tsx                   | onRemoveQueueItem → removeQueueOccurrence
 packages/app-shell/src/app-shell.ts   | removeQueueOccurrence; queueModel/lyricsModel dep narrowing
 packages/ui-native/src/stage-sheet.tsx | DarkThemeScope boundary, per-pane chrome pans,
                                        a11y pair, eager panes, queueListEl/lyricLineEls/lyricsPane memos
 packages/ui-native/src/theme.tsx       | DarkThemeScope
 packages/ui-web/src/now-playing-screen.tsx | eager panes, queueListEl/lyricLineEls/lyricsPane memos
 packages/ui-web/probe-tabs.mjs         | jsdom Profiler harness (evidence)
```

Series on `devin/ui-tabs` over `466659b` (the wave-1 keep-alive, already
on branch): `25b1e06` stable immersive boundary + per-pane chrome pans;
this commit — eager panes + render isolation.
