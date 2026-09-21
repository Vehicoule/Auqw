import { CancellationSource } from '../cancellation.ts';
import type { OperationContext } from '../cancellation.ts';
import { appError } from '../errors.ts';
import type {
  MatchEvidence,
  Recording,
  Settings,
  SourceMapping,
  SourceRef,
  TrackMetadata,
} from '../domain.ts';
import { MatchingEngine } from '../matching/matching-engine.ts';
import type { PersistedState } from '../ports/storage.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import {
  FakeClock,
  FakeLog,
  FakeStorage,
  SequenceIds,
} from '../testing/fakes.ts';
import { assert, assertDeepEqual, assertEqual } from '../testing/assert.ts';
import {
  createCorrections,
  effectiveMapping,
  isRefRejected,
} from './corrections.ts';
import type { CandidateSnapshot, MatchReview } from './library.ts';

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: 'US',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
};

const QUEUE: QueueSnapshot = {
  revision: 0,
  occurrences: [],
  currentOccurrenceId: null,
  positionMs: 0,
  mode: 'stopped',
};

const EVIDENCE: MatchEvidence = {
  titleSimilarity: 0.9,
  artistSimilarity: 0.9,
  durationDeltaMs: 100,
  exactIsrc: false,
  score: 85,
  versionLabels: [],
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

function candidate(provider: string, id: string, title = 'Song'): CandidateSnapshot {
  const metadata = meta(provider, id, title, 'Artist', 300_000);
  return { metadata, ref: metadata.sourceRef };
}

function recording(
  id: string,
  refs: readonly SourceRef[],
  mappings: readonly SourceMapping[] = [],
): Recording {
  return {
    id,
    title: 'Song',
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
    mappings,
    provenance: 'provider',
  };
}

function mapping(
  provider: string,
  id: string,
  status: SourceMapping['status'],
  matchedAtMs: number,
): SourceMapping {
  return { ref: ref(provider, id), status, matchedAtMs, evidence: EVIDENCE };
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
    queue: partial.queue ?? QUEUE,
    settings: partial.settings ?? SETTINGS,
  };
}

function context(): OperationContext {
  return {
    requestId: 'test',
    deadlineMs: Number.MAX_SAFE_INTEGER,
    signal: new CancellationSource().signal,
  };
}

function rig(state: PersistedState) {
  const storage = new FakeStorage(state);
  const clock = new FakeClock(1_000);
  const log = new FakeLog();
  const corrections = createCorrections({
    storage,
    ids: new SequenceIds(),
    clock,
    log,
  });
  return { storage, clock, log, corrections };
}

async function stateOf(storage: FakeStorage): Promise<PersistedState> {
  const loaded = await storage.load(context());
  assert(loaded.ok, 'load failed');
  return loaded.value;
}

async function recordingOf(
  storage: FakeStorage,
  id: string,
): Promise<Recording> {
  const state = await stateOf(storage);
  const rec = state.recordings.find((r) => r.id === id);
  assert(rec !== undefined, `recording ${id} missing`);
  return rec;
}

async function reviewOf(
  storage: FakeStorage,
  reviewId: string,
): Promise<MatchReview> {
  const state = await stateOf(storage);
  const review = state.matchReviews.find((r) => r.reviewId === reviewId);
  assert(review !== undefined, `review ${reviewId} missing`);
  return review;
}

