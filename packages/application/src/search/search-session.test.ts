import { SearchSession } from './search-session.ts';
import type { SearchState } from './search-session.ts';
import { appError, ok } from '../errors.ts';
import type { SearchPage } from '../ports/provider.ts';
import type { TrackMetadata } from '../domain.ts';
import {
  FakeClock,
  FakeProvider,
  SequenceIds,
} from '../testing/fakes.ts';
import { assert, assertEqual } from '../testing/assert.ts';

function item(title: string): TrackMetadata {
  return {
    sourceRef: { provider: 'p', kind: 'track', id: title },
    title,
    artist: null,
    album: null,
    durationMs: null,
    releaseYear: null,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: null,
  };
}

function page(titles: readonly string[]): SearchPage {
  return { items: titles.map(item), storefront: 'US' };
}

function harness() {
  const provider = new FakeProvider('prov');
  const clock = new FakeClock(1_000);
  const ids = new SequenceIds();
  const session = new SearchSession(provider, clock, ids);
  return { provider, clock, ids, session };
}

const INPUT = { query: 'roads', limit: 5, storefront: 'US' as string | null };

async function basics(): Promise<void> {
  const { provider, session } = harness();
  const seen: SearchState[] = [];
  session.subscribe((s) => {
    seen.push(s);
    if (s.type === 'loading') {
      throw new Error('subscriber exceptions are isolated');
    }
  });
  session.subscribe((s) => {
    seen.push(s);
  });

  const pending = session.search(INPUT);
  assertEqual(session.snapshot().type, 'loading');
  assertEqual(provider.calls.length, 1);
  provider.settleSearch(ok(page(['Roads'])));
  const state = await pending;
  assertEqual(state.type, 'content');
  assertEqual(session.snapshot().type, 'content');
  if (state.type === 'content') {
    assertEqual(state.page.items[0]?.title, 'Roads');
  }
  // Two subscribers each saw the transitions; the throwing one still
  // received subsequent states.
  assert(seen.filter((s) => s.type === 'loading').length === 2);
  assert(seen.filter((s) => s.type === 'content').length === 2);

  // empty is distinct from loading.
  const emptyPending = session.search({ ...INPUT, query: 'nothing' });
  assertEqual(session.snapshot().type, 'loading');
  provider.settleSearch(ok(page([])));
  const empty = await emptyPending;
  assertEqual(empty.type, 'empty');
  assertEqual(session.snapshot().type, 'empty');
}

async function coalescing(): Promise<void> {
  const { provider, session } = harness();
  const p1 = session.search(INPUT);
  const p2 = session.search(INPUT);
  assert(p1 === p2, 'identical in-flight key returns the same Promise');
  assertEqual(provider.calls.length, 1);
  provider.settleSearch(ok(page(['x'])));
  await p1;
}

async function finalWins(): Promise<void> {
  const { provider, session } = harness();
  const first = session.search(INPUT);
  const second = session.search({ ...INPUT, query: 'other' });
  assertEqual(provider.calls.length, 2);
  // The stale request resolves last but must not publish.
  provider.settleSearch(ok(page(['stale-first-query-result'])));
  provider.settleSearch(ok(page(['fresh'])));
  await first;
  const state = await second;
  assertEqual(state.type, 'content');
  if (state.type === 'content') {
    assertEqual(
      state.page.items[0]?.title,
      'fresh',
      'final-wins: stale completion must not overwrite',
    );
  }
  // The stale promise resolves to the current state, not its own —
  // it never publishes the stale page.
  const stale = await first;
  assert(
    stale.type !== 'content' ||
    stale.page.items[0]?.title !== 'stale-first-query-result',
  );
}

