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
  return Promise.race([
    call.then(
      (value) => ({ t: 'value' as const, value }),
      (thrown: unknown) => ({ t: 'failed' as const, thrown }),
    ),
    new Promise<Raced<T>>((resolve) => {
      if (signal.cancelled) {
        resolve({ t: 'cancelled' });
        return;
      }
      const unsubscribe = signal.subscribe(() => {
        unsubscribe();
        resolve({ t: 'cancelled' });
      });
    }),
  ]);
}
