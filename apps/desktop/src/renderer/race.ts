import type { CancellationSignal } from '@auqw/application';

/**
 * First-settle-wins race: a port call vs the caller's signal. The
 * losing promise still settles in the background — the caller decides
 * whether a late resolution needs reaping (a minted sink is aborted)
 * or is simply dropped (read-only ops mint nothing).
 *
 * Use when an IPC call can park — a `begin` queued behind the sink
 * cap, a long directory enumeration — so a cancel isn't forced to
 * out-wait the utility's own queue.
 */
export type Raced<T> =
  | { readonly t: 'value'; readonly value: T }
  | { readonly t: 'failed'; readonly thrown: unknown }
  | { readonly t: 'cancelled' };

export function raced<T>(
  call: Promise<T>,
  signal: CancellationSignal,
): Promise<Raced<T>> {
  return new Promise<Raced<T>>((resolve) => {
    const unsubscribe = signal.subscribe(() => {
      unsubscribe();
      resolve({ t: 'cancelled' });
    });
    // The loser unsubscribes: a signal reused across many calls never
    // retains one listener per completed op (a plain Promise.race
    // leaves the losing subscription parked forever).
    const settle = (outcome: Raced<T>): void => {
      unsubscribe();
      resolve(outcome);
    };
    if (signal.cancelled) {
      settle({ t: 'cancelled' });
      return;
    }
    void call.then(
      (value) => settle({ t: 'value', value }),
      (thrown: unknown) => settle({ t: 'failed', thrown }),
    );
  });
}
