import type {
  AppError,
  CancellationSignal,
  ErrorKind,
  Result,
} from '@auqw/application';
import {
  appError,
  appErrorKind,
  err,
  fromUnknown,
  ok,
  raced,
} from '@auqw/application';
import type { ShellErrorKind } from '../shared/errors.ts';
import { isShellError } from '../shared/errors.ts';
import { isRecord } from '../shared/check.ts';

/**
 * Shell→application error-kind map for the port adapters. The shell's
 * kinds are deliberately narrower than the app's — every mapping is a
 * lossy step UP into the app's taxonomy, chosen so the engines still
 * see the semantics they branch on (`permission-denied` for a revoked
 * grant, `storage-full` for ENOSPC, `invalid-response` for contract
 * violations). Kinds a stream/host op can emit must agree with
 * `ERROR_KIND_BY_SLUG` (which `rawToAppError` applies on the stream
 * legs) — the same rejection crossed both maps and read `internal`
 * here but `transient` there.
 */
const SHELL_TO_APP: Readonly<Record<ShellErrorKind, ErrorKind>> = {
  'invalid-request': 'invalid-message',
  'invalid-response': 'invalid-response',
  'not-implemented': 'not-applicable',
  unavailable: 'unavailable',
  'process-crashed': 'unavailable',
  released: 'released',
  cancelled: 'cancelled',
  'corrupt-state': 'internal',
  'io-error': 'transient',
  transient: 'transient',
  'rate-limit': 'rate-limit',
  'auth-required': 'auth-required',
  'streams-capped': 'streams-capped',
  'permission-denied': 'permission-denied',
  'storage-full': 'storage-full',
  internal: 'internal',
};

/** A rejected `api.*` call becomes a typed `AppError` for the port. */
export function shellToAppError(thrown: unknown): AppError {
  if (isShellError(thrown)) {
    return appError(SHELL_TO_APP[thrown.kind], thrown.message);
  }
  return fromUnknown(thrown);
}

/** A raw bridge rejection: the record's kind slug maps through the
 * taxonomy and its message survives; a non-record reads `internal`
 * with the call site's fallback. */
export function rawToAppError(thrown: unknown, fallback: string): AppError {
  if (isRecord(thrown)) {
    const message = thrown['message'];
    return appError(
      appErrorKind(thrown['kind']),
      typeof message === 'string' && message.length > 0
        ? message
        : fallback,
    );
  }
  return appError('internal', fallback);
}

/** The cancelled pre-check every observed IPC op starts with. */
export function ifCancelled(
  signal: CancellationSignal,
): Result<never> | null {
  return signal.cancelled
    ? err(appError('cancelled', 'cancelled'))
    : null;
}

/** Race a read-only IPC call against the caller's signal, settling
 * typed — `cancelled` on the race loss, the shell map on rejection. */
export async function settleIpc<T>(
  call: Promise<T>,
  signal: CancellationSignal,
): Promise<Result<T>> {
  const outcome = await raced(call, signal);
  if (outcome.t === 'cancelled') {
    return err(appError('cancelled', 'cancelled'));
  }
  if (outcome.t === 'failed') {
    return err(shellToAppError(outcome.thrown));
  }
  return ok(outcome.value);
}
