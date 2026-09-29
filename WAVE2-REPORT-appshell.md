# Wave 2 — `createAppShell` extraction report

Shared shell composition hoisted into `packages/app-shell`
(`useAppShell({ controller, state, ports })`). Both `Main` bodies now
wire platform seams through `AppShellPorts<E>` and destructure the
returned model/op surface; neither composes behavioral state inline.

## Size

| File | Before | After | Δ |
| --- | ---: | ---: | ---: |
| `apps/desktop/src/renderer/app.tsx` | 3827 | 1458 | −2369 (−62%) |
| `apps/mobile/App.tsx` | 4998 | 2587 | −2411 (−48%) |
| `packages/app-shell/src/app-shell.ts` | — | 3338 | new |
| `packages/app-shell/src/types.ts` | — | 538 | new (ports + pure helpers) |
| `packages/app-shell/src/app-shell.test.ts` | — | 362 | new |
| `packages/app-shell/src/index.ts` | — | 17 | new |

## Blocks hoisted

All in `app-shell.ts`, transcribed from the duplicated regions:

- position channel (`subscribePosition` external store)
- shell chrome state: tab, stage open/mode, reordering, query,
  search recents, sheet-open flags, epoch refs
- locale: `applyLocale`, `localeTick`, `localeApplied` gate
- diagnostics reads (`attempts`, `resultMeta`, `entityMeta` refs)
- overlay stack + entity-fetch registry
- connectivity (`subscribeOnline` port → `online`)
- toast bus (`setToastSink` + auto-clear)
- downloads ledger subscribe/throttle + storage-usage probes
- playability gates: `isOwned` vs `localPlayable` split, `canPlay`,
  `canPlayMeta`, offline honesty
- download chip map, `downloadChipFor`, `downloadRefFor`,
  `onDownloadAction` (request/cancel/retry/remove)
- search: provider router, `SearchSession`, `searchState`,
  suggestions debounce, recents, `runSearch`/`submitSearch`/
  `cancelSearch`/`retrySearch`/`applySearchText`, `resultMetaFor`
- models: player, stagePlayer, queue, library, home, search,
  settings, corrections, radio, lyrics, transfer, playlist/entity
  per-route models, picker items
- play funnel: `dispatchPlay`/`reportPlay` (attempt actions vs plain
  funnel), `playRecording`/`playMeta`, `onResultPress`,
  `onHomeCardPress`
- queue ops: `playQueueOccurrence`, `onMoveQueueItem`,
  `onMoveQueueItemTo`, `toggleReordering`
- transport: `onPlayPause`, `onToggleLike`, `advance`,
  `seekToPosition`, held-occurrence resume/seek poses
- settings handlers: `onSettingsSelect`/`onSettingsToggle`, theme/
  language/storefront/quality/artwork-cache sheet state machines
  (epoch-tagged saves), provider pickers, `queueSettingsWrite`
- lyrics fetch + retry; radio seed gating (`onStartRadioGated`,
  `onStopRadio`); corrections live-read + `reviewOp`
- transfer: `onExport` → `exportJson` port; `beginImportRead`/
  `onImportText`/`cancelImportRead`/`failImportRead`/`onApplyImport`/
  `onResetImport`/`resetTransfer`
- entity fetch/pagination (`loadEntityPage`, `openEntity`,
  `onLoadMore`)
- collection/playlist play (`playCollectionRows`, `playPlaylist`,
  `playPlaylistEntry`, `entityPlayAll`, `onEntityRowPress`,
  `entityRowMeta`)
- row-actions sheet model (`rowActions`, `onRowAction`), playlist
  picker (`onPickPlaylist`, `onCreateAndPick`), provider picker
  (`onPickProvider`)
- playlist ops (`renamePlaylist`, `deletePlaylist`,
  `removePlaylistEntry`, `movePlaylistEntry`), card ops (`onOpenCard`,
  `onCreatePlaylist`)
- chrome helpers (`selectTab`, `focusSearch`, `openStage`,
  `setStageOpenFor`), stage download chip (`stageDownload`,
  `onStageDownload`, `onStageAddToPlaylist`)

## Divergences found → how each was parameterized