async function typedErrors(): Promise<void> {
  const { provider, clock, session } = harness();
  const pending = session.search(INPUT);
  provider.settleSearch({
    ok: false,
    error: appError('rate-limit', 'slow down', 5_000),
  });
  const state = await pending;
  assertEqual(state.type, 'error');
  if (state.type === 'error') {
    assertEqual(state.error.kind, 'rate-limit');
    assertEqual(state.retryAtMs, clock.nowMs() + 5_000);
  }

  // Fallback retry window when retryAfterMs is absent.
  const again = session.search({ ...INPUT, query: 'rl2' });
  provider.settleSearch({ ok: false, error: appError('rate-limit', 'rl') });
  const rl = await again;
  if (rl.type === 'error') {
    assertEqual(rl.retryAtMs, clock.nowMs() + 60_000);
  } else {
    throw new Error('expected error state');
  }

  // A throwing port maps to the fixed internal error.
  const thrower = new FakeProvider('throwy');
  thrower.search = () => Promise.reject(new Error('raw'));
  const s2 = new SearchSession(thrower, clock, new SequenceIds());
  const thrownState = await s2.search(INPUT);
  assertEqual(thrownState.type, 'error');
  if (thrownState.type === 'error') {
    assertEqual(thrownState.error.kind, 'internal');
    assert(!thrownState.error.message.includes('raw'));
  }
}

async function cancelAndCache(): Promise<void> {
  const { provider, clock, session } = harness();

  // Cancel publishes idle and the cancelled request never publishes.
  const pending = session.search(INPUT);
  session.cancel();
  assertEqual(session.snapshot().type, 'idle');
  provider.settleSearch(ok(page(['late'])));
  await pending;
  assertEqual(session.snapshot().type, 'idle');

  // A fresh cache hit avoids the provider entirely.
  const p1 = session.search(INPUT);
  provider.settleSearch(ok(page(['Roads'])));
  await p1;
  const callsBefore = provider.calls.length;
  clock.advance(60_000);
  const hit = await session.search(INPUT);
  assertEqual(provider.calls.length, callsBefore, 'fresh cache: no call');
  assertEqual(hit.type, 'content');

  // After TTL expiry the provider is queried again.
  clock.advance(7 * 24 * 60 * 60 * 1000);
  const expired = session.search(INPUT);
  assertEqual(session.snapshot().type, 'loading');
  provider.settleSearch(ok(page(['Roads'])));
  await expired;
}

async function lruCap(): Promise<void> {
  const provider = new FakeProvider('lru');
  const clock = new FakeClock(0);
  const session = new SearchSession(provider, clock, new SequenceIds(), {
    maxEntries: 3,
    cacheTtlMs: 10_000,
  });
  for (const q of ['a', 'b', 'c']) {
    const p = session.search({ ...INPUT, query: q });
    provider.settleSearch(ok(page([q])));
    await p;
  }
  // Refresh 'a' to make it most-recently-used, then insert 'd' which
  // must evict 'b' (the oldest untouched entry).
  const pa = session.search({ ...INPUT, query: 'a' });
  await pa;
  const pd = session.search({ ...INPUT, query: 'd' });
  provider.settleSearch(ok(page(['d'])));
  await pd;

  const callsBefore = provider.calls.length;
  await session.search({ ...INPUT, query: 'a' });
  assertEqual(provider.calls.length, callsBefore, 'a stayed cached');
  const pb = session.search({ ...INPUT, query: 'b' });
  provider.settleSearch(ok(page(['b'])));
  await pb;
  assertEqual(
    provider.calls.length,
    callsBefore + 1,
    'b was evicted and refetched',
  );
}

async function rapidIntent(): Promise<void> {
  const { provider, session } = harness();
  // A(start) -> B(start cancels A) -> A(start before first A settles):
  // three provider calls; the final A wins.
  const pA1 = session.search({ ...INPUT, query: 'a' });
  const pB = session.search({ ...INPUT, query: 'b' });
  const pA2 = session.search({ ...INPUT, query: 'a' });
  assertEqual(provider.calls.length, 3, 'rapid A-B-A must issue 3 calls');
  // Same-key coalescing still applies to the live record.
  const pA3 = session.search({ ...INPUT, query: 'a' });
  assert(pA3 === pA2, 'coalescing targets the current record only');
  assertEqual(provider.calls.length, 3);

  // Out-of-order: settle the newest A first.
  provider.settleSearchAt(2, ok(page(['a-final'])));
  const sA2 = await pA2;
  assertEqual(sA2.type, 'content');
  if (sA2.type === 'content') {
    assertEqual(sA2.page.items[0]?.title, 'a-final');
  }
  const sB = await pB;
  const sA1 = await pA1;
  // Stale completions never published: final state is the last A.
  const final = session.snapshot();
  assertEqual(final.type, 'content');
  if (final.type === 'content') {
    assertEqual(final.query, 'a');
    assertEqual(final.page.items[0]?.title, 'a-final');
  }
  assert(sB.type !== 'error' && sA1.type !== 'error');
}

