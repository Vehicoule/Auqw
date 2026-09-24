import { isRecord } from './check.ts';
import type { ShellError } from './errors.ts';
import { isShellError } from './errors.ts';

/**
 * Every boundary in the shell answers with the same result envelope —
 * `ipcMain.handle` replies, utility-process replies, and preload
 * unwrapping all share this shape.
 */
export type ResultEnvelope<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: ShellError };

export function ok<T>(result: T): ResultEnvelope<T> {
  return { ok: true, result };
}

export function fail(error: ShellError): ResultEnvelope<never> {
  return { ok: false, error };
}

export function isResultEnvelope(
  value: unknown,
): value is ResultEnvelope<unknown> {
  if (!isRecord(value)) {
    return false;
  }
  if (value['ok'] === true) {
    return Object.hasOwn(value, 'result');
  }
  if (value['ok'] === false) {
    return isShellError(value['error']);
  }
  return false;
}
