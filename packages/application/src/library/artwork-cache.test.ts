import { CancellationSource } from '../cancellation.ts';
import type {
  CancellationSignal,
  OperationContext,
} from '../cancellation.ts';
import type { Settings } from '../domain.ts';
import {
  ARTWORK_CACHE_BUDGET_DEFAULT_BYTES,
  ARTWORK_CACHE_BUDGET_MAX_BYTES,
  ARTWORK_CACHE_BUDGET_MIN_BYTES,
} from '../domain.ts';
import type { AppError, Result } from '../errors.ts';
import { appError, err, ok } from '../errors.ts';
import type { PersistedState } from '../ports/storage.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import {
  Deferred,
  FakeClock,
  FakeLog,
  FakeStorage,
  SequenceIds,
} from '../testing/fakes.ts';
import { assert, assertDeepEqual, assertEqual } from '../testing/assert.ts';
import {
  artworkCacheBudgetBytes,
  createArtworkCache,
} from './artwork-cache.ts';
import type {
  ArtworkCache,
  ArtworkFetchPort,
  ArtworkPathsPort,
} from './artwork-cache.ts';
import type { ArtworkCacheEntry } from './library.ts';

const MB = 1024 * 1024;
const BUDGET = 25 * MB;

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: 'US',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
  artworkCacheBytes: BUDGET,
};

const QUEUE: QueueSnapshot = {
  revision: 0,
  occurrences: [],
  currentOccurrenceId: null,
  positionMs: 0,
  mode: 'stopped',
};

function persisted(partial: Partial<PersistedState> = {}): PersistedState {
  return {
    recordings: partial.recordings ?? [],
    likes: partial.likes ?? [],
    entities: partial.entities ?? [],
    entitySourceRefs: partial.entitySourceRefs ?? [],
    playlists: partial.playlists ?? [],
    playlistEntries: partial.playlistEntries ?? [],
    playHistory: partial.playHistory ?? [],
    playCounts: partial.playCounts ?? [],
    matchReviews: partial.matchReviews ?? [],
    lyricsCache: partial.lyricsCache ?? [],
    artworkCache: partial.artworkCache ?? [],
    queue: partial.queue ?? QUEUE,
    settings: partial.settings ?? SETTINGS,
  };
}

/** Mirrors FakeArtworkPaths.destFor so seed rows resolve honestly. */
function destOf(url: string): string {
  return `/art/${encodeURIComponent(url)}`;
}

function seed(
  url: string,
  bytes: number,
  lastAccessedMs: number,
): ArtworkCacheEntry {
  return { url, filePath: destOf(url), bytes, lastAccessedMs };
}

function ctx(source = new CancellationSource()): OperationContext {
  return {
    requestId: 'test-req',
    deadlineMs: Number.MAX_SAFE_INTEGER,
    signal: source.signal,
  };
}

