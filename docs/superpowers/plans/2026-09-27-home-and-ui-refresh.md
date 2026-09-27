# Home and UI Refresh Implementation Plan

> **For agentic workers:** Implement the tasks in order and check each result before proceeding.

**Goal:** Make Home cards honest and playable, improve crowded metadata in the Stage and World, and bring the canonical preview up to date.

**Architecture:** Keep the existing shared view models and native/web components. Mobile Home distinguishes provider suggestions from local recording cards before invoking playback. Layout adjustments remain in the platform UI components and CSS.

**Tech Stack:** React Native, React DOM, TypeScript, pnpm, static HTML preview.

**Spec:** `docs/specs/design.md` and the approved Current/Proposed comparison from this discussion.

## Constraints and review focus

- Keep mobile artwork full bleed with the pinned controls and preserve the dark contrast treatment.
- Preserve provider suggestions versus recent-search semantics and the existing offline play guard.
- Do not display a `see all` action without a wired destination.
- Review long titles at small heights and large text scales; artwork and controls must stay usable.
- Search results and Home rails should remain legible in a narrow World pane and with translated copy.

## Tasks

1. **Home behavior and copy.** Add a regression for tapping a provider-backed Home card on mobile, observing the current missing-recording path. Reuse the search result's metadata and `canPlayMeta` logic to play it; leave materialized recordings on `playRecording`. Change Home rail labels to describe recently liked tracks and results from a search. Check English and all shipped locale catalogs.
2. **Player and search.** Keep the immersive Stage art and bottom cluster. Permit a two-line mobile title alongside download/add actions; keep the desktop Stage title readable without adding an artwork resize rule. Render provider completions with a search icon and recents with a clock on native and web. Stack search result metadata under its heading when space is tight.
3. **Home layout and hover.** Put the Home subtitle on its own line in narrow layouts; permit two-line card titles with aligned subtitles. Replace Home/library cover hover shadows with a hairline or quiet fill, including keyboard focus.
4. **Preview and verification.** Update `docs/design-preview/index.html` so its mobile Stage matches the current immersive surface, then reflect the metadata changes. Run the relevant UI/application tests, full `pnpm typecheck` and `pnpm test`, inspect the diff, and open a PR with any device-only limitations stated.
