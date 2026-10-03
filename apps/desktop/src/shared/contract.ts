import { hasOnlyKeys, isBoundedString, isRecord } from './check.ts';
import * as v from './schema.ts';
import type { SqlRow, SqlValue } from '@auqw/storage-sqlite';
import type {
  AdaptivePalette,
  ThemeSource,
} from '@auqw/design-tokens/adaptive';

/**
 * Payload types for every channel in `CHANNELS`. Validators here are the
 * single source of truth: main validates inbound args with them and the
 * preload re-validates every returned payload with them. Each `isX` is
 * composed from the `v.*` combinators in `./schema.ts` and each payload
 * type is `v.Guarded<typeof isX>` — the declared type IS the validator's
 * narrowing, so the two can never drift.
 */

export type AppMeta = v.Guarded<typeof isAppMeta>;

export const isAppMeta = v.object({
  version: v.boundedString(128),
  platform: v.boundedString(32),
  userDataPath: v.boundedString(4096),
});

export type NetSnapshot = NetEvent;
export type NetEvent = v.Guarded<typeof isNetEvent>;

export const isNetEvent = v.object({
  online: v.boolean(),
});

const PALETTE_KEYS = ['bg', 'fg', 'accent', 'warn', 'sel'] as const;

const isAdaptivePalette: v.Guard<AdaptivePalette> = (
  value,
): value is AdaptivePalette =>
  isRecord(value) &&
  hasOnlyKeys(value, PALETTE_KEYS) &&
  PALETTE_KEYS.every((key) =>
    isBoundedString(value[key] ?? 'x', 32),
  );

const isThemeSource: v.Guard<ThemeSource | null> = v.nullable(
  v.object({
    scheme: v.literals('dark', 'light'),
    palette: v.optional(isAdaptivePalette),
  }),
);

/**
 * The OS-emitted `{scheme, palette?}` a ThemeSourcePort produces, or
 * `null` when main has no source to offer (the renderer then resolves
 * 'adaptive' like 'system'). Pushed on `theme:events`.
 */
export type ThemeSourceEvent = v.Guarded<typeof isThemeSourceEvent>;

export const isThemeSourceEvent = v.object({
  source: isThemeSource,
});

/** `window:control` payload — one op from the renderer-drawn caption
    cluster (minimize · toggle-maximize · close). */
export type WindowControlPayload = v.Guarded<typeof isWindowControlPayload>;

export const isWindowControlPayload = v.object({
  op: v.literals('minimize', 'toggle-maximize', 'close'),
});

/** `window:state` push — maximize state driving the cluster's
    maximize↔restore glyph swap. */
export type WindowStateEvent = v.Guarded<typeof isWindowStateEvent>;

export const isWindowStateEvent = v.object({
  maximized: v.boolean(),
});

const pickFolderArgs = v.object({ title: v.optional(v.string()) });
const pickFilesArgs = v.object({
  title: v.optional(v.string()),
  multiple: v.optional(v.boolean()),
});

export type PickFolderArgs = v.Guarded<typeof pickFolderArgs>;
export type PickFilesArgs = v.Guarded<typeof pickFilesArgs>;

export const isPickFolderArgs = (
  value: unknown,
): value is PickFolderArgs =>
  value === undefined || pickFolderArgs(value);

export const isPickFilesArgs = (
  value: unknown,
): value is PickFilesArgs =>
  value === undefined || pickFilesArgs(value);

/**
 * Secure-store keys map to one file each under userData — the pattern
 * refuses separators so a key can never walk the directory.
 */
const isSecureKey = v.refine(
  v.pattern(/^[a-z0-9][a-z0-9._-]{0,127}$/i),
  // `auqw.sync.*` is the pairing-custody namespace — it lives in the
  // sync-secure store behind `sync:keys`, never on these
  // renderer-facing channels.
  (key) => !key.toLowerCase().startsWith('auqw.sync.'),
);

export type SecureGetArgs = v.Guarded<typeof isSecureGetArgs>;
export type SecureSetArgs = v.Guarded<typeof isSecureSetArgs>;
export type SecureDeleteArgs = v.Guarded<typeof isSecureDeleteArgs>;

export const isSecureGetArgs = v.object({ key: isSecureKey });

export const isSecureSetArgs = v.object({
  key: isSecureKey,
  value: v.string(65_536),
});

export const isSecureDeleteArgs = isSecureGetArgs;

export const isStringOrNull = v.nullable(v.string());

export const isStringArray = v.array(v.string());

export const isUndefinedResult = v.literal(undefined);

export type UtilityPingArgs = v.Guarded<typeof isUtilityPingArgs>;
export type UtilityPingResult = v.Guarded<typeof isUtilityPingResult>;

export const isUtilityPingArgs = v.object({
  message: v.boundedString(4096),
});

export const isUtilityPingResult = v.object({
  reply: v.literal('pong'),
  echo: v.boundedString(4096),
});

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
export type PluginManifestPayload = v.Guarded<
  typeof isPluginManifestPayload
>;

const isPluginManifestPayload = v.object({
  pluginId: v.boundedString(128),
  providerId: v.boundedString(128),
  capabilities: v.array(v.boundedString(64)),
  /** Manifest `version`; null when the manifest omits it. */
  version: v.nullable(v.boundedString(64)),
  /**
   * Manifest `permissions` as declared (`network:` hosts, `kv`, ...).
   * The host-accepted grammar has no length bound — an unbounded guard
   * keeps the payload faithful to what the host enforces.
   */
  permissions: v.array(v.string()),
});

export type HostPluginsResult = v.Guarded<typeof isHostPluginsResult>;

export const isHostPluginsResult = v.object({
  bindings: v.literals('loaded', 'unavailable'),
  bindingsError: v.optional(v.string()),
  plugins: v.array(v.boundedString(128)),
  manifests: v.array(isPluginManifestPayload),
});

/**
 * A prepared stream handle as the host reports it — mirrors
 * `PreparedStream` in `packages/application` but stays shell-local so
 * the contract never imports app packages.
 */
export type PreparedStreamPayload = v.Guarded<
  typeof isPreparedStreamPayload
>;

export const isPreparedStreamPayload = v.object({
  handle: v.boundedString(512),
  mime: v.boundedString(128),
  itag: v.optional(v.int()),
  contentLength: v.optional(v.int()),
  expiresAtMs: v.optional(v.int()),
  bitrateKbps: v.optional(v.int()),
});

