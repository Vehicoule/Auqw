import type { CancellationSignal } from '@auqw/application';
import type { SearchHistoryStore } from '@auqw/application';
import { SEARCH_HISTORY_LIMIT } from '@auqw/application';
import { CANCELLED } from './driver.ts';
import type { SqliteDriver } from './driver.ts';
import { enqueueDriverTransaction } from './transaction-queue.ts';

// The port carries no OperationContext: recents are a session-long
// convenience list, not a cancellable operation. The queue still
// needs a signal — one that can never flip.
const NEVER_CANCELLED: CancellationSignal = {
  cancelled: false,
  subscribe: () => () => undefined,
};

function checkSignal(signal: CancellationSignal): void {
  if (signal.cancelled) {
    throw CANCELLED;
  }
}

/**
 * `SearchHistoryStore` over the shared sqlite database: the
 * `search_history` table (schema v12) is device-local by
 * construction — it is not a `PersistedState` section, so
 * export/import and sync never see it. Failures degrade to
 * empty/no-op: recents are a convenience list — a dropped write or
 * a schema-pending database just shows fewer rows.
 */
export function createSearchHistoryStore(
  driver: SqliteDriver,
  now: () => number = () => Date.now(),
): SearchHistoryStore {
  return {
    async load() {
      try {
        // enqueueDriverTransaction, not a bare driver.transaction:
        // the driver is shared with SqliteStorage/sync-log on the
        // same connection, so an unqueued BEGIN IMMEDIATE collides
        // with any open transaction and the write would be dropped.
        const rows = await enqueueDriverTransaction(
          driver,
          (conn) =>
            conn.query<{ query: string }>(
              `SELECT query FROM search_history
               ORDER BY rowid DESC LIMIT ?`,
              [SEARCH_HISTORY_LIMIT],
            ),
          NEVER_CANCELLED,
          checkSignal,
        );
        return rows.map((row) => row['query']);
      } catch {
        return [];
      }
    },
    async record(query) {
      const trimmed = query.trim();
      if (trimmed === '') {
        return;
      }
      try {
        await enqueueDriverTransaction(
          driver,
          async (conn) => {
            // REPLACE deletes then re-inserts on a PK conflict, so a
            // re-search takes a fresh rowid — rowid order IS the MRU
            // order, immune to the same-millisecond ties a pure
            // searched_ms ordering would leave unordered.
            await conn.execute(
              `INSERT OR REPLACE INTO search_history (query, searched_ms)
               VALUES (?, ?)`,
              [trimmed, now()],
            );
            await conn.execute(
              `DELETE FROM search_history WHERE query NOT IN (
                 SELECT query FROM search_history
                 ORDER BY rowid DESC LIMIT ?)`,
              [SEARCH_HISTORY_LIMIT],
            );
          },
          NEVER_CANCELLED,
          checkSignal,
        );
      } catch {
        // Convenience list — a dropped write only costs a recents row.
      }
    },
  };
}
