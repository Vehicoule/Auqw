import { CancellationSource } from '../cancellation.ts';
import type { OperationContext } from '../cancellation.ts';
import type { Recording, Settings, SourceRef } from '../domain.ts';
import { appError, err, ok } from '../errors.ts';
import type {
  LyricsLine,
  LyricsMatch,
  LyricsResult,
} from '../ports/provider.ts';
import type { ProviderPort } from '../ports/provider.ts';
import type { PersistedState } from '../ports/storage.ts';
import { Session } from '../session/session.ts';
import type { ReadySession, SessionState } from '../session/session.ts';
import {
  FakeClock,
  FakeLog,
  FakePlayer,
  FakeProvider,
  FakeStorage,
  SequenceIds,
  SequenceRandom,
} from '../testing/fakes.ts';
import { assert, assertDeepEqual, assertEqual } from '../testing/assert.ts';
import {
  applyAcceptance,
  linesToLrc,
  LYRICS_DURATION_DRIFT_MS,
  lyricsCacheEntry,
  lyricsFromCache,
  parseLrc,
} from './lyrics.ts';
import { isLyricsCacheEntry } from './library.ts';
import type { LyricsCacheEntry } from './library.ts';
import { exportLibrary } from './export-import.ts';

const MATCHED: LyricsMatch = {
  title: 'Song r1',
  artist: 'Artist',
  album: 'Album',
  durationMs: 300_000,
};

const DURATION = { durationMs: 300_000 };

function lines(
  pairs: readonly (readonly [number, string])[],
): LyricsLine[] {
  return pairs.map(([tMs, text]) => ({ tMs, text }));
}

function syncedResult(
  pairs: readonly (readonly [number, string])[],
  matched: LyricsMatch | null = MATCHED,
): LyricsResult {
  return { kind: 'synced', lines: lines(pairs), matched };
}

const GOOD = [
  [0, 'first'],
  [10_000, 'second'],
  [20_500, 'third'],
] as const;

// ---- applyAcceptance: synced ---------------------------------------------

function syncedAcceptance(): void {
  // A well-formed synced record stays synced.
  const accepted = applyAcceptance(syncedResult(GOOD), DURATION);
  assert(accepted.kind === 'synced', 'well-formed synced is accepted');
  assertEqual(accepted.kind === 'synced' ? accepted.lines.length : 0, 3);

  // Drift at the bound is accepted; past it is not.
  const atBound = applyAcceptance(
    syncedResult(GOOD, { ...MATCHED, durationMs: 305_000 }),
    DURATION,
  );
  assert(atBound.kind === 'synced', 'drift at 5 s stays synced');
  assertEqual(LYRICS_DURATION_DRIFT_MS, 5_000, 'documented 5 s bound');
  const pastBound = applyAcceptance(
    syncedResult(GOOD, { ...MATCHED, durationMs: 305_001 }),
    DURATION,
  );
  assert(
    pastBound.kind === 'unavailable',
    'a drifted record is rejected wholesale — wrong record, wrong text',
  );

  // Unknown durations never fire the drift rule.
  const noRecordingDuration = applyAcceptance(
    syncedResult(GOOD, { ...MATCHED, durationMs: 999_000 }),
    { durationMs: null },
  );
  assert(
    noRecordingDuration.kind === 'synced',
    'unknown recording duration disables drift',
  );
  const noMatchedDuration = applyAcceptance(
    syncedResult(GOOD, { ...MATCHED, durationMs: null }),
    DURATION,
  );
  assert(noMatchedDuration.kind === 'synced', 'unknown record duration');
  const noEvidence = applyAcceptance(syncedResult(GOOD, null), DURATION);
  assert(noEvidence.kind === 'synced', 'absent matched evidence passes');

  // Structural failures degrade to plain on the words carried.
  const outOfOrder = applyAcceptance(
    syncedResult([
      [20_000, 'later'],
      [10_000, 'earlier'],
    ]),
    DURATION,
  );
  assert(outOfOrder.kind === 'plain', 'out-of-order is not synced');
  assertDeepEqual(
    outOfOrder.kind === 'plain' ? outOfOrder.text : null,
    'later\nearlier',
    'downgrade keeps the words the lines carry',
  );

  // Equal timestamps are not strictly monotonic.
  const equal = applyAcceptance(
    syncedResult([
      [10_000, 'a'],
      [10_000, 'b'],
    ]),
    DURATION,
  );
  assert(equal.kind === 'plain', 'equal timestamps downgrade to plain');

  // An empty timed-line set is never synced and carries no words.
  const empty = applyAcceptance(syncedResult([]), DURATION);
  assert(empty.kind === 'unavailable', 'empty lines → honest absence');

  // Malformed timestamps reject the timing, not the text.
  const malformed = applyAcceptance(
    syncedResult([
      [Number.NaN, 'still words'],
      [5_000, 'more'],
    ]),
    DURATION,
  );
  assert(malformed.kind === 'plain', 'non-safe tMs is a timing failure');
  const negative = applyAcceptance(
    syncedResult([
      [-1, 'neg'],
      [5_000, 'more'],
    ]),
    DURATION,
  );
  assert(negative.kind === 'plain', 'negative tMs is a timing failure');

  // Lines of nothing but whitespace have no words to degrade to.
  const blankWords = applyAcceptance(
    syncedResult([
      [10_000, 'a'],
      [5_000, ' '],
    ]),
    DURATION,
  );
  assert(
    blankWords.kind === 'plain',
    'a whitespace line joined still has words',
  );
  const onlyWhitespace = applyAcceptance(
    syncedResult([[5_000, '   ']]),
    DURATION,
  );
  // One valid monotonic line is a fine synced — blank text included.
  assert(onlyWhitespace.kind === 'synced', 'timed blanks are still timed');
}

