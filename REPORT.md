# Warm-adoption coverage — REPORT

Branch `devin/pb-warm`. Widen the hit rate of the advisory stream
warm (`#streamWarm`) so the common forward paths adopt a minted
session instead of cold-resolving, without growing steady-state
provider resolve volume.

## What changed

All engine changes are in `packages/application/src/session/playback-engine.ts`;
tests in `packages/application/src/session/session.test.ts`; the warm-policy
row in `docs/decisions.md` was amended to match.

### 1. Queue-side want widened (`#warmWant`, `#successorWarmRef`, `#queueRowRef`)

Previously the queue-origin warm existed only while `playback.type === 'playing'`
and targeted `walk[pos + 1]` unconditionally. Now:

- **Settled stretches mint the `next()` target.** `buffering`, `playing`, and
  `paused` all want the row a forward move lands on — the first **unmarked**
  dealt successor, head-wrapped under `repeat=all`. `#successorWarmRef` mirrors
  `advance()`/`#wrapToHead` exactly (same walk, same `isUnplayable` skip, same
  wrap rule), so the minted session is the one `next()`/ended attaches.
- **Parked cursor warms under an idle paused queue.** When playback is `idle`
  but the queue mode is `paused` with a cursor — a `next()`/`previous()` taken
  while paused idles the player, and a restored session boots into exactly this
  shape — the want is the cursor row itself, because the resume/play press is
  that row's attempt. Flagged (`isUnplayable`) cursor rows mint nothing: that's
  a retry the user owes, not a spend the warm owes.
- **Unmarked-only everywhere.** Both the dealt-window candidates pass
  (`#nextWarmTarget`) and the successor pick step over `isUnplayable` rows —
  previously the window pass could still buy a mapping for a row every forward
  move skips.
- `#queueRowRef` is the shared pick: occurrence pin, owned bytes, mapping,
  unvetoed `sourceRef`, gated to a remote ref on the active playback provider —
  candidate-less rows stay the candidates pass's job.
- `StreamWarm.origin` doc updated: `'queue'` now means any queue-side want.

### 2. Early waste release

