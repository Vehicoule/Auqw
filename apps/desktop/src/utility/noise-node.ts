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
} from 'node:crypto';
import {
  createNoiseSuite,
  noisePkcs8B64,
  noiseRawPrivate,
  noiseRawPublic,
  noiseSpkiB64,
  type NoisePrimitives,
  type NoiseSuite,
} from '@auqw/application';

/**
 * The desktop's NoisePrimitives — node:crypto, the only backend this
 * process has. The protocol (transcript order, HKDF info, nonce
 * layout, frame format) lives in @auqw/application's sync/noise.ts;
 * this file is just the primitive binding — X25519 key material
 * crosses node:crypto's API as canonical SPKI/PKCS8 DER, so the DER
 * helpers do the wrap/unwrap both directions.
 */

function derPub(raw: Uint8Array) {
  return {
    key: Buffer.from(noiseSpkiB64(raw), 'base64'),
    format: 'der' as const,
    type: 'spki' as const,
  };
}

function derPriv(raw: Uint8Array) {
  return {
    key: Buffer.from(noisePkcs8B64(raw), 'base64'),
    format: 'der' as const,
    type: 'pkcs8' as const,
  };
}

export function nodeNoisePrimitives(): NoisePrimitives {
  return {
    x25519(privateKey, publicKey) {
      return new Uint8Array(
        diffieHellman({
          privateKey: createPrivateKey(derPriv(privateKey)),
          publicKey: createPublicKey(derPub(publicKey)),
        }),
      );
    },
    x25519Public(privateKey) {
      const derived = createPublicKey(createPrivateKey(derPriv(privateKey)))
        .export({ format: 'der', type: 'spki' });
      const raw = noiseRawPublic(derived.toString('base64'));
      if (raw === null) {
        throw new Error('node:x25519 export is not canonical SPKI');
      }
      return new Uint8Array(raw);
    },
    generateX25519() {
      const pair = generateKeyPairSync('x25519');
      const publicKey = noiseRawPublic(
        pair.publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
      );
      const privateKey = noiseRawPrivate(
        pair.privateKey
          .export({ format: 'der', type: 'pkcs8' })
          .toString('base64'),
      );
      if (publicKey === null || privateKey === null) {
        throw new Error('node:x25519 export is not canonical DER');
      }
      return {
        privateKey: new Uint8Array(privateKey),
        publicKey: new Uint8Array(publicKey),
      };
    },
    sha256(bytes) {
      return new Uint8Array(createHash('sha256').update(bytes).digest());
    },
    hkdf(ikm, salt, info, length) {
      return new Uint8Array(
        hkdfSync(
          'sha256',
          Buffer.from(ikm),
          Buffer.from(salt),
          Buffer.from(info),
          length,
        ),
      );
    },
    aesGcmEncrypt(key, iv, plaintext, aad) {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      if (aad !== undefined) {
        cipher.setAAD(aad);
      }
      return new Uint8Array(
        Buffer.concat([
          cipher.update(Buffer.from(plaintext)),
          cipher.final(),
          cipher.getAuthTag(),
        ]),
      );
    },
    aesGcmDecrypt(key, iv, ctTag, aad) {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      if (aad !== undefined) {
        decipher.setAAD(aad);
      }
      decipher.setAuthTag(
        Buffer.from(ctTag.subarray(ctTag.length - 16)),
      );
      return new Uint8Array(
        Buffer.concat([
          decipher.update(
            Buffer.from(ctTag.subarray(0, ctTag.length - 16)),
          ),
          decipher.final(),
        ]),
      );
    },
    randomBytes(n) {
      return new Uint8Array(nodeRandom(n));
    },
  };
}

/**
 * The desktop's bound suite — one instance; the primitives hold no
 * state beyond the CSPRNG, so a module-level singleton is safe.
 * Tests that need scripted key material build their own suite over
 * `nodeNoisePrimitives()` with the mint/random slots replaced.
 */
export const nodeNoise: NoiseSuite = createNoiseSuite(
  nodeNoisePrimitives(),
);