// ---- applyAcceptance: plain / instrumental / unavailable ------------------

function otherAcceptance(): void {
  const plain: LyricsResult = {
    kind: 'plain',
    text: 'the words',
    matched: MATCHED,
  };
  assert(applyAcceptance(plain, DURATION).kind === 'plain');
  // Plain is never upgraded: acceptance cannot invent timestamps.
  assert(
    applyAcceptance(plain, { durationMs: null }).kind === 'plain',
    'plain never becomes synced',
  );

  const empty = applyAcceptance(
    { kind: 'plain', text: '   ', matched: MATCHED },
    DURATION,
  );
  assert(empty.kind === 'unavailable', 'whitespace text is no text');

  const drifted = applyAcceptance(
    { kind: 'plain', text: 'the words', matched: { ...MATCHED, durationMs: 400_000 } },
    DURATION,
  );
  assert(
    drifted.kind === 'unavailable',
    'a drifted plain record is wrong text too',
  );

  const instrumental: LyricsResult = {
    kind: 'instrumental',
    matched: MATCHED,
  };
  assert(
    applyAcceptance(instrumental, DURATION).kind === 'instrumental',
    'instrumental honored',
  );
  const driftedInstrumental = applyAcceptance(
    { kind: 'instrumental', matched: { ...MATCHED, durationMs: 90_000 } },
    DURATION,
  );
  assert(
    driftedInstrumental.kind === 'unavailable',
    'a drifted instrumental flag is not ours to claim',
  );

  const absent: LyricsResult = { kind: 'unavailable', matched: MATCHED };
  const passed = applyAcceptance(absent, DURATION);
  assert(passed.kind === 'unavailable' && passed.matched === MATCHED);
}

// ---- LRC parse / serialize -----------------------------------------------

function lrcParsing(): void {
  const parsed = parseLrc('[00:17.12] a\n[01:02.345] b\n[02:03] c\n[00:00.5] d');
  assertDeepEqual(
    parsed.map((l) => l.tMs),
    [500, 17_120, 62_345, 123_000],
    'fraction digits scale, unsorted input sorts',
  );
  assertEqual(parsed[0]?.text, 'd');

  // Metadata tags drop; the offset tag shifts later timestamps.
  const shifted = parseLrc(
    '[ti:Song]\n[offset:+250]\n[00:10.00] hi\n[offset:-50]\n[00:20.00] yo',
  );
  assertDeepEqual(
    shifted.map((l) => l.tMs),
    [10_250, 19_950],
    'offset applies to what follows it',
  );

  // Several stamps on one line emit one line per stamp.
  const multi = parseLrc('[00:10.00][00:20.00] again');
  assertDeepEqual(
    multi.map((l) => l.tMs),
    [10_000, 20_000],
  );
  assertEqual(multi[0]?.text, 'again');

  // Untimed lines and tag-only noise contribute nothing.
  assertEqual(parseLrc('plain text\n[la:eng]').length, 0);

  // Round-trip: lines → LRC → lines preserves tMs and text.
  const source = lines([
    [0, 'start'],
    [61_234, 'middle'],
    [3_661_000, 'past the hour'],
  ]);
  const round = parseLrc(linesToLrc(source));
  assertDeepEqual(
    round.map((l) => [l.tMs, l.text]),
    source.map((l) => [l.tMs, l.text]),
    'serialize/parse round-trip is lossless',
  );

  // Newline-bearing text cannot smuggle extra records.
  const smuggled = linesToLrc([{ tMs: 1_000, text: 'one\ntwo' }]);
  assertEqual(smuggled.split('\n').length, 1, 'embedded newlines flatten');

  // Text starting with '[' round-trips: the serializer separates the
  // stamp so the parser never reads the text as a second timestamp.
  const bracketed = lines([
    [0, '[Chorus]'],
    [10_000, '[offset:+500]'],
    [20_000, 'tail'],
  ]);
  assertDeepEqual(
    parseLrc(linesToLrc(bracketed)).map((l) => [l.tMs, l.text]),
    bracketed.map((l) => [l.tMs, l.text]),
    'bracketed text round-trips losslessly',
  );
}

// ---- cache mapping --------------------------------------------------------

