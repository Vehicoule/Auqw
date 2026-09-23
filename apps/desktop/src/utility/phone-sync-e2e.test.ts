import { once } from 'node:events';
import { createConnection, Socket } from 'node:net';
import { randomBytes as nodeRandom } from 'node:crypto';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import {
  FakeSyncLogStore,
  FakeLog,
  FakePlayer,
  FakeProvider,
  FakeStorage,
  SequenceIds,
} from '@auqw/application/testing';
import type {
  CancellationSignal,
  ClockPort,
  MergeOutcome,
  Result,
  SyncClientKeys,
  SyncEngine,
  SyncIdentity,
  SyncPeer,
  SyncSocket,
  SyncSocketPort,
} from '@auqw/application';
import {
  appError,
  createSyncClient,
  createSyncEngine,
  createSyncEnginePort,
  ensureSyncIdentity,
  err,
  ok,
  Session,
} from '@auqw/application';
import {
  base64Decode,
  base64Encode,
  createNobleIdentity,
  createNobleSyncCrypto,
} from '../../../mobile/src/adapters/noble-sync-crypto.ts';
import { createMemoryKeys } from './sync-keys.ts';
import {
  createNoiseV1Cipher,
  fingerprintOf,
  generateIdentity,
  isClientHello,
  type SyncIdentity as DesktopIdentity,
} from './sync-crypto.ts';
import { createSyncService, type SyncService } from './sync-server.ts';
import { isRecord } from '../shared/check.ts';

/**
 * The phone leg's loopback proof: the REAL mobile client
 * (packages/application/src/sync/sync-client.ts + the noble crypto
 * and socket adapters that ship in apps/mobile) driven over real
 * 127.0.0.1 sockets into the REAL desktop service — the same
 * createSyncService the Electron shell wires, with real SyncEngines
 * on both ends. What the scripted-fake unit tests cannot show —
 * noble↔node:crypto byte interop, real TCP framing, and true service
 * behavior — this file proves end to end.
 *
 * Lives here (not apps/mobile) because it needs node — net, crypto
 * interop vectors, and the desktop service under test.
 */

/* --------------------------- node socket ---------------------------- */

function asSyncSocket(socket: Socket): SyncSocket {
  return {
    get remoteAddress() {
      return socket.remoteAddress;
    },
    write(data: Uint8Array): void {
      socket.write(Buffer.from(data));
    },
    on(event: string, listener: (...args: never[]) => void): unknown {
      // never-args is a supertype — any emitter payload satisfies it.
      return socket.on(event, listener as (...args: unknown[]) => void);
    },
    end(): void {
      socket.end();
    },
    destroy(): void {
      socket.destroy();
    },
  };
}

function createNodeSyncSockets(): SyncSocketPort {
  return {
    async connect({ host, port, timeoutMs, signal }) {
      const socket = createConnection({ host, port });
      const timer = setTimeout(() => {
        socket.destroy(new Error('sync: dial timeout'));
      }, timeoutMs);
      try {
        await once(socket, 'connect');
      } catch {
        clearTimeout(timer);
        return err(appError('unavailable', 'sync: dial failed'));
      }
      clearTimeout(timer);
      if (signal?.cancelled === true) {
        socket.destroy();
        return err(appError('cancelled', 'sync: dial cancelled'));
      }
      return ok<SyncSocket>(asSyncSocket(socket));
    },
  };
}

/* ----------------------------- custody ------------------------------ */

function memoryClientKeys(): SyncClientKeys & {
  readonly map: Map<string, SyncPeer>;
} {
  const state: {
    identity: { deviceId: string; identity: SyncIdentity } | null;
    map: Map<string, SyncPeer>;
  } = { identity: null, map: new Map() };
  return {
    map: state.map,
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

/* ------------------------------ clock ------------------------------- */

const realClock: ClockPort = {
  nowMs: () => Date.now(),
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal.cancelled) {
        resolve(err(appError('cancelled', 'sleep cancelled')));
        return;
      }
      const timer = setTimeout(() => {
        unsub();
        resolve(ok(undefined));
      }, ms);
      const unsub = signal.subscribe(() => {
        clearTimeout(timer);
        resolve(err(appError('cancelled', 'sleep cancelled')));
      });
    });
  },
};

