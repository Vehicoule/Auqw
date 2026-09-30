import { assert, assertEqual } from './testing/assert.ts';
import type { OperationContext } from './cancellation.ts';
import { appError, err, ok } from './errors.ts';
import type { Result } from './errors.ts';
import { createPeaksTracker } from './peaks-tracker.ts';
import type { PeaksTarget } from './peaks-tracker.ts';
import { FakeClock } from './testing/fakes.ts';
import type {
  PeaksPort,
  PeaksRequest,
  WaveformPeak,
} from './ports/peaks.ts';

const PEAKS: readonly WaveformPeak[] = [
  { up: 0.5, down: 0.4 },
  { up: 1, down: 0.9 },
  { up: 0.25, down: 0.2 },
];

function target(id: string, handle = 'h'): PeaksTarget {
  return { id, handle, durationMs: 120_000 };
}

/** Enough microtask turns for a port call (and a resolved clock
 *  sleep) to settle before the next assertion. */
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

type Call = {
  request: PeaksRequest;
  context: OperationContext;
  resolve: (r: Result<readonly WaveformPeak[]>) => void;
};

/**
 * Scripted port: `handler` answers immediately, or `manual` queues
 * calls the test resolves by hand (the superseded-completion case).
 */
function fakePort(
  handler?: (request: PeaksRequest) => Result<readonly WaveformPeak[]>,
): {
  calls: Call[];
  port: PeaksPort;
} {
  const calls: Call[] = [];
  return {
    calls,
    port: {
      peaks(request, context) {
        if (handler !== undefined) {
          calls.push({ request, context, resolve: () => { } });
          return Promise.resolve(handler(request));
        }
        return new Promise<Result<readonly WaveformPeak[]>>((resolve) => {
          calls.push({ request, context, resolve });
        });
      },
    },
  };
}

