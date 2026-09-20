import { openDatabaseAsync } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { CancellationSignal } from '@auqw/application';
import type {
  SqliteConnection,
  SqliteDriver,
  SqlRow,
} from '@auqw/storage-sqlite';
// The cancellation sentinel is package-internal: SqliteStorage's
// #mapError classifies thrown === CANCELLED as a typed `cancelled`.
import { CANCELLED } from '../../../../packages/storage-sqlite/src/cancelled.ts';

function checkCancelled(signal: CancellationSignal | undefined): void {
  if (signal?.cancelled === true) {
    throw CANCELLED;
  }
}

function checkRow(row: Record<string, unknown>): void {
  for (const value of Object.values(row)) {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number'
    ) {
      // bigint/blob/undefined have no SqlValue representation; the
      // throw crosses to SqliteStorage.#mapError as `transient`.
      throw new Error('unsupported sqlite column type');
    }
  }
}

/**
 * SqliteDriver over `expo-sqlite`.
 *
 * The transaction boundary is a manual `BEGIN IMMEDIATE` / `COMMIT` /
 * `ROLLBACK` on the driver's own connection — not
 * `withExclusiveTransactionAsync`: that helper runs its `txn` on a
 * *new* native connection and issues BEGIN before the task body, so
 * `PRAGMA foreign_keys` can never reach it (the pragma is a no-op
 * inside a transaction, and per-connection). The driver contract
 * requires FK enforcement to come from the driver's connection-level
 * setting, so every transaction re-asserts the pragma *before* BEGIN
 * on the same connection that runs the statements. Exclusivity is
 * still real: BEGIN IMMEDIATE takes the write lock immediately and
 * this connection is never shared.
 */
export async function createExpoSqliteDriver(
  path = 'auqw.db',
): Promise<SqliteDriver> {
  const db: SQLiteDatabase = await openDatabaseAsync(path);
  // Connection-scoped; must be set outside any transaction to apply.
  await db.execAsync('PRAGMA foreign_keys = ON');

  return {
    async transaction<T>(
      work: (connection: SqliteConnection) => Promise<T>,
      signal?: CancellationSignal,
    ): Promise<T> {
      checkCancelled(signal);
      // Re-asserted per transaction before BEGIN (same discipline as
      // the bundled NodeSqliteDriver): a no-op pragma is cheap, a
      // silently unenforced FK is not.
      await db.execAsync('PRAGMA foreign_keys = ON');
      checkCancelled(signal);
      const connection: SqliteConnection = {
        async execute(sql, params = [], statementSignal) {
          checkCancelled(statementSignal ?? signal);
          const result = await db.runAsync(sql, [...params]);
          return {
            changes: result.changes,
            lastInsertRowId: result.lastInsertRowId,
          };
        },
        async query<T extends SqlRow>(
          sql: string,
          params = [],
          statementSignal?: CancellationSignal,
        ): Promise<readonly T[]> {
          checkCancelled(statementSignal ?? signal);
          const rows = await db.getAllAsync<T>(sql, [...params]);
          for (const row of rows) {
            checkRow(row);
          }
          return rows;
        },
      };
      await db.execAsync('BEGIN IMMEDIATE');
      try {
        const value = await work(connection);
        checkCancelled(signal);
        await db.execAsync('COMMIT');
        return value;
      } catch (thrown) {
        try {
          await db.execAsync('ROLLBACK');
        } catch {
          // The transaction already ended.
        }
        throw thrown;
      }
    },
  };
}
