import { CancellationSource } from './cancellation.ts';
import { PEAKS_MAX_DECODE_MS } from './ports/peaks.ts';
import type { PeaksPort, WaveformPeak } from './ports/peaks.ts';
import type { ClockPort } from './ports/clock.ts';

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

/** Canonical 256-pair rows are tiny; a dozen tracks is plenty of recency. */
const PEAK_CACHE_LIMIT = 12;
const PEAK_DEADLINE_MS = 30_000;
/**
 * A transient abort (bytes not yet buffered, a stalled fill, a dead
 * handle about to be re-prepared) retries on a delay — each pull is a
 * handful of reads, cheap to re-attempt a few times before the
 * seeded pattern settles.
 */
const PEAK_RETRY_LIMIT = 3;
const PEAK_RETRY_DELAY_MS = 4_000;

type Inflight = {
  readonly source: CancellationSource;
  /** Latest pull args — a `durationMs` update rides the live sweep. */
  target: PeaksTarget;
};

export type PeaksTrackerDeps = {
  readonly port: PeaksPort;
  /** Deadlines and retry sleeps — the injected system clock. */
  readonly clock: ClockPort;
  /** Fires when a settled result may have changed `get` — re-render. */
  readonly onChange?: (() => void) | undefined;
  readonly cacheLimit?: number;
  readonly deadlineMs?: number;
  readonly retryLimit?: number;
  readonly retryDelayMs?: number;
  /** A durationMs update past this cancels the live sweep outright. */
  readonly maxDurationMs?: number;
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
  get(id: string): readonly WaveformPeak[] | null | undefined;
} {
  const port = deps.port;
  const onChange = deps.onChange;
  const cacheLimit = deps.cacheLimit ?? PEAK_CACHE_LIMIT;
  const deadlineMs = deps.deadlineMs ?? PEAK_DEADLINE_MS;
  const retryLimit = deps.retryLimit ?? PEAK_RETRY_LIMIT;
  const retryDelayMs = deps.retryDelayMs ?? PEAK_RETRY_DELAY_MS;
  const maxDurationMs = deps.maxDurationMs ?? PEAKS_MAX_DECODE_MS;
  const clock = deps.clock;
  const cache = new Map<string, readonly WaveformPeak[] | null>();
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
    const { id } = target;
    if (cache.has(id)) {
      // Cache hit (including a settled `null`): reinsert so the
      // revisit bumps recency — the Map's iteration order is the LRU
      // order eviction walks.
      const value = cache.get(id);
      cache.delete(id);
      cache.set(id, value === undefined ? null : value);
      return;
    }
    const live = inflight.get(id);
    if (live !== undefined) {
      const priorMs = live.target.durationMs;
      const updatedMs = target.durationMs;
      if (
        updatedMs !== null &&
        updatedMs > maxDurationMs &&
        (priorMs === null || priorMs <= maxDurationMs)
      ) {
        // A duration that crosses the bound only after the request
        // started is checked like the port checks it up front —
        // the sweep dies in place; its settle caches nothing. (A
        // request already running over-cap is a duplicate pull, not
        // a reveal — its own terminal failure must still cache.)
        inflight.delete(id);
        live.source.cancel();
        return;
      }
      // A re-pull under the same id (durationMs landed mid-sweep)
      // updates the target instead of restarting — the sweep keeps
      // running, and a provisional-cap bail re-attempts against the
      // fresher args rather than settling blind.
      live.target = target;
      return;
    }
    const entry: Inflight = {
      source: new CancellationSource(),
      target,
    };
    inflight.set(id, entry);

    const attempt = (n: number): void => {
      const sentMs = entry.target.durationMs;
      void port
        .peaks(
          { handle: entry.target.handle, durationMs: sentMs },
          {
            requestId: `peaks-${id}-${n}`,
            deadlineMs: clock.nowMs() + deadlineMs,
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
          // unknown-duration byte cap): a durationMs that landed
          // mid-sweep retries it in place at the real cap — no wasted
          // restart. Restarting on an unchanged durationMs would loop
          // forever against a port that always refuses, so it keys off
          // freshness; otherwise the bail settles uncached so a later
          // pull still gets the full budget.
          const provisionalCap =
            !result.ok && result.error.kind === 'not-applicable';
          if (
            provisionalCap &&
            entry.target.durationMs !== null &&
            entry.target.durationMs !== sentMs
          ) {
            attempt(1);
            return;
          }
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
            // Retry rides the injected clock — a cancel resolves the
            // sleep early and the guard swallows the dead attempt.
            void clock
              .sleep(retryDelayMs, entry.source.signal)
              .then((slept) => {
                if (slept.ok && !entry.source.signal.cancelled) {
                  attempt(n + 1);
                }
              });
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
      entry.source.cancel();
    },
    get(id) {
      return cache.get(id);
    },
  };
}
