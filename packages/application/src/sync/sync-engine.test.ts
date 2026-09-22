import {
  DIVERGENCE_HISTORY_LIMIT,
  SETTINGS_RECORD_ID,
  TOMBSTONE_FIELD,
  createSyncEngine,
  isSyncDelta,
  likeRecordId,
} from './sync-engine.ts';
import type {
  ApplyResult,
  ChangeEntry,
  LocalWrite,
  SyncDelta,
  SyncEngine,
} from './sync-engine.ts';
import { compareStamp } from './hlc.ts';
import type { HlcStamp } from './hlc.ts';
import { PLAY_HISTORY_RETENTION_MS } from '../library/history.ts';
import { CancellationSource } from '../cancellation.ts';
import { appError } from '../errors.ts';
import { assert, assertEqual, assertDeepEqual } from '../testing/assert.ts';
import {
  FakeClock,
  FakeLog,
  FakeSyncLogStore,
  SequenceIds,
} from '../testing/fakes.ts';

type Rig = {
  engine: SyncEngine;
  clock: FakeClock;
  store: FakeSyncLogStore;
};

async function makeEngine(
  deviceId: string,
  at = 1_000,
  store?: FakeSyncLogStore,
): Promise<Rig> {
  const s = store ?? new FakeSyncLogStore();
  const clock = new FakeClock(at);
  const created = await createSyncEngine({
    store: s,
    clock,
    ids: new SequenceIds(),
    log: new FakeLog(),
    deviceId,
  });
  assert(created.ok, `createSyncEngine(${deviceId}) failed`);
  return { engine: created.value, clock, store: s };
}

async function mustWrite(
  engine: SyncEngine,
  input: LocalWrite,
): Promise<ChangeEntry> {
  const wrote = await engine.localChange(input);
  assert(wrote.ok, `localChange failed: ${JSON.stringify(input)}`);
  return wrote.value.entry;
}

async function mustApply(
  engine: SyncEngine,
  doc: SyncDelta,
): Promise<ApplyResult> {
  const applied = await engine.applyDelta(
    JSON.parse(JSON.stringify(doc)) as unknown,
  );
  assert(applied.ok, `applyDelta failed: ${JSON.stringify(doc).slice(0, 200)}`);
  return applied.value;
}

/** Hand-built wire entry for precise stamp control. */
function rawEntry(
  kind: ChangeEntry['kind'],
  recordId: string,
  field: string,
  value: unknown,
  hlc: HlcStamp,
  deviceId = 'peer',
): ChangeEntry {
  return { kind, recordId, field, value, tombstone: false, hlc, deviceId };
}

function rawTombstone(
  kind: ChangeEntry['kind'],
  recordId: string,
  hlc: HlcStamp,
  deviceId = 'peer',
): ChangeEntry {
  return {
    kind,
    recordId,
    field: TOMBSTONE_FIELD,
    value: null,
    tombstone: true,
    hlc,
    deviceId,
  };
}

function delta(
  entries: readonly ChangeEntry[],
  senderDeviceId = 'peer',
): SyncDelta {
  return {
    formatVersion: 1,
    senderDeviceId,
    cursor: {},
    entries,
  };
}

function materialized(
  engine: SyncEngine,
  kind: ChangeEntry['kind'],
  recordId: string,
): Readonly<Record<string, unknown>> | undefined {
  return engine
    .materialize()
    .find((r) => r.kind === kind && r.recordId === recordId)?.fields;
}

// ---- unit tests -------------------------------------------------------------

async function basicWrites(): Promise<void> {
  const { engine, clock } = await makeEngine('a', 500);
  const first = await engine.localChange({
    kind: 'recording',
    recordId: 'r1',
    field: 'title',
    value: 'Song',
  });
  assert(first.ok, 'write failed');
  assertEqual(first.value.entry.deviceId, 'a');
  assertEqual(first.value.outcome.type, 'applied');
  assertDeepEqual(first.value.entry.hlc, { l: 500, c: 0 });
  const second = await engine.localChange({
    kind: 'recording',
    recordId: 'r1',
    field: 'artist',
    value: 'Someone',
  });
  assert(second.ok, 'write failed');
  // Same wall ms → counter increments; stamps stay strictly monotone.
  assert(
    compareStamp(second.value.entry.hlc, first.value.entry.hlc) > 0,
    'local stamps must be strictly monotone',
  );
  clock.advance(10);
  const third = await engine.localChange({
    kind: 'like',
    recordId: likeRecordId('track', 'r1'),
    field: 'like',
    value: { entityKind: 'track', targetId: 'r1', likedAtMs: 510 },
  });
  assert(third.ok, 'like write failed');
  assertEqual(third.value.entry.hlc.l, 510);
  assertDeepEqual(materialized(engine, 'recording', 'r1'), {
    title: 'Song',
    artist: 'Someone',
  });
}

