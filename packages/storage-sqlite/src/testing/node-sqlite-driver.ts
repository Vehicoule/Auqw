import { DatabaseSync } from 'node:sqlite';
import type { CancellationSignal } from '@auqw/application';
import { CANCELLED } from '../cancelled.ts';
import type {
  SqliteConnection,
  SqliteDriver,
  SqlParams,
  SqlRow,
  SqlValue,
} from '../driver.ts';

function checkSignal(signal: CancellationSignal | undefined): void {
  if (signal?.cancelled === true) {
    throw CANCELLED;
  }
}

/** Converts driver rows; bigint/blob/undefined values are rejected. */
function toSqlRow(row: Record<string, unknown>): SqlRow {
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(row)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number'
    ) {
      out[key] = value;
    } else {
      throw new Error('unsupported sqlite column type');
    }
  }
  return out;
}

function toRowId(value: number | bigint | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;
  }
  return value;
}

/**
 * Real driver over the Node built-in `node:sqlite` in-memory/file
 * database. Sync API wrapped in the async port surface; `BEGIN
 * IMMEDIATE` / `COMMIT` / `ROLLBACK` with signal checks at the
 * boundary and before every statement.
 */
export class NodeSqliteDriver implements SqliteDriver {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path);
  }

  async transaction<T>(
    work: (connection: SqliteConnection) => Promise<T>,
    signal?: CancellationSignal,
  ): Promise<T> {
    checkSignal(signal);
    // PRAGMA foreign_keys is connection-scoped and must be set outside
    // a transaction to take effect.
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('BEGIN IMMEDIATE');
    const connection: SqliteConnection = {
      execute: (sql, params = [], statementSignal) => {
        checkSignal(statementSignal ?? signal);
        const info = this.#db.prepare(sql).run(...params);
        return Promise.resolve({
          changes: info.changes,
          lastInsertRowId: toRowId(info.lastInsertRowid),
        });
      },
      query: <T extends SqlRow>(
        sql: string,
        params: SqlParams = [],
        statementSignal?: CancellationSignal,
      ) => {
        checkSignal(statementSignal ?? signal);
        const rows = this.#db.prepare(sql).all(...params);
        return Promise.resolve(
          rows.map(toSqlRow) as unknown as readonly T[],
        );
      },
    };
    try {
      const result = await work(connection);
      checkSignal(signal);
      this.#db.exec('COMMIT');
      return result;
    } catch (thrown) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // The transaction already ended.
      }
      throw thrown;
    }
  }

  /** Test setup only: raw script outside a transaction boundary. */
  execScript(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#db.close();
    }
  }
}

/**
 * Delegating driver wrapper for failure/cancellation injection: throws
 * before the Nth execute or query of the next transaction, and/or runs
 * a hook at the Nth statement (used to cancel a context mid-commit).
 * Statement counters reset per transaction.
 */
export class FailingDriver implements SqliteDriver {
  readonly inner: NodeSqliteDriver;
  #executeCount = 0;
  #queryCount = 0;
  #statementCount = 0;
  #transactions = 0;
  #failExecuteAt: number | null = null;
  #failQueryAt: number | null = null;
  #hookAt: { n: number; hook: () => void } | null = null;

  constructor(inner: NodeSqliteDriver) {
    this.inner = inner;
  }

  get transactions(): number {
    return this.#transactions;
  }

  /** Throws once before the Nth execute of the next transaction. */
  failBeforeExecute(n: number): void {
    this.#failExecuteAt = n;
  }

  /** Throws once before the Nth query of the next transaction. */
  failBeforeQuery(n: number): void {
    this.#failQueryAt = n;
  }

  /** Runs the hook once at the Nth statement of the next transaction. */
  hookAtStatement(n: number, hook: () => void): void {
    this.#hookAt = { n, hook };
  }

  async transaction<T>(
    work: (connection: SqliteConnection) => Promise<T>,
    signal?: CancellationSignal,
  ): Promise<T> {
    this.#transactions += 1;
    this.#executeCount = 0;
    this.#queryCount = 0;
    this.#statementCount = 0;
    return this.inner.transaction(async (conn) => {
      const wrapped: SqliteConnection = {
        execute: (sql, params, statementSignal) => {
          this.#executeCount += 1;
          this.#statementCount += 1;
          if (this.#failExecuteAt === this.#executeCount) {
            this.#failExecuteAt = null;
            return Promise.reject(new Error('injected execute failure'));
          }
          this.#runHook();
          return conn.execute(sql, params, statementSignal);
        },
        query: (sql, params, statementSignal) => {
          this.#queryCount += 1;
          this.#statementCount += 1;
          if (this.#failQueryAt === this.#queryCount) {
            this.#failQueryAt = null;
            return Promise.reject(new Error('injected query failure'));
          }
          this.#runHook();
          return conn.query(sql, params, statementSignal);
        },
      };
      return work(wrapped);
    }, signal);
  }

  #runHook(): void {
    if (this.#hookAt !== null && this.#hookAt.n === this.#statementCount) {
      const hook = this.#hookAt.hook;
      this.#hookAt = null;
      hook();
    }
  }

  execScript(sql: string): void {
    this.inner.execScript(sql);
  }

  close(): void {
    this.inner.close();
  }
}
