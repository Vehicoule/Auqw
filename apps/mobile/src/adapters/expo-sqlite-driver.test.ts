import { assert, assertEqual } from '@auqw/application/testing';
import { CancellationSource } from '@auqw/application';
import type { SQLiteBindParams, SQLiteRunResult } from 'expo-sqlite';
import {
  createExpoSqliteDriver,
  isDeadHandleError,
} from './expo-sqlite-driver.ts';
import type { ExpoSqliteDb, ExpoSqliteIo } from './expo-sqlite-driver.ts';

/**
 * The reported failure shape: a JS-side `SQLiteDatabase` whose native
 * registration is dead answers every call with a rejected native
 * dispatch. The driver must re-open the database and replay the unit
 * of work on the fresh handle — never replay the dead call.
 */
function npe(): Error {
  return new Error(
    "Call to function 'NativeDatabase.execAsync' has been rejected.\n" +
      '→ Caused by: java.lang.NullPointerException',
  );
}

class FakeDb implements ExpoSqliteDb {
  readonly execs: string[] = [];
  readonly runs: string[] = [];
  readonly queries: string[] = [];
  closed = false;
  /** Throw this on the next call of each kind, once. */
  failExec: Error | null = null;
  failRun: Error | null = null;
  failQuery: Error | null = null;
  /** Throw on every call of each kind. */
  dead = false;

  execAsync(sql: string): Promise<void> {
    this.execs.push(sql);
    if (this.dead) {
      return Promise.reject(npe());
    }
    if (this.failExec !== null) {
      const thrown = this.failExec;
      this.failExec = null;
      return Promise.reject(thrown);
    }
    return Promise.resolve();
  }

  runAsync(
    sql: string,
    _params: SQLiteBindParams,
  ): Promise<SQLiteRunResult> {
    this.runs.push(sql);
    if (this.dead) {
      return Promise.reject(npe());
    }
    if (this.failRun !== null) {
      const thrown = this.failRun;
      this.failRun = null;
      return Promise.reject(thrown);
    }
    return Promise.resolve({ changes: 1, lastInsertRowId: 1 });
  }

  getAllAsync<T>(
    sql: string,
    _params: SQLiteBindParams,
  ): Promise<T[]> {
    this.queries.push(sql);
    if (this.dead) {
      return Promise.reject(npe());
    }
    if (this.failQuery !== null) {
      const thrown = this.failQuery;
      this.failQuery = null;
      return Promise.reject(thrown);
    }
    return Promise.resolve([]);
  }

  closeAsync(): Promise<void> {
    this.closed = true;
    return this.dead ? Promise.reject(npe()) : Promise.resolve();
  }
}

type Rig = {
  opened: FakeDb[];
  deleted: string[];
  io: ExpoSqliteIo;
};

function rig(...dbs: FakeDb[]): Rig {
  const opened: FakeDb[] = [];
  const deleted: string[] = [];
  let next = 0;
  const io: ExpoSqliteIo = {
    openDb: (_path: string) => {
      const db = dbs[next] ?? new FakeDb();
      next += 1;
      opened.push(db);
      return Promise.resolve(db);
    },
    deleteIfExists: (filePath: string) => {
      deleted.push(filePath);
      return Promise.resolve();
    },
  };
  return { opened, deleted, io };
}

const work = async (conn: {
  execute(sql: string): Promise<unknown>;
}): Promise<string> => {
  await conn.execute('INSERT INTO t VALUES (1)');
  return 'done';
};