function cacheMapping(): void {
  const acceptedSynced = applyAcceptance(syncedResult(GOOD), DURATION);
  assert(acceptedSynced.kind === 'synced');
  const entry = lyricsCacheEntry('r1', 'lyrics-lrclib', '0.1.3', acceptedSynced, 42);
  assert(entry !== null && entry.kind === 'synced');
  assert(entry !== null && isLyricsCacheEntry(entry), 'entry persists');
  assertEqual(entry?.provider, 'lyrics-lrclib');
  assertDeepEqual(
    entry?.payload.plainLyrics ?? null,
    'first\nsecond\nthird',
    'synced entries keep the joined plain text',
  );
  // The cached synced rebuilds the same sheet.
  const rebuilt = lyricsFromCache(entry as LyricsCacheEntry, DURATION);
  assert(rebuilt.kind === 'synced' && rebuilt.lines.length === 3);
  assertEqual(rebuilt.matched, null, 'cache stores no match evidence');

  const plainEntry = lyricsCacheEntry(
    'r1',
    'lyrics-lrclib',
    '0.1.3',
    { kind: 'plain', text: 'words', matched: MATCHED },
    43,
  );
  assert(
    plainEntry !== null &&
    plainEntry.kind === 'plain' &&
    isLyricsCacheEntry(plainEntry),
  );
  const rebuiltPlain = lyricsFromCache(plainEntry as LyricsCacheEntry, DURATION);
  assert(rebuiltPlain.kind === 'plain', 'a cached plain stays plain');

  const instrumentalEntry = lyricsCacheEntry(
    'r1',
    'lyrics-lrclib',
    '0.1.3',
    { kind: 'instrumental', matched: MATCHED },
    44,
  );
  assert(
    instrumentalEntry !== null &&
    instrumentalEntry.payload.instrumental &&
    isLyricsCacheEntry(instrumentalEntry),
    'instrumental persists as the flagged no-text encoding',
  );
  const rebuiltInstrumental = lyricsFromCache(
    instrumentalEntry as LyricsCacheEntry,
    DURATION,
  );
  assert(rebuiltInstrumental.kind === 'instrumental');

  // Absence is never cached.
  assertEqual(
    lyricsCacheEntry(
      'r1',
      'lyrics-lrclib',
      '0.1.3',
      { kind: 'unavailable', matched: null },
      45,
    ),
    null,
    'unavailable stays refetchable',
  );

  // A corrupt cached synced degrades to its stored plain text.
  const corrupt: LyricsCacheEntry = {
    recordingId: 'r1',
    provider: 'lyrics-lrclib',
    kind: 'synced',
    payload: {
      plainLyrics: 'the words',
      syncedLyrics: 'not lrc at all',
      instrumental: false,
    },
    fetchedMs: 46,
  };
  const degraded = lyricsFromCache(corrupt, DURATION);
  assert(
    degraded.kind === 'plain' && degraded.text === 'the words',
    'corrupt synced falls back to stored plain text',
  );
  const corruptBare = lyricsFromCache(
    { ...corrupt, payload: { ...corrupt.payload, plainLyrics: null } },
    DURATION,
  );
  assert(
    corruptBare.kind === 'unavailable',
    'corrupt synced with no text is honest absence',
  );

  // A plain-kind entry never presents as synced — even if a stray
  // syncedLyrics string rides along.
  const plainWithLrc: LyricsCacheEntry = {
    recordingId: 'r1',
    provider: 'lyrics-lrclib',
    kind: 'plain',
    payload: {
      plainLyrics: 'plain words',
      syncedLyrics: '[00:01.000] smuggled',
      instrumental: false,
    },
    fetchedMs: 47,
  };
  const neverSynced = lyricsFromCache(plainWithLrc, DURATION);
  assert(neverSynced.kind === 'plain', 'kind gates the synced path');
}

// ---- session use case -----------------------------------------------------

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: 'US',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
};

function trackRef(provider: string, id: string): SourceRef {
  return { provider, kind: 'track', id };
}

function recording(id: string, durationMs: number | null = 300_000): Recording {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    durationMs,
    releaseYear: 2020,
    artwork: [],
    explicit: null,
    genre: null,
    isrc: null,
    versionLabels: [],
    sourceRefs: [trackRef('itunes', `it-${id}`)],
    mappings: [],
    provenance: 'provider',
  };
}

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
    queue: partial.queue ?? {
      revision: 0,
      occurrences: [],
      currentOccurrenceId: null,
      positionMs: 0,
      mode: 'stopped',
    },
    settings: partial.settings ?? SETTINGS,
  };
}

type Rig = {
  session: Session;
  storage: FakeStorage;
  player: FakePlayer;
  clock: FakeClock;
  log: FakeLog;
  states: SessionState[];
};

/** Catalog/playback slots are always injected; lyrics come via `extra`. */
function rig(state: PersistedState, extra: ProviderPort[] = []): Rig {
  const storage = new FakeStorage(state);
  const player = new FakePlayer();
  const clock = new FakeClock(1_000);
  const log = new FakeLog();
  const session = new Session({
    storage,
    player,
    providers: [
      new FakeProvider('itunes', ['catalog.search']),
      new FakeProvider('youtube-music', [
        'playback.candidates',
        'playback.resolve',
      ]),
      ...extra,
    ],
    clock,
    ids: new SequenceIds(),
    random: new SequenceRandom(),
    log,
    defaults: SETTINGS,
  });
  const states: SessionState[] = [];
  session.subscribe((s) => states.push(s));
  return { session, storage, player, clock, log, states };
}

