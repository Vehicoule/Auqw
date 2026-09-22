import {
  hasOnlyKeys,
  isBoolean,
  isBoundedString,
  isFiniteNumber,
  isRecord,
  isSafeNonNegativeInt,
  isStringOrUndefined,
} from './check.ts';
import type { SqlRow, SqlValue } from '@auqw/storage-sqlite';

/**
 * Payload types for every channel in `CHANNELS`. Validators here are the
 * single source of truth: main validates inbound args with them and the
 * preload re-validates every returned payload with them.
 */

export type AppMeta = {
  readonly version: string;
  readonly platform: string;
  readonly userDataPath: string;
};

export function isAppMeta(value: unknown): value is AppMeta {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['version', 'platform', 'userDataPath']) &&
    isBoundedString(value['version'], 128) &&
    isBoundedString(value['platform'], 32) &&
    isBoundedString(value['userDataPath'], 4096)
  );
}

export type NetSnapshot = { readonly online: boolean };
export type NetEvent = { readonly online: boolean };

export function isNetEvent(value: unknown): value is NetEvent {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['online']) &&
    isBoolean(value['online'])
  );
}

export type PickFolderArgs = { readonly title?: string };
export type PickFilesArgs = {
  readonly title?: string;
  readonly multiple?: boolean;
};

export function isPickFolderArgs(
  value: unknown,
): value is PickFolderArgs {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyKeys(value, ['title']) &&
      isStringOrUndefined(value['title']))
  );
}

export function isPickFilesArgs(value: unknown): value is PickFilesArgs {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyKeys(value, ['title', 'multiple']) &&
      isStringOrUndefined(value['title']) &&
      (value['multiple'] === undefined || isBoolean(value['multiple'])))
  );
}

/**
 * Secure-store keys map to one file each under userData — the pattern
 * refuses separators so a key can never walk the directory.
 */
export function isSecureKey(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
  );
}

export type SecureGetArgs = { readonly key: string };
export type SecureSetArgs = { readonly key: string; readonly value: string };
export type SecureDeleteArgs = { readonly key: string };

export function isSecureGetArgs(value: unknown): value is SecureGetArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['key']) &&
    isSecureKey(value['key'])
  );
}

export function isSecureSetArgs(value: unknown): value is SecureSetArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['key', 'value']) &&
    isSecureKey(value['key']) &&
    typeof value['value'] === 'string' &&
    value['value'].length <= 65_536
  );
}

export const isSecureDeleteArgs = isSecureGetArgs;

export function isStringOrNull(
  value: unknown,
): value is string | null {
  return value === null || typeof value === 'string';
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string')
  );
}

export function isUndefinedResult(value: unknown): value is undefined {
  return value === undefined;
}

export type UtilityPingArgs = { readonly message: string };
export type UtilityPingResult = {
  readonly reply: 'pong';
  readonly echo: string;
};

export function isUtilityPingArgs(
  value: unknown,
): value is UtilityPingArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['message']) &&
    isBoundedString(value['message'], 4096)
  );
}

export function isUtilityPingResult(
  value: unknown,
): value is UtilityPingResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['reply', 'echo']) &&
    value['reply'] === 'pong' &&
    isBoundedString(value['echo'], 4096)
  );
}

/* ------------------------------------------------------------------ */
/* Plugin-host status + stream seam payloads                            */
/* ------------------------------------------------------------------ */

/**
 * `host:plugins` — whether the native bindings loaded and which plugin
 * ids are live. `bindings` is a status, not a throw: the utility keeps
 * serving non-stream channels when the `.node` artifact is absent.
 */
export type HostPluginsResult = {
  readonly bindings: 'loaded' | 'unavailable';
  readonly bindingsError?: string;
  readonly plugins: readonly string[];
};

