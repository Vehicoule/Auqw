# Prepared-session claim + re-mint cancel hygiene — REPORT

Branch `devin/pb-race`. Fixes the delivered-but-unattached kill race:
a `Prepared{handle}` in flight could be terminated between delivery
and the consumer's attach, because every teardown keyed on
`attached` alone.

## What changed

### Task 1 — atomic claim (`auqw-stream`, `host-surface`)

- `crates/auqw-stream/src/session.rs`: `Shared.claimed: bool` beside
  `attached` under the same mutex; `SessionInner::is_claimed()` and
  `SessionInner::claim()` (monotonic — never cleared, including across
  `close`; a claimed session keeps its owner through detach).
- `crates/auqw-stream/src/registry.rs`: `StreamRegistry::claim(handle)`
  plus the two predicate changes below.
- `crates/host-surface/src/stream.rs`: `stream.claim(...)` runs inside
  the `PreparedSlot` commit critical section at **both** commit sites —
  the adoption fast-path (`admission.prepared`, ~line 408) and the
  invoke-path delivery commit (`prepared_handles`, ~line 589). Claim is
  written **before** the slot insert: a supersede scan doesn't hold
  `prepared_handles`, so the session must already read claimed before
  its slot is ever visible to `cancel`. A `cancel` (which holds
  `prepared_handles`) can therefore never observe a slot whose session
  is unclaimed.
- `crates/host-surface/src/lib.rs` `cancel`: the delivered-request
  path removes the request's slot, keeps the existing co-owner check
  (`m.values().any(|v| v.handle == slot.handle)`), and now calls
  `stream.release(&handle)` instead of `cancel_if_unattached`. Once
  the slot is gone the session is ownerless — and claimed, so the
  unattached-only predicate could never fire. The `is_live` rechecks,
  mid-delivery `await_idle`, tombstone logic, and generation guards
  are unchanged.

### Exact predicates touched

| Site | Before | After |
| --- | --- | --- |
| `supersede_unattached` scan filter (`registry.rs`) | `!s.is_attached() && !s.is_terminal()` | `!s.is_attached() && !s.is_claimed() && !s.is_terminal()` |
| `supersede_unattached` terminal transition | `terminate_if(Superseded, \|sh\| !sh.attached)` | `terminate_if(Superseded, \|sh\| !sh.attached && !sh.claimed)` |
| `cancel_if_unattached` (`registry.rs`) | `terminate_if(Cancelled, \|sh\| !sh.attached)` | `terminate_if(Cancelled, \|sh\| !sh.attached && !sh.claimed)` |
| delivered-request `cancel` (`lib.rs`) | `stream.cancel_if_unattached(&handle)` | `stream.release(&handle)` |

### Unchanged on purpose (verified)

- `attach()` checks only `terminal` and `stale_prepare` — a claimed
  session attaches normally (covered by
  `claimed_session_survives_unattached_teardowns_and_attaches`).
- `detached_since`/`attach_ms`/pump priority/`stale_prepare` semantics
  untouched; `claimed` does not gate the detached reaper — a claimed
  session still reaps at `prepare_ttl` (120 s bound). An ownerless
  attach is handled by `abandon` instead: the session is marked, and
  its `close` drops `claimed` so supersede/reaper can retire the
  detach — never a kill on a playing stream.
- `reusable()` still ignores `claimed` — a claimed warm is still
  adoptable by a real attempt (co-ownership; decision-log warm-adopt
  row). The tombstone and `was_cancelled`/`dead` abandoned paths in
  `start_prepare`'s delivery still call `cancel_if_unattached` —
  those sessions were never slot-committed, so they are unclaimed and
  still die.
- `stream_release` is unchanged (still unconditional by handle + slot
  prune): it is owner-explicit teardown, not a kill path the claim
  covers — see "Notes" below.

### Task 2 — re-mint cancellation (`Remint` trait)

- `Remint::remint(cancel: CancellationToken)` — the pump passes
  `session.cancel.child_token()`; `PluginRemint` hands it to `invoke`
  (replacing the detached `CancellationToken::new()`), so session
  teardown reaches the re-mint's own cancel checks/in-flight HTTP
  promptly. `mint_deadline` remains the outer bound, and the pump's
  own `select!` cancel arm still drops the future on teardown — the
  token additionally keeps detached guest work from finishing blind.
