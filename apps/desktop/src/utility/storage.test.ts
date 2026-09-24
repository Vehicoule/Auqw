import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import { CHANNELS } from '../shared/channels.ts';
import { isStorageBeginResult } from '../shared/contract.ts';
import type { UtilityResponse } from './envelope.ts';
import { createUtilityRouter } from './router.ts';
import { createStorageService } from './storage.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'auqw-utility-storage-'));
  const dbPath = join(dir, 'auqw.db');
  const service = createStorageService({ dbPath });
  const route = createUtilityRouter(service.handlers);
  let nextId = 1;
  const call = (channel: string, args?: unknown): Promise<UtilityResponse> => {
    const id = nextId;
    nextId += 1;
    return route({ id, channel, args });
  };
  const begin = async (): Promise<string> => {
    const res = await call(CHANNELS.storageBegin, undefined);
    assert(res.ok && isStorageBeginResult(res.result), 'begin resolves');
    return res.result.txId;
  };
  const execute = (txId: string, sql: string, params: readonly (string | number | null)[] = []) =>
    call(CHANNELS.storageExecute, { txId, sql, params });
  const query = (txId: string, sql: string, params: readonly (string | number | null)[] = []) =>
    call(CHANNELS.storageQuery, { txId, sql, params });

  try {
    // happy path: begin → execute → query → commit
    const tx = await begin();
    const created = await execute(
      tx,
      'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)',
    );
    assert(created.ok, 'create table resolves');
    const inserted = await execute(
      tx,
      'INSERT INTO items (name) VALUES (?), (?)',
      ['alpha', 'beta'],
    );
    assert(inserted.ok, 'insert resolves');
    assertDeepEqual(inserted.result, {
      changes: 2,
      lastInsertRowId: 2,
    });
    const rows = await query(tx, 'SELECT id, name FROM items ORDER BY id');
    assert(rows.ok, 'query resolves');
    assertDeepEqual(rows.result, {
      rows: [
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ],
    });
    const committed = await call(CHANNELS.storageCommit, { txId: tx });
    assert(committed.ok && committed.result === undefined, 'commit resolves');
    // named params and nulls round-trip
    const tx2 = await begin();
    await execute(tx2, 'INSERT INTO items (name) VALUES (?)', ['gamma']);
    const withNull = await execute(
      tx2,
      'INSERT INTO items (id, name) VALUES (?, ?)',
      [99, null],
    );
    assert(withNull.ok);
    const got = await query(tx2, 'SELECT name FROM items WHERE id = ?', [99]);
    assert(got.ok);
    assertDeepEqual(got.result, { rows: [{ name: null }] });
    await call(CHANNELS.storageCommit, { txId: tx2 });

    // rollback discards
    const tx3 = await begin();
    await execute(tx3, 'INSERT INTO items (name) VALUES (?)', ['dropped']);
    const rolled = await call(CHANNELS.storageRollback, { txId: tx3 });
    assert(rolled.ok, 'rollback resolves');
    const tx4 = await begin();
    const afterRollback = await query(
      tx4,
      `SELECT COUNT(*) AS n FROM items WHERE name = 'dropped'`,
    );
    assert(afterRollback.ok);
    assertDeepEqual(afterRollback.result, { rows: [{ n: 0 }] });
    await call(CHANNELS.storageCommit, { txId: tx4 });

    // a second begin waits for the open tx to close, then proceeds
    const held = await begin();
    let secondSettled = false;
    const second = call(CHANNELS.storageBegin, undefined).then((res) => {
      secondSettled = true;
      return res;
    });
    await sleep(30);
    assert(!secondSettled, 'second begin waits on the open tx');
    await call(CHANNELS.storageCommit, { txId: held });
    const secondRes = await second;
    assert(
      secondRes.ok && isStorageBeginResult(secondRes.result),
      'second begin resolves after commit',
    );
    await call(CHANNELS.storageRollback, {
      txId: secondRes.result.txId,
    });

    // cancel poisons the tx: the next pinned statement answers cancelled
    const doomed = await begin();
    const cancelled = await call(CHANNELS.storageCancel, { txId: doomed });
    assert(cancelled.ok, 'cancel resolves');
    const afterCancel = await execute(
      doomed,
      'INSERT INTO items (name) VALUES (?)',
      ['never'],
    );
    assert(
      !afterCancel.ok && afterCancel.error.kind === 'cancelled',
      'statement on cancelled tx answers cancelled',
    );
    const afterCancelQuery = await query(doomed, 'SELECT 1 AS one');
    assert(!afterCancelQuery.ok && afterCancelQuery.error.kind === 'cancelled');
    // a commit racing a cancel rolls back instead and releases the slot
    const raced = await call(CHANNELS.storageCommit, { txId: doomed });
    assert(
      !raced.ok && raced.error.kind === 'cancelled',
      'commit on cancelled tx answers cancelled',
    );
    const afterRace = await begin();
    const racedRow = await query(afterRace, 'SELECT 1 AS one');
    assert(racedRow.ok, 'tx slot released after cancelled commit');
    await call(CHANNELS.storageCommit, { txId: afterRace });
    // cancel is idempotent on a dead tx
    const cancelDead = await call(CHANNELS.storageCancel, { txId: doomed });
    assert(cancelDead.ok, 'cancel on a closed tx still resolves');

    // unknown tx ids are invalid requests
    for (const channel of [
      CHANNELS.storageCommit,
      CHANNELS.storageRollback,
    ]) {
      const res = await call(channel, { txId: 'no-such-tx' });
      assert(!res.ok && res.error.kind === 'invalid-request', channel);
    }
    const unknownStmt = await execute('no-such-tx', 'SELECT 1');
    assert(!unknownStmt.ok && unknownStmt.error.kind === 'invalid-request');

    // foreign keys are enforced from open time
    const fk = await begin();
    await execute(
      fk,
      'CREATE TABLE parent (id INTEGER PRIMARY KEY)',
    );
    await execute(
      fk,
      'CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))',
    );
    const orphan = await execute(
      fk,
      'INSERT INTO child (pid) VALUES (?)',
      [42],
    );
    assert(
      !orphan.ok && orphan.error.kind === 'io-error',
      'foreign key violation surfaces io-error',
    );
    await call(CHANNELS.storageRollback, { txId: fk });

    // invalid params never reach sqlite
    const badCalls: readonly [string, unknown][] = [
      [CHANNELS.storageExecute, { txId: held, sql: 'SELECT 1', params: [true] }],
      [CHANNELS.storageExecute, { txId: held, sql: 'SELECT 1', params: [{}] }],
      [CHANNELS.storageExecute, { txId: held, sql: 'SELECT 1', params: [1n] }],
      [CHANNELS.storageExecute, { txId: held, sql: 'SELECT 1' }],
      [CHANNELS.storageExecute, { txId: held, sql: 42, params: [] }],
      [CHANNELS.storageExecute, { txId: 7, sql: 'SELECT 1', params: [] }],
      [CHANNELS.storageExecute, { txId: held, sql: 'SELECT 1', params: [], extra: 1 }],
      [CHANNELS.storageExecute, { txId: held, sql: 'SELECT 1', params: [Number.NaN] }],
      [CHANNELS.storageExecute, { txId: held, sql: 'SELECT 1', params: [undefined] }],
      [CHANNELS.storageQuery, { txId: held, sql: 'SELECT 1', params: [false] }],
      [CHANNELS.storageCommit, { txId: '' }],
      [CHANNELS.storageBackup, { tag: '../escape' }],
      [CHANNELS.storageBackup, { tag: 'has space' }],
      [CHANNELS.storageBegin, {}],
      [CHANNELS.storageBegin, { txId: 'x' }],
    ];
    for (const [index, [channel, args]] of badCalls.entries()) {
      const res = await call(channel, args);
      assert(
        !res.ok && res.error.kind === 'invalid-request',
        `${channel} rejects bad args #${index}`,
      );
    }
    // null/string/number params are the only valid ones — accepted here
    const okParams = await begin();
    const validParams = await execute(
      okParams,
      'INSERT INTO items (id, name) VALUES (?, ?)',
      [100, 'valid'],
    );
    assert(validParams.ok);
    await call(CHANNELS.storageCommit, { txId: okParams });

    // backup writes <file>.bak-<tag>; dropBackup removes it
    const backupFile = `${dbPath}.bak-v1`;
    const backed = await call(CHANNELS.storageBackup, { tag: 'v1' });
    assert(backed.ok, 'backup resolves');
    assert(existsSync(backupFile), 'backup image landed next to the db');
    const reBacked = await call(CHANNELS.storageBackup, { tag: 'v1' });
    assert(reBacked.ok, 'backup replaces a stale image');
    const dropped = await call(CHANNELS.storageDropBackup, { tag: 'v1' });
    assert(dropped.ok, 'dropBackup resolves');
    assert(!existsSync(backupFile), 'backup image removed');
    const dropAbsent = await call(CHANNELS.storageDropBackup, { tag: 'v1' });
    assert(dropAbsent.ok, 'dropBackup on a missing image still resolves');

    // a tx abandoned on close rolls back — nothing it wrote survives
    const abandoned = await begin();
    await execute(abandoned, 'CREATE TABLE lost (id INTEGER)');
    service.close();
    const reopened = createStorageService({ dbPath });
    const route2 = createUtilityRouter(reopened.handlers);
    const probe = await route2({
      id: 900,
      channel: CHANNELS.storageBegin,
      args: undefined,
    });
    assert(probe.ok && isStorageBeginResult(probe.result));
    const lost = await route2({
      id: 901,
      channel: CHANNELS.storageQuery,
      args: {
        txId: probe.result.txId,
        sql: 'SELECT id FROM lost',
        params: [],
      },
    });
    assert(
      !lost.ok && lost.error.kind === 'io-error',
      'abandoned tx rolled back on close',
    );
    // committed rows survive a reopen
    const kept = await route2({
      id: 902,
      channel: CHANNELS.storageQuery,
      args: {
        txId: probe.result.txId,
        sql: 'SELECT COUNT(*) AS n FROM items',
        params: [],
      },
    });
    assert(kept.ok);
    assertDeepEqual(kept.result, { rows: [{ n: 5 }] });
    await route2({
      id: 903,
      channel: CHANNELS.storageCommit,
      args: { txId: probe.result.txId },
    });
    // a closed service answers released
    reopened.close();
    const afterClose = await route2({
      id: 904,
      channel: CHANNELS.storageBegin,
      args: undefined,
    });
    assert(
      !afterClose.ok && afterClose.error.kind === 'released',
      'closed service answers released',
    );

    // an unconfigured path degrades to unavailable, never a crash
    const unconfigured = createStorageService({ dbPath: undefined });
    const route3 = createUtilityRouter(unconfigured.handlers);
    const noPath = await route3({
      id: 907,
      channel: CHANNELS.storageBegin,
      args: undefined,
    });
    assert(
      !noPath.ok && noPath.error.kind === 'unavailable',
      'missing dbPath answers unavailable',
    );

    // unknown storage channels still answer not-implemented
    const bogus = await route({ id: 908, channel: 'storage:bogus', args: {} });
    assert(!bogus.ok && bogus.error.kind === 'not-implemented');
    assertEqual(bogus.id, 908);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
