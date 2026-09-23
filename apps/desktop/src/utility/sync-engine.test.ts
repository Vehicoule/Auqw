import type { ApplyResult, SyncDelta } from '@auqw/application';
import {
  assert,
  assertDeepEqual,
  assertEqual,
  FakeSyncLogStore,
} from '@auqw/application/testing';
import { createClock, createIds, createLog } from '../renderer/runtime.ts';
import {
  createUtilitySyncEngine,
  type UtilitySyncEngine,
} from './sync-engine.ts';

/**
 * The SyncEngine→SyncEnginePort adapter: string cursors, doc
 * passthrough, and strict-JSON results (the wire's `isSyncDeltaDoc`
 * backstop). Engine semantics themselves live in the application's
 * own tests — here only the boundary shape is proven.
 */

async function engineAt(deviceId: string): Promise<UtilitySyncEngine> {
  const built = await createUtilitySyncEngine({
    store: new FakeSyncLogStore(),
    clock: createClock(),
    ids: createIds(),
    log: createLog(() => {}),
    deviceId,
  });
  assert(built.ok, `engine build failed: ${JSON.stringify(built)}`);
  if (!built.ok) {
    throw new Error('unreachable');
  }
  return built.value;
}

function writeName(recordId: string, value: string) {
  return {
    kind: 'playlist',
    recordId,
    field: 'name',
    value,
  } as const;
}

export async function run(): Promise<void> {
  // —— localChanges stamps entries the export then carries ——
  {
    const engine = await engineAt('dsk-a');
    const changed = await engine.localChanges(
      [writeName('pl-1', 'road tunes')],
      undefined,
    );
    assert(changed.ok, `localChanges failed: ${JSON.stringify(changed)}`);
    const exported = await engine.port.exportDelta('', undefined);
    assert(exported.ok, `export failed: ${JSON.stringify(exported)}`);
    if (!exported.ok) {
      return;
    }
    const delta = exported.value as SyncDelta;
    assertEqual(delta.senderDeviceId, 'dsk-a');
    assertEqual(delta.entries.length, 1);
    assertEqual(delta.entries[0]?.recordId, 'pl-1');
    assertEqual(delta.entries[0]?.deviceId, 'dsk-a');
    // Results ride strict JSON — they must survive the wire's
    // serializer without a toJSON path.
    assertDeepEqual(
      JSON.parse(JSON.stringify(delta)),
      delta,
    );
  }

  // —— '' means a full snapshot; a returned cursor continues the stream ——
  {
    const engine = await engineAt('dsk-b');
    const first = await engine.localChanges(
      [writeName('pl-1', 'one')],
      undefined,
    );
    assert(first.ok);
    const exported1 = await engine.port.exportDelta('', undefined);
    assert(exported1.ok);
    if (!exported1.ok) {
      return;
    }
    const delta1 = exported1.value as SyncDelta;
    const cursor1 = JSON.stringify(delta1.cursor);

    const second = await engine.localChanges(
      [writeName('pl-2', 'two')],
      undefined,
    );
    assert(second.ok);

    // Round-trip: the cursor the peer last got back to us is the
    // string we now answer.
    const exported2 = await engine.port.exportDelta(cursor1, undefined);
    assert(exported2.ok, `export failed: ${JSON.stringify(exported2)}`);
    if (!exported2.ok) {
      return;
    }
    const delta2 = exported2.value as SyncDelta;
    assertEqual(delta2.entries.length, 1);
    assertEqual(delta2.entries[0]?.recordId, 'pl-2');
  }

  // —— A malformed cursor is a typed error, not a thrown JSON.parse ——
  {
    const engine = await engineAt('dsk-c');
    for (const since of ['not-json', '{"a":"x"}', '[1,2,3]']) {
      const exported = await engine.port.exportDelta(since, undefined);
      assert(!exported.ok, `expected err for ${since}`);
      if (!exported.ok) {
        assertEqual(exported.error.kind, 'invalid-response');
      }
    }
  }

  // —— applyDelta forwards the doc; the transport's deviceId is ignored ——
  {
    const source = await engineAt('dsk-source');
    await source.localChanges([writeName('pl-9', 'shared')], undefined);
    const exported = await source.port.exportDelta('', undefined);
    assert(exported.ok);
    if (!exported.ok) {
      return;
    }
    const sink = await engineAt('dsk-sink');
    // The entry itself carries 'dsk-source'; the transport-supplied id
    // must not rewrite it.
    const applied = await sink.port.applyDelta(
      JSON.parse(JSON.stringify(exported.value)),
      'dsk-transport',
      undefined,
    );
    assert(applied.ok, `apply failed: ${JSON.stringify(applied)}`);
    if (!applied.ok) {
      return;
    }
    const result = applied.value as ApplyResult;
    assertEqual(result.senderDeviceId, 'dsk-source');
    assertEqual(result.entries.length, 1);
    assertEqual(result.entries[0]?.deviceId, 'dsk-source');
    assertDeepEqual(result.cursor, { 'dsk-source': 1 });
  }

  // —— localChanges validates writes through the engine's own rules ——
  {
    const engine = await engineAt('dsk-d');
    const bad = await engine.localChanges(
      [{ kind: 'playlist', recordId: 'pl-x', field: 'bogus', value: 1 }],
      undefined,
    );
    // Engine validation fails the batch typed — a field outside the
    // whitelist is 'not-applicable', not a per-write reject.
    assert(!bad.ok, `batch should fail: ${JSON.stringify(bad)}`);
    if (!bad.ok) {
      assertEqual(bad.error.kind, 'not-applicable');
    }
  }

  console.log('sync-engine adapter tests passed');
}
