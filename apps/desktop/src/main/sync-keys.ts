import { access, mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode } from '../shared/check.ts';
import { isShellError, shellError } from '../shared/errors.ts';
import type { SecureStore } from './secure-store.ts';
import { isSyncIdentity, type SyncIdentity } from '../utility/sync-crypto.ts';
import {
  isSyncDeviceRecord,
  isSyncKeysOp,
  MAX_SYNC_DEVICES,
  type SyncDeviceRecord,
  type SyncKeysOp,
} from '../utility/sync-keys.ts';

/**
 * The `sync:keys` service — the main-process half of the pairing key
 * custody channel. The utility process owns the listener and the
 * handshake but cannot reach Electron's `safeStorage`, so all key
 * material lives here as SecureStore entries: the desktop identity
 * under `auqw.sync.identity`, each paired device under
 * `auqw.sync.device.<id>` as a JSON record. When safeStorage has no OS
 * backend every op fails `unavailable` — pairing never falls back to
 * plaintext keys.
 */

const IDENTITY_KEY = 'auqw.sync.identity';
const DEVICE_PREFIX = 'auqw.sync.device.';
const SYNC_KEY_PREFIX = 'auqw.sync.';

/**
 * One-time custody move: builds before the `sync-secure` dir existed
 * stored sync entries next to renderer-reachable keys. Relocating the
 * ciphertext files preserves pairings across the upgrade — nothing is
 * decrypted, so a plain rename carries each entry. Existing entries in
 * the destination win; a partially migrated earlier boot just
 * continues. A failed read of the old dir means a pre-split install
 * never paired — nothing to move.
 */
export async function migrateSyncCustody(
  fromDir: string,
  toDir: string,
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(fromDir);
  } catch (thrown) {
    if (errorCode(thrown) === 'ENOENT') {
      return;
    }
    throw shellError('io-error', 'legacy secure dir could not be listed');
  }
  // The custody dir is created lazily by the store's first set — on a
  // first-boot-after-upgrade nothing has made it yet, and a rename
  // into a missing dir would silently skip every eligible entry.
  await mkdir(toDir, { recursive: true });
  for (const file of files) {
    if (!file.startsWith(SYNC_KEY_PREFIX) || !file.endsWith('.b64')) {
      continue;
    }
    const dest = join(toDir, file);
    try {
      // Destination wins: rename would silently overwrite on POSIX, so
      // check first — a partially migrated earlier boot must not
      // clobber what the new custody dir already holds.
      await access(dest);
      continue;
    } catch (thrown) {
      if (errorCode(thrown) !== 'ENOENT') {
        throw shellError('io-error', 'sync key migration failed');
      }
    }
    try {
      await rename(join(fromDir, file), dest);
    } catch (thrown) {
      if (errorCode(thrown) !== 'ENOENT') {
        throw shellError('io-error', 'sync key migration failed');
      }
    }
  }
}

function deviceKey(id: string): string {
  return `${DEVICE_PREFIX}${id}`;
}

function idFromKey(key: string): string | null {
  return key.startsWith(DEVICE_PREFIX) ? key.slice(DEVICE_PREFIX.length) : null;
}