export function isHostPluginsResult(
  value: unknown,
): value is HostPluginsResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['bindings', 'bindingsError', 'plugins']) &&
    (value['bindings'] === 'loaded' || value['bindings'] === 'unavailable') &&
    isStringOrUndefined(value['bindingsError']) &&
    Array.isArray(value['plugins']) &&
    value['plugins'].every((p) => isBoundedString(p, 128))
  );
}

/**
 * A prepared stream handle as the host reports it — mirrors
 * `PreparedStream` in `packages/application` but stays shell-local so
 * the contract never imports app packages.
 */
export type PreparedStreamPayload = {
  readonly handle: string;
  readonly mime: string;
  readonly itag?: number;
  readonly contentLength?: number;
  readonly expiresAtMs?: number;
  readonly bitrateKbps?: number;
};

export function isPreparedStreamPayload(
  value: unknown,
): value is PreparedStreamPayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'handle',
      'mime',
      'itag',
      'contentLength',
      'expiresAtMs',
      'bitrateKbps',
    ]) &&
    isBoundedString(value['handle'], 512) &&
    isBoundedString(value['mime'], 128) &&
    (value['itag'] === undefined ||
      isSafeNonNegativeInt(value['itag'])) &&
    (value['contentLength'] === undefined ||
      isSafeNonNegativeInt(value['contentLength'])) &&
    (value['expiresAtMs'] === undefined ||
      isSafeNonNegativeInt(value['expiresAtMs'])) &&
    (value['bitrateKbps'] === undefined ||
      isSafeNonNegativeInt(value['bitrateKbps']))
  );
}

export type HttpTracePayload = {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly bytes: number;
  readonly elapsedMs: number;
};

function isHttpTracePayload(value: unknown): value is HttpTracePayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['method', 'url', 'status', 'bytes', 'elapsedMs']) &&
    isBoundedString(value['method'], 32) &&
    isBoundedString(value['url'], 2048) &&
    // Signed-url material never crosses: queries and fragments are the
    // host's redaction target, so the boundary enforces the invariant.
    !(value['url'] as string).includes('?') &&
    !(value['url'] as string).includes('#') &&
    (value['status'] === undefined ||
      isSafeNonNegativeInt(value['status'])) &&
    isSafeNonNegativeInt(value['bytes']) &&
    isSafeNonNegativeInt(value['elapsedMs'])
  );
}

export type GuestLogPayload = {
  readonly level: string;
  readonly message: string;
};

function isGuestLogPayload(value: unknown): value is GuestLogPayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['level', 'message']) &&
    isBoundedString(value['level'], 16) &&
    typeof value['message'] === 'string' &&
    value['message'].length <= 4096
  );
}

/** Attempt diagnostics — redacted by the host before crossing. */
export type AttemptSummaryPayload = {
  readonly requestId: string;
  readonly steps: number;
  readonly httpCalls: number;
  readonly bytes: number;
  readonly fuelUsed: number;
  readonly elapsedMs: number;
  readonly httpTrace: readonly HttpTracePayload[];
  readonly guestLog: readonly GuestLogPayload[];
};

function isAttemptSummaryPayload(
  value: unknown,
): value is AttemptSummaryPayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'requestId',
      'steps',
      'httpCalls',
      'bytes',
      'fuelUsed',
      'elapsedMs',
      'httpTrace',
      'guestLog',
    ]) &&
    isBoundedString(value['requestId'], 128) &&
    isSafeNonNegativeInt(value['steps']) &&
    isSafeNonNegativeInt(value['httpCalls']) &&
    isSafeNonNegativeInt(value['bytes']) &&
    isSafeNonNegativeInt(value['fuelUsed']) &&
    isSafeNonNegativeInt(value['elapsedMs']) &&
    // Caps mirror `isAttemptTrace` in packages/application — the
    // boundary must never accept a trace the port would reject on
    // persistence, nor drop one the port considers valid.
    Array.isArray(value['httpTrace']) &&
    value['httpTrace'].length <= 32 &&
    value['httpTrace'].every(isHttpTracePayload) &&
    Array.isArray(value['guestLog']) &&
    value['guestLog'].length <= 128 &&
    value['guestLog'].every(isGuestLogPayload)
  );
}

