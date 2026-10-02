import type {
  AppError,
  ArtworkCacheEntry,
  AttemptTrace,
  CancellationSignal,
  DownloadRecord,
  Entity,
  EntitySourceRef,
  Like,
  LocalFile,
  LocalSource,
  LyricsCacheEntry,
  MatchReview,
  PlayCount,
  PlayEvent,
  Playlist,
  PlaylistEntry,
  QueueSnapshot,
  Recording,
  Result,
  Settings,
  SourceMapping,
  SourceRef,
  StorageBatch,
} from '@auqw/application';
import {
  appError,
  err,
  isArtworkCacheEntry,
  isAttemptTrace,
  isDownloadRecord,
  isEntity,
  isEntitySourceRef,
  isLike,
  isLocalFile,
  isLocalSource,
  isLyricsCacheEntry,
  isMatchReview,
  isPlayCount,
  isPlayEvent,
  isPlaylist,
  isPlaylistEntry,
  isQueueSnapshot,
  isRecording,
  isSettings,
  isSourceMapping,
  ok,
} from '@auqw/application';
import { CANCELLED } from './driver.ts';
import type {
  SqliteConnection,
  SqlParams,
  SqlRow,
  SqlStatement,
  SqlValue,
} from './driver.ts';

export const ATTEMPT_CAP = 500;

/** Binds one statement's params under the IPC cap and legacy limits. */
const MAX_PARAMS = 250;

function invalidBatch(): AppError {
  return appError('invalid-response', 'commit batch failed validation');
}

/* ------------------------------------------------------------------ */
/* Row decoding helpers — shared by decodeState (load) and the         */
/* `recordingsMerge` read inside commit.                               */
/* ------------------------------------------------------------------ */

/**
 * Decoders over a `fail` flag: malformed cells mark `bad` on the
 * caller's flag rather than throwing, so one sweep collects every
 * problem instead of dying on the first.
 */
export type RowTools = ReturnType<typeof rowTools>;

export function rowTools(fail: () => void) {
  const reqStr = (value: SqlValue | undefined): string =>
    typeof value === 'string' ? value : (fail(), '');
  const reqNonEmpty = (value: SqlValue | undefined): string => {
    const str = reqStr(value);
    if (str.length === 0) {
      fail();
    }
    return str;
  };
  const optStr = (value: SqlValue | undefined): string | null =>
    value === null || typeof value === 'string' ? value : (fail(), null);
  const reqInt = (value: SqlValue | undefined): number =>
    typeof value === 'number' && Number.isSafeInteger(value)
      ? value
      : (fail(), 0);
  const reqNonNegInt = (value: SqlValue | undefined): number => {
    const num = reqInt(value);
    if (num < 0) {
      fail();
    }
    return num;
  };
  const optInt = (value: SqlValue | undefined): number | null =>
    value === null
      ? null
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? value
        : (fail(), null);
  const optBool = (value: SqlValue | undefined): boolean | null =>
    value === null
      ? null
      : value === 1
        ? true
        : value === 0
          ? false
          : (fail(), null);
  const reqBool = (value: SqlValue | undefined): boolean =>
    value === 1 ? true : value === 0 ? false : (fail(), false);
  const json = (value: SqlValue | undefined): unknown => {
    if (typeof value !== 'string') {
      fail();
      return null;
    }
    try {
      return JSON.parse(value);
    } catch {
      fail();
      return null;
    }
  };
  return {
    fail,
    reqStr,
    reqNonEmpty,
    optStr,
    reqInt,
    reqNonNegInt,
    optInt,
    optBool,
    reqBool,
    json,
  };
}

/**
 * A stored row the decode dropped — table + identifying key for the
 * load/commit logs. Keys are opaque ids only, never row content.
 */
export type DroppedRow = {
  readonly table: string;
  readonly key: string;
};

export type DecodedRecordings = {
  readonly recordings: Recording[];
  readonly recordingIds: ReadonlySet<string>;
  /**
   * Stored recording ids the decode dropped. The merge never sees
   * them, so the row diff deletes them outright — their dependents
   * must go down with the parent (see planCommit's purge pass).
   */
  readonly droppedRecordingIds: ReadonlySet<string>;
  readonly dropped: readonly DroppedRow[];
};

/**
 * Recording rows + their per-recording junction rows → Recording[].
 * Stored rows arrive through the raw statement path (renderer
 * `storage:*` writes, a migrated file), so malformed rows drop rather
 * than fail — an invalid row is an orphan the commit diff deletes,
 * not a reason to brick the document. `refRows`/`mappingRows` must
 * arrive ordered by (recording_id, ordinal); the ordinal itself is
 * order-only — a gapped or renumbered column heals on the row's next
 * write, so only its decode validity gates the row.
 */
export function decodeRecordingRows(
  recordingRows: readonly SqlRow[],
  refRows: readonly SqlRow[],
  mappingRows: readonly SqlRow[],
): DecodedRecordings {
  const dropped: DroppedRow[] = [];
  const droppedRecordingIds = new Set<string>();
  // Row-scoped fail flags: a malformed cell condemns its own row, not
  // the sweep — the row drops and decoding continues. The draft
  // keeps junction arrays mutable until the element gate retypes it.
  type DraftRecording = Omit<Recording, 'sourceRefs' | 'mappings'> & {
    sourceRefs: SourceRef[];
    mappings: SourceMapping[];
  };
  const byId = new Map<string, DraftRecording>();
  const order: DraftRecording[] = [];
  for (const row of recordingRows) {
    let bad = false;
    const t = rowTools(() => {
      bad = true;
    });
    const rec: DraftRecording = {
      id: t.reqStr(row['id']),
      title: t.reqStr(row['title']),
      artist: t.optStr(row['artist']),
      album: t.optStr(row['album']),
      durationMs: t.optInt(row['duration_ms']),
      releaseYear: t.optInt(row['release_year']),
      artwork: t.json(row['artwork_json']) as Recording['artwork'],
      explicit: t.optBool(row['explicit']),
      genre: t.optStr(row['genre']),
      isrc: t.optStr(row['isrc']),
      versionLabels: t.json(
        row['version_labels_json'],
      ) as Recording['versionLabels'],
      sourceRefs: [],
      mappings: [],
      provenance: row['provenance'] as Recording['provenance'],
    };
    if (bad || rec.id.length === 0) {
      dropped.push({ table: 'recordings', key: rec.id });
      if (rec.id.length > 0) {
        droppedRecordingIds.add(rec.id);
      }
      continue;
    }
    if (byId.has(rec.id)) {
      // A duplicate id drops but stays out of the purge set — the
      // surviving row keeps its dependents.
      dropped.push({ table: 'recordings', key: rec.id });
      continue;
    }
    byId.set(rec.id, rec);
    order.push(rec);
  }
  const seenRefs = new Map<string, Set<string>>();
  for (const row of refRows) {
    let bad = false;
    const t = rowTools(() => {
      bad = true;
    });
    const recordingId = t.reqStr(row['recording_id']);
    t.reqNonNegInt(row['ordinal']);
    const provider = t.reqNonEmpty(row['provider']);
    const sourceId = t.reqNonEmpty(row['source_id']);
    const target = byId.get(recordingId);
    if (bad || row['kind'] !== 'track' || target === undefined) {
      dropped.push({ table: 'source_refs', key: recordingId });
      continue;
    }
    const seen = seenRefs.get(recordingId) ?? new Set<string>();
    const key = `${provider} track ${sourceId}`;
    if (seen.has(key)) {
      dropped.push({ table: 'source_refs', key: recordingId });
      continue;
    }
    seen.add(key);
    seenRefs.set(recordingId, seen);
    target.sourceRefs.push({
      provider,
      kind: 'track',
      id: sourceId,
    });
  }
  for (const row of mappingRows) {
    let bad = false;
    const t = rowTools(() => {
      bad = true;
    });
    const recordingId = t.reqStr(row['recording_id']);
    t.reqNonNegInt(row['ordinal']);
    const target = byId.get(recordingId);
    const mapping: SourceMapping = {
      ref: {
        provider: t.reqNonEmpty(row['provider']),
        kind: 'track',
        id: t.reqNonEmpty(row['source_id']),
      },
      status: row['status'] as SourceMapping['status'],
      matchedAtMs: t.reqNonNegInt(row['matched_at_ms']),
      evidence: t.json(row['evidence_json']) as SourceMapping['evidence'],
    };
    if (
      bad ||
      row['kind'] !== 'track' ||
      target === undefined ||
      !isSourceMapping(mapping)
    ) {
      dropped.push({ table: 'mappings', key: recordingId });
      continue;
    }
    target.mappings.push(mapping);
  }
  const recordings: Recording[] = [];
  const recordingIds = new Set<string>();
  for (const rec of order) {
    // Rows that reassemble into a contract violation — zero source
    // refs, wrong provenance, malformed list cells — drop wholesale;
    // the merge diff purges the row and the purge pass takes its
    // dependents down.
    const key = rec.id;
    if (!isRecording(rec)) {
      dropped.push({ table: 'recordings', key });
      droppedRecordingIds.add(key);
      continue;
    }
    recordings.push(rec);
    recordingIds.add(rec.id);
  }
  return { recordings, recordingIds, droppedRecordingIds, dropped };
}

