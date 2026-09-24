import { CancellationSource } from '@auqw/application';
import type {
  ChangeEntry,
  DivergenceEntry,
  OperationContext,
} from '@auqw/application';
import { assert, assertDeepEqual, assertEqual } from '@auqw/application/testing';
import { SqliteStorage } from './storage.ts';
import { SqliteSyncLogStore } from './sync-log-store.ts';
import { NodeSqliteDriver } from './testing/node-sqlite-driver.ts';
import type { Settings } from '@auqw/application';

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: 'US',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
};

let contextSeq = 0;

function ctx(source = new CancellationSource()): {
  context: OperationContext;
  source: CancellationSource;
} {
  contextSeq += 1;
  return {
    context: {
      requestId: `t-${contextSeq}`,
      deadlineMs: Number.MAX_SAFE_INTEGER,
      signal: source.signal,
    },
    source,
  };
}

function rig(): {
  driver: NodeSqliteDriver;
  storage: SqliteStorage;
  syncLog: SqliteSyncLogStore;
} {
  const driver = new NodeSqliteDriver();
  return {
    driver,
    storage: new SqliteStorage(driver, SETTINGS),
    syncLog: new SqliteSyncLogStore(driver),
  };
}

function entry(
  deviceId: string,
  seq: number,
  overrides: Partial<ChangeEntry> = {},
): ChangeEntry {
  return {
    kind: 'playlist',
    recordId: `pl-${seq}`,
    field: 'name',
    value: `Mix ${seq}`,
    tombstone: false,
    hlc: { l: seq, c: 0 },
    deviceId,
    seq,
    ...overrides,
  };
}

function divergence(
  historyId: string,
  seq: number,
): DivergenceEntry {
  return {
    historyId,
    seq,
    kind: 'playlist',
    recordId: 'pl-1',
    field: 'name',
    loser: {
      deviceId: 'phone-1',
      hlc: { l: seq, c: 0 },
      tombstone: false,
      value: 'loser',
    },
    winner: {
      deviceId: 'desk-1',
      hlc: { l: seq + 1, c: 0 },
      tombstone: false,
      value: 'winner',
    },
    observedMs: seq * 1000,
    origin: 'remote',
  };
}

// 1. Empty store on a migrated schema loads an empty snapshot.
async function emptyLoad(): Promise<void> {
  const { driver, storage, syncLog } = rig();
  assert((await storage.initialize(ctx().context)).ok);
  const loaded = await syncLog.load(ctx().context);
  assert(loaded.ok, 'load resolves');
  assertEqual(loaded.value.entries.length, 0);
  assertEqual(loaded.value.divergence.length, 0);
  assertDeepEqual(loaded.value.watermarks, {});
  assertEqual(loaded.value.divergenceFloor ?? 0, 0);
  driver.close();
}

// 2. Entries, divergence, and watermarks round-trip in append order.
async function appendLoadRoundtrip(): Promise<void> {
  const { driver, storage, syncLog } = rig();
  assert((await storage.initialize(ctx().context)).ok);
  const a = entry('phone-1', 1);
  const b = entry('desk-1', 1, { recordId: 'pl-x', value: 'Desk' });
  const c = entry('phone-1', 2, { recordId: 'pl-2', value: 'Two' });
  const d = divergence('h-1', 1);
  assert(
    (
      await syncLog.append(
        {
          entries: [a, b],
          divergence: [d],
          watermarks: { 'phone-1': 2, 'desk-1': 1 },
        },
        ctx().context,
      )
    ).ok,
    'append resolves',
  );
  assert(
    (await syncLog.append({ entries: [c] }, ctx().context)).ok,
    'second append resolves',
  );
  const loaded = await syncLog.load(ctx().context);
  assert(loaded.ok, 'load resolves');
  assertDeepEqual(loaded.value.entries, [a, b, c]);
  assertDeepEqual(loaded.value.divergence, [d]);
  assertDeepEqual(loaded.value.watermarks, { 'phone-1': 2, 'desk-1': 1 });
  driver.close();
}

// 3. Watermark writes merge per-device max — a stale write can't
// rewind the stored mark.
async function watermarkMergeMax(): Promise<void> {
  const { driver, storage, syncLog } = rig();
  assert((await storage.initialize(ctx().context)).ok);
  assert(
    (
      await syncLog.append(
        { watermarks: { 'phone-1': 5 } },
        ctx().context,
      )
    ).ok,
  );
  assert(
    (
      await syncLog.append(
        { watermarks: { 'phone-1': 3, 'desk-1': 1 } },
        ctx().context,
      )
    ).ok,
  );
  const loaded = await syncLog.load(ctx().context);
  assert(loaded.ok);
  assertDeepEqual(loaded.value.watermarks, { 'phone-1': 5, 'desk-1': 1 });
  driver.close();
}

