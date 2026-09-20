import type { QueueSnapshot } from '../queue/queue-engine.ts';
import {
  hasExactKeys,
  isArtworkRef,
  isEntityRef,
  isLike,
  isOptString,
  isQueueSnapshot,
  isRecord,
  isRecording,
  isSafeNonNegative,
  isSettings,
  isSourceMapping,
  isString,
  isTrackMetadata,
  isTrackRef,
} from '../domain.ts';
import type {
  ArtworkRef,
  EntityKind,
  EntityRef,
  Like,
  Recording,
  Settings,
  SourceMapping,
  SourceRef,
  TrackMetadata,
} from '../domain.ts';

/** Provider-independent album/artist page a like can attach to. */
export type Entity = {
  entityId: string;
  kind: EntityKind;
  title: string;
  artistName: string | null;
  artwork: readonly ArtworkRef[];
  createdMs: number;
};

/**
 * One provider attachment per entity per provider. `provider` mirrors
 * `ref.provider` — the table keys on it, so the two must agree.
 */
export type EntitySourceRef = {
  entityId: string;
  provider: string;
  ref: EntityRef;
};

export type Playlist = {
  playlistId: string;
  name: string;
  createdMs: number;
  updatedMs: number;
};

/**
 * One occurrence row: duplicates of a recording keep distinct
 * entryIds; `position` is fractional for O(1) reorders.
 */
export type PlaylistEntry = {
  entryId: string;
  playlistId: string;
  recordingId: string;
  position: number;
  selectedRef: SourceRef | null;
  addedMs: number;
};

export type PlayEvent = {
  eventId: string;
  recordingId: string;
  occurrenceId: string | null;
  playedMs: number;
  listenedMs: number;
};

/** Durable Top-50 aggregate; never pruned with history. */
export type PlayCount = {
  recordingId: string;
  count: number;
  lastMs: number;
};

/** A candidate frozen at review time for later confirmation. */
export type CandidateSnapshot = {
  metadata: TrackMetadata;
  ref: SourceRef;
};

/** What a resolved review wrote: the confirmed ref, or null. */
export type MatchResolution = {
  ref: SourceRef | null;
};

export type MatchReviewStatus =
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'dismissed';

export type MatchReview = {
  reviewId: string;
  recordingId: string;
  candidates: readonly CandidateSnapshot[];
  status: MatchReviewStatus;
  resolution: MatchResolution | null;
  createdMs: number;
  resolvedMs: number | null;
};

export type LyricsPayload = {
  plainLyrics: string | null;
  syncedLyrics: string | null;
  instrumental: boolean;
};

export type LyricsCacheEntry = {
  recordingId: string;
  provider: string;
  kind: 'plain' | 'synced';
  payload: LyricsPayload;
  fetchedMs: number;
};

export type ArtworkCacheEntry = {
  url: string;
  filePath: string;
  bytes: number;
  lastAccessedMs: number;
};

/** Recording rows export flat; refs and mappings export as junctions. */
export type ExportRecording = Omit<Recording, 'sourceRefs' | 'mappings'>;

export type RecordingSourceRef = { recordingId: string; ref: SourceRef };

export type RecordingMapping = {
  recordingId: string;
  mapping: SourceMapping;
};

/**
 * The versioned owned-data document: every owned class, no session
 * state, no caches, no diagnostics. Import validates the whole
 * document before committing; on any failure nothing changes.
 */
export type ExportDocument = {
  formatVersion: 1;
  exportedAtMs: number;
  recordings: readonly ExportRecording[];
  sourceRefs: readonly RecordingSourceRef[];
  mappings: readonly RecordingMapping[];
  likes: readonly Like[];
  entities: readonly Entity[];
  entitySourceRefs: readonly EntitySourceRef[];
  playlists: readonly Playlist[];
  playlistEntries: readonly PlaylistEntry[];
  playHistory: readonly PlayEvent[];
  playCounts: readonly PlayCount[];
  matchReviews: readonly MatchReview[];
  settings: Settings;
};

