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
 * `manifests` carries each loaded plugin's declared provider id +
 * capability names verbatim — the renderer-side provider adapter
 * re-validates them against the ABI capability set.
 */
export type PluginManifestPayload = {
  readonly pluginId: string;
  readonly providerId: string;
  readonly capabilities: readonly string[];
};

export function isPluginManifestPayload(
  value: unknown,
): value is PluginManifestPayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['pluginId', 'providerId', 'capabilities']) &&
    isBoundedString(value['pluginId'], 128) &&
    isBoundedString(value['providerId'], 128) &&
    Array.isArray(value['capabilities']) &&
    value['capabilities'].every((c) => isBoundedString(c, 64))
  );
}

export type HostPluginsResult = {
  readonly bindings: 'loaded' | 'unavailable';
  readonly bindingsError?: string;
  readonly plugins: readonly string[];
  readonly manifests: readonly PluginManifestPayload[];
};

export function isHostPluginsResult(
  value: unknown,
): value is HostPluginsResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['bindings', 'bindingsError', 'plugins', 'manifests']) &&
    (value['bindings'] === 'loaded' || value['bindings'] === 'unavailable') &&
    isStringOrUndefined(value['bindingsError']) &&
    Array.isArray(value['plugins']) &&
    value['plugins'].every((p) => isBoundedString(p, 128)) &&
    Array.isArray(value['manifests']) &&
    value['manifests'].every(isPluginManifestPayload)
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
/**
 * `startRequest`'s terminal outcome — `succeeded` carries the raw
 * `done.result` JSON for the renderer adapter to decode, `failed`
 * the host's typed kind + message.
 */
export type RequestOutcomePayload = {
  readonly type: 'succeeded' | 'failed';
  readonly resultJson?: string;
  readonly kind?: string;
  readonly message?: string;
  readonly attempt: AttemptSummaryPayload;
};

export function isRequestOutcomePayload(
  value: unknown,
): value is RequestOutcomePayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'type',
      'resultJson',
      'kind',
      'message',
      'attempt',
    ]) &&
    (value['type'] === 'succeeded' || value['type'] === 'failed') &&
    (value['resultJson'] === undefined ||
      (typeof value['resultJson'] === 'string' &&
        value['resultJson'].length <= 1_048_576)) &&
    isStringOrUndefined(value['kind']) &&
    isStringOrUndefined(value['message']) &&
    isAttemptSummaryPayload(value['attempt'])
  );
}

export type PrepareOutcomePayload = {
  readonly type: 'prepared' | 'failed' | 'superseded';
  readonly stream?: PreparedStreamPayload;
  // Session handles this prepare superseded or pruned (napi
  // `PrepareOutcome.superseded: Vec<String>`) — handle routing drops
  // them so a dead session can never serve a later attach.
  readonly superseded?: readonly string[];
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
    // No length cap: the registry prunes unbounded terminal sets, and
    // rejecting post-registration would strand the minted handle.
    (value['superseded'] === undefined ||
      (Array.isArray(value['superseded']) &&
        value['superseded'].every((h) => isBoundedString(h, 256)))) &&
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
 * `host:request` — any declared capability with a JSON object payload,
 * mirroring the napi `startRequest` signature. The renderer mints the
 * requestId so its cancel path can reach the host before the promise
 * resolves.
 */
export type HostRequestArgs = {
  readonly pluginId: string;
  readonly capability: string;
  readonly payloadJson: string;
  readonly requestId: string;
};

export function isHostRequestArgs(
  value: unknown,
): value is HostRequestArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'pluginId',
      'capability',
      'payloadJson',
      'requestId',
    ]) &&
    isBoundedString(value['pluginId'], 128) &&
    isBoundedString(value['capability'], 64) &&
    typeof value['payloadJson'] === 'string' &&
    value['payloadJson'].length <= 65_536 &&
    isBoundedString(value['requestId'], 128)
  );
}

/** `host:cancel` — same requestId-scoped abort as `stream:cancel`. */
export type HostCancelArgs = { readonly requestId: string };

export function isHostCancelArgs(
  value: unknown,
): value is HostCancelArgs {
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
  /** QR-payload text: JSON {v, endpoint, endpoints, code, fp}. */
  readonly payload: string;
  /** The 6-digit typed path — same session as the QR payload. */
  readonly code: string;
  /** Primary `ip:port` for the typed path — shown next to the code. */
  readonly endpoint: string;
  readonly expiresAt: number;
};