/**
 * Mirrors the port's trace-URL rule: a redacted `http(s)` URL, or the
 * literal `<pot-provider>` sentinel the host emits for pot mints (the
 * LAN address never crosses at all). Signed-url material — queries
 * and fragments — never crosses.
 */
const isTraceUrlPayload: v.Guard<string> = (
  value,
): value is string =>
  value === '<pot-provider>' ||
  (isBoundedString(value, 2048) &&
    (value.startsWith('http://') || value.startsWith('https://')) &&
    !value.includes('?') &&
    !value.includes('#'));

const isHttpTracePayload = v.object({
  method: v.boundedString(32),
  url: isTraceUrlPayload,
  status: v.optional(v.int()),
  bytes: v.int(),
  elapsedMs: v.int(),
});

const isGuestLogPayload = v.object({
  level: v.boundedString(16),
  message: v.string(4096),
});

/** Attempt diagnostics — redacted by the host before crossing. */
export type AttemptSummaryPayload = v.Guarded<
  typeof isAttemptSummaryPayload
>;

const isAttemptSummaryPayload = v.object({
  requestId: v.boundedString(128),
  steps: v.int(),
  httpCalls: v.int(),
  bytes: v.int(),
  fuelUsed: v.int(),
  elapsedMs: v.int(),
  // Caps mirror `isAttemptTrace` in packages/application — the
  // boundary must never accept a trace the port would reject on
  // persistence, nor drop one the port considers valid.
  httpTrace: v.array(isHttpTracePayload, { max: 32 }),
  guestLog: v.array(isGuestLogPayload, { max: 128 }),
});

/**
 * `startRequest`'s terminal outcome — `succeeded` carries the raw
 * `done.result` JSON for the renderer adapter to decode, `failed`
 * the host's typed kind + message.
 */
export type RequestOutcomePayload = v.Guarded<
  typeof isRequestOutcomePayload
>;

export const isRequestOutcomePayload = v.object({
  type: v.literals('succeeded', 'failed'),
  resultJson: v.optional(v.string(1_048_576)),
  kind: v.optional(v.string()),
  message: v.optional(v.string()),
  attempt: isAttemptSummaryPayload,
});

/**
 * `startPrepare`'s resolved outcome. `prepared` carries the minted
 * stream; `failed`/`superseded` carry the host's typed kind + message.
 */
export type PrepareOutcomePayload = v.Guarded<
  typeof isPrepareOutcomePayload
>;

export const isPrepareOutcomePayload = v.object({
  type: v.literals('prepared', 'failed', 'superseded'),
  stream: v.optional(isPreparedStreamPayload),
  // Session handles this prepare superseded or pruned (napi
  // `PrepareOutcome.superseded: Vec<String>`) — handle routing drops
  // them so a dead session can never serve a later attach. No length
  // cap: the registry prunes unbounded terminal sets, and rejecting
  // post-registration would strand the minted handle.
  superseded: v.optional(v.array(v.boundedString(256))),
  kind: v.optional(v.string()),
  message: v.optional(v.string()),
  attempt: v.optional(isAttemptSummaryPayload),
});

export type StreamPrepareArgs = v.Guarded<typeof isStreamPrepareArgs>;

export const isStreamPrepareArgs = v.object({
  pluginId: v.boundedString(128),
  sourceRef: v.boundedString(4096),
  requestId: v.boundedString(128),
});

export type StreamDevPrepareArgs = v.Guarded<
  typeof isStreamDevPrepareArgs
>;

export const isStreamDevPrepareArgs = v.object({
  url: v.refine(
    v.string(4096),
    (url) => url.startsWith('https://') || url.startsWith('http://'),
  ),
  mime: v.boundedString(128),
  contentLength: v.optional(v.int()),
  remintable: v.optional(v.boolean()),
});

export type StreamHandleArgs = v.Guarded<typeof isStreamHandleArgs>;

export const isStreamHandleArgs = v.object({
  handle: v.boundedString(512),
});

export type StreamOpenArgs = v.Guarded<typeof isStreamOpenArgs>;

export const isStreamOpenArgs = v.object({
  handle: v.boundedString(512),
  position: v.int(),
});

/** `stream:open` result — `null` remaining = unknown total. */
type StreamOpenResult = v.Guarded<typeof isStreamOpenResult>;

export const isStreamOpenResult = v.object({
  remaining: v.nullable(v.int()),
});

export type StreamReadArgs = v.Guarded<typeof isStreamReadArgs>;

const MAX_READ_LEN = 1024 * 1024;

export const isStreamReadArgs = v.object({
  handle: v.boundedString(512),
  position: v.int(),
  maxLen: v.refine(v.int(), (n) => n > 0 && n <= MAX_READ_LEN),
});

/** `stream:read` result — raw bytes ride base64; empty = EOF. */
type StreamReadResult = v.Guarded<typeof isStreamReadResult>;

export const isStreamReadResult = v.object({
  data: v.string(MAX_READ_LEN * 2),
});

export type StreamProbeArgs = v.Guarded<typeof isStreamProbeArgs>;

export const isStreamProbeArgs = v.object({
  handle: v.boundedString(512),
  position: v.int(),
  maxLen: v.refine(v.int(), (n) => n > 0 && n <= MAX_READ_LEN),
  /** `false` = committed-bytes-only (peek semantics); default fetches. */
  fetch: v.optional(v.boolean()),
});

/** `stream:probe` result — bytes ride base64; `eof` distinguishes a
 * confirmed end-of-stream from a fetch-disabled hole. */
type StreamProbeResult = v.Guarded<typeof isStreamProbeResult>;

export const isStreamProbeResult = v.object({
  data: v.string(MAX_READ_LEN * 2),
  total: v.nullable(v.int()),
  eof: v.boolean(),
});

type StreamServeUrlResult = v.Guarded<
  typeof isStreamServeUrlResult
>;

export const isStreamServeUrlResult = v.object({
  url: v.refine(v.boundedString(2048), (url) =>
    url.startsWith('http://127.0.0.1:'),
  ),
});

/** `stream:marks` — lifecycle phase marks, all optional ms values. */
export type StreamMarksResult = v.Guarded<typeof isStreamMarksResult>;

