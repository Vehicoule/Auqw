import type {
  MatchEvidence,
  QueueOccurrence,
  Recording,
  Settings,
  SourceMapping,
  SourceRef,
  TrackMetadata,
} from '../domain.ts';
import { appError, err, ok } from '../errors.ts';
import type { Result } from '../errors.ts';
import type { PersistedState, StorageBatch } from '../ports/storage.ts';
import type { ProviderPort, RadioPage } from '../ports/provider.ts';
import type {
  AttemptTrace,
  PlaybackIdentity,
} from '../ports/player.ts';
import type { QueueSnapshot } from './queue-engine.ts';
import {
  isRadioPage,
  planRadioPage,
  publishRadio,
  remainingAfterCurrent,
  shouldGrowRadio,
  RADIO_DRAIN_CHASE_PAGES,
  RADIO_FETCH_AHEAD,
  RADIO_PAGE_MAX_ITEMS,
} from './radio-tail.ts';
import type { RadioTailRecord } from './radio-tail.ts';
import { Session } from '../session/session.ts';
import type { ReadySession, SessionState } from '../session/session.ts';
import {
  ALL_CAPABILITIES,
  FakeClock,
  FakeLog,
  FakePlayer,
  FakeProvider,
  FakeStorage,
  SequenceIds,
  SequenceRandom,
} from '../testing/fakes.ts';
import { assert, assertDeepEqual, assertEqual } from '../testing/assert.ts';

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: 'US',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
};

function ref(provider: string, id: string): SourceRef {
  return { provider, kind: 'track', id };
}

function meta(
  provider: string,
  id: string,
  title: string,
  artist: string,
  durationMs: number,
): TrackMetadata {
  return {
    sourceRef: ref(provider, id),
    title,
    artist,
    album: 'Album',
    durationMs,
    releaseYear: 2020,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: 'US',
  };
}

function recording(id: string, refs: readonly SourceRef[]): Recording {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    durationMs: 300_000,
    releaseYear: 2020,
    artwork: [],
    explicit: null,
    genre: null,
    isrc: null,
    versionLabels: [],
    sourceRefs: refs,
    mappings: [],
    provenance: 'provider',
  };
}

function occurrence(
  id: string,
  recordingId: string,
  selectedRef: SourceRef | null = null,
): QueueOccurrence {
  return { occurrenceId: id, recordingId, selectedRef };
}

function queue(partial: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    revision: partial.revision ?? 0,
    occurrences: partial.occurrences ?? [],
    currentOccurrenceId: partial.currentOccurrenceId ?? null,
    positionMs: partial.positionMs ?? 0,
    mode: partial.mode ?? 'stopped',
  };
}

function tail(partial: Partial<RadioTailRecord> = {}): RadioTailRecord {
  return {
    seedRef: ref('youtube-music', 'seed'),
    providerId: 'youtube-music',
    continuation: 'cont-1',
    status: 'growing',
    error: undefined,
    fetching: false,
    source: null,
    resumeOnDrain: false,
    dupPages: 0,
    ...partial,
  };
}

function page(
  items: readonly TrackMetadata[],
  continuation: string | null,
): RadioPage {
  return { candidates: items, continuation };
}

function evidence(score = 80): MatchEvidence {
  return {
    titleSimilarity: 0.9,
    artistSimilarity: 0.9,
    durationDeltaMs: 100,
    exactIsrc: false,
    score,
    versionLabels: [],
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
    queue: partial.queue ?? queue(),
    settings: partial.settings ?? SETTINGS,
  };
}

type Rig = {
  session: Session;
  storage: FakeStorage;
  player: FakePlayer;
  itunes: FakeProvider;
  ytm: FakeProvider;
  extra: FakeProvider[];
  clock: FakeClock;
  log: FakeLog;
  states: SessionState[];
};