/**
 * `startPrepare`'s resolved outcome. `prepared` carries the minted
 * stream; `failed`/`superseded` carry the host's typed kind + message.
 */
export type PrepareOutcomePayload = {
  readonly type: 'prepared' | 'failed' | 'superseded';
  readonly stream?: PreparedStreamPayload;
  readonly superseded?: boolean;
  readonly kind?: string;
  readonly message?: string;
  readonly attempt?: AttemptSummaryPayload;
};

export function isPrepareOutcomePayload(
  value: unknown,
): value is PrepareOutcomePayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'type',
      'stream',
      'superseded',
      'kind',
      'message',
      'attempt',
    ]) &&
    (value['type'] === 'prepared' ||
      value['type'] === 'failed' ||
      value['type'] === 'superseded') &&
    (value['stream'] === undefined ||
      isPreparedStreamPayload(value['stream'])) &&
    (value['superseded'] === undefined ||
      isBoolean(value['superseded'])) &&
    isStringOrUndefined(value['kind']) &&
    isStringOrUndefined(value['message']) &&
    (value['attempt'] === undefined ||
      isAttemptSummaryPayload(value['attempt']))
  );
}

export type StreamPrepareArgs = {
  readonly pluginId: string;
  readonly sourceRef: string;
  readonly requestId: string;
};

export function isStreamPrepareArgs(
  value: unknown,
): value is StreamPrepareArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['pluginId', 'sourceRef', 'requestId']) &&
    isBoundedString(value['pluginId'], 128) &&
    isBoundedString(value['sourceRef'], 4096) &&
    isBoundedString(value['requestId'], 128)
  );
}

export type StreamDevPrepareArgs = {
  readonly url: string;
  readonly mime: string;
  readonly contentLength?: number;
  readonly remintable?: boolean;
};

export function isStreamDevPrepareArgs(
  value: unknown,
): value is StreamDevPrepareArgs {
  const url = isRecord(value) ? value['url'] : undefined;
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['url', 'mime', 'contentLength', 'remintable']) &&
    typeof url === 'string' &&
    url.length <= 4096 &&
    (url.startsWith('https://') || url.startsWith('http://')) &&
    isBoundedString(value['mime'], 128) &&
    (value['contentLength'] === undefined ||
      isSafeNonNegativeInt(value['contentLength'])) &&
    (value['remintable'] === undefined || isBoolean(value['remintable']))
  );
}

export type StreamHandleArgs = { readonly handle: string };

export function isStreamHandleArgs(
  value: unknown,
): value is StreamHandleArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['handle']) &&
    isBoundedString(value['handle'], 512)
  );
}

export type StreamOpenArgs = {
  readonly handle: string;
  readonly position: number;
};

export function isStreamOpenArgs(
  value: unknown,
): value is StreamOpenArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['handle', 'position']) &&
    isBoundedString(value['handle'], 512) &&
    isSafeNonNegativeInt(value['position'])
  );
}

/** `stream:open` result — `null` remaining = unknown total. */
export type StreamOpenResult = { readonly remaining: number | null };

export function isStreamOpenResult(
  value: unknown,
): value is StreamOpenResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['remaining']) &&
    (value['remaining'] === null ||
      isSafeNonNegativeInt(value['remaining']))
  );
}

export type StreamReadArgs = {
  readonly handle: string;
  readonly position: number;
  readonly maxLen: number;
};

const MAX_READ_LEN = 1024 * 1024;

export function isStreamReadArgs(
  value: unknown,
): value is StreamReadArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['handle', 'position', 'maxLen']) &&
    isBoundedString(value['handle'], 512) &&
    isSafeNonNegativeInt(value['position']) &&
    isSafeNonNegativeInt(value['maxLen']) &&
    (value['maxLen'] as number) > 0 &&
    (value['maxLen'] as number) <= MAX_READ_LEN
  );
}

