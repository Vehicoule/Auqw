import {
  createCipheriv,
  createDecipheriv,
  createHash,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { hasOnlyKeys, isBoundedString, isRecord } from '../shared/check.ts';

/**
 * The SyncCipher seam — what the LAN transport needs from a crypto
 * suite. sync.md leaves the session cipher open ("noise-style or TLS
 * with pinned self-signed certs — chosen in Slice 4 with evidence").
 *
 * Default implementation below is a noise-style X25519 + HKDF +
 * AES-256-GCM construction on `node:crypto` alone: X25519 static
 * identities (desktop + each device), an ephemeral-ephemeral plus two
 * ephemeral-static Diffie-Hellman mixes per session, and AEAD-sealed
 * frames. No certificate generation is needed — Node cannot produce an
 * X.509 self-signed cert without an external dependency or an openssl
 * subprocess (neither exists on a packaged Windows install), so pinned
 * TLS is NOT the zero-dep option the framing suggested; this is. The
 * seam still admits a `tls.TLSSocket`-based impl that yields the same
 * `SessionCodec` shape if the decision lands on TLS.
 *
 * Handshake (frames are length-prefixed JSON until the channel opens):
 *   C→S hello:     {v:1, kind:'hello', deviceId, name, eph, dev}
 *   S→C challenge: {v:1, kind:'challenge', eph, salt, spub, registered}
 *   k_sess = HKDF-SHA256(dh(e,e)‖dh(devC,eS)‖dh(eC,S_desk), salt,
 *                        'auqw-sync-v1') → kC2S‖kS2C
 *   …then sealed app messages; the FIRST sealed client message is
 *   {t:'pair', code} or {t:'resume'} — authorization is a protocol
 *   concern above this layer.
 */

export type SyncIdentity = {
  /** SPKI DER, base64. */
  readonly pub: string;
  /** PKCS8 DER, base64 — safeStorage-backed at rest. */
  readonly priv: string;
};

/** `sha256(pubSpkiDer)` — the fingerprint the QR payload pins. */
export function fingerprintOf(pubSpkiB64: string): string {
  return createHash('sha256')
    .update(Buffer.from(pubSpkiB64, 'base64'))
    .digest('hex');
}

export function generateIdentity(): SyncIdentity {
  const pair = generateKeyPairSync('x25519');
  return {
    pub: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    priv: pair.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
  };
}

export function isSyncIdentity(value: unknown): value is SyncIdentity {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['pub', 'priv']) &&
    isBoundedString(value['pub'], 128) &&
    isBoundedString(value['priv'], 256)
  );
}

