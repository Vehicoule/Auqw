# Playback reliability: dead-outcome re-prepare, honest row marking, bot-check wall, cancelled verdicts, mobile watcher — REPORT

Branch `devin/pb-engine`. Five fixes to the playback failure path so
verdicts stay honest and recoverable: registry-induced dead streams
re-prepare silently, transient weather no longer poisons queue rows,
the provider bot-check wall gets its own policy + copy, bookkeeping
verdicts stop painting the player line, and mobile surfaces late
native failures exactly like desktop.

## Fix 1 — dead-stream prepare outcomes re-prepare silently

**Before:** a `prepare` outcome arriving `{type:'failed', error.kind ∈
DEAD_STREAM_KINDS}` (`not-found`/`released`/`superseded`/`evicted`/
`expired`) went straight to `#failOrRetryAttempt` → `failAttempt` →
`error.notFound`-style failure — even though the same dead-stream
kinds on the `play()` and status legs already trigger a silent
re-prepare. A `not-found` outcome here is a registry kill (the minted
session died between commit and delivery), not provider truth.

**After:** `#handlePrepareEvent`
(`packages/application/src/session/playback-engine.ts`, failed-outcome
branch) checks `DEAD_STREAM_KINDS` first and hops through
`startAttempt(occurrenceId, {deadlineMs, listenedMsAccum,
preparesUsed})` — the same recovery shape `#adoptPrepared` already
uses for a dead handle. The hop draws on the intent's own deadline and
shared `preparesUsed`, and the budget gate lives in the branch itself:
once `preparesUsed` reaches `PREPARE_CALL_BUDGET = 2` the outcome
falls through to the ordinary failure path, so the terminal verdict
is the LAST outcome verbatim — a provider's real `'not-found'` rides
the same kinds and must never surface as `'budget-exceeded'`.
Playback publishes `preparing` throughout — no failed flicker, no
queue mark.

## Fix 2 — only permanent verdicts flag the row

**Before:** `#failAttempt` called `r.queue.markUnplayable(error)` for
every terminal failure. `markUnplayable` both pauses+records
`blockedError` AND adds the occurrence to `#unplayable`, which drives
`QueueProjectionItem.skipsForward` — so transient weather, timeouts,
rate walls, cancellation, and budget exhaustion permanently
forward-marked otherwise playable rows.

**After:** `queue-engine.ts` splits the primitive:
`#blockCurrent(error, unplayable)` shared by
- `markFailed(error)` — pause + record the typed verdict, no flag.
- `markUnplayable(error)` — same, plus the forward-skip flag.

`#failAttempt` now gates on `PERMANENT_FAILURE_KINDS` =
`{not-found, unsupported, no-result, auth-required, expired-resource}`.
Every other kind (`transient`, `timeout`, `rate-limit`, `cancelled`,
`superseded`, `budget-exceeded`, dead-stream kinds, `unavailable`, …)
pauses the queue on its typed `blockedError` but leaves the row in the
forward walk — `next()`/`previous()`/`select` still reach it. The
same-verdict no-op dedupe is flag-aware so a `markFailed` →
`markUnplayable` escalation can't silently degrade.

## Fix 3 — bot-check wall: detail survived; policy + honest copy added

**Trace (where the detail lands).** The guest emits
`Failed{kind:"transient", message:"bot-check"}`
(`plugins/youtube-music/src/guest.rs` `ladder_error`). The guest SDK
renders `{kind}: {message}` → `"transient: bot-check"`;
`crates/plugin-host/src/invoke.rs` wraps it as
`InvokeError::GuestFail` → `"guest failure (transient): transient:
bot-check"`. Every JS leg then preserves `kind` and `message`
verbatim: `crates/host-surface/src/stream.rs` `prepare_outcome`, the
napi/node bindings, `apps/desktop/.../web-player.ts`
(`appError(appErrorKind(kind), message)`), `rawToAppError`, and
`apps/mobile/src/adapters/auqw-expo-player.ts`. **The detail is never
laundered away** — it arrives at the engine as
`AppError{kind:'transient', message:'…: bot-check'}`.

**Detection:** `isBotCheckWall(error)` in
`packages/application/src/errors.ts` — `kind === 'transient'` AND the
LAST `:`-separated segment of `message` trims to exactly `bot-check`.
Because every host leg prefixes rather than rewrites, the guest's
detail token is always the trailing segment; non-suffix occurrences
(`bot-check: recheck`, `bot-checksum`, a non-`transient` kind) do not
match.

