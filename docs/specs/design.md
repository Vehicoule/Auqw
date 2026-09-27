# Design

Owns: visual direction, tokens, components, and rendering rules.

## Direction

The omarchy design language over the predecessor's **Stage & World** shell — structured, quiet, mono-typed, artwork-led. Rendered and iterated to approval in [`../design-preview/index.html`](../design-preview/index.html) (self-contained, canonical artifact — judge that file, not prose).

Two surfaces, two jobs:

- **Stage** listens — artwork, metadata, seek, transport, and `player | lyrics | queue` sub-modes.
- **World** browses — home, explore, library, search results, settings.

Omarchy rules, non-negotiable: depth comes from the background ramp only (no shadows); boundaries are hairlines; states are alpha fills; accent is reserved for active/selected/progress; radii are deliberate and small (frames square, controls rounded); type is one sans family (Inter); icons are custom-rendered and move (see Rendering).

## Shell contract — desktop (Electron)

One window, no titlebar band. The Stage column runs to the top edge at the golden-ratio split — `38.2%` clamped to 280–480 px — with **no header strip of its own** (the GTK sidebar player was chromeless; collapse lives on the world toggle). Under ~860 px window width it stops shrinking and floats over a scrim instead (GTK breakpoint behavior, tap-outside dismisses). Pushed pages scope to the world column so the stage's playback controls stay reachable. A single 40 px toolbar carries all window chrome:

