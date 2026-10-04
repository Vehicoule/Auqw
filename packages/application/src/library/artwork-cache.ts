import { CancellationSource } from '../cancellation.ts';
import type {
  CancellationSignal,
  OperationContext,
} from '../cancellation.ts';
import type { AppError, ErrorKind, Result } from '../errors.ts';
import { appError, cancelledError, err, fromUnknown, ok } from '../errors.ts';
import type { Settings } from '../domain.ts';
import {
  ARTWORK_CACHE_BUDGET_DEFAULT_BYTES,
  isPublicHttpsUrl,
  isSafeNonNegative,
  isSettings,
  isString,
} from '../domain.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { LogPort } from '../ports/log.ts';
import type { IdPort } from '../ports/runtime.ts';
import type { StoragePort } from '../ports/storage.ts';
import { retryBounded } from '../retry.ts';
import { isArtworkCacheEntry } from './library.ts';
import type { ArtworkCacheEntry } from './library.ts';
import { artworkAssetKey, artworkUrlSize } from './artwork-url.ts';

/**
 * Network-to-file transfer for one artwork image, supplied by the
 * shell adapter (expo-file-system on mobile). The application core
 * never touches network or filesystem itself.
 *
 * Contract: `download` writes the body to `destPath` atomically
 * (temp file + rename) so a partial or failed transfer never leaves
 * a file at `destPath`; `bytes` reports the final file size.
 * Expected error kinds: 'unavailable' (no network), 'rate-limit'
 * (honors `retryAfterMs`), 'invalid-response' (non-image or malformed
 * body), 'transient', 'timeout', 'cancelled'. The port never throws;
 * a throw crosses back as 'internal'.
 *
 * Implementations must additionally refuse a destination that resolves
 * to a loopback, private, link-local or otherwise non-public address.
 * `isPublicHttpsUrl` only inspects the spelling of the host, so a
 * public-looking name can still point inward, DNS rebinding included.
 * The check belongs here because the transfer is the only place the
 * resolved address exists. Refusing counts as 'invalid-response'.
 */
export interface ArtworkFetchPort {
  download(
    url: string,
    destPath: string,
    signal: CancellationSignal,
  ): Promise<Result<{ bytes: number }>>;
}

/**
 * Owns the on-disk artwork cache directory: supplies its location,
 * derives a deterministic collision-free destination path per url,
 * and performs all file removal. `destFor` must be stable — the same
 * url always maps to the same path — and must not produce the same
 * path for two different urls.
 *
 * File deletion lives on this port (not on ArtworkFetchPort) so the
 * adapter surface that owns the cache directory owns the whole file
 * lifecycle; the fetch port only transfers bytes. `remove` treats an
 * absent file as success — eviction is idempotent.
 *
 * `exists` answers whether a file is still on disk: the directory is
 * OS-reclaimable (Paths.cache), so a persisted row can outlive its
 * file. An error means the check could not be made — the caller must
 * not assume either presence or absence.
 */
export interface ArtworkPathsPort {
  /** Absolute path of the cache directory this port owns. */
  readonly dir: string;
  destFor(url: string): string;
  exists(
    filePath: string,
    signal: CancellationSignal,
  ): Promise<Result<boolean>>;
  remove(
    filePath: string,
    signal: CancellationSignal,
  ): Promise<Result<void>>;
}

export type ArtworkLookup = {
  /** True when the entry was already cached (no download ran). */
  readonly hit: boolean;
  /**
   * Cache-local file path, valid at return time. Entries are
   * disposable: a later eviction may remove the file, so callers
   * must tolerate it disappearing and re-request.
   */
  readonly filePath: string;
};

export type ArtworkSweepReport = {
  /** Rows dropped because their file is gone (OS-reaped). */
  readonly reaped: number;
  readonly reapedBytes: number;
  readonly evicted: number;
  readonly evictedBytes: number;
  readonly totalBytes: number;
  readonly budgetBytes: number;
};

export type ArtworkCacheDeps = {
  readonly storage: StoragePort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly log: LogPort;
  readonly fetch: ArtworkFetchPort;
  readonly paths: ArtworkPathsPort;
};

export type ArtworkCache = {
  get(
    url: string,
    context: OperationContext,
  ): Promise<Result<ArtworkLookup>>;
  sweep(context: OperationContext): Promise<Result<ArtworkSweepReport>>;
};

