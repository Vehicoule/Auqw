import { CancellationSource } from './cancellation.ts';
import { appError, err, ok } from './errors.ts';
import type { Result } from './errors.ts';
import { retryBounded } from './retry.ts';
import { FakeClock } from './testing/fakes.ts';
import { assert, assertEqual } from './testing/assert.ts';

const DEADLINE_MS = 10_000;

/** Enough microtask turns for a call to settle AND the backoff
 *  sleeper to register before the clock advances past it. */
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function rig(now = 0): { clock: FakeClock; source: CancellationSource } {
  return { clock: new FakeClock(now), source: new CancellationSource() };
}

/** Scripted per-attempt results; records every attempt's index. */
function scripted(
  outcomes: readonly Result<string>[],
): { calls: number[]; call: () => Promise<Result<string>> } {
  const calls: number[] = [];
  let index = 0;
  return {
    calls,
    call: () => {
      calls.push(index + 1);
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return Promise.resolve(
        outcome ?? err(appError('internal', 'unscripted')),
      );
    },
  };
}

async function succeedsFirstTry(): Promise<void> {
  const { clock, source } = rig();
  const s = scripted([ok('a')]);
  const result = await retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: s.call,
  });
  assert(result.ok && result.value === 'a', 'first success returns');
  assertEqual(s.calls.length, 1, 'one call');
}

async function transientThenSuccess(): Promise<void> {
  const { clock, source } = rig();
  const s = scripted([
    err(appError('transient', 'blip')),
    ok('b'),
  ]);
  const pending = retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: s.call,
  });
  // The backoff sleeps on the fake clock — advance past it.
  await settle();
  clock.advance(1_000);
  const result = await pending;
  assert(result.ok && result.value === 'b', 'retry recovered');
  assertEqual(s.calls.length, 2, 'two calls');
}

async function permanentFailsOnce(): Promise<void> {
  const { clock, source } = rig();
  const s = scripted([err(appError('no-result', 'absent')), ok('never')]);
  const result = await retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: s.call,
  });
  assert(!result.ok && result.error.kind === 'no-result');
  assertEqual(s.calls.length, 1, 'no retry on permanent');
}

async function cancelledCallNotRetried(): Promise<void> {
  const { clock, source } = rig();
  const s = scripted([err(appError('cancelled', 'cancelled')), ok('never')]);
  const result = await retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: s.call,
  });
  assert(!result.ok && result.error.kind === 'cancelled');
  assertEqual(s.calls.length, 1, 'cancelled never retries');
}

async function retryAfterHonored(): Promise<void> {
  const { clock, source } = rig();
  const s = scripted([
    err(appError('rate-limit', 'slow down', 2_000)),
    ok('c'),
  ]);
  const pending = retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: s.call,
  });
  await settle();
  // 300 ms base < 2 s asked — the retry must wait the server's 2 s.
  clock.advance(500);
  await settle();
  assertEqual(s.calls.length, 1, 'retryAfterMs delays the retry');
  clock.advance(1_600);
  const result = await pending;
  assert(result.ok && result.value === 'c');
  assertEqual(s.calls.length, 2);
}

async function retryAfterPastDeadlineFailsFast(): Promise<void> {
  const { clock, source } = rig();
  const s = scripted([
    err(appError('rate-limit', 'slow down', 60_000)),
    ok('never'),
  ]);
  const result = await retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: s.call,
  });
  assert(
    !result.ok && result.error.kind === 'rate-limit',
    'a wait past the deadline surfaces the verdict, not a timeout',
  );
  assertEqual(s.calls.length, 1, 'no doomed retry');
}

async function deadDeadlineOnEntry(): Promise<void> {
  const { clock, source } = rig(20_000);
  const s = scripted([ok('never')]);
  const result = await retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: s.call,
  });
  assert(!result.ok && result.error.kind === 'timeout');
  assertEqual(s.calls.length, 0, 'call never runs on a dead deadline');
}

async function cancelDuringBackoff(): Promise<void> {
  const { clock, source } = rig();
  const s = scripted([err(appError('transient', 'blip')), ok('never')]);
  const pending = retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: s.call,
  });
  await settle();
  source.cancel();
  const result = await pending;
  assert(!result.ok && result.error.kind === 'cancelled');
  assertEqual(s.calls.length, 1, 'cancelled backoff abandons retry');
}

async function backoffDoubles(): Promise<void> {
  const { clock, source } = rig();
  const s = scripted([
    err(appError('transient', 'a')),
    err(appError('transient', 'b')),
    ok('c'),
  ]);
  const pending = retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    maxAttempts: 3,
    baseBackoffMs: 200,
    call: s.call,
  });
  await settle();
  clock.advance(200);
  await settle();
  assertEqual(s.calls.length, 2, 'second attempt after base backoff');
  clock.advance(200);
  await settle();
  assertEqual(s.calls.length, 2, 'doubled backoff still pending');
  clock.advance(200);
  const result = await pending;
  assert(result.ok && result.value === 'c');
  assertEqual(s.calls.length, 3);
}

async function maxAttemptsCapsRetries(): Promise<void> {
  const { clock, source } = rig();
  const s = scripted([err(appError('transient', 'a')), ok('never')]);
  const result = await retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    maxAttempts: 1,
    call: s.call,
  });
  assert(!result.ok && result.error.kind === 'transient');
  assertEqual(s.calls.length, 1, 'maxAttempts=1 never retries');
}

async function attemptNumberPassed(): Promise<void> {
  const { clock, source } = rig();
  const attempts: number[] = [];
  const pending = retryBounded<string>({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: (_signal, attempt) => {
      attempts.push(attempt);
      return Promise.resolve(
        attempt < 2
          ? err(appError('timeout', 'slow'))
          : ok('done'),
      );
    },
  });
  await settle();
  clock.advance(1_000);
  const result = await pending;
  assert(result.ok);
  assertEqual(attempts.join(','), '1,2', 'attempt numbers are 1-based');
}

async function timeoutVerdictAfterBudgetBurn(): Promise<void> {
  const { clock, source } = rig();
  // First call burns almost the whole deadline before failing.
  const call = async (): Promise<Result<string>> => {
    clock.advance(9_500);
    return err(appError('transient', 'slow fail'));
  };
  const pending = retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call,
  });
  await settle();
  // 300 ms of backoff fits the 500 ms remaining — the second call
  // burns it all and the last verdict stands.
  clock.advance(400);
  const result = await pending;
  assert(
    !result.ok && result.error.kind === 'transient',
    'the failing attempt\'s verdict stands when budget is spent',
  );
}

async function brokenClockIsInternal(): Promise<void> {
  const { source } = rig();
  const brokenClock = {
    nowMs(): number {
      throw new Error('dead clock');
    },
    sleep: () => Promise.resolve(ok(undefined)),
  };
  const result = await retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock: brokenClock,
    call: () => Promise.resolve(ok('never')),
  });
  assert(!result.ok && result.error.kind === 'internal');
}

export async function run(): Promise<void> {
  await succeedsFirstTry();
  await transientThenSuccess();
  await permanentFailsOnce();
  await cancelledCallNotRetried();
  await retryAfterHonored();
  await retryAfterPastDeadlineFailsFast();
  await deadDeadlineOnEntry();
  await cancelDuringBackoff();
  await backoffDoubles();
  await maxAttemptsCapsRetries();
  await attemptNumberPassed();
  await timeoutVerdictAfterBudgetBurn();
  await brokenClockIsInternal();
}