export const isStreamMarksResult = v.object({
  prepareStartedMs: v.optional(v.int()),
  resolveMs: v.optional(v.int()),
  mintMs: v.optional(v.int()),
  firstByteMs: v.optional(v.int()),
  headReadyMs: v.optional(v.int()),
  attachMs: v.optional(v.int()),
});

export type StreamCancelArgs = v.Guarded<typeof isStreamCancelArgs>;

export const isStreamCancelArgs = v.object({
  requestId: v.boundedString(128),
});

/**
 * `host:request` — any declared capability with a JSON object payload,
 * mirroring the napi `startRequest` signature. The renderer mints the
 * requestId so its cancel path can reach the host before the promise
 * resolves.
 */
export type HostRequestArgs = v.Guarded<typeof isHostRequestArgs>;

export const isHostRequestArgs = v.object({
  pluginId: v.boundedString(128),
  capability: v.boundedString(64),
  payloadJson: v.string(65_536),
  requestId: v.boundedString(128),
});

/** `host:cancel` — same requestId-scoped abort as `stream:cancel`. */
export type HostCancelArgs = v.Guarded<typeof isHostCancelArgs>;

export const isHostCancelArgs = v.object({
  requestId: v.boundedString(128),
});

/**
 * `stream:port` — asks main to broker a MessageChannel to the utility
 * process's byte pump for `handle`. The port itself arrives on the
 * `stream-bytes` event keyed by `requestId`; the invoke resolves once
 * main has posted both ends (or rejects typed).
 */
export type StreamPortArgs = v.Guarded<typeof isStreamPortArgs>;

export const isStreamPortArgs = v.object({
  handle: v.boundedString(512),
  requestId: v.boundedString(128),
});

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

/**
 * The storage channels forward to the utility process: `begin` pins a
 * transaction id there and every statement runs against it, because a
 * driver's `transaction(work)` callback cannot cross a process
 * boundary. Params and row values are `SqlValue` (string/number/null)
 * only — bigint, blob, and boolean have no wire representation.
 */
export type StorageBeginResult = v.Guarded<typeof isStorageBeginResult>;

export const isStorageBeginResult = v.object({
  txId: v.boundedString(64),
});

export const isStorageBeginArgs = v.literal(undefined);

export type StorageTxArgs = v.Guarded<typeof isStorageTxArgs>;

export const isStorageTxArgs = v.object({
  txId: v.boundedString(64),
});

const isSqlValue: v.Guard<SqlValue> = v.union(
  v.literal(null),
  v.string(1_048_576),
  v.finite(),
);

const isSqlParams = v.array(isSqlValue, { max: 256 });

const isSqlRowValue: v.Guard<SqlRow> = (
  value,
): value is SqlRow =>
  isRecord(value) &&
  Object.keys(value).length <= 256 &&
  Object.keys(value).every((key) => isBoundedString(key, 128)) &&
  Object.values(value).every(isSqlValue);

export type StorageExecuteArgs = v.Guarded<typeof isStorageExecuteArgs>;

export const isStorageExecuteArgs = v.object({
  txId: v.boundedString(64),
  sql: v.boundedString(65_536),
  params: isSqlParams,
});

export const isStorageQueryArgs = isStorageExecuteArgs;

export type StorageStatement = v.Guarded<typeof isStorageStatement>;

const isStorageStatement = v.object({
  sql: v.boundedString(65_536),
  params: isSqlParams,
});

export type StorageExecManyArgs = v.Guarded<typeof isStorageExecManyArgs>;

export const isStorageExecManyArgs = v.object({
  txId: v.boundedString(64),
  statements: v.array(isStorageStatement, { max: 4_096 }),
});

export type StorageExecuteResult = v.Guarded<
  typeof isStorageExecuteResult
>;

export const isStorageExecuteResult = v.object({
  changes: v.int(),
  lastInsertRowId: v.nullable(v.integer()),
});

export type StorageQueryResult = v.Guarded<typeof isStorageQueryResult>;

export const isStorageQueryResult = v.object({
  rows: v.array(isSqlRowValue, { max: 1_000_000 }),
});

export type StorageBackupArgs = v.Guarded<typeof isStorageBackupArgs>;

export const isStorageBackupArgs = v.object({
  tag: v.pattern(/^[a-z0-9-]{1,64}$/i),
});

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
  readonly execMany: (
    txId: string,
    statements: readonly StorageStatement[],
  ) => Promise<void>;
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

const syncListenerState = v.literals(
  'starting',
  'listening',
  'unavailable',
  // Never started: a never-paired install defers listener+custody until
  // an explicit sync action (pairing), so observational status reads
  // stay free of the safeStorage/keychain read.
  'dormant',
  'disabled',
);

export type SyncStatusResult = v.Guarded<typeof isSyncStatusResult>;

export const isSyncStatusResult = v.object({
  listener: syncListenerState,
  /** `ip:port` to feed a pairing payload, or null when nothing is up. */
  endpoint: v.nullable(v.boundedString(128)),
  boundPort: v.nullable(v.int()),
  advertise: v.literals('off', 'announcing', 'unavailable'),
  pairedDevices: v.int(),
  sessions: v.int(),
  lastSyncAt: v.nullable(v.finite()),
  engine: v.literals('ready', 'absent'),
  /** The local device's sync identity — null while the engine is absent. */
  deviceId: v.nullable(v.boundedString(128)),
  name: v.boundedString(128),
  fingerprint: v.nullable(v.boundedString(128)),
});

export type SyncPairingResult = v.Guarded<typeof isSyncPairingResult>;

export const isSyncPairingResult = v.object({
  /** QR-payload text: JSON {v, endpoint, endpoints, code, fp}. */
  payload: v.boundedString(1_024),
  /** The 6-digit typed path — same session as the QR payload. */
  code: v.pattern(/^[0-9]{6}$/),
  /** Primary `ip:port` for the typed path — shown next to the code. */
  endpoint: v.boundedString(64),
  expiresAt: v.finite(),
});

/**
 * `sync:nearby*` — the LocalSend-style discovery surface: the utility
 * browses `_auqw._tcp` while a nearby list is open and pushes
 * `sync:nearby` events through main. Discovery is advisory — pairing
 * still authorizes by the 6-digit code (or a scanned payload); the
 * advertised `fp` only pins it.
 */
export type SyncNearbyPeer = v.Guarded<typeof isSyncNearbyPeer>;

