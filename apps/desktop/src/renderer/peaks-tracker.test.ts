import { assert, assertEqual } from '@auqw/application/testing';
import { appError, err, ok } from '@auqw/application';
import type { PeaksPort, PeaksRequest, Result } from '@auqw/application';
import { createPeaksTracker } from './peaks-tracker.ts';
import type { PeaksTarget } from './peaks-tracker.ts';

const PEAKS: readonly number[] = [0.5, 1, 0.25];

function target(id: string, handle = 'h'): PeaksTarget {
  return { id, handle, durationMs: 120_000 };
}

/** Flush pending promise chains without a real timer. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type Call = { request: PeaksRequest; resolve: (r: Result<readonly number[]>) => void };

/**
 * Scripted port: `handler` answers immediately, or `manual` queues
 * calls the test resolves by hand (the superseded-completion case).
 */
function fakePort(handler?: (request: PeaksRequest) => Result<readonly number[]>): {
  calls: Call[];
  port: PeaksPort;
} {
  const calls: Call[] = [];
  return {
    calls,
    port: {
      peaks(request) {
        if (handler !== undefined) {
          calls.push({ request, resolve: () => {} });
          return Promise.resolve(handler(request));
        }
        return new Promise<Result<readonly number[]>>((resolve) => {
          calls.push({ request, resolve });
        });
      },
    },
  };
}

