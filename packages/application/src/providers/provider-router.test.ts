import { CancellationSource } from '../cancellation.ts';
import type { OperationContext } from '../cancellation.ts';
import { appError, ok } from '../errors.ts';
import type { EntityRef, SourceRef } from '../domain.ts';
import type {
  EntityPage,
  LyricsQuery,
  ProviderCapability,
  RadioPage,
} from '../ports/provider.ts';
import { FakeProvider } from '../testing/fakes.ts';
import { assert, assertDeepEqual, assertEqual } from '../testing/assert.ts';
import {
  ProviderRouter,
  selectionFromSettings,
} from './provider-router.ts';
import type { ProviderSelection } from './provider-router.ts';

const SELECTION: ProviderSelection = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  lyricsProvider: null,
  radioProvider: null,
};

function ctx(): OperationContext {
  return {
    requestId: 'r-1',
    deadlineMs: 10_000,
    signal: new CancellationSource().signal,
  };
}

function trackRef(provider: string, id: string): SourceRef {
  return { provider, kind: 'track', id };
}

function entityRef(provider: string, id: string): EntityRef {
  return { provider, kind: 'album', id };
}

const QUERY: LyricsQuery = {
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  durationMs: 200_000,
  isrc: null,
};

const ENTITY_PAGE: EntityPage = {
  entity: {
    sourceRef: entityRef('deezer', 'a1'),
    kind: 'album',
    title: 'Album',
    subtitle: null,
    artwork: [],
  },
  items: [],
  continuation: null,
  complete: true,
};

const RADIO_PAGE: RadioPage = { candidates: [], continuation: null };

async function slotRouting(): Promise<void> {
  const itunes = new FakeProvider('itunes', ['catalog.search']);
  const ytm = new FakeProvider('youtube-music', [
    'playback.resolve',
    'playback.candidates',
    'radio.seed',
  ]);
  const router = new ProviderRouter([itunes, ytm]);

  const search = router.providerFor('catalog.search', SELECTION);
  assert(search.ok && search.value === itunes, 'catalog slot → itunes');
  const resolve = router.providerFor('playback.resolve', SELECTION);
  assert(resolve.ok && resolve.value === ytm, 'playback slot → ytm');
  const candidates = router.providerFor('playback.candidates', SELECTION);
  assert(candidates.ok && candidates.value === ytm);

  // The configured provider must declare the capability: itunes
  // holds the catalog slot but never declared catalog.entity.
  const entity = router.providerFor('catalog.entity', SELECTION);
  assert(!entity.ok && entity.error.kind === 'unsupported');
  const metadata = router.providerFor('catalog.metadata', SELECTION);
  assert(!metadata.ok && metadata.error.kind === 'unsupported');
  // A configured id nobody registered is unsupported too.
  const missing = router.providerFor('catalog.search', {
    ...SELECTION,
    catalogProvider: 'ghost',
  });
  assert(!missing.ok && missing.error.kind === 'unsupported');
}

async function autoSelection(): Promise<void> {
  const itunes = new FakeProvider('itunes', ['catalog.search']);
  const ytm = new FakeProvider('youtube-music', [
    'playback.resolve',
    'radio.seed',
  ]);
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const router = new ProviderRouter([itunes, ytm, lrclib]);

  // The sole lyrics declarer serves both lyric capabilities.
  const synced = router.providerFor('lyrics.synced', SELECTION);
  assert(synced.ok && synced.value === lrclib);
  const plain = router.providerFor('lyrics.plain', SELECTION);
  assert(plain.ok && plain.value === lrclib);

  // The playback provider is preferred for radio among declarers.
  const radio = router.providerFor('radio.seed', SELECTION);
  assert(radio.ok && radio.value === ytm, 'playback provider seeds radio');

  // With a different playback provider, the first declarer serves.
  const alt = router.providerFor('radio.seed', {
    ...SELECTION,
    playbackProvider: 'itunes',
  });
  assert(alt.ok && alt.value === ytm, 'sole declarer still serves');

  // A capability nothing declares is unsupported.
  const bare = new ProviderRouter([itunes]);
  const none = bare.providerFor('radio.seed', SELECTION);
  assert(!none.ok && none.error.kind === 'unsupported');
  const noLyrics = bare.providerFor('lyrics.plain', SELECTION);
  assert(!noLyrics.ok && noLyrics.error.kind === 'unsupported');
}