export function isSyncPairingResult(
  value: unknown,
): value is SyncPairingResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['payload', 'code', 'endpoint', 'expiresAt']) &&
    isBoundedString(value['payload'], 1_024) &&
    typeof value['code'] === 'string' &&
    /^[0-9]{6}$/.test(value['code']) &&
    isBoundedString(value['endpoint'], 64) &&
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

/**
 * The strict JSON domain — values that survive a serialize/parse round
 * trip unchanged. Electron IPC preserves `undefined` properties, sparse
 * array slots, `NaN`, and ±Infinity that `JSON.stringify` silently
 * rewrites or drops; accepting them here would validate one document
 * while the sync engine receives a different one.
 */
const MAX_JSON_DEPTH = 64;

/**
 * A getter answers per-read — validation and serialization would
 * observe different documents (a value accepted now can vanish or
 * change on the wire). Only own enumerable DATA properties are stable
 * enough to validate and then send. `toJSON` is the exception that
 * escapes an enumerable-only scan: JSON.stringify invokes it whatever
 * its enumerability, so a hidden hook would serialize a document
 * validation never saw — reject a `toJSON` getter or function value.
 */
function hasNoEnumerableGetter(value: object): boolean {
  // `toJSON` is honored wherever it sits on the prototype chain —
  // Object.prototype/Array.prototype are the allowed protos, and a
  // hook placed there rewrites the wire doc just like an own prop.
  // The FIRST descriptor wins the stringify lookup: an inert
  // non-function value shadows anything deeper and stays legal.
  // The walk is cycle-marked and bounded — a proxy answering
  // getPrototypeOf with itself or a fresh proxy would otherwise loop
  // forever, and this cap is not covered by the value-depth bound.
  const seen = new WeakSet<object>();
  const MAX_PROTO_DEPTH = 16;
  for (
    let level: object | null = value, depth = 0;
    level !== null;
    level = Object.getPrototypeOf(level), depth += 1
  ) {
    if (depth > MAX_PROTO_DEPTH || seen.has(level)) {
      return false;
    }
    seen.add(level);
    const hook = Object.getOwnPropertyDescriptor(level, 'toJSON');
    if (hook === undefined) {
      continue;
    }
    if (
      hook.get !== undefined ||
      ('value' in hook && typeof hook.value === 'function')
    ) {
      return false;
    }
    break;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every(
    (desc) => desc.enumerable !== true || desc.get === undefined,
  );
}

function isJsonValueInner(
  value: unknown,
  active: WeakSet<object>,
  depth: number,
): boolean {
  if (value === null || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'string') {
    return true;
  }
  if (depth > MAX_JSON_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    // `length` counts holes; keys enumerate real slots — a sparse
    // array serializes to nulls it doesn't actually contain.
    if (
      Object.keys(value).length !== value.length ||
      active.has(value) ||
      !hasNoEnumerableGetter(value)
    ) {
      return false;
    }
    active.add(value);
    try {
      return value.every((entry) =>
        isJsonValueInner(entry, active, depth + 1),
      );
    } finally {
      active.delete(value);
    }
  }
  if (isRecord(value)) {
    // Only plain objects — a Date, Map, or class instance carries no
    // own enumerable slots yet serializes to a different domain (a
    // Date becomes a string, a Map becomes {}).
    const proto: unknown = Object.getPrototypeOf(value);
    if (
      (proto !== Object.prototype && proto !== null) ||
      active.has(value) ||
      !hasNoEnumerableGetter(value)
    ) {
      return false;
    }
    active.add(value);
    try {
      return Object.values(value).every((entry) =>
        isJsonValueInner(entry, active, depth + 1),
      );
    } finally {
      active.delete(value);
    }
  }
  return false;
}

export function isJsonValue(value: unknown): boolean {
  // `active` marks the CURRENT path only — deleted on unwind — so a
  // diamond of shared references still passes while a true cycle
  // returns false instead of overflowing the stack. The depth cap
  // bounds the recursion a hostile object graph can provoke.
  return isJsonValueInner(value, new WeakSet<object>(), 0);
}

/**
 * A JSON value whose serialized UTF-8 form fits `maxBytes`. The cap is
 * BYTES on the wire — `encoded.length` counts UTF-16 code units, so
 * non-ASCII payloads are measured with TextEncoder.
 */
function isBoundedJson(value: unknown, maxBytes: number): boolean {
  // The whole validation sits inside the exception boundary — a
  // malformed graph (proxy, throwing accessor) answers false, never
  // an internal throw that lands as the wrong error kind.
  try {
    if (!isJsonValue(value)) {
      return false;
    }
    const encoded = JSON.stringify(value);
    return (
      typeof encoded === 'string' &&
      new TextEncoder().encode(encoded).length <= maxBytes
    );
  } catch {
    return false;
  }
}

/**
 * Opaque delta document: a JSON object or array that stays inside the
 * cap — deltas are documents, not bare primitives.
 */
export function isSyncDeltaDoc(value: unknown): boolean {
  return (
    (isRecord(value) || Array.isArray(value)) &&
    isBoundedJson(value, MAX_SYNC_DOC_BYTES)
  );
}

export type SyncDeltasArgs = { readonly since: string };

/**
 * The serialized-cursor bound: `since` is `JSON.stringify(SyncCursor)`
 * — a map of up to 512 device ids (each ≤128 chars) to sequences.
 * Worst case is 512 entries × ~150 JSON chars ≈ 77 KB; round to
 * 80 000 so a full cursor always fits.
 */
export const MAX_SYNC_CURSOR_CHARS = 80_000;

export function isSyncDeltasArgs(
  value: unknown,
): value is SyncDeltasArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['since']) &&
    // '' is a legal cursor — the engine reads it as "full snapshot".
    typeof value['since'] === 'string' &&
    value['since'].length <= MAX_SYNC_CURSOR_CHARS
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
    // The engine's apply receipt is `unknown` — any bounded JSON value
    // (including `null`) is a valid result, not just full documents.
    isBoundedJson(value['result'], MAX_SYNC_DOC_BYTES)
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
 * `sync:localChanges` — domain edits the renderer already committed,
 * pushed to the engine so it can stamp them into the change log. The
 * doc mirrors the engine's `LocalWrite` shape with `kind` left a
 * string: the whitelist check is the engine's own `validLocalWrite`,
 * which runs per write before stamping — the boundary only owes the
 * bounded-shape check below.
 */
