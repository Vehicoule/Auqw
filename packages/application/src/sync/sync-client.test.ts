import { CancellationSource } from '../cancellation.ts';
import { appError, err, ok, type Result } from '../errors.ts';
import type {
  SyncClientCrypto,
  SyncClientHandshake,
  SyncClientKeys,
  SyncFrameCodec,
  SyncIdentity,
  SyncPeer,
  SyncSocket,
  SyncSocketPort,
} from '../ports/sync-transport.ts';
import { assert, assertDeepEqual, assertEqual } from '../testing/assert.ts';
import {
  FakeClock,
  FakeLog,
  FakeSyncLogStore,
  SequenceIds,
} from '../testing/fakes.ts';
import {
  createSyncEngine,
  type SyncDelta,
  type SyncEngine,
} from './sync-engine.ts';
import { createSyncClient, type SyncClientDeps } from './sync-client.ts';
import {
  attachSyncPump,
  decodeJson,
  encodeJson,
  isServerChallenge,
  sinceToCursor,
  type SyncDeviceSummary,
  type SyncPairingPayload,
  type SyncWirePump,
} from './sync-wire.ts';

/* --------------------------- fake socket ---------------------------- */

type SocketEvent = 'data' | 'close' | 'error' | 'end';

class FakeSocket implements SyncSocket {
  peer: FakeSocket | null = null;
  #listeners = {
    data: [] as ((chunk: Uint8Array) => void)[],
    close: [] as ((hadError: boolean) => void)[],
    error: [] as ((error: { readonly message: string }) => void)[],
    end: [] as (() => void)[],
  };
  readonly written: Uint8Array[] = [];

  write(data: Uint8Array): void {
    this.written.push(data);
    const peer = this.peer;
    if (peer !== null) {
      peer.#emit('data', data);
    }
  }

  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
  on(
    event: 'error',
    listener: (error: { readonly message: string }) => void,
  ): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: SocketEvent, listener: (...args: never[]) => void): void {
    (this.#listeners[event] as ((...args: never[]) => void)[]).push(
      listener,
    );
  }

  #emit(event: SocketEvent, arg?: unknown): void {
    for (const listener of this.#listeners[event]) {
      (listener as (a?: unknown) => void)(arg);
    }
  }

  end(): void {
    const peer = this.peer;
    if (peer !== null) {
      peer.#emit('end');
      peer.#emit('close', false);
    }
  }

  destroy(): void {
    const peer = this.peer;
    this.peer = null;
    this.#emit('close', true);
    if (peer !== null && peer.peer === this) {
      peer.peer = null;
      peer.#emit('close', false);
    }
  }

  /** Test-only: report a transport error into this end. */
  fail(message: string): void {
    this.#emit('error', { message });
    this.#emit('close', true);
  }
}

