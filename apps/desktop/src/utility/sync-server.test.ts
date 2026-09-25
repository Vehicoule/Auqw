import {
  createServer,
  createConnection,
  type Socket,
} from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import {
  ok,
  type ApplyResult,
  type Result,
  type SyncDelta,
  type SyncEnginePort,
} from '@auqw/application';
import { FakeSyncLogStore } from '@auqw/application/testing';
import {
  createClock,
  createIds,
  createLog,
} from '../renderer/runtime.ts';
import {
  createUtilitySyncEngine,
  type UtilitySyncEngine,
} from './sync-engine.ts';
import { isShellError, shellError } from '../shared/errors.ts';
import { isRecord } from '../shared/check.ts';
import { MAX_SYNC_DOC_BYTES } from '../shared/contract.ts';
import {
  createTestPeer,
  fingerprintOf,
  type SessionCodec,
} from './sync-crypto.ts';
import {
  createMemoryKeys,
  type SyncDeviceRecord,
  type SyncKeys,
} from './sync-keys.ts';
import { createSyncService, type SyncService } from './sync-server.ts';
import { attachWirePump } from './sync-wire.ts';

/**
 * Loopback coverage for the LAN transport: real 127.0.0.1 sockets run
 * hello→pair→delta end-to-end through the same pumps, codec, and
 * registry the app wires. `createTestPeer` is the phone half — marked
 * as a test double in sync-crypto.ts.
 */

type WireReply =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: string } };

/** A minimal phone-side wire client over one loopback socket. */
function createClient(socket: Socket): {
  send(payload: Buffer): void;
  recv(): Promise<Buffer>;
  close(): void;
  readonly closed: Promise<string>;
} {
  const frames: Buffer[] = [];
  const waiters: Array<{
    resolve: (b: Buffer) => void;
    reject: (e: Error) => void;
  }> = [];
  let closedResolve: (r: string) => void = () => undefined;
  const closed = new Promise<string>((resolve) => {
    closedResolve = resolve;
  });
  attachWirePump({
    socket,
    maxPayload: 2 * 1_048_576,
    onFrame: (payload) => {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve(payload);
      } else {
        frames.push(payload);
      }
    },
    onClose: (reason) => {
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error(`closed:${reason}`));
      }
      closedResolve(reason);
    },
  });
  return {
    send(payload) {
      const head = Buffer.alloc(4);
      head.writeUInt32LE(payload.length, 0);
      socket.write(Buffer.concat([head, payload]));
    },
    recv() {
      const frame = frames.shift();
      if (frame !== undefined) {
        return Promise.resolve(frame);
      }
      return new Promise<Buffer>((resolve, reject) =>
        waiters.push({ resolve, reject }),
      );
    },
    close() {
      socket.destroy();
    },
    get closed() {
      return closed;
    },
  };
}

async function dial(port: number): Promise<ReturnType<typeof createClient>> {
  const socket = createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  return createClient(socket);
}

/** hello → challenge → complete → sealed pair/resume. */
async function phoneHandshake(
  client: ReturnType<typeof createClient>,
  peer: ReturnType<typeof createTestPeer>,
  pinnedFp: string,
): Promise<{ codec: SessionCodec; registered: boolean }> {
  client.send(Buffer.from(JSON.stringify(peer.hello()), 'utf8'));
  const challenge = JSON.parse((await client.recv()).toString('utf8'));
  const done = peer.complete(challenge, pinnedFp);
  return { codec: done.codec, registered: done.registered };
}

function sealJson(codec: SessionCodec, msg: unknown): Buffer {
  return codec.seal(Buffer.from(JSON.stringify(msg), 'utf8'));
}

function openJson(codec: SessionCodec, frame: Buffer): unknown {
  return JSON.parse(codec.open(frame).toString('utf8'));
}

type PairingPayload = {
  endpoint: string;
  endpoints: string[];
  code: string;
  fp: string;
  expiresAt: number;
};

async function invokeHandler(
  service: SyncService,
  channel: string,
  args: unknown,
): Promise<WireReply> {
  const handler = service.handlers[channel];
  assert(handler !== undefined, `no handler for ${channel}`);
  try {
    return { ok: true, value: await handler(args) };
  } catch (thrown) {
    if (isShellError(thrown)) {
      return { ok: false, error: { kind: thrown.kind } };
    }
    return { ok: false, error: { kind: 'internal' } };
  }
}

async function pairingCode(service: SyncService): Promise<PairingPayload> {
  const reply = await invokeHandler(service, 'sync:pairing', undefined);
  assert(reply.ok, `sync:pairing failed: ${JSON.stringify(reply)}`);
  const result = reply.value;
  assert(isRecord(result));
  const payload: unknown = JSON.parse(String(result['payload']));
  assert(isRecord(payload));
  return {
    endpoint: String(payload['endpoint']),
    endpoints: Array.isArray(payload['endpoints'])
      ? (payload['endpoints'] as unknown[]).map(String)
      : [],
    code: String(result['code']),
    fp: String(payload['fp']),
    expiresAt: Number(result['expiresAt']),
  };
}