export type PersistedShape = {
  readonly recordings: readonly Recording[];
  readonly likes: readonly Like[];
  readonly entities: readonly Entity[];
  readonly entitySourceRefs: readonly EntitySourceRef[];
  readonly playlists: readonly Playlist[];
  readonly playlistEntries: readonly PlaylistEntry[];
  readonly playHistory: readonly PlayEvent[];
  readonly playCounts: readonly PlayCount[];
  readonly matchReviews: readonly MatchReview[];
  readonly lyricsCache: readonly LyricsCacheEntry[];
  readonly artworkCache: readonly ArtworkCacheEntry[];
  readonly queue: QueueSnapshot;
  readonly settings: Settings;
};

const MATCH_REVIEW_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'confirmed',
  'rejected',
  'dismissed',
]);

function isEntityKind(value: unknown): value is EntityKind {
  return value === 'album' || value === 'artist';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedText(value: unknown, max: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= max);
}

function hasUniqueIds<T>(items: readonly T[], idOf: (item: T) => string) {
  return new Set(items.map(idOf)).size === items.length;
}

export function isEntity(value: unknown): value is Entity {
  if (!isRecord(value)) {
    return false;
  }
  const { entityId, kind, title, artistName, artwork, createdMs } = value;
  return (
    hasExactKeys(value, [
      'entityId',
      'kind',
      'title',
      'artistName',
      'artwork',
      'createdMs',
    ]) &&
    isString(entityId, 64) &&
    isEntityKind(kind) &&
    isString(title, 512) &&
    isOptString(artistName, 512) &&
    Array.isArray(artwork) &&
    artwork.length <= 8 &&
    artwork.every(isArtworkRef) &&
    isSafeNonNegative(createdMs)
  );
}

export function isEntitySourceRef(
  value: unknown,
): value is EntitySourceRef {
  if (!isRecord(value)) {
    return false;
  }
  const { entityId, provider, ref } = value;
  return (
    hasExactKeys(value, ['entityId', 'provider', 'ref']) &&
    isString(entityId, 64) &&
    isString(provider, 64) &&
    isEntityRef(ref) &&
    ref.provider === provider
  );
}

export function isPlaylist(value: unknown): value is Playlist {
  if (!isRecord(value)) {
    return false;
  }
  const { playlistId, name, createdMs, updatedMs } = value;
  return (
    hasExactKeys(value, ['playlistId', 'name', 'createdMs', 'updatedMs']) &&
    isString(playlistId, 64) &&
    isString(name, 512) &&
    isSafeNonNegative(createdMs) &&
    isSafeNonNegative(updatedMs) &&
    updatedMs >= createdMs
  );
}

export function isPlaylistEntry(value: unknown): value is PlaylistEntry {
  if (!isRecord(value)) {
    return false;
  }
  const {
    entryId,
    playlistId,
    recordingId,
    position,
    selectedRef,
    addedMs,
  } = value;
  return (
    hasExactKeys(value, [
      'entryId',
      'playlistId',
      'recordingId',
      'position',
      'selectedRef',
      'addedMs',
    ]) &&
    isString(entryId, 64) &&
    isString(playlistId, 64) &&
    isString(recordingId, 64) &&
    isFiniteNumber(position) &&
    (selectedRef === null || isTrackRef(selectedRef)) &&
    isSafeNonNegative(addedMs)
  );
}

export function isPlayEvent(value: unknown): value is PlayEvent {
  if (!isRecord(value)) {
    return false;
  }
  const { eventId, recordingId, occurrenceId, playedMs, listenedMs } = value;
  return (
    hasExactKeys(value, [
      'eventId',
      'recordingId',
      'occurrenceId',
      'playedMs',
      'listenedMs',
    ]) &&
    isString(eventId, 64) &&
    isString(recordingId, 64) &&
    (occurrenceId === null || isString(occurrenceId, 64)) &&
    isSafeNonNegative(playedMs) &&
    isSafeNonNegative(listenedMs)
  );
}

export function isPlayCount(value: unknown): value is PlayCount {
  if (!isRecord(value)) {
    return false;
  }
  const { recordingId, count, lastMs } = value;
  return (
    hasExactKeys(value, ['recordingId', 'count', 'lastMs']) &&
    isString(recordingId, 64) &&
    isSafeNonNegative(count) &&
    isSafeNonNegative(lastMs)
  );
}