/** Resolves the active byte budget: the setting or the spec default. */
export function artworkCacheBudgetBytes(settings: Settings): number {
  return settings.artworkCacheBytes ?? ARTWORK_CACHE_BUDGET_DEFAULT_BYTES;
}

function isArtworkUrl(url: unknown): url is string {
  return isString(url, 2048) && isPublicHttpsUrl(url);
}

const invalidResponse = (message: string): Result<never> =>
  err(appError('invalid-response', message));

/**
 * The cached same-asset entry best able to serve `url`: same asset key
 * and a served size ≥ the request's, smallest adequate winning (a
 * 2048px file serving a 64px row wastes decode memory when a 128px
 * twin sits beside it). Only size-addressable shapes qualify — a
 * knob-less entry is 'unknown', never 'probably big'. Exact misses
 * only: the caller already tried `entries.get(url)`.
 */
function siblingEntry(
  url: string,
  entries: ReadonlyMap<string, ArtworkCacheEntry>,
): ArtworkCacheEntry | undefined {
  const want = artworkUrlSize(url);
  if (want === null) {
    return undefined;
  }
  const key = artworkAssetKey(url);
  let best: ArtworkCacheEntry | undefined;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const other of entries.values()) {
    if (other.url === url) {
      continue;
    }
    const have = artworkUrlSize(other.url);
    if (have === null || have < want || have >= bestSize) {
      continue;
    }
    if (artworkAssetKey(other.url) !== key) {
      continue;
    }
    best = other;
    bestSize = have;
  }
  return best;
}

type Section = {
  readonly entries: Map<string, ArtworkCacheEntry>;
  readonly settings: Settings;
};

/** Phase-1 verdict: the cached filePath on a hit, null when absent. */
type Probe = string | null;

type Inflight = {
  promise: Promise<Result<ArtworkLookup>>;
  /**
   * Callers still waiting on the shared download. The work runs on
   * its own signal — one waiter cancelling (an unmounted image)
   * must not abort a download the others still need; the work only
   * cancels once the last waiter is gone.
   */
  waiters: number;
  work: CancellationSource;
  /**
   * Every live waiter's own deadline — the multiset backing the
   * shared bound so a departing caller's budget leaves with them.
   */
  waiterDeadlines: number[];
  /**
   * The shared bound: the LATEST deadline any waiter brought, so a
   * short-deadline leader doesn't expire a transfer a later caller
   * still has budget for. Recomputed on join and on leave;
   * retryBounded re-reads it.
   */
  deadlineMs: number;
};

type Eviction = {
  readonly evicted: number;
  readonly evictedBytes: number;
  readonly firstError: AppError | null;
};

/**
 * In-memory verdict on a url that just failed — see `failures`
 * below. `untilMs` is the absolute expiry; a rate-limit's
 * `retryAfterMs` sets it when the server asks for longer.
 */
type Failure = {
  readonly error: AppError;
  readonly untilMs: number;
};

/**
 * A dead url's verdict is remembered for this long so a remounting
 * image grid doesn't re-hammer the network on every mount. Short
 * enough to recover quickly when the server heals — this only
 * suppresses the retry loop, it never poisons the on-disk cache.
 */
const FAILURE_TTL_MS = 20_000;
const FAILURE_MAX_ENTRIES = 512;

/**
 * Verdicts that describe the url itself — only these may
 * negative-cache. Transport and environment kinds (timeout,
 * transient, unavailable, auth, storage, internal, lifecycle) say
 * nothing about what the url holds: pinning them would keep a
 * healthy url dead through a connectivity blip, long after the
 * network recovered. 'rate-limit' stays — its TTL is the
 * server-asked wait that suppresses re-hammering.
 */
const NEGATIVE_CACHE_KINDS: ReadonlySet<ErrorKind> = new Set([
  'not-found',
  'invalid-response',
  'artifact-rejected',
  'no-result',
  'not-applicable',
  'unsupported',
  'permission-denied',
  'expired-resource',
  'rate-limit',
]);

