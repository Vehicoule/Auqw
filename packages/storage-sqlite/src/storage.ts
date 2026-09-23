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
  LyricsCacheEntry,
  MatchReview,
  OperationContext,
  PersistedState,
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
  StoragePort,
} from '@auqw/application';
import {
  appError,
  err,
  isAttemptTrace,
  isExportDocument,
  isPersistedState,
  isSettings,
  ok,
} from '@auqw/application';
import { CANCELLED } from './cancelled.ts';
import type {
  SqliteConnection,
  SqliteDriver,
  SqlRow,
  SqlValue,
} from './driver.ts';
import { enqueueDriverTransaction } from './transaction-queue.ts';
import {
  CURRENT_SCHEMA_VERSION,
  KNOWN_TABLES,
  MIGRATIONS,
} from './migrations.ts';

const ATTEMPT_CAP = 500;

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

function invalidBatch(): AppError {
  return appError('invalid-response', 'commit batch failed validation');
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
 * cache, and every commit rewrites the coherent core state inside one
 * transaction so an interrupted write can never leave partials.
 */
export class SqliteStorage implements StoragePort {
  readonly #driver: SqliteDriver;
  readonly #defaults: Settings;
  #init: Promise<Result<void>> | null = null;

  constructor(driver: SqliteDriver, defaultSettings: Settings) {
    if (!isSettings(defaultSettings)) {
      throw new TypeError('defaultSettings must be a valid Settings');
    }
    this.#driver = driver;
    this.#defaults = defaultSettings;
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
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name COLLATE NOCASE IN (${KNOWN_TABLES.map(() => '?').join(',')})
             LIMIT 1`,
            [...KNOWN_TABLES],
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
            `INSERT INTO settings (id, catalog_provider, playback_provider, storefront, quality_kbps, theme, prefetch, lyrics_provider, radio_provider, artwork_cache_bytes, download_metered)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        const current = await this.#readState(conn, signal);
        if (!current.ok) {
          return current;
        }
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
        // `recordingsMerge` applies to the rows just read inside THIS
        // transaction — a read-modify-write that cannot drop a
        // session write queued between a caller's own load and commit.
        const merged: PersistedState = {
          recordings:
            batch.recordingsMerge !== undefined
              ? batch.recordingsMerge(current.value.recordings)
              : (batch.recordings ?? current.value.recordings),
          likes: batch.likes ?? current.value.likes,
          entities: batch.entities ?? current.value.entities,
          entitySourceRefs:
            batch.entitySourceRefs ?? current.value.entitySourceRefs,
          playlists: batch.playlists ?? current.value.playlists,
          playlistEntries:
            batch.playlistEntries ?? current.value.playlistEntries,
          playHistory: batch.playHistory ?? current.value.playHistory,
          playCounts: batch.playCounts ?? current.value.playCounts,
          matchReviews: batch.matchReviews ?? current.value.matchReviews,
          lyricsCache: batch.lyricsCache ?? current.value.lyricsCache,
          artworkCache:
            batch.artworkCache ?? current.value.artworkCache,
          downloads: batch.downloads ?? current.value.downloads,
          localSources:
            batch.localSources ?? current.value.localSources,
          localFiles: batch.localFiles ?? current.value.localFiles,
          queue: batch.queue ?? current.value.queue,
          settings: batch.settings ?? current.value.settings,
        };
        const attempts = batch.attempts ?? [];
        // Validate the entire resulting document before any mutation.
        if (!isPersistedState(merged)) {
          return err(invalidBatch());
        }
        if (!attempts.every(isAttemptTrace)) {
          return err(invalidBatch());
        }
        this.#check(signal);
        // Each section rewrites its own tables; sections whose rows
        // foreign-key into a rewritten parent ride along (SQLite FKs
        // are immediate, so dependents must be deleted first and
        // reinserted from the merged document).
        const recordingsTouched =
          batch.recordings !== undefined ||
          batch.recordingsMerge !== undefined;
        const rewrite = {
          queueState: batch.queue !== undefined,
          queueOccurrences:
            batch.queue !== undefined || recordingsTouched,
          playlistEntries:
            batch.playlistEntries !== undefined ||
            batch.playlists !== undefined ||
            recordingsTouched,
          playlists: batch.playlists !== undefined,
          playHistory:
            batch.playHistory !== undefined ||
            recordingsTouched,
          playCounts:
            batch.playCounts !== undefined ||
            recordingsTouched,
          matchReviews:
            batch.matchReviews !== undefined ||
            recordingsTouched,
          lyricsCache:
            batch.lyricsCache !== undefined ||
            recordingsTouched,
          entitySourceRefs:
            batch.entitySourceRefs !== undefined ||
            batch.entities !== undefined,
          entities: batch.entities !== undefined,
          likes: batch.likes !== undefined,
          recordings: recordingsTouched,
          artworkCache: batch.artworkCache !== undefined,
          downloads:
            batch.downloads !== undefined ||
            recordingsTouched,
          localFiles:
            batch.localFiles !== undefined ||
            batch.localSources !== undefined ||
            recordingsTouched,
          localSources: batch.localSources !== undefined,
          settings: batch.settings !== undefined,
        };
        const deletes: readonly (readonly [boolean, string])[] = [
          [rewrite.queueOccurrences, 'DELETE FROM queue_occurrences'],
          [rewrite.playlistEntries, 'DELETE FROM playlist_entries'],
          [rewrite.playHistory, 'DELETE FROM play_history'],
          [rewrite.playCounts, 'DELETE FROM play_counts'],
          [rewrite.matchReviews, 'DELETE FROM match_reviews'],
          [rewrite.lyricsCache, 'DELETE FROM lyrics_cache'],
          [rewrite.downloads, 'DELETE FROM downloads'],
          [rewrite.localFiles, 'DELETE FROM local_files'],
          [rewrite.localSources, 'DELETE FROM local_sources'],
          [rewrite.likes, 'DELETE FROM likes'],
          [rewrite.entitySourceRefs, 'DELETE FROM entity_source_refs'],
          [rewrite.entities, 'DELETE FROM entities'],
          [rewrite.playlists, 'DELETE FROM playlists'],
          [rewrite.recordings, 'DELETE FROM mappings'],
          [rewrite.recordings, 'DELETE FROM source_refs'],
          [rewrite.recordings, 'DELETE FROM recordings'],
          [rewrite.queueState, 'DELETE FROM queue_state'],
          [rewrite.settings, 'DELETE FROM settings'],
          [rewrite.artworkCache, 'DELETE FROM artwork_cache'],
        ];
        for (const [enabled, statement] of deletes) {
          if (enabled) {
            await conn.execute(statement, undefined, signal);
          }
        }
        this.#check(signal);
        if (rewrite.recordings) {
          for (const recording of merged.recordings) {
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
                recording.provenance,
              ],
              signal,
            );
            for (const [ordinal, ref] of recording.sourceRefs.entries()) {
              await conn.execute(
                `INSERT INTO source_refs (recording_id, ordinal, provider, kind, source_id)
                 VALUES (?, ?, ?, 'track', ?)`,
                [recording.id, ordinal, ref.provider, ref.id],
                signal,
              );
            }
            for (const [ordinal, mapping] of recording.mappings.entries()) {
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
        }
        if (rewrite.entities) {
          for (const entity of merged.entities) {
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
        }
        if (rewrite.entitySourceRefs) {
          for (const ref of merged.entitySourceRefs) {
            await conn.execute(
              `INSERT INTO entity_source_refs (entity_id, provider, ref_json)
               VALUES (?, ?, ?)`,
              [ref.entityId, ref.provider, JSON.stringify(ref.ref)],
              signal,
            );
          }
        }
        if (rewrite.playlists) {
          for (const playlist of merged.playlists) {
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
        }
        if (rewrite.playlistEntries) {
          for (const entry of merged.playlistEntries) {
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
        }
        if (rewrite.likes) {
          for (const like of merged.likes) {
            await conn.execute(
              `INSERT INTO likes (entity_kind, target_id, liked_ms)
               VALUES (?, ?, ?)`,
              [like.entityKind, like.targetId, like.likedAtMs],
              signal,
            );
          }
        }
        if (rewrite.playHistory) {
          for (const event of merged.playHistory) {
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
        }
        if (rewrite.playCounts) {
          for (const count of merged.playCounts) {
            await conn.execute(
              `INSERT INTO play_counts (recording_id, count, last_ms)
               VALUES (?, ?, ?)`,
              [count.recordingId, count.count, count.lastMs],
              signal,
            );
          }
        }
        if (rewrite.matchReviews) {
          for (const review of merged.matchReviews) {
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
        }
        if (rewrite.lyricsCache) {
          for (const entry of merged.lyricsCache) {
            await conn.execute(
              `INSERT INTO lyrics_cache (recording_id, provider, kind, payload_json, fetched_ms)
               VALUES (?, ?, ?, ?, ?)`,
              [
                entry.recordingId,
                entry.provider,
                entry.kind,
                JSON.stringify(entry.payload),
                entry.fetchedMs,
              ],
              signal,
            );
          }
        }
        if (rewrite.artworkCache) {
          for (const entry of merged.artworkCache) {
            await conn.execute(
              `INSERT INTO artwork_cache (url, file_path, bytes, last_accessed_ms)
               VALUES (?, ?, ?, ?)`,
              [
                entry.url,
                entry.filePath,
                entry.bytes,
                entry.lastAccessedMs,
              ],
              signal,
            );
          }
        }
        if (rewrite.downloads) {
          for (const download of merged.downloads) {
            await conn.execute(
              `INSERT INTO downloads (download_id, recording_id, provider, source_ref_json, file_path, bytes, state, committed_offset, checksum, mime, itag, expires_at_ms, error_json, priority, requested_ms, downloaded_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
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
                download.error === null
                  ? null
                  : JSON.stringify(download.error),
                download.priority,
                download.requestedMs,
                download.downloadedMs,
              ],
              signal,
            );
          }
        }
        if (rewrite.localSources) {
          for (const source of merged.localSources) {
            await conn.execute(
              `INSERT INTO local_sources (source_id, tree_uri, label, added_ms, last_scan_ms)
               VALUES (?, ?, ?, ?, ?)`,
              [
                source.sourceId,
                source.treeUri,
                source.label,
                source.addedMs,
                source.lastScanMs,
              ],
              signal,
            );
          }
        }
        if (rewrite.localFiles) {
          for (const file of merged.localFiles) {
            await conn.execute(
              `INSERT INTO local_files (file_id, source_id, doc_id, size, fingerprint, modified_ms, title, artist, album, duration_ms, genre, recording_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
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
              ],
              signal,
            );
          }
        }
        this.#check(signal);
        if (rewrite.queueState) {
          await conn.execute(
            `INSERT INTO queue_state (id, revision, current_occurrence_id, position_ms, mode, blocked_error_json)
             VALUES (1, ?, ?, ?, ?, ?)`,
            [
              merged.queue.revision,
              merged.queue.currentOccurrenceId,
              merged.queue.positionMs,
              merged.queue.mode,
              merged.queue.blockedError === undefined
                ? null
                : JSON.stringify(merged.queue.blockedError),
            ],
            signal,
          );
        }
        if (rewrite.queueOccurrences) {
          for (const [ordinal, occurrence] of merged.queue.occurrences
            .entries()) {
            await conn.execute(
              `INSERT INTO queue_occurrences (occurrence_id, ordinal, recording_id, selected_provider, selected_kind, selected_source_id)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [
                occurrence.occurrenceId,
                ordinal,
                occurrence.recordingId,
                occurrence.selectedRef?.provider ?? null,
                occurrence.selectedRef === null ? null : 'track',
                occurrence.selectedRef?.id ?? null,
              ],
              signal,
            );
          }
        }
        if (rewrite.settings) {
          await conn.execute(
            `INSERT INTO settings (id, catalog_provider, playback_provider, storefront, quality_kbps, theme, prefetch, lyrics_provider, radio_provider, artwork_cache_bytes, download_metered)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              merged.settings.catalogProvider,
              merged.settings.playbackProvider,
              merged.settings.storefront,
              merged.settings.qualityKbps,
              merged.settings.theme,
              merged.settings.prefetch ? 1 : 0,
              merged.settings.lyricsProvider ?? null,
              merged.settings.radioProvider ?? null,
              merged.settings.artworkCacheBytes ?? null,
              merged.settings.downloadMetered === true ? 1 : 0,
            ],
            signal,
          );
        }
        this.#check(signal);
        for (const trace of attempts) {
          await conn.execute(
            'INSERT INTO attempt_traces (request_id, trace_json) VALUES (?, ?)',
            [trace.requestId, JSON.stringify(trace)],
            signal,
          );
        }
        await conn.execute(
          `DELETE FROM attempt_traces WHERE seq NOT IN (SELECT seq FROM attempt_traces ORDER BY seq DESC LIMIT ${ATTEMPT_CAP})`,
          undefined,
          signal,
        );
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
        // The session survives the import as an empty stopped queue —
        // its old rows named the recordings just replaced.
        await conn.execute(
          `UPDATE queue_state
           SET revision = revision + 1, current_occurrence_id = NULL,
               position_ms = 0, mode = 'stopped', blocked_error_json = NULL
           WHERE id = 1`,
          undefined,
          signal,
        );
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
          `INSERT INTO settings (id, catalog_provider, playback_provider, storefront, quality_kbps, theme, prefetch, lyrics_provider, radio_provider, artwork_cache_bytes, download_metered)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    if (built === null || !isPersistedState(built)) {
      return err(invalidData());
    }
    return ok(built);
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

function decodeState(rows: TableRows): PersistedState | null {
  const recordingRows = rows.recordings;
  const refRows = rows.sourceRefs;
  const mappingRows = rows.mappings;
  const likeRows = rows.likes;
  const queueRows = rows.queueState;
  const occurrenceRows = rows.queueOccurrences;
  const settingsRows = rows.settings;
  if (queueRows.length !== 1 || settingsRows.length !== 1) {
    return null;
  }
  const queueRow = queueRows[0];
  const settingsRow = settingsRows[0];
  if (queueRow === undefined || settingsRow === undefined) {
    return null;
  }
  let bad = false;
  const fail = (): void => {
    bad = true;
  };
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

  // Recording ids first so every dependent row can be verified against
  // them; duplicate recording rows are rejected even without the PK.
  const recordingIds = new Set<string>();
  for (const row of recordingRows) {
    const id = reqStr(row['id']);
    if (recordingIds.has(id)) {
      fail();
    }
    recordingIds.add(id);
  }

  // source_refs: ordered by (recording_id, ordinal); ordinals must be
  // contiguous from 0 per recording, ids must name a real recording,
  // and (provider, kind, source_id) must be unique per recording.
  const refsByRecording = new Map<string, SourceRef[]>();
  const refOrdinals = new Map<string, number>();
  const seenRefs = new Map<string, Set<string>>();
  for (const row of refRows) {
    const recordingId = reqStr(row['recording_id']);
    if (!recordingIds.has(recordingId)) {
      fail();
    }
    if (row['kind'] !== 'track') {
      fail();
    }
    const ordinal = reqNonNegInt(row['ordinal']);
    const expected = refOrdinals.get(recordingId) ?? 0;
    if (ordinal !== expected) {
      fail();
    }
    refOrdinals.set(recordingId, expected + 1);
    const provider = reqNonEmpty(row['provider']);
    const sourceId = reqNonEmpty(row['source_id']);
    const ref: SourceRef = { provider, kind: 'track', id: sourceId };
    const seen = seenRefs.get(recordingId) ?? new Set<string>();
    const key = `${provider} track ${sourceId}`;
    if (seen.has(key)) {
      fail();
    }
    seen.add(key);
    seenRefs.set(recordingId, seen);
    const list = refsByRecording.get(recordingId) ?? [];
    list.push(ref);
    refsByRecording.set(recordingId, list);
  }
  const mappingsByRecording = new Map<string, SourceMapping[]>();
  const mappingOrdinals = new Map<string, number>();
  for (const row of mappingRows) {
    const recordingId = reqStr(row['recording_id']);
    if (!recordingIds.has(recordingId)) {
      fail();
    }
    if (row['kind'] !== 'track') {
      fail();
    }
    const ordinal = reqNonNegInt(row['ordinal']);
    const expected = mappingOrdinals.get(recordingId) ?? 0;
    if (ordinal !== expected) {
      fail();
    }
    mappingOrdinals.set(recordingId, expected + 1);
    const mapping: SourceMapping = {
      ref: {
        provider: reqNonEmpty(row['provider']),
        kind: 'track',
        id: reqNonEmpty(row['source_id']),
      },
      status: row['status'] as SourceMapping['status'],
      matchedAtMs: reqNonNegInt(row['matched_at_ms']),
      evidence: json(row['evidence_json']) as SourceMapping['evidence'],
    };
    const list = mappingsByRecording.get(recordingId) ?? [];
    list.push(mapping);
    mappingsByRecording.set(recordingId, list);
  }
  const recordings: Recording[] = recordingRows.map((row) => {
    const id = reqStr(row['id']);
    return {
      id,
      title: reqStr(row['title']),
      artist: optStr(row['artist']),
      album: optStr(row['album']),
      durationMs: optInt(row['duration_ms']),
      releaseYear: optInt(row['release_year']),
      artwork: json(row['artwork_json']) as Recording['artwork'],
      explicit: optBool(row['explicit']),
      genre: optStr(row['genre']),
      isrc: optStr(row['isrc']),
      versionLabels: json(
        row['version_labels_json'],
      ) as Recording['versionLabels'],
      sourceRefs: refsByRecording.get(id) ?? [],
      mappings: mappingsByRecording.get(id) ?? [],
      provenance: row['provenance'] as Recording['provenance'],
    };
  });
  // likes: polymorphic target_id — 'track' names a recording,
  // 'album'/'artist' name an entity (checked after entity decode).
  const likeKeys = new Set<string>();
  const likes: Like[] = likeRows.map((row) => {
    const kind = row['entity_kind'];
    if (kind !== 'track' && kind !== 'album' && kind !== 'artist') {
      fail();
    }
    const targetId = reqStr(row['target_id']);
    const key = `${kind as string} ${targetId}`;
    if (likeKeys.has(key)) {
      fail();
    }
    likeKeys.add(key);
    return {
      entityKind: kind as Like['entityKind'],
      targetId,
      likedAtMs: reqNonNegInt(row['liked_ms']),
    };
  });
  // Entities: ids and kinds first so entity_source_refs and
  // entity-kind likes can be verified; duplicate entity rows rejected
  // without the PK.
  const entityIds = new Set<string>();
  const entityKinds = new Map<string, Entity['kind']>();
  for (const row of rows.entities) {
    const id = reqStr(row['entity_id']);
    if (entityIds.has(id)) {
      fail();
    }
    entityIds.add(id);
    const kind = row['kind'];
    if (kind !== 'album' && kind !== 'artist') {
      fail();
    } else {
      entityKinds.set(id, kind);
    }
  }
  const entities: Entity[] = rows.entities.map((row) => {
    const kind = row['kind'];
    if (kind !== 'album' && kind !== 'artist') {
      fail();
    }
    return {
      entityId: reqStr(row['entity_id']),
      kind: kind as Entity['kind'],
      title: reqStr(row['title']),
      artistName: optStr(row['artist_name']),
      artwork:
        row['artwork_json'] === null
          ? []
          : (json(row['artwork_json']) as Entity['artwork']),
      createdMs: reqNonNegInt(row['created_ms']),
    };
  });
  for (const like of likes) {
    // 'track' likes name recordings; entity likes must name an entity
    // of the same kind.
    const resolves =
      like.entityKind === 'track'
        ? recordingIds.has(like.targetId)
        : entityKinds.get(like.targetId) === like.entityKind;
    if (!resolves) {
      fail();
    }
  }
  const entityRefKeys = new Set<string>();
  const entitySourceRefs: EntitySourceRef[] = rows.entitySourceRefs.map(
    (row) => {
      const entityId = reqStr(row['entity_id']);
      if (!entityIds.has(entityId)) {
        fail();
      }
      const provider = reqNonEmpty(row['provider']);
      const key = `${entityId} ${provider}`;
      if (entityRefKeys.has(key)) {
        fail();
      }
      entityRefKeys.add(key);
      const ref = json(row['ref_json']);
      // The ref's kind must agree with the target entity's kind.
      if (
        typeof ref !== 'object' ||
        ref === null ||
        (ref as EntityRef).kind !== entityKinds.get(entityId)
      ) {
        fail();
      }
      return {
        entityId,
        provider,
        ref: ref as EntityRef,
      };
    },
  );
  const playlistIds = new Set<string>();
  for (const row of rows.playlists) {
    const id = reqStr(row['playlist_id']);
    if (playlistIds.has(id)) {
      fail();
    }
    playlistIds.add(id);
  }
  const playlists: Playlist[] = rows.playlists.map((row) => ({
    playlistId: reqStr(row['playlist_id']),
    name: reqStr(row['name']),
    createdMs: reqNonNegInt(row['created_ms']),
    updatedMs: reqNonNegInt(row['updated_ms']),
  }));
  const entryIds = new Set<string>();
  const entryPositions = new Map<string, Set<number>>();
  const playlistEntries: PlaylistEntry[] = rows.playlistEntries.map(
    (row) => {
      const playlistId = reqStr(row['playlist_id']);
      if (!playlistIds.has(playlistId)) {
        fail();
      }
      const recordingId = reqStr(row['recording_id']);
      if (!recordingIds.has(recordingId)) {
        fail();
      }
      const entryId = reqStr(row['entry_id']);
      if (entryIds.has(entryId)) {
        fail();
      }
      entryIds.add(entryId);
      const position = row['position'];
      if (typeof position !== 'number' || !Number.isFinite(position)) {
        fail();
      }
      const seen = entryPositions.get(playlistId) ?? new Set<number>();
      if (seen.has(position as number)) {
        fail();
      }
      seen.add(position as number);
      entryPositions.set(playlistId, seen);
      const selectedRef =
        row['selected_ref_json'] === null
          ? null
          : (json(row['selected_ref_json']) as SourceRef);
      return {
        entryId,
        playlistId,
        recordingId,
        position: position as number,
        selectedRef,
        addedMs: reqNonNegInt(row['added_ms']),
      };
    },
  );
  const eventIds = new Set<string>();
  const playHistory: PlayEvent[] = rows.playHistory.map((row) => {
    const eventId = reqStr(row['event_id']);
    if (eventIds.has(eventId)) {
      fail();
    }
    eventIds.add(eventId);
    const recordingId = reqStr(row['recording_id']);
    if (!recordingIds.has(recordingId)) {
      fail();
    }
    return {
      eventId,
      recordingId,
      occurrenceId: optStr(row['occurrence_id']),
      playedMs: reqNonNegInt(row['played_ms']),
      listenedMs: reqNonNegInt(row['listened_ms']),
    };
  });
  const countedIds = new Set<string>();
  const playCounts: PlayCount[] = rows.playCounts.map((row) => {
    const recordingId = reqStr(row['recording_id']);
    if (!recordingIds.has(recordingId) || countedIds.has(recordingId)) {
      fail();
    }
    countedIds.add(recordingId);
    return {
      recordingId,
      count: reqNonNegInt(row['count']),
      lastMs: reqNonNegInt(row['last_ms']),
    };
  });
  const reviewIds = new Set<string>();
  const matchReviews: MatchReview[] = rows.matchReviews.map((row) => {
    const reviewId = reqStr(row['review_id']);
    if (reviewIds.has(reviewId)) {
      fail();
    }
    reviewIds.add(reviewId);
    const recordingId = reqStr(row['recording_id']);
    if (!recordingIds.has(recordingId)) {
      fail();
    }
    const status = row['status'];
    if (
      status !== 'pending' &&
      status !== 'confirmed' &&
      status !== 'rejected' &&
      status !== 'dismissed'
    ) {
      fail();
    }
    const resolvedMs = optInt(row['resolved_ms']);
    if (resolvedMs !== null && resolvedMs < 0) {
      fail();
    }
    return {
      reviewId,
      recordingId,
      candidates: json(row['candidates_json']) as MatchReview['candidates'],
      status: status as MatchReview['status'],
      resolution:
        row['resolution_json'] === null
          ? null
          : (json(row['resolution_json']) as MatchReview['resolution']),
      createdMs: reqNonNegInt(row['created_ms']),
      resolvedMs,
    };
  });
  const lyricIds = new Set<string>();
  const lyricsCache: LyricsCacheEntry[] = rows.lyricsCache.map((row) => {
    const recordingId = reqStr(row['recording_id']);
    if (!recordingIds.has(recordingId) || lyricIds.has(recordingId)) {
      fail();
    }
    lyricIds.add(recordingId);
    const kind = row['kind'];
    if (kind !== 'plain' && kind !== 'synced') {
      fail();
    }
    return {
      recordingId,
      provider: reqNonEmpty(row['provider']),
      kind: kind as LyricsCacheEntry['kind'],
      payload: json(row['payload_json']) as LyricsCacheEntry['payload'],
      fetchedMs: reqNonNegInt(row['fetched_ms']),
    };
  });
  const artworkUrls = new Set<string>();
  const artworkCache: ArtworkCacheEntry[] = rows.artworkCache.map((row) => {
    const url = reqStr(row['url']);
    if (artworkUrls.has(url)) {
      fail();
    }
    artworkUrls.add(url);
    return {
      url,
      filePath: reqStr(row['file_path']),
      bytes: reqNonNegInt(row['bytes']),
      lastAccessedMs: reqNonNegInt(row['last_accessed_ms']),
    };
  });
  const downloadIds = new Set<string>();
  const downloadedRecordingIds = new Set<string>();
  const downloads: DownloadRecord[] = rows.downloads.map((row) => {
    const downloadId = reqStr(row['download_id']);
    if (downloadIds.has(downloadId)) {
      fail();
    }
    downloadIds.add(downloadId);
    const recordingId = reqStr(row['recording_id']);
    if (!recordingIds.has(recordingId) ||
        downloadedRecordingIds.has(recordingId)) {
      fail();
    }
    downloadedRecordingIds.add(recordingId);
    const state = row['state'];
    return {
      downloadId,
      recordingId,
      provider: reqNonEmpty(row['provider']),
      sourceRef: json(row['source_ref_json']) as SourceRef,
      filePath: reqStr(row['file_path']),
      bytes: reqNonNegInt(row['bytes']),
      state: state as DownloadState,
      committedOffset: reqNonNegInt(row['committed_offset']),
      checksum: optStr(row['checksum']),
      mime: optStr(row['mime']),
      itag: optInt(row['itag']),
      expiresAtMs: optInt(row['expires_at_ms']),
      error:
        row['error_json'] === null
          ? null
          : (json(row['error_json']) as DownloadRecord['error']),
      priority: reqNonNegInt(row['priority']),
      requestedMs: reqNonNegInt(row['requested_ms']),
      downloadedMs: optInt(row['downloaded_ms']),
    };
  });
  const localSourceIds = new Set<string>();
  const localSources: LocalSource[] = rows.localSources.map((row) => {
    const sourceId = reqStr(row['source_id']);
    if (localSourceIds.has(sourceId)) {
      fail();
    }
    localSourceIds.add(sourceId);
    return {
      sourceId,
      treeUri: reqStr(row['tree_uri']),
      label: reqStr(row['label']),
      addedMs: reqNonNegInt(row['added_ms']),
      lastScanMs: optInt(row['last_scan_ms']),
    };
  });
  const localFileIds = new Set<string>();
  const localFiles: LocalFile[] = rows.localFiles.map((row) => {
    const fileId = reqStr(row['file_id']);
    if (localFileIds.has(fileId)) {
      fail();
    }
    localFileIds.add(fileId);
    const sourceId = reqStr(row['source_id']);
    if (!localSourceIds.has(sourceId)) {
      fail();
    }
    const recordingId = reqStr(row['recording_id']);
    if (!recordingIds.has(recordingId)) {
      fail();
    }
    return {
      fileId,
      sourceId,
      docId: reqStr(row['doc_id']),
      size: reqNonNegInt(row['size']),
      fingerprint: reqStr(row['fingerprint']),
      modifiedMs: optInt(row['modified_ms']),
      title: optStr(row['title']),
      artist: optStr(row['artist']),
      album: optStr(row['album']),
      durationMs: optInt(row['duration_ms']),
      genre: optStr(row['genre']),
      recordingId,
    };
  });
  const blocked =
    queueRow['blocked_error_json'] === null
      ? undefined
      : (json(queueRow['blocked_error_json']) as AppError);
  const mode = queueRow['mode'];
  if (mode !== 'stopped' && mode !== 'paused' && mode !== 'playing') {
    fail();
  }
  const occurrenceIds = new Set<string>();
  const queue: QueueSnapshot = {
    revision: reqNonNegInt(queueRow['revision']),
    occurrences: occurrenceRows.map((row, index) => {
      // Ordinals are globally contiguous from 0 in query order.
      if (reqNonNegInt(row['ordinal']) !== index) {
        fail();
      }
      const occurrenceId = reqStr(row['occurrence_id']);
      if (occurrenceIds.has(occurrenceId)) {
        fail();
      }
      occurrenceIds.add(occurrenceId);
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
          fail();
        }
        selectedRef = {
          provider: providerStr,
          kind: 'track',
          id: sourceStr,
        };
      }
      return {
        occurrenceId,
        recordingId: reqStr(row['recording_id']),
        selectedRef,
      };
    }),
    currentOccurrenceId: optStr(queueRow['current_occurrence_id']),
    positionMs: reqNonNegInt(queueRow['position_ms']),
    mode: mode as QueueSnapshot['mode'],
    ...(blocked === undefined ? {} : { blockedError: blocked }),
  };
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
  };
  if (bad) {
    return null;
  }
  return {
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
  };
}
