import type {
  AppError,
  AttemptTrace,
  CancellationSignal,
  OperationContext,
  PersistedState,
  QueueSnapshot,
  Recording,
  Result,
  Settings,
  SourceMapping,
  SourceRef,
  StorageBatch,
  StoragePort,
  TrackLike,
} from '@auqw/application';
import {
  appError,
  err,
  isAttemptTrace,
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
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './migrations.ts';

const ATTEMPT_CAP = 500;

function transientError(): AppError {
  return appError('transient', 'storage operation failed');
}

function invalidData(): AppError {
  return appError('invalid-response', 'stored data failed validation');
}

function invalidBatch(): AppError {
  return appError('invalid-response', 'commit batch failed validation');
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
    const work = this.#runInitialize(context);
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
      return await this.#driver.transaction(async (conn) => {
        this.#check(signal);
        await conn.execute(
          'PRAGMA foreign_keys = ON',
          undefined,
          signal,
        );
        let version = 0;
        const found = await conn.query<SqlRow>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`,
          undefined,
          signal,
        );
        if (found.length > 0) {
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
          version = raw;
        }
        if (version === CURRENT_SCHEMA_VERSION) {
          return ok(undefined);
        }
        const statements = MIGRATIONS[version] ?? [];
        for (const statement of statements) {
          this.#check(signal);
          await conn.execute(statement, undefined, signal);
        }
        this.#check(signal);
        await conn.execute(
          `INSERT INTO settings (id, catalog_provider, playback_provider, storefront, quality_kbps, theme, prefetch)
           VALUES (1, ?, ?, ?, ?, ?, ?)`,
          [
            this.#defaults.catalogProvider,
            this.#defaults.playbackProvider,
            this.#defaults.storefront,
            this.#defaults.qualityKbps,
            this.#defaults.theme,
            this.#defaults.prefetch ? 1 : 0,
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
        return ok(undefined);
      }, signal);
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
      return await this.#driver.transaction(async (conn) => {
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
      return await this.#driver.transaction(async (conn) => {
        this.#check(signal);
        const current = await this.#readState(conn, signal);
        if (!current.ok) {
          return current;
        }
        const merged: PersistedState = {
          recordings: batch.recordings ?? current.value.recordings,
          likes: batch.likes ?? current.value.likes,
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
        const coreChanged =
          batch.recordings !== undefined ||
          batch.likes !== undefined ||
          batch.queue !== undefined;
        if (coreChanged) {
          for (const statement of [
            'DELETE FROM queue_occurrences',
            'DELETE FROM queue_state',
            'DELETE FROM likes',
            'DELETE FROM mappings',
            'DELETE FROM source_refs',
            'DELETE FROM recordings',
          ]) {
            await conn.execute(statement, undefined, signal);
          }
          this.#check(signal);
          for (const recording of merged.recordings) {
            await conn.execute(
              `INSERT INTO recordings (id, title, artist, album, duration_ms, release_year, artwork_json, explicit, genre, isrc, version_labels_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          this.#check(signal);
          for (const like of merged.likes) {
            await conn.execute(
              `INSERT INTO likes (entity_kind, entity_id, liked_at_ms)
               VALUES ('track', ?, ?)`,
              [like.recordingId, like.likedAtMs],
              signal,
            );
          }
          this.#check(signal);
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
        this.#check(signal);
        if (batch.settings !== undefined) {
          await conn.execute('DELETE FROM settings', undefined, signal);
          await conn.execute(
            `INSERT INTO settings (id, catalog_provider, playback_provider, storefront, quality_kbps, theme, prefetch)
             VALUES (1, ?, ?, ?, ?, ?, ?)`,
            [
              merged.settings.catalogProvider,
              merged.settings.playbackProvider,
              merged.settings.storefront,
              merged.settings.qualityKbps,
              merged.settings.theme,
              merged.settings.prefetch ? 1 : 0,
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
      return await this.#driver.transaction(async (conn) => {
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

  /** Reconstructs the persisted document; null marks malformed rows. */
  async #readState(
    conn: SqliteConnection,
    signal: CancellationSignal,
  ): Promise<Result<PersistedState>> {
    this.#check(signal);
    const recordingRows = await conn.query<SqlRow>(
      'SELECT * FROM recordings ORDER BY rowid',
      undefined,
      signal,
    );
    const refRows = await conn.query<SqlRow>(
      'SELECT * FROM source_refs ORDER BY recording_id, ordinal',
      undefined,
      signal,
    );
    const mappingRows = await conn.query<SqlRow>(
      'SELECT * FROM mappings ORDER BY recording_id, ordinal',
      undefined,
      signal,
    );
    const likeRows = await conn.query<SqlRow>(
      'SELECT * FROM likes ORDER BY rowid',
      undefined,
      signal,
    );
    const queueRows = await conn.query<SqlRow>(
      'SELECT * FROM queue_state WHERE id = 1',
      undefined,
      signal,
    );
    const occurrenceRows = await conn.query<SqlRow>(
      'SELECT * FROM queue_occurrences ORDER BY ordinal',
      undefined,
      signal,
    );
    const settingsRows = await conn.query<SqlRow>(
      'SELECT * FROM settings WHERE id = 1',
      undefined,
      signal,
    );
    this.#check(signal);
    const built = decodeState(
      recordingRows,
      refRows,
      mappingRows,
      likeRows,
      queueRows,
      occurrenceRows,
      settingsRows,
    );
    if (built === null || !isPersistedState(built)) {
      return err(invalidData());
    }
    return ok(built);
  }
}

function decodeState(
  recordingRows: readonly SqlRow[],
  refRows: readonly SqlRow[],
  mappingRows: readonly SqlRow[],
  likeRows: readonly SqlRow[],
  queueRows: readonly SqlRow[],
  occurrenceRows: readonly SqlRow[],
  settingsRows: readonly SqlRow[],
): PersistedState | null {
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
    };
  });
  const likes: TrackLike[] = likeRows.map((row) => {
    if (row['entity_kind'] !== 'track') {
      fail();
    }
    return {
      recordingId: reqStr(row['entity_id']),
      likedAtMs: reqNonNegInt(row['liked_at_ms']),
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
  };
  if (bad) {
    return null;
  }
  return { recordings, likes, queue, settings };
}
