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
    downloads: partial.downloads ?? [],
    localSources: partial.localSources ?? [],
    localFiles: partial.localFiles ?? [],
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
  /**
   * When set, downloads ignore the caller's cancel signal — models
   * a port that reports its own verdict even after cancellation.
   */
  deaf = false;
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
    if (!this.deaf) {
      signal.subscribe(() => {
        deferred.resolve({
          ok: false,
          error: appError('cancelled', 'cancelled'),
        });
      });
    }
    return deferred.promise;
  }

  /** Settles the oldest still-open download; false when none pending. */
  settleDownload(result: Result<{ bytes: number }>): boolean {
    // Cancelled downloads resolved through their signal listener are
    // already settled — a real aborted request is simply gone.
    let head = this.#deferreds[0];
    while (head !== undefined && head.settled) {
      this.#deferreds.shift();
      head = this.#deferreds[0];
    }
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

  #failExistsOnPresent: AppError | null = null;

  /** The next remove fails once with the given typed error. */
  failNextRemove(error: AppError): void {
    this.#failRemove = error;
  }

  /** The next exists check fails once with the given typed error. */
  failNextExists(error: AppError): void {
    this.#failExists = error;
  }

  /** The next exists check on a PRESENT file fails once — missing
   *  paths report missing first, so this lets a reap land before the
   *  failure does. */
  failExistsOnPresent(error: AppError): void {
    this.#failExistsOnPresent = error;
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
    if (this.missing.has(filePath)) {
      return Promise.resolve(ok(false));
    }
    if (this.#failExistsOnPresent !== null) {
      const error = this.#failExistsOnPresent;
      this.#failExistsOnPresent = null;
      return Promise.resolve(err(error));
    }
    return Promise.resolve(ok(true));
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

const A = 'https://art.example/a.jpg';
const B = 'https://art.example/b.jpg';
const C = 'https://art.example/c.jpg';
const D = 'https://art.example/d.jpg';

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

  // Second get hits: no re-download; the touch is write-behind —
  // storage still shows the insert's timestamp until the flush.
  r.clock.advance(500);
  const hit = await r.cache.get(A, ctx());
  assert(hit.ok, 'hit get failed');
  assertEqual(hit.value.hit, true);
  assertEqual(hit.value.filePath, destOf(A));
  assertEqual(r.fetch.calls.length, 1, 'hit must not download');
  const pending = await r.storage.load(ctx());
  assert(pending.ok);
  assertEqual(
    pending.value.artworkCache[0]?.lastAccessedMs,
    1_000,
    'touch is not yet persisted',
  );
  // The debounced flush lands the touch in one commit.
  r.clock.advance(3_000);
  await pump();
  const after = await r.storage.load(ctx());
  assert(after.ok);
  assertEqual(after.value.artworkCache[0]?.lastAccessedMs, 1_500);
}

async function fetchErrorsPropagate(): Promise<void> {
  const r = rig(persisted());
  r.fetch.respond(() =>
    err(appError('rate-limit', 'slow down', 30_000)),
  );
  // A retryable failure earns one in-deadline retry; both attempts
  // hit the same verdict, then the error propagates unchanged.
  const pending = r.cache.get(A, ctx());
  await pump();
  assertEqual(r.fetch.calls.length, 1);
  r.clock.advance(30_000);
  const res = await pending;
  assert(!res.ok, 'rate-limited get must fail');
  assertEqual(res.error.kind, 'rate-limit');
  assertEqual(res.error.retryAfterMs, 30_000);
  assertEqual(r.fetch.calls.length, 2, 'one bounded retry ran');
  assertEqual((await storedUrls(r.storage)).length, 0);

  // Negative cache: inside the verdict's retryAfter window a second
  // get answers from memory — no download at all.
  const again = await r.cache.get(A, ctx());
  assert(!again.ok && again.error.kind === 'rate-limit');
  assertEqual(
    r.fetch.calls.length,
    2,
    'negative cache suppresses the refetch',
  );

  r.fetch.respond(() => err(appError('unavailable', 'offline')));
  const second = r.cache.get(B, ctx());
  await pump();
  // 'unavailable' carries no retryAfter — the backoff fires next tick.
  r.clock.advance(1_000);
  const off = await second;
  assert(!off.ok);
  assertEqual(off.error.kind, 'unavailable');
  assertEqual((await storedUrls(r.storage)).length, 0);
}

async function negativeCacheExpiry(): Promise<void> {
  const r = rig(persisted());
  // Fail once transiently; the verdict caches for FAILURE_TTL_MS.
  let call = 0;
  r.fetch.respond(() => {
    call += 1;
    return call === 1
      ? err(appError('transient', 'blip'))
      : ok({ bytes: 4 * MB });
  });
  const pending = r.cache.get(A, ctx());
  await pump();
  r.clock.advance(1_000);
  const first = await pending;
  // The in-get retry already recovered — this get succeeded.
  assert(first.ok, 'transient then success must resolve');
  assertEqual(r.fetch.calls.length, 2, 'retry recovered in-window');

  // A hard-failing url: 'not-found' is the url's own verdict — one
  // attempt lands and the dead verdict negative-caches.
  r.fetch.respond(() => err(appError('not-found', 'dead')));
  const dead = r.cache.get(B, ctx());
  await pump();
  r.clock.advance(1_000);
  const failed = await dead;
  assert(!failed.ok);
  assertEqual(r.fetch.calls.length, 3, 'one attempt for B');
  // Remounts inside the TTL cost zero network calls.
  for (let i = 0; i < 5; i += 1) {
    const hit = await r.cache.get(B, ctx());
    assert(!hit.ok && hit.error.kind === 'not-found');
  }
  assertEqual(r.fetch.calls.length, 3, 'remounts stay suppressed');
  // Past the TTL the url earns a fresh try — and can succeed.
  r.fetch.respondBytes(4 * MB);
  r.clock.advance(25_000);
  const healed = await r.cache.get(B, ctx());
  assert(healed.ok, 'expired negative verdict must refetch');
  assertEqual(r.fetch.calls.length, 4);
}

async function unavailableIsNotNegativeCached(): Promise<void> {
  const r = rig(persisted());
  // 'unavailable' is the network's verdict, not the url's — an
  // offline get must not pin the url dead for the TTL while
  // connectivity could already be back on the next mount.
  r.fetch.respond(() => err(appError('unavailable', 'offline')));
  const failed = await r.cache.get(A, ctx());
  assert(!failed.ok && failed.error.kind === 'unavailable');
  assertEqual(r.fetch.calls.length, 1, 'one attempt, non-retryable');
  // Remount after recovery: the url earns a fresh download NOW,
  // not after FAILURE_TTL_MS.
  r.fetch.respondBytes(4 * MB);
  const recovered = await r.cache.get(A, ctx());
  assert(recovered.ok, 'recovery must not wait out a negative verdict');
  assertEqual(r.fetch.calls.length, 2, 'recovery refetches');
}

async function transportFailuresAreNotNegativeCached(): Promise<void> {
  const r = rig(persisted());
  // 'transient' after the in-get retry — like 'timeout' and
  // 'unavailable' — is the network's verdict, not the url's. The
  // negative cache must not pin it while connectivity could already
  // be back on the next mount.
  r.fetch.respond(() => err(appError('transient', 'blip')));
  const pending = r.cache.get(A, ctx());
  await pump();
  r.clock.advance(1_000);
  const failed = await pending;
  assert(!failed.ok && failed.error.kind === 'transient');
  assertEqual(r.fetch.calls.length, 2, 'in-window retry ran');
  // Recovery on the next mount — no TTL wait.
  r.fetch.respondBytes(4 * MB);
  const recovered = await r.cache.get(A, ctx());
  assert(recovered.ok, 'recovered get must refetch immediately');
  assertEqual(r.fetch.calls.length, 3, 'recovery refetches');
}

async function shortDeadlineWaiterLeavesSharedWork(): Promise<void> {
  const r = rig(persisted());
  // Leader with a 5 s budget; a second waiter joins with 30 s — the
  // shared download must outlive the leader's expiry and still
  // deliver to the waiter that had the budget for it.
  const leaderCtx: OperationContext = {
    requestId: 'leader',
    deadlineMs: r.clock.nowMs() + 5_000,
    signal: new CancellationSource().signal,
  };
  const p1 = r.cache.get(A, leaderCtx);
  await pump();
  assertEqual(r.fetch.calls.length, 1, 'shared download started');
  const followerCtx: OperationContext = {
    requestId: 'follower',
    deadlineMs: r.clock.nowMs() + 30_000,
    signal: new CancellationSource().signal,
  };
  const p2 = r.cache.get(A, followerCtx);
  await pump();
  assertEqual(r.fetch.calls.length, 1, 'follower coalesced');
  // The leader's deadline dies mid-download — it times out alone.
  r.clock.advance(5_000);
  await pump();
  const r1 = await p1;
  assert(!r1.ok && r1.error.kind === 'timeout', 'leader timed out');
  // The transfer keeps flying on the follower's budget — the
  // leader's expiry must not have cancelled the shared work.
  assert(
    r.fetch.calls[0]?.signal.cancelled === false,
    'shared download outlives the leader deadline',
  );
  assert(r.fetch.settleDownload(ok({ bytes: 4 * MB })));
  const r2 = await p2;
  assert(r2.ok, 'follower receives the shared result');
  assertEqual(r.fetch.calls.length, 1, 'still one download');
}

async function zeroRetryAfterStillNegativeCaches(): Promise<void> {
  const r = rig(persisted());
  // retryAfterMs: 0 is a floor, not a bypass — the verdict still
  // negative-caches for the default TTL instead of expiring
  // immediately and letting remounts re-hammer the dead url.
  r.fetch.respond(() => err(appError('rate-limit', 'slow down', 0)));
  const pending = r.cache.get(A, ctx());
  await pump();
  r.clock.advance(1_000);
  const failed = await pending;
  assert(!failed.ok && failed.error.kind === 'rate-limit');
  assertEqual(r.fetch.calls.length, 2, 'in-window retry ran');
  for (let i = 0; i < 3; i += 1) {
    const hit = await r.cache.get(A, ctx());
    assert(!hit.ok && hit.error.kind === 'rate-limit');
  }
  assertEqual(
    r.fetch.calls.length,
    2,
    'a zero retry hint cannot expire the verdict early',
  );
  // Past the default TTL the url earns a fresh try — and heals.
  r.fetch.respondBytes(4 * MB);
  r.clock.advance(25_000);
  const healed = await r.cache.get(A, ctx());
  assert(healed.ok, 'expired verdict refetches');
  assertEqual(r.fetch.calls.length, 3);
}

async function cancelledGetIsNotNegativeCached(): Promise<void> {
  const r = rig(persisted());
  const source = new CancellationSource();
  const pending = r.cache.get(A, ctx(source));
  await pump();
  source.cancel();
  const res = await pending;
  assert(!res.ok && res.error.kind === 'cancelled');
  // A cancel is the caller's choice, not the url's verdict — the
  // next get downloads afresh.
  r.fetch.respondBytes(4 * MB);
  const after = await r.cache.get(A, ctx());
  assert(after.ok, 'post-cancel get must fetch');
  assertEqual(r.fetch.calls.length, 2, 'cancel + refetch');
}

async function transientRetryRecovers(): Promise<void> {
  const r = rig(persisted());
  let call = 0;
  r.fetch.respond(() => {
    call += 1;
    return call === 1
      ? err(appError('timeout', 'upstream slow'))
      : ok({ bytes: 2 * MB });
  });
  const pending = r.cache.get(A, ctx());
  await pump();
  assertEqual(r.fetch.calls.length, 1);
  r.clock.advance(400);
  const res = await pending;
  assert(res.ok, 'timeout then success must resolve');
  assertEqual(res.value.filePath, destOf(A));
  assertEqual(r.fetch.calls.length, 2);
  assertEqual((await storedUrls(r.storage)).length, 1);
}

async function invalidUrls(): Promise<void> {
  const r = rig(persisted());
  const http = await r.cache.get('http://art.example/x.jpg', ctx());
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

  // The leader's own cancel must not kill shared work either — an
  // unmounted first subscriber leaves the download for the rest.
  const s5 = new CancellationSource();
  const s6 = new CancellationSource();
  const p5 = r.cache.get(C, ctx(s5));
  const p6 = r.cache.get(C, ctx(s6));
  await pump();
  assertEqual(r.fetch.calls.length, 3);
  s5.cancel();
  assert(
    r.fetch.settleDownload(ok({ bytes: 3 * MB })),
    'download must survive the leader cancelling',
  );
  const [r5, r6] = await Promise.all([p5, p6]);
  assert(!r5.ok && r5.error.kind === 'cancelled', 'leader sees cancelled');
  assert(r6.ok, 'waiter keeps the shared download');
  assertEqual(r6.value.filePath, destOf(C));

  // But once every waiter is gone, the work itself is cancelled —
  // downloads nobody still needs never land.
  const s7 = new CancellationSource();
  const s8 = new CancellationSource();
  const p7 = r.cache.get(D, ctx(s7));
  const p8 = r.cache.get(D, ctx(s8));
  await pump();
  assertEqual(r.fetch.calls.length, 4);
  s7.cancel();
  s8.cancel();
  // A get landing synchronously after the last waiter left — while
  // the cancelled record still sits in the map — must start fresh
  // work; joining the dead record could only answer cancelled.
  const p9 = r.cache.get(D, ctx());
  const [r7, r8] = await Promise.all([p7, p8]);
  assert(!r7.ok && !r8.ok, 'empty waiter set cancels the work');
  assertEqual(
    (await storedUrls(r.storage)).filter((u) => u === D).length,
    0,
    'abandoned download caches nothing',
  );
  await pump();
  assertEqual(
    r.fetch.calls.length,
    5,
    'late get must restart, not join cancelled work',
  );
  assert(r.fetch.settleDownload(ok({ bytes: 1 * MB })));
  const r9 = await p9;
  assert(r9.ok && r9.value.filePath === destOf(D));
}

async function abandonedGetCannotPoison(): Promise<void> {
  const r = rig(persisted());
  // This port answers on its own schedule — a cancelled signal does
  // not stop it returning a late HTTP error for the abandoned run.
  r.fetch.deaf = true;
  const s1 = new CancellationSource();
  const s2 = new CancellationSource();
  const p1 = r.cache.get(A, ctx(s1));
  const p2 = r.cache.get(A, ctx(s2));
  await pump();
  assertEqual(r.fetch.calls.length, 1);
  s1.cancel();
  s2.cancel();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert(!r1.ok && !r2.ok, 'all waiters cancelled');
  // A fresh get takes over while the abandoned download still flies.
  const p3 = r.cache.get(A, ctx());
  await pump();
  assertEqual(r.fetch.calls.length, 2, 'replacement run started');
  // The abandoned run reports a late HTTP failure — a teardown
  // artifact, not a verdict: it must not negative-cache over the
  // replacement's success.
  assert(
    r.fetch.settleDownload(err(appError('transient', 'server 500'))),
    'old download still pending',
  );
  assert(r.fetch.settleDownload(ok({ bytes: 4 * MB })));
  const res3 = await p3;
  assert(res3.ok, 'replacement get succeeded');
  const after = await r.cache.get(A, ctx());
  assert(
    after.ok && after.value.hit,
    'stale verdict must not mask the stored file',
  );
  assertEqual(r.fetch.calls.length, 2, 'no refetch after the race');
}

async function deadlineCancelsDownloadSignal(): Promise<void> {
  const r = rig(persisted());
  // A hung transfer that ignores even its own signal — the deadline
  // watchdog must still cancel the signal it was handed so the port
  // knows the budget died.
  r.fetch.deaf = true;
  const source = new CancellationSource();
  const context: OperationContext = {
    requestId: 'test-req',
    deadlineMs: r.clock.nowMs() + 10_000,
    signal: source.signal,
  };
  const pending = r.cache.get(A, context);
  await pump();
  assertEqual(r.fetch.calls.length, 1, 'download in flight');
  r.clock.advance(10_000);
  const res = await pending;
  assert(!res.ok && res.error.kind === 'timeout', 'deadline surfaces timeout');
  assert(
    r.fetch.calls[0]?.signal.cancelled === true,
    'watchdog cancellation reached the transfer signal',
  );
  assert(
    source.signal.cancelled === false,
    'the caller signal is untouched — only the attempt child died',
  );
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

async function hitsServeFromMirror(): Promise<void> {
  const r = rig(
    persisted({
      artworkCache: [seed(A, 8 * MB, 10), seed(B, 8 * MB, 20)],
    }),
  );
  const a = await r.cache.get(A, ctx());
  const b = await r.cache.get(B, ctx());
  const a2 = await r.cache.get(A, ctx());
  assert(
    a.ok && a.value.hit && b.ok && b.value.hit && a2.ok && a2.value.hit,
    'expected hits',
  );
  // The section loads once; every later hit reads the mirror — the
  // row-mount storm's per-hit full-state load is gone.
  assertEqual(r.storage.loads.length, 1, 'repeat hits read the mirror');
  assertEqual(r.storage.commits.length, 0, 'no per-hit commit');
  // One debounced flush persists the whole burst of touches.
  r.clock.advance(3_000);
  await pump();
  assertEqual(r.storage.commits.length, 1, 'one flush for the burst');
  const stored = await r.storage.load(ctx());
  assert(stored.ok);
  assertEqual(stored.value.artworkCache[0]?.lastAccessedMs, 1_000);
  assertEqual(stored.value.artworkCache[1]?.lastAccessedMs, 1_000);
  assertEqual(r.storage.loads.length, 2, 'only the read-back loaded');
}

async function mirrorRefreshesAfterTtl(): Promise<void> {
  const r = rig(persisted({ artworkCache: [seed(A, 8 * MB, 10)] }));
  const first = await r.cache.get(A, ctx());
  const second = await r.cache.get(A, ctx());
  assert(first.ok && second.ok, 'hits failed');
  assertEqual(r.storage.loads.length, 1, 'hits stay on the mirror');
  // Past the refresh window the next hit reloads — a budget change
  // from settings or an import is picked up within the window.
  r.clock.advance(61_000);
  const late = await r.cache.get(A, ctx());
  assert(late.ok && late.value.hit, 'refreshed get must still hit');
  assertEqual(r.storage.loads.length, 2, 'stale mirror reloaded');
}

async function commitFailureDropsMirror(): Promise<void> {
  const r = rig(persisted({ artworkCache: [seed(A, 8 * MB, 10)] }));
  const warm = await r.cache.get(A, ctx());
  assert(warm.ok && warm.value.hit, 'warm hit failed');
  // A structural mutation whose commit fails leaves the mirror
  // claiming a deletion storage never applied — it is discarded.
  r.paths.missing.add(destOf(A));
  r.storage.failNext(appError('transient', 'db write failed'));
  const failed = await r.cache.get(A, ctx());
  assert(!failed.ok && failed.error.kind === 'transient');
  assertEqual(r.fetch.calls.length, 0, 'never reached download');
  assertEqual(r.storage.loads.length, 1, 'no reload on the mirror');
  // The next get reloads storage truth: the row is back, its file
  // still missing, so it reaps again and this commit lands.
  r.fetch.respondBytes(4 * MB);
  const healed = await r.cache.get(A, ctx());
  assert(healed.ok, 'reloaded get failed');
  assertEqual(healed.value.hit, false, 'reaped row re-downloads');
  assertEqual(r.storage.loads.length, 2, 'mirror rebuilt from storage');
  assertDeepEqual(await storedUrls(r.storage), [A]);
}

async function touchFlushRetriesOnFailure(): Promise<void> {
  const r = rig(persisted({ artworkCache: [seed(A, 8 * MB, 10)] }));
  const warm = await r.cache.get(A, ctx());
  assert(warm.ok && warm.value.hit, 'warm hit failed');
  r.clock.advance(500);
  const hit = await r.cache.get(A, ctx());
  assert(hit.ok && hit.value.hit, 'hit failed');
  // Fail the first scheduled flush — the retry cycle re-arms on
  // its own and lands the touch without another get scheduling it.
  r.storage.failNext(appError('transient', 'db write failed'));
  r.clock.advance(3_000);
  await pump();
  // The failed commit never reached the applied log.
  assertEqual(r.storage.commits.length, 0, 'failed flush unapplied');
  const still = await r.storage.load(ctx());
  assert(still.ok);
  assertEqual(
    still.value.artworkCache[0]?.lastAccessedMs,
    10,
    'failed flush persisted nothing',
  );
  // The retry fires after a doubled delay (3s → 6s).
  r.clock.advance(7_000);
  await pump();
  assertEqual(r.storage.commits.length, 1, 'retry committed once');
  const after = await r.storage.load(ctx());
  assert(after.ok);
  assertEqual(
    after.value.artworkCache[0]?.lastAccessedMs,
    1_500,
    'retry landed the touch',
  );
}

async function sweepSeesUnflushedTouches(): Promise<void> {
  // A touch still waiting on the debounced flush must count for
  // recency — the sweep's fresh load carries the mirror's newer
  // access times forward instead of regressing LRU order.
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
  const hit = await r.cache.get(A, ctx());
  assert(hit.ok && hit.value.hit, 'expected hit');
  // A was touched at 1000 but the flush has not run; a persisted-only
  // sweep would still call it oldest. The mirror's time wins: B
  // evicts instead of A.
  const swept = await r.cache.sweep(ctx());
  assert(swept.ok, 'sweep failed');
  assertEqual(swept.value.evicted, 1);
  assertEqual(r.paths.removed.join(','), destOf(B));
  assertDeepEqual(await storedUrls(r.storage), [A, C]);
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

// CDN size variants of one asset — the grammar artwork-url.ts owns.
const G_SMALL =
  'https://lh3.googleusercontent.com/img/abc=w128-h128-l90-rj';
const G_BIG =
  'https://lh3.googleusercontent.com/img/abc=w1024-h1024-l90-rj';
const G_HUGE =
  'https://lh3.googleusercontent.com/img/abc=w2048-h2048-l90-rj';
const G_OTHER =
  'https://lh3.googleusercontent.com/img/zzz=w1024-h1024-l90-rj';
const D_SMALL =
  'https://e-cdns-images.dzcdn.net/images/cover/abc/64x64.jpg';
const D_BIG =
  'https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg';

async function siblingServesMiss(): Promise<void> {
  // The big variant cached (the full player fetched it); the small
  // variant's get answers with that file — no second download.
  const r = rig(
    persisted({ artworkCache: [seed(G_BIG, 3 * MB, 500)] }),
  );
  r.fetch.respondBytes(4 * MB);
  r.clock.advance(500);
  const res = await r.cache.get(G_SMALL, ctx());
  assert(res.ok, 'sibling get failed');
  assertEqual(res.value.hit, true);
  assertEqual(res.value.filePath, destOf(G_BIG));
  assertEqual(r.fetch.calls.length, 0, 'sibling hit must not download');
  // Read-only reuse: no row minted for the requested url — the file
  // stays owned by the sibling's single entry for bytes and eviction.
  assertDeepEqual(await storedUrls(r.storage), [G_BIG]);
  // The SIBLING's access time earned the hit — write-behind flush.
  r.clock.advance(3_000);
  await pump();
  const after = await r.storage.load(ctx());
  assert(after.ok);
  assertEqual(after.value.artworkCache[0]?.lastAccessedMs, 1_500);
  // Deezer-shaped urls key alike across their discrete ladder too.
  const r2 = rig(
    persisted({ artworkCache: [seed(D_BIG, 3 * MB, 500)] }),
  );
  const res2 = await r2.cache.get(D_SMALL, ctx());
  assert(res2.ok && res2.value.hit, 'deezer sibling must serve');
  assertEqual(res2.value.filePath, destOf(D_BIG));
  assertEqual(r2.fetch.calls.length, 0);
}

async function smallestAdequateSiblingWins(): Promise<void> {
  // Both variants cover the request — the 1024 file beats the 2048
  // (same asset, less decode memory for the row that asked).
  const r = rig(
    persisted({
      artworkCache: [seed(G_HUGE, 9 * MB, 10), seed(G_BIG, 3 * MB, 20)],
    }),
  );
  r.fetch.respondBytes(4 * MB);
  const res = await r.cache.get(G_SMALL, ctx());
  assert(res.ok, 'adequate sibling get failed');
  assertEqual(res.value.filePath, destOf(G_BIG));
  assertEqual(r.fetch.calls.length, 0);
}

async function undersizedAndForeignSiblingsDoNotServe(): Promise<void> {
  // A smaller variant can't cover the request; a different asset key
  // and a knob-less url never substitute — each is a real download.
  const r = rig(
    persisted({
      artworkCache: [
        seed(G_SMALL, 1 * MB, 10),
        seed(G_OTHER, 3 * MB, 20),
        seed(A, 2 * MB, 30),
      ],
    }),
  );
  r.fetch.respondBytes(4 * MB);
  const res = await r.cache.get(G_BIG, ctx());
  assert(res.ok, 'miss get failed');
  assertEqual(res.value.hit, false);
  assertEqual(r.fetch.calls.length, 1, 'real miss downloads');
}

async function siblingBeatsFailureVerdict(): Promise<void> {
  // The small variant 404'd, THEN the big one landed: the file beats
  // the remembered verdict — a dead size knob says nothing about the
  // asset's other variants.
  const r = rig(persisted());
  r.fetch.respond((url) =>
    url === G_SMALL
      ? err(appError('not-found', 'variant gone'))
      : ok({ bytes: 3 * MB }),
  );
  const dead = await r.cache.get(G_SMALL, ctx());
  assert(!dead.ok && dead.error.kind === 'not-found');
  const big = await r.cache.get(G_BIG, ctx());
  assert(big.ok, 'big variant download failed');
  // Still inside the verdict window — the sibling file answers.
  const res = await r.cache.get(G_SMALL, ctx());
  assert(res.ok, 'sibling file must beat the stale verdict');
  assertEqual(res.value.filePath, destOf(G_BIG));
  assertEqual(r.fetch.calls.length, 2, 'no refetch ran');
}

async function reapedSiblingFallsBackToDownload(): Promise<void> {
  // The sibling's row outlived its file — the reap drops the row and
  // the request downloads like any honest miss.
  const r = rig(
    persisted({ artworkCache: [seed(G_BIG, 3 * MB, 10)] }),
  );
  r.paths.missing.add(destOf(G_BIG));
  r.fetch.respondBytes(4 * MB);
  const res = await r.cache.get(G_SMALL, ctx());
  assert(res.ok, 'miss get failed');
  assertEqual(res.value.hit, false);
  assertEqual(res.value.filePath, destOf(G_SMALL));
  assertEqual(r.fetch.calls.length, 1);
  // The dead sibling row was reaped — its file is gone either way.
  assertDeepEqual(await storedUrls(r.storage), [G_SMALL]);
}

async function reapedSiblingYieldsToNextSibling(): Promise<void> {
  // The smallest adequate sibling's file is gone but a larger one's
  // survives — the reap yields to the next sibling, not a download.
  const r = rig(
    persisted({
      artworkCache: [seed(G_HUGE, 9 * MB, 10), seed(G_BIG, 3 * MB, 20)],
    }),
  );
  r.paths.missing.add(destOf(G_BIG));
  r.fetch.respondBytes(4 * MB);
  const res = await r.cache.get(G_SMALL, ctx());
  assert(res.ok, 'sibling get failed');
  assertEqual(res.value.hit, true);
  assertEqual(res.value.filePath, destOf(G_HUGE));
  assertEqual(r.fetch.calls.length, 0);
  assertDeepEqual(await storedUrls(r.storage), [G_HUGE]);
  // Same through the exact row: G_SMALL's own file missing, the
  // bigger variant still answers.
  const r2 = rig(
    persisted({
      artworkCache: [seed(G_SMALL, 1 * MB, 10), seed(G_BIG, 3 * MB, 20)],
    }),
  );
  r2.paths.missing.add(destOf(G_SMALL));
  const res2 = await r2.cache.get(G_SMALL, ctx());
  assert(res2.ok && res2.value.hit, 'exact-reap sibling must serve');
  assertEqual(res2.value.filePath, destOf(G_BIG));
  assertEqual(r2.fetch.calls.length, 0);
  assertDeepEqual(await storedUrls(r2.storage), [G_BIG]);
}

async function statFailureStillCommitsReaps(): Promise<void> {
  // G_BIG's file is gone; the stat on the NEXT sibling errors — the
  // earlier reap must still commit or the mirror argues with storage.
  const r = rig(
    persisted({
      artworkCache: [seed(G_BIG, 3 * MB, 10), seed(G_HUGE, 9 * MB, 20)],
    }),
  );
  r.paths.missing.add(destOf(G_BIG));
  r.paths.failExistsOnPresent(appError('unavailable', 'stat broke'));
  const res = await r.cache.get(G_SMALL, ctx());
  assert(!res.ok, 'stat failure must surface');
  assertEqual(res.error.kind, 'unavailable');
  assertDeepEqual(await storedUrls(r.storage), [G_HUGE]);
}

export async function run(): Promise<void> {
  await missAndHit();
  await fetchErrorsPropagate();
  await negativeCacheExpiry();
  await unavailableIsNotNegativeCached();
  await transportFailuresAreNotNegativeCached();
  await shortDeadlineWaiterLeavesSharedWork();
  await zeroRetryAfterStillNegativeCaches();
  await cancelledGetIsNotNegativeCached();
  await transientRetryRecovers();
  await invalidUrls();
  await lruEvictionOrder();
  await touchOnHitReorders();
  await oversizeEntryRejected();
  await coalescedConcurrentGets();
  await abandonedGetCannotPoison();
  await deadlineCancelsDownloadSignal();
  await cancellation();
  await storageFailures();
  await sweepShrinkAndNoop();
  await sweepRemoveFailure();
  await budgetResolution();
  await osReapedFileScoresMiss();
  await getExistsErrorIsHonest();
  await hitsServeFromMirror();
  await mirrorRefreshesAfterTtl();
  await commitFailureDropsMirror();
  await touchFlushRetriesOnFailure();
  await sweepSeesUnflushedTouches();
  await sweepReapsMissing();
  await sweepExistsErrorKeepsRow();
  await siblingServesMiss();
  await smallestAdequateSiblingWins();
  await undersizedAndForeignSiblingsDoNotServe();
  await siblingBeatsFailureVerdict();
  await reapedSiblingFallsBackToDownload();
  await reapedSiblingYieldsToNextSibling();
  await statFailureStillCommitsReaps();
}
