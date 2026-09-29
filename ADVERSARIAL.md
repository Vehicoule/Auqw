# Adversarial review: packages/app-shell extraction (PR #179)

You are reviewing the wave-2 app-shell extraction in `/home/ubuntu/wt/appshell`
on branch `devin/w2-appshell`. The PR refactored the duplicated shell
composition out of `apps/desktop/src/renderer/app.tsx` (2982→1465 LoC) and
`apps/mobile/App.tsx` (3291→2587 LoC) into `packages/app-shell` (a 3338-LoC
`useAppShell` hook + 538-LoC ports/types). It claims behavior-identical.

Your job: prove that claim false — find real behavior changes, not style.

## Highest-risk bug classes for this refactor

1. **Hook deps drift.** `useMemo`/`useCallback`/`useEffect` dependency arrays
   in the hook must match what each app's inline version depended on. A
   missing dep → stale closures; an added dep → re-render/recompute storms
   (e.g. the artwork-refetch class of bugs this repo already fixed once).
   Diff discipline: for each hoisted block, compare the ORIGINAL code on
   `origin/main` (git show origin/main:apps/desktop/src/renderer/app.tsx,
   and apps/mobile/App.tsx) against the hook's version — especially the
   trailing deps arrays.
2. **Effect ordering.** React runs effects top-down; moving blocks into a
   shared hook changes relative order vs platform seams that stayed in the
   app files. Look for effects whose ordering mattered (e.g. an app-side
   effect that must run BEFORE a hoisted one — playback position restore,
   stage morph writes, overlay open-on-mount).
3. **Callback identity / referential stability.** If the hook returns
   callbacks that were previously memoized differently, children that
   depended on stable refs re-render. Check `useMemo`ed models consumers.
4. **Port semantic swaps.** `localPlayable` (attachability) vs `isOwned`
   (ownership) MUST stay distinct — verify every `playlistDownloadFor`
   skip question uses `isOwned` and every honesty mark uses `localPlayable`
   (the #174/#177 invariant). Also `preferOwnedRef`,
   `entityPlayRequiresCanPlay`, `homeSuggestionLimit`,
   `trackAttemptActions`, `holdEndedPlayer`, `lyricsWhileOpen`,
   `resetModeOnTrack`, `strictHomeCardKeys`, `markPlayingRef`,
   `localCatalog`, `omitSettingsRows`, `sweepArtworkCache`,
   `openSync` vs `openSyncOverlay` — check both apps wire each per its
   ORIGINAL behavior, and the hook's default for an unwired port matches
   the OTHER app's original behavior.
5. **Mobile Overlay union.** `E extends ShellOverlay` — check every
   switch in the mobile file still handles its extra overlays
   (transfer, sync, etc.); a widened union that silently narrows is a
   regression.
6. **Stale live-instance reads.** `afterLocalMutation` custody (mobile
   rehydrate swaps `local()` instances) — rehydrate-then-project when the
   instance changed; a stale commit clobbers rows.
7. **Mobile-only port defaults.** If `ports.haptic`,
   `ports.onSearchCommit`, `ports.markPlayingRef`, `ports.localCatalog`
   are unset on desktop, the hook must no-op them — not crash, and not
   enable a mobile-only path on desktop.
8. **`stageOpen`/`stageInitiallyOpen` asymmetries**, queue-end
   `holdEndedPlayer` writes into shared values the morph reads — check
   write ordering.

## Also verify

- `#177`'s peaks local legs survived the merge: desktop `peaksPort`
  must wire `localUriFor: controller.localUriFor` and
  `localRead: window.auqw.local.read`.
- `useWaveformPeaks(ports.peaksPort ?? null, ...)` handles the iOS
  no-port case exactly like the original (it rendered seeded peaks).
- Session/observable subscriptions don't double-subscribe or leak: any
  `useEffect` that subscribes must unsubscribe identically to the
  original.
- No `useAppShell` return value that a screen consumed by name got
  renamed without all call sites updated (typecheck covers this — but a
  DIFFERENT field with the same name/signature that returns wrong data
  would still typecheck).

## How to verify the originals

`git show origin/main:apps/desktop/src/renderer/app.tsx > /tmp/old-desktop-app.tsx`
`git show origin/main:apps/mobile/App.tsx > /tmp/old-mobile-app.tsx`

For each hoisted block, locate it in the old files and in the hook;
compare logic AND deps.

## Rules

- CONFIRMED bug → fix it, add/adjust a regression test, commit on
  `devin/w2-appshell` (`fix(app-shell): ...` — one commit per bug, clear
  message). Do NOT push — I push after reviewing.
- Speculative / can't-prove → report only.
- If you find a divergence where picking a side would CHANGE shipped
  behavior on either platform, STOP and report — do not pick a side.
- Run gates after any fix:
  `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`
  `pnpm -C packages/app-shell typecheck && pnpm -C packages/app-shell test`
  `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test`
  `pnpm -C apps/mobile typecheck && pnpm -C apps/mobile test`
- Write findings to `~/wt/appshell/ADVERSARIAL-REPORT.md`: verdict per
  bug class (clean/fixed/reported), what you checked, LoC-safe diffstat.