async function pump(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function readyOf(r: Rig): ReadySession {
  const state = r.session.snapshot();
  assert(state.type === 'ready', `expected ready, got ${state.type}`);
  return state;
}

function lyricsCalls(provider: FakeProvider): number {
  return provider.calls.filter((c) => c.method === 'getLyrics').length;
}

async function missThenHit(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const r = rig(persisted({ recordings: [recording('r1')] }), [lrclib]);
  await r.session.restore();

  const pending = r.session.getLyrics('r1');
  await pump();
  // The query is built from the recording; synced is preferred.
  const call = lrclib.calls.find((c) => c.method === 'getLyrics');
  assertDeepEqual(
    call?.input,
    {
      query: {
        title: 'Song r1',
        artist: 'Artist',
        album: 'Album',
        durationMs: 300_000,
        isrc: null,
      },
      prefer: 'synced',
    },
    'lyrics query carries recording metadata',
  );
  assert(
    lrclib.settleLyrics(
      ok({ kind: 'synced', lines: lines(GOOD), matched: MATCHED }),
    ),
  );
  const sheet = await pending;
  assert(sheet.ok && sheet.value.kind === 'synced', 'synced sheet');
  assert(
    sheet.ok &&
    sheet.value.cached === false &&
    sheet.value.provider === 'lyrics-lrclib',
  );

  // The accepted record was committed to the lyrics cache.
  const commit = r.storage.commits.find(
    (c) => c.batch.lyricsCache !== undefined,
  );
  const stored = commit?.batch.lyricsCache?.[0];
  assert(stored?.kind === 'synced' && stored.provider === 'lyrics-lrclib');
  assert(stored !== undefined && isLyricsCacheEntry(stored));

  // Second call is a cache hit — no provider round trip, same honesty.
  const again = await r.session.getLyrics('r1');
  assert(again.ok && again.value.kind === 'synced');
  assert(
    again.ok &&
    again.value.cached === true &&
    again.value.matched === null,
    'cached sheets carry no stored match evidence',
  );
  assertEqual(lyricsCalls(lrclib), 1, 'cache hit skips the provider');
  await r.session.dispose();
}

async function plainStaysPlain(): Promise<void> {
  // A plain-only provider routes prefer=synced to its plain capability.
  const plainOnly = new FakeProvider('plain-lyrics', ['lyrics.plain']);
  const r = rig(persisted({ recordings: [recording('r1')] }), [plainOnly]);
  await r.session.restore();
  const pending = r.session.getLyrics('r1');
  await pump();
  assert(
    plainOnly.settleLyrics(
      ok({ kind: 'plain', text: 'only words', matched: MATCHED }),
    ),
  );
  const sheet = await pending;
  assert(sheet.ok && sheet.value.kind === 'plain');
  const stored = r.storage.commits.find(
    (c) => c.batch.lyricsCache !== undefined,
  )?.batch.lyricsCache?.[0];
  assert(stored?.kind === 'plain', 'plain result caches as plain');

  // The cached plain stays plain — it is never re-presented as synced.
  const again = await r.session.getLyrics('r1');
  assert(
    again.ok && again.value.kind === 'plain' && again.value.cached,
    'cached plain stays plain',
  );
  assertEqual(lyricsCalls(plainOnly), 1);
  await r.session.dispose();
}

async function rejections(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const r = rig(
    persisted({ recordings: [recording('r1'), recording('r2')] }),
    [lrclib],
  );
  await r.session.restore();

  // A drifted record is rejected: unavailable sheet, nothing cached.
  // Absence is only proven once BOTH flavors are dry — the synced
  // miss falls back to the declared plain capability first, then
  // books a session miss for the TTL window.
  const drifted = r.session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(
    ok({
      kind: 'synced',
      lines: lines(GOOD),
      matched: { ...MATCHED, durationMs: 600_000 },
    }),
  );
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  const sheet = await drifted;
  assert(sheet.ok && sheet.value.kind === 'unavailable');
  assert(
    !r.storage.commits.some((c) => c.batch.lyricsCache !== undefined),
    'rejections are not cached',
  );
  // Inside the miss window the re-open serves the booked miss — a
  // real provider cannot change its answer in seconds — and past the
  // TTL the lookup re-proves itself.
  const missed = await r.session.getLyrics('r1');
  assert(
    missed.ok && missed.value.kind === 'unavailable' && missed.value.cached,
    'a fresh miss serves without a round trip',
  );
  assertEqual(lyricsCalls(lrclib), 2, 'miss suppresses the refetch');
  r.clock.advance(31 * 60_000);

  // Non-monotonic synced degrades to plain — and that is what caches.
  const degraded = r.session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(
    ok({
      kind: 'synced',
      lines: lines([
        [20_000, 'later'],
        [10_000, 'earlier'],
      ]),
      matched: MATCHED,
    }),
  );
  const degradedSheet = await degraded;
  assert(
    degradedSheet.ok && degradedSheet.value.kind === 'plain',
    'rejected synced serves the words it carries',
  );
  const stored = r.storage.commits.find(
    (c) => c.batch.lyricsCache !== undefined,
  )?.batch.lyricsCache?.[0];
  assert(stored?.kind === 'plain', 'the downgrade is what persists');

  // Provider-reported absence books a session miss for a short TTL —
  // a pane re-open serves it without storming the provider, then the
  // miss ages out and the lookup re-proves itself. Absence is only
  // proven once BOTH flavors are dry: the synced miss falls back to
  // the declared plain capability first.
  const absent = r.session.getLyrics('r2');
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  await pump();
  assert(
    lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null })),
    'synced absence falls back to the plain capability',
  );
  const absentSheet = await absent;
  assert(absentSheet.ok && absentSheet.value.kind === 'unavailable');
  assertEqual(
    r.storage.commits.filter((c) => c.batch.lyricsCache !== undefined)
      .length,
    1,
    'only the plain downgrade was ever committed',
  );
  const refetchSheet = await r.session.getLyrics('r2');
  assert(
    refetchSheet.ok &&
      refetchSheet.value.kind === 'unavailable' &&
      refetchSheet.value.cached,
    'a fresh miss serves without a round trip',
  );
  assertEqual(lyricsCalls(lrclib), 5, 'miss suppresses the refetch');

  // The miss ages out: past its TTL the lookup re-proves honestly.
  r.clock.advance(31 * 60_000);
  const reproof = r.session.getLyrics('r2');
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  const reSheet = await reproof;
  assert(
    reSheet.ok &&
      reSheet.value.kind === 'unavailable' &&
      !reSheet.value.cached,
    'aged-out miss refetches',
  );
  assertEqual(lyricsCalls(lrclib), 7);

  // Meanwhile r1's downgraded plain is a hit — no round trip.
  const cached = await r.session.getLyrics('r1');
  assert(cached.ok && cached.value.kind === 'plain' && cached.value.cached);
  assertEqual(lyricsCalls(lrclib), 7);
  await r.session.dispose();
}

