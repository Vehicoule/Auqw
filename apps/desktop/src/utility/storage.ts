import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CHANNELS } from '../shared/channels.ts';
import type {
  StorageBackupArgs,
  StorageExecuteArgs,
  StorageTxArgs,
} from '../shared/contract.ts';
import {
  isStorageBackupArgs,
  isStorageBeginArgs,
  isStorageExecuteArgs,
  isStorageQueryArgs,
  isStorageTxArgs,
} from '../shared/contract.ts';
import type { ShellError } from '../shared/errors.ts';
import { isShellError, shellError } from '../shared/errors.ts';
import type { UtilityHandler } from './router.ts';

export type StorageServiceOptions = {
  /**
   * File path of the main database — main resolves it under userData
   * and hands it to the fork through `AUQW_DB_PATH`. Undefined degrades
   * every storage channel to `unavailable` instead of a crash.
   */
  readonly dbPath: string | undefined;
};

export type StorageService = {
  readonly handlers: Readonly<Record<string, UtilityHandler>>;
  /** Rolls back any open transaction and closes the database. */
  readonly close: () => void;
};

type OpenTx = { cancelled: boolean };

/**
 * Maps a thrown sqlite/fs failure to a typed io error. The raw value —
 * sqlite errstr, file paths — never crosses the process boundary.
 */
function ioError(message: string): ShellError {
  return shellError('io-error', message);
}

/** Rethrows ShellErrors, wraps everything else as `io-error`. */
function rethrowStorage(message: string, thrown: unknown): never {
  if (isShellError(thrown)) {
    throw thrown;
  }
  throw ioError(message);
}

function toSqlRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (typeof value === 'bigint') {
      // Outside the safe range a Number would round-trip a different
      // key — refuse rather than send an imprecise value.
      if (
        value < BigInt(-Number.MAX_SAFE_INTEGER) ||
        value > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw ioError('unsupported sqlite column type');
      }
      row[key] = Number(value);
      continue;
    }
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number'
    ) {
      // blob has no SqlValue representation on the wire.
      throw ioError('unsupported sqlite column type');
    }
  }
  return row;
}

function toRowId(value: number | bigint | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value >= BigInt(-Number.MAX_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;
  }
  return value;
}