async function localWriteValidation(): Promise<void> {
  const { engine } = await makeEngine('a');
  // Off-whitelist fields never enter the log.
  const offList = await engine.localChange({
    kind: 'settings',
    recordId: SETTINGS_RECORD_ID,
    field: 'downloadMetered',
    value: true,
  });
  assert(!offList.ok, 'per-device budget field must not sync');
  assertEqual(offList.ok ? '' : offList.error.kind, 'not-applicable');
  const artworkBudget = await engine.localChange({
    kind: 'settings',
    recordId: SETTINGS_RECORD_ID,
    field: 'artworkCacheBytes',
    value: 200,
  });
  assert(!artworkBudget.ok, 'artwork budget must not sync');
  // Not a real record field at all.
  const bogus = await engine.localChange({
    kind: 'recording',
    recordId: 'r1',
    field: 'secretUrl',
    value: 'https://signed.example/x',
  });
  assert(!bogus.ok, 'non-whitelisted field rejected');
  // Whitelisted field, wrong value shape.
  const badValue = await engine.localChange({
    kind: 'settings',
    recordId: SETTINGS_RECORD_ID,
    field: 'theme',
    value: 'purple',
  });
  assert(!badValue.ok, 'invalid value rejected');
  assertEqual(badValue.ok ? '' : badValue.error.kind, 'invalid-response');
  // The rejected writes left nothing behind.
  assertEqual(engine.materialize().length, 0);
  const exported = await engine.exportDelta();
  assert(exported.ok);
  assertEqual(exported.value.entries.length, 0);
}

async function deltaRoundTrip(): Promise<void> {
  const a = await makeEngine('a', 100);
  const b = await makeEngine('b', 5_000);
  await mustWrite(a.engine, {
    kind: 'playlist',
    recordId: 'pl1',
    field: 'name',
    value: 'Favorites',
  });
  await mustWrite(a.engine, {
    kind: 'playlistEntry',
    recordId: 'e1',
    field: 'position',
    value: 1.5,
  });
  const exported = await a.engine.exportDelta();
  assert(exported.ok);
  assert(isSyncDelta(JSON.parse(JSON.stringify(exported.value))));
  const applied = await mustApply(b.engine, exported.value);
  assertEqual(applied.senderDeviceId, 'a');
  assertEqual(applied.entries.length, 2);
  assert(applied.outcomes.every((o) => o.type === 'applied'));
  assertDeepEqual(materialized(b.engine, 'playlist', 'pl1'), {
    name: 'Favorites',
  });
  assertDeepEqual(materialized(b.engine, 'playlistEntry', 'e1'), {
    position: 1.5,
  });
  // The doc's cursor is B's next `since`: re-export yields nothing.
  const again = await a.engine.exportDelta(applied.cursor);
  assert(again.ok);
  assertEqual(again.value.entries.length, 0);
}

async function fieldLww(): Promise<void> {
  const b = await makeEngine('b');
  // Older write applied first.
  let applied = await mustApply(
    b.engine,
    delta([rawEntry('recording', 'r1', 'title', 'old', { l: 10, c: 0 })]),
  );
  assertEqual(applied.outcomes[0]?.type, 'applied');
  // Newer write wins and displaces the old value into divergence.
  applied = await mustApply(
    b.engine,
    delta([
      rawEntry('recording', 'r1', 'title', 'new', { l: 20, c: 0 }),
    ]),
  );
  const outcome = applied.outcomes[0];
  assertEqual(outcome?.type, 'applied');
  if (outcome?.type === 'applied') {
    assertEqual(outcome.displaced.length, 1);
    assertEqual(outcome.displaced[0]?.value, 'old');
  }
  assertDeepEqual(materialized(b.engine, 'recording', 'r1'), {
    title: 'new',
  });
  const rows = b.engine.divergenceHistory();
  assertEqual(rows.length, 1);
  assertEqual(rows[0]?.loser.value, 'old');
  assertEqual(rows[0]?.winner.value, 'new');
  assertEqual(rows[0]?.origin, 'remote');
  // Out-of-order arrival of a still-older write: loses, preserved.
  applied = await mustApply(
    b.engine,
    delta([
      rawEntry('recording', 'r1', 'title', 'oldest', { l: 5, c: 0 }),
    ]),
  );
  assertEqual(applied.outcomes[0]?.type, 'superseded');
  assertDeepEqual(materialized(b.engine, 'recording', 'r1'), {
    title: 'new',
  });
  assertEqual(b.engine.divergenceHistory().length, 2);
}