export const MAX_SYNC_LOCAL_WRITES = 256;
export const MAX_SYNC_FIELD_BYTES = 65_536;

export type SyncLocalWriteDoc =
  | {
      readonly kind: string;
      readonly recordId: string;
      readonly field: string;
      readonly value: unknown;
    }
  | {
      readonly kind: string;
      readonly recordId: string;
      readonly tombstone: true;
    };

export function isSyncLocalWriteDoc(
  value: unknown,
): value is SyncLocalWriteDoc {
  if (
    !isRecord(value) ||
    !isBoundedString(value['kind'], 64) ||
    !isBoundedString(value['recordId'], 1024)
  ) {
    return false;
  }
  if (hasOnlyKeys(value, ['kind', 'recordId', 'tombstone'])) {
    return value['tombstone'] === true;
  }
  return (
    hasOnlyKeys(value, ['kind', 'recordId', 'field', 'value']) &&
    isBoundedString(value['field'], 64) &&
    isBoundedJson(value['value'], MAX_SYNC_FIELD_BYTES)
  );
}

export type SyncLocalChangesArgs = {
  readonly writes: readonly SyncLocalWriteDoc[];
};

export function isSyncLocalChangesArgs(
  value: unknown,
): value is SyncLocalChangesArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['writes']) &&
    Array.isArray(value['writes']) &&
    value['writes'].length > 0 &&
    value['writes'].length <= MAX_SYNC_LOCAL_WRITES &&
    value['writes'].every(isSyncLocalWriteDoc)
  );
}

/**
 * The result is a small acknowledgement, not the per-write outcome
 * list: callers only consume ok/err, and a results array of the same
 * writes would re-serialize every committed value — a batch that
 * passes field bounds could then exceed the doc cap and report a
 * transport failure AFTER the engine already appended (Review #46
 * round-9). `accepted` counts the stamped batch.
 */
export type SyncLocalChangesResult = { readonly accepted: number };

export function isSyncLocalChangesResult(
  value: unknown,
): value is SyncLocalChangesResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['accepted']) &&
    typeof value['accepted'] === 'number' &&
    Number.isSafeInteger(value['accepted']) &&
    value['accepted'] >= 0
  );
}

/**
 * `sync:applied` — the utility→main→renderer push that remote-applied
 * merge outcomes are waiting in the drain outbox. The renderer still
 * pulls `sync:drainApplied`; the event only says how deep the queue is.
 */
export type SyncAppliedEvent = { readonly pending: number };

export function isSyncAppliedEvent(
  value: unknown,
): value is SyncAppliedEvent {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['pending']) &&
    isSafeNonNegativeInt(value['pending']) &&
    value['pending'] <= 1_000_000
  );
}

