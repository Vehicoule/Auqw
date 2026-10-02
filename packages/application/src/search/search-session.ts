import { CancellationSource } from '../cancellation.ts';
import type { OperationContext } from '../cancellation.ts';
import type { AppError, Result } from '../errors.ts';
import { appError, fromUnknown } from '../errors.ts';
import { isSafeNonNegative } from '../domain.ts';
import { retryBounded } from '../retry.ts';
import { saturatingAdd } from '../session/util.ts';
import type { IdPort } from '../ports/runtime.ts';
import type { ClockPort } from '../ports/clock.ts';
import { searchPageHasContent } from '../ports/provider.ts';
import type { ProviderPort, SearchKind, SearchPage } from '../ports/provider.ts';

export type SearchState =
  | { readonly type: 'idle'; readonly revision: number }
  | {
    readonly type: 'loading';
    readonly revision: number;
    readonly query: string;
  }
  | {
    readonly type: 'content';
    readonly revision: number;
    readonly query: string;
    readonly page: SearchPage;
    readonly refreshError?: AppError;
  }
  | { readonly type: 'empty'; readonly revision: number; readonly query: string }
  | {
    readonly type: 'error';
    readonly revision: number;
    readonly query: string;
    readonly error: AppError;
    readonly retryAtMs?: number;
  };

const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 100;
const REQUEST_DEADLINE_MS = 15_000;
const RATE_LIMIT_FALLBACK_MS = 60_000;

type CacheEntry = { readonly page: SearchPage; readonly storedAtMs: number };

type Inflight = {
  readonly source: CancellationSource;
  promise: Promise<SearchState>;
};

export class SearchSession {
  #state: SearchState = { type: 'idle', revision: 0 };
  #listeners = new Set<(state: SearchState) => void>();
  // Map iteration order is insertion order; entries are re-inserted
  // on access, making it an LRU.
  #cache = new Map<string, CacheEntry>();
  #inflight = new Map<string, Inflight>();
  #source: CancellationSource | null = null;
  readonly #cacheTtlMs: number;
  readonly #maxEntries: number;
  readonly #provider: ProviderPort;
  readonly #clock: ClockPort;
  readonly #ids: IdPort;

