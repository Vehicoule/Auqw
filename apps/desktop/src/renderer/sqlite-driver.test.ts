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
    const { calls, storage } = fakeStorage();
    const driver = createSqliteDriver(storage);
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
    const { calls, storage } = fakeStorage();
    const driver = createSqliteDriver(storage);
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
    const { calls, storage } = fakeStorage({
      commit: (txId) => {
        calls.push({ channel: 'commit', txId });
        return Promise.reject(commitError);
      },
    });
    const driver = createSqliteDriver(storage);
    await throwsWith(
      driver.transaction(() => Promise.resolve('x')),
      commitError,
      'commit failure',
    );
    assertDeepEqual(channels(calls), ['begin', 'commit', 'rollback']);
  }

  // a failing rollback is swallowed; the original error still wins
  {
    const { calls, storage } = fakeStorage({
      rollback: (txId) => {
        calls.push({ channel: 'rollback', txId });
        return Promise.reject(new Error('rollback broken'));
      },
    });
    const driver = createSqliteDriver(storage);
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
    const { calls, storage } = fakeStorage();
    const driver = createSqliteDriver(storage);
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
    const { calls, storage } = fakeStorage();
    const driver = createSqliteDriver(storage);
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

  // cancellation observed after work skips commit and rolls back
  {
    const { calls, storage } = fakeStorage();
    const driver = createSqliteDriver(storage);
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
    const { calls, storage } = fakeStorage();
    const driver = createSqliteDriver(storage);
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
    const { calls, storage } = fakeStorage({
      execute: (txId, sql, params = []) => {
        calls.push({ channel: 'execute', txId, sql, params });
        return Promise.reject(cancelled);
      },
    });
    const driver = createSqliteDriver(storage);
    await throwsWith(
      driver.transaction((conn) => conn.execute('INSERT')),
      cancelled,
      'wire cancellation',
    );
    assertDeepEqual(channels(calls), ['begin', 'execute', 'rollback']);
  }

  // backup/dropBackup delegate straight through
  {
    const { calls, storage } = fakeStorage();
    const driver = createSqliteDriver(storage);
    await driver.backup('v1');
    await driver.dropBackup('v1');
    assertDeepEqual(channels(calls), ['backup', 'dropBackup']);
  }
}