/** `stream:read` result — raw bytes ride base64; empty = EOF. */
export type StreamReadResult = { readonly data: string };

export function isStreamReadResult(
  value: unknown,
): value is StreamReadResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['data']) &&
    typeof value['data'] === 'string' &&
    value['data'].length <= MAX_READ_LEN * 2
  );
}

export type StreamServeUrlResult = { readonly url: string };

export function isStreamServeUrlResult(
  value: unknown,
): value is StreamServeUrlResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['url']) &&
    isBoundedString(value['url'], 2048) &&
    value['url'].startsWith('http://127.0.0.1:')
  );
}

/** `stream:marks` — lifecycle phase marks, all optional ms values. */
export type StreamMarksResult = {
  readonly prepareStartedMs?: number;
  readonly resolveMs?: number;
  readonly mintMs?: number;
  readonly firstByteMs?: number;
  readonly headReadyMs?: number;
  readonly attachMs?: number;
};

export function isStreamMarksResult(
  value: unknown,
): value is StreamMarksResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'prepareStartedMs',
      'resolveMs',
      'mintMs',
      'firstByteMs',
      'headReadyMs',
      'attachMs',
    ]) &&
    (value['prepareStartedMs'] === undefined ||
      isSafeNonNegativeInt(value['prepareStartedMs'])) &&
    (value['resolveMs'] === undefined ||
      isSafeNonNegativeInt(value['resolveMs'])) &&
    (value['mintMs'] === undefined ||
      isSafeNonNegativeInt(value['mintMs'])) &&
    (value['firstByteMs'] === undefined ||
      isSafeNonNegativeInt(value['firstByteMs'])) &&
    (value['headReadyMs'] === undefined ||
      isSafeNonNegativeInt(value['headReadyMs'])) &&
    (value['attachMs'] === undefined ||
      isSafeNonNegativeInt(value['attachMs']))
  );
}

export type StreamCancelArgs = { readonly requestId: string };

export function isStreamCancelArgs(
  value: unknown,
): value is StreamCancelArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['requestId']) &&
    isBoundedString(value['requestId'], 128)
  );
}

/**
 * `stream:port` — asks main to broker a MessageChannel to the utility
 * process's byte pump for `handle`. The port itself arrives on the
 * `stream-bytes` event keyed by `requestId`; the invoke resolves once
 * main has posted both ends (or rejects typed).
 */
export type StreamPortArgs = {
  readonly handle: string;
  readonly requestId: string;
};

export function isStreamPortArgs(
  value: unknown,
): value is StreamPortArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['handle', 'requestId']) &&
    isBoundedString(value['handle'], 512) &&
    isBoundedString(value['requestId'], 128)
  );
}

/**
 * The pump-port facade the preload hands the renderer — the real
 * MessagePort stays inside the isolated world; only wrapped
 * send/receive callbacks cross the contextBridge. `send` takes a
 * client protocol frame (see `shared/pump-protocol.ts`); `onMessage`
 * delivers pump frames.
 */
export type StreamPortLike = {
  readonly send: (message: unknown) => void;
  readonly onMessage: (listener: (message: unknown) => void) => () => void;
  readonly close: () => void;
};

export type UndefinedArgs = undefined;

/**
 * The storage channels forward to the utility process: `begin` pins a
 * transaction id there and every statement runs against it, because a
 * driver's `transaction(work)` callback cannot cross a process
 * boundary. Params and row values are `SqlValue` (string/number/null)
 * only — bigint, blob, and boolean have no wire representation.
 */
export type StorageBeginResult = { readonly txId: string };

export function isStorageBeginResult(
  value: unknown,
): value is StorageBeginResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['txId']) &&
    isBoundedString(value['txId'], 64)
  );
}

export function isStorageBeginArgs(
  value: unknown,
): value is undefined {
  return value === undefined;
}

export type StorageTxArgs = { readonly txId: string };

