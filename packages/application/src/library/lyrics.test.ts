import { CancellationSource } from '../cancellation.ts';
import type { OperationContext } from '../cancellation.ts';
import type { Recording, Settings, SourceRef } from '../domain.ts';
import { appError, ok } from '../errors.ts';
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
  const entry = lyricsCacheEntry('r1', 'lyrics-lrclib', acceptedSynced, 42);
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
  const drifted = r.session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(
    ok({
      kind: 'synced',
      lines: lines(GOOD),
      matched: { ...MATCHED, durationMs: 600_000 },
    }),
  );
  const sheet = await drifted;
  assert(sheet.ok && sheet.value.kind === 'unavailable');
  assert(
    !r.storage.commits.some((c) => c.batch.lyricsCache !== undefined),
    'rejections are not cached',
  );
  // The rejection did not stick: the next call refetches honestly.
  assertEqual(lyricsCalls(lrclib), 1);

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

  // Provider-reported absence is honest and never cached — r2 keeps
  // refetching rather than freezing a miss.
  const absent = r.session.getLyrics('r2');
  await pump();
  lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null }));
  const absentSheet = await absent;
  assert(absentSheet.ok && absentSheet.value.kind === 'unavailable');
  assertEqual(
    r.storage.commits.filter((c) => c.batch.lyricsCache !== undefined)
      .length,
    1,
    'only the plain downgrade was ever committed',
  );
  const refetch = r.session.getLyrics('r2');
  await pump();
  assert(
    lrclib.settleLyrics(ok({ kind: 'unavailable', matched: null })),
    'absence refetches instead of caching',
  );
  await refetch;

  // Meanwhile r1's downgraded plain is a hit — no round trip.
  const cached = await r.session.getLyrics('r1');
  assert(cached.ok && cached.value.kind === 'plain' && cached.value.cached);
  assertEqual(lyricsCalls(lrclib), 4);
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
  await failures();
  await cancellation();
}
