import type {
  QueueOccurrence,
  Recording,
  Settings,
  SourceRef,
  TrackMetadata,
} from '../domain.ts';
import { appError, err, ok } from '../errors.ts';
import type { Result } from '../errors.ts';
import type {
  AttemptTrace,
  PlayerEvent,
  PlaybackIdentity,
} from '../ports/player.ts';
import type { PlayerPort } from '../ports/player.ts';
import type { PersistedState, StorageBatch } from '../ports/storage.ts';
import type { StoragePort } from '../ports/storage.ts';
import type { OperationContext } from '../cancellation.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import type { ProviderPort } from '../ports/provider.ts';
import { Session } from './session.ts';
import type { ReadySession, SessionState } from './session.ts';
import {
  FakeClock,
  FakeLog,
  FakePlayer,
  FakeProvider,
  FakeStorage,
  SequenceIds,
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

const TRACE: AttemptTrace = {
  requestId: 'req-x',
  steps: 1,
  httpCalls: 0,
  bytes: 0,
  fuelUsed: 0,
  elapsedMs: 5,
  httpTrace: [],
  guestLog: [],
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
  };
}

function occurrence(
  id: string,
  recordingId: string,
  selectedRef: SourceRef | null = null,
): QueueOccurrence {
  return { occurrenceId: id, recordingId, selectedRef };
}

