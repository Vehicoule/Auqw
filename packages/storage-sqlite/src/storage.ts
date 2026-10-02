import type {
  AppError,
  ArtworkCacheEntry,
  AttemptTrace,
  CancellationSignal,
  DownloadRecord,
  DownloadState,
  Entity,
  EntityRef,
  EntitySourceRef,
  ExportDocument,
  Like,
  LocalFile,
  LocalSource,
  LogPort,
  LyricsCacheEntry,
  MatchReview,
  OperationContext,
  PersistedState,
  PlayCount,
  PlayEvent,
  Playlist,
  PlaylistEntry,
  QueueOccurrence,
  QueueSnapshot,
  Result,
  Settings,
  SourceMapping,
  SourceRef,
  StorageBatch,
  StoragePort,
} from '@auqw/application';
import {
  appError,
  err,
  isArtworkCacheEntry,
  isAttemptTrace,
  isDownloadRecord,
  isEntity,
  isEntitySourceRef,
  isExportDocument,
  isLike,
  isLocalFile,
  isLocalSource,
  isLyricsCacheEntry,
  isMatchReview,
  isPersistedState,
  isPlayCount,
  isPlayEvent,
  isPlaylist,
  isPlaylistEntry,
  isQueueSnapshot,
  isSettings,
  ok,
} from '@auqw/application';
import { CANCELLED } from './driver.ts';
import type {
  SqliteConnection,
  SqliteDriver,
  SqlRow,
  SqlValue,
} from './driver.ts';
import { enqueueDriverTransaction } from './transaction-queue.ts';
import {
  ATTEMPT_CAP,
  decodeRecordingRows,
  planCommit,
  rowTools,
} from './commit.ts';
import type { DroppedRow, RowTools } from './commit.ts';
import {
  CURRENT_SCHEMA_VERSION,
  KNOWN_SCHEMA_OBJECTS,
  MIGRATIONS,
} from './migrations.ts';

// Names SQLite collides within — tables, views, and indexes share
// one namespace; triggers are separate. The version-zero probe
// rejects a foreign file only when it holds an object that would
// actually block a migration's CREATE.
const FOREIGN_OBJECT_NAMES = KNOWN_SCHEMA_OBJECTS.filter(
  (o) => o.kind === 'object',
).map((o) => o.name);
const FOREIGN_TRIGGER_NAMES = KNOWN_SCHEMA_OBJECTS.filter(
  (o) => o.kind === 'trigger',
).map((o) => o.name);
const FOREIGN_PROBE_SQL =
  `SELECT name FROM sqlite_master WHERE ` +
  `(type IN ('table','index','view') AND name COLLATE NOCASE IN (${FOREIGN_OBJECT_NAMES.map(() => '?').join(',')}))` +
  (FOREIGN_TRIGGER_NAMES.length > 0
    ? ` OR (type = 'trigger' AND name COLLATE NOCASE IN (${FOREIGN_TRIGGER_NAMES.map(() => '?').join(',')}))`
    : '') +
  ` LIMIT 1`;
const FOREIGN_PROBE_PARAMS = [
  ...FOREIGN_OBJECT_NAMES,
  ...FOREIGN_TRIGGER_NAMES,
];

/**
 * Initialize sections keyed by driver: probe, backup, and migrate are
 * three steps split across two transactions (VACUUM INTO cannot run
 * inside BEGIN), so instances sharing a driver must serialize the
 * whole sequence — otherwise a second probe can capture a version the
 * first instance has already migrated past and replay its DDL.
 */
const INITIALIZE_TAILS = new WeakMap<
  SqliteDriver,
  { tail: Promise<void> }
>();

function transientError(): AppError {
  return appError('transient', 'storage operation failed');
}

function invalidData(): AppError {
  return appError('invalid-response', 'stored data failed validation');
}

function invalidImport(): AppError {
  return appError('invalid-response', 'import document failed validation');
}

function invalidSchema(): AppError {
  return appError('invalid-response', 'database schema is invalid');
}

function newerSchema(): AppError {
  return appError(
    'invalid-response',
    'database schema is newer than this app',
  );
}

function invalidExport(): AppError {
  return appError(
    'invalid-response',
    'exportedAtMs must be a safe nonnegative integer',
  );
}

function cancelledError(): AppError {
  return appError('cancelled', 'cancelled');
}

/**
 * SQLite-backed StoragePort. Platform-neutral: a driver supplies the
 * connection/transaction boundary; no SQLite runtime is bundled here.
 * The database is the only source of truth — there is no in-memory
 * cache, and every commit writes its row-level delta inside one
 * transaction so an interrupted write can never leave partials.
 */
export class SqliteStorage implements StoragePort {
  readonly #driver: SqliteDriver;
  readonly #defaults: Settings;
  readonly #log: LogPort | undefined;
  #init: Promise<Result<void>> | null = null;

  constructor(
    driver: SqliteDriver,
    defaultSettings: Settings,
    log?: LogPort,
  ) {
    if (!isSettings(defaultSettings)) {
      throw new TypeError('defaultSettings must be a valid Settings');
    }
    this.#driver = driver;
    this.#defaults = defaultSettings;
    this.#log = log;
  }

