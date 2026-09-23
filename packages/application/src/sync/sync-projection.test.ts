import type {
  EntityRef,
  QueueOccurrence,
  Recording,
  SourceMapping,
  SourceRef,
} from '../domain.ts';
import type {
  Entity,
  EntitySourceRef,
  MatchReview,
  PlayCount,
  PlayEvent,
  Playlist,
  PlaylistEntry,
} from '../library/library.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import type { Like, Settings } from '../domain.ts';
import type { HlcStamp } from './hlc.ts';
import {
  decodeRecordId,
  entitySourceRefRecordId,
  likeRecordId,
  mappingRecordId,
  SETTINGS_RECORD_ID,
  sourceRefRecordId,
  TOMBSTONE_FIELD,
} from './sync-engine.ts';
import type {
  ChangeEntry,
  LocalWrite,
  MergeOutcome,
  SyncRecordKind,
} from './sync-engine.ts';
import {
  emissionWrites,
  entityDeleteWrites,
  entityUpsertWrites,
  projectAppliedEntries,
  recordingDeleteWrites,
  recordingUpsertWrites,
  reviewSyncWrites,
  settingsWrites,
} from './sync-projection.ts';
import type {
  SyncEmitInput,
  SyncProjectionInput,
} from './sync-projection.ts';
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

function mappingFor(recRef: SourceRef): SourceMapping {
  return {
    ref: recRef,
    status: 'user-confirmed',
    matchedAtMs: 5_000,
    evidence: {
      titleSimilarity: 1,
      artistSimilarity: 1,
      durationDeltaMs: 0,
      exactIsrc: true,
      score: 9,
      versionLabels: [],
    },
  };
}

function entity(id: string, kind: 'album' | 'artist'): Entity {
  return {
    entityId: id,
    kind,
    title: `Entity ${id}`,
    artistName: 'Artist Name',
    artwork: [],
    createdMs: 1_000,
  };
}

function entityRef(
  entityId: string,
  provider: string,
  id: string,
): EntitySourceRef {
  const entityRefValue: EntityRef = { provider, kind: 'album', id };
  return { entityId, provider, ref: entityRefValue };
}

function playlist(id: string): Playlist {
  return {
    playlistId: id,
    name: `Playlist ${id}`,
    createdMs: 100,
    updatedMs: 200,
  };
}

function entryRow(
  entryId: string,
  playlistId: string,
  recordingId: string,
): PlaylistEntry {
  return {
    entryId,
    playlistId,
    recordingId,
    position: 0,
    selectedRef: null,
    addedMs: 50,
  };
}

function playEvent(id: string, recordingId: string): PlayEvent {
  return {
    eventId: id,
    recordingId,
    occurrenceId: null,
    playedMs: 500,
    listenedMs: 500,
  };
}

function playCount(recordingId: string, count = 3, lastMs = 100): PlayCount {
  return { recordingId, count, lastMs };
}

function review(reviewId: string, recordingId: string): MatchReview {
  const candRef = ref('youtube-music', `c-${reviewId}`);
  return {
    reviewId,
    recordingId,
    candidates: [
      {
        metadata: {
          sourceRef: candRef,
          title: 'Candidate',
          artist: null,
          album: null,
          durationMs: null,
          releaseYear: null,
          artwork: [],
          explicit: null,
          genre: null,
          storefront: null,
        },
        ref: candRef,
      },
    ],
    status: 'pending',
    resolution: null,
    createdMs: 700,
    resolvedMs: null,
  };
}

function emitInput(partial: Partial<SyncEmitInput> = {}): SyncEmitInput {
  return {
    recordings: partial.recordings ?? [],
    likes: partial.likes ?? [],
    entities: partial.entities ?? [],
    entitySourceRefs: partial.entitySourceRefs ?? [],
    playlists: partial.playlists ?? [],
    playlistEntries: partial.playlistEntries ?? [],
    playHistory: partial.playHistory ?? [],
    playCounts: partial.playCounts ?? [],
    settings: partial.settings ?? SETTINGS,
    ...(partial.matchReviews !== undefined
      ? { matchReviews: partial.matchReviews }
      : {}),
  };
}

function queueEmpty(): QueueSnapshot {
  return {
    revision: 0,
    occurrences: [],
    currentOccurrenceId: null,
    positionMs: 0,
    mode: 'stopped',
  };
}