function rig(
  state: PersistedState,
  extraProviders: ProviderPort[] = [],
  deps: {
    isOnline?: () => boolean;
    localPlaybackFor?: (recordingId: string) => string | null;
  } = {},
): Rig {
  const storage = new FakeStorage(state);
  const player = new FakePlayer();
  const itunes = new FakeProvider('itunes');
  const ytm = new FakeProvider('youtube-music');
  const extra = extraProviders.filter(
    (p): p is FakeProvider => p instanceof FakeProvider,
  );
  const clock = new FakeClock(1_000);
  const log = new FakeLog();
  const session = new Session({
    storage,
    player,
    providers: [itunes, ytm, ...extraProviders],
    clock,
    ids: new SequenceIds(),
    random: new SequenceRandom(),
    log,
    defaults: SETTINGS,
    ...(deps.isOnline === undefined ? {} : { isOnline: deps.isOnline }),
    ...(deps.localPlaybackFor === undefined
      ? {}
      : { localPlaybackFor: deps.localPlaybackFor }),
  });
  const states: SessionState[] = [];
  session.subscribe((s) => states.push(s));
  return { session, storage, player, itunes, ytm, extra, clock, log, states };
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

async function restoreOk(r: Rig): Promise<void> {
  const res = await r.session.restore();
  assert(res.ok, 'restore failed');
}

function radioCalls(r: Rig, provider?: FakeProvider): { method: string; input: unknown }[] {
  return (provider ?? r.ytm).calls.filter((c) => c.method === 'radioSeed');
}

async function pureRemaining(): Promise<void> {
  const q = queue({
    occurrences: [occurrence('o1', 'r1'), occurrence('o2', 'r2')],
  });
  assertEqual(remainingAfterCurrent(q), 0, 'no current means nothing ahead');
  const withCurrent = queue({
    occurrences: [
      occurrence('o1', 'r1'),
      occurrence('o2', 'r2'),
      occurrence('o3', 'r3'),
    ],
    currentOccurrenceId: 'o1',
    mode: 'paused',
  });
  assertEqual(remainingAfterCurrent(withCurrent), 2, 'counts after current');
  const atTail = queue({ ...withCurrent, currentOccurrenceId: 'o3' });
  assertEqual(remainingAfterCurrent(atTail), 0, 'tail item has nothing after');
  const stale = queue({ ...withCurrent, currentOccurrenceId: 'gone' });
  assertEqual(remainingAfterCurrent(stale), 0, 'unknown current is 0');
}

async function pureIsRadioPage(): Promise<void> {
  const good = page([meta('youtube-music', 'v1', 'T', 'A', 1000)], 'c');
  assert(isRadioPage(good), 'valid page accepted');
  assert(isRadioPage(page([], null)), 'empty page with null token is valid');
  assert(!isRadioPage(null), 'null rejected');
  assert(!isRadioPage({ candidates: [], continuation: 'x', extra: 1 }), 'extra key rejected');
  assert(
    !isRadioPage({ candidates: 'x', continuation: null }),
    'non-array candidates rejected',
  );
  assert(
    !isRadioPage(page([], '')),
    'empty continuation string rejected',
  );
  assert(
    !isRadioPage({ candidates: [], continuation: 7 }),
    'non-string continuation rejected',
  );
  const badItem = page(
    [{ ...meta('youtube-music', 'v1', 'T', 'A', 1000), title: '' }],
    'c',
  );
  assert(!isRadioPage(badItem), 'one corrupt item fails the whole page');
  const flood = page(
    Array.from({ length: RADIO_PAGE_MAX_ITEMS + 1 }, (_, i) =>
      meta('youtube-music', `v${i}`, 'T', 'A', 1000),
    ),
    'c',
  );
  assert(!isRadioPage(flood), 'oversized page rejected');
}

async function pureShouldGrow(): Promise<void> {
  const armed = tail();
  const short = queue({
    occurrences: [occurrence('o1', 'r1'), occurrence('o2', 'r2')],
    currentOccurrenceId: 'o1',
    mode: 'paused',
  });
  assert(shouldGrowRadio(armed, short), 'armed short tail grows');
  assert(!shouldGrowRadio(null, short), 'no record never grows');
  assert(
    !shouldGrowRadio(tail({ status: 'ended' }), short),
    'ended tail never grows',
  );
  assert(
    !shouldGrowRadio(tail({ status: 'failed' }), short),
    'failed tail never grows',
  );
  assert(
    !shouldGrowRadio(tail({ continuation: null }), short),
    'no continuation never grows',
  );
  assert(
    !shouldGrowRadio(tail({ fetching: true }), short),
    'in-flight fetch suppresses duplicates',
  );
  const stopped = queue({ occurrences: [occurrence('o1', 'r1')] });
  assert(!shouldGrowRadio(armed, stopped), 'stopped queue never grows');
  const full = queue({
    occurrences: [
      occurrence('o1', 'r1'),
      occurrence('o2', 'r2'),
      occurrence('o3', 'r3'),
      occurrence('o4', 'r4'),
    ],
    currentOccurrenceId: 'o1',
    mode: 'paused',
  });
  assert(!shouldGrowRadio(armed, full), 'a full window stays put');
  assertEqual(RADIO_FETCH_AHEAD, 3, 'spec window is ~3');
}

async function purePublish(): Promise<void> {
  assertEqual(publishRadio(null), null, 'no record publishes null');
  const published = publishRadio(
    tail({ error: appError('transient', 'boom'), status: 'failed' }),
  );
  assert(published !== null, 'record publishes');
  assertEqual(published?.status, 'failed');
  assertEqual(published?.error?.kind, 'transient');
  assertEqual(published?.providerId, 'youtube-music');
  assertDeepEqual(published?.seedRef, ref('youtube-music', 'seed'));
  const clean = publishRadio(tail({ fetching: true }));
  assert(clean !== null && clean.fetching, 'fetching is published');
  assert(!('error' in (clean ?? {})), 'no error key when unset');
}

async function purePlanDedupe(): Promise<void> {
  const ids = new SequenceIds();
  const rec = recording('rX', [ref('youtube-music', 'v-old')]);
  const queued = queue({
    occurrences: [
      occurrence('o1', 'rX', ref('youtube-music', 'v-old')),
      occurrence('o2', 'rOther'),
    ],
    currentOccurrenceId: 'o1',
    mode: 'paused',
  });
  const plan = planRadioPage(
    [rec],
    queued.occurrences,
    [
      meta('youtube-music', 'v-old', 'T1', 'A', 1000), // queued ref
      meta('youtube-music', 'v-new', 'T2', 'A', 1000), // new
    ],
    ids,
    'youtube-music',
    5,
  );
  assertEqual(plan.occurrences.length, 1, 'queued ref is skipped');
  const kept = plan.occurrences[0];
  assert(kept !== undefined);
  const keptRec = plan.recordings.find((x) => x.id === kept.recordingId);
  assert(
    keptRec !== undefined && keptRec.sourceRefs.some((s) => s.id === 'v-new'),
    'survivor mints the new item',
  );
  // All-dupes page: nothing appended, recordings untouched.
  const plan2 = planRadioPage(
    plan.recordings,
    [...queued.occurrences, ...plan.occurrences],
    [meta('youtube-music', 'v-old', 'T1', 'A', 1000), meta('youtube-music', 'v-new', 'T2', 'A', 1000)],
    ids,
    'youtube-music',
    6,
  );
  assertEqual(plan2.occurrences.length, 0, 'all-dupes page appends nothing');
  // Recording-level dedupe: a queued recording's other refs also block.
  const recTwo = recording('rY', [ref('youtube-music', 'v-a'), ref('youtube-music', 'v-b')]);
  const queuedTwo = queue({
    occurrences: [occurrence('o9', 'rY', ref('youtube-music', 'v-a'))],
    currentOccurrenceId: 'o9',
    mode: 'paused',
  });
  const plan3 = planRadioPage(
    [recTwo],
    queuedTwo.occurrences,
    [meta('youtube-music', 'v-b', 'T', 'A', 1000)],
    ids,
    'youtube-music',
    7,
  );
  assertEqual(plan3.occurrences.length, 0, 'queued recording refs dedupe');
}

async function purePlanMint(): Promise<void> {
  const ids = new SequenceIds();
  const item = meta('youtube-music', 'v1', 'Roads', 'Portishead', 300_000);
  const plan = planRadioPage([], [], [item], ids, 'youtube-music', 5);
  assertEqual(plan.occurrences.length, 1);
  assertEqual(plan.recordings.length, 1, 'one recording minted');
  const rec = plan.recordings[0];
  assert(rec !== undefined);
  assertEqual(rec.title, 'Roads');
  assertDeepEqual(rec.sourceRefs, [item.sourceRef]);
  const mapping = rec.mappings[0];
  assert(mapping !== undefined, 'automatic mapping recorded');
  assertEqual(mapping.status, 'automatic');
  assertDeepEqual(mapping.ref, item.sourceRef);
  assert(mapping.evidence.score > 0, 'real scored evidence, not fabricated');
  const occ = plan.occurrences[0];
  assert(occ !== undefined);
  assertEqual(occ.recordingId, rec.id);
  assertDeepEqual(occ.selectedRef, item.sourceRef, 'playable ref selected');
  // A non-playback provider's item keeps honest unavailable selection.
  const planForeign = planRadioPage(
    [],
    [],
    [meta('deezer', 'd1', 'X', 'Y', 1000)],
    ids,
    'youtube-music',
    5,
  );
  assertEqual(
    planForeign.occurrences[0]?.selectedRef,
    null,
    'foreign ref is not auto-selected',
  );
  // Page order is preserved for multiple items.
  const planOrder = planRadioPage(
    [],
    [],
    [
      meta('youtube-music', 'a', 'A', 'X', 1000),
      meta('youtube-music', 'b', 'B', 'X', 1000),
      meta('youtube-music', 'c', 'C', 'X', 1000),
    ],
    ids,
    'youtube-music',
    5,
  );
  const titles = planOrder.occurrences.map(
    (o) => planOrder.recordings.find((x) => x.id === o.recordingId)?.title,
  );
  assertDeepEqual(titles, ['A', 'B', 'C'], 'page order preserved');
}

async function purePlanExisting(): Promise<void> {
  const ids = new SequenceIds();
  const confirmed: SourceMapping = {
    ref: ref('youtube-music', 'v1'),
    status: 'user-confirmed',
    matchedAtMs: 1,
    evidence: evidence(),
  };
  const existing: Recording = {
    ...recording('rE', [ref('youtube-music', 'v1')]),
    title: 'Old Title',
    mappings: [confirmed],
  };
  const item = meta('youtube-music', 'v1', 'New Title', 'Artist', 300_000);
  const plan = planRadioPage([existing], [], [item], ids, 'youtube-music', 9);
  assertEqual(plan.occurrences.length, 1);
  assertEqual(plan.recordings.length, 1, 'no duplicate recording');
  const rec = plan.recordings[0];
  assert(rec !== undefined);
  assertEqual(rec.id, 'rE', 'existing recording is reused');
  assertEqual(rec.title, 'New Title', 'metadata refreshed');
  assertEqual(
    rec.mappings[0]?.status,
    'user-confirmed',
    'a user verdict is never replaced',
  );
  // An automatic winner for the same ref refreshes in place.
  const autoExisting: Recording = {
    ...recording('rF', [ref('youtube-music', 'v2')]),
    mappings: [
      { ref: ref('youtube-music', 'v2'), status: 'automatic', matchedAtMs: 1, evidence: evidence(10) },
    ],
  };
  const plan2 = planRadioPage(
    [autoExisting],
    [],
    [meta('youtube-music', 'v2', 'Song rF', 'Artist', 300_000)],
    ids,
    'youtube-music',
    20,
  );
  const m2 = plan2.recordings[0]?.mappings[0];
  assertEqual(m2?.matchedAtMs, 20, 'automatic mapping refreshed');
  assertEqual(plan2.recordings[0]?.mappings.length, 1, 'no mapping dupes');
}

async function purePlanRejectsMismatched(): Promise<void> {
  const ids = new SequenceIds();
  // Same provider ref, but the item's metadata hard-rejects the stored
  // recording on the live axis: the item is not this recording — it
  // must not be merged in or enqueued under it.
  const existing: Recording = {
    ...recording('rL', [ref('youtube-music', 'v1')]),
    title: 'Song (Live)',
    versionLabels: ['live'],
  };
  const recordings = [existing];
  const item = meta('youtube-music', 'v1', 'Song', 'Artist', 300_000);
  const plan = planRadioPage(recordings, [], [item], ids, 'youtube-music', 9);
  assertEqual(plan.occurrences.length, 0, 'rejected item not enqueued');
  assert(
    plan.recordings === recordings,
    'recordings untouched by a rejected item',
  );
  assertEqual(plan.recordings[0]?.title, 'Song (Live)');
  assertEqual(plan.recordings[0]?.mappings.length, 0, 'no mapping written');
  // A user-denied verdict for the same ref skips the item the same way.
  const denied: Recording = {
    ...recording('rD', [ref('youtube-music', 'v2')]),
    mappings: [
      {
        ref: ref('youtube-music', 'v2'),
        status: 'rejected',
        matchedAtMs: 1,
        evidence: evidence(),
      },
    ],
  };
  const planDenied = planRadioPage(
    [denied],
    [],
    [meta('youtube-music', 'v2', 'Song rD', 'Artist', 300_000)],
    ids,
    'youtube-music',
    9,
  );
  assertEqual(
    planDenied.occurrences.length,
    0,
    'user-rejected pairing not enqueued',
  );
  assertEqual(planDenied.recordings.length, 1);
  // A similarity-floor miss without a hard conflict is metadata drift:
  // the shared ref identifies the recording, so it is refreshed and
  // enqueued — just without a new mapping assertion.
  const stale: Recording = {
    ...recording('rS', [ref('youtube-music', 'v3')]),
    title: 'Untitled',
  };
  const planDrift = planRadioPage(
    [stale],
    [],
    [meta('youtube-music', 'v3', 'Parachute', 'Coldplay', 300_000)],
    ids,
    'youtube-music',
    9,
  );
  assertEqual(
    planDrift.occurrences.length,
    1,
    'same-ref drifted item still enqueues',
  );
  assertEqual(
    planDrift.recordings[0]?.title,
    'Parachute',
    'provider metadata refreshes drift',
  );
  assertEqual(
    planDrift.recordings[0]?.mappings.length,
    0,
    'no mapping written without evidence',
  );
}

async function radioSeedFlow(): Promise<void> {
  const r = rig(persisted());
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  // Armed + fetching state is published while the seed is in flight.
  const armed = readyOf(r).radio;
  assert(armed !== null, 'radio armed');
  assertEqual(armed?.status, 'growing');
  assert(armed?.fetching, 'seed fetch published');
  const seedCall = radioCalls(r)[0];
  assert(seedCall !== undefined, 'radio.seed invoked');
  assertDeepEqual(seedCall.input, { sourceRef: ref('youtube-music', 'seed-1') });
  r.ytm.settleRadio(
    ok(
      page(
        [
          meta('youtube-music', 'v1', 'One', 'A', 200_000),
          meta('youtube-music', 'v2', 'Two', 'B', 210_000),
          meta('youtube-music', 'v3', 'Three', 'C', 220_000),
        ],
        'cont-1',
      ),
    ),
  );
  const res = await started;
  assert(res.ok, 'startRadio failed');
  await pump();
  const snap = readyOf(r);
  assertEqual(snap.queue.occurrences.length, 3, 'page appended at tail');
  assertEqual(snap.recordings.length, 3, 'recordings minted');
  const first = snap.recordings[0];
  assert(first !== undefined);
  assertEqual(first.title, 'One');
  assertEqual(first.mappings[0]?.status, 'automatic');
  assertDeepEqual(first.mappings[0]?.ref, ref('youtube-music', 'v1'));
  const firstOcc = snap.queue.occurrences[0];
  assertEqual(firstOcc?.recordingId, first.id);
  assertDeepEqual(firstOcc?.selectedRef, ref('youtube-music', 'v1'));
  // Atomic: the page's recordings + queue land in a single commit.
  const commits = r.storage.commits.filter(
    (c) => c.batch.recordings !== undefined || c.batch.queue !== undefined,
  );
  assertEqual(commits.length, 1, 'one atomic write for the page');
  const batch = commits[0]?.batch;
  assert(batch !== undefined);
  assertEqual(batch.recordings?.length, 3);
  assertEqual(batch.queue?.occurrences.length, 3);
  const radio = snap.radio;
  assert(radio !== null);
  assertEqual(radio.status, 'growing');
  assert(!radio.fetching, 'fetch completed');
  assertEqual(radio.providerId, 'youtube-music');
  assertDeepEqual(radio.seedRef, ref('youtube-music', 'seed-1'));
  // The armed tail fetched nothing yet: no current, no consumption.
  assertEqual(radioCalls(r).length, 1, 'no continuation without a playhead');
  await r.session.dispose();
}

async function radioSeedValidation(): Promise<void> {
  const deezer = new FakeProvider('deezer', ['catalog.search']);
  const r = rig(persisted(), [deezer]);
  await restoreOk(r);
  const album = await r.session.startRadio({
    provider: 'youtube-music',
    kind: 'album',
    id: 'a1',
  });
  assert(!album.ok && album.error.kind === 'not-applicable', 'album seed rejected');
  const malformed = await r.session.startRadio({
    provider: '',
    kind: 'track',
    id: 'x',
  });
  assert(
    !malformed.ok && malformed.error.kind === 'invalid-response',
    'malformed ref rejected',
  );
  const foreign = await r.session.startRadio(ref('deezer', 'd1'));
  assert(
    !foreign.ok && foreign.error.kind === 'unsupported',
    'provider without radio.seed is unsupported',
  );
  assertEqual(radioCalls(r).length, 0, 'no provider was invoked');
  assertEqual(radioCalls(r, deezer).length, 0, 'deezer never invoked');
  assertEqual(readyOf(r).queue.occurrences.length, 0, 'queue untouched');
  assertEqual(readyOf(r).radio, null, 'no tail armed');
  await r.session.dispose();
}

async function radioSeedFailure(): Promise<void> {
  const r = rig(persisted());
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  r.ytm.settleRadio(err(appError('rate-limit', 'slow down', 30_000)));
  const res = await started;
  assert(!res.ok, 'failed seed propagates');
  assertEqual(res.error.kind, 'rate-limit', 'typed error verbatim');
  assertEqual(readyOf(r).radio, null, 'no tail on a failed seed');
  assertEqual(readyOf(r).queue.occurrences.length, 0, 'no partial page');
  assertEqual(readyOf(r).recordings.length, 0, 'no partial recordings');
  await r.session.dispose();
}

async function radioLazyGrowth(): Promise<void> {
  const paused = queue({
    revision: 1,
    occurrences: [occurrence('u1', 'rU')],
    currentOccurrenceId: 'u1',
    positionMs: 0,
    mode: 'paused',
  });
  const r = rig(
    persisted({
      recordings: [recording('rU', [ref('youtube-music', 'u')])],
      queue: paused,
    }),
  );
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  r.ytm.settleRadio(
    ok(
      page(
        [
          meta('youtube-music', 'v1', 'R1', 'A', 200_000),
          meta('youtube-music', 'v2', 'R2', 'A', 200_000),
          meta('youtube-music', 'v3', 'R3', 'A', 200_000),
          meta('youtube-music', 'v4', 'R4', 'A', 200_000),
        ],
        'cont-1',
      ),
    ),
  );
  assert((await started).ok);
  await pump();
  // 4 behind the playhead: the window is satisfied, no fetch.
  assertEqual(radioCalls(r).length, 1, 'window satisfied: no fetch');
  // u1 → v1: 3 remaining, still satisfied.
  assert((await r.session.next()).ok);
  await pump();
  assertEqual(radioCalls(r).length, 1, 'three ahead still satisfies');
  // v1 → v2: 2 remaining — the window opened, fetch cont-1.
  assert((await r.session.next()).ok);
  await pump();
  assertEqual(radioCalls(r).length, 2, 'continuation fetch fired');
  const call = radioCalls(r)[1];
  assert(call !== undefined);
  assertDeepEqual(call.input, { continuation: 'cont-1' });
  const published = readyOf(r).radio;
  assert(
    published !== null && published.fetching,
    'in-flight fetch is published',
  );
  r.ytm.settleRadio(
    ok(
      page(
        [
          meta('youtube-music', 'v5', 'R5', 'A', 200_000),
          meta('youtube-music', 'v6', 'R6', 'A', 200_000),
        ],
        'cont-2',
      ),
    ),
  );
  await pump();
  assertEqual(readyOf(r).queue.occurrences.length, 7, 'page two appended');
  assertEqual(radioCalls(r).length, 2, 'window refilled: chain stopped');
  // v2 → v3 (3 left), v3 → v4 (2 left) — window opens again.
  assert((await r.session.next()).ok);
  await pump();
  assertEqual(radioCalls(r).length, 2);
  assert((await r.session.next()).ok);
  await pump();
  assertEqual(radioCalls(r).length, 3, 'second continuation fired');
  assertDeepEqual(radioCalls(r)[2]?.input, { continuation: 'cont-2' });
  r.ytm.settleRadio(ok(page([meta('youtube-music', 'v7', 'R7', 'A', 200_000)], null)));
  await pump();
  assertEqual(readyOf(r).radio?.status, 'ended', 'end-of-continuation');
  await r.session.dispose();
}

async function radioEndOfContinuation(): Promise<void> {
  const paused = queue({
    revision: 1,
    occurrences: [occurrence('u1', 'rU')],
    currentOccurrenceId: 'u1',
    positionMs: 0,
    mode: 'paused',
  });
  const r = rig(
    persisted({
      recordings: [recording('rU', [ref('youtube-music', 'u')])],
      queue: paused,
    }),
  );
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  r.ytm.settleRadio(ok(page([meta('youtube-music', 'v1', 'R1', 'A', 200_000)], null)));
  assert((await started).ok);
  await pump();
  assertEqual(readyOf(r).radio?.status, 'ended', 'null token ends the tail');
  // The queue finishes honestly — no fetch ever fires again.
  assert((await r.session.next()).ok); // u1 → v1
  await pump();
  assert((await r.session.next()).ok); // v1 → end
  await pump();
  const snap = readyOf(r);
  assertEqual(snap.queue.currentOccurrenceId, null, 'queue ended');
  assertEqual(snap.queue.mode, 'stopped');
  assertEqual(radioCalls(r).length, 1, 'no continuation call was made');
  await r.session.dispose();
}

async function radioFetchFailure(): Promise<void> {
  const paused = queue({
    revision: 1,
    occurrences: [occurrence('u1', 'rU')],
    currentOccurrenceId: 'u1',
    positionMs: 0,
    mode: 'paused',
  });
  const r = rig(
    persisted({
      recordings: [recording('rU', [ref('youtube-music', 'u')])],
      queue: paused,
    }),
  );
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  r.ytm.settleRadio(ok(page([meta('youtube-music', 'v1', 'R1', 'A', 200_000)], 'cont-1')));
  assert((await started).ok);
  await pump();
  // 1 behind the playhead: window open, continuation fetch in flight.
  assertEqual(radioCalls(r).length, 2, 'continuation fetch fired');
  r.ytm.settleRadio(err(appError('transient', 'upstream gone')));
  await pump();
  const radio = readyOf(r).radio;
  assert(radio !== null);
  assertEqual(radio.status, 'failed', 'failed fetch marks the tail');
  assertEqual(radio.error?.kind, 'transient', 'typed error carried');
  assert(!radio.fetching, 'never an infinite spinner');
  // No retry loop: further transitions never call the provider again.
  assert((await r.session.next()).ok); // u1 → v1
  await pump();
  assert((await r.session.next()).ok); // v1 → end
  await pump();
  assertEqual(radioCalls(r).length, 2, 'no retry after a failed tail');
  assertEqual(readyOf(r).queue.mode, 'stopped', 'queue ended honestly');
  await r.session.dispose();
}

async function radioDedupeAndChain(): Promise<void> {
  const paused = queue({
    revision: 1,
    occurrences: [occurrence('u1', 'rU')],
    currentOccurrenceId: 'u1',
    positionMs: 0,
    mode: 'paused',
  });
  const r = rig(
    persisted({
      recordings: [recording('rU', [ref('youtube-music', 'u')])],
      queue: paused,
    }),
  );
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  r.ytm.settleRadio(ok(page([meta('youtube-music', 'v1', 'R1', 'A', 200_000)], 'cont-1')));
  assert((await started).ok);
  await pump();
  // Window open (1 ahead): cont-1 is already in flight.
  assertEqual(radioCalls(r).length, 2);
  // Page 2: v1 dupes the queue, v2 is new — appended, tail still short.
  r.ytm.settleRadio(
    ok(
      page(
        [
          meta('youtube-music', 'v1', 'R1 dupe', 'A', 200_000),
          meta('youtube-music', 'v2', 'R2', 'A', 200_000),
        ],
        'cont-2',
      ),
    ),
  );
  await pump();
  assertEqual(readyOf(r).queue.occurrences.length, 3, 'dupe skipped, new appended');
  assertEqual(readyOf(r).recordings.length, 3, 'dupe minted nothing');
  assertEqual(radioCalls(r).length, 3, 'still short: chained cont-2');
  // Page 3 is all dupes: appended nothing, and does NOT chain.
  r.ytm.settleRadio(
    ok(
      page(
        [
          meta('youtube-music', 'v1', 'R1', 'A', 200_000),
          meta('youtube-music', 'v2', 'R2', 'A', 200_000),
        ],
        'cont-3',
      ),
    ),
  );
  await pump();
  assertEqual(readyOf(r).queue.occurrences.length, 3, 'all-dupe page added nothing');
  assertEqual(radioCalls(r).length, 3, 'zero-yield page does not chain');
  // The next real transition re-evaluates and fetches cont-3.
  assert((await r.session.next()).ok);
  await pump();
  assertEqual(radioCalls(r).length, 4, 'next transition refires growth');
  assertDeepEqual(radioCalls(r)[3]?.input, { continuation: 'cont-3' });
  await r.session.dispose();
}

async function radioStoppedNoGrowth(): Promise<void> {
  const r = rig(persisted());
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  r.ytm.settleRadio(
    ok(
      page(
        [
          meta('youtube-music', 'v1', 'R1', 'A', 200_000),
          meta('youtube-music', 'v2', 'R2', 'A', 200_000),
        ],
        'cont-1',
      ),
    ),
  );
  assert((await started).ok);
  await pump();
  assertEqual(radioCalls(r).length, 1, 'stopped queue never fetches');
  // A playhead appears: consumption arms the window again.
  const occId = readyOf(r).queue.occurrences[0]?.occurrenceId;
  assert(occId !== undefined);
  const playing = r.session.playOccurrence(occId);
  await pump();
  const nextP = r.session.next();
  await pump();
  assertEqual(radioCalls(r).length, 2, 'playhead inside the window fetches');
  // Clean up the pending playback attempts.
  r.player.cancelPendingPrepares();
  await playing;
  await nextP;
  await r.session.dispose();
}

async function radioImportClears(): Promise<void> {
  const paused = queue({
    revision: 1,
    occurrences: [occurrence('u1', 'rU')],
    currentOccurrenceId: 'u1',
    positionMs: 0,
    mode: 'paused',
  });
  const r = rig(
    persisted({
      recordings: [recording('rU', [ref('youtube-music', 'u')])],
      queue: paused,
    }),
  );
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  r.ytm.settleRadio(ok(page([meta('youtube-music', 'v1', 'R1', 'A', 200_000)], 'cont-1')));
  assert((await started).ok);
  await pump();
  assertEqual(radioCalls(r).length, 2, 'continuation in flight');
  const exported = await r.session.exportLibrary();
  assert(exported.ok, 'export failed');
  const imported = await r.session.importLibrary(exported.value.json);
  assert(imported.ok, 'import failed');
  await pump();
  assertEqual(readyOf(r).radio, null, 'import disarms the tail');
  assert(
    r.ytm.cancelledSignals.length > 0,
    'in-flight continuation was cancelled',
  );
  // The stale page resolves cancelled and is discarded, never appended.
  r.ytm.settleRadio(ok(page([meta('youtube-music', 'v9', 'Late', 'A', 1000)], 'x')));
  await pump();
  assertEqual(readyOf(r).queue.occurrences.length, 0, 'queue stays reset');
  await r.session.dispose();
}

async function radioReseed(): Promise<void> {
  const r = rig(persisted());
  await restoreOk(r);
  const first = r.session.startRadio(ref('youtube-music', 'seed-A'));
  await pump();
  r.ytm.settleRadio(ok(page([meta('youtube-music', 'v1', 'A1', 'A', 1000)], 'cont-A')));
  assert((await first).ok);
  await pump();
  const second = r.session.startRadio(ref('youtube-music', 'seed-B'));
  await pump();
  assertDeepEqual(radioCalls(r)[1]?.input, { sourceRef: ref('youtube-music', 'seed-B') });
  r.ytm.settleRadio(ok(page([meta('youtube-music', 'v9', 'B1', 'B', 1000)], 'cont-B')));
  assert((await second).ok);
  await pump();
  const radio = readyOf(r).radio;
  assert(radio !== null);
  assertDeepEqual(radio.seedRef, ref('youtube-music', 'seed-B'), 'new seed replaces');
  assertEqual(radio.status, 'growing');
  assertEqual(readyOf(r).queue.occurrences.length, 2, 'both pages kept their items');
  await r.session.dispose();
}

async function radioOccurrencePlays(): Promise<void> {
  const r = rig(persisted());
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  r.ytm.settleRadio(ok(page([meta('youtube-music', 'v1', 'R1', 'A', 200_000)], 'cont-1')));
  assert((await started).ok);
  await pump();
  const occId = readyOf(r).queue.occurrences[0]?.occurrenceId;
  assert(occId !== undefined);
  const playing = r.session.playOccurrence(occId);
  await pump();
  const prep = r.player.calls.find((c) => c.method === 'prepare');
  assert(prep !== undefined, 'radio occurrence prepares through the normal path');
  assertDeepEqual(
    (prep.input as { provider: string; sourceRef: string }).provider,
    'youtube-music',
  );
  assertEqual(
    (prep.input as { provider: string; sourceRef: string }).sourceRef,
    'v1',
    'the item’s own ref plays — version fidelity preserved',
  );
  r.player.cancelPendingPrepares();
  await playing;
  await r.session.dispose();
}

async function radioStop(): Promise<void> {
  const paused = queue({
    revision: 1,
    occurrences: [occurrence('u1', 'rU')],
    currentOccurrenceId: 'u1',
    positionMs: 0,
    mode: 'paused',
  });
  const r = rig(
    persisted({
      recordings: [recording('rU', [ref('youtube-music', 'u')])],
      queue: paused,
    }),
  );
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  r.ytm.settleRadio(ok(page([meta('youtube-music', 'v1', 'R1', 'A', 200_000)], 'cont-1')));
  assert((await started).ok);
  await pump();
  assertEqual(radioCalls(r).length, 2, 'continuation pending');
  const stopped = r.session.stopRadio();
  assert(stopped.ok, 'stopRadio failed');
  assertEqual(readyOf(r).radio, null, 'tail disarmed');
  // The pending continuation resolves cancelled and lands nothing.
  r.ytm.settleRadio(ok(page([meta('youtube-music', 'v9', 'Late', 'A', 1000)], 'x')));
  await pump();
  assertEqual(readyOf(r).queue.occurrences.length, 2, 'stale page discarded');
  assert((await r.session.next()).ok);
  await pump();
  assertEqual(radioCalls(r).length, 2, 'no fetch after stop');
  await r.session.dispose();
}

async function radioInvalidPage(): Promise<void> {
  const r = rig(persisted());
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  const corrupt: Result<RadioPage> = ok({
    candidates: [
      meta('youtube-music', 'v1', 'R1', 'A', 200_000),
      { ...meta('youtube-music', 'v2', '', 'A', 1000) },
    ],
    continuation: 'cont-1',
  });
  r.ytm.settleRadio(corrupt);
  const res = await started;
  assert(!res.ok, 'corrupt page fails');
  assertEqual(res.error.kind, 'invalid-response');
  assertEqual(readyOf(r).radio, null, 'no tail armed on a bad page');
  assertEqual(readyOf(r).recordings.length, 0, 'all items or none');
  assertEqual(readyOf(r).queue.occurrences.length, 0, 'nothing appended');
  await r.session.dispose();
}

// ---------- auto-arm: last playing occurrence seeds the tail ----------

const PREPARE_TRACE: AttemptTrace = {
  requestId: 'req-x',
  steps: 1,
  httpCalls: 0,
  bytes: 0,
  fuelUsed: 0,
  elapsedMs: 5,
  httpTrace: [],
  guestLog: [],
};

function lastPrepareIdentity(r: Rig): PlaybackIdentity {
  const list = r.player.calls.filter((c) => c.method === 'prepare');
  const last = list[list.length - 1];
  assert(last !== undefined, 'expected a prepare call');
  return (last.input as { identity: PlaybackIdentity }).identity;
}

/** Emit prepared + resolve the in-flight prepare for `handle`. */
async function emitPrepared(
  r: Rig,
  handle: string,
): Promise<PlaybackIdentity> {
  await pump();
  const identity = lastPrepareIdentity(r);
  r.player.emit({
    type: 'prepare',
    requestId: `req-${handle}`,
    identity,
    outcome: {
      type: 'prepared',
      stream: { handle, mime: 'audio/mp4' },
      attempt: PREPARE_TRACE,
    },
  });
  await pump();
  assert(
    r.player.settlePrepare(ok(`req-${handle}`)),
    'expected pending prepare',
  );
  await pump();
  return identity;
}

function serviceTransition(
  r: Rig,
  fields: {
    from: string;
    to: string | null;
    identity?: PlaybackIdentity | null;
    handle?: string | null;
  },
): void {
  const projection = r.player.projections[r.player.projections.length - 1];
  assert(projection !== undefined, 'expected an installed projection');
  r.player.emit({
    type: 'queue-transition',
    projectionId: projection.projectionId,
    projectedQueueRev: projection.queueRev,
    fromOccurrenceId: fields.from,
    toOccurrenceId: fields.to,
    reason: 'ended',
    positionMs: 0,
    identity: fields.identity ?? null,
    handle: fields.handle ?? null,
  });
}

function endViaService(r: Rig, fromOccurrenceId: string): void {
  serviceTransition(r, { from: fromOccurrenceId, to: null });
}

function pausedTailQueue(): PersistedState {
  return persisted({
    recordings: [recording('rU', [ref('youtube-music', 'u')])],
    queue: queue({
      revision: 1,
      occurrences: [occurrence('u1', 'rU')],
      currentOccurrenceId: 'u1',
      positionMs: 0,
      mode: 'paused',
    }),
  });
}

async function autoArmSeedsOnPlayingTail(): Promise<void> {
  const r = rig(pausedTailQueue());
  await restoreOk(r);
  await pump();
  assertEqual(radioCalls(r).length, 0, 'restored-paused tail does not arm');
  const resumed = r.session.resume();
  await pump();
  assertEqual(radioCalls(r).length, 1, 'playing the last item arms the tail');
  assertDeepEqual(
    radioCalls(r)[0]?.input,
    { sourceRef: ref('youtube-music', 'u') },
    'seed taken from the playing item’s routable ref',
  );
  r.player.cancelPendingPrepares();
  await resumed;
  await r.session.dispose();
}

async function autoArmSkipsMidQueue(): Promise<void> {
  const paused = queue({
    revision: 1,
    occurrences: [occurrence('u1', 'rU'), occurrence('u2', 'rV')],
    currentOccurrenceId: 'u1',
    positionMs: 0,
    mode: 'paused',
  });
  const r = rig(
    persisted({
      recordings: [
        recording('rU', [ref('youtube-music', 'u')]),
        recording('rV', [ref('youtube-music', 'v')]),
      ],
      queue: paused,
    }),
  );
  await restoreOk(r);
  const resumed = r.session.resume();
  await pump();
  assertEqual(radioCalls(r).length, 0, 'items remain ahead — no arm');
  r.player.cancelPendingPrepares();
  await resumed;
  await r.session.dispose();
}

async function autoArmSuppressedAfterDisarm(): Promise<void> {
  const r = rig(pausedTailQueue());
  await restoreOk(r);
  const resumed = r.session.resume();
  await pump();
  assertEqual(radioCalls(r).length, 1, 'armed');
  // Disarm while the seed is still in flight: the tail drops and
  // the occurrence is marked so replaying it never reseeds.
  const stopped = r.session.stopRadio();
  assert(stopped.ok, 'stopRadio failed');
  assertEqual(readyOf(r).radio, null, 'disarmed');
  r.ytm.settleRadio(
    ok(page([meta('youtube-music', 'v1', 'R1', 'A', 200_000)], 'cont-1')),
  );
  await pump();
  assertEqual(
    readyOf(r).queue.occurrences.length,
    1,
    'late seed page discarded',
  );
  r.player.cancelPendingPrepares();
  await resumed;
  const replayed = r.session.playOccurrence('u1');
  await pump();
  assertEqual(radioCalls(r).length, 1, 'disarm suppresses the auto-seed');
  r.player.cancelPendingPrepares();
  await replayed;
  await r.session.dispose();
}

async function autoArmDrainResumesIntoTail(): Promise<void> {
  const r = rig(pausedTailQueue());
  await restoreOk(r);
  const resumed = r.session.resume();
  await pump();
  assertEqual(radioCalls(r).length, 1, 'armed before the item ended');
  // The item ends while the seed is still in flight — queue drains.
  assert((await r.session.next()).ok, 'skip past end drains');
  await pump();
  const drained = readyOf(r);
  assertEqual(drained.queue.currentOccurrenceId, null, 'queue drained');
  assertEqual(drained.queue.mode, 'stopped', 'drained queue stops');
  r.ytm.settleRadio(
    ok(
      page(
        [
          meta('youtube-music', 'v10', 'Follow', 'A', 200_000),
          meta('youtube-music', 'v11', 'After', 'B', 200_000),
        ],
        'cont-1',
      ),
    ),
  );
  await pump();
  const snap = readyOf(r);
  assertEqual(
    snap.queue.occurrences.length,
    3,
    'page appended behind the drained item',
  );
  assertEqual(
    snap.queue.currentOccurrenceId,
    snap.queue.occurrences[1]?.occurrenceId,
    'playback resumes at the first appended item',
  );
  assertEqual(snap.queue.mode, 'playing', 'playback continues');
  const prep = r.player.calls.filter((c) => c.method === 'prepare');
  assertEqual(prep.length, 2, 'resumed item prepares');
  assertEqual(
    (prep[1]?.input as { sourceRef: string }).sourceRef,
    'v10',
    'resumed item resolves its own ref',
  );
  r.player.cancelPendingPrepares();
  await resumed;
  await r.session.dispose();
}

async function autoArmServiceDrainResumes(): Promise<void> {
  const r = rig(pausedTailQueue());
  await restoreOk(r);
  const resumed = r.session.resume();
  await emitPrepared(r, 'h-u1');
  assert((await resumed).ok, 'resume failed');
  await pump();
  assertEqual(readyOf(r).queue.mode, 'playing', 'playing u1');
  assert(readyOf(r).playback.type !== 'idle', 'attempt in flight');
  assertEqual(radioCalls(r).length, 1, 'armed while playing');
  // The service reports the queue ran dry inside the installed
  // projection (toOccurrenceId null on an 'ended' reason).
  endViaService(r, 'u1');
  await pump();
  const drained = readyOf(r);
  assertEqual(drained.queue.currentOccurrenceId, null, 'service drained');
  assertEqual(readyOf(r).playback.type, 'idle', 'playhead idles');
  r.ytm.settleRadio(
    ok(page([meta('youtube-music', 'v10', 'Follow', 'A', 200_000)], 'cont-1')),
  );
  await pump();
  const snap = readyOf(r);
  assertEqual(
    snap.queue.currentOccurrenceId,
    snap.queue.occurrences[1]?.occurrenceId,
    'the in-flight page resumes playback when it lands',
  );
  assertEqual(snap.queue.mode, 'playing', 'queue playing again');
  r.player.cancelPendingPrepares();
  await r.session.dispose();
}

async function stopDropsInFlightArm(): Promise<void> {
  const r = rig(pausedTailQueue());
  await restoreOk(r);
  const resumed = r.session.resume();
  await pump();
  assertEqual(radioCalls(r).length, 1, 'armed');
  // A stop while the seed is in flight must leave the queue dead:
  // the late page lands nothing and playback never resurrects.
  const stopped = r.session.stop();
  await pump();
  r.ytm.settleRadio(
    ok(page([meta('youtube-music', 'v9', 'Late', 'A', 1000)], 'x')),
  );
  await pump();
  assert((await stopped).ok, 'stop failed');
  const snap = readyOf(r);
  assertEqual(snap.radio, null, 'stop drops the tail');
  assertEqual(snap.queue.occurrences.length, 1, 'no page appended');
  assertEqual(snap.queue.mode, 'stopped', 'queue stays stopped');
  assertEqual(snap.playback.type, 'idle', 'playback stays idle');
  r.player.cancelPendingPrepares();
  await resumed;
  await r.session.dispose();
}

async function seedOnStoppedQueueStaysIdle(): Promise<void> {
  const r = rig(persisted());
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  r.ytm.settleRadio(
    ok(page([meta('youtube-music', 'v1', 'R1', 'A', 200_000)], 'cont-1')),
  );
  assert((await started).ok);
  await pump();
  const snap = readyOf(r);
  assertEqual(snap.queue.occurrences.length, 1, 'items landed');
  assertEqual(
    snap.queue.currentOccurrenceId,
    null,
    'a seed armed while idle appends for later — never resurrects',
  );
  assertEqual(snap.playback.type, 'idle', 'stays idle');
  await r.session.dispose();
}

async function nativeAdvanceArmsTail(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [
        recording('rU', [ref('youtube-music', 'u')]),
        recording('rV', [ref('youtube-music', 'v')]),
      ],
      queue: queue({
        revision: 1,
        occurrences: [occurrence('u1', 'rU'), occurrence('u2', 'rV')],
        currentOccurrenceId: 'u1',
        positionMs: 0,
        mode: 'paused',
      }),
    }),
  );
  await restoreOk(r);
  const resumed = r.session.resume();
  await emitPrepared(r, 'h-u1');
  await resumed;
  await pump();
  assertEqual(radioCalls(r).length, 0, 'u2 still ahead — no arm');
  // A native-driven move lands on the last item: the arm must fire
  // from the transition reconcile, not only session commands.
  serviceTransition(r, {
    from: 'u1',
    to: 'u2',
    identity: { attemptId: 'svc-u2', queueRev: 2 },
    handle: 'h-u2',
  });
  await pump();
  assertEqual(readyOf(r).queue.currentOccurrenceId, 'u2');
  assertEqual(radioCalls(r).length, 1, 'native advance onto the tail arms');
  assertDeepEqual(
    radioCalls(r)[0]?.input,
    { sourceRef: ref('youtube-music', 'v') },
    'seed comes from the item the service landed on',
  );
  await r.session.dispose();
}