export function isCandidateSnapshot(
  value: unknown,
): value is CandidateSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  const { metadata, ref } = value;
  return (
    hasExactKeys(value, ['metadata', 'ref']) &&
    isTrackMetadata(metadata) &&
    isTrackRef(ref)
  );
}

export function isMatchResolution(
  value: unknown,
): value is MatchResolution {
  if (!isRecord(value)) {
    return false;
  }
  const { ref } = value;
  return (
    hasExactKeys(value, ['ref']) && (ref === null || isTrackRef(ref))
  );
}

export function isMatchReview(value: unknown): value is MatchReview {
  if (!isRecord(value)) {
    return false;
  }
  const {
    reviewId,
    recordingId,
    candidates,
    status,
    resolution,
    createdMs,
    resolvedMs,
  } = value;
  return (
    hasExactKeys(value, [
      'reviewId',
      'recordingId',
      'candidates',
      'status',
      'resolution',
      'createdMs',
      'resolvedMs',
    ]) &&
    isString(reviewId, 64) &&
    isString(recordingId, 64) &&
    Array.isArray(candidates) &&
    candidates.length >= 1 &&
    candidates.length <= 64 &&
    candidates.every(isCandidateSnapshot) &&
    typeof status === 'string' &&
    MATCH_REVIEW_STATUSES.has(status) &&
    (resolution === null || isMatchResolution(resolution)) &&
    isSafeNonNegative(createdMs) &&
    (resolvedMs === null || isSafeNonNegative(resolvedMs)) &&
    // Pending is exactly the unresolved state: no resolution, no stamp.
    (status === 'pending' ? resolvedMs === null && resolution === null
      : resolvedMs !== null)
  );
}

export function isLyricsPayload(value: unknown): value is LyricsPayload {
  if (!isRecord(value)) {
    return false;
  }
  const { plainLyrics, syncedLyrics, instrumental } = value;
  return (
    hasExactKeys(value, ['plainLyrics', 'syncedLyrics', 'instrumental']) &&
    isBoundedText(plainLyrics, 65_536) &&
    isBoundedText(syncedLyrics, 65_536) &&
    typeof instrumental === 'boolean'
  );
}

export function isLyricsCacheEntry(
  value: unknown,
): value is LyricsCacheEntry {
  if (!isRecord(value)) {
    return false;
  }
  const { recordingId, provider, kind, payload, fetchedMs } = value;
  return (
    hasExactKeys(value, [
      'recordingId',
      'provider',
      'kind',
      'payload',
      'fetchedMs',
    ]) &&
    isString(recordingId, 64) &&
    isString(provider, 64) &&
    (kind === 'plain' || kind === 'synced') &&
    isLyricsPayload(payload) &&
    // A 'synced' entry must actually carry timed lines; plain never
    // presents as synced, so the inverse is not required.
    (kind !== 'synced' || payload.syncedLyrics !== null) &&
    isSafeNonNegative(fetchedMs)
  );
}

export function isArtworkCacheEntry(
  value: unknown,
): value is ArtworkCacheEntry {
  if (!isRecord(value)) {
    return false;
  }
  const { url, filePath, bytes, lastAccessedMs } = value;
  return (
    hasExactKeys(value, ['url', 'filePath', 'bytes', 'lastAccessedMs']) &&
    isString(url, 2048) &&
    url.startsWith('https://') &&
    isString(filePath, 1024) &&
    isSafeNonNegative(bytes) &&
    isSafeNonNegative(lastAccessedMs)
  );
}

function isRecordingSourceRef(
  value: unknown,
): value is RecordingSourceRef {
  if (!isRecord(value)) {
    return false;
  }
  const { recordingId, ref } = value;
  return (
    hasExactKeys(value, ['recordingId', 'ref']) &&
    isString(recordingId, 64) &&
    isTrackRef(ref)
  );
}

function isRecordingMapping(value: unknown): value is RecordingMapping {
  if (!isRecord(value)) {
    return false;
  }
  const { recordingId, mapping } = value;
  return (
    hasExactKeys(value, ['recordingId', 'mapping']) &&
    isString(recordingId, 64) &&
    isSourceMapping(mapping)
  );
}

