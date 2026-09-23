/**
 * Domain projection — the two directions that bridge the sync change
 * log and the owned-domain sections:
 *
 * - `emissionWrites(prev, batch)` maps a committed domain batch to
 *   `LocalWrite[]` — the whitelist surface exactly: whole-row upserts
 *   for new/changed rows, tombstones for vanished rows (with the
 *   domain's delete cascade mirrored into record tombstones).
 * - `projectAppliedEntries(outcomes, current)` folds remote `applied`
 *   merge outcomes onto the persisted sections and returns a
 *   `StorageBatch` — valid rows only. A partial insert takes domain
 *   defaults or stays `pending` until its required fields arrive; a
 *   malformed record is `skipped`, never committed.
 *
 * Pure: no IO, no clock, nothing beyond the public record-id
 * encoders, the field whitelist, and the domain validators.
 */

import type {
  DownloadRecord,
  Like,
  LocalFile,
  Recording,
  Settings,
  SourceMapping,
  SourceRef,
} from '../domain.ts';
import { isLike, isRecording, isSettings } from '../domain.ts';
import type {
  Entity,
  EntitySourceRef,
  ExportDocument,
  LyricsCacheEntry,
  MatchReview,
  PlayCount,
  PlayEvent,
  Playlist,
  PlaylistEntry,
} from '../library/library.ts';
import {
  isEntity,
  isEntitySourceRef,
  isMatchReview,
  isPlayCount,
  isPlayEvent,
  isPlaylist,
  isPlaylistEntry,
} from '../library/library.ts';
import type { PersistedState, StorageBatch } from '../ports/storage.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import { QueueEngine } from '../queue/queue-engine.ts';
import { compareStamp } from './hlc.ts';
import type {
  ChangeEntry,
  LocalWrite,
  MaterializedRecord,
  MergeOutcome,
  SyncRecordKind,
} from './sync-engine.ts';
import {
  decodeRecordId,
  entitySourceRefRecordId,
  isChangeEntry,
  isMaterializedRecord,
  likeRecordId,
  mappingRecordId,
  SETTINGS_RECORD_ID,
  sourceRefRecordId,
  SYNC_FIELD_RULES,
} from './sync-engine.ts';

// ---- shared shapes --------------------------------------------------------

/**
 * The sections emission diffs a committed batch against. Mirrors the
 * session's `Ready` sections plus `settings`; `matchReviews` is
 * optional — the session mirror doesn't carry them, and callers that
 * do (import) pass them so recording-delete cascades stay complete.
 */
export type SyncEmitInput = {
  readonly recordings: readonly Recording[];
  readonly likes: readonly Like[];
  readonly entities: readonly Entity[];
  readonly entitySourceRefs: readonly EntitySourceRef[];
  readonly playlists: readonly Playlist[];
  readonly playlistEntries: readonly PlaylistEntry[];
  readonly playHistory: readonly PlayEvent[];
  readonly playCounts: readonly PlayCount[];
  readonly settings: Settings;
  readonly matchReviews?: readonly MatchReview[];
};

/** The persisted sections the inbound projection folds over. */
export type SyncProjectionInput = Pick<
  PersistedState,
  | 'recordings'
  | 'likes'
  | 'entities'
  | 'entitySourceRefs'
  | 'playlists'
  | 'playlistEntries'
  | 'playHistory'
  | 'playCounts'
  | 'matchReviews'
  | 'lyricsCache'
  | 'downloads'
  | 'localFiles'
  | 'queue'
  | 'settings'
>;

/** A record that can never materialize — the caller typed-logs it.
 * `kind` is 'unknown' when the wire shape itself was rejected — a
 * malformed entry can't name a trusted SyncRecordKind to log. */
export type ProjectionSkip = {
  readonly kind: SyncRecordKind | 'unknown';
  readonly reason: 'unmaterializable' | 'invalid';
};

export type SyncProjection = {
  /**
   * Changed sections only. `recordings` rides `recordingsMerge` so a
   * LocalFileSource commit landing between the caller's load and its
   * commit is preserved — the plan re-applies over the transaction's
   * own freshest rows.
   */
  readonly batch: StorageBatch;
  /** Applied outcomes for records still awaiting required fields. */
  readonly pending: readonly MergeOutcome[];
  /**
   * Materialized records that could not materialize this pass — a
   * dependent whose parent has not arrived yet (a rebuild page may
   * order it before the parent). The caller retains them and unions
   * them into the next `projectMaterialized` call — paged rebuilds
   * stay memory-bounded without dropping cross-page dependents.
   */
  readonly pendingRecords: readonly MaterializedRecord[];
  /** Records that can never materialize — log these (kind only). */
  readonly skipped: readonly ProjectionSkip[];
  readonly changedKinds: readonly SyncRecordKind[];
};

const KEY_SEP = '\u001f';

function decodeParts(
  recordId: string,
  count: number,
): readonly string[] | null {
  const parts = decodeRecordId(recordId);
  return parts !== null && parts.length === count ? parts : null;
}

function sameRef(a: SourceRef, b: SourceRef): boolean {
  return a.provider === b.provider && a.kind === b.kind && a.id === b.id;
}

function sameMapping(a: SourceMapping, b: SourceMapping): boolean {
  return (
    sameRef(a.ref, b.ref) &&
    a.status === b.status &&
    a.matchedAtMs === b.matchedAtMs
  );
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]))
    );
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  return (
    aKeys.length === Object.keys(bObj).length &&
    aKeys.every((k) => Object.hasOwn(bObj, k) && jsonEqual(aObj[k], bObj[k]))
  );
}

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---- emission: domain rows → LocalWrite[] ---------------------------------

const RECORDING_SYNC_FIELDS = [
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
] as const;

const ENTITY_SYNC_FIELDS = [
  'kind',
  'title',
  'artistName',
  'artwork',
  'createdMs',
] as const;

const PLAYLIST_SYNC_FIELDS = ['name', 'createdMs', 'updatedMs'] as const;

const PLAYLIST_ENTRY_SYNC_FIELDS = [
  'playlistId',
  'recordingId',
  'position',
  'selectedRef',
  'addedMs',
] as const;

const PLAY_COUNT_SYNC_FIELDS = ['count', 'lastMs'] as const;

const MATCH_REVIEW_SYNC_FIELDS = [
  'recordingId',
  'createdMs',
  'status',
  'resolution',
  'resolvedMs',
  'candidates',
] as const;

const SETTINGS_SYNC_FIELDS = [
  'theme',
  'storefront',
  'catalogProvider',
  'playbackProvider',
  'lyricsProvider',
  'radioProvider',
  'qualityKbps',
  'prefetch',
] as const;

function fieldWrite(
  kind: SyncRecordKind,
  recordId: string,
  field: string,
  value: unknown,
): LocalWrite {
  return { kind, recordId, field, value };
}

function tombstoneWrite(kind: SyncRecordKind, recordId: string): LocalWrite {
  return { kind, recordId, tombstone: true };
}

function sourceRefUpsertWrite(
  recordingId: string,
  ref: SourceRef,
): LocalWrite {
  return {
    kind: 'recordingSourceRef',
    recordId: sourceRefRecordId(recordingId, ref),
    field: 'ref',
    value: ref,
  };
}

function mappingUpsertWrite(
  recordingId: string,
  mapping: SourceMapping,
): LocalWrite {
  return {
    kind: 'recordingMapping',
    recordId: mappingRecordId(recordingId, mapping),
    field: 'mapping',
    value: mapping,
  };
}

/**
 * Full recording upsert: every whitelisted field plus a presence
 * record for every ref/mapping the row carries. `prev` drives the
 * presence diff — a ref or mapping the update dropped tombstones
 * under its own record id so the remote's row loses it too.
 */
export function recordingUpsertWrites(
  next: Recording,
  prev?: Recording | undefined,
): LocalWrite[] {
  const writes: LocalWrite[] = [];
  for (const field of RECORDING_SYNC_FIELDS) {
    writes.push(fieldWrite('recording', next.id, field, next[field]));
  }
  const prevRefs = prev?.sourceRefs ?? [];
  for (const ref of next.sourceRefs) {
    if (prevRefs.every((p) => !sameRef(p, ref))) {
      writes.push(sourceRefUpsertWrite(next.id, ref));
    }
  }
  for (const ref of prevRefs) {
    if (next.sourceRefs.every((n) => !sameRef(n, ref))) {
      writes.push(
        tombstoneWrite(
          'recordingSourceRef',
          sourceRefRecordId(next.id, ref),
        ),
      );
    }
  }
  const prevMappings = prev?.mappings ?? [];
  for (const mapping of next.mappings) {
    if (prevMappings.every((p) => !sameMapping(p, mapping))) {
      writes.push(mappingUpsertWrite(next.id, mapping));
    }
  }
  for (const mapping of prevMappings) {
    if (next.mappings.every((n) => !sameMapping(n, mapping))) {
      writes.push(
        tombstoneWrite(
          'recordingMapping',
          mappingRecordId(next.id, mapping),
        ),
      );
    }
  }
  return writes;
}

