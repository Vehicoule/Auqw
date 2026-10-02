# Design

Owns: visual direction, tokens, components, and rendering rules.

## Direction

The omarchy design language over the predecessor's **Stage & World** shell — structured, quiet, mono-typed, artwork-led. Rendered and iterated to approval in [`../design-preview/index.html`](../design-preview/index.html) (self-contained, canonical artifact — judge that file, not prose).

Two surfaces, two jobs:

- **Stage** listens — artwork, metadata, seek, transport, and `player | lyrics | queue` sub-modes.
- **World** browses — home, explore, library, search results, settings.

Omarchy rules, non-negotiable: depth comes from the background ramp only (no shadows); boundaries are hairlines; states are alpha fills; accent is reserved for active/selected/progress plus the sub-soft hover wash (see Tokens); radii are deliberate and small (frames square, controls rounded); type is one sans family (Inter); icons are custom-rendered and move (see Rendering).

## Shell contract — desktop (Electron)

One window, no titlebar band. The Stage column runs to the top edge at the golden-ratio split — `38.2%` with a 280 px floor and no ceiling (a pixel cap read as a shrunken strip on wide windows) — with **no header strip of its own** (the GTK sidebar player was chromeless; collapse lives on the world toggle). Under ~860 px window width it stops shrinking and floats over a scrim instead (GTK breakpoint behavior, tap-outside dismisses). Pushed pages scope to the world column so the stage's playback controls stay reachable. A single 40 px toolbar carries all window chrome:

