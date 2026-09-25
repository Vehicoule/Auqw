import { CancellationSource } from '../cancellation.ts';
import type { OperationContext } from '../cancellation.ts';
import type {
  AttemptTrace,
  PlayerEvent,
  PlaybackIdentity,
} from '../ports/player.ts';
import type {
  QueueOccurrence,
  Recording,
  Settings,
  SourceRef,
} from '../domain.ts';
import type { ExportDocument } from './library.ts';
import { isExportDocument } from './library.ts';
import {
  applyImport,
  exportLibrary,
  parseExportJson,
  previewImport,
} from './export-import.ts';
import type { PersistedState } from '../ports/storage.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import { ok as okResult } from '../errors.ts';
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

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: 'US',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
};

function ctx(): { context: OperationContext; source: CancellationSource } {
  const source = new CancellationSource();
  return {
    context: { requestId: 't', deadlineMs: 60_000, signal: source.signal },
    source,
  };
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
    downloads: partial.downloads ?? [],
    localSources: partial.localSources ?? [],
    localFiles: partial.localFiles ?? [],
    queue: partial.queue ?? emptyQueue(),
    settings: partial.settings ?? SETTINGS,
  };
}

const SEEDED: PersistedState = persisted({
  recordings: [
    recording('r1', [ref('itunes', 'i1'), ref('youtube-music', 'y1')]),
    recording('r2', [ref('itunes', 'i2')]),
  ],
  likes: [
    { entityKind: 'track', targetId: 'r1', likedAtMs: 42 },
    { entityKind: 'album', targetId: 'ent-1', likedAtMs: 43 },
  ],
  entities: [
    {
      entityId: 'ent-1',
      kind: 'album',
      title: 'Album One',
      artistName: 'Artist',
      artwork: [],
      createdMs: 10,
    },
  ],
  entitySourceRefs: [
    {
      entityId: 'ent-1',
      provider: 'itunes',
      ref: { provider: 'itunes', kind: 'album', id: 'alb-1' },
    },
  ],
  playlists: [
    { playlistId: 'pl-1', name: 'Mix', createdMs: 5, updatedMs: 9 },
  ],
  playlistEntries: [
    {
      entryId: 'pe-1',
      playlistId: 'pl-1',
      recordingId: 'r1',
      position: 1,
      selectedRef: null,
      addedMs: 6,
    },
    {
      entryId: 'pe-2',
      playlistId: 'pl-1',
      recordingId: 'r1',
      position: 2,
      selectedRef: ref('youtube-music', 'y1'),
      addedMs: 7,
    },
  ],
  playHistory: [
    {
      eventId: 'ev-1',
      recordingId: 'r1',
      occurrenceId: 'o1',
      playedMs: 50,
      listenedMs: 200_000,
    },
  ],
  playCounts: [{ recordingId: 'r1', count: 3, lastMs: 50 }],
  matchReviews: [],
});

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

function sessionFor(state: PersistedState): {
  session: Session;
  storage: FakeStorage;
  player: FakePlayer;
  ytm: FakeProvider;
  states: SessionState[];
} {
  const storage = new FakeStorage(state);
  const player = new FakePlayer();
  const ytm = new FakeProvider('youtube-music');
  const session = new Session({
    storage,
    player,
    providers: [new FakeProvider('itunes'), ytm],
    clock: new FakeClock(1_000),
    ids: new SequenceIds(),
    random: new SequenceRandom(),
    log: new FakeLog(),
    defaults: SETTINGS,
  });
  const states: SessionState[] = [];
  session.subscribe((s) => states.push(s));
  return { session, storage, player, ytm, states };
}

function ready(state: SessionState): ReadySession {
  assert(state.type === 'ready', `expected ready, got ${state.type}`);
  return state;
}