async function playlistOccurrenceOrder(): Promise<void> {
  const b = await makeEngine('b');
  // Two devices reorder the same entry concurrently: fractional
  // position is an LWW field — the higher stamp wins outright.
  await mustApply(
    b.engine,
    delta([
      rawEntry('playlistEntry', 'e1', 'position', 2.25, { l: 30, c: 0 }),
    ]),
  );
  await mustApply(
    b.engine,
    delta([
      rawEntry('playlistEntry', 'e1', 'position', 0.5, { l: 25, c: 0 }),
    ]),
  );
  assertDeepEqual(materialized(b.engine, 'playlistEntry', 'e1'), {
    position: 2.25,
  });
  // A genuinely newer reorder wins regardless of position direction.
  await mustApply(
    b.engine,
    delta([
      rawEntry('playlistEntry', 'e1', 'position', 0.75, { l: 40, c: 0 }),
    ]),
  );
  assertDeepEqual(materialized(b.engine, 'playlistEntry', 'e1'), {
    position: 0.75,
  });
}

async function playCountMerge(): Promise<void> {
  const b = await makeEngine('b');
  // PlayCount fields merge as max: a higher count with an *older*
  // stamp still wins — a merged count never regresses (sync.md: the
  // merge must never destroy observed plays; exact per-device splits
  // stay recoverable through the playEvent entries themselves).
  await mustApply(
    b.engine,
    delta([
      rawEntry('playCount', 'r1', 'count', 7, { l: 10, c: 0 }),
      rawEntry('playCount', 'r1', 'lastMs', 900, { l: 10, c: 1 }),
    ]),
  );
  const applied = await mustApply(
    b.engine,
    delta([
      rawEntry('playCount', 'r1', 'count', 3, { l: 50, c: 0 }),
      rawEntry('playCount', 'r1', 'lastMs', 1_200, { l: 50, c: 1 }),
    ]),
  );
  assertEqual(applied.outcomes[0]?.type, 'superseded'); // 3 < 7
  assertEqual(applied.outcomes[1]?.type, 'applied'); // 1200 > 900
  assertDeepEqual(materialized(b.engine, 'playCount', 'r1'), {
    count: 7,
    lastMs: 1_200,
  });
  // A losing 'max' write is preserved like any other loser — as is
  // the displaced lastMs winner.
  const rows = b.engine.divergenceHistory();
  assertEqual(rows.length, 2);
  assert(
    rows.some((r) => r.field === 'count' && r.loser.value === 3),
    'losing count preserved',
  );
  assert(
    rows.some((r) => r.field === 'lastMs' && r.loser.value === 900),
    'displaced winner preserved',
  );
}

async function tombstoneRules(): Promise<void> {
  const b = await makeEngine('b');
  const write = rawEntry('recording', 'r1', 'title', 'Song', {
    l: 10,
    c: 0,
  });
  const tomb = rawTombstone('recording', 'r1', { l: 20, c: 0 });
  const newerWrite = rawEntry('recording', 'r1', 'artist', 'Back', {
    l: 30,
    c: 0,
  });
  // Reordered delivery: tombstone first, then the older write.
  await mustApply(b.engine, delta([tomb]));
  await mustApply(b.engine, delta([write]));
  // The older write stays dead.
  assertEqual(materialized(b.engine, 'recording', 'r1'), undefined);
  // Its value is preserved in divergence.
  const rows = b.engine.divergenceHistory();
  assertEqual(rows.length, 1);
  assertEqual(rows[0]?.loser.value, 'Song');
  assertEqual(rows[0]?.loser.tombstone, false);
  // A newer write beats the tombstone — the record revives with just
  // that field.
  const applied = await mustApply(b.engine, delta([newerWrite]));
  assertEqual(applied.outcomes[0]?.type, 'applied');
  assertDeepEqual(materialized(b.engine, 'recording', 'r1'), {
    artist: 'Back',
  });

  // Forward order on a second record: write, then delete.
  await mustApply(
    b.engine,
    delta([rawEntry('recording', 'r2', 'title', 'Gone', { l: 5, c: 0 })]),
  );
  await mustApply(
    b.engine,
    delta([rawTombstone('recording', 'r2', { l: 6, c: 0 })]),
  );
  assertEqual(materialized(b.engine, 'recording', 'r2'), undefined);

  // A still-newer tombstone beats the field that outlived the first.
  await mustApply(
    b.engine,
    delta([rawTombstone('recording', 'r1', { l: 40, c: 0 })]),
  );
  assertEqual(materialized(b.engine, 'recording', 'r1'), undefined);
}

