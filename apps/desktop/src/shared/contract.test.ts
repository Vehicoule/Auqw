import { assert } from '@auqw/application/testing';
import {
  isJsonValue,
  isStorageBackupArgs,
  isStorageBeginArgs,
  isStorageBeginResult,
  isStorageExecuteArgs,
  isStorageExecuteResult,
  isStorageQueryResult,
  isStorageTxArgs,
  isSyncDeltaDoc,
} from './contract.ts';

export function run(): void {
  // storage:begin — no args
  assert(isStorageBeginArgs(undefined), 'begin takes undefined args');
  assert(!isStorageBeginArgs({}), 'begin rejects an object');
  assert(!isStorageBeginArgs({ txId: 'x' }), 'begin rejects txId');

  // tx-pinned channels — { txId }
  assert(isStorageTxArgs({ txId: 'abc-123' }), 'tx args pass');
  assert(!isStorageTxArgs({}), 'tx args require txId');
  assert(!isStorageTxArgs({ txId: '' }), 'empty txId rejected');
  assert(!isStorageTxArgs({ txId: 7 }), 'numeric txId rejected');
  assert(
    !isStorageTxArgs({ txId: 'x'.repeat(65) }),
    'over-long txId rejected',
  );
  assert(
    !isStorageTxArgs({ txId: 'x', extra: 1 }),
    'unexpected keys rejected',
  );

  // storage:execute / storage:query args
  const exec = { txId: 'tx', sql: 'SELECT 1', params: [] };
  assert(isStorageExecuteArgs(exec), 'execute args pass');
  assert(
    isStorageExecuteArgs({ ...exec, params: ['a', 1, null, -2.5, ''] }),
    'sql params accept string/number/null',
  );
  assert(!isStorageExecuteArgs({ ...exec, sql: '' }), 'empty sql rejected');
  assert(!isStorageExecuteArgs({ ...exec, sql: 42 }), 'non-string sql');
  assert(
    !isStorageExecuteArgs({ txId: 'tx', sql: 'SELECT 1' }),
    'missing params rejected',
  );
  assert(
    !isStorageExecuteArgs({ ...exec, params: 'x' }),
    'non-array params rejected',
  );
  for (const bad of [true, false, {}, [], Number.NaN, Infinity, 1n, undefined]) {
    assert(
      !isStorageExecuteArgs({ ...exec, params: [bad] }),
      `param ${String(bad)} rejected`,
    );
  }
  assert(
    !isStorageExecuteArgs({
      ...exec,
      params: Array.from({ length: 257 }, () => 1),
    }),
    'over-long params rejected',
  );
  assert(!isStorageExecuteArgs({ ...exec, extra: 1 }), 'extra key rejected');
  assert(!isStorageExecuteArgs('sql'), 'non-record rejected');

  // storage:begin result
  assert(isStorageBeginResult({ txId: 'tx-1' }), 'begin result passes');
  assert(!isStorageBeginResult({ txId: '' }), 'empty txId result rejected');
  assert(!isStorageBeginResult({}), 'missing txId result rejected');
  assert(
    !isStorageBeginResult({ txId: 'x', extra: 1 }),
    'unexpected result keys rejected',
  );

  // storage:execute result
  assert(
    isStorageExecuteResult({ changes: 0, lastInsertRowId: null }),
    'execute result passes',
  );
  assert(
    isStorageExecuteResult({ changes: 2, lastInsertRowId: 7 }),
    'execute result with rowid passes',
  );
  assert(
    !isStorageExecuteResult({ changes: -1, lastInsertRowId: null }),
    'negative changes rejected',
  );
  assert(
    !isStorageExecuteResult({ changes: 1.5, lastInsertRowId: null }),
    'fractional changes rejected',
  );
  assert(
    !isStorageExecuteResult({ changes: 1, lastInsertRowId: '7' }),
    'string rowid rejected',
  );
  assert(
    !isStorageExecuteResult({ changes: 1, lastInsertRowId: 2.5 }),
    'fractional rowid rejected',
  );
  assert(
    !isStorageExecuteResult({ changes: 1 }),
    'missing rowid rejected',
  );
  assert(
    !isStorageExecuteResult({ changes: 1, lastInsertRowId: null, x: 1 }),
    'extra result key rejected',
  );

  // storage:query result
  assert(isStorageQueryResult({ rows: [] }), 'empty rows pass');
  assert(
    isStorageQueryResult({
      rows: [{ id: 1, name: 'x', blob: null, f: -2.5 }],
    }),
    'sql-typed rows pass',
  );
  assert(!isStorageQueryResult({}), 'missing rows rejected');
  assert(!isStorageQueryResult({ rows: 'x' }), 'non-array rows rejected');
  assert(!isStorageQueryResult({ rows: [null] }), 'non-record row rejected');
  assert(
    !isStorageQueryResult({ rows: [{ id: 1n }] }),
    'bigint row value rejected',
  );
  assert(
    !isStorageQueryResult({ rows: [{ id: [1] }] }),
    'array row value rejected',
  );
  assert(
    !isStorageQueryResult({ rows: [{ id: undefined }] }),
    'undefined row value rejected',
  );
  assert(
    !isStorageQueryResult({ rows: [{ id: true }] }),
    'boolean row value rejected',
  );

  // storage:backup / dropBackup args
  assert(isStorageBackupArgs({ tag: 'v1' }), 'backup tag passes');
  assert(isStorageBackupArgs({ tag: 'v-12' }), 'dashed tag passes');
  assert(!isStorageBackupArgs({ tag: '' }), 'empty tag rejected');
  assert(!isStorageBackupArgs({}), 'missing tag rejected');
  assert(!isStorageBackupArgs({ tag: 'has space' }), 'spaced tag rejected');
  assert(!isStorageBackupArgs({ tag: '../walk' }), 'path tag rejected');
  assert(!isStorageBackupArgs({ tag: 'a'.repeat(65) }), 'long tag rejected');
  assert(!isStorageBackupArgs({ tag: 12 }), 'numeric tag rejected');

  // strict-JSON domain — malformed graphs reject, never overflow
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert(!isJsonValue(cyclic), 'cyclic object rejected, not a crash');
  const cyclicArr: unknown[] = [];
  cyclicArr.push(cyclicArr);
  assert(!isJsonValue(cyclicArr), 'cyclic array rejected');
  let deep: unknown = { v: 1 };
  for (let i = 0; i < 80; i += 1) {
    deep = { next: deep };
  }
  assert(!isJsonValue(deep), 'over-depth graph rejected');
  // A shared (non-cyclic) reference is a diamond, not a cycle.
  const shared = { k: 1 };
  assert(isJsonValue({ a: shared, b: shared }), 'diamond refs pass');
  const sparse = new Array(3);
  sparse[0] = 1;
  assert(!isJsonValue(sparse), 'sparse array rejected');
  assert(!isJsonValue(NaN), 'NaN rejected');
  assert(
    isJsonValue({ ok: [1, 'x', null, true] }),
    'plain document passes',
  );
  assert(
    !isSyncDeltaDoc(cyclic),
    'cyclic delta doc rejected instead of throwing',
  );
  // A getter can answer differently per read — validation could never
  // vouch for the serialized wire document, so accessors reject.
  let getterReads = 0;
  const getterDoc = {
    get value() {
      getterReads += 1;
      return getterReads === 1 ? 1 : undefined;
    },
  };
  assert(!isJsonValue(getterDoc), 'enumerable getter rejected');
  const getterArr = [
    1,
    {
      get v() {
        return 2;
      },
    },
  ];
  assert(!isJsonValue(getterArr), 'nested getter rejected');
  // `toJSON` is honored by JSON.stringify regardless of enumerability —
  // a hidden hook would serialize a document validation never saw.
  const hooked = { value: 1 };
  Object.defineProperty(hooked, 'toJSON', {
    enumerable: false,
    value: () => ({ value: 2 }),
  });
  assert(!isJsonValue(hooked), 'hidden toJSON hook rejected');
  const docWithToJsonField = { toJSON: 'name', v: 1 };
  assert(
    isJsonValue(docWithToJsonField),
    'a non-function toJSON field is inert',
  );
}
