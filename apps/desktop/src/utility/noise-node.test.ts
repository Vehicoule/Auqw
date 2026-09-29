import { assert, assertEqual } from '@auqw/application/testing';
import {
  createNoiseSuite,
  isSyncIdentity,
  noisePkcs8B64,
  noiseSpkiB64,
  type NoisePrimitives,
  type NoiseSuite,
  type SyncFrameCodec,
} from '@auqw/application';
import { createNoiseTestPeer } from '@auqw/application/testing';
import { nobleNoisePrimitives } from '../../../mobile/src/adapters/noble-sync-crypto.ts';
import { nodeNoise, nodeNoisePrimitives } from './noise-node.ts';

/**
 * The desktop noise-v1 adapter on node:crypto — custody minting,
 * fingerprint stability, codec round-trip/tamper/sequence binding,
 * the strict hello gate, and the golden-vector proof that a fixed
 * transcript seals byte-identical frames under BOTH the node and the
 * noble (mobile) backends. The noble import resolves through
 * apps/mobile's dependencies — the same seam the phone e2e uses.
 */

const hexOf = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('hex');
const utf8 = (text: string): Uint8Array => Buffer.from(text, 'utf8');

// Fixed raw key material — 32-byte scalars both backends clamp the
// same way. Ordering matches the scripted mint/draw sequence below.
const CALLER_DEV_PRIV = new Uint8Array(32).fill(0x11);
const CALLER_EPH_PRIV = new Uint8Array(32).fill(0x02);
const SERVER_DEV_PRIV = new Uint8Array(32).fill(0x22);
const SERVER_EPH_PRIV = new Uint8Array(32).fill(0x03);
const HANDSHAKE_SALT = new Uint8Array(32).fill(0xaa);

/** The script every backend replays: the caller mints its ephemeral,
 * the responder mints its ephemeral then draws the 32-byte salt. */
const SCRIPT_MINTS = [CALLER_EPH_PRIV, SERVER_EPH_PRIV];
const SCRIPT_DRAWS = [HANDSHAKE_SALT];

/** A NoisePrimitives whose key mints + salt draws come from a script —
 * the golden-vector transcript replays identically on any backend. */
function scriptedPrimitives(
  base: NoisePrimitives,
): NoisePrimitives {
  let mintAt = 0;
  let drawAt = 0;
  return {
    ...base,
    generateX25519() {
      const priv = SCRIPT_MINTS[mintAt] ?? new Uint8Array(32);
      mintAt += 1;
      return { privateKey: priv, publicKey: base.x25519Public(priv) };
    },
    randomBytes(n) {
      const bytes = SCRIPT_DRAWS[drawAt] ?? new Uint8Array(n);
      drawAt += 1;
      return bytes.slice(0, n);
    },
  };
}

/** One scripted handshake — the same bytes on any backend. */
function scriptedHandshake(suite: NoiseSuite): {
  hello: { eph: string; dev: string };
  challenge: { eph: string; salt: string; spub: string };
  c2s: SyncFrameCodec;
  s2c: SyncFrameCodec;
} {
  const callerId = {
    pub: noiseSpkiB64(suite.primitives.x25519Public(CALLER_DEV_PRIV)),
    priv: noisePkcs8B64(CALLER_DEV_PRIV),
  };
  const serverId = {
    pub: noiseSpkiB64(suite.primitives.x25519Public(SERVER_DEV_PRIV)),
    priv: noisePkcs8B64(SERVER_DEV_PRIV),
  };
  const client = suite.clientCrypto(callerId).begin({
    deviceId: 'dev-golden01',
    name: 'golden-phone',
  });
  const hello = client.hello();
  const accepted = suite
    .responderCrypto(serverId)
    .accept(hello, { registered: false });
  const done = client.complete(
    JSON.parse(Buffer.from(accepted.challenge).toString('utf8')),
    {},
  );
  assert(done.ok, 'golden handshake completes');
  if (!done.ok) {
    throw new Error('unreachable');
  }
  return {
    hello,
    challenge: JSON.parse(
      Buffer.from(accepted.challenge).toString('utf8'),
    ) as { eph: string; salt: string; spub: string },
    c2s: done.value.codec,
    s2c: accepted.codec,
  };
}

/* Recorded at consolidation: the scripted transcript's sealed frames.
 * iv = 00000000‖u64le(0) prefix, then ct‖tag16. Sealing these under
 * EITHER backend reproduces the bytes exactly — proven live below. */
const GOLDEN_C2S =
  '0000000000000000000000009f78999f58327c2e1db52b61cb744198' +
  'b8196cffb3fe4525e78d4f3e8032730c6ee2b4f438318d7d9b6bffed';