/* ------------------------------ rig --------------------------------- */

const random = (n: number): Uint8Array => new Uint8Array(nodeRandom(n));

async function realEngine(deviceId: string): Promise<SyncEngine> {
  const engine = await createSyncEngine({
    store: new FakeSyncLogStore(),
    clock: realClock,
    ids: new SequenceIds(),
    log: new FakeLog(),
    deviceId,
  });
  if (!engine.ok) {
    throw new Error(`engine failed: ${engine.error.kind}`);
  }
  return engine.value;
}

async function startService(engine: SyncEngine): Promise<{
  service: SyncService;
  keys: ReturnType<typeof createMemoryKeys>;
  port: number;
}> {
  const keys = createMemoryKeys();
  const service = createSyncService({
    host: '127.0.0.1',
    port: 0,
    keys,
    engine: createSyncEnginePort(engine),
    deviceName: 'auqw-desk',
    endpointHost: '127.0.0.1',
    advertise: () => ({ close() {} }),
    handshakeMs: 5_000,
    idleMs: 30_000,
  });
  const status = await service.ready;
  assertEqual(status.listener, 'listening', 'service binds');
  assert(status.boundPort !== null);
  return { service, keys, port: status.boundPort };
}

async function pairingPayload(service: SyncService): Promise<string> {
  const handler = service.handlers['sync:pairing'];
  assert(handler !== undefined);
  const result: unknown = await handler(undefined);
  assert(isRecord(result) && typeof result['payload'] === 'string');
  return result['payload'];
}

async function makeClient(opts: {
  engine: SyncEngine;
  keys: SyncClientKeys;
  deviceId: string;
}) {
  // Production wiring order: custody owns the device identity; the
  // crypto suite is constructed from whatever custody minted/loaded.
  // installId stands in for the app's stable install-id port.
  const installId = { next: () => opts.deviceId };
  const custody = await ensureSyncIdentity({
    keys: opts.keys,
    crypto: { createIdentity: () => createNobleIdentity(random) },
    ids: installId,
  });
  assert(custody.ok, 'identity custody');
  assertEqual(custody.value.deviceId, opts.deviceId);
  const crypto = createNobleSyncCrypto({
    identity: custody.value.identity,
    randomBytes: random,
  });
  return createSyncClient({
    sockets: createNodeSyncSockets(),
    crypto,
    keys: opts.keys,
    engine: opts.engine,
    ids: new SequenceIds(),
    clock: realClock,
    log: new FakeLog(),
    deviceId: opts.deviceId,
    name: 'auqw-phone',
    connectMs: 5_000,
    handshakeMs: 5_000,
    requestMs: 10_000,
    pingMs: 60_000,
  });
}

async function seedEntry(
  engine: SyncEngine,
  recordId: string,
  value: string,
): Promise<void> {
  const write = await engine.localChange({
    kind: 'playlist',
    recordId,
    field: 'name',
    value,
  });
  assert(write.ok, `localChange failed: ${JSON.stringify(write)}`);
}

async function exported(
  engine: SyncEngine,
): Promise<{ entries: readonly unknown[] }> {
  const delta = await engine.exportDelta();
  assert(delta.ok);
  return delta.value;
}

/* ------------------------------ tests ------------------------------- */

