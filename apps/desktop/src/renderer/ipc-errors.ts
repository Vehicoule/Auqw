import type { AppError, ErrorKind } from '@auqw/application';
import { appError, fromUnknown } from '@auqw/application';
import type { ShellErrorKind } from '../shared/errors.ts';
import { isShellError } from '../shared/errors.ts';

/**
 * Shell→application error-kind map for the port adapters. The shell's
 * kinds are deliberately narrower than the app's — every mapping is a
 * lossy step UP into the app's taxonomy, chosen so the engines still
 * see the semantics they branch on (`permission-denied` for a revoked
 * grant, `storage-full` for ENOSPC, `invalid-response` for contract
 * violations).
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
  'io-error': 'internal',
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