- **Adoption-time margin check** in `startAttempt`: the mint-side
  `WARM_EXPIRY_MARGIN_MS` check now runs again at adopt. A warm whose URL lands
  inside the attach margin — or a dead `safeNow()` clock that can't prove
  otherwise — is released via `#dropStreamWarm` and the attempt falls through
  to a cold prepare, instead of riding a doomed handle into the dead-outcome
  re-prepare hop (#197's path stays the fallback, not the plan).
- Mutation/stop invalidation was already complete (queue-mutation re-eval,
  `setShuffleRetargetsStreamWarm`, revision keys); new tests pin the
  release-on-removal and release-on-stop behavior.
- **Idle-transitional keep**: `resume()`/`play()` flips a paused queue to
  `'playing'` one derived tick before `startAttempt` runs — the want reads null
  in that tick and used to drop the just-needed warm. A warm matching the
  cursor row now survives the gap, the same keep-rule `'playing'` already used
  for a just-landed select.

### 3. Tick-driven re-eval on every settled status

`#handleEvent` re-evaluates `#maybeWarmStream` on every accepted mapped tick
(was: `playing` only). Buffering and paused ticks now derive the want too —
the successor mint starts while the current row's first bytes land, and a
paused session keeps its warm instead of waiting for the next mutation.

## Verification

```text
pnpm install --frozen-lockfile          ok
pnpm -C packages/application typecheck  ok
pnpm -C packages/application test       ok (all session suites incl. 8 new tests)
pnpm -C packages/app-shell typecheck    ok
pnpm -C packages/app-shell test         ok ("app-shell tests passed")
pnpm -C apps/mobile typecheck           ok
pnpm -C apps/desktop typecheck          ok
pnpm typecheck (workspace)              ok
```

New `session.test.ts` coverage:

- `streamWarmDuringBuffering` — successor mint issues on a buffering tick.
- `streamWarmPausedNextAdoptsOnResume` — warm survives pause, survives the
  paused-`next()` idle hop (`release` count for the warm handle stays zero),
  and `resume()` adopts it (`prepare` count unchanged at 1).
- `streamWarmWrapsRepeatAllTail` — tail row warms the dealt head under
  `repeat=all`; `next()` wraps and adopts (prepare count unchanged).
- `streamWarmSkipsUnplayableSuccessor` — a permanently-failed row is skipped;
  the warm targets the next unmarked row.
- `streamWarmReleasedOnSuccessorRemoval` — removing the warmed row releases
  its session handle and retargets to the new successor.
- `streamWarmDropOnStop` — `stop()` releases the mint.
- `streamWarmStaleAdoptionRepairs` — a warm minted outside the attach margin
  is released at adoption and the tap mints fresh (prepare count = 1).
- `streamWarmDenyCapEvicts` — 17 denies through the 16-cap LRU evict the
  oldest; a re-hand re-fires.
- `restartRestore` reworked — restore on a paused queue mints the cursor warm
  (asserted `prewarm` on the persisted ref, never a saved URL), and `resume()`
  adopts it with zero `prepare` calls. `restorePlayingSnapshot`/`settingsFlow`
  filters now exclude advisory ops (`prewarm`/`cancelPrepare`/`release`) from
  the "never starts playback" invariant — the invariant itself is unchanged.

## Hit-rate delta per flow (estimated, engine-level)

No device measurement exists for this slice — these are structural deltas
derived from the want-space diff, not measured TTFS numbers.

| Flow | Before | After |
| --- | --- | --- |
| tap-in-queue (cursor/successor row) | adopt only if minted under `playing` | + adoptable after a paused cursor hop and after restore (parked-cursor mint) |
| `next()` while playing | warm-adopted (existing) | unchanged; mint now also issues during `buffering`, so it's likelier to be delivered by the time `next()` lands |
| `next()`/`previous()` while paused | always cold (want was null under `idle`/`paused`) | parked-cursor mint — resume/play adopts, zero `prepare` |
| `next()` at repeat=all tail | always cold (`walk[pos+1]` only) | head-wrapped mint — wrap adopts |
| resume after restore on paused queue | always cold | boot-minted cursor warm adopted on `resume()` |
| `next()` past a flagged row | warm could target the dead row | warm targets the row `next()` lands on |

## Resolve-volume delta per change

- Successor want under `buffering`/`paused`: **+1 advisory `prewarm`** per
  settled stretch with a resolved successor (was +0 under paused, issued only
  on playing ticks under buffering). Bounded by the single warm slot,
  `prefetch`+online+unmetered gates, the 16-key deny-LRU, and `WARM_SEEN`
  dedupe on the window pass. The mint replaces the cold resolve `next()` would
  have paid — adopted ⇒ net ≤0; abandoned ⇒ +1, same bound as before.
- Parked-cursor want under idle+paused: **+1 `prewarm`** per paused-idle
  stretch (once per cursor; re-issues only on want change). On resume it is
  the resolve the press needed anyway ⇒ adopted = net 0, and resume-on-boot
  is the single most common cold path so the trade is favorable.
- Unmarked-skip (window + successor): **−1 wasted resolve** per flagged row in
  the walk — strictly saves traffic.
- Adoption-time stale release: **0** — converts a guaranteed dead-handle
  outcome (dead attach + #197 re-prepare) into one clean cold prepare; same
  resolve count, one fewer failed attach.
- Steady-state ceiling unchanged: ≤1 outstanding speculative stream mint at
  any time; no new periodic or per-tick provider calls (all mints still want-
  driven and deduped).

## Deliberately not done

- **Press-intent warm (candidate 2): no new signal invented.** The only
  prewarm callers are the search-results effect in `packages/app-shell` (first
  9 visible rows → `session.prewarm`) and the catalog labeled-match path.
  Neither desktop nor mobile has a hover/long-press/dwell/scroll-settle
  signal; inventing one (timers, pointer listeners, row lifecycle hooks) is a
  heavier shell change than this task's blast radius. The existing
  surface-hand path already covers the "user is looking at it" case.
- **No TTL/deny tuning (candidate 3).** No evidence of starvation:
  `STREAM_DENY_CAP=16` counts distinct failing keys per session — a bound
  real sessions can't plausibly reach (proven by `streamWarmDenyCapEvicts`);
  `WARM_ROW_TTL_MS=120s` matches the URL-attach horizon. Left as-is.
- **`'preparing'` still parks the warm slot (candidate 4).** Verified against
  main post-#198: `claim` lands inside the prepared-slot commit, so a
  **delivered** warm is immune to `supersede_unattached`/`cancel_if_unattached`,
  but an **in-flight** warm minted alongside an attempt's prepare is not yet
  claimed and could be killed by that attempt's supersede scan. The park stays
  — it is precisely the "don't supersede-kill an unclaimed warm" rule. Warm
  mints resume the moment the attempt commits (`buffering` want).
- **Second-deep successor warming** (`walk[pos+2]`): rejected — the single
  warm slot is the resolve-volume bound; a second speculative mint doubles the
  per-action ceiling for a much lower-probability target.
- **`next()`-while-paused to a non-adjacent row / arbitrary `playOccurrence`
  tap** on an unwarmed row still cold-resolves — only cursor/successor/surface
  rows warm. Widening to "any queue row" would explode resolve volume with no
  hit-rate evidence.

## Diffstat

```text
$ git diff --stat origin/main...HEAD
 .agent-started                                     |   0
 PROMPT.md                                          |  87 ++++-
 docs/decisions.md                                  |   2 +-
 packages/application/src/session/playback-engine.ts | 238 ++++++++-----
 packages/application/src/session/session.test.ts   | 372 +++++++++++++++++++--
 5 files changed, 580 insertions(+), 119 deletions(-)
```

(`PROMPT.md`/`.agent-started` are harness artifacts committed separately at
`38c76c8`; the implementation is `b9e520a`.)