/* ------------------------------------------------------------------ */
/* Table specs: column order == write order; keys are the PK columns.  */
/* `reinsert` tables delete+insert changed rows — the only safe play  */
/* against non-PK UNIQUE columns (a swapped ordinal/unique tuple can  */
/* never collide once the old rows are gone). FK parents UPDATE in    */
/* place instead: a delete there would cascade away dependent rows.   */
/* Tables read `ORDER BY rowid` also update in place so an edited row */
/* keeps its position in the committed array's physical order.        */
/* ------------------------------------------------------------------ */

type RowTuple = readonly SqlValue[];

type TableDef = {
  readonly table: string;
  readonly columns: readonly string[];
  readonly key: readonly string[];
  readonly reinsert: boolean;
};

const RECORDINGS: TableDef = {
  table: 'recordings',
  columns: [
    'id',
    'title',
    'artist',
    'album',
    'duration_ms',
    'release_year',
    'artwork_json',
    'explicit',
    'genre',
    'isrc',
    'version_labels_json',
    'provenance',
  ],
  key: ['id'],
  reinsert: false,
};

const SOURCE_REFS: TableDef = {
  table: 'source_refs',
  columns: ['recording_id', 'ordinal', 'provider', 'kind', 'source_id'],
  key: ['recording_id', 'ordinal'],
  reinsert: true,
};

const MAPPINGS: TableDef = {
  table: 'mappings',
  columns: [
    'recording_id',
    'ordinal',
    'provider',
    'kind',
    'source_id',
    'status',
    'matched_at_ms',
    'evidence_json',
  ],
  key: ['recording_id', 'ordinal'],
  reinsert: true,
};

const LIKES: TableDef = {
  table: 'likes',
  columns: ['entity_kind', 'target_id', 'liked_ms'],
  key: ['entity_kind', 'target_id'],
  reinsert: false,
};

const ENTITIES: TableDef = {
  table: 'entities',
  columns: [
    'entity_id',
    'kind',
    'title',
    'artist_name',
    'artwork_json',
    'created_ms',
  ],
  key: ['entity_id'],
  reinsert: false,
};

const ENTITY_SOURCE_REFS: TableDef = {
  table: 'entity_source_refs',
  columns: ['entity_id', 'provider', 'ref_json'],
  key: ['entity_id', 'provider'],
  reinsert: true,
};

const PLAYLISTS: TableDef = {
  table: 'playlists',
  columns: ['playlist_id', 'name', 'created_ms', 'updated_ms'],
  key: ['playlist_id'],
  reinsert: false,
};

const PLAYLIST_ENTRIES: TableDef = {
  table: 'playlist_entries',
  columns: [
    'entry_id',
    'playlist_id',
    'recording_id',
    'position',
    'selected_ref_json',
    'added_ms',
  ],
  key: ['entry_id'],
  reinsert: true,
};

const PLAY_HISTORY: TableDef = {
  table: 'play_history',
  columns: [
    'event_id',
    'recording_id',
    'occurrence_id',
    'played_ms',
    'listened_ms',
  ],
  key: ['event_id'],
  reinsert: true,
};

const PLAY_COUNTS: TableDef = {
  table: 'play_counts',
  columns: ['recording_id', 'count', 'last_ms'],
  key: ['recording_id'],
  reinsert: false,
};

const MATCH_REVIEWS: TableDef = {
  table: 'match_reviews',
  columns: [
    'review_id',
    'recording_id',
    'candidates_json',
    'status',
    'resolution_json',
    'created_ms',
    'resolved_ms',
  ],
  key: ['review_id'],
  reinsert: false,
};

const LYRICS_CACHE: TableDef = {
  table: 'lyrics_cache',
  columns: [
    'recording_id',
    'provider',
    'kind',
    'payload_json',
    'fetched_ms',
    'provider_version',
  ],
  key: ['recording_id'],
  reinsert: false,
};

const ARTWORK_CACHE: TableDef = {
  table: 'artwork_cache',
  columns: ['url', 'file_path', 'bytes', 'last_accessed_ms'],
  key: ['url'],
  reinsert: false,
};

const DOWNLOADS: TableDef = {
  table: 'downloads',
  columns: [
    'download_id',
    'recording_id',
    'provider',
    'source_ref_json',
    'file_path',
    'bytes',
    'state',
    'committed_offset',
    'checksum',
    'mime',
    'itag',
    'expires_at_ms',
    'error_json',
    'priority',
    'requested_ms',
    'downloaded_ms',
  ],
  key: ['download_id'],
  reinsert: true,
};

const LOCAL_SOURCES: TableDef = {
  table: 'local_sources',
  columns: ['source_id', 'tree_uri', 'label', 'added_ms', 'last_scan_ms'],
  key: ['source_id'],
  reinsert: false,
};

const LOCAL_FILES: TableDef = {
  table: 'local_files',
  columns: [
    'file_id',
    'source_id',
    'doc_id',
    'size',
    'fingerprint',
    'modified_ms',
    'title',
    'artist',
    'album',
    'duration_ms',
    'genre',
    'recording_id',
  ],
  key: ['file_id'],
  reinsert: true,
};

const QUEUE_OCCURRENCES: TableDef = {
  table: 'queue_occurrences',
  columns: [
    'occurrence_id',
    'ordinal',
    'recording_id',
    'selected_provider',
    'selected_kind',
    'selected_source_id',
  ],
  key: ['occurrence_id'],
  reinsert: true,
};

// `load` reads these tables `ORDER BY rowid`, so physical row order
// is part of the committed contract — see `diffRows`'s reorder pass.
const ORDERED_TABLES: ReadonlySet<TableDef> = new Set([
  RECORDINGS,
  LIKES,
  ENTITIES,
  PLAYLISTS,
  PLAY_COUNTS,
  MATCH_REVIEWS,
  LYRICS_CACHE,
  ARTWORK_CACHE,
]);