- **Stage column edge:** pure player, top to bottom — the same artwork-led immersive surface as the mobile sheet. macOS traffic lights pin over its top-left (the body insets to keep them clear), and a floating stop control (halts playback, keeps the queue) overlays the top-right while a track is loaded — the desktop's only `session.stop()` path; the world toggle only hides the column.
- **World toolbar:** back/forward chevrons leading the left group — a browser-style history over `(tab, overlay-stack)` locations: every committed navigation appends a location, restores rebuild the pushed stack (entity pages re-fetch their own content), and the unavailable direction stays mounted but dims so the pair's footprint never shifts the tabs · stage toggle beside them at the seam · centered `home | explore | library` switch — the same segmented construction as the stage's mode segment (tonal fill, glyph + label), sized up for the strip · compact search field + primary menu (settings) at the end · caption buttons (Windows/Linux overlay the strip's right edge — the renderer measures `windowControlsOverlay` into `--uw-caption-w` so controls keep clear). Electron: `titleBarStyle: 'hiddenInset'` + `trafficLightPosition` on macOS (no drawn strip); `titleBarStyle: 'hidden'` + `titleBarOverlay` themed per scheme on Windows and Linux.
- **Search:** lives once — a compact pill field in the world toolbar's right group, beside the nav switch, present on every tab. It collapses to a bare loupe while the world body is scrolled (accent-tinted while a query is live; a tap or `/` re-opens it) and springs back at the top. Off explore it reads placeholder + `/` and routes to the explore tab on focus (same target as `/`); on explore it *is* the active query — there is no second field inside the tab body. On focus an accent comet laps the border once — tail drifting, then head extending until the entry is ringed (the shared `ringdraw` keyframes; reduced-motion paints the settled ring). This supersedes the earlier icon-only deferral: a 36 px field fits the toolbar honestly, and a second in-body field read as a bug in preview review.
- **Explore results:** filter chips pin above the results (`all · songs · in your library` — the set is the contract's; album/artist entity chips stay reserved until catalog search returns entity items). 'In your library' keeps only rows whose deduped group carries a ref the library owns (same membership rule as the playlist check). Under it, a top band pairs the **top-result hero** (the provider's #1 — big art, kind·artist·year meta, accent play affordance) with a short top-songs column; then the section head (`all results · n`, count follows the filter) and a `# · title · album · time` column-headed table — the row anatomy gains index and album cells for this surface. Narrow widths stack the band single-column and drop the album cell.
- **Stage column:** the full player lives here — same modes and blocks as the sheet below, in the same `player | lyrics | queue` order. When nothing is loaded the column shows an empty state instead of dead controls. No mini-player on desktop.
- **Stage player mode:** artwork-led, same treatment as the mobile sheet — full-bleed artwork, a statically blurred copy revealed by an alpha ramp so the frost fades in under the bottom cluster only (one blur pass, no hard edge), a dark scrim gradient over the top, and dark-scheme scoping for the whole surface. The bottom cluster: radio chip top-center · meta (title/artist/album) + download/add actions at its right edge · waveform-style seek · centered transport `like · prev · play · next · repeat` — shuffle lives in the playing track's ⋯ menu (top-right, beside the dismiss), not on the transport bar; the menu carries the standard row actions and reports shuffle as a toggle row. The mode segment floats at the bottom edge — it takes no layout space, and scrollable bodies keep the clear zone inside their scroll padding so content glides beneath it. The whole cluster is the stage's chrome: lyrics and queue panes fill the space *above* it and never replace it — meta+actions, waveform seek, transport and the mode segment stay put in every mode. Missing artwork falls back to the flat stage surface.
- **Stage lyrics mode:** title + honest sync state (`estimated timing` when unsynced) + scrollable lines; active line in accent; thin scrollbar. No transport controls inside the lyrics pane — the cluster below carries them.
- **Row anatomy (shared, both platforms):** thumb (animated eq overlay when playing) · title + version · duration · state (like/download/warn) · add-to-playlist.
- **Library:** collections 2×2 (`liked · downloads · top 50 · history`, play affordance each) → ownable grid (filter chips, sort, grid/list, dashed new-playlist card) → followed-artists rail → recently added (shared rows).
- **Home:** greeting + resume card → the same four collection tiles (one shared component and counting rule, so a count never disagrees with Library) → card rails (recently played, recently liked, suggested).

## Shell contract — mobile (React Native / Expo)

Native chrome, per platform — not a shrunken desktop:

- **Navbar:** Android = M3 Expressive bar (tall, wide tonal indicator, bold active label, gesture handle); iOS = floating translucent capsule (liquid glass — blur is scoped to OS chrome, never an app surface). Settings is the 4th tab: `home · explore · library · settings`. The bar hides while the stage sheet is expanded — the sheet is the presented surface and a second chrome row behind it reads as a bug.
- **Status bar:** content runs edge-to-edge under the system status bar on every tab and pushed overlay — no painted band. A subtle top fade (a gradient veil, not a solid strip) keeps the clock and notification icons readable over scrolling content. Screens keep their inset inside scroll padding, so headings start below the status bar but glide beneath it as they scroll.
- **Mini-player:** floating card above the navbar — artwork left, title/artist, `like + resume` right. Progress is a **squared ring hugging the artwork** (rounded-rect path, progress sweeps from top-center): the same thin clean arc on every platform. Swipe sideways skips; swipe-down dismisses (stops playback); tap opens the Stage sheet.
- **Mini-player → sheet morph (CMP deck):** one continuous `progress` drives the whole transition — dragging the card upward raises the sheet 1:1 with the finger and release commits at 30% of the travel or on a fling (±600px/s, direction-decisive), settling with a velocity-carrying spring. While it rises, the card fades out inside the first stretch (gone by 0.25), the sheet's surface sweeps up with corners morphing card→sheet→square at the anchor, a half-strength scrim covers the exposed region, and the sheet's content (artwork + controls) reveals through the 0.25→0.5 window. The same contract runs in reverse on the sheet's own down-drag. Whichever gesture's release commits an anchor marks it before the `expanded` flip lands, so the state change never cold-restarts the settle spring — the flick's velocity survives. The uncovered region is pressable the moment the sheet lifts off the card (mid-morph taps collapse it), and gesture objects are stable across re-renders so a position tick can't cancel a live drag.
- **Stage sheet:** full-screen, grab handle, swipe-down dismisses. Same modes and same order as desktop: `player | lyrics | queue`. Media controls go platform-native — Android: filled-accent squircle play + tonal prev/next; iOS: translucent glass circles. **No volume control** — hardware buttons own it. Player mode is immersive (CMP reference): the artwork fills the surface under a fixed dark scrim, a statically blurred copy of the artwork is revealed by an alpha ramp so the frost fades in progressively under the bottom cluster only (no live blur view, no hard edge), and the layout pins its cluster — the top row is `chevron · radio chip centered · ⋯` — the ⋯ opens the playing track's row-actions (the same sheet rows get: like, queue, playlist, download, start-radio, and the shuffle toggle); the title line carries download + add-to-playlist at its right edge; then waveform timeline → transport `like · prev · play · next · repeat`. The mode segment floats over the bottom safe zone (it clears the home indicator); scrollable bodies carry the reserve inside their scroll padding so lines/rows glide beneath it. As on desktop the cluster never leaves: lyrics/queue panes fill the region above the cluster, which stays rendered in every mode. Content always renders in the dark scheme over art. Missing artwork falls back to the flat stage surface; lyrics/queue modes keep the flat surface. Shuffle toggles a dealt play order — accents the crossed-arrows glyph; the canonical queue order is preserved and re-toggling deals a fresh order. Repeat cycles `off → all → one` on tap: `all` accents the loop glyph and wraps the play-order ends (tail→head on next/end, head→tail on previous); `one` accents a badged `repeat-one` glyph and replays the item on its natural end only — manual skips still advance. Both rules ride the queue projection, so service-side moves and the JS fallback follow the same semantics.
- **Rows:** same anatomy as desktop (50 px, larger hit areas).
- **Search:** lives once — a floating glass loupe pinned top-right over every tab (below the sheets; the explore pane carries no second field). Tapping springs it open into the field: the loupe itself morphs — the icon travels into the field's leading slot, the input and close fade in on the delayed leg — on the app spring, with the blur clipped to the morphing shape. Focusing it on a non-explore tab routes to explore (the same `focusSearch`); on explore it is the active query. On focus the same accent comet laps the border as on desktop (lap, tail drift, head extend — `ringdraw` over a measured-perimeter path).
- **Explore results:** the same chip set pins above the list (horizontal scroll); results stay the flat shared-row list — no hero, no table (rows carry no index/album cells at this width).

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
| alpha.fg08/18/25/40 | `fg @ 8/16/26/42%` | `fg @ 6/13/26/42%` | same as dark | selected fills, disabled |
| hover | `accent.soft @ 55%` | `accent.soft @ 55%` | `accent.soft @ 55%` | hover wash — half the selected fill's own source so it always reads below selected in every scheme (adaptive palettes may source the selection color elsewhere than accent); the neutral fg08 wash read as "greyed out" and drowned on accent-filled controls |

Shape: the default control is **squared with rounded corners** — `radius.control` (8–11 px) on buttons, icon buttons, fields, chips and segmented controls; `radius.card` (12 px) on surfaces nested inside a float (segment items, transport wells); `radius.float` (16 px) on floating panels and cards; `radius.thumb` (5 px); `radius.frame` 0. Fully-round shapes are reserved for the idioms where round is the meaning: switch track + thumb, slider knob, indicator dots and badges. The play control is a squircle (~30 % radius) — an app-icon shape, not a circle. `radius.pill` is never a default control shape; the world's single search field is the named exception — the rounded entry is the search idiom.

States carry meaning beyond color: playing = accent text **and** eq overlay on the thumb; liked = filled pink heart; unavailable = dimmed + warn glyph; selected = alpha fill + weight. `playback.active` = `accent.active` (split only if the two meanings differ beyond color). No decorative text below 4.5:1; decorative-only roles (grab handles, hints) may sit below.

### Scheme sources

The token set is a small ramp, so an external palette maps onto it mechanically. A `ThemeSourcePort` emits `{scheme, palette?}`; one generator (`deriveScheme` in `@auqw/design-tokens/adaptive`) turns `{bg, fg, accent, warn?, sel?}` into a full scheme — `stage/deep/raise` as luminance steps off `bg`, hairlines as `fg` alphas, `accent-soft` = accent @14% (an OS `sel` color overrides it), `text.secondary` = fg mixed toward bg — with a contrast guard that nudges derived text roles toward the source until ≥4.5:1 or falls back to the built-in scheme honestly. A palette carrying only `accent`/`warn`/`sel` overlays those roles on the flag-polarity built-in; polarity for a full palette is read off `bg` itself.

| Surface | Source | Yields |
|---|---|---|
| Omarchy | watch `current/theme/colors.toml` (`~/.config/omarchy/`; newer builds `~/.local/state/omarchy/`) — Omarchy/Hyprland sessions only, so a stale file on another DE can't win | full palette + light/dark mode |
| KDE | `~/.config/kdeglobals` `[Colors:*]`, portal accent when globals lack usable colors | full palette |
| GNOME 47+ | portal `org.freedesktop.appearance accent-color` | accent only |
| Windows / macOS | Electron `systemPreferences.getAccentColor()` / `getColor('control-accent-color')` | accent only |
| Android 12+ | Material You `system_accent*` via a small Expo module | tonal palette |
| iOS | `useColorScheme` | dark/light only |

Settings gains `adaptive` alongside `dark · light · oled · system`: dark/light flag from `nativeTheme`/`useColorScheme`, palette where the platform exposes one; Electron's main process owns the watchers and pushes over IPC.

## Type

- **One family, sans:** Inter (OFL, bundled everywhere — `@expo-google-fonts/inter` on mobile; the wght-axis variable woff2 (`@fontsource-variable/inter`) copied into the desktop renderer, aliased to the `Inter_*` token names; `ui-sans-serif → system-ui` stays the fallback stack) — chrome, controls, metadata, lists, display. Hierarchy is built from size + weight + the fg ramp, not from a second family.
- Track titles bold/bright; artists primary; album · year and durations muted; section labels uppercase-tracked.
- CJK: platform fallbacks stay enabled; gallery fixtures include JP/KR/SC/TC titles and truncation is checked against CJK metrics, not Latin averages.

## Components (first release)

Track row (the shared anatomy) · artwork well (missing art = note glyph on a tinted surface, never a broken frame) · mini-player + squared progress ring · Stage sheet · native navbar · transport cluster · waveform-style seek · segmented mode switch · single toolbar search field · collections tile · library card · artists rail · text/icon buttons · sheet · loading/empty/error/unavailable treatments. Each documents states, overflow, hit area, and accessibility semantics; the track row specifies open-details vs play and how duplicate occurrences read.

## Rendering

Stock RN components + Reanimated/Gesture Handler on mobile; DOM/CSS on desktop; SVG for icons. No Skia/canvas/shaders in the first release. The Stage's waveform-style seek renders the measured amplitude profile on desktop/web **and** Android — peaks extract lazily off the playing stream's bytes (WebAudio decode on web; `MediaExtractor`+`MediaCodec` inside `modules/auqw-expo` on Android) as asymmetric `{up, down}` bars, and the seeded **decorative** pattern stands in only while extraction is pending, on failure, or where no decoder path exists (iOS) ([decisions.md](../decisions.md)); the component must read identically as a plain progress bar, and drags commit the seek on release rather than per pixel.

Icons are one family — a 24px grid at `strokes.icon` (1.8px), round caps + joins, with `filled` variants carrying state (like, active tab); icon components never borrow `strokes.progress`. Icon motion contract — no static glyph icons: play⇄pause morph · heart fill-in · eq bars on the playing thumb (live in the preview) · rotate (sync) · bounce (like) · add-to-playlist draws a check on and *keeps* it while the track sits in a playlist (state, not just a confirmation). Springs run per-frame at display rate — rAF vertex interpolation on web, Reanimated shared values on mobile; never fixed-duration CSS `d:path` transitions or layout-property keyframes (eq bars scale, they don't resize). Shared values, not per-frame React state; transforms and opacity only; the player clock drives progress; stop animation when invisible; respect reduced motion (eq → static indicator, sheet → crossfade, rings → static arc).

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

First design deliverable: the preview's screens rendered with real fixture content in Slice 1 (mobile: list + mini-player + Stage sheet, navbar; the token pipeline live from Slice 1's start) plus the desktop shell in Slice 4 — unified WCO strip, Stage/World split, the toolbar's single search field, the three schemes.
