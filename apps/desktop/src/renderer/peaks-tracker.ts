import { CancellationSource } from '@auqw/application';
import type { PeaksPort } from '@auqw/application';

/**
 * What the tracker needs to fetch — the live playback session fields.
 * `id` is the cache identity: the caller builds it as
 * `recordingId|attemptId` so a re-prepared stream (a new attempt, a
 * new handle, possibly new bytes) never inherits peaks — or a cached
 * failure — from the attempt it replaced.
 */
export type PeaksTarget = {
  readonly id: string;
  readonly handle: string;
  readonly durationMs: number | null;
};

/** Canonical 256-float rows are tiny; a dozen tracks is plenty of recency. */
const PEAK_CACHE_LIMIT = 12;
const PEAK_DEADLINE_MS = 30_000;
/**
 * A transient abort (bytes not yet buffered, a stalled fill, a dead
 * handle about to be re-prepared) retries on a delay — each pull is a
 * handful of IPC reads, cheap to re-attempt a few times before the
 * seeded pattern settles.
 */
const PEAK_RETRY_LIMIT = 3;
const PEAK_RETRY_DELAY_MS = 4_000;

type Inflight = {
  readonly source: CancellationSource;
  timer: ReturnType<typeof setTimeout> | null;
};

export type PeaksTrackerDeps = {
  readonly port: PeaksPort;
  /** Fires when a settled result may have changed `get` — re-render. */
  readonly onChange?: (() => void) | undefined;
  readonly cacheLimit?: number;
  readonly deadlineMs?: number;
  readonly retryLimit?: number;
  readonly retryDelayMs?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  readonly now?: () => number;
};

/**
 * Extraction state for waveform peaks, split from the React hook so
 * its lifecycle is unit-testable: `pull` starts or refreshes a
 * recording's extraction, `cancel` abandons one, `get` reads the
 * cache (`undefined` = never fetched or transient-failed, `null` =
 * terminal failure, an array = real peaks). The Map doubles as the
 * LRU — a cache hit reinserts so the least-recently-pulled evicts
 * first.
 */
export function createPeaksTracker(deps: PeaksTrackerDeps): {
  pull(target: PeaksTarget): void;
  cancel(id: string): void;
  get(id: string): readonly number[] | null | undefined;
} {
  const port = deps.port;
  const onChange = deps.onChange;
  const cacheLimit = deps.cacheLimit ?? PEAK_CACHE_LIMIT;
  const deadlineMs = deps.deadlineMs ?? PEAK_DEADLINE_MS;
  const retryLimit = deps.retryLimit ?? PEAK_RETRY_LIMIT;
  const retryDelayMs = deps.retryDelayMs ?? PEAK_RETRY_DELAY_MS;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, readonly number[] | null>();
  const inflight = new Map<string, Inflight>();

  function evict(): void {
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  }

  function pull(target: PeaksTarget): void {
    const { id, handle, durationMs } = target;
    if (cache.has(id)) {
      // Cache hit (including a settled `null`): reinsert so the
      // revisit bumps recency — the Map's iteration order is the LRU
      // order eviction walks.
      const value = cache.get(id);
      cache.delete(id);
      cache.set(id, value === undefined ? null : value);
      return;
    }
    if (inflight.has(id)) {
      return;
    }
    const entry: Inflight = { source: new CancellationSource(), timer: null };
    inflight.set(id, entry);

    const attempt = (n: number): void => {
      void port
        .peaks(
          { handle, durationMs },
          {
            requestId: `peaks-${id}-${n}`,
            deadlineMs: now() + deadlineMs,
            signal: entry.source.signal,
          },
        )
        .then((result) => {
          // A cancelled extraction's result belongs to a stale target —
          // decode may finish after `cancel` ran, and a late success
          // must never overwrite the replacement attempt's peaks.
          if (entry.source.signal.cancelled) {
            return;
          }
          // 'not-applicable' marks a provisional bound (the tighter
          // unknown-duration byte cap): neither terminal nor worth a
          // spot-retry at the same cap — it settles uncached so the
          // pull a durationMs update retriggers gets the real budget.
          const provisionalCap =
            !result.ok && result.error.kind === 'not-applicable';
          if (result.ok) {
            cache.set(id, result.value);
            evict();
          } else if (
            !provisionalCap &&
            (result.error.kind === 'budget-exceeded' ||
              result.error.kind === 'invalid-response')
          ) {
            // Terminal failures cache `null` — seeded bars stick and
            // the same attempt never re-pulls on revisit.
            cache.set(id, null);
            evict();
          } else if (
            !provisionalCap &&
            result.error.kind !== 'cancelled' &&
            n < retryLimit
          ) {
            entry.timer = setTimeoutFn(() => {
              if (!entry.source.signal.cancelled) {
                attempt(n + 1);
              }
            }, retryDelayMs);
            return;
          }
          inflight.delete(id);
          onChange?.();
        });
    };
    attempt(1);
  }

  return {
    pull,
    cancel(id) {
      const entry = inflight.get(id);
      if (entry === undefined) {
        return;
      }
      inflight.delete(id);
      if (entry.timer !== null) {
        clearTimeoutFn(entry.timer);
      }
      entry.source.cancel();
    },
    get(id) {
      return cache.get(id);
    },
  };
}