async function seedPrefersAttemptRef(): Promise<void> {
  // Unpinned occurrence whose playback pick is NOT the first stored
  // source ref: the seed must follow the ref actually playing.
  const r = rig(
    persisted({
      recordings: [
        recording('rU', [
          ref('itunes', 'i1'),
          ref('youtube-music', 'y1'),
        ]),
      ],
      queue: queue({
        revision: 1,
        occurrences: [occurrence('u1', 'rU')],
        currentOccurrenceId: 'u1',
        positionMs: 0,
        mode: 'paused',
      }),
    }),
  );
  await restoreOk(r);
  const resumed = r.session.resume();
  await emitPrepared(r, 'h-u1');
  await resumed;
  await pump();
  assertEqual(
    radioCalls(r, r.itunes).length,
    0,
    'the sibling provider’s ref must not seed',
  );
  assertEqual(radioCalls(r).length, 1, 'armed on the tail');
  assertDeepEqual(
    radioCalls(r)[0]?.input,
    { sourceRef: ref('youtube-music', 'y1') },
    'seed follows the attempt’s resolved ref, not stored order',
  );
  await r.session.dispose();
}

async function endedTailNeverReseeds(): Promise<void> {
  const r = rig(persisted());
  await restoreOk(r);
  const started = r.session.startRadio(ref('youtube-music', 'seed-1'));
  await pump();
  // A page with no continuation is terminal — 'the queue simply
  // finishes', it must not silently re-seed a fresh mix.
  r.ytm.settleRadio(
    ok(page([meta('youtube-music', 'v1', 'R1', 'A', 200_000)], null)),
  );
  assert((await started).ok);
  await pump();
  assertEqual(readyOf(r).radio?.status, 'ended');
  const last = readyOf(r).queue.occurrences.at(-1);
  assert(last !== undefined);
  const played = r.session.playOccurrence(last.occurrenceId);
  await pump();
  assertEqual(
    radioCalls(r).length,
    1,
    'playing the last item of an ended mix must not re-seed',
  );
  r.player.cancelPendingPrepares();
  await played;
  await r.session.dispose();
}

