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
      let text: string;
      try {
        text = await readFile(fileFor(key), 'utf8');
      } catch (thrown) {
        if (errorCode(thrown) === 'ENOENT') {
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
        return safeStorage.decryptString(decoded);
      } catch {
        throw shellError('corrupt-state', 'secure entry failed to decrypt');
      }
    },

    async set(key, value) {
      requireEncryption();
      const encrypted = Buffer.from(safeStorage.encryptString(value));
      const target = fileFor(key);
      // tmp + rename: a crash mid-write leaves a torn file that reads
      // back corrupt-state forever — publish only complete files.
      const staging = `${target}.tmp`;
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(staging, encrypted.toString('base64'), 'utf8');
        await rename(staging, target);
      } catch {
        await unlink(staging).catch(() => undefined);
        throw shellError('io-error', 'secure entry could not be written');
      }
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
    },
  };
}