/** A real engine behind the adapter — no fake in the E2E path. */
async function testUtilityEngine(
  deviceId: string,
): Promise<UtilitySyncEngine> {
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

/** Engine double: echoes since and records applied deltas. */
function createEchoEngine(): SyncEnginePort & {
  applied: { delta: unknown; deviceId: string }[];
} {
  const applied: { delta: unknown; deviceId: string }[] = [];
  return {
    applied,
    exportDelta(since: string): Promise<Result<unknown>> {
      return Promise.resolve(ok({ kind: 'echo', since }));
    },
    applyDelta(
      delta: unknown,
      deviceId: string,
    ): Promise<Result<unknown>> {
      applied.push({ delta, deviceId });
      return Promise.resolve(ok({ applied: true }));
    },
  };
}

async function startService(
  extra: Partial<Parameters<typeof createSyncService>[0]> = {},
): Promise<{
  service: SyncService;
  keys: ReturnType<typeof createMemoryKeys>;
  engine: ReturnType<typeof createEchoEngine>;
  port: number;
}> {
  const keys = createMemoryKeys();
  const engine = createEchoEngine();
  let announced: { port: number; name: string } | null = null;
  const service = createSyncService({
    host: '127.0.0.1',
    port: 0,
    keys,
    engine,
    deviceName: 'test-desk',
    endpointHost: '127.0.0.1',
    advertise: (opts) => {
      announced = { port: opts.port, name: opts.name };
      return {
        close() {
          announced = null;
        },
      };
    },
    handshakeMs: 5_000,
    idleMs: 30_000,
    ...extra,
  });
  const status = await service.ready;
  assertEqual(status.listener, 'listening', 'service binds');
  assert(status.boundPort !== null);
  assertEqual(
    status.advertise,
    'announcing',
    'advertiser factory ran',
  );
  assert(announced !== null);
  assertEqual(
    (announced as { port: number }).port,
    status.boundPort,
    'mDNS announced the bound port',
  );
  return { service, keys, engine, port: status.boundPort };
}

async function pairPhone(opts: {
  port: number;
  deviceId: string;
  code: string;
  fp: string;
  name?: string;
}): Promise<{
  client: ReturnType<typeof createClient>;
  codec: SessionCodec;
  welcome: Record<string, unknown>;
}> {
  const client = await dial(opts.port);
  const peer = createTestPeer({
    deviceId: opts.deviceId,
    name: opts.name ?? 'pixel-test',
  });
  const { codec } = await phoneHandshake(client, peer, opts.fp);
  client.send(sealJson(codec, { t: 'pair', code: opts.code }));
  const welcome = openJson(codec, await client.recv());
  assert(
    isRecord(welcome) &&
      welcome['t'] === 'welcome',
    `expected welcome, got ${JSON.stringify(welcome)}`,
  );
  return { client, codec, welcome };
}

export async function run(): Promise<void> {
  // —— E2E: hello → pair → ping → sync → devices → bye ——
  {
    const { service, keys, port } = await startService();
    try {
      const pairing = await pairingCode(service);
      assertEqual(pairing.endpoint, `127.0.0.1:${port}`);
      assertDeepEqual(
        pairing.endpoints,
        [`127.0.0.1:${port}`],
        'pairing payload ships every LAN candidate',
      );
      assert(/^[0-9]{6}$/.test(pairing.code));
      const { client, codec } = await pairPhone({
        port,
        deviceId: 'phone-00001',
        code: pairing.code,
        fp: pairing.fp,
        name: 'pixel-8',
      });
      assertEqual(keys.records.size, 1, 'device registered');

      client.send(sealJson(codec, { t: 'ping' }));
      assertDeepEqual(await openJson(codec, await client.recv()), {
        t: 'pong',
      });

      client.send(
        sealJson(codec, {
          t: 'sync',
          since: 'cursor-7',
          delta: { puts: [{ id: 't1' }] },
        }),
      );
      const delta = await openJson(codec, await client.recv());
      assertDeepEqual(delta, {
        t: 'delta',
        delta: { kind: 'echo', since: 'cursor-7' },
      });

      client.send(sealJson(codec, { t: 'devices' }));
      const devicesMsg = await openJson(codec, await client.recv());
      assert(isRecord(devicesMsg) && devicesMsg['t'] === 'devices');
      const list = devicesMsg['devices'];
      assert(Array.isArray(list) && list.length === 1);
      const entry = list[0];
      assert(isRecord(entry));
      assertEqual(entry['id'], 'phone-00001');
      assertEqual(entry['name'], 'pixel-8');

      const status = await service.status();
      assertEqual(status.sessions, 1, 'one open session');
      assertEqual(status.pairedDevices, 1);
      assert(status.lastSyncAt !== null, 'sync stamped');

      const statusReply = await invokeHandler(
        service,
        'sync:status',
        undefined,
      );
      assert(statusReply.ok, 'sync:status handler replies ok');
      const statusValue = statusReply.ok ? statusReply.value : null;
      assert(isRecord(statusValue));
      assertEqual(
        statusValue['listener'],
        'listening',
        'handler-level checked status',
      );

      client.send(sealJson(codec, { t: 'bye' }));
      await client.closed;
    } finally {
      await service.close();
    }
  }

  // —— Wrong code: typed reject, device never registers ——
  {
    const { service, keys, port } = await startService();
    try {
      const pairing = await pairingCode(service);
      const wrong = pairing.code === '000000' ? '000001' : '000000';
      const client = await dial(port);
      const peer = createTestPeer({
        deviceId: 'phone-rogue1',
        name: 'rogue',
      });
      const { codec } = await phoneHandshake(client, peer, pairing.fp);
      client.send(sealJson(codec, { t: 'pair', code: wrong }));
      const reply = await openJson(codec, await client.recv());
      assertDeepEqual(reply, { t: 'reject', reason: 'bad-code' });
      const reason = await client.closed;
      assert(
        reason === 'peer' || reason === 'local',
        `connection closed after reject (${reason})`,
      );
      assertEqual(keys.records.size, 0, 'rejected device never registers');
    } finally {
      await service.close();
    }
  }

  // —— Expired re-pair keeps the live registration ——
  // A code that lapses between mint and consume rolls back its half-
  // written record — but a re-pair for an id already registered must
  // NOT delete the still-valid prior registration.
  {
    const { service, keys, port } = await startService({
      codeTtlMs: 100,
    });
    try {
      const first = await pairingCode(service);
      const { client } = await pairPhone({
        port,
        deviceId: 'dev-repair-01',
        code: first.code,
        fp: first.fp,
      });
      client.close();
      assertEqual(keys.records.size, 1, 'first pair registered');

      // Second code lapses before the pair frame lands — consume
      // fails and the rollback must restore, not unpair.
      const second = await pairingCode(service);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const client2 = await dial(port);
      const peer = createTestPeer({
        deviceId: 'dev-repair-01',
        name: 'pixel-test',
      });
      const { codec } = await phoneHandshake(client2, peer, second.fp);
      client2.send(sealJson(codec, { t: 'pair', code: second.code }));
      const reply = await openJson(codec, await client2.recv());
      assertDeepEqual(reply, { t: 'reject', reason: 'pairing-expired' });
      assertEqual(
        keys.records.size,
        1,
        'live registration survives the expired re-pair',
      );
    } finally {
      await service.close();
    }
  }

  // —— A mid-write mint can't steal an in-flight pair's code ——
  {
    const inner = createMemoryKeys();
    // Hold the pair handler open during its registry write so a fresh
    // sync:pairing mint — minted off the pair lock — lands mid-flight.
    // The pair already consumed the code before the write began: the
    // mint only opens the NEXT window, this pair still completes, and
    // the taken code can't pair a second device.
    let releaseWrite: () => void = () => undefined;
    const writeHold = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let holdPuts = false;
    const gatedKeys: SyncKeys & {
      records: Map<string, SyncDeviceRecord>;
    } = {
      ...inner,
      records: inner.records,
      async devicePut(record) {
        await inner.devicePut(record);
        if (holdPuts) {
          holdPuts = false;
          await writeHold;
        }
      },
    };
    const service = createSyncService({
      host: '127.0.0.1',
      port: 0,
      keys: gatedKeys,
      endpointHost: '127.0.0.1',
      advertise: null,
    });
    try {
      const status = await service.ready;
      assert(status.boundPort !== null);
      const port = status.boundPort;

      // An established phone — a same-id re-pair displaces it.
      const p1 = await pairingCode(service);
      const first = await pairPhone({
        port,
        deviceId: 'phone-old',
        code: p1.code,
        fp: p1.fp,
      });
      first.client.close();

      const p2 = await pairingCode(service);
      // Same device id under a fresh device key: a completed pair
      // overwrites the incumbent record outright.
      const c = await dial(port);
      const rogue = createTestPeer({
        deviceId: 'phone-old',
        name: 'rogue',
      });
      const hs = await phoneHandshake(c, rogue, p2.fp);
      holdPuts = true;
      c.send(sealJson(hs.codec, { t: 'pair', code: p2.code }));
      // Wait for the gated write to reach its hold, then retire the
      // pending window — the consumed code is already taken, so the
      // mint only re-opens the window for a later pair.
      for (let i = 0; i < 200 && holdPuts; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert(!holdPuts, 'pair write reached the hold');
      await pairingCode(service);
      releaseWrite();
      const reply = await openJson(hs.codec, await c.recv());
      assert(
        isRecord(reply) && reply['t'] === 'welcome',
        'in-flight pair completes across the mid-write mint',
      );
      assertEqual(
        inner.records.get('phone-old')?.fp,
        fingerprintOf(rogue.identity.pub),
        're-pair displaced the incumbent record',
      );
      assertEqual(inner.records.size, 1, 'no shadow records remain');
      c.close();
      // The consumed code is spent even though a newer window opened.
      const c2 = await dial(port);
      const peer2 = createTestPeer({
        deviceId: 'phone-second',
        name: 'second',
      });
      const hs2 = await phoneHandshake(c2, peer2, p2.fp);
      c2.send(sealJson(hs2.codec, { t: 'pair', code: p2.code }));
      const reply2 = await openJson(hs2.codec, await c2.recv());
      assertDeepEqual(reply2, { t: 'reject', reason: 'bad-code' });
      c2.close();
    } finally {
      await service.close();
    }
  }

  // —— Attempt cap: wrong-code budget is per remote address ——
  // Loopback can't fake distinct source IPs, so what this proves is:
  // the shared pool is gone — misses count against the attacker's
  // address only — and a fresh mint resets the table so the legit
  // phone can always get a new window.
  {
    const { service, port } = await startService({ maxCodeAttempts: 2 });
    try {
      const pairing = await pairingCode(service);
      const wrong = pairing.code === '000000' ? '000001' : '000000';
      for (let i = 0; i < 2; i += 1) {
        const client = await dial(port);
        const peer = createTestPeer({
          deviceId: `phone-try${i}-x`,
          name: 'tryer',
        });
        const { codec } = await phoneHandshake(client, peer, pairing.fp);
        client.send(sealJson(codec, { t: 'pair', code: wrong }));
        const reply = (await openJson(codec, await client.recv())) as {
          reason?: string;
        };
        if (i === 0) {
          assertEqual(reply.reason, 'bad-code');
        } else {
          assertEqual(
            reply.reason,
            'pairing-attempts',
            'that source exhausted its guesses',
          );
        }
        client.close();
      }
      // The pending code survives attacker misses — minting a fresh
      // code resets budgets so pairing is never permanently locked.
      const pairing2 = await pairingCode(service);
      const { client } = await pairPhone({
        port,
        deviceId: 'phone-ok-after',
        code: pairing2.code,
        fp: pairing2.fp,
      });
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— A single bad guess never invalidates the pending code ——
  {
    const { service, port } = await startService();
    try {
      const pairing = await pairingCode(service);
      const wrong = pairing.code === '000000' ? '000001' : '000000';
      const attacker = await dial(port);
      const rogue = createTestPeer({
        deviceId: 'phone-evil-0',
        name: 'evil',
      });
      const badHs = await phoneHandshake(attacker, rogue, pairing.fp);
      attacker.send(
        sealJson(badHs.codec, { t: 'pair', code: wrong }),
      );
      assertDeepEqual(await openJson(badHs.codec, await attacker.recv()), {
        t: 'reject',
        reason: 'bad-code',
      });
      // Old behavior burned the code globally; now the legit phone
      // still completes pairing inside its window.
      const { client } = await pairPhone({
        port,
        deviceId: 'phone-00012',
        code: pairing.code,
        fp: pairing.fp,
      });
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— Resume aliases the registry id, never the claimed id ——
  {
    const { service, keys, port } = await startService();
    try {
      const pairing = await pairingCode(service);
      const real = createTestPeer({
        deviceId: 'phone-00013',
        name: 'pixel-real',
      });
      const first = await dial(port);
      const hs1 = await phoneHandshake(first, real, pairing.fp);
      first.send(
        sealJson(hs1.codec, { t: 'pair', code: pairing.code }),
      );
      await openJson(hs1.codec, await first.recv());
      first.close();
      await first.closed;
      assertEqual(keys.records.size, 1);
      assert(keys.records.has('phone-00013'));

      // Same device key, different claimed deviceId — an alias attempt.
      const rogue = createTestPeer({
        deviceId: 'phone-alias9',
        name: 'rogue',
        identity: real.identity,
      });
      const second = await dial(port);
      const hs2 = await phoneHandshake(second, rogue, pairing.fp);
      assertEqual(hs2.registered, true);
      second.send(sealJson(hs2.codec, { t: 'resume' }));
      const welcome = await openJson(hs2.codec, await second.recv());
      assert(isRecord(welcome) && welcome['t'] === 'welcome');
      const device = welcome['device'];
      assert(isRecord(device));
      assertEqual(
        device['id'],
        'phone-00013',
        'registry id pins over claimed alias',
      );
      assertEqual(
        keys.records.size,
        1,
        'no shadow registry entry written',
      );
      assert(
        !keys.records.has('phone-alias9'),
        'claimed alias never lands in the registry',
      );
      second.close();
    } finally {
      await service.close();
    }
  }

  // —— Unpair clears the device's pending-sync mark ——
  {
    const { service, port } = await startService();
    try {
      const pairing = await pairingCode(service);
      const { client } = await pairPhone({
        port,
        deviceId: 'phone-00014',
        code: pairing.code,
        fp: pairing.fp,
      });
      client.close();
      await client.closed;
      // The server's own close event lands after the client's — wait
      // for the session to be reaped before the kick.
      for (let i = 0; i < 50; i += 1) {
        if ((await service.status()).sessions === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const kick = await invokeHandler(service, 'sync:trigger', undefined);
      assert(kick.ok && isRecord(kick.value));
      assertEqual(
        kick.value['pending'],
        true,
        'offline device marks pending',
      );
      await invokeHandler(service, 'sync:unpair', {
        id: 'phone-00014',
      });
      const again = await invokeHandler(
        service,
        'sync:trigger',
        undefined,
      );
      assert(again.ok && isRecord(again.value));
      assertEqual(
        again.value['pending'],
        false,
        'unpaired device is never pending',
      );
    } finally {
      await service.close();
    }
  }

  // —— IPC: engine failures keep their error kind ——
  {
    const { service } = await startService({
      engine: {
        exportDelta(): Promise<Result<unknown>> {
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'storage-full',
              message: 'full',
              retryable: false,
            },
          });
        },
        applyDelta(): Promise<Result<unknown>> {
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'cancelled',
              message: 'drop',
              retryable: false,
            },
          });
        },
      },
    });
    try {
      const deltas = await invokeHandler(service, 'sync:deltas', {
        since: 's0',
      });
      assert(!deltas.ok);
      assertEqual(
        deltas.error.kind,
        'io-error',
        'storage-full keeps an io-class kind',
      );
      const imported = await invokeHandler(
        service,
        'sync:importDelta',
        { delta: {} },
      );
      assert(!imported.ok);
      assertEqual(imported.error.kind, 'cancelled');
    } finally {
      await service.close();
    }
  }

  // —— Over-cap engine reply: typed error, never a silent drop ——
  {
    const { service, port } = await startService({
      sessionCap: 8 * 1_024,
      engine: {
        exportDelta(): Promise<Result<unknown>> {
          return Promise.resolve(ok({ blob: 'x'.repeat(9 * 1_024) }));
        },
        applyDelta(): Promise<Result<unknown>> {
          return Promise.resolve(ok(null));
        },
      },
    });
    try {
      const pairing = await pairingCode(service);
      const { client, codec } = await pairPhone({
        port,
        deviceId: 'phone-00015',
        code: pairing.code,
        fp: pairing.fp,
      });
      client.send(sealJson(codec, { t: 'sync', since: 's1' }));
      const reply = await openJson(codec, await client.recv());
      assertDeepEqual(
        reply,
        { t: 'error', code: 'too-large' },
        'oversize reply is a typed error, not silence',
      );
      // The session survives — the sequence stayed contiguous.
      client.send(sealJson(codec, { t: 'ping' }));
      assertDeepEqual(await openJson(codec, await client.recv()), {
        t: 'pong',
      });
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— A malformed engine export is a typed error, not a mutation ——
  {
    const { service, port } = await startService({
      engine: {
        exportDelta(): Promise<Result<unknown>> {
          // `undefined` silently drops on serialize — the wire must
          // refuse instead of delivering a rewritten document.
          return Promise.resolve(
            ok({ puts: [{ id: 'a', value: undefined }] }),
          );
        },
        applyDelta(): Promise<Result<unknown>> {
          return Promise.resolve(ok(null));
        },
      },
    });
    try {
      const pairing = await pairingCode(service);
      const { client, codec } = await pairPhone({
        port,
        deviceId: 'phone-00016',
        code: pairing.code,
        fp: pairing.fp,
      });
      client.send(sealJson(codec, { t: 'sync', since: 's1' }));
      assertDeepEqual(await openJson(codec, await client.recv()), {
        t: 'error',
        code: 'invalid-response',
      });
      client.send(sealJson(codec, { t: 'ping' }));
      assertDeepEqual(await openJson(codec, await client.recv()), {
        t: 'pong',
      });
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— A doc that mutates between reads is refused too ——
  {
    const { service, port } = await startService({
      engine: {
        exportDelta(): Promise<Result<unknown>> {
          let reads = 0;
          const doc: Record<string, unknown> = {};
          Object.defineProperty(doc, 'puts', {
            enumerable: true,
            get: () => {
              reads += 1;
              return reads === 1
                ? [{ id: 'a', v: 1 }]
                : [{ id: 'b', v: 1 }];
            },
          });
          return Promise.resolve(ok(doc));
        },
        applyDelta(): Promise<Result<unknown>> {
          return Promise.resolve(ok(null));
        },
      },
    });
    try {
      const pairing = await pairingCode(service);
      const { client, codec } = await pairPhone({
        port,
        deviceId: 'phone-00017',
        code: pairing.code,
        fp: pairing.fp,
      });
      client.send(sealJson(codec, { t: 'sync', since: 's1' }));
      assertDeepEqual(await openJson(codec, await client.recv()), {
        t: 'error',
        code: 'invalid-response',
      });
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— An exotic wrapper ships only its canonical wire form ——
  {
    const { service, port } = await startService({
      engine: {
        exportDelta(): Promise<Result<unknown>> {
          return Promise.resolve(
            ok(new Proxy({ puts: [{ id: 'a', v: 1 }] }, {})),
          );
        },
        applyDelta(): Promise<Result<unknown>> {
          return Promise.resolve(ok(null));
        },
      },
    });
    try {
      const pairing = await pairingCode(service);
      const { client, codec } = await pairPhone({
        port,
        deviceId: 'phone-00018',
        code: pairing.code,
        fp: pairing.fp,
      });
      client.send(sealJson(codec, { t: 'sync', since: 's1' }));
      // What ships is the reparsed plain graph — validation approved
      // exactly the document the peer receives.
      assertDeepEqual(await openJson(codec, await client.recv()), {
        t: 'delta',
        delta: { puts: [{ id: 'a', v: 1 }] },
      });
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— Corrupt custody identity regenerates instead of bricking ——
  {
    const keys = createMemoryKeys();
    // Shape-valid base64 garbage — isSyncIdentity passes, crypto won't.
    await keys.identitySet({ pub: 'QUJD', priv: 'REVG' });
    const service = createSyncService({
      host: '127.0.0.1',
      port: 0,
      keys,
      endpointHost: '127.0.0.1',
      advertise: null,
    });
    try {
      const status = await service.ready;
      assertEqual(status.listener, 'listening', 'service recovers');
      const regen = await keys.identityGet();
      assert(
        regen !== null && regen.pub !== 'QUJD',
        'identity regenerated',
      );
      assert(
        status.fingerprint !== null && status.fingerprint.length === 64,
      );
    } finally {
      await service.close();
    }
  }

  // —— Resume path: paired device re-dials and skips the code ——
  {
    const { service, keys, port } = await startService();
    try {
      const pairing = await pairingCode(service);
      const peer = createTestPeer({
        deviceId: 'phone-00002',
        name: 'tablet',
      });
      const first = await dial(port);
      const hs1 = await phoneHandshake(first, peer, pairing.fp);
      first.send(sealJson(hs1.codec, { t: 'pair', code: pairing.code }));
      await openJson(hs1.codec, await first.recv());
      first.close();
      await first.closed;
      assertEqual(keys.records.size, 1);

      const second = await dial(port);
      const hs2 = await phoneHandshake(second, peer, pairing.fp);
      assertEqual(hs2.registered, true, 'challenge flags registered');
      second.send(sealJson(hs2.codec, { t: 'resume' }));
      const welcome = await openJson(hs2.codec, await second.recv());
      assert(isRecord(welcome) && welcome['t'] === 'welcome');
      second.close();
    } finally {
      await service.close();
    }
  }

  // —— Resume by an unknown device: typed reject ——
  {
    const { service, port } = await startService();
    try {
      const pairing = await pairingCode(service);
      const client = await dial(port);
      const peer = createTestPeer({
        deviceId: 'phone-stray1',
        name: 'stray',
      });
      const { codec, registered } = await phoneHandshake(
        client,
        peer,
        pairing.fp,
      );
      assertEqual(registered, false);
      client.send(sealJson(codec, { t: 'resume' }));
      assertDeepEqual(await openJson(codec, await client.recv()), {
        t: 'reject',
        reason: 'unpaired',
      });
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— Unpair: key revoked, live session kicked, data untouched ——
  {
    const { service, keys, port } = await startService();
    try {
      const pairing = await pairingCode(service);
      const { client } = await pairPhone({
        port,
        deviceId: 'phone-00003',
        code: pairing.code,
        fp: pairing.fp,
      });
      assertEqual(keys.records.size, 1);
      const unpair = await invokeHandler(service, 'sync:unpair', {
        id: 'phone-00003',
      });
      assert(unpair.ok, 'unpair answers ok');
      assert(
        unpair.ok && unpair.value === undefined,
        'void result is undefined — the preload boundary requires it',
      );
      assertEqual(keys.records.size, 0, 'device record gone');
      await client.closed;
      const status = await service.status();
      assertEqual(status.sessions, 0, 'session kicked');
      // Re-dial after revoke: the same key is unknown again.
      const pairing2 = await pairingCode(service);
      const peer2 = createTestPeer({
        deviceId: 'phone-00003',
        name: 'back',
      });
      const back = await dial(port);
      const hs = await phoneHandshake(back, peer2, pairing2.fp);
      assertEqual(hs.registered, false, 'revoked key unregisters');
      back.close();
    } finally {
      await service.close();
    }
  }

  // —— Oversize pre-auth frame: connection dropped, no hang ——
  {
    const { service, port } = await startService();
    try {
      const socket = createConnection({ host: '127.0.0.1', port });
      await once(socket, 'connect');
      const head = Buffer.alloc(4);
      head.writeUInt32LE(64 * 1_024, 0); // over the 16KiB handshake cap
      socket.write(head);
      const [event] = await Promise.race([
        once(socket, 'close'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('hang')), 5_000),
        ),
      ]);
      void event;
    } finally {
      await service.close();
    }
  }

  // —— Listener bind failure → typed unavailable, never fake ——
  {
    const blocker = createServer();
    blocker.listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    const address = blocker.address();
    assert(address !== null && typeof address === 'object');
    const keys = createMemoryKeys();
    const service = createSyncService({
      host: '127.0.0.1',
      port: address.port,
      keys,
      engine: createEchoEngine(),
      deviceName: 'blocked',
      endpointHost: '127.0.0.1',
      advertise: null,
    });
    try {
      const status = await service.ready;
      assertEqual(status.listener, 'unavailable', 'bind failure typed');
      const pairing = await invokeHandler(
        service,
        'sync:pairing',
        undefined,
      );
      assert(!pairing.ok && pairing.error.kind === 'unavailable');
    } finally {
      await service.close();
      blocker.close();
    }
  }

  // —— Disabled config → 'disabled', pairing still honest ——
  {
    const keys = createMemoryKeys();
    const service = createSyncService({
      host: '127.0.0.1',
      port: 0,
      disabled: true,
      keys,
      advertise: null,
    });
    try {
      const status = await service.ready;
      assertEqual(status.listener, 'disabled');
      const pairing = await invokeHandler(
        service,
        'sync:pairing',
        undefined,
      );
      assert(!pairing.ok && pairing.error.kind === 'unavailable');
    } finally {
      await service.close();
    }
  }

  // —— Disabled + dead custody → still a stable 'disabled' answer ——
  {
    const keys = createMemoryKeys();
    const deadCustody: SyncKeys = {
      ...keys,
      deviceList() {
        return Promise.reject(
          shellError('unavailable', 'safeStorage backend dead'),
        );
      },
    };
    const service = createSyncService({
      host: '127.0.0.1',
      port: 0,
      disabled: true,
      keys: deadCustody,
      advertise: null,
    });
    try {
      const status = await service.ready;
      assertEqual(status.listener, 'disabled');
      const queried = await invokeHandler(
        service,
        'sync:status',
        undefined,
      );
      assert(
        queried.ok &&
          isRecord(queried.value) &&
          queried.value['listener'] === 'disabled',
        'disabled status survives a dead custody backend',
      );
    } finally {
      await service.close();
    }
  }

  // —— Engine-absent: delta channels type 'unavailable' ——
  {
    const keys = createMemoryKeys();
    const service = createSyncService({
      host: '127.0.0.1',
      port: 0,
      keys,
      advertise: null,
      endpointHost: '127.0.0.1',
    });
    try {
      await service.ready;
      const status = await service.status();
      assertEqual(status.engine, 'absent');
      const deltasReply = await invokeHandler(
        service,
        'sync:deltas',
        { since: '' },
      );
      assert(!deltasReply.ok && deltasReply.error.kind === 'unavailable');
      const importReply = await invokeHandler(
        service,
        'sync:importDelta',
        { delta: {} },
      );
      assert(!importReply.ok && importReply.error.kind === 'unavailable');
    } finally {
      await service.close();
    }
  }

  // —— IPC handlers: deltas/importDelta/trigger seam ——
  {
    const { service, engine } = await startService();
    try {
      const deltas = await invokeHandler(service, 'sync:deltas', {
        since: 'c3',
      });
      assert(deltas.ok);
      assertDeepEqual(deltas.value, {
        delta: { kind: 'echo', since: 'c3' },
      });
      const imported = await invokeHandler(service, 'sync:importDelta', {
        delta: { puts: [] },
        deviceId: 'phone-00009',
      });
      assert(imported.ok);
      assertDeepEqual(imported.value, { result: { applied: true } });
      assertEqual(engine.applied.length, 1);
      assertEqual(engine.applied[0]?.deviceId, 'phone-00009');

      // Trigger with no open sessions → pending flag, no throw.
      const trigger = await invokeHandler(
        service,
        'sync:trigger',
        undefined,
      );
      assert(trigger.ok);
      const status = await service.status();
      assert(status.fingerprint !== null);
    } finally {
      await service.close();
    }
  }

  // —— Trigger kicks the open session ——
  {
    const { service, port } = await startService();
    try {
      const pairing = await pairingCode(service);
      const { client, codec } = await pairPhone({
        port,
        deviceId: 'phone-00004',
        code: pairing.code,
        fp: pairing.fp,
      });
      const trigger = await invokeHandler(
        service,
        'sync:trigger',
        undefined,
      );
      assert(trigger.ok && isRecord(trigger.value));
      assertEqual(trigger.value['triggered'], true);
      const kick = await openJson(codec, await client.recv());
      assertDeepEqual(kick, { t: 'sync-request' });
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— Handshake deadline: a socket that never completes dies ——
  {
    const { service, port } = await startService({ handshakeMs: 150 });
    try {
      const socket = createConnection({ host: '127.0.0.1', port });
      await once(socket, 'connect');
      await once(socket, 'close');
    } finally {
      await service.close();
    }
  }

  // —— Pairing mints require a live listener (fresh per call) ——
  {
    const { service } = await startService();
    try {
      const a = await pairingCode(service);
      const b = await pairingCode(service);
      assert(
        a.expiresAt > Date.now(),
        'fresh code carries a future expiry',
      );
      assert(
        a.code !== b.code || a.expiresAt !== b.expiresAt,
        'each mint is a fresh pending session',
      );
    } finally {
      await service.close();
    }
  }

  // —— Engine Result-error maps onto the wire ——
  {
    const { service, port } = await startService({
      engine: {
        exportDelta(): Promise<Result<unknown>> {
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'storage-full',
              message: 'full',
              retryable: false,
            },
          });
        },
        applyDelta(): Promise<Result<unknown>> {
          return Promise.resolve(ok(null));
        },
      },
    });
    try {
      const pairing = await pairingCode(service);
      const { client, codec } = await pairPhone({
        port,
        deviceId: 'phone-00005',
        code: pairing.code,
        fp: pairing.fp,
      });
      client.send(sealJson(codec, { t: 'sync', since: 'x' }));
      const reply = await openJson(codec, await client.recv());
      assert(isRecord(reply) && reply['t'] === 'error');
      assertEqual(reply['code'], 'storage-full');
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— A brute-forced source is locked out even holding the code ——
  {
    const { service, keys, port } = await startService({
      maxCodeAttempts: 2,
    });
    try {
      const pairing = await pairingCode(service);
      const wrong = pairing.code === '000000' ? '000001' : '000000';
      for (let i = 0; i < 2; i += 1) {
        const c = await dial(port);
        const p = createTestPeer({
          deviceId: `phone-guess0${i}`,
          name: 'guess',
        });
        const { codec } = await phoneHandshake(c, p, pairing.fp);
        c.send(sealJson(codec, { t: 'pair', code: wrong }));
        await openJson(codec, await c.recv());
        c.close();
      }
      // Same source (loopback can't alias addresses) with the CORRECT
      // code: the lockout refuses before the code is ever evaluated.
      const c = await dial(port);
      const p = createTestPeer({
        deviceId: 'phone-lucky-01',
        name: 'lucky',
      });
      const { codec } = await phoneHandshake(c, p, pairing.fp);
      c.send(sealJson(codec, { t: 'pair', code: pairing.code }));
      assertDeepEqual(await openJson(codec, await c.recv()), {
        t: 'reject',
        reason: 'pairing-attempts',
      });
      await c.closed;
      assertEqual(
        keys.records.size,
        0,
        'a locked-out source can never register',
      );
      // A fresh mint resets the window — the operator keeps control.
      const pairing2 = await pairingCode(service);
      const { client } = await pairPhone({
        port,
        deviceId: 'phone-afterlock',
        code: pairing2.code,
        fp: pairing2.fp,
      });
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— Shared ceiling: misses can't scale with source addresses ——
  // Loopback can't alias IPs, so the per-IP budget (10) stays far
  // away: locking at the 3rd attempt proves the shared counter.
  {
    const { service, port } = await startService({
      maxCodeAttempts: 10,
      maxTotalCodeAttempts: 3,
    });
    try {
      const pairing = await pairingCode(service);
      const wrong = pairing.code === '000000' ? '000001' : '000000';
      for (let i = 0; i < 3; i += 1) {
        const c = await dial(port);
        const p = createTestPeer({
          deviceId: `phone-spray${i}`,
          name: 'spray',
        });
        const { codec } = await phoneHandshake(c, p, pairing.fp);
        c.send(sealJson(codec, { t: 'pair', code: wrong }));
        const reply = (await openJson(codec, await c.recv())) as {
          reason?: string;
        };
        assertEqual(
          reply.reason,
          i < 2 ? 'bad-code' : 'pairing-attempts',
          `attempt ${i} reason`,
        );
        c.close();
      }
      // The shared budget also gates a fresh source — the pending
      // code can't be pried further from any address.
      const c = await dial(port);
      const p = createTestPeer({
        deviceId: 'phone-after-cap',
        name: 'aftercap',
      });
      const { codec } = await phoneHandshake(c, p, pairing.fp);
      c.send(sealJson(codec, { t: 'pair', code: pairing.code }));
      assertDeepEqual(await openJson(codec, await c.recv()), {
        t: 'reject',
        reason: 'pairing-attempts',
      });
      await c.closed;
      // A fresh mint restores the window — the code space re-opens.
      const pairing2 = await pairingCode(service);
      const { client } = await pairPhone({
        port,
        deviceId: 'phone-recap',
        code: pairing2.code,
        fp: pairing2.fp,
      });
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— A transient registry failure never burns the pending code ——
  {
    const inner = createMemoryKeys();
    let failPut = true;
    const flakyKeys: SyncKeys & {
      records: Map<string, SyncDeviceRecord>;
    } = {
      ...inner,
      records: inner.records,
      async devicePut(record) {
        if (failPut) {
          failPut = false;
          throw shellError('io-error', 'transient custody failure');
        }
        await inner.devicePut(record);
      },
    };
    const service = createSyncService({
      host: '127.0.0.1',
      port: 0,
      keys: flakyKeys,
      endpointHost: '127.0.0.1',
      advertise: null,
    });
    try {
      const status = await service.ready;
      assert(status.boundPort !== null);
      const pairing = await pairingCode(service);
      const c1 = await dial(status.boundPort);
      const p1 = createTestPeer({
        deviceId: 'phone-flaky-1',
        name: 'flaky',
      });
      const hs1 = await phoneHandshake(c1, p1, pairing.fp);
      c1.send(sealJson(hs1.codec, { t: 'pair', code: pairing.code }));
      assertDeepEqual(await openJson(hs1.codec, await c1.recv()), {
        t: 'reject',
        reason: 'io-error',
      });
      await c1.closed;
      // Retrying the same code inside its window pairs — the failed
      // registry write left it pending instead of consuming it.
      const c2 = await dial(status.boundPort);
      const p2 = createTestPeer({
        deviceId: 'phone-flaky-1',
        name: 'flaky',
      });
      const hs2 = await phoneHandshake(c2, p2, pairing.fp);
      c2.send(sealJson(hs2.codec, { t: 'pair', code: pairing.code }));
      const welcome = await openJson(hs2.codec, await c2.recv());
      assert(
        isRecord(welcome) && welcome['t'] === 'welcome',
        'retry after transient failure completes pairing',
      );
      c2.close();
    } finally {
      await service.close();
    }
  }

  // —— A second hello mid-handshake dies, never a corrupted session ——
  {
    const { service, keys, port } = await startService();
    try {
      await pairingCode(service);
      const client = await dial(port);
      const peer = createTestPeer({
        deviceId: 'phone-2hello',
        name: 'twice',
      });
      const hello = Buffer.from(JSON.stringify(peer.hello()), 'utf8');
      client.send(hello);
      client.send(hello); // back-to-back — protocol violation
      // The server kills the session: no codec/identity mashup, no
      // registered device, and the socket ends instead of hanging.
      await client.closed;
      assertEqual(keys.records.size, 0, 'stray hello registered nothing');
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— The wire `devices` reply is scoped to the caller's own record ——
  {
    const { service, keys, port } = await startService();
    try {
      let pairing = await pairingCode(service);
      const first = await pairPhone({
        port,
        deviceId: 'phone-alpha1',
        code: pairing.code,
        fp: pairing.fp,
        name: 'alpha',
      });
      pairing = await pairingCode(service);
      const second = await pairPhone({
        port,
        deviceId: 'phone-beta-02',
        code: pairing.code,
        fp: pairing.fp,
        name: 'beta',
      });
      assertEqual(keys.records.size, 2);
      second.client.send(sealJson(second.codec, { t: 'devices' }));
      const reply = await openJson(second.codec, await second.client.recv());
      assert(isRecord(reply) && reply['t'] === 'devices');
      const list = reply['devices'];
      assert(
        Array.isArray(list) && list.length === 1,
        'a paired peer sees only its own record',
      );
      const entry = list[0];
      assert(isRecord(entry) && entry['id'] === 'phone-beta-02');
      first.client.close();
      second.client.close();
    } finally {
      await service.close();
    }
  }

  // —— Unparseable custody → the identity is replaced, not wedged ——
  {
    const keys = createMemoryKeys();
    let corrupted = true;
    const broken: SyncKeys & {
      records: Map<string, SyncDeviceRecord>;
    } = {
      ...keys,
      records: keys.records,
      async identityGet() {
        if (corrupted) {
          corrupted = false;
          throw shellError('corrupt-state', 'identity is not json');
        }
        return keys.identityGet();
      },
    };
    const service = createSyncService({
      host: '127.0.0.1',
      port: 0,
      keys: broken,
      endpointHost: '127.0.0.1',
      advertise: null,
    });
    try {
      const status = await service.ready;
      assertEqual(
        status.listener,
        'listening',
        'a corrupt record is replaced at startup',
      );
      const identity = await broken.identityGet();
      assert(identity !== null, 'replacement persisted');
    } finally {
      await service.close();
    }
  }

  // —— Non-JSON deltas are rejected at the contract ——
  {
    const { service } = await startService();
    try {
      const undefMember = await invokeHandler(service, 'sync:importDelta', {
        delta: { gone: undefined },
      });
      assert(
        !undefMember.ok && undefMember.error.kind === 'invalid-request',
        'an undefined member is outside the JSON domain',
      );
      const sparse = await invokeHandler(service, 'sync:importDelta', {
        delta: [1, , 2],
      });
      assert(
        !sparse.ok && sparse.error.kind === 'invalid-request',
        'a sparse array is outside the JSON domain',
      );
      const nan = await invokeHandler(service, 'sync:importDelta', {
        delta: { v: Number.NaN },
      });
      assert(
        !nan.ok && nan.error.kind === 'invalid-request',
        'NaN is outside the JSON domain',
      );
      const date = await invokeHandler(service, 'sync:importDelta', {
        delta: { at: new Date(0) },
      });
      assert(
        !date.ok && date.error.kind === 'invalid-request',
        'a Date serializes differently than it validates',
      );
      const mapped = await invokeHandler(service, 'sync:importDelta', {
        delta: { m: new Map() },
      });
      assert(
        !mapped.ok && mapped.error.kind === 'invalid-request',
        'a Map is outside the JSON domain',
      );
      const bare = Object.create(null) as Record<string, unknown>;
      bare['x'] = 1;
      const plain = await invokeHandler(service, 'sync:importDelta', {
        delta: bare,
      });
      assert(plain.ok, 'null-prototype records stay inside the domain');
    } finally {
      await service.close();
    }
  }

  // —— Unpair mid-handshake: resume must NOT resurrect the record ——
  {
    const { service, keys, port } = await startService();
    try {
      const pairing = await pairingCode(service);
      const peer = createTestPeer({
        deviceId: 'phone-zombie1',
        name: 'zombie',
      });
      const c1 = await dial(port);
      const h1 = await phoneHandshake(c1, peer, pairing.fp);
      c1.send(sealJson(h1.codec, { t: 'pair', code: pairing.code }));
      const welcome = openJson(h1.codec, await c1.recv());
      assert(
        isRecord(welcome) && welcome['t'] === 'welcome',
        'first pairing lands',
      );
      assertEqual(keys.records.size, 1);
      c1.close();
      // The second connection presents the SAME device key but claims
      // a different deviceId — the canonical registry id stays
      // 'phone-zombie1'. Unpairing that id can't kick this session
      // (kickDevice matches the claimed id), so the conditional touch
      // is the only guard against resurrecting the revoked record.
      const peer2 = createTestPeer({
        deviceId: 'phone-alias9x',
        name: 'zombie-alias',
        identity: peer.identity,
      });
      const c2 = await dial(port);
      const h2 = await phoneHandshake(c2, peer2, pairing.fp);
      const unpair = await invokeHandler(service, 'sync:unpair', {
        id: 'phone-zombie1',
      });
      assert(unpair.ok, 'unpair lands mid-handshake');
      assertEqual(keys.records.size, 0);
      c2.send(sealJson(h2.codec, { t: 'resume' }));
      const reply = openJson(h2.codec, await c2.recv());
      assert(
        isRecord(reply) &&
          reply['t'] === 'reject' &&
          reply['reason'] === 'unpaired',
        `expected unpaired reject, got ${JSON.stringify(reply)}`,
      );
      assertEqual(
        keys.records.size,
        0,
        'a revoked device is not resurrected',
      );
      c2.close();
    } finally {
      await service.close();
    }
  }

  // —— Two sessions racing one code: only the winner registers ——
  {
    const { service, keys, port } = await startService();
    try {
      const pairing = await pairingCode(service);
      const mk = async (deviceId: string) => {
        const client = await dial(port);
        const peer = createTestPeer({ deviceId, name: 'racer' });
        const h = await phoneHandshake(client, peer, pairing.fp);
        return { client, codec: h.codec };
      };
      const a = await mk('phone-race-a1');
      const b = await mk('phone-race-b1');
      a.client.send(sealJson(a.codec, { t: 'pair', code: pairing.code }));
      b.client.send(sealJson(b.codec, { t: 'pair', code: pairing.code }));
      const ra = openJson(a.codec, await a.client.recv());
      const rb = openJson(b.codec, await b.client.recv());
      const types = [ra, rb].map((m) =>
        isRecord(m) ? m['t'] : '?',
      );
      assert(
        types.includes('welcome') && types.includes('reject'),
        `one winner + one reject, got ${JSON.stringify([ra, rb])}`,
      );
      // The rejected client's key never enters the registry — it can
      // not resume later off a silently persisted record.
      assertEqual(keys.records.size, 1, 'only the winner registers');
      a.client.close();
      b.client.close();
    } finally {
      await service.close();
    }
  }

  // —— A device that opens mid-trigger still gets the kick ——
  {
    const keys = createMemoryKeys();
    let armNext = false;
    let release: (() => void) | null = null;
    const gated: SyncKeys = {
      ...keys,
      deviceList() {
        if (!armNext) {
          return keys.deviceList();
        }
        armNext = false;
        return new Promise((resolve) => {
          release = () => {
            keys.deviceList().then(resolve);
          };
        });
      },
    };
    const { service, port } = await startService({ keys: gated });
    try {
      const pairing = await pairingCode(service);
      const peer = createTestPeer({
        deviceId: 'phone-midtrig1',
        name: 'midtrigger',
      });
      const c1 = await dial(port);
      const h1 = await phoneHandshake(c1, peer, pairing.fp);
      c1.send(sealJson(h1.codec, { t: 'pair', code: pairing.code }));
      await c1.recv();
      c1.close();
      // Hold the trigger's registry read; the phone resumes inside the
      // window — its hello's own deviceList is ungated (arm consumed).
      armNext = true;
      const triggerP = invokeHandler(service, 'sync:trigger', undefined);
      await new Promise((r) => setTimeout(r, 10));
      const c2 = await dial(port);
      const h2 = await phoneHandshake(c2, peer, pairing.fp);
      c2.send(sealJson(h2.codec, { t: 'resume' }));
      const welcome = openJson(h2.codec, await c2.recv());
      assert(
        isRecord(welcome) && welcome['t'] === 'welcome',
        'resume lands during the held trigger',
      );
      release!();
      // The final live pass must see the just-opened session.
      const kick = openJson(h2.codec, await c2.recv());
      assert(
        isRecord(kick) && kick['t'] === 'sync-request',
        `mid-trigger device gets the kick, got ${JSON.stringify(kick)}`,
      );
      const trig = await triggerP;
      assert(
        trig.ok &&
          isRecord(trig.value) &&
          trig.value['triggered'] === true,
        'trigger reports the live kick',
      );
      c2.close();
    } finally {
      await service.close();
    }
  }

  // —— An undelivered kick keeps the device pending until it lands ——
  {
    const keys = createMemoryKeys();
    const { service, port } = await startService({ keys });
    try {
      const pairing = await pairingCode(service);
      const peer = createTestPeer({
        deviceId: 'phone-pending1',
        name: 'pending',
      });
      const c1 = await dial(port);
      const h1 = await phoneHandshake(c1, peer, pairing.fp);
      c1.send(sealJson(h1.codec, { t: 'pair', code: pairing.code }));
      await c1.recv();
      c1.close();
      await new Promise((r) => setTimeout(r, 20));
      // Trigger with the device gone: the kick has no live socket, so
      // the pending mark must survive — not clear on a dead send.
      const first = await invokeHandler(service, 'sync:trigger', undefined);
      assert(
        first.ok &&
          isRecord(first.value) &&
          first.value['pending'] === true,
        `offline device stays pending, got ${JSON.stringify(first)}`,
      );
      // Reconnect: enterOpen's kick must deliver AND clear the mark.
      const c2 = await dial(port);
      const h2 = await phoneHandshake(c2, peer, pairing.fp);
      c2.send(sealJson(h2.codec, { t: 'resume' }));
      const welcome = openJson(h2.codec, await c2.recv());
      assert(
        isRecord(welcome) && welcome['t'] === 'welcome',
        'resume succeeds for the pending device',
      );
      const kick = openJson(h2.codec, await c2.recv());
      assert(
        isRecord(kick) && kick['t'] === 'sync-request',
        `reconnect delivers the held kick, got ${JSON.stringify(kick)}`,
      );
      const second = await invokeHandler(service, 'sync:trigger', undefined);
      assert(
        second.ok &&
          isRecord(second.value) &&
          second.value['pending'] === false,
        'delivered kick cleared the pending mark',
      );
      c2.close();
    } finally {
      await service.close();
    }
  }

  // —— A contract-max delta doc crosses the wire both ways ——
  {
    const bigDoc = {
      changes: ['x'.repeat(MAX_SYNC_DOC_BYTES - 256)],
    };
    const { service, port } = await startService({
      engine: {
        exportDelta(): Promise<Result<unknown>> {
          return Promise.resolve(ok(bigDoc));
        },
        applyDelta(): Promise<Result<unknown>> {
          return Promise.resolve(ok({ applied: true }));
        },
      },
    });
    try {
      const pairing = await pairingCode(service);
      const { client, codec } = await pairPhone({
        port,
        deviceId: 'phone-maxdelta1',
        code: pairing.code,
        fp: pairing.fp,
      });
      client.send(
        sealJson(codec, { t: 'sync', since: 's', delta: bigDoc }),
      );
      const reply = openJson(codec, await client.recv());
      assert(
        isRecord(reply) &&
          reply['t'] === 'delta' &&
          isRecord(reply['delta']) &&
          Array.isArray(reply['delta']['changes']),
        `max-size delta crosses sealed frames, got ${JSON.stringify(reply).slice(0, 120)}`,
      );
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— Re-pair under a new id clears the stale pending mark ——
  {
    const { service, port } = await startService();
    try {
      // Device 'phone-repair-a' pairs, drops, and goes pending.
      const pairing1 = await pairingCode(service);
      const peer = createTestPeer({
        deviceId: 'phone-repair-a',
        name: 're',
      });
      const c1 = await dial(port);
      const h1 = await phoneHandshake(c1, peer, pairing1.fp);
      c1.send(
        sealJson(h1.codec, { t: 'pair', code: pairing1.code }),
      );
      await c1.recv();
      c1.close();
      await c1.closed;
      // The server's close event lands after the client's — wait for
      // the session to be reaped before the kick.
      for (let i = 0; i < 50; i += 1) {
        if ((await service.status()).sessions === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const trig = await invokeHandler(
        service,
        'sync:trigger',
        undefined,
      );
      assert(
        trig.ok &&
          isRecord(trig.value) &&
          trig.value['pending'] === true,
        'offline device is pending',
      );
      // Same key re-pairs under a NEW id — the old record dedupes
      // out and its pending mark must go with it.
      const pairing2 = await pairingCode(service);
      const peer2 = createTestPeer({
        deviceId: 'phone-repair-b',
        name: 're',
        identity: peer.identity,
      });
      const c2 = await dial(port);
      const h2 = await phoneHandshake(c2, peer2, pairing2.fp);
      c2.send(
        sealJson(h2.codec, { t: 'pair', code: pairing2.code }),
      );
      await c2.recv();
      const status = await service.status();
      assertEqual(status.pairedDevices, 1, 're-pair deduped the old id');
      // c2 stays open: the kick drains its (not-pending) state — only
      // the OLD id's mark can leak. Pre-fix this reported pending.
      const trig2 = await invokeHandler(
        service,
        'sync:trigger',
        undefined,
      );
      assert(
        trig2.ok &&
          isRecord(trig2.value) &&
          trig2.value['pending'] === false,
        'stale pending mark cleared with the re-pair',
      );
      c2.close();
    } finally {
      await service.close();
    }
  }

  // —— Custody failure propagates: sync:status fails typed ——
  {
    const keys = createMemoryKeys();
    let custodyDead = false;
    const flaky: SyncKeys = {
      ...keys,
      async deviceList() {
        if (custodyDead) {
          throw shellError('unavailable', 'safeStorage backend dead');
        }
        return keys.deviceList();
      },
    };
    const { service } = await startService({ keys: flaky });
    try {
      const healthy = await invokeHandler(
        service,
        'sync:status',
        undefined,
      );
      assert(healthy.ok, 'status healthy while custody lives');
      custodyDead = true;
      const degraded = await invokeHandler(
        service,
        'sync:status',
        undefined,
      );
      assert(
        !degraded.ok && degraded.error.kind === 'unavailable',
        'sync:status fails typed, not a fake empty registry',
      );
      const trig = await invokeHandler(
        service,
        'sync:trigger',
        undefined,
      );
      assert(
        !trig.ok && trig.error.kind === 'unavailable',
        'sync:trigger fails typed, not a false pending:false',
      );
    } finally {
      await service.close();
    }
  }

  // —— A hello carrying non-X25519 key material dies pre-challenge ——
  {
    const { service, keys, port } = await startService();
    try {
      await pairingCode(service);
      const peer = createTestPeer({
        deviceId: 'phone-badkey',
        name: 'badkey',
      });
      // Valid base64, wrong curve — an ed25519 key can't join a
      // noise-v1 handshake no matter how well-formed it looks.
      const wrongCurve = generateKeyPairSync('ed25519')
        .publicKey.export({ format: 'der', type: 'spki' })
        .toString('base64');
      for (const mutate of [
        (h: Record<string, unknown>) => {
          h['eph'] = 'not-base64!!!';
        },
        (h: Record<string, unknown>) => {
          h['dev'] = wrongCurve;
        },
      ]) {
        const client = await dial(port);
        const hello = peer.hello() as unknown as Record<string, unknown>;
        mutate(hello);
        client.send(Buffer.from(JSON.stringify(hello), 'utf8'));
        // Killed at the shape gate — no challenge is ever written.
        const sawFrame = await client.recv().then(
          () => true,
          () => false,
        );
        assertEqual(sawFrame, false, 'a bad key dies pre-challenge');
        client.close();
      }
      assertEqual(keys.records.size, 0);
    } finally {
      await service.close();
    }
  }

  // —— A primitive applyDelta receipt is a legal import result ——
  {
    const { service } = await startService({
      engine: {
        exportDelta(): Promise<Result<unknown>> {
          return Promise.resolve(ok({}));
        },
        applyDelta(): Promise<Result<unknown>> {
          return Promise.resolve(ok(null));
        },
      },
    });
    try {
      const reply = await invokeHandler(service, 'sync:importDelta', {
        delta: { a: 1 },
      });
      assert(
        reply.ok &&
          isRecord(reply.value) &&
          reply.value['result'] === null,
        'ok(null) is a valid receipt, not invalid-response',
      );
    } finally {
      await service.close();
    }
  }

  // —— Real engines through the socket: two devices converge ——
  // The desktop's service carries a real SyncEngine behind the
  // adapter; the phone half is the same stack with its own store.
  // Writes on BOTH sides cross over one sealed session.
  {
    const desk = await testUtilityEngine('dsk-e2e');
    const phone = await testUtilityEngine('phone-e2e');
    await desk.localChanges(
      [writeName('pl-desk', 'desk list')],
      undefined,
    );
    await phone.localChanges(
      [writeName('pl-phone', 'phone list')],
      undefined,
    );
    const { service, port } = await startService({ engine: desk.port });
    try {
      const status = await service.status();
      assertEqual(status.engine, 'ready', 'engine reports ready');
      const pairing = await pairingCode(service);
      const { client, codec } = await pairPhone({
        port,
        deviceId: 'phone-e2e',
        code: pairing.code,
        fp: pairing.fp,
      });
      // Phone → desk: the phone's own export is the apply doc.
      const phoneDelta = await phone.port.exportDelta('', undefined);
      assert(phoneDelta.ok);
      if (!phoneDelta.ok) {
        return;
      }
      client.send(
        sealJson(codec, {
          t: 'sync',
          since: '',
          delta: phoneDelta.value,
        }),
      );
      const reply = await openJson(codec, await client.recv());
      assert(
        isRecord(reply) && reply['t'] === 'delta',
        `expected delta, got ${JSON.stringify(reply)}`,
      );
      const deskDelta = reply['delta'] as SyncDelta;
      assertEqual(deskDelta.senderDeviceId, 'dsk-e2e');
      assert(
        deskDelta.entries.some(
          (e) => e.recordId === 'pl-desk' && e.deviceId === 'dsk-e2e',
        ),
        'reply carries the desk-side write',
      );
      // Desk → phone: apply the reply on the phone's engine — it
      // must record the desk entry AND move its watermark.
      const applied = await phone.port.applyDelta(
        JSON.parse(JSON.stringify(deskDelta)),
        'dsk-e2e',
        undefined,
      );
      assert(applied.ok);
      if (applied.ok) {
        const result = applied.value as ApplyResult;
        assert(
          result.entries.some(
            (e) => e.recordId === 'pl-desk' && e.deviceId === 'dsk-e2e',
          ),
          'phone converged on the desk write',
        );
        assertEqual(result.cursor['dsk-e2e'], 1);
      }
      // Continuation: since=<reply cursor> returns only what's new.
      const follow = await desk.localChanges(
        [writeName('pl-desk-2', 'second list')],
        undefined,
      );
      assert(follow.ok);
      const replyCursor = JSON.stringify(deskDelta.cursor);
      client.send(
        sealJson(codec, { t: 'sync', since: replyCursor }),
      );
      const reply2 = await openJson(codec, await client.recv());
      assert(isRecord(reply2) && reply2['t'] === 'delta');
      const deskDelta2 = reply2['delta'] as SyncDelta;
      assertEqual(deskDelta2.entries.length, 1);
      assertEqual(deskDelta2.entries[0]?.recordId, 'pl-desk-2');
      client.close();
    } finally {
      await service.close();
    }
  }

  // —— Channels on the real engine: deltas/importDelta/localChanges ——
  {
    const desk = await testUtilityEngine('dsk-chan');
    const { service } = await startService({
      engine: desk.port,
      localChanges: (writes, signal) =>
        desk.localChanges(writes, signal),
    });
    try {
      // Renderer-committed write lands in the change log.
      const changed = await invokeHandler(service, 'sync:localChanges', {
        writes: [writeName('pl-c1', 'channel list')],
      });
      assert(changed.ok, `localChanges: ${JSON.stringify(changed)}`);
      // Small ack: the channel returns the stamped count, not the
      // serialized batch — the batch already landed, and echoing it
      // could overflow the result cap into a fake transport failure
      // (Review #46 round-9).
      const changedResult = changed.ok
        ? (changed.value as { accepted: number })
        : null;
      assertEqual(changedResult?.accepted, 1);

      // A write outside the engine's whitelist fails the whole batch
      // typed — never a per-write reject riding inside an ok.
      const refused = await invokeHandler(service, 'sync:localChanges', {
        writes: [
          {
            kind: 'playlist',
            recordId: 'pl-c2',
            field: 'bogus',
            value: 1,
          },
        ],
      });
      assert(!refused.ok);
      assertEqual(refused.error.kind, 'invalid-request');

      // Malformed args never reach the engine.
      const malformed = await invokeHandler(service, 'sync:localChanges', {
        writes: [],
      });
      assert(!malformed.ok);
      assertEqual(malformed.error.kind, 'invalid-request');

      // The committed write exports through sync:deltas.
      const deltas = await invokeHandler(service, 'sync:deltas', {
        since: '',
      });
      assert(deltas.ok);
      const deltaValue = deltas.ok
        ? (deltas.value as { delta: SyncDelta }).delta
        : null;
      assert(
        deltaValue !== null &&
          deltaValue.entries.some((e) => e.recordId === 'pl-c1'),
        'exported delta carries the committed write',
      );

      // And a real phone-built delta imports through importDelta.
      const phone = await testUtilityEngine('phone-chan');
      await phone.localChanges(
        [writeName('pl-imp', 'imported list')],
        undefined,
      );
      const phoneDelta = await phone.port.exportDelta('', undefined);
      assert(phoneDelta.ok);
      if (!phoneDelta.ok) {
        return;
      }
      const imported = await invokeHandler(service, 'sync:importDelta', {
        delta: JSON.parse(JSON.stringify(phoneDelta.value)),
      });
      assert(imported.ok);
      const applied = imported.ok
        ? (imported.value as { result: ApplyResult }).result
        : null;
      assert(
        applied !== null &&
          applied.entries.some(
            (e) =>
              e.recordId === 'pl-imp' && e.deviceId === 'phone-chan',
          ),
        'imported delta lands in the desk log',
      );
      assertEqual(applied?.cursor['phone-chan'], 1);
    } finally {
      await service.close();
    }
  }

  // —— localChanges absent: typed unavailable ——
  {
    const { service } = await startService();
    try {
      const reply = await invokeHandler(service, 'sync:localChanges', {
        writes: [writeName('pl-z', 'nope')],
      });
      assert(!reply.ok);
      assertEqual(reply.error.kind, 'unavailable');
    } finally {
      await service.close();
    }
  }

  // —— Promise engine: settles inside start(), status 'ready' ——
  {
    const desk = await testUtilityEngine('dsk-prom');
    const { service } = await startService({
      engine: Promise.resolve(desk.port),
    });
    try {
      const status = await service.status();
      assertEqual(status.engine, 'ready', 'promise engine resolved');
      const deltas = await invokeHandler(service, 'sync:deltas', {
        since: '',
      });
      assert(deltas.ok, 'deltas answer on the resolved engine');
    } finally {
      await service.close();
    }
  }

  // —— A rejected engine promise degrades to absent ——
  {
    const { service } = await startService({
      engine: Promise.resolve(null),
    });
    try {
      const status = await service.status();
      assertEqual(status.engine, 'absent', 'null engine degrades');
      const deltas = await invokeHandler(service, 'sync:deltas', {
        since: '',
      });
      assert(!deltas.ok);
      assertEqual(deltas.error.kind, 'unavailable');
    } finally {
      await service.close();
    }
  }

  // —— Applied outbox: applied outcomes queue → drainApplied pages ——
  // The renderer pulls the outbox in byte-bounded chunks; both bounds
  // (drop-oldest cap + per-chunk byte budget) get exercised by one
  // oversized import.
  {
    const desk = await testUtilityEngine('dsk-outbox');
    const notified: number[] = [];
    const { service } = await startService({
      engine: desk.port,
      notifyApplied: (pending: number) => {
        notified.push(pending);
      },
    });
    try {
      // Nothing applied yet — the drain answers honestly empty.
      const empty = await invokeHandler(
        service,
        'sync:drainApplied',
        undefined,
      );
      assertDeepEqual(
        empty.ok ? empty.value : null,
        { outcomes: [], dropped: false, remaining: 0 },
        'empty drain reports empty',
      );

      // A phone-built delta imports through importDelta — each applied
      // outcome lands in the outbox and fires notifyApplied.
      const phone = await testUtilityEngine('phone-outbox');
      await phone.localChanges(
        [writeName('pl-ob', 'outbox list')],
        undefined,
      );
      const phoneDelta = await phone.port.exportDelta('', undefined);
      assert(phoneDelta.ok);
      if (!phoneDelta.ok) {
        return;
      }
      const imported = await invokeHandler(service, 'sync:importDelta', {
        delta: JSON.parse(JSON.stringify(phoneDelta.value)),
      });
      assert(imported.ok, `importDelta: ${JSON.stringify(imported)}`);
      assert(notified.length > 0, 'notifyApplied fired for the outbox');

      const drained = await invokeHandler(
        service,
        'sync:drainApplied',
        undefined,
      );
      assert(drained.ok);
      const first = drained.ok
        ? (drained.value as {
            outcomes: readonly unknown[];
            dropped: boolean;
            remaining: number;
          })
        : null;
      assert(first !== null);
      assert(first.outcomes.length > 0, 'applied outcomes drained');
      assert(
        first.outcomes.every(
          (o) => isRecord(o) && o['type'] === 'applied',
        ),
        'only applied outcomes queue',
      );
      assertEqual(first.dropped, false);
      assertEqual(first.remaining, 0, 'outbox consumed fully');

      // The pull consumed them — a second drain is empty again.
      const again = await invokeHandler(
        service,
        'sync:drainApplied',
        undefined,
      );
      assertDeepEqual(
        again.ok ? again.value : null,
        { outcomes: [], dropped: false, remaining: 0 },
        'second drain empty',
      );
    } finally {
      await service.close();
    }
  }

  // —— Outbox bounds: >4096 applied + ~700 B entries force both the ——
  // —— drop-oldest flag and a multi-chunk byte-budgeted drain.      ——
  {
    const desk = await testUtilityEngine('dsk-bounds');
    const { service } = await startService({ engine: desk.port });
    try {
      const phone = await testUtilityEngine('phone-bounds');
      // 4_200 writes, ~512-char values → ~2.9 MB of applied outcomes,
      // past both the 4_096 cap and the ~1 MB chunk budget. Each
      // importDelta call itself stays under the doc byte cap — the
      // cursor walks the phone's log in slices.
      const pad = 'x'.repeat(480);
      let since = '';
      // 500-entry pages: the importDelta RESULT carries entries AND
      // outcomes, so a page this size stays inside the doc byte cap.
      for (let i = 0; i < 4_200; i += 500) {
        for (let j = i; j < i + 500 && j < 4_200; j += 256) {
          const batch = Array.from(
            { length: Math.min(256, 4_200 - j) },
            (_, k) => writeName(`pl-b${j + k}`, `${pad}-${j + k}`),
          );
          const wrote = await phone.localChanges(batch, undefined);
          assert(wrote.ok, 'bulk localChanges failed');
        }
        const page = await phone.port.exportDelta(since, undefined);
        assert(page.ok);
        if (!page.ok) {
          return;
        }
        const imported = await invokeHandler(
          service,
          'sync:importDelta',
          {
            delta: JSON.parse(JSON.stringify(page.value)),
          },
        );
        assert(imported.ok, `importDelta: ${JSON.stringify(imported)}`);
        since = JSON.stringify((page.value as SyncDelta).cursor);
      }

      let total = 0;
      let sawDropped = false;
      let chunks = 0;
      for (;;) {
        const drained = await invokeHandler(
          service,
          'sync:drainApplied',
          undefined,
        );
        assert(drained.ok, 'drain failed');
        if (!drained.ok) {
          return;
        }
        const page = drained.value as {
          outcomes: readonly unknown[];
          dropped: boolean;
          remaining: number;
        };
        total += page.outcomes.length;
        sawDropped ||= page.dropped;
        chunks += 1;
        if (page.remaining === 0) {
          break;
        }
        assert(chunks < 64, 'drain must terminate');
      }
      assert(sawDropped, 'drop-oldest flag surfaced');
      assert(chunks > 1, 'byte budget paged the drain');
      assertEqual(total, 4_096, 'outbox kept only the capped tail');
    } finally {
      await service.close();
    }
  }

  // —— Durable spill: every applied outcome writes through to ——
  // —— sync-applied.jsonl before the import acks, drain PEEKS and ——
  // —— ack consumes — a fresh service inherits the backlog across ——
  // —— a restart (Devin Review #46).                           ——
  {
    const dir = await mkdtemp(join(tmpdir(), 'auqw-spill-'));
    const spill = join(dir, 'sync-applied.jsonl');
    const desk = await testUtilityEngine('dsk-spill');
    const { service } = await startService({
      engine: desk.port,
      appliedSpillPath: spill,
    });
    try {
      const phone = await testUtilityEngine('phone-spill');
      // 6_500 applied outcomes all write through to the JSONL file
      // — more than one drain page's byte budget (~1 MB ≈ ~1_700
      // outcomes), so a file remainder survives for the restarted
      // service.
      const pad = 'x'.repeat(480);
      let since = '';
      for (let i = 0; i < 6_500; i += 500) {
        for (let j = i; j < i + 500 && j < 6_500; j += 256) {
          const batch = Array.from(
            { length: Math.min(256, 6_500 - j) },
            (_, k) => writeName(`pl-s${j + k}`, `${pad}-${j + k}`),
          );
          const wrote = await phone.localChanges(batch, undefined);
          assert(wrote.ok, 'bulk localChanges failed');
        }
        const page = await phone.port.exportDelta(since, undefined);
        assert(page.ok);
        if (!page.ok) {
          return;
        }
        const imported = await invokeHandler(
          service,
          'sync:importDelta',
          {
            delta: JSON.parse(JSON.stringify(page.value)),
          },
        );
        assert(imported.ok, `importDelta: ${JSON.stringify(imported)}`);
        since = JSON.stringify((page.value as SyncDelta).cursor);
      }

      const spilledFile = await stat(spill).catch(() => null);
      assert(spilledFile !== null, 'spill file written');

      // One drain on the first service: byte budget pages it and
      // leaves a file remainder. The drain is a peek — no ack — so
      // the file keeps every served line for the restarted service.
      const first = await invokeHandler(
        service,
        'sync:drainApplied',
        undefined,
      );
      assert(first.ok, 'first drain failed');
      const firstPage = first.ok
        ? (first.value as {
            outcomes: readonly unknown[];
            dropped: boolean;
            remaining: number;
          })
        : null;
      assert(firstPage !== null);
      assert(
        firstPage.outcomes.length > 0,
        'first drain served outcomes',
      );
      assert(firstPage.remaining > 0, 'backlog remains after page');
      // An un-acked second drain re-serves the same file prefix —
      // the peek consumed nothing.
      const again = await invokeHandler(
        service,
        'sync:drainApplied',
        undefined,
      );
      assert(again.ok, 'repeat drain failed');
      if (again.ok) {
        const againPage = again.value as {
          outcomes: readonly unknown[];
        };
        assertEqual(
          againPage.outcomes.length,
          firstPage.outcomes.length,
          'un-acked drain re-serves the same prefix',
        );
      }
      await service.close();

      // A fresh service on the same spill path inherits the backlog —
      // its own volatile outbox is empty, so anything it serves came
      // from the durable file.
      const restarted = await startService({
        engine: desk.port,
        appliedSpillPath: spill,
      });
      try {
        let rest = 0;
        let restDropped = false;
        for (;;) {
          const drained = await invokeHandler(
            restarted.service,
            'sync:drainApplied',
            undefined,
          );
          assert(drained.ok, 'restarted drain failed');
          if (!drained.ok) {
            return;
          }
          const page = drained.value as {
            outcomes: readonly unknown[];
            dropped: boolean;
            remaining: number;
          };
          rest += page.outcomes.length;
          restDropped ||= page.dropped;
          // The peek only leaves disk at ack — consume each page so
          // the next drain serves the next segment.
          const acked = await invokeHandler(
            restarted.service,
            'sync:ackApplied',
            undefined,
          );
          assert(acked.ok, 'restarted ack failed');
          if (page.remaining === 0) {
            break;
          }
        }
        assert(rest > 0, 'restarted service drained spilled backlog');
        assert(!restDropped, 'durable path reports nothing dropped');
        const tail = await stat(spill);
        assertEqual(tail.size, 0, 'ack consumed the spill file');
      } finally {
        await restarted.service.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // —— Ack persists a byte-offset sidecar instead of rewriting the ——
  // —— file: post-ack drains serve only the tail past the offset ——
  // —— (Devin Review #46 round-6).                            ——
  {
    const dir = await mkdtemp(join(tmpdir(), 'auqw-spill-off-'));
    const spill = join(dir, 'sync-applied.jsonl');
    const desk = await testUtilityEngine('dsk-off');
    const { service } = await startService({
      engine: desk.port,
      appliedSpillPath: spill,
    });
    try {
      const phone = await testUtilityEngine('phone-off');
      for (const name of ['pl-off-a', 'pl-off-b', 'pl-off-c']) {
        const wrote = await phone.localChanges(
          [writeName(name, name)],
          undefined,
        );
        assert(wrote.ok, 'localChanges failed');
      }
      const page = await phone.port.exportDelta('', undefined);
      assert(page.ok);
      if (!page.ok) {
        return;
      }
      const imported = await invokeHandler(service, 'sync:importDelta', {
        delta: JSON.parse(JSON.stringify(page.value)),
      });
      assert(imported.ok, 'importDelta failed');

      const before = await stat(spill);
      const drained = await invokeHandler(
        service,
        'sync:drainApplied',
        undefined,
      );
      assert(drained.ok, 'drain failed');
      const served = drained.ok
        ? (drained.value as { outcomes: readonly unknown[] })
        : { outcomes: [] };
      assert(served.outcomes.length > 0, 'drain served outcomes');

      const acked = await invokeHandler(
        service,
        'sync:ackApplied',
        undefined,
      );
      assert(acked.ok, 'ack failed');

      // The offset sidecar now records the consumed prefix; the JSONL
      // is untouched — below the compaction threshold it keeps its
      // full contents (a stale offset self-heals via off > size).
      const offRaw = await readFile(`${spill}.off`, 'utf8');
      assertEqual(
        Number.parseInt(offRaw.trim(), 10),
        before.size,
        'sidecar offset covers every served byte',
      );
      const after = await stat(spill);
      assertEqual(
        after.size,
        before.size,
        'ack under the compaction threshold leaves the file alone',
      );

      // A post-ack drain serves nothing — the offset skipped every
      // consumed line; another import lands past the offset.
      const again = await invokeHandler(
        service,
        'sync:drainApplied',
        undefined,
      );
      assert(again.ok, 'post-ack drain failed');
      if (again.ok) {
        const page2 = again.value as {
          outcomes: readonly unknown[];
          remaining: number;
        };
        assertEqual(
          page2.outcomes.length,
          0,
          'acked lines never re-serve',
        );
        assertEqual(page2.remaining, 0, 'backlog fully consumed');
      }
    } finally {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  // —— Compaction commits sidecar(0) BEFORE the data rename, so the ——
  // —— only reachable post-compact generation is {off: 0, new file}; ——
  // —— a stale positive offset can never sit beside the compacted  ——
  // —— layout and skip unserved rows (Devin Review #46 round-8).   ——
  {
    const dir = await mkdtemp(join(tmpdir(), 'auqw-spill-gen-'));
    const spill = join(dir, 'sync-applied.jsonl');
    // ~1.2 MB of parseable JSON lines — a backlog big enough that the
    // second ack crosses the 1 MiB compaction watermark.
    const pad = 'x'.repeat(48_000);
    const lines: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      lines.push(JSON.stringify({ pad, i }));
    }
    await writeFile(spill, `${lines.join('\n')}\n`);
    const seeded = await stat(spill);
    assert(seeded.size > 1_048_576, 'seeded backlog crosses the watermark');

    const desk = await testUtilityEngine('dsk-gen');
    const { service } = await startService({
      engine: desk.port,
      appliedSpillPath: spill,
    });
    try {
      for (;;) {
        const drained = await invokeHandler(
          service,
          'sync:drainApplied',
          undefined,
        );
        assert(drained.ok, 'drain failed');
        if (!drained.ok) {
          return;
        }
        const page = drained.value as { remaining: number };
        const acked = await invokeHandler(
          service,
          'sync:ackApplied',
          undefined,
        );
        assert(acked.ok, 'ack failed');
        if (page.remaining === 0) {
          break;
        }
      }
      // Whole backlog acked → the compacted generation is {off: 0,
      // empty file}: the zero sidecar commits before the data rename,
      // so a crash mid-compact re-serves (never skips) old rows.
      const offRaw = await readFile(`${spill}.off`, 'utf8');
      assertEqual(
        Number.parseInt(offRaw.trim(), 10),
        0,
        'compacted generation commits a zero offset',
      );
      const tail = await stat(spill);
      assertEqual(tail.size, 0, 'compacted file holds only the unacked tail');

      const restarted = await startService({
        engine: desk.port,
        appliedSpillPath: spill,
      });
      try {
        const drained = await invokeHandler(
          restarted.service,
          'sync:drainApplied',
          undefined,
        );
        assert(drained.ok);
        if (drained.ok) {
          const page = drained.value as {
            outcomes: readonly unknown[];
            remaining: number;
          };
          assertEqual(
            page.outcomes.length,
            0,
            'no stale offset skips — compacted file drains empty',
          );
          assertEqual(page.remaining, 0);
        }
      } finally {
        await restarted.service.close();
      }
    } finally {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  // —— A spill line bigger than the page budget can never be served ——
  // —— returning it as `remaining` forever would wedge every later ——
  // —— projection. It consumes as poison: skipped bytes, dropped    ——
  // —— flag set, and the drain still serves the lines behind it.   ——
  // —— (Devin Review #46 round-9)                                  ——
  {
    const dir = await mkdtemp(join(tmpdir(), 'auqw-spill-poison-'));
    const spill = join(dir, 'sync-applied.jsonl');
    const poison = JSON.stringify({ pad: 'p'.repeat(1_100_000) });
    const tail = ['{"k":"a"}', '{"k":"b"}', '{"k":"c"}'];
    await writeFile(spill, `${poison}\n${tail.join('\n')}\n`);

    const desk = await testUtilityEngine('dsk-poison');
    const { service } = await startService({
      engine: desk.port,
      appliedSpillPath: spill,
    });
    try {
      // Page 1: the poison head self-advances the durable offset —
      // nothing deliverable, but `remaining` stays honest so the
      // drain loop keeps going instead of wedging on it.
      const first = await invokeHandler(
        service,
        'sync:drainApplied',
        undefined,
      );
      assert(first.ok, 'drain failed');
      if (!first.ok) {
        return;
      }
      const page = first.value as {
        outcomes: readonly unknown[];
        dropped: boolean;
        remaining: number;
      };
      assertEqual(
        page.outcomes.length,
        0,
        'a poison-only page serves nothing — it self-advances',
      );
      assert(page.dropped, 'poison skip surfaces as dropped');
      assertEqual(page.remaining, 3, 'the servable tail is still due');

      // Page 2: the offset already passed the poison — the tail
      // lands without re-scanning it.
      const second = await invokeHandler(
        service,
        'sync:drainApplied',
        undefined,
      );
      assert(second.ok, 'second drain failed');
      if (!second.ok) {
        return;
      }
      const tail = second.value as {
        outcomes: readonly unknown[];
        remaining: number;
      };
      assertEqual(
        tail.outcomes.length,
        3,
        'lines behind the poison still project',
      );
      assertEqual(tail.remaining, 0);

      const acked = await invokeHandler(
        service,
        'sync:ackApplied',
        undefined,
      );
      assert(acked.ok, 'ack failed');
      const again = await invokeHandler(
        service,
        'sync:drainApplied',
        undefined,
      );
      assert(again.ok);
      if (again.ok) {
        const next = again.value as { outcomes: readonly unknown[] };
        assertEqual(
          next.outcomes.length,
          0,
          'poison consumed — no re-serve loop',
        );
      }
    } finally {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  // —— close() must settle the spill tail: a drain already on the ——
  // —— chain finishes its offset advance before close() resolves   ——
  // —— (Devin Review #46 round-10).                                ——
  {
    const dir = await mkdtemp(join(tmpdir(), 'auqw-spill-close-'));
    const spill = join(dir, 'sync-applied.jsonl');
    const poison = JSON.stringify({ pad: 'p'.repeat(1_100_000) });
    await writeFile(spill, `${poison}\n{"k":"a"}\n`);

    const desk = await testUtilityEngine('dsk-close');
    const { service } = await startService({
      engine: desk.port,
      appliedSpillPath: spill,
    });
    try {
      const drainPromise = invokeHandler(
        service,
        'sync:drainApplied',
        undefined,
      );
      // close() while the drain's tail work may still be queued —
      // the poison self-advance + compaction must land before
      // close() resolves.
      await service.close();
      await drainPromise.catch(() => undefined);
      const settled = await stat(spill);
      assertEqual(
        settled.size,
        10,
        'in-flight spill work settled before close resolved',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