async function offlineArmRetriesOnReconnect(): Promise<void> {
  // A locally-owned last track still plays offline; the arm must
  // skip quietly (weather, not a verdict) and fire on reconnect.
  let online = false;
  const r = rig(pausedTailQueue(), [], {
    isOnline: () => online,
    localPlaybackFor: (id) => (id === 'rU' ? 'doc-u' : null),
  });
  await restoreOk(r);
  const resumed = r.session.resume();
  await pump();
  assertEqual(radioCalls(r).length, 0, 'offline tail item must not arm');
  online = true;
  r.session.connectivityChanged();
  await pump();
  assertEqual(radioCalls(r).length, 1, 'reconnect re-arms the tail');
  assertDeepEqual(
    radioCalls(r)[0]?.input,
    { sourceRef: ref('youtube-music', 'u') },
    'seed falls past the local ref to the catalog source',
  );
  r.player.cancelPendingPrepares();
  await resumed;
  await r.session.dispose();
}

async function armWaitsForAttemptRef(): Promise<void> {
  // Only a foreign-provider ref is stored: playback resolves through
  // the candidates round, so the arm is queued while `attempt.ref`
  // is still unknown. The seed must wait for the real pick instead
  // of grabbing a stored ref that isn't the version playing.
  const r = rig(
    persisted({
      recordings: [recording('rU', [ref('itunes', 'i1')])],
      queue: queue({
        revision: 1,
        occurrences: [occurrence('u1', 'rU')],
        currentOccurrenceId: 'u1',
        positionMs: 0,
        mode: 'paused',
      }),
    }),
  );
  await restoreOk(r);
  const resumed = r.session.resume();
  await pump();
  assertEqual(
    radioCalls(r).length,
    0,
    'no seed while the attempt ref is unresolved',
  );
  const adopted = r.ytm.settleCandidates(
    ok([meta('youtube-music', 'cy', 'Song rU', 'Artist', 300_000)]),
  );
  assert(adopted, 'expected a pending candidates call');
  await pump();
  assertEqual(
    radioCalls(r, r.itunes).length,
    0,
    'the foreign stored ref must never seed',
  );
  assertEqual(radioCalls(r).length, 1, 'resolved ref re-arms');
  assertDeepEqual(
    radioCalls(r)[0]?.input,
    { sourceRef: ref('youtube-music', 'cy') },
    'seed is the candidate the attempt actually resolved',
  );
  r.player.cancelPendingPrepares();
  await resumed;
  await r.session.dispose();
}