export function createSyncKeysHandler(deps: {
  secure: SecureStore;
  /** The SecureStore directory — device listing enumerates its files. */
  dir: string;
}): (args: unknown) => Promise<unknown> {
  const { secure, dir } = deps;

  async function identityGet(): Promise<SyncIdentity | null> {
    const text = await secure.get(IDENTITY_KEY);
    if (text === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw shellError('corrupt-state', 'sync identity is not json');
    }
    if (!isSyncIdentity(parsed)) {
      throw shellError('corrupt-state', 'sync identity failed validation');
    }
    return parsed;
  }

  async function deviceList(): Promise<{
    devices: SyncDeviceRecord[];
    skipped: number;
  }> {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (thrown) {
      if (errorCode(thrown) === 'ENOENT') {
        return { devices: [], skipped: 0 };
      }
      throw shellError('io-error', 'secure dir could not be listed');
    }
    const devices: SyncDeviceRecord[] = [];
    let skipped = 0;
    for (const file of files) {
      if (!file.startsWith(DEVICE_PREFIX) || !file.endsWith('.b64')) {
        continue;
      }
      const id = idFromKey(file.slice(0, -'.b64'.length));
      if (id === null) {
        skipped += 1;
        continue;
      }
      try {
        const text = await secure.get(deviceKey(id));
        if (text === null) {
          skipped += 1;
          continue;
        }
        const parsed: unknown = JSON.parse(text);
        if (isSyncDeviceRecord(parsed)) {
          devices.push(parsed);
        } else {
          skipped += 1;
        }
      } catch (thrown) {
        // A corrupt entry is counted, not fatal — the device it
        // described just looks unpaired and must re-pair. A dead
        // encryption backend is systemic: surface it, don't hide it.
        if (isShellError(thrown) && thrown.kind === 'unavailable') {
          throw thrown;
        }
        skipped += 1;
      }
    }
    return { devices, skipped };
  }

  // Registry mutations serialize behind one promise chain: the
  // cap-check → fp-dedupe → write sequence is a single logical
  // transaction, and two concurrent puts must not both observe room
  // for a 65th record (an oversized list then fails its own boundary
  // validator and breaks every deviceList call).
  let registryChain: Promise<void> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = registryChain.then(fn);
    registryChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function devicePut(record: SyncDeviceRecord): Promise<void> {
    const existing = await secure.get(deviceKey(record.id));
    const { devices } = await deviceList();
    if (existing === null) {
      const isNewFp = !devices.some((d) => d.fp === record.fp);
      if (devices.length >= MAX_SYNC_DEVICES) {
        if (isNewFp) {
          throw shellError(
            'unavailable',
            'paired device registry is full',
          );
        }
        // At capacity a same-fp migration must evict BEFORE writing —
        // a transient 65th file would trip the device-list bound and
        // wedge the registry. A failed write after the evict leaves the
        // phone needing a re-pair, which is recoverable; a wedged
        // registry is not.
        for (const d of devices) {
          if (d.fp === record.fp && d.id !== record.id) {
            await secure.delete(deviceKey(d.id));
          }
        }
      }
    }
    // Below capacity, write BEFORE evicting stale-fp ids: a failed
    // write must not delete the only valid registration. And dedupe
    // runs on EVERY put — including update-path retries — so a failed
    // cleanup converges on the next call instead of leaving same-fp
    // duplicates forever.
    await secure.set(deviceKey(record.id), JSON.stringify(record));
    for (const d of devices) {
      if (d.fp === record.fp && d.id !== record.id) {
        await secure.delete(deviceKey(d.id));
      }
    }
  }

  return async (args: unknown) => {
    if (!isSyncKeysOp(args)) {
      throw shellError('invalid-request', 'sync:keys bad op');
    }
    const op: SyncKeysOp = args;
    switch (op.op) {
      case 'identity-get':
        return { identity: await identityGet() };
      case 'identity-set': {
        const existing = await identityGet();
        if (existing !== null) {
          // Rotation orphans every pairing — refuse silently swapping.
          throw shellError(
            'invalid-request',
            'sync identity already installed',
          );
        }
        await secure.set(IDENTITY_KEY, JSON.stringify(op.identity));
        return null;
      }
      case 'identity-replace':
        // Recovery/rotation path — deliberately bypasses the
        // create-once preflight (which would itself trip on the broken
        // record it's replacing). Device pairings hold the devices'
        // own keys, so they survive a desktop-identity rotation; a
        // phone that pinned our old fingerprint re-pairs.
        await secure.set(IDENTITY_KEY, JSON.stringify(op.identity));
        return null;
      case 'device-list':
        return deviceList();
      case 'device-put':
        return serialized(async () => {
          await devicePut(op.record);
          return null;
        });
      case 'device-touch':
        // Update iff the record still exists with the same fp —
        // check-and-write inside the serialized section is the atomic
        // guard against a concurrent unpair.
        return serialized(async () => {
          const text = await secure.get(deviceKey(op.record.id));
          if (text === null) {
            return { updated: false };
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            return { updated: false };
          }
          if (
            !isSyncDeviceRecord(parsed) ||
            parsed.fp !== op.record.fp
          ) {
            return { updated: false };
          }
          await secure.set(
            deviceKey(op.record.id),
            JSON.stringify(op.record),
          );
          return { updated: true };
        });
      case 'device-delete':
        return serialized(async () => {
          await secure.delete(deviceKey(op.id));
          return null;
        });
    }
  };
}
