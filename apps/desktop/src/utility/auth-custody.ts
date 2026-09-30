import type {
  AppError,
  AuthCustody,
  AuthCustodyRecord,
} from '@auqw/application';
import {
  appError,
  appErrorKind,
  err,
  isAuthCustodyRecord,
  ok,
} from '@auqw/application';
import { hasOnlyKeys, isRecord } from '../shared/check.ts';
import { isShellError } from '../shared/errors.ts';

/**
 * `auth:custody` — the utility→main custody channel for OAuth session
 * trust. Electron's safeStorage exists only in main, so the refresh
 * grant's sealed record crosses this channel exactly like `sync:keys`
 * carries pairing material. The renderer never sees custody contents —
 * its auth surface carries status snapshots and UI verbs only.
 */

export const AUTH_CUSTODY_CHANNEL = 'auth:custody';

export type AuthCustodyOp =
  | { readonly op: 'get' }
  | { readonly op: 'set'; readonly record: AuthCustodyRecord }
  | { readonly op: 'clear' };

export function isAuthCustodyOp(value: unknown): value is AuthCustodyOp {
  if (!isRecord(value) || typeof value['op'] !== 'string') {
    return false;
  }
  switch (value['op']) {
    case 'get':
    case 'clear':
      return hasOnlyKeys(value, ['op']);
    case 'set':
      return (
        hasOnlyKeys(value, ['op', 'record']) &&
        isAuthCustodyRecord(value['record'])
      );
    default:
      return false;
  }
}

/** `{record}` result — null = absent. */
export function isAuthCustodyResult(
  value: unknown,
): value is { readonly record: AuthCustodyRecord | null } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['record']) &&
    (value['record'] === null || isAuthCustodyRecord(value['record']))
  );
}

function custodyError(thrown: unknown): AppError {
  return appError(
    isShellError(thrown) ? appErrorKind(thrown.kind) : 'internal',
    'auth: custody op failed',
  );
}
/**
 * AuthCustody over the service channel — the main side answers from
 * its dedicated auth-secure store. A malformed answer reads as a typed
 * failure, never as a silently empty store (a read-through bug would
 * otherwise sign the user out on every boot).
 */
export function createServiceAuthCustody(
  request: (channel: string, args: unknown) => Promise<unknown>,
): AuthCustody {
  return {
    async read() {
      try {
        const result = await request(AUTH_CUSTODY_CHANNEL, { op: 'get' });
        if (!isAuthCustodyResult(result)) {
          return err(
            appError('invalid-response', 'auth: bad custody reply'),
          );
        }
        return ok(result.record);
      } catch (thrown) {
        return err(custodyError(thrown));
      }
    },
    async write(record) {
      try {
        await request(AUTH_CUSTODY_CHANNEL, { op: 'set', record });
        return ok(undefined);
      } catch (thrown) {
        return err(custodyError(thrown));
      }
    },
    async clear() {
      try {
        await request(AUTH_CUSTODY_CHANNEL, { op: 'clear' });
        return ok(undefined);
      } catch (thrown) {
        return err(custodyError(thrown));
      }
    },
  };
}