async function dupePageChasesContinuation(): Promise<void> {
  // Armed while playing; the first page returns only the playing
  // track itself (deduped away) plus a live continuation — the drain
  // must keep chasing until a page actually appends.
  const r = rig(pausedTailQueue());
  await restoreOk(r);
  const resumed = r.session.resume();
  await emitPrepared(r, 'h-u1');
  await resumed;
  await pump();
  assertEqual(radioCalls(r).length, 1, 'armed');
  // Drain before the page lands.
  assert((await r.session.next()).ok, 'skip past end drains');
  await pump();
  assertEqual(readyOf(r).queue.currentOccurrenceId, null);
  r.ytm.settleRadio(
    ok(page([meta('youtube-music', 'u', 'Song rU', 'Artist', 300_000)], 'c1')),
  );
  await pump();
  assertEqual(
    radioCalls(r).length,
    2,
    'duplicate-only page chases the continuation',
  );
  r.ytm.settleRadio(
    ok(page([meta('youtube-music', 'v9', 'Next', 'A', 200_000)], 'c2')),
  );
  await pump();
  const snap = readyOf(r);
  assertEqual(snap.queue.occurrences.length, 2, 'fresh item appended');
  assertEqual(snap.queue.mode, 'playing', 'playback resumes');
  assertEqual(
    snap.queue.currentOccurrenceId,
    snap.queue.occurrences[1]?.occurrenceId,
    'resumes at the first appended item',
  );
  r.player.cancelPendingPrepares();
  await r.session.dispose();
}