/**
 * Recording delete plus the dependent records the domain cascade
 * drops with it: ref/mapping presence rows, playlist entries and
 * play rows keyed to it, its count, a track like, and its reviews.
 */
export function recordingDeleteWrites(
  recording: Recording,
  dependents: Pick<
    SyncEmitInput,
    'playlistEntries' | 'playHistory' | 'matchReviews'
  >,
): LocalWrite[] {
  const writes: LocalWrite[] = [
    tombstoneWrite('recording', recording.id),
  ];
  for (const ref of recording.sourceRefs) {
    writes.push(
      tombstoneWrite(
        'recordingSourceRef',
        sourceRefRecordId(recording.id, ref),
      ),
    );
  }
  for (const mapping of recording.mappings) {
    writes.push(
      tombstoneWrite(
        'recordingMapping',
        mappingRecordId(recording.id, mapping),
      ),
    );
  }
  for (const entry of dependents.playlistEntries) {
    if (entry.recordingId === recording.id) {
      writes.push(tombstoneWrite('playlistEntry', entry.entryId));
    }
  }
  for (const event of dependents.playHistory) {
    if (event.recordingId === recording.id) {
      writes.push(tombstoneWrite('playEvent', event.eventId));
    }
  }
  writes.push(tombstoneWrite('playCount', recording.id));
  for (const review of dependents.matchReviews ?? []) {
    if (review.recordingId === recording.id) {
      writes.push(tombstoneWrite('matchReview', review.reviewId));
    }
  }
  writes.push(
    tombstoneWrite('like', likeRecordId('track', recording.id)),
  );
  return writes;
}

/**
 * Entity upsert: whitelisted fields plus each live source ref. Ref
 * rows are keyed (entityId, provider) — a vanished provider tombstones.
 */
export function entityUpsertWrites(
  entity: Entity,
  refs: readonly EntitySourceRef[],
  prevRefs?: readonly EntitySourceRef[],
): LocalWrite[] {
  const writes: LocalWrite[] = [];
  for (const field of ENTITY_SYNC_FIELDS) {
    writes.push(
      fieldWrite('entity', entity.entityId, field, entity[field]),
    );
  }
  const prev = prevRefs ?? [];
  for (const ref of refs) {
    // Same-provider row with a changed ref value is still an upsert —
    // provider-key presence alone would silently absorb the edit.
    const prior = prev.find((p) => p.provider === ref.provider);
    if (prior === undefined || !jsonEqual(prior.ref, ref.ref)) {
      writes.push({
        kind: 'entitySourceRef',
        recordId: entitySourceRefRecordId(entity.entityId, ref.provider),
        field: 'ref',
        value: ref.ref,
      });
    }
  }
  for (const ref of prev) {
    if (refs.every((n) => n.provider !== ref.provider)) {
      writes.push(
        tombstoneWrite(
          'entitySourceRef',
          entitySourceRefRecordId(entity.entityId, ref.provider),
        ),
      );
    }
  }
  return writes;
}

/** Entity delete: the entity, its refs, and a like keyed to it. */
export function entityDeleteWrites(
  entity: Entity,
  refs: readonly EntitySourceRef[],
): LocalWrite[] {
  const writes: LocalWrite[] = [
    tombstoneWrite('entity', entity.entityId),
  ];
  for (const ref of refs) {
    writes.push(
      tombstoneWrite(
        'entitySourceRef',
        entitySourceRefRecordId(entity.entityId, ref.provider),
      ),
    );
  }
  writes.push(
    tombstoneWrite('like', likeRecordId(entity.kind, entity.entityId)),
  );
  return writes;
}

/** One review row — all whitelisted fields under its reviewId. */
export function reviewSyncWrites(review: MatchReview): LocalWrite[] {
  return MATCH_REVIEW_SYNC_FIELDS.map((field) =>
    fieldWrite('matchReview', review.reviewId, field, review[field]),
  );
}

/** Only the whitelisted settings fields that actually changed. */
export function settingsWrites(
  prev: Settings,
  next: Settings,
): LocalWrite[] {
  const writes: LocalWrite[] = [];
  for (const field of SETTINGS_SYNC_FIELDS) {
    if (!jsonEqual(prev[field], next[field])) {
      writes.push(
        fieldWrite('settings', SETTINGS_RECORD_ID, field, next[field]),
      );
    }
  }
  return writes;
}

/**
 * The generic commit seam: diff every synced section a batch writes
 * against the committed-pre sections and emit the mapped writes.
 * Whole-row upserts for new/changed rows (idempotent — stamping a
 * field a second time just mints a newer winner), tombstones for rows
 * that vanished, cascades mirrored for deletes. Sections outside the
 * whitelist (queue, caches, downloads, local files, attempts) never
 * emit — there is no record kind for them.
 */