export function isStorageTxArgs(
  value: unknown,
): value is StorageTxArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['txId']) &&
    isBoundedString(value['txId'], 64)
  );
}

function isSqlValue(value: unknown): value is SqlValue {
  return (
    value === null ||
    (typeof value === 'string' && value.length <= 1_048_576) ||
    isFiniteNumber(value)
  );
}

function isSqlParams(value: unknown): value is readonly SqlValue[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every(isSqlValue)
  );
}

function isSqlRowValue(value: unknown): value is SqlRow {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 256 &&
    Object.keys(value).every((key) => isBoundedString(key, 128)) &&
    Object.values(value).every(isSqlValue)
  );
}

export type StorageExecuteArgs = {
  readonly txId: string;
  readonly sql: string;
  readonly params: readonly SqlValue[];
};
export type StorageQueryArgs = StorageExecuteArgs;

export function isStorageExecuteArgs(
  value: unknown,
): value is StorageExecuteArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['txId', 'sql', 'params']) &&
    isBoundedString(value['txId'], 64) &&
    isBoundedString(value['sql'], 65_536) &&
    isSqlParams(value['params'])
  );
}

export const isStorageQueryArgs = isStorageExecuteArgs;

export type StorageExecuteResult = {
  readonly changes: number;
  readonly lastInsertRowId: number | null;
};

export function isStorageExecuteResult(
  value: unknown,
): value is StorageExecuteResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['changes', 'lastInsertRowId']) &&
    isSafeNonNegativeInt(value['changes']) &&
    (value['lastInsertRowId'] === null ||
      (isFiniteNumber(value['lastInsertRowId']) &&
        Number.isSafeInteger(value['lastInsertRowId'])))
  );
}

export type StorageQueryResult = { readonly rows: readonly SqlRow[] };

export function isStorageQueryResult(
  value: unknown,
): value is StorageQueryResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['rows']) &&
    Array.isArray(value['rows']) &&
    value['rows'].length <= 1_000_000 &&
    value['rows'].every(isSqlRowValue)
  );
}

export type StorageBackupArgs = { readonly tag: string };

export function isStorageBackupArgs(
  value: unknown,
): value is StorageBackupArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['tag']) &&
    typeof value['tag'] === 'string' &&
    /^[a-z0-9-]{1,64}$/i.test(value['tag'])
  );
}

/**
 * The storage bridge the renderer's `SqliteDriver` drives — one method
 * per `storage:*` channel, same envelope unwrapping as the rest of the
 * facade.
 */
export type AuqwStorage = {
  readonly begin: () => Promise<StorageBeginResult>;
  readonly commit: (txId: string) => Promise<void>;
  readonly rollback: (txId: string) => Promise<void>;
  readonly cancel: (txId: string) => Promise<void>;
  readonly execute: (
    txId: string,
    sql: string,
    params?: readonly SqlValue[],
  ) => Promise<StorageExecuteResult>;
  readonly query: (
    txId: string,
    sql: string,
    params?: readonly SqlValue[],
  ) => Promise<StorageQueryResult>;
  readonly backup: (tag: string) => Promise<void>;
  readonly dropBackup: (tag: string) => Promise<void>;
};

/* ------------------------------------------------------------------ */
/* Sync — LAN transport, pairing, device registry, delta seam.         */
/* ------------------------------------------------------------------ */

/** Cap on an opaque delta document — sync payloads must not balloon IPC. */
export const MAX_SYNC_DOC_BYTES = 1_048_576;

export type SyncListenerState =
  | 'starting'
  | 'listening'
  | 'unavailable'
  | 'disabled';

export type SyncStatusResult = {
  readonly listener: SyncListenerState;
  /** `ip:port` to feed a pairing payload, or null when nothing is up. */
  readonly endpoint: string | null;
  readonly boundPort: number | null;
  readonly advertise: 'off' | 'announcing' | 'unavailable';
  readonly pairedDevices: number;
  readonly sessions: number;
  readonly lastSyncAt: number | null;
  readonly engine: 'ready' | 'absent';
  readonly name: string;
  readonly fingerprint: string | null;
};

