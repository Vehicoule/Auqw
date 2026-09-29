import {
  hasKeys,
  isRecord,
  isSafeNonNegative,
  isString,
} from '../domain.ts';
import { isSyncCursor, type SyncCursor } from './sync-engine.ts';
import {
  DEVICE_ID_PATTERN,
  DEVICE_NAME_MAX,
  FINGERPRINT_PATTERN,
} from './sync-wire.ts';

/**
 * The unified paired-peer custody record — ONE row shape both
 * platforms persist. `role` names the PEER's wire role toward the
 * row's owner (the same direction the handshake names its halves):
 *
 *   'caller'    — the peer dials us. The responder's device registry:
 *                 id + pub pin the caller's identity key, fp is the
 *                 lookup key. `endpoints` records the caller's
 *                 dialable addrs when the host learned them (a pair
 *                 host stores them so it can dial back).
 *   'responder' — we dial the peer. The caller's dial book: fp pins
 *                 the server identity on every later dial, endpoints
 *                 + peerCursor carry reconnect and export state.
 *
 * Rows stored by pre-unification builds carry no `role` — the read
 * helpers below infer it from the shape (a dial-book row carries
 * `endpoints`/`peerCursor`, a registry row carries `id`/`pub`) and
 * normalize on load, so records minted on shipped devices still
 * load. Writes always emit the tagged shape.
 */

/** A peer whose role toward us is 'caller' — it dials; we answer. */
export type SyncCallerPeer = {
  readonly role: 'caller';
  /** The caller's claimed deviceId — registry names it, not the wire. */
  readonly id: string;
  readonly name: string;
  /** Caller's device X25519 SPKI, base64. */
  readonly pub: string;
  /** sha256(pub DER) hex — the registry's auth identity + lookup key. */
  readonly fp: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
  /** Dialable `host:port`s learned from the hello — may be absent. */
  readonly endpoints?: readonly string[];
};

/**
 * A peer whose role toward us is 'responder' — we dial it. `fp` pins
 * the server identity on every later dial; `peerCursor` is the peer's
 * watermark map learned from its last delta — the `since` filter for
 * the next export, and the implicit ack of what it already merged.
 */
export type SyncPeer = {
  readonly role: 'responder';
  readonly fp: string;
  readonly name: string;
  readonly endpoints: readonly string[];
  readonly pairedAt: number;
  readonly lastSeenAt: number;
  readonly peerCursor: SyncCursor;
  readonly lastSyncAt?: number;
  /**
   * The peer's deviceId — captured when the peer hosted the pairing
   * (its welcome discloses the responder identity); absent on records
   * from a responder that never shared it.
   */
  readonly deviceId?: string;
  /** The peer's device public key (SPKI b64) — welcome host field. */
  readonly pub?: string;
  /**
   * The peer's bundled POT service as `host:port`, learned from the
   * pairing payload — shares `endpoints`' freshness horizon (a
   * desktop restart rebinds both; the next pair refreshes).
   */
  readonly pot?: string;
};

export type SyncPeerRecord = SyncPeer | SyncCallerPeer;

function isFp(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}

/**
 * The responder row's fields, minus the role tag — the READ bounds
 * deliberately match the shipped mobile reader, not the write guard:
 * `name`/endpoints are unbounded strings, the timestamps any number,
 * and the optionals may carry ''. Every record a shipped build could
 * have stored must still load; strictness lives in `isSyncPeer`.
 */
function readResponderRow(value: Record<string, unknown>): SyncPeer | null {
  const endpoints = value['endpoints'];
  const cursor = value['peerCursor'];
  return isFp(value['fp']) &&
    typeof value['name'] === 'string' &&
    Array.isArray(endpoints) &&
    endpoints.every((ep) => typeof ep === 'string') &&
    typeof value['pairedAt'] === 'number' &&
    typeof value['lastSeenAt'] === 'number' &&
    isRecord(cursor) &&
    Object.values(cursor).every((m) => typeof m === 'number') &&
    (value['lastSyncAt'] === undefined ||
      typeof value['lastSyncAt'] === 'number') &&
    (value['deviceId'] === undefined ||
      (typeof value['deviceId'] === 'string' &&
        value['deviceId'].length <= 64)) &&
    (value['pub'] === undefined ||
      (typeof value['pub'] === 'string' && value['pub'].length <= 128)) &&
    (value['pot'] === undefined ||
      (typeof value['pot'] === 'string' && value['pot'].length <= 320))
    ? {
        role: 'responder',
        fp: value['fp'],
        name: value['name'],
        endpoints,
        pairedAt: value['pairedAt'],
        lastSeenAt: value['lastSeenAt'],
        peerCursor: cursor as SyncCursor,
        ...(value['lastSyncAt'] === undefined
          ? {}
          : { lastSyncAt: value['lastSyncAt'] }),
        ...(value['deviceId'] === undefined
          ? {}
          : { deviceId: value['deviceId'] }),
        ...(value['pub'] === undefined ? {} : { pub: value['pub'] }),
        ...(value['pot'] === undefined ? {} : { pot: value['pot'] }),
      }
    : null;
}

