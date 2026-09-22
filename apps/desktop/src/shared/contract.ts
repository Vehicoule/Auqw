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
  readonly utility: {
    readonly ping: (message: string) => Promise<UtilityPingResult>;
  };
};

declare global {
  interface Window {
    auqw: AuqwApi;
  }
}