| Divergence | Parameterization |
| --- | --- |
| Online signal: desktop `controller.subscribeOnline` edge stream vs mobile connectivity port (subscribe-first + snapshot seed, stale-snapshot guard, subscribe-throw fallback) | `ports.subscribeOnline` — required seam |
| "Locally playable": desktop capability probe (`localPlaybackFor(id) !== null` — always false today) vs mobile owned-bytes (downloads/local files attach directly) | `ports.localPlayable` unset on mobile → falls back to `isOwned` |
| iOS has no local-attach path — download create affordances hidden there, removal rows kept | `ports.downloadsEnabled` (`Platform.OS !== 'ios'`) |
| Playlist-entry ref choice: mobile drops `selectedRef` to null when owned bytes exist; desktop passes the pinned ref | `ports.preferOwnedRef` |
| Home-card press: desktop plays any unmatched key as a recording id and bounds the suggestion lookup to the first 12 results; mobile requires recents membership and searched the whole page | `ports.strictHomeCardKeys` (mobile) + `ports.homeSuggestionLimit` (desktop: 12) |
| Entity play-all/shuffle-all: desktop filters by `canPlayMeta` and no-ops on empty; mobile plays every fetched row | `ports.entityPlayRequiresCanPlay` (desktop) |
| Result play funnel: desktop wraps attempts in typed attempt actions; mobile reports results plainly | `ports.trackAttemptActions` (desktop) |
| Queue-end player hold: mobile holds the last player while the morph sheet settles; desktop clears on idle | `ports.holdEndedPlayer` + `ports.resetStageMorph` (mobile writes its shared values) |
| Lyrics timing: mobile prefetches while the stage is open in any mode; desktop loads only in lyrics mode | `ports.lyricsWhileOpen` (mobile) |
| New track under an open sheet returns it to player mode (mobile only) | `ports.resetModeOnTrack` |
| Settings `sync` row: desktop scrolls/focuses the inline panel; mobile pushes a `{type:'sync'}` overlay — and mobile's overlay union extends `ShellOverlay` | `ports.openSync` vs `ports.openSyncOverlay` + the `E` generic (`ShellOverlay \| E`) |
| Local-source mutation custody: mobile swaps live instances under rehydrate (rehydrate-then-project when the instance changed); desktop re-reads the live source directly | `ports.afterLocalMutation(mutated, refreshLocal)` |
| Search commit dismisses the IME (mobile only) | `ports.onSearchCommit` |
| Haptics on play/delete/settings paths (mobile only) | `ports.haptic` |
| Peaks decode: desktop `createWebPeaksPort(stream)`; Android `createExpoPeaksPort`; iOS none | `ports.peaksPort` |
| Library export: desktop Blob-anchor download; mobile SAF folder pick / documents-root write with picker-cancel vs write-failure split | `ports.exportJson` returning `ExportWrite` (`done`/`cancelled`/`error`) — cancel maps to the original `'idle'` phase reset |
| Settings rows: desktop omits the artwork-cache row; mobile keeps it and sweeps the cache on shrink | `ports.omitSettingsRows` + `ports.sweepArtworkCache` + `settingsExtras` (`localSupported`, `syncSupported`, `syncLabel`) |
| Entity/search playing-row mark: mobile passes `playingRef` to the models | `ports.markPlayingRef` |
| Local index rows merge into catalog search (mobile only) | `ports.localCatalog` |
| Deeplink transfer reset wipes the whole transfer state (`IDLE_TRANSFER`) — distinct from `onResetImport`'s import-only unwind | `resetTransfer` export (mobile `auqw://transfer` leg) |
| Home `onResume`: desktop's original aliased the play/pause toggle; mobile's was a plain `session.resume()` | Kept app-side — mobile's JSX keeps its own one-line `onResume`; the hook's `onPlayPause` stays the toggle |

## Left duplicated (with reason)

- **Screen JSX / prop plumbing.** The render bodies (SearchScreen,
  HomeScreen, StageSheet, overlay switch, sheets JSX) stay app-side —
  they bind different components (ui-web vs ui-native) with different
  prop shapes (insets, desktop stage column vs native morph sheet).
- **Thin session one-liners in props** — `session.toggleLike`,
  `session.stop`, `session.removeOccurrence`, `toggleShuffle`,
  `cycleRepeat`, `toggleEntityLike` appear verbatim in both files.
  They're direct session forwards with no shell logic; hoisting them
  adds surface without removing a decision point. Left as call-site
  adapters.
- **Sync engine surfaces.** Desktop's IPC sync panel vs mobile's
  pairing/share/nearby/delta ops are different implementations behind
  different controllers — untouched beyond the shared overlay route.
- **`home-card.ts` (mobile)** — `activateHomeCard` is now only used by
  its unit test (wired into `shell.test.ts`); retained as the
  contract the hook's `onHomeCardPress` reproduces. Its caller is the
  hook, so the file could later move under app-shell; left in place to
  keep the diff surgical.

## Diffstat

```text
 apps/desktop/package.json                |    3 +-
 apps/desktop/src/renderer/app.tsx        | 2975 +++-----------------------
 apps/mobile/App.tsx                      | 3291 ++++-------------------------
 apps/mobile/package.json                 |    1 +
 packages/app-shell/package.json          |   26 +
 packages/app-shell/src/app-shell.test.ts |  362 ++++
 packages/app-shell/src/app-shell.ts      | 3338 ++++++++++++++++++++++++++++++
 packages/app-shell/src/index.ts          |   17 +
 packages/app-shell/src/types.ts          |  538 +++++
 packages/app-shell/tsconfig.json         |   14 +
 pnpm-lock.yaml                           |   28 +
 11 files changed, 5069 insertions(+), 5524 deletions(-)
```

## Gates (evidence)

```text
pnpm install --frozen-lockfile            OK
pnpm -C packages/app-shell typecheck      OK (tsc --noEmit)
pnpm -C packages/app-shell test           OK — "app-shell tests passed"
pnpm -C packages/ui-shared typecheck      OK
pnpm -C packages/ui-shared test           OK — "ui-shared tests passed"
pnpm -C packages/application typecheck    OK
pnpm -C packages/application test         OK
pnpm -C apps/desktop typecheck            OK
pnpm -C apps/desktop test                 OK — "desktop shell tests passed"
pnpm -C apps/mobile typecheck             OK
pnpm -C apps/mobile test                  OK — "mobile shell tests passed"
pnpm -C packages/ui-web typecheck         OK
pnpm -C packages/ui-web test              OK — "ui-web tests passed (168 assertions)"
pnpm -C packages/ui-native typecheck      OK
pnpm -C packages/ui-native test           OK — "ui-native tests passed"
```