/**
 * Cross-record checks shared by the persisted document and the export
 * document: shapes, per-section uniqueness, and every foreign target
 * resolving inside the document.
 */
function hasValidLibrarySections(
  sections: Record<string, unknown>,
  recordingIds: ReadonlySet<string>,
): boolean {
  const likes = sections['likes'];
  const entities = sections['entities'];
  const entitySourceRefs = sections['entitySourceRefs'];
  const playlists = sections['playlists'];
  const playlistEntries = sections['playlistEntries'];
  const playHistory = sections['playHistory'];
  const playCounts = sections['playCounts'];
  const matchReviews = sections['matchReviews'];
  if (
    !Array.isArray(likes) ||
    !likes.every(isLike) ||
    !Array.isArray(entities) ||
    !entities.every(isEntity) ||
    !Array.isArray(entitySourceRefs) ||
    !entitySourceRefs.every(isEntitySourceRef) ||
    !Array.isArray(playlists) ||
    !playlists.every(isPlaylist) ||
    !Array.isArray(playlistEntries) ||
    !playlistEntries.every(isPlaylistEntry) ||
    !Array.isArray(playHistory) ||
    !playHistory.every(isPlayEvent) ||
    !Array.isArray(playCounts) ||
    !playCounts.every(isPlayCount) ||
    !Array.isArray(matchReviews) ||
    !matchReviews.every(isMatchReview)
  ) {
    return false;
  }
  if (
    !hasUniqueIds(entities, (e) => e.entityId) ||
    !hasUniqueIds(playlists, (p) => p.playlistId) ||
    !hasUniqueIds(playlistEntries, (e) => e.entryId) ||
    !hasUniqueIds(playHistory, (e) => e.eventId) ||
    !hasUniqueIds(playCounts, (c) => c.recordingId) ||
    !hasUniqueIds(matchReviews, (r) => r.reviewId)
  ) {
    return false;
  }
  const entityIds = new Set(entities.map((e) => e.entityId));
  const playlistIds = new Set(playlists.map((p) => p.playlistId));
  const likeKeys = new Set<string>();
  for (const like of likes) {
    const key = `${like.entityKind} ${like.targetId}`;
    if (likeKeys.has(key)) {
      return false;
    }
    likeKeys.add(key);
    // 'track' likes name recordings; entity likes name entities.
    const target =
      like.entityKind === 'track' ? recordingIds : entityIds;
    if (!target.has(like.targetId)) {
      return false;
    }
  }
  const entityRefKeys = new Set<string>();
  for (const ref of entitySourceRefs) {
    if (!entityIds.has(ref.entityId)) {
      return false;
    }
    const key = `${ref.entityId} ${ref.provider}`;
    if (entityRefKeys.has(key)) {
      return false;
    }
    entityRefKeys.add(key);
  }
  const positions = new Map<string, Set<number>>();
  for (const entry of playlistEntries) {
    if (!playlistIds.has(entry.playlistId)) {
      return false;
    }
    if (!recordingIds.has(entry.recordingId)) {
      return false;
    }
    const seen = positions.get(entry.playlistId) ?? new Set<number>();
    if (seen.has(entry.position)) {
      return false;
    }
    seen.add(entry.position);
    positions.set(entry.playlistId, seen);
  }
  for (const event of playHistory) {
    if (!recordingIds.has(event.recordingId)) {
      return false;
    }
  }
  for (const count of playCounts) {
    if (!recordingIds.has(count.recordingId)) {
      return false;
    }
  }
  for (const review of matchReviews) {
    if (!recordingIds.has(review.recordingId)) {
      return false;
    }
  }
  return true;
}

const PERSISTED_KEYS = [
  'recordings',
  'likes',
  'entities',
  'entitySourceRefs',
  'playlists',
  'playlistEntries',
  'playHistory',
  'playCounts',
  'matchReviews',
  'lyricsCache',
  'artworkCache',
  'queue',
  'settings',
];