/**
 * `sync:drainApplied` — one byte-bounded pull off the applied-outcome
 * outbox. `outcomes` carries merge outcomes verbatim (the projection
 * validates entry shapes itself); `dropped` reports outbox overflow
 * since the previous drain; `remaining` drives the drain loop.
 */
export type SyncDrainAppliedResult = {
  readonly outcomes: readonly unknown[];
  readonly dropped: boolean;
  readonly remaining: number;
};

export function isSyncDrainAppliedResult(
  value: unknown,
): value is SyncDrainAppliedResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['outcomes', 'dropped', 'remaining']) &&
    Array.isArray(value['outcomes']) &&
    value['outcomes'].every(isJsonValue) &&
    isBoundedJson(value['outcomes'], MAX_SYNC_DOC_BYTES) &&
    isBoolean(value['dropped']) &&
    isSafeNonNegativeInt(value['remaining']) &&
    value['remaining'] <= 1_000_000
  );
}

/**
 * `sync:materialized` — paged pull of the engine's materialized
 * record view. `records` are opaque `{kind, recordId, fields}`
 * JSON — the session validates each via `isMaterializedRecord`;
 * `nextOffset` continues the pull, `null` ends it.
 */
export type SyncMaterializedArgs = {
  readonly offset: number;
};

export function isSyncMaterializedArgs(
  value: unknown,
): value is SyncMaterializedArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['offset']) &&
    isSafeNonNegativeInt(value['offset']) &&
    value['offset'] <= 1_000_000
  );
}

export type SyncMaterializedResult = {
  readonly records: readonly unknown[];
  readonly nextOffset: number | null;
};

export function isSyncMaterializedResult(
  value: unknown,
): value is SyncMaterializedResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['records', 'nextOffset']) &&
    Array.isArray(value['records']) &&
    value['records'].every(isJsonValue) &&
    isBoundedJson(value['records'], MAX_SYNC_DOC_BYTES) &&
    (value['nextOffset'] === null ||
      isSafeNonNegativeInt(value['nextOffset']))
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
  /**
   * Commit-then-log: the engine stamps renderer-side domain edits so
   * later deltas carry them. Call-site wiring lands with the sync
   * emission leg — the channel + engine path exist now.
   */
  readonly localChanges: (
    args: SyncLocalChangesArgs,
  ) => Promise<SyncLocalChangesResult>;
  /**
   * Pull side of the applied-outcome seam: returns one bounded chunk;
   * call until `remaining` is 0 (the `onApplied` push prompts it).
   * The pull is a PEEK — the durable copy leaves only via ackApplied
   * after the renderer's domain commit lands.
   */
  readonly drainApplied: () => Promise<SyncDrainAppliedResult>;
  /** Consume the outcomes the last drain served — post-commit ack. */
  readonly ackApplied: () => Promise<void>;
  /**
   * Durable recovery: paged pull of the engine's materialized record
   * view for sessions that lost outcome streams (drained-then-crashed,
   * evicted from a bound). Loop until `nextOffset` is null.
   */
  readonly materialized: (
    args: SyncMaterializedArgs,
  ) => Promise<SyncMaterializedResult>;
  /**
   * Push side — the utility posts `sync:applied` through main after
   * every applyDelta; subscribing also warrants a first manual drain
   * (outbox contents can predate the subscriber).
   */
  readonly onApplied: (
    listener: (event: SyncAppliedEvent) => void,
  ) => () => void;
};

/* ------------------------------------------------------------------ */
/* Transfer file-plane + local index + tag-read payloads                */
/* ------------------------------------------------------------------ */

/**
 * `transfer:*` — the `MediaTransferPort` file plane. A `begin` mints a
 * sink id in the utility; writes are raw bytes riding base64; `commit`
 * returns the durable byte offset (the resume point); `finalize`
 * verifies an optional sha256 digest then atomically renames
 * `name.part` over `name`. Destination names stay bare — the managed
 * dir under userData is the only writable surface.
 */
export const MAX_TRANSFER_NAME = 512;
// 4MiB decoded → ceil(4194304/3)*4 = 5,592,408 base64 chars.
export const MAX_TRANSFER_WRITE_BASE64 = 5_592_408;
export const MAX_SWEEP_KEEP = 65_536;
export const MAX_LIST_ENTRIES = 65_536;

export type TransferBeginArgs = {
  readonly destPath: string;
  readonly resumeAtBytes: number;
};