async function explicitSelection(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', ['lyrics.plain']);
  const other = new FakeProvider('other-lyrics', ['lyrics.synced']);
  const ytm = new FakeProvider('youtube-music', ['radio.seed']);
  const router = new ProviderRouter([lrclib, other, ytm]);

  // An explicit pick wins over auto order — even when it declares
  // only part of the lyrics set.
  const selection: ProviderSelection = {
    ...SELECTION,
    lyricsProvider: 'other-lyrics',
    radioProvider: 'other-lyrics',
  };
  const synced = router.providerFor('lyrics.synced', selection);
  assert(synced.ok && synced.value === other);
  // The explicit pick is authoritative: undeclared → unsupported,
  // never silently rerouted to lrclib.
  const plain = router.providerFor('lyrics.plain', selection);
  assert(!plain.ok && plain.error.kind === 'unsupported');
  // Same rule for an explicit radio pick that lacks the capability.
  const radio = router.providerFor('radio.seed', selection);
  assert(!radio.ok && radio.error.kind === 'unsupported');
}

async function refScopedRouting(): Promise<void> {
  const itunes = new FakeProvider('itunes', ['catalog.search']);
  const deezer = new FakeProvider('deezer', [
    'catalog.search',
    'catalog.entity',
    'catalog.artwork',
  ]);
  const router = new ProviderRouter([itunes, deezer]);

  // A deezer ref goes to deezer even though itunes holds the catalog
  // slot — provenance, not the configured name.
  const page = router.getEntity(entityRef('deezer', 'a1'), ctx());
  assertEqual(deezer.pendingCount('entity'), 1);
  deezer.settleEntity(ok(ENTITY_PAGE));
  const result = await page;
  assert(result.ok && result.value === ENTITY_PAGE);

  // catalog.artwork follows the same provenance rule through
  // ProviderRouter.artwork — the ref's minting provider serves it.
  const art = router.artwork(trackRef('deezer', 'd1'), { size: 600 }, ctx());
  assertEqual(deezer.pendingCount('artwork'), 1);
  deezer.settleArtwork(ok([]));
  assert((await art).ok);

  // An itunes ref honestly reports unsupported — itunes never
  // declared catalog.entity, and the call is not rerouted to deezer.
  const denied = await router.getEntity(entityRef('itunes', 'i1'), ctx());
  assert(!denied.ok && denied.error.kind === 'unsupported');
  assertEqual(itunes.pendingCount('entity'), 0, 'no port call made');
  // An unregistered provider ref is unsupported the same way.
  const ghost = await router.getEntity(entityRef('tidal', 't1'), ctx());
  assert(!ghost.ok && ghost.error.kind === 'unsupported');
}

async function opDispatch(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const plainOnly = new FakeProvider('plain-lyrics', ['lyrics.plain']);
  const ytm = new FakeProvider('youtube-music', ['radio.seed']);
  const router = new ProviderRouter([lrclib, plainOnly, ytm]);

  // prefer=synced reaches the lyrics provider unchanged.
  const synced = router.getLyrics(
    SELECTION,
    { query: QUERY, prefer: 'synced' },
    ctx(),
  );
  assertEqual(lrclib.pendingCount('lyrics'), 1);
  lrclib.settleLyrics(
    ok({ kind: 'synced', lines: [{ tMs: 0, text: 'hi' }], matched: null }),
  );
  const syncedResult = await synced;
  assert(syncedResult.ok && syncedResult.value.kind === 'synced');

  // prefer=plain on a synced-less provider resolves the plain
  // capability — the result honestly says plain.
  const router2 = new ProviderRouter([plainOnly, ytm]);
  const plain = router2.getLyrics(
    SELECTION,
    { query: QUERY, prefer: 'synced' },
    ctx(),
  );
  assertEqual(plainOnly.pendingCount('lyrics'), 1);
  plainOnly.settleLyrics(ok({ kind: 'plain', text: 'words', matched: null }));
  const plainResult = await plain;
  assert(plainResult.ok && plainResult.value.kind === 'plain');

  // No lyrics provider at all → unsupported without a port call.
  const router3 = new ProviderRouter([ytm]);
  const none = await router3.getLyrics(
    SELECTION,
    { query: QUERY, prefer: 'plain' },
    ctx(),
  );
  assert(!none.ok && none.error.kind === 'unsupported');

  // Seed routing is ref-scoped; continuation routes by selection.
  const seed = router2.radioSeed(
    SELECTION,
    { sourceRef: trackRef('youtube-music', 'v1') },
    ctx(),
  );
  assertEqual(ytm.pendingCount('radio'), 1);
  ytm.settleRadio(ok(RADIO_PAGE));
  assert((await seed).ok);

  // A foreign seed ref is unsupported, never rerouted to ytm.
  const foreign = await router2.radioSeed(
    SELECTION,
    { sourceRef: trackRef('itunes', 'i1') },
    ctx(),
  );
  assert(!foreign.ok && foreign.error.kind === 'unsupported');

  // Continuation goes to the (auto-resolved) radio provider.
  const next = router2.radioSeed(
    SELECTION,
    { continuation: 'cont-1' },
    ctx(),
  );
  assertEqual(ytm.pendingCount('radio'), 1);
  ytm.settleRadio(ok(RADIO_PAGE));
  assert((await next).ok);
}

