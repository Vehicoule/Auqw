/**
 * Reliability fault-injection harness (evidence tool, not shipped).
 * Runs the same scripted failures against whichever checkout hosts
 * it — baseline main vs the hardening branch — and prints one JSON
 * object per scenario on stdout.
 *
 *   node --experimental-strip-types harness/reliability-measure.ts
 */
import { CancellationSource } from '../src/cancellation.ts';
import { appError, err, ok } from '../src/errors.ts';
import type { AppError, Result } from '../src/errors.ts';
import type { CancellationSignal } from '../src/cancellation.ts';
import { isSafeNonNegative } from '../src/domain.ts';
import { Session } from '../src/session/session.ts';
import type {
  AttemptTrace,
  PersistedState,
  PlaybackIdentity,
  PlayerEvent,
  QueueSnapshot,
  Recording,
  Settings,
  SourceRef,
} from '../src/session/session.ts';
import { SearchSession } from '../src/search/search-session.ts';
import { createArtworkCache } from '../src/library/artwork-cache.ts';
import type { OperationContext } from '../src/ports/provider.ts';
import {
  FakeClock,
  FakeLog,
  FakePlayer,
  FakeProvider,
  FakeStorage,
  SequenceIds,
  SequenceRandom,
} from '../src/testing/fakes.ts';
import * as appIndex from '../src/index.ts';

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

