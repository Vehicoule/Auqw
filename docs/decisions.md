# Decisions

Statuses: **Decided**, **Deferred**, **Open**. Each row carries its
rationale and the condition that would reopen it.

## Capability surface

| Decision | Status | Rationale | Reopen when |
| --- | --- | --- | --- |
| `catalog.suggest` joins ABI 0.3.0 — keystroke query completions (`{input, limit?}` → `{suggestions: string[]}`) | Decided | Typing fetched full catalog pages per keystroke — heavyweight, slow, and the ranking varied per catalog provider. Completions are one small response, provider-independent, and typo-corrected upstream (predecessor app's `get_search_suggestions` model). | If completions prove consistently worse than live results, revisit; commit path unchanged. |
| `catalog.suggest` has no settings slot — it routes automatically over declaring providers | Decided | Suggestions are provider-independent by design: whichever loaded provider declares the capability serves the draft pane (first declarer, registration order). A per-slot choice would fragment the typing surface without benefit. | If a second declarer lands and ordering matters, introduce routing policy in this log first. |
| Typing no longer runs `catalog.search` — results commit on Enter or a suggestion tap | Decided | Removes per-keystroke catalog load; the committed query is also what caches and recents record, matching what the operator actually searched for. | If users need live results while typing, gate behind a setting — default stays suggestions-first. |

## Plugin guests

| Decision | Status | Rationale | Reopen when |
| --- | --- | --- | --- |
| `serde` (derive) joins youtube-music guest deps for `radio.seed`'s `next` parse | Decided | A 565 KB `next` body as a `Value` DOM burns ~340 M fuel against the 200 M per-entry cap — the mobile `budget-exceeded: fuel` failure. Typed structs with per-field tolerance visitors parse once (~84 M fuel) at identical skip semantics. serde + serde_json were already SDK deps; this adds only `serde`'s `derive` feature to the guest crate. | If the guest grows a second large-body endpoint, generalize the opt_* helpers into the SDK or revisit a streaming parse. |

## Presentation

| Decision | Status | Rationale | Reopen when |
| --- | --- | --- | --- |
| Waveform peaks extract client-side on desktop/web — a `PeaksPort` pulls the playing stream's own bytes and WebAudio decodes them; mobile keeps the seeded pattern | Decided | Peaks are pure decoration — a provider-carried amplitude field would entangle every guest plugin's contract for pixels no behavior trusts. The open stream handle already owns the bytes, so the extraction is free bandwidth and zero wire surface. | If mobile lands a cheap native extractor (`modules/auqw-expo`) or a provider can ship peaks essentially free, revisit — the renderer contract (`peaks?: number[]`) accepts either source. |
| UI typeface is Inter (400/500/700 via `@expo-google-fonts/inter` on mobile, `Inter → ui-sans-serif → system-ui` on web/desktop); JetBrains Mono dropped, along with the "type is monospaced" Omarchy rule | Decided | Monospace read terminal-like rather than music-player; owner directed a Mistral-style sans shell (2026-09). Inter ships through the same bundled-google-fonts mechanism that carried JetBrains Mono — dependency swap, not a new mechanism. | If Inter's metrics break dense metadata/duration columns, revisit with `fontVariant: ['tabular-nums']` or a numeric-only mono fallback. |
