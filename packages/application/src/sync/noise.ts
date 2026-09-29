import {
  hasKeys,
  isRecord,
  isString,
} from '../domain.ts';
import { appError, err, ok } from '../errors.ts';
import type {
  SyncClientCrypto,
  SyncClientHandshake,
  SyncFrameCodec,
  SyncIdentity,
  SyncResponderCrypto,
} from '../ports/sync-transport.ts';
import {
  isClientHello,
  isServerChallenge,
  type ClientHello,
} from './sync-wire.ts';

/**
 * noise-v1 — the ONE LAN-sync session construction, shared by every
 * host. The desktop and phone used to carry private copies
 * (node:crypto vs @noble); both now inject a primitive suite here and
 * the transcript, derivation, and codec live exactly once.
 *
 * Handshake (frames are length-prefixed JSON until the channel opens):
 *   C→S hello:     {v:1, kind:'hello', deviceId, name, eph, dev}
 *   S→C challenge: {v:1, kind:'challenge', eph, salt, spub, registered}
 *   k_sess = HKDF-SHA256(dh(e,e)‖dh(devC,eS)‖dh(eC,S_desk), salt,
 *                        'auqw-sync-v1') → kC2S‖kS2C
 *   …then sealed app messages; the FIRST sealed client message is
 *   {t:'pair', code} or {t:'resume'} — authorization is a protocol
 *   concern above this layer.
 *
 * Custody identity format: X25519 keys serialized as canonical
 * SPKI/PKCS8 DER, base64 — the format both platforms already stored,
 * so records minted by either old implementation still load.
 *
 * Sealed frames: iv = 4 zero bytes ‖ u64le seq, payload sealed
 * iv‖ct‖tag16; open() binds the sequence — TCP ordering means a gap
 * is always tamper or desync.
 */

/* --------------------------- the seam ------------------------------ */

/**
 * The primitive set a platform injects — the whole of what noise-v1
 * needs from a crypto backend. All keys are RAW 32-byte X25519
 * material (the DER custody wrappers are this module's job). Desktop
 * wires `node:crypto`, mobile wires `@noble`; tests may wire scripted
 * randomness for golden vectors.
 */
export type NoisePrimitives = {
  /** X25519 scalar multiplication — both args raw 32-byte keys. */
  x25519(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** The raw 32-byte public key for a raw private key. */
  x25519Public(privateKey: Uint8Array): Uint8Array;
  /** Fresh raw keypair from the platform CSPRNG. */
  generateX25519(): {
    readonly privateKey: Uint8Array;
    readonly publicKey: Uint8Array;
  };
  sha256(bytes: Uint8Array): Uint8Array;
  /** HKDF-SHA256 per RFC 5869 — `length` bytes of output. */
  hkdf(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Uint8Array;
  /** AES-256-GCM seal — returns ciphertext ‖ 16-byte tag. */
  aesGcmEncrypt(
    key: Uint8Array,
    iv: Uint8Array,
    plaintext: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array;
  /** AES-256-GCM open over ct‖tag16 — MUST throw on tag failure. */
  aesGcmDecrypt(
    key: Uint8Array,
    iv: Uint8Array,
    ctTag: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array;
  randomBytes(n: number): Uint8Array;
};

export const NOISE_SUITE_NAME = 'noise-v1';
const HKDF_INFO = ascii('auqw-sync-v1');
const WIRE_VERSION = 1;

/* ------------------------------ base64 ------------------------------ */

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    out +=
      b === undefined
        ? '='
        : B64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64_ALPHABET[c & 0x3f];
  }
  return out;
}

const B64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/** Strict base64 — any non-alphabet byte or bad padding is null. */
export function base64Decode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    return null;
  }
  const quads = value.length / 4;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(quads * 3 - padding);
  const digitAt = (at: number): number =>
    // '=' padding contributes zero bits, never a table hit.
    value[at] === '=' ? 0 : (B64_LOOKUP[value.charCodeAt(at)] ?? -1);
  for (let i = 0; i < quads; i += 1) {
    const at = i * 4;
    const n =
      (digitAt(at) << 18) |
      (digitAt(at + 1) << 12) |
      (digitAt(at + 2) << 6) |
      digitAt(at + 3);
    if (n < 0) {
      return null;
    }
    const byteAt = i * 3;
    if (byteAt < out.length) {
      out[byteAt] = (n >> 16) & 0xff;
    }
    if (byteAt + 1 < out.length) {
      out[byteAt + 1] = (n >> 8) & 0xff;
    }
    if (byteAt + 2 < out.length) {
      out[byteAt + 2] = n & 0xff;
    }
  }
  return out;
}