// 4. dropDivergenceBefore deletes rows below the floor inside the
// append's transaction and persists the cumulative floor.
async function divergenceFloorPrune(): Promise<void> {
  const { driver, storage, syncLog } = rig();
  assert((await storage.initialize(ctx().context)).ok);
  const rows = [divergence('h-1', 1), divergence('h-2', 2), divergence('h-3', 3)];
  assert(
    (await syncLog.append({ divergence: rows }, ctx().context)).ok,
    'append rows',
  );
  assert(
    (
      await syncLog.append(
        { dropDivergenceBefore: 2 },
        ctx().context,
      )
    ).ok,
    'floor write resolves',
  );
  let loaded = await syncLog.load(ctx().context);
  assert(loaded.ok);
  assertDeepEqual(loaded.value.divergence, [rows[1], rows[2]]);
  assertEqual(loaded.value.divergenceFloor, 2);
  // A lower floor can't rewind the cumulative prune boundary.
  assert(
    (
      await syncLog.append(
        { dropDivergenceBefore: 1 },
        ctx().context,
      )
    ).ok,
  );
  loaded = await syncLog.load(ctx().context);
  assert(loaded.ok);
  assertEqual(loaded.value.divergenceFloor, 2);
  assertEqual(loaded.value.divergence.length, 2);
  driver.close();
}

// 5. A crash-replayed append is idempotent: (device_id, seq) and
// history_id uniqueness dedupe the replayed rows.
async function replayedAppendDedupes(): Promise<void> {
  const { driver, storage, syncLog } = rig();
  assert((await storage.initialize(ctx().context)).ok);
  const write = {
    entries: [entry('phone-1', 1), entry('phone-1', 2)],
    divergence: [divergence('h-1', 1)],
    watermarks: { 'phone-1': 2 },
  };
  assert((await syncLog.append(write, ctx().context)).ok);
  assert((await syncLog.append(write, ctx().context)).ok);
  const loaded = await syncLog.load(ctx().context);
  assert(loaded.ok);
  assertEqual(loaded.value.entries.length, 2, 'replay deduped');
  assertEqual(loaded.value.divergence.length, 1);
  driver.close();
}

// 6. Malformed batches reject before the transaction opens — no
// partial rows land.
async function malformedBatchRejected(): Promise<void> {
  const { driver, storage, syncLog } = rig();
  assert((await storage.initialize(ctx().context)).ok);
  const bad = await syncLog.append(
    { entries: [{ ...entry('phone-1', 1), seq: -1 } as never] },
    ctx().context,
  );
  assert(!bad.ok && bad.error.kind === 'invalid-response');
  const loaded = await syncLog.load(ctx().context);
  assert(loaded.ok);
  assertEqual(loaded.value.entries.length, 0, 'nothing written');
  driver.close();
}

// 7. A corrupt stored row fails typed, never a raw throw.
async function corruptRowRejected(): Promise<void> {
  const { driver, storage, syncLog } = rig();
  assert((await storage.initialize(ctx().context)).ok);
  await driver.transaction(async (conn) => {
    await conn.execute(
      `INSERT INTO sync_log (device_id, seq, entry_json) VALUES ('x', 1, '{oops')`,
    );
  });
  const loaded = await syncLog.load(ctx().context);
  assert(
    !loaded.ok && loaded.error.kind === 'invalid-response',
    'corrupt row typed',
  );
  driver.close();
}

// 8. Cancellation is typed on both seams.
async function cancellationTyped(): Promise<void> {
  const { driver, storage, syncLog } = rig();
  assert((await storage.initialize(ctx().context)).ok);
  const call = ctx();
  call.source.cancel();
  const loaded = await syncLog.load(call.context);
  assert(!loaded.ok && loaded.error.kind === 'cancelled');
  const appended = await syncLog.append(
    { entries: [entry('phone-1', 1)] },
    call.context,
  );
  assert(!appended.ok && appended.error.kind === 'cancelled');
  driver.close();
}

// 9. Both stores over one driver serialize on the shared tail — a
// domain commit and a sync append interleave cleanly.
async function sharedDriverStores(): Promise<void> {
  const { driver, storage, syncLog } = rig();
  assert((await storage.initialize(ctx().context)).ok);
  const [commit, appended] = await Promise.all([
    storage.commit({}, ctx().context),
    syncLog.append({ entries: [entry('phone-1', 1)] }, ctx().context),
  ]);
  assert(commit.ok, 'commit resolves');
  assert(appended.ok, 'append resolves');
  const loaded = await syncLog.load(ctx().context);
  assert(loaded.ok && loaded.value.entries.length === 1);
  driver.close();
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['emptyLoad', emptyLoad],
  ['appendLoadRoundtrip', appendLoadRoundtrip],
  ['watermarkMergeMax', watermarkMergeMax],
  ['divergenceFloorPrune', divergenceFloorPrune],
  ['replayedAppendDedupes', replayedAppendDedupes],
  ['malformedBatchRejected', malformedBatchRejected],
  ['corruptRowRejected', corruptRowRejected],
  ['cancellationTyped', cancellationTyped],
  ['sharedDriverStores', sharedDriverStores],
];

for (const [name, fn] of TESTS) {
  try {
    await fn();
  } catch (thrown) {
    throw new Error(`sync-log-store test failed: ${name}`, {
      cause: thrown,
    });
  }
}