export function isTransferBeginArgs(
  value: unknown,
): value is TransferBeginArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['destPath', 'resumeAtBytes']) &&
    isBoundedString(value['destPath'], MAX_TRANSFER_NAME) &&
    isSafeNonNegativeInt(value['resumeAtBytes'])
  );
}

export type TransferBeginResult = { readonly sinkId: string };
export type TransferSinkArgs = { readonly sinkId: string };

export function isSinkId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

export function isTransferBeginResult(
  value: unknown,
): value is TransferBeginResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sinkId']) &&
    isSinkId(value['sinkId'])
  );
}

export function isTransferSinkArgs(
  value: unknown,
): value is TransferSinkArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sinkId']) &&
    isSinkId(value['sinkId'])
  );
}

export type TransferWriteArgs = {
  readonly sinkId: string;
  readonly data: string;
};

export function isTransferWriteArgs(
  value: unknown,
): value is TransferWriteArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sinkId', 'data']) &&
    isSinkId(value['sinkId']) &&
    typeof value['data'] === 'string' &&
    value['data'].length <= MAX_TRANSFER_WRITE_BASE64
  );
}

export type TransferCommitResult = { readonly offset: number };

export function isTransferCommitResult(
  value: unknown,
): value is TransferCommitResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['offset']) &&
    isSafeNonNegativeInt(value['offset'])
  );
}

export type TransferFinalizeArgs = {
  readonly sinkId: string;
  readonly expected: string | null;
};

export function isTransferFinalizeArgs(
  value: unknown,
): value is TransferFinalizeArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sinkId', 'expected']) &&
    isSinkId(value['sinkId']) &&
    (value['expected'] === null ||
      (typeof value['expected'] === 'string' &&
        /^[0-9a-f]{64}$/.test(value['expected'])))
  );
}

export type TransferFinalizeResult = { readonly digest: string };

export function isTransferFinalizeResult(
  value: unknown,
): value is TransferFinalizeResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['digest']) &&
    typeof value['digest'] === 'string' &&
    /^[0-9a-f]{64}$/.test(value['digest'])
  );
}

export type TransferAbortArgs = {
  readonly sinkId: string;
  readonly keep: boolean;
};

export function isTransferAbortArgs(
  value: unknown,
): value is TransferAbortArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sinkId', 'keep']) &&
    isSinkId(value['sinkId']) &&
    isBoolean(value['keep'])
  );
}

export type TransferNameArgs = { readonly name: string };

export function isTransferNameArgs(
  value: unknown,
): value is TransferNameArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['name']) &&
    isBoundedString(value['name'], MAX_TRANSFER_NAME)
  );
}

export type TransferStatResult = {
  readonly exists: boolean;
  readonly bytes: number | null;
};

export function isTransferStatResult(
  value: unknown,
): value is TransferStatResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['exists', 'bytes']) &&
    isBoolean(value['exists']) &&
    (value['bytes'] === null || isSafeNonNegativeInt(value['bytes']))
  );
}

export type TransferSweepArgs = { readonly keepPaths: readonly string[] };

export function isTransferSweepArgs(
  value: unknown,
): value is TransferSweepArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['keepPaths']) &&
    Array.isArray(value['keepPaths']) &&
    value['keepPaths'].length <= MAX_SWEEP_KEEP &&
    value['keepPaths'].every((name) =>
      isBoundedString(name, MAX_TRANSFER_NAME),
    )
  );
}

export type TransferSweepResult = { readonly swept: number };

export function isTransferSweepResult(
  value: unknown,
): value is TransferSweepResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['swept']) &&
    isSafeNonNegativeInt(value['swept'])
  );
}

export type TransferSinkInfo = {
  readonly sinkId: string;
  readonly destPath: string;
  readonly committedBytes: number;
  readonly openedMs: number;
};

export function isTransferSinkInfo(
  value: unknown,
): value is TransferSinkInfo {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sinkId', 'destPath', 'committedBytes', 'openedMs']) &&
    isSinkId(value['sinkId']) &&
    isBoundedString(value['destPath'], MAX_TRANSFER_NAME) &&
    isSafeNonNegativeInt(value['committedBytes']) &&
    isSafeNonNegativeInt(value['openedMs'])
  );
}

export type TransferFileInfo = { readonly name: string; readonly bytes: number };

export function isTransferFileInfo(
  value: unknown,
): value is TransferFileInfo {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['name', 'bytes']) &&
    isBoundedString(value['name'], MAX_TRANSFER_NAME) &&
    isSafeNonNegativeInt(value['bytes'])
  );
}

export type TransferListResult = {
  readonly sinks: readonly TransferSinkInfo[];
  readonly files: readonly TransferFileInfo[];
};

