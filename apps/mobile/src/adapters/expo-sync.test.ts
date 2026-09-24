// expo-sync projection seam: `createExpoSync`'s `onApplied` must fire
// on EVERY successful applyDelta (syncNow pages and direct engine
// calls alike), and a drained merge must materialize into a real
// Session — the same convergence the desktop proves on the wire.
import type {
  ApplyResult,
  ClockPort,
  SyncClientKeys,
  SyncIdentity,
  SyncPeer,
} from '@auqw/application';
import {
  appError,
  createSyncEngine,
  err,
  ok,
  Session,
} from '@auqw/application';
import {
  assert,
  assertEqual,
  FakeLog,
  FakePlayer,
  FakeProvider,
  FakeStorage,
  FakeSyncLogStore,
  SequenceIds,
} from '@auqw/application/testing';
import type {
  AuqwExpoSubscription,
  AuqwSyncNative,
} from './auqw-expo-surface.ts';
import { base64Encode } from './noble-sync-crypto.ts';
import { createExpoSync } from './expo-sync.ts';

const clock: ClockPort = {
  nowMs: () => Date.now(),
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal.cancelled) {
        resolve(err(appError('cancelled', 'sleep cancelled')));
        return;
      }
      const unsub = signal.subscribe(() => {
        clearTimeout(timer);
        resolve(err(appError('cancelled', 'sleep cancelled')));
      });
      const timer = setTimeout(() => {
        unsub();
        resolve(ok(undefined));
      }, ms);
    });
  },
};

function memoryClientKeys(): SyncClientKeys {
  const state: {
    identity: { deviceId: string; identity: SyncIdentity } | null;
    map: Map<string, SyncPeer>;
  } = { identity: null, map: new Map() };
  return {
    async identityGet() {
      return ok(state.identity);
    },
    async identitySet(record) {
      state.identity = record;
      return ok(undefined);
    },
    async peerList() {
      return ok([...state.map.values()]);
    },
    async peerPut(peer) {
      state.map.set(peer.fp, peer);
      return ok(undefined);
    },
    async peerDelete(fp) {
      state.map.delete(fp);
      return ok(undefined);
    },
  };
}

// No sockets ever open in this test — the apply path is exercised
// directly on the wrapped engine — but the surface must still be
// fully shaped so construction can't touch an undefined member.
function fakeHost(): AuqwSyncNative {
  const sub: AuqwExpoSubscription = { remove() {} };
  return {
    syncConnect: async () => ({ remoteAddress: null }),
    syncSend: async () => undefined,
    syncClose: async () => undefined,
    syncDestroy: async () => undefined,
    // Deterministic bytes — this test needs entropy only in shape.
    syncRandomBytes: (length) =>
      base64Encode(new Uint8Array(length).fill(0xab)),
    addSyncSocketDataListener: () => sub,
    addSyncSocketClosedListener: () => sub,
  };
}

async function realEngine(deviceId: string) {
  const built = await createSyncEngine({
    store: new FakeSyncLogStore(),
    clock,
    ids: new SequenceIds(),
    log: new FakeLog(),
    deviceId,
  });
  assert(built.ok, `engine build failed for ${deviceId}`);
  if (!built.ok) {
    throw new Error('unreachable');
  }
  return built.value;
}

function newSession(): Session {
  const empty = {
    recordings: [],
    likes: [],
    entities: [],
    entitySourceRefs: [],
    playlists: [],
    playlistEntries: [],
    playHistory: [],
    playCounts: [],
    matchReviews: [],
    lyricsCache: [],
    artworkCache: [],
    downloads: [],
    localSources: [],
    localFiles: [],
    queue: {
      revision: 0,
      occurrences: [],
      currentOccurrenceId: null,
      positionMs: 0,
      mode: 'stopped' as const,
    },
    settings: {
      catalogProvider: 'itunes',
      playbackProvider: 'youtube-music',
      storefront: 'US',
      qualityKbps: 256,
      theme: 'system' as const,
      prefetch: true,
    },
  };
  return new Session({
    storage: new FakeStorage(empty),
    player: new FakePlayer(),
    providers: [
      new FakeProvider('itunes'),
      new FakeProvider('youtube-music'),
    ],
    clock,
    ids: new SequenceIds(),
    log: new FakeLog(),
    defaults: empty.settings,
    localPlaybackFor: () => null,
    isOnline: () => true,
  });
}

async function appliedDeltaProjects(): Promise<void> {
  // The phone: a real engine whose export becomes the inbound delta.
  const phone = await realEngine('phone-m-1');
  const write = await phone.localChangeBatch(
    [
      {
        kind: 'playlist',
        recordId: 'pl-remote',
        field: 'name',
        value: 'from-phone',
      },
    ],
    undefined,
  );
  assert(write.ok, 'phone localChanges failed');
  const exported = await phone.exportDelta({}, undefined, undefined);
  assert(exported.ok, 'phone exportDelta failed');
  if (!exported.ok) {
    return;
  }

  // The handset surface with the domain-projection seam installed.
  const applied: ApplyResult[] = [];
  const surface = await createExpoSync({
    host: fakeHost(),
    logStore: new FakeSyncLogStore(),
    // Stable-install stand-in — custody mints the wire deviceId from
    // this port, and the pattern wants ≥8 chars.
    ids: { next: () => 'mobile-m-1' },
    clock,
    log: new FakeLog(),
    keys: memoryClientKeys(),
    onApplied: (result) => applied.push(result),
  });
  assert(surface.ok, `createExpoSync: ${JSON.stringify(surface)}`);
  if (!surface.ok) {
    return;
  }

  // Direct applyDelta on the surface engine — the path EVERY inbound
  // caller shares — must notify exactly once with the merge result.
  const session = newSession();
  try {
    const restored = await session.restore();
    assert(restored.ok, 'session restore failed');
    const merged = await surface.value.engine.applyDelta(
      exported.value,
      undefined,
    );
    assert(merged.ok, `applyDelta: ${JSON.stringify(merged)}`);
    assertEqual(applied.length, 1);
    assert(
      applied[0] !== undefined && applied[0].outcomes.length > 0,
      'onApplied received the merge outcomes',
    );

    // The production hook feeds applied.outcomes into the session.
    const projected = await session.applySyncedEntries(
      applied[0].outcomes,
    );
    assert(projected.ok, `applySyncedEntries: ${JSON.stringify(projected)}`);
    const state = session.snapshot();
    assert(state.type === 'ready');
    const list = state.playlists.find(
      (p) => p.playlistId === 'pl-remote',
    );
    assert(list !== undefined, 'remote playlist materialized');
    assertEqual(list?.name, 'from-phone');
  } finally {
    await surface.value.client.close();
    await session.dispose();
  }
}

export async function run(): Promise<void> {
  await appliedDeltaProjects();
}