export async function run(): Promise<void> {
  // Classification: dead-handle causes only — never the generic
  // rejection prefix that every native failure shares.
  assert(isDeadHandleError(npe()), 'NPE native cause is dead-handle');
  assert(
    isDeadHandleError(new Error('database is closed')),
    'closed handle is dead-handle',
  );
  assert(
    !isDeadHandleError(
      new Error(
        "Call to function 'NativeDatabase.execAsync' has been rejected.\n" +
          '→ Caused by: java.io.IOException: disk I/O error',
        ),
      ),
    'disk failure is not dead-handle',
  );
  assert(!isDeadHandleError(new Error('UNIQUE constraint failed')));
  assert(!isDeadHandleError('a string, not an Error'));

  // Dead handle at transaction time: re-open once and replay the work
  // on the fresh handle.
  {
    const first = new FakeDb();
    const second = new FakeDb();
    const r = rig(first, second);
    const driver = await createExpoSqliteDriver(undefined, r.io);
    first.dead = true;
    const result = await driver.transaction(work);
    assertEqual(result, 'done', 'work completed on the reopened handle');
    assertEqual(r.opened.length, 2, 'exactly one re-open');
    assert(first.closed, 'stale handle closed best-effort');
    assert(
      second.execs.includes('BEGIN IMMEDIATE') &&
        second.execs.includes('COMMIT'),
      'fresh handle ran the transaction',
    );
  }

  // Work itself sees the dead handle mid-transaction: the whole unit
  // replays on the fresh handle (the dead one never committed).
  {
    const first = new FakeDb();
    const second = new FakeDb();
    const r = rig(first, second);
    const driver = await createExpoSqliteDriver(undefined, r.io);
    let calls = 0;
    const result = await driver.transaction(async (conn) => {
      calls += 1;
      if (calls === 1) {
        first.dead = true;
      }
      await conn.execute('INSERT INTO t VALUES (1)');
      return 'done';
    });
    assertEqual(result, 'done');
    assertEqual(calls, 2, 'work replayed on the fresh handle');
    assertEqual(r.opened.length, 2);
  }

  // A dead first handle at creation: one fresh registration before
  // the driver is handed out.
  {
    const dead = new FakeDb();
    dead.failExec = npe();
    const live = new FakeDb();
    const r = rig(dead, live);
    const driver = await createExpoSqliteDriver(undefined, r.io);
    assertEqual(r.opened.length, 2, 'creation retried the open once');
    assert(dead.closed, 'the failed probe handle is closed, not held');
    const result = await driver.transaction(work);
    assertEqual(result, 'done');
    assertEqual(r.opened.length, 2, 'no extra opens for a live handle');
  }

  // A callback error that merely mentions a dead resource propagates
  // without reopening or replaying `work` — only failures from the
  // driver's own native calls are marked.
  {
    const first = new FakeDb();
    const r = rig(first);
    const driver = await createExpoSqliteDriver(undefined, r.io);
    const lookAlike = new Error('database is closed');
    let calls = 0;
    let caught: unknown;
    try {
      await driver.transaction(async () => {
        calls += 1;
        throw lookAlike;
      });
    } catch (thrown) {
      caught = thrown;
    }
    assert(caught === lookAlike, 'callback error propagates untouched');
    assertEqual(calls, 1, 'work never replays on a look-alike error');
    assertEqual(r.opened.length, 1, 'no re-open for a callback failure');
  }

  // A handle whose liveness probe fails is closed, not abandoned —
  // failed opens leave no cached registration behind.
  {
    const dead = new FakeDb();
    dead.failExec = npe();
    const live = new FakeDb();
    const r = rig(dead, live);
    await createExpoSqliteDriver(undefined, r.io);
    assert(dead.closed, 'failed probe handle closed before the retry');
    assertEqual(r.opened.length, 2);
  }

  // Non-dead errors stay honest: no re-open, the throw propagates.
  {
    const first = new FakeDb();
    const r = rig(first);
    const driver = await createExpoSqliteDriver(undefined, r.io);
    first.failExec = new Error('disk I/O error');
    let caught: unknown;
    try {
      await driver.transaction(work);
    } catch (thrown) {
      caught = thrown;
    }
    assert(caught instanceof Error, 'non-dead error propagates');
    assertEqual((caught as Error).message, 'disk I/O error');
    assertEqual(r.opened.length, 1, 'real errors never self-heal');
  }

  // Ops can arrive on different storage tails (a backup rides the
  // initialize tail, a transaction the transaction tail): with a dead
  // registry underneath, both must share a single re-open and replay
  // on the same fresh handle — no racing reopens, no leaked or
  // sibling-closed registration.
  {
    const first = new FakeDb();
    const second = new FakeDb();
    const r = rig(first, second);
    const driver = await createExpoSqliteDriver(undefined, r.io);
    first.dead = true;
    const [backupResult, txnResult] = await Promise.all([
      driver.backup('v1'),
      driver.transaction(work),
    ]);
    assertEqual(backupResult, undefined, 'backup completed');
    assertEqual(txnResult, 'done', 'transaction completed');
    assertEqual(r.opened.length, 2, 'a single re-open served both ops');
    assert(!second.closed, 'fresh handle never closed mid-flight');
    assert(
      second.execs.includes('COMMIT'),
      'transaction replayed on the fresh handle',
    );
    assert(
      second.queries.includes('PRAGMA database_list'),
      'backup replayed on the fresh handle',
    );
  }

  // A handle dead on retry too surfaces the second failure — bounded.
  {
    const first = new FakeDb();
    const second = new FakeDb();
    second.dead = true;
    const r = rig(first, second);
    const driver = await createExpoSqliteDriver(undefined, r.io);
    first.dead = true;
    let caught: unknown;
    try {
      await driver.transaction(work);
    } catch (thrown) {
      caught = thrown;
    }
    assert(caught instanceof Error, 'still-dead failure propagates');
    assertEqual(r.opened.length, 2, 'bounded to one re-open');
  }

  // Cancellation is checked before any db call — a dead handle must
  // not be reopened on behalf of a cancelled op.
  {
    const first = new FakeDb();
    const r = rig(first);
    const driver = await createExpoSqliteDriver(undefined, r.io);
    const source = new CancellationSource();
    source.cancel();
    let caught: unknown;
    try {
      await driver.transaction(work, source.signal);
    } catch (thrown) {
      caught = thrown;
    }
    assert(caught !== undefined, 'cancelled transaction rejects');
    // Only the creation-time pragma reached the db — nothing else.
    assertEqual(first.execs.length, 1, 'no db calls after cancel');
    assertEqual(r.opened.length, 1);
  }

  // The opening `foreign_keys` pragma still arms every new handle.
  {
    const r = rig(new FakeDb());
    await createExpoSqliteDriver(undefined, r.io);
    assertDeepStrings(r.opened[0]?.execs ?? [], ['PRAGMA foreign_keys = ON']);
  }
}

function assertDeepStrings(actual: string[], expected: string[]): void {
  assertEqual(actual.length, expected.length, 'exec count');
  for (let i = 0; i < expected.length; i += 1) {
    assertEqual(actual[i], expected[i]);
  }
}