function projInput(
  partial: Partial<SyncProjectionInput> = {},
): SyncProjectionInput {
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
    downloads: partial.downloads ?? [],
    localFiles: partial.localFiles ?? [],
    queue: partial.queue ?? queueEmpty(),
    settings: partial.settings ?? SETTINGS,
  };
}

const DEV = 'device-remote';
let seqCounter = 0;

function stamp(l: number, c = 0): HlcStamp {
  return { l, c };
}

function fieldEntry(
  kind: SyncRecordKind,
  recordId: string,
  field: string,
  value: unknown,
  opts: { l?: number; c?: number; device?: string } = {},
): ChangeEntry {
  seqCounter += 1;
  return {
    kind,
    recordId,
    field,
    value,
    tombstone: false,
    // Entry identity is (deviceId, l, c) — mint a distinct counter per
    // call like a real device clock would.
    hlc: stamp(opts.l ?? 10, opts.c ?? seqCounter),
    deviceId: opts.device ?? DEV,
    seq: seqCounter,
  };
}

function tombstoneEntry(
  kind: SyncRecordKind,
  recordId: string,
  opts: { l?: number; c?: number; device?: string } = {},
): ChangeEntry {
  seqCounter += 1;
  return {
    kind,
    recordId,
    field: TOMBSTONE_FIELD,
    value: null,
    tombstone: true,
    hlc: stamp(opts.l ?? 10, opts.c ?? seqCounter),
    deviceId: opts.device ?? DEV,
    seq: seqCounter,
  };
}

function applied(
  entry: ChangeEntry,
  displaced: readonly ChangeEntry[] = [],
): MergeOutcome {
  return { type: 'applied', entry, displaced };
}

function isTombstone(write: LocalWrite): boolean {
  return (write as { tombstone?: boolean }).tombstone === true;
}

/* ------------------------------------------------------------------ */
/* recordId decode round-trip                                          */
/* ------------------------------------------------------------------ */