async function whitelistOnApply(): Promise<void> {
  const b = await makeEngine('b');
  // A crafted remote entry outside the whitelist is rejected per-row
  // without sinking the rest of the delta.
  const doc = delta([
    rawEntry('settings', SETTINGS_RECORD_ID, 'theme', 'oled', {
      l: 10,
      c: 0,
    }),
    rawEntry(
      'settings',
      SETTINGS_RECORD_ID,
      'downloadMetered',
      true,
      { l: 10, c: 1 },
    ),
    rawEntry(
      'settings',
      SETTINGS_RECORD_ID,
      'sessionToken',
      'leak',
      { l: 10, c: 2 },
    ),
  ]);
  const applied = await mustApply(b.engine, doc);
  const kinds = applied.outcomes.map((o) => o.type);
  assertDeepEqual(kinds, ['rejected', 'rejected', 'applied']);
  assertDeepEqual(materialized(b.engine, 'settings', SETTINGS_RECORD_ID), {
    theme: 'oled',
  });
  // Rejected entries never reach the log: a re-export of this device
  // must not relay them.
  const exported = await b.engine.exportDelta();
  assert(exported.ok);
  assertEqual(exported.value.entries.length, 1);
  assertEqual(exported.value.entries[0]?.field, 'theme');
  // And malformed envelope → whole-doc error.
  const malformed = await b.engine.applyDelta({ nope: true });
  assert(!malformed.ok);
  assertEqual(malformed.ok ? '' : malformed.error.kind, 'invalid-message');
  const badVersion = await b.engine.applyDelta({
    formatVersion: 2,
    senderDeviceId: 'x',
    cursor: {},
    entries: [],
  });
  assert(!badVersion.ok, 'unknown formatVersion rejected');
}

async function boundedHistoryWindow(): Promise<void> {
  const a = await makeEngine('a', PLAY_HISTORY_RETENTION_MS + 1_000_000);
  const old = {
    eventId: 'ev-old',
    recordingId: 'r1',
    occurrenceId: null,
    playedMs: a.clock.nowMs() - PLAY_HISTORY_RETENTION_MS - 1,
    listenedMs: 5,
  };
  const recent = {
    eventId: 'ev-new',
    recordingId: 'r1',
    occurrenceId: null,
    playedMs: a.clock.nowMs() - 60_000,
    listenedMs: 5,
  };
  await mustWrite(a.engine, {
    kind: 'playEvent',
    recordId: 'ev-old',
    field: 'event',
    value: old,
  });
  await mustWrite(a.engine, {
    kind: 'playEvent',
    recordId: 'ev-new',
    field: 'event',
    value: recent,
  });
  const exported = await a.engine.exportDelta();
  assert(exported.ok);
  assertEqual(exported.value.entries.length, 1);
  assertEqual(exported.value.entries[0]?.recordId, 'ev-new');
  // Non-playEvent entries are never retention-filtered.
  await mustWrite(a.engine, {
    kind: 'recording',
    recordId: 'r1',
    field: 'title',
    value: 'Song',
  });
  const again = await a.engine.exportDelta();
  assert(again.ok);
  assertEqual(again.value.entries.length, 2);
}

async function duplicatesAndWatermarks(): Promise<void> {
  const a = await makeEngine('a', 100);
  const b = await makeEngine('b', 200);
  const c = await makeEngine('c', 300);
  await mustWrite(b.engine, {
    kind: 'recording',
    recordId: 'r1',
    field: 'title',
    value: 'From B',
  });
  // Relay: B → A → C. Then B → C directly; C must dedupe.
  const bExport = await b.engine.exportDelta();
  assert(bExport.ok);
  await mustApply(a.engine, bExport.value);
  const aExport = await a.engine.exportDelta();
  assert(aExport.ok);
  assertEqual(aExport.value.entries.length, 1); // relayed, not A-authored
  const appliedRelayed = await mustApply(c.engine, aExport.value);
  assertEqual(appliedRelayed.entries.length, 1);
  const appliedDirect = await mustApply(c.engine, bExport.value);
  assertEqual(appliedDirect.entries.length, 0);
  assertEqual(appliedDirect.outcomes[0]?.type, 'duplicate');
  // Per-source-device cursors: marking B's watermark filters only B's
  // entries; A's own writes still export.
  await mustWrite(a.engine, {
    kind: 'recording',
    recordId: 'r2',
    field: 'title',
    value: 'From A',
  });
  const bStamp = appliedRelayed.entries[0]?.hlc;
  assert(bStamp !== undefined);
  const partial = await a.engine.exportDelta({ b: bStamp });
  assert(partial.ok);
  assertEqual(partial.value.entries.length, 1);
  assertEqual(partial.value.entries[0]?.deviceId, 'a');
}

