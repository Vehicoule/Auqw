import type {
  SQLiteBindParams,
  SQLiteRunResult,
} from 'expo-sqlite';
import type { CancellationSignal } from '@auqw/application';
import type {
  SqliteConnection,
  SqliteDriver,
  SqlRow,
} from '@auqw/storage-sqlite';
// The cancellation sentinel is package-internal: SqliteStorage's
// #mapError classifies thrown === CANCELLED as a typed `cancelled`.
import { CANCELLED } from '../../../../packages/storage-sqlite/src/cancelled.ts';

/**
 * The slice of `expo-sqlite`'s `SQLiteDatabase` the driver uses —
 * injected so the driver's reconnect path is testable off-device
 * (`SQLiteDatabase` itself satisfies this structurally).
 */
export type ExpoSqliteDb = {
  execAsync(source: string): Promise<void>;
  runAsync(
    source: string,
    params: SQLiteBindParams,
  ): Promise<SQLiteRunResult>;
  getAllAsync<T>(source: string, params: SQLiteBindParams): Promise<T[]>;
  closeAsync(): Promise<void>;
};

/** How the host binds the expo-sqlite / expo-file-system natives. */
export type ExpoSqliteIo = {
  /** `expo-sqlite`'s `openDatabaseAsync` (or an equivalent surface). */
  openDb(path: string): Promise<ExpoSqliteDb>;
  /** Remove `filePath` when present (backup replace/discard). */
  deleteIfExists(filePath: string): Promise<void>;
};

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
 * Dead-handle failures — the only throws worth a re-open. A JS-side
 * `SQLiteDatabase` can outlive the native registration it wraps:
 * module-registry recreation (activity/process churn, a reload that
 * remints the native module table) leaves calls resolving a null ref
 * (`NativeDatabase.execAsync → java.lang.NullPointerException`), and
 * a released/closed handle reports `closed`. Match on the native
 * cause, never the generic `has been rejected` prefix — real errors
 * (disk, lock, constraint) must stay honest, not self-heal.
 */
const DEAD_HANDLE =
  /NullPointerException|IllegalStateException|database is closed|has been closed|already closed/i;

export function isDeadHandleError(thrown: unknown): boolean {
  return thrown instanceof Error && DEAD_HANDLE.test(thrown.message);
}

/**
 * A dead-handle throw raised by the driver's own native call — marked
 * at the call site (via `guardNative`) so a transaction callback that
 * fails with a look-alike message never replays `work`: non-database
 * effects inside `work` cannot be rolled back and must not run twice.
 */
class DeadHandle extends Error {
  readonly detail: Error;
  constructor(detail: Error) {
    super(detail.message);
    this.name = 'DeadHandle';
    this.detail = detail;
  }
}

const guardNative = async <T>(call: Promise<T>): Promise<T> => {
  try {
    return await call;
  } catch (thrown) {
    if (isDeadHandleError(thrown)) {
      throw new DeadHandle(thrown);
    }
    throw thrown;
  }
};

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
 *
 * Self-healing: when a call hits a dead native handle the driver
 * closes the stale wrapper (best-effort — the close itself may be
 * the thing that is dead), re-`openDb`s a fresh registration, and
 * replays the unit of work once. A second failure propagates; it is
 * genuinely dead (file gone, registry wedged for the process), not a
 * stale handle. Storage serializes transactions per driver instance,
 * so the binding swap can never interleave another in-flight turn.
 */
