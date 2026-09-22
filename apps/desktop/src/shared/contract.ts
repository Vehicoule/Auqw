import {
  hasOnlyKeys,
  isBoolean,
  isBoundedString,
  isRecord,
  isStringOrUndefined,
} from './check.ts';

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
  readonly utility: {
    readonly ping: (message: string) => Promise<UtilityPingResult>;
  };
};

declare global {
  interface Window {
    auqw: AuqwApi;
  }
}
