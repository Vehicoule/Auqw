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

| UI typeface is Inter (400/500/700 via `@expo-google-fonts/inter` on mobile, `Inter → ui-sans-serif → system-ui` on web/desktop); JetBrains Mono dropped, along with the "type is monospaced" Omarchy rule | Decided | Monospace read terminal-like rather than music-player; owner directed a Mistral-style sans shell (2026-09). Inter ships through the same bundled-google-fonts mechanism that carried JetBrains Mono — dependency swap, not a new mechanism. | If Inter's metrics break dense metadata/duration columns, revisit with `fontVariant: ['tabular-nums']` or a numeric-only mono fallback. |

## Playback

| Decision | Status | Rationale | Reopen when |
| --- | --- | --- | --- |
| Handle-keyed stream ops (`stream:serve-url|open|read|close|release|marks`) report a dead registry session as `released`; session re-prepares on dead-handle kinds from transport calls AND async `failed` statuses (the element's probe path), while a dead-handle pause reports ok | Decided | Serve-url sessions detach on pause (the last range conn ends) and the reaper evicts them past the 120 s TTL, so a long pause outlives the stream. `not-found` there is dead-resource semantics, not malformed input: mapping it to `released` lets session re-prepare from the queue's persisted position instead of `markUnplayable` + 0:00 reset. DOM-only ops (seekTo/pause on the web player) never touch IPC, so the dead URL surfaces as an async media error — the player probes handle liveness (`stream:marks`) before labeling it transient. | If a handle-keyed op gains a not-found source that is genuinely caller error (e.g. bad arg shape), split that slug back out. |
