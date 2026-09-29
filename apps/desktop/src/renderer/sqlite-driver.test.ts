import { CancellationSource } from '@auqw/application';
import type { SqlValue } from '@auqw/storage-sqlite';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import { shellError } from '../shared/errors.ts';
import type {
  AuqwStorage,
  StorageExecuteResult,
} from '../shared/contract.ts';
import { CANCELLED } from '../../../../packages/storage-sqlite/src/cancelled.ts';
import { createSqliteDriver } from './sqlite-driver.ts';

type Call = {
  readonly channel: string;
  readonly txId?: string;
  readonly sql?: string;
  readonly params?: readonly SqlValue[];
  readonly batchSize?: number;
};

function fakeStorage(overrides: Partial<AuqwStorage> = {}): {
  calls: Call[];
  storage: AuqwStorage;
} {
  const calls: Call[] = [];
  let txCounter = 0;
  const storage: AuqwStorage = {
    begin: () => {
      txCounter += 1;
      calls.push({ channel: 'begin' });
      return Promise.resolve({ txId: `tx-${txCounter}` });
    },
    commit: (txId) => {
      calls.push({ channel: 'commit', txId });
      return Promise.resolve();
    },
    rollback: (txId) => {
      calls.push({ channel: 'rollback', txId });
      return Promise.resolve();
    },
    cancel: (txId) => {
      calls.push({ channel: 'cancel', txId });
      return Promise.resolve();
    },
    execute: (txId, sql, params = []): Promise<StorageExecuteResult> => {
      calls.push({ channel: 'execute', txId, sql, params });
      return Promise.resolve({ changes: 1, lastInsertRowId: 7 });
    },
    execMany: (txId, statements) => {
      calls.push({ channel: 'execMany', txId, batchSize: statements.length });
      for (const statement of statements) {
        calls.push({
          channel: 'execMany:stmt',
          txId,
          sql: statement.sql,
          params: statement.params,
        });
      }
      return Promise.resolve();
    },
    query: (txId, sql, params = []) => {
      calls.push({ channel: 'query', txId, sql, params });
      return Promise.resolve({ rows: [{ id: 1 }] });
    },
    backup: (tag) => {
      calls.push({ channel: 'backup', txId: tag });
      return Promise.resolve();
    },
    dropBackup: (tag) => {
      calls.push({ channel: 'dropBackup', txId: tag });
      return Promise.resolve();
    },
    ...overrides,
  };
  return { calls, storage };
}

function rig(overrides: Partial<AuqwStorage> = {}): {
  calls: Call[];
  driver: ReturnType<typeof createSqliteDriver>;
} {
  const { calls, storage } = fakeStorage(overrides);
  return { calls, driver: createSqliteDriver(storage) };
}

function channels(calls: readonly Call[]): string[] {
  return calls.map((c) => c.channel);
}

async function throwsWith(
  promise: Promise<unknown>,
  expected: unknown,
  message: string,
): Promise<void> {
  try {
    await promise;
  } catch (thrown) {
    assert(thrown === expected, `${message}: wrong error`);
    return;
  }
  throw new Error(`${message}: resolved instead of throwing`);
}