export function emissionWrites(
  prev: SyncEmitInput,
  batch: StorageBatch,
): LocalWrite[] {
  const writes: LocalWrite[] = [];
  const matchReviews = prev.matchReviews ?? [];

  if (batch.recordings !== undefined) {
    const prevById = new Map(prev.recordings.map((rec) => [rec.id, rec]));
    const nextIds = new Set(batch.recordings.map((rec) => rec.id));
    for (const rec of batch.recordings) {
      const before = prevById.get(rec.id);
      if (before !== rec) {
        writes.push(...recordingUpsertWrites(rec, before));
      }
    }
    for (const rec of prev.recordings) {
      if (!nextIds.has(rec.id)) {
        writes.push(
          ...recordingDeleteWrites(rec, {
            playlistEntries: prev.playlistEntries,
            playHistory: prev.playHistory,
            matchReviews,
          }),
        );
      }
    }
  }

  if (batch.likes !== undefined) {
    const keyOf = (like: Like): string =>
      `${like.entityKind}${KEY_SEP}${like.targetId}`;
    const prevKeys = new Map(prev.likes.map((like) => [keyOf(like), like]));
    const nextKeys = new Set(batch.likes.map(keyOf));
    for (const like of batch.likes) {
      if (prevKeys.get(keyOf(like)) !== like) {
        writes.push({
          kind: 'like',
          recordId: likeRecordId(like.entityKind, like.targetId),
          field: 'like',
          value: like,
        });
      }
    }
    for (const like of prev.likes) {
      if (!nextKeys.has(keyOf(like))) {
        writes.push(
          tombstoneWrite(
            'like',
            likeRecordId(like.entityKind, like.targetId),
          ),
        );
      }
    }
  }

  if (batch.entities !== undefined) {
    const prevById = new Map(prev.entities.map((e) => [e.entityId, e]));
    const nextIds = new Set(batch.entities.map((e) => e.entityId));
    const refsOf = (
      rows: readonly EntitySourceRef[],
    ): Map<string, EntitySourceRef[]> => {
      const map = new Map<string, EntitySourceRef[]>();
      for (const ref of rows) {
        const list = map.get(ref.entityId) ?? [];
        list.push(ref);
        map.set(ref.entityId, list);
      }
      return map;
    };
    const prevRefs = refsOf(prev.entitySourceRefs);
    const nextRefs = refsOf(batch.entitySourceRefs ?? prev.entitySourceRefs);
    for (const entity of batch.entities) {
      if (prevById.get(entity.entityId) !== entity) {
        writes.push(
          ...entityUpsertWrites(
            entity,
            nextRefs.get(entity.entityId) ?? [],
            prevRefs.get(entity.entityId) ?? [],
          ),
        );
      }
    }
    // An unchanged entity whose ref set still moved (a late-arriving
    // ref rides the same commit's entitySourceRefs section) emits
    // just the presence diff.
    for (const entityId of new Set([...prevRefs.keys(), ...nextRefs.keys()])) {
      if (prevById.get(entityId) !== batch.entities.find((e) => e.entityId === entityId)) {
        continue; // entity itself changed or vanished — covered above
      }
      // Keyed by provider, compared by value: a same-provider ref
      // rewrite still emits an upsert.
      const prevMap = new Map(
        (prevRefs.get(entityId) ?? []).map((ref) => [ref.provider, ref.ref]),
      );
      const nextMap = new Map(
        (nextRefs.get(entityId) ?? []).map((ref) => [ref.provider, ref.ref]),
      );
      for (const [provider, refValue] of nextMap) {
        const prior = prevMap.get(provider);
        if (prior === undefined || !jsonEqual(prior, refValue)) {
          writes.push({
            kind: 'entitySourceRef',
            recordId: entitySourceRefRecordId(entityId, provider),
            field: 'ref',
            value: refValue,
          });
        }
      }
      for (const provider of prevMap.keys()) {
        if (!nextMap.has(provider)) {
          writes.push(
            tombstoneWrite(
              'entitySourceRef',
              entitySourceRefRecordId(entityId, provider),
            ),
          );
        }
      }
    }
    for (const entity of prev.entities) {
      if (!nextIds.has(entity.entityId)) {
        writes.push(
          ...entityDeleteWrites(
            entity,
            prevRefs.get(entity.entityId) ?? [],
          ),
        );
      }
    }
  }

  if (
    batch.entitySourceRefs !== undefined &&
    batch.entities === undefined
  ) {
    // Ref-only commits (no entity section write): diff the presence
    // records alone so a standalone ref change still emits.
    const keyOf = (ref: EntitySourceRef): string =>
      `${ref.entityId}${KEY_SEP}${ref.provider}`;
    const prevKeys = new Map(
      prev.entitySourceRefs.map((ref) => [keyOf(ref), ref]),
    );
    const nextKeys = new Set(batch.entitySourceRefs.map(keyOf));
    for (const ref of batch.entitySourceRefs) {
      // Value compare, not identity — a same-provider row whose ref
      // changed emits the upsert; a rebuilt identical ref does not.
      const priorRef = prevKeys.get(keyOf(ref));
      if (priorRef === undefined || !jsonEqual(priorRef.ref, ref.ref)) {
        writes.push({
          kind: 'entitySourceRef',
          recordId: entitySourceRefRecordId(ref.entityId, ref.provider),
          field: 'ref',
          value: ref.ref,
        });
      }
    }
    for (const ref of prev.entitySourceRefs) {
      if (!nextKeys.has(keyOf(ref))) {
        writes.push(
          tombstoneWrite(
            'entitySourceRef',
            entitySourceRefRecordId(ref.entityId, ref.provider),
          ),
        );
      }
    }
  }

  if (batch.playlists !== undefined) {
    const prevById = new Map(prev.playlists.map((p) => [p.playlistId, p]));
    const nextIds = new Set(batch.playlists.map((p) => p.playlistId));
    for (const playlist of batch.playlists) {
      if (prevById.get(playlist.playlistId) !== playlist) {
        writes.push(
          ...PLAYLIST_SYNC_FIELDS.map((field) =>
            fieldWrite('playlist', playlist.playlistId, field, playlist[field]),
          ),
        );
      }
    }
    for (const playlist of prev.playlists) {
      if (!nextIds.has(playlist.playlistId)) {
        writes.push(tombstoneWrite('playlist', playlist.playlistId));
        for (const entry of prev.playlistEntries) {
          if (entry.playlistId === playlist.playlistId) {
            writes.push(tombstoneWrite('playlistEntry', entry.entryId));
          }
        }
      }
    }
  }

  if (batch.playlistEntries !== undefined) {
    const prevById = new Map(prev.playlistEntries.map((e) => [e.entryId, e]));
    const nextIds = new Set(batch.playlistEntries.map((e) => e.entryId));
    for (const entry of batch.playlistEntries) {
      if (prevById.get(entry.entryId) !== entry) {
        writes.push(
          ...PLAYLIST_ENTRY_SYNC_FIELDS.map((field) =>
            fieldWrite('playlistEntry', entry.entryId, field, entry[field]),
          ),
        );
      }
    }
    for (const entry of prev.playlistEntries) {
      if (!nextIds.has(entry.entryId)) {
        writes.push(tombstoneWrite('playlistEntry', entry.entryId));
      }
    }
  }

  if (batch.playHistory !== undefined) {
    const prevById = new Map(prev.playHistory.map((e) => [e.eventId, e]));
    const nextIds = new Set(batch.playHistory.map((e) => e.eventId));
    for (const event of batch.playHistory) {
      if (prevById.get(event.eventId) !== event) {
        writes.push(fieldWrite('playEvent', event.eventId, 'event', event));
      }
    }
    for (const event of prev.playHistory) {
      if (!nextIds.has(event.eventId)) {
        writes.push(tombstoneWrite('playEvent', event.eventId));
      }
    }
  }

  if (batch.playCounts !== undefined) {
    const prevById = new Map(prev.playCounts.map((c) => [c.recordingId, c]));
    const nextIds = new Set(batch.playCounts.map((c) => c.recordingId));
    for (const count of batch.playCounts) {
      if (prevById.get(count.recordingId) !== count) {
        for (const field of PLAY_COUNT_SYNC_FIELDS) {
          writes.push(
            fieldWrite('playCount', count.recordingId, field, count[field]),
          );
        }
      }
    }
    for (const count of prev.playCounts) {
      if (!nextIds.has(count.recordingId)) {
        writes.push(tombstoneWrite('playCount', count.recordingId));
      }
    }
  }

  if (batch.matchReviews !== undefined) {
    const prevById = new Map(matchReviews.map((r) => [r.reviewId, r]));
    const nextIds = new Set(batch.matchReviews.map((r) => r.reviewId));
    for (const review of batch.matchReviews) {
      if (prevById.get(review.reviewId) !== review) {
        writes.push(...reviewSyncWrites(review));
      }
    }
    for (const review of matchReviews) {
      if (!nextIds.has(review.reviewId)) {
        writes.push(tombstoneWrite('matchReview', review.reviewId));
      }
    }
  }

  if (batch.settings !== undefined) {
    writes.push(...settingsWrites(prev.settings, batch.settings));
  }

  return writes;
}

/**
 * Boot-time emit recovery (Review #46): emission is post-commit and
 * the pending queue is memory-only, so a shutdown or dead emit port
 * can strand committed writes forever. `synced` maps each live
 * materialized record's `syncedRecordKey` to its synced `fields` —
 * the same `MaterializedRecord[]` the callers already page through —
 * and every write whose field value the log never saw re-emits:
 *
 * - the record is absent or tombstoned (empty `fields` — a winning
 *   tombstone means nothing about the row was delivered);
 * - the field is absent or carries a different value — the stale
 *   `lww` case a record-existence check misses (a rename committed
 *   but never emitted);
 * - for `sum`/`max` fields, only when the local value is LARGER —
 *   asserting a smaller aggregate/ceiling is a guaranteed no-op
 *   (clamped to a zero component), so only a truly undelivered
 *   increment re-emits.
 *
 * Tombstones never emit — absent-from-domain can't be told apart
 * from a remote create the inbound pass hasn't folded yet, so a
 * reconstructed delete could erase a row the remote legitimately
 * owns.
 */
export function unsyncedWrites(
  input: SyncEmitInput,
  synced: ReadonlyMap<string, Record<string, unknown>>,
): LocalWrite[] {
  const delivered = (write: LocalWrite): boolean => {
    if ('tombstone' in write) {
      return true;
    }
    const fields = synced.get(`${write.kind}${KEY_SEP}${write.recordId}`);
    if (fields === undefined || Object.keys(fields).length === 0) {
      return false;
    }
    const syncedValue = fields[write.field];
    if (syncedValue === undefined) {
      // The record never carried this field. A defined domain value
      // must still deliver; an `undefined` domain value already IS
      // the materialized shape (a stamped absent and an unstamped
      // field fold identically) — re-emitting it converges to
      // nothing and would fire on every boot.
      return write.value === undefined;
    }
    const merge = SYNC_FIELD_RULES[write.kind][write.field]?.merge;
    if (
      (merge === 'sum' || merge === 'max') &&
      typeof write.value === 'number'
    ) {
      return typeof syncedValue === 'number' && syncedValue >= write.value;
    }
    return jsonEqual(syncedValue, write.value);
  };
  const batch: StorageBatch = {
    recordings: [...input.recordings],
    likes: [...input.likes],
    entities: [...input.entities],
    entitySourceRefs: [...input.entitySourceRefs],
    playlists: [...input.playlists],
    playlistEntries: [...input.playlistEntries],
    playHistory: [...input.playHistory],
    playCounts: [...input.playCounts],
    matchReviews: [...(input.matchReviews ?? [])],
  };
  const writes = emissionWrites(
    {
      recordings: [],
      likes: [],
      entities: [],
      entitySourceRefs: [],
      playlists: [],
      playlistEntries: [],
      playHistory: [],
      playCounts: [],
      matchReviews: [],
      settings: input.settings,
    },
    batch,
  );
  const settingsKey = `settings${KEY_SEP}${SETTINGS_RECORD_ID}`;
  const settingsFields = synced.get(settingsKey);
  if (settingsFields === undefined || Object.keys(settingsFields).length === 0) {
    for (const field of SETTINGS_SYNC_FIELDS) {
      writes.push({
        kind: 'settings',
        recordId: SETTINGS_RECORD_ID,
        field,
        value: input.settings[field],
      });
    }
  } else {
    for (const field of SETTINGS_SYNC_FIELDS) {
      const write = fieldWrite(
        'settings',
        SETTINGS_RECORD_ID,
        field,
        input.settings[field],
      );
      if (!delivered(write)) {
        writes.push(write);
      }
    }
  }
  return writes.filter((write) => !delivered(write));
}

