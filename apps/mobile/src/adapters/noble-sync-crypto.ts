import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  NoisePrimitives,
  NoiseSuite,
  SyncClientCrypto,
  SyncIdentity,
  SyncResponderCrypto,
} from '@auqw/application';
import {
  base64Decode,
  base64Encode,
  createNoiseSuite,
} from '@auqw/application';

/**
 * The mobile NoisePrimitives — noble bindings for the shared noise-v1
 * suite (@auqw/application's sync/noise.ts owns the protocol: SPKI/
 * PKCS8 custody formats, HKDF info 'auqw-sync-v1', iv = 4 zero bytes
 * ‖ u64le seq, frames sealed iv‖ct‖tag16). The mobile runtime has no
 * node:crypto, so DH/HKDF/GCM come from @noble (pure JS,
 * constant-time, audited) — the SAME primitive choices the bespoke
 * implementation used, so peers minted before the consolidation still
 * handshake bit-for-bit.
 *
 * `random` is injected because RN has no crypto.getRandomValues —
 * production wires the native module's SecureRandom-backed
 * `syncRandomBytes`; tests wire x25519.utils.randomSecretKey.
 */

export { base64Decode, base64Encode };

export function nobleNoisePrimitives(
  randomBytes: (n: number) => Uint8Array,
): NoisePrimitives {
  return {
    x25519(privateKey, publicKey) {
      return x25519.getSharedSecret(privateKey, publicKey);
    },
    x25519Public(privateKey) {
      return x25519.getPublicKey(privateKey);
    },
    generateX25519() {
      const privateKey = randomBytes(32);
      return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
    },
    sha256(bytes) {
      return sha256(bytes);
    },
    hkdf(ikm, salt, info, length) {
      return hkdf(sha256, ikm, salt, info, length);
    },
    aesGcmEncrypt(key, iv, plaintext, aad) {
      // gcm.encrypt returns ciphertext ‖ 16-byte tag.
      return gcm(key, iv, aad).encrypt(plaintext);
    },
    aesGcmDecrypt(key, iv, ctTag, aad) {
      // gcm.decrypt throws on tag failure — the suite's open() relies
      // on that.
      return gcm(key, iv, aad).decrypt(ctTag);
    },
    randomBytes,
  };
}

/** A bound noise-v1 suite on noble — one per CSPRNG binding. */
export function nobleNoise(
  randomBytes: (n: number) => Uint8Array,
): NoiseSuite {
  return createNoiseSuite(nobleNoisePrimitives(randomBytes));
}

/** Mint a device keypair — the standalone mint lets custody
 * (`ensureSyncIdentity`) run before a suite instance exists. */
export function createNobleIdentity(
  randomBytes: (n: number) => Uint8Array,
): SyncIdentity {
  return nobleNoise(randomBytes).createIdentity();
}

/**
 * `identity` is the device's long-lived keypair (from SyncClientKeys
 * custody). `begin` mints a fresh ephemeral per connection — the
 * handshake object is single-use.
 */
export function createNobleSyncCrypto(opts: {
  identity: SyncIdentity;
  /** CSPRNG source — native SecureRandom in production. */
  randomBytes: (n: number) => Uint8Array;
}): SyncClientCrypto {
  return nobleNoise(opts.randomBytes).clientCrypto(opts.identity);
}

/** sha256(SPKI DER) hex — the wire `fp` derivation custody keys on. */
export function nobleFingerprintOf(spkiB64: string): string {
  // Fingerprint needs only sha256 — the RNG is never touched, so a
  // throwing stub is safe (and honest if a caller ever did need it).
  return nobleNoise(() => {
    throw new Error('sync: fingerprint needs no randomness');
  }).fingerprintOf(spkiB64);
}

/**
 * The noise-v1 responder half for the pair host — the shared suite's
 * accept(): fresh ephemeral, 32-byte salt, dh1 = eph·hello.eph, dh2 =
 * eph·hello.dev, dh3 = static·hello.eph, keys = HKDF-64(dh1‖dh2‖dh3,
 * salt, 'auqw-sync-v1'), responder sends on keys[32:64] / receives on
 * keys[0:32]. A malformed hello's key material throws — the caller
 * treats that as connection death, never a typed reply.
 */
export function createNobleSyncResponder(opts: {
  identity: SyncIdentity;
  randomBytes: (n: number) => Uint8Array;
}): SyncResponderCrypto {
  return nobleNoise(opts.randomBytes).responderCrypto(opts.identity);
}
