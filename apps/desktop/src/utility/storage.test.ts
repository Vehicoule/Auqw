import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

    // execMany runs its statements in order inside the tx — one call
    // lands a delete + multi-row insert + update
    const txBatch = await begin();
    const batched = await call(CHANNELS.storageExecMany, {
      txId: txBatch,
      statements: [
        { sql: `DELETE FROM items WHERE name = 'gamma'`, params: [] },
        {
          sql: 'INSERT INTO items (name) VALUES (?), (?)',
          params: ['b1', 'b2'],
        },
        { sql: `UPDATE items SET name = ? WHERE name = 'b1'`, params: ['b1x'] },
      ],
    });
    assert(batched.ok && batched.result === undefined, 'execMany resolves');
    const batchRows = await query(
      txBatch,
      `SELECT name FROM items WHERE name IN ('gamma', 'b1', 'b1x', 'b2') ORDER BY name`,
    );
    assert(batchRows.ok);
    assertDeepEqual(batchRows.result, {
      rows: [{ name: 'b1x' }, { name: 'b2' }],
    });
    // the gate scans every statement before any runs — a poisoned tail
    // must not run the batch's leading statements either
    const gatedBatch = await call(CHANNELS.storageExecMany, {
      txId: txBatch,
      statements: [
        { sql: `INSERT INTO items (name) VALUES ('sneaky')`, params: [] },
        { sql: 'ATTACH DATABASE x AS y', params: [] },
      ],
    });
    assert(
      !gatedBatch.ok && gatedBatch.error.kind === 'invalid-request',
      'execMany refuses a gated tail statement',
    );
    const sneaky = await query(
      txBatch,
      `SELECT COUNT(*) AS n FROM items WHERE name = 'sneaky'`,
    );
    assert(sneaky.ok);
    assertDeepEqual(
      sneaky.result,
      { rows: [{ n: 0 }] },
      'gate refusal ran nothing from the batch',
    );
    // a mid-batch constraint failure surfaces io-error; the tx still
    // rolls back so the partial prefix lands nothing
    const brokeBatch = await call(CHANNELS.storageExecMany, {
      txId: txBatch,
      statements: [
        { sql: `INSERT INTO items (name) VALUES ('prefix')`, params: [] },
        { sql: `INSERT INTO items (id) VALUES (1)`, params: [] },
      ],
    });
    assert(
      !brokeBatch.ok && brokeBatch.error.kind === 'io-error',
      'mid-batch failure surfaces io-error',
    );
    await call(CHANNELS.storageRollback, { txId: txBatch });
    const txAfter = await begin();
    const prefixCheck = await query(
      txAfter,
      `SELECT COUNT(*) AS n FROM items WHERE name IN ('sneaky', 'prefix')`,
    );
    assert(prefixCheck.ok);
    assertDeepEqual(
      prefixCheck.result,
      { rows: [{ n: 0 }] },
      'rolled-back batch left nothing',
    );
    // unknown/cancelled txs reject the batch the same as a statement
    const unknownBatch = await call(CHANNELS.storageExecMany, {
      txId: 'no-such-tx',
      statements: [],
    });
    assert(!unknownBatch.ok && unknownBatch.error.kind === 'invalid-request');
    await call(CHANNELS.storageCommit, { txId: txAfter });
    const deadBatch = await begin();
    await call(CHANNELS.storageCancel, { txId: deadBatch });
    const cancelledBatch = await call(CHANNELS.storageExecMany, {
      txId: deadBatch,
      statements: [{ sql: 'SELECT 1', params: [] }],
    });
    assert(
      !cancelledBatch.ok && cancelledBatch.error.kind === 'cancelled',
      'execMany on cancelled tx answers cancelled',
    );
    await call(CHANNELS.storageRollback, { txId: deadBatch });

    // a cancel landing mid-chunk interrupts the batch — the handler
    // yields between 64-statement sub-batches and re-checks the flag
    const midTx = await begin();
    const midFlight = call(CHANNELS.storageExecMany, {
      txId: midTx,
      statements: Array.from({ length: 130 }, (_, i) => ({
        sql: 'INSERT INTO items (name) VALUES (?)',
        params: [`mid-${i}`],
      })),
    });
    await call(CHANNELS.storageCancel, { txId: midTx });
    const midResult = await midFlight;
    assert(
      !midResult.ok && midResult.error.kind === 'cancelled',
      'mid-batch cancel interrupts the chunk',
    );
    await call(CHANNELS.storageRollback, { txId: midTx });
    const midCheck = await begin();
    const midRows = await query(
      midCheck,
      `SELECT COUNT(*) AS n FROM items WHERE name LIKE 'mid-%'`,
    );
    assert(midRows.ok);
    assertDeepEqual(
      midRows.result,
      { rows: [{ n: 0 }] },
      'interrupted batch rolled back clean',
    );
    await call(CHANNELS.storageCommit, { txId: midCheck });

    // a rollback landing mid-chunk (lifecycle cleanup for a dead
    // renderer) aborts the batch — the rest must not write in
    // autocommit on the released connection
    const lifeTx = await begin();
    const lifeFlight = call(CHANNELS.storageExecMany, {
      txId: lifeTx,
      statements: Array.from({ length: 130 }, (_, i) => ({
        sql: 'INSERT INTO items (name) VALUES (?)',
        params: [`life-${i}`],
      })),
    });
    await call(CHANNELS.storageRollback, { txId: lifeTx });
    const lifeResult = await lifeFlight;
    assert(
      !lifeResult.ok && lifeResult.error.kind === 'cancelled',
      'mid-batch rollback aborts the chunk',
    );
    const lifeCheck = await begin();
    const lifeRows = await query(
      lifeCheck,
      `SELECT COUNT(*) AS n FROM items WHERE name LIKE 'life-%'`,
    );
    assert(lifeRows.ok);
    assertDeepEqual(
      lifeRows.result,
      { rows: [{ n: 0 }] },
      'rolled-back prefix persisted nothing',
    );
    await call(CHANNELS.storageCommit, { txId: lifeCheck });

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

    // a begin whose local_sources snapshot can't be read must not
    // strand an untracked IMMEDIATE transaction on the one connection —
    // the same begin retries with the same typed error, and it
    // recovers once the schema is repaired
    const schemaBreak = await begin();
    await execute(
      schemaBreak,
      'CREATE TABLE local_sources (id INTEGER PRIMARY KEY)',
    );
    await call(CHANNELS.storageCommit, { txId: schemaBreak });
    const brokeBegin = await call(CHANNELS.storageBegin, undefined);
    assert(
      !brokeBegin.ok &&
        brokeBegin.error.kind === 'io-error' &&
        brokeBegin.error.message === 'local_sources read failed',
      'begin fails when the snapshot cannot be read',
    );
    const retryBegin = await call(CHANNELS.storageBegin, undefined);
    assert(
      !retryBegin.ok &&
        retryBegin.error.kind === 'io-error' &&
        retryBegin.error.message === 'local_sources read failed',
      'retry fails the same way — no orphaned tx wedged the connection',
    );
    const repair = new DatabaseSync(dbPath);
    try {
      repair.exec('DROP TABLE local_sources');
    } finally {
      repair.close();
    }
    const healed = await call(CHANNELS.storageBegin, undefined);
    assert(
      healed.ok && isStorageBeginResult(healed.result),
      'begin recovers once the snapshot can be read',
    );
    await call(CHANNELS.storageRollback, { txId: healed.result.txId });

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
      [
        CHANNELS.storageExecMany,
        { txId: held, statements: 'not-array' },
      ],
      [
        CHANNELS.storageExecMany,
        { txId: held, statements: [{ sql: 'SELECT 1', params: [true] }] },
      ],
      [
        CHANNELS.storageExecMany,
        { txId: held, statements: [{ sql: 'SELECT 1' }] },
      ],
      [
        CHANNELS.storageExecMany,
        { txId: held, statements: [], extra: 1 },
      ],
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

    // the statement gate: ATTACH/DETACH/VACUUM and non-allowlisted
    // PRAGMA escape the db boundary — refused before prepare
    const gated = await begin();
    for (const sql of [
      "ATTACH DATABASE '/tmp/evil.db' AS evil",
      '  DeTach DATABASE main',
      'VACUUM',
      'VACUUM INTO "/tmp/vac.db"',
      'PRAGMA foreign_keys = OFF',
      'PRAGMA writable_schema = ON',
      'PRAGMA journal_mode = DELETE',
      '-- peek\nATTACH DATABASE x AS y',
      '/* c */ pragma foreign_keys = off',
      // leading empty statements — prepare() skips them, so the gate
      // must too: ';ATTACH' would otherwise run under an empty head
      ';ATTACH DATABASE x AS y',
      ';; VACUUM',
      '/* c */; ATTACH x AS y',
      '; PRAGMA journal_mode = OFF',
      // a `*//*` storm must still fail fast — the head scan is linear
      `/*${'*//*'.repeat(200)}`,
    ]) {
      const res = await execute(gated, sql);
      assert(
        !res.ok && res.error.kind === 'invalid-request',
        `gate refuses: ${sql}`,
      );
      const qres = await query(gated, sql);
      assert(
        !qres.ok && qres.error.kind === 'invalid-request',
        `gate refuses query: ${sql}`,
      );
    }
    // the one pragma the renderer's own driver issues stays legal
    const pragmaOk = await execute(gated, 'PRAGMA foreign_keys = ON');
    assert(pragmaOk.ok, 'pragma foreign_keys = ON passes the gate');
    // ordinary statements still flow
    const stillOk = await execute(
      gated,
      'INSERT INTO items (name) VALUES (?)',
      ['post-gate'],
    );
    assert(stillOk.ok, 'ordinary statements pass the gate');
    // a rowid outside the safe range folds to null — never an
    // imprecise Number that round-trips a different key
    const hugeRow = await execute(
      gated,
      'INSERT INTO items (id, name) VALUES (-9223372036854775807, ?)',
      ['huge'],
    );
    assert(hugeRow.ok);
    assertDeepEqual(hugeRow.result, {
      changes: 1,
      lastInsertRowId: null,
    });
    await call(CHANNELS.storageRollback, { txId: gated });

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

    // unknown storage channels answer invalid-request
    const bogus = await route({ id: 908, channel: 'storage:bogus', args: {} });
    assert(!bogus.ok && bogus.error.kind === 'invalid-request');
    assertEqual(bogus.id, 908);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