// Noble crypto interop — byte-exact vs the desktop's node:crypto
// construction, proven at the handshake and frame layers.
async function cryptoVectors(): Promise<void> {
  // base64 matches Buffer exactly, both directions.
  for (const bytes of [
    new Uint8Array(0),
    new Uint8Array([1]),
    new Uint8Array([1, 2]),
    random(31),
    random(32),
    random(48),
    random(1024),
  ]) {
    const ours = base64Encode(bytes);
    assertEqual(ours, Buffer.from(bytes).toString('base64'));
    const back = base64Decode(ours);
    assert(back !== null);
    assertDeepEqual([...back], [...bytes]);
  }
  assert(base64Decode('!!!') === null);
  assert(base64Decode('abc') === null);

  const serverIdentity = generateIdentity();
  const clientIdentity = generateIdentity();
  const cipher = createNoiseV1Cipher(serverIdentity);
  const crypto = createNobleSyncCrypto({
    identity: clientIdentity,
    randomBytes: random,
  });

  // Minted identity: priv derives pub byte-for-byte, hello passes the
  // server's validators.
  const minted = crypto.createIdentity();
  assert(/^[0-9a-f]{64}$/.test(fingerprintOf(minted.pub)));
  const handshake = crypto.begin({ deviceId: 'phone-e2e-1', name: 'p' });
  const hello = handshake.hello();
  assert(isClientHello(hello), 'server accepts our hello');

  // Real server accepts + answers; we complete its challenge and both
  // codecs open each other's frames byte-exact.
  const accepted = cipher.accept(hello, { registered: false });
  const challenge = JSON.parse(accepted.challenge.toString('utf8'));
  const completed = handshake.complete(challenge, {
    pinnedFp: fingerprintOf(serverIdentity.pub),
  });
  assert(completed.ok, 'challenge completes');
  assertEqual(completed.value.registered, false);
  assertDeepEqual(completed.value.serverFp, fingerprintOf(serverIdentity.pub));

  const c2s = new TextEncoder().encode('{"t":"pair","code":"123456"}');
  const s2c = new TextEncoder().encode('{"t":"welcome"}');
  assertDeepEqual(
    [...accepted.codec.open(completed.value.codec.seal(c2s))],
    [...c2s],
    'server opens our seal',
  );
  assertDeepEqual(
    [...completed.value.codec.open(accepted.codec.seal(s2c))],
    [...s2c],
    'we open server seal',
  );

  // Sequence binding holds — a reordered frame throws on open.
  const a = completed.value.codec.seal(new TextEncoder().encode('"a"'));
  const b = completed.value.codec.seal(new TextEncoder().encode('"b"'));
  try {
    accepted.codec.open(b);
    assert(false, 'out-of-order frame opened');
  } catch (thrown) {
    assert(thrown instanceof Error && thrown.message.includes('sequence'));
  }
  assertDeepEqual([...accepted.codec.open(a)], [...new TextEncoder().encode('"a"')]);
  void b;

  // Pinned-fingerprint mismatch → permission-denied, typed.
  const hs2 = crypto.begin({ deviceId: 'phone-e2e-1', name: 'p' });
  const acc2 = cipher.accept(hs2.hello(), { registered: true });
  const ch2 = JSON.parse(acc2.challenge.toString('utf8'));
  const miss = hs2.complete(ch2, { pinnedFp: 'f'.repeat(64) });
  assert(!miss.ok && miss.error.kind === 'permission-denied');

  // Garbage key material → invalid-response, never a raw throw.
  const hs3 = crypto.begin({ deviceId: 'phone-e2e-1', name: 'p' });
  const bad = hs3.complete(
    {
      v: 1,
      kind: 'challenge',
      eph: 'not-a-key',
      salt: 'bm90LXNhbHQ=',
      spub: 'bad',
      registered: false,
    },
    {},
  );
  assert(!bad.ok && bad.error.kind === 'invalid-response');
}