async function nativeDrainChasesContinuation(): Promise<void> {
  // A native-driven drain bypasses #derived: when the fetch-ahead was
  // starved (offline for the whole walk to the end), the armed tail
  // holds a continuation with nothing in flight — the drain itself
  // must chase it or the queue strands stopped.
  let online = true;
  const r = rig(pausedTailQueue(), [], { isOnline: () => online });
  await restoreOk(r);
  const resumed = r.session.resume();
  await emitPrepared(r, 'h-u1');
  await resumed;
  await pump();
  assertEqual(radioCalls(r).length, 1, 'armed on the tail');
  r.ytm.settleRadio(
    ok(
      page(
        [
          meta('youtube-music', 'v9', 'Next', 'A', 200_000),
          meta('youtube-music', 'v10', 'Mid', 'A', 200_000),
          meta('youtube-music', 'v11', 'End', 'A', 200_000),
          meta('youtube-music', 'v12', 'Last', 'A', 200_000),
        ],
        'c1',
      ),
    ),
  );
  await pump();
  assertEqual(
    readyOf(r).queue.occurrences.length,
    5,
    'first page appended',
  );
  // Walk to the last item while offline — the fetch-ahead window
  // opens along the way but every grow is skipped, so nothing is in
  // flight when the service drains.
  online = false;
  for (const occ of readyOf(r).queue.occurrences.slice(1)) {
    const proj = r.player.projections[r.player.projections.length - 1];
    serviceTransition(r, {
      from: readyOf(r).queue.currentOccurrenceId ?? '',
      to: occ.occurrenceId,
      identity: {
        attemptId: `svc-${occ.occurrenceId}`,
        queueRev: proj?.queueRev ?? 0,
      },
      handle: `h-${occ.occurrenceId}`,
    });
    await pump();
    assertEqual(readyOf(r).queue.currentOccurrenceId, occ.occurrenceId);
  }
  assertEqual(radioCalls(r).length, 1, 'offline fetch-ahead starved');
  // Connectivity returns and the service drains the last item — the
  // drain itself must chase continuation c1.
  online = true;
  serviceTransition(r, {
    from: readyOf(r).queue.currentOccurrenceId ?? '',
    to: null,
  });
  await pump();
  assertEqual(readyOf(r).queue.currentOccurrenceId, null, 'drained');
  assertEqual(
    radioCalls(r).length,
    2,
    'a native drain chases the live continuation',
  );
  r.ytm.settleRadio(
    ok(page([meta('youtube-music', 'v99', 'After', 'B', 200_000)], 'c2')),
  );
  await pump();
  const snap = readyOf(r);
  assertEqual(snap.queue.mode, 'playing', 'chased page resumes playback');
  assertEqual(
    snap.queue.currentOccurrenceId,
    snap.queue.occurrences[snap.queue.occurrences.length - 1]
      ?.occurrenceId,
    'resumes at the chased page’s first item',
  );
  r.player.cancelPendingPrepares();
  await r.session.dispose();
}

