import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
  // The map holds the READ PROMISE, not the settled value — two
  // concurrent gets would each see a settled-value cache as empty and
  // both decrypt (two Keychain prompts for one key). Sharing the
  // in-flight promise coalesces them; failures evict so a recoverable
  // read retries instead of memoizing the error.
  const cache = new Map<string, Promise<string | null>>();

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

  async function readStored(key: string): Promise<string | null> {
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
      // Corrupt entries stay uncached — a backend that recovers
      // (or a file a rewrite repairs) is retried, not memoized.
      throw shellError('corrupt-state', 'secure entry failed to decrypt');
    }
  }

  // Same-key mutations serialize through this chain — an overlapping
  // set/delete otherwise races unlink-vs-rename, and the LAST cache
  // write could belong to the operation the filesystem discarded,
  // leaving reads stale for the life of the store. The fs work and the
  // cache publish travel inside one chained step so they can't split.
  const mutations = new Map<string, Promise<void>>();

  function serialize(key: string, work: () => Promise<void>): Promise<void> {
    const prior = mutations.get(key) ?? Promise.resolve();
    // Run even when the prior op rejected — a failed delete must not
    // wedge the key's queue.
    const next = prior.then(work, work);
    mutations.set(key, next);
    const cleanup = () => {
      if (mutations.get(key) === next) {
        mutations.delete(key);
      }
    };
    // Both branches handled — a rejected op still runs eviction without
    // an unhandled rejection.
    void next.then(cleanup, cleanup);
    return next;
  }

  return {
    async get(key) {
      requireEncryption();
      const hit = cache.get(key);
      if (hit !== undefined) {
        return hit;
      }
      const inflight = readStored(key);
      cache.set(key, inflight);
      // Identity check: a stale rejection must not evict a value a
      // concurrent set() wrote after this read started.
      inflight.catch(() => {
        if (cache.get(key) === inflight) {
          cache.delete(key);
        }
      });
      return inflight;
    },

    async set(key, value) {
      requireEncryption();
      const encrypted = Buffer.from(safeStorage.encryptString(value));
      const target = fileFor(key);
      // tmp + rename: a crash mid-write leaves a torn file that reads
      // back corrupt-state forever — publish only complete files. The
      // staging name is unique per call: two overlapping sets would
      // share one tmp path and a rename could publish the other's
      // half-written bytes. The durability chain matches the plugin
      // KV and the sync journal — fsync the staged bytes, atomic
      // rename, then best-effort parent-dir fsync — so a crash right
      // after a credential write cannot silently lose it.
      stagingSeq += 1;
      const staging = `${target}.${process.pid}.${stagingSeq}.tmp`;
      await serialize(key, async () => {
        let handle;
        try {
          await mkdir(dir, { recursive: true });
          handle = await open(staging, 'w');
          await handle.writeFile(encrypted.toString('base64'), 'utf8');
          // 'r+' not needed — the handle is already write-capable, and
          // Windows refuses FlushFileBuffers on a read-only handle.
          await handle.sync();
          await handle.close();
          handle = undefined;
          await rename(staging, target);
        } catch {
          if (handle !== undefined) {
            await handle.close().catch(() => undefined);
          }
          await unlink(staging).catch(() => undefined);
          throw shellError('io-error', 'secure entry could not be written');
        }
        // Best-effort dir fsync — the rename is already committed.
        try {
          const parent = await open(dir, 'r');
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        } catch {
          // Directory fsync is unsupported on some platforms — the
          // rename has landed; only the dir entry ordering is soft.
        }
        cache.set(key, Promise.resolve(value));
      });
    },

    async delete(key) {
      requireEncryption();
      await serialize(key, async () => {
        try {
          await unlink(fileFor(key));
        } catch (thrown) {
          if (errorCode(thrown) !== 'ENOENT') {
            throw shellError('io-error', 'secure entry could not be removed');
          }
        }
        cache.set(key, Promise.resolve(null));
      });
    },
  };
}