async function divergenceHistoryOps(): Promise<void> {
  const a = await makeEngine('a', 100);
  const b = await makeEngine('b', 200);
  // Local loser: 'max' merge makes a local count lose to a synced one.
  await mustApply(
    a.engine,
    delta([rawEntry('playCount', 'r1', 'count', 9, { l: 10, c: 0 })]),
  );
  const localLoser = await a.engine.localChange({
    kind: 'playCount',
    recordId: 'r1',
    field: 'count',
    value: 4,
  });
  assert(localLoser.ok);
  assertEqual(localLoser.value.outcome.type, 'superseded');
  const localRows = a.engine.divergenceHistory();
  assertEqual(localRows.length, 1);
  assertEqual(localRows[0]?.origin, 'local');
  // Remote loser on the other device.
  await mustApply(
    b.engine,
    delta([rawEntry('recording', 'r1', 'title', 'keep', { l: 50, c: 0 })]),
  );
  await mustApply(
    b.engine,
    delta([rawEntry('recording', 'r1', 'title', 'drop', { l: 40, c: 0 })]),
  );
  const rows = b.engine.divergenceHistory();
  assertEqual(rows.length, 1);
  assertEqual(rows[0]?.origin, 'remote');
  // Newest-first ordering + record filter.
  await mustApply(
    b.engine,
    delta([rawEntry('recording', 'r2', 'title', 'x2', { l: 70, c: 0 })]),
  );
  await mustApply(
    b.engine,
    delta([rawEntry('recording', 'r2', 'title', 'y2', { l: 60, c: 0 })]),
  );
  const all = b.engine.divergenceHistory();
  assertEqual(all.length, 2);
  assertEqual(all[0]?.recordId, 'r2');
  assertEqual(
    b.engine.divergenceHistory({ recordId: 'r1' }).length,
    1,
  );
  assertEqual(b.engine.divergenceHistory({ kind: 'entity' }).length, 0);
}

async function restoreLoser(): Promise<void> {
  const a = await makeEngine('a', 1_000);
  await mustApply(
    a.engine,
    delta([rawEntry('recording', 'r1', 'title', 'synced', { l: 900, c: 0 })]),
  );
  // A competing remote write with an older stamp loses — its value is
  // preserved in divergence, and restoring it re-issues it locally.
  await mustApply(
    a.engine,
    delta([rawEntry('recording', 'r1', 'title', 'older', { l: 10, c: 0 })]),
  );
  const row = a.engine.divergenceHistory()[0];
  assert(row !== undefined);
  assertEqual(row.loser.value, 'older');
  const restored = await a.engine.restoreLoser(row.historyId);
  assert(restored.ok, 'restore failed');
  assertEqual(restored.value.outcome.type, 'applied');
  assertDeepEqual(materialized(a.engine, 'recording', 'r1'), {
    title: 'older',
  });
  // The restore is a fresh local write — it exports like one.
  const exported = await a.engine.exportDelta();
  assert(exported.ok);
  assert(
    exported.value.entries.some(
      (e) => e.deviceId === 'a' && e.value === 'older',
    ),
    'restored value must enter the log',
  );
  // Unknown ids fail closed.
  const missing = await a.engine.restoreLoser('div-nope');
  assert(!missing.ok);
  assertEqual(missing.ok ? '' : missing.error.kind, 'not-found');
}

async function tombstoneRestore(): Promise<void> {
  const a = await makeEngine('a', 5_000);
  await mustApply(
    a.engine,
    delta([rawEntry('recording', 'r1', 'title', 'Song', { l: 10, c: 0 })]),
  );
  // A newer tombstone deletes the record…
  await mustApply(
    a.engine,
    delta([rawTombstone('recording', 'r1', { l: 20, c: 0 })]),
  );
  // …then an older tombstone arrives and loses to it. The losing
  // delete is still preserved.
  await mustApply(
    a.engine,
    delta([rawTombstone('recording', 'r1', { l: 5, c: 0 })]),
  );
  const row = a.engine
    .divergenceHistory()
    .find((d) => d.loser.tombstone);
  assert(row !== undefined, 'losing tombstone preserved');
  const restored = await a.engine.restoreLoser(row.historyId);
  assert(restored.ok);
  assertEqual(restored.value.outcome.type, 'applied');
  // Fresh delete stamp wins: the record stays deleted.
  assertEqual(materialized(a.engine, 'recording', 'r1'), undefined);
}

