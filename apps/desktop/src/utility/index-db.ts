import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { shellError } from '../shared/errors.ts';

/**
 * A read-only accessor over the SAME database file the storage service
 * drives — `dbPath` is `AUQW_DB_PATH`, and the domain tables
 * (`downloads`, `local_sources`, `local_files`) are the ones the
 * renderer-side engines write through the storage tx channels. This is
 * a second connection on one file, never a second database, so the
 * transfer/tagread/local read planes see committed state directly.
 *
 * The connection opens read-only: every domain write stays on the
 * storage service's single-active-tx path. `busy_timeout` keeps a read
 * honest while the writer holds its reserved lock (rollback-journal
 * readers wait rather than fail); enabling WAL on the writer side is a
 * separate decision and not required for correctness here.
 */
export type IndexDb = {
  /**
   * The open connection, or null when the database file does not exist
   * yet (fresh install before the renderer's first write — callers map
   * that to empty state, not an error). Throws 'unavailable' when no
   * path is configured, 'released' after close.
   */
  readonly get: () => DatabaseSync | null;
  readonly close: () => void;
};

export function createIndexDb(dbPath: string | undefined): IndexDb {
  let db: DatabaseSync | null = null;
  let closed = false;

  return {
    get() {
      if (db !== null) {
        return db;
      }
      if (closed) {
        throw shellError('released', 'index db accessor is closed');
      }
      if (dbPath === undefined) {
        throw shellError(
          'unavailable',
          'index db path is not configured',
        );
      }
      if (!existsSync(dbPath)) {
        return null;
      }
      try {
        const opened = new DatabaseSync(dbPath, {
          readOnly: true,
          timeout: 5000,
        });
        db = opened;
        return opened;
      } catch (thrown) {
        // The file can be deleted between the existsSync check and the
        // open — an absent database is empty state, not an error.
        if (!existsSync(dbPath)) {
          return null;
        }
        throw shellError('io-error', 'index db open failed');
      }
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      const opened = db;
      db = null;
      opened?.close();
    },
  };
}