async function noSilentFailover(): Promise<void> {
  // A routed provider's failure propagates verbatim — the router
  // never substitutes another declarer after the fact.
  const first = new FakeProvider('deezer', ['catalog.entity']);
  const second = new FakeProvider('other', ['catalog.entity']);
  const router = new ProviderRouter([first, second]);
  const call = router.getEntity(entityRef('deezer', 'a1'), ctx());
  first.settleEntity({
    ok: false,
    error: appError('rate-limit', 'slow down', 500),
  });
  const result = await call;
  assert(!result.ok && result.error.kind === 'rate-limit');
  assertEqual(result.error.message, 'slow down');
  assertEqual(second.calls.length, 0, 'no fallback attempt');
}

async function settingsDerivation(): Promise<void> {
  const selection = selectionFromSettings({
    catalogProvider: 'itunes',
    playbackProvider: 'youtube-music',
    storefront: 'US',
    qualityKbps: 256,
    theme: 'system',
    prefetch: true,
    lyricsProvider: 'lyrics-lrclib',
    radioProvider: null,
  });
  assertDeepEqual(selection, {
    catalogProvider: 'itunes',
    playbackProvider: 'youtube-music',
    lyricsProvider: 'lyrics-lrclib',
    radioProvider: null,
  });
  // Absent optionals normalize to null.
  const bare = selectionFromSettings({
    catalogProvider: 'itunes',
    playbackProvider: 'youtube-music',
    storefront: null,
    qualityKbps: 128,
    theme: 'dark',
    prefetch: false,
  });
  assertEqual(bare.lyricsProvider, null);
  assertEqual(bare.radioProvider, null);
}

async function declarationGating(): Promise<void> {
  // The fake honors the declared set like the adapter: an op outside
  // it is unsupported without queueing.
  const partial = new FakeProvider('partial', ['catalog.search']);
  const caps: readonly ProviderCapability[] = partial.capabilities;
  assertDeepEqual(caps, ['catalog.search']);
  const result = await partial.getEntity(entityRef('partial', 'e1'), ctx());
  assert(!result.ok && result.error.kind === 'unsupported');
  const lyrics = await partial.getLyrics(
    { query: QUERY, prefer: 'synced' },
    ctx(),
  );
  assert(!lyrics.ok && lyrics.error.kind === 'unsupported');
  const radio = await partial.radioSeed({ continuation: 'c' }, ctx());
  assert(!radio.ok && radio.error.kind === 'unsupported');
  assertEqual(partial.pendingCount('entity'), 0);
  assertEqual(partial.pendingCount('lyrics'), 0);
  assertEqual(partial.pendingCount('radio'), 0);

  // Duplicate provider ids are a construction error, like Session's.
  let threw = false;
  try {
    new ProviderRouter([partial, new FakeProvider('partial')]);
  } catch {
    threw = true;
  }
  assert(threw, 'duplicate provider ids rejected');
}

async function fakeSettleRoundTrip(): Promise<void> {
  const provider = new FakeProvider('deezer', ['catalog.entity', 'radio.seed']);
  const source = new CancellationSource();
  const context: OperationContext = {
    requestId: 'r',
    deadlineMs: 1,
    signal: source.signal,
  };
  const entity = provider.getEntity(entityRef('deezer', 'a1'), context);
  source.cancel();
  const cancelled = await entity;
  assert(!cancelled.ok && cancelled.error.kind === 'cancelled');

  const radio = provider.radioSeed({ continuation: 'c' }, ctx());
  assert(provider.settleRadio(ok(RADIO_PAGE)));
  assert((await radio).ok);
}

export async function run(): Promise<void> {
  await slotRouting();
  await autoSelection();
  await explicitSelection();
  await refScopedRouting();
  await opDispatch();
  await noSilentFailover();
  await settingsDerivation();
  await declarationGating();
  await fakeSettleRoundTrip();
}