/** Manually-driven timers — retries are deterministic. */
function fakeTimers(): {
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  fire(): void;
} {
  const pending: { cb: () => void; cleared: boolean }[] = [];
  return {
    setTimeoutFn: ((cb: () => void) => {
      const timer = { cb, cleared: false };
      pending.push(timer);
      return timer;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((timer: { cleared: boolean }) => {
      timer.cleared = true;
    }) as unknown as typeof clearTimeout,
    fire() {
      for (const timer of pending.splice(0)) {
        if (!timer.cleared) {
          timer.cb();
        }
      }
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
      onChange: () => changes++,
    });
    tracker.pull(target('r-1'));
    await flush();
    assertEqual(tracker.get('r-1'), PEAKS, 'real peaks cache');
    assertEqual(changes, 1, 'one notification per settle');
    tracker.pull(target('r-1'));
    assertEqual(changes, 1, 'a cache hit pulls nothing new');
  }

  // In-flight dedupe: a second pull for the same recording shares
  // the pending extraction.
  {
    const { calls, port } = fakePort();
    const tracker = createPeaksTracker({ port });
    tracker.pull(target('r-2'));
    tracker.pull(target('r-2'));
    assertEqual(calls.length, 1, 'one pull per recording');
  }

  // Terminal failures cache null — revisits never re-pull.
  {
    const { calls, port } = fakePort(() =>
      err(appError('budget-exceeded', 'too big')),
    );
    const tracker = createPeaksTracker({ port });
    tracker.pull(target('r-3'));
    await flush();
    assertEqual(tracker.get('r-3'), null, 'terminal failure caches null');
    tracker.pull(target('r-3'));
    assertEqual(calls.length, 1, 'a settled failure never re-pulls');
  }

  // Transient failures retry on a delay and stay uncached — a later
  // pull (e.g. a re-prepared handle) attempts again.
  {
    const timers = fakeTimers();
    const { calls, port } = fakePort(() =>
      err(appError('unavailable', 'not buffered')),
    );
    const tracker = createPeaksTracker({
      port,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      retryDelayMs: 10,
      retryLimit: 2,
    });
    tracker.pull(target('r-4'));
    await flush();
    assertEqual(calls.length, 1, 'first attempt');
    timers.fire();
    await flush();
    assertEqual(calls.length, 2, 'a transient abort retries once more');
    assertEqual(tracker.get('r-4'), undefined, 'transient failures stay uncached');
    tracker.pull(target('r-4'));
    await flush();
    assertEqual(calls.length, 3, 'an uncached target retries on revisit');
  }

  // A cancelled pull never writes — even when the port resolves late
  // (the decode lands after the handle was swapped).
  {
    const { calls, port } = fakePort();
    const tracker = createPeaksTracker({ port });
    tracker.pull(target('r-5', 'h1'));
    tracker.cancel('r-5');
    tracker.pull(target('r-5', 'h2'));
    calls[1]?.resolve(ok(PEAKS)); // the replacement lands first
    await flush();
    const stale: readonly number[] = [9, 9, 9];
    calls[0]?.resolve(ok(stale)); // the cancelled pull lands late
    await flush();
    assertEqual(
      tracker.get('r-5'),
      PEAKS,
      'a superseded extraction never overwrites the live peaks',
    );
  }

  // LRU eviction follows recency of pull, not insertion.
  {
    const { port } = fakePort(() => ok(PEAKS));
    const tracker = createPeaksTracker({ port, cacheLimit: 3 });
    tracker.pull(target('a'));
    tracker.pull(target('b'));
    tracker.pull(target('c'));
    await flush();
    tracker.pull(target('a')); // refresh a's recency
    tracker.pull(target('d'));
    await flush();
    assertEqual(tracker.get('b'), undefined, 'oldest entry evicts');
    assertEqual(tracker.get('a'), PEAKS, 'a revisited entry survives');
    assertEqual(tracker.get('d'), PEAKS, 'the new entry caches');
  }

  // A budget abort under the provisional unknown-duration cap is not
  // terminal: it settles uncached so the pull a later durationMs
  // triggers gets the full byte budget.
  {
    const timers = fakeTimers();
    const { calls, port } = fakePort(() =>
      err(appError('not-applicable', 'stream too large')),
    );
    const tracker = createPeaksTracker({
      port,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      retryDelayMs: 10,
    });
    tracker.pull({ id: 'r-8', handle: 'h', durationMs: null });
    await flush();
    assertEqual(
      tracker.get('r-8'),
      undefined,
      'a provisional-cap abort stays uncached',
    );
    timers.fire();
    await flush();
    assertEqual(calls.length, 1, 'no spot-retry on a provisional abort');
    tracker.pull({ id: 'r-8', handle: 'h', durationMs: 120_000 });
    await flush();
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
    const tracker = createPeaksTracker({ port });
    tracker.pull({ id: 'r-8b', handle: 'h', durationMs: null });
    tracker.pull({ id: 'r-8b', handle: 'h', durationMs: 120_000 });
    await flush();
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
    const tracker2 = createPeaksTracker({ port: port2 });
    tracker2.pull({ id: 'r-8c', handle: 'h', durationMs: null });
    tracker2.pull({ id: 'r-8c', handle: 'h', durationMs: 120_000 });
    await flush();
    await flush();
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
    const tracker = createPeaksTracker({ port, maxDurationMs: 1000 });
    tracker.pull({ id: 'r-8d', handle: 'h', durationMs: null });
    tracker.pull({ id: 'r-8d', handle: 'h', durationMs: 2000 });
    calls[0]?.resolve(ok(PEAKS));
    await flush();
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
    const tracker = createPeaksTracker({ port, maxDurationMs: 1000 });
    tracker.pull({ id: 'r-8f', handle: 'h', durationMs: 500 });
    tracker.pull({ id: 'r-8f', handle: 'h', durationMs: 2000 });
    calls[0]?.resolve(ok(PEAKS));
    await flush();
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
    const tracker = createPeaksTracker({ port, maxDurationMs: 1000 });
    tracker.pull({ id: 'r-8e', handle: 'h', durationMs: 2000 });
    tracker.pull({ id: 'r-8e', handle: 'h', durationMs: 2000 });
    await flush();
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
    const tracker = createPeaksTracker({ port });
    tracker.pull({ id: 'r-9', handle: 'h', durationMs: null });
    await flush();
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
    const tracker = createPeaksTracker({ port });
    tracker.pull(target('r-7|a1', 'h1'));
    await flush();
    assertEqual(tracker.get('r-7|a1'), null, 'first attempt cached its failure');
    tracker.pull(target('r-7|a2', 'h2'));
    assertEqual(calls.length, 2, 'a new attempt pulls its own stream');
  }

  // Cancellation mid-retry clears the scheduled attempt.
  {
    const timers = fakeTimers();
    const { calls, port } = fakePort(() =>
      err(appError('unavailable', 'not buffered')),
    );
    const tracker = createPeaksTracker({
      port,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      retryDelayMs: 10,
      retryLimit: 3,
    });
    tracker.pull(target('r-6'));
    await flush();
    tracker.cancel('r-6');
    timers.fire();
    await flush();
    assertEqual(calls.length, 1, 'a cancelled retry never fires');
  }
}