/**
 * How long the mirrored section is trusted before a fresh load. The
 * section carries `settings` (the budget) alongside the entries, and
 * settings writes have no notification path into this cache — the
 * sweep-on-shrink call covers shrink, but a grown budget or an import
 * would otherwise stay invisible until the next boot. One reload per
 * minute of activity bounds that staleness without putting a
 * full-state read back on every lookup.
 */
const SECTION_REFRESH_MS = 60_000;

/**
 * Access-time touches write back on a delay: a list mount can touch
 * dozens of rows and one debounced commit covers the whole burst,
 * where one write-through commit per touch serialized a full section
 * rewrite behind every image. Structural changes (inserts, reaps,
 * evictions) still commit before returning — only the LRU timestamp
 * rides the delay.
 */
const TOUCH_FLUSH_DELAY_MS = 3_000;

/**
 * Extra flushes a failed commit earns before the cycle gives up.
 * The delay doubles per attempt (6s, 12s, 24s after the initial
 * 3s) — bounded so a persistently wedged writer isn't retried in a
 * tight loop; the dirty mark survives the last retry so the next
 * touch re-arms a fresh cycle instead of dropping recency for good.
 */
const TOUCH_FLUSH_RETRY_MAX = 3;

/**
 * Bounded LRU on-disk artwork cache (docs/specs/data.md: ~200 MB,
 * managed in settings). Entries persist in the `artworkCache`
 * section of StoragePort; files live in the paths port's directory.
 *
 * Concurrency: every read-modify-write on the persisted section runs
 * on one serialized tail (session's `#likeTail` pattern) — the
 * section commits atomically, so without serialization two writers
 * would lose each other's rows. Downloads run *outside* the tail so
 * misses for different urls transfer in parallel; gets for the same
 * url coalesce onto one in-flight record (search-session's pattern).
 *
 * The section is mirrored in memory after first load: a row-list
 * mount turns into dozens of gets and a full-state load plus a
 * write-through commit per image serialized the whole mount behind
 * one tail. Hits read the mirror and stat the file; the LRU touch
 * persists on a debounced flush, and a commit failure discards the
 * mirror so the next operation reloads storage truth.
 */
