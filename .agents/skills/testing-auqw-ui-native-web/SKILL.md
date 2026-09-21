---
name: testing-auqw-ui-native-web
description: How to render and test the Auqw ui-native component gallery in a desktop browser when no Android/iOS emulator is available
---

# Testing auqw ui-native on web

The `apps/mobile` package (Expo/RN) cannot run on an emulator in this environment, but `packages/ui-native` ships a `GalleryScreen` that renders every screen/component against fixtures. A web harness can be bootstrapped to exercise it in Chrome.

## Harness setup (uncommitted — do not commit these files)

In `apps/mobile/`:

1. `index.web.ts`:
   ```ts
   import { registerRootComponent } from 'expo';
   import { WebGalleryApp } from './web-gallery';
   registerRootComponent(WebGalleryApp);
   ```
2. `web-gallery.tsx`: wraps `GalleryScreen` in `GestureHandlerRootView` + `SafeAreaProvider` and gates on `useFonts(JetBrainsMono_*)` from `@expo-google-fonts/jetbrains-mono`.
3. `package.json`: set `"main": "index.web.ts"` and add deps `@expo/metro-runtime@57.0.8`, `react-dom@19.2.3`, `react-native-web@0.21.2`.

Then from the repo root (node 24 + pnpm 12.3.4). Standard env: `source ~/.nvm/nvm.sh && nvm use 24`. If nvm/node/pnpm aren't installed on your machine, provision them any way that works (e.g. a node 24 tarball + `npm i -g pnpm@12.3.4`) and make sure `node`/`pnpm` resolve on PATH:

```sh
pnpm install
cd apps/mobile && pnpm exec expo export --platform web   # outputs dist/
cd dist && python3 -m http.server 8087                    # or any static server
```

Open `http://localhost:8087/` in Chrome. Export bundles in ~2s; re-export after any harness edit (no hot reload).

## What the gallery can and cannot prove

- Gallery is one long scroll of `Section`s with chip-driven state switching (theme, search phase, stage-sheet drag state). Phase/state changes only happen via the chips — fixtures are static, callbacks are `noop`.
- Gallery `Frame`s are full-width, not phone-width: at ~950px desktop width the `StageSheet` artwork (`aspectRatio: 1`, `fill`) is taller than the 620px frame and clips the transport controls — resize the Chrome window to ~530px wide (`wmctrl -r Auqw -e 0,10,40,530,720`) so sheet content renders fully before judging it.
- `browser_console` CDP may attach to a different Chrome window when several are open (evals returning `querySelectorAll('div').length === 0` = wrong target). Visual assertions from screenshots are sufficient; close extra windows if you need console evals.
- CorrectionsScreen's `onRetry` prop isn't wired in the gallery fixtures (App.tsx passes `loadReviews` in the real app), so the corrections "error" frame shows no retry button — expected coverage gap, not a bug.
- Platform-split code (`*.native.tsx` vs `*.tsx`, where present) resolves to the shared/web variant on web: queue reorder shows chevron up/down buttons instead of drag handles, `PlatformTabs` shows the app navbar fallback.
- `GestureHandlerRootView` Pan gestures (mini-player swipe-down dismiss, stage-sheet drag) do NOT track mouse drags on web — verify via the `rest`/`mid-drag`/`dismissed` chips instead and call this out when reporting.
- App-level wiring (App.tsx) — tab bar, native stack sheets/overlays, the theme picker opened from settings — is not reachable via the gallery; only the shared components are. The sheets section already renders a `ProviderPickerSheet` fixture — for app-side variants (e.g. the 4-option theme picker), pin one temporarily in `web-gallery.tsx`; don't add a permanent fixture.
- Token/colour assertions: use `getComputedStyle` in the browser console (e.g. secondary text = `rgb(143, 153, 194)` for `#8f99c2`).

## Devin secrets needed

None — fixtures only.
