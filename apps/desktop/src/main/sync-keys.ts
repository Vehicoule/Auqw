import { readdir } from 'node:fs/promises';
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

  async function devicePut(record: SyncDeviceRecord): Promise<void> {
    const existing = await secure.get(deviceKey(record.id));
    if (existing === null) {
      const { devices } = await deviceList();
      const isNewFp = !devices.some((d) => d.fp === record.fp);
      if (devices.length >= MAX_SYNC_DEVICES && isNewFp) {
        throw shellError(
          'unavailable',
          'paired device registry is full',
        );
      }
      // Same key re-pairing under a new id (reinstall) — drop stale ids.
      for (const d of devices) {
        if (d.fp === record.fp && d.id !== record.id) {
          await secure.delete(deviceKey(d.id));
        }
      }
    }
    await secure.set(deviceKey(record.id), JSON.stringify(record));
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
        await devicePut(op.record);
        return null;
      case 'device-delete':
        await secure.delete(deviceKey(op.id));
        return null;
    }
  };
}