async function expiredRefreshLru(): Promise<void> {
  const provider = new FakeProvider('lru2');
  const clock = new FakeClock(0);
  const session = new SearchSession(provider, clock, new SequenceIds(), {
    maxEntries: 2,
    cacheTtlMs: 100,
  });
  for (const q of ['x', 'y']) {
    const p = session.search({ ...INPUT, query: q });
    provider.settleSearch(ok(page([q])));
    await p;
  }
  // Expire 'x', refetch it (it must become MRU), then insert 'z'
  // which must evict 'y'.
  clock.advance(200);
  const px = session.search({ ...INPUT, query: 'x' });
  provider.settleSearch(ok(page(['x2'])));
  await px;
  const pz = session.search({ ...INPUT, query: 'z' });
  provider.settleSearch(ok(page(['z'])));
  await pz;
  const callsBefore = provider.calls.length;
  await session.search({ ...INPUT, query: 'x' });
  assertEqual(provider.calls.length, callsBefore, 'refreshed x is MRU');
  const py = session.search({ ...INPUT, query: 'y' });
  provider.settleSearch(ok(page(['y'])));
  await py;
  assertEqual(
    provider.calls.length,
    callsBefore + 1,
    'y was evicted by the refresh',
  );
}

async function keyAndClockEdges(): Promise<void> {
  // Keys that collided under a joined-string scheme stay distinct.
  {
    const { provider, session } = harness();
    const p1 = session.search({ ...INPUT, query: 'a', limit: 22, storefront: 'b' });
    const p2 = session.search({ ...INPUT, query: 'a2', limit: 2, storefront: 'b' });
    assert(p1 !== p2, 'distinct keys must not coalesce');
    assertEqual(provider.calls.length, 2);
    provider.settleSearchAt(0, ok(page(['1'])));
    provider.settleSearchAt(0, ok(page(['2'])));
    await p1;
    await p2;
  }

  // Clock saturation: request deadline and retryAt clamp at MAX_SAFE.
  {
    const provider = new FakeProvider('sat');
    const clock = new FakeClock(Number.MAX_SAFE_INTEGER - 10);
    const session = new SearchSession(provider, clock, new SequenceIds());
    const p = session.search(INPUT);
    provider.settleSearch({
      ok: false,
      error: appError('rate-limit', 'rl', 60_000),
    });
    const state = await p;
    if (state.type === 'error') {
      assertEqual(state.retryAtMs, Number.MAX_SAFE_INTEGER);
    } else {
      throw new Error('expected saturated error state');
    }
  }

  // A broken clock publishes the fixed internal error instead of
  // forming an unsafe context.
  {
    const provider = new FakeProvider('badclock');
    const clock = new FakeClock(0);
    const broken = { nowMs: () => Number.NaN, sleep: clock.sleep.bind(clock) };
    const session = new SearchSession(provider, broken, new SequenceIds());
    const state = await session.search(INPUT);
    assertEqual(state.type, 'error');
    if (state.type === 'error') {
      assertEqual(state.error.kind, 'internal');
    }
    assertEqual(provider.calls.length, 0, 'no request on unsafe clock');
  }
}