async function pump(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function ref(provider: string, id: string): SourceRef {
  return { provider, kind: 'track', id };
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
) {
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

function newSession(
  state: PersistedState,
  providers: FakeProvider[],
  clock: FakeClock,
  player = new FakePlayer(),
): Session {
  return new Session({
    storage: new FakeStorage(state),
    player,
    providers,
    clock,
    ids: new SequenceIds(),
    random: new SequenceRandom(),
    log: new FakeLog(),
    defaults: SETTINGS,
  });
}

function lastPrepareIdentity(player: FakePlayer): PlaybackIdentity {
  const list = player.calls.filter((c) => c.method === 'prepare');
  return (list[list.length - 1]?.input as { identity: PlaybackIdentity })
    .identity;
}

function emitFailedPrepare(
  player: FakePlayer,
  identity: PlaybackIdentity,
  requestId: string,
  error: AppError,
): void {
  player.emit({
    type: 'prepare',
    requestId,
    identity,
    outcome: { type: 'failed', error, attempt: TRACE },
  });
}

function emitPrepared(
  player: FakePlayer,
  identity: PlaybackIdentity,
  handle: string,
): void {
  player.emit({
    type: 'prepare',
    requestId: `req-${handle}`,
    identity,
    outcome: {
      type: 'prepared',
      stream: { handle, mime: 'audio/mp4' },
      attempt: TRACE,
    },
  });
}

/** Scenario 1: a retryable prepare failure mid-flight. */
async function scenarioPlayback() {
  const player = new FakePlayer();
  const clock = new FakeClock(1_000);
  const session = newSession(
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
    [new FakeProvider('itunes'), new FakeProvider('youtube-music')],
    clock,
    player,
  );
  await session.restore();
  const intent = session.playOccurrence('o1');
  await pump();
  emitFailedPrepare(
    player,
    lastPrepareIdentity(player),
    'req-f1',
    appError('streams-capped', 'provider capped'),
  );
  await pump();
  clock.advance(500);
  await pump();
  // Settle every pending prepare deferred — attempt-1's and, on the
  // retry path, attempt-2's.
  player.settlePrepare(ok('req-a'));
  player.settlePrepare(ok('req-b'));
  await pump();
  emitPrepared(player, lastPrepareIdentity(player), 'h-m1');
  await pump();
  const intentResult = await intent;
  const snap = session.snapshot();
  const playback =
    snap.type === 'ready' ? snap.playback.type : `state:${snap.type}`;
  return {
    scenario: 'playback.prepare-failed(streams-capped)',
    prepareCalls: player.calls.filter((c) => c.method === 'prepare')
      .length,
    playCalls: player.calls.filter((c) => c.method === 'play').length,
    finalPlayback: playback,
    intentError: intentResult.ok ? null : intentResult.error.kind,
    recovered: playback === 'buffering' || playback === 'playing',
  };
}

/** Scenario 2: search fails transiently once, then succeeds. */
async function scenarioSearch() {
  const provider = new FakeProvider('itunes');
  const clock = new FakeClock(0);
  const session = new SearchSession(provider, clock, new SequenceIds());
  const pending = session.search({
    query: 'roads',
    limit: 5,
    storefront: 'US',
  });
  provider.settleSearch(err(appError('transient', 'down')));
  await pump();
  clock.advance(500);
  await pump();
  provider.settleSearch(ok({ items: [], storefront: 'US' }));
  const state = await pending;
  return {
    scenario: 'search.transient-then-ok',
    providerCalls: provider.calls.filter((c) => c.method === 'search')
      .length,
    finalType: state.type,
    recovered: state.type === 'content' || state.type === 'empty',
  };
}

/** Scenario 3: lyrics fetch transient failure then success. */
async function scenarioLyrics() {
  const lrclib = new FakeProvider('lyrics-lrclib', [
    'lyrics.plain',
    'lyrics.synced',
  ]);
  const clock = new FakeClock(0);
  const session = newSession(
    persisted({
      recordings: [recording('r1', [ref('youtube-music', 'y1')])],
    }),
    [
      new FakeProvider('itunes', ['catalog.search']),
      new FakeProvider('youtube-music', [
        'playback.candidates',
        'playback.resolve',
      ]),
      lrclib,
    ],
    clock,
  );
  await session.restore();
  const pending = session.getLyrics('r1');
  await pump();
  lrclib.settleLyrics(err(appError('transient', 'down')));
  await pump();
  // The lyrics retry backs off at an 800 ms base — cross it.
  clock.advance(800);
  await pump();
  lrclib.settleLyrics(ok({ kind: 'plain', text: 'words', matched: null }));
  const sheet = await pending;
  return {
    scenario: 'lyrics.transient-then-ok',
    providerCalls: lrclib.calls.filter((c) => c.method === 'getLyrics')
      .length,
    ok: sheet.ok,
    kind: sheet.ok ? sheet.value.kind : sheet.error.kind,
    recovered: sheet.ok,
  };
}

/** Scenario 4: entity page transient failure then success. */
async function scenarioEntity() {
  const deezer = new FakeProvider('deezer');
  const clock = new FakeClock(0);
  const session = newSession(
    persisted(),
    [new FakeProvider('itunes'), new FakeProvider('youtube-music'), deezer],
    clock,
  );
  await session.restore();
  const refAlbum = {
    provider: 'deezer',
    kind: 'album',
    id: 'a1',
  } as never;
  const pending = session.getEntityPage(refAlbum);
  await pump();
  deezer.settleEntity(err(appError('transient', 'down')));
  await pump();
  clock.advance(500);
  await pump();
  deezer.settleEntity(
    ok({
      entity: {
        sourceRef: { provider: 'deezer', kind: 'album', id: 'a1' },
        kind: 'album',
        title: 'Deadbeat',
        subtitle: 'Tame Impala',
        artwork: [],
      },
      items: [],
      continuation: null,
      complete: true,
    } as never),
  );
  const page = await pending;
  return {
    scenario: 'entity.transient-then-ok',
    providerCalls: deezer.calls.filter((c) => c.method === 'getEntity')
      .length,
    ok: page.ok,
    entitiesMaterialized:
      session.snapshot().type === 'ready'
        ? (session.snapshot() as { entities: unknown[] }).entities.length
        : -1,
    recovered: page.ok,
  };
}

/** Minimal artwork ports for the harness (mirrors the test fakes). */
function artworkPorts() {
  const calls: string[] = [];
  let plan: (url: string) => Result<{ bytes: number }> = () =>
    ok({ bytes: 8 });
  const fetch = {
    calls,
    respond(fn: (url: string) => Result<{ bytes: number }>): void {
      plan = fn;
    },
    download(
      url: string,
      _destPath: string,
      _signal: CancellationSignal,
    ): Promise<Result<{ bytes: number }>> {
      calls.push(url);
      return Promise.resolve(plan(url));
    },
  };
  const paths = {
    destFor: (url: string) => `/art/${encodeURIComponent(url)}`,
    exists: () => Promise.resolve(ok(false)),
    remove: () => Promise.resolve(ok(undefined)),
  };
  return { fetch, paths };
}

function ctx(): OperationContext {
  return {
    requestId: 'measure',
    deadlineMs: Number.MAX_SAFE_INTEGER,
    signal: new CancellationSource().signal,
  };
}

/** Scenario 5: artwork transient retry + negative caching. */
async function scenarioArtwork() {
  const storage = new FakeStorage(persisted());
  const clock = new FakeClock(1_000);
  const { fetch, paths } = artworkPorts();
  const cache = createArtworkCache({
    storage,
    clock,
    ids: new SequenceIds(),
    log: new FakeLog(),
    fetch,
    paths,
  });
  // Transient once, then success.
  let n = 0;
  fetch.respond(() => {
    n += 1;
    return n === 1 ? err(appError('transient', 'blip')) : ok({ bytes: 8 });
  });
  const g = cache.get('https://art.example/a.jpg', ctx());
  await pump();
  clock.advance(500);
  await pump();
  const got = await g;
  const transientCalls = n;

  // Dead URL fetched repeatedly — negative cache should suppress.
  // 'not-found' is the url's own verdict; 'unavailable' describes
  // the network and is intentionally never cached.
  fetch.respond(() => err(appError('not-found', 'gone')));
  const B = 'https://art.example/b.jpg';
  await cache.get(B, ctx());
  const bCalls1 = fetch.calls.filter((u) => u === B).length;
  const b2 = await cache.get(B, ctx());
  const bCalls2 = fetch.calls.filter((u) => u === B).length;
  // After the negative TTL the next get retries the network.
  clock.advance(21_000);
  await cache.get(B, ctx());
  const bCalls3 = fetch.calls.filter((u) => u === B).length;
  return {
    scenario: 'artwork.transient+negative-cache',
    transientCalls,
    transientOk: got.ok,
    deadUrlCallsBeforeExpiry: bCalls2,
    deadUrlCallsFirst: bCalls1,
    deadUrlCallsAfterTtl: bCalls3,
    negativeCached: b2 !== undefined && !b2.ok,
  };
}

/** Scenario 6: sync scheduler triggers (branch-only API). */
async function scenarioSync() {
  const createSyncScheduler = (
    appIndex as { createSyncScheduler?: unknown }
  ).createSyncScheduler as
    | ((deps: Record<string, unknown>) => {
      start(): void;
      notifyLocalWrites(): void;
      notifyConnectivity(online: boolean): void;
      stop(): void;
    })
    | undefined;
  if (createSyncScheduler === undefined) {
    return {
      scenario: 'sync.scheduler-triggers',
      onLaunchRounds: null,
      afterWriteBurstRounds: null,
      afterReconnectRounds: null,
      note: 'no scheduler on this checkout',
    };
  }
  const clock = new FakeClock(0);
  const peer = {
    role: 'responder',
    fp: 'fp-1',
    name: 'phone',
    endpoints: ['10.0.0.2:4123'],
    pairedAt: 1,
    lastSeenAt: 1,
    peerCursor: {},
  } as const;
  let syncing = false;
  let listeners: ((s: unknown) => void)[] = [];
  const views = new Map<string, { state: string; lastError?: AppError }>();
  const syncNowCalls: string[] = [];
  const client = {
    status: () => ({
      deviceId: 'self',
      peers: views.has(peer.fp)
        ? [
          {
            peer,
            state: views.get(peer.fp)?.state,
            syncing: false,
            ...(views.get(peer.fp)?.lastError === undefined
              ? {}
              : { lastError: views.get(peer.fp)?.lastError }),
          },
        ]
        : [{ peer, state: 'offline', syncing: false }],
    }),
    subscribe: (l: (s: unknown) => void) => {
      listeners.push(l);
      return () => {
        listeners = listeners.filter((x) => x !== l);
      };
    },
    peers: () => Promise.resolve(ok([peer])),
    pair: () => Promise.resolve(err(appError('unsupported', 'stub'))),
    syncNow: (fp: string) => {
      syncNowCalls.push(fp);
      syncing = true;
      return Promise.resolve(
        ok({ peerFp: fp, remoteEntries: 0, sentEntries: 0, divergence: 0, rounds: 1 }),
      ).finally(() => {
        syncing = false;
      });
    },
    refreshPeer: () => Promise.resolve(ok(undefined)),
    unpair: () => Promise.resolve(ok(undefined)),
    close: () => Promise.resolve(ok(undefined)),
  };
  void syncing;
  const scheduler = createSyncScheduler({
    client,
    clock,
    log: new FakeLog(),
    isOnline: () => true,
  });
  scheduler.start();
  await pump();
  clock.advance(1);
  await pump();
  const onLaunch = syncNowCalls.length;
  // A burst of three committed writes coalesces into one round.
  scheduler.notifyLocalWrites();
  scheduler.notifyLocalWrites();
  scheduler.notifyLocalWrites();
  await pump();
  clock.advance(1_000);
  await pump();
  const afterWrites = syncNowCalls.length;
  // Session drop with a retryable verdict → backoff reconnect.
  views.set(peer.fp, {
    state: 'offline',
    lastError: appError('transient', 'socket dropped'),
  });
  for (const l of listeners) {
    l(client.status());
  }
  await pump();
  clock.advance(2_500);
  await pump();
  const afterReconnect = syncNowCalls.length;
  scheduler.stop();
  return {
    scenario: 'sync.scheduler-triggers',
    onLaunchRounds: onLaunch,
    afterWriteBurstRounds: afterWrites,
    afterReconnectRounds: afterReconnect,
  };
}

const scenarios = [
  scenarioPlayback,
  scenarioSearch,
  scenarioLyrics,
  scenarioEntity,
  scenarioArtwork,
  scenarioSync,
];

for (const run of scenarios) {
  try {
    const report = await run();
    console.log(JSON.stringify(report));
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
