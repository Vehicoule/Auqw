import { CancellationSource } from './cancellation.ts';
import type { CancellationSignal } from './cancellation.ts';
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
  // burns it all. It still settles, so its verdict stands; the
  // watchdog only beats calls still pending at the deadline.
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

async function invalidOptionsFallBackSafely(): Promise<void> {
  const { clock, source } = rig();
  // A non-finite deadline binds nothing at all — caller misuse is
  // internal, and the call never runs.
  const s = scripted([ok('never')]);
  const nanDeadline = await retryBounded({
    deadlineMs: Number.NaN,
    signal: source.signal,
    clock,
    call: s.call,
  });
  assert(!nanDeadline.ok && nanDeadline.error.kind === 'internal');
  const infDeadline = await retryBounded({
    deadlineMs: Number.POSITIVE_INFINITY,
    signal: source.signal,
    clock,
    call: s.call,
  });
  assert(!infDeadline.ok && infDeadline.error.kind === 'internal');
  assertEqual(s.calls.length, 0, 'a binding check precedes any call');

  // A maxAttempts that cannot bound falls back to the default —
  // NaN would otherwise mean "never reach the cap" forever.
  const s2 = scripted([err(appError('transient', 'a')), ok('b')]);
  const p2 = retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    maxAttempts: Number.NaN,
    call: s2.call,
  });
  await settle();
  clock.advance(1_000);
  const r2 = await p2;
  assert(r2.ok, 'NaN maxAttempts falls back to the default');
  assertEqual(s2.calls.length, 2);

  // A fractional cap floors to an integer bound.
  const s3 = scripted([
    err(appError('transient', 'a')),
    err(appError('transient', 'b')),
    ok('c'),
  ]);
  const p3 = retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    maxAttempts: 2.9,
    call: s3.call,
  });
  await settle();
  clock.advance(1_000);
  const r3 = await p3;
  assert(!r3.ok && r3.error.kind === 'transient');
  assertEqual(s3.calls.length, 2, '2.9 floors to 2 attempts');

  // A negative backoff cannot squeeze the wait to zero — the
  // default still sleeps before the retry.
  const s4 = scripted([err(appError('transient', 'a')), ok('d')]);
  const p4 = retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    baseBackoffMs: -50,
    call: s4.call,
  });
  await settle();
  clock.advance(299);
  await settle();
  assertEqual(s4.calls.length, 1, 'negative backoff still waits');
  clock.advance(1);
  const r4 = await p4;
  assert(r4.ok);
  assertEqual(s4.calls.length, 2);
}

async function nonFiniteRetryAfterStandsVerdict(): Promise<void> {
  const { clock, source } = rig();
  // A wait the budget cannot express is the same as one that
  // outlives it: the provider's verdict stands rather than a retry
  // firing on a garbage floor.
  const s = scripted([
    err(appError('rate-limit', 'slow', Number.NaN)),
    ok('never'),
  ]);
  const result = await retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: s.call,
  });
  assert(!result.ok && result.error.kind === 'rate-limit');
  assertEqual(s.calls.length, 1, 'non-finite hint never retries');

  // A negative hint floors at zero — the backoff still applies.
  const s2 = scripted([
    err(appError('rate-limit', 'neg', -500)),
    ok('b'),
  ]);
  const pending = retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: s2.call,
  });
  await settle();
  clock.advance(1_000);
  const r2 = await pending;
  assert(r2.ok, 'negative hint retries at the normal backoff');
  assertEqual(s2.calls.length, 2);
}

async function cancelledSignalNeverCallsAgain(): Promise<void> {
  const { clock, source } = rig();
  // Pre-cancelled: the loop must not start a single call.
  source.cancel();
  const s0 = scripted([ok('never')]);
  const pre = await retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: s0.call,
  });
  assert(!pre.ok && pre.error.kind === 'cancelled');
  assertEqual(s0.calls.length, 0, 'pre-cancelled never calls');

  // Cancellation landing after the backoff woke — before the next
  // call starts — must not spend another port call either.
  const { clock: clock2, source: source2 } = rig();
  const s = scripted([err(appError('transient', 'blip')), ok('never')]);
  const pending = retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source2.signal,
    clock: clock2,
    call: s.call,
  });
  await settle();
  clock2.advance(400);
  source2.cancel();
  const result = await pending;
  assert(!result.ok && result.error.kind === 'cancelled');
  assertEqual(s.calls.length, 1, 'cancel after wake skips the call');
}

async function hungCallDiesAtDeadline(): Promise<void> {
  const { clock, source } = rig();
  // A port promise that never settles must not pin the loop — the
  // deadline cancels the call's signal and surfaces 'timeout'.
  const signals: CancellationSignal[] = [];
  const pending = retryBounded({
    deadlineMs: DEADLINE_MS,
    signal: source.signal,
    clock,
    call: (signal) => {
      signals.push(signal);
      return new Promise<Result<string>>(() => { });
    },
  });
  await settle();
  assertEqual(signals.length, 1, 'call issued');
  clock.advance(DEADLINE_MS - 1);
  await settle();
  clock.advance(1);
  const result = await pending;
  assert(!result.ok && result.error.kind === 'timeout', 'hung call timed out');
  assert(signals[0]?.cancelled === true, 'deadline cancels the call signal');
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
  await invalidOptionsFallBackSafely();
  await nonFiniteRetryAfterStandsVerdict();
  await cancelledSignalNeverCallsAgain();
  await hungCallDiesAtDeadline();
}
