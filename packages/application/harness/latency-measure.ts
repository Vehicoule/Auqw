/**
 * Click-to-play latency harness (evidence tool, not shipped).
 * Drives scripted clicks against whichever checkout hosts it —
 * baseline main vs the latency branch — with each pipeline leg paying
 * a modeled WAN latency. Prints one JSON object per scenario on
 * stdout: leg sums, call counts, click→buffering / click→playing.
 *
 *   node --experimental-strip-types harness/latency-measure.ts
 *
 * Stage model (documented estimates, single-shot WAN):
 *   commit      10 ms — local persisted queue/write commit
 *   candidates 300 ms — playback.candidates round-trip (InnerTube)
 *   resolveAck   5 ms — startPrepare → requestId (IPC call, not the
 *                       resolve itself)
 *   mint        550 ms — guest resolve + mint + last-byte probe; the
 *                       midpoint of the 250–900 ms cold-resolve range
 *   attach       40 ms — media element ready → 'playing' publish
 *
 * Warm legs never charge the tap path — they run in the background
 * before the click lands; the scenario harness settles them first.
 */
import { ok, err, appError } from '../src/errors.ts';
import type { Result } from '../src/errors.ts';
import { createPeaksTracker } from '../src/peaks-tracker.ts';
import type { PeaksTrackerDeps } from '../src/peaks-tracker.ts';
import type {
  PeaksPort,
  PeaksStore,
  WaveformPeak,
} from '../src/ports/peaks.ts';
import { Session } from '../src/session/session.ts';
import type {
  AttemptTrace,
  PersistedState,
  PlaybackIdentity,
  PlayerEvent,
  QueueSnapshot,
  Recording,
  SessionState,
  Settings,
  SourceRef,
  TrackMetadata,
} from '../src/session/session.ts';
import {
  FakeClock,
  FakeLog,
  FakePlayer,
  FakeProvider,
  FakeStorage,
  SequenceIds,
  SequenceRandom,
} from '../src/testing/fakes.ts';

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: 'US',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
};

const LAT = {
  commit: 10,
  candidates: 300,
  resolveAck: 5,
  mint: 550,
  attach: 40,
} as const;

/**
 * Waveform-peaks extraction legs (documented estimates, same style as
 * LAT). Probes are bounded ranged reads on the minted session — one
 * WAN round-trip each, overlapped `concurrency`-wide. Decode is the
 * measured OfflineAudioContext cost of one ~5 s stereo cluster
 * (~30 ms on this box). `headCommitted` models a head probe landing
 * on bytes the pump already committed (peek serve + IPC) — the mint's
 * speculative fill commits the head before 'prepared' lands, so even
 * cold prepares get the committed rate; `headFetch` is the pessimistic
 * cold-fetch bound for streams whose pump hadn't reached the head yet.
 */
const PEAKS = {
  store: 10, // sqlite point lookup → persisted profile
  headCommitted: 5,
  headFetch: 150,
  probe: 150, // one ranged GET round on the session's connection
  decode: 30, // one cluster's decode + bucket
  concurrency: 4,
  coarseSamples: 5, // emit threshold inside the extractor
  samples: 24, // coarse + refine probe budget
} as const;

const PEAK_PROFILE: readonly WaveformPeak[] = Array.from(
  { length: 256 },
  (_, i) => ({ up: ((i * 37) % 100) / 100, down: ((i * 53) % 100) / 200 }),
);

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