**Policy:** the wall is provider truth (per-IP/visitor), not weather —
- `#failOrRetryAttempt` bails to `#failAttempt` before arming the
  400 ms auto-retry (so a wall never spends the attempt's one retry).
- `retryBounded` (`retry.ts`) also refuses to retry it, covering
  `prepare`/`candidates` call-level retries.
- It is not in `PERMANENT_FAILURE_KINDS` → `markFailed` only: queue
  pauses with `blockedError{transient, …bot-check}`, row unflagged,
  explicit user retry still reaches it.

**Copy:** new `error.providerWall` key in all 5 locales
(en "the provider is refusing requests right now — try again later";
fr/de/es/zh equivalents), selected in `errorText` before the generic
kind map when `isBotCheckWall` holds. Generic transients keep
`error.transient`. The raw guest message never reaches a surface —
only the localized line.

## Fix 4 — bookkeeping verdicts stay off the player line

`toPlayerModel` (`packages/ui-shared/src/view-models.ts`) rendered
`errorText(playback.error)` for every `failed` state. `errorText`
deliberately keeps `cancelled` loud — providers return it as a real
verdict on non-playback ops, and `reportResult`/`reportPlay` own
teardown suppression at the ops level. The player surface is
different: on a playback attempt, `cancelled`/`superseded` can only be
bookkeeping (a torn-down intent or an overtaken play).

**After:** `PLAYER_ERROR_SILENT = {cancelled, superseded}` gates the
`errorMessage` field — the row still reports `status:'failed'` but
never wears interruption copy. Real failure kinds render unchanged.

## Fix 5 — mobile mounts the `playback.failed` watcher

Desktop shells pass `trackAttemptActions: true` into
`useAppShell` ports, which mounts the watcher that reports
`playback.failed` verdicts landing after the op promise settled
(engine-advanced failures) through the same deduped funnel
(`attemptActionsRef` action labels + `lastPlayErrorRef` identity
dedupe). Mobile reported only its own op Results — a late native
`failed` status never surfaced.

**After:** `apps/mobile/App.tsx` sets `trackAttemptActions: true` —
the flag already parameterizes the whole funnel, so this is a one-line
parity flip plus doc updates (`types.ts`, `app-shell.ts` comments now
describe both shells instead of "desktop only").

## Tests added

`packages/application/src/session/session.test.ts`:
- `deadPrepareOutcomeRePrepares` — dead prepare outcome → second
  prepare issued, playback stays `preparing`, no `blockedError`, the
  fresh session adopts and plays; the superseded caller reads
  `superseded` bookkeeping.
- `deadPrepareOutcomeStopsAtBudget` — two dead outcomes → exactly 2
  prepare calls, terminal `budget-exceeded`, queue paused, row
  unflagged.
- `transientFailureLeavesRowReachable` — generic `transient` still
  gets the in-budget retry; a terminal transient pauses the queue with
  `blockedError` but `skipsForward` stays unset and
  previous→next still lands on the row (was oC-skipping before).
- `permanentFailureSkipsForward` — `auth-required` flags
  `skipsForward:true` and `next()` steps over the row.
- `botCheckWallPolicy` — wall fails immediately (no `preparing`
  backoff), no second prepare after `advance(2000)`, queue paused
  unflagged, caller sees `transient`+`bot-check` intact, explicit
  `retryCurrent()` re-prepares and plays.
- `unplayableFailure` — strengthened: asserts the `unavailable`
  verdict does NOT flag the row.
- `unplayableRollbackRestoresMarks`, `repeatAllWrapSkipsMarkedHead` —
  flag-dependent assertions re-pointed at `no-result` (a verdict the
  policy still flags); assertions otherwise unchanged.

`packages/application/src/queue/queue-engine.test.ts` — `markFailed`
block: pause+verdict without flag, dedupe, walk reachability, and the
flag-aware `markUnplayable` escalation.

`packages/application/src/errors.test.ts` — `isBotCheckWall` matrix:
5 wrap shapes recognized, 8 non-wall kind/message pairs rejected.

`packages/ui-shared/src/error-text.test.ts` — wall copy asserted for
both the bare and host-wrapped message shapes; generic transient keeps
`error.transient`; per-locale coverage loop now also verifies
`error.providerWall` exists and differs in de/es/fr/zh.

`packages/ui-native/src/ui-native.test.ts` — `testPlayerMapper`:
`cancelled`/`superseded` failed playbacks produce `status:'failed'`
with `errorMessage:null`; the fixture failure still renders.

Mobile watcher: the flag flip is hook wiring shared with desktop; no
new unit harness exists for `useAppShell` effects (app-shell tests
cover pure helpers, mobile shell tests cover adapters) — parity is by
construction, verified by typecheck on both shells.

## Gates run

```
pnpm install --frozen-lockfile          ✓
pnpm -C packages/application typecheck  ✓
pnpm -C packages/application test       ✓ (incl. harness/reliability-measure)
pnpm -C packages/ui-shared typecheck    ✓
pnpm -C packages/ui-shared test         ✓ (ui-shared + error-text)
pnpm -C packages/app-shell  typecheck   ✓
pnpm -C packages/app-shell  test        ✓
pnpm -C apps/desktop        typecheck   ✓
pnpm -C apps/desktop        test        ✓
pnpm -C apps/mobile         typecheck   ✓
pnpm -C apps/mobile         test        ✓
pnpm typecheck (all workspaces)         ✓
pnpm -C packages/ui-native  typecheck+test ✓ (touched file)
```

## Diffstat

```
 apps/mobile/App.tsx                                |   4 +
 packages/app-shell/src/app-shell.ts                |   6 +-
 packages/app-shell/src/types.ts                    |   7 +-
 packages/application/src/errors.test.ts            |  34 ++
 packages/application/src/errors.ts                 |  18 ++
 packages/application/src/queue/queue-engine.test.ts |  31 ++
 packages/application/src/queue/queue-engine.ts     |  34 +-
 packages/application/src/retry.ts                  |  10 +-
 packages/application/src/session/playback-engine.ts |  49 ++-
 packages/application/src/session/session.test.ts   | 351 ++++++++++++++++++-
 packages/ui-native/src/ui-native.test.ts           |  21 ++
 packages/ui-shared/src/error-text.test.ts          |  13 +
 packages/ui-shared/src/error-text.ts               |   7 +-
 packages/ui-shared/src/locales/de.ts               |   2 +
 packages/ui-shared/src/locales/en.ts               |   2 +
 packages/ui-shared/src/locales/es.ts               |   2 +
 packages/ui-shared/src/locales/fr.ts               |   2 +
 packages/ui-shared/src/locales/zh.ts               |   1 +
 packages/ui-shared/src/view-models.ts              |  19 +-
 19 files changed, 591 insertions(+), 22 deletions(-)
```

No new dependencies; `exactOptionalPropertyTypes` preserved; no raw
provider text, URLs, tokens, or guest payloads on any user surface,
log, or fixture.