export function isSyncStatusResult(
  value: unknown,
): value is SyncStatusResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'listener',
      'endpoint',
      'boundPort',
      'advertise',
      'pairedDevices',
      'sessions',
      'lastSyncAt',
      'engine',
      'name',
      'fingerprint',
    ]) &&
    (value['listener'] === 'starting' ||
      value['listener'] === 'listening' ||
      value['listener'] === 'unavailable' ||
      value['listener'] === 'disabled') &&
    (value['endpoint'] === null ||
      isBoundedString(value['endpoint'], 128)) &&
    (value['boundPort'] === null ||
      isSafeNonNegativeInt(value['boundPort'])) &&
    (value['advertise'] === 'off' ||
      value['advertise'] === 'announcing' ||
      value['advertise'] === 'unavailable') &&
    isSafeNonNegativeInt(value['pairedDevices']) &&
    isSafeNonNegativeInt(value['sessions']) &&
    (value['lastSyncAt'] === null ||
      isFiniteNumber(value['lastSyncAt'])) &&
    (value['engine'] === 'ready' || value['engine'] === 'absent') &&
    isBoundedString(value['name'], 128) &&
    (value['fingerprint'] === null ||
      isBoundedString(value['fingerprint'], 128))
  );
}

export type SyncPairingResult = {
  /** QR-payload text: JSON {v, endpoint, code, fp}. */
  readonly payload: string;
  /** The 6-digit typed path — same session as the QR payload. */
  readonly code: string;
  readonly expiresAt: number;
};

export function isSyncPairingResult(
  value: unknown,
): value is SyncPairingResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['payload', 'code', 'expiresAt']) &&
    isBoundedString(value['payload'], 1_024) &&
    typeof value['code'] === 'string' &&
    /^[0-9]{6}$/.test(value['code']) &&
    isFiniteNumber(value['expiresAt'])
  );
}

export type SyncDeviceInfo = {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
};

function isSyncDeviceInfo(value: unknown): value is SyncDeviceInfo {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'name', 'pairedAt', 'lastSeenAt']) &&
    isBoundedString(value['id'], 64) &&
    isBoundedString(value['name'], 128) &&
    isFiniteNumber(value['pairedAt']) &&
    isFiniteNumber(value['lastSeenAt'])
  );
}

export type SyncDevicesResult = {
  readonly devices: readonly SyncDeviceInfo[];
};

export function isSyncDevicesResult(
  value: unknown,
): value is SyncDevicesResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['devices']) &&
    Array.isArray(value['devices']) &&
    value['devices'].length <= 64 &&
    value['devices'].every(isSyncDeviceInfo)
  );
}

export type SyncUnpairArgs = { readonly id: string };

export function isSyncUnpairArgs(
  value: unknown,
): value is SyncUnpairArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id']) &&
    isBoundedString(value['id'], 64)
  );
}

/** Opaque delta document: any JSON structure that stays inside the cap. */
export function isSyncDeltaDoc(value: unknown): boolean {
  if (!(isRecord(value) || Array.isArray(value))) {
    return false;
  }
  try {
    const encoded = JSON.stringify(value);
    return (
      typeof encoded === 'string' &&
      encoded.length <= MAX_SYNC_DOC_BYTES
    );
  } catch {
    return false;
  }
}

export type SyncDeltasArgs = { readonly since: string };

export function isSyncDeltasArgs(
  value: unknown,
): value is SyncDeltasArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['since']) &&
    // '' is a legal cursor — the engine reads it as "full snapshot".
    typeof value['since'] === 'string' &&
    value['since'].length <= 256
  );
}

export type SyncDeltasResult = { readonly delta: unknown };

export function isSyncDeltasResult(
  value: unknown,
): value is SyncDeltasResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['delta']) &&
    isSyncDeltaDoc(value['delta'])
  );
}

