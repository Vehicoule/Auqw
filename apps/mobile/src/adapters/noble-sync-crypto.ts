import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  AppError,
  ErrorKind,
  Result,
  SyncClientCrypto,
  SyncClientHandshake,
  SyncFrameCodec,
  SyncIdentity,
} from '@auqw/application';
import { appError, err, isServerChallenge, ok } from '@auqw/application';

/**
 * The noise-v1 client half on noble primitives — the mobile runtime
 * has no node:crypto, so DH/HKDF/GCM come from @noble (pure JS,
 * constant-time, audited). Byte-for-byte identical to the desktop's
 * construction: SPKI/PKCS8 DER custody formats, HKDF info
 * 'auqw-sync-v1', iv = 4 zero bytes ‖ u64le seq, frames sealed
 * iv‖ct‖tag16 and sequence-bound on open.
 *
 * `random` is injected because RN has no crypto.getRandomValues —
 * production wires the native module's SecureRandom-backed
 * `syncRandomBytes`; tests wire x25519.utils.randomSecretKey.
 */

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
    out += b === undefined ? '=' : B64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
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

export function base64Decode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    return null;
  }
  const quads = value.length / 4;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(quads * 3 - padding);
  const digitAt = (at: number): number => {
    const code = value.charCodeAt(at);
    // '=' padding contributes zero bits, never a table hit.
    return value[at] === '=' ? 0 : (B64_LOOKUP[code] ?? -1);
  };
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
  for (const part of parts) {
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
    bytes.length >= prefix.length &&
    prefix.every((b, i) => bytes[i] === b)
  );
}

/** SPKI DER b64 → raw 32-byte X25519 public key; null when not ours. */
function rawPublic(spkiB64: string): Uint8Array | null {
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
function rawPrivate(pkcs8B64: string): Uint8Array | null {
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

function spkiOf(rawPub: Uint8Array): string {
  return base64Encode(concatBytes(SPKI_PREFIX, rawPub));
}

function pkcs8Of(rawPriv: Uint8Array): string {
  return base64Encode(concatBytes(PKCS8_PREFIX, rawPriv));
}

function sha256Hex(bytes: Uint8Array): string {
  return [...sha256(bytes)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ------------------------------ codec ------------------------------- */

const IV_BYTES = 12;
const TAG_BYTES = 16;

function seqIv(seq: bigint): Uint8Array {
  const iv = new Uint8Array(IV_BYTES);
  const view = new DataView(iv.buffer, iv.byteOffset, IV_BYTES);
  view.setBigUint64(IV_BYTES - 8, seq, true);
  return iv;
}

function seqOf(iv: Uint8Array): bigint {
  return new DataView(iv.buffer, iv.byteOffset, IV_BYTES).getBigUint64(
    IV_BYTES - 8,
    true,
  );
}

function createCodec(sendKey: Uint8Array, recvKey: Uint8Array): SyncFrameCodec {
  let sendSeq = 0n;
  let recvSeq = 0n;
  return {
    seal(plain: Uint8Array): Uint8Array {
      const iv = seqIv(sendSeq);
      sendSeq += 1n;
      // gcm.encrypt returns ciphertext ‖ 16-byte tag.
      const sealed = gcm(sendKey, iv).encrypt(plain);
      return concatBytes(iv, sealed);
    },
    open(frame: Uint8Array): Uint8Array {
      if (frame.length < IV_BYTES + TAG_BYTES) {
        throw new Error('sealed frame too short');
      }
      const iv = frame.subarray(0, IV_BYTES);
      if (seqOf(iv) !== recvSeq) {
        // Sequence binding keeps replayed/reordered frames dead — TCP
        // ordering means a gap is always tamper or desync.
        throw new Error('sealed frame out of sequence');
      }
      recvSeq += 1n;
      return gcm(recvKey, iv).decrypt(frame.subarray(IV_BYTES));
    },
  };
}

/* ---------------------------- the suite ----------------------------- */

function cryptoError(kind: ErrorKind, message: string): AppError {
  return appError(kind, message);
}

/** Mint a device keypair — the standalone mint lets custody
 * (`ensureSyncIdentity`) run before a suite instance exists. */
export function createNobleIdentity(
  randomBytes: (n: number) => Uint8Array,
): SyncIdentity {
  const priv = randomBytes(X25519_KEY_BYTES);
  const pub = x25519.getPublicKey(priv);
  return { pub: spkiOf(pub), priv: pkcs8Of(priv) };
}

/**
 * `identity` is the device's long-lived keypair (from SyncClientKeys
 * custody). `begin` mints a fresh ephemeral per connection — the
 * handshake object is single-use like the desktop's.
 */
export function createNobleSyncCrypto(opts: {
  identity: SyncIdentity;
  /** CSPRNG source — native SecureRandom in production. */
  randomBytes: (n: number) => Uint8Array;
}): SyncClientCrypto {
  return {
    name: 'noise-v1',
    get identity() {
      return opts.identity;
    },
    createIdentity(): SyncIdentity {
      return createNobleIdentity(opts.randomBytes);
    },
    begin({ deviceId, name }): SyncClientHandshake {
      const ephPriv = opts.randomBytes(X25519_KEY_BYTES);
      const ephPub = x25519.getPublicKey(ephPriv);
      return {
        hello: () => ({
          v: 1,
          kind: 'hello',
          deviceId,
          name,
          eph: spkiOf(ephPub),
          dev: opts.identity.pub,
        }),
        complete(challengeJson, { pinnedFp }) {
          if (!isServerChallenge(challengeJson)) {
            return err(
              cryptoError('invalid-response', 'sync: malformed challenge'),
            );
          }
          const ephPubRaw = rawPublic(challengeJson.eph);
          const spubRaw = rawPublic(challengeJson.spub);
          const spubDer = base64Decode(challengeJson.spub);
          const devPrivRaw = rawPrivate(opts.identity.priv);
          const salt = base64Decode(challengeJson.salt);
          if (
            ephPubRaw === null ||
            spubRaw === null ||
            spubDer === null ||
            devPrivRaw === null ||
            salt === null ||
            salt.length === 0
          ) {
            return err(
              cryptoError(
                'invalid-response',
                'sync: challenge carries unusable key material',
              ),
            );
          }
          const serverFp = sha256Hex(spubDer);
          if (pinnedFp !== undefined && pinnedFp !== serverFp) {
            return err(
              cryptoError(
                'permission-denied',
                'sync: server fingerprint mismatch',
              ),
            );
          }
          let codec: SyncFrameCodec;
          try {
            const dh1 = x25519.getSharedSecret(ephPriv, ephPubRaw);
            const dh2 = x25519.getSharedSecret(devPrivRaw, ephPubRaw);
            const dh3 = x25519.getSharedSecret(ephPriv, spubRaw);
            const keys = hkdf(
              sha256,
              concatBytes(dh1, dh2, dh3),
              salt,
              utf8('auqw-sync-v1'),
              64,
            );
            codec = createCodec(
              keys.subarray(0, 32),
              keys.subarray(32, 64),
            );
          } catch (thrown) {
            return err(
              cryptoError(
                'invalid-response',
                `sync: handshake derivation failed (${thrown instanceof Error ? thrown.message : 'crypto error'})`,
              ),
            );
          }
          return ok({
            codec,
            registered: challengeJson.registered,
            serverPub: challengeJson.spub,
            serverFp,
          });
        },
      };
    },
  };
}

function utf8(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}