/* ------------------------- row encoders --------------------------- */

const recordingRow = (r: Recording): SqlValue[] => [
  r.id,
  r.title,
  r.artist,
  r.album,
  r.durationMs,
  r.releaseYear,
  JSON.stringify(r.artwork),
  r.explicit === null ? null : r.explicit ? 1 : 0,
  r.genre,
  r.isrc,
  JSON.stringify(r.versionLabels),
  r.provenance,
];

const sourceRefRow = (
  recordingId: string,
  ordinal: number,
  ref: SourceRef,
): SqlValue[] => [recordingId, ordinal, ref.provider, 'track', ref.id];

const mappingRow = (
  recordingId: string,
  ordinal: number,
  mapping: SourceMapping,
): SqlValue[] => [
  recordingId,
  ordinal,
  mapping.ref.provider,
  'track',
  mapping.ref.id,
  mapping.status,
  mapping.matchedAtMs,
  JSON.stringify(mapping.evidence),
];

const likeRow = (like: Like): SqlValue[] => [
  like.entityKind,
  like.targetId,
  like.likedAtMs,
];

const entityRow = (entity: Entity): SqlValue[] => [
  entity.entityId,
  entity.kind,
  entity.title,
  entity.artistName,
  entity.artwork.length === 0 ? null : JSON.stringify(entity.artwork),
  entity.createdMs,
];

const entitySourceRefRow = (ref: EntitySourceRef): SqlValue[] => [
  ref.entityId,
  ref.provider,
  JSON.stringify(ref.ref),
];

const playlistRow = (playlist: Playlist): SqlValue[] => [
  playlist.playlistId,
  playlist.name,
  playlist.createdMs,
  playlist.updatedMs,
];

const playlistEntryRow = (entry: PlaylistEntry): SqlValue[] => [
  entry.entryId,
  entry.playlistId,
  entry.recordingId,
  entry.position,
  entry.selectedRef === null ? null : JSON.stringify(entry.selectedRef),
  entry.addedMs,
];

const playEventRow = (event: PlayEvent): SqlValue[] => [
  event.eventId,
  event.recordingId,
  event.occurrenceId,
  event.playedMs,
  event.listenedMs,
];

const playCountRow = (count: PlayCount): SqlValue[] => [
  count.recordingId,
  count.count,
  count.lastMs,
];

const matchReviewRow = (review: MatchReview): SqlValue[] => [
  review.reviewId,
  review.recordingId,
  JSON.stringify(review.candidates),
  review.status,
  review.resolution === null ? null : JSON.stringify(review.resolution),
  review.createdMs,
  review.resolvedMs,
];

const lyricsCacheRow = (entry: LyricsCacheEntry): SqlValue[] => [
  entry.recordingId,
  entry.provider,
  entry.kind,
  JSON.stringify(entry.payload),
  entry.fetchedMs,
  // Three-way encoding: NULL = pre-versioning row, '' = recorded null
  // provenance (a versionless provider's write), else the version.
  entry.providerVersion === undefined ? null : (entry.providerVersion ?? ''),
];

const artworkCacheRow = (entry: ArtworkCacheEntry): SqlValue[] => [
  entry.url,
  entry.filePath,
  entry.bytes,
  entry.lastAccessedMs,
];

const downloadRow = (download: DownloadRecord): SqlValue[] => [
  download.downloadId,
  download.recordingId,
  download.provider,
  JSON.stringify(download.sourceRef),
  download.filePath,
  download.bytes,
  download.state,
  download.committedOffset,
  download.checksum,
  download.mime,
  download.itag,
  download.expiresAtMs,
  download.error === null ? null : JSON.stringify(download.error),
  download.priority,
  download.requestedMs,
  download.downloadedMs,
];

const localSourceRow = (source: LocalSource): SqlValue[] => [
  source.sourceId,
  source.treeUri,
  source.label,
  source.addedMs,
  source.lastScanMs,
];

const localFileRow = (file: LocalFile): SqlValue[] => [
  file.fileId,
  file.sourceId,
  file.docId,
  file.size,
  file.fingerprint,
  file.modifiedMs,
  file.title,
  file.artist,
  file.album,
  file.durationMs,
  file.genre,
  file.recordingId,
];

const queueOccurrenceRow = (
  occurrenceId: string,
  ordinal: number,
  recordingId: string,
  selectedRef: SourceRef | null,
): SqlValue[] => [
  occurrenceId,
  ordinal,
  recordingId,
  selectedRef?.provider ?? null,
  selectedRef === null ? null : 'track',
  selectedRef?.id ?? null,
];

const queueStateRow = (queue: QueueSnapshot): SqlValue[] => [
  1,
  queue.revision,
  queue.currentOccurrenceId,
  queue.positionMs,
  queue.mode,
  queue.blockedError === undefined
    ? null
    : JSON.stringify(queue.blockedError),
];

const settingsRow = (settings: Settings): SqlValue[] => [
  1,
  settings.catalogProvider,
  settings.playbackProvider,
  settings.storefront,
  settings.qualityKbps,
  settings.theme,
  settings.prefetch ? 1 : 0,
  settings.lyricsProvider ?? null,
  settings.radioProvider ?? null,
  settings.artworkCacheBytes ?? null,
  settings.downloadMetered === true ? 1 : 0,
  settings.language ?? null,
];

const QUEUE_STATE_COLUMNS = [
  'id',
  'revision',
  'current_occurrence_id',
  'position_ms',
  'mode',
  'blocked_error_json',
];

const SETTINGS_COLUMNS = [
  'id',
  'catalog_provider',
  'playback_provider',
  'storefront',
  'quality_kbps',
  'theme',
  'prefetch',
  'lyrics_provider',
  'radio_provider',
  'artwork_cache_bytes',
  'download_metered',
  'language',
];

/* ------------------------- statement emit -------------------------- */

const stmt = (sql: string, params: SqlParams = []): SqlStatement => ({
  sql,
  params,
});

const placeholders = (n: number): string =>
  `(${new Array<string>(n).fill('?').join(',')})`;

/** `DELETE FROM t WHERE key IN (...)` — chunked under the param cap. */
function deleteStatements(
  def: TableDef,
  keys: readonly RowTuple[],
): SqlStatement[] {
  const out: SqlStatement[] = [];
  if (keys.length === 0) {
    return out;
  }
  if (def.key.length === 1) {
    const col = def.key[0] as string;
    for (let i = 0; i < keys.length; i += MAX_PARAMS) {
      const chunk = keys.slice(i, i + MAX_PARAMS);
      out.push(
        stmt(
          `DELETE FROM ${def.table} WHERE ${col} IN ${placeholders(chunk.length)}`,
          chunk.map((key) => key[0] ?? null),
        ),
      );
    }
    return out;
  }
  const keyList = def.key.join(', ');
  const valueTuple = placeholders(def.key.length);
  const per = Math.max(1, Math.floor(MAX_PARAMS / def.key.length));
  for (let i = 0; i < keys.length; i += per) {
    const chunk = keys.slice(i, i + per);
    out.push(
      stmt(
        `DELETE FROM ${def.table} WHERE (${keyList}) IN (VALUES ${chunk.map(() => valueTuple).join(',')})`,
        chunk.flatMap((key) => [...key]),
      ),
    );
  }
  return out;
}