export async function run(): Promise<void> {
  // happy path: begin → statements → commit, txId pinned on every call
  {
    const { calls, driver } = rig();
    const value = await driver.transaction(async (conn) => {
      const inserted = await conn.execute('INSERT INTO t VALUES (?)', [
        'a',
        1,
        null,
      ]);
      assertEqual(inserted.lastInsertRowId, 7);
      const rows = await conn.query<{ id: number }>(
        'SELECT id FROM t',
      );
      assertDeepEqual(rows, [{ id: 1 }]);
      return 'done';
    });
    assertEqual(value, 'done');
    assertDeepEqual(channels(calls), [
      'begin',
      'execute',
      'query',
      'commit',
    ]);
    assert(
      calls.every((c) => c.txId === undefined || c.txId === 'tx-1'),
      'every statement pinned to the begun tx',
    );
    const execute = calls.find((c) => c.channel === 'execute');
    assertDeepEqual(execute?.params, ['a', 1, null]);
  }

  // a throwing work callback rolls back; the original error propagates
  {
    const { calls, driver } = rig();
    const boom = new Error('work failed');
    await throwsWith(
      driver.transaction(() => Promise.reject(boom)),
      boom,
      'work failure',
    );
    assertDeepEqual(channels(calls), ['begin', 'rollback']);
  }

  // a failing commit still rolls back; the commit error propagates
  {
    const commitError = shellError('io-error', 'commit failed');
    const { calls, driver } = rig({
      commit: (txId) => {
        calls.push({ channel: 'commit', txId });
        return Promise.reject(commitError);
      },
    });
    await throwsWith(
      driver.transaction(() => Promise.resolve('x')),
      commitError,
      'commit failure',
    );
    assertDeepEqual(channels(calls), ['begin', 'commit', 'rollback']);
  }

  // a failing rollback is swallowed; the original error still wins
  {
    const { calls, driver } = rig({
      rollback: (txId) => {
        calls.push({ channel: 'rollback', txId });
        return Promise.reject(new Error('rollback broken'));
      },
    });
    const boom = new Error('work failed');
    await throwsWith(
      driver.transaction(() => Promise.reject(boom)),
      boom,
      'rollback failure',
    );
    assertDeepEqual(channels(calls), ['begin', 'rollback']);
  }

  // a signal cancelled up front never reaches the wire
  {
    const { calls, driver } = rig();
    const source = new CancellationSource();
    source.cancel();
    await throwsWith(
      driver.transaction(() => Promise.resolve(), source.signal),
      CANCELLED,
      'pre-cancelled signal',
    );
    assertDeepEqual(calls, []);
  }

  // mid-transaction cancellation: flag the tx, throw CANCELLED, roll back
  {
    const { calls, driver } = rig();
    const source = new CancellationSource();
    await throwsWith(
      driver.transaction(async (conn) => {
        await conn.execute('INSERT INTO t VALUES (?)', [1]);
        source.cancel();
        await conn.execute('INSERT INTO t VALUES (?)', [2]);
        return 'never';
      }, source.signal),
      CANCELLED,
      'mid-transaction cancel',
    );
    assertDeepEqual(channels(calls), [
      'begin',
      'execute',
      'cancel',
      'rollback',
    ]);
  }

  // a cancel landing while work is suspended still flags the tx
  {
    const { calls, driver } = rig();
    const source = new CancellationSource();
    await throwsWith(
      driver.transaction(async (conn) => {
        await conn.execute('INSERT INTO t VALUES (?)', [1]);
        source.cancel();
        assertDeepEqual(
          channels(calls),
          ['begin', 'execute', 'cancel'],
          'subscription flags the tx before the next statement',
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        await conn.execute('INSERT INTO t VALUES (?)', [2]);
        return 'never';
      }, source.signal),
      CANCELLED,
      'cancel while stalled',
    );
    assertDeepEqual(channels(calls), [
      'begin',
      'execute',
      'cancel',
      'rollback',
    ]);
  }

  // cancellation observed after work skips commit and rolls back
  {
    const { calls, driver } = rig();
    const source = new CancellationSource();
    await throwsWith(
      driver.transaction(async () => {
        source.cancel();
        return 'done';
      }, source.signal),
      CANCELLED,
      'post-work cancel',
    );
    assertDeepEqual(channels(calls), ['begin', 'cancel', 'rollback']);
  }

  // a per-statement signal cancels the statement without poisoning the tx
  {
    const { calls, driver } = rig();
    const source = new CancellationSource();
    await throwsWith(
      driver.transaction(async (conn) => {
        source.cancel();
        await conn.query('SELECT 1', undefined, source.signal);
        return 'never';
      }),
      CANCELLED,
      'statement-level cancel',
    );
    assertDeepEqual(channels(calls), ['begin', 'rollback']);
  }

  // a cancelled ShellError from the wire propagates untouched
  {
    const cancelled = shellError('cancelled', 'transaction cancelled');
    const { calls, driver } = rig({
      execute: (txId, sql, params = []) => {
        calls.push({ channel: 'execute', txId, sql, params });
        return Promise.reject(cancelled);
      },
    });
    await throwsWith(
      driver.transaction((conn) => conn.execute('INSERT')),
      cancelled,
      'wire cancellation',
    );
    assertDeepEqual(channels(calls), ['begin', 'execute', 'rollback']);
  }

  // executeAll sends one wire call per ≤2048-statement chunk — a
  // whole commit plan crosses the bridge once, ordered and tx-pinned
  {
    const { calls, driver } = rig();
    await driver.transaction(async (conn) => {
      await conn.executeAll([
        { sql: 'INSERT INTO t VALUES (?)', params: [1] },
        { sql: 'INSERT INTO t VALUES (?)', params: [2] },
        { sql: 'DELETE FROM t WHERE id = ?', params: [1] },
      ]);
      return 'x';
    });
    assertDeepEqual(channels(calls), [
      'begin',
      'execMany',
      'execMany:stmt',
      'execMany:stmt',
      'execMany:stmt',
      'commit',
    ]);
    const batches = calls.filter((c) => c.channel === 'execMany');
    assertDeepEqual(
      batches.map((c) => c.batchSize),
      [3],
    );
    assert(
      batches.every((c) => c.txId === 'tx-1'),
      'batch pinned to the open tx',
    );
    const stmts = calls.filter((c) => c.channel === 'execMany:stmt');
    assertDeepEqual(
      stmts.map((c) => c.sql),
      [
        'INSERT INTO t VALUES (?)',
        'INSERT INTO t VALUES (?)',
        'DELETE FROM t WHERE id = ?',
      ],
    );
    assertDeepEqual(stmts[2]?.params, [1]);
  }

  // plans beyond the per-call cap split into sequential chunks with
  // statement order preserved across the boundary
  {
    const { calls, driver } = rig();
    await driver.transaction(async (conn) => {
      await conn.executeAll(
        Array.from({ length: 2049 }, (_, i) => ({
          sql: 'INSERT INTO t VALUES (?)',
          params: [i],
        })),
      );
      return 'x';
    });
    const batches = calls.filter((c) => c.channel === 'execMany');
    assertDeepEqual(
      batches.map((c) => c.batchSize),
      [2048, 1],
    );
    const stmts = calls.filter((c) => c.channel === 'execMany:stmt');
    assertEqual(stmts.length, 2049);
    assertDeepEqual(
      stmts[2048]?.params,
      [2048],
      'first statement of the second chunk follows the 2048th',
    );
  }

  // a per-call signal cancels the batch without poisoning the tx —
  // nothing reaches the wire
  {
    const { calls, driver } = rig();
    const source = new CancellationSource();
    await throwsWith(
      driver.transaction(async (conn) => {
        source.cancel();
        await conn.executeAll(
          [{ sql: 'SELECT 1', params: [] }],
          source.signal,
        );
        return 'never';
      }),
      CANCELLED,
      'executeAll statement-level cancel',
    );
    assertDeepEqual(channels(calls), ['begin', 'rollback']);
  }

  // backup/dropBackup delegate straight through
  {
    const { calls, driver } = rig();
    await driver.backup('v1');
    await driver.dropBackup('v1');
    assertDeepEqual(channels(calls), ['backup', 'dropBackup']);
  }
}