async function hydration(): Promise<void> {
  const store = new FakeSyncLogStore();
  const a = await makeEngine('a', 100, store);
  await mustWrite(a.engine, {
    kind: 'recording',
    recordId: 'r1',
    field: 'title',
    value: 'Song',
  });
  await mustApply(
    a.engine,
    delta([
      rawEntry('recording', 'r1', 'title', 'loser', { l: 50, c: 0 }),
      rawEntry(
        'like',
        'album:e9',
        'like',
        { entityKind: 'album', targetId: 'e9', likedAtMs: 60 },
        { l: 60, c: 0 },
      ),
    ]),
  );
  const before = a.engine.materialize();
  const divergenceBefore = a.engine.divergenceHistory().length;
  // A fresh engine on the same store rebuilds identical merge state.
  const revived = await makeEngine('a', 400, store);
  assertDeepEqual(revived.engine.materialize(), before);
  assertEqual(
    revived.engine.divergenceHistory().length,
    divergenceBefore,
  );
  assertDeepEqual(revived.engine.cursor(), a.engine.cursor());
  // The clock rehydrates above every known stamp — a new local write
  // still wins against everything synced so far.
  const wrote = await revived.engine.localChange({
    kind: 'recording',
    recordId: 'r1',
    field: 'artist',
    value: 'Someone',
  });
  assert(wrote.ok);
  assert(
    wrote.value.entry.hlc.l >= 100,
    'rehydrated clock must not regress below known stamps',
  );
  assertEqual(wrote.value.outcome.type, 'applied');
}

async function batchAndCancel(): Promise<void> {
  const a = await makeEngine('a', 100);
  const batch = await a.engine.localChangeBatch([
    { kind: 'playlist', recordId: 'p1', field: 'name', value: 'X' },
    {
      kind: 'playlistEntry',
      recordId: 'e1',
      field: 'position',
      value: 1,
    },
    { kind: 'playlist', recordId: 'p1', field: 'updatedMs', value: 7 },
  ]);
  assert(batch.ok);
  assertEqual(batch.value.length, 3);
  // Stamps are unique within one batch.
  const stamps = batch.value.map((r) => `${r.entry.hlc.l}:${r.entry.hlc.c}`);
  assertEqual(new Set(stamps).size, 3);
  // Empty batch and invalid members fail closed.
  const empty = await a.engine.localChangeBatch([]);
  assert(!empty.ok);
  const mixed = await a.engine.localChangeBatch([
    { kind: 'settings', recordId: SETTINGS_RECORD_ID, field: 'theme', value: 'dark' },
    { kind: 'settings', recordId: SETTINGS_RECORD_ID, field: 'nope', value: 1 },
  ]);
  assert(!mixed.ok, 'one invalid member rejects the batch');
  // Cancellation.
  const source = new CancellationSource();
  source.cancel();
  const cancelled = await a.engine.localChange(
    { kind: 'playlist', recordId: 'p1', field: 'name', value: 'Z' },
    source.signal,
  );
  assert(!cancelled.ok);
  assertEqual(cancelled.ok ? '' : cancelled.error.kind, 'cancelled');
}

async function storeFailures(): Promise<void> {
  const store = new FakeSyncLogStore();
  const a = await makeEngine('a', 100, store);
  store.failNextAppend(appError('unavailable', 'disk full'));
  const failed = await a.engine.localChange({
    kind: 'recording',
    recordId: 'r1',
    field: 'title',
    value: 'Song',
  });
  assert(!failed.ok);
  assertEqual(failed.ok ? '' : failed.error.kind, 'unavailable');
  // Nothing entered the in-memory log — the durable append is the gate.
  const exported = await a.engine.exportDelta();
  assert(exported.ok);
  assertEqual(exported.value.entries.length, 0);
  // The next write proceeds normally.
  const ok2 = await a.engine.localChange({
    kind: 'recording',
    recordId: 'r1',
    field: 'title',
    value: 'Song',
  });
  assert(ok2.ok);
}

async function divergenceCap(): Promise<void> {
  const b = await makeEngine('b');
  await mustApply(
    b.engine,
    delta([rawEntry('recording', 'r1', 'title', 'winner', { l: 1e9, c: 0 })]),
  );
  // One delta of many losing writes over-fills the bounded history.
  const losers = Array.from({ length: DIVERGENCE_HISTORY_LIMIT + 25 }, (_, i) =>
    rawEntry(
      'recording',
      'r1',
      'title',
      `loser-${i}`,
      { l: 100 + i, c: 0 },
    ),
  );
  await mustApply(b.engine, delta(losers));
  const rows = b.engine.divergenceHistory();
  assertEqual(rows.length, DIVERGENCE_HISTORY_LIMIT);
  // Newest retained: the oldest losers were dropped.
  assertEqual(rows[0]?.loser.value, `loser-${DIVERGENCE_HISTORY_LIMIT + 24}`);
}

// ---- property harness -------------------------------------------------------

// Deterministic xorshift32.
function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

const PROP_RECORDS = ['r1', 'r2'] as const;

function pick<T>(rand: () => number, xs: readonly T[]): T {
  const chosen = xs[rand() % xs.length];
  assert(chosen !== undefined, 'pick from empty list');
  return chosen;
}

const PROP_WRITES: readonly {
  kind: 'recording';
  field: string;
  gen: (r: () => number) => unknown;
}[] = [
  { kind: 'recording', field: 'title', gen: (r) => `t${r() % 5}` },
  { kind: 'recording', field: 'artist', gen: (r) => `a${r() % 5}` },
  { kind: 'recording', field: 'genre', gen: (r) => `g${r() % 3}` },
];

