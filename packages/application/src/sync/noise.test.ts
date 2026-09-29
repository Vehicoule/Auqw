import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '../testing/assert.ts';
import {
  base64Decode,
  base64Encode,
  createNoiseSuite,
  isSyncIdentity,
  noisePkcs8B64,
  noiseRawPrivate,
  noiseRawPublic,
  noiseSpkiB64,
  type NoisePrimitives,
} from './noise.ts';

/**
 * Pure-TS coverage of the shared noise-v1 module — everything except
 * the primitive bodies. The fake suite below is deterministic and
 * observable (calls record their args), so the transcript ordering,
 * custody formats, codec sequencing, and typed error paths are all
 * provable without a crypto backend; the desktop/mobile test files
 * supply the real-primitive golden vectors.
 */

function b(i: number): Uint8Array {
  return new Uint8Array(32).fill(i);
}

/** Deterministic fake primitives — x25519 = xor fold, gcm = keyed tag. */
function fakeNoise(): NoisePrimitives & {
  hkdfCalls: { ikm: Uint8Array; salt: Uint8Array; info: Uint8Array }[];
} {
  const hkdfCalls: { ikm: Uint8Array; salt: Uint8Array; info: Uint8Array }[] =
    [];
  let minted = 0;
  const pubOf = (priv: Uint8Array): Uint8Array => priv.map((v) => v ^ 0xff);
  const tag = (key: Uint8Array, iv: Uint8Array, ct: Uint8Array) => {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) {
      out[i] =
        (key[i % key.length] ?? 0) ^
        (iv[i % iv.length] ?? 0) ^
        (ct[i % Math.max(ct.length, 1)] ?? 0);
    }
    return out;
  };
  return {
    hkdfCalls,
    x25519: (priv, pub) =>
      priv.map((v, i) => v ^ (pub[i % pub.length] ?? 0)),
    x25519Public: pubOf,
    generateX25519: () => {
      minted += 1;
      const privateKey = b(minted);
      return { privateKey, publicKey: pubOf(privateKey) };
    },
    sha256: (bytes) => {
      const out = new Uint8Array(32);
      for (let i = 0; i < bytes.length; i += 1) {
        out[i % 32] = (out[i % 32] ?? 0) ^ (bytes[i] ?? 0);
      }
      return out;
    },
    hkdf: (ikm, salt, info, length) => {
      hkdfCalls.push({
        ikm: new Uint8Array(ikm),
        salt: new Uint8Array(salt),
        info: new Uint8Array(info),
      });
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        out[i] = ikm[i % ikm.length] ?? 0;
      }
      return out;
    },
    aesGcmEncrypt: (key, iv, plaintext) => {
      const ct = plaintext.map((v, i) => v ^ (key[i % 32] ?? 0));
      return new Uint8Array([...ct, ...tag(key, iv, ct)]);
    },
    aesGcmDecrypt: (key, iv, ctTag) => {
      const ct = ctTag.subarray(0, ctTag.length - 16);
      const want = tag(key, iv, ct);
      const got = ctTag.subarray(ctTag.length - 16);
      if (!want.every((v, i) => v === got[i])) {
        throw new Error('tag mismatch');
      }
      return ct.map((v, i) => v ^ (key[i % 32] ?? 0));
    },
    randomBytes: (n) => new Uint8Array(n).fill(7),
  };
}

const ID_A = { priv: noisePkcs8B64(b(0x11)), pub: '' };
const ID_B = { priv: noisePkcs8B64(b(0x22)), pub: '' };