export async function run(): Promise<void> {
  // ---- enqueue + dedupe ---------------------------------------------

  {
    const rec = recording('r1', [ref('itunes', 'i1')]);
    const r = rig(persisted({ recordings: [rec] }));
    const made = await r.corrections.enqueueReview('r1', [
      candidate('youtube-music', 'y1'),
      candidate('youtube-music', 'y2'),
    ]);
    assert(made.ok, 'enqueue failed');
    assertEqual(made.value.status, 'pending');
    assertEqual(made.value.recordingId, 'r1');
    assertEqual(made.value.candidates.length, 2);
    assertEqual(made.value.resolution, null);
    assertEqual(made.value.resolvedMs, null);
    assertEqual(made.value.createdMs, 1_000);

    // A second enqueue while pending returns the same review.
    const again = await r.corrections.enqueueReview('r1', [
      candidate('deezer', 'd9'),
    ]);
    assert(again.ok, 'second enqueue failed');
    assertEqual(again.value.reviewId, made.value.reviewId);
    assertEqual(again.value.candidates.length, 2, 'candidates replaced');

    const state = await stateOf(r.storage);
    assertEqual(state.matchReviews.length, 1);
  }

  // ---- enqueue validation ---------------------------------------------

  {
    const rec = recording('r1', [ref('itunes', 'i1')]);
    const r = rig(persisted({ recordings: [rec] }));
    const missing = await r.corrections.enqueueReview('nope', [
      candidate('youtube-music', 'y1'),
    ]);
    assert(!missing.ok && missing.error.kind === 'not-found');
    const empty = await r.corrections.enqueueReview('r1', []);
    assert(!empty.ok && empty.error.kind === 'invalid-response');
    const tooMany = await r.corrections.enqueueReview(
      'r1',
      Array.from({ length: 65 }, (_, i) =>
        candidate('youtube-music', `y${i}`),
      ),
    );
    assert(!tooMany.ok && tooMany.error.kind === 'invalid-response');
    assertEqual(r.storage.commits.length, 0, 'invalid enqueues committed');
  }

  // ---- confirm --------------------------------------------------------

  {
    const prior = mapping('itunes', 'i1', 'automatic', 100);
    const rec = recording('r1', [ref('itunes', 'i1')], [prior]);
    const r = rig(persisted({ recordings: [rec] }));
    const made = await r.corrections.enqueueReview('r1', [
      candidate('youtube-music', 'y1'),
      candidate('youtube-music', 'y2'),
    ]);
    assert(made.ok, 'enqueue failed');

    const confirmed = await r.corrections.confirm(made.value.reviewId, 1);
    assert(confirmed.ok, 'confirm failed');
    assertEqual(confirmed.value.status, 'confirmed');
    assertDeepEqual(confirmed.value.resolution, {
      ref: ref('youtube-music', 'y2'),
    });
    assertEqual(confirmed.value.resolvedMs, 1_000);

    const recAfter = await recordingOf(r.storage, 'r1');
    const written = recAfter.mappings[recAfter.mappings.length - 1];
    assertEqual(recAfter.mappings.length, 2, 'mapping not appended');
    assertEqual(written?.status, 'user-confirmed');
    assertDeepEqual(written?.ref, ref('youtube-music', 'y2'));
    assertEqual(written?.matchedAtMs, 1_000);
    // The prior automatic claim is retained as provenance; the
    // corrections precedence makes it inert.
    assertDeepEqual(recAfter.mappings[0], prior);
    // Source refs stay untouched — undo is an exact inverse.
    assertDeepEqual(recAfter.sourceRefs, [ref('itunes', 'i1')]);

    // One commit carried recordings + reviews atomically.
    const last = r.storage.commits[r.storage.commits.length - 1];
    assert(
      last !== undefined &&
      last.batch.recordings !== undefined &&
      last.batch.matchReviews !== undefined,
      'confirm did not commit both sections in one batch',
    );

    // A resolved review cannot be re-confirmed.
    const again = await r.corrections.confirm(made.value.reviewId, 0);
    assert(!again.ok && again.error.kind === 'not-applicable');
  }

  // ---- confirm validation ----------------------------------------------

  {
    const rec = recording('r1', [ref('itunes', 'i1')]);
    const r = rig(persisted({ recordings: [rec] }));
    const made = await r.corrections.enqueueReview('r1', [
      candidate('youtube-music', 'y1'),
    ]);
    assert(made.ok, 'enqueue failed');
    const missing = await r.corrections.confirm('no-such-review', 0);
    assert(!missing.ok && missing.error.kind === 'not-found');
    const outOfRange = await r.corrections.confirm(made.value.reviewId, 4);
    assert(!outOfRange.ok && outOfRange.error.kind === 'invalid-response');
    const negative = await r.corrections.confirm(made.value.reviewId, -1);
    assert(!negative.ok && negative.error.kind === 'invalid-response');
    assertEqual(
      r.storage.commits.filter((c) => c.batch.recordings !== undefined)
        .length,
      0,
      'invalid confirms committed recordings',
    );
  }

  // ---- reject -----------------------------------------------------------

  {
    const rec = recording('r1', [ref('itunes', 'i1')]);
    const r = rig(persisted({ recordings: [rec] }));
    const made = await r.corrections.enqueueReview('r1', [
      candidate('youtube-music', 'y1'),
      candidate('youtube-music', 'y2'),
    ]);
    assert(made.ok, 'enqueue failed');
    const rejected = await r.corrections.reject(made.value.reviewId);
    assert(rejected.ok, 'reject failed');
    assertEqual(rejected.value.status, 'rejected');
    assertDeepEqual(rejected.value.resolution, { ref: null });

    const recAfter = await recordingOf(r.storage, 'r1');
    assertEqual(recAfter.mappings.length, 2, 'vetoes not written');
    assert(
      recAfter.mappings.every(
        (m) => m.status === 'rejected' && m.matchedAtMs === 1_000,
      ),
      'rejected mappings malformed',
    );
    // Every candidate ref is vetoed; none became a source attachment.
    assert(isRefRejected(recAfter.mappings, ref('youtube-music', 'y1')));
    assert(isRefRejected(recAfter.mappings, ref('youtube-music', 'y2')));
    assertDeepEqual(recAfter.sourceRefs, [ref('itunes', 'i1')]);

    // The engine excludes vetoed refs from candidacy entirely.
    const outcome = MatchingEngine.match(
      recAfter,
      [
        meta('youtube-music', 'y1', 'Song', 'Artist', 300_000),
        meta('youtube-music', 'y2', 'Song', 'Artist', 300_000),
      ],
      recAfter.mappings,
    );
    assertEqual(outcome.type, 'unavailable', 'vetoed refs still eligible');

    const again = await r.corrections.reject(made.value.reviewId);
    assert(!again.ok && again.error.kind === 'not-applicable');
  }

  // ---- undo a confirm --------------------------------------------------

  {
    const prior = mapping('itunes', 'i1', 'automatic', 100);
    const rec = recording('r1', [ref('itunes', 'i1')], [prior]);
    const r = rig(persisted({ recordings: [rec] }));
    const made = await r.corrections.enqueueReview('r1', [
      candidate('youtube-music', 'y1'),
    ]);
    assert(made.ok, 'enqueue failed');
    const confirmed = await r.corrections.confirm(made.value.reviewId, 0);
    assert(confirmed.ok, 'confirm failed');

    r.clock.advance(50);
    const undone = await r.corrections.undo(made.value.reviewId);
    assert(undone.ok, 'undo failed');
    assertEqual(undone.value.status, 'pending');
    assertEqual(undone.value.resolution, null);
    assertEqual(undone.value.resolvedMs, null);

    const recAfter = await recordingOf(r.storage, 'r1');
    assertDeepEqual(recAfter.mappings, [prior], 'prior state not restored');
  }

  // ---- undo a reject ----------------------------------------------------

  {
    const rec = recording('r1', [ref('itunes', 'i1')]);
    const r = rig(persisted({ recordings: [rec] }));
    const made = await r.corrections.enqueueReview('r1', [
      candidate('youtube-music', 'y1'),
      candidate('youtube-music', 'y2'),
    ]);
    assert(made.ok, 'enqueue failed');
    const rejected = await r.corrections.reject(made.value.reviewId);
    assert(rejected.ok, 'reject failed');
    const undone = await r.corrections.undo(made.value.reviewId);
    assert(undone.ok, 'undo failed');
    assertEqual(undone.value.status, 'pending');
    const recAfter = await recordingOf(r.storage, 'r1');
    assertEqual(recAfter.mappings.length, 0, 'vetoes not removed');
  }

  // ---- undo validation ---------------------------------------------------

  {
    const rec = recording('r1', [ref('itunes', 'i1')]);
    const r = rig(persisted({ recordings: [rec] }));
    const made = await r.corrections.enqueueReview('r1', [
      candidate('youtube-music', 'y1'),
    ]);
    assert(made.ok, 'enqueue failed');
    const pending = await r.corrections.undo(made.value.reviewId);
    assert(!pending.ok && pending.error.kind === 'not-applicable');
    const missing = await r.corrections.undo('no-such-review');
    assert(!missing.ok && missing.error.kind === 'not-found');
  }

  // ---- listing + filtering ------------------------------------------------

  {
    const recs = [
      recording('r1', [ref('itunes', 'i1')]),
      recording('r2', [ref('itunes', 'i2')]),
      recording('r3', [ref('itunes', 'i3')]),
    ];
    const r = rig(persisted({ recordings: recs }));
    const first = await r.corrections.enqueueReview('r1', [
      candidate('youtube-music', 'y1'),
    ]);
    r.clock.advance(10);
    const second = await r.corrections.enqueueReview('r2', [
      candidate('youtube-music', 'y2'),
    ]);
    r.clock.advance(10);
    const third = await r.corrections.enqueueReview('r3', [
      candidate('youtube-music', 'y3'),
    ]);
    assert(first.ok && second.ok && third.ok, 'enqueues failed');
    const resolved = await r.corrections.confirm(second.value.reviewId, 0);
    assert(resolved.ok, 'confirm failed');

    const pending = await r.corrections.listReviews();
    assert(pending.ok, 'list failed');
    assertDeepEqual(
      pending.value.map((v) => v.reviewId),
      [first.value.reviewId, third.value.reviewId],
      'pending queue wrong or unordered',
    );

    const all = await r.corrections.listReviews({ status: 'all' });
    assert(all.ok && all.value.length === 3, 'all filter wrong');

    const confirmedOnly = await r.corrections.listReviews({
      status: 'confirmed',
    });
    assert(confirmedOnly.ok && confirmedOnly.value.length === 1);
    assertEqual(confirmedOnly.value[0]?.reviewId, second.value.reviewId);
  }

  // ---- corrections precedence (outranking) ---------------------------------

  {
    // A newer automatic mapping never shadows a user correction.
    const rec = recording('r1', [ref('itunes', 'i1')], [
      mapping('youtube-music', 'y-old', 'user-confirmed', 100),
      mapping('youtube-music', 'y-new', 'automatic', 200),
    ]);
    const best = effectiveMapping(rec, 'youtube-music');
    assertEqual(best?.status, 'user-confirmed');
    assertDeepEqual(best?.ref, ref('youtube-music', 'y-old'));

    // Without a correction the latest automatic wins.
    const automatics = recording('r2', [ref('itunes', 'i2')], [
      mapping('youtube-music', 'y1', 'automatic', 100),
      mapping('youtube-music', 'y2', 'automatic', 300),
      mapping('youtube-music', 'y3', 'automatic', 200),
    ]);
    assertDeepEqual(
      effectiveMapping(automatics, 'youtube-music')?.ref,
      ref('youtube-music', 'y2'),
    );

    // Rejected mappings are never picked and veto their ref.
    const vetoed = recording('r3', [ref('itunes', 'i3')], [
      mapping('youtube-music', 'y1', 'rejected', 300),
      mapping('youtube-music', 'y1', 'automatic', 100),
    ]);
    assertEqual(effectiveMapping(vetoed, 'youtube-music'), null);
    assert(isRefRejected(vetoed.mappings, ref('youtube-music', 'y1')));

    // A later rejection vetoes an earlier confirmation of the same ref.
    const overturned = recording('r4', [ref('itunes', 'i4')], [
      mapping('youtube-music', 'y1', 'user-confirmed', 100),
      mapping('youtube-music', 'y1', 'rejected', 400),
      mapping('youtube-music', 'y2', 'automatic', 50),
    ]);
    const next = effectiveMapping(overturned, 'youtube-music');
    assertDeepEqual(next?.ref, ref('youtube-music', 'y2'));

    // Other providers' mappings are invisible to the pick.
    const other = recording('r5', [ref('itunes', 'i5')], [
      mapping('deezer', 'd1', 'user-confirmed', 100),
    ]);
    assertEqual(effectiveMapping(other, 'youtube-music'), null);

    // A user-confirmed mapping wins inside the engine even when the
    // candidate would score below the auto threshold.
    const confirmedRec = recording('r6', [ref('itunes', 'i6')], [
      mapping('youtube-music', 'y1', 'user-confirmed', 100),
    ]);
    const outcome = MatchingEngine.match(
      confirmedRec,
      [meta('youtube-music', 'y1', 'Song', 'Artist', 300_000)],
      confirmedRec.mappings,
    );
    assert(outcome.type === 'matched', 'user verdict not honored');
  }

  // ---- serialization + cancellation + failures -----------------------------

  {
    const rec = recording('r1', [ref('itunes', 'i1')]);
    const r = rig(persisted({ recordings: [rec] }));
    const made = await r.corrections.enqueueReview('r1', [
      candidate('youtube-music', 'y1'),
    ]);
    assert(made.ok, 'enqueue failed');
    // Ops serialize: undo observes confirm's committed state.
    const [confirmed, undone] = await Promise.all([
      r.corrections.confirm(made.value.reviewId, 0),
      r.corrections.undo(made.value.reviewId),
    ]);
    assert(confirmed.ok, 'confirm failed');
    assert(undone.ok, 'undo failed');
    assertEqual(undone.value.status, 'pending');
    const recAfter = await recordingOf(r.storage, 'r1');
    assertEqual(recAfter.mappings.length, 0, 'undo lost to a race');

    // A pre-cancelled signal stops the op before any boundary call.
    const source = new CancellationSource();
    source.cancel();
    const cancelled = await r.corrections.confirm(
      made.value.reviewId,
      0,
      source.signal,
    );
    assert(!cancelled.ok && cancelled.error.kind === 'cancelled');
    const state = await stateOf(r.storage);
    assertEqual(state.matchReviews[0]?.status, 'pending');

    // A commit failure is a typed error and logs a warning.
    const made2 = await r.corrections.enqueueReview('r1', [
      candidate('youtube-music', 'y9'),
    ]);
    assert(made2.ok, 'enqueue failed');
    r.storage.failNext(appError('internal', 'disk full'));
    const failed = await r.corrections.confirm(made2.value.reviewId, 0);
    assert(!failed.ok && failed.error.kind === 'internal');
    assert(
      r.log.entries.some((e) => e.level === 'warn'),
      'commit failure not logged',
    );
    const review = await reviewOf(r.storage, made2.value.reviewId);
    assertEqual(review.status, 'pending', 'failed commit changed state');
  }
}