async function instrumentalHonored(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const r = rig(persisted({ recordings: [recording('r1')] }), [lrclib]);
  await r.session.restore();
  const pending = r.session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(ok({ kind: 'instrumental', matched: MATCHED }));
  const sheet = await pending;
  assert(sheet.ok && sheet.value.kind === 'instrumental');
  const stored = r.storage.commits.find(
    (c) => c.batch.lyricsCache !== undefined,
  )?.batch.lyricsCache?.[0];
  assert(
    stored?.payload.instrumental === true,
    'instrumental persists as the flag',
  );
  const again = await r.session.getLyrics('r1');
  assert(
    again.ok && again.value.kind === 'instrumental' && again.value.cached,
    'cached instrumental is honored',
  );
  assertEqual(lyricsCalls(lrclib), 1);
  await r.session.dispose();
}

async function seededCacheHit(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const seeded: LyricsCacheEntry = {
    recordingId: 'r1',
    provider: 'lyrics-lrclib',
    providerVersion: '0.0.0-fake',
    kind: 'plain',
    payload: {
      plainLyrics: 'cached words',
      syncedLyrics: null,
      instrumental: false,
    },
    fetchedMs: 5,
  };
  const r = rig(
    persisted({ recordings: [recording('r1')], lyricsCache: [seeded] }),
    [lrclib],
  );
  await r.session.restore();
  const sheet = await r.session.getLyrics('r1');
  assert(
    sheet.ok &&
    sheet.value.kind === 'plain' &&
    sheet.value.cached &&
    sheet.value.provider === 'lyrics-lrclib',
  );
  assertEqual(lyricsCalls(lrclib), 0, 'a cache hit never calls out');
  await r.session.dispose();
}

// An entry written under a different provider version — or before
// version tracking — is stale: the upgraded provider re-fetches, and
// the replacement row records the serving version.
async function staleVersionRefetches(): Promise<void> {
  const lrclib = new FakeProvider(
    'lyrics-lrclib',
    ['lyrics.plain', 'lyrics.synced'],
    '0.1.3',
  );
  const staleRows: LyricsCacheEntry[] = [
    {
      recordingId: 'r1',
      provider: 'lyrics-lrclib',
      providerVersion: '0.1.0',
      kind: 'plain',
      payload: {
        plainLyrics: 'old words',
        syncedLyrics: null,
        instrumental: false,
      },
      fetchedMs: 5,
    },
    {
      recordingId: 'r2',
      provider: 'lyrics-lrclib',
      kind: 'plain',
      payload: {
        plainLyrics: 'legacy words',
        syncedLyrics: null,
        instrumental: false,
      },
      fetchedMs: 6,
    },
  ];
  const r = rig(
    persisted({
      recordings: [recording('r1'), recording('r2')],
      lyricsCache: staleRows,
    }),
    [lrclib],
  );
  await r.session.restore();

  const first = r.session.getLyrics('r1');
  await pump();
  assertEqual(lyricsCalls(lrclib), 1, 'stale version refetches');
  lrclib.settleLyrics(
    ok({ kind: 'synced', lines: lines(GOOD), matched: MATCHED }),
  );
  const sheet = await first;
  assert(
    sheet.ok && sheet.value.kind === 'synced' && !sheet.value.cached,
    'upgraded provider serves fresh lyrics',
  );
  const stored = r.storage.commits
    .find((c) => c.batch.lyricsCache !== undefined)
    ?.batch.lyricsCache?.find((e) => e.recordingId === 'r1');
  assertEqual(stored?.providerVersion, '0.1.3', 'write carries version');

  // The versioned replacement is a cache hit; the versionless legacy
  // row refetches once on its own open.
  const again = await r.session.getLyrics('r1');
  assert(again.ok && again.value.cached);
  assertEqual(lyricsCalls(lrclib), 1, 'versioned row caches');
  const legacy = r.session.getLyrics('r2');
  await pump();
  assertEqual(lyricsCalls(lrclib), 2, 'versionless row refetches once');
  lrclib.settleLyrics(
    ok({ kind: 'plain', text: 'still plain', matched: MATCHED }),
  );
  const second = await legacy;
  assert(second.ok && second.value.kind === 'plain');
  const r2 = r.session.getLyrics('r2');
  const legacyHit = await r2;
  assert(legacyHit.ok && legacyHit.value.cached);
  assertEqual(lyricsCalls(lrclib), 2, 're-cached row stays cached');
  await r.session.dispose();
}

