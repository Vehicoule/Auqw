import { CancellationSource } from '../cancellation.ts';
import { appError, ok } from '../errors.ts';
import type { OperationContext } from '../cancellation.ts';
import type { PersistedState } from '../ports/storage.ts';
import type { AttemptTrace } from '../ports/player.ts';
import {
  Deferred,
  FakeClock,
  FakePlayer,
  FakeProvider,
  FakeStorage,
  SequenceIds,
} from './fakes.ts';
import { assert, assertDeepEqual, assertEqual } from './assert.ts';

function ctx(): OperationContext {
  return {
    requestId: 'r-1',
    deadlineMs: 10_000,
    signal: new CancellationSource().signal,
  };
}

function state(): PersistedState {
  return {
    recordings: [],
    likes: [],
    entities: [],
    entitySourceRefs: [],
    playlists: [],
    playlistEntries: [],
    playHistory: [],
    playCounts: [],
    matchReviews: [],
    lyricsCache: [],
    artworkCache: [],
    downloads: [],
    localSources: [],
    localFiles: [],
    queue: {
      revision: 0,
      occurrences: [],
      currentOccurrenceId: null,
      positionMs: 0,
      mode: 'stopped',
    },
    settings: {
      catalogProvider: 'itunes',
      playbackProvider: 'youtube-music',
      storefront: 'US',
      qualityKbps: 256,
      theme: 'system',
      prefetch: true,
    },
  };
}

async function deferredTests(): Promise<void> {
  const d = new Deferred<number>();
  d.resolve(1);
  d.resolve(2);
  d.reject(new Error('late'));
  assertEqual(await d.promise, 1, 'settle is idempotent');
}

async function clockTests(): Promise<void> {
  const clock = new FakeClock(100);
  assertEqual(clock.nowMs(), 100);

  const signal = new CancellationSource();
  const sleeping = clock.sleep(50, signal.signal);
  assertEqual(clock.pendingSleepers, 1);
  clock.advance(60);
  const slept = await sleeping;
  assert(slept.ok, 'sleep resolves after advance');
  assertEqual(clock.pendingSleepers, 0);

  // Cancellation settles once and cancels the sleeper.
  const source = new CancellationSource();
  const cancelled = clock.sleep(1000, source.signal);
  source.cancel();
  const res = await cancelled;
  assert(!res.ok && res.error.kind === 'cancelled');
  assertEqual(clock.pendingSleepers, 0);
  clock.advance(2000);
  assertEqual(clock.pendingSleepers, 0, 'settled sleeper cannot re-fire');

  // Validation and saturation.
  for (const bad of [-1, 1.5, Number.NaN]) {
    let threw = false;
    try {
      new FakeClock(bad);
    } catch {
      threw = true;
    }
    assert(threw, `FakeClock(${bad}) must throw`);
    threw = false;
    try {
      clock.advance(bad);
    } catch {
      threw = true;
    }
    assert(threw, `advance(${bad}) must throw`);
    threw = false;
    try {
      void clock.sleep(bad, new CancellationSource().signal);
    } catch {
      threw = true;
    }
    assert(threw, `sleep(${bad}) must throw`);
  }
  const maxClock = new FakeClock(Number.MAX_SAFE_INTEGER - 1);
  const s2 = new CancellationSource();
  const wake = maxClock.sleep(1000, s2.signal);
  maxClock.advance(1);
  await wake; // saturated wake time still resolves
}

async function playerTests(): Promise<void> {
  const player = new FakePlayer();
  let fired = 0;
  player.subscribe(() => {
    throw new Error('listener throws');
  });
  player.subscribe(() => {
    fired += 1;
  });
  player.emit({
    type: 'status',
    handle: 'h',
    identity: { attemptId: 'a', queueRev: 1 },
    state: 'playing',
    positionMs: 0,
  });
  assertEqual(fired, 1, 'throwing listener must not block others');

  player.setNextResult({ ok: false, error: appError('released', 'x') });
  const res = await player.pause({ attemptId: 'a', queueRev: 1 });
  assert(!res.ok && res.error.kind === 'released');
  const res2 = await player.pause({ attemptId: 'a', queueRev: 1 });
  assert(res2.ok, 'injected failure is consumed once');
}