async function pump(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

class FakeArtworkFetch implements ArtworkFetchPort {
  readonly calls: {
    url: string;
    destPath: string;
    signal: CancellationSignal;
  }[] = [];
  #deferreds: Deferred<Result<{ bytes: number }>>[] = [];
  #auto: ((url: string) => Result<{ bytes: number }>) | null = null;

  /** Every subsequent download resolves immediately via fn. */
  respond(fn: (url: string) => Result<{ bytes: number }>): void {
    this.#auto = fn;
  }

  /** Shorthand for `respond(() => ok({ bytes }))`. */
  respondBytes(bytes: number): void {
    this.#auto = () => ok({ bytes });
  }

  download(
    url: string,
    destPath: string,
    signal: CancellationSignal,
  ): Promise<Result<{ bytes: number }>> {
    this.calls.push({ url, destPath, signal });
    if (this.#auto !== null) {
      const answer = this.#auto;
      try {
        return Promise.resolve(answer(url));
      } catch {
        return Promise.resolve(
          err(appError('internal', 'respond threw')),
        );
      }
    }
    const deferred = new Deferred<Result<{ bytes: number }>>();
    this.#deferreds.push(deferred);
    signal.subscribe(() => {
      deferred.resolve({
        ok: false,
        error: appError('cancelled', 'cancelled'),
      });
    });
    return deferred.promise;
  }

  /** Settles the oldest pending download; false when none pending. */
  settleDownload(result: Result<{ bytes: number }>): boolean {
    const deferred = this.#deferreds.shift();
    if (deferred === undefined) {
      return false;
    }
    deferred.resolve(result);
    return true;
  }

  get pendingDownloads(): number {
    return this.#deferreds.length;
  }
}

class FakeArtworkPaths implements ArtworkPathsPort {
  readonly dir = '/art';
  readonly removed: string[] = [];
  /** Paths the OS is simulated to have reclaimed. */
  readonly missing = new Set<string>();
  #failRemove: AppError | null = null;
  #failExists: AppError | null = null;

  /** The next remove fails once with the given typed error. */
  failNextRemove(error: AppError): void {
    this.#failRemove = error;
  }

  /** The next exists check fails once with the given typed error. */
  failNextExists(error: AppError): void {
    this.#failExists = error;
  }

  destFor(url: string): string {
    return `${this.dir}/${encodeURIComponent(url)}`;
  }

  exists(
    filePath: string,
    signal: CancellationSignal,
  ): Promise<Result<boolean>> {
    void signal;
    if (this.#failExists !== null) {
      const error = this.#failExists;
      this.#failExists = null;
      return Promise.resolve(err(error));
    }
    return Promise.resolve(ok(!this.missing.has(filePath)));
  }

  remove(
    filePath: string,
    signal: CancellationSignal,
  ): Promise<Result<void>> {
    void signal;
    this.removed.push(filePath);
    if (this.#failRemove !== null) {
      const error = this.#failRemove;
      this.#failRemove = null;
      return Promise.resolve(err(error));
    }
    return Promise.resolve(ok(undefined));
  }
}

type Rig = {
  cache: ArtworkCache;
  storage: FakeStorage;
  fetch: FakeArtworkFetch;
  paths: FakeArtworkPaths;
  clock: FakeClock;
  log: FakeLog;
};

function rig(state: PersistedState, now = 1_000): Rig {
  const storage = new FakeStorage(state);
  const fetch = new FakeArtworkFetch();
  const paths = new FakeArtworkPaths();
  const clock = new FakeClock(now);
  const log = new FakeLog();
  const cache = createArtworkCache({
    storage,
    clock,
    ids: new SequenceIds(),
    log,
    fetch,
    paths,
  });
  return { cache, storage, fetch, paths, clock, log };
}

const A = 'https://img/a.jpg';
const B = 'https://img/b.jpg';
const C = 'https://img/c.jpg';
const D = 'https://img/d.jpg';

async function storedUrls(storage: FakeStorage): Promise<string[]> {
  const loaded = await storage.load(ctx());
  assert(loaded.ok, 'load failed in test');
  return loaded.value.artworkCache.map((e) => e.url);
}

async function missAndHit(): Promise<void> {
  const r = rig(persisted());
  r.fetch.respondBytes(8 * MB);

  const miss = await r.cache.get(A, ctx());
  assert(miss.ok, 'miss get failed');
  assertEqual(miss.value.hit, false);
  assertEqual(miss.value.filePath, destOf(A));
  assertEqual(r.fetch.calls.length, 1);
  assertEqual(r.fetch.calls[0]?.destPath, destOf(A));

  const urls = await storedUrls(r.storage);
  assertEqual(urls.length, 1);
  assertEqual(urls[0], A);
  const loaded = await r.storage.load(ctx());
  assert(loaded.ok);
  const row = loaded.value.artworkCache[0];
  assertEqual(row?.bytes, 8 * MB);
  assertEqual(row?.lastAccessedMs, 1_000);

  // Second get hits: no re-download, lastAccessedMs writes through.
  r.clock.advance(500);
  const hit = await r.cache.get(A, ctx());
  assert(hit.ok, 'hit get failed');
  assertEqual(hit.value.hit, true);
  assertEqual(hit.value.filePath, destOf(A));
  assertEqual(r.fetch.calls.length, 1, 'hit must not download');
  const after = await r.storage.load(ctx());
  assert(after.ok);
  assertEqual(after.value.artworkCache[0]?.lastAccessedMs, 1_500);
}

async function fetchErrorsPropagate(): Promise<void> {
  const r = rig(persisted());
  r.fetch.respond(() =>
    err(appError('rate-limit', 'slow down', 30_000)),
  );
  const res = await r.cache.get(A, ctx());
  assert(!res.ok, 'rate-limited get must fail');
  assertEqual(res.error.kind, 'rate-limit');
  assertEqual(res.error.retryAfterMs, 30_000);
  assertEqual((await storedUrls(r.storage)).length, 0);

  r.fetch.respond(() => err(appError('unavailable', 'offline')));
  const off = await r.cache.get(B, ctx());
  assert(!off.ok);
  assertEqual(off.error.kind, 'unavailable');
  assertEqual((await storedUrls(r.storage)).length, 0);
}

async function invalidUrls(): Promise<void> {
  const r = rig(persisted());
  const http = await r.cache.get('http://img/x.jpg', ctx());
  assert(!http.ok && http.error.kind === 'invalid-response');
  const empty = await r.cache.get('', ctx());
  assert(!empty.ok && empty.error.kind === 'invalid-response');
  assertEqual(r.fetch.calls.length, 0);
}

async function lruEvictionOrder(): Promise<void> {
  const r = rig(
    persisted({
      artworkCache: [
        seed(A, 8 * MB, 10),
        seed(B, 8 * MB, 20),
        seed(C, 8 * MB, 30),
      ],
    }),
  );
  r.fetch.respondBytes(8 * MB);
  // 24 MB cached, budget 25 MB: D lands at 32 MB, evicts A only.
  const res = await r.cache.get(D, ctx());
  assert(res.ok, 'get failed');
  assertEqual(res.value.hit, false);
  assertEqual(r.paths.removed.length, 1);
  assertEqual(r.paths.removed[0], destOf(A));
  assert((await storedUrls(r.storage)).join(',') === `${B},${C},${D}`);
}

async function touchOnHitReorders(): Promise<void> {
  const r = rig(
    persisted({
      artworkCache: [
        seed(A, 8 * MB, 10),
        seed(B, 8 * MB, 20),
        seed(C, 8 * MB, 30),
      ],
    }),
  );
  r.fetch.respondBytes(8 * MB);
  const hit = await r.cache.get(A, ctx());
  assert(hit.ok && hit.value.hit, 'expected hit');
  // A is now MRU (lastAccessedMs = 1000); B becomes the evictee.
  const miss = await r.cache.get(D, ctx());
  assert(miss.ok);
  assertEqual(r.paths.removed.length, 1);
  assertEqual(r.paths.removed[0], destOf(B));
  const urls = await storedUrls(r.storage);
  assertEqual(urls.join(','), `${A},${C},${D}`);
}

async function oversizeEntryRejected(): Promise<void> {
  const r = rig(
    persisted({ artworkCache: [seed(A, 8 * MB, 10)] }),
  );
  // 26 MB download exceeds the 25 MB budget: rejected, never cached.
  r.fetch.respondBytes(26 * MB);
  const res = await r.cache.get(B, ctx());
  assert(!res.ok, 'oversize get must fail');
  assertEqual(res.error.kind, 'budget-exceeded');
  assertEqual(res.error.retryable, false);
  // The just-downloaded file is removed; existing rows are untouched.
  assert(r.paths.removed.includes(destOf(B)));
  assert((await storedUrls(r.storage)).join(',') === A);
}

async function coalescedConcurrentGets(): Promise<void> {
  const r = rig(persisted());
  const s1 = new CancellationSource();
  const s2 = new CancellationSource();
  const p1 = r.cache.get(A, ctx(s1));
  const p2 = r.cache.get(A, ctx(s2));
  await pump();
  assertEqual(r.fetch.calls.length, 1, 'gets must share one download');
  assert(
    r.fetch.settleDownload(ok({ bytes: 4 * MB })),
    'no pending download',
  );
  const [r1, r2] = await Promise.all([p1, p2]);
  assert(r1.ok && r2.ok);
  assertEqual(r1.value.filePath, destOf(A));
  assertEqual(r2.value.filePath, destOf(A));
  assertEqual(r1.value.hit, false);
  assertEqual(r2.value.hit, false);
  assertEqual((await storedUrls(r.storage)).length, 1);

  // After the download lands, a fresh get hits the stored entry.
  const third = await r.cache.get(A, ctx());
  assert(third.ok && third.value.hit, 'post-download get must hit');

  // A waiter cancelled mid-flight fails alone; the leader continues.
  const s3 = new CancellationSource();
  const s4 = new CancellationSource();
  const p3 = r.cache.get(B, ctx(s3));
  const p4 = r.cache.get(B, ctx(s4));
  await pump();
  assertEqual(r.fetch.calls.length, 2);
  s4.cancel();
  assert(r.fetch.settleDownload(ok({ bytes: 2 * MB })));
  const [r3, r4] = await Promise.all([p3, p4]);
  assert(r3.ok, 'leader get must succeed');
  assert(!r4.ok && r4.error.kind === 'cancelled');
}

async function cancellation(): Promise<void> {
  const r = rig(persisted());
  const dead = new CancellationSource();
  dead.cancel();
  const pre = await r.cache.get(A, ctx(dead));
  assert(!pre.ok && pre.error.kind === 'cancelled');
  assertEqual(r.fetch.calls.length, 0);

  // Cancellation mid-download aborts the transfer, caches nothing.
  const src = new CancellationSource();
  const pending = r.cache.get(A, ctx(src));
  await pump();
  assertEqual(r.fetch.calls.length, 1);
  src.cancel();
  const res = await pending;
  assert(!res.ok && res.error.kind === 'cancelled');
  assertEqual((await storedUrls(r.storage)).length, 0);
}

async function storageFailures(): Promise<void> {
  // Commit failure: the orphaned download file is cleaned up.
  const r = rig(persisted());
  r.fetch.respondBytes(4 * MB);
  r.storage.failNext(appError('transient', 'db write failed'));
  const res = await r.cache.get(A, ctx());
  assert(!res.ok && res.error.kind === 'transient');
  assert(
    r.paths.removed.includes(destOf(A)),
    'failed-commit file must be removed',
  );
  assertEqual((await storedUrls(r.storage)).length, 0);

  // Load failure: the typed error crosses back.
  const r2 = rig(persisted());
  r2.storage.holdNextLoad();
  const pending = r2.cache.get(B, ctx());
  await pump();
  assert(
    r2.storage.settleLoad(err(appError('transient', 'db down'))),
    'no pending load to settle',
  );
  const res2 = await pending;
  assert(!res2.ok && res2.error.kind === 'transient');
  assertEqual(r2.fetch.calls.length, 0);
}

async function sweepShrinkAndNoop(): Promise<void> {
  const r = rig(
    persisted({
      artworkCache: [
        seed(A, 8 * MB, 10),
        seed(B, 8 * MB, 20),
        seed(C, 8 * MB, 30),
      ],
      settings: { ...SETTINGS, artworkCacheBytes: 17 * MB },
    }),
  );
  // 24 MB cached under a 17 MB budget: evict oldest until it fits.
  const swept = await r.cache.sweep(ctx());
  assert(swept.ok, 'sweep failed');
  assertEqual(swept.value.evicted, 1);
  assertEqual(swept.value.evictedBytes, 8 * MB);
  assertEqual(swept.value.totalBytes, 16 * MB);
  assertEqual(swept.value.budgetBytes, 17 * MB);
  assertEqual(r.paths.removed.join(','), destOf(A));
  assert((await storedUrls(r.storage)).join(',') === `${B},${C}`);

  // No-op sweep commits nothing.
  const commits = r.storage.commits.length;
  const again = await r.cache.sweep(ctx());
  assert(again.ok);
  assertEqual(again.value.evicted, 0);
  assertEqual(r.storage.commits.length, commits, 'no-op sweep wrote');
}

async function sweepRemoveFailure(): Promise<void> {
  const r = rig(
    persisted({
      artworkCache: [
        seed(A, 8 * MB, 10),
        seed(B, 8 * MB, 20),
        seed(C, 8 * MB, 30),
      ],
      settings: { ...SETTINGS, artworkCacheBytes: 17 * MB },
    }),
  );
  r.paths.failNextRemove(appError('transient', 'fs busy'));
  const res = await r.cache.sweep(ctx());
  assert(!res.ok && res.error.kind === 'transient');
  // A's row survived (its file may still exist); B evicted to reach
  // 16 MB <= 17 MB, so C was never a candidate.
  assert((await storedUrls(r.storage)).join(',') === `${A},${C}`);
  assert(
    r.log.entries.some((e) => e.level === 'warn'),
    'removal failure must log a warning',
  );
}

async function budgetResolution(): Promise<void> {
  // Absent key resolves to the spec default; a set key wins.
  const { artworkCacheBytes: _drop, ...noKey } = SETTINGS;
  assertEqual(
    artworkCacheBudgetBytes(noKey),
    ARTWORK_CACHE_BUDGET_DEFAULT_BYTES,
  );
  assertEqual(artworkCacheBudgetBytes(SETTINGS), BUDGET);
  assertEqual(ARTWORK_CACHE_BUDGET_DEFAULT_BYTES, 200 * MB);
  assert(ARTWORK_CACHE_BUDGET_MIN_BYTES <= ARTWORK_CACHE_BUDGET_MAX_BYTES);

  // The default budget governs when the key is absent.
  const r = rig(
    persisted({
      artworkCache: [seed(A, 8 * MB, 10)],
      settings: noKey,
    }),
  );
  r.fetch.respondBytes(8 * MB);
  const res = await r.cache.get(B, ctx());
  assert(res.ok, 'default-budget get failed');
  assertEqual(r.paths.removed.length, 0, 'nothing near 200 MB budget');
}

async function osReapedFileScoresMiss(): Promise<void> {
  const r = rig(persisted({ artworkCache: [seed(A, 8 * MB, 10)] }));
  // The OS reclaimed the file but the row survived.
  r.paths.missing.add(destOf(A));
  r.fetch.respondBytes(8 * MB);
  const res = await r.cache.get(A, ctx());
  assert(res.ok, 'reaped get failed');
  assertEqual(res.value.hit, false, 'a reaped entry scores a miss');
  assertEqual(res.value.filePath, destOf(A));
  assertEqual(r.fetch.calls.length, 1, 'the entry re-downloads');
  // The stale row was replaced, not duplicated.
  assertDeepEqual(await storedUrls(r.storage), [A]);
}

async function getExistsErrorIsHonest(): Promise<void> {
  const r = rig(persisted({ artworkCache: [seed(A, 8 * MB, 10)] }));
  r.paths.failNextExists(appError('transient', 'fs busy'));
  const res = await r.cache.get(A, ctx());
  assert(!res.ok && res.error.kind === 'transient');
  // Presence was never disproven: the row survives and no
  // download ran.
  assertDeepEqual(await storedUrls(r.storage), [A]);
  assertEqual(r.fetch.calls.length, 0);
}

async function sweepReapsMissing(): Promise<void> {
  const r = rig(
    persisted({
      artworkCache: [
        seed(A, 8 * MB, 10),
        seed(B, 8 * MB, 20),
        seed(C, 8 * MB, 30),
      ],
    }),
  );
  r.paths.missing.add(destOf(B));
  const swept = await r.cache.sweep(ctx());
  assert(swept.ok, 'sweep failed');
  assertEqual(swept.value.reaped, 1);
  assertEqual(swept.value.reapedBytes, 8 * MB);
  assertEqual(swept.value.evicted, 0, 'reap alone fits the budget');
  assertDeepEqual(await storedUrls(r.storage), [A, C]);
  // A reaped row's file is already gone — nothing to remove.
  assertEqual(r.paths.removed.length, 0);
}

async function sweepExistsErrorKeepsRow(): Promise<void> {
  const r = rig(
    persisted({
      artworkCache: [seed(A, 8 * MB, 10), seed(B, 8 * MB, 20)],
    }),
  );
  r.paths.failNextExists(appError('transient', 'fs busy'));
  const res = await r.cache.sweep(ctx());
  assert(!res.ok && res.error.kind === 'transient');
  // A stat failure never deletes the row.
  assertDeepEqual(await storedUrls(r.storage), [A, B]);
  assert(
    r.log.entries.some((e) => e.level === 'warn'),
    'stat failure must log a warning',
  );
}

export async function run(): Promise<void> {
  await missAndHit();
  await fetchErrorsPropagate();
  await invalidUrls();
  await lruEvictionOrder();
  await touchOnHitReorders();
  await oversizeEntryRejected();
  await coalescedConcurrentGets();
  await cancellation();
  await storageFailures();
  await sweepShrinkAndNoop();
  await sweepRemoveFailure();
  await budgetResolution();
  await osReapedFileScoresMiss();
  await getExistsErrorIsHonest();
  await sweepReapsMissing();
  await sweepExistsErrorKeepsRow();
}