/* ------------------------------ DER --------------------------------- */

// Canonical X25519 wrappers: SPKI `302a…032100` and PKCS8
// `302e…04220420` — the custody format both old impls emitted.
const SPKI_PREFIX = hexToBytes('302a300506032b656e032100');
const PKCS8_PREFIX = hexToBytes('302e020100300506032b656e04220420');
const X25519_KEY_BYTES = 32;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (let part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return (
    bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b)
  );
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((b0, i) => b[i] === b0);
}

/** SPKI DER b64 → raw 32-byte X25519 public key; null when not ours. */
export function noiseRawPublic(spkiB64: string): Uint8Array | null {
  const der = base64Decode(spkiB64);
  if (
    der === null ||
    der.length !== SPKI_PREFIX.length + X25519_KEY_BYTES ||
    !startsWith(der, SPKI_PREFIX)
  ) {
    return null;
  }
  return der.subarray(SPKI_PREFIX.length);
}

/** PKCS8 DER b64 → raw 32-byte X25519 private key; null when not ours. */
export function noiseRawPrivate(pkcs8B64: string): Uint8Array | null {
  const der = base64Decode(pkcs8B64);
  if (
    der === null ||
    der.length !== PKCS8_PREFIX.length + X25519_KEY_BYTES ||
    !startsWith(der, PKCS8_PREFIX)
  ) {
    return null;
  }
  return der.subarray(PKCS8_PREFIX.length);
}

export function noiseSpkiB64(rawPub: Uint8Array): string {
  return base64Encode(concatBytes(SPKI_PREFIX, rawPub));
}