  constructor(
    provider: ProviderPort,
    clock: ClockPort,
    ids: IdPort,
    options?: { cacheTtlMs?: number; maxEntries?: number },
  ) {
    this.#provider = provider;
    this.#clock = clock;
    this.#ids = ids;
    const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!isSafeNonNegative(cacheTtlMs) || cacheTtlMs === 0) {
      throw new TypeError('cacheTtlMs must be a positive safe integer');
    }
    if (!isSafeNonNegative(maxEntries) || maxEntries === 0) {
      throw new TypeError('maxEntries must be a positive safe integer');
    }
    this.#cacheTtlMs = cacheTtlMs;
    this.#maxEntries = maxEntries;
  }

  snapshot(): SearchState {
    return this.#state;
  }

  subscribe(listener: (state: SearchState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #publish(state: SearchState): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch {
        // Subscriber exceptions are isolated.
      }
    }
  }

  cancel(): void {
    if (
      this.#source === null &&
      this.#inflight.size === 0 &&
      this.#state.type === 'idle'
    ) {
      return;
    }
    this.#source?.cancel();
    this.#source = null;
    this.#inflight.clear();
    if (this.#state.type !== 'idle') {
      this.#publish({ type: 'idle', revision: this.#state.revision + 1 });
    }
  }

  search(input: {
    query: string;
    limit: number;
    storefront: string | null;
    /** Result kinds to serve; absent asks for everything. */
    kinds?: readonly SearchKind[] | undefined;
    /** Next-page token from a prior result; absent fetches page one. */
    continuation?: string | undefined;
  }): Promise<SearchState> {
    const query = input.query.trim();
    if (query.length === 0) {
      this.cancel();
      return Promise.resolve(this.#state);
    }

    // `kinds` is a set: normalize before it keys the cache or reaches
    // the wire so ['album','artist'] and ['artist','album'] coalesce.
    const kinds =
      input.kinds === undefined
        ? undefined
        : [...new Set(input.kinds)].sort();
    // An empty set asks for nothing the absent key doesn't — the wire
    // never emits it, so it keys the cache identically.
    const filter = kinds === undefined || kinds.length === 0 ? undefined : kinds;
    const continuation =
      input.continuation === undefined || input.continuation.length === 0
        ? undefined
        : input.continuation;

    const key = JSON.stringify([
      this.#provider.id,
      query,
      input.limit,
      input.storefront,
      filter ?? null,
      // Page tokens key their own entry — a next page never collides
      // with the cached first page it continues.
      continuation ?? null,
    ]);

    // Coalesce only when the in-flight record is the current one and
    // its source was not cancelled — a superseded same-key request is
    // a fresh call.
    const pending = this.#inflight.get(key);
    if (
      pending !== undefined &&
      pending.source === this.#source &&
      !pending.source.signal.cancelled
    ) {
      return pending.promise;
    }

    // Every new intent supersedes the active request, including paths
    // that return early from a cache hit or an invalid clock reading.
    this.#source?.cancel();
    this.#source = null;

    const now = this.#clock.nowMs();
    if (!isSafeNonNegative(now)) {
      // A broken clock must not produce an unsafe context.
      const state: SearchState = {
        type: 'error',
        revision: this.#state.revision + 1,
        query,
        error: appError('internal', 'clock returned an unsafe timestamp'),
      };
      this.#publish(state);
      return Promise.resolve(state);
    }

    const cached = this.#cache.get(key);
    if (
      cached !== undefined &&
      saturatingAdd(cached.storedAtMs, this.#cacheTtlMs) > now
    ) {
      // LRU touch on access.
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      const revision = this.#state.revision + 1;
      const state: SearchState = searchPageHasContent(cached.page)
        ? { type: 'content', revision, query, page: cached.page }
        : { type: 'empty', revision, query };
      this.#publish(state);
      return Promise.resolve(state);
    }

    const source = new CancellationSource();
    this.#source = source;
    const revision = this.#state.revision + 1;
    this.#publish({ type: 'loading', revision, query });

    const context: OperationContext = {
      requestId: this.#ids.next('search'),
      deadlineMs: saturatingAdd(now, REQUEST_DEADLINE_MS),
      signal: source.signal,
    };

    const record: Inflight = { source, promise: Promise.resolve(this.#state) };
    record.promise = this.#run(
      key,
      query,
      {
        limit: input.limit,
        storefront: input.storefront,
        kinds: filter,
        continuation,
      },
      context,
      revision,
      record,
    );
    this.#inflight.set(key, record);
    return record.promise;
  }

  async #run(
    key: string,
    query: string,
    input: {
      limit: number;
      storefront: string | null;
      kinds?: readonly SearchKind[] | undefined;
      continuation?: string | undefined;
    },
    context: OperationContext,
    revision: number,
    record: Inflight,
  ): Promise<SearchState> {
    let result: Result<SearchPage>;
    try {
      // Transient failures retry inside the request's own deadline —
      // the same budget the UI already waits on — with per-attempt
      // request ids for diagnostics.
      result = await retryBounded({
        deadlineMs: context.deadlineMs,
        signal: context.signal,
        clock: this.#clock,
        call: async (signal) => {
          try {
            return await this.#provider.search(
              {
                query,
                limit: input.limit,
                storefront: input.storefront,
                kinds: input.kinds,
                continuation: input.continuation,
              },
              {
                requestId: this.#ids.next('search'),
                deadlineMs: context.deadlineMs,
                signal,
              },
            );
          } catch (thrown) {
            return { ok: false as const, error: fromUnknown(thrown) };
          }
        },
      });
    } finally {
      // Only the record's own completion removes it — a superseded
      // same-key request must not delete the newer record.
      if (this.#inflight.get(key) === record) {
        this.#inflight.delete(key);
      }
    }

    // Final-wins by source identity: a superseded or cancelled
    // request never publishes and never overwrites cache or state.
    if (this.#source !== record.source || context.signal.cancelled) {
      return this.#state;
    }

    if (result.ok) {
      const page = result.value;
      // Re-validate the clock before caching; an unsafe timestamp
      // skips caching but still publishes the content.
      const storedNow = this.#clock.nowMs();
      if (isSafeNonNegative(storedNow)) {
        // Delete before set so a refreshed entry becomes MRU.
        this.#cache.delete(key);
        this.#cache.set(key, { page, storedAtMs: storedNow });
      }
      while (this.#cache.size > this.#maxEntries) {
        const oldest = this.#cache.keys().next();
        if (oldest.done) {
          break;
        }
        this.#cache.delete(oldest.value);
      }
      const state: SearchState = searchPageHasContent(page)
        ? { type: 'content', revision, query, page }
        : { type: 'empty', revision, query };
      this.#publish(state);
      return state;
    }

    const error = result.error;
    // Our own cancels were filtered above; a provider-side 'cancelled'
    // still settles the search — it flows through the stale-cache and
    // error paths like any other failure rather than leaving 'loading'.
    const stale = this.#cache.get(key);
    if (stale !== undefined && searchPageHasContent(stale.page)) {
      const state: SearchState = {
        type: 'content',
        revision,
        query,
        page: stale.page,
        refreshError: error,
      };
      this.#publish(state);
      return state;
    }
    const retryNow = this.#clock.nowMs();
    const retryAtMs = isSafeNonNegative(retryNow)
      ? saturatingAdd(retryNow, error.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS)
      : undefined;
    const state: SearchState =
      error.kind === 'rate-limit' && retryAtMs !== undefined
        ? { type: 'error', revision, query, error, retryAtMs }
        : { type: 'error', revision, query, error };
    this.#publish(state);
    return state;
  }
}