const isSyncNearbyPeer = v.object({
  /** Stable per-service identity — rows key on it, `lost` carries it. */
  key: v.boundedString(320),
  name: v.boundedString(128),
  host: v.boundedString(64),
  port: v.int(),
  /** Every pairable resolved address, best-first (`host` is [0]) —
   * dial candidates when the ranked pick sits behind a dead route. */
  addresses: v.array(v.boundedString(64), { max: 16 }),
  /** Advertised identity fingerprint (TXT `dev`) — null when absent. */
  fp: v.nullable(v.boundedString(128)),
});

export type SyncNearbyEvent = v.Guarded<typeof isSyncNearbyEvent>;

export const isSyncNearbyEvent = v.union(
  v.object({ type: v.literal('found'), peer: isSyncNearbyPeer }),
  v.object({ type: v.literal('lost'), key: v.boundedString(320) }),
  // A caller just consumed our minted offer — the sheet remints so
  // it never displays a dead code.
  v.object({ type: v.literal('paired') }),
);

export type SyncDeviceInfo = v.Guarded<typeof isSyncDeviceInfo>;

const isSyncDeviceInfo = v.object({
  id: v.boundedString(64),
  name: v.boundedString(128),
  pairedAt: v.finite(),
  lastSeenAt: v.finite(),
});

/**
 * `sync:dial` — pair TO a phone-hosted offer: the desktop is the
 * caller, the typed/scanned code is the auth secret. `fp` pins the
 * responder when mDNS/QR disclosed it.
 */
export type SyncDialArgs = v.Guarded<typeof isSyncDialArgs>;

export const isSyncDialArgs = v.object({
  host: v.boundedString(64),
  port: v.int(),
  code: v.pattern(/^[0-9]{6}$/),
  fp: v.optional(v.boundedString(128)),
  /**
   * All resolved dial candidates for the target, best-first — when
   * present the dial iterates this list (dead route under the ranked
   * pick falls through to a sibling). `host` stays the fallback.
   */
  hosts: v.optional(v.array(v.boundedString(64), { max: 16 })),
});

/** `sync:dialPayload` — pair TO a phone's QR payload verbatim. */
export type SyncDialPayloadArgs = v.Guarded<typeof isSyncDialPayloadArgs>;

export const isSyncDialPayloadArgs = v.object({
  payload: v.boundedString(1_024),
});

export type SyncDialResult = v.Guarded<typeof isSyncDialResult>;

export const isSyncDialResult = v.object({
  device: isSyncDeviceInfo,
});

export type SyncDevicesResult = v.Guarded<typeof isSyncDevicesResult>;

export const isSyncDevicesResult = v.object({
  devices: v.array(isSyncDeviceInfo, { max: 64 }),
});

export type SyncUnpairArgs = v.Guarded<typeof isSyncUnpairArgs>;

export const isSyncUnpairArgs = v.object({
  id: v.boundedString(64),
});

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

export type SyncDeltasArgs = v.Guarded<typeof isSyncDeltasArgs>;

/**
 * The serialized-cursor bound: `since` is `JSON.stringify(SyncCursor)`
 * — a map of up to 512 device ids (each ≤128 chars) to sequences.
 * Worst case is 512 entries × ~150 JSON chars ≈ 77 KB; round to
 * 80 000 so a full cursor always fits.
 */
export const MAX_SYNC_CURSOR_CHARS = 80_000;

export const isSyncDeltasArgs = v.object({
  // '' is a legal cursor — the engine reads it as "full snapshot".
  since: v.string(MAX_SYNC_CURSOR_CHARS),
});

export type SyncDeltasResult = v.Guarded<typeof isSyncDeltasResult>;

export const isSyncDeltasResult = v.object({
  delta: v.checked(isSyncDeltaDoc),
});

export type SyncImportDeltaArgs = v.Guarded<typeof isSyncImportDeltaArgs>;

export const isSyncImportDeltaArgs = v.object({
  delta: v.checked(isSyncDeltaDoc),
  deviceId: v.optional(v.boundedString(64)),
});

export type SyncImportDeltaResult = v.Guarded<
  typeof isSyncImportDeltaResult
>;

export const isSyncImportDeltaResult = v.object({
  // The engine's apply receipt is `unknown` — any bounded JSON value
  // (including `null`) is a valid result, not just full documents.
  result: v.checked((entry) =>
    isBoundedJson(entry, MAX_SYNC_DOC_BYTES),
  ),
});

export type SyncTriggerResult = v.Guarded<typeof isSyncTriggerResult>;

export const isSyncTriggerResult = v.object({
  triggered: v.boolean(),
  pending: v.boolean(),
});

/**
 * `sync:localChanges` — domain edits the renderer already committed,
 * pushed to the engine so it can stamp them into the change log. The
 * doc mirrors the engine's `LocalWrite` shape with `kind` left a
 * string: the whitelist check is the engine's own `validLocalWrite`,
 * which runs per write before stamping — the boundary only owes the
 * bounded-shape check below.
 */
const MAX_SYNC_LOCAL_WRITES = 256;
const MAX_SYNC_FIELD_BYTES = 65_536;

const isSyncLocalWriteDoc = v.union(
  v.object({
    kind: v.boundedString(64),
    recordId: v.boundedString(1024),
    field: v.boundedString(64),
    value: v.checked((entry) =>
      isBoundedJson(entry, MAX_SYNC_FIELD_BYTES),
    ),
  }),
  v.object({
    kind: v.boundedString(64),
    recordId: v.boundedString(1024),
    tombstone: v.literal(true),
  }),
);

export type SyncLocalChangesArgs = v.Guarded<
  typeof isSyncLocalChangesArgs
>;

export const isSyncLocalChangesArgs = v.object({
  writes: v.array(isSyncLocalWriteDoc, {
    min: 1,
    max: MAX_SYNC_LOCAL_WRITES,
  }),
});

/**
 * The result is a small acknowledgement, not the per-write outcome
 * list: callers only consume ok/err, and a results array of the same
 * writes would re-serialize every committed value — a batch that
 * passes field bounds could then exceed the doc cap and report a
 * transport failure AFTER the engine already appended (Review #46
 * round-9). `accepted` counts the stamped batch.
 */
export type SyncLocalChangesResult = v.Guarded<
  typeof isSyncLocalChangesResult
>;

export const isSyncLocalChangesResult = v.object({
  accepted: v.int(),
});