const GOLDEN_S2C =
  '0000000000000000000000006173db32b8b4028ed306aa83ea857d09' +
  '6227b47a6de85621c407c17ec46aa0';

export function run(): void {
  // Identity generation and fingerprint stability.
  const identity = nodeNoise.createIdentity();
  assert(isSyncIdentity(identity), 'identity validates');
  assert(nodeNoise.isUsableIdentity(identity), 'a fresh identity is usable');
  const fp = nodeNoise.fingerprintOf(identity.pub);
  assertEqual(fp.length, 64, 'sha256 hex');
  assertEqual(fp, nodeNoise.fingerprintOf(identity.pub), 'fingerprint is stable');
  const other = nodeNoise.createIdentity();
  assert(
    nodeNoise.fingerprintOf(other.pub) !== fp,
    'distinct identities fingerprint differently',
  );

  // isUsableIdentity also binds pub↔priv: a spliced pair whose keys
  // each load as X25519 but don't correspond is corrupt, not usable.
  assert(
    !nodeNoise.isUsableIdentity({ pub: other.pub, priv: identity.priv }),
    'mismatched stored pair is unusable',
  );
  assert(
    !nodeNoise.isUsableIdentity({ pub: identity.pub, priv: '!!!!' }),
    'garbage priv is unusable',
  );

  // Codec round trip + tamper + sequence binding.
  const key = new Uint8Array(32).fill(7);
  const a = nodeNoise.createCodec({ sendKey: key, recvKey: key });
  const b = nodeNoise.createCodec({ sendKey: key, recvKey: key });
  const sealed = a.seal(utf8('hello sync'));
  assertEqual(sealed.length, 10 + 28, 'sealed frame carries iv+tag');
  assertEqual(
    Buffer.from(b.open(sealed)).toString('utf8'),
    'hello sync',
    'round trips',
  );

  // A flipped tag bit kills open.
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  let tamperedThrew = false;
  try {
    b.open(tampered);
  } catch {
    tamperedThrew = true; // gcm tag verification failure
  }
  assert(tamperedThrew, 'tampered frame must throw');

  // A replayed frame dies on the sequence check.
  const c = nodeNoise.createCodec({ sendKey: key, recvKey: key });
  const d = nodeNoise.createCodec({ sendKey: key, recvKey: key });
  const f1 = c.seal(utf8('first'));
  const f2 = c.seal(utf8('second'));
  assertEqual(Buffer.from(d.open(f1)).toString('utf8'), 'first');
  let replayThrew = false;
  try {
    d.open(f1);
  } catch {
    replayThrew = true; // sequence mismatch
  }
  assert(replayThrew, 'replayed frame must throw');
  assertEqual(
    Buffer.from(d.open(f2)).toString('utf8'),
    'second',
    'stream continues',
  );

  // isClientHello boundary validation — key fields must actually
  // load as X25519 SPKI, not just look like strings.
  const pub = identity.pub;
  assert(
    nodeNoise.isClientHello({
      v: 1,
      kind: 'hello',
      deviceId: 'dev-00000001',
      name: 'pixel',
      eph: pub,
      dev: pub,
    }),
    'valid hello passes',
  );
  assert(
    !nodeNoise.isClientHello({
      v: 2,
      kind: 'hello',
      deviceId: 'dev-00000001',
      name: 'pixel',
      eph: pub,
      dev: pub,
    }),
    'wrong version rejected',
  );
  assert(
    !nodeNoise.isClientHello({
      v: 1,
      kind: 'hello',
      deviceId: '../escape',
      name: 'x',
      eph: pub,
      dev: pub,
    }),
    'hostile deviceId rejected',
  );
  assert(
    !nodeNoise.isClientHello({
      v: 1,
      kind: 'hello',
      deviceId: 'dev-00000001',
      name: 'pixel',
      eph: 'AAAA',
      dev: pub,
    }),
    'non-key eph rejected at the shape gate',
  );

  // Full handshake: a responder accept completes against the test
  // peer's client half, and both ends' codecs interoperate.
  const cipher = nodeNoise.responderCrypto(identity);
  assertEqual(cipher.name, 'noise-v1');
  const peer = createNoiseTestPeer(nodeNoise, {
    deviceId: 'dev-00000001',
    name: 'pixel',
  });
  const accepted = cipher.accept(peer.hello(), { registered: false });
  const challenge = JSON.parse(
    Buffer.from(accepted.challenge).toString('utf8'),
  );
  const client = peer.complete(challenge, fp);
  assertEqual(client.registered, false);
  const msg = accepted.codec.seal(utf8('{"t":"ping"}'));
  assertEqual(
    Buffer.from(client.codec.open(msg)).toString('utf8'),
    '{"t":"ping"}',
    'server→client opens',
  );
  const back = client.codec.seal(utf8('{"t":"pong"}'));
  assertEqual(
    Buffer.from(accepted.codec.open(back)).toString('utf8'),
    '{"t":"pong"}',
    'client→server opens',
  );

  // A wrong pinned fingerprint is caught client-side.
  const peer2 = createNoiseTestPeer(nodeNoise, {
    deviceId: 'dev-00000002',
    name: 'other',
  });
  const accepted2 = cipher.accept(peer2.hello(), { registered: true });
  let pinThrew: unknown;
  try {
    peer2.complete(
      JSON.parse(Buffer.from(accepted2.challenge).toString('utf8')),
      nodeNoise.fingerprintOf(other.pub),
    );
  } catch (thrown) {
    pinThrew = thrown;
  }
  assert(
    pinThrew instanceof Error && pinThrew.message.includes('fingerprint'),
    'pin mismatch reports fingerprint',
  );

  // A garbage dev key fails accept, not later.
  const badPeer = createNoiseTestPeer(nodeNoise, {
    deviceId: 'dev-00000003',
    name: 'bad',
  });
  const hello = badPeer.hello();
  let badKeyThrew = false;
  try {
    cipher.accept({ ...hello, dev: 'not-a-key' }, { registered: false });
  } catch {
    badKeyThrew = true; // unusable key material
  }
  assert(badKeyThrew, 'bad device key must throw in accept');

  /* ----------------------- golden vectors --------------------------
   * The wire-format proof: one scripted transcript — fixed device and
   * ephemeral keys, fixed salt — replayed through the node adapter
   * AND the noble (mobile) adapter must produce byte-identical hello
   * key fields, challenge key/salt fields, and sealed frames. The
   * recorded constants pin the output so drift in BOTH backends is
   * still caught. */
  const nodeT = scriptedHandshake(
    createNoiseSuite(scriptedPrimitives(nodeNoisePrimitives())),
  );
  const nobleT = scriptedHandshake(
    createNoiseSuite(
      scriptedPrimitives(nobleNoisePrimitives(() => {
        throw new Error('noble script supplies all randomness');
      })),
    ),
  );

  // hello carries caller-eph + dev pubs — same raw keys → same SPKI.
  assertEqual(nobleT.hello.eph, nodeT.hello.eph, 'hello eph identical');
  assertEqual(nobleT.hello.dev, nodeT.hello.dev, 'hello dev identical');
  // challenge carries responder-eph + salt + spub — identical bytes.
  assertEqual(nobleT.challenge.eph, nodeT.challenge.eph, 'challenge eph identical');
  assertEqual(nobleT.challenge.salt, nodeT.challenge.salt, 'challenge salt identical');
  assertEqual(nobleT.challenge.spub, nodeT.challenge.spub, 'challenge spub identical');

  // Derived keys agree: each backend opens the other's sealed frame.
  // The client codec's recv key is kS2C; the responder codec's recv
  // key is kC2S — open the opposing direction on each.
  const sealedC2s = nodeT.c2s.seal(utf8('{"t":"pair","code":"123456"}'));
  const sealedS2c = nodeT.s2c.seal(utf8('{"t":"welcome"}'));
  assertEqual(
    Buffer.from(nobleT.c2s.open(sealedS2c)).toString('utf8'),
    '{"t":"welcome"}',
    'noble opens the node-sealed s2c frame',
  );
  assertEqual(
    Buffer.from(nobleT.s2c.open(sealedC2s)).toString('utf8'),
    '{"t":"pair","code":"123456"}',
    'noble opens the node-sealed c2s frame',
  );

  // And sealing the same plaintext on the noble codecs reproduces the
  // exact same frame bytes — same keys, same iv construction.
  assertEqual(
    hexOf(nobleT.c2s.seal(utf8('{"t":"pair","code":"123456"}'))),
    hexOf(sealedC2s),
    'noble seals byte-identical c2s frame',
  );
  assertEqual(
    hexOf(nobleT.s2c.seal(utf8('{"t":"welcome"}'))),
    hexOf(sealedS2c),
    'noble seals byte-identical s2c frame',
  );

  // The recorded transcript — regenerating under either backend must
  // reproduce these exact frames (iv‖ct‖tag16, seq 0 in each dir).
  assertEqual(hexOf(sealedC2s), GOLDEN_C2S, 'c2s golden frame');
  assertEqual(hexOf(sealedS2c), GOLDEN_S2C, 's2c golden frame');
}
