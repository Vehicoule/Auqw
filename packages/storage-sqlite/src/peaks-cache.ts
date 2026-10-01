import type { CancellationSignal } from '@auqw/application';
import type { PeaksStore, WaveformPeak } from '@auqw/application';
import { CANCELLED } from './driver.ts';
import type { SqliteDriver } from './driver.ts';
import { enqueueDriverTransaction } from './transaction-queue.ts';

/**
 * Device-local LRU bound on persisted peak rows — one row is ~2 KB of
 * JSON, so hundreds of tracks cost well under a megabyte.
 */
const PEAKS_CACHE_LIMIT = 256;

// The port carries no OperationContext: persisted peaks are a
// decoration lookup, not a cancellable operation. The queue still
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

const isPeak = (value: unknown): value is WaveformPeak => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const up = (value as { up?: unknown }).up;
  const down = (value as { down?: unknown }).down;
  return (
    typeof up === 'number' &&
    Number.isFinite(up) &&
    up >= 0 &&
    up <= 1 &&
    typeof down === 'number' &&
    Number.isFinite(down) &&
    down >= 0 &&
    down <= 1
  );
};

/**
 * `PeaksStore` over the shared sqlite database: the `peaks_cache`
 * table (schema v11) is device-local by construction — it is not a
 * `PersistedState` section, so export/import and sync never see it,
 * matching the "keyed by content identity, disposable" contract.
 * Failures degrade to a miss/no-op: the store is a fast path, never
 * the only source of peaks — a corrupt row, a schema-pending database,
 * or a failing driver just re-extracts.
 */
export function createPeaksCacheStore(
  driver: SqliteDriver,
  now: () => number = () => Date.now(),
): PeaksStore {
  return {
    async load(recordingId) {
      try {
        // enqueueDriverTransaction, not a bare driver.transaction:
        // the driver is shared with SqliteStorage/sync-log on the
        // same connection, so an unqueued BEGIN IMMEDIATE collides
        // with any open transaction — peaks ops degrade silently,
        // but the racing commit fails transiently. Every store over
        // one driver must queue on the same tail.
        const rows = await enqueueDriverTransaction(
          driver,
          async (conn) => {
            const hit = await conn.query<{
              recording_id: string;
              peaks_json: string;
            }>('SELECT peaks_json FROM peaks_cache WHERE recording_id = ?', [
              recordingId,
            ]);
            if (hit.length > 0) {
              await conn.execute(
                'UPDATE peaks_cache SET fetched_ms = ? WHERE recording_id = ?',
                [now(), recordingId],
              );
            }
            return hit;
          },
          NEVER_CANCELLED,
          checkSignal,
        );
        const json = rows[0]?.['peaks_json'];
        if (typeof json !== 'string') {
          return null;
        }
        const parsed: unknown = JSON.parse(json);
        if (
          !Array.isArray(parsed) ||
          parsed.length === 0 ||
          parsed.length > 4096 ||
          !parsed.every(isPeak)
        ) {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    },
    async save(recordingId, peaks) {
      try {
        await enqueueDriverTransaction(
          driver,
          async (conn) => {
            await conn.execute(
              `INSERT OR REPLACE INTO peaks_cache (recording_id, peaks_json, fetched_ms)
             VALUES (?, ?, ?)`,
              [recordingId, JSON.stringify(peaks), now()],
            );
            await conn.execute(
              `DELETE FROM peaks_cache WHERE recording_id NOT IN (
               SELECT recording_id FROM peaks_cache
               ORDER BY fetched_ms DESC, recording_id DESC LIMIT ?)`,
              [PEAKS_CACHE_LIMIT],
            );
          },
          NEVER_CANCELLED,
          checkSignal,
        );
      } catch {
        // Decoration — a dropped write only costs a cold start.
      }
    },
  };
}