/**
 * Whole-document emission for `importLibrary`: rebuild the doc's
 * recordings from their junction rows, then diff the imported owned
 * set against the replaced sections — every imported row upserts and
 * every prior row the doc dropped tombstones.
 */
export function importEmissionWrites(
  prev: SyncEmitInput,
  doc: ExportDocument,
): LocalWrite[] {
  const refsById = new Map<string, SourceRef[]>();
  for (const row of doc.sourceRefs) {
    const list = refsById.get(row.recordingId) ?? [];
    list.push(row.ref);
    refsById.set(row.recordingId, list);
  }
  const mapsById = new Map<string, SourceMapping[]>();
  for (const row of doc.mappings) {
    const list = mapsById.get(row.recordingId) ?? [];
    list.push(row.mapping);
    mapsById.set(row.recordingId, list);
  }
  const recordings: Recording[] = [];
  for (const row of doc.recordings) {
    const rec: Recording = {
      ...row,
      sourceRefs: refsById.get(row.id) ?? [],
      mappings: mapsById.get(row.id) ?? [],
    };
    if (isRecording(rec)) {
      recordings.push(rec);
    }
  }
  return emissionWrites(prev, {
    recordings,
    likes: doc.likes,
    entities: doc.entities,
    entitySourceRefs: doc.entitySourceRefs,
    playlists: doc.playlists,
    playlistEntries: doc.playlistEntries,
    playHistory: doc.playHistory,
    playCounts: doc.playCounts,
    matchReviews: doc.matchReviews,
    settings: doc.settings,
  });
}

// ---- inbound: applied outcomes → domain batch -----------------------------

type AppliedOutcome = Extract<MergeOutcome, { type: 'applied' }>;

function entryKey(entry: ChangeEntry): string {
  return `${entry.deviceId}${KEY_SEP}${entry.hlc.l}${KEY_SEP}${entry.hlc.c}`;
}

function compareEntries(a: ChangeEntry, b: ChangeEntry): number {
  const byStamp = compareStamp(a.hlc, b.hlc);
  if (byStamp !== 0) {
    return byStamp;
  }
  return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
}

/**
 * Per-record fold of applied outcomes, mirroring the engine's merge
 * read: a tombstone kills every canonically-earlier field fold and
 * lets later ones re-populate; 'lww' keeps the newest fold, 'max'
 * keeps the largest, and 'sum' keeps one component winner per device —
 * the applied outcome IS that winner, so domain math stays an
 * additive delta against the displaced component.
 */
/** The mapping identity — ref + status + matchedAtMs. */
type MappingKey = Pick<SourceMapping, 'ref' | 'status' | 'matchedAtMs'>;

type RecordFold = {
  readonly kind: SyncRecordKind;
  readonly recordId: string;
  tombstoned: boolean;
  readonly fields: Map<string, unknown>;
  /** 'sum' field → this drain's count delta against the domain row. */
  readonly sumDeltas: Map<string, number>;
  readonly outcomes: AppliedOutcome[];
  /** Materialized rebuild only: the source record to retain on pend. */
  readonly pendingRecord?: MaterializedRecord;
  /** Earliest hlc.l folded — createdMs fallback for new rows. */
  minL: number;
  /**
   * Fields/sum values carry the engine's materialized TRUTH (absolute
   * post-merge state), not drain-relative deltas — set when the
   * outcome stream carried a `record` snapshot (Review #46).
   */
  absolute: boolean;
};

function foldOutcome(fold: RecordFold, outcome: AppliedOutcome): void {
  const entry = outcome.entry;
  fold.outcomes.push(outcome);
  if (entry.hlc.l < fold.minL) {
    fold.minL = entry.hlc.l;
  }
  if (entry.tombstone) {
    fold.tombstoned = true;
    fold.fields.clear();
    fold.sumDeltas.clear();
    return;
  }
  fold.tombstoned = false;
  const rule = SYNC_FIELD_RULES[fold.kind]?.[entry.field];
  if (rule?.merge === 'sum') {
    const displaced = outcome.displaced[0];
    const prevComponent =
      displaced !== undefined && typeof displaced.value === 'number'
        ? displaced.value
        : 0;
    fold.sumDeltas.set(
      entry.field,
      (fold.sumDeltas.get(entry.field) ?? 0) +
        (typeof entry.value === 'number' ? entry.value : 0) -
        prevComponent,
    );
    return;
  }
  if (rule?.merge === 'max') {
    const value = typeof entry.value === 'number' ? entry.value : 0;
    const prior = fold.fields.get(entry.field);
    fold.fields.set(
      entry.field,
      typeof prior === 'number' && prior > value ? prior : value,
    );
    return;
  }
  fold.fields.set(entry.field, entry.value);
}

function numField(
  fields: Map<string, unknown>,
  field: string,
): number | null {
  const v = fields.get(field);
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

function strField(fields: Map<string, unknown>, field: string): string | null {
  const v = fields.get(field);
  return typeof v === 'string' ? v : null;
}

/**
 * Fold applied merge outcomes onto the persisted sections. The caller
 * unions previously pending outcomes into `outcomes` — the fold
 * re-sorts canonically and dedupes by entry key, so replaying the
 * same outcome is a no-op. `pending` returns the applied outcomes
 * whose records still can't materialize; `skipped` is for permanent
 * drops the caller logs (kind only — record ids embed provider ids).
 */
export function projectAppliedEntries(
  outcomes: readonly MergeOutcome[],
  current: SyncProjectionInput,
): SyncProjection {
  const pending: MergeOutcome[] = [];
  const skipped: ProjectionSkip[] = [];

  const applied: AppliedOutcome[] = [];
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.type !== 'applied') {
      continue;
    }
    // Outcomes cross a wire-shaped boundary here — re-validate the
    // entry + its displaced component before the fold trusts them.
    const displaced = (outcome as { displaced?: unknown }).displaced;
    if (
      !isChangeEntry(outcome.entry) ||
      (displaced !== undefined &&
        (!Array.isArray(displaced) ||
          !displaced.every(isChangeEntry)))
    ) {
      skipped.push({ kind: 'unknown', reason: 'invalid' });
      continue;
    }
    if (seen.has(entryKey(outcome.entry))) {
      continue;
    }
    seen.add(entryKey(outcome.entry));
    applied.push(outcome);
  }
  applied.sort((a, b) => compareEntries(a.entry, b.entry));

  const folds = new Map<string, RecordFold>();
  const foldFor = (kind: SyncRecordKind, recordId: string): RecordFold => {
    const key = `${kind}${KEY_SEP}${recordId}`;
    let fold = folds.get(key);
    if (fold === undefined) {
      fold = {
        kind,
        recordId,
        tombstoned: false,
        fields: new Map(),
        sumDeltas: new Map(),
        outcomes: [],
        minL: Number.MAX_SAFE_INTEGER,
        absolute: false,
      };
      folds.set(key, fold);
    }
    return fold;
  };
  for (const outcome of applied) {
    foldOutcome(foldFor(outcome.entry.kind, outcome.entry.recordId), outcome);
  }
  // Engine-attached materialized snapshots override fold inference —
  // the fold can't see fields that merged in earlier drains, and a
  // delayed tombstone that lost to newer fields must not delete a
  // record the engine still materializes (Review #46). When several
  // outcomes carry a snapshot for the same record — a retained
  // pending outcome replayed beside a newer one — the LAST wins:
  // snapshots ride outcome order, so the newest apply's view is the
  // honest merge state (Review #46 round-8).
  const snaps = new Map<string, MaterializedRecord>();
  for (const outcome of applied) {
    if (outcome.record !== undefined) {
      snaps.set(
        `${outcome.record.kind}${KEY_SEP}${outcome.record.recordId}`,
        outcome.record,
      );
    }
  }
  for (const fold of folds.values()) {
    const snap = snaps.get(`${fold.kind}${KEY_SEP}${fold.recordId}`);
    if (snap === undefined) {
      continue;
    }
    fold.fields.clear();
    for (const [field, value] of Object.entries(snap.fields)) {
      fold.fields.set(field, value);
    }
    fold.sumDeltas.clear();
    fold.tombstoned = Object.keys(snap.fields).length === 0;
    fold.absolute = true;
  }

  return finishProjection(folds, current, pending, skipped);
}