export type SyncImportDeltaArgs = {
  readonly delta: unknown;
  readonly deviceId?: string;
};

export function isSyncImportDeltaArgs(
  value: unknown,
): value is SyncImportDeltaArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['delta', 'deviceId']) &&
    isSyncDeltaDoc(value['delta']) &&
    (value['deviceId'] === undefined ||
      isBoundedString(value['deviceId'], 64))
  );
}

export type SyncImportDeltaResult = { readonly result: unknown };

export function isSyncImportDeltaResult(
  value: unknown,
): value is SyncImportDeltaResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['result']) &&
    isSyncDeltaDoc(value['result'])
  );
}

export type SyncTriggerResult = {
  readonly triggered: boolean;
  readonly pending: boolean;
};

export function isSyncTriggerResult(
  value: unknown,
): value is SyncTriggerResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['triggered', 'pending']) &&
    isBoolean(value['triggered']) &&
    isBoolean(value['pending'])
  );
}

/**
 * The renderer's `api.sync.*` — one method per `sync:*` channel; the
 * utility's sync service answers them all and works plugin-free.
 */
export type AuqwSync = {
  readonly status: () => Promise<SyncStatusResult>;
  readonly pairing: () => Promise<SyncPairingResult>;
  readonly devices: () => Promise<SyncDevicesResult>;
  readonly unpair: (args: SyncUnpairArgs) => Promise<void>;
  readonly deltas: (args: SyncDeltasArgs) => Promise<SyncDeltasResult>;
  readonly importDelta: (
    args: SyncImportDeltaArgs,
  ) => Promise<SyncImportDeltaResult>;
  readonly trigger: () => Promise<SyncTriggerResult>;
};

/**
 * The `window.auqw` surface the preload exposes. Every method resolves
 * with a validated payload and rejects with a `ShellError`-shaped value.
 */
export type AuqwApi = {
  readonly app: {
    readonly meta: () => Promise<AppMeta>;
  };
  readonly dialog: {
    readonly pickFolder: (
      title?: string,
    ) => Promise<string | null>;
    readonly pickFiles: (
      title?: string,
      multiple?: boolean,
    ) => Promise<readonly string[]>;
  };
  readonly net: {
    readonly snapshot: () => Promise<NetSnapshot>;
    readonly subscribe: (listener: (event: NetEvent) => void) => () => void;
  };
  readonly secure: {
    readonly get: (key: string) => Promise<string | null>;
    readonly set: (key: string, value: string) => Promise<void>;
    readonly delete: (key: string) => Promise<void>;
  };
  readonly storage: AuqwStorage;
  readonly sync: AuqwSync;
  readonly utility: {
    readonly ping: (message: string) => Promise<UtilityPingResult>;
  };
  readonly host: {
    readonly plugins: () => Promise<HostPluginsResult>;
  };
  readonly stream: {
    readonly prepare: (
      args: StreamPrepareArgs,
    ) => Promise<PrepareOutcomePayload>;
    readonly devPrepare: (
      args: StreamDevPrepareArgs,
    ) => Promise<PreparedStreamPayload>;
    readonly serveUrl: (
      args: StreamHandleArgs,
    ) => Promise<StreamServeUrlResult>;
    readonly open: (args: StreamOpenArgs) => Promise<StreamOpenResult>;
    readonly read: (args: StreamReadArgs) => Promise<StreamReadResult>;
    readonly close: (args: StreamHandleArgs) => Promise<void>;
    readonly release: (args: StreamHandleArgs) => Promise<void>;
    readonly marks: (args: StreamHandleArgs) => Promise<StreamMarksResult>;
    readonly cancel: (args: StreamCancelArgs) => Promise<void>;
    readonly channel: (args: StreamHandleArgs) => Promise<StreamPortLike>;
  };
};

declare global {
  interface Window {
    auqw: AuqwApi;
  }
}