export function isTransferListResult(
  value: unknown,
): value is TransferListResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sinks', 'files']) &&
    Array.isArray(value['sinks']) &&
    value['sinks'].length <= MAX_LIST_ENTRIES &&
    value['sinks'].every(isTransferSinkInfo) &&
    Array.isArray(value['files']) &&
    value['files'].length <= MAX_LIST_ENTRIES &&
    value['files'].every(isTransferFileInfo)
  );
}

export type TransferStatusResult = TransferSinkInfo;

export const isTransferStatusResult = isTransferSinkInfo;

export type TransferStatsResult = {
  readonly bytes: number;
  readonly files: number;
  readonly partials: number;
  readonly freeBytes: number | null;
};

export function isTransferStatsResult(
  value: unknown,
): value is TransferStatsResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['bytes', 'files', 'partials', 'freeBytes']) &&
    isSafeNonNegativeInt(value['bytes']) &&
    isSafeNonNegativeInt(value['files']) &&
    isSafeNonNegativeInt(value['partials']) &&
    (value['freeBytes'] === null ||
      isSafeNonNegativeInt(value['freeBytes']))
  );
}

/**
 * `tagread:*` — the `TagReaderPort` read plane for granted trees.
 * `treeUri` is an opaque grant handle minted by `local:add`; every
 * batch is bounded so a hostile or corrupted tree can't smuggle
 * unbounded work across the boundary.
 */
export const MAX_TAGREAD_BATCH = 64;
export const MAX_DOC_ID = 4096;
export const MAX_ENUM_ENTRIES = 50_000;
export const MAX_TAG_FIELD = 4096;

export type TagreadEnumerateArgs = { readonly treeUri: string };

export function isTagreadEnumerateArgs(
  value: unknown,
): value is TagreadEnumerateArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['treeUri']) &&
    isBoundedString(value['treeUri'], MAX_DOC_ID)
  );
}

export type LocalEntryPayload = {
  readonly docId: string;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly modifiedMs: number | null;
};

export function isLocalEntryPayload(
  value: unknown,
): value is LocalEntryPayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['docId', 'name', 'size', 'mime', 'modifiedMs']) &&
    isBoundedString(value['docId'], MAX_DOC_ID) &&
    isBoundedString(value['name'], 1024) &&
    isSafeNonNegativeInt(value['size']) &&
    isBoundedString(value['mime'], 128) &&
    (value['modifiedMs'] === null ||
      isSafeNonNegativeInt(value['modifiedMs']))
  );
}

export type TagreadEnumerateResult = {
  readonly entries: readonly LocalEntryPayload[];
};

export function isTagreadEnumerateResult(
  value: unknown,
): value is TagreadEnumerateResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['entries']) &&
    Array.isArray(value['entries']) &&
    value['entries'].length <= MAX_ENUM_ENTRIES &&
    value['entries'].every(isLocalEntryPayload)
  );
}

export type TagreadBatchArgs = {
  readonly treeUri: string;
  readonly docIds: readonly string[];
};

export function isTagreadBatchArgs(
  value: unknown,
): value is TagreadBatchArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['treeUri', 'docIds']) &&
    isBoundedString(value['treeUri'], MAX_DOC_ID) &&
    Array.isArray(value['docIds']) &&
    value['docIds'].length <= MAX_TAGREAD_BATCH &&
    value['docIds'].every((id) => isBoundedString(id, MAX_DOC_ID))
  );
}

export type FileFingerprintPayload = {
  readonly docId: string;
  readonly fingerprint: string;
};

export function isFileFingerprintPayload(
  value: unknown,
): value is FileFingerprintPayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['docId', 'fingerprint']) &&
    isBoundedString(value['docId'], MAX_DOC_ID) &&
    isBoundedString(value['fingerprint'], 128)
  );
}

export type TagreadFingerprintResult = {
  readonly fingerprints: readonly (FileFingerprintPayload | null)[];
};

export function isTagreadFingerprintResult(
  value: unknown,
): value is TagreadFingerprintResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['fingerprints']) &&
    Array.isArray(value['fingerprints']) &&
    value['fingerprints'].length <= MAX_TAGREAD_BATCH &&
    value['fingerprints'].every(
      (fp) => fp === null || isFileFingerprintPayload(fp),
    )
  );
}

export type LocalTagsPayload = {
  readonly docId: string;
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly durationMs: number | null;
  readonly genre: string | null;
};

