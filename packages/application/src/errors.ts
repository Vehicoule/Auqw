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
  | 'provider-wall'
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

/**
 * A wire `kind` slug: every taxonomy kind is its own slug, plus the
 * host-side transport kinds the seam folds onto the taxonomy.
 */
export type ErrorSlug =
  | ErrorKind
  | 'io-error'
  | 'invalid-request'
  | 'not-implemented'
  | 'process-crashed'
  | 'corrupt-state';

/**
 * Canonical slug → kind table for every boundary that receives a
 * `kind` string over the wire (desktop host IPC, the mobile seam,
 * prepare/status payloads). Anything outside the table degrades to
 * `internal` in {@link appErrorKind} — an untyped slug never crosses
 * a port.
 */
export const ERROR_KIND_BY_SLUG: Readonly<Record<ErrorSlug, ErrorKind>> = {
  'no-result': 'no-result',
  'not-applicable': 'not-applicable',
  unsupported: 'unsupported',
  'auth-required': 'auth-required',
  'auth-expired': 'auth-expired',
  'rate-limit': 'rate-limit',
  transient: 'transient',
  'provider-wall': 'provider-wall',
  'expired-resource': 'expired-resource',
  'permission-denied': 'permission-denied',
  'invalid-response': 'invalid-response',
  timeout: 'timeout',
  cancelled: 'cancelled',
  'budget-exceeded': 'budget-exceeded',
  'guest-trap': 'guest-trap',
  'invalid-message': 'invalid-message',
  'artifact-rejected': 'artifact-rejected',
  'streams-capped': 'streams-capped',
  released: 'released',
  superseded: 'superseded',
  evicted: 'evicted',
  expired: 'expired',
  'not-found': 'not-found',
  unavailable: 'unavailable',
  'storage-full': 'storage-full',
  'io-error': 'transient',
  'invalid-request': 'invalid-response',
  'not-implemented': 'unavailable',
  'process-crashed': 'unavailable',
  'corrupt-state': 'internal',
  internal: 'internal',
};

/** Maps a wire `kind` slug to the taxonomy; unknown values are `internal`. */
export function appErrorKind(slug: unknown): ErrorKind {
  return typeof slug === 'string' && Object.hasOwn(ERROR_KIND_BY_SLUG, slug)
    ? ERROR_KIND_BY_SLUG[slug as ErrorSlug]
    : 'internal';
}

export function appError(
  kind: ErrorKind,
  message: string,
  retryAfterMs?: number,
): AppError {
  return retryAfterMs === undefined
    ? { kind, message, retryable: RETRYABLE.has(kind) }
    : { kind, message, retryable: RETRYABLE.has(kind), retryAfterMs };
}

/**
 * A provider-side bot wall — the upstream refused the session's
 * visitor/IP itself. Guests on ABI ≥0.3.0 emit the `provider-wall`
 * kind directly; earlier guests wore `transient` plus a `bot-check`
 * detail, and `AppError` carries no detail field — but every leg
 * between the guest and the engine prepends its own `{kind}: ` prefix
 * to the message, so the legacy detail survives as the LAST
 * `:`-separated segment (`"guest failure (transient): transient:
 * bot-check"`). Both shapes are the same verdict: per-IP/per-visitor
 * provider truth, not weather — in-invocation retries spend no calls
 * on it and the row stays unmarked; the attempt's alternate-ref hop
 * still treats it as worth one fresh ladder on a different video.
 */
export function isBotCheckWall(error: AppError): boolean {
  return (
    error.kind === 'provider-wall' ||
    (error.kind === 'transient' &&
      error.message.split(':').at(-1)?.trim() === 'bot-check')
  );
}

/**
 * A capped-mint wall — every ladder rung resolved but each minted
 * stream URL refused its boundary probe: `transient` carrying the
 * guest's `streams-capped` detail (same last-segment carry as the
 * legacy bot-check shape). Like the bot wall the verdict is
 * per-mint stochastic, not a verdict on the video: the serving edge
 * refused this visitor/IP's mints. Unlike the bot wall it keeps its
 * auto-retry — redrawing the same ref's ladder mints fresh URLs —
 * and the attempt's alternate-ref hop still treats it as worth one
 * fresh ladder on a different video.
 */
export function isStreamsCappedTransient(error: AppError): boolean {
  return (
    error.kind === 'transient' &&
    error.message.split(':').at(-1)?.trim() === 'streams-capped'
  );
}

/**
 * Verdicts that condemn the row itself — the source is gone,
 * unplayable, or gated. Only these earn the forward-skip flag;
 * every other failure still pauses the queue on its typed verdict
 * but leaves the row in the walk. Shared by the engine's mark
 * policy and the shells' advance gate — the two walks must agree.
 */
const PERMANENT_FAILURE_KINDS: ReadonlySet<ErrorKind> = new Set([
  'not-found',
  'unsupported',
  'no-result',
  'auth-required',
  'expired-resource',
]);

export function isPermanentFailure(error: AppError): boolean {
  return PERMANENT_FAILURE_KINDS.has(error.kind);
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(error: AppError): Result<never> {
  return { ok: false, error };
}

/** The 'cancelled' shape every op surfaces on a fired signal. */
export function cancelledError(): AppError {
  return appError('cancelled', 'cancelled');
}

/**
 * Maps an unexpected thrown value crossing a port boundary to a fixed
 * internal error. The raw value is never carried across the port.
 */
export function fromUnknown(thrown: unknown): AppError {
  void thrown;
  return appError('internal', 'unexpected port failure');
}
