// The interop halves below run under `node --experimental-strip-types`
// (the mobile test runner) — node:crypto supplies the desktop-side
// reference derivation. `/// types="node"` because bundler resolution
// here doesn't auto-include @types/node for bare builtin specifiers.
/// <reference types="node" />
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes as nodeRandom,
} from 'crypto';
import { Buffer } from 'buffer';
import type { ClientHello, SyncIdentity } from '@auqw/application';
import { assert, assertEqual } from '@auqw/application/testing';
import {
  createNobleIdentity,
  createNobleSyncCrypto,
  createNobleSyncResponder,
  nobleFingerprintOf,
} from './noble-sync-crypto.ts';

/**
 * noise-v1 interop: the noble responder is proven against a node:crypto
 * client (the desktop dialer's construction) AND the noble client
 * against a node:crypto responder (the desktop server's). Both halves
 * must derive the same session keys — a frame sealed on one side opens
 * on the other, in both directions. The node doubles here mirror
 * apps/desktop's sync-crypto.ts derivations verbatim.
 */

const randomBytes = (n: number): Uint8Array => new Uint8Array(nodeRandom(n));

function nodeIdentity(): SyncIdentity {
  const pair = generateKeyPairSync('x25519');
  return {
    pub: pair.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
    priv: pair.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
  };
}

function nodeFp(spkiB64: string): string {
  return createHash('sha256')
    .update(Buffer.from(spkiB64, 'base64'))
    .digest('hex');
}