- All impls updated: `PluginRemint`, `DevRemint`, `StaticRemint`
  (testkit), `CountingRemint`/`HangingRemint`/`WatchingRemint` (pump
  tests), `NeverRemint`/`OkRemint` (seam), `HangRemint` (host tests).

## Tests added

- `auqw-stream` seam (`tests/seam.rs`):
  - `claimed_session_survives_unattached_teardowns_and_attaches`
  - `unclaimed_session_still_dies_to_unattached_teardowns`
  - `claimed_session_stays_claimed_across_detach`
- `auqw-stream` pump (`src/pump.rs` tests):
  - `session_cancel_reaches_in_flight_remint` — a re-mint parked on
    the handed token wakes on session teardown (detached watcher
    proves the child token fired, not just the pump's select arm).
- `host-surface` (`src/lib.rs` tests):
  - `adopted_session_is_claimed_against_supersede` — the adoption's
    slot commit claims the session.
  - `delivered_owner_cancel_releases_only_at_last_owner` — co-owner
    survives first owner's cancel; last owner's cancel releases.

Existing tests already covering the fixed behavior now exercise the
new path: `prepare_adopts_a_live_warm_session`'s tail (`cancel`
unwinds the adopted warm — now via `release`, which the claimed
session requires) and `cancel_racing_adoption_never_kills_the_new_owner`.

## Contradictions / notes vs the analysis

- **None found against the race analysis.** The three kill paths were
  as described; the `is_live` rechecks narrow but don't close the gap.
- The delivered-cancel swap from `cancel_if_unattached` to `release`
  drops the old "a playing consumer is never cancelled" guard *for the
  owning request's cancel*: an attached session whose last owner is
  cancelled now ends `Released`. That is the intended ownership model —
  once the request's slot is removed nothing else can end the session
  (attached sessions are exempt from the detached reaper, so an
  ownerless attached session would leak); player-side attached
  teardown is `releaseStream`/`stream_release` by handle. The `cancel`
  doc comment was updated to say so.
- `stream_release`'s unconditional-by-handle kill of a co-adopted
  handle (the third listed path) is not closed by this diff — per the
  expected-diff scope it stays caller-discipline: the bindings only
  release handles they own (`markReleased` ordering in
  `AuqwExpoModule.kt`), and `stream_release` prunes co-owners' slots.
  The claim prevents the *unattached-only* kills; explicit release
  remains terminal.
- Invoke-path `Prepared` can't be driven in host-surface tests (no
  conformance guest emits a contract-valid `playbackResolveResult`
  under `start_prepare`'s payload — echo echoes the step input,
  scenario requires `payload.scenario`). The invoke-path claim commit
  is covered by the registry-level claim tests plus the identical
  adopt-path test; the diff is the same two-statement commit order.

## Gate evidence

Workspace package names are `auqw-stream`/`auqw-host-surface` (the
`-p host-surface` spelling in the task doesn't resolve — same
packages).

```text
$ cargo fmt --all -- --check
(clean — FMT_CLEAN)

$ cargo test -p auqw-stream -p auqw-host-surface
host-surface lib: 19 passed, 0 failed   (incl. adopted_session_is_claimed_against_supersede,
                                       delivered_owner_cancel_releases_only_at_last_owner)
auqw-stream lib:  70 passed, 0 failed   (incl. session_cancel_reaches_in_flight_remint)
auqw-stream seam: 46 passed, 0 failed   (incl. claimed_session_survives_unattached_teardowns_and_attaches,
                                       unclaimed_session_still_dies_to_unattached_teardowns,
                                       claimed_session_stays_claimed_across_detach)

$ cargo build -p auqw-stream -p auqw-host-surface
Finished `dev` profile — clean

$ cargo clippy -p auqw-stream -p auqw-host-surface --all-targets -- -D warnings
Finished `dev` profile — clean

$ cargo check -p auqw-mobile-bindings -p auqw-node-bindings
Finished `dev` profile — clean (bindings unaffected by the internal
Remint signature change)
```