function emptyQueue(): QueueSnapshot {
  return {
    revision: 0,
    occurrences: [],
    currentOccurrenceId: null,
    positionMs: 0,
    mode: 'stopped',
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
    queue: partial.queue ?? emptyQueue(),
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

function rig(state: PersistedState, extraProviders: ProviderPort[] = []): Rig {
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
    log,
    defaults: SETTINGS,
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

function ready(state: SessionState): ReadySession {
  assert(state.type === 'ready', `expected ready, got ${state.type}`);
  return state;
}

function readyOf(r: Rig): ReadySession {
  return ready(r.session.snapshot());
}

function calls(r: Rig, method: string): { method: string; input: unknown }[] {
  return r.player.calls.filter((c) => c.method === method);
}

function preparedEvent(
  identity: PlaybackIdentity,
  handle: string,
): PlayerEvent {
  return {
    type: 'prepare',
    requestId: `req-${handle}`,
    identity,
    outcome: {
      type: 'prepared',
      stream: { handle, mime: 'audio/mp4' },
      attempt: TRACE,
    },
  };
}

function statusEvent(
  identity: PlaybackIdentity,
  handle: string,
  state: 'playing' | 'paused' | 'buffering' | 'ended' | 'failed',
  positionMs: number,
  error = appError('transient', 'player failed'),
): PlayerEvent {
  const base = {
    type: 'status' as const,
    handle,
    identity,
    state,
    positionMs,
  };
  return state === 'failed' ? { ...base, error } : base;
}

function lastPrepareIdentity(r: Rig): PlaybackIdentity {
  const list = calls(r, 'prepare');
  const last = list[list.length - 1];
  assert(last !== undefined, 'expected a prepare call');
  return (last.input as { identity: PlaybackIdentity }).identity;
}

/** Pumps until the player saw a prepare call, then emits prepared. */
async function emitPrepared(r: Rig, handle: string): Promise<PlaybackIdentity> {
  await pump();
  const identity = lastPrepareIdentity(r);
  r.player.emit(preparedEvent(identity, handle));
  await pump();
  assert(
    r.player.settlePrepare(ok(`req-${handle}`)),
    'expected pending prepare',
  );
  await pump();
  return identity;
}

async function restoreOk(r: Rig): Promise<void> {
  const res = await r.session.restore();
  assert(res.ok, 'restore failed');
}

/** Runs the full happy-path pipeline to 'playing' for the current item. */
async function playThrough(r: Rig, occurrenceId: string): Promise<void> {
  const started = r.session.playOccurrence(occurrenceId);
  await pump();
  // Candidates may or may not be needed depending on mappings.
  if (r.ytm.pendingCount('candidates') > 0) {
    const rec = readyOf(r).recordings.find(
      (x) => x.id === readyOf(r).queue.occurrences.find((o) => o.occurrenceId === occurrenceId)?.recordingId,
    );
    assert(rec !== undefined, 'recording missing');
    const candidate = meta(
      'youtube-music',
      `ytm-${occurrenceId}`,
      rec.title,
      rec.artist ?? 'Artist',
      rec.durationMs ?? 300_000,
    );
    r.ytm.settleCandidates(ok([candidate]));
    await pump();
  }
  const identity = lastPrepareIdentity(r);
  r.player.emit(preparedEvent(identity, `h-${occurrenceId}`));
  await pump();
  assert(r.player.settlePrepare(ok(`req-${occurrenceId}`)), 'pending prepare');
  const res = await started;
  assert(res.ok, 'playOccurrence failed');
  await pump();
}

async function restorePlayingSnapshot(): Promise<void> {
  const queue: QueueSnapshot = {
    revision: 5,
    occurrences: [occurrence('o1', 'r1')],
    currentOccurrenceId: 'o1',
    positionMs: 1200,
    mode: 'playing',
  };
  const r = rig(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
      queue,
    }),
  );
  await restoreOk(r);
  const snap = readyOf(r);
  assertEqual(snap.queue.mode, 'paused', 'playing restores paused');
  assertEqual(snap.queue.positionMs, 1200, 'position preserved');
  assertEqual(snap.playback.type, 'idle', 'playback idle after restore');
  const playbackCalls = r.player.calls.filter(
    (c) => c.method !== 'setQueueProjection',
  );
  assertEqual(playbackCalls.length, 0, 'no playback calls on restore');
  const lastCommit = r.storage.commits[r.storage.commits.length - 1];
  assert(lastCommit !== undefined, 'paused queue committed');
  assertEqual(
    (lastCommit.batch.queue as QueueSnapshot).mode,
    'paused',
    'committed queue is paused',
  );

  // Invalid whole document: occurrence references a missing recording.
  const bad = rig(
    persisted({
      recordings: [],
      queue: { ...queue, mode: 'paused' },
    }),
  );
  const res = await bad.session.restore();
  assert(!res.ok, 'invalid doc must fail');
  assertEqual(res.error.kind, 'invalid-response');
  const badSnap = bad.session.snapshot();
  assert(badSnap.type === 'restore-failed', 'restore-failed state');
  assertEqual(bad.storage.commits.length, 0, 'no partial mutation committed');
}

async function metadataToPrepare(): Promise<void> {
  const r = rig(persisted());
  await restoreOk(r);
  const m = meta('itunes', 'it-1', 'Roads', 'Portishead', 300_000);
  const playing = r.session.addAndPlay(m);
  await pump();
  assertEqual(
    readyOf(r).playback.type,
    'preparing',
    'preparing published before awaits',
  );
  // Catalog-independent: candidates come from the playback provider.
  assertEqual(r.ytm.pendingCount('candidates'), 1);
  r.ytm.settleCandidates(
    ok([meta('youtube-music', 'ytm-9', 'Roads', 'Portishead', 300_000)]),
  );
  await pump();
  const identity = lastPrepareIdentity(r);
  const prepInput = calls(r, 'prepare')[0]?.input as {
    provider: string;
    sourceRef: string;
  };
  assertEqual(prepInput.provider, 'youtube-music');
  assertEqual(prepInput.sourceRef, 'ytm-9', 'selected ref id prepares');
  // Prepared event arrives BEFORE the prepare promise settles.
  r.player.emit(preparedEvent(identity, 'h-1'));
  await pump();
  assertEqual(calls(r, 'play').length, 1, 'exactly one play call');
  assert(
    r.player.settlePrepare(ok('req-9')),
    'prepare promise still pending',
  );
  const res = await playing;
  assert(res.ok, 'addAndPlay failed');
  await pump();
  const snap = readyOf(r);
  const rec = snap.recordings[0];
  assert(rec !== undefined);
  assert(
    rec.mappings.some(
      (m) => m.status === 'automatic' && m.ref.id === 'ytm-9',
    ),
    'automatic mapping appended',
  );
  assertEqual(
    snap.queue.occurrences[0]?.selectedRef?.id,
    'ytm-9',
    'occurrence selectedRef set',
  );
  const playCall = calls(r, 'play')[0]?.input as {
    identity: PlaybackIdentity;
  };
  assertDeepEqual(playCall.identity, identity);
  assert(
    ['buffering', 'playing', 'paused'].includes(snap.playback.type),
    'playback progressed past preparing',
  );
  assertEqual(calls(r, 'play').length, 1, 'still exactly one play call');
}

async function rapidPlayIntents(): Promise<void> {
  const state = persisted({
    recordings: [
      recording('rA', [ref('itunes', 'a')]),
      recording('rB', [ref('itunes', 'b')]),
    ],
    queue: {
      revision: 2,
      occurrences: [occurrence('oA', 'rA'), occurrence('oB', 'rB')],
      currentOccurrenceId: null,
      positionMs: 0,
      mode: 'stopped',
    },
  });
  const r = rig(state);
  await restoreOk(r);
  const a = r.session.playOccurrence('oA');
  await pump();
  assertEqual(r.ytm.pendingCount('candidates'), 1, 'A candidates pending');
  const identities = r.states
    .map((s) => (s.type === 'ready' ? s.playback : null))
    .filter((p): p is NonNullable<typeof p> => p !== null && 'identity' in p)
    .map((p) => ('identity' in p ? p.identity : undefined));
  const idA = identities[identities.length - 1];
  assert(idA !== undefined, 'A identity published');
  const b = r.session.playOccurrence('oB');
  await pump();
  assertEqual(r.ytm.pendingCount('candidates'), 2, 'B candidates pending');
  // A's stale candidates resolve late: no effect.
  r.ytm.settleCandidatesAt(
    0,
    ok([meta('youtube-music', 'ytm-a', 'Song rA', 'Artist', 300_000)]),
  );
  await pump();
  r.ytm.settleCandidates(
    ok([meta('youtube-music', 'ytm-b', 'Song rB', 'Artist', 300_000)]),
  );
  await pump();
  const idB = lastPrepareIdentity(r);
  assert(idB.attemptId !== idA.attemptId, 'fresh attempt id');
  // A stale prepared event for A is released, never played.
  r.player.emit(preparedEvent(idA, 'h-stale-A'));
  r.player.emit(preparedEvent(idB, 'h-B'));
  await pump();
  assert(r.player.settlePrepare(ok('req-B')), 'B prepare pending');
  await Promise.all([a, b]);
  await pump();
  const releases = calls(r, 'release').map(
    (c) => (c.input as { handle: string }).handle,
  );
  assert(releases.includes('h-stale-A'), 'stale prepared handle released');
  assertEqual(calls(r, 'play').length, 1, 'only final identity plays');
  const playInput = calls(r, 'play')[0]?.input as {
    identity: PlaybackIdentity;
  };
  assertDeepEqual(playInput.identity, idB);
  const playback = readyOf(r).playback;
  assert('identity' in playback && playback.identity.attemptId === idB.attemptId);
}

async function rapidProviderSwitches(): Promise<void> {
  const spotify = new FakeProvider('spotify');
  const r = rig(
    persisted({
      recordings: [recording('r1', [ref('itunes', 'i1')])],
      queue: {
        revision: 1,
        occurrences: [occurrence('o1', 'r1')],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
    [spotify],
  );
  await restoreOk(r);
  const playing = r.session.playOccurrence('o1');
  await pump();
  assertEqual(r.ytm.pendingCount('candidates'), 1);
  const toSpotify = await r.session.updateSettings({
    ...SETTINGS,
    playbackProvider: 'spotify',
  });
  assert(toSpotify.ok, 'settings switch failed');
  await pump();
  assertEqual(spotify.pendingCount('candidates'), 1, 'spotify candidates');
  const backToYtm = await r.session.updateSettings(SETTINGS);
  assert(backToYtm.ok, 'settings switch back failed');
  await pump();
  // Final attempt: candidates on the last provider.
  r.ytm.settleCandidatesAt(
    r.ytm.pendingCount('candidates') - 1,
    ok([meta('youtube-music', 'ytm-final', 'Song r1', 'Artist', 300_000)]),
  );
  await pump();
  const identity = lastPrepareIdentity(r);
  r.player.emit(preparedEvent(identity, 'h-final'));
  await pump();
  r.player.settlePrepare(ok('req-final'));
  const res = await playing;
  await pump();
  assert(r.ytm.cancelledSignals.length >= 1, 'first ytm candidates cancelled');
  assert(
    spotify.cancelledSignals.length >= 1,
    'spotify candidates cancelled',
  );
  const prepInput = calls(r, 'prepare').at(-1)?.input as {
    provider: string;
  };
  assertEqual(prepInput.provider, 'youtube-music', 'final provider wins');
  assert(
    !res.ok && res.error.kind === 'superseded',
    'superseded intent reports superseded',
  );
  assertEqual(calls(r, 'play').length, 1);
}

async function deadlineTimeout(): Promise<void> {
  const r = rig(persisted());
  await restoreOk(r);
  const playing = r.session.addAndPlay(
    meta('itunes', 'it-1', 'Song X', 'Artist', 300_000),
  );
  await pump();
  assertEqual(r.ytm.pendingCount('candidates'), 1);
  r.clock.advance(15_000);
  await pump();
  const res = await playing;
  assert(!res.ok, 'timeout surfaces');
  assertEqual(res.error.kind, 'timeout');
  assert(res.error.retryable, 'timeout is retryable');
  const snap = readyOf(r);
  assertEqual(snap.playback.type, 'failed');
  assertEqual(snap.queue.mode, 'paused', 'blocked item pauses');
  assert(snap.queue.blockedError !== undefined, 'queue blocked');
  assert(r.ytm.cancelledSignals.length >= 1, 'provider work cancelled');
  // Retry begins a fresh attempt.
  const retry = r.session.retryCurrent();
  await pump();
  assert(
    r.ytm.calls.filter((c) => c.method === 'candidates').length === 2,
    'retry starts fresh candidates',
  );
  const idNew = r.states
    .map((s) => (s.type === 'ready' ? s.playback : null))
    .filter((p): p is NonNullable<typeof p> => p !== null && 'identity' in p)
    .map((p) => ('identity' in p ? p.identity : undefined))
    .at(-1);
  // The first (cancelled) deferred still occupies queue index 0.
  r.ytm.settleCandidatesAt(
    r.ytm.pendingCount('candidates') - 1,
    ok([meta('youtube-music', 'ytm-r', 'Song X', 'Artist', 300_000)]),
  );
  await pump();
  r.player.emit(preparedEvent(lastPrepareIdentity(r), 'h-retry'));
  await pump();
  r.player.settlePrepare(ok('req-retry'));
  const retryRes = await retry;
  assert(retryRes.ok, 'retry succeeds');
  assert(idNew !== undefined);
}

async function naturalEnded(): Promise<void> {
  // With an installed projection, the service owns the advance: an
  // ended status defers to the queue-transition event and JS never
  // advances or prepares the successor itself.
  const r = rig(
    persisted({
      recordings: [
        recording('rA', [ref('youtube-music', 'yA')]),
        recording('rB', [ref('youtube-music', 'yB')]),
      ],
      queue: {
        revision: 2,
        occurrences: [
          occurrence('oA', 'rA', ref('youtube-music', 'yA')),
          occurrence('oB', 'rB', ref('youtube-music', 'yB')),
        ],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  await playThrough(r, 'oA');
  const snap0 = readyOf(r);
  const idA = 'identity' in snap0.playback ? snap0.playback.identity : undefined;
  assert(idA !== undefined);
  const preps = calls(r, 'prepare').length;
  // Ended defers: still current, no release, no prepare.
  r.player.emit(statusEvent(idA, 'h-oA', 'ended', 300_000));
  await pump();
  assertEqual(
    readyOf(r).queue.currentOccurrenceId,
    'oA',
    'ended defers to the service transition',
  );
  // A duplicate ended stays a no-op.
  r.player.emit(statusEvent(idA, 'h-oA', 'ended', 300_000));
  await pump();
  assertEqual(readyOf(r).queue.currentOccurrenceId, 'oA');
  assertEqual(calls(r, 'prepare').length, preps, 'no JS advance');
  // The service reports the transition: exactly one advance, no app
  // prepare, old handle released exactly once.
  const svc: PlaybackIdentity = {
    attemptId: 'svc-1',
    queueRev: r.player.projections.at(-1)?.queueRev ?? 0,
  };
  r.player.emit(
    transitionEvent(r, {
      from: 'oA',
      to: 'oB',
      reason: 'ended',
      positionMs: 0,
      identity: svc,
      handle: 'h-svc',
    }),
  );
  await pump();
  assertEqual(
    readyOf(r).queue.currentOccurrenceId,
    'oB',
    'transition advances once',
  );
  assertEqual(calls(r, 'prepare').length, preps, 'no second prepare');
  const releasesA = calls(r, 'release').filter(
    (c) => (c.input as { handle: string }).handle === 'h-oA',
  );
  assertEqual(releasesA.length, 1, 'old handle released exactly once');
  // End of queue: ended defers, then the tail transition to null stops.
  r.player.emit(statusEvent(svc, 'h-svc', 'ended', 300_000));
  await pump();
  assertEqual(readyOf(r).queue.currentOccurrenceId, 'oB', 'deferred');
  r.player.emit(
    transitionEvent(r, {
      from: 'oB',
      to: null,
      reason: 'ended',
      positionMs: 0,
      identity: null,
      handle: null,
    }),
  );
  await pump();
  const snap = readyOf(r);
  assertEqual(snap.queue.mode, 'stopped', 'end of queue stops');
  assertEqual(snap.playback.type, 'idle');
  assertEqual(calls(r, 'play').length, 1, 'one app play call total');
}

async function endedFallback(): Promise<void> {
  // Without an installed projection the JS fallback path advances
  // and prepares the successor, preserving availability honesty.
  const r = rig(
    persisted({
      recordings: [
        recording('rA', [ref('itunes', 'a')]),
        recording('rB', [ref('itunes', 'b')]),
      ],
      queue: {
        revision: 2,
        occurrences: [occurrence('oA', 'rA'), occurrence('oB', 'rB')],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  const playing = r.session.playOccurrence('oA');
  await pump();
  r.ytm.settleCandidates(
    ok([meta('youtube-music', 'ytm-a', 'Song rA', 'Artist', 300_000)]),
  );
  await pump();
  const idA = lastPrepareIdentity(r);
  r.player.emit(preparedEvent(idA, 'h-A'));
  await pump();
  r.player.settlePrepare(ok('req-A'));
  assert((await playing).ok);
  await pump();
  // Fail the next projection install; a seek re-projects and fails.
  r.player.failNextProjection(appError('transient', 'projection down'));
  assert((await r.session.seekTo(100)).ok);
  await pump();
  const idNow = readyOf(r).playback;
  const identity = 'identity' in idNow ? idNow.identity : undefined;
  assert(identity !== undefined);
  const preps = calls(r, 'prepare').length;
  r.player.emit(statusEvent(identity, 'h-A', 'ended', 300_000));
  await pump();
  assertEqual(
    readyOf(r).queue.currentOccurrenceId,
    'oB',
    'failed projection falls back to JS advance',
  );
  while (r.ytm.pendingCount('candidates') > 0) {
    r.ytm.settleCandidatesAt(
      r.ytm.pendingCount('candidates') - 1,
      ok([meta('youtube-music', 'ytm-b', 'Song rB', 'Artist', 300_000)]),
    );
    await pump();
    if (r.player.pendingPrepares > 0) {
      break;
    }
  }
  assertEqual(
    calls(r, 'prepare').length,
    preps + 1,
    'fallback prepares successor',
  );
  const idB = lastPrepareIdentity(r);
  r.player.emit(preparedEvent(idB, 'h-B'));
  await pump();
  r.player.settlePrepare(ok('req-B'));
  await pump();
  // End of queue through the fallback path stops.
  r.player.failNextProjection(appError('transient', 'projection down'));
  assert((await r.session.seekTo(50)).ok);
  await pump();
  const idB2 = readyOf(r).playback;
  const identityB = 'identity' in idB2 ? idB2.identity : undefined;
  assert(identityB !== undefined);
  r.player.emit(statusEvent(identityB, 'h-B', 'ended', 300_000));
  await pump();
  const snap = readyOf(r);
  assertEqual(snap.queue.mode, 'stopped', 'end of queue stops');
  assertEqual(snap.playback.type, 'idle');
}

async function pauseResumeSeek(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
      queue: {
        revision: 1,
        occurrences: [
          occurrence('o1', 'r1', ref('youtube-music', 'y1')),
        ],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  await playThrough(r, 'o1');
  const snap0 = readyOf(r);
  const id0 = 'identity' in snap0.playback ? snap0.playback.identity : undefined;
  assert(id0 !== undefined);
  const rev0 = snap0.queue.revision;

  const paused = await r.session.pause();
  assert(paused.ok, 'pause failed');
  const snapP = readyOf(r);
  assertEqual(snapP.queue.revision, rev0 + 1, 'pause ticks once');
  assertEqual(snapP.queue.mode, 'paused');
  const idP = 'identity' in snapP.playback ? snapP.playback.identity : undefined;
  assert(idP !== undefined);
  assertEqual(idP.attemptId, id0.attemptId, 'same attempt');
  assertEqual(idP.queueRev, rev0 + 1, 'identity tracks new revision');
  const pauseCall = calls(r, 'pause')[0]?.input as PlaybackIdentity;
  assertDeepEqual(pauseCall, idP);

  // Observed status positions do not change queue revision.
  r.player.emit(statusEvent(idP, 'h-o1', 'paused', 4_500));
  await pump();
  const snapObs = readyOf(r);
  assertEqual(snapObs.queue.revision, rev0 + 1, 'observed position no tick');
  assertEqual(snapObs.queue.positionMs, 4_500);

  const resumed = await r.session.resume();
  assert(resumed.ok, 'resume failed');
  const snapR = readyOf(r);
  assertEqual(snapR.queue.revision, rev0 + 2, 'resume ticks once');
  const resumePlay = calls(r, 'play').at(-1)?.input as {
    identity: PlaybackIdentity;
  };
  assertEqual(resumePlay.identity.attemptId, id0.attemptId);
  assertEqual(resumePlay.identity.queueRev, rev0 + 2);

  const seeked = await r.session.seekTo(9_000);
  assert(seeked.ok, 'seek failed');
  const snapS = readyOf(r);
  assertEqual(snapS.queue.revision, rev0 + 3, 'seek ticks once');
  assertEqual(snapS.queue.positionMs, 9_000);
  const seekCall = calls(r, 'seekTo')[0]?.input as {
    positionMs: number;
    identity: PlaybackIdentity;
  };
  assertEqual(seekCall.positionMs, 9_000);
  assertEqual(seekCall.identity.attemptId, id0.attemptId);
  assertEqual(seekCall.identity.queueRev, rev0 + 3);
}

async function previousSemantics(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [
        recording('rA', [ref('itunes', 'a')]),
        recording('rB', [ref('itunes', 'b')]),
      ],
      queue: {
        revision: 2,
        occurrences: [occurrence('oA', 'rA'), occurrence('oB', 'rB')],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  await playThrough(r, 'oB');
  const idB = lastPrepareIdentity(r);
  // >3s restarts the same occurrence: bounded seekTo(0), no re-prepare.
  r.player.emit(statusEvent(idB, 'h-oB', 'playing', 5_000));
  await pump();
  const prepsBefore = calls(r, 'prepare').length;
  const restarted = await r.session.previous();
  await pump();
  assert(restarted.ok, 'previous failed');
  const snapRestart = readyOf(r);
  assertEqual(
    snapRestart.queue.currentOccurrenceId,
    'oB',
    '>3s restarts same item',
  );
  assertEqual(snapRestart.queue.positionMs, 0, 'position reset');
  const seekRestart = calls(r, 'seekTo').at(-1)?.input as {
    positionMs: number;
    identity: PlaybackIdentity;
  };
  assert(seekRestart !== undefined, 'restart seeks natively');
  assertEqual(seekRestart.positionMs, 0);
  assertEqual(
    seekRestart.identity.attemptId,
    idB.attemptId,
    'same attempt, new revision',
  );
  assertEqual(
    calls(r, 'prepare').length,
    prepsBefore,
    'restart does not re-prepare',
  );
  // <=3s moves to the previous occurrence.
  const idB2 = seekRestart.identity;
  r.player.emit(statusEvent(idB2, 'h-oB', 'playing', 500));
  await pump();
  const moved = r.session.previous();
  await pump();
  assertEqual(
    readyOf(r).queue.currentOccurrenceId,
    'oA',
    '<=3s moves to previous',
  );
  if (r.ytm.pendingCount('candidates') > 0) {
    r.ytm.settleCandidates(
      ok([meta('youtube-music', 'ytm-a', 'Song rA', 'Artist', 300_000)]),
    );
    await pump();
  }
  r.player.emit(preparedEvent(lastPrepareIdentity(r), 'h-oA'));
  await pump();
  r.player.settlePrepare(ok('req-oA'));
  assert((await moved).ok);
  await pump();
  // Paused edits never start playback.
  assert((await r.session.pause()).ok);
  const playCalls = calls(r, 'play').length;
  const preps = calls(r, 'prepare').length;
  assert((await r.session.moveOccurrence('oB', 0)).ok);
  await pump();
  assertEqual(calls(r, 'play').length, playCalls, 'paused move no play');
  assertEqual(calls(r, 'prepare').length, preps, 'paused move no prepare');
}

async function unplayableFailure(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [
        recording('rA', [ref('itunes', 'a')]),
        recording('rB', [ref('itunes', 'b')]),
      ],
      queue: {
        revision: 2,
        occurrences: [occurrence('oA', 'rA'), occurrence('oB', 'rB')],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  await playThrough(r, 'oA');
  const idA = lastPrepareIdentity(r);
  r.player.emit(
    statusEvent(
      idA,
      'h-oA',
      'failed',
      0,
      appError('unavailable', 'not playable'),
    ),
  );
  await pump();
  const snap = readyOf(r);
  assertEqual(snap.queue.mode, 'paused', 'unplayable pauses item');
  assert(snap.queue.blockedError !== undefined, 'blocked error set');
  assertEqual(snap.playback.type, 'failed');
  // Retry clears the block and starts fresh.
  const retry = r.session.retryCurrent();
  await pump();
  // rA now has a youtube-music mapping: prepare goes directly.
  r.player.emit(preparedEvent(lastPrepareIdentity(r), 'h-oA2'));
  await pump();
  r.player.settlePrepare(ok('req-oA2'));
  assert((await retry).ok, 'retry failed');
  await pump();
  // Fail again, then skip to the successor.
  const idA2 = lastPrepareIdentity(r);
  r.player.emit(
    statusEvent(idA2, 'h-oA2', 'failed', 0, appError('unavailable', 'nope')),
  );
  await pump();
  const skipped = r.session.skipCurrent();
  await pump();
  assert((await skipped).ok, 'skip failed');
  assertEqual(
    readyOf(r).queue.currentOccurrenceId,
    'oB',
    'skip advances from blocked',
  );
  // A blocked item was paused: the successor stays paused, so the
  // skip itself starts no playback.
  assertEqual(readyOf(r).queue.mode, 'paused');
  assertEqual(readyOf(r).playback.type, 'idle');
  // An explicit resume starts the successor.
  const resumed = r.session.resume();
  await pump();
  if (r.ytm.pendingCount('candidates') > 0) {
    r.ytm.settleCandidatesAt(
      r.ytm.pendingCount('candidates') - 1,
      ok([meta('youtube-music', 'ytm-b', 'Song rB', 'Artist', 300_000)]),
    );
    await pump();
  }
  r.player.emit(preparedEvent(lastPrepareIdentity(r), 'h-oB'));
  await pump();
  r.player.settlePrepare(ok('req-oB'));
  assert((await resumed).ok, 'resume after skip failed');
  await pump();
  const playback = readyOf(r).playback;
  assert('identity' in playback, 'successor attempt begins on resume');
}

async function restartRestore(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y-signed')])],
      queue: {
        revision: 7,
        occurrences: [
          occurrence('o1', 'r1', ref('youtube-music', 'y-signed')),
        ],
        currentOccurrenceId: 'o1',
        positionMs: 2_000,
        mode: 'playing',
      },
    }),
  );
  await restoreOk(r);
  const playCalls = r.player.calls.filter(
    (c) => c.method !== 'setQueueProjection',
  );
  assertEqual(playCalls.length, 0, 'restore never starts player');
  assertEqual(readyOf(r).playback.type, 'idle');
  // No committed batch may contain a URL.
  for (const { batch } of r.storage.commits) {
    assert(
      !JSON.stringify(batch).includes('http'),
      'no URLs persisted on restore',
    );
  }
  const resumed = r.session.resume();
  await pump();
  // Fresh attempt prepares through the provider ref — never a saved URL.
  const prep = calls(r, 'prepare')[0]?.input as {
    provider: string;
    sourceRef: string;
  };
  assertEqual(prep.provider, 'youtube-music');
  assertEqual(prep.sourceRef, 'y-signed');
  r.player.emit(preparedEvent(lastPrepareIdentity(r), 'h-fresh'));
  await pump();
  assert(
    r.player.settlePrepare(ok('req-fresh')),
    'prepare still pending',
  );
  assert((await resumed).ok);
  await pump();
  assertEqual(calls(r, 'play').length, 1, 'first resume prepares fresh');
}

async function likesFlow(): Promise<void> {
  const r = rig(
    persisted({ recordings: [recording('r1', [ref('itunes', 'i1')])] }),
  );
  await restoreOk(r);
  assert((await r.session.toggleLike('r1')).ok);
  assertEqual(readyOf(r).likes.length, 1, 'like added');
  const likeCommits = r.storage.commits.filter((c) => c.batch.likes !== undefined);
  assert(likeCommits.length >= 1, 'likes committed');
  // Commit failure preserves the old like set and publishes the error.
  r.storage.failNext(appError('internal', 'disk full'));
  const res = await r.session.toggleLike('r1');
  assert(!res.ok, 'commit failure surfaces');
  const snap = readyOf(r);
  assertEqual(snap.likes.length, 1, 'old likes preserved');
  assert(snap.persistenceError !== undefined, 'persistenceError published');
  assert(
    !r.storage.commits.some(
      (c) => c.batch.likes !== undefined && c.batch.likes.length === 0,
    ),
    'failed commit not applied',
  );
  const unknown = await r.session.toggleLike('nope');
  assert(!unknown.ok && unknown.error.kind === 'not-found');
}

async function settingsFlow(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
      queue: {
        revision: 1,
        occurrences: [
          occurrence('o1', 'r1', ref('youtube-music', 'y1')),
        ],
        currentOccurrenceId: 'o1',
        positionMs: 0,
        mode: 'paused',
      },
    }),
  );
  await restoreOk(r);
  const updated = await r.session.updateSettings({
    ...SETTINGS,
    qualityKbps: 128,
  });
  assert(updated.ok, 'settings update failed');
  assertEqual(readyOf(r).settings.qualityKbps, 128);
  // Invalid settings rejected before commit.
  const commitsBefore = r.storage.commits.length;
  const bad = await r.session.updateSettings({
    ...SETTINGS,
    playbackProvider: 'not-injected',
  });
  assert(!bad.ok && bad.error.kind === 'invalid-response');
  const badShape = await r.session.updateSettings({
    ...SETTINGS,
    qualityKbps: 0,
  });
  assert(!badShape.ok && badShape.error.kind === 'invalid-response');
  assertEqual(
    r.storage.commits.length,
    commitsBefore,
    'invalid settings never commit',
  );
  assertEqual(readyOf(r).settings.playbackProvider, 'youtube-music');
  // Provider change while paused never starts playback.
  const spotify = new FakeProvider('spotify');
  const r2 = rig(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
      queue: {
        revision: 1,
        occurrences: [
          occurrence('o1', 'r1', ref('youtube-music', 'y1')),
        ],
        currentOccurrenceId: 'o1',
        positionMs: 0,
        mode: 'paused',
      },
    }),
    [spotify],
  );
  await restoreOk(r2);
  const switched = await r2.session.updateSettings({
    ...SETTINGS,
    playbackProvider: 'spotify',
  });
  assert(switched.ok);
  await pump();
  const r2PlayCalls = r2.player.calls.filter(
    (c) => c.method !== 'setQueueProjection',
  );
  assertEqual(
    r2PlayCalls.length,
    0,
    'paused provider switch starts nothing',
  );
  assertEqual(spotify.calls.length, 0, 'no provider calls while paused');
}

async function disposeFlow(): Promise<void> {
  const r = rig(persisted());
  await restoreOk(r);
  const playing = r.session.addAndPlay(
    meta('itunes', 'it-1', 'Song X', 'Artist', 300_000),
  );
  await pump();
  assertEqual(r.ytm.pendingCount('candidates'), 1);
  const before = r.states.length;
  await r.session.dispose();
  await pump();
  assert(
    r.ytm.cancelledSignals.length >= 1,
    'dispose cancels provider work',
  );
  const identity = r.states
    .map((s) => (s.type === 'ready' ? s.playback : null))
    .filter((p): p is NonNullable<typeof p> => p !== null && 'identity' in p)
    .map((p) => ('identity' in p ? p.identity : undefined))
    .at(-1);
  // Late events have no effect after unsubscribe.
  if (identity !== undefined) {
    r.player.emit(preparedEvent(identity, 'h-late'));
    r.player.emit(statusEvent(identity, 'h-late', 'playing', 100));
  }
  await r.session.drain();
  await pump();
  assertEqual(r.states.length, before, 'no publishes after dispose');
  assertEqual(calls(r, 'play').length, 0, 'late prepared never plays');
  void playing;
}

async function portThrows(): Promise<void> {
  // storage.load throws: mapped to internal without raw message.
  const throwingStorage: StoragePort = {
    load: () => Promise.reject(new Error('raw-secret-message')),
    commit: (_batch: StorageBatch, _ctx: OperationContext) =>
      Promise.resolve(ok(undefined)),
    loadAttempts: (_limit: number, _ctx: OperationContext) =>
      Promise.resolve(ok([])),
    exportOwned: (_atMs: number, _ctx: OperationContext) =>
      Promise.reject(new Error('raw-secret-message')),
    importOwned: (_doc: never, _ctx: OperationContext) =>
      Promise.resolve(ok(undefined)),
  };
  const player = new FakePlayer();
  const session = new Session({
    storage: throwingStorage,
    player,
    providers: [new FakeProvider('itunes'), new FakeProvider('youtube-music')],
    clock: new FakeClock(0),
    ids: new SequenceIds(),
    log: new FakeLog(),
    defaults: SETTINGS,
  });
  const res = await session.restore();
  assert(!res.ok && res.error.kind === 'internal', 'throw maps internal');
  assert(
    !res.error.message.includes('raw-secret-message'),
    'raw message must not leak',
  );

  // Throwing candidates maps internal.
  const throwingProvider: FakeProvider = new FakeProvider('youtube-music');
  const r = rig(persisted());
  const badProvider: ProviderPort = {
    id: 'youtube-music',
    search: () => Promise.resolve(ok({ items: [], storefront: null })),
    candidates: () => Promise.reject(new Error('secret-boom')),
    resolvePlayback: () =>
      Promise.resolve(
        err(appError('internal', 'unused')),
      ) as Promise<Result<never>> as never,
    getDetails: () => Promise.resolve(ok([])),
  };
  const r2 = new Session({
    storage: new FakeStorage(persisted()),
    player: new FakePlayer(),
    providers: [new FakeProvider('itunes'), badProvider],
    clock: new FakeClock(0),
    ids: new SequenceIds(),
    log: new FakeLog(),
    defaults: SETTINGS,
  });
  assert((await r2.restore()).ok);
  const playing = r2.addAndPlay(
    meta('itunes', 'it-1', 'Song', 'Artist', 300_000),
  );
  await pump();
  const res2 = await playing;
  assert(!res2.ok && res2.error.kind === 'internal', 'provider throw internal');
  assert(!res2.error.message.includes('secret-boom'), 'no raw leak');
  void throwingProvider;
}

function xorshift(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

async function rapidSequenceProperty(): Promise<void> {
  for (let seed = 1; seed <= 100; seed += 1) {
    const rand = xorshift(seed);
    const r = rig(
      persisted({
        recordings: [
          recording('r1', [ref('youtube-music', 'y1')]),
          recording('r2', [ref('youtube-music', 'y2')]),
          recording('r3', [ref('youtube-music', 'y3')]),
        ],
        queue: {
          revision: 3,
          occurrences: [
            occurrence('o1', 'r1', ref('youtube-music', 'y1')),
            occurrence('o2', 'r2', ref('youtube-music', 'y2')),
            occurrence('o3', 'r3', ref('youtube-music', 'y3')),
          ],
          currentOccurrenceId: null,
          positionMs: 0,
          mode: 'stopped',
        },
      }),
    );
    await restoreOk(r);
    const seenIdentityKeys: string[] = [];
    let regression = false;
    r.session.subscribe((s) => {
      if (s.type !== 'ready') {
        return;
      }
      const p = s.playback;
      if ('identity' in p && p.identity !== undefined) {
        const key = `${p.identity.attemptId}@${p.identity.queueRev}`;
        const prevIndex = seenIdentityKeys.indexOf(key);
        if (
          prevIndex >= 0 &&
          prevIndex < seenIdentityKeys.length - 1
        ) {
          regression = true;
        }
        if (prevIndex < 0) {
          seenIdentityKeys.push(key);
        }
      }
    });
    const ops = ['o1', 'o2', 'o3'];
    for (let step = 0; step < 15; step += 1) {
      const op = rand() % 8;
      const occ = ops[rand() % ops.length] ?? 'o1';
      if (op === 0) {
        void r.session.playOccurrence(occ);
      } else if (op === 1) {
        void r.session.next();
      } else if (op === 2) {
        void r.session.previous();
      } else if (op === 3) {
        void r.session.pause();
      } else if (op === 4) {
        void r.session.resume();
      } else if (op === 5) {
        // Stale/fabricated events around intent changes.
        const stale: PlaybackIdentity = {
          attemptId: `stale-${step}`,
          queueRev: 0,
        };
        r.player.emit(statusEvent(stale, 'h-stale', 'playing', 100));
        const known = seenIdentityKeys[rand() % Math.max(1, seenIdentityKeys.length)];
        if (known !== undefined) {
          const [attemptId, revStr] = known.split('@');
          const knownId: PlaybackIdentity = {
            attemptId: attemptId ?? 'x',
            queueRev: Number(revStr ?? 0),
          };
          r.player.emit(preparedEvent(knownId, `h-k${step}`));
          r.player.emit(statusEvent(knownId, `h-k${step}`, 'ended', 10));
        }
      } else if (op === 6) {
        if (r.player.pendingPrepares > 0) {
          r.player.settlePrepare(ok(`req-s${step}`));
        }
      } else {
        void r.session.seekTo(rand() % 10_000);
      }
      await pump(6);
      // Resolve any pending prepare so later intents proceed.
      if (r.player.pendingPrepares > 0 && rand() % 2 === 0) {
        r.player.settlePrepare(ok(`req-t${step}`));
      }
    }
    // Dispose cancels all operation/timer sources so owned work
    // settles deterministically — no orphan background promises.
    await r.session.dispose();
    await pump();
    assert(!regression, `seed ${seed}: playback regressed to stale identity`);
    // Every play call uses an identity that was published while active.
    for (const c of calls(r, 'play')) {
      const id = (c.input as { identity: PlaybackIdentity }).identity;
      const key = `${id.attemptId}@${id.queueRev}`;
      assert(
        seenIdentityKeys.includes(key),
        `seed ${seed}: play used unpublished identity ${key}`,
      );
    }
    // Snapshot stays coherent.
    const snap = r.session.snapshot();
    if (snap.type === 'ready') {
      const q = snap.queue;
      if (q.currentOccurrenceId === null) {
        assertEqual(q.mode, 'stopped', `seed ${seed}: legal end state`);
      } else {
        assert(
          q.mode === 'paused' || q.mode === 'playing',
          `seed ${seed}: current requires non-stopped mode`,
        );
      }
      if (q.blockedError !== undefined) {
        assertEqual(q.mode, 'paused', `seed ${seed}: blocked must pause`);
      }
    }
  }
}


// ---- wave 3b+ projection & correctness-review tests --------------------

function transitionEvent(
  r: Rig,
  fields: {
    from: string | null;
    to: string | null;
    reason: 'ended' | 'remote-next' | 'remote-previous';
    positionMs: number;
    identity: PlaybackIdentity | null;
    handle: string | null;
    projectionId?: string;
    projectedQueueRev?: number;
  },
): PlayerEvent {
  const p = r.player.projections.at(-1);
  assert(p !== undefined, 'no projection sent');
  return {
    type: 'queue-transition',
    projectionId: fields.projectionId ?? p.projectionId,
    projectedQueueRev: fields.projectedQueueRev ?? p.queueRev,
    fromOccurrenceId: fields.from,
    toOccurrenceId: fields.to,
    reason: fields.reason,
    positionMs: fields.positionMs,
    identity: fields.identity,
    handle: fields.handle,
  };
}

async function projectionBasics(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [
        {
          ...recording('rA', [ref('youtube-music', 'yA')]),
          artwork: [
            { url: 'https://art.example/a.png', width: 2, height: 2 },
          ],
        },
        recording('rB', [ref('itunes', 'iB')]),
      ],
      queue: {
        revision: 2,
        occurrences: [
          occurrence('oA', 'rA', ref('youtube-music', 'yA')),
          occurrence('oB', 'rB', ref('itunes', 'iB')),
        ],
        currentOccurrenceId: 'oA',
        positionMs: 500,
        mode: 'paused',
      },
    }),
  );
  await restoreOk(r);
  await pump();
  const first = r.player.projections.at(-1);
  assert(first !== undefined, 'restore projects');
  assertEqual(first.items.length, 2, 'ordered items');
  const itemA = first.items[0];
  const itemB = first.items[1];
  assertEqual(itemA?.occurrenceId, 'oA');
  assertEqual(itemA?.provider, 'youtube-music');
  assertEqual(itemA?.sourceRef, 'yA');
  assertEqual(itemA?.title, 'Song rA');
  assertEqual(itemA?.artworkUrl, 'https://art.example/a.png', 'first https art');
  assertEqual(itemB?.provider, null, 'wrong-provider ref is null');
  assertEqual(itemB?.sourceRef, null);
  assertEqual(itemB?.artworkUrl, null);
  assertEqual(first.currentOccurrenceId, 'oA');
  assertEqual(first.positionMs, 500);
  assertEqual(first.mode, 'paused');
  // Lock-screen metadata never carries a signed stream URL.
  const serialized = JSON.stringify(first);
  assert(!serialized.includes('sig='), 'no signed URL in projection');
  assert(!serialized.includes('googlevideo'), 'no stream host in projection');

  // A queue mutation sends a new identified projection.
  assert((await r.session.moveOccurrence('oB', 0)).ok);
  await pump();
  const second = r.player.projections.at(-1);
  assert(second !== undefined);
  assert(second.projectionId !== first.projectionId, 'fresh projection id');
  assert(second.queueRev > first.queueRev, 'fresh revision');
  assertEqual(second.items[0]?.occurrenceId, 'oB', 'mutation projected');

  // A stale projection call resolving late cannot overwrite the
  // newer marker: defer projections, mutate again, settle the OLD
  // call with an error — no persistenceError should stick.
  r.player.deferProjections();
  assert((await r.session.moveOccurrence('oB', 1)).ok);
  await pump();
  const third = r.player.projections.at(-1);
  assert(third !== undefined && third.projectionId !== second.projectionId);
  assert((await r.session.moveOccurrence('oB', 0)).ok);
  await pump();
  const fourth = r.player.projections.at(-1);
  assert(fourth !== undefined && fourth.projectionId !== third.projectionId);
  // The older deferred call resolves late with a failure.
  assert(r.player.settleProjection(err(appError('internal', 'stale'))));
  await pump();
  assertEqual(
    readyOf(r).queue.occurrences[0]?.occurrenceId,
    'oB',
    'queue unaffected by stale projection failure',
  );
  while (r.player.pendingProjections > 0) {
    r.player.settleProjection(ok(undefined));
  }
}

async function backgroundTransitionChain(): Promise<void> {
  const r = rig(persisted({
    recordings: ['A', 'B', 'C'].map((id) => recording(`r${id}`, [ref('youtube-music', `y${id}`)])),
    queue: {
      revision: 2,
      occurrences: ['A', 'B', 'C'].map((id) => occurrence(`o${id}`, `r${id}`, ref('youtube-music', `y${id}`))),
      currentOccurrenceId: 'oA', positionMs: 0, mode: 'paused',
    },
  }));
  await restoreOk(r);
  await pump();
  const projection = r.player.projections.at(-1);
  assert(projection !== undefined);
  const identity = (id: string): PlaybackIdentity => ({ attemptId: `svc-${id}`, queueRev: projection.queueRev });
  const move = (from: string, to: string) => transitionEvent(r, {
    from, to, reason: 'ended', positionMs: 0,
    identity: identity(to), handle: `h-${to}`,
    projectionId: projection.projectionId, projectedQueueRev: projection.queueRev,
  });
  const first = move('oA', 'oB');
  // Native already reached C before JS can consume either event.
  r.player.emit(first);
  r.player.emit(statusEvent(identity('oB'), 'h-oB', 'ended', 100));
  r.player.emit(move('oB', 'oC'));
  await pump();
  assertEqual(readyOf(r).queue.currentOccurrenceId, 'oC', 'queued native moves reconcile through the immutable projection');
  assertEqual(r.player.projections.at(-1)?.projectionId, projection.projectionId, 'reconciliation does not supersede the service cursor');
  r.player.emit(statusEvent(identity('oC'), 'h-oC', 'playing', 321));
  r.player.emit(first);
  await pump();
  assertEqual(readyOf(r).queue.currentOccurrenceId, 'oC', 'old move cannot resurrect B');
  assertEqual(readyOf(r).queue.positionMs, 321, 'native identity remains valid after reconciliation');
  await r.session.pause();
  await pump();
  r.player.emit(move('oC', 'oB'));
  await pump();
  assertEqual(readyOf(r).queue.currentOccurrenceId, 'oC', 'new app intent rejects the old projection');
}

async function transitionReconcile(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [
        recording('rA', [ref('youtube-music', 'yA')]),
        recording('rB', [ref('youtube-music', 'yB')]),
      ],
      queue: {
        revision: 2,
        occurrences: [
          occurrence('oA', 'rA', ref('youtube-music', 'yA')),
          occurrence('oB', 'rB', ref('youtube-music', 'yB')),
        ],
        currentOccurrenceId: 'oA',
        positionMs: 0,
        mode: 'paused',
      },
    }),
  );
  await restoreOk(r);
  await pump();
  const preps = calls(r, 'prepare').length;
  const svc = (): PlaybackIdentity => ({
    attemptId: 'svc-1',
    queueRev: r.player.projections.at(-1)?.queueRev ?? 0,
  });
  const currentIs = (id: string, why: string) =>
    assertEqual(readyOf(r).queue.currentOccurrenceId, id, why);
  // A wrong-revision event is ignored entirely.
  r.player.emit(
    transitionEvent(r, {
      from: 'oA',
      to: 'oB',
      reason: 'ended',
      positionMs: 0,
      identity: svc(),
      handle: 'h-svc',
      projectedQueueRev: 9999,
    }),
  );
  await pump();
  currentIs('oA', 'stale revision ignored');
  // Strict legality: arbitrary jumps, wrong from, malformed pairs.
  const illegal: readonly PlayerEvent[] = [
    // from does not match the projected cursor.
    transitionEvent(r, {
      from: 'oB',
      to: 'oB',
      reason: 'remote-previous',
      positionMs: 0,
      identity: svc(),
      handle: 'h-svc',
    }),
    // remote-previous may not jump forward to the successor.
    transitionEvent(r, {
      from: 'oA',
      to: 'oB',
      reason: 'remote-previous',
      positionMs: 0,
      identity: svc(),
      handle: 'h-svc',
    }),
    // ended to null while a successor exists.
    transitionEvent(r, {
      from: 'oA',
      to: null,
      reason: 'ended',
      positionMs: 0,
      identity: null,
      handle: null,
    }),
    // nonnull target requires both identity and handle.
    transitionEvent(r, {
      from: 'oA',
      to: 'oB',
      reason: 'ended',
      positionMs: 0,
      identity: svc(),
      handle: null,
    }),
    // empty attemptId.
    transitionEvent(r, {
      from: 'oA',
      to: 'oB',
      reason: 'ended',
      positionMs: 0,
      identity: { attemptId: '', queueRev: 0 },
      handle: 'h-svc',
    }),
    // unsafe identity revision.
    transitionEvent(r, {
      from: 'oA',
      to: 'oB',
      reason: 'ended',
      positionMs: 0,
      identity: { attemptId: 'svc-1', queueRev: 1.5 },
      handle: 'h-svc',
    }),
    // unsafe position.
    transitionEvent(r, {
      from: 'oA',
      to: 'oB',
      reason: 'ended',
      positionMs: Number.NaN,
      identity: svc(),
      handle: 'h-svc',
    }),
    // null target requires null identity/handle.
    transitionEvent(r, {
      from: 'oA',
      to: null,
      reason: 'ended',
      positionMs: 0,
      identity: svc(),
      handle: 'h-svc',
      // 'oA' has a successor so null is already illegal; the pairing
      // check must also fire for tail-null cases — covered below.
    }),
  ];
  for (const event of illegal) {
    r.player.emit(event);
    await pump();
    currentIs('oA', 'illegal transition rejected');
  }
  // A valid transition reconciles without a second app prepare.
  r.player.emit(
    transitionEvent(r, {
      from: 'oA',
      to: 'oB',
      reason: 'ended',
      positionMs: 0,
      identity: svc(),
      handle: 'h-svc',
    }),
  );
  await pump();
  const snap = readyOf(r);
  assertEqual(snap.queue.currentOccurrenceId, 'oB', 'cursor adopted');
  assertEqual(snap.queue.mode, 'playing');
  assertEqual(calls(r, 'prepare').length, preps, 'no second prepare');
  const playback = snap.playback;
  assert(playback.type === 'buffering', 'adopted attempt buffers');
  if (playback.type === 'buffering') {
    assertEqual(playback.handle, 'h-svc');
    assertEqual(playback.identity.attemptId, 'svc-1');
  }
  const projectionsAfter = r.player.projections.length;
  // Duplicate event: the projection already moved on -> no-op.
  r.player.emit(
    transitionEvent(r, {
      from: 'oA',
      to: 'oB',
      reason: 'ended',
      positionMs: 0,
      identity: svc(),
      handle: 'h-svc',
      projectionId: 'projection-stale',
    }),
  );
  await pump();
  assertEqual(
    r.player.projections.length,
    projectionsAfter,
    'duplicate transition is a no-op',
  );
  // Observed position, then remote-previous same target resets to 0.
  const adopted = readyOf(r).playback;
  const adoptedIdentity =
    'identity' in adopted && adopted.identity !== undefined
      ? adopted.identity
      : undefined;
  assert(adoptedIdentity !== undefined);
  r.player.emit(statusEvent(adoptedIdentity, 'h-svc', 'playing', 5_000));
  await pump();
  assertEqual(readyOf(r).queue.positionMs, 5_000);
  // The adopted identity must track the post-reconcile revision — the
  // service re-keys its status echo to every installed projection, so
  // a stale queueRev here would reject every later status.
  assertEqual(
    adoptedIdentity.queueRev,
    r.player.projections.at(-1)?.queueRev,
    'adopted identity tracks installed revision',
  );
  const revBefore = readyOf(r).queue.revision;
  r.player.emit(
    transitionEvent(r, {
      from: 'oB',
      to: 'oB',
      reason: 'remote-previous',
      positionMs: 0,
      identity: svc(),
      handle: 'h-svc',
    }),
  );
  await pump();
  const snapRestart = readyOf(r);
  assertEqual(snapRestart.queue.currentOccurrenceId, 'oB');
  assertEqual(snapRestart.queue.positionMs, 0, 'same-item restart resets');
  assert(
    snapRestart.queue.revision > revBefore,
    'restart ticks revision once',
  );
  assertEqual(calls(r, 'prepare').length, preps, 'restart reuses handle');
  // remote-previous to the immediate predecessor is legal.
  r.player.emit(
    transitionEvent(r, {
      from: 'oB',
      to: 'oA',
      reason: 'remote-previous',
      positionMs: 0,
      identity: svc(),
      handle: 'h-svc',
    }),
  );
  await pump();
  currentIs('oA', 'predecessor previous adopted');
  // Null target on the tail stops — after stepping back next.
  r.player.emit(
    transitionEvent(r, {
      from: 'oA',
      to: 'oB',
      reason: 'remote-next',
      positionMs: 0,
      identity: svc(),
      handle: 'h-svc',
    }),
  );
  await pump();
  currentIs('oB', 'remote-next adopted');
  r.player.emit(
    transitionEvent(r, {
      from: 'oB',
      to: null,
      reason: 'ended',
      positionMs: 0,
      identity: null,
      handle: null,
    }),
  );
  await pump();
  const snapEnd = readyOf(r);
  assertEqual(snapEnd.queue.mode, 'stopped', 'null target stops');
  assertEqual(snapEnd.playback.type, 'idle');
}

async function remotePausePlay(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
      queue: {
        revision: 1,
        occurrences: [occurrence('o1', 'r1', ref('youtube-music', 'y1'))],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  await playThrough(r, 'o1');
  const snap0 = readyOf(r);
  const id0 = 'identity' in snap0.playback ? snap0.playback.identity : undefined;
  assert(id0 !== undefined);
  const projections0 = r.player.projections.length;
  // Remote pause: status reports paused while intent is playing.
  r.player.emit(statusEvent(id0, 'h-o1', 'paused', 1_000));
  await pump();
  const snapP = readyOf(r);
  assertEqual(snapP.queue.mode, 'paused', 'remote pause reconciles');
  assertEqual(snapP.queue.revision, snap0.queue.revision + 1);
  assert(
    r.player.projections.length > projections0,
    'remote pause re-projects',
  );
  const idP = 'identity' in snapP.playback ? snapP.playback.identity : undefined;
  assert(idP !== undefined && idP.queueRev === snapP.queue.revision);
  // Remote play: status reports playing while intent is paused.
  r.player.emit(statusEvent(idP, 'h-o1', 'playing', 2_000));
  await pump();
  const snapR = readyOf(r);
  assertEqual(snapR.queue.mode, 'playing', 'remote play reconciles');
  assertEqual(snapR.queue.revision, snapP.queue.revision + 1);
  assertEqual(snapR.queue.positionMs, 2_000);
}

async function statusJoinAcrossQueueEdits(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
      queue: {
        revision: 1,
        occurrences: [occurrence('o1', 'r1', ref('youtube-music', 'y1'))],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  await playThrough(r, 'o1');
  const idA = lastPrepareIdentity(r);
  // A queue edit ticks the revision without re-keying the active
  // identity; native re-keys attached.queueRev on the next install, so
  // status echoes carry the newer revision.
  const enq = await r.session.enqueueMetadata(
    meta('itunes', 'it-2', 'Two', 'B', 300_000),
  );
  assert(enq.ok, 'enqueue failed');
  await pump();
  const newerRev = readyOf(r).queue.revision;
  assert(newerRev > idA.queueRev, 'edit ticked the revision');
  const echoed = { attemptId: idA.attemptId, queueRev: newerRev };
  r.player.emit(statusEvent(echoed, 'h-o1', 'playing', 5_000));
  await pump();
  assertEqual(
    readyOf(r).queue.positionMs,
    5_000,
    'status joins after a queue edit',
  );
  r.player.emit(statusEvent(echoed, 'h-o1', 'paused', 5_000));
  await pump();
  assertEqual(readyOf(r).queue.mode, 'paused', 'remote pause reconciles');
}

async function successorMapping(): Promise<void> {
  const twoItem = () =>
    persisted({
      recordings: [
        recording('rA', [ref('itunes', 'a')]),
        recording('rB', [ref('itunes', 'b')]),
      ],
      queue: {
        revision: 2,
        occurrences: [occurrence('oA', 'rA'), occurrence('oB', 'rB')],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    });
  // Matched: successor ref filled once, projected, never re-mapped.
  {
    const r = rig(twoItem());
    await restoreOk(r);
    await playThrough(r, 'oA');
    await pump();
    assertEqual(
      r.ytm.calls.filter((c) => c.method === 'candidates').length,
      2,
      'attempt + successor candidates',
    );
    r.ytm.settleCandidatesAt(
      r.ytm.pendingCount('candidates') - 1,
      ok([meta('youtube-music', 'ytm-b', 'Song rB', 'Artist', 300_000)]),
    );
    await pump();
    const snap = readyOf(r);
    assertEqual(
      snap.queue.occurrences[1]?.selectedRef?.id,
      'ytm-b',
      'successor ref filled',
    );
    const rec = snap.recordings.find((x) => x.id === 'rB');
    assert(
      rec?.mappings.some(
        (m) => m.status === 'automatic' && m.ref.id === 'ytm-b',
      ) === true,
      'automatic mapping appended',
    );
    const latest = r.player.projections.at(-1);
    assertEqual(
      latest?.items[1]?.sourceRef,
      'ytm-b',
      'projection carries filled ref',
    );
    const candidatesAfter = r.ytm.calls.filter(
      (c) => c.method === 'candidates',
    ).length;
    // A no-op status tick re-derives but does not re-map.
    const idA = 'identity' in snap.playback ? snap.playback.identity : undefined;
    assert(idA !== undefined);
    r.player.emit(statusEvent(idA, 'h-oA', 'playing', 100));
    await pump();
    assertEqual(
      r.ytm.calls.filter((c) => c.method === 'candidates').length,
      candidatesAfter,
      'successor mapped once',
    );
  }
  // Rapid current change cancels the old mapping task.
  {
    const r = rig(twoItem());
    await restoreOk(r);
    await playThrough(r, 'oA');
    await pump();
    const next = r.session.next();
    await pump();
    assert(
      r.ytm.cancelledSignals.length >= 1,
      'mapping task cancelled on current change',
    );
    // Late settlement of the cancelled task applies nothing.
    r.ytm.settleCandidatesAt(
      0,
      ok([meta('youtube-music', 'ytm-late', 'Song rB', 'Artist', 300_000)]),
    );
    await pump();
    // The new current (oB) attempt is pending its own candidates.
    if (r.ytm.pendingCount('candidates') > 0) {
      r.ytm.settleCandidatesAt(
        r.ytm.pendingCount('candidates') - 1,
        ok([meta('youtube-music', 'ytm-b', 'Song rB', 'Artist', 300_000)]),
      );
      await pump();
    }
    r.player.emit(preparedEvent(lastPrepareIdentity(r), 'h-oB'));
    await pump();
    r.player.settlePrepare(ok('req-oB'));
    assert((await next).ok);
  }
  // Ambiguous match leaves the ref null — native pauses honestly.
  {
    const r = rig(twoItem());
    await restoreOk(r);
    await playThrough(r, 'oA');
    await pump();
    r.ytm.settleCandidatesAt(
      r.ytm.pendingCount('candidates') - 1,
      ok([
        meta('youtube-music', 'y1', 'Song rB', 'Artist', 300_000),
        meta('youtube-music', 'y2', 'Song rB', 'Artist', 300_000),
      ]),
    );
    await pump();
    assertEqual(
      readyOf(r).queue.occurrences[1]?.selectedRef,
      null,
      'ambiguous stays null',
    );
  }
  // A newer rejected mapping for the same ref wins precedence: the
  // automatic result is neither selected nor appended.
  {
    const r = rig(
      persisted({
        recordings: [
          recording('rA', [ref('itunes', 'a')]),
          {
            ...recording('rB', [ref('itunes', 'b')]),
            mappings: [
              {
                ref: ref('youtube-music', 'ytm-b'),
                status: 'rejected',
                matchedAtMs: 1_000_000,
                evidence: {
                  titleSimilarity: 1,
                  artistSimilarity: 1,
                  durationDeltaMs: 0,
                  exactIsrc: false,
                  score: 100,
                  versionLabels: [],
                },
              },
            ],
          },
        ],
        queue: {
          revision: 2,
          occurrences: [occurrence('oA', 'rA'), occurrence('oB', 'rB')],
          currentOccurrenceId: null,
          positionMs: 0,
          mode: 'stopped',
        },
      }),
    );
    await restoreOk(r);
    await playThrough(r, 'oA');
    await pump();
    r.ytm.settleCandidatesAt(
      r.ytm.pendingCount('candidates') - 1,
      ok([meta('youtube-music', 'ytm-b', 'Song rB', 'Artist', 300_000)]),
    );
    await pump();
    const snap = readyOf(r);
    assertEqual(
      snap.queue.occurrences[1]?.selectedRef,
      null,
      'rejected winner is never selected',
    );
    const rec = snap.recordings.find((x) => x.id === 'rB');
    assertEqual(
      rec?.mappings.filter(
        (m) => m.ref.id === 'ytm-b' && m.status === 'automatic',
      ).length,
      0,
      'rejected mapping is not shadowed by an automatic one',
    );
  }
  // A reorder mid-flight discards the stale result: the occurrence is
  // no longer the immediate successor.
  {
    const r = rig(twoItem());
    await restoreOk(r);
    await playThrough(r, 'oA');
    await pump();
    assert(r.ytm.pendingCount('candidates') >= 1, 'mapping in flight');
    assert((await r.session.moveOccurrence('oB', 0)).ok);
    await pump();
    r.ytm.settleCandidatesAt(
      0,
      ok([meta('youtube-music', 'ytm-late', 'Song rB', 'Artist', 300_000)]),
    );
    await pump();
    assertEqual(
      readyOf(r)
        .queue.occurrences.find((o) => o.occurrenceId === 'oB')
        ?.selectedRef,
      null,
      'reordered successor is never filled',
    );
    const rec = readyOf(r).recordings.find((x) => x.id === 'rB');
    assertEqual(
      rec?.mappings.length ?? 0,
      0,
      'stale mapping task applies nothing',
    );
  }
}

async function duplicatePrepareSafety(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
      queue: {
        revision: 1,
        occurrences: [occurrence('o1', 'r1', ref('youtube-music', 'y1'))],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  await playThrough(r, 'o1');
  const snap = readyOf(r);
  const id0 = 'identity' in snap.playback ? snap.playback.identity : undefined;
  assert(id0 !== undefined);
  const released = () =>
    calls(r, 'release').map((c) => (c.input as { handle: string }).handle);
  const before = released().length;
  // Duplicate prepared carrying the adopted handle is ignored.
  r.player.emit(preparedEvent(id0, 'h-o1'));
  await pump();
  assertEqual(released().length, before, 'same-handle duplicate ignored');
  // A different duplicate handle is released.
  r.player.emit(preparedEvent(id0, 'h-other'));
  await pump();
  assert(released().includes('h-other'), 'different duplicate released');
  assert(!released().includes('h-o1'), 'live handle untouched');
  // A stale-identity prepared whose handle equals the live handle is
  // not released — the current attempt keeps its stream.
  const staleIdentity: PlaybackIdentity = {
    attemptId: 'attempt-stale',
    queueRev: 0,
  };
  r.player.emit(preparedEvent(staleIdentity, 'h-o1'));
  await pump();
  assert(
    !released().includes('h-o1'),
    'stale event cannot release the live handle',
  );
  // A stale prepared with its own distinct handle is released.
  r.player.emit(preparedEvent(staleIdentity, 'h-orphan'));
  await pump();
  assert(released().includes('h-orphan'), 'stale orphan handle released');
}

async function deadClockSkipsPort(): Promise<void> {
  const base = new FakeClock(1_000);
  let broken = false;
  const clock = {
    nowMs: () => {
      if (broken) {
        throw new Error('clock dead');
      }
      return base.nowMs();
    },
    sleep: (ms: number, signal: Parameters<FakeClock['sleep']>[1]) =>
      base.sleep(ms, signal),
  };
  const storage = new FakeStorage(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
      queue: {
        revision: 1,
        occurrences: [occurrence('o1', 'r1', ref('youtube-music', 'y1'))],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  const player = new FakePlayer();
  const session = new Session({
    storage,
    player,
    providers: [
      new FakeProvider('itunes'),
      new FakeProvider('youtube-music'),
    ],
    clock,
    ids: new SequenceIds(),
    log: new FakeLog(),
    defaults: SETTINGS,
  });
  assert((await session.restore()).ok);
  broken = true;
  const res = await session.playOccurrence('o1');
  assert(!res.ok, 'dead clock fails the attempt');
  assertEqual(res.error.kind, 'internal');
  assertEqual(
    player.calls.filter((c) => c.method === 'prepare').length,
    0,
    'invalid clock never starts the port call',
  );
}

async function prepareTimerInternal(): Promise<void> {
  const base = new FakeClock(1_000);
  let failSleep = false;
  const clock = {
    nowMs: () => base.nowMs(),
    sleep: (ms: number, signal: Parameters<FakeClock['sleep']>[1]) =>
      failSleep
        ? Promise.resolve(err(appError('internal', 'clock sleep dead')))
        : base.sleep(ms, signal),
  };
  const storage = new FakeStorage(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
      queue: {
        revision: 1,
        occurrences: [occurrence('o1', 'r1', ref('youtube-music', 'y1'))],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  const player = new FakePlayer();
  const session = new Session({
    storage,
    player,
    providers: [
      new FakeProvider('itunes'),
      new FakeProvider('youtube-music'),
    ],
    clock,
    ids: new SequenceIds(),
    log: new FakeLog(),
    defaults: SETTINGS,
  });
  assert((await session.restore()).ok);
  const playing = session.playOccurrence('o1');
  await pump();
  assert(player.pendingPrepares >= 1, 'prepare issued');
  failSleep = true;
  player.settlePrepare(ok('req-t'));
  await pump();
  // The armed prepare timeout saw an internal clock failure; the
  // attempt fails coherently instead of preparing forever.
  const snap = session.snapshot();
  assert(snap.type === 'ready');
  if (snap.type === 'ready') {
    assertEqual(snap.playback.type, 'failed', 'internal timer fails attempt');
    if (snap.playback.type === 'failed') {
      assertEqual(snap.playback.error.kind, 'internal');
    }
  }
  assert(
    player.calls.some((c) => c.method === 'cancelPrepare'),
    'armed prepare cancelled on timer failure',
  );
  void playing;
}

async function restoreTimeout(): Promise<void> {
  const r = rig(persisted());
  r.storage.holdNextLoad();
  const res = r.session.restore();
  r.clock.advance(15_000);
  await pump();
  const result = await res;
  assert(!result.ok, 'timeout surfaces');
  assertEqual(result.error.kind, 'timeout');
  assert(result.error.retryable, 'timeout is retryable');
  assertEqual(r.session.snapshot().type, 'restore-failed');
  assert(
    r.storage.loads[0]?.signal.cancelled === true,
    'load source cancelled on timeout',
  );
}

async function previousNoOp(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [recording('rA', [ref('youtube-music', 'yA')])],
      queue: {
        revision: 3,
        occurrences: [occurrence('oA', 'rA', ref('youtube-music', 'yA'))],
        currentOccurrenceId: 'oA',
        positionMs: 0,
        mode: 'paused',
      },
    }),
  );
  await restoreOk(r);
  await pump();
  const callsBefore = r.player.calls.length;
  const commitsBefore = r.storage.commits.length;
  const res = await r.session.previous();
  assert(res.ok, 'no-op previous resolves');
  assertEqual(readyOf(r).queue.revision, 3, 'no revision change');
  assertEqual(r.player.calls.length, callsBefore, 'no native calls');
  assertEqual(r.storage.commits.length, commitsBefore, 'no persist');
}

async function controlFailure(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
      queue: {
        revision: 1,
        occurrences: [occurrence('o1', 'r1', ref('youtube-music', 'y1'))],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  await playThrough(r, 'o1');
  r.player.setNextResult(err(appError('internal', 'native rejected')));
  const res = await r.session.pause();
  assert(!res.ok, 'port failure surfaces');
  const snap = readyOf(r);
  assertEqual(snap.playback.type, 'failed', 'coherent failed state');
  assertEqual(snap.queue.mode, 'paused', 'queue blocked paused');
  assert(snap.queue.blockedError !== undefined);
  const releases = calls(r, 'release');
  assert(releases.length >= 1, 'failed attempt releases handle');
}

async function earlyPrepareFailure(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
      queue: {
        revision: 1,
        occurrences: [occurrence('o1', 'r1', ref('youtube-music', 'y1'))],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  const playing = r.session.playOccurrence('o1');
  await pump();
  const identity = lastPrepareIdentity(r);
  // Prepare outcome fails BEFORE the prepare promise resolves.
  const failure: PlayerEvent = {
    type: 'prepare',
    requestId: 'req-early',
    identity,
    outcome: {
      type: 'failed',
      error: appError('streams-capped', 'provider capped'),
      attempt: TRACE,
    },
  };
  r.player.emit(failure);
  await pump();
  assertEqual(readyOf(r).playback.type, 'failed');
  r.player.settlePrepare(ok('req-early'));
  const res = await playing;
  assert(!res.ok, 'attempt resolves failed');
  assertEqual(
    res.error.kind,
    'streams-capped',
    'real error kind, not superseded',
  );
  // A late prepared event for the same identity is released, not played.
  r.player.emit(preparedEvent(identity, 'h-late'));
  await pump();
  const releases = calls(r, 'release').map(
    (c) => (c.input as { handle: string }).handle,
  );
  assert(releases.includes('h-late'), 'late prepared released');
  assertEqual(calls(r, 'play').length, 0, 'never played');
}

async function releaseRetry(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [
        recording('rA', [ref('youtube-music', 'yA')]),
        recording('rB', [ref('youtube-music', 'yB')]),
      ],
      queue: {
        revision: 2,
        occurrences: [
          occurrence('oA', 'rA', ref('youtube-music', 'yA')),
          occurrence('oB', 'rB', ref('youtube-music', 'yB')),
        ],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  await playThrough(r, 'oA');
  const idA = lastPrepareIdentity(r);
  // The first release fails; the handle must remain retryable.
  r.player.setNextResult(err(appError('transient', 'release failed')));
  const second = r.session.playOccurrence('oB');
  await pump();
  r.player.emit(preparedEvent(lastPrepareIdentity(r), 'h-oB'));
  await pump();
  r.player.settlePrepare(ok('req-oB'));
  assert((await second).ok);
  const releaseCallsA = () =>
    calls(r, 'release').filter(
      (c) => (c.input as { handle: string }).handle === 'h-oA',
    ).length;
  assertEqual(releaseCallsA(), 1, 'first release attempted');
  // A stale prepared event for A retries the release and succeeds.
  r.player.emit(preparedEvent(idA, 'h-oA'));
  await pump();
  assertEqual(releaseCallsA(), 2, 'failed release is retried');
}

async function statusBoundary(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
      queue: {
        revision: 1,
        occurrences: [occurrence('o1', 'r1', ref('youtube-music', 'y1'))],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  await playThrough(r, 'o1');
  const snap = readyOf(r);
  const id0 = 'identity' in snap.playback ? snap.playback.identity : undefined;
  assert(id0 !== undefined);
  // Wrong handle: ignored + fixed warning.
  r.player.emit(statusEvent(id0, 'h-other', 'playing', 9_999));
  await pump();
  assertEqual(readyOf(r).queue.positionMs, 0, 'wrong handle ignored');
  // Malformed position: ignored + fixed warning.
  r.player.emit({
    type: 'status',
    handle: 'h-o1',
    identity: id0,
    state: 'playing',
    positionMs: Number.NaN,
  });
  await pump();
  assert(
    r.log.entries.some((e) => e.message === 'player status rejected'),
    'fixed sanitized warning',
  );
  // Valid status still applies.
  r.player.emit(statusEvent(id0, 'h-o1', 'playing', 1_234));
  await pump();
  assertEqual(readyOf(r).queue.positionMs, 1_234);
}

async function staleFailCannotClobber(): Promise<void> {
  const r = rig(
    persisted({
      recordings: [
        recording('rA', [ref('itunes', 'a')]),
        recording('rB', [ref('itunes', 'b')]),
      ],
      queue: {
        revision: 2,
        occurrences: [occurrence('oA', 'rA'), occurrence('oB', 'rB')],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await restoreOk(r);
  const a = r.session.playOccurrence('oA');
  await pump();
  const b = r.session.playOccurrence('oB');
  await pump();
  // A's candidates resolve as an error late; A is stale.
  r.ytm.settleCandidatesAt(0, err(appError('transient', 'A failed')));
  await pump();
  // A stale status-failure for A must not clobber B's preparing state.
  const idA = r.states
    .map((s) => (s.type === 'ready' ? s.playback : null))
    .filter((p): p is NonNullable<typeof p> => p !== null && 'identity' in p)
    .map((p) => ('identity' in p ? p.identity : undefined))
    .at(-2);
  if (idA !== undefined) {
    r.player.emit(
      statusEvent(idA, 'h-a', 'failed', 0, appError('transient', 'late')),
    );
    await pump();
  }
  const playback = readyOf(r).playback;
  assertEqual(playback.type, 'preparing', 'stale failure cannot clobber');
  if (playback.type === 'preparing') {
    assertEqual(playback.occurrenceId, 'oB');
  }
  assertEqual(
    readyOf(r).queue.blockedError,
    undefined,
    'queue not blocked by stale failure',
  );
  void a;
  void b;
}

async function phaseLogFixed(): Promise<void> {
  const r = rig(persisted());
  await restoreOk(r);
  const identity: PlaybackIdentity = { attemptId: 'a', queueRev: 0 };
  r.player.emit({
    type: 'phase',
    handle: 'h-1',
    identity,
    name: 'SECRET-PHASE-NAME-12345',
    atMs: 5,
    sinceStartMs: 5,
  });
  await r.session.drain();
  await pump();
  assert(
    r.log.entries.some((e) => e.message === 'player phase observed'),
    'fixed phase diagnostic',
  );
  assert(
    !r.log.entries.some((e) => e.message.includes('SECRET-PHASE-NAME')),
    'raw phase name never logged',
  );
}

async function disposeCleanup(): Promise<void> {
  // Cancelled provider work: counters reach zero.
  {
    const r = rig(persisted());
    await restoreOk(r);
    void r.session.addAndPlay(
      meta('itunes', 'it-1', 'Song X', 'Artist', 300_000),
    );
    await pump();
    assert(r.ytm.pendingCount('candidates') >= 1);
    await r.session.dispose();
    await pump();
    assert(r.ytm.cancelledSignals.length >= 1, 'candidates cancelled');
    assertEqual(r.clock.pendingSleepers, 0, 'no orphan sleepers');
    assertEqual(calls(r, 'play').length, 0);
  }
  // Armed prepare timeout: cancelled on dispose, no orphan timers.
  {
    const r = rig(
      persisted({
        recordings: [recording('r1', [ref('youtube-music', 'y1')])],
        queue: {
          revision: 1,
          occurrences: [occurrence('o1', 'r1', ref('youtube-music', 'y1'))],
          currentOccurrenceId: null,
          positionMs: 0,
          mode: 'stopped',
        },
      }),
    );
    await restoreOk(r);
    const playing = r.session.playOccurrence('o1');
    await pump();
    // Prepare resolves but no prepared event: the timeout is armed.
    r.player.settlePrepare(ok('req-armed'));
    await pump();
    assert(r.clock.pendingSleepers >= 1, 'timeout armed');
    await r.session.dispose();
    await pump();
    assertEqual(r.clock.pendingSleepers, 0, 'armed timer cancelled');
    assertEqual(r.player.pendingPrepares, 0, 'no pending prepares');
    assert(
      calls(r, 'cancelPrepare').length >= 1,
      'armed prepare cancelled',
    );
    void playing;
  }
}

async function concurrentLikes(): Promise<void> {
  const r = rig(persisted({
    recordings: [
      recording('r1', [ref('itunes', 'i1')]),
      recording('r2', [ref('itunes', 'i2')]),
    ]
  }));
  await restoreOk(r);
  const results = await Promise.all([
    r.session.toggleLike('r1'), r.session.toggleLike('r2'),
  ]);
  assert(results.every((result) => result.ok));
  assertDeepEqual(readyOf(r).likes.map((like) => like.targetId), ['r1', 'r2']);
  await Promise.all([r.session.toggleLike('r1'), r.session.toggleLike('r1')]);
  assertDeepEqual(readyOf(r).likes.map((like) => like.targetId).sort(), ['r1', 'r2']);
  await r.session.dispose();
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['concurrentLikes', concurrentLikes],
  ['restorePlayingSnapshot', restorePlayingSnapshot],
  ['metadataToPrepare', metadataToPrepare],
  ['rapidPlayIntents', rapidPlayIntents],
  ['rapidProviderSwitches', rapidProviderSwitches],
  ['deadlineTimeout', deadlineTimeout],
  ['naturalEnded', naturalEnded],
  ['endedFallback', endedFallback],
  ['pauseResumeSeek', pauseResumeSeek],
  ['previousSemantics', previousSemantics],
  ['unplayableFailure', unplayableFailure],
  ['restartRestore', restartRestore],
  ['likesFlow', likesFlow],
  ['settingsFlow', settingsFlow],
  ['disposeFlow', disposeFlow],
  ['portThrows', portThrows],
  ['projectionBasics', projectionBasics],
  ['backgroundTransitionChain', backgroundTransitionChain],
  ['transitionReconcile', transitionReconcile],
  ['remotePausePlay', remotePausePlay],
  ['statusJoinAcrossQueueEdits', statusJoinAcrossQueueEdits],
  ['successorMapping', successorMapping],
  ['duplicatePrepareSafety', duplicatePrepareSafety],
  ['deadClockSkipsPort', deadClockSkipsPort],
  ['prepareTimerInternal', prepareTimerInternal],
  ['restoreTimeout', restoreTimeout],
  ['previousNoOp', previousNoOp],
  ['controlFailure', controlFailure],
  ['earlyPrepareFailure', earlyPrepareFailure],
  ['releaseRetry', releaseRetry],
  ['statusBoundary', statusBoundary],
  ['staleFailCannotClobber', staleFailCannotClobber],
  ['phaseLogFixed', phaseLogFixed],
  ['disposeCleanup', disposeCleanup],
  ['rapidSequenceProperty', rapidSequenceProperty],
] as const;

export async function run(): Promise<void> {
  for (const [name, fn] of TESTS) {
    await fn();
  }
}