- **Stage column edge:** pure player, top to bottom. macOS traffic lights still pin over its top-left (the body insets to keep them clear), and a floating stop control (halts playback, keeps the queue) overlays the top-right while a track is loaded.
- **World toolbar:** stage toggle + search icon at the seam · centered `home | explore | library` pills · primary menu (settings) at the end · caption buttons (Windows/Linux overlay the strip's right edge — the renderer measures `windowControlsOverlay` into `--uw-caption-w` so controls keep clear). Electron: `titleBarStyle: 'hiddenInset'` + `trafficLightPosition` on macOS (no drawn strip); `titleBarStyle: 'hidden'` + `titleBarOverlay` themed per scheme on Windows and Linux.
- **Search:** the toolbar icon routes to the explore tab and focuses its field (same target as `/`). The GTK expanding-field variant stays deferred — the toolbar is too thin to host an inline field honestly.
- **Stage column:** the full player lives here — same modes and blocks as the sheet below. When nothing is loaded the column shows an empty state instead of dead controls. No mini-player on desktop.
- **Stage player mode:** artwork → meta (title/artist/album + download/add) → waveform-style seek → centered transport `like · prev · play · next · repeat` → volume → mode segment (pinned at the bottom edge). Play is a solid fg-bright block; liked is pink.
- **Stage lyrics mode:** title + honest sync state (`estimated timing` when unsynced) + scrollable lines; active line in accent; pin control; thin scrollbar. No transport controls inside lyrics.
- **Row anatomy (shared, both platforms):** thumb (animated eq overlay when playing) · title + version · duration · state (like/download/warn) · add-to-playlist.
- **Library:** collections 2×2 (`liked · downloads · top 50 · history`, play affordance each) → ownable grid (filter chips, sort, grid/list, dashed new-playlist card) → followed-artists rail → recently added (shared rows). The 2×2 is Library-only; Home uses card rails.

## Shell contract — mobile (React Native / Expo)

Native chrome, per platform — not a shrunken desktop:

- **Navbar:** Android = M3 Expressive bar (tall, wide pill indicator, bold active label, gesture handle); iOS = floating translucent capsule (liquid glass — blur is scoped to OS chrome, never an app surface). Settings is the 4th tab: `home · explore · library · settings`.
- **Mini-player:** floating card above the navbar — artwork left, title/artist, `like + resume` right. Progress is a **squared ring hugging the artwork** (rounded-rect path, progress sweeps from top-center): the same thin clean arc on every platform. Swipe sideways skips; swipe-down dismisses (stops playback); tap opens the Stage sheet.
- **Mini-player → sheet morph (CMP deck):** one continuous `progress` drives the whole transition — dragging the pill upward raises the sheet 1:1 with the finger and release commits at 30% of the travel or on a fling (±600px/s, direction-decisive), settling with a velocity-carrying spring. While it rises, the pill fades out inside the first stretch (gone by 0.25), the sheet's surface sweeps up with corners morphing card→sheet→square at the anchor, a half-strength scrim covers the exposed region, and the sheet's content (artwork + controls) reveals through the 0.25→0.5 window. The same contract runs in reverse on the sheet's own down-drag.
- **Stage sheet:** full-screen, grab handle, swipe-down dismisses. Same modes as desktop. Media controls go platform-native — Android: filled-accent squircle play + tonal prev/next; iOS: translucent glass circles. **No volume control** — hardware buttons own it. Player mode is immersive (CMP reference): the artwork fills the surface under a fixed dark scrim, a statically blurred copy of the artwork is revealed by an alpha ramp so the frost fades in progressively under the bottom cluster only (no live blur view, no hard edge), and the layout pins its cluster — the radio affordance sits centered under the grab handle as an accent pill; the title line carries download + add-to-playlist at its right edge; then timeline → transport `like · prev · play · next · repeat` → mode segment, all pinned at the bottom edge. Content always renders in the dark scheme over art. Missing artwork falls back to the flat stage surface; lyrics/queue modes keep the flat surface. Repeat cycles `off → all → one` on tap: `all` accents the loop glyph and wraps the queue ends (tail→head on next/end, head→tail on previous); `one` accents a badged `repeat-one` glyph and replays the item on its natural end only — manual skips still advance. The rule rides the queue projection, so service-side moves and the JS fallback follow the same semantics.
- **Rows:** same anatomy as desktop (50 px, larger hit areas).

## Tokens

Typed JSON source (DTCG), one authority; generated TS/CSS outputs. Three schemes share one geometry — `dark` (warm charcoal), `light` (warm paper), `oled` (true black). Measured WCAG 2.2 contrast below (re-measure any value that changes).

| Role | Dark | Light | OLED | Ratio (d / l / o) |
|---|---|---|---|---|
| surface.canvas | `#161512` | `#faf8f3` | `#000000` | — |
| surface.stage | `#100e0c` | `#f1ede5` | `#070605` | — |
| surface.deep | `#0b0a09` | `#e7e1d4` | `#000000` | — |
| surface.raised | `#232019` | `#ffffff` | `#16140f` | — |
| text.primary | `#e6e1d8` | `#2a251f` | `#e6e1d8` | on canvas: 14.0 / 14.3 / 16.1 |
| text.bright | `#f5f1e9` | `#171310` | `#f5f1e9` | on canvas: 16.2 / 17.4 / 18.6 |
| text.secondary | `#a8a094` | `#6f6659` | `#a8a094` | on canvas: 7.1 / 5.3 / 8.1 |
| accent.active | `#ff8a3d` | `#c2410c` | `#ff8a3d` | on canvas: 7.8 / 4.9 / 9.0 |
| accent.soft | `rgba(255,138,61,.16)` | `rgba(194,65,12,.11)` | `rgba(255,138,61,.18)` | fill for selected/active only |
| status.warn | `#ff8787` | `#a61e1e` | `#ff8787` | on canvas: 7.9 / 7.0 / 9.1 |
| status.liked | `#f97b9b` | `#b0214f` | `#f97b9b` | on canvas: 7.3 / 6.2 / 8.3 |
| divider | `#3a352d` | `#d8d1c2` | `#29241e` | seams only |
| switch.thumb | `#ffffff` | `#ffffff` | `#ffffff` | thumb is constant white |
| hairline | `fg @ 14%` | `fg @ 15%` | `fg @ 13%` | furniture borders |
| alpha.fg08/18/25/40 | `fg @ 8/16/26/42%` | `fg @ 6/13/26/42%` | same as dark | hover/selected fills, disabled |

States carry meaning beyond color: playing = accent text **and** eq overlay on the thumb; liked = filled pink heart; unavailable = dimmed + warn glyph; selected = alpha fill + weight. `playback.active` = `accent.active` (split only if the two meanings differ beyond color). No decorative text below 4.5:1; decorative-only roles (grab handles, hints) may sit below.

### Scheme sources (deferred — see decisions.md)

The token set is a small ramp, so an external palette maps onto it mechanically. A `ThemeSourcePort` emits `{scheme, palette?}`; one generator turns `{bg, fg, accent, warn?, sel?}` into a full scheme — `stage/deep/raise` as luminance steps off `bg`, hairlines as `fg` alphas, `accent-soft` = accent @14%, `text.secondary` = fg mixed toward bg — with a contrast guard that nudges derived text roles toward the source until ≥4.5:1 or falls back to the built-in scheme honestly.

| Surface | Source | Yields |
|---|---|---|
| Omarchy | watch `current/theme/colors.toml` (`~/.config/omarchy/`; newer builds `~/.local/state/omarchy/`) | full palette + light/dark mode |
| KDE | `~/.config/kdeglobals` `[Colors:*]` | full palette |
| GNOME 47+ | portal `org.freedesktop.appearance accent-color` | accent only |
| Windows / macOS | Electron `systemPreferences.getAccentColor()` / `getColor('control-accent-color')` | accent only |
| Android 12+ | Material You `system_accent*` via a small Expo module | tonal palette |
| iOS | `useColorScheme` | dark/light only |

Settings gains `adaptive` alongside `dark · light · oled · system`: dark/light flag from `nativeTheme`/`useColorScheme`, palette where the platform exposes one; Electron's main process owns the watchers and pushes over IPC.

## Type

- **One family, sans:** Inter (OFL, bundled via `@expo-google-fonts/inter` on mobile; `Inter → ui-sans-serif → system-ui` stack on web/desktop) — chrome, controls, metadata, lists, display. Hierarchy is built from size + weight + the fg ramp, not from a second family.
- Track titles bold/bright; artists primary; album · year and durations muted; section labels uppercase-tracked.
- CJK: platform fallbacks stay enabled; gallery fixtures include JP/KR/SC/TC titles and truncation is checked against CJK metrics, not Latin averages.

## Components (first release)

Track row (the shared anatomy) · artwork well (missing art = note glyph on a tinted surface, never a broken frame) · mini-player + squared progress ring · Stage sheet · native navbar · transport cluster · waveform-style seek · segmented mode switch · expanding search field · collections tile · library card · artists rail · text/icon buttons · sheet · loading/empty/error/unavailable treatments. Each documents states, overflow, hit area, and accessibility semantics; the track row specifies open-details vs play and how duplicate occurrences read.

## Rendering

Stock RN components + Reanimated/Gesture Handler on mobile; DOM/CSS on desktop; SVG for icons. No Skia/canvas/shaders in the first release. The Stage's waveform-style seek renders the **decorative** amplitude pattern shown in the preview — real peak extraction stays deferred ([product.md](../product.md) roadmap); the component must read identically as a plain progress bar.

Icon motion contract — no static glyph icons: play⇄pause morph · heart fill-in · eq bars on the playing thumb (live in the preview) · rotate (sync) · bounce (like). Shared values, not per-frame React state; transforms and opacity only; the player clock drives progress; stop animation when invisible; respect reduced motion (eq → static indicator, sheet → crossfade, rings → static arc).

Blur rule: translucent blur appears on OS chrome (iOS capsule navbar, glass mini-player) and on one deliberate exception — the mobile full player's bottom frost over its artwork backdrop. Everywhere else app surfaces never blur — depth is the bg ramp.

## Evaluation rules

| Product intent | Design consequence | Evaluated by |
|---|---|---|
| Music is the subject | Artwork and track/artist hierarchy carry the identity; provenance stays secondary | Recognize song, version, and play action without reading provider badges |
| Listening stays continuous | Current track and transport reachable across search, queue, and library | Navigate those views without losing the current item or playback controls |
| Personal organization is trustworthy | Selected / playing / liked / queued / unavailable all distinguishable | Each state readable beyond color alone |
| A collection scans quickly | Stable row geometry; density changes deliberately by context | Review crowded playlists and long metadata, not just showcase cards |
| Personality has a purpose | One recognizable artwork/transport treatment on a consistent type and shape system | Coherent across contrasting albums; survives missing artwork |

## Gallery

A dev-route gallery driven by the production components, fixture props only: scheme matrix (dark/light/OLED); long/CJK/diacritic titles at 200% scale; missing, slow, and extreme-color artwork; every track-row state; queue with duplicates and unavailable items; player states including mid-gesture and reduced motion; error and retry. A component change re-reviews its gallery states; humans judge quality — no screenshot-diff CI.

First design deliverable: the preview's screens rendered with real fixture content in Slice 1 (mobile: list + mini-player + Stage sheet, navbar; the token pipeline live from Slice 1's start) plus the desktop shell in Slice 4 — unified WCO strip, Stage/World split, expanding search, the three schemes.