function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function entryKey(e: ChangeEntry): string {
  return JSON.stringify([e.deviceId, e.hlc.l, e.hlc.c]);
}

function slotKey(e: ChangeEntry): string {
  return JSON.stringify([e.kind, e.recordId, e.field]);
}

function recordKey(e: ChangeEntry): string {
  return JSON.stringify([e.kind, e.recordId]);
}

function entryLess(a: ChangeEntry, b: ChangeEntry): boolean {
  const s = compareStamp(a.hlc, b.hlc);
  if (s !== 0) {
    return s < 0;
  }
  return a.deviceId < b.deviceId;
}

/** Canonical field winners: per (kind,recordId,field), the max entry. */
function expectedWinners(
  entries: readonly ChangeEntry[],
): Map<string, ChangeEntry> {
  const winners = new Map<string, ChangeEntry>();
  for (const e of entries) {
    if (e.tombstone) {
      continue;
    }
    const slot = slotKey(e);
    const cur = winners.get(slot);
    if (e.kind === 'playCount') {
      // 'max' semilattice: larger value wins; exact tie → later stamp.
      if (
        cur === undefined ||
        (typeof e.value === 'number' &&
          typeof cur.value === 'number' &&
          (e.value > cur.value ||
            (e.value === cur.value && entryLess(cur, e))))
      ) {
        winners.set(slot, e);
      }
    } else if (cur === undefined || entryLess(cur, e)) {
      winners.set(slot, e);
    }
  }
  return winners;
}

/** Canonical record tombstones: per (kind,recordId), the max tombstone. */
function expectedTombstones(
  entries: readonly ChangeEntry[],
): Map<string, ChangeEntry> {
  const winners = new Map<string, ChangeEntry>();
  for (const e of entries) {
    if (!e.tombstone) {
      continue;
    }
    const slot = recordKey(e);
    const cur = winners.get(slot);
    if (cur === undefined || entryLess(cur, e)) {
      winners.set(slot, e);
    }
  }
  return winners;
}

/** Reference materialize straight from the entry set. */
function expectedMaterialize(
  entries: readonly ChangeEntry[],
): { kind: string; recordId: string; fields: Record<string, unknown> }[] {
  const fieldWinners = expectedWinners(entries);
  const tombs = expectedTombstones(entries);
  const byRecord = new Map<
    string,
    { kind: string; recordId: string; fields: Record<string, unknown> }
  >();
  for (const e of entries) {
    if (e.tombstone || fieldWinners.get(slotKey(e)) !== e) {
      continue;
    }
    const tomb = tombs.get(recordKey(e));
    if (tomb !== undefined && !entryLess(tomb, e)) {
      continue; // field predates the winning delete — dead at read time
    }
    const key = recordKey(e);
    let rec = byRecord.get(key);
    if (rec === undefined) {
      rec = { kind: e.kind, recordId: e.recordId, fields: {} };
      byRecord.set(key, rec);
    }
    rec.fields[e.field] = e.value;
  }
  const out = [...byRecord.values()];
  out.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind < b.kind ? -1 : 1;
    }
    return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
  });
  return out;
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rand() % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