export async function run(): Promise<void> {
  // A successful pull caches real peaks and notifies once.
  {
    const { port } = fakePort(() => ok(PEAKS));
    let changes = 0;
    const tracker = createPeaksTracker({
      port,
      clock: new FakeClock(),
      onChange: () => changes++,
    });
    tracker.pull(target('r-1'));
    await settle();
    assertEqual(tracker.get('r-1'), PEAKS, 'real peaks cache');
    assertEqual(changes, 1, 'one notification per settle');
    tracker.pull(target('r-1'));
    assertEqual(changes, 1, 'a cache hit pulls nothing new');
  }

  // In-flight dedupe: a second pull for the same recording shares
  // the pending extraction.
  {
    const { calls, port } = fakePort();
    const tracker = createPeaksTracker({ port, clock: new FakeClock() });
    tracker.pull(target('r-2'));
    tracker.pull(target('r-2'));
    assertEqual(calls.length, 1, 'one pull per recording');
  }

  // Terminal failures cache null — revisits never re-pull.
  {
    const { calls, port } = fakePort(() =>
      err(appError('budget-exceeded', 'too big')),
    );
    const tracker = createPeaksTracker({ port, clock: new FakeClock() });
    tracker.pull(target('r-3'));
    await settle();
    assertEqual(tracker.get('r-3'), null, 'terminal failure caches null');
    tracker.pull(target('r-3'));
    assertEqual(calls.length, 1, 'a settled failure never re-pulls');
  }

  // Transient failures retry on a delay and stay uncached — a later
  // pull (e.g. a re-prepared handle) attempts again.
  {
    const clock = new FakeClock();
    const { calls, port } = fakePort(() =>
      err(appError('unavailable', 'not buffered')),
    );
    const tracker = createPeaksTracker({
      port,
      clock,
      retryDelayMs: 10,
      retryLimit: 2,
    });
    tracker.pull(target('r-4'));
    await settle();
    assertEqual(calls.length, 1, 'first attempt');
    clock.advance(10);
    await settle();
    assertEqual(calls.length, 2, 'a transient abort retries once more');
    assertEqual(
      tracker.get('r-4'),
      undefined,
      'transient failures stay uncached',
    );
    tracker.pull(target('r-4'));
    await settle();
    assertEqual(calls.length, 3, 'an uncached target retries on revisit');
  }

  // A cancelled pull never writes — even when the port resolves late
  // (the decode lands after the handle was swapped).
  {
    const { calls, port } = fakePort();
    const tracker = createPeaksTracker({ port, clock: new FakeClock() });
    tracker.pull(target('r-5', 'h1'));
    tracker.cancel('r-5');
    tracker.pull(target('r-5', 'h2'));
    calls[1]?.resolve(ok(PEAKS)); // the replacement lands first
    await settle();
    const stale: readonly WaveformPeak[] = [
      { up: 9, down: 9 },
      { up: 9, down: 9 },
      { up: 9, down: 9 },
    ];
    calls[0]?.resolve(ok(stale)); // the cancelled pull lands late
    await settle();
    assertEqual(
      tracker.get('r-5'),
      PEAKS,
      'a superseded extraction never overwrites the live peaks',
    );
  }

  // A cancelled generation's requestId must never repeat on its
  // replacement: the abandoned extraction can still be unwinding
  // natively, and a colliding id lets its teardown unregister the
  // live one's cancel slot.
  {
    const { calls, port } = fakePort();
    const tracker = createPeaksTracker({ port, clock: new FakeClock() });
    tracker.pull(target('r-ids', 'h1'));
    tracker.cancel('r-ids');
    tracker.pull(target('r-ids', 'h2'));
    assertEqual(calls.length, 2, 'cancel + re-pull spawns a second call');
    assert(
      calls[0]?.context.requestId !== calls[1]?.context.requestId,
      'request ids stay unique across generations',
    );
    assert(
      calls[1]?.context.requestId.includes('r-ids') === true,
      'the id still names its recording for diagnostics',
    );
  }

  // The same uniqueness must hold across tracker instances: a
  // remounted tracker restarting its own sequence would mint an id
  // already held by the previous instance's still-winding-down
  // native job.
  {
    const { calls: callsA, port: portA } = fakePort();
    const trackerA = createPeaksTracker({
      port: portA,
      clock: new FakeClock(),
    });
    const { calls: callsB, port: portB } = fakePort();
    const trackerB = createPeaksTracker({
      port: portB,
      clock: new FakeClock(),
    });
    trackerA.pull(target('r-shared', 'h1'));
    trackerB.pull(target('r-shared', 'h2'));
    assertEqual(callsA.length, 1, 'first tracker pulls');
    assertEqual(callsB.length, 1, 'second tracker pulls');
    assert(
      callsA[0]?.context.requestId !== callsB[0]?.context.requestId,
      'request ids stay unique across tracker instances',
    );
  }

  // LRU eviction follows recency of pull, not insertion.
  {
    const { port } = fakePort(() => ok(PEAKS));
    const tracker = createPeaksTracker({
      port,
      clock: new FakeClock(),
      cacheLimit: 3,
    });
    tracker.pull(target('a'));
    tracker.pull(target('b'));
    tracker.pull(target('c'));
    await settle();
    tracker.pull(target('a')); // refresh a's recency
    tracker.pull(target('d'));
    await settle();
    assertEqual(tracker.get('b'), undefined, 'oldest entry evicts');
    assertEqual(tracker.get('a'), PEAKS, 'a revisited entry survives');
    assertEqual(tracker.get('d'), PEAKS, 'the new entry caches');
  }

  // A budget abort under the provisional unknown-duration cap is not
  // terminal: it settles uncached so the pull a later durationMs
  // triggers gets the full byte budget.
  {
    const { calls, port } = fakePort(() =>
      err(appError('not-applicable', 'stream too large')),
    );
    const clock = new FakeClock();
    const tracker = createPeaksTracker({
      port,
      clock,
      retryDelayMs: 10,
    });
    tracker.pull({ id: 'r-8', handle: 'h', durationMs: null });
    await settle();
    assertEqual(
      tracker.get('r-8'),
      undefined,
      'a provisional-cap abort stays uncached',
    );
    assertEqual(
      clock.pendingSleepers,
      0,
      'no spot-retry on a provisional abort',
    );
    tracker.pull({ id: 'r-8', handle: 'h', durationMs: 120_000 });
    await settle();
    assertEqual(
      calls.length,
      2,
      'a known duration re-extracts under the full cap',
    );
  }

  // A durationMs landing mid-sweep must not cancel+restart the byte
  // pull: the live extraction rides on, and only a provisional-cap
  // bail re-attempts — in place, at the full cap.
  {
    const { calls, port } = fakePort();
    const tracker = createPeaksTracker({ port, clock: new FakeClock() });
    tracker.pull({ id: 'r-8b', handle: 'h', durationMs: null });
    tracker.pull({ id: 'r-8b', handle: 'h', durationMs: 120_000 });
    await settle();
    assertEqual(
      calls.length,
      1,
      'a durationMs update rides the in-flight sweep',
    );
    // Now the bail case: the sweep exhausts the provisional cap after
    // the real duration landed — it re-attempts against it, no user
    // re-trigger needed.
    const { calls: calls2, port: port2 } = fakePort((request) =>
      request.durationMs === null
        ? err(appError('not-applicable', 'stream too large'))
        : ok(PEAKS),
    );
    const tracker2 = createPeaksTracker({
      port: port2,
      clock: new FakeClock(),
    });
    tracker2.pull({ id: 'r-8c', handle: 'h', durationMs: null });
    tracker2.pull({ id: 'r-8c', handle: 'h', durationMs: 120_000 });
    await settle();
    await settle();
    assertEqual(calls2.length, 2, 'a provisional bail retries in place');
    assertEqual(
      calls2[1]?.request.durationMs,
      120_000,
      'the in-place retry runs at the real cap',
    );
    assertEqual(tracker2.get('r-8c'), PEAKS);
  }

  // A durationMs update past the port's decode bound cancels the
  // sweep outright — a successful result for a now-known long track
  // must not cache.
  {
    const { calls, port } = fakePort();
    const tracker = createPeaksTracker({
      port,
      clock: new FakeClock(),
      maxDurationMs: 1000,
    });
    tracker.pull({ id: 'r-8d', handle: 'h', durationMs: null });
    tracker.pull({ id: 'r-8d', handle: 'h', durationMs: 2000 });
    calls[0]?.resolve(ok(PEAKS));
    await settle();
    assertEqual(
      calls.length,
      1,
      'the over-cap update kills the sweep without re-pulling',
    );
    assertEqual(
      tracker.get('r-8d'),
      undefined,
      'a cancelled-over-cap sweep caches nothing',
    );
  }

  // The same cancel applies when a *known* duration grows past the
  // cap mid-sweep — a new request at that duration would be refused,
  // so the in-flight one dies rather than decoding oversized audio.
  {
    const { calls, port } = fakePort();
    const tracker = createPeaksTracker({
      port,
      clock: new FakeClock(),
      maxDurationMs: 1000,
    });
    tracker.pull({ id: 'r-8f', handle: 'h', durationMs: 500 });
    tracker.pull({ id: 'r-8f', handle: 'h', durationMs: 2000 });
    calls[0]?.resolve(ok(PEAKS));
    await settle();
    assertEqual(calls.length, 1, 'a duration crossing the cap cancels');
    assertEqual(tracker.get('r-8f'), undefined);
  }

  // But a pull that STARTED over the cap is not an "update" — the
  // duplicate (the hook fires pull twice on mount) must leave the
  // in-flight request to settle its terminal failure, so revisits
  // hit the cached null instead of re-pulling forever.
  {
    const { calls, port } = fakePort(() =>
      err(appError('budget-exceeded', 'track too long')),
    );
    const tracker = createPeaksTracker({
      port,
      clock: new FakeClock(),
      maxDurationMs: 1000,
    });
    tracker.pull({ id: 'r-8e', handle: 'h', durationMs: 2000 });
    tracker.pull({ id: 'r-8e', handle: 'h', durationMs: 2000 });
    await settle();
    assertEqual(calls.length, 1, 'the duplicate pull dedupes');
    assertEqual(
      tracker.get('r-8e'),
      null,
      'the terminal failure still caches',
    );
    tracker.pull({ id: 'r-8e', handle: 'h', durationMs: 2000 });
    assertEqual(calls.length, 1, 'a revisit never re-pulls');
  }

  // A real budget-exceeded while durationMs is unknown (the decoded
  // PCM ceiling) is still terminal — the duration landing later must
  // not re-decode the same oversized audio.
  {
    const { calls, port } = fakePort(() =>
      err(appError('budget-exceeded', 'decoded audio too large')),
    );
    const tracker = createPeaksTracker({ port, clock: new FakeClock() });
    tracker.pull({ id: 'r-9', handle: 'h', durationMs: null });
    await settle();
    assertEqual(tracker.get('r-9'), null, 'the PCM ceiling stays terminal');
    tracker.pull({ id: 'r-9', handle: 'h', durationMs: 120_000 });
    assertEqual(calls.length, 1, 'a terminal bail never re-decodes');
  }

  // A re-prepared stream is a new cache identity — the same recording
  // under a new attempt pulls fresh instead of inheriting the old
  // stream's peaks or failure.
  {
    const { calls, port } = fakePort(() =>
      err(appError('invalid-response', 'not audio')),
    );
    const tracker = createPeaksTracker({ port, clock: new FakeClock() });
    tracker.pull(target('r-7|a1', 'h1'));
    await settle();
    assertEqual(
      tracker.get('r-7|a1'),
      null,
      'first attempt cached its failure',
    );
    tracker.pull(target('r-7|a2', 'h2'));
    assertEqual(calls.length, 2, 'a new attempt pulls its own stream');
  }

  // Cancellation mid-retry clears the scheduled attempt.
  {
    const clock = new FakeClock();
    const { calls, port } = fakePort(() =>
      err(appError('unavailable', 'not buffered')),
    );
    const tracker = createPeaksTracker({
      port,
      clock,
      retryDelayMs: 10,
      retryLimit: 3,
    });
    tracker.pull(target('r-6'));
    await settle();
    assertEqual(
      clock.pendingSleepers,
      1,
      'the retry sleep is parked on the clock',
    );
    tracker.cancel('r-6');
    await settle();
    assertEqual(clock.pendingSleepers, 0, 'cancel unwinds the sleep');
    clock.advance(10_000);
    await settle();
    assertEqual(calls.length, 1, 'a cancelled retry never fires');
  }

  // A settled profile is content-keyed: a later attempt for the same
  // recording (re-prepare, warm adopt) inherits it with zero pulls.
  {
    const { calls, port } = fakePort(() => ok(PEAKS));
    const tracker = createPeaksTracker({ port, clock: new FakeClock() });
    tracker.pull(target('r-8|a1', 'h1'));
    await settle();
    assertEqual(calls.length, 1, 'first attempt extracts');
    tracker.pull(target('r-8|a2', 'h2'));
    await settle();
    assertEqual(
      calls.length,
      1,
      'the same recording never re-extracts across attempts',
    );
    assertEqual(
      tracker.get('r-8|a2'),
      PEAKS,
      'the new attempt reads the content-keyed profile',
    );
  }

  // A persisted store hit skips extraction entirely.
  {
    const { calls, port } = fakePort(() => ok(PEAKS));
    const stored: readonly WaveformPeak[] = [{ up: 0.9, down: 0.8 }];
    const tracker = createPeaksTracker({
      port,
      clock: new FakeClock(),
      store: {
        load: (id) =>
          Promise.resolve(id === 'r-9' ? stored : null),
        save: () => Promise.resolve(),
      },
    });
    tracker.pull(target('r-9|a1'));
    await settle();
    assertEqual(
      calls.length,
      0,
      'a persisted profile never pays an extraction',
    );
    assertEqual(tracker.get('r-9|a1'), stored, 'the stored row serves');
  }

  // A coarse profile lands under the content key mid-flight; the
  // final result supersedes it in place.
  {
    const coarse: readonly WaveformPeak[] = [{ up: 0.3, down: 0.2 }];
    const { calls, port } = fakePort();
    let changes = 0;
    const tracker = createPeaksTracker({
      port,
      clock: new FakeClock(),
      onChange: () => changes++,
    });
    tracker.pull(target('r-10|a1'));
    await settle();
    assertEqual(calls.length, 1, 'extraction in flight');
    calls[0]!.request.onCoarse?.(coarse);
    assertEqual(
      tracker.get('r-10|a1'),
      coarse,
      'coarse bars render before the refined result',
    );
    calls[0]!.resolve(ok(PEAKS));
    await settle();
    assertEqual(
      tracker.get('r-10|a1'),
      PEAKS,
      'the refined profile replaces coarse in place',
    );
    assertEqual(changes, 2, 'coarse then final — one notify each');
  }

  // A settled failure stays attempt-scoped: the next attempt for the
  // same recording pulls instead of inheriting the null.
  {
    const { calls, port } = fakePort(() =>
      err(appError('budget-exceeded', 'too big')),
    );
    const tracker = createPeaksTracker({ port, clock: new FakeClock() });
    tracker.pull(target('r-11|a1', 'h1'));
    await settle();
    assertEqual(
      tracker.get('r-11|a1'),
      null,
      'the failure sentinel caches under the attempt',
    );
    tracker.pull(target('r-11|a2', 'h2'));
    await settle();
    assertEqual(
      calls.length,
      2,
      'a fresh attempt re-earns the sweep',
    );
  }

  // A coarse-only entry renders but never counts as done: cancel the
  // flight mid-coarse and the next pull re-extracts; only a finished
  // profile skips work.
  {
    const coarse: readonly WaveformPeak[] = [{ up: 0.2, down: 0.1 }];
    const { calls, port } = fakePort();
    const tracker = createPeaksTracker({ port, clock: new FakeClock() });
    tracker.pull(target('r-12|a1', 'h1'));
    await settle();
    calls[0]!.request.onCoarse?.(coarse);
    tracker.cancel('r-12|a1');
    // The stale completion belongs to the cancelled generation.
    calls[0]!.resolve(ok(PEAKS));
    await settle();
    assertEqual(
      tracker.get('r-12|a2'),
      coarse,
      'the partial profile still renders',
    );
    tracker.pull(target('r-12|a2', 'h2'));
    await settle();
    assertEqual(
      calls.length,
      2,
      'a coarse-only cache never skips refinement',
    );
    calls[1]!.resolve(ok(PEAKS));
    await settle();
    assertEqual(
      tracker.get('r-12|a2'),
      PEAKS,
      'the finished result lands under the same key',
    );
    tracker.pull(target('r-12|a3', 'h3'));
    await settle();
    assertEqual(calls.length, 2, 'a finished profile does skip work');
  }

  // A deduped pull is owed its sweep: when the covering extraction is
  // cancelled mid-flight, the waiting target promotes into its own.
  {
    const { calls, port } = fakePort();
    const tracker = createPeaksTracker({ port, clock: new FakeClock() });
    tracker.pull(target('r-13|a1', 'h1'));
    await settle();
    tracker.pull(target('r-13|a2', 'h2'));
    await settle();
    assertEqual(calls.length, 1, 'the second pull dedupes onto the sweep');
    tracker.cancel('r-13|a1');
    await settle();
    assertEqual(
      calls.length,
      2,
      'the waiting attempt promotes its own extraction',
    );
    assertEqual(
      calls[1]!.request.handle,
      'h2',
      "the promoted sweep runs the waiter's handle",
    );
    calls[1]!.resolve(ok(PEAKS));
    await settle();
    assertEqual(tracker.get('r-13|a2'), PEAKS, 'the waiter lands its bars');
  }

  // A waiting pull cancelled before promotion stays dead — the
  // covering sweep's later death revives nothing.
  {
    const { calls, port } = fakePort();
    const tracker = createPeaksTracker({ port, clock: new FakeClock() });
    tracker.pull(target('r-14|a1', 'h1'));
    await settle();
    tracker.pull(target('r-14|a2', 'h2'));
    await settle();
    tracker.cancel('r-14|a2');
    tracker.cancel('r-14|a1');
    await settle();
    assertEqual(calls.length, 1, 'a cancelled waiter never promotes');
  }
}
