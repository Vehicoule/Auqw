import { isBoolean, isBoundedString, isRecord } from './check.ts';

const ERROR_KINDS = [
  'invalid-request',
  'invalid-response',
  'not-implemented',
  'unavailable',
  'process-crashed',
  'released',
  'cancelled',
  'corrupt-state',
  'io-error',
  // The stream seam's own kinds — the napi slugs ride the envelope
  // verbatim so both renderer maps land on the same app kind.
  'transient',
  'rate-limit',
  'auth-required',
  'permission-denied',
  'storage-full',
  'internal',
] as const;

export type ShellErrorKind = (typeof ERROR_KINDS)[number];

export type ShellError = {
  readonly kind: ShellErrorKind;
  readonly message: string;
  readonly retryable: boolean;
};

const ERROR_KIND_SET: ReadonlySet<string> = new Set(ERROR_KINDS);

const RETRYABLE: ReadonlySet<ShellErrorKind> = new Set([
  'unavailable',
  'process-crashed',
  'io-error',
  'transient',
  'rate-limit',
  'internal',
]);

export function shellError(
  kind: ShellErrorKind,
  message: string,
): ShellError {
  return { kind, message, retryable: RETRYABLE.has(kind) };
}

export function isShellError(value: unknown): value is ShellError {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['kind'] === 'string' &&
    ERROR_KIND_SET.has(value['kind']) &&
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
