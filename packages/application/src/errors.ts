export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AppError };

export type ErrorKind =
  | 'no-result'
  | 'not-applicable'
  | 'unsupported'
  | 'auth-required'
  | 'auth-expired'
  | 'rate-limit'
  | 'transient'
  | 'expired-resource'
  | 'permission-denied'
  | 'invalid-response'
  | 'timeout'
  | 'cancelled'
  | 'budget-exceeded'
  | 'guest-trap'
  | 'invalid-message'
  | 'artifact-rejected'
  | 'streams-capped'
  | 'released'
  | 'superseded'
  | 'evicted'
  | 'expired'
  | 'not-found'
  | 'unavailable'
  | 'storage-full'
  | 'internal';

export type AppError = {
  readonly kind: ErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
};

const RETRYABLE: ReadonlySet<ErrorKind> = new Set([
  'rate-limit',
  'transient',
  'expired-resource',
  'timeout',
  'streams-capped',
  'expired',
  'internal',
]);

export function appError(
  kind: ErrorKind,
  message: string,
  retryAfterMs?: number,
): AppError {
  const error: AppError =
    retryAfterMs === undefined
      ? { kind, message, retryable: RETRYABLE.has(kind) }
      : { kind, message, retryable: RETRYABLE.has(kind), retryAfterMs };
  return error;
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(error: AppError): Result<never> {
  return { ok: false, error };
}

/**
 * Maps an unexpected thrown value crossing a port boundary to a fixed
 * internal error. The raw value is never carried across the port.
 */
export function fromUnknown(thrown: unknown): AppError {
  void thrown;
  return appError('internal', 'unexpected port failure');
}
