import type { CancellationSignal } from '@auqw/application';
import type { SqliteConnection, SqliteDriver } from './driver.ts';

/**
 * Transaction tails keyed by driver: one driver is one connection, so
 * transactions serialize per driver even when several stores share it
 * (SqliteStorage plus SqliteSyncLogStore over the same database file).
 */
const TRANSACTION_TAILS = new WeakMap<
  SqliteDriver,
  { tail: Promise<void> }
>();

/**
 * One connection cannot run overlapping BEGIN/COMMIT sequences. The
 * tail is keyed on the driver, not the caller: every store over one
 * driver queues on the same tail, so a sync-log append can never
 * interleave a domain commit.
 */
export function enqueueDriverTransaction<T>(
  driver: SqliteDriver,
  work: (connection: SqliteConnection) => Promise<T>,
  signal: CancellationSignal,
  check: (signal: CancellationSignal) => void,
): Promise<T> {
  let slot = TRANSACTION_TAILS.get(driver);
  if (slot === undefined) {
    slot = { tail: Promise.resolve() };
    TRANSACTION_TAILS.set(driver, slot);
  }
  const result = slot.tail.then(() => {
    check(signal);
    return driver.transaction(work, signal);
  });
  slot.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