/**
 * `sync:applied` — the utility→main→renderer push that remote-applied
 * merge outcomes are waiting in the drain outbox. The renderer still
 * pulls `sync:drainApplied`; the event only says how deep the queue is.
 */
export type SyncAppliedEvent = v.Guarded<typeof isSyncAppliedEvent>;

export const isSyncAppliedEvent = v.object({
  pending: v.int(1_000_000),
});

/**
 * `sync:drainApplied` — one byte-bounded pull off the applied-outcome
 * outbox. `outcomes` carries merge outcomes verbatim (the projection
 * validates entry shapes itself); `dropped` reports outbox overflow
 * since the previous drain; `remaining` drives the drain loop.
 */
export type SyncDrainAppliedResult = v.Guarded<
  typeof isSyncDrainAppliedResult
>;

export const isSyncDrainAppliedResult = v.object({
  outcomes: v.refine(v.array(v.checked(isJsonValue)), (entries) =>
    isBoundedJson(entries, MAX_SYNC_DOC_BYTES),
  ),
  dropped: v.boolean(),
  remaining: v.int(1_000_000),
});

/**
 * `sync:materialized` — paged pull of the engine's materialized
 * record view. `records` are opaque `{kind, recordId, fields}`
 * JSON — the session validates each via `isMaterializedRecord`;
 * `nextOffset` continues the pull, `null` ends it.
 */
export type SyncMaterializedArgs = v.Guarded<
  typeof isSyncMaterializedArgs
>;

export const isSyncMaterializedArgs = v.object({
  offset: v.int(1_000_000),
});

export type SyncMaterializedResult = v.Guarded<
  typeof isSyncMaterializedResult
>;

export const isSyncMaterializedResult = v.object({
  records: v.refine(v.array(v.checked(isJsonValue)), (entries) =>
    isBoundedJson(entries, MAX_SYNC_DOC_BYTES),
  ),
  nextOffset: v.nullable(v.int()),
});

/**
 * The renderer's `api.sync.*` — one method per `sync:*` channel; the
 * utility's sync service answers them all and works plugin-free.
 */