function pubKey(spkiB64: string) {
  return { key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' } as const;
}

function privKey(pkcs8B64: string) {
  return {
    key: Buffer.from(pkcs8B64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  } as const;
}

function x25519(priv: string, pub: string): Buffer {
  return diffieHellman({ privateKey: privKey(priv), publicKey: pubKey(pub) });
}

/** Directional AEAD codec — per-direction seq counters as 96-bit nonces. */
export type SessionCodec = {
  seal(plain: Uint8Array): Buffer;
  open(frame: Uint8Array): Buffer;
};

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createCodec(opts: {
  sendKey: Uint8Array;
  recvKey: Uint8Array;
}): SessionCodec {
  let sendSeq = 0n;
  let recvSeq = 0n;
  return {
    seal(plain) {
      const iv = Buffer.alloc(IV_BYTES);
      iv.writeBigUInt64LE(sendSeq, IV_BYTES - 8);
      sendSeq += 1n;
      const cipher = createCipheriv('aes-256-gcm', opts.sendKey, iv);
      return Buffer.concat([
        iv,
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    },
    open(frame) {
      if (frame.length < IV_BYTES + TAG_BYTES) {
        throw new Error('sealed frame too short');
      }
      const iv = frame.subarray(0, IV_BYTES);
      const expected = Buffer.alloc(IV_BYTES);
      expected.writeBigUInt64LE(recvSeq, IV_BYTES - 8);
      if (!expected.equals(iv)) {
        // Sequence binding keeps replayed/reordered frames dead — TCP
        // ordering means a gap is always tamper or desync.
        throw new Error('sealed frame out of sequence');
      }
      recvSeq += 1n;
      const tag = frame.subarray(frame.length - TAG_BYTES);
      const ct = frame.subarray(IV_BYTES, frame.length - TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', opts.recvKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Wire message shapes — validated, never trusted                       */
/* ------------------------------------------------------------------ */

export const WIRE_VERSION = 1;

export type ClientHello = {
  readonly v: number;
  readonly kind: 'hello';
  readonly deviceId: string;
  readonly name: string;
  /** Client ephemeral X25519 SPKI, base64. */
  readonly eph: string;
  /** Client long-lived device X25519 SPKI, base64. */
  readonly dev: string;
};

export function isClientHello(value: unknown): value is ClientHello {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['v', 'kind', 'deviceId', 'name', 'eph', 'dev']) &&
    value['v'] === WIRE_VERSION &&
    value['kind'] === 'hello' &&
    // deviceId feeds the secure-file name — the pattern is the wall.
    /^[a-z0-9][a-z0-9._-]{7,63}$/.test(String(value['deviceId'])) &&
    isBoundedString(value['name'], 128) &&
    isBoundedString(value['eph'], 128) &&
    isBoundedString(value['dev'], 128)
  );
}

/* ------------------------------------------------------------------ */
/* The seam                                                            */
/* ------------------------------------------------------------------ */

export type AcceptedHandshake = {
  /** Plaintext frame payload to send next — the challenge. */
  readonly challenge: Buffer;
  /** Sealed channel for everything after. */
  readonly codec: SessionCodec;
  readonly peer: {
    readonly deviceId: string;
    readonly name: string;
    readonly devPub: string;
    readonly devFp: string;
  };
};

export interface SyncCipher {
  readonly name: string;
  readonly identity: SyncIdentity;
  /**
   * Validate a client hello, run the server half of the key
   * agreement, and return the challenge plus the ready session codec.
   * `registered` is echoed into the challenge so the peer can pick
   * pair vs resume without a round trip; it authorizes nothing.
   * Throws on malformed keys — callers treat a throw as connection
   * death, not a typed reply.
   */
  accept(hello: ClientHello, opts: { registered: boolean }): AcceptedHandshake;
}

/**
 * The noise-style default: X25519 static identity + ephemeral DH ×3 +
 * HKDF + AES-256-GCM. See the file header for why this — not pinned
 * TLS — is the zero-dependency default; the choice is pending
 * ratification in decisions.md.
 */
export function createNoiseV1Cipher(identity: SyncIdentity): SyncCipher {
  return {
    name: 'noise-v1',
    identity,
    accept(hello, opts) {
      const eph = generateKeyPairSync('x25519');
      const salt = randomBytes(32);
      const dh1 = x25519(
        eph.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        hello.eph,
      );
      const dh2 = x25519(
        eph.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        hello.dev,
      );
      const dh3 = x25519(identity.priv, hello.eph);
      const keys = Buffer.from(
        hkdfSync(
          'sha256',
          Buffer.concat([dh1, dh2, dh3]),
          salt,
          'auqw-sync-v1',
          64,
        ),
      );
      const codec = createCodec({
        sendKey: keys.subarray(32, 64),
        recvKey: keys.subarray(0, 32),
      });
      const challenge = Buffer.from(
        JSON.stringify({
          v: WIRE_VERSION,
          kind: 'challenge',
          eph: eph.publicKey
            .export({ format: 'der', type: 'spki' })
            .toString('base64'),
          salt: salt.toString('base64'),
          spub: identity.pub,
          registered: opts.registered,
        }),
        'utf8',
      );
      return {
        challenge,
        codec,
        peer: {
          deviceId: hello.deviceId,
          name: hello.name,
          devPub: hello.dev,
          devFp: fingerprintOf(hello.dev),
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Test double — the phone half of the handshake for loopback tests.    */
/* Lives in production code only because the phone leg hasn't landed;   */
/* marked plainly. NOT wired into the app's runtime path.               */
/* ------------------------------------------------------------------ */

export type TestPeer = {
  readonly identity: SyncIdentity;
  readonly deviceId: string;
  readonly name: string;
  hello(): ClientHello;
  /** Complete the client half; `pinnedFp` mismatches → throw. */
  complete(
    challengeJson: unknown,
    pinnedFp?: string,
  ): { codec: SessionCodec; registered: boolean };
};

export function createTestPeer(opts: {
  deviceId: string;
  name: string;
}): TestPeer {
  const identity = generateIdentity();
  const eph = generateKeyPairSync('x25519');
  const ephPub = eph.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  const ephPriv = eph.privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64');
  return {
    identity,
    deviceId: opts.deviceId,
    name: opts.name,
    hello() {
      return {
        v: WIRE_VERSION,
        kind: 'hello',
        deviceId: opts.deviceId,
        name: opts.name,
        eph: ephPub,
        dev: identity.pub,
      };
    },
    complete(challengeJson, pinnedFp) {
      if (
        !isRecord(challengeJson) ||
        challengeJson['v'] !== WIRE_VERSION ||
        challengeJson['kind'] !== 'challenge' ||
        !isBoundedString(challengeJson['eph'], 128) ||
        !isBoundedString(challengeJson['salt'], 128) ||
        !isBoundedString(challengeJson['spub'], 128)
      ) {
        throw new Error('malformed challenge');
      }
      const fp = fingerprintOf(challengeJson['spub']);
      if (pinnedFp !== undefined && fp !== pinnedFp) {
        throw new Error('server fingerprint mismatch');
      }
      const salt = Buffer.from(challengeJson['salt'], 'base64');
      const dh1 = x25519(ephPriv, challengeJson['eph']);
      const dh2 = x25519(identity.priv, challengeJson['eph']);
      const dh3 = x25519(ephPriv, challengeJson['spub']);
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
        codec: createCodec({
          sendKey: keys.subarray(0, 32),
          recvKey: keys.subarray(32, 64),
        }),
        registered: challengeJson['registered'] === true,
      };
    },
  };
}
