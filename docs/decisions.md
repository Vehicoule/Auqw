# Decisions

Statuses: **Decided**, **Deferred**, **Open**. Each row carries its
rationale and the condition that would reopen it.

## Capability surface

| Decision | Status | Rationale | Reopen when |
| --- | --- | --- | --- |
| `catalog.suggest` joins ABI 0.3.0 — keystroke query completions (`{input, limit?}` → `{suggestions: string[]}`) | Decided | Typing fetched full catalog pages per keystroke — heavyweight, slow, and the ranking varied per catalog provider. Completions are one small response, provider-independent, and typo-corrected upstream (predecessor app's `get_search_suggestions` model). | If completions prove consistently worse than live results, revisit; commit path unchanged. |
| `catalog.suggest` has no settings slot — it routes automatically over declaring providers | Decided | Suggestions are provider-independent by design: whichever loaded provider declares the capability serves the draft pane (first declarer, registration order). A per-slot choice would fragment the typing surface without benefit. | If a second declarer lands and ordering matters, introduce routing policy in this log first. |
| Typing no longer runs `catalog.search` — results commit on Enter or a suggestion tap | Decided | Removes per-keystroke catalog load; the committed query is also what caches and recents record, matching what the operator actually searched for. | If users need live results while typing, gate behind a setting — default stays suggestions-first. |