function socketPair(): [FakeSocket, FakeSocket] {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/* --------------------------- fake crypto --------------------------- */

const PASS_CODEC: SyncFrameCodec = {
  seal: (plain) => plain,
  open: (frame) => frame,
};

// The fake suite's fingerprint derivation: a fixed 64-hex value so the
// QR payload and device records satisfy the wire `fp` validator.
const FAKE_FP = 'a'.repeat(64);

function fpOf(spub: string): string {
  void spub;
  return FAKE_FP;
}

function fakeCrypto(opts: { identity?: SyncIdentity } = {}): SyncClientCrypto {
  const identity = opts.identity ?? { pub: 'dev-pub', priv: 'dev-priv' };
  return {
    name: 'fake-v1',
    identity,
    createIdentity: () => ({ pub: 'new-pub', priv: 'new-priv' }),
    begin: ({ deviceId, name }): SyncClientHandshake => ({
      hello: () => ({
        v: 1,
        kind: 'hello',
        deviceId,
        name,
        eph: 'eph-pub',
        dev: identity.pub,
      }),
      complete: (challengeJson, { pinnedFp }) => {
        if (!isServerChallenge(challengeJson)) {
          return {
            ok: false,
            error: appError('invalid-response', 'sync: malformed challenge'),
          };
        }
        const serverFp = fpOf(challengeJson.spub);
        if (pinnedFp !== undefined && pinnedFp !== serverFp) {
          return {
            ok: false,
            error: appError(
              'permission-denied',
              'sync: fingerprint mismatch',
            ),
          };
        }
        return ok({
          codec: PASS_CODEC,
          registered: challengeJson.registered,
          serverPub: challengeJson.spub,
          serverFp,
        });
      },
    }),
  };
}

/* ---------------------------- fake keys ---------------------------- */

function fakeKeys(): SyncClientKeys & {
  peers: Map<string, SyncPeer>;
  failPeerPut: boolean;
} {
  const peers = new Map<string, SyncPeer>();
  let identity: { deviceId: string; identity: SyncIdentity } | null = null;
  const keys = {
    peers,
    failPeerPut: false,
    identityGet: () => Promise.resolve(ok(identity)),
    identitySet: (record: { deviceId: string; identity: SyncIdentity }) => {
      identity = record;
      return Promise.resolve(ok(undefined));
    },
    peerList: () => Promise.resolve(ok([...peers.values()])),
    peerPut: (peer: SyncPeer) => {
      if (keys.failPeerPut) {
        return Promise.resolve(
          err(appError('unavailable', 'sync: custody write failed')),
        );
      }
      peers.set(peer.fp, peer);
      return Promise.resolve(ok(undefined));
    },
    peerDelete: (fp: string) => {
      peers.delete(fp);
      return Promise.resolve(ok(undefined));
    },
  };
  return keys;
}

/* -------------------------- scripted server ------------------------ */

type ScriptedServer = {
  readonly port: number;
  readonly engine: SyncEngine;
  readonly pump: SyncWirePump;
  readonly hello: unknown[];
  readonly auths: unknown[];
  readonly syncs: unknown[];
  readonly devices: readonly SyncDeviceSummary[];
  byeSeen: boolean;
  reject: string | null;
  registered: boolean;
  deviceSummaries: SyncDeviceSummary[];
  /** Kill the transport when a sync request arrives mid-open phase. */
  dropOnSync: boolean;
  /** Stay silent on a sync request — the socket stays open, no reply. */
  muteOnSync: boolean;
  /** Reply `more:true` on every delta — a peer that never converges. */
  forceDeltaMore: boolean;
};

async function createEngine(
  deviceId: string,
  clock: FakeClock,
): Promise<SyncEngine> {
  const engine = await createSyncEngine({
    store: new FakeSyncLogStore(),
    clock,
    ids: new SequenceIds(),
    log: new FakeLog(),
    deviceId,
  });
  if (!engine.ok) {
    throw new Error(`engine failed: ${engine.error.kind}`);
  }
  return engine.value;
}

/* ------------------------------ rig -------------------------------- */

const CLIENT_ID = 'phone-test-1';
const SERVER_ID = 'desk-test-1';
const SERVER_SPUB = 'server-spub';
const SERVER_FP = fpOf(SERVER_SPUB);
const ENDPOINT = '10.0.0.4:7777';

async function rig(): Promise<{
  client: ReturnType<typeof createSyncClient>;
  clientEngine: SyncEngine;
  serverEngine: SyncEngine;
  server: ScriptedServer;
  keys: ReturnType<typeof fakeKeys>;
  clock: FakeClock;
  sockets: { registered: Map<string, (socket: FakeSocket) => void> };
  portCloses: () => number;
}> {
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const clientEngine = await createEngine(CLIENT_ID, clock);
  const serverEngine = await createEngine(SERVER_ID, clock);
  const keys = fakeKeys();

  const servers = new Map<string, (socket: FakeSocket) => void>();

  let portCloseCount = 0;
  const sockets: SyncSocketPort = {
    connect: ({ host, port }) => {
      const hook = servers.get(`${host}:${port}`);
      if (hook === undefined) {
        return Promise.resolve({
          ok: false,
          error: appError('unavailable', 'sync: dial failed'),
        });
      }
      const [clientEnd, serverEnd] = socketPair();
      hook(serverEnd);
      return Promise.resolve(ok<SyncSocket>(clientEnd));
    },
    close: () => {
      portCloseCount += 1;
    },
  };

  const server: ScriptedServer = {
    port: 7777,
    engine: serverEngine,
    pump: undefined as unknown as SyncWirePump,
    hello: [],
    auths: [],
    syncs: [],
    devices: [],
    byeSeen: false,
    reject: null,
    registered: true,
    deviceSummaries: [],
    dropOnSync: false,
    muteOnSync: false,
    forceDeltaMore: false,
  };

  servers.set('10.0.0.4:7777', (socket) => {
    const pump = attachSyncPump({
      socket,
      maxPayload: 1 << 22,
      onFrame: (payload) => {
        const msg = decodeJson(payload);
        void handle(server, pump, msg);
      },
      onClose: () => {},
    });
    (server as { pump: SyncWirePump }).pump = pump;
  });

  const deps: SyncClientDeps = {
    sockets,
    crypto: fakeCrypto(),
    keys,
    engine: clientEngine,
    ids,
    clock,
    log: new FakeLog(),
    deviceId: CLIENT_ID,
    name: 'auqw-phone',
    requestMs: 60_000,
    handshakeMs: 60_000,
    pingMs: 30_000,
  };
  return {
    client: createSyncClient(deps),
    clientEngine,
    serverEngine,
    server,
    keys,
    clock,
    sockets: { registered: servers },
    portCloses: () => portCloseCount,
  };
}

async function handle(
  server: ScriptedServer,
  pump: SyncWirePump,
  msg: unknown,
): Promise<void> {
  if (typeof msg !== 'object' || msg === null) {
    return;
  }
  const t = (msg as { t?: unknown; kind?: unknown }).t;
  const kind = (msg as { t?: unknown; kind?: unknown }).kind;
  if (kind === 'hello') {
    server.hello.push(msg);
    pump.send(
      encodeJson({
        v: 1,
        kind: 'challenge',
        eph: 's-eph',
        salt: 's-salt',
        spub: SERVER_SPUB,
        registered: server.registered,
      }),
    );
    return;
  }
  if (t === 'pair' || t === 'resume') {
    server.auths.push(msg);
    if (server.reject !== null) {
      pump.send(encodeJson({ t: 'reject', reason: server.reject }));
      return;
    }
    pump.send(
      encodeJson({
        t: 'welcome',
        device: {
          id: CLIENT_ID,
          name: 'auqw-phone',
          pub: 'dev-pub',
          fp: 'b'.repeat(64),
          pairedAt: 1_000,
          lastSeenAt: 1_000,
        },
        name: 'auqw-desk',
      }),
    );
    return;
  }
  if (t === 'sync') {
    server.syncs.push(msg);
    if (server.dropOnSync) {
      pump.close();
      return;
    }
    if (server.muteOnSync) {
      return;
    }
    const sent = msg as { since?: unknown; delta?: unknown };
    if (sent.delta !== undefined) {
      const applied = await server.engine.applyDelta(sent.delta);
      if (!applied.ok) {
        pump.send(encodeJson({ t: 'error', code: 'bad-request' }));
        return;
      }
    }
    const since =
      typeof sent.since === 'string' ? sinceToCursor(sent.since) : null;
    const exported = await server.engine.exportDelta(since ?? {});
    if (!exported.ok) {
      pump.send(encodeJson({ t: 'error', code: 'internal' }));
      return;
    }
    const delta = server.forceDeltaMore
      ? { ...exported.value, more: true }
      : exported.value;
    pump.send(encodeJson({ t: 'delta', delta }));
    return;
  }
  if (t === 'ping') {
    pump.send(encodeJson({ t: 'pong' }));
    return;
  }
  if (t === 'devices') {
    pump.send(
      encodeJson({
        t: 'devices',
        devices: server.deviceSummaries,
      }),
    );
    return;
  }
  if (t === 'bye') {
    server.byeSeen = true;
    return;
  }
}

function qrPayload(overrides: Partial<SyncPairingPayload> = {}): string {
  return JSON.stringify({
    v: 1,
    endpoint: ENDPOINT,
    endpoints: [ENDPOINT],
    code: '123456',
    fp: SERVER_FP,
    ...overrides,
  });
}

/* ------------------------------ tests ------------------------------ */

// 1. QR payload: hello → challenge → pair → welcome → peer custody.
async function pairOverQrPayload(): Promise<void> {
  const { client, server, keys } = await rig();
  const paired = await client.pair({ payload: qrPayload() });
  assert(paired.ok, 'pair resolves');
  assertEqual(paired.value.fp, SERVER_FP);
  assertEqual(paired.value.name, 'auqw-desk');
  assertDeepEqual(paired.value.endpoints, [ENDPOINT]);
  assertEqual(server.hello.length, 1, 'hello seen');
  const hello = server.hello[0] as { kind?: unknown; deviceId?: unknown };
  assertEqual(hello.kind, 'hello');
  assertEqual(hello.deviceId, CLIENT_ID);
  assertEqual(server.auths.length, 1, 'auth seen');
  assertDeepEqual(server.auths[0], { t: 'pair', code: '123456' });
  const stored = keys.peers.get(SERVER_FP);
  assert(stored !== undefined, 'peer in custody');
  const status = client.status();
  assertEqual(status.peers.length, 1);
  assertEqual(status.peers[0]?.state, 'open');
  await client.close();
}

// 2. Typed code: fp learned TOFU — no pinned fp required.
async function pairOverTypedCode(): Promise<void> {
  const { client, server, keys } = await rig();
  const paired = await client.pair({
    code: '654321',
    endpoints: [ENDPOINT],
  });
  assert(paired.ok, 'typed-code pair resolves');
  assertEqual(paired.value.fp, SERVER_FP);
  assertDeepEqual(server.auths[0], { t: 'pair', code: '654321' });
  assert(keys.peers.has(SERVER_FP), 'custody written');
  await client.close();
}

// 3. Malformed payloads and codes fail typed before any dial.
async function pairRejectsBadInput(): Promise<void> {
  const { client } = await rig();
  const badJson = await client.pair({ payload: '{nope' });
  assert(!badJson.ok && badJson.error.kind === 'invalid-message');
  const badShape = await client.pair({ payload: '{"v":1}' });
  assert(!badShape.ok && badShape.error.kind === 'invalid-message');
  const badCode = await client.pair({ code: '12', endpoints: [ENDPOINT] });
  assert(!badCode.ok && badCode.error.kind === 'invalid-message');
  await client.close();
}

// 4. Server reject maps per taxonomy; custody stays empty.
async function pairRejectMapsError(): Promise<void> {
  const { client, server, keys } = await rig();
  server.reject = 'bad-code';
  const failed = await client.pair({ payload: qrPayload() });
  assert(!failed.ok, 'pair fails');
  assertEqual(failed.error.kind, 'permission-denied');
  assertEqual(keys.peers.size, 0, 'no custody');
  await client.close();
}

// 5. A pinned fp that doesn't match the dialed server fails
// permission-denied before any auth frame leaves.
async function pinnedFingerprintMismatch(): Promise<void> {
  const { client, server, keys } = await rig();
  keys.peers.set('c'.repeat(64), {
    fp: 'c'.repeat(64),
    name: 'old',
    endpoints: [ENDPOINT],
    pairedAt: 1,
    lastSeenAt: 1,
    peerCursor: {},
  });
  const failed = await client.syncNow('c'.repeat(64));
  assert(!failed.ok);
  assertEqual(failed.error.kind, 'permission-denied');
  assertEqual(server.auths.length, 0, 'no auth sent');
  await client.close();
}

// 6. Full round: phone exports local changes, desktop replies with its
// own — both engines converge on both records.
async function syncRoundConverges(): Promise<void> {
  const { client, clientEngine, serverEngine, keys } = await rig();
  const paired = await client.pair({ payload: qrPayload() });
  assert(paired.ok);
  assert(
    (
      await clientEngine.localChange({
        kind: 'playlist',
        recordId: 'pl-phone',
        field: 'name',
        value: 'Phone Mix',
      })
    ).ok,
    'phone local change',
  );
  assert(
    (
      await serverEngine.localChange({
        kind: 'playlist',
        recordId: 'pl-desk',
        field: 'name',
        value: 'Desk Mix',
      })
    ).ok,
    'desk local change',
  );
  const outcome = await client.syncNow(SERVER_FP);
  assert(outcome.ok, 'sync resolves');
  assertEqual(outcome.value.sentEntries, 1);
  assertEqual(outcome.value.remoteEntries, 1);
  const names = new Set(
    clientEngine.materialize().map((r) => r.fields['name'] as string),
  );
  assert(names.has('Phone Mix') && names.has('Desk Mix'), 'client merged');
  const deskNames = new Set(
    serverEngine.materialize().map((r) => r.fields['name'] as string),
  );
  assert(
    deskNames.has('Phone Mix') && deskNames.has('Desk Mix'),
    'server merged',
  );
  const peer = keys.peers.get(SERVER_FP);
  assert(peer !== undefined, 'peer kept');
  assert(
    (peer.peerCursor[SERVER_ID] ?? 0) >= 1,
    'peerCursor advanced to desk watermark',
  );
  await client.close();
}

// 7. A dead socket mid-request settles typed — never wedges the op.
async function socketDeathUnwedges(): Promise<void> {
  const { client, server } = await rig();
  const paired = await client.pair({ payload: qrPayload() });
  assert(paired.ok);
  server.dropOnSync = true;
  const outcome = await client.syncNow(SERVER_FP);
  assert(!outcome.ok, 'round fails on dead socket');
  assertEqual(outcome.error.kind, 'transient');
  assertEqual(client.status().peers[0]?.state, 'offline');
  await client.close();
}

// 8. A `sync-request` nudge kicks a real round on the client.
async function syncRequestKicksRound(): Promise<void> {
  const { client, server } = await rig();
  const paired = await client.pair({ payload: qrPayload() });
  assert(paired.ok);
  const before = server.syncs.length;
  server.pump.send(encodeJson({ t: 'sync-request' }));
  for (let i = 0; i < 50 && server.syncs.length === before; i += 1) {
    await Promise.resolve();
  }
  assert(server.syncs.length > before, 'kick ran a round');
  await client.close();
}

// 9. unpair sends bye and drops custody; the record is gone.
async function unpairSaysByeAndForgets(): Promise<void> {
  const { client, server, keys } = await rig();
  const paired = await client.pair({ payload: qrPayload() });
  assert(paired.ok);
  const removed = await client.unpair(SERVER_FP);
  assert(removed.ok, 'unpair resolves');
  assert(server.byeSeen, 'bye observed');
  assert(!keys.peers.has(SERVER_FP), 'custody dropped');
  assertEqual(client.status().peers.length, 0);
  const listed = await client.peers();
  assert(listed.ok && listed.value.length === 0);
  await client.close();
}

// 10. A resume that meets `unpaired` rejects auth-required and drops
// the stale custody record locally.
async function resumeUnpairedDropsCustody(): Promise<void> {
  const { client, server, keys } = await rig();
  keys.peers.set(SERVER_FP, {
    fp: SERVER_FP,
    name: 'auqw-desk',
    endpoints: [ENDPOINT],
    pairedAt: 1,
    lastSeenAt: 1,
    peerCursor: {},
  });
  server.reject = 'unpaired';
  const failed = await client.syncNow(SERVER_FP);
  assert(!failed.ok);
  assertEqual(failed.error.kind, 'auth-required');
  assert(!keys.peers.has(SERVER_FP), 'stale custody dropped');
  await client.close();
}

// 11. `devices` reply surfaces the desktop's record for this device.
async function refreshPeerReadsDevices(): Promise<void> {
  const { client, server } = await rig();
  server.deviceSummaries = [
    {
      id: CLIENT_ID,
      name: 'auqw-phone',
      pairedAt: 1_000,
      lastSeenAt: 2_000,
    },
  ];
  const paired = await client.pair({ payload: qrPayload() });
  assert(paired.ok);
  const view = await client.refreshPeer(SERVER_FP);
  assert(view.ok, 'refresh resolves');
  assertEqual(view.value?.id, CLIENT_ID);
  assertEqual(view.value?.name, 'auqw-phone');
  await client.close();
}

// 12. Keepalive: advancing the clock fires a ping the server answers.
async function keepalivePings(): Promise<void> {
  const { client, server, clock } = await rig();
  const paired = await client.pair({ payload: qrPayload() });
  assert(paired.ok);
  const helloSeen = server.hello.length;
  clock.advance(30_000);
  // The ping/pong exchange completes synchronously on fake sockets;
  // a second round proves the loop stays alive.
  clock.advance(30_000);
  await Promise.resolve();
  assertEqual(server.hello.length, helloSeen, 'no re-handshake');
  assertEqual(client.status().peers[0]?.state, 'open');
  await client.close();
}

// 13. Custody hydration: a peer persisted before construction
// surfaces in status() once the client loads it — the restart path
// (createExpoSync awaits peers() before exposing the surface).
async function restartHydratesPeers(): Promise<void> {
  const { client, keys } = await rig();
  keys.peers.set(SERVER_FP, {
    fp: SERVER_FP,
    name: 'auqw-desk',
    endpoints: [ENDPOINT],
    pairedAt: 1,
    lastSeenAt: 1,
    peerCursor: {},
  });
  assertEqual(client.status().peers.length, 0, 'pre-load status empty');
  let emitted = 0;
  client.subscribe(() => {
    emitted += 1;
  });
  const listed = await client.peers();
  assert(listed.ok && listed.value.length === 1);
  assertEqual(client.status().peers.length, 1, 'status sees custody');
  assertEqual(client.status().peers[0]?.state, 'offline');
  assert(emitted > 0, 'subscribers notified on hydration');
  await client.close();
}

// 14. Concurrent syncNow shares one dial — one hello, one auth, both
// rounds serialized on the single session.
async function concurrentSyncSharesOneDial(): Promise<void> {
  const { client, server, keys } = await rig();
  keys.peers.set(SERVER_FP, {
    fp: SERVER_FP,
    name: 'auqw-desk',
    endpoints: [ENDPOINT],
    pairedAt: 1,
    lastSeenAt: 1,
    peerCursor: {},
  });
  const [a, b] = await Promise.all([
    client.syncNow(SERVER_FP),
    client.syncNow(SERVER_FP),
  ]);
  assert(a.ok && b.ok, 'both rounds resolve');
  assertEqual(server.hello.length, 1, 'one handshake only');
  assertEqual(server.auths.length, 1, 'one auth');
  await client.close();
}

// 15. A request that outlives its deadline is session-fatal: the wire
// has no request ids, so a late reply must never complete a retried
// request — the next op redials a clean session.
async function timeoutKillsSessionAndRedials(): Promise<void> {
  const { client, server, clock, keys } = await rig();
  keys.peers.set(SERVER_FP, {
    fp: SERVER_FP,
    name: 'auqw-desk',
    endpoints: [ENDPOINT],
    pairedAt: 1,
    lastSeenAt: 1,
    peerCursor: {},
  });
  server.muteOnSync = true;
  const timed = client.syncNow(SERVER_FP);
  // Let the handshake resolve and the sync request go out before the
  // clock advances — the reply deadline arms only after that.
  for (let i = 0; i < 50 && server.syncs.length === 0; i += 1) {
    await Promise.resolve();
  }
  assertEqual(server.syncs.length, 1, 'sync request went out');
  clock.advance(60_000);
  const outcome = await timed;
  assert(!outcome.ok && outcome.error.kind === 'timeout');
  assertEqual(client.status().peers[0]?.state, 'offline');
  server.muteOnSync = false;
  const retried = await client.syncNow(SERVER_FP);
  assert(retried.ok, 'retry redials and converges');
  assertEqual(server.hello.length, 2, 'second dial happened');
  await client.close();
}

// 16. close() hands the socket port its teardown hook — adapters
// holding bridge subscriptions get released with the client.
async function closeDisposesSocketPort(): Promise<void> {
  const { client, portCloses } = await rig();
  const paired = await client.pair({ payload: qrPayload() });
  assert(paired.ok);
  await client.close();
  assertEqual(portCloses(), 1, 'socket port released');
}

// 17. A failed round on a live session records lastError on the view —
// the UI must not read "connected" over a custody-write failure, and a
// later success clears it.
async function failedRoundSurfacesLastError(): Promise<void> {
  const { client, keys } = await rig();
  keys.peers.set(SERVER_FP, {
    fp: SERVER_FP,
    name: 'auqw-desk',
    endpoints: [ENDPOINT],
    pairedAt: 1,
    lastSeenAt: 1,
    peerCursor: {},
  });
  keys.failPeerPut = true;
  const failed = await client.syncNow(SERVER_FP);
  assert(!failed.ok && failed.error.kind === 'unavailable');
  const view = client.status().peers[0];
  assert(view !== undefined && view.state === 'open', 'session survived');
  assertEqual(view.lastError?.kind, 'unavailable', 'lastError recorded');
  keys.failPeerPut = false;
  const retried = await client.syncNow(SERVER_FP);
  assert(retried.ok, 'retry converges');
  assert(
    client.status().peers[0]?.lastError === undefined,
    'success clears lastError',
  );
  await client.close();
}

// 18. An export that serializes over the wire cap refits by halving —
// a large log still converges across pages instead of dying on send.
async function oversizedExportPaginates(): Promise<void> {
  const { client, clientEngine, serverEngine } = await rig();
  const paired = await client.pair({ payload: qrPayload() });
  assert(paired.ok);
  // ~260 B per entry × 6000 ≈ 1.5 MB — over SESSION_CAP, so the
  // default 10k page cannot ship until the limit refits.
  const writes = Array.from({ length: 6_000 }, (_, i) => ({
    kind: 'like' as const,
    recordId: `like-${i}`,
    field: 'like',
    value: { entityKind: 'track', targetId: `trk-${i}`, likedAtMs: 1 },
  }));
  const batch = await clientEngine.localChangeBatch(writes);
  assert(batch.ok, 'local batch');
  const outcome = await client.syncNow(SERVER_FP);
  assert(outcome.ok, 'big export converges');
  assertEqual(outcome.value.sentEntries, 6_000);
  assert(outcome.value.rounds >= 2, 'refit produced multiple pages');
  const deskLikes = serverEngine
    .materialize()
    .filter((r) => r.kind === 'like');
  assertEqual(deskLikes.length, 6_000, 'server merged every like');
  await client.close();
}

// 19. A peer that keeps advertising `more` without progress must not
// read as converged — the round reports budget-exceeded on the view.
async function incompleteRoundFailsHonest(): Promise<void> {
  const { client, server, keys } = await rig();
  keys.peers.set(SERVER_FP, {
    fp: SERVER_FP,
    name: 'auqw-desk',
    endpoints: [ENDPOINT],
    pairedAt: 1,
    lastSeenAt: 1,
    peerCursor: {},
  });
  server.forceDeltaMore = true;
  const outcome = await client.syncNow(SERVER_FP);
  assert(!outcome.ok && outcome.error.kind === 'budget-exceeded');
  const view = client.status().peers[0];
  assert(view !== undefined && view.state === 'open', 'session survived');
  assertEqual(view.lastError?.kind, 'budget-exceeded');
  await client.close();
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['pairOverQrPayload', pairOverQrPayload],
  ['pairOverTypedCode', pairOverTypedCode],
  ['pairRejectsBadInput', pairRejectsBadInput],
  ['pairRejectMapsError', pairRejectMapsError],
  ['pinnedFingerprintMismatch', pinnedFingerprintMismatch],
  ['syncRoundConverges', syncRoundConverges],
  ['socketDeathUnwedges', socketDeathUnwedges],
  ['syncRequestKicksRound', syncRequestKicksRound],
  ['unpairSaysByeAndForgets', unpairSaysByeAndForgets],
  ['resumeUnpairedDropsCustody', resumeUnpairedDropsCustody],
  ['refreshPeerReadsDevices', refreshPeerReadsDevices],
  ['keepalivePings', keepalivePings],
  ['restartHydratesPeers', restartHydratesPeers],
  ['concurrentSyncSharesOneDial', concurrentSyncSharesOneDial],
  ['timeoutKillsSessionAndRedials', timeoutKillsSessionAndRedials],
  ['closeDisposesSocketPort', closeDisposesSocketPort],
  ['failedRoundSurfacesLastError', failedRoundSurfacesLastError],
  ['oversizedExportPaginates', oversizedExportPaginates],
  ['incompleteRoundFailsHonest', incompleteRoundFailsHonest],
];

export async function run(): Promise<void> {
  for (const [name, fn] of TESTS) {
    try {
      await fn();
    } catch (thrown) {
      throw new Error(`sync-client test failed: ${name}`, {
        cause: thrown,
      });
    }
  }
}
