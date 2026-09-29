import { appError, cancelledError, err, ok } from './errors.ts';
import type { AppError, Result } from './errors.ts';
import { CancellationSource } from './cancellation.ts';
import type { CancellationSignal } from './cancellation.ts';
import type { ClockPort } from './ports/clock.ts';
import { isSafeNonNegative } from './domain.ts';
import { internalError, timeoutError } from './session/util.ts';

/**
 * Bounded retry for port calls that already carry an absolute
 * deadline (docs/specs/playback.md: one attempt's budget includes
 * its retries). Every attempt shares the same `deadlineMs` — a
 * retry can never outlive the operation it serves — and
 * `retryAfterMs` is honored as a minimum wait, compared against the
 * remaining budget: a server-asked wait longer than the deadline
 * has left surfaces the failure instead of sleeping past it.
 *
 * The deadline binds the calls too, not just their scheduling: each
 * invocation rides a child signal cancelled when the budget dies,
 * and the wait races the remaining time so a hung port promise
 * surfaces `timeout` rather than pinning the loop.
 *
 * Only `error.retryable` kinds retry — the taxonomy decides — so
 * cancellation, no-result, and validation failures pass through
 * untouched. Backoff doubles per attempt, is capped, and sleeps
 * through the caller's signal so a supersede or teardown abandons
 * the wait immediately.
 */
export type RetryOptions = {
  /**
   * Absolute epoch-ms deadline shared by every attempt. Read fresh
   * at each attempt and each watchdog wake, so a dynamic value (a
   * shared record's live max) may move it forward — never earlier.
   */
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
  const nowMs = (): number | undefined => {
    try {
      const n = opts.clock.nowMs();
      return isSafeNonNegative(n) ? n : undefined;
    } catch {
      return undefined;
    }
  };
  let lastError: AppError = timeoutError();
  for (let attempt = 1; ; attempt += 1) {
    // A cancellation landing after a successful backoff must not
    // spend another port call — the signal is consulted at every
    // attempt, not only through the backoff sleep.
    if (opts.signal.cancelled) {
      return err(cancelledError());
    }
    const now = nowMs();
    if (now === undefined) {
      return err(internalError());
    }
    const remaining = opts.deadlineMs - now;
    if (remaining <= 0) {
      return err(attempt > 1 ? lastError : timeoutError());
    }
    // The deadline binds the call itself, not only attempt starts:
    // the call races a sleep of the remaining budget on a child
    // signal — a hung port promise loses the race, gets cancelled,
    // and surfaces 'timeout' instead of pinning the loop forever.
    const attemptSource = new CancellationSource();
    const watchdog = new CancellationSource();
    // A parent cancel must wake the race too — it cancels the call's
    // signal and aborts the deadline sleep so the loop unwinds
    // immediately instead of waiting the remaining budget out.
    const unbind = opts.signal.subscribe(() => {
      attemptSource.cancel();
      watchdog.cancel();
    });
    // The call starts synchronously (callers rely on the port being
    // hit before `search()` returns); a synchronous throw still
    // unwinds the subscription before propagating.
    let callP: Promise<{ tag: 'call'; result: Result<T> } | { tag: 'call'; thrown: unknown }>;
    try {
      callP = opts.call(attemptSource.signal, attempt).then(
        (result) => ({ tag: 'call' as const, result }),
        (thrown: unknown) => ({ tag: 'call' as const, thrown }),
      );
    } catch (thrown) {
      unbind();
      throw thrown;
    }
    // The bound is re-read after every wake: callers sharing one
    // record across waiters (artwork inflight) may move the deadline
    // forward mid-attempt, and an early wake then re-arms instead of
    // firing on a stale bound.
    const watchdogP = (async () => {
      for (; ;) {
        const wokeAt = nowMs();
        if (wokeAt === undefined) {
          return { tag: 'sleep' as const, slept: err(internalError()) };
        }
        if (opts.deadlineMs - wokeAt <= 0) {
          // The budget died during the call. A call that consumed it
          // synchronously may settle this same microtask — yield once
          // so its own verdict wins the race, then confirm the bound
          // is still dead (a live getter may have moved it forward).
          await Promise.resolve();
          const recheck = nowMs();
          if (recheck === undefined || opts.deadlineMs - recheck <= 0) {
            return { tag: 'sleep' as const, slept: ok(undefined) };
          }
          continue;
        }
        const slept = await opts.clock.sleep(
          opts.deadlineMs - wokeAt,
          watchdog.signal,
        );
        if (!slept.ok) {
          return { tag: 'sleep' as const, slept };
        }
      }
    })();
    const winner = await Promise.race([callP, watchdogP]);
    watchdog.cancel();
    unbind();
    if (winner.tag === 'sleep') {
      attemptSource.cancel();
      return err(winner.slept.ok ? timeoutError() : winner.slept.error);
    }
    if ('thrown' in winner) {
      throw winner.thrown;
    }
    const result = winner.result;
    if (result.ok) {
      return result;
    }
    lastError = result.error;
    if (!result.error.retryable || attempt >= maxAttempts) {
      return result;
    }
    const now2 = nowMs();
    if (now2 === undefined) {
      return err(internalError());
    }
    const budgetLeft = opts.deadlineMs - now2;
    if (budgetLeft <= 0) {
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
    if (wait >= budgetLeft) {
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
