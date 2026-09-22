import { assert, assertEqual } from '@auqw/application/testing';
import {
  createCodec,
  createNoiseV1Cipher,
  createTestPeer,
  fingerprintOf,
  generateIdentity,
  isClientHello,
  isSyncIdentity,
  isUsableIdentity,
} from './sync-crypto.ts';

export function run(): void {
  // Identity generation and fingerprint stability.
  const identity = generateIdentity();
  assert(isSyncIdentity(identity), 'identity validates');
  assert(isUsableIdentity(identity), 'a fresh identity is usable');
  const fp = fingerprintOf(identity.pub);
  assertEqual(fp.length, 64, 'sha256 hex');
  assertEqual(fp, fingerprintOf(identity.pub), 'fingerprint is stable');
  const other = generateIdentity();
  assert(
    fingerprintOf(other.pub) !== fp,
    'distinct identities fingerprint differently',
  );

  // isUsableIdentity also binds pub↔priv: a spliced pair whose keys
  // each load as X25519 but don't correspond is corrupt, not usable.
  assert(
    !isUsableIdentity({ pub: other.pub, priv: identity.priv }),
    'mismatched stored pair is unusable',
  );
  assert(
    !isUsableIdentity({ pub: identity.pub, priv: '!!!!' }),
    'garbage priv is unusable',
  );

  // Codec round trip + tamper + sequence binding.
  const key = Buffer.alloc(32, 7);
  const a = createCodec({ sendKey: key, recvKey: key });
  const b = createCodec({ sendKey: key, recvKey: key });
  const sealed = a.seal(Buffer.from('hello sync'));
  assertEqual(sealed.length, 10 + 28, 'sealed frame carries iv+tag');
  assertEqual(b.open(sealed).toString('utf8'), 'hello sync', 'round trips');

  // A flipped tag bit kills open.
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  try {
    b.open(tampered);
    assert(false, 'tampered frame must throw');
  } catch {
    // gcm tag verification failure
  }

  // A replayed frame dies on the sequence check.
  const c = createCodec({ sendKey: key, recvKey: key });
  const d = createCodec({ sendKey: key, recvKey: key });
  const f1 = c.seal(Buffer.from('first'));
  const f2 = c.seal(Buffer.from('second'));
  assertEqual(d.open(f1).toString('utf8'), 'first');
  try {
    d.open(f1);
    assert(false, 'replayed frame must throw');
  } catch {
    // sequence mismatch
  }
  assertEqual(d.open(f2).toString('utf8'), 'second', 'stream continues');

  // isClientHello boundary validation — key fields must actually
  // load as X25519 SPKI, not just look like strings.
  const pub = identity.pub;
  assert(
    isClientHello({
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
    !isClientHello({
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
    !isClientHello({
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
    !isClientHello({
      v: 1,
      kind: 'hello',
      deviceId: 'dev-00000001',
      name: 'pixel',
      eph: 'AAAA',
      dev: pub,
    }),
    'non-key eph rejected at the shape gate',
  );

  // Full handshake: a server accept completes against the test peer's
  // client half, and both ends' codecs interoperate.
  const cipher = createNoiseV1Cipher(identity);
  assertEqual(cipher.name, 'noise-v1');
  const peer = createTestPeer({ deviceId: 'dev-00000001', name: 'pixel' });
  const accepted = cipher.accept(peer.hello(), { registered: false });
  const challenge = JSON.parse(accepted.challenge.toString('utf8'));
  const client = peer.complete(challenge, fp);
  assertEqual(client.registered, false);
  const msg = accepted.codec.seal(Buffer.from('{"t":"ping"}'));
  assertEqual(
    client.codec.open(msg).toString('utf8'),
    '{"t":"ping"}',
    'server→client opens',
  );
  const back = client.codec.seal(Buffer.from('{"t":"pong"}'));
  assertEqual(
    accepted.codec.open(back).toString('utf8'),
    '{"t":"pong"}',
    'client→server opens',
  );

  // A wrong pinned fingerprint is caught client-side.
  const peer2 = createTestPeer({ deviceId: 'dev-00000002', name: 'other' });
  const accepted2 = cipher.accept(peer2.hello(), { registered: true });
  try {
    peer2.complete(
      JSON.parse(accepted2.challenge.toString('utf8')),
      fingerprintOf(other.pub),
    );
    assert(false, 'wrong pinned fingerprint must throw');
  } catch (thrown) {
    assert(
      thrown instanceof Error && thrown.message.includes('fingerprint'),
      'pin mismatch reports fingerprint',
    );
  }

  // A garbage dev key fails accept, not later.
  const badPeer = createTestPeer({ deviceId: 'dev-00000003', name: 'bad' });
  const hello = badPeer.hello();
  try {
    cipher.accept({ ...hello, dev: 'not-a-key' }, { registered: false });
    assert(false, 'bad device key must throw in accept');
  } catch {
    // diffieHellman rejects a non-X25519 key
  }
}
