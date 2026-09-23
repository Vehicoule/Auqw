import type {
  AppError,
  CancellationSignal,
  OperationContext,
  Result,
  SyncLogSnapshot,
  SyncLogStore,
  SyncLogWrite,
} from '@auqw/application';
import {
  appError,
  err,
  isChangeEntry,
  isDivergenceEntry,
  isSyncCursor,
  ok,
} from '@auqw/application';
import { CANCELLED } from './cancelled.ts';
import type {
  SqliteConnection,
  SqliteDriver,
  SqlRow,
} from './driver.ts';
import { enqueueDriverTransaction } from './transaction-queue.ts';

/**
 * SQLite-backed SyncLogStore (docs/specs/sync.md): the merge engine's
 * durable surface. It shares the driver's connection with
 * SqliteStorage — the queue in transaction-queue.ts serializes both
 * stores' BEGIN/COMMIT sequences over one file.
 *
 * Row encoding is one JSON document per row; `(device_id, seq)` /
 * `history_id` uniqueness plus `INSERT OR IGNORE` makes a
 * crash-replayed append idempotent — hydration returns the rows once.
 */
export class SqliteSyncLogStore implements SyncLogStore {
  readonly #driver: SqliteDriver;

  constructor(driver: SqliteDriver) {
    this.#driver = driver;
  }

  #check(signal: CancellationSignal | undefined): void {
    if (signal?.cancelled === true) {
      throw CANCELLED;
    }
  }

  #mapError(thrown: unknown, signal: CancellationSignal): AppError {
    if (thrown === CANCELLED || signal.cancelled) {
      return appError('cancelled', 'cancelled');
    }
    return appError('transient', 'sync log operation failed');
  }

  #transaction<T>(
    work: (connection: SqliteConnection) => Promise<T>,
    signal: CancellationSignal,
  ): Promise<T> {
    return enqueueDriverTransaction(
      this.#driver,
      work,
      signal,
      (s) => this.#check(s),
    );
  }

  async load(
    context: OperationContext,
  ): Promise<Result<SyncLogSnapshot>> {
    try {
      return await this.#transaction(async (conn) => {
        this.#check(context.signal);
        const entryRows = await conn.query<SqlRow>(
          'SELECT entry_json FROM sync_log ORDER BY rowid',
          undefined,
          context.signal,
        );
        const entries: unknown[] = [];
        try {
          for (const row of entryRows) {
            entries.push(JSON.parse(String(row['entry_json'])));
          }
        } catch {
          return err(
            appError('invalid-response', 'stored sync entry failed validation'),
          );
        }
        if (!entries.every(isChangeEntry)) {
          return err(
            appError('invalid-response', 'stored sync entry failed validation'),
          );
        }
        const divergenceRows = await conn.query<SqlRow>(
          'SELECT row_json FROM sync_divergence ORDER BY rowid',
          undefined,
          context.signal,
        );
        const divergence: unknown[] = [];
        try {
          for (const row of divergenceRows) {
            divergence.push(JSON.parse(String(row['row_json'])));
          }
        } catch {
          return err(
            appError(
              'invalid-response',
              'stored divergence row failed validation',
            ),
          );
        }
        if (!divergence.every(isDivergenceEntry)) {
          return err(
            appError(
              'invalid-response',
              'stored divergence row failed validation',
            ),
          );
        }
        const watermarkRows = await conn.query<SqlRow>(
          'SELECT device_id, mark FROM sync_watermarks',
          undefined,
          context.signal,
        );
        const watermarks: Record<string, number> = {};
        for (const row of watermarkRows) {
          const device = row['device_id'];
          const mark = row['mark'];
          if (typeof device !== 'string' || !isSafeInt(mark)) {
            return err(
              appError(
                'invalid-response',
                'stored watermark row failed validation',
              ),
            );
          }
          watermarks[device] = mark;
        }
        const floorRows = await conn.query<SqlRow>(
          `SELECT value FROM sync_meta WHERE key = 'divergence_floor'`,
          undefined,
          context.signal,
        );
        let divergenceFloor = 0;
        if (floorRows.length > 0) {
          const value = floorRows[0]?.['value'];
          if (!isSafeInt(value)) {
            return err(
              appError(
                'invalid-response',
                'stored divergence floor failed validation',
              ),
            );
          }
          divergenceFloor = value;
        }
        return ok({
          entries,
          divergence,
          watermarks,
          divergenceFloor,
        });
      }, context.signal);
    } catch (thrown) {
      return err(this.#mapError(thrown, context.signal));
    }
  }

  async append(
    write: SyncLogWrite,
    context: OperationContext,
  ): Promise<Result<void>> {
    if (
      (write.entries !== undefined &&
        !write.entries.every(isChangeEntry)) ||
      (write.divergence !== undefined &&
        !write.divergence.every(isDivergenceEntry)) ||
      (write.watermarks !== undefined &&
        !isSyncCursor(write.watermarks)) ||
      (write.dropDivergenceBefore !== undefined &&
        !isSafeInt(write.dropDivergenceBefore))
    ) {
      return err(
        appError('invalid-response', 'sync append batch failed validation'),
      );
    }
    try {
      await this.#transaction(async (conn) => {
        this.#check(context.signal);
        if (write.dropDivergenceBefore !== undefined) {
          const floor = write.dropDivergenceBefore;
          await conn.execute(
            'DELETE FROM sync_divergence WHERE seq < ?',
            [floor],
            context.signal,
          );
          await conn.execute(
            `INSERT INTO sync_meta (key, value) VALUES ('divergence_floor', ?)
             ON CONFLICT (key) DO UPDATE SET value = MAX(value, excluded.value)`,
            [floor],
            context.signal,
          );
        }
        if (write.entries !== undefined) {
          for (const entry of write.entries) {
            await conn.execute(
              `INSERT OR IGNORE INTO sync_log (device_id, seq, entry_json)
               VALUES (?, ?, ?)`,
              [entry.deviceId, entry.seq, JSON.stringify(entry)],
              context.signal,
            );
          }
        }
        if (write.divergence !== undefined) {
          for (const row of write.divergence) {
            await conn.execute(
              `INSERT OR IGNORE INTO sync_divergence (history_id, seq, row_json)
               VALUES (?, ?, ?)`,
              [row.historyId, row.seq, JSON.stringify(row)],
              context.signal,
            );
          }
        }
        if (write.watermarks !== undefined) {
          for (const [device, mark] of Object.entries(write.watermarks)) {
            await conn.execute(
              `INSERT INTO sync_watermarks (device_id, mark) VALUES (?, ?)
               ON CONFLICT (device_id) DO UPDATE SET mark = MAX(mark, excluded.mark)`,
              [device, mark],
              context.signal,
            );
          }
        }
      }, context.signal);
      return ok(undefined);
    } catch (thrown) {
      return err(this.#mapError(thrown, context.signal));
    }
  }
}

function isSafeInt(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}