type AuqwSync = {
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
  /**
   * LocalSend-style discovery: start the `_auqw._tcp` browse while a
   * nearby list is on screen; peers arrive via `onNearby` pushes.
   * Best-effort — a failure to browse reports 'unavailable' at start.
   */
  readonly nearbyStart: () => Promise<void>;
  readonly nearbyStop: () => Promise<void>;
  readonly onNearby: (
    listener: (event: SyncNearbyEvent) => void,
  ) => () => void;
  /**
   * Caller half of symmetric pairing: pair TO a phone-hosted offer by
   * endpoint + displayed code, or verbatim QR payload. The peer's
   * pair-host is pairing-only — rounds still run phone→desktop.
   */
  readonly dial: (args: SyncDialArgs) => Promise<SyncDialResult>;
  readonly dialPayload: (
    args: SyncDialPayloadArgs,
  ) => Promise<SyncDialResult>;
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
const MAX_TRANSFER_NAME = 512;
// 4MiB decoded → ceil(4194304/3)*4 = 5,592,408 base64 chars.
const MAX_TRANSFER_WRITE_BASE64 = 5_592_408;
const MAX_SWEEP_KEEP = 65_536;
const MAX_LIST_ENTRIES = 65_536;

export type TransferBeginArgs = v.Guarded<typeof isTransferBeginArgs>;

export const isTransferBeginArgs = v.object({
  destPath: v.boundedString(MAX_TRANSFER_NAME),
  resumeAtBytes: v.int(),
});

type TransferBeginResult = v.Guarded<typeof isTransferBeginResult>;
export type TransferSinkArgs = v.Guarded<typeof isTransferSinkArgs>;

const isSinkId = v.pattern(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);

export const isTransferBeginResult = v.object({ sinkId: isSinkId });

export const isTransferSinkArgs = v.object({ sinkId: isSinkId });

export type TransferWriteArgs = v.Guarded<typeof isTransferWriteArgs>;

export const isTransferWriteArgs = v.object({
  sinkId: isSinkId,
  data: v.string(MAX_TRANSFER_WRITE_BASE64),
});

type TransferCommitResult = v.Guarded<
  typeof isTransferCommitResult
>;

export const isTransferCommitResult = v.object({ offset: v.int() });

export type TransferFinalizeArgs = v.Guarded<
  typeof isTransferFinalizeArgs
>;

export const isTransferFinalizeArgs = v.object({
  sinkId: isSinkId,
  expected: v.nullable(v.pattern(/^[0-9a-f]{64}$/)),
});

type TransferFinalizeResult = v.Guarded<
  typeof isTransferFinalizeResult
>;

export const isTransferFinalizeResult = v.object({
  digest: v.pattern(/^[0-9a-f]{64}$/),
});

export type TransferAbortArgs = v.Guarded<typeof isTransferAbortArgs>;

export const isTransferAbortArgs = v.object({
  sinkId: isSinkId,
  keep: v.boolean(),
});

export type TransferNameArgs = v.Guarded<typeof isTransferNameArgs>;

export const isTransferNameArgs = v.object({
  name: v.boundedString(MAX_TRANSFER_NAME),
});

type TransferStatResult = v.Guarded<typeof isTransferStatResult>;

export const isTransferStatResult = v.object({
  exists: v.boolean(),
  bytes: v.nullable(v.int()),
});

export type TransferSweepArgs = v.Guarded<typeof isTransferSweepArgs>;

export const isTransferSweepArgs = v.object({
  keepPaths: v.array(v.boundedString(MAX_TRANSFER_NAME), {
    max: MAX_SWEEP_KEEP,
  }),
});

type TransferSweepResult = v.Guarded<typeof isTransferSweepResult>;

export const isTransferSweepResult = v.object({ swept: v.int() });

export type TransferSinkInfo = v.Guarded<typeof isTransferSinkInfo>;

const isTransferSinkInfo = v.object({
  sinkId: isSinkId,
  destPath: v.boundedString(MAX_TRANSFER_NAME),
  committedBytes: v.int(),
  openedMs: v.int(),
});

const isTransferFileInfo = v.object({
  name: v.boundedString(MAX_TRANSFER_NAME),
  bytes: v.int(),
});

type TransferListResult = v.Guarded<typeof isTransferListResult>;

export const isTransferListResult = v.object({
  sinks: v.array(isTransferSinkInfo, { max: MAX_LIST_ENTRIES }),
  files: v.array(isTransferFileInfo, { max: MAX_LIST_ENTRIES }),
});

type TransferStatusResult = v.Guarded<
  typeof isTransferStatusResult
>;

export const isTransferStatusResult = isTransferSinkInfo;

type TransferStatsResult = v.Guarded<typeof isTransferStatsResult>;

export const isTransferStatsResult = v.object({
  bytes: v.int(),
  files: v.int(),
  partials: v.int(),
  freeBytes: v.nullable(v.int()),
});

/**
 * `transfer:fetch*` — the download wire leg. The renderer CSP forbids
 * https egress (`connect-src 'self' http://127.0.0.1:*`) and browser
 * fetch can't send a minted `User-Agent`, so the request runs in the
 * utility's Node fetch. `fetch` returns the status + response headers
 * only; `fetchBody` pulls a bounded body — the transfer policy only
 * reads bodies on 206, so error pages and whole-file 200s are never
 * buffered. `fetchAbort` cancels either phase; a requestId is
 * single-use.
 */
const MAX_FETCH_URL = 8192;
const MAX_FETCH_HEADERS = 32;
const MAX_FETCH_HEADER_NAME = 64;
const MAX_FETCH_HEADER_VALUE = 2048;
// 8MiB decoded → ceil(8388608/3)*4 = 11,184,812 base64 chars.
const MAX_FETCH_BODY_BASE64 = 11_184_812;

const isFetchId = v.boundedString(96);

// RFC 9110 token — a malformed name would TypeError inside undici and
// surface as a 'transient' failure that retries forever. Rejected at
// the boundary instead.
const FETCH_HEADER_NAME =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;

const isFetchHeaders = (
  value: unknown,
): value is Readonly<Record<string, string>> =>
  isRecord(value) &&
  Object.keys(value).length <= MAX_FETCH_HEADERS &&
  Object.entries(value).every(
    ([name, headerValue]) =>
      FETCH_HEADER_NAME.test(name) &&
      isBoundedString(headerValue, MAX_FETCH_HEADER_VALUE),
  );

export type TransferFetchArgs = v.Guarded<typeof isTransferFetchArgs>;

export const isTransferFetchArgs = v.object({
  requestId: isFetchId,
  url: v.boundedString(MAX_FETCH_URL),
  headers: isFetchHeaders,
});

// Response header values may legitimately be empty — only bounded.
const isHeaderPair = (
  value: unknown,
): value is readonly [string, string] =>
  Array.isArray(value) &&
  value.length === 2 &&
  isBoundedString(value[0], MAX_FETCH_HEADER_NAME) &&
  typeof value[1] === 'string' &&
  value[1].length <= MAX_FETCH_HEADER_VALUE;

type TransferFetchResult = v.Guarded<typeof isTransferFetchResult>;

export const isTransferFetchResult = v.object({
  status: v.int(599),
  headers: v.array(isHeaderPair, { max: 64 }),
});

export type TransferFetchIdArgs = v.Guarded<typeof isTransferFetchIdArgs>;

export const isTransferFetchIdArgs = v.object({ requestId: isFetchId });

type TransferFetchBodyResult = v.Guarded<typeof isTransferFetchBodyResult>;

export const isTransferFetchBodyResult = v.object({
  data: v.string(MAX_FETCH_BODY_BASE64),
});

/**
 * `tagread:*` — the `TagReaderPort` read plane for granted trees.
 * `treeUri` is an opaque grant handle minted by `local:add`; every
 * batch is bounded so a hostile or corrupted tree can't smuggle
 * unbounded work across the boundary.
 */
export const MAX_TAGREAD_BATCH = 64;
const MAX_DOC_ID = 4096;
export const MAX_ENUM_ENTRIES = 50_000;
export const MAX_TAG_FIELD = 4096;

export type TagreadEnumerateArgs = v.Guarded<
  typeof isTagreadEnumerateArgs
>;

export const isTagreadEnumerateArgs = v.object({
  treeUri: v.boundedString(MAX_DOC_ID),
});

const isLocalEntryPayload = v.object({
  docId: v.boundedString(MAX_DOC_ID),
  name: v.boundedString(1024),
  size: v.int(),
  mime: v.boundedString(128),
  modifiedMs: v.nullable(v.int()),
});

type TagreadEnumerateResult = v.Guarded<
  typeof isTagreadEnumerateResult
>;

export const isTagreadEnumerateResult = v.object({
  entries: v.array(isLocalEntryPayload, { max: MAX_ENUM_ENTRIES }),
});

export type TagreadBatchArgs = v.Guarded<typeof isTagreadBatchArgs>;

export const isTagreadBatchArgs = v.object({
  treeUri: v.boundedString(MAX_DOC_ID),
  docIds: v.array(v.boundedString(MAX_DOC_ID), {
    max: MAX_TAGREAD_BATCH,
  }),
});

const isFileFingerprintPayload = v.object({
  docId: v.boundedString(MAX_DOC_ID),
  fingerprint: v.boundedString(128),
});

type TagreadFingerprintResult = v.Guarded<
  typeof isTagreadFingerprintResult
>;

export const isTagreadFingerprintResult = v.object({
  fingerprints: v.array(v.nullable(isFileFingerprintPayload), {
    max: MAX_TAGREAD_BATCH,
  }),
});

const isLocalTagsPayload = v.object({
  docId: v.boundedString(MAX_DOC_ID),
  title: v.nullable(v.boundedString(MAX_TAG_FIELD)),
  artist: v.nullable(v.boundedString(MAX_TAG_FIELD)),
  album: v.nullable(v.boundedString(MAX_TAG_FIELD)),
  durationMs: v.nullable(v.int()),
  genre: v.nullable(v.boundedString(MAX_TAG_FIELD)),
  artworkUri: v.nullable(v.boundedString(MAX_DOC_ID)),
});

type TagreadReadResult = v.Guarded<typeof isTagreadReadResult>;

export const isTagreadReadResult = v.object({
  tags: v.array(v.nullable(isLocalTagsPayload), {
    max: MAX_TAGREAD_BATCH,
  }),
});

/**
 * `local:*` — the desktop local-files surface. `local:add` validates
 * renderer-picked paths and mints the treeUri/label descriptors the
 * engine's `addFolder` commits; probe/playback back the renderer's
 * `localPlaybackFor` hook; sweep is the startup integrity reporter.
 */
const MAX_LOCAL_PATHS = 1024;
const MAX_LOCAL_PATH = 4096;
const MAX_PLAYBACK_ENTRIES = 100_000;

export type LocalAddArgs = v.Guarded<typeof isLocalAddArgs>;

export const isLocalAddArgs = v.object({
  paths: v.array(v.boundedString(MAX_LOCAL_PATH), {
    min: 1,
    max: MAX_LOCAL_PATHS,
  }),
});

export type LocalPicksArgs = v.Guarded<typeof isLocalPicksArgs>;

/** `local:picks` — main attests the paths an OS dialog produced.
 *  Same shape as `local:add`: a bounded absolute-path list. */
export const isLocalPicksArgs = v.object({
  paths: v.array(v.boundedString(MAX_LOCAL_PATH), {
    min: 1,
    max: MAX_LOCAL_PATHS,
  }),
});

export type LocalPickPayload = v.Guarded<typeof isLocalPickPayload>;

const isLocalPickPayload = v.object({
  treeUri: v.boundedString(MAX_LOCAL_PATH + 16),
  label: v.boundedString(1024),
  kind: v.literals('dir', 'file'),
});

type LocalAddResult = v.Guarded<typeof isLocalAddResult>;

export const isLocalAddResult = v.object({
  picks: v.array(isLocalPickPayload, { max: MAX_LOCAL_PATHS }),
});

export type LocalProbeArgs = v.Guarded<typeof isLocalProbeArgs>;

export const isLocalProbeArgs = v.object({
  recordingId: v.boundedString(512),
});

const MAX_LOCAL_URI = 8192;

export type LocalResolveArgs = v.Guarded<typeof isLocalResolveArgs>;

export const isLocalResolveArgs = v.object({
  uri: v.boundedString(MAX_LOCAL_URI),
});

type LocalResolveResult = v.Guarded<typeof isLocalResolveResult>;

export const isLocalResolveResult = v.object({
  uri: v.nullable(v.boundedString(MAX_LOCAL_URI)),
});

export type LocalReadArgs = v.Guarded<typeof isLocalReadArgs>;

export const isLocalReadArgs = v.object({
  uri: v.boundedString(MAX_LOCAL_URI),
  position: v.refine(v.int(), (n) => n >= 0),
  maxLen: v.refine(v.int(), (n) => n > 0 && n <= MAX_READ_LEN),
});

type LocalReadResult = v.Guarded<typeof isLocalReadResult>;

export const isLocalReadResult = v.object({
  data: v.string(MAX_READ_LEN * 2),
});

type LocalProbeResult = v.Guarded<typeof isLocalProbeResult>;

export const isLocalProbeResult = v.object({
  uri: v.nullable(
    v.refine(v.boundedString(MAX_LOCAL_PATH + 16), (uri) =>
      uri.startsWith('file://'),
    ),
  ),
});

const isLocalSourcePayload = v.object({
  sourceId: v.boundedString(128),
  treeUri: v.boundedString(MAX_LOCAL_PATH + 16),
  label: v.boundedString(1024),
  addedMs: v.int(),
  lastScanMs: v.nullable(v.int()),
  fileCount: v.int(),
});

type LocalListResult = v.Guarded<typeof isLocalListResult>;

export const isLocalListResult = v.object({
  sources: v.array(isLocalSourcePayload, { max: MAX_LIST_ENTRIES }),
});

const isLocalPlaybackEntry = v.object({
  recordingId: v.boundedString(512),
  uri: v.refine(v.boundedString(MAX_LOCAL_PATH + 16), (uri) =>
    uri.startsWith('file://'),
  ),
});

type LocalPlaybackResult = v.Guarded<typeof isLocalPlaybackResult>;

export const isLocalPlaybackResult = v.object({
  entries: v.array(isLocalPlaybackEntry, {
    max: MAX_PLAYBACK_ENTRIES,
  }),
});

type LocalSweepResult = v.Guarded<typeof isLocalSweepResult>;

export const isLocalSweepResult = v.object({
  missing: v.int(),
  sources: v.array(
    v.object({
      sourceId: v.boundedString(128),
      missing: v.int(),
    }),
    { max: MAX_LIST_ENTRIES },
  ),
});

// ------------------------------------------------------------------
// auth:* — OAuth session-trust surface. The renderer sees status
// snapshots and verbs only; refresh/access tokens never cross this
// boundary (custody + token exchange live in utility/main).
// ------------------------------------------------------------------

const isAuthStatusPayload = v.union(
  v.object({ state: v.literal('signed-out') }),
  v.object({ state: v.literal('starting') }),
  v.object({
    state: v.literal('authorizing'),
    userCode: v.boundedString(64),
    verificationUrl: v.boundedString(512),
    expiresAtMs: v.finite(),
  }),
  v.object({ state: v.literal('signed-in') }),
  v.object({
    state: v.literal('failed'),
    error: v.object({
      kind: v.boundedString(64),
      message: v.boundedString(1024),
      retryable: v.boolean(),
      retryAfterMs: v.optional(v.finite()),
    }),
  }),
);

/** `auth:status` reply + `auth:state` push payload. */
export const isAuthSnapshot = v.object({
  status: isAuthStatusPayload,
  /** The user-supplied client_id override — null = built-in default. */
  clientId: v.nullable(v.boundedString(512)),
  /** Live access token in the host slot — signed-in && false = dead link. */
  bearerLive: v.boolean(),
});

export type AuthSnapshotPayload = v.Guarded<typeof isAuthSnapshot>;

export type AuthSetClientArgs = v.Guarded<typeof isAuthSetClientArgs>;

export const isAuthSetClientArgs = v.object({
  clientId: v.nullable(v.boundedString(512)),
});

export type AuthOpenUrlArgs = v.Guarded<typeof isAuthOpenUrlArgs>;

export const isAuthOpenUrlArgs = v.object({
  url: v.boundedString(2048),
});

// ------------------------------------------------------------------
// update:* — release update check. Snapshots + verbs only; the egress
// and the open-target allowlist live in main.
// ------------------------------------------------------------------

const isUpdateArtifact = v.object({
  name: v.boundedString(256),
  url: v.boundedString(2048),
});

const isUpdateErrorPayload = v.object({
  kind: v.boundedString(64),
  message: v.boundedString(1024),
  retryable: v.boolean(),
  retryAfterMs: v.optional(v.finite()),
});

const isUpdateStatusPayload = v.union(
  v.object({ state: v.literal('idle') }),
  v.object({ state: v.literal('checking') }),
  v.object({ state: v.literal('current') }),
  v.object({
    state: v.literal('available'),
    version: v.boundedString(64),
    url: v.boundedString(2048),
    artifact: v.nullable(isUpdateArtifact),
    checksums: v.nullable(isUpdateArtifact),
  }),
  v.object({
    state: v.literal('failed'),
    error: isUpdateErrorPayload,
  }),
);

const isUpdateApplyPayload = v.union(
  v.object({ state: v.literal('idle') }),
  v.object({
    state: v.literal('downloading'),
    version: v.boundedString(64),
    receivedBytes: v.finite(),
    totalBytes: v.nullable(v.finite()),
  }),
  v.object({ state: v.literal('verifying'), version: v.boundedString(64) }),
  v.object({ state: v.literal('applying'), version: v.boundedString(64) }),
  v.object({
    state: v.literal('ready-to-restart'),
    version: v.boundedString(64),
  }),
  v.object({ state: v.literal('applied'), version: v.boundedString(64) }),
  v.object({
    state: v.literal('needs-permission'),
    version: v.boundedString(64),
  }),
  v.object({
    state: v.literal('failed'),
    version: v.boundedString(64),
    error: isUpdateErrorPayload,
  }),
);

/** `update:status` reply + `update:state` push payload. */
export const isUpdateSnapshot = v.object({
  status: isUpdateStatusPayload,
  currentVersion: v.boundedString(64),
  apply: isUpdateApplyPayload,
  /** How far `update:apply` can honestly take this build — main's own
      verdict, not a renderer request. */
  capability: v.literals('open', 'download', 'install'),
});

export type UpdateSnapshotPayload = v.Guarded<typeof isUpdateSnapshot>;

export const isUpdateCheckArgs = v.object({
  kind: v.literals('boot', 'manual'),
});

export type UpdateCheckArgs = v.Guarded<typeof isUpdateCheckArgs>;

/**
 * The `window.auqw` surface the preload exposes. Every method resolves
 * with a validated payload and rejects with a `ShellError`-shaped value.
 */
export type AuqwApi = {
  readonly app: {
    readonly meta: () => Promise<AppMeta>;
  };
  readonly chrome: {
    /** `process.platform` captured in preload — the sandboxed renderer
        cannot read it itself but needs it for platform chrome tweaks. */
    readonly platform: string;
    /** Caption-button op — main applies it to the sender's window.
        One-way send; nothing to await. */
    readonly control: (op: WindowControlPayload['op']) => void;
    /** Main→renderer push of the maximize state — toggles the
        maximize↔restore glyph. Unsubscribes on the returned call. */
    readonly onState: (
      listener: (event: WindowStateEvent) => void,
    ) => () => void;
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
  readonly theme: {
    /** Subscribes to OS theme-source pushes; the current source is
        delivered immediately. */
    readonly subscribe: (
      listener: (event: ThemeSourceEvent) => void,
    ) => () => void;
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
    readonly probe: (args: StreamProbeArgs) => Promise<StreamProbeResult>;
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
    readonly sweepFinalized: (
      args: TransferSweepArgs,
    ) => Promise<TransferSweepResult>;
    readonly list: () => Promise<TransferListResult>;
    readonly status: (args: TransferSinkArgs) => Promise<TransferStatusResult>;
    readonly stats: () => Promise<TransferStatsResult>;
    readonly fetch: (args: TransferFetchArgs) => Promise<TransferFetchResult>;
    readonly fetchBody: (
      args: TransferFetchIdArgs,
    ) => Promise<TransferFetchBodyResult>;
    readonly fetchAbort: (args: TransferFetchIdArgs) => Promise<void>;
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
    readonly resolve: (
      args: LocalResolveArgs,
    ) => Promise<LocalResolveResult>;
    readonly read: (args: LocalReadArgs) => Promise<LocalReadResult>;
    readonly list: () => Promise<LocalListResult>;
    readonly playback: () => Promise<LocalPlaybackResult>;
    readonly sweep: () => Promise<LocalSweepResult>;
  };
  /**
   * OAuth session trust — status snapshots + flow verbs only. Token
   * material never crosses: custody lives in main's sealed store and
   * the token exchange runs in the utility process.
   */
  readonly auth: {
    readonly status: () => Promise<AuthSnapshotPayload>;
    readonly begin: () => Promise<void>;
    readonly cancel: () => Promise<void>;
    readonly signOut: () => Promise<void>;
    /** The advanced client_id override — null restores the default. */
    readonly setClient: (clientId: string | null) => Promise<void>;
    /** Forces an immediate renewal attempt — the linked-but-dead
     *  recovery affordance. */
    readonly retry: () => Promise<void>;
    /** Opens the device-flow verification URL — allowlisted in main. */
    readonly openUrl: (url: string) => Promise<void>;
    readonly onState: (
      listener: (snapshot: AuthSnapshotPayload) => void,
    ) => () => void;
  };
  /**
   * Release update check — status snapshots + the check/open verbs.
   * `open` takes no URL: main opens the release page its own
   * snapshot recorded (allowlisted to the repo's releases).
   */
  readonly update: {
    readonly status: () => Promise<UpdateSnapshotPayload>;
    readonly check: (
      kind: UpdateCheckArgs['kind'],
    ) => Promise<UpdateSnapshotPayload>;
    /** Opens the available release's page (or the releases index). */
    readonly open: () => Promise<void>;
    /** Begins the download→verify→apply pipeline — real only past
        the 'open' capability, a main-side refusal otherwise. */
    readonly apply: () => Promise<void>;
    /** Refires the install handoff on the retained stage — valid
        only inside 'applied' (re-opens the mounted dmg window). */
    readonly reapply: () => Promise<void>;
    /** Aborts the live apply. */
    readonly cancel: () => Promise<void>;
    /** Relaunches into the replaced build — valid only inside
        'ready-to-restart' (AppImage leg, assisted dmg install). */
    readonly restart: () => Promise<void>;
    readonly onState: (
      listener: (snapshot: UpdateSnapshotPayload) => void,
    ) => () => void;
  };
};

declare global {
  interface Window {
    auqw: AuqwApi;
  }
}