// A provider whose manifest omits `version` reports null. A legacy row
// (no providerVersion) must still refetch under it — missing provenance
// never equals a matching null — while its own writes record null
// provenance and stay cacheable in-memory.
async function nullVersionProviderRefetchesLegacy(): Promise<void> {
  const lrclib = new FakeProvider(
    'lyrics-lrclib',
    ['lyrics.plain', 'lyrics.synced'],
    null,
  );
  const legacy: LyricsCacheEntry = {
    recordingId: 'r1',
    provider: 'lyrics-lrclib',
    kind: 'plain',
    payload: {
      plainLyrics: 'legacy words',
      syncedLyrics: null,
      instrumental: false,
    },
    fetchedMs: 5,
  };
  const r = rig(
    persisted({
      recordings: [recording('r1')],
      lyricsCache: [legacy],
    }),
    [lrclib],
  );
  await r.session.restore();
  const first = r.session.getLyrics('r1');
  await pump();
  assertEqual(lyricsCalls(lrclib), 1, 'legacy row refetches under null version');
  lrclib.settleLyrics(ok({ kind: 'plain', text: 'fresh', matched: MATCHED }));
  await first;
  const stored = r.storage.commits
    .find((c) => c.batch.lyricsCache !== undefined)
    ?.batch.lyricsCache?.find((e) => e.recordingId === 'r1');
  assert(
    stored?.providerVersion === null,
    'write records null provenance',
  );
  const again = await r.session.getLyrics('r1');
  assert(again.ok && again.value.cached, 'written null row caches');
  assertEqual(lyricsCalls(lrclib), 1, 'no second round trip');
  await r.session.dispose();
}

async function failures(): Promise<void> {
  // An unrestored session is a typed unavailable.
  const unready = rig(persisted({ recordings: [recording('r1')] }));
  const noSession = await unready.session.getLyrics('r1');
  assert(!noSession.ok && noSession.error.kind === 'unavailable');
  await unready.session.dispose();

  // No lyrics provider at all: a typed unsupported, no port call.
  const bare = rig(persisted({ recordings: [recording('r1')] }));
  await bare.session.restore();
  const none = await bare.session.getLyrics('r1');
  assert(!none.ok && none.error.kind === 'unsupported');
  await bare.session.dispose();

  // Unknown recording is not-found before routing.
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const r = rig(persisted({ recordings: [recording('r1')] }), [lrclib]);
  await r.session.restore();
  const missing = await r.session.getLyrics('ghost');
  assert(!missing.ok && missing.error.kind === 'not-found');
  assertEqual(lyricsCalls(lrclib), 0);

  // A disposable-cache commit failure still serves the lyrics, and
  // surfaces through persistenceError rather than the op result.
  r.storage.failNext(appError('transient', 'disk gone'));
  const pending = r.session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(
    ok({ kind: 'plain', text: 'words', matched: MATCHED }),
  );
  const sheet = await pending;
  assert(sheet.ok && sheet.value.kind === 'plain', 'result survives');
  assertEqual(
    readyOf(r).persistenceError?.kind,
    'transient',
    'commit failure publishes persistenceError',
  );
  // Commit-first: the failed write left no in-memory entry, so the
  // next call refetches.
  const again = r.session.getLyrics('r1');
  await pump();
  assertEqual(lyricsCalls(lrclib), 2, 'failed cache write refetches');
  lrclib.settleLyrics(
    ok({ kind: 'plain', text: 'words', matched: MATCHED }),
  );
  await again;
  await r.session.dispose();
}

