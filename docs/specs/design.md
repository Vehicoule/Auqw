# Design

Owns: visual direction, tokens, components, and rendering rules.

## Direction

The omarchy design language over the predecessor's **Stage & World** shell — structured, quiet, mono-typed, artwork-led. Rendered and iterated to approval in [`../design-preview/index.html`](../design-preview/index.html) (self-contained, canonical artifact — judge that file, not prose).

Two surfaces, two jobs:

- **Stage** listens — artwork, metadata, seek, transport, and `player | lyrics | queue` sub-modes.
- **World** browses — home, explore, library, search results, settings.

Omarchy rules, non-negotiable: depth comes from the background ramp only (no shadows); boundaries are hairlines; states are alpha fills; accent is reserved for active/selected/progress; radii are deliberate and small (frames square, controls rounded); type is monospaced; icons are custom-rendered and move (see Rendering).

## Shell contract — desktop (Electron)

One window, no titlebar band. The Stage column runs to the top edge; the World's first row is its toolbar. A single 56 px line carries all chrome:

- **Stage strip:** macOS traffic lights pin left, the output-device pill centers, the sidebar-collapse button pins right.
- **World toolbar:** expanding search icon (left, at the panel seam) · centered `home | explore | library` tabs · menu · caption buttons (Windows/Linux overlay the strip's right edge; close hover → `#e81123`). Electron: `titleBarStyle: 'hidden'` + `titleBarOverlay` themed per scheme.
- **Search (GTK pattern):** a compact icon that expands on hover/focus; when open it takes the toolbar's width and the nav tabs step aside — overlap is impossible by construction.
- **Stage player mode:** artwork → meta (title/artist/album + download/add) → waveform-style seek → centered transport `like · prev · play · next · repeat` → volume → mode segment (pinned at the bottom edge). Play is a solid fg-bright block; liked is pink.
- **Stage lyrics mode:** title + honest sync state (`estimated timing` when unsynced) + scrollable lines; active line in accent; pin control; thin scrollbar. No transport controls inside lyrics.
- **Row anatomy (shared, both platforms):** thumb (animated eq overlay when playing) · title + version · duration · state (like/download/warn) · add-to-playlist.
- **Library:** collections 2×2 (`liked · downloads · top 50 · history`, play affordance each) → ownable grid (filter chips, sort, grid/list, dashed new-playlist card) → followed-artists rail → recently added (shared rows). The 2×2 is Library-only; Home uses card rails.

## Shell contract — mobile (React Native / Expo)

Native chrome, per platform — not a shrunken desktop:

- **Navbar:** Android = M3 Expressive bar (tall, wide pill indicator, bold active label, gesture handle); iOS = floating translucent capsule (liquid glass — blur is scoped to OS chrome, never an app surface). Settings is the 4th tab: `home · explore · library · settings`.
- **Mini-player:** floating card above the navbar — artwork left, title/artist, `like + resume` right. Progress is a **squared ring hugging the artwork** (rounded-rect path, progress sweeps from top-center): wavy M3E outline on Android, thin clean arc on iOS. Swipe sideways skips; tap or swipe-up opens the Stage sheet.
- **Stage sheet:** full-screen, grab handle, swipe-down dismisses. Same modes as desktop. Media controls go platform-native — Android: filled-accent squircle play + tonal prev/next; iOS: translucent glass circles. **No volume control** — hardware buttons own it. Layout splits free space evenly (art → air → meta → air → controls); no filler text.
- **Rows:** same anatomy as desktop (50 px, larger hit areas).

## Tokens

Typed JSON source (DTCG), one authority; generated TS/CSS outputs. Three schemes share one geometry — `dark` (Tokyo-Night-based), `light`, `oled` (true black). Measured WCAG 2.2 contrast below (re-measure any value that changes).

| Role | Dark | Light | OLED | Ratio (d / l / o) |
|---|---|---|---|---|
| surface.canvas | `#1a1b26` | `#f5f6fa` | `#000000` | — |
| surface.stage | `#13141c` | `#eceef4` | `#06060a` | — |
| surface.deep | `#0e0e14` | `#dfe2ec` | `#000000` | — |
| surface.raised | `#24283b` | `#ffffff` | `#12131a` | — |
| text.primary | `#a9b1d6` | `#343a52` | `#a9b1d6` | on canvas: 8.1 / 10.4 / 9.9 |
| text.bright | `#c0caf5` | `#222840` | `#c0caf5` | on canvas: 10.6 / 13.5 / 13.0 |
| text.secondary | `#828ab3` | `#575d85` | `#828ab3` | on canvas: 5.1 / 5.9 / ~6.5 |
| accent.active | `#7aa2f7` | `#1a5ac8` | `#7aa2f7` | on canvas: 6.8 / 5.8 / 8.3 |
| accent.soft | `rgba(122,162,247,.15)` | `rgba(26,90,200,.14)` | `rgba(122,162,247,.15)` | fill for selected/active only |
| status.warn | `#e0af68` | `#8a6524` | `#e0af68` | on canvas: 8.5 / 4.9 / ~10 |
| status.liked | `#f7768e` | `#b24a60` | `#f7768e` | on canvas: 6.5 / 4.8 / ~8 |
| divider | `#414868` | `#c4c8d8` | `#23253a` | seams only |
| hairline | `fg @ 11–12%` | `fg @ 12%` | `fg @ 11%` | furniture borders |
| alpha.fg08/18/25/40 | `fg @ 7/16/25/40%` | `fg @ 5/12/24/40%` | same as dark | hover/selected fills, disabled |

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

- **One family, monospaced:** JetBrains Mono (OFL) in the preview — chrome, controls, metadata, lists, display. Hierarchy is built from size + weight + the fg ramp, not from a second family.
- Track titles bold/bright; artists primary; album · year and durations muted; section labels uppercase-tracked.
- CJK: platform fallbacks stay enabled; gallery fixtures include JP/KR/SC/TC titles and truncation is checked against CJK metrics, not Latin averages.

## Components (first release)

Track row (the shared anatomy) · artwork well (missing art = note glyph on a tinted surface, never a broken frame) · mini-player + squared progress ring · Stage sheet · native navbar · transport cluster · waveform-style seek · segmented mode switch · expanding search field · collections tile · library card · artists rail · text/icon buttons · sheet · loading/empty/error/unavailable treatments. Each documents states, overflow, hit area, and accessibility semantics; the track row specifies open-details vs play and how duplicate occurrences read.

## Rendering

Stock RN components + Reanimated/Gesture Handler on mobile; DOM/CSS on desktop; SVG for icons. No Skia/canvas/shaders in the first release. The Stage's waveform-style seek renders the **decorative** amplitude pattern shown in the preview — real peak extraction stays deferred ([product.md](../product.md) roadmap); the component must read identically as a plain progress bar.

Icon motion contract — no static glyph icons: play⇄pause morph · heart fill-in · eq bars on the playing thumb (live in the preview) · rotate (sync) · bounce (like). Shared values, not per-frame React state; transforms and opacity only; the player clock drives progress; stop animation when invisible; respect reduced motion (eq → static indicator, sheet → crossfade, rings → static arc).

Blur rule: translucent blur appears only on OS chrome (iOS capsule navbar, glass mini-player). App surfaces never blur — depth is the bg ramp.

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