export function isLocalTagsPayload(
  value: unknown,
): value is LocalTagsPayload {
  const tagField = (v: unknown) => v === null || isBoundedString(v, MAX_TAG_FIELD);
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'docId',
      'title',
      'artist',
      'album',
      'durationMs',
      'genre',
    ]) &&
    isBoundedString(value['docId'], MAX_DOC_ID) &&
    tagField(value['title']) &&
    tagField(value['artist']) &&
    tagField(value['album']) &&
    tagField(value['genre']) &&
    (value['durationMs'] === null ||
      isSafeNonNegativeInt(value['durationMs']))
  );
}

export type TagreadReadResult = {
  readonly tags: readonly (LocalTagsPayload | null)[];
};

export function isTagreadReadResult(
  value: unknown,
): value is TagreadReadResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['tags']) &&
    Array.isArray(value['tags']) &&
    value['tags'].length <= MAX_TAGREAD_BATCH &&
    value['tags'].every((t) => t === null || isLocalTagsPayload(t))
  );
}

/**
 * `local:*` — the desktop local-files surface. `local:add` validates
 * renderer-picked paths and mints the treeUri/label descriptors the
 * engine's `addFolder` commits; probe/playback back the renderer's
 * `localPlaybackFor` hook; sweep is the startup integrity reporter.
 */
export const MAX_LOCAL_PATHS = 1024;
export const MAX_LOCAL_PATH = 4096;
export const MAX_PLAYBACK_ENTRIES = 100_000;

export type LocalAddArgs = { readonly paths: readonly string[] };

export function isLocalAddArgs(value: unknown): value is LocalAddArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['paths']) &&
    Array.isArray(value['paths']) &&
    value['paths'].length > 0 &&
    value['paths'].length <= MAX_LOCAL_PATHS &&
    value['paths'].every((p) => isBoundedString(p, MAX_LOCAL_PATH))
  );
}

export type LocalPickPayload = {
  readonly treeUri: string;
  readonly label: string;
  readonly kind: 'dir' | 'file';
};

export function isLocalPickPayload(
  value: unknown,
): value is LocalPickPayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['treeUri', 'label', 'kind']) &&
    isBoundedString(value['treeUri'], MAX_LOCAL_PATH + 16) &&
    isBoundedString(value['label'], 1024) &&
    (value['kind'] === 'dir' || value['kind'] === 'file')
  );
}

export type LocalAddResult = {
  readonly picks: readonly LocalPickPayload[];
};

export function isLocalAddResult(
  value: unknown,
): value is LocalAddResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['picks']) &&
    Array.isArray(value['picks']) &&
    value['picks'].length <= MAX_LOCAL_PATHS &&
    value['picks'].every(isLocalPickPayload)
  );
}

export type LocalProbeArgs = { readonly recordingId: string };

export function isLocalProbeArgs(
  value: unknown,
): value is LocalProbeArgs {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['recordingId']) &&
    isBoundedString(value['recordingId'], 512)
  );
}

export type LocalProbeResult = { readonly uri: string | null };

export function isLocalProbeResult(
  value: unknown,
): value is LocalProbeResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['uri']) &&
    (value['uri'] === null ||
      (isBoundedString(value['uri'], MAX_LOCAL_PATH + 16) &&
        (value['uri'] as string).startsWith('file://')))
  );
}

export type LocalSourcePayload = {
  readonly sourceId: string;
  readonly treeUri: string;
  readonly label: string;
  readonly addedMs: number;
  readonly lastScanMs: number | null;
  readonly fileCount: number;
};

export function isLocalSourcePayload(
  value: unknown,
): value is LocalSourcePayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'sourceId',
      'treeUri',
      'label',
      'addedMs',
      'lastScanMs',
      'fileCount',
    ]) &&
    isBoundedString(value['sourceId'], 128) &&
    isBoundedString(value['treeUri'], MAX_LOCAL_PATH + 16) &&
    isBoundedString(value['label'], 1024) &&
    isSafeNonNegativeInt(value['addedMs']) &&
    (value['lastScanMs'] === null ||
      isSafeNonNegativeInt(value['lastScanMs'])) &&
    isSafeNonNegativeInt(value['fileCount'])
  );
}

export type LocalListResult = {
  readonly sources: readonly LocalSourcePayload[];
};

export function isLocalListResult(
  value: unknown,
): value is LocalListResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sources']) &&
    Array.isArray(value['sources']) &&
    value['sources'].length <= MAX_LIST_ENTRIES &&
    value['sources'].every(isLocalSourcePayload)
  );
}

