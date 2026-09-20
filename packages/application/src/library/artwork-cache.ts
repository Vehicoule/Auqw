import type {
  CancellationSignal,
  OperationContext,
} from '../cancellation.ts';
import type { AppError, Result } from '../errors.ts';
import { appError, err, fromUnknown, ok } from '../errors.ts';
import type { Settings } from '../domain.ts';
import {
  ARTWORK_CACHE_BUDGET_DEFAULT_BYTES,
  isSafeNonNegative,
  isSettings,
  isString,
} from '../domain.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { LogPort } from '../ports/log.ts';
import type { IdPort } from '../ports/runtime.ts';
import type { StoragePort } from '../ports/storage.ts';
import { isArtworkCacheEntry } from './library.ts';
import type { ArtworkCacheEntry } from './library.ts';

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
 */
export interface ArtworkPathsPort {
  /** Absolute path of the cache directory this port owns. */
  readonly dir: string;
  destFor(url: string): string;
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
  return (
    settings.artworkCacheBytes ?? ARTWORK_CACHE_BUDGET_DEFAULT_BYTES
  );
}

function isArtworkUrl(url: unknown): url is string {
  return isString(url, 2048) && url.startsWith('https://');
}

type Section = {
  readonly entries: Map<string, ArtworkCacheEntry>;
  readonly settings: Settings;
};

type Probe =
  | { readonly type: 'hit'; readonly filePath: string }
  | { readonly type: 'absent' };

type Inflight = {
  promise: Promise<Result<ArtworkLookup>>;
};

type Eviction = {
  readonly evicted: number;
  readonly evictedBytes: number;
  readonly firstError: AppError | null;
};

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
 */
export function createArtworkCache(deps: ArtworkCacheDeps): ArtworkCache {
  let tail: Promise<unknown> = Promise.resolve();
  const inflight = new Map<string, Inflight>();
  const owned = new Set<Promise<unknown>>();

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
    void work.then(
      () => {
        owned.delete(work);
      },
      () => {
        owned.delete(work);
      },
    );
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
      return err(
        appError(
          'invalid-response',
          'persisted settings failed validation',
        ),
      );
    }
    const rows: unknown = state.artworkCache;
    if (
      !Array.isArray(rows) ||
      !rows.every(isArtworkCacheEntry)
    ) {
      return err(
        appError(
          'invalid-response',
          'persisted artwork cache failed validation',
        ),
      );
    }
    const entries = new Map<string, ArtworkCacheEntry>();
    for (const row of rows) {
      if (entries.has(row.url)) {
        return err(
          appError(
            'invalid-response',
            'persisted artwork cache has duplicate urls',
          ),
        );
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
        if (firstError === null) {
          firstError = appError('cancelled', 'cancelled');
        }
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
  ): Promise<Result<ArtworkLookup>> {
    // Phase 1 (serialized): a present entry is touched write-through.
    const probed = await serialized(
      async (): Promise<Result<Probe>> => {
        const section = await loadSection(context);
        if (!section.ok) {
          return section;
        }
        const entry = section.value.entries.get(url);
        if (entry === undefined) {
          return ok({ type: 'absent' });
        }
        const now = safeNow();
        if (now === null) {
          return err(
            appError('internal', 'clock returned an unsafe timestamp'),
          );
        }
        entry.lastAccessedMs = now;
        const committed = await commitSection(
          section.value.entries,
          context,
        );
        if (!committed.ok) {
          return committed;
        }
        return ok({ type: 'hit', filePath: entry.filePath });
      },
    );
    if (!probed.ok) {
      return probed;
    }
    if (probed.value.type === 'hit') {
      return ok({ hit: true, filePath: probed.value.filePath });
    }

    const destPath = deps.paths.destFor(url);
    if (!isString(destPath, 1024)) {
      return err(
        appError(
          'invalid-response',
          'artwork destination path failed validation',
        ),
      );
    }
    const downloaded = await call(() =>
      deps.fetch.download(url, destPath, context.signal),
    );
    if (!downloaded.ok) {
      // Honest miss: the typed error crosses back, nothing is cached.
      return downloaded;
    }
    const bytes = downloaded.value.bytes;
    if (!isSafeNonNegative(bytes)) {
      await call(() => deps.paths.remove(destPath, context.signal));
      return err(
        appError(
          'invalid-response',
          'download reported an invalid byte count',
        ),
      );
    }
    const now = safeNow();
    if (now === null) {
      await call(() => deps.paths.remove(destPath, context.signal));
      return err(
        appError('internal', 'clock returned an unsafe timestamp'),
      );
    }

    // Phase 2 (serialized): insert under the current budget.
    return serialized(async (): Promise<Result<ArtworkLookup>> => {
      const section = await loadSection(context);
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
        await call(() => deps.paths.remove(destPath, context.signal));
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
        const committed = await commitSection(entries, context);
        if (!committed.ok) {
          return committed;
        }
        return ok({ hit: true, filePath: existing.filePath });
      }
      for (const other of entries.values()) {
        if (other.filePath === destPath) {
          await call(() =>
            deps.paths.remove(destPath, context.signal),
          );
          return err(
            appError(
              'invalid-response',
              'artwork destination path collides with a cached entry',
            ),
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
      const committed = await commitSection(entries, context);
      if (!committed.ok) {
        // Without its row the new file is orphaned; remove it.
        await call(() => deps.paths.remove(destPath, context.signal));
        return committed;
      }
      return ok({ hit: false, filePath: destPath });
    });
  }

  async function waitFor(
    record: Inflight,
    context: OperationContext,
  ): Promise<Result<ArtworkLookup>> {
    const result = await record.promise;
    if (context.signal.cancelled) {
      return err(appError('cancelled', 'cancelled'));
    }
    return result;
  }

  function get(
    url: string,
    context: OperationContext,
  ): Promise<Result<ArtworkLookup>> {
    if (!isArtworkUrl(url)) {
      return Promise.resolve(
        err(appError('invalid-response', 'invalid artwork url')),
      );
    }
    if (context.signal.cancelled) {
      return Promise.resolve(
        err(appError('cancelled', 'cancelled')),
      );
    }
    // Concurrent gets for the same url coalesce onto one download.
    const pending = inflight.get(url);
    if (pending !== undefined) {
      return waitFor(pending, context);
    }
    // Placeholder replaced before the record is published to the map.
    const record: Inflight = {
      promise: Promise.resolve(
        err(appError('internal', 'inflight record unset')),
      ),
    };
    record.promise = (async (): Promise<Result<ArtworkLookup>> => {
      try {
        return await runGet(url, context);
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
          return err(appError('cancelled', 'cancelled'));
        }
        const section = await loadSection(context);
        if (!section.ok) {
          return section;
        }
        const budgetBytes = artworkCacheBudgetBytes(
          section.value.settings,
        );
        const eviction = await evictUnderBudget(
          section.value.entries,
          budgetBytes,
          null,
          context.signal,
        );
        if (eviction.evicted > 0) {
          const committed = await commitSection(
            section.value.entries,
            context,
          );
          if (!committed.ok) {
            return committed;
          }
        }
        const report: ArtworkSweepReport = {
          evicted: eviction.evicted,
          evictedBytes: eviction.evictedBytes,
          totalBytes: totalBytes(section.value.entries),
          budgetBytes,
        };
        // A removal failure is honest: achieved evictions are already
        // committed, but the sweep reports the error it hit.
        if (eviction.firstError !== null) {
          return err(eviction.firstError);
        }
        return ok(report);
      },
    );
  }

  return { get, sweep };
}