async function pump(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

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
): QueueSnapshot['occurrences'][number] {
  return { occurrenceId: id, recordingId, selectedRef };
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

function playingEvent(
  identity: PlaybackIdentity,
  handle: string,
): PlayerEvent {
  return {
    type: 'status',
    handle,
    identity,
    state: 'playing',
    positionMs: 0,
  };
}

/** The i-th call's identity — deferreds are FIFO vs the calls log. */
function callIdentity(
  player: FakePlayer,
  method: string,
  index: number,
): PlaybackIdentity | null {
  const call = player.calls.filter((c) => c.method === method)[index];
  if (call === undefined) {
    return null;
  }
  return (call.input as { identity: PlaybackIdentity }).identity;
}

type Legs = {
  commit: number;
  candidates: number;
  resolveAck: number;
  mint: number;
  attach: number;
  peaks: number;
};

/** One settleable step of the modeled peaks pipeline. `apply` runs
 * after the clock has already advanced by `ms` — it emits the coarse
 * profile, resolves the port call, or settles a store hit. */
type PeakLeg = { readonly ms: number; readonly apply?: () => void };

type Env = {
  session: Session;
  storage: FakeStorage;
  player: FakePlayer;
  itunes: FakeProvider;
  ytm: FakeProvider;
  clock: FakeClock;
  legs: Legs;
  counts: {
    commits: number;
    candidates: number;
    prepares: number;
    prewarms: number;
  };
  /** Calls already emitted-served per player method. */
  served: { prepare: number; prewarm: number };
  seq: number;
  playingEmitted: boolean;
  /** Peak extraction work queued by the fake port, FIFO like the
   * player's deferreds — drive() pays one leg per round. */
  peaksJobs: PeakLeg[][];
  /** Recording ids with a persisted peaks profile (store hit). */
  peaksStoredIds: ReadonlySet<string>;
  /** The waveform tracker — same wiring `useWaveformPeaks` builds. */
  peaksTracker: ReturnType<typeof peaksTrackerFor>;
  /** The id the tracker already pulled — pull once per attempt. */
  peaksPulledFor: string | null;
  marks: {
    clickAtMs: number;
    bufferingAtMs: number | null;
    playingAtMs: number | null;
    peaksCoarseAtMs: number | null;
    peaksFinalAtMs: number | null;
  };
};

function buildEnv(state: PersistedState): Env {
  const storage = new FakeStorage(state);
  const player = new FakePlayer();
  const itunes = new FakeProvider('itunes');
  const ytm = new FakeProvider('youtube-music');
  const clock = new FakeClock(1_000);
  const session = new Session({
    storage,
    player,
    providers: [itunes, ytm],
    clock,
    ids: new SequenceIds(),
    random: new SequenceRandom(),
    log: new FakeLog(),
    defaults: SETTINGS,
  });
  return {
    session,
    storage,
    player,
    itunes,
    ytm,
    clock,
    legs: { commit: 0, candidates: 0, resolveAck: 0, mint: 0, attach: 0, peaks: 0 },
    counts: { commits: 0, candidates: 0, prepares: 0, prewarms: 0 },
    served: { prepare: 0, prewarm: 0 },
    seq: 0,
    playingEmitted: false,
    peaksJobs: [],
    peaksStoredIds: new Set(),
    peaksTracker: null as never,
    peaksPulledFor: null,
    marks: {
      clickAtMs: -1,
      bufferingAtMs: null,
      playingAtMs: null,
      peaksCoarseAtMs: null,
      peaksFinalAtMs: null,
    },
  };
}

function newEnv(state: PersistedState): Env {
  const env = buildEnv(state);
  env.peaksTracker = peaksTrackerFor(env);
  return env;
}

/**
 * The waveform pipeline, wired exactly like `useWaveformPeaks`: a
 * tracker over a port whose work is paid out as PeakLeg rounds inside
 * drive(). `onCoarse` marks the first real-bar moment; the promise's
 * settle marks the refined profile. A store hit resolves inside one
 * 10 ms DB leg instead of opening the probe path.
 */
function peaksTrackerFor(env: Env) {
  const store: PeaksStore = {
    load: (recordingId) =>
      new Promise((resolve) => {
        if (!env.peaksStoredIds.has(recordingId)) {
          resolve(null);
          return;
        }
        env.peaksJobs.push([
          {
            ms: PEAKS.store,
            apply: () => {
              env.marks.peaksCoarseAtMs = env.clock.nowMs();
              env.marks.peaksFinalAtMs = env.clock.nowMs();
              resolve(PEAK_PROFILE);
            },
          },
        ]);
      }),
    save: () => Promise.resolve(),
  };
  const port: PeaksPort = {
    peaks(request) {
      return new Promise<Result<readonly WaveformPeak[]>>((resolve) => {
        // Head probe lands on bytes the mint's speculative fill
        // already committed — peek serve + IPC on every path; the
        // tail Cues probe is the one fetch that always costs a RTT.
        const legs: PeakLeg[] = [
          { ms: PEAKS.headCommitted },
          { ms: PEAKS.probe },
        ];
        const rounds = Math.ceil(PEAKS.samples / PEAKS.concurrency);
        const coarseRound = Math.ceil(
          PEAKS.coarseSamples / PEAKS.concurrency,
        );
        for (let r = 1; r <= rounds; r++) {
          legs.push({
            ms: PEAKS.probe + PEAKS.decode,
            apply:
              r === coarseRound
                ? () => {
                    env.marks.peaksCoarseAtMs = env.clock.nowMs();
                    request.onCoarse?.(PEAK_PROFILE);
                  }
                : undefined,
          });
        }
        legs.push({
          ms: 0,
          apply: () => {
            env.marks.peaksFinalAtMs = env.clock.nowMs();
            resolve(ok(PEAK_PROFILE));
          },
        });
        env.peaksJobs.push(legs);
      });
    },
  };
  const deps: PeaksTrackerDeps = {
    port,
    clock: env.clock,
    store,
    onChange: () => {},
  };
  return createPeaksTracker(deps);
}

/** Builds a candidates result that matches the call's own query. */
function candidatesFor(
  provider: FakeProvider,
  playbackProvider: string,
): readonly TrackMetadata[] {
  const pending = provider.calls.filter((c) => c.method === 'candidates');
  const call = pending[pending.length - provider.pendingCount('candidates')];
  const query = (
    call?.input as { query?: { title?: string; artist?: string; durationMs?: number } }
  )?.query;
  return [
    meta(
      playbackProvider,
      `${playbackProvider}-m${pending.length}`,
      query?.title ?? 'Song',
      query?.artist ?? 'Artist',
      query?.durationMs ?? 300_000,
    ),
  ];
}

function playbackStatus(env: Env): string {
  const snap = env.session.snapshot();
  return snap.type === 'ready' ? snap.playback.type : snap.type;
}

/**
 * Resolves when `intent` settles — a click's own await is the honest
 * boundary: 'playing' from a prior row satisfies nothing for a new
 * click, and a failed resolve has no 'playing' to wait for.
 */
function settledFlag<T>(promise: Promise<T>): { done: boolean } {
  const flag = { done: false };
  void promise.then(
    () => {
      flag.done = true;
    },
    () => {
      flag.done = true;
    },
  );
  return flag;
}

/**
 * One pump round: settle ONE deferred leg against the latency model,
 * then yield — the tap's continuations interleave between background
 * legs exactly as they do in the live app, so a warm pass's pending
 * resolve never inflates a click's own marks. 'buffering' publishes
 * on attach, 'playing' after the modeled media-element leg.
 */
async function drive(
  env: Env,
  until: () => boolean,
  maxRounds = 800,
): Promise<void> {
  for (let round = 0; round < maxRounds; round += 1) {
    // Flush queued continuations before observing — status publishes
    // are post-settle microtasks; reading marks first would attribute
    // background legs to the click's own chain.
    await pump(4);
    // Marks for the tap path only — legs paid before the click don't
    // appear here: marks.clickAtMs resets at the click itself. The
    // 'playing' mark requires the click's own 'buffering' first — a
    // prior row's stale 'playing' status is not the click landing.
    if (env.marks.bufferingAtMs === null && playbackStatus(env) === 'buffering') {
      env.marks.bufferingAtMs = env.clock.nowMs();
      // The waveform pull fires the moment `peaksTarget` materializes
      // — same trigger `useWaveformPeaks` uses: the first visible
      // 'buffering' state already carries the borrowed handle.
      const snap = env.session.snapshot();
      if (snap.type === 'ready' && snap.playback.type === 'buffering') {
        const pb = snap.playback;
        const peaksId = `${pb.recordingId}|${pb.identity.attemptId}`;
        if (env.peaksPulledFor !== peaksId) {
          env.peaksPulledFor = peaksId;
          env.peaksTracker.pull({
            id: peaksId,
            handle: pb.handle,
            durationMs: pb.durationMs ?? null,
          });
        }
      }
    }
    if (
      env.marks.bufferingAtMs !== null &&
      env.marks.playingAtMs === null &&
      playbackStatus(env) === 'playing'
    ) {
      env.marks.playingAtMs = env.clock.nowMs();
    }
    if (until()) {
      break;
    }
    // 'buffering' observed → media-element attach leg → 'playing'.
    // It leads the settle branches: the attach overlaps background
    // candidates/mapping work, never queues behind it.
    if (!env.playingEmitted && playbackStatus(env) === 'buffering') {
      const playCall = env.player.calls
        .filter((c) => c.method === 'play')
        .at(-1);
      env.clock.advance(LAT.attach);
      env.legs.attach += LAT.attach;
      env.playingEmitted = true;
      if (playCall !== undefined) {
        const input = playCall.input as {
          handle: string;
          identity: PlaybackIdentity;
        };
        env.player.emit(playingEvent(input.identity, input.handle));
      }
      continue;
    }
    // One leg settles per round — commits first (the click's own chain
    // lands ahead of background provider work, which runs on separate
    // connections in the real app).
    env.storage.holdNextCommit();
    if (env.storage.pendingCommits > 0) {
      env.clock.advance(LAT.commit);
      env.legs.commit += LAT.commit;
      env.counts.commits += 1;
      env.storage.settleCommit(ok(undefined));
      continue;
    }
    // Peaks legs settle ahead of unrelated background work — probes
    // ride the click's own stream-session connection, while other
    // rows' candidates and warm mints run on separate ones; in the
    // real app they overlap, so the model pays peaks first.
    const peakJob = env.peaksJobs[0];
    if (peakJob !== undefined) {
      const leg = peakJob.shift()!;
      env.clock.advance(leg.ms);
      env.legs.peaks += leg.ms;
      leg.apply?.();
      if (peakJob.length === 0) {
        env.peaksJobs.shift();
      }
      continue;
    }
    // Candidates calls race in parallel (independent HTTP requests) —
    // every pending call lands on the same leg's clock advance.
    const candPending =
      env.ytm.pendingCount('candidates') + env.itunes.pendingCount('candidates');
    if (candPending > 0) {
      env.clock.advance(LAT.candidates);
      env.legs.candidates += LAT.candidates;
      for (const provider of [env.ytm, env.itunes]) {
        while (provider.pendingCount('candidates') > 0) {
          env.counts.candidates += 1;
          provider.settleCandidates(
            ok(candidatesFor(provider, 'youtube-music')),
          );
        }
      }
      continue;
    }
    if (env.player.pendingPrepares > 0) {
      env.clock.advance(LAT.resolveAck);
      env.legs.resolveAck += LAT.resolveAck;
      env.counts.prepares += 1;
      const identity = callIdentity(env.player, 'prepare', env.served.prepare);
      env.served.prepare += 1;
      env.seq += 1;
      env.player.settlePrepare(ok(`req-p${env.seq}`));
      await pump(4);
      env.clock.advance(LAT.mint);
      env.legs.mint += LAT.mint;
      if (identity !== null) {
        env.player.emit(preparedEvent(identity, `h-p${env.seq}`));
      }
      continue;
    }
    if (env.player.pendingPrewarms > 0) {
      env.clock.advance(LAT.resolveAck);
      env.counts.prewarms += 1;
      const identity = callIdentity(env.player, 'prewarm', env.served.prewarm);
      env.served.prewarm += 1;
      env.seq += 1;
      env.player.settlePrewarm(ok(`req-w${env.seq}`));
      await pump(4);
      env.clock.advance(LAT.mint);
      env.legs.mint += LAT.mint;
      if (identity !== null) {
        env.player.emit(preparedEvent(identity, `h-w${env.seq}`));
      }
      continue;
    }
  }
}

/** Click → intent settled + the new row reached 'playing' (or the
 * model's best effort when it can't). */
async function driveClick(
  env: Env,
  intent: Promise<Result<void>>,
): Promise<Result<void>> {
  const flag = settledFlag(intent);
  await drive(env, () => flag.done);
  // The attach leg publishes 'playing' one tick after the intent
  // resolves — drive it to completion, capped: a failure path has
  // no 'playing' to land (its terminal state is the exit).
  await drive(
    env,
    () =>
      playbackStatus(env) === 'playing' ||
      (playbackStatus(env) !== 'preparing' &&
        playbackStatus(env) !== 'buffering'),
    60,
  );
  // Then let the waveform finish under the same leg model — peaks
  // keep working while playback runs, so the marks close out after
  // 'playing' lands exactly as the render would trail the first
  // audio frame.
  await drive(env, () => env.peaksJobs.length === 0, 60);
  return intent;
}

/** A fresh mark just before the scripted click. */
function markClick(env: Env): void {
  env.marks.clickAtMs = env.clock.nowMs();
  env.marks.bufferingAtMs = null;
  env.marks.playingAtMs = null;
  env.marks.peaksCoarseAtMs = null;
  env.marks.peaksFinalAtMs = null;
  env.peaksPulledFor = null;
  env.playingEmitted = false;
}

function report(
  scenario: string,
  env: Env,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const { clickAtMs, bufferingAtMs, playingAtMs, peaksCoarseAtMs, peaksFinalAtMs } = env.marks;
  return {
    scenario,
    clickToBufferMs:
      bufferingAtMs === null ? null : bufferingAtMs - clickAtMs,
    clickToPlayMs: playingAtMs === null ? null : playingAtMs - clickAtMs,
    clickToPeaksCoarseMs:
      peaksCoarseAtMs === null ? null : peaksCoarseAtMs - clickAtMs,
    clickToPeaksFinalMs:
      peaksFinalAtMs === null ? null : peaksFinalAtMs - clickAtMs,
    legs: env.legs,
    counts: env.counts,
    latencyModel: LAT,
    peaksLatencyModel: PEAKS,
    ...extra,
  };
}

/** Prepare provider routing used by every scenario below. */
function threeTrackQueue(): PersistedState {
  return persisted({
    recordings: [
      recording('rA', [ref('youtube-music', 'ytm-a')]),
      recording('rB', [ref('youtube-music', 'ytm-b')]),
      recording('rC', [ref('youtube-music', 'ytm-c')]),
      // Unmapped rows: catalog-only refs — the candidates leg pays.
      recording('rD', [ref('itunes', 'it-d')]),
      recording('rE', [ref('itunes', 'it-e')]),
    ],
    queue: {
      revision: 3,
      occurrences: [
        occurrence('oA', 'rA', ref('youtube-music', 'ytm-a')),
        occurrence('oB', 'rB', ref('youtube-music', 'ytm-b')),
        occurrence('oC', 'rC', ref('youtube-music', 'ytm-c')),
        occurrence('oD', 'rD', null),
        occurrence('oE', 'rE', null),
      ],
      currentOccurrenceId: null,
      positionMs: 0,
      mode: 'stopped',
    },
  });
}

/** Scenario: tap a pinned non-successor queue row — cold. */
async function coldQueuePinned() {
  const env = newEnv(threeTrackQueue());
  await env.session.restore();
  await drive(env, () => env.storage.pendingCommits === 0);
  markClick(env);
  const res = await driveClick(env, env.session.playOccurrence('oB'));
  return report('cold.queue-row.pinned', env, { intentOk: res.ok });
}

/** Scenario: tap an unmapped queue row — candidates + mapping commit. */
async function coldQueueUnmapped() {
  const env = newEnv(threeTrackQueue());
  await env.session.restore();
  markClick(env);
  const res = await driveClick(env, env.session.playOccurrence('oD'));
  return report('cold.queue-row.unmapped', env, { intentOk: res.ok });
}

/** Scenario: tap a same-playback-provider catalog row (search result). */
async function coldCatalogTapSameProvider() {
  const env = newEnv(persisted());
  await env.session.restore();
  markClick(env);
  const res = await driveClick(
    env,
    env.session.playMetadata([
      meta('youtube-music', 'ytm-search1', 'Roads', 'Artist', 200_000),
    ]),
  );
  return report('cold.search-tap.same-provider', env, { intentOk: res.ok });
}

/** Scenario: tap a catalog-provider row — candidates + mapping legs. */
async function coldCatalogTapCrossProvider() {
  const env = newEnv(persisted());
  await env.session.restore();
  markClick(env);
  const res = await driveClick(
    env,
    env.session.playMetadata([
      meta('itunes', 'it-search1', 'Roads', 'Artist', 200_000),
    ]),
  );
  return report('cold.search-tap.cross-provider', env, { intentOk: res.ok });
}

/**
 * Scenario: the dealt successor minted its warm while oA played —
 * tapping oB should adopt it: commit + attach only.
 */
async function warmQueueSuccessor() {
  const env = newEnv(threeTrackQueue());
  await env.session.restore();
  await driveClick(env, env.session.playOccurrence('oA'));
  // Background: the dealt-window successor warm resolves + mints oB.
  await drive(
    env,
    () =>
      env.player.calls.filter((c) => c.method === 'prewarm').length > 0 &&
      env.player.pendingPrewarms === 0,
  );
  await pump();
  markClick(env);
  const res = await driveClick(env, env.session.playOccurrence('oB'));
  const adopted = env.counts.prepares === 1; // oA's own prepare only
  return report('warm.queue-successor', env, { intentOk: res.ok, adopted });
}

/**
 * Scenario: a queue row the viewport handed via `occurrenceIds`
 * mints ahead of the tap — feature-detected: on a checkout without
 * the hand, the warm never issues and `covered` reports false.
 */
async function warmQueueViewportRow() {
  const env = newEnv(threeTrackQueue());
  await env.session.restore();
  // The surface hands the rows it is showing — oC is not the
  // successor, so the shipped want-space never covers it.
  (
    env.session.prewarm as (i: Record<string, unknown>) => void
  )({ occurrenceIds: ['oC'] });
  await drive(env, () => env.player.pendingPrewarms === 0);
  await pump();
  const prewarmCalls = env.player.calls.filter(
    (c) => c.method === 'prewarm',
  ).length;
  markClick(env);
  const res = await driveClick(env, env.session.playOccurrence('oC'));
  return report('warm.queue-viewport-row', env, {
    intentOk: res.ok,
    covered: prewarmCalls > 0,
    adopted: prewarmCalls > 0 && env.counts.prepares === 0,
  });
}

/**
 * Scenario: hover/focus warm for an unmapped library row — the
 * candidates pass ran and the minted session waits for the tap.
 * `focus` is feature-detected the same way.
 */
async function warmFocusUnmappedRow() {
  const env = newEnv(threeTrackQueue());
  await env.session.restore();
  (
    env.session.prewarm as (i: Record<string, unknown>) => void
  )({ focus: { kind: 'recording', id: 'rE' } });
  await drive(
    env,
    () =>
      env.player.calls.some(
        (c) =>
          c.method === 'prewarm' &&
          (c.input as { sourceRef?: string }).sourceRef === 'youtube-music-m1',
      ) && env.player.pendingPrewarms === 0,
  );
  await pump();
  const warmMinted = env.player.calls.some((c) => c.method === 'prewarm');
  markClick(env);
  const res = await driveClick(env, env.session.playOccurrence('oE'));
  return report('warm.focus-unmapped-row', env, {
    intentOk: res.ok,
    covered: warmMinted,
    adopted: warmMinted && env.counts.prepares === 0,
  });
}

/**
 * Scenario: enqueue warms the new rows before any surface hands them
 * — tapping a just-enqueued row adopts its minted session.
 */
async function warmEnqueuedRow() {
  const env = newEnv(
    persisted({
      recordings: [
        recording('r1', [ref('itunes', 'it-1')]),
        recording('r2', [ref('itunes', 'it-2')]),
      ],
    }),
  );
  await env.session.restore();
  const enq = await env.session.enqueueRecording('r2');
  // Let the post-enqueue warm run to its mint — the coverage question
  // is whether a click landing after it adopts without re-resolving.
  await drive(
    env,
    () =>
      env.player.calls.some((c) => c.method === 'prewarm') &&
      env.player.pendingPrewarms === 0,
  );
  await pump();
  const prewarmCalls = env.player.calls.filter(
    (c) => c.method === 'prewarm',
  ).length;
  const occurrenceId = enq.ok ? enq.value : 'missing';
  markClick(env);
  const res = await driveClick(env, env.session.playOccurrence(occurrenceId));
  return report('warm.enqueued-row', env, {
    intentOk: res.ok,
    covered: prewarmCalls > 0,
    adopted: env.counts.prepares === 0,
  });
}

/**
 * Scenario: the warm-adopt floor — identical to `warmQueueSuccessor`
 * but every row is already mapped, so no background candidates leg
 * interleaves; the measured marks are the adopt path itself.
 */
async function warmQueueSuccessorQuiet() {
  const env = newEnv(
    persisted({
      recordings: [
        recording('rA', [ref('youtube-music', 'ytm-a')]),
        recording('rB', [ref('youtube-music', 'ytm-b')]),
        recording('rC', [ref('youtube-music', 'ytm-c')]),
      ],
      queue: {
        revision: 3,
        occurrences: [
          occurrence('oA', 'rA', ref('youtube-music', 'ytm-a')),
          occurrence('oB', 'rB', ref('youtube-music', 'ytm-b')),
          occurrence('oC', 'rC', ref('youtube-music', 'ytm-c')),
        ],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
    }),
  );
  await env.session.restore();
  await driveClick(env, env.session.playOccurrence('oA'));
  await drive(
    env,
    () =>
      env.player.calls.filter((c) => c.method === 'prewarm').length > 0 &&
      env.player.pendingPrewarms === 0,
  );
  await pump();
  markClick(env);
  const res = await driveClick(env, env.session.playOccurrence('oB'));
  return report('warm.queue-successor.quiet', env, {
    intentOk: res.ok,
    adopted: env.counts.prepares === 1,
  });
}

/**
 * Scenario: same cold pinned tap, but the recording's peaks profile
 * is persisted — the store hit serves the waveform inside one DB leg
 * and the probe path never runs. This is the repeat-play fast path.
 */
async function coldQueuePinnedStoredPeaks() {
  const env = newEnv(threeTrackQueue());
  await env.session.restore();
  env.peaksStoredIds = new Set(['rB']);
  await drive(env, () => env.storage.pendingCommits === 0);
  markClick(env);
  const res = await driveClick(env, env.session.playOccurrence('oB'));
  return report('cold.queue-row.pinned.stored-peaks', env, {
    intentOk: res.ok,
  });
}

const scenarios = [
  coldQueuePinned,
  coldQueuePinnedStoredPeaks,
  coldQueueUnmapped,
  coldCatalogTapSameProvider,
  coldCatalogTapCrossProvider,
  warmQueueSuccessor,
  warmQueueSuccessorQuiet,
  warmQueueViewportRow,
  warmFocusUnmappedRow,
  warmEnqueuedRow,
];

for (const run of scenarios) {
  try {
    const out = await run();
    console.log(JSON.stringify(out));
  } catch (thrown) {
    console.log(
      JSON.stringify({
        scenario: run.name,
        crashed: thrown instanceof Error ? thrown.message : String(thrown),
      }),
    );
    process.exitCode = 1;
  }
}
