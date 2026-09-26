import { appError, err } from './errors.ts';
import type { AppError, Result } from './errors.ts';
import type { CancellationSignal } from './cancellation.ts';
import type { ClockPort } from './ports/clock.ts';
import { isSafeNonNegative } from './domain.ts';

/**
 * Bounded retry for port calls that already carry an absolute
 * deadline (docs/specs/playback.md: one attempt's budget includes
 * its retries). Every attempt shares the same `deadlineMs` — a
 * retry can never outlive the operation it serves — and
 * `retryAfterMs` is honored as a minimum wait, compared against the
 * remaining budget: a server-asked wait longer than the deadline
 * has left surfaces the failure instead of sleeping past it.
 *
 * Only `error.retryable` kinds retry — the taxonomy decides — so
 * cancellation, no-result, and validation failures pass through
 * untouched. Backoff doubles per attempt, is capped, and sleeps
 * through the caller's signal so a supersede or teardown abandons
 * the wait immediately.
 */
export type RetryOptions = {
  /** Absolute epoch-ms deadline shared by every attempt. */
  readonly deadlineMs: number;
  /** Cancels in-flight calls and any pending backoff. */
  readonly signal: CancellationSignal;
  readonly clock: ClockPort;
  /** Total attempts including the first; must be >= 1. Default 2. */
  readonly maxAttempts?: number;
  /** First backoff in ms; doubles per retry. Default 300. */
  readonly baseBackoffMs?: number;
};

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 5_000;

function timeoutError(): AppError {
  return appError('timeout', 'operation deadline exceeded');
}

function internalError(): AppError {
  return appError('internal', 'an internal error occurred');
}

/**
 * Runs `call` up to `maxAttempts` times while failures stay
 * retryable and budget remains. The thunk receives the caller's
 * signal and the 1-based attempt number so per-attempt contexts can
 * mint fresh request ids. When the budget is spent mid-retry the
 * last provider verdict stands; a deadline already dead on entry is
 * a timeout.
 *
 * Option values cross a public boundary, so they are normalized
 * before use: a non-finite `deadlineMs` binds nothing and is an
 * internal defect; a `maxAttempts` that is not a finite integer >= 1
 * or a `baseBackoffMs` that is not finite and >= 0 falls back to the
 * defaults rather than silently disabling the bounds.
 */
export async function retryBounded<T>(
  opts: RetryOptions & {
    readonly call: (
      signal: CancellationSignal,
      attempt: number,
    ) => Promise<Result<T>>;
  },
): Promise<Result<T>> {
  if (!Number.isFinite(opts.deadlineMs)) {
    return err(internalError());
  }
  const maxAttempts =
    opts.maxAttempts !== undefined &&
      Number.isFinite(opts.maxAttempts) &&
      opts.maxAttempts >= 1
      ? Math.floor(opts.maxAttempts)
      : DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs =
    opts.baseBackoffMs !== undefined &&
      Number.isFinite(opts.baseBackoffMs) &&
      opts.baseBackoffMs >= 0
      ? opts.baseBackoffMs
      : DEFAULT_BACKOFF_MS;
  let lastError: AppError = timeoutError();
  for (let attempt = 1; ; attempt += 1) {
    let now: number;
    try {
      now = opts.clock.nowMs();
    } catch {
      return err(internalError());
    }
    if (!isSafeNonNegative(now)) {
      return err(internalError());
    }
    if (opts.deadlineMs - now <= 0) {
      return err(attempt > 1 ? lastError : timeoutError());
    }
    const result = await opts.call(opts.signal, attempt);
    if (result.ok) {
      return result;
    }
    lastError = result.error;
    if (!result.error.retryable || attempt >= maxAttempts) {
      return result;
    }
    let now2: number;
    try {
      now2 = opts.clock.nowMs();
    } catch {
      return err(internalError());
    }
    if (!isSafeNonNegative(now2)) {
      return err(internalError());
    }
    const remaining = opts.deadlineMs - now2;
    if (remaining <= 0) {
      // The attempt consumed the whole budget — its verdict stands.
      return result;
    }
    // retryAfterMs is the server's minimum wait — a floor, never
    // clamped down. Only the self-computed backoff gets the cap. A
    // non-finite hint expresses a wait no budget can hold — the
    // verdict stands; a negative one floors at zero.
    const backoff = Math.min(
      baseBackoffMs * Math.pow(2, attempt - 1),
      MAX_BACKOFF_MS,
    );
    const asked = result.error.retryAfterMs;
    const floor =
      asked === undefined
        ? 0
        : !Number.isFinite(asked)
          ? Number.POSITIVE_INFINITY
          : Math.max(0, asked);
    const wait = Math.max(floor, backoff);
    if (wait >= remaining) {
      // The asked-for wait outlives the budget — retrying into a
      // dead deadline can only time out.
      return result;
    }
    const slept = await opts.clock.sleep(wait, opts.signal);
    if (!slept.ok) {
      // A cancelled backoff ends the operation with cancellation;
      // a dead clock is internal. Anything else keeps the last
      // failure as the verdict.
      return slept.error.kind === 'cancelled' ||
        slept.error.kind === 'internal'
        ? err(slept.error)
        : err(lastError);
    }
  }
}
