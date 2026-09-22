import {
  hasOnlyKeys,
  isBoundedString,
  isRecord,
  isSafeNonNegativeInt,
} from '../shared/check.ts';
import { shellError } from '../shared/errors.ts';
import { isSyncIdentity, type SyncIdentity } from './sync-crypto.ts';

/**
 * `sync:keys` — the utility→main custody channel. Electron's
 * safeStorage exists only in the main process, so pairing-protocol key
 * material (the desktop identity private key and every paired device's
 * public key record) crosses this internal channel to main's
 * SecureStore rather than any plain get/set. The renderer never sees
 * key material — its `api.sync.*` surface carries device metadata only.
 */

export const SYNC_KEYS_CHANNEL = 'sync:keys';

/** Cap on the registry — pairing spam can't grow the store unbounded. */
export const MAX_SYNC_DEVICES = 64;

export type SyncDeviceRecord = {
  /** Client-minted id — `^[a-z0-9][a-z0-9._-]{7,63}$`; feeds the file key. */
  readonly id: string;
  readonly name: string;
  /** Device long-lived X25519 public key, SPKI base64. */
  readonly pub: string;
  /** sha256(pub-DER) hex — the auth identity the session binds to. */
  readonly fp: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
};

export function isDeviceId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{7,63}$/.test(value)
  );
}

export function isSyncDeviceRecord(
  value: unknown,
): value is SyncDeviceRecord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'id',
      'name',
      'pub',
      'fp',
      'pairedAt',
      'lastSeenAt',
    ]) &&
    isDeviceId(value['id']) &&
    isBoundedString(value['name'], 128) &&
    isBoundedString(value['pub'], 128) &&
    /^[0-9a-f]{64}$/.test(String(value['fp'])) &&
    isSafeNonNegativeInt(value['pairedAt']) &&
    isSafeNonNegativeInt(value['lastSeenAt'])
  );
}

export type SyncKeysOp =
  | { readonly op: 'identity-get' }
  | { readonly op: 'identity-set'; readonly identity: SyncIdentity }
  | { readonly op: 'identity-replace'; readonly identity: SyncIdentity }
  | { readonly op: 'device-list' }
  | { readonly op: 'device-put'; readonly record: SyncDeviceRecord }
  | { readonly op: 'device-delete'; readonly id: string };

export type SyncKeysResult =
  | { readonly identity: SyncIdentity | null }
  | { readonly devices: readonly SyncDeviceRecord[]; readonly skipped: number }
  | null;

/** The custody surface the sync server uses — client or in-memory fake. */
export interface SyncKeys {
  identityGet(): Promise<SyncIdentity | null>;
  /** Create-once — refuses over an existing record. */
  identitySet(identity: SyncIdentity): Promise<void>;
  /**
   * Unconditional overwrite — the corrupt/unusable-identity recovery
   * path. Distinct from `identitySet` so routine init keeps its
   * create-once guarantee; replacing the desktop identity orphans
   * nothing on this side (device records hold the devices' own keys).
   */
  identityReplace(identity: SyncIdentity): Promise<void>;
  deviceList(): Promise<{
    devices: readonly SyncDeviceRecord[];
    skipped: number;
  }>;
  devicePut(record: SyncDeviceRecord): Promise<void>;
  deviceDelete(id: string): Promise<void>;
}

export function isSyncKeysOp(value: unknown): value is SyncKeysOp {
  if (!isRecord(value) || typeof value['op'] !== 'string') {
    return false;
  }
  switch (value['op']) {
    case 'identity-get':
    case 'device-list':
      return hasOnlyKeys(value, ['op']);
    case 'identity-set':
    case 'identity-replace':
      return (
        hasOnlyKeys(value, ['op', 'identity']) &&
        isSyncIdentity(value['identity'])
      );
    case 'device-put':
      return (
        hasOnlyKeys(value, ['op', 'record']) &&
        isSyncDeviceRecord(value['record'])
      );
    case 'device-delete':
      return (
        hasOnlyKeys(value, ['op', 'id']) && isDeviceId(value['id'])
      );
    default:
      return false;
  }
}

/**
 * In-memory SyncKeys double — unit tests for the server run against it;
 * production backs it with the service client to main. Marked plainly:
 * it holds key material unencrypted and is never wired into the app.
 */
export function createMemoryKeys(): SyncKeys & {
  records: Map<string, SyncDeviceRecord>;
} {
  let identity: SyncIdentity | null = null;
  const records = new Map<string, SyncDeviceRecord>();
  return {
    records,
    async identityGet() {
      return identity;
    },
    async identitySet(next) {
      // Faithful to custody: create-once — a second install is an
      // invalid-request, never a silent swap.
      if (identity !== null) {
        throw shellError(
          'invalid-request',
          'sync identity already installed',
        );
      }
      identity = next;
    },
    async identityReplace(next) {
      identity = next;
    },
    async deviceList() {
      return { devices: [...records.values()], skipped: 0 };
    },
    async devicePut(record) {
      records.set(record.id, record);
    },
    async deviceDelete(id) {
      records.delete(id);
    },
  };
}

/** Result validators for the client half — replies are re-checked. */
function isIdentityResult(
  value: unknown,
): value is { identity: SyncIdentity | null } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['identity']) &&
    (value['identity'] === null || isSyncIdentity(value['identity']))
  );
}

function isDeviceListResult(
  value: unknown,
): value is { devices: readonly SyncDeviceRecord[]; skipped: number } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['devices', 'skipped']) &&
    Array.isArray(value['devices']) &&
    value['devices'].length <= MAX_SYNC_DEVICES &&
    value['devices'].every(isSyncDeviceRecord) &&
    isSafeNonNegativeInt(value['skipped'])
  );
}

function isEmptyResult(value: unknown): value is null {
  return value === null;
}

/**
 * Utility-side client — `request` is the service-channel transport
 * (utility→main). Every reply is validated before it reaches the sync
 * server; a malformed reply throws at this seam, never inside it.
 */
export function createServiceKeys(
  request: (channel: string, args: unknown) => Promise<unknown>,
): SyncKeys {
  const call = async <T>(
    op: SyncKeysOp,
    is: (v: unknown) => v is T,
    label: string,
  ): Promise<T> => {
    const result: unknown = await request(SYNC_KEYS_CHANNEL, op);
    if (!is(result)) {
      throw shellError(
        'invalid-response',
        `sync-keys malformed reply for ${label}`,
      );
    }
    return result;
  };
  return {
    async identityGet() {
      return (
        await call({ op: 'identity-get' }, isIdentityResult, 'identity-get')
      ).identity;
    },
    async identitySet(identity) {
      await call({ op: 'identity-set', identity }, isEmptyResult, 'identity-set');
    },
    async identityReplace(identity) {
      await call(
        { op: 'identity-replace', identity },
        isEmptyResult,
        'identity-replace',
      );
    },
    async deviceList() {
      return call({ op: 'device-list' }, isDeviceListResult, 'device-list');
    },
    async devicePut(record) {
      await call({ op: 'device-put', record }, isEmptyResult, 'device-put');
    },
    async deviceDelete(id) {
      await call({ op: 'device-delete', id }, isEmptyResult, 'device-delete');
    },
  };
}
