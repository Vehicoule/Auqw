import type { CancellationSignal } from '@auqw/application';

export type SqlValue = string | number | null;
export type SqlParams = readonly SqlValue[];
export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface SqliteConnection {
  execute(
    sql: string,
    params?: SqlParams,
    signal?: CancellationSignal,
  ): Promise<{ changes: number; lastInsertRowId: number | null }>;
  query<T extends SqlRow>(
    sql: string,
    params?: SqlParams,
    signal?: CancellationSignal,
  ): Promise<readonly T[]>;
}

/**
 * Platform drivers implement one atomic transaction boundary and must
 * observe the signal before each statement and at the boundary.
 *
 * The driver must enable `PRAGMA foreign_keys = ON` on its connection
 * *outside* BEGIN — SQLite silently ignores it inside a transaction.
 * Storage additionally issues a defensive in-transaction PRAGMA, but
 * enforcement comes from the driver's connection-level setting.
 */
export interface SqliteDriver {
  transaction<T>(
    work: (connection: SqliteConnection) => Promise<T>,
    signal?: CancellationSignal,
  ): Promise<T>;
  /**
   * Recoverable whole-database backup, invoked before a destructive
   * migration. Runs outside the transaction boundary (a file copy or
   * `VACUUM INTO` cannot run inside BEGIN). `tag` is a lowercase
   * alphanumeric label such as `v1`; drivers conventionally write
   * `<db>.bak-<tag>` next to the database. A driver over an
   * ephemeral (e.g. `:memory:`) database has nothing durable to
   * preserve and may no-op.
   */
  backup(tag: string): Promise<void>;
}
