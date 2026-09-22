import {
  createServer,
  createConnection,
  type Socket,
} from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import {
  ok,
  type Result,
  type SyncEngine,
} from '@auqw/application';
import { isShellError, shellError } from '../shared/errors.ts';
import { isRecord } from '../shared/check.ts';
import { createTestPeer, type SessionCodec } from './sync-crypto.ts';
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
    code: String(result['code']),
    fp: String(payload['fp']),
    expiresAt: Number(result['expiresAt']),
  };
}

/** Engine double: echoes since and records applied deltas. */
function createEchoEngine(): SyncEngine & {
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
}