/** Validates the whole persisted document, including references. */
export function isPersistedState(value: unknown): value is PersistedShape {
  if (!isRecord(value) || !hasExactKeys(value, PERSISTED_KEYS)) {
    return false;
  }
  const v = value;
  if (
    !Array.isArray(v['recordings']) ||
    !v['recordings'].every(isRecording) ||
    !Array.isArray(v['lyricsCache']) ||
    !v['lyricsCache'].every(isLyricsCacheEntry) ||
    !Array.isArray(v['artworkCache']) ||
    !v['artworkCache'].every(isArtworkCacheEntry) ||
    !isQueueSnapshot(v['queue']) ||
    !isSettings(v['settings'])
  ) {
    return false;
  }
  const recordings = v['recordings'] as readonly Recording[];
  const queue = v['queue'];
  const recordingIds = new Set(recordings.map((r) => r.id));
  if (recordingIds.size !== recordings.length) {
    return false;
  }
  const lyricsCache = v['lyricsCache'] as readonly LyricsCacheEntry[];
  for (const entry of lyricsCache) {
    if (!recordingIds.has(entry.recordingId)) {
      return false;
    }
  }
  if (
    !hasUniqueIds(
      v['artworkCache'] as readonly ArtworkCacheEntry[],
      (a) => a.url,
    )
  ) {
    return false;
  }
  if (!hasValidLibrarySections(v, recordingIds)) {
    return false;
  }
  for (const occurrence of queue.occurrences) {
    if (!recordingIds.has(occurrence.recordingId)) {
      return false;
    }
  }
  return true;
}

const EXPORT_KEYS = [
  'formatVersion',
  'exportedAtMs',
  'recordings',
  'sourceRefs',
  'mappings',
  'likes',
  'entities',
  'entitySourceRefs',
  'playlists',
  'playlistEntries',
  'playHistory',
  'playCounts',
  'matchReviews',
  'settings',
];

/**
 * Whole-document validation for the owned-data export: every section
 * validates and every junction row resolves before anything commits.
 * Recordings are reassembled from the flat junction rows and checked
 * against the full Recording contract.
 */
export function isExportDocument(value: unknown): value is ExportDocument {
  if (!isRecord(value) || !hasExactKeys(value, EXPORT_KEYS)) {
    return false;
  }
  const v = value;
  if (
    v['formatVersion'] !== 1 ||
    !isSafeNonNegative(v['exportedAtMs']) ||
    !Array.isArray(v['recordings']) ||
    !Array.isArray(v['sourceRefs']) ||
    !Array.isArray(v['mappings']) ||
    !isSettings(v['settings'])
  ) {
    return false;
  }
  const recordingIds = new Set<string>();
  const records: { rec: Record<string, unknown>; id: string }[] = [];
  for (const rec of v['recordings']) {
    if (!isRecord(rec) || !isString(rec['id'], 64)) {
      return false;
    }
    if (recordingIds.has(rec['id'])) {
      return false;
    }
    recordingIds.add(rec['id']);
    records.push({ rec, id: rec['id'] });
  }
  const refsByRecording = new Map<string, SourceRef[]>();
  for (const row of v['sourceRefs']) {
    if (!isRecordingSourceRef(row) || !recordingIds.has(row.recordingId)) {
      return false;
    }
    const list = refsByRecording.get(row.recordingId) ?? [];
    list.push(row.ref);
    refsByRecording.set(row.recordingId, list);
  }
  const mappingsByRecording = new Map<string, SourceMapping[]>();
  for (const row of v['mappings']) {
    if (!isRecordingMapping(row) || !recordingIds.has(row.recordingId)) {
      return false;
    }
    const list = mappingsByRecording.get(row.recordingId) ?? [];
    list.push(row.mapping);
    mappingsByRecording.set(row.recordingId, list);
  }
  // Reassembling each recording also enforces >=1 source ref and
  // (provider, kind, id) uniqueness per recording.
  for (const { rec, id } of records) {
    const assembled = {
      ...rec,
      sourceRefs: refsByRecording.get(id) ?? [],
      mappings: mappingsByRecording.get(id) ?? [],
    };
    if (!isRecording(assembled)) {
      return false;
    }
  }
  return hasValidLibrarySections(v, recordingIds);
}
