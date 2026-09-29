import { appError, err, ok, type Result } from '../errors.ts';
import type {
  SyncAcceptorPort,
  SyncClientCrypto,
  SyncClientHandshake,
  SyncClientKeys,
  SyncFrameCodec,
  SyncIdentity,
  SyncPeer,
  SyncResponderCrypto,
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
import { createSyncEngine } from './sync-engine.ts';
import { createSyncClient } from './sync-client.ts';
import {
  createSyncPairHost,
  type SyncHostPeer,
  type SyncHostRegistry,
  type SyncPairHostDeps,
} from './sync-host.ts';
import {
  encodeJson,
  isServerChallenge,
  type ClientHello,
} from './sync-wire.ts';

/**
 * Pair-host tests: a REAL createSyncClient (fake crypto/keys/sockets)
 * dials a REAL createSyncPairHost over in-memory socket pairs — the
 * full hello → challenge → auth → welcome state machine on both sides.
 * Crypto is the pass-through fake; codec interop is proven separately
 * in the adapter suites (noble responder ↔ node peer).
 */

/* --------------------------- fake socket --------------------------- */

type SocketEvent = 'data' | 'close' | 'error' | 'end';

class FakeSocket implements SyncSocket {
  peer: FakeSocket | null = null;
  remoteAddress: string | undefined;
  #listeners = {
    data: [] as ((chunk: Uint8Array) => void)[],
    close: [] as ((hadError: boolean) => void)[],
    error: [] as ((error: { readonly message: string }) => void)[],
    end: [] as (() => void)[],
  };

  write(data: Uint8Array): void {
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

/** Deterministic fake fingerprint: dev pub → 64-hex. */
function fakeFp(dev: string): string {
  let h = 0;
  for (let i = 0; i < dev.length; i += 1) {
    h = (h * 31 + dev.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(64, '0').slice(0, 64);
}

const HOST_ID = 'phone-host-1';
const HOST_NAME = 'Pixel 8';
const HOST_PUB = 'host-spub';
const HOST_FP = fakeFp(HOST_PUB);
const DESK_ID = 'desk-test-1';
const DESK_PUB = 'desk-dev-pub';
const DESK_FP = fakeFp(DESK_PUB);

/** Caller half — fake client crypto; `callerPort` rides hello.port. */
function fakeClientCrypto(callerPort?: number): SyncClientCrypto {
  const identity: SyncIdentity = { pub: DESK_PUB, priv: 'desk-priv' };
  return {
    name: 'fake-v1',
    identity,
    createIdentity: () => ({ pub: 'new-pub', priv: 'new-priv' }),
    fingerprintOf: fakeFp,
    begin: ({ deviceId, name }): SyncClientHandshake => ({
      hello: () => ({
        v: 1,
        kind: 'hello',
        deviceId,
        name,
        eph: 'eph-pub',
        dev: identity.pub,
        ...(callerPort === undefined ? {} : { port: callerPort }),
      }),
      complete: (challengeJson, { pinnedFp }) => {
        if (!isServerChallenge(challengeJson)) {
          return err(appError('invalid-response', 'bad challenge'));
        }
        const serverFp = fakeFp(challengeJson.spub);
        if (pinnedFp !== undefined && pinnedFp !== serverFp) {
          return err(appError('permission-denied', 'fp mismatch'));
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

/** Responder half — accept mints a syntactically valid challenge. */
function fakeResponderCrypto(): SyncResponderCrypto {
  return {
    name: 'fake-v1',
    identity: { pub: HOST_PUB, priv: 'host-priv' },
    accept(hello: ClientHello, opts: { registered: boolean }) {
      return {
        challenge: encodeJson({
          v: 1,
          kind: 'challenge',
          eph: 'host-eph',
          salt: 'c2FsdA==',
          spub: HOST_PUB,
          registered: opts.registered,
        }),
        codec: PASS_CODEC,
        peer: {
          deviceId: hello.deviceId,
          name: hello.name,
          devPub: hello.dev,
          devFp: fakeFp(hello.dev),
        },
      };
    },
  };
}

/* --------------------------- fake custody -------------------------- */

function fakeRegistry(): SyncHostRegistry & {
  rows: Map<string, SyncHostPeer>;
  failPut: boolean;
} {
  const rows = new Map<string, SyncHostPeer>();
  const registry = {
    rows,
    failPut: false,
    find: (fp: string) => Promise.resolve(ok(rows.get(fp) ?? null)),
    put: (peer: SyncHostPeer) => {
      if (registry.failPut) {
        return Promise.resolve(
          err(appError('unavailable', 'custody write failed')),
        );
      }
      rows.set(peer.fp, peer);
      return Promise.resolve(ok(undefined));
    },
    touch: (peer: SyncHostPeer) => {
      const existing = rows.get(peer.fp);
      if (existing === undefined) {
        return Promise.resolve(ok(false));
      }
      rows.set(peer.fp, peer);
      return Promise.resolve(ok(true));
    },
  };
  return registry;
}

function fakeKeys(): SyncClientKeys & { peers: Map<string, SyncPeer> } {
  const peers = new Map<string, SyncPeer>();
  return {
    peers,
    identityGet: () => Promise.resolve(ok(null)),
    identitySet: () => Promise.resolve(ok(undefined)),
    peerList: () => Promise.resolve(ok([...peers.values()])),
    peerTouch: (peer) => {
      const existing = peers.get(peer.fp);
      if (existing === undefined) {
        return Promise.resolve(ok(false));
      }
      peers.set(peer.fp, {
        ...existing,
        name: peer.name,
        lastSeenAt: peer.lastSeenAt,
        ...(peer.endpoints.length > 0 ? { endpoints: peer.endpoints } : {}),
        ...(peer.deviceId === undefined || peer.deviceId === ''
          ? {}
          : { deviceId: peer.deviceId }),
        ...(peer.pub === undefined || peer.pub === ''
          ? {}
          : { pub: peer.pub }),
      });
      return Promise.resolve(ok(true));
    },
    peerPut: (peer) => {
      peers.set(peer.fp, peer);
      return Promise.resolve(ok(undefined));
    },
    peerMerge: (peer) => {
      const existing = peers.get(peer.fp);
      peers.set(
        peer.fp,
        existing === undefined
          ? peer
          : {
              ...peer,
              pairedAt: existing.pairedAt,
              peerCursor: existing.peerCursor,
              ...(existing.lastSyncAt === undefined
                ? {}
                : { lastSyncAt: existing.lastSyncAt }),
              ...(existing.pot === undefined ? {} : { pot: existing.pot }),
            },
      );
      return Promise.resolve(ok(undefined));
    },
    peerDelete: (fp) => {
      peers.delete(fp);
      return Promise.resolve(ok(undefined));
    },
  };
}

function hostPeer(fp: string, overrides: Partial<SyncHostPeer> = {}): SyncHostPeer {
  return {
    role: 'caller',
    id: DESK_ID,
    name: 'auqw-desk',
    pub: DESK_PUB,
    fp,
    pairedAt: 1,
    lastSeenAt: 1,
    endpoints: [],
    ...overrides,
  };
}

function deskPeer(fp: string, endpoints: readonly string[]): SyncPeer {
  return {
    role: 'responder',
    fp,
    name: HOST_NAME,
    endpoints,
    pairedAt: 1,
    lastSeenAt: 1,
    peerCursor: {},
  };
}

/* ------------------------------ rig -------------------------------- */

const PORT = 7777;
const ENDPOINT = `127.0.0.1:${PORT}`;

async function rig(opts: {
  callerPort?: number;
  registry?: ReturnType<typeof fakeRegistry>;
  hostOverrides?: Partial<SyncPairHostDeps>;
} = {}): Promise<{
  host: ReturnType<typeof createSyncPairHost>;
  client: ReturnType<typeof createSyncClient>;
  registry: ReturnType<typeof fakeRegistry>;
  keys: ReturnType<typeof fakeKeys>;
  resumes: SyncHostPeer[];
  pairs: SyncHostPeer[];
}> {
  const clock = new FakeClock();
  const registry = opts.registry ?? fakeRegistry();
  const keys = fakeKeys();
  const resumes: SyncHostPeer[] = [];
  const pairs: SyncHostPeer[] = [];

  const engineResult = await createSyncEngine({
    store: new FakeSyncLogStore(),
    clock,
    ids: new SequenceIds(),
    log: new FakeLog(),
    deviceId: DESK_ID,
  });
  assert(engineResult.ok, 'client engine builds');
  const clientEngine = engineResult.value;

  const acceptorHook: { onSocket?: (s: SyncSocket) => void } = {};
  const acceptor: SyncAcceptorPort = {
    listen: ({ onSocket }) => {
      acceptorHook.onSocket = onSocket;
      return Promise.resolve(ok({ port: PORT, close: () => {} }));
    },
  };
  const sockets: SyncSocketPort = {
    connect: ({ host, port }) => {
      if (`${host}:${port}` !== ENDPOINT || acceptorHook.onSocket === undefined) {
        return Promise.resolve(err(appError('unavailable', 'dial failed')));
      }
      const [clientEnd, serverEnd] = socketPair();
      serverEnd.remoteAddress = '10.0.0.8';
      acceptorHook.onSocket(serverEnd);
      return Promise.resolve(ok<SyncSocket>(clientEnd));
    },
  };

  const host = createSyncPairHost({
    acceptor,
    crypto: fakeResponderCrypto(),
    registry,
    deviceId: HOST_ID,
    name: HOST_NAME,
    fp: HOST_FP,
    fingerprintOf: fakeFp,
    mintCode: () => '424242',
    clock,
    onResume: (p) => resumes.push(p),
    onPair: (p) => pairs.push(p),
    handshakeMs: 60_000,
    idleMs: 60_000,
    ...opts.hostOverrides,
  });
  const started = await host.start();
  assert(started.ok, 'host binds');
  assertEqual(host.port, PORT);

  const client = createSyncClient({
    sockets,
    crypto: fakeClientCrypto(opts.callerPort),
    keys,
    engine: clientEngine,
    ids: new SequenceIds(),
    clock,
    log: new FakeLog(),
    deviceId: DESK_ID,
    name: 'auqw-desk',
    requestMs: 60_000,
    handshakeMs: 60_000,
    pingMs: 30_000,
  });
  return { host, client, registry, keys, resumes, pairs };
}

/* ------------------------------ tests ------------------------------ */

// 1. Typed-code pair: caller lands in host custody with the advertised
// endpoint (hello.port + remote IP), onPair fires, welcome carries the
// host identity back into client custody.
async function pairRegistersCaller(): Promise<void> {
  const { host, client, registry, keys, pairs } = await rig({
    callerPort: 9911,
  });
  const offer = host.mintOffer();
  assert(offer.ok);
  assertEqual(offer.value.code, '424242');
  const paired = await client.pair({
    code: '424242',
    endpoints: [ENDPOINT],
  });
  assert(paired.ok, 'pair resolves');
  assertEqual(paired.value.fp, HOST_FP);
  assertEqual(paired.value.name, HOST_NAME);
  const row = registry.rows.get(DESK_FP);
  assert(row !== undefined, 'caller in host custody');
  assertEqual(row.id, DESK_ID);
  assertEqual(row.name, 'auqw-desk');
  assertDeepEqual(row.endpoints, ['10.0.0.8:9911']);
  assertEqual(pairs.length, 1, 'onPair fired');
  assert(keys.peers.has(HOST_FP), 'host in client custody');
  await host.close();
  await client.close();
}

// 2. Wrong code → typed reject, nothing written, budget accrues.
async function wrongCodeRejected(): Promise<void> {
  const { host, client, registry } = await rig();
  host.mintOffer();
  const failed = await client.pair({ code: '000000', endpoints: [ENDPOINT] });
  assert(!failed.ok);
  assertEqual(failed.error.kind, 'permission-denied');
  assertEqual(registry.rows.size, 0);
  await host.close();
  await client.close();
}

// 3. Never-minted host → reject 'no-pairing' (client maps to
// 'expired' — the pairing window isn't live).
async function noMintRejected(): Promise<void> {
  const { host, client, registry } = await rig();
  const failed = await client.pair({ code: '424242', endpoints: [ENDPOINT] });
  assert(!failed.ok);
  assertEqual(failed.error.kind, 'expired');
  assertEqual(registry.rows.size, 0);
  await host.close();
  await client.close();
}

// 4. Attempt budget: enough misses lock the remote — a correct guess
// afterwards still can't pair.
async function attemptBudgetLocks(): Promise<void> {
  const { host, client, registry } = await rig({
    hostOverrides: { maxCodeAttempts: 2, maxTotalCodeAttempts: 100 },
  });
  host.mintOffer();
  const first = await client.pair({ code: '000000', endpoints: [ENDPOINT] });
  assert(!first.ok);
  assertEqual(first.error.kind, 'permission-denied');
  const second = await client.pair({ code: '000000', endpoints: [ENDPOINT] });
  assert(!second.ok);
  assertEqual(second.error.kind, 'rate-limit');
  const correct = await client.pair({ code: '424242', endpoints: [ENDPOINT] });
  assert(!correct.ok, 'locked remote cannot pair');
  assertEqual(correct.error.kind, 'rate-limit');
  assertEqual(registry.rows.size, 0);
  await host.close();
  await client.close();
}

// 5. A code consumed once can't pair twice — second attempt sees the
// window gone ('no-pairing').
async function codePairsExactlyOnce(): Promise<void> {
  const { host, client, registry } = await rig();
  host.mintOffer();
  const first = await client.pair({ code: '424242', endpoints: [ENDPOINT] });
  assert(first.ok);
  const second = await client.pair({ code: '424242', endpoints: [ENDPOINT] });
  assert(!second.ok, 'consumed code re-pairs nothing');
  assertEqual(second.error.kind, 'expired');
  assertEqual(registry.rows.size, 1);
  await host.close();
  await client.close();
}

// 6. A custody write that fails restores the mint — the same code
// retries cleanly once custody recovers.
async function failedPutRestoresMint(): Promise<void> {
  const { host, client, registry } = await rig();
  host.mintOffer();
  registry.failPut = true;
  const first = await client.pair({ code: '424242', endpoints: [ENDPOINT] });
  assert(!first.ok);
  registry.failPut = false;
  const retry = await client.pair({ code: '424242', endpoints: [ENDPOINT] });
  assert(retry.ok, 'restored code pairs on retry');
  assert(registry.rows.has(DESK_FP));
  await host.close();
  await client.close();
}

// 6b. stop() swaps the mint generation before a pending custody
// write settles — the write's failure must not restore the consumed
// code into the post-stop window (the stopped offer stays dead).
async function stoppedOfferStaysDead(): Promise<void> {
  const registry = fakeRegistry();
  let holdPut = true;
  let releasePut: (() => void) | undefined;
  const origPut = registry.put;
  registry.put = (peer, signal) => {
    if (holdPut) {
      return new Promise<Result<void>>((resolve) => {
        releasePut = () =>
          resolve(err(appError('unavailable', 'custody write failed')));
      });
    }
    return origPut(peer, signal);
  };
  const { host, client } = await rig({ registry });
  host.mintOffer();
  const pairing = client.pair({ code: '424242', endpoints: [ENDPOINT] });
  for (let i = 0; i < 1_000 && releasePut === undefined; i += 1) {
    await Promise.resolve();
  }
  assert(releasePut !== undefined, 'custody write in flight');
  const stopping = host.stop();
  releasePut();
  await stopping;
  const failed = await pairing;
  assert(!failed.ok, 'in-flight pair rejects');
  holdPut = false;
  const restarted = await host.start();
  assert(restarted.ok, 'host rebinds after stop');
  const retry = await client.pair({ code: '424242', endpoints: [ENDPOINT] });
  assert(!retry.ok, 'stopped offer does not pair after restart');
  assertEqual(retry.error.kind, 'expired');
  await host.close();
  await client.close();
}

// 7. Resume: a registered caller touches its record (fresh name,
// endpoint, lastSeen) and fires onResume — the kick hook.
async function resumeTouchesAndKicks(): Promise<void> {
  const registry = fakeRegistry();
  registry.rows.set(DESK_FP, hostPeer(DESK_FP, { endpoints: ['10.0.0.8:1111'] }));
  const { host, client, keys, resumes } = await rig({ registry, callerPort: 2222 });
  keys.peers.set(HOST_FP, deskPeer(HOST_FP, [ENDPOINT]));
  // syncNow drives resume → welcome → the sync request errors
  // 'pair-only' — the resume still landed and kicked onResume.
  const round = await client.syncNow(HOST_FP);
  assert(!round.ok, 'pair-only host refuses the round');
  await host.close();
  await client.close();
  assertEqual(resumes.length, 1);
  assertEqual(resumes[0]?.id, DESK_ID);
  assertDeepEqual(resumes[0]?.endpoints, ['10.0.0.8:2222']);
  const row = registry.rows.get(DESK_FP);
  assert(row !== undefined && row.name === 'auqw-desk');
}

// 8. Resume by an unregistered caller rejects 'unpaired' → the client
// drops its stale peer custody.
async function resumeUnpairedRejects(): Promise<void> {
  const { host, client, keys } = await rig();
  keys.peers.set(HOST_FP, deskPeer(HOST_FP, [ENDPOINT]));
  const round = await client.syncNow(HOST_FP);
  assert(!round.ok);
  assertEqual(round.error.kind, 'auth-required');
  assert(!keys.peers.has(HOST_FP), 'stale custody dropped');
  await host.close();
  await client.close();
}

// 9. Open loop on a pair-only host: refreshPeer answers 'devices' with
// the caller's own row; 'sync' gets the typed pair-only error.
async function openLoopDevicesAndPairOnly(): Promise<void> {
  const { host, client, registry } = await rig();
  host.mintOffer();
  const paired = await client.pair({ code: '424242', endpoints: [ENDPOINT] });
  assert(paired.ok);
  const refreshed = await client.refreshPeer(HOST_FP);
  assert(refreshed.ok);
  assertEqual(refreshed.value?.id, DESK_ID);
  assertEqual(refreshed.value?.name, 'auqw-desk');
  assert(registry.rows.has(DESK_FP));
  await host.close();
  await client.close();
}

// 10. close() kills the listener + sessions — minting fails after.
async function closeDropsSessions(): Promise<void> {
  const { host, client } = await rig();
  host.mintOffer();
  const paired = await client.pair({ code: '424242', endpoints: [ENDPOINT] });
  assert(paired.ok);
  await host.close();
  assert(!host.mintOffer().ok, 'closed host cannot mint');
  await client.close();
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['pairRegistersCaller', pairRegistersCaller],
  ['wrongCodeRejected', wrongCodeRejected],

  ['noMintRejected', noMintRejected],
  ['attemptBudgetLocks', attemptBudgetLocks],
  ['codePairsExactlyOnce', codePairsExactlyOnce],
  ['failedPutRestoresMint', failedPutRestoresMint],
  ['stoppedOfferStaysDead', stoppedOfferStaysDead],
  ['resumeTouchesAndKicks', resumeTouchesAndKicks],
  ['resumeUnpairedRejects', resumeUnpairedRejects],
  ['openLoopDevicesAndPairOnly', openLoopDevicesAndPairOnly],
  ['closeDropsSessions', closeDropsSessions],
];

export async function run(): Promise<void> {
  for (const [name, fn] of TESTS) {
    try {
      await fn();
    } catch (thrown) {
      throw new Error(`sync-host test failed: ${name}`, { cause: thrown });
    }
  }
}