function toCount(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * Which statements the renderer may run inside its tx. Arbitrary SQL
 * is the channel's contract, but three forms escape the database
 * boundary the sandbox is built on: `ATTACH`/`DETACH` reach any
 * sqlite file the utility process can read, `VACUUM` rewrites the
 * file out from under the tx, and most `PRAGMA` forms flip
 * connection-global or schema-level state (`writable_schema`,
 * `journal_mode`/`foreign_keys = OFF`) the tx model can't isolate.
 * The one pragma the renderer's own driver legitimately issues is
 * `PRAGMA foreign_keys = ON`; anything else is refused.
 */
const PRAGMA_FOREIGN_KEYS_ON = /^pragma\s+foreign_keys\s*=\s*on\s*;?$/i;
// `;` counts as trivia: prepare() skips leading empty statements, so
// ';ATTACH' would otherwise reach the driver under an empty head.
const STATEMENT_HEAD = /^(?:[\s;]|--[^\n]*\n|\/\*[^]*?\*\/)*([a-z]+)/i;
const BLOCKED_HEADS = new Set(['attach', 'detach', 'vacuum', 'pragma']);

function checkStatement(sql: string): void {
  const keyword = (STATEMENT_HEAD.exec(sql)?.[1] ?? '').toLowerCase();
  if (keyword === '') {
    throw shellError('invalid-request', 'statement has no head keyword');
  }
  if (!BLOCKED_HEADS.has(keyword)) {
    return;
  }
  if (keyword === 'pragma' && PRAGMA_FOREIGN_KEYS_ON.test(sql)) {
    return;
  }
  throw shellError(
    'invalid-request',
    `statement keyword ${keyword} is not admitted`,
  );
}

/**
 * Storage channels over one `node:sqlite` connection. One connection
 * means one open transaction, so `storage:begin` waits for the active
 * tx to close; statements then run atomically on the synchronous
 * `DatabaseSync` as they arrive on the message loop.
 */
export function createStorageService(
  options: StorageServiceOptions,
): StorageService {
  let db: DatabaseSync | null = null;
  let shutdown = false;
  const openTxs = new Map<string, OpenTx>();
  let activeTx: string | null = null;
  let txClosed: Promise<void> | null = null;
  let releaseTx: (() => void) | null = null;

  function database(): DatabaseSync {
    if (db !== null) {
      return db;
    }
    if (shutdown) {
      throw shellError('released', 'storage service is closed');
    }
    if (options.dbPath === undefined) {
      throw shellError('unavailable', 'storage path is not configured');
    }
    try {
      mkdirSync(dirname(options.dbPath), { recursive: true });
      const opened = new DatabaseSync(options.dbPath);
      // Connection-scoped; must be set outside a transaction to apply.
      opened.exec('PRAGMA foreign_keys = ON');
      db = opened;
      return opened;
    } catch (thrown) {
      rethrowStorage('storage open failed', thrown);
    }
  }

  /** The main database file, resolved from SQLite itself. */
  function mainFile(): string | null {
    const rows = database().prepare('PRAGMA database_list').all() as {
      name?: unknown;
      file?: unknown;
    }[];
    const file = rows.find((r) => r['name'] === 'main')?.['file'];
    return typeof file === 'string' && file.length > 0 ? file : null;
  }

  function requireTx(txId: string): OpenTx {
    const tx = openTxs.get(txId);
    if (tx === undefined) {
      throw shellError('invalid-request', 'unknown transaction');
    }
    return tx;
  }

  /** Releases the tx slot so a waiting `storage:begin` can proceed. */
  function releaseSlot(txId: string): void {
    openTxs.delete(txId);
    activeTx = null;
    const release = releaseTx;
    txClosed = null;
    releaseTx = null;
    release?.();
  }

  function closeTx(txId: string, statement: 'COMMIT' | 'ROLLBACK'): void {
    requireTx(txId);
    const opened = database();
    try {
      opened.exec(statement);
    } catch (thrown) {
      // A failed COMMIT leaves the tx open in SQLite — roll back
      // before releasing the slot or the next begin nests a BEGIN.
      try {
        opened.exec('ROLLBACK');
      } catch {
        // The transaction already ended.
      }
      throw thrown;
    } finally {
      releaseSlot(txId);
    }
  }

  async function begin(): Promise<unknown> {
    // A second begin waits on the slot the active tx releases on
    // commit/rollback; statements for the open tx keep flowing
    // meanwhile because the wait is only an awaited promise.
    while (activeTx !== null) {
      const wait = txClosed;
      if (wait === null) {
        break;
      }
      await wait;
    }
    if (shutdown) {
      throw shellError('released', 'storage service is closed');
    }
    try {
      database().exec('BEGIN IMMEDIATE');
    } catch (thrown) {
      rethrowStorage('storage begin failed', thrown);
    }
    const txId = randomUUID();
    openTxs.set(txId, { cancelled: false });
    activeTx = txId;
    txClosed = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });
    return { txId };
  }

  function commit(args: StorageTxArgs): unknown {
    const tx = requireTx(args.txId);
    if (tx.cancelled) {
      // A commit racing a cancel never lands: roll back so the tx
      // slot still releases, then report the cancellation.
      try {
        closeTx(args.txId, 'ROLLBACK');
      } catch {
        // The slot released anyway.
      }
      throw shellError('cancelled', 'transaction cancelled');
    }
    try {
      closeTx(args.txId, 'COMMIT');
    } catch (thrown) {
      rethrowStorage('storage commit failed', thrown);
    }
    return undefined;
  }

  function rollback(args: StorageTxArgs): unknown {
    try {
      closeTx(args.txId, 'ROLLBACK');
    } catch (thrown) {
      rethrowStorage('storage rollback failed', thrown);
    }
    return undefined;
  }

  function cancel(args: StorageTxArgs): unknown {
    // Idempotent: a tx that already ended is the requested end state.
    const tx = openTxs.get(args.txId);
    if (tx !== undefined) {
      tx.cancelled = true;
    }
    return undefined;
  }

  function execute(args: StorageExecuteArgs): unknown {
    const tx = requireTx(args.txId);
    if (tx.cancelled) {
      throw shellError('cancelled', 'transaction cancelled');
    }
    checkStatement(args.sql);
    try {
      // bigint reads keep rowids exact — a truncated f64 rowid bound
      // as a key later would address a different row.
      const stmt = database().prepare(args.sql);
      stmt.setReadBigInts(true);
      const info = stmt.run(...args.params);
      return {
        changes: toCount(info.changes),
        lastInsertRowId: toRowId(info.lastInsertRowid),
      };
    } catch (thrown) {
      rethrowStorage('storage execute failed', thrown);
    }
  }

  function query(args: StorageExecuteArgs): unknown {
    const tx = requireTx(args.txId);
    if (tx.cancelled) {
      throw shellError('cancelled', 'transaction cancelled');
    }
    checkStatement(args.sql);
    try {
      const stmt = database().prepare(args.sql);
      stmt.setReadBigInts(true);
      const rows = stmt.all(...args.params);
      return { rows: rows.map((row) => toSqlRow(row as Record<string, unknown>)) };
    } catch (thrown) {
      rethrowStorage('storage query failed', thrown);
    }
  }

  /**
   * `VACUUM INTO` a `<file>.bak-<tag>` sibling of the main database; a
   * stale image from a failed attempt is removed first — `VACUUM INTO`
   * refuses an existing target and must not wedge retries.
   */
  function backup(args: StorageBackupArgs): unknown {
    try {
      const file = mainFile();
      if (file !== null) {
        rmSync(`${file}.bak-${args.tag}`, { force: true });
        database().exec(
          `VACUUM INTO '${file.replaceAll("'", "''")}.bak-${args.tag}'`,
        );
      }
    } catch (thrown) {
      rethrowStorage('storage backup failed', thrown);
    }
    return undefined;
  }

  /** Removes a `<file>.bak-<tag>` image; absent files are ignored. */
  function dropBackup(args: StorageBackupArgs): unknown {
    try {
      const file = mainFile();
      if (file !== null) {
        rmSync(`${file}.bak-${args.tag}`, { force: true });
      }
    } catch (thrown) {
      rethrowStorage('storage dropBackup failed', thrown);
    }
    return undefined;
  }

  function guarded<A>(
    name: string,
    validate: (value: unknown) => value is A,
    run: (args: A) => unknown,
  ): UtilityHandler {
    return async (args) => {
      if (!validate(args)) {
        throw shellError(
          'invalid-request',
          `invalid arguments for ${name}`,
        );
      }
      return run(args);
    };
  }

  return {
    handlers: {
      [CHANNELS.storageBegin]: guarded(
        CHANNELS.storageBegin,
        isStorageBeginArgs,
        begin,
      ),
      [CHANNELS.storageCommit]: guarded(
        CHANNELS.storageCommit,
        isStorageTxArgs,
        commit,
      ),
      [CHANNELS.storageRollback]: guarded(
        CHANNELS.storageRollback,
        isStorageTxArgs,
        rollback,
      ),
      [CHANNELS.storageCancel]: guarded(
        CHANNELS.storageCancel,
        isStorageTxArgs,
        cancel,
      ),
      [CHANNELS.storageExecute]: guarded(
        CHANNELS.storageExecute,
        isStorageExecuteArgs,
        execute,
      ),
      [CHANNELS.storageQuery]: guarded(
        CHANNELS.storageQuery,
        isStorageQueryArgs,
        query,
      ),
      [CHANNELS.storageBackup]: guarded(
        CHANNELS.storageBackup,
        isStorageBackupArgs,
        backup,
      ),
      [CHANNELS.storageDropBackup]: guarded(
        CHANNELS.storageDropBackup,
        isStorageBackupArgs,
        dropBackup,
      ),
    },
    close() {
      if (shutdown) {
        return;
      }
      shutdown = true;
      // Abandoned transactions never commit — the map is cleared and
      // the connection rolled back so a waiting begin releases.
      openTxs.clear();
      if (activeTx !== null && db !== null) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The transaction already ended.
        }
        activeTx = null;
      }
      const release = releaseTx;
      txClosed = null;
      releaseTx = null;
      release?.();
      if (db !== null) {
        const opened = db;
        db = null;
        opened.close();
      }
    },
  };
}