export type LocalPlaybackEntry = {
  readonly recordingId: string;
  readonly uri: string;
};

export function isLocalPlaybackEntry(
  value: unknown,
): value is LocalPlaybackEntry {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['recordingId', 'uri']) &&
    isBoundedString(value['recordingId'], 512) &&
    isBoundedString(value['uri'], MAX_LOCAL_PATH + 16) &&
    (value['uri'] as string).startsWith('file://')
  );
}

export type LocalPlaybackResult = {
  readonly entries: readonly LocalPlaybackEntry[];
};

export function isLocalPlaybackResult(
  value: unknown,
): value is LocalPlaybackResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['entries']) &&
    Array.isArray(value['entries']) &&
    value['entries'].length <= MAX_PLAYBACK_ENTRIES &&
    value['entries'].every(isLocalPlaybackEntry)
  );
}

export type LocalSweepResult = {
  readonly missing: number;
  readonly sources: readonly { readonly sourceId: string; readonly missing: number }[];
};

export function isLocalSweepResult(
  value: unknown,
): value is LocalSweepResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['missing', 'sources']) &&
    isSafeNonNegativeInt(value['missing']) &&
    Array.isArray(value['sources']) &&
    value['sources'].length <= MAX_LIST_ENTRIES &&
    value['sources'].every(
      (s) =>
        isRecord(s) &&
        hasOnlyKeys(s, ['sourceId', 'missing']) &&
        isBoundedString(s['sourceId'], 128) &&
        isSafeNonNegativeInt(s['missing']),
    )
  );
}

/**
 * The `window.auqw` surface the preload exposes. Every method resolves
 * with a validated payload and rejects with a `ShellError`-shaped value.
 */
export type AuqwApi = {
  readonly app: {
    readonly meta: () => Promise<AppMeta>;
  };
  readonly chrome: {
    /** Reports the resolved ui-web scheme so main can re-tint the
        titlebar overlay. One-way send; nothing to await. */
    readonly setScheme: (scheme: 'dark' | 'light' | 'oled') => void;
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
    readonly request: (
      args: HostRequestArgs,
    ) => Promise<RequestOutcomePayload>;
    readonly cancelRequest: (args: HostCancelArgs) => Promise<void>;
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
  /**
   * The `MediaTransferPort` file plane — sink lifecycle plus cache
   * management. The `DownloadManager` engine drives these calls from
   * the renderer exactly as it does the mobile adapter.
   */
  readonly transfer: {
    readonly ensureDir: () => Promise<void>;
    readonly begin: (args: TransferBeginArgs) => Promise<TransferBeginResult>;
    readonly write: (args: TransferWriteArgs) => Promise<void>;
    readonly commit: (args: TransferSinkArgs) => Promise<TransferCommitResult>;
    readonly finalize: (
      args: TransferFinalizeArgs,
    ) => Promise<TransferFinalizeResult>;
    readonly abort: (args: TransferAbortArgs) => Promise<void>;
    readonly stat: (args: TransferNameArgs) => Promise<TransferStatResult>;
    readonly remove: (args: TransferNameArgs) => Promise<void>;
    readonly sweepPartials: (
      args: TransferSweepArgs,
    ) => Promise<TransferSweepResult>;
    readonly list: () => Promise<TransferListResult>;
    readonly status: (args: TransferSinkArgs) => Promise<TransferStatusResult>;
    readonly stats: () => Promise<TransferStatsResult>;
  };
  /**
   * The `TagReaderPort` read plane — enumerate/fingerprint/read against
   * a granted treeUri only.
   */
  readonly tagread: {
    readonly enumerate: (
      args: TagreadEnumerateArgs,
    ) => Promise<TagreadEnumerateResult>;
    readonly fingerprint: (
      args: TagreadBatchArgs,
    ) => Promise<TagreadFingerprintResult>;
    readonly read: (args: TagreadBatchArgs) => Promise<TagreadReadResult>;
  };
  /**
   * Picked-path validation + playback probe + integrity sweep over the
   * domain index the utility reads. `add` mints the descriptors the
   * engine commits as `local_sources` rows via `addFolder`.
   */
  readonly local: {
    readonly add: (args: LocalAddArgs) => Promise<LocalAddResult>;
    readonly probe: (args: LocalProbeArgs) => Promise<LocalProbeResult>;
    readonly list: () => Promise<LocalListResult>;
    readonly playback: () => Promise<LocalPlaybackResult>;
    readonly sweep: () => Promise<LocalSweepResult>;
  };
};

declare global {
  interface Window {
    auqw: AuqwApi;
  }
}