async function cancellation(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const r = rig(persisted({ recordings: [recording('r1')] }), [lrclib]);
  await r.session.restore();

  // Caller cancellation reaches the in-flight provider call.
  const source = new CancellationSource();
  const context: OperationContext = {
    requestId: 'ui-1',
    deadlineMs: 60_000,
    signal: source.signal,
  };
  const pending = r.session.getLyrics('r1', context);
  await pump();
  assertEqual(lrclib.pendingCount('lyrics'), 1);
  source.cancel();
  const cancelled = await pending;
  assert(!cancelled.ok && cancelled.error.kind === 'cancelled');
  assertEqual(lrclib.cancelledSignals.length, 1, 'signal reached the port');

  // A caller deadline tighter than the op bound wins honestly.
  const stale: OperationContext = {
    requestId: 'ui-2',
    deadlineMs: 500,
    signal: new CancellationSource().signal,
  };
  const timed = await r.session.getLyrics('r1', stale);
  assert(!timed.ok && timed.error.kind === 'timeout');
  assertEqual(lyricsCalls(lrclib), 1, 'no port call past deadline');

  // An already-cancelled caller context never reaches the provider.
  const dead = new CancellationSource();
  dead.cancel();
  const early = await r.session.getLyrics('r1', {
    requestId: 'ui-3',
    deadlineMs: 60_000,
    signal: dead.signal,
  });
  assert(!early.ok && early.error.kind === 'cancelled');
  assertEqual(lyricsCalls(lrclib), 1);
  await r.session.dispose();
}

// A dual-capability provider whose synced walk comes back dry still
// declares lyrics.plain — the same query with prefer:'plain' rescues
// the records the synced flavor could never serve (a plain-only
// record defers inside the synced waterfall).
async function plainFallbackRescuesSyncedAbsence(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const r = rig(persisted({ recordings: [recording('r1')] }), [lrclib]);
  await r.session.restore();
  const pending = r.session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  await pump();
  // The fallback fires the same query at the plain capability.
  const calls = lrclib.calls.filter((c) => c.method === 'getLyrics');
  assertEqual(calls.length, 2, 'synced absence falls back once');
  assertDeepEqual(
    (calls[1]?.input as { prefer?: string })?.prefer,
    'plain',
  );
  lrclib.settleLyrics(
    ok({ kind: 'plain', text: 'only words', matched: MATCHED }),
  );
  const sheet = await pending;
  assert(
    sheet.ok && sheet.value.kind === 'plain',
    'plain answer serves after the synced miss',
  );
  const stored = r.storage.commits.find(
    (c) => c.batch.lyricsCache !== undefined,
  )?.batch.lyricsCache?.[0];
  assert(stored?.kind === 'plain', 'the rescued plain caches');
  await r.session.dispose();
}

// A provider that declares only lyrics.plain gets no second call —
// the fallback never pays a round trip it cannot use.
async function noFallbackWithoutPlainCapability(): Promise<void> {
  const syncedOnly = new FakeProvider('synced-lyrics', ['lyrics.synced']);
  const r = rig(persisted({ recordings: [recording('r1')] }), [syncedOnly]);
  await r.session.restore();
  const pending = r.session.getLyrics('r1');
  await pump();
  syncedOnly.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  const sheet = await pending;
  assert(sheet.ok && sheet.value.kind === 'unavailable');
  assertEqual(lyricsCalls(syncedOnly), 1, 'no fallback without the cap');
  await r.session.dispose();
}

// The plain-only mirror image: prefer:'synced' already resolved to
// the provider's plain capability upstream, so its 'unavailable' IS
// the plain answer — a fallback call would re-issue the same request.
async function plainOnlyProviderSkipsDuplicateFallback(): Promise<void> {
  const plainOnly = new FakeProvider('plain-lyrics', ['lyrics.plain']);
  const r = rig(persisted({ recordings: [recording('r1')] }), [plainOnly]);
  await r.session.restore();
  const pending = r.session.getLyrics('r1');
  await pump();
  plainOnly.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  const sheet = await pending;
  assert(sheet.ok && sheet.value.kind === 'unavailable');
  assertEqual(
    lyricsCalls(plainOnly),
    1,
    'plain-only provider takes no duplicate fallback',
  );
  await r.session.dispose();
}

// A hard failure on the plain fallback surfaces as an error — absence
// is not proven when the second flavor could not answer.
async function fallbackFailureSurfaces(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const r = rig(persisted({ recordings: [recording('r1')] }), [lrclib]);
  await r.session.restore();
  const pending = r.session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  await pump();
  // A non-retryable failure — absence was never proven.
  lrclib.settleLyrics(err(appError('invalid-response', 'bad payload')));
  const out = await pending;
  assert(!out.ok && out.error.kind === 'invalid-response');
  // The failure books no miss: the next open refetches honestly.
  const again = r.session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(
    ok({ kind: 'plain', text: 'words', matched: MATCHED }),
  );
  const sheet = await again;
  assert(sheet.ok && sheet.value.kind === 'plain');
  await r.session.dispose();
}