async function drainChaseIsBounded(): Promise<void> {
  const r = rig(pausedTailQueue());
  await restoreOk(r);
  const resumed = r.session.resume();
  await emitPrepared(r, 'h-u1');
  await resumed;
  await pump();
  assert((await r.session.next()).ok);
  await pump();
  // Every page is a duplicate of the playing track — the chase must
  // give up after RADIO_DRAIN_CHASE_PAGES hops, not spin forever.
  const dupe = () =>
    ok(page([meta('youtube-music', 'u', 'Song rU', 'Artist', 300_000)], 'cx'));
  for (let i = 0; i < RADIO_DRAIN_CHASE_PAGES + 2; i += 1) {
    r.ytm.settleRadio(dupe());
    await pump();
  }
  assertEqual(
    radioCalls(r).length,
    1 + RADIO_DRAIN_CHASE_PAGES,
    'duplicate pages stop after the chase bound',
  );
  assertEqual(
    readyOf(r).queue.mode,
    'stopped',
    'queue stays ended once the chase gives up',
  );
  await r.session.dispose();
}

async function pausedSeedDrainsThenResumes(): Promise<void> {
  // Seed while paused, then play the last item through: the armed
  // tail earns the drain-resume — a page landing afterwards restarts
  // playback at its first appended item. The pump lets the queued
  // seed mint its record before resume(), so the record is truly
  // captured in the paused queue.
  const r = rig(pausedTailQueue());
  await restoreOk(r);
  const seeded = r.session.startRadio(ref('youtube-music', 'u'));
  await pump();
  const resumed = r.session.resume();
  await emitPrepared(r, 'h-u1');
  await resumed;
  await pump();
  assertEqual(readyOf(r).queue.mode, 'playing');
  assert((await r.session.next()).ok, 'play through the end');
  await pump();
  assertEqual(readyOf(r).queue.mode, 'stopped', 'drained');
  r.ytm.settleRadio(
    ok(page([meta('youtube-music', 'v9', 'Next', 'A', 200_000)], 'c1')),
  );
  await pump();
  assert((await seeded).ok);
  const snap = readyOf(r);
  assertEqual(snap.queue.mode, 'playing', 'page resumes a played-through tail');
  assertEqual(
    snap.queue.currentOccurrenceId,
    snap.queue.occurrences[1]?.occurrenceId,
    'resumes at the first appended item',
  );
  r.player.cancelPendingPrepares();
  await r.session.dispose();
}