export async function createExpoSqliteDriver(
  path: string | undefined,
  io: ExpoSqliteIo,
): Promise<SqliteDriver> {
  const name = path ?? 'auqw.db';

  // Arming the pragma doubles as a liveness probe: a handle whose
  // native registration is already dead throws here, before the
  // driver is handed out.
  const openLive = async (): Promise<ExpoSqliteDb> => {
    const db = await io.openDb(name);
    try {
      await guardNative(db.execAsync('PRAGMA foreign_keys = ON'));
    } catch (thrown) {
      // A half-opened registration stays cached on Android — close the
      // probe handle before the caller retries or propagates (the
      // close itself may be the call that is dead).
      try {
        await db.closeAsync();
      } catch {
        // Best-effort.
      }
      throw thrown;
    }
    return db;
  };

  // A resolved-but-dead first handle — or an open that itself rejects
  // on a wedged registry — gets exactly one fresh registration. When
  // both are dead the registry is gone for the process: surface an
  // honest unavailable, not a bare native NPE.
  let db: ExpoSqliteDb;
  try {
    db = await openLive();
  } catch (first) {
    if (!isDeadHandleError(first)) {
      throw first;
    }
    try {
      db = await openLive();
    } catch (second) {
      const detail =
        second instanceof Error ? second.message : 'unknown failure';
      throw new Error(`sqlite driver unavailable: ${detail}`, {
        cause: second,
      });
    }
  }

  const reopen = async (): Promise<void> => {
    try {
      await db.closeAsync();
    } catch {
      // Closing the stale handle may be the call that is dead.
    }
    db = await openLive();
  };

  const withDb = async <T>(
    run: (db: ExpoSqliteDb) => Promise<T>,
  ): Promise<T> => {
    try {
      return await run(db);
    } catch (thrown) {
      // Only a marked native failure replays — a callback error with a
      // look-alike message propagates without re-running `work`.
      if (!(thrown instanceof DeadHandle)) {
        throw thrown;
      }
    }
    await reopen();
    return await run(db);
  };

  const checkTag = (tag: string): void => {
    if (!/^[a-z0-9-]+$/i.test(tag)) {
      throw new TypeError('backup tag must be alphanumeric/dashes');
    }
  };
  // The device path of the main database, resolved from SQLite itself
  // so the backup lands next to the file it preserves.
  const mainFile = async (db: ExpoSqliteDb): Promise<string | null> => {
    const rows = await guardNative(
      db.getAllAsync<{ name: string; file: string }>(
        'PRAGMA database_list',
        [],
      ),
    );
    const file = rows.find((r) => r.name === 'main')?.file;
    return typeof file === 'string' && file.length > 0 ? file : null;
  };

  return {
    async backup(tag: string): Promise<void> {
      checkTag(tag);
      await withDb(async (db) => {
        const file = await mainFile(db);
        if (file === null) {
          return;
        }
        // VACUUM INTO refuses an existing target: a stale image from a
        // failed attempt is replaced so retries stay retryable.
        await io.deleteIfExists(`${file}.bak-${tag}`);
        await guardNative(
          db.execAsync(
            `VACUUM INTO '${file.replaceAll("'", "''")}.bak-${tag}'`,
          ),
        );
      });
    },
    async dropBackup(tag: string): Promise<void> {
      checkTag(tag);
      await withDb(async (db) => {
        const file = await mainFile(db);
        if (file !== null) {
          await io.deleteIfExists(`${file}.bak-${tag}`);
        }
      });
    },
    async transaction<T>(
      work: (connection: SqliteConnection) => Promise<T>,
      signal?: CancellationSignal,
    ): Promise<T> {
      return withDb(async (db) => {
        checkCancelled(signal);
        // Re-asserted per transaction before BEGIN (same discipline as
        // the bundled NodeSqliteDriver): a no-op pragma is cheap, a
        // silently unenforced FK is not.
        await guardNative(db.execAsync('PRAGMA foreign_keys = ON'));
        checkCancelled(signal);
        const connection: SqliteConnection = {
          async execute(sql, params = [], statementSignal) {
            checkCancelled(statementSignal ?? signal);
            const result = await guardNative(
              db.runAsync(sql, [...params]),
            );
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
            const rows = await guardNative(
              db.getAllAsync<T>(sql, [...params]),
            );
            for (const row of rows) {
              checkRow(row);
            }
            return rows;
          },
          // The batch is already multi-row INSERTs from the planner —
          // one awaited `runAsync` per statement keeps ordering cheap.
          async executeAll(statements, statementSignal) {
            checkCancelled(statementSignal ?? signal);
            for (const statement of statements) {
              checkCancelled(statementSignal ?? signal);
              await guardNative(
                db.runAsync(statement.sql, [...statement.params]),
              );
            }
          },
        };
        await guardNative(db.execAsync('BEGIN IMMEDIATE'));
        try {
          const value = await work(connection);
          checkCancelled(signal);
          await guardNative(db.execAsync('COMMIT'));
          return value;
        } catch (thrown) {
          try {
            await db.execAsync('ROLLBACK');
          } catch {
            // The transaction already ended.
          }
          throw thrown;
        }
      });
    },
  };
}