async function optionsAndCancelEdges(): Promise<void> {
  const provider = new FakeProvider('opts');
  const clock = new FakeClock(0);
  const ids = new SequenceIds();
  for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    let threw = false;
    try {
      new SearchSession(provider, clock, ids, { cacheTtlMs: bad });
    } catch {
      threw = true;
    }
    assert(threw, `cacheTtlMs ${bad} must throw`);
    threw = false;
    try {
      new SearchSession(provider, clock, ids, { maxEntries: bad });
    } catch {
      threw = true;
    }
    assert(threw, `maxEntries ${bad} must throw`);
  }

  // cancel() on a fresh session is a no-op (no revision bump).
  const fresh = new SearchSession(provider, clock, new SequenceIds());
  fresh.cancel();
  assertEqual(fresh.snapshot().revision, 0, 'idle cancel is a no-op');
  fresh.cancel();
  assertEqual(fresh.snapshot().revision, 0);
}

async function nearMaxCache(): Promise<void> {
  // storedAt near MAX + ttl saturates: entry stays fresh below MAX.
  {
    const provider = new FakeProvider('nearmax');
    const clock = new FakeClock(Number.MAX_SAFE_INTEGER - 10);
    const session = new SearchSession(provider, clock, new SequenceIds());
    const p1 = session.search(INPUT);
    provider.settleSearch(ok(page(['Roads'])));
    await p1;
    clock.advance(5);
    const p2 = session.search(INPUT);
    const state = await p2;
    assertEqual(state.type, 'content', 'saturated expiry still fresh');
    assertEqual(provider.calls.length, 1, 'cache hit, no second call');
  }

  // A clock that turns unsafe at cache-write time skips caching.
  {
    const provider = new FakeProvider('unsa');
    const base = new FakeClock(100);
    let unsafe = false;
    const clock = {
      nowMs: () => (unsafe ? Number.NaN : base.nowMs()),
      sleep: (ms: number, signal: Parameters<typeof base.sleep>[1]) =>
        base.sleep(ms, signal),
    };
    const session = new SearchSession(provider, clock, new SequenceIds());
    const p1 = session.search(INPUT);
    unsafe = true;
    provider.settleSearch(ok(page(['Roads'])));
    await p1;
    unsafe = false;
    const p2 = session.search(INPUT);
    provider.settleSearch(ok(page(['Roads'])));
    await p2;
    assertEqual(provider.calls.length, 2, 'unsafe write skips cache');
  }

  // Rate-limit with an unsafe clock omits retryAtMs.
  {
    const provider = new FakeProvider('unrl');
    const base = new FakeClock(100);
    let unsafe = false;
    const clock = {
      nowMs: () => (unsafe ? Number.NaN : base.nowMs()),
      sleep: (ms: number, signal: Parameters<typeof base.sleep>[1]) =>
        base.sleep(ms, signal),
    };
    const session = new SearchSession(provider, clock, new SequenceIds());
    const p1 = session.search(INPUT);
    unsafe = true;
    provider.settleSearch({
      ok: false,
      error: appError('rate-limit', 'rl', 1000),
    });
    const state = await p1;
    assertEqual(state.type, 'error');
    if (state.type === 'error') {
      assertEqual(state.retryAtMs, undefined, 'unsafe now omits retryAt');
    }
  }
}

async function refreshError(): Promise<void> {
  const { provider, clock, session } = harness();
  const p1 = session.search(INPUT);
  provider.settleSearch(ok(page(['Roads'])));
  await p1;

  // Expire the entry, then a failed refresh keeps the cached page.
  clock.advance(8 * 24 * 60 * 60 * 1000);
  const p2 = session.search(INPUT);
  provider.settleSearch({ ok: false, error: appError('transient', 'down') });
  const state = await p2;
  assertEqual(state.type, 'content');
  if (state.type === 'content') {
    assertEqual(state.refreshError?.kind, 'transient');
    assertEqual(state.page.items[0]?.title, 'Roads');
  }
}

export async function run(): Promise<void> {
  await basics();
  await coalescing();
  await finalWins();
  await typedErrors();
  await cancelAndCache();
  await lruCap();
  await rapidIntent();
  await expiredRefreshLru();
  await keyAndClockEdges();
  await optionsAndCancelEdges();
  await refreshError();
  await nearMaxCache();
}
