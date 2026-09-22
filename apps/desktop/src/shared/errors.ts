import { isBoolean, isBoundedString, isRecord } from './check.ts';

export type ShellErrorKind =
  | 'invalid-request'
  | 'invalid-response'
  | 'not-implemented'
  | 'unavailable'
  | 'process-crashed'
  | 'released'
  | 'cancelled'
  | 'corrupt-state'
  | 'io-error'
  | 'internal';

export type ShellError = {
  readonly kind: ShellErrorKind;
  readonly message: string;
  readonly retryable: boolean;
};

const RETRYABLE: ReadonlySet<ShellErrorKind> = new Set([
  'unavailable',
  'process-crashed',
  'io-error',
  'internal',
]);

export function shellError(
  kind: ShellErrorKind,
  message: string,
): ShellError {
  return { kind, message, retryable: RETRYABLE.has(kind) };
}

const ERROR_KINDS: ReadonlySet<string> = new Set([
  'invalid-request',
  'invalid-response',
  'not-implemented',
  'unavailable',
  'process-crashed',
  'released',
  'cancelled',
  'corrupt-state',
  'io-error',
  'internal',
]);

export function isShellError(value: unknown): value is ShellError {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['kind'] === 'string' &&
    ERROR_KINDS.has(value['kind']) &&
    isBoundedString(value['message'], 2048) &&
    isBoolean(value['retryable'])
  );
}

/**
 * Maps an unexpected thrown value crossing a boundary to a fixed
 * internal error. The raw value is never carried across the boundary.
 */
export function fromUnknown(thrown: unknown): ShellError {
  void thrown;
  return shellError('internal', 'unexpected shell failure');
}