function testRecordIdDecode(): void {
  assertDeepEqual(
    decodeRecordId(likeRecordId('track', 'rec-1')),
    ['track', 'rec-1'],
    'like recordId decode',
  );
  assertDeepEqual(
    decodeRecordId(entitySourceRefRecordId('e-1', 'itunes')),
    ['e-1', 'itunes'],
    'entitySourceRef recordId decode',
  );
  const sr = ref('itunes', 'song 42');
  assertDeepEqual(
    decodeRecordId(sourceRefRecordId('rec-1', sr)),
    ['rec-1', 'itunes', 'track', 'song 42'],
    'sourceRef recordId decode (nested colons preserved)',
  );
  const mapping = mappingFor(sr);
  assertDeepEqual(
    decodeRecordId(mappingRecordId('rec-1', mapping)),
    ['rec-1', 'itunes', 'track', 'song 42', 'user-confirmed', '5000'],
    'mapping recordId decode',
  );
  // Malformed ids reject instead of decoding garbage.
  for (const bad of [
    'x',
    'abc',
    '2:a',
    '-1:a',
    '1:ab:cd',
    'foo:bar',
    '01',
  ]) {
    assertEqual(
      decodeRecordId(bad),
      null,
      `malformed recordId ${JSON.stringify(bad)} must reject`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* emission: per-kind LocalWrite builders                              */
/* ------------------------------------------------------------------ */

function testRecordingUpsertWrites(): void {
  const sr = ref('itunes', 't-1');
  const next = recording('r-1', [sr]);
  const writes = recordingUpsertWrites(next);
  const fields = writes.filter(
    (w) => w.kind === 'recording' && w.recordId === 'r-1',
  );
  assertEqual(
    fields.length,
    11,
    'recording upsert emits all 11 whitelisted fields',
  );
  assertDeepEqual(
    fields.map((w) => w.kind === 'recording' && 'field' in w ? (w as { field: string }).field : '?'),
    [
      'title',
      'artist',
      'album',
      'durationMs',
      'releaseYear',
      'artwork',
      'explicit',
      'genre',
      'isrc',
      'versionLabels',
      'provenance',
    ],
    'recording field order',
  );
  const refWrites = writes.filter((w) => w.kind === 'recordingSourceRef');
  assertEqual(refWrites.length, 1, 'one sourceRef presence write');
  assertEqual(
    refWrites[0]?.recordId,
    sourceRefRecordId('r-1', sr),
    'sourceRef write keyed by sourceRefRecordId',
  );

  // Update: a removed ref tombstones; the surviving one emits nothing.
  const replaced = ref('itunes', 't-2');
  const delta = recordingUpsertWrites(recording('r-1', [replaced]), next);
  const tombstones = delta.filter(
    (w) => w.kind === 'recordingSourceRef' && isTombstone(w),
  );
  assertEqual(tombstones.length, 1, 'removed ref tombstones');
  assertEqual(
    tombstones[0]?.recordId,
    sourceRefRecordId('r-1', sr),
    'tombstone names the removed ref',
  );
  const adds = delta.filter(
    (w) => w.kind === 'recordingSourceRef' && !isTombstone(w),
  );
  assertEqual(adds.length, 1, 'new ref upserts');

  // Mapping presence records emit with the 6-part mapping id.
  const withMapping = { ...next, mappings: [mappingFor(sr)] };
  const mapped = recordingUpsertWrites(withMapping, next);
  const mapWrites = mapped.filter((w) => w.kind === 'recordingMapping');
  assertEqual(mapWrites.length, 1, 'new mapping presence write');
  assertEqual(
    mapWrites[0]?.recordId,
    mappingRecordId('r-1', mappingFor(sr)),
    'mapping write keyed by mappingRecordId',
  );
}

function testRecordingDeleteWrites(): void {
  const sr = ref('itunes', 't-1');
  const rec = { ...recording('r-1', [sr]), mappings: [mappingFor(sr)] };
  const writes = recordingDeleteWrites(rec, {
    playlistEntries: [
      entryRow('pe-1', 'pl-1', 'r-1'),
      entryRow('pe-2', 'pl-1', 'other'),
    ],
    playHistory: [playEvent('ev-1', 'r-1'), playEvent('ev-2', 'other')],
    matchReviews: [review('rev-1', 'r-1'), review('rev-2', 'other')],
  });
  const kinds = writes.map((w) => w.kind);
  assert(writes.every(isTombstone), 'delete emits tombstones only');
  assertDeepEqual(
    kinds,
    [
      'recording',
      'recordingSourceRef',
      'recordingMapping',
      'playlistEntry',
      'playEvent',
      'playCount',
      'matchReview',
      'like',
    ],
    'delete cascade order: recording → refs → mappings → dependents → count/review → like',
  );
  assertEqual(
    writes.find((w) => w.kind === 'playlistEntry')?.recordId,
    'pe-1',
    'only this recording\'s playlist entry tombstones',
  );
  assertEqual(
    writes.find((w) => w.kind === 'playEvent')?.recordId,
    'ev-1',
    'only this recording\'s play event tombstones',
  );
  assertEqual(
    writes.find((w) => w.kind === 'like')?.recordId,
    likeRecordId('track', 'r-1'),
    'track like tombstones',
  );
}

function testEntityWrites(): void {
  const ent = entity('e-1', 'album');
  const refs = [entityRef('e-1', 'itunes', 'al-1')];
  const writes = entityUpsertWrites(ent, refs);
  assertEqual(
    writes.filter((w) => w.kind === 'entity').length,
    5,
    'entity upsert emits all 5 whitelisted fields',
  );
  const refWrites = writes.filter((w) => w.kind === 'entitySourceRef');
  assertEqual(refWrites.length, 1, 'entity ref presence write');
  assertEqual(
    refWrites[0]?.recordId,
    entitySourceRefRecordId('e-1', 'itunes'),
    'entity ref keyed (entityId, provider)',
  );

  // Provider removal tombstones.
  const delta = entityUpsertWrites(ent, [], refs);
  assertEqual(
    delta.filter((w) => w.kind === 'entitySourceRef' && isTombstone(w))
      .length,
    1,
    'vanished provider tombstones',
  );

  const deletes = entityDeleteWrites(ent, refs);
  assertDeepEqual(
    deletes.map((w) => w.kind),
    ['entity', 'entitySourceRef', 'like'],
    'entity delete: entity + refs + like',
  );
  assertEqual(
    deletes.find((w) => w.kind === 'like')?.recordId,
    likeRecordId('album', 'e-1'),
    'entity like uses the entity-kind like id',
  );
}

function testSettingsWrites(): void {
  const next: Settings = {
    ...SETTINGS,
    theme: 'dark',
    qualityKbps: 128,
    radioProvider: 'deezer',
  };
  const writes = settingsWrites(SETTINGS, next);
  assertDeepEqual(
    writes.map((w) => ('field' in w ? w.field : '?')),
    ['theme', 'radioProvider', 'qualityKbps'],
    'only changed whitelisted fields emit',
  );
  assert(writes.every((w) => w.recordId === SETTINGS_RECORD_ID));
}

function testEmissionWritesBatch(): void {
  const rec = recording('r-1', [ref('itunes', 't-1')]);
  const prev = emitInput({
    recordings: [rec],
    likes: [
      { entityKind: 'track', targetId: 'r-1', likedAtMs: 1 },
      { entityKind: 'track', targetId: 'gone', likedAtMs: 2 },
    ],
    playlists: [playlist('pl-1')],
    playlistEntries: [entryRow('pe-1', 'pl-1', 'r-1')],
    playHistory: [playEvent('ev-1', 'r-1')],
    matchReviews: [review('rev-1', 'r-1')],
  });
  const renamed = { ...rec, title: 'Renamed' };
  const writes = emissionWrites(prev, {
    recordings: [renamed],
    likes: [{ entityKind: 'track', targetId: 'r-1', likedAtMs: 1 }],
    playlists: [{ playlistId: 'pl-1', name: 'New', createdMs: 100, updatedMs: 300 }],
    playlistEntries: [],
    playHistory: [],
    settings: { ...SETTINGS, theme: 'dark' },
  });

  // Recording update: field writes for the changed row.
  assert(
    writes.some(
      (w) =>
        w.kind === 'recording' &&
        w.recordId === 'r-1' &&
        'field' in w &&
        w.field === 'title' &&
        w.value === 'Renamed',
    ),
    'recording update emits field writes',
  );
  // Like removed → tombstone for 'gone'.
  assert(
    writes.some(
      (w) =>
        w.kind === 'like' &&
        w.recordId === likeRecordId('track', 'gone') &&
        isTombstone(w),
    ),
    'removed like tombstones',
  );
  // Playlist rename: whitelisted fields only.
  assert(
    writes.some(
      (w) =>
        w.kind === 'playlist' &&
        w.recordId === 'pl-1' &&
        'field' in w &&
        w.field === 'name' &&
        w.value === 'New',
    ),
    'playlist rename emits name field',
  );
  // Playlist entry + play event removals → tombstones.
  assert(
    writes.some(
      (w) => w.kind === 'playlistEntry' && w.recordId === 'pe-1' && isTombstone(w),
    ),
    'removed playlist entry tombstones',
  );
  assert(
    writes.some(
      (w) => w.kind === 'playEvent' && w.recordId === 'ev-1' && isTombstone(w),
    ),
    'removed play event tombstones',
  );
  // Settings: only `theme` changed.
  const settingWrites = writes.filter((w) => w.kind === 'settings');
  assertDeepEqual(
    settingWrites.map((w) => ('field' in w ? w.field : '?')),
    ['theme'],
    'settings diff emits changed fields only',
  );
}

/* ------------------------------------------------------------------ */
/* inbound: projectAppliedEntries                                      */
/* ------------------------------------------------------------------ */

function testInboundRecordingInsert(): void {
  const sr = ref('itunes', 't-1');
  const outcomes = [
    applied(fieldEntry('recording', 'r-1', 'title', 'Remote Song')),
    applied(fieldEntry('recording', 'r-1', 'artist', 'Remote Artist')),
    applied(fieldEntry('recording', 'r-1', 'durationMs', 200_000)),
    applied(
      fieldEntry(
        'recordingSourceRef',
        sourceRefRecordId('r-1', sr),
        'ref',
        sr,
      ),
    ),
  ];
  const projected = projectAppliedEntries(outcomes, projInput());
  assertEqual(projected.pending.length, 0, 'insert materializes');
  assertEqual(projected.skipped.length, 0);
  const merged = projected.batch.recordingsMerge?.([]) ?? [];
  assertEqual(merged.length, 1, 'insert lands one recording');
  const rec = merged[0];
  assertEqual(rec?.title, 'Remote Song');
  assertEqual(rec?.artist, 'Remote Artist');
  // Missing fields get domain defaults — the row is never malformed.
  assertEqual(rec?.album, null);
  assertEqual(rec?.artwork.length, 0);
  assertEqual(rec?.provenance, 'provider');
  assertDeepEqual(rec?.sourceRefs, [sr]);
  assert(projected.changedKinds.includes('recording'));
}

function testInboundPartialInsertPending(): void {
  // A remote insert carrying only a ref (no field record yet) cannot
  // materialize — it pends until the field entries arrive.
  const sr = ref('itunes', 't-1');
  const outcomes = [
    applied(
      fieldEntry(
        'recordingSourceRef',
        sourceRefRecordId('r-1', sr),
        'ref',
        sr,
      ),
    ),
  ];
  const projected = projectAppliedEntries(outcomes, projInput());
  assertEqual(projected.pending.length, 1, 'field-less insert pends');
  assertEqual(
    projected.batch.recordingsMerge?.([]).length ?? 0,
    0,
    'pending rows never enter the batch',
  );

  // The next drain unions the pending outcomes with the field entries
  // — the fold dedupes + re-sorts so the record materializes whole.
  const merged = projectAppliedEntries(
    [
      ...projected.pending,
      applied(fieldEntry('recording', 'r-1', 'title', 'Arrived')),
    ],
    projInput(),
  );
  assertEqual(merged.pending.length, 0);
  const rows = merged.batch.recordingsMerge?.([]) ?? [];
  assertEqual(rows[0]?.title, 'Arrived');
  assertDeepEqual(rows[0]?.sourceRefs, [sr]);
}

function testInboundRecordingDeleteCascade(): void {
  const sr = ref('itunes', 't-1');
  const rec = recording('r-1', [sr]);
  const current = projInput({
    recordings: [rec, recording('keep', [ref('itunes', 't-9')])],
    likes: [
      { entityKind: 'track', targetId: 'r-1', likedAtMs: 1 },
      { entityKind: 'track', targetId: 'keep', likedAtMs: 1 },
    ],
    playlists: [playlist('pl-1')],
    playlistEntries: [
      entryRow('pe-1', 'pl-1', 'r-1'),
      entryRow('pe-2', 'pl-1', 'keep'),
    ],
    playHistory: [playEvent('ev-1', 'r-1'), playEvent('ev-2', 'keep')],
    playCounts: [playCount('r-1'), playCount('keep')],
    matchReviews: [review('rev-1', 'r-1'), review('rev-2', 'keep')],
    lyricsCache: [
      {
        recordingId: 'r-1',
        provider: 'lrclib',
        kind: 'plain',
        payload: {
          plainLyrics: 'la',
          syncedLyrics: null,
          instrumental: false,
        },
        fetchedMs: 1,
      },
    ],
    downloads: [
      {
        downloadId: 'd-1',
        recordingId: 'r-1',
        provider: 'itunes',
        sourceRef: { provider: 'itunes', kind: 'track', id: 't-1' },
        filePath: '/m/a.mp3',
        bytes: 100,
        state: 'available',
        committedOffset: 100,
        checksum: null,
        mime: 'audio/mpeg',
        itag: null,
        expiresAtMs: null,
        error: null,
        priority: 0,
        requestedMs: 1,
        downloadedMs: 1,
      },
    ],
    queue: {
      revision: 3,
      occurrences: [
        { occurrenceId: 'o-1', recordingId: 'r-1', selectedRef: null },
        { occurrenceId: 'o-2', recordingId: 'keep', selectedRef: null },
      ],
      currentOccurrenceId: 'o-1',
      positionMs: 0,
      mode: 'paused',
    },
  });
  const outcomes = [applied(tombstoneEntry('recording', 'r-1'))];
  const projected = projectAppliedEntries(outcomes, current);
  const merged = projected.batch.recordingsMerge?.(current.recordings) ?? [];
  assertDeepEqual(
    merged.map((r) => r.id),
    ['keep'],
    'tombstone deletes the recording',
  );
  // Cascade mirrors the domain delete: dependents of the dead row drop.
  assertDeepEqual(
    (projected.batch.likes ?? []).map((l) => l.targetId),
    ['keep'],
    'dead recording\'s like drops',
  );
  assertDeepEqual(
    (projected.batch.playlistEntries ?? []).map((e) => e.entryId),
    ['pe-2'],
    'dead recording\'s playlist entries drop',
  );
  assertDeepEqual(
    (projected.batch.playHistory ?? []).map((e) => e.eventId),
    ['ev-2'],
    'dead recording\'s play events drop',
  );
  assertDeepEqual(
    (projected.batch.playCounts ?? []).map((c) => c.recordingId),
    ['keep'],
    'dead recording\'s play count drops',
  );
  assertDeepEqual(
    (projected.batch.matchReviews ?? []).map((r) => r.reviewId),
    ['rev-2'],
    'dead recording\'s reviews drop',
  );
  assertEqual(projected.batch.lyricsCache?.length, 0, 'lyrics drop');
  assertEqual(projected.batch.downloads?.length, 0, 'downloads drop');
  const queue = projected.batch.queue;
  assert(queue !== undefined, 'queue replays removals');
  assertDeepEqual(
    queue?.occurrences.map((o) => o.occurrenceId),
    ['o-2'],
    'dead recording\'s queue occurrences drop via QueueEngine.remove',
  );
}

function testInboundLikes(): void {
  const rec = recording('r-1', [ref('itunes', 't-1')]);
  const current = projInput({ recordings: [rec] });
  const add: Like = {
    entityKind: 'track',
    targetId: 'r-1',
    likedAtMs: 42,
  };
  const outcomes = [
    applied(fieldEntry('like', likeRecordId('track', 'r-1'), 'like', add)),
  ];
  const projected = projectAppliedEntries(outcomes, current);
  assertDeepEqual(projected.batch.likes, [add], 'like upserts');

  const removed = projectAppliedEntries(
    [applied(tombstoneEntry('like', likeRecordId('track', 'r-1')))],
    projInput({ recordings: [rec], likes: [add] }),
  );
  assertDeepEqual(removed.batch.likes, [], 'like tombstone removes');
}

function testInboundEntityPlusRef(): void {
  const ent = entity('e-1', 'artist');
  const outcomes = [
    applied(fieldEntry('entity', 'e-1', 'kind', 'artist')),
    applied(fieldEntry('entity', 'e-1', 'title', 'Artist Name')),
    applied(fieldEntry('entity', 'e-1', 'createdMs', 900)),
    applied(
      fieldEntry(
        'entitySourceRef',
        entitySourceRefRecordId('e-1', 'itunes'),
        'ref',
        { provider: 'itunes', kind: 'artist', id: 'a-1' },
      ),
    ),
  ];
  const projected = projectAppliedEntries(outcomes, projInput());
  const rows = projected.batch.entities ?? [];
  assertEqual(rows.length, 1, 'entity inserts');
  assertEqual(rows[0]?.entityId, 'e-1');
  assertEqual(rows[0]?.kind, 'artist');
  const refs = projected.batch.entitySourceRefs ?? [];
  assertEqual(refs.length, 1, 'entity sourceRef lands');
  assertEqual(refs[0]?.provider, 'itunes');
}

function testInboundPlaylistAndEntry(): void {
  const rec = recording('r-1', [ref('itunes', 't-1')]);
  const current = projInput({
    recordings: [rec],
    playlists: [playlist('pl-1')],
  });
  const outcomes = [
    applied(
      fieldEntry('playlistEntry', 'pe-9', 'playlistId', 'pl-1'),
    ),
    applied(
      fieldEntry('playlistEntry', 'pe-9', 'recordingId', 'r-1'),
    ),
    applied(fieldEntry('playlistEntry', 'pe-9', 'position', 2)),
    applied(fieldEntry('playlistEntry', 'pe-9', 'addedMs', 700)),
  ];
  const projected = projectAppliedEntries(outcomes, current);
  const entries = projected.batch.playlistEntries ?? [];
  assertEqual(entries.length, 1, 'playlist entry inserts');
  assertDeepEqual(
    {
      playlistId: entries[0]?.playlistId,
      recordingId: entries[0]?.recordingId,
      position: entries[0]?.position,
      addedMs: entries[0]?.addedMs,
    },
    { playlistId: 'pl-1', recordingId: 'r-1', position: 2, addedMs: 700 },
    'entry fields fold',
  );

  // Playlist delete → playlist + entry tombstones mirror.
  const withEntry = projInput({
    recordings: [rec],
    playlists: [playlist('pl-1')],
    playlistEntries: [entryRow('pe-9', 'pl-1', 'r-1')],
  });
  const deleted = projectAppliedEntries(
    [
      applied(tombstoneEntry('playlist', 'pl-1')),
      applied(tombstoneEntry('playlistEntry', 'pe-9')),
    ],
    withEntry,
  );
  assertDeepEqual(deleted.batch.playlists, [], 'playlist tombstone deletes');
  assertDeepEqual(
    deleted.batch.playlistEntries,
    [],
    'entry tombstone removes the row',
  );
}

function testInboundPlayRows(): void {
  const rec = recording('r-1', [ref('itunes', 't-1')]);
  const current = projInput({
    recordings: [rec],
    playCounts: [playCount('r-1', 3, 100)],
  });
  const event = playEvent('ev-9', 'r-1');
  const outcomes = [
    applied(fieldEntry('playEvent', 'ev-9', 'event', event)),
    // 'sum' merge: the applied outcome's displaced[0] is the prior
    // component winner — domain fold adds only the delta.
    applied(fieldEntry('playCount', 'r-1', 'count', 5), [
      fieldEntry('playCount', 'r-1', 'count', 3, { device: 'device-old' }),
    ]),
    applied(fieldEntry('playCount', 'r-1', 'lastMs', 600)),
  ];
  const projected = projectAppliedEntries(outcomes, current);
  assertDeepEqual(
    (projected.batch.playHistory ?? []).map((e) => e.eventId),
    ['ev-9'],
    'play event inserts',
  );
  assertDeepEqual(projected.batch.playCounts, [
    { recordingId: 'r-1', count: 5, lastMs: 600 },
  ]);
  // count: 3 + (5 − displaced 3) = 5; lastMs 'max': 600 wins.
}

function testInboundMatchReview(): void {
  const rec = recording('r-1', [ref('itunes', 't-1')]);
  const current = projInput({
    recordings: [rec],
    matchReviews: [review('rev-1', 'r-1')],
  });
  const outcomes = [
    applied(fieldEntry('matchReview', 'rev-1', 'status', 'confirmed')),
    applied(
      fieldEntry('matchReview', 'rev-1', 'resolution', {
        ref: null,
      }),
    ),
    applied(fieldEntry('matchReview', 'rev-1', 'resolvedMs', 900)),
  ];
  const projected = projectAppliedEntries(outcomes, current);
  const reviews = projected.batch.matchReviews ?? [];
  assertEqual(reviews.length, 1);
  assertEqual(reviews[0]?.status, 'confirmed');
  assertDeepEqual(reviews[0]?.resolution, { ref: null });
  assertEqual(reviews[0]?.resolvedMs, 900);

  // A review insert from a remote device can't materialize — the
  // whitelist has no recordingId/createdMs; it lands in skipped, not
  // pending (it can never satisfy its fields later).
  const inserted = projectAppliedEntries(
    [applied(fieldEntry('matchReview', 'rev-new', 'status', 'pending'))],
    projInput({ recordings: [rec] }),
  );
  assert(
    inserted.skipped.some(
      (s) => s.kind === 'matchReview' && s.reason === 'unmaterializable',
    ),
    'remote review insert reports unmaterializable',
  );
  assertEqual(inserted.batch.matchReviews?.length ?? 0, 0);
}

function testInboundSettings(): void {
  const outcomes = [
    applied(
      fieldEntry('settings', SETTINGS_RECORD_ID, 'theme', 'dark'),
    ),
    applied(
      fieldEntry('settings', SETTINGS_RECORD_ID, 'qualityKbps', 128),
    ),
  ];
  const projected = projectAppliedEntries(outcomes, projInput());
  const next = projected.batch.settings;
  assertEqual(next?.theme, 'dark');
  assertEqual(next?.qualityKbps, 128);
  assertEqual(next?.storefront, 'US', 'untouched fields preserved');
}

function testInboundUnknownInsertDefaults(): void {
  // A recording update on an id this device never had materializes
  // once the minimal required fields (title) arrive.
  const outcomes = [
    applied(fieldEntry('recording', 'r-new', 'title', 'Ghost')),
    applied(
      fieldEntry(
        'recordingSourceRef',
        sourceRefRecordId('r-new', ref('deezer', 'd-1')),
        'ref',
        ref('deezer', 'd-1'),
      ),
    ),
  ];
  const projected = projectAppliedEntries(outcomes, projInput());
  const merged = projected.batch.recordingsMerge?.([]) ?? [];
  assertEqual(merged.length, 1);
  assertEqual(merged[0]?.title, 'Ghost');
  assertEqual(merged[0]?.durationMs, null, 'missing duration defaults');
}

function testInboundSupersededAndInvalid(): void {
  const rec = recording('r-1', [ref('itunes', 't-1')]);
  const current = projInput({ recordings: [rec] });
  // 'superseded' outcomes are ignored — the loser does not overwrite.
  const loser = fieldEntry('recording', 'r-1', 'title', 'Loser Title', {
    l: 5,
  });
  const winner = fieldEntry('recording', 'r-1', 'title', 'Winner', {
    l: 9,
  });
  const outcomes: MergeOutcome[] = [
    { type: 'superseded', entry: loser, winner },
  ];
  const projected = projectAppliedEntries(outcomes, current);
  assertEqual(
    projected.batch.recordingsMerge,
    undefined,
    'superseded entries never touch the recordings batch',
  );

  // Wire-malformed outcomes skip typed — never crash, never log ids.
  const malformed: MergeOutcome[] = [
    {
      type: 'applied',
      entry: { kind: 'like' } as unknown as ChangeEntry,
      displaced: [],
    },
    applied(fieldEntry('like', likeRecordId('track', 'r-1'), 'like', {
      entityKind: 'track',
      targetId: 'r-1',
      likedAtMs: 1,
    })),
  ];
  const folded = projectAppliedEntries(malformed, current);
  assert(
    folded.skipped.some(
      (s) => s.kind === 'unknown' && s.reason === 'invalid',
    ),
    'malformed outcome reports invalid',
  );
  assertDeepEqual(
    folded.batch.likes,
    [{ entityKind: 'track', targetId: 'r-1', likedAtMs: 1 }],
    'valid siblings still fold',
  );
}

function testInboundFieldMergeOnExisting(): void {
  const rec = recording('r-1', [ref('itunes', 't-1')]);
  const current = projInput({ recordings: [rec] });
  const outcomes = [
    applied(fieldEntry('recording', 'r-1', 'title', 'Updated')),
    applied(fieldEntry('recording', 'r-1', 'genre', 'jazz')),
  ];
  const projected = projectAppliedEntries(outcomes, current);
  const merged = projected.batch.recordingsMerge?.([rec]) ?? [];
  assertEqual(merged[0]?.title, 'Updated');
  assertEqual(merged[0]?.genre, 'jazz');
  assertEqual(merged[0]?.artist, 'Artist', 'untouched fields preserved');
}

function testInboundIdempotentReplay(): void {
  const sr = ref('itunes', 't-1');
  const outcomes = [
    applied(fieldEntry('recording', 'r-1', 'title', 'Once')),
    applied(
      fieldEntry(
        'recordingSourceRef',
        sourceRefRecordId('r-1', sr),
        'ref',
        sr,
      ),
    ),
  ];
  // Replaying the same outcomes (drain retry) is a no-op — dedupe by
  // entry key.
  const projected = projectAppliedEntries(
    [...outcomes, ...outcomes],
    projInput(),
  );
  const merged = projected.batch.recordingsMerge?.([]) ?? [];
  assertEqual(merged.length, 1, 'replay dedupes to one insert');
}

/* ------------------------------------------------------------------ */

export function run(): void {
  testRecordIdDecode();
  testRecordingUpsertWrites();
  testRecordingDeleteWrites();
  testEntityWrites();
  testSettingsWrites();
  testEmissionWritesBatch();
  testInboundRecordingInsert();
  testInboundPartialInsertPending();
  testInboundRecordingDeleteCascade();
  testInboundLikes();
  testInboundEntityPlusRef();
  testInboundPlaylistAndEntry();
  testInboundPlayRows();
  testInboundMatchReview();
  testInboundSettings();
  testInboundUnknownInsertDefaults();
  testInboundSupersededAndInvalid();
  testInboundFieldMergeOnExisting();
  testInboundIdempotentReplay();
}
