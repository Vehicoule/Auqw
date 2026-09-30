import {
  hasOnlyKeys,
  isRecord,
  isSafeNonNegativeInt,
} from '../shared/check.ts';
import { shellError } from '../shared/errors.ts';
import {
  isSyncIdentity,
  readSyncCallerPeer,
  type SyncCallerPeer,
  type SyncIdentity,
} from '@auqw/application';
import { nodeNoise } from './noise-node.ts';

/**
 * `sync:keys` — the utility→main custody channel. Electron's
 * safeStorage exists only in the main process, so pairing-protocol key
 * material (the desktop identity private key and every paired device's
 * public key record) crosses this internal channel to main's
 * SecureStore rather than any plain get/set. The renderer never sees
 * key material — its `api.sync.*` surface carries device metadata only.
 */

const SYNC_KEYS_CHANNEL = 'sync:keys';

/** Cap on the registry — pairing spam can't grow the store unbounded. */
export const MAX_SYNC_DEVICES = 64;

/**
 * A paired caller's custody record — the unified `role:'caller'`
 * SyncPeerRecord the application package owns. Rows written before
 * the unification carry no `role` tag (and no `endpoints`); the
 * reader below accepts them and normalizes to the tagged shape.
 */
export type SyncDeviceRecord = SyncCallerPeer;

export function isDeviceId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{7,63}$/.test(value)
  );
}

/**
 * Read a stored device record — tagged rows pass through, legacy
 * untagged rows normalize to `role:'caller'`. The fp↔pub binding is
 * still enforced cryptographically: a record whose fp isn't
 * sha256(its own pub) misbinds resume identity and fp-dedupe, so it
 * reads as no record at all.
 */
export function readSyncDeviceRecord(
  value: unknown,
): SyncDeviceRecord | null {
  const row = readSyncCallerPeer(value);
  if (row === null) {
    return null;
  }
  return nodeNoise.fingerprintOf(row.pub) === row.fp ? row : null;
}

export function isSyncDeviceRecord(
  value: unknown,
): value is SyncDeviceRecord {
  return readSyncDeviceRecord(value) !== null;
}

export type SyncKeysOp =
  | { readonly op: 'identity-get' }
  | { readonly op: 'identity-set'; readonly identity: SyncIdentity }
  | { readonly op: 'identity-replace'; readonly identity: SyncIdentity }
  | { readonly op: 'device-list' }
  | { readonly op: 'device-put'; readonly record: SyncDeviceRecord }
  | { readonly op: 'device-touch'; readonly record: SyncDeviceRecord }
  | { readonly op: 'device-delete'; readonly id: string };

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
  /**
   * Update iff a record with this id AND fp is still registered —
   * false means it vanished (e.g. an unpair landed mid-handshake), so
   * the caller must NOT recreate it. Atomic inside custody's
   * serialized registry section.
   */
  deviceTouch(record: SyncDeviceRecord): Promise<boolean>;
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
    case 'device-touch':
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

function isTouchResult(value: unknown): value is { updated: boolean } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['updated']) &&
    typeof value['updated'] === 'boolean'
  );
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
    async deviceTouch(record) {
      return (
        await call(
          { op: 'device-touch', record },
          isTouchResult,
          'device-touch',
        )
      ).updated;
    },
    async deviceDelete(id) {
      await call({ op: 'device-delete', id }, isEmptyResult, 'device-delete');
    },
  };
}