function nodeX25519(privPkcs8B64: string, pubSpkiB64: string): Buffer {
  const priv = createPrivateKey({
    key: Buffer.from(privPkcs8B64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const pub = createPublicKey({
    key: Buffer.from(pubSpkiB64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return diffieHellman({ privateKey: priv, publicKey: pub });
}

function nodeCodec(sendKey: Buffer, recvKey: Buffer) {
  let sendSeq = 0n;
  let recvSeq = 0n;
  const ivOf = (seq: bigint): Buffer => {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64LE(seq, 4);
    return iv;
  };
  return {
    seal(plain: Uint8Array): Uint8Array {
      const iv = ivOf(sendSeq);
      sendSeq += 1n;
      const cipher = createCipheriv('aes-256-gcm', sendKey, iv);
      const ct = Buffer.concat([
        cipher.update(Buffer.from(plain)),
        cipher.final(),
      ]);
      return new Uint8Array(Buffer.concat([iv, ct, cipher.getAuthTag()]));
    },
    open(frame: Uint8Array): Uint8Array {
      const buf = Buffer.from(frame);
      const iv = buf.subarray(0, 12);
      const seq = iv.readBigUInt64LE(4);
      if (seq !== recvSeq) {
        throw new Error('out of sequence');
      }
      recvSeq += 1n;
      const tag = buf.subarray(buf.length - 16);
      const ct = buf.subarray(12, buf.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', recvKey, iv);
      decipher.setAuthTag(tag);
      return new Uint8Array(
        Buffer.concat([decipher.update(ct), decipher.final()]),
      );
    },
  };
}

/** The desktop dialer's client half — node:crypto, mirrors TestPeer. */
function nodeClient(identity: SyncIdentity, deviceId: string, name: string) {
  const eph = generateKeyPairSync('x25519');
  const ephPub = eph.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  const ephPriv = eph.privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64');
  return {
    hello(): ClientHello {
      return {
        v: 1,
        kind: 'hello',
        deviceId,
        name,
        eph: ephPub,
        dev: identity.pub,
      };
    },
    complete(challengeJson: unknown) {
      const c = challengeJson as {
        eph: string;
        salt: string;
        spub: string;
        registered: boolean;
      };
      const salt = Buffer.from(c.salt, 'base64');
      const dh1 = nodeX25519(ephPriv, c.eph);
      const dh2 = nodeX25519(identity.priv, c.eph);
      const dh3 = nodeX25519(ephPriv, c.spub);
      const keys = Buffer.from(
        hkdfSync(
          'sha256',
          Buffer.concat([dh1, dh2, dh3]),
          salt,
          'auqw-sync-v1',
          64,
        ),
      );
      return {
        codec: nodeCodec(keys.subarray(0, 32), keys.subarray(32, 64)),
        serverFp: nodeFp(c.spub),
        registered: c.registered,
      };
    },
  };
}

async function nobleResponderToNodeClient(): Promise<void> {
  const serverId = nodeIdentity();
  const clientId = nodeIdentity();
  const responder = createNobleSyncResponder({
    identity: serverId,
    randomBytes,
  });
  const client = nodeClient(clientId, 'desk-test-1', 'desktop');
  const accepted = responder.accept(client.hello(), { registered: false });
  const challenge = JSON.parse(
    Buffer.from(accepted.challenge).toString('utf8'),
  ) as unknown;
  const done = client.complete(challenge);
  const sealed = done.codec.seal(new TextEncoder().encode('ping'));
  const opened = accepted.codec.open(sealed);
  assertEqual(Buffer.from(opened).toString('utf8'), 'ping');
  const back = accepted.codec.seal(new TextEncoder().encode('pong'));
  assertEqual(Buffer.from(done.codec.open(back)).toString('utf8'), 'pong');
  assertEqual(done.serverFp, nobleFingerprintOf(serverId.pub));
  assertEqual(done.serverFp, nodeFp(serverId.pub));
  assertEqual(accepted.peer.devFp, nodeFp(clientId.pub));
}

async function nodeResponderToNobleClient(): Promise<void> {
  const serverId = nodeIdentity();
  const clientIdentity = createNobleIdentity(randomBytes);
  // The desktop server's accept(), verbatim construction in node:crypto.
  const accept = (hello: ClientHello, registered: boolean) => {
    const eph = generateKeyPairSync('x25519');
    const salt = nodeRandom(32);
    const ephPriv = eph.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    const dh1 = nodeX25519(ephPriv, hello.eph);
    const dh2 = nodeX25519(ephPriv, hello.dev);
    const dh3 = nodeX25519(serverId.priv, hello.eph);
    const keys = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.concat([dh1, dh2, dh3]),
        salt,
        'auqw-sync-v1',
        64,
      ),
    );
    return {
      codec: nodeCodec(keys.subarray(32, 64), keys.subarray(0, 32)),
      challenge: Buffer.from(
        JSON.stringify({
          v: 1,
          kind: 'challenge',
          eph: eph.publicKey
            .export({ format: 'der', type: 'spki' })
            .toString('base64'),
          salt: salt.toString('base64'),
          spub: serverId.pub,
          registered,
        }),
        'utf8',
      ),
    };
  };
  const client = createNobleSyncCrypto({ identity: clientIdentity, randomBytes });
  const session = client.begin({ deviceId: 'phone-test-1', name: 'phone' });
  const hello = session.hello();
  const accepted = accept(hello, true);
  const done = session.complete(
    JSON.parse(accepted.challenge.toString('utf8')),
    {},
  );
  assert(done.ok, 'noble client accepts the node challenge');
  if (!done.ok) {
    return;
  }
  const codec = done.value.codec;
  const sealed = codec.seal(new TextEncoder().encode('ping'));
  assertEqual(
    Buffer.from(accepted.codec.open(sealed)).toString('utf8'),
    'ping',
  );
  const back = accepted.codec.seal(new TextEncoder().encode('pong'));
  assertEqual(Buffer.from(codec.open(back)).toString('utf8'), 'pong');
  assertEqual(done.value.serverFp, nodeFp(serverId.pub));
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['nobleResponderToNodeClient', nobleResponderToNodeClient],
  ['nodeResponderToNobleClient', nodeResponderToNobleClient],
];

export async function run(): Promise<void> {
  for (const [name, fn] of TESTS) {
    try {
      await fn();
    } catch (thrown) {
      throw new Error(`noble-sync-responder test failed: ${name}`, {
        cause: thrown,
      });
    }
  }
}
