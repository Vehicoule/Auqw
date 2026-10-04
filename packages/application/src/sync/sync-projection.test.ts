import type {
  EntityRef,
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
  syncFieldRule,
  TOMBSTONE_FIELD,
} from './sync-engine.ts';
import type {
  ChangeEntry,
  LocalWrite,
  MaterializedRecord,
  MergeOutcome,
  SyncRecordKind,
} from './sync-engine.ts';
import {
  emissionWrites,
  entityDeleteWrites,
  entityUpsertWrites,
  projectAppliedEntries,
  projectMaterialized,
  recordingDeleteWrites,
  recordingUpsertWrites,
  settingsWrites,
  unsyncedWrites,
} from './sync-projection.ts';
import type {
  SyncEmitEvidence,
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
    ...(partial.deviceId !== undefined
      ? { deviceId: partial.deviceId }
      : {}),
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
  record?: MaterializedRecord,
): MergeOutcome {
  return record === undefined
    ? { type: 'applied', entry, displaced }
    : { type: 'applied', entry, displaced, record };
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

function testArtworkEmissionPortable(): void {
  // `file://` art-store refs are device-local: they never enter a
  // delta, so a receiving device re-derives cover art from the
  // backing file instead of holding a dead path that blocks backfill.
  const fileArt = {
    url: 'file:///home/u/.config/auqw/art/abc.png',
    width: null,
    height: null,
  };
  const httpsArt = {
    url: 'https://images.example.com/a.jpg',
    width: 100,
    height: 100,
  };
  const rec = recording('r-1', [ref('itunes', 't-1')]);
  const writes = recordingUpsertWrites({
    ...rec,
    artwork: [fileArt, httpsArt],
  });
  const artWrite = writes.find(
    (w) => w.kind === 'recording' && 'field' in w && w.field === 'artwork',
  );
  assertDeepEqual(
    artWrite !== undefined && 'value' in artWrite ? artWrite.value : null,
    [httpsArt],
    'recording artwork emits portable refs only',
  );

  const entWrites = entityUpsertWrites(
    { ...entity('e-1', 'album'), artwork: [fileArt] },
    [],
  );
  const entArt = entWrites.find(
    (w) => w.kind === 'entity' && 'field' in w && w.field === 'artwork',
  );
  assertDeepEqual(
    entArt !== undefined && 'value' in entArt ? entArt.value : null,
    [],
    'entity artwork emits portable refs only',
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
    ['radioProvider', 'qualityKbps'],
    'changed whitelisted fields emit; device-local theme does not',
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
    settings: { ...SETTINGS, language: 'fr' },
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
  // Settings: only `language` changed.
  const settingWrites = writes.filter((w) => w.kind === 'settings');
  assertDeepEqual(
    settingWrites.map((w) => ('field' in w ? w.field : '?')),
    ['language'],
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

  // A remote review carrying only `status` lacks its immutable
  // identity (recordingId/createdMs) — it pends, never skipped: a
  // later page may still deliver the identity fields (Review #46).
  const inserted = projectAppliedEntries(
    [applied(fieldEntry('matchReview', 'rev-new', 'status', 'pending'))],
    projInput({ recordings: [rec] }),
  );
  assertEqual(
    inserted.pending.length,
    1,
    'identity-less remote review pends',
  );
  assertEqual(inserted.batch.matchReviews?.length ?? 0, 0);

  // Identity-bearing first-seen-remote review materializes whole
  // against a live parent recording.
  const remote = projectAppliedEntries(
    [
      applied(fieldEntry('matchReview', 'rev-2', 'recordingId', 'r-1')),
      applied(fieldEntry('matchReview', 'rev-2', 'createdMs', 700)),
      applied(
        fieldEntry(
          'matchReview',
          'rev-2',
          'candidates',
          review('rev-2', 'r-1').candidates,
        ),
      ),
    ],
    projInput({ recordings: [rec] }),
  );
  const landed = remote.batch.matchReviews ?? [];
  assertEqual(landed.length, 1, 'remote review inserts');
  assertEqual(landed[0]?.recordingId, 'r-1');
  assertEqual(landed[0]?.status, 'pending');
  assertEqual(landed[0]?.createdMs, 700);

  // The same review against a missing parent pends until the
  // recording arrives.
  const orphan = projectAppliedEntries(
    [
      applied(fieldEntry('matchReview', 'rev-3', 'recordingId', 'r-x')),
      applied(fieldEntry('matchReview', 'rev-3', 'createdMs', 700)),
    ],
    projInput({ recordings: [rec] }),
  );
  assertEqual(
    orphan.pending.length,
    2,
    'parent-less remote review pends',
  );
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
  assertEqual(next?.theme, 'system', 'theme is device-local — never applied');
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

/* ------------------------------------------------------------------ */
/* regressions                                                          */
/* ------------------------------------------------------------------ */

// A mapping tombstone removes ONLY its own key — unrelated mappings
// on the same recording survive (Devin Review #46).
function testMappingTombstoneKeepsOthers(): void {
  const r1 = ref('itunes', 't-1');
  const r2 = ref('deezer', 'd-2');
  const m1 = mappingFor(r1);
  const m2 = { ...mappingFor(r2), matchedAtMs: 9_000 };
  const rec: Recording = { ...recording('r-1', [r1, r2]), mappings: [m1, m2] };
  const projected = projectAppliedEntries(
    [
      applied(
        tombstoneEntry('recordingMapping', mappingRecordId('r-1', m1)),
      ),
    ],
    projInput({ recordings: [rec] }),
  );
  const merged = projected.batch.recordingsMerge?.([rec]) ?? [];
  assertEqual(merged.length, 1, 'recording stays');
  const kept = merged[0]?.mappings ?? [];
  assertEqual(kept.length, 1, 'other mapping survives the tombstone');
  assertEqual(kept[0]?.matchedAtMs, 9_000);
}

// An entitySourceRef field entry REPLACES the (entityId, provider)
// row — never appends a duplicate (Devin Review #46).
function testEntityRefUpdateReplaces(): void {
  const current = projInput({
    entities: [entity('al-1', 'album')],
    entitySourceRefs: [entityRef('al-1', 'itunes', 'old-id')],
  });
  const projected = projectAppliedEntries(
    [
      applied(
        fieldEntry(
          'entitySourceRef',
          entitySourceRefRecordId('al-1', 'itunes'),
          'ref',
          { provider: 'itunes', kind: 'album', id: 'new-id' },
        ),
      ),
    ],
    current,
  );
  const rows = projected.batch.entitySourceRefs ?? [];
  assertEqual(rows.length, 1, 'same-key update replaces, not duplicates');
  assertEqual(rows[0]?.ref.id, 'new-id');
}

/* ------------------------------------------------------------------ */
/* round-3: ref-change emission, snapshots, materialized recovery      */
/* ------------------------------------------------------------------ */

// UoXN — a same-provider entitySourceRef CHANGE emits an upsert;
// presence-only keying would silently absorb the edit.
function testEntityRefChangeEmits(): void {
  const ent = entity('e-1', 'album');
  const prev = [entityRef('e-1', 'itunes', 'al-old')];
  const next = [entityRef('e-1', 'itunes', 'al-new')];
  const writes = entityUpsertWrites(ent, next, prev);
  const refWrites = writes.filter(
    (w) => w.kind === 'entitySourceRef' && !isTombstone(w),
  );
  assertEqual(refWrites.length, 1, 'changed ref emits an upsert');
  assertEqual(
    (refWrites[0] as { value: EntityRef }).value.id,
    'al-new',
    'upsert carries the new ref',
  );
  const same = entityUpsertWrites(ent, prev, prev);
  assertEqual(
    same.filter((w) => w.kind === 'entitySourceRef').length,
    0,
    'unchanged ref emits nothing',
  );
}

// UoQ3 — a delayed tombstone that lost to newer fields must not
// delete the row the engine still materializes.
function testSnapshotSurvivesTombstone(): void {
  const current = projInput({
    recordings: [recording('r-1', [ref('itunes', 't-1')])],
  });
  const outcome = applied(tombstoneEntry('recording', 'r-1'), [], {
    kind: 'recording',
    recordId: 'r-1',
    fields: { title: 'Still Alive', artist: 'A' },
  });
  const projected = projectAppliedEntries([outcome], current);
  const rows = projected.batch.recordingsMerge?.(current.recordings) ?? [];
  assertEqual(rows.length, 1, 'snapshot with fields keeps the row');
  assertEqual(rows[0]?.title, 'Still Alive');
}

// Empty snapshot = the engine's "fully deleted" — the row goes.
function testSnapshotEmptyDeletes(): void {
  const current = projInput({
    recordings: [recording('r-1', [ref('itunes', 't-1')])],
  });
  const outcome = applied(tombstoneEntry('recording', 'r-1'), [], {
    kind: 'recording',
    recordId: 'r-1',
    fields: {},
  });
  const projected = projectAppliedEntries([outcome], current);
  assertDeepEqual(
    projected.batch.recordingsMerge?.(current.recordings),
    [],
    'empty snapshot deletes the row',
  );
}

// Snapshot counts are ABSOLUTE (materialized truth), not deltas —
// replaying the same drain can't double a play count.
function testSnapshotCountAbsolute(): void {
  const current = projInput({
    recordings: [recording('r-1', [ref('itunes', 't-1')])],
    playCounts: [playCount('r-1', 5)],
  });
  const outcome = applied(
    fieldEntry('playCount', 'r-1', 'count', 2),
    [],
    {
      kind: 'playCount',
      recordId: 'r-1',
      fields: { count: 7, lastMs: 900 },
    },
  );
  const projected = projectAppliedEntries([outcome], current);
  const counts = projected.batch.playCounts ?? [];
  assertEqual(counts[0]?.count, 7, 'snapshot count applies absolute');
  const replay = projectAppliedEntries(
    [outcome],
    projInput({
      recordings: current.recordings,
      playCounts: counts,
    }),
  );
  assertEqual(
    replay.batch.playCounts?.[0]?.count ?? 7,
    7,
    'replayed drain stays idempotent',
  );
}

// `count - ourComponent - loggedRemote` is exactly the plays the
// log never saw — a remote share deleted inside the page folds
// away, while the unsent surplus above the live components survives.
function testSnapshotCountFloorHonorsTombstone(): void {
  const current = projInput({
    recordings: [recording('r-1', [ref('itunes', 't-1')])],
    playCounts: [
      { recordingId: 'r-1', count: 10, lastMs: 100, loggedRemote: 10 },
    ],
    deviceId: 'dev-us',
  });
  const outcome = applied(
    fieldEntry('playCount', 'r-1', 'count', 2),
    [],
    {
      kind: 'playCount',
      recordId: 'r-1',
      fields: { count: 7, lastMs: 900 },
      // All-remote baseline, peer's component deleted in-page.
      sumComponents: { count: { 'peer-x': 7 } },
    },
  );
  const projected = projectAppliedEntries([outcome], current);
  const folded = projected.batch.playCounts?.[0];
  assertEqual(
    folded?.count,
    7,
    'a deleted logged component folds to the page',
  );
  assertEqual(
    folded?.loggedRemote,
    7,
    'the page restamps the remote baseline',
  );
}

// Delivered plays stop counting as unsent: our live component
// reads out of the page, so a successfully emitted play doesn't
// double — and replaying the same page can't regrow it.
function testSnapshotCountFloorDeliveredPlays(): void {
  const current = projInput({
    recordings: [recording('r-1', [ref('itunes', 't-1')])],
    playCounts: [
      { recordingId: 'r-1', count: 11, lastMs: 100, loggedRemote: 0 },
    ],
    deviceId: 'dev-us',
  });
  const outcome = applied(
    fieldEntry('playCount', 'r-1', 'count', 2),
    [],
    {
      kind: 'playCount',
      recordId: 'r-1',
      fields: { count: 11, lastMs: 900 },
      sumComponents: { count: { 'dev-us': 11 } },
    },
  );
  const projected = projectAppliedEntries([outcome], current);
  const folded = projected.batch.playCounts?.[0];
  assertEqual(
    folded?.count,
    11,
    'a delivered play folds once, not twice',
  );
  assertEqual(
    projectAppliedEntries([outcome], {
      ...current,
      playCounts: folded === undefined ? [] : [folded],
    }).batch.playCounts?.[0]?.count,
    11,
    'replaying the same page does not inflate',
  );
}

// A tombstone removing OUR component stays deleted: `loggedOurs`
// marks the share that already delivered, so the page's shrink
// reads as deletion — not stranded plays to resurrect.
function testSnapshotCountFloorHonorsOurTombstone(): void {
  const current = projInput({
    recordings: [recording('r-1', [ref('itunes', 't-1')])],
    playCounts: [
      {
        recordingId: 'r-1',
        count: 10,
        lastMs: 100,
        loggedRemote: 7,
        loggedOurs: 3,
      },
    ],
    deviceId: 'dev-us',
  });
  const outcome = applied(
    fieldEntry('playCount', 'r-1', 'count', 2),
    [],
    {
      kind: 'playCount',
      recordId: 'r-1',
      fields: { count: 7, lastMs: 900 },
      // Our 3 is gone from the log; the peer's 7 remains.
      sumComponents: { count: { 'peer-x': 7 } },
    },
  );
  const folded = projectAppliedEntries([outcome], current).batch
    .playCounts?.[0];
  assertEqual(
    folded?.count,
    7,
    'our tombstoned component stays deleted',
  );
  assertEqual(
    folded?.loggedOurs,
    0,
    'the stamp re-anchors at the live share',
  );
  assertEqual(
    projectAppliedEntries([outcome], {
      ...current,
      playCounts: folded === undefined ? [] : [folded],
    }).batch.playCounts?.[0]?.count,
    7,
    'replay does not resurrect the deleted share',
  );
  // Delete-then-new-play before any fold: the page carries our new
  // delivered component, so BOTH the old stamp and the new share
  // come out — stored 11 (10 + the new play), page ours 1 + peer 7
  // = 8, nothing unsent.
  const regrown = projInput({
    recordings: current.recordings,
    playCounts: [
      {
        recordingId: 'r-1',
        count: 11,
        lastMs: 100,
        loggedRemote: 7,
        loggedOurs: 3,
      },
    ],
    deviceId: 'dev-us',
  });
  const regrownOutcome = applied(
    fieldEntry('playCount', 'r-1', 'count', 3),
    [],
    {
      kind: 'playCount',
      recordId: 'r-1',
      fields: { count: 8, lastMs: 950 },
      sumComponents: { count: { 'dev-us': 1, 'peer-x': 7 } },
    },
  );
  const refolded = projectAppliedEntries([regrownOutcome], regrown)
    .batch.playCounts?.[0];
  assertEqual(
    refolded?.count,
    8,
    'a delivered new play does not duplicate over the tombstone',
  );
  assertEqual(refolded?.loggedOurs, 1, 'the stamp re-anchors live');
}

// The baseline keeps plays the log never saw — stranded increments
// and imported totals — and remote growth between pages can't eat
// them: stored 300, baseline remote 70, page ours 30 + remote 120.
function testSnapshotCountFloorsAtLoggedRemote(): void {
  const current = projInput({
    recordings: [recording('r-1', [ref('itunes', 't-1')])],
    playCounts: [
      { recordingId: 'r-1', count: 300, lastMs: 100, loggedRemote: 70 },
    ],
    deviceId: 'dev-us',
  });
  const outcome = applied(
    fieldEntry('playCount', 'r-1', 'count', 3),
    [],
    {
      kind: 'playCount',
      recordId: 'r-1',
      fields: { count: 150, lastMs: 900 },
      sumComponents: { count: { 'dev-us': 30, 'peer-x': 120 } },
    },
  );
  const projected = projectAppliedEntries([outcome], current);
  const folded = projected.batch.playCounts?.[0];
  // unsent = 300 - 30 - 70 = 200; merged = 150 + 200 = 350.
  assertEqual(folded?.count, 350, 'the unsent surplus survives');
  assertEqual(folded?.loggedRemote, 120, 'the baseline re-anchors');
  // A row that never stamped a baseline falls back to the
  // local-count floor — conservative, never over-claims.
  const legacy = projInput({
    recordings: current.recordings,
    playCounts: [
      { recordingId: 'r-1', count: 11, lastMs: 100, localCount: 5 },
    ],
    deviceId: 'dev-us',
  });
  const page = applied(
    fieldEntry('playCount', 'r-1', 'count', 2),
    [],
    {
      kind: 'playCount',
      recordId: 'r-1',
      fields: { count: 10, lastMs: 900 },
      sumComponents: { count: { 'dev-us': 5, 'peer-x': 5 } },
    },
  );
  assertEqual(
    projectAppliedEntries([page], legacy).batch.playCounts?.[0]
      ?.count,
    11,
    'baseline-less rows keep the bounded local surplus',
  );
}

// W98I — several applied outcomes may snapshot the same record; the
// LAST one in canonical order is the merge truth. Picking the first
// rewinds the row to a stale generation.
function testSnapshotNewestWins(): void {
  const sr = ref('itunes', 't-1');
  const current = projInput();
  const outcomes = [
    // The dependent that pends while its parent recording is missing.
    applied(fieldEntry('matchReview', 'rev-1', 'recordingId', 'r-1')),
    applied(fieldEntry('matchReview', 'rev-1', 'createdMs', 700)),
    applied(
      fieldEntry(
        'matchReview',
        'rev-1',
        'candidates',
        review('rev-1', 'r-1').candidates,
      ),
    ),
    // Older retained outcome for r-1 — its snapshot is already stale.
    applied(fieldEntry('recording', 'r-1', 'title', 'Older'), [], {
      kind: 'recording',
      recordId: 'r-1',
      fields: { title: 'Older', artist: 'Stale' },
    }),
    // Newer outcome for the same record — its snapshot must win.
    applied(fieldEntry('recording', 'r-1', 'artist', 'B'), [], {
      kind: 'recording',
      recordId: 'r-1',
      fields: { title: 'Newer', artist: 'B' },
    }),
    // The dependency that resolves the row (and frees the pending
    // review): the source-ref presence that makes r-1 insertable.
    applied(
      fieldEntry(
        'recordingSourceRef',
        sourceRefRecordId('r-1', sr),
        'ref',
        sr,
      ),
    ),
  ];
  const projected = projectAppliedEntries(outcomes, current);
  assertEqual(projected.pending.length, 0, 'dependency resolves pending');
  const rows =
    projected.batch.recordingsMerge?.(current.recordings) ?? [];
  assertEqual(rows[0]?.title, 'Newer', 'newest snapshot wins');
  assertEqual(rows[0]?.artist, 'B');
  assertDeepEqual(
    (projected.batch.matchReviews ?? []).map((r) => r.reviewId),
    ['rev-1'],
    'pending review lands with its parent',
  );
}

// The materialized recovery path: records rebuild rows, absent
// records keep existing rows, empty-field records delete.
function testProjectMaterialized(): void {
  const current = projInput({
    recordings: [
      recording('r-keep', [ref('itunes', 'k-1')]),
      recording('r-dead', [ref('itunes', 'd-1')]),
    ],
    likes: [{ entityKind: 'track', targetId: 'r-keep', likedAtMs: 1 }],
  });
  const srNew = ref('itunes', 'n-1');
  const projected = projectMaterialized(
    [
      {
        kind: 'recording',
        recordId: 'r-new',
        fields: {
          title: 'New',
          artist: 'N',
          album: 'AL',
          durationMs: 100,
        },
      },
      {
        kind: 'recordingSourceRef',
        recordId: sourceRefRecordId('r-new', srNew),
        fields: { ref: srNew },
      },
      { kind: 'recording', recordId: 'r-dead', fields: {} },
      {
        kind: 'recording',
        recordId: 'r-keep',
        fields: { title: 'Kept', artist: 'K' },
      },
    ],
    current,
  );
  const rows = projected.batch.recordingsMerge?.(current.recordings) ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert(byId.has('r-new'), 'materialized insert lands');
  assert(!byId.has('r-dead'), 'empty record deletes');
  assertEqual(byId.get('r-keep')?.title, 'Kept', 'materialized refresh');
  // The like never synced — absent from the materialized set — and
  // must stay, not get deleted.
  assertEqual(
    (projected.batch.likes ?? current.likes).length,
    1,
    'unsynced row keeps',
  );
}

// Staged projection (Review #46): a dependent materialized ahead of
// its parent lands nowhere — it rides `pendingRecords` into the next
// call and lands once the parent arrives, instead of either dropping
// or forcing the whole materialized view into memory at once.
function testProjectMaterializedPending(): void {
  const current = projInput({ recordings: [], likes: [] });
  const likeRec: MaterializedRecord = {
    kind: 'like',
    recordId: likeRecordId('track', 'r-x'),
    fields: {
      like: { entityKind: 'track', targetId: 'r-x', likedAtMs: 7 },
    },
  };
  const first = projectMaterialized([likeRec], current);
  assertEqual(
    first.batch.likes,
    undefined,
    'dependent before parent lands nothing',
  );
  assertDeepEqual(
    first.pendingRecords,
    [likeRec],
    'unmaterializable record rides pending',
  );
  const parentRef = ref('itunes', 'x-1');
  const second = projectMaterialized(
    [
      ...first.pendingRecords,
      {
        kind: 'recording',
        recordId: 'r-x',
        fields: { title: 'X', artist: 'X', album: 'A', durationMs: 1 },
      },
      {
        kind: 'recordingSourceRef',
        recordId: sourceRefRecordId('r-x', parentRef),
        fields: { ref: parentRef },
      },
    ],
    projInput({ recordings: [], likes: [] }),
  );
  assertDeepEqual(
    second.batch.likes,
    [{ entityKind: 'track', targetId: 'r-x', likedAtMs: 7 }],
    'retained dependent lands once the parent arrives',
  );
  assertDeepEqual(
    second.pendingRecords,
    [],
    'resolved dependents leave pending',
  );
}

// The materialized guard enforces the delta path's per-field rules:
// a record carrying a whitelisted field with a bad value, or a field
// the whitelist never heard of, quarantines as skipped instead of
// being cast into a row — while a rule-conformant sibling lands.
function testProjectMaterializedSkipsInvalid(): void {
  const current = projInput({ recordings: [], likes: [] });
  const goodRef = ref('itunes', 'g-1');
  const projected = projectMaterialized(
    [
      {
        kind: 'recording',
        recordId: 'r-bad',
        fields: { title: 42 },
      },
      {
        kind: 'recording',
        recordId: 'r-off',
        fields: { title: 'ok', sessionToken: 'leak' },
      },
      {
        kind: 'recording',
        recordId: 'r-good',
        fields: { title: 'Good', artist: 'G' },
      },
      {
        kind: 'recordingSourceRef',
        recordId: sourceRefRecordId('r-good', goodRef),
        fields: { ref: goodRef },
      },
    ],
    current,
  );
  assertDeepEqual(
    projected.skipped,
    [
      { kind: 'unknown', reason: 'invalid' },
      { kind: 'unknown', reason: 'invalid' },
    ],
    'invalid-field records quarantine as skipped',
  );
  const rows = projected.batch.recordingsMerge?.(current.recordings) ?? [];
  assertDeepEqual(
    rows.map((r) => r.id),
    ['r-good'],
    'rule-conformant record still materializes',
  );
  assertDeepEqual(
    projected.pendingRecords,
    [],
    'rejected records never ride pending',
  );
}

// A playlistEntry tombstone deletes the existing row (Devin Review
// #46 — the existing-row loop must not re-push it).
function testEntryTombstoneRemoves(): void {
  const current = projInput({
    recordings: [recording('r-1', [ref('itunes', 't-1')])],
    playlists: [playlist('pl-1')],
    playlistEntries: [entryRow('pe-9', 'pl-1', 'r-1')],
  });
  const projected = projectAppliedEntries(
    [applied(tombstoneEntry('playlistEntry', 'pe-9'))],
    current,
  );
  assertDeepEqual(
    projected.batch.playlistEntries,
    [],
    'entry tombstone removes the row',
  );
}

/* ------------------------------------------------------------------ */
/* boot-diff emission: unsyncedWrites                                   */
/* ------------------------------------------------------------------ */

// Committed writes a past life stranded in the memory-only emit
// queue re-emit at boot: every domain row whose (kind, recordId) is
// absent from the materialized map, AND every synced field whose
// value the domain has moved past — upserts only (Review #46).
function testUnsyncedWrites(): void {
  const rec = recording('r-1', [ref('itunes', 't-1')]);
  const input = emitInput({
    recordings: [rec],
    likes: [{ entityKind: 'track', targetId: 'r-1', likedAtMs: 1 }],
    playlists: [playlist('pl-1')],
    matchReviews: [review('rev-1', 'r-1')],
    playCounts: [{ recordingId: 'r-1', count: 5, lastMs: 9 }],
  });

  // The fully-delivered log: every emitted write's field value is
  // what materialize() would report.
  const allWrites = unsyncedWrites(input, new Map());
  const syncedMap = (
    writes: readonly LocalWrite[],
  ): Map<string, Record<string, unknown>> => {
    const map = new Map<string, Record<string, unknown>>();
    for (const w of writes) {
      if ('tombstone' in w) {
        continue;
      }
      const key = `${w.kind}\u001f${w.recordId}`;
      const fields = map.get(key) ?? {};
      fields[w.field] = w.value;
      map.set(key, fields);
    }
    return map;
  };
  const synced = syncedMap(allWrites);
  const DEV = 'dev-us';
  const evidence = (
    components: Record<
      string,
      Record<string, Record<string, number>>
    > = {},
    winners: Record<string, Record<string, string>> = {},
  ): SyncEmitEvidence => ({
    deviceId: DEV,
    components: new Map(Object.entries(components)),
    winners: new Map(Object.entries(winners)),
  });
  const none = unsyncedWrites(
    input,
    synced,
    evidence({ 'playCount\u001fr-1': { count: { [DEV]: 5 } } }),
  );
  assertEqual(none.length, 0, 'fully synced domain emits nothing');
  // Without per-device evidence a 'sum' write can't prove delivery —
  // the merged total might be a coincidental remote match — so it
  // re-emits rather than trusting aggregate equality.
  assert(
    unsyncedWrites(input, synced).some(
      (w) =>
        w.kind === 'playCount' && 'field' in w && w.field === 'count',
    ),
    'a sum write without component evidence re-emits',
  );

  // Recording absent → its field + presence writes re-emit; the
  // still-synced like/playlist/review/count do not.
  const withoutRec = syncedMap(allWrites);
  for (const w of recordingUpsertWrites(rec)) {
    withoutRec.delete(`${w.kind}\u001f${w.recordId}`);
  }
  const coveredEvidence = evidence({
    'playCount\u001fr-1': { count: { [DEV]: 5 } },
  });
  const onlyRec = unsyncedWrites(input, withoutRec, coveredEvidence);
  assert(
    onlyRec.length > 0 && onlyRec.every((w) => !('tombstone' in w)),
    'recovery emits upserts only',
  );
  assert(
    onlyRec.every(
      (w) =>
        w.kind === 'recording' ||
        w.kind === 'recordingSourceRef' ||
        w.kind === 'recordingMapping',
    ),
    'only the absent record re-emits',
  );
  assert(
    onlyRec.some((w) => w.kind === 'recording' && w.recordId === 'r-1'),
    'missing recording re-emits its field writes',
  );

  // A synced record carrying a STALE field value re-emits just that
  // field — record-existence alone can't see a rename that never
  // reached the log (Review #46).
  const staleTitle = syncedMap(allWrites);
  const recFields = staleTitle.get(`recording\u001fr-1`);
  assert(recFields !== undefined, 'recording record present');
  recFields['title'] = 'old name';
  const titleWrites = unsyncedWrites(input, staleTitle, coveredEvidence);
  assertEqual(titleWrites.length, 1, 'one stale field emits one write');
  assert(
    titleWrites[0]?.kind === 'recording' &&
      'field' in (titleWrites[0] ?? {}) &&
      (titleWrites[0] as { field?: string }).field === 'title',
    'the stale field re-emits',
  );

  // A synced field absent from the record re-emits too — a partial
  // earlier emission must not mask the missing value.
  const missingField = syncedMap(allWrites);
  delete missingField.get(`recording\u001fr-1`)?.['title'];
  assert(
    unsyncedWrites(input, missingField).some(
      (w) => 'field' in w && w.field === 'title',
    ),
    'a field the record lacks re-emits',
  );

  // 'sum' delivery is per-device evidence, not merged equality —
  // remote coverage above ours hides a lost increment either way,
  // so an evidence-less pass re-emits; 'max' still suppresses
  // provably-dead writes.
  const remoteAhead = syncedMap(allWrites);
  remoteAhead.get(`playCount\u001fr-1`)!['count'] = 9;
  assert(
    unsyncedWrites(input, remoteAhead).some(
      (w) =>
        w.kind === 'playCount' && 'field' in w && w.field === 'count',
    ),
    'remote-ahead sum re-emits — component presence is unprovable',
  );
  const largerCount = syncedMap(allWrites);
  largerCount.get(`playCount\u001fr-1`)!['count'] = 2;
  const countWrites = unsyncedWrites(input, largerCount);
  assert(
    countWrites.some(
      (w) =>
        w.kind === 'playCount' && 'field' in w && w.field === 'count',
    ),
    'local-ahead sum re-emits the gap',
  );

  // BUG_0002 — per-device component evidence: a peer component
  // coincidentally equal to our domain value can't hide a lost
  // local component, and the re-emit asserts our recovered
  // component plus the remote share (stamps our plays — never a
  // sumComponentFor-clamped 0).
  const countValue = (writes: readonly LocalWrite[]): unknown =>
    writes.find(
      (w): w is Extract<LocalWrite, { field: string }> =>
        w.kind === 'playCount' && 'field' in w && w.field === 'count',
    )?.value;
  const fiveEvents = [
    playEvent('ev-a', 'r-1'),
    playEvent('ev-b', 'r-1'),
    playEvent('ev-c', 'r-1'),
    playEvent('ev-d', 'r-1'),
    playEvent('ev-e', 'r-1'),
  ];
  const playInput = emitInput({
    playHistory: fiveEvents,
    playCounts: [{ recordingId: 'r-1', count: 5, lastMs: 9 }],
  });
  // Peer-equal: synced total 5 is the peer's, our 5 plays never
  // reached the log — the 5 domain events carry no synced playEvent
  // record, so the recovery target is 5 and the emit asserts
  // 5 + remoteShare(5) = 10 (stamps our 5).
  const lostPeerEqual = unsyncedWrites(
    playInput,
    new Map([['playCount\u001fr-1', { count: 5 }]]),
    evidence({ 'playCount\u001fr-1': { count: { 'peer-x': 5 } } }),
  );
  assertEqual(
    countValue(lostPeerEqual),
    10,
    'peer-equal loss re-emits our component plus the remote share',
  );
  // Peer-ahead: synced 9 is the peer's against a stale domain 5 —
  // the emit asserts 5 + 9 = 14, stamping our 5 rather than the
  // domain total's clamped 0.
  const lostPeerAhead = unsyncedWrites(
    playInput,
    new Map([['playCount\u001fr-1', { count: 9 }]]),
    evidence({ 'playCount\u001fr-1': { count: { 'peer-x': 9 } } }),
  );
  assertEqual(
    countValue(lostPeerAhead),
    14,
    'peer-ahead loss re-emits the recovered aggregate',
  );
  // Covered: our component already accounts for all five of our
  // events plus the peer's five — nothing re-emits.
  const covered = unsyncedWrites(
    emitInput({
      playHistory: fiveEvents,
      playCounts: [{ recordingId: 'r-1', count: 10, lastMs: 9 }],
    }),
    new Map<string, Record<string, unknown>>([
      ['playCount\u001fr-1', { count: 10 }],
      ...fiveEvents.map(
        (e) => [`playEvent\u001f${e.eventId}`, { event: e }] as const,
      ),
    ]),
    evidence(
      { 'playCount\u001fr-1': { count: { [DEV]: 5, 'peer-x': 5 } } },
      Object.fromEntries(
        fiveEvents.map((e) => [
          `playEvent\u001f${e.eventId}`,
          { event: DEV },
        ]),
      ),
    ),
  );
  assert(
    !covered.some(
      (w) =>
        w.kind === 'playCount' && 'field' in w && w.field === 'count',
    ),
    'a covered component stays suppressed',
  );
  // Partial loss: three of our five events delivered (winner is us),
  // two never emitted — the recovery target outgrows our stamped 3
  // and the re-emit asserts the true 5.
  const partial = unsyncedWrites(
    emitInput({
      playHistory: fiveEvents,
      playCounts: [{ recordingId: 'r-1', count: 3, lastMs: 9 }],
    }),
    new Map<string, Record<string, unknown>>([
      ['playCount\u001fr-1', { count: 3 }],
      ...fiveEvents
        .slice(0, 3)
        .map(
          (e) => [`playEvent\u001f${e.eventId}`, { event: e }] as const,
        ),
    ]),
    evidence(
      { 'playCount\u001fr-1': { count: { [DEV]: 3 } } },
      Object.fromEntries(
        fiveEvents
          .slice(0, 3)
          .map((e) => [`playEvent\u001f${e.eventId}`, { event: DEV }]),
      ),
    ),
  );
  assertEqual(
    countValue(partial),
    5,
    'a partially lost component re-emits the recovered total',
  );

  // Durable baseline: the event window expired (no playHistory
  // rows), so events can't prove our lost increment — the
  // committed localCount still can. Our live component is 4 but
  // localCount says 5, so the target is 5 and the emit asserts
  // 5 + remoteShare(9) = 14.
  const expired = unsyncedWrites(
    emitInput({
      playCounts: [
        { recordingId: 'r-1', count: 13, lastMs: 9, localCount: 5 },
      ],
    }),
    new Map([['playCount\u001fr-1', { count: 13 }]]),
    evidence({
      'playCount\u001fr-1': { count: { [DEV]: 4, 'peer-x': 9 } },
    }),
  );
  assertEqual(
    countValue(expired),
    14,
    'a lost increment past the event window re-emits via localCount',
  );

  // The aggregate-side baseline: count − loggedRemote is our full
  // intended component — an imported total whose emission failed
  // re-emits above OUR live share, not just the pending delta
  // (ours 30 + unsent 200 = 230 > domainEstimate 180 → emit 350).
  const pending = unsyncedWrites(
    emitInput({
      playCounts: [
        { recordingId: 'r-1', count: 300, lastMs: 9, loggedRemote: 70 },
      ],
    }),
    new Map([['playCount\u001fr-1', { count: 150 }]]),
    evidence({
      'playCount\u001fr-1': { count: { [DEV]: 30, 'peer-x': 120 } },
    }),
  );
  assertEqual(
    countValue(pending),
    350,
    'an unsent aggregate re-emits the complete component',
  );

  // A tombstoned local component is not ours to recover: loggedOurs
  // above the live share was delivered, then deleted — every
  // ours-side leg discounts it, so the count write stays
  // suppressed instead of resurrecting the deleted plays.
  const deleted = unsyncedWrites(
    emitInput({
      playCounts: [
        {
          recordingId: 'r-1',
          count: 10,
          lastMs: 9,
          localCount: 3,
          loggedRemote: 7,
          loggedOurs: 3,
        },
      ],
    }),
    new Map([['playCount\u001fr-1', { count: 7 }]]),
    evidence({
      'playCount\u001fr-1': { count: { 'peer-x': 7 } },
    }),
  );
  assert(
    !deleted.some(
      (w) => w.kind === 'playCount' && 'field' in w && w.field === 'count',
    ),
    'a deleted local component does not re-emit',
  );

  // Delete-then-new-delivered: every leg discounts the old stamp
  // and the new share is already in the log — target 1, ours 1,
  // suppressed instead of asserting a duplicated component.
  const regrownDelivered = unsyncedWrites(
    emitInput({
      playCounts: [
        {
          recordingId: 'r-1',
          count: 11,
          lastMs: 9,
          localCount: 4,
          loggedRemote: 7,
          loggedOurs: 3,
        },
      ],
    }),
    new Map([['playCount\u001fr-1', { count: 8 }]]),
    evidence({
      'playCount\u001fr-1': { count: { [DEV]: 1, 'peer-x': 7 } },
    }),
  );
  assert(
    !regrownDelivered.some(
      (w) => w.kind === 'playCount' && 'field' in w && w.field === 'count',
    ),
    'a delivered new play does not double-emit over the tombstone',
  );

  // Same ordering but the new play never delivered: the emit
  // recovers exactly the stranded share (1) plus the remote 7 = 8.
  const regrownStranded = unsyncedWrites(
    emitInput({
      playCounts: [
        {
          recordingId: 'r-1',
          count: 11,
          lastMs: 9,
          localCount: 4,
          loggedRemote: 7,
          loggedOurs: 3,
        },
      ],
    }),
    new Map([['playCount\u001fr-1', { count: 7 }]]),
    evidence({
      'playCount\u001fr-1': { count: { 'peer-x': 7 } },
    }),
  );
  assertEqual(
    countValue(regrownStranded),
    8,
    'a stranded new play re-emits over the tombstone',
  );

  // A remote share at the wire bound fills it — the merge can't
  // represent any further component, so the write is delivered.
  const saturatedRemote = unsyncedWrites(
    playInput,
    new Map([
      ['playCount\u001fr-1', { count: Number.MAX_SAFE_INTEGER }],
    ]),
    evidence({
      'playCount\u001fr-1': {
        count: { 'peer-x': Number.MAX_SAFE_INTEGER },
      },
    }),
  );
  assert(
    !saturatedRemote.some(
      (w) =>
        w.kind === 'playCount' && 'field' in w && w.field === 'count',
    ),
    'a saturated remote share stays suppressed',
  );

  // target + remoteShare past the bound emits the saturated
  // aggregate the merge itself would compute.
  const saturatingEmit = unsyncedWrites(
    emitInput({
      playHistory: fiveEvents,
      playCounts: [{ recordingId: 'r-1', count: 5, lastMs: 9 }],
    }),
    new Map([
      ['playCount\u001fr-1', { count: Number.MAX_SAFE_INTEGER }],
    ]),
    evidence({
      'playCount\u001fr-1': {
        count: { 'peer-x': Number.MAX_SAFE_INTEGER - 4 },
      },
    }),
  );
  assertEqual(
    countValue(saturatingEmit),
    Number.MAX_SAFE_INTEGER,
    'target plus remote share saturates at the wire bound',
  );

  // Near-saturated: once our component is stamped to the headroom
  // the wire bound leaves, it is delivered — the raw target is
  // unreachable and the check must not replay it on every boot.
  const nearSaturated = unsyncedWrites(
    emitInput({
      playCounts: [
        {
          recordingId: 'r-1',
          count: Number.MAX_SAFE_INTEGER,
          lastMs: 9,
          localCount: 5,
        },
      ],
    }),
    new Map([
      ['playCount\u001fr-1', { count: Number.MAX_SAFE_INTEGER }],
    ]),
    evidence({
      'playCount\u001fr-1': {
        count: { [DEV]: 2, 'peer-x': Number.MAX_SAFE_INTEGER - 2 },
      },
    }),
  );
  assert(
    !nearSaturated.some(
      (w) =>
        w.kind === 'playCount' && 'field' in w && w.field === 'count',
    ),
    'a component stamped to the headroom stays delivered',
  );

  // A tombstoned synced record (empty fields) counts as absent —
  // the local row re-emits whole.
  const tombstoned = syncedMap(allWrites);
  tombstoned.set(`recording\u001fr-1`, {});
  assert(
    unsyncedWrites(input, tombstoned).some(
      (w) => w.kind === 'recording' && w.recordId === 'r-1',
    ),
    'a tombstoned synced record resurrects the local row',
  );

  // Settings absent → every whitelisted field emits; a stale
  // settings field emits just that one.
  const noSettings = syncedMap(allWrites);
  noSettings.delete(`settings\u001f${SETTINGS_RECORD_ID}`);
  const settingWrites = unsyncedWrites(input, noSettings).filter(
    (w) => w.kind === 'settings',
  );
  assertDeepEqual(
    settingWrites.map((w) => ('field' in w ? w.field : '?')).sort(),
    [
      'catalogProvider',
      'language',
      'lyricsProvider',
      'playbackProvider',
      'prefetch',
      'qualityKbps',
      'radioProvider',
      'storefront',
    ],
    'missing settings record emits all whitelisted fields',
  );
  const staleSettings = syncedMap(allWrites);
  staleSettings.get(`settings\u001f${SETTINGS_RECORD_ID}`)!['storefront'] =
    'FR';
  assertEqual(
    unsyncedWrites(input, staleSettings, coveredEvidence).length,
    1,
    'stale settings field re-emits alone',
  );
}

/* ------------------------------------------------------------------ */
/* Review #46 round-10 — emitted writes satisfy their field rules      */
/* ------------------------------------------------------------------ */

// Optional-domain fields arrive `undefined` (Settings lyricsProvider/
// radioProvider, Recording.isrc) but the wire accepts only `null` —
// an undefined value fails `localChangeBatch` validation, and the
// whole batch would wedge behind it at the emit-queue head.
function testEmissionNeverEmitsUndefined(): void {
  // SETTINGS has neither optional provider key: unsetting one emits
  // `null` (the wire's absent), never `undefined` (a rule failure).
  const prev = { ...SETTINGS, lyricsProvider: 'itunes' } as Settings;
  const next = { ...SETTINGS } as Settings;
  const writes = settingsWrites(prev, next);
  assert(writes.length > 0, 'settings diff emits');
  const lyr = writes.find(
    (w) => !('tombstone' in w) && w.field === 'lyricsProvider',
  );
  assert(
    lyr !== undefined && !('tombstone' in lyr) && lyr.value === null,
    'unset emits null',
  );
  for (const w of writes) {
    if ('tombstone' in w) {
      continue;
    }
    const rule = syncFieldRule('settings', w.field);
    assert(rule !== undefined, 'settings field is whitelisted');
    assert(
      rule.valid(w.value),
      `settings.${w.field} value satisfies its rule (got ${String(w.value)})`,
    );
  }

  // Boot-diff: the same emission from `unsyncedWrites` — every write,
  // of every kind, must validate.
  const input = emitInput({
    recordings: [recording('r-1', [ref('itunes', 't-1')])],
  });
  for (const w of unsyncedWrites(input, new Map())) {
    if ('tombstone' in w) {
      continue;
    }
    const rule = syncFieldRule(w.kind, w.field);
    assert(rule !== undefined, `${w.kind}.${w.field} is whitelisted`);
    assert(
      rule.valid(w.value),
      `${w.kind}.${w.field} value satisfies its rule (got ${String(w.value)})`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Review #46 round-10 — merge dead-set is the same set dependents     */
/* were pruned by: a fresh ref can't preserve a 'delete' plan          */
/* ------------------------------------------------------------------ */

// A remote ref tombstone leaves r1 with no snapshot refs → 'delete'
// in `dead`. A concurrent local ref L inside the transaction does NOT
// resurrect it — the merge honors the same 'delete' set the
// dependent sections were pruned by, so a surviving recording can
// never be left with deleted dependents.
function testMergeDeadSetConsistent(): void {
  const refA = ref('itunes', 't-1');
  const recA = recording('r-1', [refA]);
  const current = projInput({
    recordings: [recA],
    likes: [{ entityKind: 'track', targetId: 'r-1', likedAtMs: 1 }],
  });
  const outcomes = [
    applied(tombstoneEntry('recordingSourceRef', sourceRefRecordId('r-1', refA))),
  ];
  const projected = projectAppliedEntries(outcomes, current);
  // Snapshot classification: r1 dies — dependents prune with it.
  assertEqual(
    (projected.batch.likes ?? []).length,
    0,
    'dead recording\'s like drops',
  );
  // The transaction re-read finds r1 carrying a concurrent local ref
  // — the merge still honors 'delete' rather than reviving it, so
  // merged recordings stay coherent with the pruned dependents.
  const recL = recording('r-1', [refA, ref('local', 'file-7')]);
  const merged =
    projected.batch.recordingsMerge?.([recL]) ?? ([] as Recording[]);
  assertEqual(
    merged.length,
    0,
    'a stale-delete plan cannot preserve the row its dependents lost',
  );
}

export function run(): void {
  testRecordIdDecode();
  testRecordingUpsertWrites();
  testRecordingDeleteWrites();
  testArtworkEmissionPortable();
  testEntityWrites();
  testSettingsWrites();
  testEmissionWritesBatch();
  testUnsyncedWrites();
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
  testMappingTombstoneKeepsOthers();
  testEntityRefUpdateReplaces();
  testEntityRefChangeEmits();
  testSnapshotSurvivesTombstone();
  testSnapshotEmptyDeletes();
  testSnapshotCountAbsolute();
  testSnapshotCountFloorHonorsTombstone();
  testSnapshotCountFloorDeliveredPlays();
  testSnapshotCountFloorHonorsOurTombstone();
  testSnapshotCountFloorsAtLoggedRemote();
  testSnapshotNewestWins();
  testProjectMaterialized();
  testProjectMaterializedPending();
  testProjectMaterializedSkipsInvalid();
  testEntryTombstoneRemoves();
  testEmissionNeverEmitsUndefined();
  testMergeDeadSetConsistent();
}
