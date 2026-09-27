# Decisions

Statuses: **Decided**, **Deferred**, **Open**. Each row carries its
rationale and the condition that would reopen it.

## Capability surface

| Decision | Status | Rationale | Reopen when |
| --- | --- | --- | --- |
| `catalog.suggest` joins ABI 0.3.0 — keystroke query completions (`{input, limit?}` → `{suggestions: string[]}`) | Decided | Typing fetched full catalog pages per keystroke — heavyweight, slow, and the ranking varied per catalog provider. Completions are one small response, provider-independent, and typo-corrected upstream (predecessor app's `get_search_suggestions` model). | If completions prove consistently worse than live results, revisit; commit path unchanged. |
| `catalog.suggest` has no settings slot — it routes automatically over declaring providers | Decided | Suggestions are provider-independent by design: whichever loaded provider declares the capability serves the draft pane (first declarer, registration order). A per-slot choice would fragment the typing surface without benefit. | If a second declarer lands and ordering matters, introduce routing policy in this log first. |
| Typing no longer runs `catalog.search` — results commit on Enter or a suggestion tap | Decided | Removes per-keystroke catalog load; the committed query is also what caches and recents record, matching what the operator actually searched for. | If users need live results while typing, gate behind a setting — default stays suggestions-first. |
| `stream:read` has no per-read cancel — a JS-side timeout abandons the promise but not the parked demand | Deferred | The waveform-peaks extractor abandons reads parked past a threshold; the native demand they queued releases on the first commit covering the read's position (a probe fetch) or at the stream's own `read_deadline` (20s), and extraction runs sequentially so at most one stale demand per attempt exists. A `requestId` on `stream:read` plus a session-level cancel would retract it exactly — real contract work for a decoration. | If peak extraction (or a future borrowed-reader) shows demand reordering that delays the pump measurably, or the seam gains request-scoped reads anyway, land the cancel. |

## Plugin guests

| Decision | Status | Rationale | Reopen when |
| --- | --- | --- | --- |
| `serde` (derive) joins youtube-music guest deps for `radio.seed`'s `next` parse | Decided | A 565 KB `next` body as a `Value` DOM burns ~340 M fuel against the 200 M per-entry cap — the mobile `budget-exceeded: fuel` failure. Typed structs with per-field tolerance visitors parse once (~84 M fuel) at identical skip semantics. serde + serde_json were already SDK deps; this adds only `serde`'s `derive` feature to the guest crate. | If the guest grows a second large-body endpoint, generalize the opt_* helpers into the SDK or revisit a streaming parse. |

## Playback

| Decision | Status | Rationale | Reopen when |
| --- | --- | --- | --- |
| Shuffle deals a play order, not a queue order: `QueueProjection.order` carries a permutation of item indices the cursor walks — dealt at toggle-on as the canonical prefix through the cursor + uniformly shuffled successors | Decided | Canonical `items` (and the persisted queue) stay untouched, `previous` keeps real history, and the strict immediate-successor legality check on `queue-transition` survives — a random-next rule would have to accept any target. Mirrors ExoPlayer's ShuffleOrder model. Mutations reconcile the deal: removed occurrences drop out, enqueued ones insert at uniform random positions behind the cursor's dealt position, and dealt successors never reshuffle. `repeat=one` still replays the cursor item; `repeat=all` wraps the dealt ends (tail→head on next/ended, head→tail on previous); a lone item self-wraps into a restart. The queue list keeps showing canonical order. | If "up next" must display the dealt order, or a random-next mode is requested, revisit here first. |

## Presentation

| Decision | Status | Rationale | Reopen when |
| --- | --- | --- | --- |
| Waveform peaks extract client-side on desktop/web — a `PeaksPort` pulls the playing stream's own bytes and WebAudio decodes them; mobile keeps the seeded pattern | Decided | Peaks are pure decoration — a provider-carried amplitude field would entangle every guest plugin's contract for pixels no behavior trusts. The open stream handle already owns the bytes, so the extraction is free bandwidth and zero wire surface. | If mobile lands a cheap native extractor (`modules/auqw-expo`) or a provider can ship peaks essentially free, revisit — the renderer contract (`peaks?: number[]`) accepts either source. |
| UI typeface is Inter (400/500/700 via `@expo-google-fonts/inter` on mobile, `Inter → ui-sans-serif → system-ui` on web/desktop); JetBrains Mono dropped, along with the "type is monospaced" Omarchy rule | Decided | Monospace read terminal-like rather than music-player; owner directed a Mistral-style sans shell (2026-09). Inter ships through the same bundled-google-fonts mechanism that carried JetBrains Mono — dependency swap, not a new mechanism. | If Inter's metrics break dense metadata/duration columns, revisit with `fontVariant: ['tabular-nums']` or a numeric-only mono fallback. |

## Playback

| Decision | Status | Rationale | Reopen when |
| --- | --- | --- | --- |
| Handle-keyed stream ops (`stream:serve-url|open|read|close|release|marks`) report a dead registry session as `released`; session re-prepares on dead-handle kinds from transport calls AND async `failed` statuses (the element's probe path), while a dead-handle pause reports ok | Decided | Serve-url sessions detach on pause (the last range conn ends) and the reaper evicts them past the 120 s TTL, so a long pause outlives the stream. `not-found` there is dead-resource semantics, not malformed input: mapping it to `released` lets session re-prepare from the queue's persisted position instead of `markUnplayable` + 0:00 reset. DOM-only ops (seekTo/pause on the web player) never touch IPC, so the dead URL surfaces as an async media error — the player probes handle liveness (`stream:marks`) before labeling it transient. | If a handle-keyed op gains a not-found source that is genuinely caller error (e.g. bad arg shape), split that slug back out. |