/** Multi-row `INSERT INTO t (cols) VALUES (...), (...)` chunks. */
function insertStatements(
  def: TableDef,
  rows: readonly RowTuple[],
): SqlStatement[] {
  const out: SqlStatement[] = [];
  if (rows.length === 0) {
    return out;
  }
  const colList = def.columns.join(', ');
  const valueTuple = placeholders(def.columns.length);
  const per = Math.max(1, Math.floor(MAX_PARAMS / def.columns.length));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    out.push(
      stmt(
        `INSERT INTO ${def.table} (${colList}) VALUES ${chunk.map(() => valueTuple).join(',')}`,
        chunk.flatMap((row) => [...row]),
      ),
    );
  }
  return out;
}

/** Per-row `UPDATE t SET nonkey=? ... WHERE key=?` for FK parents. */
function updateStatements(
  def: TableDef,
  rows: readonly RowTuple[],
  keyIdx: readonly number[],
  nonKeyIdx: readonly number[],
): SqlStatement[] {
  const setClause = nonKeyIdx
    .map((i) => `${def.columns[i]} = ?`)
    .join(', ');
  const whereClause = keyIdx
    .map((i) => `${def.columns[i]} = ?`)
    .join(' AND ');
  return rows.map((row) =>
    stmt(`UPDATE ${def.table} SET ${setClause} WHERE ${whereClause}`, [
      ...nonKeyIdx.map((i) => row[i] ?? null),
      ...keyIdx.map((i) => row[i] ?? null),
    ]),
  );
}

const sameRow = (a: RowTuple, b: RowTuple): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

type DiffResult = {
  /** Statements for the child-first delete phase. */
  readonly deletes: SqlStatement[];
  /** Statements for the parent-first write phase. */
  readonly writes: SqlStatement[];
  /** Rowid reassignment after writes, for `ORDER BY rowid` tables. */
  readonly reorder: SqlStatement[];
  /** Key tuples present now but absent from the merged section. */
  readonly removedKeys: RowTuple[];
  /** Current/merged pairs sharing a key but differing elsewhere. */
  readonly changedPairs: readonly (readonly [RowTuple, RowTuple])[];
};

/**
 * Diffs already-read current rows against merged row tuples.
 * `reinsertChanged` (update-in-place tables only) forces the
 * delete+insert path for a changed pair — needed when its row still
 * names a parent row this commit deletes, since the in-place UPDATE
 * would land only after that delete broke the immediate FK.
 */
function diffRows(
  def: TableDef,
  currentRows: readonly SqlRow[],
  mergedRows: readonly RowTuple[],
  reinsertChanged?: (cur: RowTuple) => boolean,
): DiffResult {
  const keyIdx = def.key.map((k) => def.columns.indexOf(k));
  const nonKeyIdx = def.columns
    .map((_, i) => i)
    .filter((i) => !keyIdx.includes(i));
  const keyOf = (tuple: RowTuple): string =>
    JSON.stringify(keyIdx.map((i) => tuple[i] ?? null));
  const current = new Map<string, RowTuple>();
  for (const row of currentRows) {
    const tuple = def.columns.map((c) => row[c] ?? null);
    current.set(keyOf(tuple), tuple);
  }
  const merged = new Map<string, RowTuple>();
  for (const tuple of mergedRows) {
    merged.set(keyOf(tuple), tuple);
  }
  const removedKeys: RowTuple[] = [];
  const changedPairs: [RowTuple, RowTuple][] = [];
  for (const [key, tuple] of current) {
    const next = merged.get(key);
    if (next === undefined) {
      removedKeys.push(keyIdx.map((i) => tuple[i] ?? null));
    } else if (!sameRow(tuple, next)) {
      changedPairs.push([tuple, next]);
    }
  }
  const added: RowTuple[] = [];
  const changed: RowTuple[] = changedPairs.map(([, next]) => next);
  for (const [key, tuple] of merged) {
    if (!current.has(key)) {
      added.push(tuple);
    }
  }
  // `reinsert` (leaf) tables: a changed row deletes by its key first —
  // after every delete lands, its replacement inserts freely even on
  // UNIQUE non-key columns (a swapped ordinal/tuple can never collide).
  // On update-in-place tables a changed pair can still be forced down
  // that path when its stored FK target dies this commit.
  const reinsertedPairs = def.reinsert
    ? changedPairs
    : changedPairs.filter(([cur]) => reinsertChanged?.(cur) === true);
  const updatedPairs = def.reinsert
    ? []
    : changedPairs.filter(([cur]) => reinsertChanged?.(cur) !== true);
  const deletes = deleteStatements(def, [
    ...removedKeys,
    ...reinsertedPairs.map(([, next]) => keyIdx.map((i) => next[i] ?? null)),
  ]);
  const writes = [
    ...updateStatements(
      def,
      updatedPairs.map(([, next]) => next),
      keyIdx,
      nonKeyIdx,
    ),
    ...insertStatements(def, [
      ...reinsertedPairs.map(([, next]) => next),
      ...added,
    ]),
  ];
  let reorder: SqlStatement[] = [];
  if (ORDERED_TABLES.has(def)) {
    // Ordered tables are diffed in rowid order. The old commit rewrote
    // every row in array order, so physical order after the writes must
    // equal the merged order: surviving rows keep their rowids (updates
    // do not move a row) and inserts append at the end. When the
    // simulated post-write order differs — a pure reorder, or added
    // rows committed mid-array — reassign rowids 1..N in merged order.
    // The negating pass first dodges rowid collisions between assigns.
    const mergedKeyOrder = mergedRows.map(keyOf);
    const currentKeyOrder = currentRows.map((row) =>
      keyOf(def.columns.map((c) => row[c] ?? null)),
    );
    // Reinserted changed pairs get fresh rowids — they land with the
    // appends, not at their old positions.
    const reinsertedKeys = new Set(
      reinsertedPairs.map(([, next]) => keyOf(next)),
    );
    const postWriteOrder = [
      ...currentKeyOrder.filter(
        (key) => merged.has(key) && !reinsertedKeys.has(key),
      ),
      ...reinsertedPairs.map(([, next]) => keyOf(next)),
      ...mergedKeyOrder.filter((key) => !current.has(key)),
    ];
    if (
      postWriteOrder.length !== mergedKeyOrder.length ||
      postWriteOrder.some((key, i) => key !== mergedKeyOrder[i])
    ) {
      const whereClause = keyIdx
        .map((i) => `${def.columns[i]} = ?`)
        .join(' AND ');
      reorder = [
        stmt(`UPDATE ${def.table} SET rowid = -rowid`),
        ...mergedRows.map((tuple, i) =>
          stmt(`UPDATE ${def.table} SET rowid = ? WHERE ${whereClause}`, [
            i + 1,
            ...keyIdx.map((k) => tuple[k] ?? null),
          ]),
        ),
      ];
    }
  }
  return { deletes, writes, reorder, removedKeys, changedPairs };
}

async function diffTable(
  conn: SqliteConnection,
  def: TableDef,
  mergedRows: readonly RowTuple[],
  signal: CancellationSignal,
  reinsertChanged?: (cur: RowTuple) => boolean,
): Promise<DiffResult> {
  const currentRows = await conn.query<SqlRow>(
    `SELECT ${def.columns.join(', ')} FROM ${def.table}${
      ORDERED_TABLES.has(def) ? ' ORDER BY rowid' : ''
    }`,
    undefined,
    signal,
  );
  return diffRows(def, currentRows, mergedRows, reinsertChanged);
}

/* ------------------------- validation ------------------------------ */

