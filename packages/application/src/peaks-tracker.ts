import { CancellationSource } from './cancellation.ts';
import { PEAKS_MAX_DECODE_MS } from './ports/peaks.ts';
import type {
  PeaksPort,
  PeaksStore,
  WaveformPeak,
} from './ports/peaks.ts';
import type { ClockPort } from './ports/clock.ts';
import type { IdPort } from './ports/runtime.ts';
import { createIds } from './runtime-impls.ts';
import { appError, err } from './errors.ts';
import type { Result } from './errors.ts';

/**
 * What the tracker needs to fetch — the live playback session fields.
 * `id` is `${recordingId}|${attemptId}`: successes cache under the
 * recordingId alone (content identity — a re-prepared stream replays
 * the same audio, so peaks and coarse profiles carry across attempts
 * and warm adoptions), while failures still key by the full attempt
 * id — one attempt's terminal refusal never poisons a later prepare.
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
/**
 * Process-wide request-id generator — request ids must be unique
 * across generations AND tracker instances: a re-pull after cancel
 * can overlap the abandoned extraction still winding down natively,
 * and a remounted tracker minting the same sequence would collide
 * with the still-registered job whose teardown would then unregister
 * the replacement's cancel slot.
 */
const processIds = createIds();

type Inflight = {
  readonly source: CancellationSource;
  /** Latest pull args — a `durationMs` update rides the live sweep. */
  target: PeaksTarget;
};

export type PeaksTrackerDeps = {
  readonly port: PeaksPort;
  /** Deadlines and retry sleeps — the injected system clock. */
  readonly clock: ClockPort;
  /**
   * Request-id entropy — defaults to a process-wide generator so ids
   * stay unique across tracker instances, remounts, and reloads.
   */
  readonly ids?: IdPort;
  /** Fires when a settled result may have changed `get` — re-render. */
  readonly onChange?: (() => void) | undefined;
  readonly cacheLimit?: number;
  readonly deadlineMs?: number;
  readonly retryLimit?: number;
  readonly retryDelayMs?: number;
  /** A durationMs update past this cancels the live sweep outright. */
  readonly maxDurationMs?: number;
  /**
   * Persisted peaks keyed by recordingId — a store hit renders the
   * last finished profile instantly and skips re-extraction (peaks
   * are a decoration of content identity; a remaster under the same
   * recordingId is the documented staleness trade-off). `undefined`
   * keeps the tracker memory-only.
   */
  readonly store?: PeaksStore | undefined;
};

/** The recording id half of `${recordingId}|${attemptId}` — content
 * identity for success caching and the persisted store. */
function contentKey(id: string): string {
  const cut = id.lastIndexOf('|');
  return cut === -1 ? id : id.slice(0, cut);
}

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
  const ids = deps.ids ?? processIds;
  const store = deps.store;
  const cache = new Map<string, readonly WaveformPeak[] | null>();
  // Terminal nulls judged under a declared over-cap duration are
  // duration-dependent (the port's declared-length gate, unlike the
  // PCM ceiling): a later pull carrying a corrected durationMs under
  // the cap must re-issue rather than serve the stale refusal.
  const gatedNullMs = new Map<string, number>();
  const inflight = new Map<string, Inflight>();

  function evict(): void {
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
      gatedNullMs.delete(oldest);
    }
  }

  function pull(target: PeaksTarget): void {
    const { id } = target;
    const key = contentKey(id);
    // A settled profile under the content key serves every later
    // attempt — the peaks describe the recording, not the mint.
    if (cache.has(key)) {
      const value = cache.get(key);
      cache.delete(key);
      cache.set(key, value ?? null);
      return;
    }
    if (cache.has(id)) {
      const judgedMs = gatedNullMs.get(id);
      const updatedMs = target.durationMs;
      if (
        judgedMs !== undefined &&
        updatedMs !== judgedMs &&
        (updatedMs === null || updatedMs <= maxDurationMs)
      ) {
        gatedNullMs.delete(id);
        cache.delete(id);
      } else {
        // Cache hit (including a settled `null`): reinsert so the
        // revisit bumps recency — the Map's iteration order is the LRU
        // order eviction walks.
        const value = cache.get(id);
        cache.delete(id);
        cache.set(id, value ?? null);
        return;
      }
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
      const settle = (result: Result<readonly WaveformPeak[]>): void => {
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
          cache.set(key, result.value);
          // Clear this attempt's own failure sentinel — but never
          // the content row just written (key === id when the caller
          // passes a bare recording id).
          if (id !== key) {
            cache.delete(id);
          }
          gatedNullMs.delete(id);
          // Fire-and-forget persist — a dropped write only costs the
          // next cold start its instant render, never correctness.
          if (store !== undefined) {
            void store.save(key, result.value).catch(() => {});
          }
          evict();
        } else if (
          !provisionalCap &&
          (result.error.kind === 'budget-exceeded' ||
            result.error.kind === 'invalid-response')
        ) {
          // Terminal failures cache `null` — seeded bars stick and
          // the same attempt never re-pulls on revisit. A
          // budget-exceeded sent with a declared duration past the
          // cap can only have come from the port's duration gate
          // (it precedes every byte pull), so it is tagged by the
          // duration it was judged on — a later pull with a
          // corrected, under-cap durationMs re-earns the sweep.
          cache.set(id, null);
          if (
            result.error.kind === 'budget-exceeded' &&
            sentMs !== null &&
            sentMs > maxDurationMs
          ) {
            gatedNullMs.set(id, sentMs);
          }
          evict();
        } else if (!provisionalCap && n < retryLimit) {
          // Every 'cancelled' reaching here is foreign — the
          // tracker's own cancel never clears the early return
          // above. A parked read killed by an upstream detach is a
          // transient abort, not a verdict: it retries like one.
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
      };
      void port
        .peaks(
          {
            handle: entry.target.handle,
            durationMs: sentMs,
            // A coarse-but-measured profile renders the moment it
            // exists — cached under the content key so the final
            // result overwrites it in place (and a cancelled sweep
            // still leaves real data behind for the next pull).
            onCoarse: (coarse) => {
              if (
                !entry.source.signal.cancelled &&
                !Array.isArray(cache.get(key))
              ) {
                cache.set(key, coarse);
                evict();
                onChange?.();
              }
            },
          },
          {
            requestId: ids.next(`peaks-${id}-${n}`),
            deadlineMs: clock.nowMs() + deadlineMs,
            signal: entry.source.signal,
          },
        )
        // A synchronous throw in the port (base64 charset, decoder
        // construction, buffer allocation) rejects the promise —
        // route it through the same settle path so the inflight entry
        // is never wedged.
        .then(settle, () =>
          settle(err(appError('internal', 'peaks: port rejected'))),
        );
    };
    // A persisted profile is the first lookup — instant repeat
    // render with zero bytes spent. It resolves inside the inflight
    // discipline so a cancel during the load abandons cleanly.
    if (store !== undefined) {
      void store
        .load(key)
        .then((persisted) => {
          if (entry.source.signal.cancelled) {
            return;
          }
          if (persisted !== null && persisted.length > 0) {
            cache.set(key, persisted);
            inflight.delete(id);
            evict();
            onChange?.();
            return;
          }
          attempt(1);
        })
        .catch(() => {
          if (!entry.source.signal.cancelled) {
            attempt(1);
          }
        });
      return;
    }
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
      // Content key first — a settled (or coarse) profile outranks
      // any attempt-scoped failure sentinel for the same recording.
      return cache.get(contentKey(id)) ?? cache.get(id);
    },
  };
}