/**
 * Rebuild the projected sections from the engine's materialized record
 * view — the durable recovery path for outcome streams a client can
 * lose (drained-then-crashed, evicted from a bound). Records absent
 * from `records` keep their current rows: absence means 'never
 * synced', not 'deleted' — deletion arrives as a record with empty
 * fields, exactly as materialize() reports it.
 */
export function projectMaterialized(
  records: readonly MaterializedRecord[],
  current: SyncProjectionInput,
): SyncProjection {
  const folds = new Map<string, RecordFold>();
  const skipped: ProjectionSkip[] = [];
  for (const rec of records) {
    if (!isMaterializedRecord(rec)) {
      skipped.push({ kind: 'unknown', reason: 'invalid' });
      continue;
    }
    const fields = new Map(Object.entries(rec.fields));
    folds.set(`${rec.kind}${KEY_SEP}${rec.recordId}`, {
      kind: rec.kind,
      recordId: rec.recordId,
      tombstoned: fields.size === 0,
      fields,
      sumDeltas: new Map(),
      outcomes: [],
      pendingRecord: rec,
      minL: 0,
      absolute: true,
    });
  }
  return finishProjection(folds, current, [], skipped);
}

function finishProjection(
  folds: Map<string, RecordFold>,
  current: SyncProjectionInput,
  pending: MergeOutcome[],
  skipped: ProjectionSkip[],
): SyncProjection {
  const foldOf = (kind: SyncRecordKind, recordId: string): RecordFold | undefined =>
    folds.get(`${kind}${KEY_SEP}${recordId}`);

  const changedKinds = new Set<SyncRecordKind>();
  const pendingRecords: MaterializedRecord[] = [];
  const pend = (fold: RecordFold): void => {
    pending.push(...fold.outcomes);
    if (fold.pendingRecord !== undefined) {
      pendingRecords.push(fold.pendingRecord);
    }
  };

  // ---- recordings ----------------------------------------------------------
  //
  // Recording rows are assembled from three record families: the
  // recording field record, its sourceRef presence records, and its
  // mapping presence records. A pending insert holds every fold
  // contributing to the row, not just the field record.

  type RecordingPlan = {
    action: 'upsert' | 'delete' | 'pending';
    fields?: Map<string, unknown>;
    refAdds: SourceRef[];
    refRemoves: SourceRef[];
    mapAdds: SourceMapping[];
    mapRemoves: MappingKey[];
  };
  const recordingPlans = new Map<string, RecordingPlan>();
  /** outcomes keyed by recordingId — for pending re-queue. */
  const recordingOutcomes = new Map<string, AppliedOutcome[]>();
  const recordingPendRecords = new Map<string, MaterializedRecord[]>();
  const planFor = (recordingId: string): RecordingPlan => {
    let plan = recordingPlans.get(recordingId);
    if (plan === undefined) {
      plan = {
        action: 'upsert',
        refAdds: [],
        refRemoves: [],
        mapAdds: [],
        mapRemoves: [],
      };
      recordingPlans.set(recordingId, plan);
    }
    return plan;
  };
  const trackOutcomes = (
    recordingId: string,
    fold: RecordFold,
  ): void => {
    const list = recordingOutcomes.get(recordingId) ?? [];
    list.push(...fold.outcomes);
    recordingOutcomes.set(recordingId, list);
    if (fold.pendingRecord !== undefined) {
      const recs = recordingPendRecords.get(recordingId) ?? [];
      recs.push(fold.pendingRecord);
      recordingPendRecords.set(recordingId, recs);
    }
  };

  for (const fold of folds.values()) {
    if (fold.kind === 'recording') {
      if (fold.tombstoned) {
        recordingPlans.set(fold.recordId, {
          action: 'delete',
          refAdds: [],
          refRemoves: [],
          mapAdds: [],
          mapRemoves: [],
        });
      } else {
        planFor(fold.recordId).fields = fold.fields;
      }
      trackOutcomes(fold.recordId, fold);
      changedKinds.add('recording');
    }
  }
  for (const fold of folds.values()) {
    if (fold.kind === 'recordingSourceRef') {
      const parts = decodeParts(fold.recordId, 4);
      if (parts === null) {
        skipped.push({ kind: 'recordingSourceRef', reason: 'invalid' });
        continue;
      }
      const [recordingId, provider, kind, id] = parts;
      if (recordingId === undefined || provider === undefined) {
        skipped.push({ kind: 'recordingSourceRef', reason: 'invalid' });
        continue;
      }
      const plan = planFor(recordingId);
      trackOutcomes(recordingId, fold);
      if (fold.tombstoned) {
        plan.refRemoves.push({ provider, kind: kind as SourceRef['kind'], id: id ?? '' });
      } else {
        const ref = fold.fields.get('ref');
        if (
          ref !== undefined &&
          (ref as SourceRef).provider === provider &&
          (ref as SourceRef).kind === kind &&
          (ref as SourceRef).id === id
        ) {
          plan.refAdds.push(ref as SourceRef);
        } else {
          skipped.push({ kind: 'recordingSourceRef', reason: 'invalid' });
          continue;
        }
      }
      changedKinds.add('recordingSourceRef');
    } else if (fold.kind === 'recordingMapping') {
      const parts = decodeParts(fold.recordId, 6);
      if (parts === null) {
        skipped.push({ kind: 'recordingMapping', reason: 'invalid' });
        continue;
      }
      const [recordingId, provider, kind, id, status, matchedAtMs] = parts;
      if (recordingId === undefined || provider === undefined) {
        skipped.push({ kind: 'recordingMapping', reason: 'invalid' });
        continue;
      }
      const plan = planFor(recordingId);
      trackOutcomes(recordingId, fold);
      if (fold.tombstoned) {
        plan.mapRemoves.push({
          ref: { provider, kind: kind as SourceRef['kind'], id: id ?? '' },
          status: status as SourceMapping['status'],
          matchedAtMs: Number(matchedAtMs),
        });
      } else {
        const mapping = fold.fields.get('mapping') as
          | SourceMapping
          | undefined;
        if (
          mapping !== undefined &&
          mapping.ref.provider === provider &&
          mapping.ref.kind === kind &&
          mapping.ref.id === id &&
          mapping.status === status &&
          String(mapping.matchedAtMs) === matchedAtMs
        ) {
          plan.mapAdds.push(mapping);
        } else {
          skipped.push({ kind: 'recordingMapping', reason: 'invalid' });
          continue;
        }
      }
      changedKinds.add('recordingMapping');
    }
  }

  const applyRefOps = (
    refs: readonly SourceRef[],
    plan: RecordingPlan,
  ): SourceRef[] => {
    let next = refs.filter((ref) =>
      plan.refRemoves.every((r) => !sameRef(r, ref)),
    );
    for (const ref of plan.refAdds) {
      if (next.every((n) => !sameRef(n, ref))) {
        next = [...next, ref];
      }
    }
    return next;
  };
  const applyMapOps = (
    mappings: readonly SourceMapping[],
    plan: RecordingPlan,
  ): SourceMapping[] => {
    let next = mappings.filter((m) =>
      plan.mapRemoves.every(
        (r) =>
          !(
            sameRef(r.ref, m.ref) &&
            r.status === m.status &&
            r.matchedAtMs === m.matchedAtMs
          ),
      ),
    );
    for (const mapping of plan.mapAdds) {
      if (next.every((n) => !sameMapping(n, mapping))) {
        next = [...next, mapping];
      }
    }
    return next;
  };
  const overlayRecording = (
    rec: Recording,
    fields: Map<string, unknown> | undefined,
  ): Recording => {
    if (fields === undefined) {
      return rec;
    }
    const next: Recording = { ...rec };
    for (const field of RECORDING_SYNC_FIELDS) {
      if (fields.has(field)) {
        (next as Record<string, unknown>)[field] = fields.get(field);
      }
    }
    return next;
  };
  const buildRecording = (
    fields: Map<string, unknown> | undefined,
    plan: RecordingPlan,
    id: string,
  ): Recording | null => {
    const title =
      fields !== undefined ? strField(fields, 'title') : null;
    if (title === null) {
      return null;
    }
    const get = (field: string): unknown => fields?.get(field);
    const rec: Recording = {
      id,
      title,
      artist: strField(fields ?? new Map(), 'artist'),
      album: strField(fields ?? new Map(), 'album'),
      durationMs: numField(fields ?? new Map(), 'durationMs'),
      releaseYear: numField(fields ?? new Map(), 'releaseYear'),
      artwork: (get('artwork') as Recording['artwork']) ?? [],
      explicit:
        typeof get('explicit') === 'boolean'
          ? (get('explicit') as boolean)
          : null,
      genre: strField(fields ?? new Map(), 'genre'),
      isrc: strField(fields ?? new Map(), 'isrc'),
      versionLabels:
        (get('versionLabels') as Recording['versionLabels']) ?? [],
      sourceRefs: applyRefOps([], plan),
      mappings: applyMapOps([], plan),
      provenance: (get('provenance') as Recording['provenance']) ?? 'provider',
    };
    return isRecording(rec) ? rec : null;
  };

  // Resolve plans against `current` once — pending vs materialized is
  // decided here so the batch and the transaction merge agree.
  for (const [id, plan] of recordingPlans) {
    if (plan.action !== 'upsert') {
      continue;
    }
    const existing = current.recordings.find((rec) => rec.id === id);
    if (existing === undefined) {
      const built = buildRecording(plan.fields, plan, id);
      if (built === null) {
        plan.action = 'pending';
        const list = recordingOutcomes.get(id);
        if (list !== undefined) {
          pending.push(...list);
        }
        const recs = recordingPendRecords.get(id);
        if (recs !== undefined) {
          pendingRecords.push(...recs);
        }
      }
      continue;
    }
    const candidate: Recording = {
      ...overlayRecording(existing, plan.fields),
      sourceRefs: applyRefOps(existing.sourceRefs, plan),
      mappings: applyMapOps(existing.mappings, plan),
    };
    // A recording must carry a source ref — a plan that would empty
    // them drops the row like a delete (the domain can't hold it).
    if (!isRecording(candidate)) {
      plan.action = 'delete';
    }
  }

  const applyRecordingPlans = (
    rows: readonly Recording[],
  ): { next: Recording[]; dead: Set<string> } => {
    const next: Recording[] = [];
    const dead = new Set<string>();
    const seen = new Set<string>();
    for (const rec of rows) {
      const plan = recordingPlans.get(rec.id);
      seen.add(rec.id);
      if (plan === undefined) {
        next.push(rec);
        continue;
      }
      if (plan.action === 'delete') {
        dead.add(rec.id);
        continue;
      }
      if (plan.action === 'pending') {
        next.push(rec);
        continue;
      }
      const candidate: Recording = {
        ...overlayRecording(rec, plan.fields),
        sourceRefs: applyRefOps(rec.sourceRefs, plan),
        mappings: applyMapOps(rec.mappings, plan),
      };
      next.push(isRecording(candidate) ? candidate : rec);
    }
    for (const [id, plan] of recordingPlans) {
      if (seen.has(id) || plan.action !== 'upsert') {
        continue;
      }
      const built = buildRecording(plan.fields, plan, id);
      if (built !== null) {
        next.push(built);
      }
    }
    return { next, dead };
  };

  const projected = applyRecordingPlans(current.recordings);
  const liveRecordingIds = new Set(projected.next.map((rec) => rec.id));
  const deadRecordingIds = projected.dead;

  // ---- scalar sections ------------------------------------------------------

  const nextEntities: Entity[] = [];
  const tombstonedEntityIds = new Set<string>();
  {
    for (const entity of current.entities) {
      const fold = foldOf('entity', entity.entityId);
      if (fold === undefined) {
        nextEntities.push(entity);
        continue;
      }
      if (fold.tombstoned) {
        tombstonedEntityIds.add(entity.entityId);
        changedKinds.add('entity');
        continue;
      }
      const fields = fold.fields;
      const candidate: Entity = {
        entityId: entity.entityId,
        kind: (fields.get('kind') as Entity['kind']) ?? entity.kind,
        title: strField(fields, 'title') ?? entity.title,
        artistName: fields.has('artistName')
          ? strField(fields, 'artistName')
          : entity.artistName,
        artwork: (fields.get('artwork') as Entity['artwork']) ?? entity.artwork,
        createdMs: numField(fields, 'createdMs') ?? entity.createdMs,
      };
      if (!isEntity(candidate)) {
        skipped.push({ kind: 'entity', reason: 'invalid' });
        nextEntities.push(entity);
        continue;
      }
      changedKinds.add('entity');
      nextEntities.push(candidate);
    }
    for (const fold of folds.values()) {
      if (
        fold.kind !== 'entity' ||
        fold.tombstoned ||
        current.entities.some((e) => e.entityId === fold.recordId)
      ) {
        continue;
      }
      const kind = fold.fields.get('kind');
      const title = strField(fold.fields, 'title');
      if ((kind !== 'album' && kind !== 'artist') || title === null) {
        pend(fold);
        continue;
      }
      const candidate: Entity = {
        entityId: fold.recordId,
        kind: kind as Entity['kind'],
        title,
        artistName: strField(fold.fields, 'artistName'),
        artwork: (fold.fields.get('artwork') as Entity['artwork']) ?? [],
        createdMs: numField(fold.fields, 'createdMs') ?? fold.minL,
      };
      if (!isEntity(candidate)) {
        skipped.push({ kind: 'entity', reason: 'invalid' });
        continue;
      }
      changedKinds.add('entity');
      nextEntities.push(candidate);
    }
    for (const fold of folds.values()) {
      if (fold.kind === 'entity' && fold.tombstoned) {
        tombstonedEntityIds.add(fold.recordId);
        changedKinds.add('entity');
      }
    }
  }
  const liveEntityIds = new Set(nextEntities.map((e) => e.entityId));

  const entityRefKey = (entityId: string, provider: string): string =>
    `${entityId}${KEY_SEP}${provider}`;
  const tombstonedEntityRefs = new Set<string>();
  const upsertEntityRefs: { ref: EntitySourceRef; fold: RecordFold }[] = [];
  for (const fold of folds.values()) {
    if (fold.kind !== 'entitySourceRef') {
      continue;
    }
    const parts = decodeParts(fold.recordId, 2);
    if (parts === null || parts[0] === undefined || parts[1] === undefined) {
      skipped.push({ kind: 'entitySourceRef', reason: 'invalid' });
      continue;
    }
    const [entityId, provider] = parts;
    if (fold.tombstoned) {
      tombstonedEntityRefs.add(entityRefKey(entityId, provider));
      changedKinds.add('entitySourceRef');
      continue;
    }
    const ref = fold.fields.get('ref') as EntitySourceRef['ref'] | undefined;
    if (ref === undefined || ref.provider !== provider) {
      skipped.push({ kind: 'entitySourceRef', reason: 'invalid' });
      continue;
    }
    upsertEntityRefs.push({
      ref: { entityId, provider, ref },
      fold,
    });
    changedKinds.add('entitySourceRef');
  }
  const nextEntityRefs: EntitySourceRef[] = current.entitySourceRefs.filter(
    (ref) =>
      liveEntityIds.has(ref.entityId) &&
      !tombstonedEntityRefs.has(entityRefKey(ref.entityId, ref.provider)),
  );
  for (const { ref, fold } of upsertEntityRefs) {
    if (!liveEntityIds.has(ref.entityId)) {
      pend(fold);
      continue;
    }
    if (!isEntitySourceRef(ref)) {
      skipped.push({ kind: 'entitySourceRef', reason: 'invalid' });
      continue;
    }
    // (entityId, provider) is the row's identity — an update replaces
    // the stale same-key row, never appends a second one.
    const stale = nextEntityRefs.findIndex(
      (r) => r.entityId === ref.entityId && r.provider === ref.provider,
    );
    if (stale >= 0) {
      nextEntityRefs.splice(stale, 1);
    }
    nextEntityRefs.push(ref);
  }

  const likeKey = (entityKind: string, targetId: string): string =>
    `${entityKind}${KEY_SEP}${targetId}`;
  const tombstonedLikes = new Set<string>();
  const upsertLikes: { like: Like; fold: RecordFold }[] = [];
  for (const fold of folds.values()) {
    if (fold.kind !== 'like') {
      continue;
    }
    const parts = decodeParts(fold.recordId, 2);
    if (parts === null || parts[0] === undefined || parts[1] === undefined) {
      skipped.push({ kind: 'like', reason: 'invalid' });
      continue;
    }
    const [entityKind, targetId] = parts;
    if (fold.tombstoned) {
      tombstonedLikes.add(likeKey(entityKind, targetId));
      changedKinds.add('like');
      continue;
    }
    const like = fold.fields.get('like');
    if (like === undefined) {
      pend(fold);
      continue;
    }
    if (
      !isLike(like) ||
      like.entityKind !== entityKind ||
      like.targetId !== targetId
    ) {
      skipped.push({ kind: 'like', reason: 'invalid' });
      continue;
    }
    upsertLikes.push({ like, fold });
    changedKinds.add('like');
  }
  const nextLikes: Like[] = current.likes.filter((like) => {
    if (tombstonedLikes.has(likeKey(like.entityKind, like.targetId))) {
      return false;
    }
    return like.entityKind === 'track'
      ? liveRecordingIds.has(like.targetId)
      : liveEntityIds.has(like.targetId);
  });
  for (const { like, fold } of upsertLikes) {
    const live =
      like.entityKind === 'track'
        ? liveRecordingIds.has(like.targetId)
        : liveEntityIds.has(like.targetId);
    if (!live) {
      pend(fold);
      continue;
    }
    const idx = nextLikes.findIndex(
      (l) => l.entityKind === like.entityKind && l.targetId === like.targetId,
    );
    if (idx < 0) {
      nextLikes.push(like);
    } else {
      nextLikes[idx] = like;
    }
  }

  const tombstonedPlaylistIds = new Set<string>();
  const nextPlaylists: Playlist[] = [];
  {
    for (const playlist of current.playlists) {
      const fold = foldOf('playlist', playlist.playlistId);
      if (fold === undefined) {
        nextPlaylists.push(playlist);
        continue;
      }
      if (fold.tombstoned) {
        tombstonedPlaylistIds.add(playlist.playlistId);
        changedKinds.add('playlist');
        continue;
      }
      const createdMs =
        numField(fold.fields, 'createdMs') ?? playlist.createdMs;
      const candidate: Playlist = {
        playlistId: playlist.playlistId,
        name: strField(fold.fields, 'name') ?? playlist.name,
        createdMs,
        updatedMs: Math.max(
          numField(fold.fields, 'updatedMs') ?? playlist.updatedMs,
          createdMs,
        ),
      };
      if (!isPlaylist(candidate)) {
        skipped.push({ kind: 'playlist', reason: 'invalid' });
        nextPlaylists.push(playlist);
        continue;
      }
      changedKinds.add('playlist');
      nextPlaylists.push(candidate);
    }
    for (const fold of folds.values()) {
      if (fold.kind !== 'playlist') {
        continue;
      }
      if (fold.tombstoned) {
        tombstonedPlaylistIds.add(fold.recordId);
        changedKinds.add('playlist');
        continue;
      }
      if (current.playlists.some((p) => p.playlistId === fold.recordId)) {
        continue;
      }
      const name = strField(fold.fields, 'name');
      if (name === null) {
        pend(fold);
        continue;
      }
      const createdMs = numField(fold.fields, 'createdMs') ?? fold.minL;
      const candidate: Playlist = {
        playlistId: fold.recordId,
        name,
        createdMs,
        updatedMs: Math.max(
          numField(fold.fields, 'updatedMs') ?? fold.minL,
          createdMs,
        ),
      };
      if (!isPlaylist(candidate)) {
        skipped.push({ kind: 'playlist', reason: 'invalid' });
        continue;
      }
      changedKinds.add('playlist');
      nextPlaylists.push(candidate);
    }
  }
  const livePlaylistIds = new Set(nextPlaylists.map((p) => p.playlistId));

  const tombstonedEntryIds = new Set<string>();
  const nextEntries: PlaylistEntry[] = [];
  const buildEntry = (
    fold: RecordFold,
    base?: PlaylistEntry,
  ): PlaylistEntry | null | undefined => {
    const playlistId =
      strField(fold.fields, 'playlistId') ?? base?.playlistId;
    const recordingId =
      strField(fold.fields, 'recordingId') ?? base?.recordingId;
    const rawPosition = fold.fields.get('position');
    const position =
      typeof rawPosition === 'number' && Number.isFinite(rawPosition)
        ? rawPosition
        : base?.position;
    if (
      playlistId === undefined ||
      recordingId === undefined ||
      position === undefined
    ) {
      return undefined;
    }
    if (!livePlaylistIds.has(playlistId) || !liveRecordingIds.has(recordingId)) {
      return undefined;
    }
    const entry: PlaylistEntry = {
      entryId: fold.recordId,
      playlistId,
      recordingId,
      position,
      selectedRef: fold.fields.has('selectedRef')
        ? ((fold.fields.get('selectedRef') as SourceRef | null) ?? null)
        : (base?.selectedRef ?? null),
      addedMs: numField(fold.fields, 'addedMs') ?? base?.addedMs ?? fold.minL,
    };
    return isPlaylistEntry(entry) ? entry : null;
  };
  for (const entry of current.playlistEntries) {
    if (
      tombstonedEntryIds.has(entry.entryId) ||
      !livePlaylistIds.has(entry.playlistId) ||
      !liveRecordingIds.has(entry.recordingId)
    ) {
      continue;
    }
    const fold = foldOf('playlistEntry', entry.entryId);
    if (fold === undefined) {
      nextEntries.push(entry);
      continue;
    }
    if (fold.tombstoned) {
      continue;
    }
    const candidate = buildEntry(fold, entry);
    if (candidate === null) {
      skipped.push({ kind: 'playlistEntry', reason: 'invalid' });
      nextEntries.push(entry);
      continue;
    }
    if (candidate === undefined) {
      pend(fold);
      nextEntries.push(entry);
      continue;
    }
    changedKinds.add('playlistEntry');
    nextEntries.push(candidate);
  }
  for (const fold of folds.values()) {
    if (fold.kind !== 'playlistEntry') {
      continue;
    }
    if (fold.tombstoned) {
      tombstonedEntryIds.add(fold.recordId);
      changedKinds.add('playlistEntry');
      continue;
    }
    if (current.playlistEntries.some((e) => e.entryId === fold.recordId)) {
      continue;
    }
    const candidate = buildEntry(fold);
    if (candidate === null) {
      skipped.push({ kind: 'playlistEntry', reason: 'invalid' });
      continue;
    }
    if (candidate === undefined) {
      pend(fold);
      continue;
    }
    changedKinds.add('playlistEntry');
    nextEntries.push(candidate);
  }

  const tombstonedEventIds = new Set<string>();
  const eventInserts: { event: PlayEvent; fold: RecordFold }[] = [];
  for (const fold of folds.values()) {
    if (fold.kind !== 'playEvent') {
      continue;
    }
    if (fold.tombstoned) {
      tombstonedEventIds.add(fold.recordId);
      changedKinds.add('playEvent');
      continue;
    }
    const event = fold.fields.get('event');
    if (event === undefined) {
      pend(fold);
      continue;
    }
    if (!isPlayEvent(event) || event.eventId !== fold.recordId) {
      skipped.push({ kind: 'playEvent', reason: 'invalid' });
      continue;
    }
    eventInserts.push({ event, fold });
    changedKinds.add('playEvent');
  }
  const nextHistory: PlayEvent[] = current.playHistory.filter(
    (event) =>
      !tombstonedEventIds.has(event.eventId) &&
      liveRecordingIds.has(event.recordingId),
  );
  for (const { event, fold } of eventInserts) {
    if (!liveRecordingIds.has(event.recordingId)) {
      pend(fold);
      continue;
    }
    const idx = nextHistory.findIndex((e) => e.eventId === event.eventId);
    if (idx < 0) {
      nextHistory.push(event);
    } else {
      nextHistory[idx] = event;
    }
  }

  const tombstonedCountIds = new Set<string>();
  const nextCounts: PlayCount[] = [];
  const countFoldIds = new Set<string>();
  {
    for (const count of current.playCounts) {
      const fold = foldOf('playCount', count.recordingId);
      if (fold === undefined) {
        if (liveRecordingIds.has(count.recordingId)) {
          nextCounts.push(count);
        }
        continue;
      }
      if (fold.tombstoned || !liveRecordingIds.has(count.recordingId)) {
        tombstonedCountIds.add(count.recordingId);
        changedKinds.add('playCount');
        continue;
      }
      countFoldIds.add(count.recordingId);
      const foldedLast = numField(fold.fields, 'lastMs');
      const candidate: PlayCount = {
        recordingId: count.recordingId,
        count: Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.max(
            0,
            fold.absolute
              ? (numField(fold.fields, 'count') ?? count.count)
              : count.count + (fold.sumDeltas.get('count') ?? 0),
          ),
        ),
        lastMs:
          foldedLast !== null && foldedLast > count.lastMs
            ? foldedLast
            : count.lastMs,
      };
      if (!isPlayCount(candidate)) {
        skipped.push({ kind: 'playCount', reason: 'invalid' });
        nextCounts.push(count);
        continue;
      }
      changedKinds.add('playCount');
      nextCounts.push(candidate);
    }
    for (const fold of folds.values()) {
      if (fold.kind !== 'playCount') {
        continue;
      }
      if (fold.tombstoned) {
        tombstonedCountIds.add(fold.recordId);
        changedKinds.add('playCount');
        continue;
      }
      if (current.playCounts.some((c) => c.recordingId === fold.recordId)) {
        continue;
      }
      if (!liveRecordingIds.has(fold.recordId)) {
        pend(fold);
        continue;
      }
      const candidate: PlayCount = {
        recordingId: fold.recordId,
        count: Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.max(
            0,
            fold.absolute
              ? (numField(fold.fields, 'count') ?? 0)
              : (fold.sumDeltas.get('count') ?? 0),
          ),
        ),
        lastMs: Math.max(0, numField(fold.fields, 'lastMs') ?? 0),
      };
      if (!isPlayCount(candidate)) {
        skipped.push({ kind: 'playCount', reason: 'invalid' });
        continue;
      }
      changedKinds.add('playCount');
      nextCounts.push(candidate);
    }
  }

  const tombstonedReviewIds = new Set<string>();
  const nextReviews: MatchReview[] = [];
  {
    const touched = new Set(
      [...folds.values()]
        .filter((f) => f.kind === 'matchReview' && !f.tombstoned)
        .map((f) => f.recordId),
    );
    for (const review of current.matchReviews) {
      const fold = foldOf('matchReview', review.reviewId);
      if (fold !== undefined && fold.tombstoned) {
        tombstonedReviewIds.add(review.reviewId);
        changedKinds.add('matchReview');
        continue;
      }
      if (!liveRecordingIds.has(review.recordingId)) {
        continue;
      }
      if (fold === undefined) {
        nextReviews.push(review);
        continue;
      }
      const fields = fold.fields;
      const candidate: MatchReview = {
        ...review,
        status:
          (fields.get('status') as MatchReview['status']) ?? review.status,
        resolution: fields.has('resolution')
          ? ((fields.get('resolution') as MatchReview['resolution']) ?? null)
          : review.resolution,
        resolvedMs: fields.has('resolvedMs')
          ? ((fields.get('resolvedMs') as number | null) ?? null)
          : review.resolvedMs,
        candidates:
          (fields.get('candidates') as MatchReview['candidates']) ??
          review.candidates,
      };
      if (!isMatchReview(candidate)) {
        skipped.push({ kind: 'matchReview', reason: 'invalid' });
        nextReviews.push(review);
        continue;
      }
      changedKinds.add('matchReview');
      nextReviews.push(candidate);
    }
    // A review CREATED on another device materializes here: the
    // whitelist carries its immutable identity (recordingId +
    // createdMs), so a first-seen-remote record can build the row.
    // Missing identity or a missing parent recording pends — the
    // fields or the parent may still arrive (Review #46).
    for (const id of touched) {
      if (current.matchReviews.some((r) => r.reviewId === id)) {
        continue;
      }
      const fold = foldOf('matchReview', id);
      if (fold === undefined || fold.tombstoned) {
        continue;
      }
      const fields = fold.fields;
      const recordingId = strField(fields, 'recordingId');
      if (recordingId === null || !liveRecordingIds.has(recordingId)) {
        pend(fold);
        continue;
      }
      const createdMs = numField(fields, 'createdMs');
      const candidate: MatchReview = {
        reviewId: id,
        recordingId,
        candidates:
          (fields.get('candidates') as MatchReview['candidates']) ?? [],
        status: (fields.get('status') as MatchReview['status']) ?? 'pending',
        resolution:
          (fields.get('resolution') as MatchReview['resolution']) ?? null,
        createdMs: createdMs ?? 0,
        resolvedMs: (fields.get('resolvedMs') as number | null) ?? null,
      };
      // Not a valid row YET — the domain needs ≥1 candidate and a
      // resolution stamp on non-pending statuses, so an insert that
      // only carried a field subset pends until the rest arrives.
      if (!isMatchReview(candidate)) {
        pend(fold);
        continue;
      }
      changedKinds.add('matchReview');
      nextReviews.push(candidate);
    }
    for (const fold of folds.values()) {
      if (fold.kind === 'matchReview' && fold.tombstoned) {
        tombstonedReviewIds.add(fold.recordId);
        changedKinds.add('matchReview');
      }
    }
  }

  let nextSettings: Settings = current.settings;
  {
    const fold = foldOf('settings', SETTINGS_RECORD_ID);
    if (fold !== undefined) {
      if (fold.tombstoned) {
        skipped.push({ kind: 'settings', reason: 'unmaterializable' });
      } else {
        const candidate = { ...current.settings };
        for (const field of SETTINGS_SYNC_FIELDS) {
          if (fold.fields.has(field)) {
            (candidate as Record<string, unknown>)[field] =
              fold.fields.get(field);
          }
        }
        if (isSettings(candidate)) {
          nextSettings = candidate;
          changedKinds.add('settings');
        } else {
          skipped.push({ kind: 'settings', reason: 'invalid' });
        }
      }
    }
  }

  // ---- dependent drops -------------------------------------------------------

  const nextLyrics: LyricsCacheEntry[] =
    deadRecordingIds.size === 0
      ? [...current.lyricsCache]
      : current.lyricsCache.filter((e) => !deadRecordingIds.has(e.recordingId));
  const nextDownloads: DownloadRecord[] =
    deadRecordingIds.size === 0
      ? [...current.downloads]
      : current.downloads.filter((d) => !deadRecordingIds.has(d.recordingId));
  const nextLocalFiles: LocalFile[] =
    deadRecordingIds.size === 0
      ? [...current.localFiles]
      : current.localFiles.filter(
          (f) => !deadRecordingIds.has(f.recordingId),
        );

  // Queue: replay the domain's own remove() per dead-recording
  // occurrence so current/successor semantics match a local delete.
  let nextQueue: QueueSnapshot = current.queue;
  {
    const deadOccurrences = current.queue.occurrences.filter((occ) =>
      deadRecordingIds.has(occ.recordingId),
    );
    if (deadOccurrences.length > 0) {
      const draft = new QueueEngine(current.queue);
      for (const occ of deadOccurrences) {
        draft.remove(occ.occurrenceId);
      }
      nextQueue = draft.snapshot();
    }
  }

  // ---- batch assembly ---------------------------------------------------------

  type MutableBatch = {
    -readonly [K in keyof StorageBatch]?: StorageBatch[K];
  };
  const batch: MutableBatch = {};
  const batchablePlans = new Map(
    [...recordingPlans].filter(([, plan]) => plan.action !== 'pending'),
  );
  if (batchablePlans.size > 0) {
    batch.recordingsMerge = (fresh: readonly Recording[]) => {
      const next: Recording[] = [];
      const seen = new Set<string>();
      for (const rec of fresh) {
        const plan = batchablePlans.get(rec.id);
        seen.add(rec.id);
        if (plan === undefined || plan.action === 'pending') {
          next.push(rec);
          continue;
        }
        if (plan.action === 'delete') {
          continue;
        }
        const candidate: Recording = {
          ...overlayRecording(rec, plan.fields),
          sourceRefs: applyRefOps(rec.sourceRefs, plan),
          mappings: applyMapOps(rec.mappings, plan),
        };
        next.push(isRecording(candidate) ? candidate : rec);
      }
      for (const [id, plan] of batchablePlans) {
        if (seen.has(id) || plan.action !== 'upsert') {
          continue;
        }
        const built = buildRecording(plan.fields, plan, id);
        if (built !== null) {
          next.push(built);
        }
      }
      return next;
    };
  }
  if (!sameArray(nextLikes, current.likes)) {
    batch.likes = nextLikes;
  }
  if (!sameArray(nextEntities, current.entities)) {
    batch.entities = nextEntities;
  }
  if (!sameArray(nextEntityRefs, current.entitySourceRefs)) {
    batch.entitySourceRefs = nextEntityRefs;
  }
  if (!sameArray(nextPlaylists, current.playlists)) {
    batch.playlists = nextPlaylists;
  }
  if (!sameArray(nextEntries, current.playlistEntries)) {
    batch.playlistEntries = nextEntries;
  }
  if (!sameArray(nextHistory, current.playHistory)) {
    batch.playHistory = nextHistory;
  }
  if (!sameArray(nextCounts, current.playCounts)) {
    batch.playCounts = nextCounts;
  }
  if (!sameArray(nextReviews, current.matchReviews)) {
    batch.matchReviews = nextReviews;
  }
  if (!sameArray(nextLyrics, current.lyricsCache)) {
    batch.lyricsCache = nextLyrics;
  }
  if (!sameArray(nextDownloads, current.downloads)) {
    batch.downloads = nextDownloads;
  }
  if (!sameArray(nextLocalFiles, current.localFiles)) {
    batch.localFiles = nextLocalFiles;
  }
  if (
    nextQueue.revision !== current.queue.revision ||
    !sameArray(nextQueue.occurrences, current.queue.occurrences)
  ) {
    batch.queue = nextQueue;
  }
  if (nextSettings !== current.settings) {
    batch.settings = nextSettings;
  }

  return {
    batch,
    pending,
    pendingRecords,
    skipped,
    changedKinds: [...changedKinds],
  };
}