async function storageTests(): Promise<void> {
  const storage = new FakeStorage(state());
  const loaded = await storage.load(ctx());
  assert(loaded.ok);
  // Clone-on-load: mutating the result cannot alter stored state.
  (loaded.value.queue as { revision: number }).revision = 99;
  const again = await storage.load(ctx());
  assert(again.ok && again.value.queue.revision === 0);

  // Clone-on-commit: mutating the batch after commit cannot alter it.
  // The like's target must exist — the fake now validates the merged
  // document exactly like sqlite does.
  const target: PersistedState['recordings'][number] = {
    id: 'r',
    title: 'T',
    artist: null,
    album: null,
    durationMs: 1000,
    releaseYear: null,
    artwork: [],
    explicit: null,
    genre: null,
    isrc: null,
    versionLabels: [],
    sourceRefs: [{ provider: 'itunes', kind: 'track', id: 'i1' }],
    mappings: [],
    provenance: 'provider',
  };
  const likes = [{ entityKind: 'track' as const, targetId: 'r', likedAtMs: 1 }];
  const committed = await storage.commit(
    { recordings: [target], likes },
    ctx(),
  );
  assert(committed.ok);
  const first = likes[0];
  if (first !== undefined) {
    first.targetId = 'mutated';
  }
  const after = await storage.load(ctx());
  assert(after.ok && after.value.likes[0]?.targetId === 'r');
  assertEqual(storage.commits.length, 1);

  // Atomic failure injection: one failure, then clean.
  storage.failNext(appError('transient', 'disk'));
  const failed = await storage.commit({ likes: [] }, ctx());
  assert(!failed.ok && failed.error.kind === 'transient');
  const retried = await storage.commit({ likes: [] }, ctx());
  assert(retried.ok);

  // Attempts: appended on commit, newest-first, capped at 500.
  const trace = (id: string): AttemptTrace => ({
    requestId: id,
    steps: 1,
    httpCalls: 0,
    bytes: 0,
    fuelUsed: 0,
    elapsedMs: 0,
    httpTrace: [],
    guestLog: [],
  });
  assert(
    (await storage.commit({ attempts: [trace('t1'), trace('t2')] }, ctx()))
      .ok,
  );
  const listed = await storage.loadAttempts(10, ctx());
  assert(listed.ok);
  assertDeepEqual(
    listed.value.map((t) => t.requestId),
    ['t2', 't1'],
  );
  const many = Array.from({ length: 510 }, (_, i) => trace(`b${i}`));
  assert((await storage.commit({ attempts: many }, ctx())).ok);
  const capped = await storage.loadAttempts(500, ctx());
  assert(capped.ok && capped.value.length === 500);
  assertEqual(capped.value[0]?.requestId, 'b509', 'newest first');
  assertEqual(capped.value[499]?.requestId, 'b10', 'oldest evicted');
  let threw = false;
  try {
    await storage.loadAttempts(0, ctx());
  } catch {
    threw = true;
  }
  assert(threw, 'invalid limit throws');
}

async function providerTests(): Promise<void> {
  const provider = new FakeProvider('p');
  const source = new CancellationSource();
  const context: OperationContext = {
    requestId: 'r',
    deadlineMs: 1,
    signal: source.signal,
  };
  const pending = provider.search(
    { query: 'q', limit: 1, storefront: null },
    context,
  );
  source.cancel();
  const cancelled = await pending;
  assert(!cancelled.ok && cancelled.error.kind === 'cancelled');
  assertEqual(provider.cancelledSignals.length, 1);

  // Cancellation also applies to non-search methods.
  const s2 = new CancellationSource();
  const c2: OperationContext = {
    requestId: 'r2',
    deadlineMs: 1,
    signal: s2.signal,
  };
  const details = provider.getDetails([], c2);
  s2.cancel();
  const detailsResult = await details;
  assert(!detailsResult.ok && detailsResult.error.kind === 'cancelled');

  // settle-at-index for out-of-order resolution (fresh provider;
  // cancelled deferreds remain queued and are skipped by index).
  const provider2 = new FakeProvider('p2');
  const p1 = provider2.search(
    { query: '1', limit: 1, storefront: null },
    ctx(),
  );
  const p2 = provider2.search(
    { query: '2', limit: 1, storefront: null },
    ctx(),
  );
  assertEqual(provider2.pendingCount('search'), 2);
  provider2.settleSearchAt(1, ok({ items: [], storefront: null }));
  const second = await p2;
  assert(second.ok);
  provider2.settleSearchAt(0, ok({ items: [], storefront: null }));
  await p1;
  assertEqual(provider2.pendingCount('search'), 0);

  // The 0.3.0 ops defer and settle like the rest, per declared caps.
  const provider3 = new FakeProvider('deezer', [
    'catalog.entity',
    'radio.seed',
  ]);
  const entity = provider3.getEntity(
    { provider: 'deezer', kind: 'album', id: 'a1' },
    ctx(),
  );
  assertEqual(provider3.pendingCount('entity'), 1);
  provider3.settleEntity(
    ok({
      entity: {
        sourceRef: { provider: 'deezer', kind: 'album', id: 'a1' },
        kind: 'album',
        title: 'Album',
        subtitle: null,
        artwork: [],
      },
      items: [],
      continuation: null,
      complete: true,
    }),
  );
  assert((await entity).ok);
  const radio = provider3.radioSeed({ continuation: 'c1' }, ctx());
  provider3.settleRadio(ok({ candidates: [], continuation: null }));
  assert((await radio).ok);
  // Undeclared ops are unsupported without queueing.
  const lyrics = await provider3.getLyrics(
    {
      query: {
        title: 't',
        artist: null,
        album: null,
        durationMs: null,
        isrc: null,
      },
      prefer: 'synced',
    },
    ctx(),
  );
  assert(!lyrics.ok && lyrics.error.kind === 'unsupported');
  const search = await provider3.search(
    { query: 'q', limit: 1, storefront: null },
    ctx(),
  );
  assert(!search.ok && search.error.kind === 'unsupported');
  assertEqual(provider3.pendingCount('lyrics'), 0);
  assertEqual(provider3.pendingCount('search'), 0);

  assert(new SequenceIds().next('x') === 'x-1');
}

export async function run(): Promise<void> {
  await deferredTests();
  await clockTests();
  await playerTests();
  await storageTests();
  await providerTests();
}