// The headline proof: QR payload → hello→challenge→pair→welcome on
// real sockets + real crypto, then a sync round converges both real
// engines — phone edit lands on the desktop, desktop edit lands on
// the phone.
async function pairAndConverge(): Promise<void> {
  const deskEngine = await realEngine('desk-e2e-1');
  const { service, port } = await startService(deskEngine);
  const phoneKeys = memoryClientKeys();
  const phoneEngine = await realEngine('phone-e2e-1');
  const client = await makeClient({
    engine: phoneEngine,
    keys: phoneKeys,
    deviceId: 'phone-e2e-1',
  });
  try {
    const payload = await pairingPayload(service);
    // The QR carries the real bound endpoint.
    const parsed = JSON.parse(payload);
    assert(parsed.endpoints.includes(`127.0.0.1:${port}`));

    const paired = await client.pair({ payload });
    assert(paired.ok, `pair failed: ${JSON.stringify(paired)}`);
    assertDeepEqual(paired.value.fp, parsed.fp);
    assertEqual(client.status().peers.length, 1);
    assertEqual(client.status().peers[0]?.state, 'open');

    // Phone-side and desktop-side edits both flow.
    await seedEntry(phoneEngine, 'pl-phone', 'from-phone');
    await seedEntry(deskEngine, 'pl-desk', 'from-desk');
    const round = await client.syncNow(paired.value.fp);
    assert(round.ok, `syncNow failed: ${JSON.stringify(round)}`);
    assert(round.value.sentEntries >= 1, 'phone edit exported');
    assert(round.value.remoteEntries >= 1, 'desktop edit imported');

    const phoneDelta = await exported(phoneEngine);
    const deskDelta = await exported(deskEngine);
    const phoneHas = (id: string) =>
      phoneDelta.entries.some(
        (e) => isRecord(e) && e['recordId'] === id,
      );
    const deskHas = (id: string) =>
      deskDelta.entries.some(
        (e) => isRecord(e) && e['recordId'] === id,
      );
    assert(phoneHas('pl-desk'), 'phone merged desktop entry');
    assert(deskHas('pl-phone'), 'desktop merged phone entry');
  } finally {
    await client.close();
    await service.close();
  }
}

// A wrong code is a typed reject — and the device never registers.
async function wrongCodeRejected(): Promise<void> {
  const deskEngine = await realEngine('desk-e2e-2');
  const { service, keys } = await startService(deskEngine);
  const phoneEngine = await realEngine('phone-e2e-2');
  const phoneKeys = memoryClientKeys();
  const client = await makeClient({
    engine: phoneEngine,
    keys: phoneKeys,
    deviceId: 'phone-e2e-2',
  });
  try {
    const payload = await pairingPayload(service);
    const parsed = JSON.parse(payload);
    const bad = { ...parsed, code: '000000' };
    const paired = await client.pair({ payload: JSON.stringify(bad) });
    assert(!paired.ok, 'bad code paired');
    assertEqual(paired.error.kind, 'permission-denied');
    // The server registry stays empty — a rejected pair mints nothing.
    assertEqual(keys.records.size, 0, 'no device registered');
  } finally {
    await client.close();
    await service.close();
  }
}

// Resume path: after pairing, a second syncNow reuses custody — the
// resume auth flows and another round merges.
async function resumeSync(): Promise<void> {
  const deskEngine = await realEngine('desk-e2e-3');
  const { service } = await startService(deskEngine);
  const phoneEngine = await realEngine('phone-e2e-3');
  const phoneKeys = memoryClientKeys();
  const client = await makeClient({
    engine: phoneEngine,
    keys: phoneKeys,
    deviceId: 'phone-e2e-3',
  });
  try {
    const payload = await pairingPayload(service);
    const paired = await client.pair({ payload });
    assert(paired.ok);
    await client.close();

    // A fresh client over the SAME custody resumes without a code.
    const client2 = await makeClient({
      engine: phoneEngine,
      keys: phoneKeys,
      deviceId: 'phone-e2e-3',
    });
    await seedEntry(deskEngine, 'pl-desk-2', 'after-resume');
    const round = await client2.syncNow(paired.value.fp);
    assert(round.ok, `resume failed: ${JSON.stringify(round)}`);
    const phoneDelta = await exported(phoneEngine);
    assert(
      phoneDelta.entries.some(
        (e) => isRecord(e) && e['recordId'] === 'pl-desk-2',
      ),
      'resumed round merged',
    );
    await client2.close();
  } finally {
    await service.close();
  }
}

