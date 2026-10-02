import type { CancellationSignal } from './cancellation.ts';

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
    if (signal.cancelled) {
      resolve({ t: 'cancelled' });
      return;
    }
    // Assigned after subscribe() returns: a signal whose listener
    // fires synchronously inside subscribe (an already-cancelled
    // implementation) must not read the binding in its TDZ.
    let unsubscribe: () => void = () => { };
    unsubscribe = signal.subscribe(() => {
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
    void call.then(
      (value) => settle({ t: 'value', value }),
      (thrown: unknown) => settle({ t: 'failed', thrown }),
    );
  });
}