async function unroutableActiveRefBlocksSeed(): Promise<void> {
  // The playing ref's provider cannot seed radio — no substitute is
  // allowed even though a stored itunes ref could.
  const noradio = new FakeProvider(
    'noradio',
    ALL_CAPABILITIES.filter((c) => c !== 'radio.seed'),
  );
  const r = rig(
    persisted({
      recordings: [
        recording('rU', [ref('noradio', 'n1'), ref('itunes', 'i1')]),
      ],
      queue: queue({
        revision: 1,
        occurrences: [occurrence('u1', 'rU')],
        currentOccurrenceId: 'u1',
        positionMs: 0,
        mode: 'paused',
      }),
      settings: { ...SETTINGS, playbackProvider: 'noradio' },
    }),
    [noradio],
  );
  await restoreOk(r);
  const resumed = r.session.resume();
  await emitPrepared(r, 'h-u1');
  await resumed;
  await pump();
  assertEqual(radioCalls(r).length, 0, 'no youtube-music seed');
  assertEqual(
    radioCalls(r, r.itunes).length,
    0,
    'a different provider’s version must not substitute',
  );
  r.player.cancelPendingPrepares();
  await r.session.dispose();
}

async function disarmDuringCommitDropsPage(): Promise<void> {
  // A page commit waiting on storage outlives a synchronous
  // stopRadio() — the disarm must drop the page, not append it.
  const r = rig(pausedTailQueue());
  await restoreOk(r);
  const seeded = r.session.startRadio(ref('youtube-music', 'u'));
  await pump();
  r.storage.holdNextCommit();
  r.ytm.settleRadio(
    ok(page([meta('youtube-music', 'v9', 'Next', 'A', 200_000)], 'c1')),
  );
  await pump();
  // An edit queued behind the held commit must survive the revert —
  // the compensating commit runs inside the same segment, before this
  // edit's segment can stage.
  const enqueued = r.session.enqueueRecording('rU');
  assert(r.session.stopRadio().ok, 'disarm lands mid-commit');
  r.storage.settleCommit(ok(undefined));
  await pump();
  assert((await seeded).ok, 'seed resolves — the page was dropped');
  assert((await enqueued).ok, 'queued edit committed after the revert');
  const snap = readyOf(r);
  assertEqual(snap.queue.occurrences.length, 2, 'page never entered');
  assertEqual(snap.radio, null, 'record gone');
  // The batch still committed durably — the in-segment compensation
  // must have rewritten a page-free queue before the queued edit ran.
  const queueCommits = r.storage.commits.filter(
    (c) => c.batch.queue !== undefined,
  );
  const ids = (c: { batch: StorageBatch }) =>
    c.batch.queue?.occurrences.map((o) => o.occurrenceId);
  const pageCommit = queueCommits[queueCommits.length - 3];
  const revertCommit = queueCommits[queueCommits.length - 2];
  const editCommit = queueCommits[queueCommits.length - 1];
  assertEqual(pageCommit?.batch.queue?.occurrences.length, 2, 'page wrote');
  assertDeepEqual(
    ids(revertCommit ?? { batch: {} }),
    ['u1'],
    'revert restored the pre-page queue before later segments ran',
  );
  assertDeepEqual(
    ids(editCommit ?? { batch: {} }),
    snap.queue.occurrences.map((o) => o.occurrenceId),
    'the queued edit landed on the reverted lineage',
  );
  r.player.cancelPendingPrepares();
  await r.session.dispose();
}

async function pausedDrainDoesNotResume(): Promise<void> {
  // Skipping the last track while PAUSED earns no resume — the
  // armed tail appends its page but playback stays stopped.
  const r = rig(pausedTailQueue());
  await restoreOk(r);
  const seeded = r.session.startRadio(ref('youtube-music', 'u'));
  await pump();
  assert((await r.session.next()).ok, 'paused skip drains');
  await pump();
  assertEqual(readyOf(r).queue.mode, 'stopped');
  r.ytm.settleRadio(
    ok(page([meta('youtube-music', 'v9', 'Next', 'A', 200_000)], 'c1')),
  );
  await pump();
  assert((await seeded).ok);
  const snap = readyOf(r);
  assertEqual(snap.queue.occurrences.length, 2, 'page appends');
  assertEqual(snap.queue.mode, 'stopped', 'no resurrection without playback');
  await r.session.dispose();
}

async function pausedServiceDrainDoesNotResume(): Promise<void> {
  // Same rule on the service path: a transition-to-null landing on
  // a paused queue is stale — it never earns the drain resume.
  const r = rig(pausedTailQueue());
  await restoreOk(r);
  const seeded = r.session.startRadio(ref('youtube-music', 'u'));
  await pump();
  const resumed = r.session.resume();
  await emitPrepared(r, 'h-u1');
  await resumed;
  await pump();
  assert((await r.session.pause()).ok, 'paused');
  serviceTransition(r, { from: 'u1', to: null });
  await pump();
  assertEqual(readyOf(r).queue.mode, 'stopped', 'stale drain applied');
  r.ytm.settleRadio(
    ok(page([meta('youtube-music', 'v9', 'Next', 'A', 200_000)], 'c1')),
  );
  await pump();
  assert((await seeded).ok);
  const snap = readyOf(r);
  assertEqual(snap.queue.occurrences.length, 2, 'page appends');
  assertEqual(snap.queue.mode, 'stopped', 'no resume from a stale drain');
  r.player.cancelPendingPrepares();
  await r.session.dispose();
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['pureRemaining', pureRemaining],
  ['pureIsRadioPage', pureIsRadioPage],
  ['pureShouldGrow', pureShouldGrow],
  ['purePublish', purePublish],
  ['purePlanDedupe', purePlanDedupe],
  ['purePlanMint', purePlanMint],
  ['purePlanExisting', purePlanExisting],
  ['purePlanRejectsMismatched', purePlanRejectsMismatched],
  ['radioSeedFlow', radioSeedFlow],
  ['radioSeedValidation', radioSeedValidation],
  ['radioSeedFailure', radioSeedFailure],
  ['radioLazyGrowth', radioLazyGrowth],
  ['radioEndOfContinuation', radioEndOfContinuation],
  ['radioFetchFailure', radioFetchFailure],
  ['radioDedupeAndChain', radioDedupeAndChain],
  ['radioStoppedNoGrowth', radioStoppedNoGrowth],
  ['radioImportClears', radioImportClears],
  ['radioReseed', radioReseed],
  ['radioOccurrencePlays', radioOccurrencePlays],
  ['radioStop', radioStop],
  ['radioInvalidPage', radioInvalidPage],
  ['autoArmSeedsOnPlayingTail', autoArmSeedsOnPlayingTail],
  ['autoArmSkipsMidQueue', autoArmSkipsMidQueue],
  ['autoArmSuppressedAfterDisarm', autoArmSuppressedAfterDisarm],
  ['autoArmDrainResumesIntoTail', autoArmDrainResumesIntoTail],
  ['autoArmServiceDrainResumes', autoArmServiceDrainResumes],
  ['stopDropsInFlightArm', stopDropsInFlightArm],
  ['seedOnStoppedQueueStaysIdle', seedOnStoppedQueueStaysIdle],
  ['nativeAdvanceArmsTail', nativeAdvanceArmsTail],
  ['seedPrefersAttemptRef', seedPrefersAttemptRef],
  ['endedTailNeverReseeds', endedTailNeverReseeds],
  ['offlineArmRetriesOnReconnect', offlineArmRetriesOnReconnect],
  ['armWaitsForAttemptRef', armWaitsForAttemptRef],
  ['dupePageChasesContinuation', dupePageChasesContinuation],
  ['nativeDrainChasesContinuation', nativeDrainChasesContinuation],
  ['drainChaseIsBounded', drainChaseIsBounded],
  ['pausedSeedDrainsThenResumes', pausedSeedDrainsThenResumes],
  ['unroutableActiveRefBlocksSeed', unroutableActiveRefBlocksSeed],
  ['disarmDuringCommitDropsPage', disarmDuringCommitDropsPage],
  ['pausedDrainDoesNotResume', pausedDrainDoesNotResume],
  ['pausedServiceDrainDoesNotResume', pausedServiceDrainDoesNotResume],
] as const;

export async function run(): Promise<void> {
  for (const [name, fn] of TESTS) {
    await fn();
  }
}