async function propertyHarness(): Promise<void> {
  const DEVICES = ['d0', 'd1', 'd2'] as const;
  for (let seed = 1; seed <= 200; seed += 1) {
    const rand = xorshift32(seed);
    const devices: SyncEngine[] = [];
    for (const id of DEVICES) {
      devices.push((await makeEngine(id, 1_000 + (rand() % 500))).engine);
    }
    // Each device performs a handful of local ops on a small key space
    // so concurrent writes collide by construction.
    for (const d of devices) {
      const ops = 3 + (rand() % 4);
      for (let i = 0; i < ops; i += 1) {
        const recordId = pick(rand, PROP_RECORDS);
        const p = rand() % 10;
        let input: LocalWrite;
        if (p < 2) {
          input = { kind: 'recording', recordId, tombstone: true };
        } else if (p < 4) {
          input = {
            kind: 'playCount',
            recordId,
            field: 'count',
            value: rand() % 10,
          };
        } else if (p === 4) {
          input = {
            kind: 'settings',
            recordId: SETTINGS_RECORD_ID,
            field: 'theme',
            value: pick(rand, ['dark', 'light', 'oled', 'system']),
          };
        } else if (p === 5) {
          input = {
            kind: 'playlistEntry',
            recordId: 'e1',
            field: 'position',
            value: rand() % 100,
          };
        } else {
          const f = pick(rand, PROP_WRITES);
          input = {
            kind: f.kind,
            recordId,
            field: f.field,
            value: f.gen(rand),
          };
        }
        const wrote = await d.localChange(input);
        assert(
          wrote.ok,
          `seed ${seed}: local write failed ${JSON.stringify(input)}`,
        );
      }
    }
    // The wire universe: union of every device's full export — relayed
    // entries included — deduped by entry key.
    const all = new Map<string, ChangeEntry>();
    for (const d of devices) {
      const exported = await d.exportDelta();
      assert(exported.ok);
      for (const e of exported.value.entries) {
        all.set(entryKey(e), e);
      }
    }
    const universe = [...all.values()];

    // Two replay engines consume the universe chunked into deltas in
    // two different shuffles — the reorder case.
    const chunkApply = async (
      engine: SyncEngine,
      entries: ChangeEntry[],
      randFn: () => number,
    ): Promise<void> => {
      const ordered = shuffled(entries, randFn);
      const size = Math.max(1, Math.ceil(ordered.length / 3));
      for (let i = 0; i < ordered.length; i += size) {
        const doc = delta(ordered.slice(i, i + size), 'wire');
        const applied = await engine.applyDelta(
          JSON.parse(JSON.stringify(doc)) as unknown,
        );
        assert(applied.ok, `seed ${seed}: apply failed`);
      }
    };
    const replayA = (await makeEngine('x1', 777)).engine;
    const replayB = (await makeEngine('x2', 888)).engine;
    await chunkApply(replayA, universe, xorshift32(seed * 7 + 1));
    await chunkApply(replayB, universe, xorshift32(seed * 13 + 3));

    // Each live device then receives every other device's full export;
    // its own entries come back as duplicates.
    for (const d of devices) {
      for (const other of devices) {
        if (other === d) {
          continue;
        }
        const exported = await other.exportDelta();
        assert(exported.ok);
        const applied = await d.applyDelta(
          JSON.parse(
            JSON.stringify(
              delta(exported.value.entries, other.deviceId),
            ),
          ) as unknown,
        );
        assert(applied.ok, `seed ${seed}: live apply failed`);
      }
    }

    // CONVERGENCE: identical entry set → identical materialized state
    // on every engine, regardless of apply order. assertDeepEqual is
    // key-order-insensitive — field insertion order legitimately
    // varies with merge order.
    const expected = expectedMaterialize(universe);
    devices.forEach((d, i) => {
      assertDeepEqual(
        d.materialize(),
        expected,
        `seed ${seed} device ${i}: convergence`,
      );
    });
    assertDeepEqual(
      replayA.materialize(),
      expected,
      `seed ${seed} replayA: convergence`,
    );
    assertDeepEqual(
      replayB.materialize(),
      expected,
      `seed ${seed} replayB: convergence`,
    );

    // NO-LOSS: every losing value is recoverable — it either survived
    // verbatim as the slot winner, or sits in divergence history.
    const fieldWinners = expectedWinners(universe);
    const tombs = expectedTombstones(universe);
    devices.forEach((d, i) => {
      const rows = d.divergenceHistory();
      for (const e of universe) {
        if (e.tombstone) {
          if (tombs.get(recordKey(e)) === e) {
            continue; // the winning delete
          }
          const kept = rows.some(
            (r) =>
              r.loser.tombstone &&
              r.loser.deviceId === e.deviceId &&
              r.loser.hlc.l === e.hlc.l &&
              r.loser.hlc.c === e.hlc.c,
          );
          assert(
            kept,
            `seed ${seed} device ${i}: losing tombstone ${entryKey(e)} not preserved`,
          );
          continue;
        }
        const slot = slotKey(e);
        const winner = fieldWinners.get(slot);
        if (winner === e) {
          continue; // live
        }
        // Dead field write: either its value still wins the slot
        // verbatim (lost on equal value), or a divergence row on the
        // same slot preserves it.
        const survived =
          (winner !== undefined && jsonEquals(winner.value, e.value)) ||
          rows.some(
            (r) =>
              r.kind === e.kind &&
              r.recordId === e.recordId &&
              r.field === e.field &&
              jsonEquals(r.loser.value, e.value),
          );
        assert(
          survived,
          `seed ${seed} device ${i}: losing value ${JSON.stringify(e.value)} for ${slot} lost without trace`,
        );
      }
    });
  }
}

export async function run(): Promise<void> {
  await basicWrites();
  await localWriteValidation();
  await deltaRoundTrip();
  await fieldLww();
  await playlistOccurrenceOrder();
  await playCountMerge();
  await tombstoneRules();
  await whitelistOnApply();
  await boundedHistoryWindow();
  await duplicatesAndWatermarks();
  await divergenceHistoryOps();
  await restoreLoser();
  await tombstoneRestore();
  await hydration();
  await batchAndCancel();
  await storeFailures();
  await divergenceCap();
  await propertyHarness();
}