async function pump(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

// 1. Export produces a document that parses back to the same sections.
async function exportRoundtrip(): Promise<void> {
  const storage = new FakeStorage(SEEDED);
  const exported = await exportLibrary(
    storage,
    new FakeClock(9_000),
    ctx().context,
  );
  assert(exported.ok, 'export resolves');
  const parsed = parseExportJson(exported.value.json);
  assert(parsed.ok, 'export JSON reparses');
  assertEqual(parsed.value.exportedAtMs, 9_000, 'clock stamps export');
  assertDeepEqual(parsed.value.recordings.length, 2);
  assertDeepEqual(parsed.value.likes, SEEDED.likes);
  assertDeepEqual(parsed.value.playlistEntries, SEEDED.playlistEntries);
  assertDeepEqual(parsed.value.playCounts, SEEDED.playCounts);
  assert(isExportDocument(parsed.value), 'valid export document');
}

// 2. Malformed inputs are typed failures, never partials.
async function parseRejects(): Promise<void> {
  for (const text of ['', '   ', 'not json', '[]', '{}', '{"formatVersion":2}']) {
    const res = parseExportJson(text);
    assert(!res.ok, `rejected: ${text.slice(0, 20)}`);
    assertEqual(res.error.kind, 'invalid-response');
  }
  // Structurally valid envelope, dangling reference: a like naming a
  // recording that is not in the document.
  const dangling = {
    formatVersion: 1,
    exportedAtMs: 1,
    recordings: [],
    sourceRefs: [],
    mappings: [],
    provenance: 'provider',
    likes: [{ entityKind: 'track', targetId: 'ghost', likedAtMs: 1 }],
    entities: [],
    entitySourceRefs: [],
    playlists: [],
    playlistEntries: [],
    playHistory: [],
    playCounts: [],
    matchReviews: [],
    settings: SETTINGS,
  };
  const res = parseExportJson(JSON.stringify(dangling));
  assert(!res.ok, 'dangling like target rejected');
}

// 3. The confirm-screen summary counts every section.
async function previewCounts(): Promise<void> {
  const storage = new FakeStorage(SEEDED);
  const exported = await exportLibrary(
    storage,
    new FakeClock(5_000),
    ctx().context,
  );
  assert(exported.ok);
  const preview = previewImport(exported.value.json);
  assert(preview.ok, 'preview resolves');
  assertDeepEqual(preview.value.counts, {
    recordings: 2,
    sourceRefs: 3,
    mappings: 0,
    likes: 2,
    entities: 1,
    entitySourceRefs: 1,
    playlists: 1,
    playlistEntries: 2,
    playEvents: 1,
    playCounts: 1,
    matchReviews: 0,
  });
}

// 4. Storage-level apply is atomic and replaces every owned section.
async function applyReplaces(): Promise<void> {
  const source = new FakeStorage(SEEDED);
  const exported = await exportLibrary(
    source,
    new FakeClock(7_000),
    ctx().context,
  );
  assert(exported.ok);
  const target = new FakeStorage(persisted());
  const applied = await applyImport(
    target,
    exported.value.doc,
    ctx().context,
  );
  assert(applied.ok, 'apply resolves');
  const loaded = await target.load(ctx().context);
  assert(loaded.ok);
  assertDeepEqual(loaded.value.recordings, SEEDED.recordings);
  assertDeepEqual(loaded.value.likes, SEEDED.likes);
  assertDeepEqual(loaded.value.playlists, SEEDED.playlists);
  assertDeepEqual(loaded.value.playlistEntries, SEEDED.playlistEntries);
}

// 5. Session import: valid document applies and rehydrates the session.
async function sessionImportApplies(): Promise<void> {
  const source = new FakeStorage(SEEDED);
  const exported = await exportLibrary(
    source,
    new FakeClock(3_000),
    ctx().context,
  );
  assert(exported.ok);

  const other = persisted({
    recordings: [recording('old', [ref('itunes', 'old-1')])],
    likes: [{ entityKind: 'track', targetId: 'old', likedAtMs: 1 }],
  });
  const { session } = sessionFor(other);
  assert((await session.restore()).ok);
  const imported = await session.importLibrary(exported.value.json);
  assert(imported.ok, 'import resolves');
  assertDeepEqual(imported.value.counts.recordings, 2);
  const snap = ready(session.snapshot());
  assertDeepEqual(snap.recordings, SEEDED.recordings);
  assertDeepEqual(snap.likes, SEEDED.likes);
  assertEqual(snap.queue.occurrences.length, 0, 'queue reset by import');
  assertEqual(snap.queue.mode, 'stopped');
}

// 6. A rejected document changes nothing in the session.
async function sessionImportRejects(): Promise<void> {
  const { session } = sessionFor(SEEDED);
  assert((await session.restore()).ok);
  const res = await session.importLibrary('{"formatVersion": 99}');
  assert(!res.ok, 'invalid doc rejected');
  assertEqual(res.error.kind, 'invalid-response');
  const snap = ready(session.snapshot());
  assertDeepEqual(snap.recordings, SEEDED.recordings, 'state untouched');
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

// 8. A provenance:'local' row round-trips: provenance and the stable
// fingerprint id (its provider:'local' sourceRef) export and import;
// device-local sections (downloads/local_sources/local_files) never
// appear in the document.
async function exportRoundtripLocalRows(): Promise<void> {
  const seeded = persisted({
    recordings: [
      recording('r1', [ref('youtube-music', 'y1')]),
      {
        ...recording('r2', [{ provider: 'local', kind: 'track', id: 'fp-deadbeef' }]),
        provenance: 'local' as const,
      },
    ],
    downloads: [
      {
        downloadId: 'd1',
        recordingId: 'r1',
        provider: 'youtube-music',
        sourceRef: ref('youtube-music', 'y1'),
        filePath: 'd1.mp4',
        bytes: 1024,
        state: 'available',
        committedOffset: 1024,
        checksum: 'a'.repeat(64),
        mime: 'audio/mp4',
        itag: 140,
        expiresAtMs: null,
        error: null,
        priority: 2,
        requestedMs: 10,
        downloadedMs: 20,
      },
    ],
    localSources: [
      {
        sourceId: 'src-1',
        treeUri: 'content://tree/Music',
        label: 'Music',
        addedMs: 100,
        lastScanMs: 200,
      },
    ],
    localFiles: [
      {
        fileId: 'fp-deadbeef',
        sourceId: 'src-1',
        docId: 'doc-9',
        size: 4096,
        fingerprint: 'fp-deadbeef',
        modifiedMs: 1_700_000_000_000,
        title: 'Local Song',
        artist: 'Local Artist',
        album: null,
        durationMs: 180_000,
        genre: null,
        recordingId: 'r2',
      },
    ],
  });
  const storage = new FakeStorage(seeded);
  const exported = await exportLibrary(
    storage,
    new FakeClock(6_000),
    ctx().context,
  );
  assert(exported.ok, 'export resolves');
  const raw = JSON.parse(exported.value.json) as Record<string, unknown>;
  assert(!('downloads' in raw), 'downloads never export');
  assert(!('localSources' in raw), 'local_sources never export');
  assert(!('localFiles' in raw), 'local_files never export');
  const parsed = parseExportJson(exported.value.json);
  assert(parsed.ok, 'export JSON reparses');
  const localRec = parsed.value.recordings.find((r) => r.id === 'r2');
  assertEqual(localRec?.provenance, 'local', 'provenance exported');
  assert(
    parsed.value.sourceRefs.some(
      (s) =>
        s.recordingId === 'r2' &&
        s.ref.provider === 'local' &&
        s.ref.id === 'fp-deadbeef',
    ),
    'stable fingerprint id exports as the local sourceRef',
  );
  const target = new FakeStorage(persisted());
  const applied = await applyImport(target, parsed.value, ctx().context);
  assert(applied.ok, 'apply resolves');
  const loaded = await target.load(ctx().context);
  assert(loaded.ok);
  const landed = loaded.value.recordings.find((r) => r.id === 'r2');
  assertEqual(landed?.provenance, 'local', 'provenance round-trips');
  assert(
    landed?.sourceRefs.some(
      (s) => s.provider === 'local' && s.id === 'fp-deadbeef',
    ) === true,
    'local ref round-trips',
  );
}

// 9. Import during playback releases the handle and lands idle.
async function sessionImportDuringPlayback(): Promise<void> {
  const playing = persisted({
    recordings: [recording('r1', [ref('youtube-music', 'y1')])],
    queue: {
      revision: 1,
      occurrences: [occurrence('o1', 'r1', ref('youtube-music', 'y1'))],
      currentOccurrenceId: 'o1',
      positionMs: 0,
      mode: 'paused',
    },
  });
  const { session, player, ytm } = sessionFor(playing);
  assert((await session.restore()).ok);
  const play = session.playOccurrence('o1');
  await pump();
  if (ytm.pendingCount('candidates') > 0) {
    ytm.settleCandidates(
      okResult([
        {
          sourceRef: ref('youtube-music', 'y1'),
          title: 'Song r1',
          artist: 'Artist',
          album: 'Album',
          durationMs: 300_000,
          releaseYear: 2020,
          artwork: [],
          explicit: null,
          genre: null,
          storefront: 'US',
        },
      ]),
    );
    await pump();
  }
  assert(player.pendingPrepares >= 1, 'prepare issued');
  const calls = player.calls.filter((c) => c.method === 'prepare');
  const last = calls[calls.length - 1];
  assert(last !== undefined, 'expected a prepare call');
  const identity = (last.input as { identity: PlaybackIdentity }).identity;
  player.emit(preparedEvent(identity, 'h-1'));
  await pump();
  assert(player.settlePrepare(okResult('req-1')), 'pending prepare');
  const res = await play;
  assert(res.ok, 'play resolves');

  const exported = await exportLibrary(
    new FakeStorage(SEEDED),
    new FakeClock(4_000),
    ctx().context,
  );
  assert(exported.ok);
  const imported = await session.importLibrary(exported.value.json);
  assert(imported.ok, 'import during playback resolves');
  const snap = ready(session.snapshot());
  assertEqual(snap.playback.type, 'idle', 'playback released to idle');
  assertDeepEqual(snap.recordings, SEEDED.recordings, 'imported rows land');
}

const TESTS: readonly [string, () => Promise<void>][] = [
  ['exportRoundtrip', exportRoundtrip],
  ['parseRejects', parseRejects],
  ['previewCounts', previewCounts],
  ['applyReplaces', applyReplaces],
  ['sessionImportApplies', sessionImportApplies],
  ['sessionImportRejects', sessionImportRejects],
  ['exportRoundtripLocalRows', exportRoundtripLocalRows],
  ['sessionImportDuringPlayback', sessionImportDuringPlayback],
];

export async function run(): Promise<void> {
  for (const [name, fn] of TESTS) {
    try {
      await fn();
    } catch (thrown) {
      throw new Error(`export-import test failed: ${name}`, { cause: thrown });
    }
  }
}
