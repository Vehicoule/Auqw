import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode } from '../shared/check.ts';
import { shellError } from '../shared/errors.ts';

/**
 * The slice of Electron `safeStorage` the store needs — declared so the
 * store itself is electron-free and fakes drive the unit tests.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Uint8Array;
  decryptString(encrypted: Uint8Array): string;
}

export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * `safeStorage`-encrypted key/value files, one base64 file per validated
 * key under `dir`. When the OS offers no encryption backend every call
 * fails `unavailable` — secrets never fall back to plaintext.
 */
export function createSecureStore(opts: {
  dir: string;
  safeStorage: SafeStorageLike;
}): SecureStore {
  const { dir, safeStorage } = opts;
  let stagingSeq = 0;
  // One decrypt per key per process: every safeStorage.decryptString
  // touches the OS secret backend, and on macOS an entry whose Keychain
  // ACL doesn't yet trust the app prompts PER CALL — caching the
  // resolved value bounds the prompt count to the number of records,
  // once, instead of once per read. These files only change through
  // this store, so the cache can't diverge from disk in-process.
  const cache = new Map<string, string | null>();

  function fileFor(key: string): string {
    return join(dir, `${key}.b64`);
  }

  function requireEncryption(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw shellError(
        'unavailable',
        'os encryption backend is not available',
      );
    }
  }

  return {
    async get(key) {
      requireEncryption();
      if (cache.has(key)) {
        return cache.get(key) ?? null;
      }
      let text: string;
      try {
        text = await readFile(fileFor(key), 'utf8');
      } catch (thrown) {
        if (errorCode(thrown) === 'ENOENT') {
          cache.set(key, null);
          return null;
        }
        throw shellError('io-error', 'secure entry could not be read');
      }
      let decoded: Uint8Array;
      try {
        decoded = Buffer.from(text, 'base64');
      } catch {
        throw shellError('corrupt-state', 'secure entry is not base64');
      }
      try {
        const value = safeStorage.decryptString(decoded);
        cache.set(key, value);
        return value;
      } catch {
        // Corrupt entries stay uncached — a backend that recovers
        // (or a file a rewrite repairs) is retried, not memoized.
        throw shellError('corrupt-state', 'secure entry failed to decrypt');
      }
    },

    async set(key, value) {
      requireEncryption();
      const encrypted = Buffer.from(safeStorage.encryptString(value));
      const target = fileFor(key);
      // tmp + rename: a crash mid-write leaves a torn file that reads
      // back corrupt-state forever — publish only complete files. The
      // staging name is unique per call: two overlapping sets would
      // share one tmp path and a rename could publish the other's
      // half-written bytes.
      stagingSeq += 1;
      const staging = `${target}.${process.pid}.${stagingSeq}.tmp`;
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(staging, encrypted.toString('base64'), 'utf8');
        await rename(staging, target);
      } catch {
        await unlink(staging).catch(() => undefined);
        throw shellError('io-error', 'secure entry could not be written');
      }
      cache.set(key, value);
    },

    async delete(key) {
      requireEncryption();
      try {
        await unlink(fileFor(key));
      } catch (thrown) {
        if (errorCode(thrown) !== 'ENOENT') {
          throw shellError('io-error', 'secure entry could not be removed');
        }
      }
      cache.set(key, null);
    },
  };
}