export function run(): void {
  const noise = fakeNoise();
  const suite = createNoiseSuite(noise);
  // Fix the identity pubs to the fake pubOf(priv) values.
  const idA = {
    priv: ID_A.priv,
    pub: noiseSpkiB64(noise.x25519Public(b(0x11))),
  };
  const idB = {
    priv: ID_B.priv,
    pub: noiseSpkiB64(noise.x25519Public(b(0x22))),
  };

  // —— base64 ————————————————————————————————————————————
  const bin = new Uint8Array([0, 1, 2, 250, 255, 128, 64, 7]);
  assertDeepEqual([...(base64Decode(base64Encode(bin)) ?? [])], [...bin]);
  assertEqual(base64Encode(new Uint8Array(0)), '');
  assertEqual(base64Decode('')?.length, 0);
  assertEqual(base64Decode('!!!'), null);
  assertEqual(base64Decode('abc'), null);

  // —— DER custody formats ———————————————————————————————
  const raw = b(0x42);
  assertDeepEqual([...(noiseRawPublic(noiseSpkiB64(raw)) ?? [])], [...raw]);
  assertDeepEqual(
    [...(noiseRawPrivate(noisePkcs8B64(raw)) ?? [])],
    [...raw],
  );
  assertEqual(noiseRawPublic(noisePkcs8B64(raw)), null); // wrong wrapper
  assertEqual(noiseRawPrivate(''), null);
  // Tampered prefix fails the canonical check.
  const tampered = base64Decode(noiseSpkiB64(raw));
  assert(tampered !== null);
  tampered[0] = 0xff;
  assertEqual(noiseRawPublic(base64Encode(tampered)), null);

  // —— identity guards ———————————————————————————————————
  assert(isSyncIdentity({ pub: 'x', priv: 'y' }));
  assert(!isSyncIdentity({ pub: 'x' }));
  assert(!isSyncIdentity({ pub: 'x', priv: 'y', extra: 1 }));
  assert(suite.isUsableIdentity(idA));
  assert(
    !suite.isUsableIdentity({
      priv: idA.priv,
      pub: idB.pub,
    }),
    'mismatched pub/priv pair is unusable',
  );
  const minted = suite.createIdentity();
  assert(
    suite.isUsableIdentity(minted),
    'a minted identity is usable',
  );
  assertEqual(suite.fingerprintOf('not-base64'), '');

  // —— strict hello guard ————————————————————————————————
  const goodHello = {
    v: 1,
    kind: 'hello',
    deviceId: 'phone-000001',
    name: 'phone',
    eph: noiseSpkiB64(b(0x33)),
    dev: idA.pub,
  };
  assert(suite.isClientHello(goodHello), 'canonical hello passes');
  assert(
    !suite.isClientHello({ ...goodHello, eph: 'AAAA' }),
    'non-key eph fails the crypto guard',
  );

  // —— codec: seq bound in both directions ———————————————
  const keyA = b(0x0a);
  const keyB = b(0x0b);
  const aSide = suite.createCodec({ sendKey: keyA, recvKey: keyB });
  const bSide = suite.createCodec({ sendKey: keyB, recvKey: keyA });
  const m0 = aSide.seal(new Uint8Array([1, 2, 3]));
  const m1 = aSide.seal(new Uint8Array([4, 5]));
  // iv = 4 zero bytes ‖ u64le seq — the layout is wire-fixed.
  assertDeepEqual([...m0.subarray(0, 12)], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assertDeepEqual([...m1.subarray(4, 12)], [1, 0, 0, 0, 0, 0, 0, 0]);
  assertDeepEqual([...bSide.open(m0)], [1, 2, 3]);
  assertDeepEqual([...bSide.open(m1)], [4, 5]);
  // Replayed frame — seq already consumed.
  let threw = false;
  try {
    bSide.open(m0);
  } catch {
    threw = true;
  }
  assert(threw, 'replayed frame throws');
  // A nonzero iv prefix (noble's old impl accepted it) kills now.
  const forged = new Uint8Array(m0);
  forged[0] = 1;
  threw = false;
  try {
    bSide.open(forged);
  } catch {
    threw = true;
  }
  assert(threw, 'forged iv prefix throws');
  // Tag tamper.
  const bad = new Uint8Array(m1.slice());
  bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
  threw = false;
  try {
    bSide.open(bad);
  } catch {
    threw = true;
  }
  assert(threw, 'tampered tag throws');
  // Short frame.
  threw = false;
  try {
    bSide.open(new Uint8Array(10));
  } catch {
    threw = true;
  }
  assert(threw, 'short frame throws');

  // —— handshake transcript order ————————————————————————
  const client = suite.clientCrypto(idA);
  const responder = suite.responderCrypto(idB);
  const handshake = client.begin({ deviceId: 'phone-000001', name: 'p' });
  const hello = handshake.hello();
  assertEqual(hello.dev, idA.pub);
  assertEqual(hello.kind, 'hello');

  const accepted = responder.accept(hello, { registered: true });
  const challengeJson = JSON.parse(
    [...accepted.challenge].map((c) => String.fromCharCode(c)).join(''),
  );
  assertEqual(challengeJson.kind, 'challenge');
  assertEqual(challengeJson.spub, idB.pub);
  assertEqual(challengeJson.registered, true);
  assertEqual(noise.hkdfCalls.length, 1);
  // dh(e,e)‖dh(devC,eS)‖dh(eC,S_desk) in order, salt + info intact.
  // createIdentity minted pair #1 above; the client ephemeral is #2,
  // the responder's #3 (fake x25519 is symmetric-xor, so either
  // leg's argument order yields the same shared bytes).
  const ikm = noise.hkdfCalls[0]?.ikm ?? new Uint8Array(0);
  const dh1 = noise.x25519(b(3), noise.x25519Public(b(2)));
  const dh2 = noise.x25519(b(0x11), noise.x25519Public(b(3)));
  const dh3 = noise.x25519(b(0x22), noise.x25519Public(b(2)));
  assertDeepEqual(
    [...ikm],
    [...dh1, ...dh2, ...dh3],
    'ikm = dh1‖dh2‖dh3 in the documented order',
  );
  assertDeepEqual(
    [...(noise.hkdfCalls[0]?.info ?? [])],
    [...[...'auqw-sync-v1'].map((c) => c.charCodeAt(0))],
  );

  const done = handshake.complete(challengeJson, {});
  assert(done.ok);
  if (done.ok) {
    assertEqual(done.value.registered, true);
    assertEqual(done.value.serverFp, suite.fingerprintOf(idB.pub));
    // Both directions open what the other sealed.
    const fromClient = done.value.codec.seal(
      new Uint8Array([9, 9, 9]),
    );
    assertDeepEqual([...accepted.codec.open(fromClient)], [9, 9, 9]);
    const fromServer = accepted.codec.seal(new Uint8Array([8, 8]));
    assertDeepEqual([...done.value.codec.open(fromServer)], [8, 8]);
  }

  // —— typed failure paths ———————————————————————————————
  const badShape = client.begin({ deviceId: 'd', name: 'd' });
  const badShapeDone = badShape.complete({ not: 'a challenge' }, {});
  assert(!badShapeDone.ok);
  if (!badShapeDone.ok) {
    assertEqual(badShapeDone.error.kind, 'invalid-response');
  }

  const pinned = client.begin({ deviceId: 'd', name: 'd' });
  const pinFail = pinned.complete(challengeJson, {
    pinnedFp: 'f'.repeat(64),
  });
  assert(!pinFail.ok);
  if (!pinFail.ok) {
    assertEqual(pinFail.error.kind, 'permission-denied');
  }

  const badKeyClient = suite.clientCrypto({
    pub: idA.pub,
    priv: 'corrupt',
  });
  const badKeyDone = badKeyClient
    .begin({ deviceId: 'd', name: 'd' })
    .complete(challengeJson, {});
  assert(!badKeyDone.ok);
  if (!badKeyDone.ok) {
    assertEqual(badKeyDone.error.kind, 'invalid-response');
  }

  // Responder accept throws on junk key material.
  threw = false;
  try {
    responder.accept({ ...hello, eph: 'not-a-key' }, { registered: false });
  } catch {
    threw = true;
  }
  assert(threw, 'accept throws on malformed eph');
}