export function createArtworkCache(deps: ArtworkCacheDeps): ArtworkCache {
  let tail: Promise<unknown> = Promise.resolve();
  const inflight = new Map<string, Inflight>();
  /**
   * Per-url negative cache: a failed download is remembered briefly
   * so repeated mounts of the same dead url answer with the stored
   * error instead of re-downloading. Memory only — never persisted
   * — and bounded so a hostile manifest can't grow it forever.
   */
  const failures = new Map<string, Failure>();
  const owned = new Set<Promise<unknown>>();
  /**
   * The persisted section mirrored in memory. `artworkCache` has a
   * single writer — this cache (imports and diagnostics leave it
   * alone) — so after the first load the mirror is authoritative and
   * reads stop hitting storage. Structural mutations write through;
   * on a commit failure the mirror may claim rows storage never saw,
   * so it is discarded and the next operation reloads storage truth.
   */
  let cached: {
    readonly data: Section;
    readonly loadedAtMs: number;
  } | null = null;
  /** Mirror holds access times newer than the last committed write. */
  let touchDirty = false;
  let touchFlushScheduled = false;
  let touchRetryCount = 0;

  /** Defensive clock read: unsafe values never reach downstream math. */
  function safeNow(): number | null {
    let now: number;
    try {
      now = deps.clock.nowMs();
    } catch {
      return null;
    }
    return isSafeNonNegative(now) ? now : null;
  }

  /** Port calls never throw by contract; throws map to internal. */
  async function call<T>(
    fn: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    try {
      return await fn();
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
  }

  /** Serializes a read-modify-write on the persisted section. */
  function serialized<T>(
    fn: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const work = tail.then(fn);
    tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  /**
   * Fresh request id per internal port call; the caller's deadline
   * and cancellation signal carry through unchanged.
   */
  function childContext(context: OperationContext): OperationContext {
    return {
      requestId: deps.ids.next('artwork'),
      deadlineMs: context.deadlineMs,
      signal: context.signal,
    };
  }

  /** Fire-and-forget promises still get an owner. */
  function own(work: Promise<unknown>): void {
    owned.add(work);
    const done = (): void => {
      owned.delete(work);
    };
    void work.then(done, done);
  }

  /** Bounded, nonfatal, sanitized logging: never urls or paths. */
  function warn(message: string): void {
    const atMs = safeNow();
    if (atMs === null) {
      return;
    }
    own(call(() => deps.log.write({ level: 'warn', message, atMs })));
  }

  /**
   * The touch flush's own context: bookkeeping must not inherit a
   * list caller's signal — a row unmounting mid-touch must not abort
   * the persistence of every touch in the batch.
   */
  function flushContext(): OperationContext {
    return {
      requestId: deps.ids.next('artwork'),
      deadlineMs: (safeNow() ?? 0) + 30_000,
      signal: new CancellationSource().signal,
    };
  }

  /**
   * Debounced write-back of access-time touches. The first dirty
   * touch schedules one commit TOUCH_FLUSH_DELAY_MS later covering
   * the whole burst. A failed commit — or a failed sleep — re-arms
   * on a doubling backoff up to TOUCH_FLUSH_RETRY_MAX times: a
   * transient write failure shouldn't have to wait for a lucky
   * next hit, and a restart after the last retry is the only way
   * recency is actually lost. Retries exhausted keeps the dirty
   * mark (and the backoff counter, so no tight loop); the next
   * touch re-arms the cycle at that delay.
   */
  function scheduleTouchFlush(): void {
    if (touchFlushScheduled) {
      return;
    }
    touchFlushScheduled = true;
    const delayMs = TOUCH_FLUSH_DELAY_MS * 2 ** touchRetryCount;
    const work = (async (): Promise<void> => {
      try {
        const slept = await call(() =>
          deps.clock.sleep(
            delayMs,
            new CancellationSource().signal,
          ),
        );
        if (!slept.ok) {
          return;
        }
        await serialized(async (): Promise<Result<void>> => {
          const live = cached;
          if (!touchDirty || live === null) {
            touchDirty = false;
            return ok(undefined);
          }
          touchDirty = false;
          const committed = await commitSection(
            live.data.entries,
            flushContext(),
          );
          if (!committed.ok) {
            touchDirty = true;
            warn('artwork cache touch flush failed');
          }
          return ok(undefined);
        });
      } finally {
        touchFlushScheduled = false;
        if (!touchDirty) {
          touchRetryCount = 0;
        } else if (touchRetryCount < TOUCH_FLUSH_RETRY_MAX) {
          touchRetryCount += 1;
          scheduleTouchFlush();
        }
      }
    })();
    own(work);
  }

  /**
   * Hands out the mirrored section, loading on first use and
   * refreshing once the copy outlives SECTION_REFRESH_MS (or `force`
   * is set — the sweep judges against the freshest budget). A
   * refresh carries the mirror's unflushed access times onto the
   * fresh rows so persisted staleness never regresses LRU order.
   */
  async function ensureSection(
    context: OperationContext,
    force = false,
  ): Promise<Result<Section>> {
    const now = safeNow();
    if (
      !force &&
      cached !== null &&
      (now === null || now - cached.loadedAtMs <= SECTION_REFRESH_MS)
    ) {
      return ok(cached.data);
    }
    const loaded = await loadSection(context);
    if (!loaded.ok) {
      return loaded;
    }
    const fresh = loaded.value;
    if (cached !== null) {
      for (const entry of fresh.entries.values()) {
        const live = cached.data.entries.get(entry.url);
        if (
          live !== undefined &&
          live.lastAccessedMs > entry.lastAccessedMs
        ) {
          entry.lastAccessedMs = live.lastAccessedMs;
        }
      }
    }
    cached = { data: fresh, loadedAtMs: now ?? 0 };
    return ok(fresh);
  }

  /**
   * Commits the mirrored entries after a structural mutation. A
   * success persists every pending touch too, clearing the dirty
   * mark; a failure means the mirror diverged from storage (it may
   * name rows storage never wrote or have dropped rows it did keep),
   * so it is discarded — the next operation reloads storage truth.
   */
  async function commitMirror(
    entries: ReadonlyMap<string, ArtworkCacheEntry>,
    context: OperationContext,
  ): Promise<Result<void>> {
    const committed = await commitSection(entries, context);
    touchDirty = false;
    if (!committed.ok) {
      cached = null;
      return committed;
    }
    return ok(undefined);
  }

  /**
   * Reads the persisted section. The storage adapter validates rows
   * it maps, but the section is re-validated here anyway: a corrupt
   * store surfaces 'invalid-response' instead of being silently
   * trusted or silently repaired.
   */
  async function loadSection(
    context: OperationContext,
  ): Promise<Result<Section>> {
    const loaded = await call(() =>
      deps.storage.load(childContext(context)),
    );
    if (!loaded.ok) {
      return loaded;
    }
    const state = loaded.value;
    if (!isSettings(state.settings)) {
      return invalidResponse('persisted settings failed validation');
    }
    const rows: unknown = state.artworkCache;
    if (!Array.isArray(rows) || !rows.every(isArtworkCacheEntry)) {
      return invalidResponse('persisted artwork cache failed validation');
    }
    const entries = new Map<string, ArtworkCacheEntry>();
    for (const row of rows) {
      if (entries.has(row.url)) {
        return invalidResponse('persisted artwork cache has duplicate urls');
      }
      entries.set(row.url, { ...row });
    }
    return ok({ entries, settings: state.settings });
  }

  function commitSection(
    entries: ReadonlyMap<string, ArtworkCacheEntry>,
    context: OperationContext,
  ): Promise<Result<void>> {
    return call(() =>
      deps.storage.commit(
        { artworkCache: [...entries.values()] },
        childContext(context),
      ),
    );
  }

  function totalBytes(
    entries: ReadonlyMap<string, ArtworkCacheEntry>,
  ): number {
    let total = 0;
    for (const entry of entries.values()) {
      total += entry.bytes;
    }
    return total;
  }

  /**
   * Evicts oldest-first until total bytes fit the budget. Ties on
   * lastAccessedMs keep insertion order (Map order = persisted
   * order). The file is removed first and only then is the row
   * dropped: on a removal failure the row stays — the file may
   * still exist, so the entry remains honest and a later sweep
   * retries. `protectedUrl` is never a candidate (the entry the
   * caller just wrote).
   */
  async function evictUnderBudget(
    entries: Map<string, ArtworkCacheEntry>,
    budgetBytes: number,
    protectedUrl: string | null,
    signal: CancellationSignal,
  ): Promise<Eviction> {
    let total = totalBytes(entries);
    let evicted = 0;
    let evictedBytes = 0;
    let firstError: AppError | null = null;
    if (total <= budgetBytes) {
      return { evicted, evictedBytes, firstError };
    }
    const candidates = [...entries.values()]
      .map((entry, index) => ({ entry, index }))
      .filter((c) => c.entry.url !== protectedUrl)
      .sort(
        (a, b) =>
          a.entry.lastAccessedMs - b.entry.lastAccessedMs ||
          a.index - b.index,
      );
    for (const { entry } of candidates) {
      if (total <= budgetBytes) {
        break;
      }
      if (signal.cancelled) {
        firstError ??= cancelledError();
        break;
      }
      const removed = await call(() =>
        deps.paths.remove(entry.filePath, signal),
      );
      if (removed.ok) {
        entries.delete(entry.url);
        total -= entry.bytes;
        evicted += 1;
        evictedBytes += entry.bytes;
      } else if (firstError === null) {
        firstError = removed.error;
        warn('artwork cache file removal failed');
      }
    }
    return { evicted, evictedBytes, firstError };
  }

  async function runGet(
    url: string,
    context: OperationContext,
    record: Inflight,
  ): Promise<Result<ArtworkLookup>> {
    // Phase 1 (serialized): a present entry answers from the mirror
    // after proving its file still exists — the directory is
    // OS-reclaimable, so a row can outlive its file. A reaped entry
    // is dropped and the url re-downloads like any absent one. The
    // access-time touch updates memory now and writes back via the
    // debounced flush, not a per-hit commit.
    const probed = await serialized(
      async (): Promise<Result<Probe>> => {
        const section = await ensureSection(context);
        if (!section.ok) {
          return section;
        }
        // Exact key first, then same-asset siblings in ascending
        // adequacy: entries are keyed by exact url, but CDN size
        // variants of one asset are interchangeable at the file level —
        // a small variant's miss (a scaled-url 404 or a stalled fetch)
        // is served by a cached larger variant instead of a redundant
        // download. Read-only reuse: no row is minted for the request
        // url, so byte accounting and eviction keep owning the file
        // through the sibling's single entry, and the sibling's access
        // time is what bumps — it earned the hit.
        const entries = section.value.entries;
        let candidate =
          entries.get(url) ?? siblingEntry(url, entries);
        let reaped = false;
        let entry: ArtworkCacheEntry | undefined;
        for (;;) {
          if (candidate === undefined) {
            break;
          }
          const probing = candidate;
          const present = await call(() =>
            deps.paths.exists(probing.filePath, context.signal),
          );
          if (!present.ok) {
            // A stat failure after earlier reaps still persists them —
            // an in-memory-only delete would leave the mirror arguing
            // with storage until the next commit or refresh.
            if (reaped) {
              const committed = await commitMirror(entries, context);
              if (!committed.ok) {
                return committed;
              }
            }
            return err(present.error);
          }
          if (present.value) {
            entry = probing;
            break;
          }
          // The row reaps under the entry's own key — a sibling hit's
          // request url isn't in the map. The next-smallest adequate
          // sibling then gets its turn: one reclaimed file shouldn't
          // cost the whole cached set its answer.
          entries.delete(probing.url);
          reaped = true;
          candidate = siblingEntry(url, entries);
        }
        // One commit covers reaps whether they ended in a hit or a
        // miss — a sibling that answered still drops the dead rows.
        if (reaped) {
          const committed = await commitMirror(entries, context);
          if (!committed.ok) {
            return committed;
          }
        }
        if (entry === undefined) {
          return ok<Probe>(null);
        }
        const now = safeNow();
        if (now === null) {
          return err(
            appError('internal', 'clock returned an unsafe timestamp'),
          );
        }
        entry.lastAccessedMs = now;
        touchDirty = true;
        scheduleTouchFlush();
        return ok<Probe>(entry.filePath);
      },
    );
    if (!probed.ok) {
      return probed;
    }
    if (probed.value !== null) {
      return ok({ hit: true, filePath: probed.value });
    }

    // The remembered failure verdict only suppresses the retry loop
    // after the probe misses — a file on disk (exact or same-asset
    // sibling) answers regardless: a 404 on this size variant says
    // nothing about the file a larger variant already holds.
    const remembered = failures.get(url);
    if (remembered !== undefined) {
      const now = safeNow();
      if (now !== null && now < remembered.untilMs) {
        return err(remembered.error);
      }
      // Expired — or a broken clock can't vouch for the verdict —
      // either way the url earns a fresh try.
      failures.delete(url);
    }

    const destPath = deps.paths.destFor(url);
    if (!isString(destPath, 1024)) {
      return invalidResponse('artwork destination path failed validation');
    }
    const removeDest = (): Promise<Result<void>> =>
      call(() => deps.paths.remove(destPath, context.signal));
    // Transient verdicts retry once inside the record's deadline —
    // the live max over its waiters, not just the leader's, so a
    // joined caller's budget keeps the shared transfer alive; a
    // still-failing url lands in the negative cache so the next
    // mount answers with the stored error rather than re-hammering.
    const downloaded = await retryBounded({
      get deadlineMs() {
        return record.deadlineMs;
      },
      signal: context.signal,
      clock: deps.clock,
      // The attempt's child signal, not the outer work signal — the
      // deadline watchdog cancels it so a timed-out download stops
      // writing rather than racing a replacement to the same path.
      call: (signal) => call(() => deps.fetch.download(url, destPath, signal)),
    });
    if (!downloaded.ok) {
      // Honest miss: the typed error crosses back, nothing is cached.
      // Only a live run writes the negative verdict — a fetch whose
      // waiters all left can report a late HTTP error while its
      // replacement already downloaded the same url successfully.
      if (
        NEGATIVE_CACHE_KINDS.has(downloaded.error.kind) &&
        !record.work.signal.cancelled
      ) {
        const now = safeNow();
        if (now !== null) {
          failures.delete(url);
          failures.set(url, {
            error: downloaded.error,
            // retryAfterMs can only lengthen the hold — a zero or
            // tiny server hint must not defeat negative caching.
            untilMs: Math.min(
              now + Math.max(downloaded.error.retryAfterMs ?? 0, FAILURE_TTL_MS),
              Number.MAX_SAFE_INTEGER,
            ),
          });
          while (failures.size > FAILURE_MAX_ENTRIES) {
            const oldest = failures.keys().next();
            if (oldest.done) {
              break;
            }
            failures.delete(oldest.value);
          }
        }
      }
      return downloaded;
    }
    const bytes = downloaded.value.bytes;
    if (!isSafeNonNegative(bytes)) {
      await removeDest();
      return invalidResponse('download reported an invalid byte count');
    }
    const now = safeNow();
    if (now === null) {
      await removeDest();
      return err(
        appError('internal', 'clock returned an unsafe timestamp'),
      );
    }
    // A live success clears any stale verdict a racing run stored —
    // the proof the url fetches is fresher than the failure.
    if (!record.work.signal.cancelled) {
      failures.delete(url);
    }

    // Phase 2 (serialized): insert under the mirrored budget — it
    // can lag a just-changed cap by up to SECTION_REFRESH_MS; a
    // shrink's follow-up sweep refreshes the mirror immediately.
    return serialized(async (): Promise<Result<ArtworkLookup>> => {
      const section = await ensureSection(context);
      if (!section.ok) {
        return section;
      }
      const budgetBytes = artworkCacheBudgetBytes(
        section.value.settings,
      );
      if (bytes > budgetBytes) {
        // An entry larger than the whole budget is rejected, not
        // inserted-then-evicted: caching it would still exceed the
        // budget and returning its path would dangle after cleanup.
        await removeDest();
        return err(
          appError(
            'budget-exceeded',
            'artwork exceeds the cache budget',
          ),
        );
      }
      const entries = section.value.entries;
      const existing = entries.get(url);
      if (existing !== undefined) {
        // Same deterministic destPath means the file just written is
        // the tracked file; refresh size + access time in place.
        existing.bytes = bytes;
        existing.lastAccessedMs = now;
        const committed = await commitMirror(entries, context);
        if (!committed.ok) {
          return committed;
        }
        return ok({ hit: true, filePath: existing.filePath });
      }
      for (const other of entries.values()) {
        if (other.filePath === destPath) {
          await removeDest();
          return invalidResponse(
            'artwork destination path collides with a cached entry',
          );
        }
      }
      entries.set(url, {
        url,
        filePath: destPath,
        bytes,
        lastAccessedMs: now,
      });
      await evictUnderBudget(
        entries,
        budgetBytes,
        url,
        context.signal,
      );
      const committed = await commitMirror(entries, context);
      if (!committed.ok) {
        // Without its row the new file is orphaned; remove it.
        await removeDest();
        return committed;
      }
      return ok({ hit: false, filePath: destPath });
    });
  }

  function waitFor(
    record: Inflight,
    context: OperationContext,
  ): Promise<Result<ArtworkLookup>> {
    record.waiters += 1;
    // A later waiter brings its own budget — the shared bound grows
    // to the latest deadline so the leader's expiry doesn't kill a
    // download newer waiters still have time for. A non-finite or
    // negative budget contributes nothing (that caller's own wait
    // times out immediately below).
    const mine = isSafeNonNegative(context.deadlineMs)
      ? context.deadlineMs
      : 0;
    record.waiterDeadlines.push(mine);
    record.deadlineMs = Math.max(record.deadlineMs, mine);
    return new Promise<Result<ArtworkLookup>>((resolve) => {
      let unsubscribe: () => void = () => { };
      let done = false;
      const deadline = new CancellationSource();
      const finish = (result: Result<ArtworkLookup>): void => {
        if (done) {
          return;
        }
        done = true;
        unsubscribe();
        deadline.cancel();
        record.waiters -= 1;
        // The departed budget leaves the shared bound — the transfer
        // keeps flying only while a remaining waiter's deadline
        // covers it; the last leaver still cancels the work.
        const slot = record.waiterDeadlines.indexOf(mine);
        if (slot !== -1) {
          record.waiterDeadlines.splice(slot, 1);
        }
        if (record.waiterDeadlines.length > 0) {
          record.deadlineMs = Math.max(...record.waiterDeadlines);
        }
        if (record.waiters === 0) {
          record.work.cancel();
        }
        resolve(result);
      };
      unsubscribe = context.signal.subscribe(() => {
        finish(err(cancelledError()));
      });
      // Each waiter's own deadline bounds its wait — a caller whose
      // budget dies while others remain leaves without cancelling
      // the shared work.
      const timedOut = err(
        appError('timeout', 'operation deadline exceeded'),
      );
      const now = safeNow();
      const remaining = now === null ? 0 : mine - now;
      if (remaining <= 0) {
        finish(timedOut);
      } else {
        void deps.clock
          .sleep(remaining, deadline.signal)
          .then((slept) => {
            if (slept.ok) {
              finish(timedOut);
            }
          });
      }
      if (!context.signal.cancelled) {
        void record.promise.then(finish);
      }
    });
  }

  function get(
    url: string,
    context: OperationContext,
  ): Promise<Result<ArtworkLookup>> {
    if (!isArtworkUrl(url)) {
      return Promise.resolve(invalidResponse('invalid artwork url'));
    }
    if (context.signal.cancelled) {
      return Promise.resolve(err(cancelledError()));
    }
    // Concurrent gets for the same url coalesce onto one download —
    // except a record whose work is already cancelled but not yet
    // unwound: joining it could only ever answer cancelled, so a
    // fresh record takes over (the abandoned one deletes itself by
    // identity check and cannot clobber the replacement).
    const pending = inflight.get(url);
    if (pending !== undefined && !pending.work.signal.cancelled) {
      return waitFor(pending, context);
    }
    // Placeholder replaced before the record is published to the map.
    const record: Inflight = {
      promise: Promise.resolve(
        err(appError('internal', 'inflight record unset')),
      ),
      waiters: 0,
      work: new CancellationSource(),
      waiterDeadlines: [],
      deadlineMs: context.deadlineMs,
    };
    record.promise = (async (): Promise<Result<ArtworkLookup>> => {
      try {
        // The download answers to `work`, not any caller's signal —
        // it outlives a waiter until every waiter is gone.
        return await runGet(
          url,
          { ...context, signal: record.work.signal },
          record,
        );
      } catch (thrown) {
        return err(fromUnknown(thrown));
      } finally {
        // Delete before the record resolves so a later get never
        // attaches to a completed download.
        if (inflight.get(url) === record) {
          inflight.delete(url);
        }
      }
    })();
    inflight.set(url, record);
    return waitFor(record, context);
  }

  function sweep(
    context: OperationContext,
  ): Promise<Result<ArtworkSweepReport>> {
    return serialized(
      async (): Promise<Result<ArtworkSweepReport>> => {
        if (context.signal.cancelled) {
          return err(cancelledError());
        }
        const section = await ensureSection(context, true);
        if (!section.ok) {
          return section;
        }
        const entries = section.value.entries;
        // Reap rows whose files the OS already reclaimed — the cache
        // dir is reclaimable, so a row can outlive its file. A stat
        // failure keeps the row (presence was never disproven) but is
        // reported like a removal failure.
        let reaped = 0;
        let reapedBytes = 0;
        let firstError: AppError | null = null;
        for (const entry of [...entries.values()]) {
          if (context.signal.cancelled) {
            firstError ??= cancelledError();
            break;
          }
          const present = await call(() =>
            deps.paths.exists(entry.filePath, context.signal),
          );
          if (!present.ok) {
            firstError ??= present.error;
            warn('artwork cache stat failed');
            continue;
          }
          if (!present.value) {
            entries.delete(entry.url);
            reaped += 1;
            reapedBytes += entry.bytes;
          }
        }
        const budgetBytes = artworkCacheBudgetBytes(
          section.value.settings,
        );
        const eviction = await evictUnderBudget(
          entries,
          budgetBytes,
          null,
          context.signal,
        );
        firstError ??= eviction.firstError;
        if (reaped > 0 || eviction.evicted > 0) {
          const committed = await commitMirror(entries, context);
          if (!committed.ok) {
            return committed;
          }
        }
        const report: ArtworkSweepReport = {
          reaped,
          reapedBytes,
          evicted: eviction.evicted,
          evictedBytes: eviction.evictedBytes,
          totalBytes: totalBytes(entries),
          budgetBytes,
        };
        // A stat/removal failure is honest: achieved reaps and
        // evictions are already committed, but the sweep reports the
        // error it hit.
        return firstError === null ? ok(report) : err(firstError);
      },
    );
  }

  return { get, sweep };
}