// The convergence proof: a phone write rides the wire into the desk
// engine, queues in the applied outbox, drains through the IPC seam,
// and materializes into a REAL application Session's sections — the
// exact renderer path (sync:drainApplied → session.applySyncedEntries).
async function drainProjectsIntoSession(): Promise<void> {
  const deskEngine = await realEngine('desk-e2e-5');
  const { service, port } = await startService(deskEngine);
  const phoneKeys = memoryClientKeys();
  const phoneEngine = await realEngine('phone-e2e-5');
  const client = await makeClient({
    engine: phoneEngine,
    keys: phoneKeys,
    deviceId: 'phone-e2e-5',
  });
  // A real Session on the desk's persisted state — the same object
  // the renderer controller drives.
  const session = new Session({
    storage: new FakeStorage({
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
        mode: 'stopped',
      },
      settings: {
        catalogProvider: 'itunes',
        playbackProvider: 'youtube-music',
        storefront: 'US',
        qualityKbps: 256,
        theme: 'system',
        prefetch: true,
      },
    }),
    player: new FakePlayer(),
    providers: [
      new FakeProvider('itunes'),
      new FakeProvider('youtube-music'),
    ],
    clock: realClock,
    ids: new SequenceIds(),
    log: new FakeLog(),
    defaults: {
      catalogProvider: 'itunes',
      playbackProvider: 'youtube-music',
      storefront: 'US',
      qualityKbps: 256,
      theme: 'system',
      prefetch: true,
    },
    localPlaybackFor: () => null,
    isOnline: () => true,
  });
  try {
    const restored = await session.restore();
    assert(restored.ok, 'session restore failed');
    const payload = await pairingPayload(service);
    const paired = await client.pair({ payload });
    assert(paired.ok);

    // Phone edit → wire → desk merge (the socket applyDelta path
    // feeds the outbox).
    await seedEntry(phoneEngine, 'pl-phone', 'from-phone');
    const round = await client.syncNow(paired.value.fp);
    assert(round.ok, `syncNow failed: ${JSON.stringify(round)}`);

    // Drain until empty — the renderer's loop shape.
    const drained: MergeOutcome[] = [];
    for (;;) {
      const handler = service.handlers['sync:drainApplied'];
      assert(handler !== undefined);
      const page: unknown = await handler(undefined);
      assert(isRecord(page));
      for (const outcome of page['outcomes'] as unknown[]) {
        drained.push(outcome as MergeOutcome);
      }
      if ((page['remaining'] as number) === 0) {
        break;
      }
    }
    assert(drained.length > 0, 'applied outcomes queued for drain');

    const applied = await session.applySyncedEntries(drained);
    assert(applied.ok, `applySyncedEntries: ${JSON.stringify(applied)}`);
    const state = session.snapshot();
    assert(state.type === 'ready');
    const list = state.playlists.find((p) => p.playlistId === 'pl-phone');
    assert(list !== undefined, 'remote playlist materialized');
    assertEqual(list?.name, 'from-phone');
  } finally {
    await client.close();
    await service.close();
    await session.dispose();
  }
}

// devices + unpair round out the session lifecycle.
async function devicesAndUnpair(): Promise<void> {
  const deskEngine = await realEngine('desk-e2e-4');
  const { service } = await startService(deskEngine);
  const phoneEngine = await realEngine('phone-e2e-4');
  const phoneKeys = memoryClientKeys();
  const client = await makeClient({
    engine: phoneEngine,
    keys: phoneKeys,
    deviceId: 'phone-e2e-4',
  });
  try {
    const payload = await pairingPayload(service);
    const paired = await client.pair({ payload });
    assert(paired.ok);

    const summary = await client.refreshPeer(paired.value.fp);
    assert(summary.ok, `devices failed: ${JSON.stringify(summary)}`);
    assert(summary.value !== null);
    assertEqual(summary.value.id, 'phone-e2e-4');

    const gone = await client.unpair(paired.value.fp);
    assert(gone.ok);
    const peers = await client.peers();
    assert(peers.ok && peers.value.length === 0, 'custody dropped');
    const after = await client.syncNow(paired.value.fp);
    assert(!after.ok && after.error.kind === 'not-found');
  } finally {
    await client.close();
    await service.close();
  }
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['cryptoVectors', cryptoVectors],
  ['pairAndConverge', pairAndConverge],
  ['wrongCodeRejected', wrongCodeRejected],
  ['resumeSync', resumeSync],
  ['drainProjectsIntoSession', drainProjectsIntoSession],
  ['devicesAndUnpair', devicesAndUnpair],
];

export async function run(): Promise<void> {
  for (const [name, fn] of TESTS) {
    try {
      await fn();
    } catch (thrown) {
      throw new Error(`phone-sync-e2e test failed: ${name}`, {
        cause: thrown,
      });
    }
  }
}