// LRCLIB's intermittent 503s sit inside 'transient': the op retries
// across the blip — three bounded attempts under one deadline — then
// the successful attempt's verdict stands.
async function transientRetryCrossesTheBlip(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const r = rig(persisted({ recordings: [recording('r1')] }), [lrclib]);
  await r.session.restore();
  const pending = r.session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(err(appError('transient', 'upstream 503')));
  await pump();
  r.clock.advance(800);
  await pump();
  assertEqual(lyricsCalls(lrclib), 2, 'first transient retried');
  lrclib.settleLyrics(err(appError('transient', 'upstream 503')));
  await pump();
  r.clock.advance(1600);
  await pump();
  assertEqual(lyricsCalls(lrclib), 3, 'second transient retried');
  lrclib.settleLyrics(ok({ kind: 'plain', text: 'words', matched: MATCHED }));
  const sheet = await pending;
  assert(sheet.ok && sheet.value.kind === 'plain', 'retry crosses the blip');
  await r.session.dispose();
}

// A booked miss is keyed on the recording's duration: corrected
// metadata re-proves the lookup instead of serving the stale miss.
async function durationChangeReprovesMiss(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const r = rig(persisted({ recordings: [recording('r1')] }), [lrclib]);
  await r.session.restore();
  const pending = r.session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  await pending;
  // A duration change — e.g. the provider re-reports the track at a
  // corrected length — makes the booked miss stale.
  const upserted = await r.session.enqueueMetadata({
    sourceRef: trackRef('itunes', 'it-r1'),
    title: 'Song r1',
    artist: 'Artist',
    album: 'Album',
    durationMs: 240_000,
    releaseYear: 2020,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: 'US',
  });
  assert(upserted.ok, 'metadata refresh lands');
  const pending2 = r.session.getLyrics('r1');
  await pump();
  assertEqual(lyricsCalls(lrclib), 3, 'duration change refetches');
  // The match must honestly carry the corrected duration — the
  // drift rule collapses a stale-duration record to unavailable.
  lrclib.settleLyrics(
    ok({
      kind: 'plain',
      text: 'words',
      matched: { ...MATCHED, durationMs: 240_000 },
    }),
  );
  const sheet = await pending2;
  assert(sheet.ok && sheet.value.kind === 'plain');
  assertEqual(lyricsCalls(lrclib), 3, 'no fallback spent on a plain hit');
  await r.session.dispose();
}

// The miss is keyed on the whole lookup, not the duration alone: a
// metadata correction that leaves duration untouched — a retagged
// artist — re-proves it all the same.
async function metadataChangeReprovesMiss(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const r = rig(persisted({ recordings: [recording('r1')] }), [lrclib]);
  await r.session.restore();
  const pending = r.session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  await pending;
  const upserted = await r.session.enqueueMetadata({
    sourceRef: trackRef('itunes', 'it-r1'),
    title: 'Song r1',
    artist: 'Corrected Artist',
    album: 'Album',
    durationMs: 300_000,
    releaseYear: 2020,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: 'US',
  });
  assert(upserted.ok, 'metadata refresh lands');
  const pending2 = r.session.getLyrics('r1');
  await pump();
  assertEqual(lyricsCalls(lrclib), 3, 'artist change refetches');
  lrclib.settleLyrics(ok({ kind: 'plain', text: 'words', matched: MATCHED }));
  const sheet = await pending2;
  assert(sheet.ok && sheet.value.kind === 'plain');
  await r.session.dispose();
}

// Importing a library replaces Ready wholesale — misses the old
// library proved must not suppress the imported recordings' first
// honest lookups, even when the same recording id lands again.
async function importLibraryClearsMisses(): Promise<void> {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const r = rig(persisted({ recordings: [recording('r1')] }), [lrclib]);
  await r.session.restore();
  const pending = r.session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  await pending;
  assertEqual(lyricsCalls(lrclib), 2, 'miss booked');
  const doc = await exportLibrary(
    new FakeStorage(persisted({ recordings: [recording('r1')] })),
    new FakeClock(3_000),
    {
      requestId: 't',
      deadlineMs: 60_000,
      signal: new CancellationSource().signal,
    },
  );
  assert(doc.ok);
  const imported = await r.session.importLibrary(doc.value.json);
  assert(imported.ok, 'import resolves');
  const importedId = readyOf(r).recordings[0]?.id;
  assert(importedId !== undefined, 'imported recording present');
  const pending2 = r.session.getLyrics(importedId);
  await pump();
  assertEqual(lyricsCalls(lrclib), 3, 'imported recording refetches');
  lrclib.settleLyrics(ok({ kind: 'plain', text: 'words', matched: MATCHED }));
  const sheet = await pending2;
  assert(sheet.ok && sheet.value.kind === 'plain');
  await r.session.dispose();
}

export async function run(): Promise<void> {
  syncedAcceptance();
  otherAcceptance();
  lrcParsing();
  cacheMapping();
  await missThenHit();
  await plainStaysPlain();
  await rejections();
  await instrumentalHonored();
  await seededCacheHit();
  await staleVersionRefetches();
  await nullVersionProviderRefetchesLegacy();
  await failures();
  await cancellation();
  await plainFallbackRescuesSyncedAbsence();
  await noFallbackWithoutPlainCapability();
  await plainOnlyProviderSkipsDuplicateFallback();
  await fallbackFailureSurfaces();
  await transientRetryCrossesTheBlip();
  await durationChangeReprovesMiss();
  await metadataChangeReprovesMiss();
  await importLibraryClearsMisses();
}