/**
 * The caller row's fields, minus the role tag — READ bounds match the
 * shipped desktop device-record validator (id pattern, bounded
 * strings, safe-integer timestamps). Extra keys are ignored — the
 * old exact-keys guard rejected them, but the fp↔pub binding check
 * the custody layers still wrap around this reader is what actually
 * binds the row to a key, so a stray field can't forge identity.
 */
function readCallerRow(value: Record<string, unknown>): SyncCallerPeer | null {
  const endpoints = value['endpoints'];
  return isString(value['id'], 64) &&
    DEVICE_ID_PATTERN.test(value['id']) &&
    isString(value['name'], DEVICE_NAME_MAX) &&
    isString(value['pub'], 128) &&
    isFp(value['fp']) &&
    isSafeNonNegative(value['pairedAt']) &&
    isSafeNonNegative(value['lastSeenAt']) &&
    (endpoints === undefined ||
      (Array.isArray(endpoints) &&
        endpoints.every((ep) => typeof ep === 'string')))
    ? {
        role: 'caller',
        id: value['id'],
        name: value['name'],
        pub: value['pub'],
        fp: value['fp'],
        pairedAt: value['pairedAt'],
        lastSeenAt: value['lastSeenAt'],
        ...(endpoints === undefined ? {} : { endpoints }),
      }
    : null;
}

/**
 * The strict write-shape guard for a caller row — the tagged record
 * exactly as `role:'caller'` custody emits it. The fp↔pub binding
 * (sha256(pub) === fp) is a crypto check and stays caller-side.
 */
export function isSyncCallerPeer(
  value: unknown,
): value is SyncCallerPeer {
  const endpoints = isRecord(value) ? value['endpoints'] : undefined;
  return (
    isRecord(value) &&
    hasKeys(
      value,
      ['role', 'id', 'name', 'pub', 'fp', 'pairedAt', 'lastSeenAt'],
      ['endpoints'],
    ) &&
    value['role'] === 'caller' &&
    isString(value['id'], 64) &&
    DEVICE_ID_PATTERN.test(value['id']) &&
    isString(value['name'], DEVICE_NAME_MAX) &&
    isString(value['pub'], 128) &&
    isFp(value['fp']) &&
    isSafeNonNegative(value['pairedAt']) &&
    isSafeNonNegative(value['lastSeenAt']) &&
    (endpoints === undefined ||
      (Array.isArray(endpoints) &&
        endpoints.every((ep) => isString(ep, 320))))
  );
}

/**
 * The strict write-shape guard for a responder row — the tagged record
 * exactly as `role:'responder'` custody emits it. Deliberately
 * tighter than the legacy reader — writes carry only canonical
 * bounds even though old stores may hold looser rows.
 */
export function isSyncPeer(value: unknown): value is SyncPeer {
  const endpoints = isRecord(value) ? value['endpoints'] : undefined;
  return (
    isRecord(value) &&
    hasKeys(
      value,
      [
        'role',
        'fp',
        'name',
        'endpoints',
        'pairedAt',
        'lastSeenAt',
        'peerCursor',
      ],
      ['lastSyncAt', 'deviceId', 'pub', 'pot'],
    ) &&
    value['role'] === 'responder' &&
    isFp(value['fp']) &&
    isString(value['name'], DEVICE_NAME_MAX) &&
    Array.isArray(endpoints) &&
    endpoints.every((ep) => isString(ep, 320)) &&
    isSafeNonNegative(value['pairedAt']) &&
    isSafeNonNegative(value['lastSeenAt']) &&
    isSyncCursor(value['peerCursor']) &&
    (value['lastSyncAt'] === undefined ||
      isSafeNonNegative(value['lastSyncAt'])) &&
    (value['deviceId'] === undefined ||
      (isString(value['deviceId'], 64) &&
        DEVICE_ID_PATTERN.test(value['deviceId']))) &&
    (value['pub'] === undefined || isString(value['pub'], 128)) &&
    (value['pot'] === undefined || isString(value['pot'], 320))
  );
}

/**
 * Load a stored peer row — current tagged shape OR either legacy
 * untagged shape — and normalize to the unified record. Unknown role
 * tags and nonconforming rows both read null so stores fail them the
 * same way they always failed a bad record.
 */
export function readSyncPeerRecord(
  value: unknown,
): SyncPeerRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value['role'] === 'caller') {
    // Tagged rows still fall back to the loose reader — a legacy row
    // normalized+retagged with fields the strict write guard rejects
    // (over-bounds name, unbounded endpoints) must not drop on reload.
    return isSyncCallerPeer(value) ? value : readCallerRow(value);
  }
  if (value['role'] === 'responder') {
    return isSyncPeer(value) ? value : readResponderRow(value);
  }
  if (value['role'] !== undefined) {
    return null;
  }
  // Untagged legacy rows: `id` marks the responder's registry row;
  // everything else tries the dial-book shape.
  return 'id' in value ? readCallerRow(value) : readResponderRow(value);
}

/** readSyncPeerRecord narrowed to the dial-book row. */
export function readSyncPeer(value: unknown): SyncPeer | null {
  const record = readSyncPeerRecord(value);
  return record !== null && record.role === 'responder' ? record : null;
}

/** readSyncPeerRecord narrowed to the registry row. */
export function readSyncCallerPeer(
  value: unknown,
): SyncCallerPeer | null {
  const record = readSyncPeerRecord(value);
  return record !== null && record.role === 'caller' ? record : null;
}
