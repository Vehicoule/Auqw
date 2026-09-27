import { assert, assertEqual } from '@auqw/application/testing';
import { appError, err, ok } from '@auqw/application';
import type { PeaksPort, PeaksRequest, Result } from '@auqw/application';
import { createPeaksTracker } from './peaks-tracker.ts';
import type { PeaksTarget } from './peaks-tracker.ts';

const PEAKS: readonly number[] = [0.5, 1, 0.25];

function target(recordingId: string, handle = 'h'): PeaksTarget {
  return { recordingId, handle, durationMs: 120_000 };
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