export function noisePkcs8B64(rawPriv: Uint8Array): string {
  return base64Encode(concatBytes(PKCS8_PREFIX, rawPriv));
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/* ------------------------------ codec ------------------------------- */

const IV_BYTES = 12;
const TAG_BYTES = 16;

function seqIv(seq: bigint): Uint8Array {
  const iv = new Uint8Array(IV_BYTES);
  new DataView(iv.buffer, iv.byteOffset, IV_BYTES).setBigUint64(
    IV_BYTES - 8,
    seq,
    true,
  );
  return iv;
}

/** Directional AEAD codec — per-direction sequence counters bind each
 * frame to its position. Throws on a short, out-of-sequence, or
 * tampered frame. */
export function createNoiseCodec(
  primitives: NoisePrimitives,
  opts: { sendKey: Uint8Array; recvKey: Uint8Array },
): SyncFrameCodec {
  let sendSeq = 0n;
  let recvSeq = 0n;
  return {
    seal(plain: Uint8Array): Uint8Array {
      const iv = seqIv(sendSeq);
      sendSeq += 1n;
      // aesGcmEncrypt returns ciphertext ‖ 16-byte tag.
      const sealed = primitives.aesGcmEncrypt(opts.sendKey, iv, plain);
      return concatBytes(iv, sealed);
    },
    open(frame: Uint8Array): Uint8Array {
      if (frame.length < IV_BYTES + TAG_BYTES) {
        throw new Error('sealed frame too short');
      }
      const iv = frame.subarray(0, IV_BYTES);
      if (!bytesEqual(iv, seqIv(recvSeq))) {
        // Full-IV compare: the four high bytes are wire-fixed zeros,
        // so an out-of-place seq — or a nonzero prefix — both kill.
        throw new Error('sealed frame out of sequence');
      }
      recvSeq += 1n;
      return primitives.aesGcmDecrypt(
        opts.recvKey,
        iv,
        frame.subarray(IV_BYTES),
      );
    },
  };
}

/* ---------------------------- identity ------------------------------ */

/** Shape validation — the record LOOKS like an identity record. */
export function isSyncIdentity(value: unknown): value is SyncIdentity {
  return (
    isRecord(value) &&
    hasKeys(value, ['pub', 'priv'], []) &&
    isString(value['pub'], 128) &&
    isString(value['priv'], 256)
  );
}

/* ----------------------------- the suite ---------------------------- */

/**
 * One noise-v1 implementation bound to a platform's primitives. The
 * surface covers every caller the two old files had: keygen + custody
 * validation (`createIdentity`/`isUsableIdentity`), the custody key
 * (`fingerprintOf`), the strict hello guard (`isClientHello` — shape
 * AND canonical key material), and the two handshake roles.
 */
export type NoiseSuite = {
  readonly name: typeof NOISE_SUITE_NAME;
  readonly primitives: NoisePrimitives;
  createIdentity(): SyncIdentity;
  /**
   * Shape says a record LOOKS like an identity; this proves the
   * material actually decodes as X25519 keys AND the pair matches —
   * a corrupt custody read regenerates instead of silently breaking
   * every handshake.
   */
  isUsableIdentity(identity: SyncIdentity): boolean;
  /** sha256(pub SPKI DER) hex — the fingerprint custody keys on. */
  fingerprintOf(pubSpkiB64: string): string;
  /**
   * The strict hello guard — shape via the shared wire validator PLUS
   * canonical X25519 key material, so a key that can't feed DH never
   * reaches the accept path (or a fingerprint/registry slot).
   */
  isClientHello(value: unknown): value is ClientHello;
  /** The dialer's half — binds `identity` as the device key. */
  clientCrypto(identity: SyncIdentity): SyncClientCrypto;
  /** The acceptor's half — `accept` throws on malformed key material. */
  responderCrypto(identity: SyncIdentity): SyncResponderCrypto;
  /** Frame codec on raw directional keys — golden-vector seam. */
  createCodec(opts: {
    sendKey: Uint8Array;
    recvKey: Uint8Array;
  }): SyncFrameCodec;
};

export function createNoiseSuite(primitives: NoisePrimitives): NoiseSuite {
  function fingerprintOf(pubSpkiB64: string): string {
    const der = base64Decode(pubSpkiB64);
    return der === null ? '' : hexOf(primitives.sha256(der));
  }

  function createIdentity(): SyncIdentity {
    const pair = primitives.generateX25519();
    return {
      pub: noiseSpkiB64(pair.publicKey),
      priv: noisePkcs8B64(pair.privateKey),
    };
  }

  function isUsableIdentity(identity: SyncIdentity): boolean {
    const privRaw = noiseRawPrivate(identity.priv);
    const pubRaw = noiseRawPublic(identity.pub);
    if (privRaw === null || pubRaw === null) {
      return false;
    }
    // Each half decoding is not enough — the stored pair must match,
    // or the challenge advertises one key while DH uses the other.
    try {
      return bytesEqual(primitives.x25519Public(privRaw), pubRaw);
    } catch {
      return false;
    }
  }

  function isCryptoHello(value: unknown): value is ClientHello {
    // The shared wire guard already bounds shape/deviceId; the crypto
    // half adds canonical X25519 material for eph + dev.
    return (
      isClientHello(value) &&
      noiseRawPublic(value.eph) !== null &&
      noiseRawPublic(value.dev) !== null
    );
  }

  function clientCrypto(identity: SyncIdentity): SyncClientCrypto {
    return {
      name: NOISE_SUITE_NAME,
      identity,
      fingerprintOf,
      createIdentity,
      begin({ deviceId, name }): SyncClientHandshake {
        const eph = primitives.generateX25519();
        const ephPub = noiseSpkiB64(eph.publicKey);
        return {
          hello: () => ({
            v: WIRE_VERSION,
            kind: 'hello',
            deviceId,
            name,
            eph: ephPub,
            dev: identity.pub,
          }),
          complete(challengeJson, { pinnedFp }) {
            if (!isServerChallenge(challengeJson)) {
              return err(
                appError('invalid-response', 'sync: malformed challenge'),
              );
            }
            const ephPubRaw = noiseRawPublic(challengeJson.eph);
            const spubRaw = noiseRawPublic(challengeJson.spub);
            const devPrivRaw = noiseRawPrivate(identity.priv);
            const salt = base64Decode(challengeJson.salt);
            if (
              ephPubRaw === null ||
              spubRaw === null ||
              devPrivRaw === null ||
              salt === null ||
              salt.length === 0
            ) {
              return err(
                appError(
                  'invalid-response',
                  'sync: challenge carries unusable key material',
                ),
              );
            }
            const serverFp = fingerprintOf(challengeJson.spub);
            if (pinnedFp !== undefined && pinnedFp !== serverFp) {
              return err(
                appError(
                  'permission-denied',
                  'sync: server fingerprint mismatch',
                ),
              );
            }
            try {
              const dh1 = primitives.x25519(eph.privateKey, ephPubRaw);
              const dh2 = primitives.x25519(devPrivRaw, ephPubRaw);
              const dh3 = primitives.x25519(eph.privateKey, spubRaw);
              const keys = primitives.hkdf(
                concatBytes(dh1, dh2, dh3),
                salt,
                HKDF_INFO,
                64,
              );
              const codec = createNoiseCodec(primitives, {
                sendKey: keys.subarray(0, 32),
                recvKey: keys.subarray(32, 64),
              });
              return ok({
                codec,
                registered: challengeJson.registered === true,
                serverPub: challengeJson.spub,
                serverFp,
              });
            } catch {
              // Raw crypto text stays out of the message — the kind
              // carries the failure class across the seam.
              return err(
                appError(
                  'invalid-response',
                  'sync: handshake derivation failed',
                ),
              );
            }
          },
        };
      },
    };
  }

  function responderCrypto(identity: SyncIdentity): SyncResponderCrypto {
    return {
      name: NOISE_SUITE_NAME,
      identity,
      accept(hello, { registered }) {
        const eph = primitives.generateX25519();
        const salt = primitives.randomBytes(32);
        const ephPubRaw = noiseRawPublic(hello.eph);
        const devPubRaw = noiseRawPublic(hello.dev);
        const devPrivRaw = noiseRawPrivate(identity.priv);
        if (
          ephPubRaw === null ||
          devPubRaw === null ||
          devPrivRaw === null
        ) {
          // Malformed key material dies the session — callers treat a
          // throw as connection death, never a typed reply.
          throw new Error('sync: hello carries unusable key material');
        }
        const dh1 = primitives.x25519(eph.privateKey, ephPubRaw);
        const dh2 = primitives.x25519(eph.privateKey, devPubRaw);
        const dh3 = primitives.x25519(devPrivRaw, ephPubRaw);
        const keys = primitives.hkdf(
          concatBytes(dh1, dh2, dh3),
          salt,
          HKDF_INFO,
          64,
        );
        const codec = createNoiseCodec(primitives, {
          sendKey: keys.subarray(32, 64),
          recvKey: keys.subarray(0, 32),
        });
        const challenge = ascii(
          JSON.stringify({
            v: WIRE_VERSION,
            kind: 'challenge',
            eph: noiseSpkiB64(eph.publicKey),
            salt: base64Encode(salt),
            spub: identity.pub,
            registered,
          }),
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

  return {
    name: NOISE_SUITE_NAME,
    primitives,
    createIdentity,
    isUsableIdentity,
    fingerprintOf,
    isClientHello: isCryptoHello,
    clientCrypto,
    responderCrypto,
    createCodec: (opts) => createNoiseCodec(primitives, opts),
  };
}