  /** Reports decode-dropped stored rows — table:key, content-free. */
  #reportDrops(context: string, dropped: readonly DroppedRow[]): void {
    if (this.#log === undefined || dropped.length === 0) {
      return;
    }
    const detail = dropped
      .slice(0, 8)
      .map((d) => `${d.table}:${d.key}`)
      .join(', ');
    void this.#log
      .write({
        level: 'warn',
        message:
          `storage: ${context} dropped ${dropped.length} malformed` +
          ` stored row${dropped.length === 1 ? '' : 's'}` +
          ` (${detail}${dropped.length > 8 ? ', …' : ''})`,
        atMs: Date.now(),
      })
      .catch(() => undefined);
  }

  #check(signal: CancellationSignal | undefined): void {
    if (signal?.cancelled === true) {
      throw CANCELLED;
    }
  }

  /**
   * The whole probe→backup→migrate sequence queued on the driver's
   * initialize tail. Each inner `#transaction` still serializes on the
   * transaction tail, so ordinary commits can interleave between the
   * sequence's steps — only a second instance's initialize waits.
   */
  #exclusiveInit<T>(work: () => Promise<T>): Promise<T> {
    let slot = INITIALIZE_TAILS.get(this.#driver);
    if (slot === undefined) {
      slot = { tail: Promise.resolve() };
      INITIALIZE_TAILS.set(this.#driver, slot);
    }
    const result = slot.tail.then(work);
    slot.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * One connection cannot run overlapping BEGIN/COMMIT sequences.
   * The tail is keyed on the driver, not this instance — it lives in
   * transaction-queue.ts so the sync-log store shares the same queue
   * when both sit on one database file.
   */
  #transaction<T>(
    work: (connection: SqliteConnection) => Promise<T>,
    signal: CancellationSignal,
  ): Promise<T> {
    return enqueueDriverTransaction(
      this.#driver,
      work,
      signal,
      (s) => this.#check(s),
    );
  }

  #mapError(thrown: unknown, signal: CancellationSignal): AppError {
    if (thrown === CANCELLED || signal.cancelled) {
      return cancelledError();
    }
    return transientError();
  }

  /**
   * One coalesced initialize per instance: reads the schema version,
   * migrates 0 -> 1 (DDL + defaults + version row) in a single
   * transaction, and stays retryable after failure.
   */
  initialize(context: OperationContext): Promise<Result<void>> {
    // A caller that arrives already cancelled gets its own typed
    // cancelled without disturbing a coalesced migration in flight.
    if (context.signal.cancelled) {
      return Promise.resolve(err(cancelledError()));
    }
    const existing = this.#init;
    if (existing !== null) {
      return existing;
    }
    const work = this.#exclusiveInit(() => this.#runInitialize(context));
    this.#init = work;
    void work.then((result) => {
      if (!result.ok && this.#init === work) {
        this.#init = null;
      }
    });
    return work;
  }

  async #runInitialize(context: OperationContext): Promise<Result<void>> {
    const signal = context.signal;
    try {
      // The version probe is its own transaction so a pre-migration
      // backup can run outside BEGIN (VACUUM INTO cannot run inside).
      const probed = await this.#transaction(async (conn) => {
        this.#check(signal);
        await conn.execute(
          'PRAGMA foreign_keys = ON',
          undefined,
          signal,
        );
        const found = await conn.query<SqlRow>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`,
          undefined,
          signal,
        );
        if (found.length === 0) {
          // Version zero claims an empty database. One that already
          // holds application-named tables is a foreign file being
          // adopted — reject it rather than merge into it. Partial
          // migrations cannot get here: each migration is one
          // transaction and rolls back whole.
          const foreign = await conn.query<SqlRow>(
            // NOCASE: sqlite_master stores the creation-time spelling
            // but SQLite treats identifiers case-insensitively — a
            // foreign `Downloads` collides with `downloads` all the
            // same, and must reject as foreign, not die in-migration.
            FOREIGN_PROBE_SQL,
            FOREIGN_PROBE_PARAMS,
            signal,
          );
          if (foreign.length > 0) {
            return err(invalidSchema());
          }
          return ok(0);
        }
        const rows = await conn.query<SqlRow>(
          'SELECT version FROM schema_version',
          undefined,
          signal,
        );
        if (rows.length !== 1) {
          return err(invalidSchema());
        }
        const raw = rows[0]?.['version'];
        if (
          typeof raw !== 'number' ||
          !Number.isSafeInteger(raw) ||
          raw < 0
        ) {
          return err(invalidSchema());
        }
        if (raw > CURRENT_SCHEMA_VERSION) {
          return err(newerSchema());
        }
        return ok(raw);
      }, signal);
      if (!probed.ok) {
        return err(probed.error);
      }
      const version = probed.value;
      if (version === CURRENT_SCHEMA_VERSION) {
        return ok(undefined);
      }
      if (version > 0) {
        // Destructive migrations keep a recoverable backup (data.md):
        // the v1 -> v2 likes rebuild drops the old table, so the
        // pre-migration file is copied first.
        this.#check(signal);
        await this.#driver.backup(`v${version}`);
      }
      const migrated = await this.#transaction(async (conn) => {
        this.#check(signal);
        await conn.execute(
          'PRAGMA foreign_keys = ON',
          undefined,
          signal,
        );
        for (let step = version; step < CURRENT_SCHEMA_VERSION; step += 1) {
          for (const statement of MIGRATIONS[step] ?? []) {
            this.#check(signal);
            await conn.execute(statement, undefined, signal);
          }
        }
        this.#check(signal);
        if (version === 0) {
          await conn.execute(
            `INSERT INTO settings (id, catalog_provider, playback_provider, storefront, quality_kbps, theme, prefetch, lyrics_provider, radio_provider, artwork_cache_bytes, download_metered, language)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              this.#defaults.catalogProvider,
              this.#defaults.playbackProvider,
              this.#defaults.storefront,
              this.#defaults.qualityKbps,
              this.#defaults.theme,
              this.#defaults.prefetch ? 1 : 0,
              this.#defaults.lyricsProvider ?? null,
              this.#defaults.radioProvider ?? null,
              this.#defaults.artworkCacheBytes ?? null,
              this.#defaults.downloadMetered === true ? 1 : 0,
              this.#defaults.language ?? null,
            ],
            signal,
          );
          await conn.execute(
            `INSERT INTO queue_state (id, revision, current_occurrence_id, position_ms, mode, blocked_error_json)
             VALUES (1, 0, NULL, 0, 'stopped', NULL)`,
            undefined,
            signal,
          );
          await conn.execute(
            'INSERT INTO schema_version (id, version) VALUES (1, ?)',
            [CURRENT_SCHEMA_VERSION],
            signal,
          );
        } else {
          await conn.execute(
            'UPDATE schema_version SET version = ? WHERE id = 1',
            [CURRENT_SCHEMA_VERSION],
            signal,
          );
        }
        return ok(undefined);
      }, signal);
      if (migrated.ok && version > 0) {
        // The pre-migration image has served its purpose — drop it so
        // a full database copy does not persist. Cleanup is
        // best-effort: a failed remove leaves an advisory file, not a
        // failed initialize.
        try {
          await this.#driver.dropBackup(`v${version}`);
        } catch {
          // Advisory file cleanup; see above.
        }
      }
      return migrated;
    } catch (thrown) {
      return err(this.#mapError(thrown, signal));
    }
  }

  async load(
    context: OperationContext,
  ): Promise<Result<PersistedState>> {
    const init = await this.initialize(context);
    if (!init.ok) {
      return init;
    }
    const signal = context.signal;
    try {
      return await this.#transaction(async (conn) => {
        this.#check(signal);
        return await this.#readState(conn, signal);
      }, signal);
    } catch (thrown) {
      return err(this.#mapError(thrown, signal));
    }
  }

  async commit(
    batch: StorageBatch,
    context: OperationContext,
  ): Promise<Result<void>> {
    const init = await this.initialize(context);
    if (!init.ok) {
      return init;
    }
    const signal = context.signal;
    try {
      return await this.#transaction(async (conn) => {
        this.#check(signal);
        const planned = await planCommit(conn, batch, signal);
        if (!planned.ok) {
          return err(planned.error);
        }
        this.#check(signal);
        this.#reportDrops('commit', planned.value.dropped);
        await conn.executeAll(planned.value.statements, signal);
        this.#check(signal);
        return ok(undefined);
      }, signal);
    } catch (thrown) {
      return err(this.#mapError(thrown, signal));
    }
  }

  async loadAttempts(
    limit: number,
    context: OperationContext,
  ): Promise<Result<readonly AttemptTrace[]>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ATTEMPT_CAP) {
      throw new TypeError('limit must be a safe integer in 1..500');
    }
    const init = await this.initialize(context);
    if (!init.ok) {
      return init;
    }
    const signal = context.signal;
    try {
      return await this.#transaction(async (conn) => {
        this.#check(signal);
        const rows = await conn.query<SqlRow>(
          'SELECT request_id, trace_json FROM attempt_traces ORDER BY seq DESC LIMIT ?',
          [limit],
          signal,
        );
        this.#check(signal);
        const traces: AttemptTrace[] = [];
        for (const row of rows) {
          const text = row['trace_json'];
          let parsed: unknown = null;
          let parseOk = typeof text === 'string';
          if (parseOk) {
            try {
              parsed = JSON.parse(text as string);
            } catch {
              parseOk = false;
            }
          }
          if (
            !parseOk ||
            !isAttemptTrace(parsed) ||
            parsed.requestId !== row['request_id']
          ) {
            return err(invalidData());
          }
          traces.push(parsed);
        }
        return ok(traces);
      }, signal);
    } catch (thrown) {
      return err(this.#mapError(thrown, signal));
    }
  }

  async exportOwned(
    exportedAtMs: number,
    context: OperationContext,
  ): Promise<Result<ExportDocument>> {
    // The port never throws: a bad timestamp (e.g. a broken clock)
    // is a typed error, not a TypeError.
    if (!Number.isSafeInteger(exportedAtMs) || exportedAtMs < 0) {
      return err(invalidExport());
    }
    const init = await this.initialize(context);
    if (!init.ok) {
      return init;
    }
    const signal = context.signal;
    try {
      return await this.#transaction(async (conn) => {
        this.#check(signal);
        const state = await this.#readState(conn, signal);
        if (!state.ok) {
          return state;
        }
        const doc = toExportDocument(state.value, exportedAtMs);
        if (!isExportDocument(doc)) {
          return err(invalidData());
        }
        return ok(doc);
      }, signal);
    } catch (thrown) {
      return err(this.#mapError(thrown, signal));
    }
  }

  async importOwned(
    doc: ExportDocument,
    context: OperationContext,
  ): Promise<Result<void>> {
    // The entire document validates before any write (data.md).
    if (!isExportDocument(doc)) {
      return err(invalidImport());
    }
    const init = await this.initialize(context);
    if (!init.ok) {
      return init;
    }
    const signal = context.signal;
    try {
      return await this.#transaction(async (conn) => {
        this.#check(signal);
        // Wipe owned tables child-first. Session rows (queue) and
        // lyrics_cache foreign-key into the recordings being
        // replaced, so they are cleared; attempt_traces and
        // artwork_cache have no such keys and are left untouched.
        // Downloads/local_files also key into recordings and get
        // wiped — the device-local files stay on disk for the
        // integrity pass to reconcile; local_sources (the user's
        // folder grants) are kept since the export never carried them.
        // The session survives the import as an empty stopped queue —
        // its old occurrences named the recordings being replaced. The
        // bump only applies when the queue is not already at that
        // post-import state, so a wholesale transaction replay (a
        // dead-handle retry whose COMMIT had already landed) is a
        // no-op instead of incrementing the revision a second time.
        await conn.execute(
          `UPDATE queue_state
           SET revision = revision + 1, current_occurrence_id = NULL,
               position_ms = 0, mode = 'stopped', blocked_error_json = NULL
           WHERE id = 1
             AND (current_occurrence_id IS NOT NULL
                  OR position_ms <> 0
                  OR mode <> 'stopped'
                  OR blocked_error_json IS NOT NULL
                  OR EXISTS (SELECT 1 FROM queue_occurrences))`,
          undefined,
          signal,
        );
        for (const statement of [
          'DELETE FROM queue_occurrences',
          'DELETE FROM lyrics_cache',
          'DELETE FROM downloads',
          'DELETE FROM local_files',
          'DELETE FROM likes',
          'DELETE FROM match_reviews',
          'DELETE FROM play_history',
          'DELETE FROM play_counts',
          'DELETE FROM playlist_entries',
          'DELETE FROM playlists',
          'DELETE FROM entity_source_refs',
          'DELETE FROM entities',
          'DELETE FROM mappings',
          'DELETE FROM source_refs',
          'DELETE FROM recordings',
          'DELETE FROM settings',
        ]) {
          await conn.execute(statement, undefined, signal);
        }
        await conn.execute(
          `INSERT OR IGNORE INTO queue_state (id, revision, current_occurrence_id, position_ms, mode, blocked_error_json)
           VALUES (1, 0, NULL, 0, 'stopped', NULL)`,
          undefined,
          signal,
        );
        this.#check(signal);
        const refsByRecording = new Map<string, SourceRef[]>();
        for (const row of doc.sourceRefs) {
          const list = refsByRecording.get(row.recordingId) ?? [];
          list.push(row.ref);
          refsByRecording.set(row.recordingId, list);
        }
        const mappingsByRecording = new Map<string, SourceMapping[]>();
        for (const row of doc.mappings) {
          const list = mappingsByRecording.get(row.recordingId) ?? [];
          list.push(row.mapping);
          mappingsByRecording.set(row.recordingId, list);
        }
        for (const recording of doc.recordings) {
          await conn.execute(
            `INSERT INTO recordings (id, title, artist, album, duration_ms, release_year, artwork_json, explicit, genre, isrc, version_labels_json, provenance)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              recording.id,
              recording.title,
              recording.artist,
              recording.album,
              recording.durationMs,
              recording.releaseYear,
              JSON.stringify(recording.artwork),
              recording.explicit === null
                ? null
                : recording.explicit
                  ? 1
                  : 0,
              recording.genre,
              recording.isrc,
              JSON.stringify(recording.versionLabels),
              // Pre-slice-3 exports carry no provenance — 'provider'.
              recording.provenance ?? 'provider',
            ],
            signal,
          );
          const refs = refsByRecording.get(recording.id) ?? [];
          for (const [ordinal, ref] of refs.entries()) {
            await conn.execute(
              `INSERT INTO source_refs (recording_id, ordinal, provider, kind, source_id)
               VALUES (?, ?, ?, ?, ?)`,
              [recording.id, ordinal, ref.provider, ref.kind, ref.id],
              signal,
            );
          }
          const mappings = mappingsByRecording.get(recording.id) ?? [];
          for (const [ordinal, mapping] of mappings.entries()) {
            await conn.execute(
              `INSERT INTO mappings (recording_id, ordinal, provider, kind, source_id, status, matched_at_ms, evidence_json)
               VALUES (?, ?, ?, 'track', ?, ?, ?, ?)`,
              [
                recording.id,
                ordinal,
                mapping.ref.provider,
                mapping.ref.id,
                mapping.status,
                mapping.matchedAtMs,
                JSON.stringify(mapping.evidence),
              ],
              signal,
            );
          }
        }
        for (const entity of doc.entities) {
          await conn.execute(
            `INSERT INTO entities (entity_id, kind, title, artist_name, artwork_json, created_ms)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              entity.entityId,
              entity.kind,
              entity.title,
              entity.artistName,
              entity.artwork.length === 0
                ? null
                : JSON.stringify(entity.artwork),
              entity.createdMs,
            ],
            signal,
          );
        }
        for (const ref of doc.entitySourceRefs) {
          await conn.execute(
            `INSERT INTO entity_source_refs (entity_id, provider, ref_json)
             VALUES (?, ?, ?)`,
            [ref.entityId, ref.provider, JSON.stringify(ref.ref)],
            signal,
          );
        }
        for (const playlist of doc.playlists) {
          await conn.execute(
            `INSERT INTO playlists (playlist_id, name, created_ms, updated_ms)
             VALUES (?, ?, ?, ?)`,
            [
              playlist.playlistId,
              playlist.name,
              playlist.createdMs,
              playlist.updatedMs,
            ],
            signal,
          );
        }
        for (const entry of doc.playlistEntries) {
          await conn.execute(
            `INSERT INTO playlist_entries (entry_id, playlist_id, recording_id, position, selected_ref_json, added_ms)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              entry.entryId,
              entry.playlistId,
              entry.recordingId,
              entry.position,
              entry.selectedRef === null
                ? null
                : JSON.stringify(entry.selectedRef),
              entry.addedMs,
            ],
            signal,
          );
        }
        for (const like of doc.likes) {
          await conn.execute(
            `INSERT INTO likes (entity_kind, target_id, liked_ms)
             VALUES (?, ?, ?)`,
            [like.entityKind, like.targetId, like.likedAtMs],
            signal,
          );
        }
        for (const event of doc.playHistory) {
          await conn.execute(
            `INSERT INTO play_history (event_id, recording_id, occurrence_id, played_ms, listened_ms)
             VALUES (?, ?, ?, ?, ?)`,
            [
              event.eventId,
              event.recordingId,
              event.occurrenceId,
              event.playedMs,
              event.listenedMs,
            ],
            signal,
          );
        }
        for (const count of doc.playCounts) {
          await conn.execute(
            `INSERT INTO play_counts (recording_id, count, last_ms)
             VALUES (?, ?, ?)`,
            [count.recordingId, count.count, count.lastMs],
            signal,
          );
        }
        for (const review of doc.matchReviews) {
          await conn.execute(
            `INSERT INTO match_reviews (review_id, recording_id, candidates_json, status, resolution_json, created_ms, resolved_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              review.reviewId,
              review.recordingId,
              JSON.stringify(review.candidates),
              review.status,
              review.resolution === null
                ? null
                : JSON.stringify(review.resolution),
              review.createdMs,
              review.resolvedMs,
            ],
            signal,
          );
        }
        await conn.execute(
          `INSERT INTO settings (id, catalog_provider, playback_provider, storefront, quality_kbps, theme, prefetch, lyrics_provider, radio_provider, artwork_cache_bytes, download_metered, language)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            doc.settings.catalogProvider,
            doc.settings.playbackProvider,
            doc.settings.storefront,
            doc.settings.qualityKbps,
            doc.settings.theme,
            doc.settings.prefetch ? 1 : 0,
            doc.settings.lyricsProvider ?? null,
            doc.settings.radioProvider ?? null,
            doc.settings.artworkCacheBytes ?? null,
            doc.settings.downloadMetered === true ? 1 : 0,
            doc.settings.language ?? null,
          ],
          signal,
        );
        this.#check(signal);
        return ok(undefined);
      }, signal);
    } catch (thrown) {
      return err(this.#mapError(thrown, signal));
    }
  }

  /** Reconstructs the persisted document; null marks malformed rows. */
  async #readState(
    conn: SqliteConnection,
    signal: CancellationSignal,
  ): Promise<Result<PersistedState>> {
    this.#check(signal);
    const rows = {} as TableRows;
    for (const [key, sql] of TABLE_QUERIES) {
      rows[key] = await conn.query<SqlRow>(sql, undefined, signal);
    }
    this.#check(signal);
    const built = decodeState(rows);
    if (built === null || !isPersistedState(built.state)) {
      return err(invalidData());
    }
    this.#reportDrops('load', built.dropped);
    return ok(built.state);
  }
}

/** Owned-data projection of the persisted document, flattened. */
function toExportDocument(
  state: PersistedState,
  exportedAtMs: number,
): ExportDocument {
  return {
    formatVersion: 1,
    exportedAtMs,
    recordings: state.recordings.map(
      ({ sourceRefs: _refs, mappings: _mappings, ...core }) => core,
    ),
    sourceRefs: state.recordings.flatMap((recording) =>
      recording.sourceRefs.map((ref) => ({ recordingId: recording.id, ref })),
    ),
    mappings: state.recordings.flatMap((recording) =>
      recording.mappings.map((mapping) => ({
        recordingId: recording.id,
        mapping,
      })),
    ),
    likes: state.likes,
    entities: state.entities,
    entitySourceRefs: state.entitySourceRefs,
    playlists: state.playlists,
    playlistEntries: state.playlistEntries,
    playHistory: state.playHistory,
    playCounts: state.playCounts,
    matchReviews: state.matchReviews,
    settings: state.settings,
  };
}

type TableRows = {
  recordings: readonly SqlRow[];
  sourceRefs: readonly SqlRow[];
  mappings: readonly SqlRow[];
  likes: readonly SqlRow[];
  entities: readonly SqlRow[];
  entitySourceRefs: readonly SqlRow[];
  playlists: readonly SqlRow[];
  playlistEntries: readonly SqlRow[];
  playHistory: readonly SqlRow[];
  playCounts: readonly SqlRow[];
  matchReviews: readonly SqlRow[];
  lyricsCache: readonly SqlRow[];
  artworkCache: readonly SqlRow[];
  downloads: readonly SqlRow[];
  localSources: readonly SqlRow[];
  localFiles: readonly SqlRow[];
  queueState: readonly SqlRow[];
  queueOccurrences: readonly SqlRow[];
  settings: readonly SqlRow[];
};

const TABLE_QUERIES: readonly (readonly [keyof TableRows, string])[] = [
  ['recordings', 'SELECT * FROM recordings ORDER BY rowid'],
  ['sourceRefs', 'SELECT * FROM source_refs ORDER BY recording_id, ordinal'],
  ['mappings', 'SELECT * FROM mappings ORDER BY recording_id, ordinal'],
  ['likes', 'SELECT * FROM likes ORDER BY rowid'],
  ['entities', 'SELECT * FROM entities ORDER BY rowid'],
  [
    'entitySourceRefs',
    'SELECT * FROM entity_source_refs ORDER BY entity_id, provider',
  ],
  ['playlists', 'SELECT * FROM playlists ORDER BY rowid'],
  [
    'playlistEntries',
    'SELECT * FROM playlist_entries ORDER BY playlist_id, position, entry_id',
  ],
  [
    'playHistory',
    'SELECT * FROM play_history ORDER BY played_ms, event_id',
  ],
  ['playCounts', 'SELECT * FROM play_counts ORDER BY rowid'],
  ['matchReviews', 'SELECT * FROM match_reviews ORDER BY rowid'],
  ['lyricsCache', 'SELECT * FROM lyrics_cache ORDER BY rowid'],
  ['artworkCache', 'SELECT * FROM artwork_cache ORDER BY rowid'],
  ['downloads', 'SELECT * FROM downloads ORDER BY requested_ms, download_id'],
  ['localSources', 'SELECT * FROM local_sources ORDER BY added_ms, source_id'],
  ['localFiles', 'SELECT * FROM local_files ORDER BY source_id, file_id'],
  ['queueState', 'SELECT * FROM queue_state WHERE id = 1'],
  ['queueOccurrences', 'SELECT * FROM queue_occurrences ORDER BY ordinal'],
  ['settings', 'SELECT * FROM settings WHERE id = 1'],
];
function decodeState(
  rows: TableRows,
): { state: PersistedState; dropped: readonly DroppedRow[] } | null {
  const occurrenceRows = rows.queueOccurrences;
  const queueRows = rows.queueState;
  const settingsRows = rows.settings;
  if (queueRows.length !== 1 || settingsRows.length !== 1) {
    return null;
  }
  const queueRow = queueRows[0];
  const settingsRow = settingsRows[0];
  if (queueRow === undefined || settingsRow === undefined) {
    return null;
  }
  const dropped: DroppedRow[] = [];
  const keyOf = (value: SqlValue | undefined): string =>
    typeof value === 'string' ? value : '#';
  // Rows reach these tables through the raw statement path (renderer
  // `storage:*` writes, a migrated file), so the decode is
  // drop-tolerant: a row violating shape, uniqueness, or a foreign
  // reference is an orphan — dropped, reported, and deleted by the
  // next section commit's diff — never a reason to fail the whole
  // restore. The queue_state/settings singletons stay strict on their
  // required fields: a corrupt singleton is engine damage, not an
  // orphan.
  const keep = <T>(
    table: string,
    key: string,
    decode: (t: RowTools) => T | null,
  ): T | null => {
    let bad = false;
    const value = decode(rowTools(() => {
      bad = true;
    }));
    if (bad || value === null) {
      dropped.push({ table, key });
      return null;
    }
    return value;
  };

  const decoded = decodeRecordingRows(
    rows.recordings,
    rows.sourceRefs,
    rows.mappings,
  );
  dropped.push(...decoded.dropped);
  const recordings = decoded.recordings;
  const recordingIds = decoded.recordingIds;

  // Entities decode before entity_source_refs and entity-kind likes:
  // both resolve their target id against this set. Duplicate ids drop
  // (the PK normally prevents them).
  const entityIds = new Set<string>();
  const entityKinds = new Map<string, Entity['kind']>();
  const entities: Entity[] = [];
  for (const row of rows.entities) {
    const entity = keep('entities', keyOf(row['entity_id']), (t) => {
      const candidate: Entity = {
        entityId: t.reqStr(row['entity_id']),
        kind: row['kind'] as Entity['kind'],
        title: t.reqStr(row['title']),
        artistName: t.optStr(row['artist_name']),
        artwork:
          row['artwork_json'] === null
            ? []
            : (t.json(row['artwork_json']) as Entity['artwork']),
        createdMs: t.reqNonNegInt(row['created_ms']),
      };
      if (entityIds.has(candidate.entityId) || !isEntity(candidate)) {
        return null;
      }
      entityIds.add(candidate.entityId);
      entityKinds.set(candidate.entityId, candidate.kind);
      return candidate;
    });
    if (entity !== null) {
      entities.push(entity);
    }
  }

  // likes: polymorphic target_id — 'track' names a recording,
  // 'album'/'artist' name an entity of the same kind.
  const likeKeys = new Set<string>();
  const likes: Like[] = [];
  for (const row of rows.likes) {
    const like = keep('likes', keyOf(row['target_id']), (t) => {
      const candidate: Like = {
        entityKind: row['entity_kind'] as Like['entityKind'],
        targetId: t.reqStr(row['target_id']),
        likedAtMs: t.reqNonNegInt(row['liked_ms']),
      };
      const key = `${candidate.entityKind} ${candidate.targetId}`;
      const resolves =
        candidate.entityKind === 'track'
          ? recordingIds.has(candidate.targetId)
          : entityKinds.get(candidate.targetId) === candidate.entityKind;
      if (likeKeys.has(key) || !isLike(candidate) || !resolves) {
        return null;
      }
      likeKeys.add(key);
      return candidate;
    });
    if (like !== null) {
      likes.push(like);
    }
  }

  const entityRefKeys = new Set<string>();
  const entitySourceRefs: EntitySourceRef[] = [];
  for (const row of rows.entitySourceRefs) {
    const ref = keep(
      'entity_source_refs',
      `${keyOf(row['entity_id'])} ${keyOf(row['provider'])}`,
      (t) => {
        const candidate: EntitySourceRef = {
          entityId: t.reqStr(row['entity_id']),
          provider: t.reqNonEmpty(row['provider']),
          ref: t.json(row['ref_json']) as EntityRef,
        };
        const key = `${candidate.entityId} ${candidate.provider}`;
        // The ref's kind must agree with the target entity's kind.
        const refKind =
          typeof candidate.ref === 'object' && candidate.ref !== null
            ? candidate.ref.kind
            : undefined;
        if (
          !entityIds.has(candidate.entityId) ||
          entityRefKeys.has(key) ||
          refKind !== entityKinds.get(candidate.entityId) ||
          !isEntitySourceRef(candidate)
        ) {
          return null;
        }
        entityRefKeys.add(key);
        return candidate;
      },
    );
    if (ref !== null) {
      entitySourceRefs.push(ref);
    }
  }

  const playlistIds = new Set<string>();
  const playlists: Playlist[] = [];
  for (const row of rows.playlists) {
    const playlist = keep(
      'playlists',
      keyOf(row['playlist_id']),
      (t) => {
        const candidate: Playlist = {
          playlistId: t.reqStr(row['playlist_id']),
          name: t.reqStr(row['name']),
          createdMs: t.reqNonNegInt(row['created_ms']),
          updatedMs: t.reqNonNegInt(row['updated_ms']),
        };
        if (
          playlistIds.has(candidate.playlistId) ||
          !isPlaylist(candidate)
        ) {
          return null;
        }
        playlistIds.add(candidate.playlistId);
        return candidate;
      },
    );
    if (playlist !== null) {
      playlists.push(playlist);
    }
  }

  const entryIds = new Set<string>();
  const entryPositions = new Map<string, Set<number>>();
  const playlistEntries: PlaylistEntry[] = [];
  for (const row of rows.playlistEntries) {
    const entry = keep('playlist_entries', keyOf(row['entry_id']), (t) => {
      const position = row['position'];
      if (typeof position !== 'number' || !Number.isFinite(position)) {
        return null;
      }
      const candidate: PlaylistEntry = {
        entryId: t.reqStr(row['entry_id']),
        playlistId: t.reqStr(row['playlist_id']),
        recordingId: t.reqStr(row['recording_id']),
        position,
        selectedRef:
          row['selected_ref_json'] === null
            ? null
            : (t.json(row['selected_ref_json']) as SourceRef),
        addedMs: t.reqNonNegInt(row['added_ms']),
      };
      const seen =
        entryPositions.get(candidate.playlistId) ?? new Set<number>();
      if (
        !playlistIds.has(candidate.playlistId) ||
        !recordingIds.has(candidate.recordingId) ||
        entryIds.has(candidate.entryId) ||
        seen.has(position) ||
        !isPlaylistEntry(candidate)
      ) {
        return null;
      }
      entryIds.add(candidate.entryId);
      seen.add(position);
      entryPositions.set(candidate.playlistId, seen);
      return candidate;
    });
    if (entry !== null) {
      playlistEntries.push(entry);
    }
  }

  const eventIds = new Set<string>();
  const playHistory: PlayEvent[] = [];
  for (const row of rows.playHistory) {
    const event = keep('play_history', keyOf(row['event_id']), (t) => {
      const candidate: PlayEvent = {
        eventId: t.reqStr(row['event_id']),
        recordingId: t.reqStr(row['recording_id']),
        occurrenceId: t.optStr(row['occurrence_id']),
        playedMs: t.reqNonNegInt(row['played_ms']),
        listenedMs: t.reqNonNegInt(row['listened_ms']),
      };
      if (
        eventIds.has(candidate.eventId) ||
        !recordingIds.has(candidate.recordingId) ||
        !isPlayEvent(candidate)
      ) {
        return null;
      }
      eventIds.add(candidate.eventId);
      return candidate;
    });
    if (event !== null) {
      playHistory.push(event);
    }
  }

  const countedIds = new Set<string>();
  const playCounts: PlayCount[] = [];
  for (const row of rows.playCounts) {
    const count = keep('play_counts', keyOf(row['recording_id']), (t) => {
      const candidate: PlayCount = {
        recordingId: t.reqStr(row['recording_id']),
        count: t.reqNonNegInt(row['count']),
        lastMs: t.reqNonNegInt(row['last_ms']),
      };
      if (
        countedIds.has(candidate.recordingId) ||
        !recordingIds.has(candidate.recordingId) ||
        !isPlayCount(candidate)
      ) {
        return null;
      }
      countedIds.add(candidate.recordingId);
      return candidate;
    });
    if (count !== null) {
      playCounts.push(count);
    }
  }

  const reviewIds = new Set<string>();
  const matchReviews: MatchReview[] = [];
  for (const row of rows.matchReviews) {
    const review = keep('match_reviews', keyOf(row['review_id']), (t) => {
      const resolvedMs = t.optInt(row['resolved_ms']);
      const candidate: MatchReview = {
        reviewId: t.reqStr(row['review_id']),
        recordingId: t.reqStr(row['recording_id']),
        candidates: t.json(
          row['candidates_json'],
        ) as MatchReview['candidates'],
        status: row['status'] as MatchReview['status'],
        resolution:
          row['resolution_json'] === null
            ? null
            : (t.json(row['resolution_json']) as MatchReview['resolution']),
        createdMs: t.reqNonNegInt(row['created_ms']),
        resolvedMs,
      };
      if (
        reviewIds.has(candidate.reviewId) ||
        !recordingIds.has(candidate.recordingId) ||
        (resolvedMs !== null && resolvedMs < 0) ||
        !isMatchReview(candidate)
      ) {
        return null;
      }
      reviewIds.add(candidate.reviewId);
      return candidate;
    });
    if (review !== null) {
      matchReviews.push(review);
    }
  }

  const lyricIds = new Set<string>();
  const lyricsCache: LyricsCacheEntry[] = [];
  for (const row of rows.lyricsCache) {
    const entry = keep('lyrics_cache', keyOf(row['recording_id']), (t) => {
      // provider_version is three-way: NULL = a pre-versioning row
      // (decodes as an absent field, so the session sees it stale and
      // refetches once); '' = an explicitly-recorded null provenance
      // from a versionless provider's write; else the version string.
      const providerVersion = row['provider_version'];
      const candidate: LyricsCacheEntry = {
        recordingId: t.reqStr(row['recording_id']),
        provider: t.reqNonEmpty(row['provider']),
        kind: row['kind'] as LyricsCacheEntry['kind'],
        payload: t.json(
          row['payload_json'],
        ) as LyricsCacheEntry['payload'],
        fetchedMs: t.reqNonNegInt(row['fetched_ms']),
        ...(providerVersion === null
          ? {}
          : {
              providerVersion:
                providerVersion === '' ? null : t.reqStr(providerVersion),
            }),
      };
      if (
        lyricIds.has(candidate.recordingId) ||
        !recordingIds.has(candidate.recordingId) ||
        !isLyricsCacheEntry(candidate)
      ) {
        return null;
      }
      lyricIds.add(candidate.recordingId);
      return candidate;
    });
    if (entry !== null) {
      lyricsCache.push(entry);
    }
  }

  const artworkUrls = new Set<string>();
  const artworkCache: ArtworkCacheEntry[] = [];
  for (const row of rows.artworkCache) {
    const entry = keep('artwork_cache', keyOf(row['url']), (t) => {
      const candidate: ArtworkCacheEntry = {
        url: t.reqStr(row['url']),
        filePath: t.reqStr(row['file_path']),
        bytes: t.reqNonNegInt(row['bytes']),
        lastAccessedMs: t.reqNonNegInt(row['last_accessed_ms']),
      };
      if (artworkUrls.has(candidate.url) || !isArtworkCacheEntry(candidate)) {
        return null;
      }
      artworkUrls.add(candidate.url);
      return candidate;
    });
    if (entry !== null) {
      artworkCache.push(entry);
    }
  }

  const downloadIds = new Set<string>();
  const downloadedRecordingIds = new Set<string>();
  const downloads: DownloadRecord[] = [];
  for (const row of rows.downloads) {
    const download = keep('downloads', keyOf(row['download_id']), (t) => {
      const candidate: DownloadRecord = {
        downloadId: t.reqStr(row['download_id']),
        recordingId: t.reqStr(row['recording_id']),
        provider: t.reqNonEmpty(row['provider']),
        sourceRef: t.json(row['source_ref_json']) as SourceRef,
        filePath: t.reqStr(row['file_path']),
        bytes: t.reqNonNegInt(row['bytes']),
        state: row['state'] as DownloadState,
        committedOffset: t.reqNonNegInt(row['committed_offset']),
        checksum: t.optStr(row['checksum']),
        mime: t.optStr(row['mime']),
        itag: t.optInt(row['itag']),
        expiresAtMs: t.optInt(row['expires_at_ms']),
        error:
          row['error_json'] === null
            ? null
            : (t.json(row['error_json']) as DownloadRecord['error']),
        priority: t.reqNonNegInt(row['priority']),
        requestedMs: t.reqNonNegInt(row['requested_ms']),
        downloadedMs: t.optInt(row['downloaded_ms']),
      };
      if (
        downloadIds.has(candidate.downloadId) ||
        !recordingIds.has(candidate.recordingId) ||
        downloadedRecordingIds.has(candidate.recordingId) ||
        !isDownloadRecord(candidate)
      ) {
        return null;
      }
      downloadIds.add(candidate.downloadId);
      downloadedRecordingIds.add(candidate.recordingId);
      return candidate;
    });
    if (download !== null) {
      downloads.push(download);
    }
  }

  const localSourceIds = new Set<string>();
  const localSources: LocalSource[] = [];
  for (const row of rows.localSources) {
    const source = keep('local_sources', keyOf(row['source_id']), (t) => {
      const candidate: LocalSource = {
        sourceId: t.reqStr(row['source_id']),
        treeUri: t.reqStr(row['tree_uri']),
        label: t.reqStr(row['label']),
        addedMs: t.reqNonNegInt(row['added_ms']),
        lastScanMs: t.optInt(row['last_scan_ms']),
      };
      if (
        localSourceIds.has(candidate.sourceId) ||
        !isLocalSource(candidate)
      ) {
        return null;
      }
      localSourceIds.add(candidate.sourceId);
      return candidate;
    });
    if (source !== null) {
      localSources.push(source);
    }
  }

  const localFileIds = new Set<string>();
  const localFiles: LocalFile[] = [];
  for (const row of rows.localFiles) {
    const file = keep('local_files', keyOf(row['file_id']), (t) => {
      const candidate: LocalFile = {
        fileId: t.reqStr(row['file_id']),
        sourceId: t.reqStr(row['source_id']),
        docId: t.reqStr(row['doc_id']),
        size: t.reqNonNegInt(row['size']),
        fingerprint: t.reqStr(row['fingerprint']),
        modifiedMs: t.optInt(row['modified_ms']),
        title: t.optStr(row['title']),
        artist: t.optStr(row['artist']),
        album: t.optStr(row['album']),
        durationMs: t.optInt(row['duration_ms']),
        genre: t.optStr(row['genre']),
        recordingId: t.reqStr(row['recording_id']),
      };
      if (
        localFileIds.has(candidate.fileId) ||
        !localSourceIds.has(candidate.sourceId) ||
        !recordingIds.has(candidate.recordingId) ||
        !isLocalFile(candidate)
      ) {
        return null;
      }
      localFileIds.add(candidate.fileId);
      return candidate;
    });
    if (file !== null) {
      localFiles.push(file);
    }
  }

  // Queue occurrences decode row-tolerant: malformed, duplicated, or
  // dangling-recording rows drop. Ordinals are order-only (the query
  // sorts by them), so a gap heals on the row's next write.
  const occurrenceIds = new Set<string>();
  const occurrences: QueueOccurrence[] = [];
  for (const row of occurrenceRows) {
    const occurrence = keep(
      'queue_occurrences',
      keyOf(row['occurrence_id']),
      (t) => {
        t.reqNonNegInt(row['ordinal']);
        const provider = row['selected_provider'];
        const kind = row['selected_kind'];
        const sourceId = row['selected_source_id'];
        // Exactly all-null or a complete (provider,'track',source_id).
        let selectedRef: SourceRef | null = null;
        if (provider !== null || kind !== null || sourceId !== null) {
          const providerStr = typeof provider === 'string' ? provider : '';
          const sourceStr = typeof sourceId === 'string' ? sourceId : '';
          if (
            providerStr.length === 0 ||
            kind !== 'track' ||
            sourceStr.length === 0
          ) {
            return null;
          }
          selectedRef = {
            provider: providerStr,
            kind: 'track',
            id: sourceStr,
          };
        }
        const candidate: QueueOccurrence = {
          occurrenceId: t.reqStr(row['occurrence_id']),
          recordingId: t.reqStr(row['recording_id']),
          selectedRef,
        };
        if (
          occurrenceIds.has(candidate.occurrenceId) ||
          !recordingIds.has(candidate.recordingId)
        ) {
          return null;
        }
        occurrenceIds.add(candidate.occurrenceId);
        return candidate;
      },
    );
    if (occurrence !== null) {
      occurrences.push(occurrence);
    }
  }

  // The queue_state/settings singletons stay strict on their required
  // fields — a corrupt revision/mode is engine-written damage, not a
  // droppable orphan.
  let bad = false;
  const tools = rowTools(() => {
    bad = true;
  });
  const { reqStr, optStr, reqInt, reqNonNegInt, optInt, reqBool, json } =
    tools;
  const mode = queueRow['mode'];
  // A malformed optional field drops to absent rather than bricking
  // the restore (storage:* writes can reach this row).
  let blockedBad = false;
  const blockedTools = rowTools(() => {
    blockedBad = true;
  });
  const blocked =
    queueRow['blocked_error_json'] === null
      ? undefined
      : (blockedTools.json(queueRow['blocked_error_json']) as AppError);
  if (blockedBad) {
    dropped.push({ table: 'queue_state', key: 'blocked_error_json' });
  }
  let queue: QueueSnapshot | null = {
    revision: reqNonNegInt(queueRow['revision']),
    occurrences,
    currentOccurrenceId: optStr(queueRow['current_occurrence_id']),
    positionMs: reqNonNegInt(queueRow['position_ms']),
    mode: mode as QueueSnapshot['mode'],
    ...(blockedBad || blocked === undefined
      ? {}
      : { blockedError: blocked }),
  };
  if (
    bad ||
    (mode !== 'stopped' && mode !== 'paused' && mode !== 'playing')
  ) {
    return null;
  }
  if (
    queue.currentOccurrenceId !== null &&
    !occurrenceIds.has(queue.currentOccurrenceId)
  ) {
    // The playhead names an occurrence the decode dropped (or one
    // never written) — park the queue back to stopped rather than
    // fail the restore on a dangling reference.
    dropped.push({ table: 'queue_state', key: queue.currentOccurrenceId });
    queue = {
      revision: queue.revision,
      occurrences,
      currentOccurrenceId: null,
      positionMs: 0,
      mode: 'stopped',
    };
  }
  const queueRevision = queue.revision;
  if (!isQueueSnapshot(queue)) {
    // The remaining doc-invalid shapes are renderer-writable too: a
    // playhead while parked, a position without a playhead, or a
    // blocked error on a stopped queue — schema-legal but not a
    // snapshot. Park the playhead; the occurrence rows stand.
    dropped.push({ table: 'queue_state', key: 'shape' });
    queue = {
      revision: queueRevision,
      occurrences,
      currentOccurrenceId: null,
      positionMs: 0,
      mode: 'stopped',
    };
  }
  if (!isQueueSnapshot(queue)) {
    return null;
  }
  const settings: Settings = {
    catalogProvider: reqStr(settingsRow['catalog_provider']),
    playbackProvider: reqStr(settingsRow['playback_provider']),
    storefront: optStr(settingsRow['storefront']),
    qualityKbps: reqInt(settingsRow['quality_kbps']),
    theme: settingsRow['theme'] as Settings['theme'],
    prefetch: reqBool(settingsRow['prefetch']),
    ...(settingsRow['lyrics_provider'] === null
      ? {}
      : { lyricsProvider: optStr(settingsRow['lyrics_provider']) }),
    ...(settingsRow['radio_provider'] === null
      ? {}
      : { radioProvider: optStr(settingsRow['radio_provider']) }),
    ...(settingsRow['artwork_cache_bytes'] === null
      ? {}
      : { artworkCacheBytes: reqInt(settingsRow['artwork_cache_bytes']) }),
    ...(reqBool(settingsRow['download_metered'])
      ? { downloadMetered: true }
      : {}),
    ...(settingsRow['language'] === null ||
      settingsRow['language'] === undefined
      ? {}
      : { language: optStr(settingsRow['language']) }),
  };
  if (bad) {
    return null;
  }
  return {
    state: {
      recordings,
      likes,
      entities,
      entitySourceRefs,
      playlists,
      playlistEntries,
      playHistory,
      playCounts,
      matchReviews,
      lyricsCache,
      artworkCache,
      downloads,
      localSources,
      localFiles,
      queue,
      settings,
    },
    dropped,
  };
}
