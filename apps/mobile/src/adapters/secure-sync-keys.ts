import { deleteItemAsync, getItemAsync, setItemAsync } from 'expo-secure-store';
import type {
  CancellationSignal,
  Result,
  SyncClientKeys,
  SyncIdentity,
  SyncPeer,
} from '@auqw/application';
import { appError, err, isRecord, ok } from '@auqw/application';
import { nativeError } from './auqw-expo-surface.ts';

/**
 * SyncClientKeys over expo-secure-store (Android Keystore / iOS
 * Keychain). The device private key and the pinned peer records are
 * the ONLY sync secrets — they stay inside the OS secure store; no
 * sync key material ever lands in AsyncStorage.
 *
 * Layout (key charset is [a-zA-Z0-9._-]; 64-hex fps qualify):
 *   auqw.sync.identity    → {deviceId, identity:{pub,priv}}
 *   auqw.sync.peerIndex   → fp[]
 *   auqw.sync.peer.<fp>   → SyncPeer
 */

const IDENTITY_KEY = 'auqw.sync.identity';
const PEER_INDEX_KEY = 'auqw.sync.peerIndex';
const peerKey = (fp: string): string => `auqw.sync.peer.${fp}`;

async function readJsonStore(key: string): Promise<Result<unknown | null>> {
  try {
    const raw = await getItemAsync(key);
    if (raw === null) {
      return ok(null);
    }
    try {
      return ok(JSON.parse(raw));
    } catch {
      return err(
        appError('invalid-response', `sync: corrupt store ${key}`),
      );
    }
  } catch (thrown) {
    return err(nativeError(thrown));
  }
}

async function writeJsonStore(
  key: string,
  value: unknown,
): Promise<Result<void>> {
  try {
    await setItemAsync(key, JSON.stringify(value));
    return ok(undefined);
  } catch (thrown) {
    return err(nativeError(thrown));
  }
}

function isIdentityRecord(
  value: unknown,
): value is { deviceId: string; identity: SyncIdentity } {
  return (
    isRecord(value) &&
    typeof value['deviceId'] === 'string' &&
    isRecord(value['identity']) &&
    typeof value['identity']['pub'] === 'string' &&
    typeof value['identity']['priv'] === 'string'
  );
}

function isFpList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v))
  );
}

function isSyncPeerRecord(value: unknown): value is SyncPeer {
  if (!isRecord(value)) {
    return false;
  }
  const cursor = value['peerCursor'];
  return (
    typeof value['fp'] === 'string' &&
    /^[0-9a-f]{64}$/.test(value['fp']) &&
    typeof value['name'] === 'string' &&
    Array.isArray(value['endpoints']) &&
    value['endpoints'].every((e) => typeof e === 'string') &&
    typeof value['pairedAt'] === 'number' &&
    typeof value['lastSeenAt'] === 'number' &&
    isRecord(cursor) &&
    Object.values(cursor).every((m) => typeof m === 'number') &&
    (value['lastSyncAt'] === undefined ||
      typeof value['lastSyncAt'] === 'number')
  );
}

function cancelled(signal?: CancellationSignal): Result<never> | null {
  return signal?.cancelled === true
    ? err(appError('cancelled', 'sync: store read cancelled'))
    : null;
}

export function createSecureSyncKeys(): SyncClientKeys {
  // Index mutations are read-modify-write over two keys — serialized
  // so concurrent peerPut/peerDelete can't lose each other's entry
  // (a lost index row makes a durable peer record invisible).
  let indexChain: Promise<unknown> = Promise.resolve();
  const withIndexLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = indexChain.then(fn);
    indexChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    async identityGet(signal) {
      const hit = cancelled(signal);
      if (hit !== null) {
        return hit;
      }
      const read = await readJsonStore(IDENTITY_KEY);
      if (!read.ok) {
        return read;
      }
      if (read.value === null) {
        return ok(null);
      }
      if (!isIdentityRecord(read.value)) {
        return err(
          appError('invalid-response', 'sync: corrupt identity record'),
        );
      }
      return ok(read.value);
    },

    async identitySet(record, signal) {
      const hit = cancelled(signal);
      if (hit !== null) {
        return hit;
      }
      return writeJsonStore(IDENTITY_KEY, record);
    },

    async peerList(signal) {
      const hit = cancelled(signal);
      if (hit !== null) {
        return hit;
      }
      const indexRead = await readJsonStore(PEER_INDEX_KEY);
      if (!indexRead.ok) {
        return indexRead;
      }
      const fps =
        indexRead.value === null
          ? []
          : isFpList(indexRead.value)
            ? indexRead.value
            : null;
      if (fps === null) {
        return err(
          appError('invalid-response', 'sync: corrupt peer index'),
        );
      }
      const peers: SyncPeer[] = [];
      for (const fp of fps) {
        if (signal?.cancelled === true) {
          return err(
            appError('cancelled', 'sync: store read cancelled'),
          );
        }
        const read = await readJsonStore(peerKey(fp));
        if (!read.ok) {
          return read;
        }
        if (read.value === null) {
          continue; // stale index entry — prune on next write
        }
        if (!isSyncPeerRecord(read.value)) {
          return err(
            appError('invalid-response', 'sync: corrupt peer record'),
          );
        }
        peers.push(read.value);
      }
      return ok(peers);
    },

    async peerPut(peer, signal) {
      const hit = cancelled(signal);
      if (hit !== null) {
        return hit;
      }
      // Record + index inside one lock: a racing peerDelete between
      // the two writes would remove the freshly indexed record and
      // leave the pairing half-visible.
      return withIndexLock(async () => {
        const wrote = await writeJsonStore(peerKey(peer.fp), peer);
        if (!wrote.ok) {
          return wrote;
        }
        const indexRead = await readJsonStore(PEER_INDEX_KEY);
        if (!indexRead.ok) {
          return indexRead;
        }
        const fps = isFpList(indexRead.value) ? indexRead.value : [];
        if (fps.includes(peer.fp)) {
          return ok(undefined);
        }
        return writeJsonStore(PEER_INDEX_KEY, [...fps, peer.fp]);
      });
    },

    async peerDelete(fp, signal) {
      const hit = cancelled(signal);
      if (hit !== null) {
        return hit;
      }
      // Index before the record, both inside the lock: a failed delete
      // leaves an unreferenced record (inert — the index drives
      // listing) rather than a stale index entry every peerList reads
      // forever, and a racing peerPut can't interleave between them.
      return withIndexLock(async () => {
        const indexRead = await readJsonStore(PEER_INDEX_KEY);
        if (!indexRead.ok) {
          return indexRead;
        }
        const fps = isFpList(indexRead.value) ? indexRead.value : [];
        const wrote = await writeJsonStore(
          PEER_INDEX_KEY,
          fps.filter((f) => f !== fp),
        );
        if (!wrote.ok) {
          return wrote;
        }
        try {
          await deleteItemAsync(peerKey(fp));
        } catch (thrown) {
          return err(nativeError(thrown));
        }
        return ok(undefined);
      });
    },
  };
}