function allUnique<T>(items: readonly T[], key: (item: T) => string): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
  }
  return true;
}

/**
 * Plans a commit's statements: validate the merged document exactly as
 * `isPersistedState` would — provided sections validate element-wise in
 * memory, cross-references resolve against the merged key sets (read
 * narrowly when the parent section isn't in the batch), and provided
 * parents that drop rows probe their unprovided dependents for a
 * dangling foreign key. Only after the whole document validates does
 * the per-table row diff emit writes.
 */
export type CommitPlan = {
  readonly statements: SqlStatement[];
  /** Stored rows the recordings decode dropped (merge path only). */
  readonly dropped: readonly DroppedRow[];
};

export async function planCommit(
  conn: SqliteConnection,
  batch: StorageBatch,
  signal: CancellationSignal,
): Promise<Result<CommitPlan>> {
  const check = (): void => {
    if (signal.cancelled) {
      throw CANCELLED;
    }
  };
  check();
  if (
    batch.recordings !== undefined &&
    batch.recordingsMerge !== undefined
  ) {
    return err(
      appError(
        'internal',
        'commit: recordings and recordingsMerge are exclusive',
      ),
    );
  }
  const attempts = batch.attempts ?? [];

  // ---------------- merged recordings --------------------------------
  // `recordingsMerge` applies to the rows just read inside THIS
  // transaction — a read-modify-write that cannot drop a session write
  // queued between a caller's own load and commit.
  const recordingsTouched =
    batch.recordings !== undefined || batch.recordingsMerge !== undefined;
  let mergedRecordings: readonly Recording[] | undefined;
  let currentRecordings: readonly SqlRow[] = [];
  let currentSourceRefs: readonly SqlRow[] = [];
  let currentMappings: readonly SqlRow[] = [];
  let droppedStored: readonly DroppedRow[] = [];
  let purgedRecordingIds: ReadonlySet<string> = new Set<string>();
  if (recordingsTouched) {
    currentRecordings = await conn.query<SqlRow>(
      `SELECT ${RECORDINGS.columns.join(', ')} FROM recordings ORDER BY rowid`,
      undefined,
      signal,
    );
    currentSourceRefs = await conn.query<SqlRow>(
      `SELECT ${SOURCE_REFS.columns.join(', ')} FROM source_refs ORDER BY recording_id, ordinal`,
      undefined,
      signal,
    );
    currentMappings = await conn.query<SqlRow>(
      `SELECT ${MAPPINGS.columns.join(', ')} FROM mappings ORDER BY recording_id, ordinal`,
      undefined,
      signal,
    );
    check();
    if (batch.recordingsMerge !== undefined) {
      // The stored-row decode is drop-tolerant: malformed rows land in
      // `dropped` instead of failing the merge — the merge applies to
      // the clean subset and the diff deletes what it never saw.
      const decoded = decodeRecordingRows(
        currentRecordings,
        currentSourceRefs,
        currentMappings,
      );
      droppedStored = decoded.dropped;
      purgedRecordingIds = decoded.droppedRecordingIds;
      mergedRecordings = batch.recordingsMerge(decoded.recordings);
    } else {
      mergedRecordings = batch.recordings;
    }
  }

  // ---------------- per-section shape checks -------------------------
  // Element validators + uniqueness, mirroring `isPersistedState` on
  // the merged document — scoped to the sections the batch carries.
  // `recordingsTouched` guards here, not `mergedRecordings`: a merge
  // that returns undefined must still land on the `!Array.isArray`
  // rejection instead of skipping validation as a silent no-op.
  if (
    recordingsTouched &&
    (!Array.isArray(mergedRecordings) ||
      !mergedRecordings.every(isRecording) ||
      !allUnique(mergedRecordings, (r) => r.id))
  ) {
    return err(invalidBatch());
  }
  const likes = batch.likes;
  if (
    likes !== undefined &&
    (!Array.isArray(likes) ||
      !likes.every(isLike) ||
      !allUnique(likes, (l) => `${l.entityKind} ${l.targetId}`))
  ) {
    return err(invalidBatch());
  }
  const entities = batch.entities;
  if (
    entities !== undefined &&
    (!Array.isArray(entities) ||
      !entities.every(isEntity) ||
      !allUnique(entities, (e) => e.entityId))
  ) {
    return err(invalidBatch());
  }
  const entitySourceRefs = batch.entitySourceRefs;
  if (
    entitySourceRefs !== undefined &&
    (!Array.isArray(entitySourceRefs) ||
      !entitySourceRefs.every(isEntitySourceRef) ||
      !allUnique(entitySourceRefs, (r) => `${r.entityId} ${r.provider}`))
  ) {
    return err(invalidBatch());
  }
  const playlists = batch.playlists;
  if (
    playlists !== undefined &&
    (!Array.isArray(playlists) ||
      !playlists.every(isPlaylist) ||
      !allUnique(playlists, (p) => p.playlistId))
  ) {
    return err(invalidBatch());
  }
  const playlistEntries = batch.playlistEntries;
  if (
    playlistEntries !== undefined &&
    (!Array.isArray(playlistEntries) ||
      !playlistEntries.every(isPlaylistEntry) ||
      !allUnique(playlistEntries, (e) => e.entryId) ||
      !allUnique(playlistEntries, (e) => `${e.playlistId} ${e.position}`))
  ) {
    return err(invalidBatch());
  }
  const playHistory = batch.playHistory;
  if (
    playHistory !== undefined &&
    (!Array.isArray(playHistory) ||
      !playHistory.every(isPlayEvent) ||
      !allUnique(playHistory, (e) => e.eventId))
  ) {
    return err(invalidBatch());
  }
  const playCounts = batch.playCounts;
  if (
    playCounts !== undefined &&
    (!Array.isArray(playCounts) ||
      !playCounts.every(isPlayCount) ||
      !allUnique(playCounts, (c) => c.recordingId))
  ) {
    return err(invalidBatch());
  }
  const matchReviews = batch.matchReviews;
  if (
    matchReviews !== undefined &&
    (!Array.isArray(matchReviews) ||
      !matchReviews.every(isMatchReview) ||
      !allUnique(matchReviews, (r) => r.reviewId))
  ) {
    return err(invalidBatch());
  }
  const lyricsCache = batch.lyricsCache;
  if (
    lyricsCache !== undefined &&
    (!Array.isArray(lyricsCache) ||
      !lyricsCache.every(isLyricsCacheEntry) ||
      // recording_id is the PK — the old rewrite's second INSERT
      // rejected a repeated recording; keep that contract.
      !allUnique(lyricsCache, (entry) => entry.recordingId))
  ) {
    return err(invalidBatch());
  }
  const artworkCache = batch.artworkCache;
  if (
    artworkCache !== undefined &&
    (!Array.isArray(artworkCache) ||
      !artworkCache.every(isArtworkCacheEntry) ||
      !allUnique(artworkCache, (a) => a.url))
  ) {
    return err(invalidBatch());
  }
  const downloads = batch.downloads;
  if (
    downloads !== undefined &&
    (!Array.isArray(downloads) ||
      !downloads.every(isDownloadRecord) ||
      !allUnique(downloads, (d) => d.downloadId) ||
      // One download per recording (recording_id UNIQUE in the schema).
      !allUnique(downloads, (d) => d.recordingId))
  ) {
    return err(invalidBatch());
  }
  const localSources = batch.localSources;
  if (
    localSources !== undefined &&
    (!Array.isArray(localSources) ||
      !localSources.every(isLocalSource) ||
      !allUnique(localSources, (s) => s.sourceId))
  ) {
    return err(invalidBatch());
  }
  const localFiles = batch.localFiles;
  if (
    localFiles !== undefined &&
    (!Array.isArray(localFiles) ||
      !localFiles.every(isLocalFile) ||
      !allUnique(localFiles, (f) => f.fileId))
  ) {
    return err(invalidBatch());
  }
  const queue = batch.queue;
  if (queue !== undefined && !isQueueSnapshot(queue)) {
    return err(invalidBatch());
  }
  const settings = batch.settings;
  if (settings !== undefined && !isSettings(settings)) {
    return err(invalidBatch());
  }
  if (!attempts.every(isAttemptTrace)) {
    return err(invalidBatch());
  }
  check();

  // ---------------- section diffs ------------------------------------
  const plans = new Map<TableDef, DiffResult>();
  if (mergedRecordings !== undefined) {
    plans.set(
      RECORDINGS,
      diffRows(
        RECORDINGS,
        currentRecordings,
        mergedRecordings.map(recordingRow),
      ),
    );
    plans.set(
      SOURCE_REFS,
      diffRows(
        SOURCE_REFS,
        currentSourceRefs,
        mergedRecordings.flatMap((r) =>
          r.sourceRefs.map((ref, ordinal) =>
            sourceRefRow(r.id, ordinal, ref),
          ),
        ),
      ),
    );
    plans.set(
      MAPPINGS,
      diffRows(
        MAPPINGS,
        currentMappings,
        mergedRecordings.flatMap((r) =>
          r.mappings.map((mapping, ordinal) =>
            mappingRow(r.id, ordinal, mapping),
          ),
        ),
      ),
    );
  }
  if (likes !== undefined) {
    plans.set(LIKES, await diffTable(conn, LIKES, likes.map(likeRow), signal));
  }
  if (entities !== undefined) {
    plans.set(
      ENTITIES,
      await diffTable(conn, ENTITIES, entities.map(entityRow), signal),
    );
  }
  if (entitySourceRefs !== undefined) {
    plans.set(
      ENTITY_SOURCE_REFS,
      await diffTable(
        conn,
        ENTITY_SOURCE_REFS,
        entitySourceRefs.map(entitySourceRefRow),
        signal,
      ),
    );
  }
  if (playlists !== undefined) {
    plans.set(
      PLAYLISTS,
      await diffTable(conn, PLAYLISTS, playlists.map(playlistRow), signal),
    );
  }
  if (playlistEntries !== undefined) {
    plans.set(
      PLAYLIST_ENTRIES,
      await diffTable(
        conn,
        PLAYLIST_ENTRIES,
        playlistEntries.map(playlistEntryRow),
        signal,
      ),
    );
  }
  if (playHistory !== undefined) {
    plans.set(
      PLAY_HISTORY,
      await diffTable(
        conn,
        PLAY_HISTORY,
        playHistory.map(playEventRow),
        signal,
      ),
    );
  }
  if (playCounts !== undefined) {
    plans.set(
      PLAY_COUNTS,
      await diffTable(
        conn,
        PLAY_COUNTS,
        playCounts.map(playCountRow),
        signal,
      ),
    );
  }
  if (matchReviews !== undefined) {
    // match_reviews.recording_id is a non-key immediate FK: a changed
    // row that still names a recording this commit deletes must take
    // the delete+insert path — its UPDATE would land after the delete.
    const goneRecordings = new Set(
      (plans.get(RECORDINGS)?.removedKeys ?? []).map((key) => key[0]),
    );
    const recordingIdx = MATCH_REVIEWS.columns.indexOf('recording_id');
    plans.set(
      MATCH_REVIEWS,
      await diffTable(
        conn,
        MATCH_REVIEWS,
        matchReviews.map(matchReviewRow),
        signal,
        goneRecordings.size === 0
          ? undefined
          : (cur) => goneRecordings.has(cur[recordingIdx] as string),
      ),
    );
  }
  if (lyricsCache !== undefined) {
    plans.set(
      LYRICS_CACHE,
      await diffTable(
        conn,
        LYRICS_CACHE,
        lyricsCache.map(lyricsCacheRow),
        signal,
      ),
    );
  }
  if (artworkCache !== undefined) {
    plans.set(
      ARTWORK_CACHE,
      await diffTable(
        conn,
        ARTWORK_CACHE,
        artworkCache.map(artworkCacheRow),
        signal,
      ),
    );
  }
  if (downloads !== undefined) {
    plans.set(
      DOWNLOADS,
      await diffTable(
        conn,
        DOWNLOADS,
        downloads.map(downloadRow),
        signal,
      ),
    );
  }
  if (localSources !== undefined) {
    plans.set(
      LOCAL_SOURCES,
      await diffTable(
        conn,
        LOCAL_SOURCES,
        localSources.map(localSourceRow),
        signal,
      ),
    );
  }
  if (localFiles !== undefined) {
    plans.set(
      LOCAL_FILES,
      await diffTable(
        conn,
        LOCAL_FILES,
        localFiles.map(localFileRow),
        signal,
      ),
    );
  }
  if (queue !== undefined) {
    plans.set(
      QUEUE_OCCURRENCES,
      await diffTable(
        conn,
        QUEUE_OCCURRENCES,
        queue.occurrences.map((occurrence, ordinal) =>
          queueOccurrenceRow(
            occurrence.occurrenceId,
            ordinal,
            occurrence.recordingId,
            occurrence.selectedRef,
          ),
        ),
        signal,
      ),
    );
  }

  // ---------------- merged key sets ----------------------------------
  // A dependent section in the batch resolves its foreign keys against
  // the merged parent — read only the key columns when the parent
  // itself isn't being rewritten.
  let recIds: ReadonlySet<string> | undefined;
  const getRecordingIds = async (): Promise<ReadonlySet<string>> => {
    if (recIds === undefined) {
      if (mergedRecordings !== undefined) {
        recIds = new Set(mergedRecordings.map((r) => r.id));
      } else {
        recIds = new Set(
          (
            await conn.query<SqlRow>(
              'SELECT id FROM recordings',
              undefined,
              signal,
            )
          ).map((row) => row['id'] as string),
        );
        check();
      }
    }
    return recIds;
  };
  let entityKinds: ReadonlyMap<string, Entity['kind']> | undefined;
  const getEntityKinds = async (): Promise<
    ReadonlyMap<string, Entity['kind']>
  > => {
    if (entityKinds === undefined) {
      if (entities !== undefined) {
        entityKinds = new Map(entities.map((e) => [e.entityId, e.kind]));
      } else {
        entityKinds = new Map(
          (
            await conn.query<SqlRow>(
              'SELECT entity_id, kind FROM entities',
              undefined,
              signal,
            )
          ).map((row) => [
            row['entity_id'] as string,
            row['kind'] as Entity['kind'],
          ]),
        );
        check();
      }
    }
    return entityKinds;
  };
  let playlistIds: ReadonlySet<string> | undefined;
  const getPlaylistIds = async (): Promise<ReadonlySet<string>> => {
    if (playlistIds === undefined) {
      if (playlists !== undefined) {
        playlistIds = new Set(playlists.map((p) => p.playlistId));
      } else {
        playlistIds = new Set(
          (
            await conn.query<SqlRow>(
              'SELECT playlist_id FROM playlists',
              undefined,
              signal,
            )
          ).map((row) => row['playlist_id'] as string),
        );
        check();
      }
    }
    return playlistIds;
  };
  let localSourceIds: ReadonlySet<string> | undefined;
  const getLocalSourceIds = async (): Promise<ReadonlySet<string>> => {
    if (localSourceIds === undefined) {
      if (localSources !== undefined) {
        localSourceIds = new Set(localSources.map((s) => s.sourceId));
      } else {
        localSourceIds = new Set(
          (
            await conn.query<SqlRow>(
              'SELECT source_id FROM local_sources',
              undefined,
              signal,
            )
          ).map((row) => row['source_id'] as string),
        );
        check();
      }
    }
    return localSourceIds;
  };

  // ---------------- cross-reference checks ---------------------------
  // Foreign keys from provided dependents into their merged parents —
  // the same resolutions `isPersistedState` enforces document-wide.
  if (likes !== undefined) {
    for (const like of likes) {
      const resolves =
        like.entityKind === 'track'
          ? (await getRecordingIds()).has(like.targetId)
          : (await getEntityKinds()).get(like.targetId) === like.entityKind;
      if (!resolves) {
        return err(invalidBatch());
      }
    }
  }
  if (entitySourceRefs !== undefined) {
    const kinds = await getEntityKinds();
    for (const ref of entitySourceRefs) {
      // The ref's kind must agree with the target entity's kind.
      if (kinds.get(ref.entityId) !== ref.ref.kind) {
        return err(invalidBatch());
      }
    }
  }
  if (playlistEntries !== undefined) {
    const ids = await getPlaylistIds();
    const recordingIdSet = await getRecordingIds();
    for (const entry of playlistEntries) {
      if (
        !ids.has(entry.playlistId) ||
        !recordingIdSet.has(entry.recordingId)
      ) {
        return err(invalidBatch());
      }
    }
  }
  if (playHistory !== undefined) {
    const recordingIdSet = await getRecordingIds();
    for (const event of playHistory) {
      if (!recordingIdSet.has(event.recordingId)) {
        return err(invalidBatch());
      }
    }
  }
  if (playCounts !== undefined) {
    const recordingIdSet = await getRecordingIds();
    for (const count of playCounts) {
      if (!recordingIdSet.has(count.recordingId)) {
        return err(invalidBatch());
      }
    }
  }
  if (matchReviews !== undefined) {
    const recordingIdSet = await getRecordingIds();
    for (const review of matchReviews) {
      if (!recordingIdSet.has(review.recordingId)) {
        return err(invalidBatch());
      }
    }
  }
  if (lyricsCache !== undefined) {
    const recordingIdSet = await getRecordingIds();
    for (const entry of lyricsCache) {
      if (!recordingIdSet.has(entry.recordingId)) {
        return err(invalidBatch());
      }
    }
  }
  if (downloads !== undefined) {
    const recordingIdSet = await getRecordingIds();
    for (const download of downloads) {
      if (!recordingIdSet.has(download.recordingId)) {
        return err(invalidBatch());
      }
    }
  }
  if (localFiles !== undefined) {
    const sourceIdSet = await getLocalSourceIds();
    const recordingIdSet = await getRecordingIds();
    for (const file of localFiles) {
      if (
        !sourceIdSet.has(file.sourceId) ||
        !recordingIdSet.has(file.recordingId)
      ) {
        return err(invalidBatch());
      }
    }
  }
  if (queue !== undefined && queue.occurrences.length > 0) {
    const recordingIdSet = await getRecordingIds();
    for (const occurrence of queue.occurrences) {
      if (!recordingIdSet.has(occurrence.recordingId)) {
        return err(invalidBatch());
      }
    }
  }

  // ---------------- dependent probes ---------------------------------
  // A provided parent that removes rows (or, for entities, changes a
  // kind) breaks an unprovided dependent's foreign key in place — the
  // merged document would dangle, exactly as `isPersistedState` finds
  // on the rebuilt document. Probe only the affected keys.
  // Decode-dropped recordings purge wholesale — their dependents get
  // explicit deletes below, so the probes only guard recordings the
  // merge itself removed.
  const removedRecordingIds = (
    plans.get(RECORDINGS)?.removedKeys ?? []
  )
    .map((key) => key[0] as string)
    .filter((id) => !purgedRecordingIds.has(id));
  const entityPlan = plans.get(ENTITIES);
  const kindIndex = ENTITIES.columns.indexOf('kind');
  const touchedEntityIds =
    entityPlan === undefined
      ? []
      : [
          ...entityPlan.removedKeys.map((key) => key[0] as string),
          ...entityPlan.changedPairs
            .filter(([cur, next]) => cur[kindIndex] !== next[kindIndex])
            .map(([, next]) => next[0] as string),
        ];
  const removedPlaylistIds = (
    plans.get(PLAYLISTS)?.removedKeys ?? []
  ).map((key) => key[0] as string);
  const removedSourceIds = (
    plans.get(LOCAL_SOURCES)?.removedKeys ?? []
  ).map((key) => key[0] as string);

  // Probe queries stay under the bridge's per-query parameter cap —
  // id lists chunk at the same bound the write statements use.
  const probeChunks = async (
    sql: (inClause: string) => string,
    ids: readonly string[],
  ): Promise<readonly SqlRow[]> => {
    const rows: SqlRow[] = [];
    for (let i = 0; i < ids.length; i += MAX_PARAMS) {
      const chunk = ids.slice(i, i + MAX_PARAMS);
      rows.push(
        ...(await conn.query<SqlRow>(
          sql(placeholders(chunk.length)),
          chunk,
          signal,
        )),
      );
    }
    return rows;
  };

  if (removedRecordingIds.length > 0) {
    const dependents: readonly (readonly [
      skip: boolean,
      table: string,
    ])[] = [
      [queue !== undefined, 'queue_occurrences'],
      [playHistory !== undefined, 'play_history'],
      [playCounts !== undefined, 'play_counts'],
      [matchReviews !== undefined, 'match_reviews'],
      [lyricsCache !== undefined, 'lyrics_cache'],
      [downloads !== undefined, 'downloads'],
    ];
    for (const [skip, table] of dependents) {
      if (skip) {
        continue;
      }
      const hit = await probeChunks(
        (inIds) =>
          `SELECT 1 FROM ${table} WHERE recording_id IN ${inIds} LIMIT 1`,
        removedRecordingIds,
      );
      if (hit.length > 0) {
        return err(invalidBatch());
      }
    }
  }
  if (playlistEntries === undefined) {
    const conds: readonly (readonly [string, readonly string[]])[] = [
      ['playlist_id', removedPlaylistIds],
      ['recording_id', removedRecordingIds],
    ];
    for (const [column, ids] of conds) {
      if (ids.length === 0) {
        continue;
      }
      const hit = await probeChunks(
        (inIds) =>
          `SELECT 1 FROM playlist_entries WHERE ${column} IN ${inIds} LIMIT 1`,
        ids,
      );
      if (hit.length > 0) {
        return err(invalidBatch());
      }
    }
  }
  if (localFiles === undefined) {
    const conds: readonly (readonly [string, readonly string[]])[] = [
      ['source_id', removedSourceIds],
      ['recording_id', removedRecordingIds],
    ];
    for (const [column, ids] of conds) {
      if (ids.length === 0) {
        continue;
      }
      const hit = await probeChunks(
        (inIds) =>
          `SELECT 1 FROM local_files WHERE ${column} IN ${inIds} LIMIT 1`,
        ids,
      );
      if (hit.length > 0) {
        return err(invalidBatch());
      }
    }
  }
  // likes.target_id is polymorphic — a removed recording dangles a
  // 'track' like; a removed/re-kinded entity dangles the rest.
  if (likes === undefined) {
    if (
      removedRecordingIds.length > 0 &&
      (
        await probeChunks(
          (inIds) =>
            `SELECT 1 FROM likes WHERE entity_kind = 'track' AND target_id IN ${inIds} LIMIT 1`,
          removedRecordingIds,
        )
      ).length > 0
    ) {
      return err(invalidBatch());
    }
    if (touchedEntityIds.length > 0) {
      const rows = await probeChunks(
        (inIds) =>
          `SELECT entity_kind, target_id FROM likes WHERE entity_kind != 'track' AND target_id IN ${inIds}`,
        touchedEntityIds,
      );
      const kinds = await getEntityKinds();
      for (const row of rows) {
        const kind = row['entity_kind'];
        const target = row['target_id'] as string;
        if (kinds.get(target) !== kind) {
          return err(invalidBatch());
        }
      }
    }
  }
  if (entitySourceRefs === undefined && touchedEntityIds.length > 0) {
    const kinds = await getEntityKinds();
    const rows = await probeChunks(
      (inIds) =>
        `SELECT entity_id, ref_json FROM entity_source_refs WHERE entity_id IN ${inIds}`,
      touchedEntityIds,
    );
    for (const row of rows) {
      let refKind: unknown = undefined;
      const text = row['ref_json'];
      if (typeof text === 'string') {
        try {
          const parsed: unknown = JSON.parse(text);
          refKind =
            typeof parsed === 'object' && parsed !== null
              ? (parsed as Record<string, unknown>)['kind']
              : undefined;
        } catch {
          refKind = undefined;
        }
      }
      if (kinds.get(row['entity_id'] as string) !== refKind) {
        return err(invalidBatch());
      }
    }
  }
  check();

  // ---------------- write plan ---------------------------------------
  // Deletes run child-first; writes parent-first. `reinsert` leaf
  // tables put their changed-row deletes in the early phase so a
  // UNIQUE non-key column never sees its replacement collide.
  const statements: SqlStatement[] = [];
  // Purge pass: recordings the merge decode dropped fall to the row
  // diff's plain delete — the dependents that don't cascade on their
  // recording FK need explicit deletes first (source_refs/mappings/
  // downloads/local_files cascade; entity_source_refs key on
  // entities). The queue_state playhead must release before the
  // occurrence rows it can name are deleted.
  // A merge that rewrites a decode-dropped recording keeps that
  // recording's dependents: purge only ids absent from the merged doc.
  const retainedIds = new Set(
    (mergedRecordings ?? []).map((recording) => recording.id),
  );
  const purgedIds = [...purgedRecordingIds].filter(
    (id) => !retainedIds.has(id),
  );
  for (let i = 0; i < purgedIds.length; i += MAX_PARAMS) {
    const chunk = purgedIds.slice(i, i + MAX_PARAMS);
    const inIds = placeholders(chunk.length);
    statements.push(
      stmt(
        `UPDATE queue_state SET
           current_occurrence_id = NULL,
           position_ms = 0,
           mode = 'stopped',
           blocked_error_json = NULL
         WHERE current_occurrence_id IN (
           SELECT occurrence_id FROM queue_occurrences
           WHERE recording_id IN ${inIds})`,
        chunk,
      ),
      stmt(
        `DELETE FROM queue_occurrences WHERE recording_id IN ${inIds}`,
        chunk,
      ),
      stmt(
        `DELETE FROM playlist_entries WHERE recording_id IN ${inIds}`,
        chunk,
      ),
      stmt(
        `DELETE FROM play_history WHERE recording_id IN ${inIds}`,
        chunk,
      ),
      stmt(
        `DELETE FROM play_counts WHERE recording_id IN ${inIds}`,
        chunk,
      ),
      stmt(
        `DELETE FROM match_reviews WHERE recording_id IN ${inIds}`,
        chunk,
      ),
      stmt(
        `DELETE FROM lyrics_cache WHERE recording_id IN ${inIds}`,
        chunk,
      ),
      // likes.target_id is polymorphic — no FK, so track likes on a
      // purged recording would dangle.
      stmt(
        `DELETE FROM likes WHERE entity_kind = 'track' AND target_id IN ${inIds}`,
        chunk,
      ),
    );
  }
  const DELETE_ORDER: readonly TableDef[] = [
    QUEUE_OCCURRENCES,
    PLAYLIST_ENTRIES,
    PLAY_HISTORY,
    PLAY_COUNTS,
    MATCH_REVIEWS,
    LYRICS_CACHE,
    DOWNLOADS,
    LOCAL_FILES,
    LOCAL_SOURCES,
    LIKES,
    ENTITY_SOURCE_REFS,
    ENTITIES,
    PLAYLISTS,
    MAPPINGS,
    SOURCE_REFS,
    RECORDINGS,
    ARTWORK_CACHE,
  ];
  const WRITE_ORDER: readonly TableDef[] = [
    RECORDINGS,
    SOURCE_REFS,
    MAPPINGS,
    ENTITIES,
    ENTITY_SOURCE_REFS,
    PLAYLISTS,
    PLAYLIST_ENTRIES,
    LIKES,
    PLAY_HISTORY,
    PLAY_COUNTS,
    MATCH_REVIEWS,
    LYRICS_CACHE,
    DOWNLOADS,
    LOCAL_SOURCES,
    LOCAL_FILES,
    ARTWORK_CACHE,
    QUEUE_OCCURRENCES,
  ];
  for (const def of DELETE_ORDER) {
    const plan = plans.get(def);
    if (plan !== undefined) {
      statements.push(...plan.deletes);
    }
  }
  check();
  for (const def of WRITE_ORDER) {
    const plan = plans.get(def);
    if (plan !== undefined) {
      statements.push(...plan.writes);
      statements.push(...plan.reorder);
    }
  }
  if (queue !== undefined) {
    statements.push(
      stmt(
        `INSERT OR REPLACE INTO queue_state (${QUEUE_STATE_COLUMNS.join(', ')})
         VALUES ${placeholders(QUEUE_STATE_COLUMNS.length)}`,
        queueStateRow(queue),
      ),
    );
  }
  if (settings !== undefined) {
    statements.push(
      stmt(
        `INSERT OR REPLACE INTO settings (${SETTINGS_COLUMNS.join(', ')})
         VALUES ${placeholders(SETTINGS_COLUMNS.length)}`,
        settingsRow(settings),
      ),
    );
  }
  const attemptRows = attempts.map((trace) => [
    trace.requestId,
    JSON.stringify(trace),
  ]);
  // A landed-but-unacked COMMIT replays this whole batch: attempt
  // inserts are append-only with no dedup constraint, so this batch's
  // request_ids are deleted first — the replay re-inserts the
  // identical set instead of doubling it. requestIds are generated
  // per attempt, so the delete only ever names this batch's own rows.
  statements.push(
    ...deleteStatements(
      {
        table: 'attempt_traces',
        columns: ['request_id'],
        key: ['request_id'],
        reinsert: false,
      },
      attempts.map((trace) => [trace.requestId]),
    ),
    ...insertStatements(
      { table: 'attempt_traces', columns: ['request_id', 'trace_json'], key: [], reinsert: false },
      attemptRows,
    ),
  );
  statements.push(
    stmt(
      `DELETE FROM attempt_traces WHERE seq NOT IN (SELECT seq FROM attempt_traces ORDER BY seq DESC LIMIT ${ATTEMPT_CAP})`,
    ),
  );
  return ok({ statements, dropped: droppedStored });
}
