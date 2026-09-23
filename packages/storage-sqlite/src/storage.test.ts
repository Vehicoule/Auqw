import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource } from '@auqw/application';
import type {
  ArtworkCacheEntry,
  AttemptTrace,
  DownloadRecord,
  Entity,
  EntitySourceRef,
  ExportDocument,
  Like,
  LocalFile,
  LocalSource,
  LyricsCacheEntry,
  MatchEvidence,
  MatchReview,
  OperationContext,
  PersistedState,
  PlayCount,
  PlayEvent,
  Playlist,
  PlaylistEntry,
  QueueOccurrence,
  QueueSnapshot,
  Recording,
  Settings,
  SourceMapping,
  SourceRef,
} from '@auqw/application';
import { assert, assertDeepEqual, assertEqual } from '@auqw/application/testing';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './migrations.ts';
import { SqliteStorage } from './storage.ts';
import { FailingDriver, NodeSqliteDriver } from './testing/node-sqlite-driver.ts';

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: 'US',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
};

const EVIDENCE: MatchEvidence = {
  titleSimilarity: 1,
  artistSimilarity: 1,
  durationDeltaMs: 0,
  exactIsrc: false,
  score: 100,
  versionLabels: [],
};

function ref(provider: string, id: string): SourceRef {
  return { provider, kind: 'track', id };
}

function evidence(score: number): MatchEvidence {
  return { ...EVIDENCE, score };
}

function recording(
  id: string,
  refs: readonly SourceRef[],
  mappings: readonly SourceMapping[] = [],
  overrides: Partial<Recording> = {},
): Recording {
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
    mappings,
    provenance: 'provider',
    ...overrides,
  };
}

function occurrence(
  id: string,
  recordingId: string,
  selectedRef: SourceRef | null = null,
): QueueOccurrence {
  return { occurrenceId: id, recordingId, selectedRef };
}

function trace(id: string): AttemptTrace {
  return {
    requestId: id,
    steps: 3,
    httpCalls: 1,
    bytes: 64,
    fuelUsed: 10,
    elapsedMs: 20,
    httpTrace: [
      {
        method: 'GET',
        url: 'https://redacted.example/path',
        status: 200,
        bytes: 64,
        elapsedMs: 5,
      },
    ],
    guestLog: [{ level: 'info', message: 'finished' }],
  };
}

let contextSeq = 0;

function ctx(source = new CancellationSource()): {
  context: OperationContext;
  source: CancellationSource;
} {
  contextSeq += 1;
  return {
    context: {
      requestId: `t-${contextSeq}`,
      deadlineMs: Number.MAX_SAFE_INTEGER,
      signal: source.signal,
    },
    source,
  };
}

function rig(): {
  driver: NodeSqliteDriver;
  failing: FailingDriver;
  storage: SqliteStorage;
} {
  const driver = new NodeSqliteDriver();
  const failing = new FailingDriver(driver);
  return { driver, failing, storage: new SqliteStorage(failing, SETTINGS) };
}

async function loadOk(storage: SqliteStorage): Promise<PersistedState> {
  const loaded = await storage.load(ctx().context);
  if (!loaded.ok) {
    throw new Error(`load failed: ${loaded.error.kind}`);
  }
  return loaded.value;
}

const EMPTY_QUEUE: QueueSnapshot = {
  revision: 0,
  occurrences: [],
  currentOccurrenceId: null,
  positionMs: 0,
  mode: 'stopped',
};

// 1. Fresh initialize: version 1 + defaults; concurrent calls coalesce.
async function initializeAndCoalesce(): Promise<void> {
  const { driver, failing, storage } = rig();
  const [a, b] = await Promise.all([
    storage.initialize(ctx().context),
    storage.initialize(ctx().context),
  ]);
  assert(a.ok && b.ok, 'initialize resolves');
  assertEqual(
    failing.transactions,
    2,
    'version probe + one migration transaction',
  );
  const versions = await failing.transaction(async (conn) =>
    conn.query('SELECT version FROM schema_version'),
  );
  assertEqual(versions.length, 1);
  assertEqual(versions[0]?.['version'], CURRENT_SCHEMA_VERSION);
  const state = await loadOk(storage);
  assertDeepEqual(state.recordings, []);
  assertDeepEqual(state.likes, []);
  assertDeepEqual(state.queue, EMPTY_QUEUE);
  assertDeepEqual(state.settings, SETTINGS);
  driver.close();
}

// 2. Full-state roundtrip preserving order, duplicates, selected refs.
async function fullRoundtrip(): Promise<void> {
  const { driver, storage } = rig();
  const mappings: SourceMapping[] = [
    {
      ref: ref('youtube-music', 'y1'),
      status: 'user-confirmed',
      matchedAtMs: 100,
      evidence: evidence(99),
    },
    {
      ref: ref('youtube-music', 'y2'),
      status: 'rejected',
      matchedAtMs: 50,
      evidence: evidence(40),
    },
  ];
  const recordings: Recording[] = [
    recording(
      'r1',
      [
        ref('itunes', 'i1'),
        ref('youtube-music', 'y1'),
        ref('youtube-music', 'y2'),
      ],
      mappings,
      {
        artwork: [
          { url: 'https://art.example/a.png', width: 300, height: 300 },
        ],
        explicit: true,
        genre: 'Rock',
        isrc: 'USRC17607839',
        versionLabels: ['live', 'remaster'],
      },
    ),
    recording('r2', [ref('itunes', 'i2')], [], {
      artist: null,
      durationMs: null,
      releaseYear: null,
    }),
  ];
  const likes: Like[] = [
    { entityKind: 'track', targetId: 'r1', likedAtMs: 7 },
    { entityKind: 'track', targetId: 'r2', likedAtMs: 9 },
  ];
  const queue: QueueSnapshot = {
    revision: 9,
    occurrences: [
      occurrence('o1', 'r1', ref('youtube-music', 'y1')),
      occurrence('o2', 'r1'),
      occurrence('o3', 'r2', ref('itunes', 'i2')),
    ],
    currentOccurrenceId: 'o2',
    positionMs: 1_234,
    mode: 'paused',
    blockedError: {
      kind: 'timeout',
      message: 'deadline exceeded',
      retryable: true,
      retryAfterMs: 30_000,
    },
  };
  const settings: Settings = {
    catalogProvider: 'custom',
    playbackProvider: 'youtube-music',
    storefront: null,
    qualityKbps: 512,
    theme: 'oled',
    prefetch: false,
  };
  const committed = await storage.commit(
    { recordings, likes, queue, settings },
    ctx().context,
  );
  assert(committed.ok, 'commit resolves');
  const state = await loadOk(storage);
  assertDeepEqual(state.recordings, recordings);
  assertDeepEqual(state.likes, likes);
  assertDeepEqual(state.queue, queue);
  assertDeepEqual(state.settings, settings);
  driver.close();
}

// 3. Injected failure after deletes/partial inserts rolls back the
// previous committed state byte-for-byte (logically).
async function commitRollback(): Promise<void> {
  const { driver, failing, storage } = rig();
  const original: Recording[] = [
    recording('r1', [ref('itunes', 'i1')]),
    recording('r2', [ref('itunes', 'i2')]),
  ];
  assert(
    (
      await storage.commit(
        { recordings: original, queue: EMPTY_QUEUE },
        ctx().context,
      )
    ).ok,
  );
  const before = await loadOk(storage);
  // Commit txn executes: 9 deletes (dependent tables first), then
  // inserts — execute 11 lands mid-insert on r3's source_refs row.
  failing.failBeforeExecute(11);
  const failed = await storage.commit(
    {
      recordings: [
        recording('r3', [ref('itunes', 'i3')]),
        recording('r4', [ref('itunes', 'i4')]),
      ],
    },
    ctx().context,
  );
  assert(!failed.ok, 'injected failure surfaces');
  assertEqual(failed.error.kind, 'transient', 'fixed typed transient');
  assert(
    !failed.error.message.includes('injected'),
    'no raw driver message',
  );
  const after = await loadOk(storage);
  assertDeepEqual(after, before, 'old state restored byte-for-byte');
  driver.close();
}

// 4. Cancellation: pre-cancelled context, and mid-commit cancel via
// hook — both roll back and report typed cancelled.
async function cancellationRollback(): Promise<void> {
  const { driver, failing, storage } = rig();
  const recordings = [recording('r1', [ref('itunes', 'i1')])];
  assert(
    (
      await storage.commit({ recordings, queue: EMPTY_QUEUE }, ctx().context)
    ).ok,
  );
  const before = await loadOk(storage);
  // Pre-cancelled: the driver boundary rejects before any statement.
  const { context: cancelledCtx, source: pre } = ctx();
  pre.cancel();
  const early = await storage.commit(
    { recordings: [recording('r2', [ref('itunes', 'i2')])] },
    cancelledCtx,
  );
  assert(!early.ok && early.error.kind === 'cancelled', 'typed cancelled');
  // Mid-commit: 16 read queries run first, then the rewrite's 9
  // deletes — statement 20 is a dependent-table delete.
  const { context: midCtx, source: mid } = ctx();
  failing.hookAtStatement(20, () => mid.cancel());
  const late = await storage.commit(
    {
      recordings: [
        recording('r3', [ref('itunes', 'i3')]),
        recording('r4', [ref('itunes', 'i4')]),
      ],
    },
    midCtx,
  );
  assert(!late.ok && late.error.kind === 'cancelled', 'mid-commit cancelled');
  const after = await loadOk(storage);
  assertDeepEqual(after, before, 'rolled back to old state');
  driver.close();
}

// 5. Injected failure mid-DDL leaves nothing; retry initializes cleanly.
async function migrationFailureRetry(): Promise<void> {
  const { driver, failing, storage } = rig();
  // Executes: PRAGMA(1), schema_version(2), recordings(3) -> fail.
  failing.failBeforeExecute(3);
  const failed = await storage.initialize(ctx().context);
  assert(!failed.ok && failed.error.kind === 'transient');
  const tables = await failing.transaction(async (conn) =>
    conn.query(`SELECT name FROM sqlite_master WHERE type = 'table'`),
  );
  assertEqual(tables.length, 0, 'no usable partial after rollback');
  const retried = await storage.initialize(ctx().context);
  assert(retried.ok, 'retry initialize succeeds');
  const state = await loadOk(storage);
  assertDeepEqual(state.settings, SETTINGS);
  driver.close();
}

// 6. Malformed stored data fails the whole load; nothing is reset.
async function malformedRows(): Promise<void> {
  const base = (): {
    recordings: Recording[];
    queue: QueueSnapshot;
  } => ({
    recordings: [
      recording(
        'r1',
        [ref('itunes', 'i1')],
        [
          {
            ref: ref('youtube-music', 'y1'),
            status: 'automatic',
            matchedAtMs: 1,
            evidence: evidence(80),
          },
        ],
      ),
    ],
    queue: {
      revision: 2,
      occurrences: [occurrence('o1', 'r1', ref('youtube-music', 'y1'))],
      currentOccurrenceId: 'o1',
      positionMs: 0,
      mode: 'paused',
    },
  });
  const corruptions: readonly string[] = [
    `UPDATE recordings SET artwork_json = '{not-json' WHERE id = 'r1'`,
    `UPDATE recordings SET version_labels_json = 'not-json' WHERE id = 'r1'`,
    `UPDATE mappings SET evidence_json = 'x' WHERE recording_id = 'r1'`,
    `UPDATE queue_state SET blocked_error_json = '{oops' WHERE id = 1`,
    `PRAGMA foreign_keys = OFF; DELETE FROM recordings WHERE id = 'r1'`,
  ];
  for (const sql of corruptions) {
    const { driver, storage } = rig();
    const seed = base();
    assert(
      (
        await storage.commit(
          { recordings: seed.recordings, queue: seed.queue },
          ctx().context,
        )
      ).ok,
      `seed commit ok for ${sql.slice(0, 32)}`,
    );
    driver.execScript(sql);
    const loaded = await storage.load(ctx().context);
    assert(!loaded.ok, `corruption detected: ${sql.slice(0, 40)}`);
    assertEqual(loaded.error.kind, 'invalid-response');
    assertEqual(loaded.error.message, 'stored data failed validation');
    driver.close();
  }
}

// 6b. Relational corruption that only survives with constraints
// removed or foreign_keys off must also fail the whole load.
async function corruptedRelations(): Promise<void> {
  const seed = async (storage: SqliteStorage): Promise<void> => {
    assert(
      (
        await storage.commit(
          {
            recordings: [
              recording(
                'r1',
                [ref('itunes', 'i1'), ref('youtube-music', 'y1')],
                [
                  {
                    ref: ref('youtube-music', 'y1'),
                    status: 'automatic',
                    matchedAtMs: 1,
                    evidence: evidence(80),
                  },
                ],
              ),
            ],
            likes: [{ entityKind: 'track', targetId: 'r1', likedAtMs: 1 }],
            queue: {
              revision: 1,
              occurrences: [
                occurrence('o1', 'r1', ref('youtube-music', 'y1')),
                occurrence('o2', 'r1'),
              ],
              currentOccurrenceId: 'o1',
              positionMs: 0,
              mode: 'paused',
            },
          },
          ctx().context,
        )
      ).ok,
      'seed commit ok',
    );
  };
  const cases: readonly (readonly [string, string])[] = [
    [
      'orphan source_ref',
      `PRAGMA foreign_keys = OFF;
       INSERT INTO source_refs (recording_id, ordinal, provider, kind, source_id)
       VALUES ('ghost', 0, 'itunes', 'track', 'g1')`,
    ],
    [
      'orphan mapping',
      `PRAGMA foreign_keys = OFF;
       INSERT INTO mappings (recording_id, ordinal, provider, kind, source_id, status, matched_at_ms, evidence_json)
       VALUES ('ghost', 0, 'itunes', 'track', 'g1', 'automatic', 1, '{}')`,
    ],
    [
      'orphan entity like',
      // likes.target_id is polymorphic, so no SQL FK — an album like
      // naming a nonexistent entity is app-level corruption.
      `INSERT INTO likes (entity_kind, target_id, liked_ms)
       VALUES ('album', 'ghost-entity', 2)`,
    ],
    [
      'orphan track like',
      `INSERT INTO likes (entity_kind, target_id, liked_ms)
       VALUES ('track', 'ghost-recording', 2)`,
    ],
    [
      'source_ref ordinal gap',
      `UPDATE source_refs SET ordinal = 7 WHERE source_id = 'y1'`,
    ],
    [
      'queue ordinal gap',
      `UPDATE queue_occurrences SET ordinal = 9 WHERE occurrence_id = 'o2'`,
    ],
    [
      'partial selected-ref tuple',
      `DROP TABLE queue_occurrences;
       CREATE TABLE queue_occurrences (occurrence_id TEXT, ordinal INTEGER, recording_id TEXT, selected_provider TEXT, selected_kind TEXT, selected_source_id TEXT);
       INSERT INTO queue_occurrences VALUES ('o1', 0, 'r1', 'youtube-music', NULL, 'y1'), ('o2', 1, 'r1', NULL, NULL, NULL)`,
    ],
    [
      'duplicate source ref',
      `DROP TABLE source_refs;
       CREATE TABLE source_refs (recording_id TEXT, ordinal INTEGER, provider TEXT, kind TEXT, source_id TEXT);
       INSERT INTO source_refs VALUES
         ('r1', 0, 'itunes', 'track', 'i1'),
         ('r1', 1, 'itunes', 'track', 'i1'),
         ('r1', 2, 'youtube-music', 'track', 'y1')`,
    ],
    [
      'duplicate occurrence id',
      `DROP TABLE queue_occurrences;
       CREATE TABLE queue_occurrences (occurrence_id TEXT, ordinal INTEGER, recording_id TEXT, selected_provider TEXT, selected_kind TEXT, selected_source_id TEXT);
       INSERT INTO queue_occurrences VALUES ('o1', 0, 'r1', NULL, NULL, NULL), ('o1', 1, 'r1', NULL, NULL, NULL)`,
    ],
  ];
  for (const [name, sql] of cases) {
    const { driver, storage } = rig();
    await seed(storage);
    driver.execScript(sql);
    const loaded = await storage.load(ctx().context);
    assert(!loaded.ok, `corruption detected: ${name}`);
    assertEqual(loaded.error.kind, 'invalid-response', name);
    // No silent reset: the same malformed state still fails on retry.
    const again = await storage.load(ctx().context);
    assert(!again.ok, `state left untouched: ${name}`);
    driver.close();
  }
}

// 7. Schema version edge cases: newer, duplicate, negative.
async function schemaVersionEdges(): Promise<void> {
  // Newer schema.
  {
    const { driver, storage } = rig();
    assert((await storage.initialize(ctx().context)).ok);
    driver.execScript(
      `UPDATE schema_version SET version = ${CURRENT_SCHEMA_VERSION + 1} WHERE id = 1`,
    );
    // A fresh instance re-reads the schema version at initialize.
    const second = new SqliteStorage(driver, SETTINGS);
    const res = await second.load(ctx().context);
    assert(!res.ok && res.error.kind === 'invalid-response');
    assertEqual(
      res.error.message,
      'database schema is newer than this app',
    );
    driver.close();
  }
  // Duplicate and negative version rows (unconstrained replacement).
  for (const values of ['(1, -3)', '(1, 1), (2, 1)']) {
    const { driver, storage } = rig();
    assert((await storage.initialize(ctx().context)).ok);
    driver.execScript(
      `DROP TABLE schema_version;
       CREATE TABLE schema_version (id INTEGER, version INTEGER);
       INSERT INTO schema_version VALUES ${values};`,
    );
    // A fresh storage re-checks the schema.
    const second = new SqliteStorage(driver, SETTINGS);
    const res = await second.initialize(ctx().context);
    assert(!res.ok, `bad version rejected: ${values}`);
    assertEqual(res.error.kind, 'invalid-response');
    driver.close();
  }
}

// 8. Attempt traces: newest-first, global cap, validation, malformed.
async function attemptTraces(): Promise<void> {
  const { driver, storage } = rig();
  assert(
    (
      await storage.commit(
        { attempts: [trace('t1'), trace('t2'), trace('t3')] },
        ctx().context,
      )
    ).ok,
  );
  const listed = await storage.loadAttempts(10, ctx().context);
  assert(listed.ok);
  assertDeepEqual(
    listed.value.map((t) => t.requestId),
    ['t3', 't2', 't1'],
  );
  assertDeepEqual(listed.value[0], trace('t3'));
  // 510 appended -> only the newest 500 survive.
  const many = Array.from({ length: 510 }, (_, i) => trace(`b${i}`));
  assert((await storage.commit({ attempts: many }, ctx().context)).ok);
  const capped = await storage.loadAttempts(500, ctx().context);
  assert(capped.ok && capped.value.length === 500);
  assertEqual(capped.value[0]?.requestId, 'b509');
  assertEqual(capped.value[499]?.requestId, 'b10');
  // A URL carrying a signed query/fragment is rejected before write.
  const signed: AttemptTrace = {
    ...trace('signed'),
    httpTrace: [
      {
        method: 'GET',
        url: 'https://h.example/v?sig=SECRET',
        bytes: 0,
        elapsedMs: 0,
      },
    ],
  };
  const rejected = await storage.commit(
    { attempts: [signed] },
    ctx().context,
  );
  assert(!rejected.ok && rejected.error.kind === 'invalid-response');
  const stillCapped = await storage.loadAttempts(500, ctx().context);
  assert(stillCapped.ok && stillCapped.value.length === 500);
  // Malformed persisted trace fails loadAttempts entirely.
  driver.execScript(
    `INSERT INTO attempt_traces (request_id, trace_json) VALUES ('bad', '{not-json')`,
  );
  const broken = await storage.loadAttempts(500, ctx().context);
  assert(!broken.ok && broken.error.kind === 'invalid-response');
  driver.close();
}

// 9. Empty batch is a no-op; settings-only/attempts-only leave the
// core untouched.
async function sectionScopedCommits(): Promise<void> {
  const { driver, storage } = rig();
  const recordings = [recording('r1', [ref('itunes', 'i1')])];
  assert(
    (
      await storage.commit(
        { recordings, queue: EMPTY_QUEUE },
        ctx().context,
      )
    ).ok,
  );
  assert((await storage.commit({}, ctx().context)).ok, 'empty no-op');
  const newSettings: Settings = { ...SETTINGS, theme: 'dark' };
  assert(
    (await storage.commit({ settings: newSettings }, ctx().context)).ok,
  );
  assert((await storage.commit({ attempts: [trace('x')] }, ctx().context)).ok);
  const state = await loadOk(storage);
  assertDeepEqual(state.recordings, recordings, 'core unchanged');
  assertDeepEqual(state.queue, EMPTY_QUEUE);
  assertDeepEqual(state.settings, newSettings);
  driver.close();
}

// 10. Two storage instances over the same driver share committed data.
async function sharedDriverVisibility(): Promise<void> {
  const { driver, storage } = rig();
  const second = new SqliteStorage(driver, SETTINGS);
  const recordings = [recording('r1', [ref('itunes', 'i1')])];
  assert(
    (
      await storage.commit(
        { recordings, queue: EMPTY_QUEUE },
        ctx().context,
      )
    ).ok,
  );
  const seen = await second.load(ctx().context);
  assert(seen.ok, 'second instance reads committed data');
  assertDeepEqual(seen.value.recordings, recordings);
  driver.close();
}

// 11. A cancelled signal is observed at every driver boundary.
async function cancelledBoundaries(): Promise<void> {
  const { driver, storage } = rig();
  const { context: loadCtx, source: s1 } = ctx();
  s1.cancel();
  const loaded = await storage.load(loadCtx);
  assert(!loaded.ok && loaded.error.kind === 'cancelled');
  const { context: commitCtx, source: s2 } = ctx();
  s2.cancel();
  const committed = await storage.commit({ settings: SETTINGS }, commitCtx);
  assert(!committed.ok && committed.error.kind === 'cancelled');
  const { context: attemptsCtx, source: s3 } = ctx();
  s3.cancel();
  const attempts = await storage.loadAttempts(5, attemptsCtx);
  assert(!attempts.ok && attempts.error.kind === 'cancelled');
  driver.close();
}

// 11b. A caller arriving already cancelled gets typed cancelled off
// the coalesced promise; the shared migration is untouched.
async function coalescedCancel(): Promise<void> {
  const { driver, failing, storage } = rig();
  assert((await storage.initialize(ctx().context)).ok);
  const { context, source } = ctx();
  source.cancel();
  const res = await storage.initialize(context);
  assert(!res.ok && res.error.kind === 'cancelled');
  // The shared initialize result is unaffected: a fresh caller works.
  const next = await storage.initialize(ctx().context);
  assert(next.ok, 'shared migration survives');
  assertEqual(
    failing.transactions,
    2,
    'still version probe + one migration transaction',
  );
  driver.close();
}

// 12. Parameterization: hostile strings roundtrip and never alter the
// schema or other rows.
async function parameterization(): Promise<void> {
  const { driver, storage } = rig();
  const hostile = `O'Hara'; DROP TABLE recordings; -- \n\t日本語 🎵`;
  const recordings = [
    recording('r1', [ref('itunes', 'i1')], [], {
      title: hostile,
      artist: `artist "quoted" ${hostile}`,
      album: 'a\nb\tc',
    }),
  ];
  assert(
    (
      await storage.commit(
        { recordings, queue: EMPTY_QUEUE },
        ctx().context,
      )
    ).ok,
  );
  const state = await loadOk(storage);
  assertDeepEqual(state.recordings, recordings, 'hostile text roundtrips');
  const tables = await driver.transaction(async (conn) =>
    conn.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recordings'`,
    ),
  );
  assertEqual(tables.length, 1, 'schema intact');
  driver.close();
}

async function concurrentOperations(): Promise<void> {
  const { driver, storage } = rig();
  assert((await storage.initialize(ctx().context)).ok);
  const results = await Promise.all([
    storage.commit({ settings: { ...SETTINGS, theme: 'dark' } }, ctx().context),
    storage.commit({ settings: { ...SETTINGS, theme: 'light' } }, ctx().context),
    storage.load(ctx().context),
    storage.loadAttempts(5, ctx().context),
  ]);
  assert(results.every((result) => result.ok), 'concurrent storage operations succeed');
  assertEqual((await loadOk(storage)).settings.theme, 'light', 'last commit wins');
  driver.close();
}

// 13. v1 -> v2 migration: a backup is taken first, v1 likes copy
// across as track likes, and every pre-existing row is preserved.
async function migrationV1toV2(): Promise<void> {
  const driver = new NodeSqliteDriver();
  // Build a real v1 database: the v1 DDL plus seeded rows through the
  // old column names (entity_id, liked_at_ms).
  driver.execScript(`${MIGRATIONS[0]?.join(';\n') ?? ''};`);
  driver.execScript(`
    INSERT INTO schema_version (id, version) VALUES (1, 1);
    INSERT INTO settings (id, catalog_provider, playback_provider, storefront, quality_kbps, theme, prefetch)
      VALUES (1, 'itunes', 'youtube-music', 'US', 256, 'system', 1);
    INSERT INTO queue_state (id, revision, current_occurrence_id, position_ms, mode, blocked_error_json)
      VALUES (1, 4, 'o1', 1200, 'paused', NULL);
    INSERT INTO recordings (id, title, artist, album, duration_ms, release_year, artwork_json, explicit, genre, isrc, version_labels_json)
      VALUES
      ('r1', 'Song r1', 'Artist', 'Album', 300000, 2020, '[]', NULL, 'Rock', NULL, '[]'),
      ('r2', 'Song r2', NULL, NULL, NULL, NULL, '[]', NULL, NULL, NULL, '[]');
    INSERT INTO source_refs (recording_id, ordinal, provider, kind, source_id)
      VALUES ('r1', 0, 'itunes', 'track', 'i1'), ('r2', 0, 'itunes', 'track', 'i2');
    INSERT INTO queue_occurrences (occurrence_id, ordinal, recording_id, selected_provider, selected_kind, selected_source_id)
      VALUES ('o1', 0, 'r1', NULL, NULL, NULL);
    INSERT INTO likes (entity_kind, entity_id, liked_at_ms)
      VALUES ('track', 'r1', 42), ('track', 'r2', 43);
  `);
  const storage = new SqliteStorage(driver, SETTINGS);
  const init = await storage.initialize(ctx().context);
  assert(init.ok, 'v1 -> v2 initialize resolves');
  assertDeepEqual(driver.backups, ['v1'], 'pre-migration backup taken');
  const state = await loadOk(storage);
  assertDeepEqual(
    state.likes,
    [
      { entityKind: 'track', targetId: 'r1', likedAtMs: 42 },
      { entityKind: 'track', targetId: 'r2', likedAtMs: 43 },
    ],
    'v1 likes copied as track likes',
  );
  assertEqual(state.recordings.length, 2, 'recordings preserved');
  assertEqual(state.recordings[0]?.sourceRefs[0]?.id, 'i1');
  assertDeepEqual(
    state.queue,
    {
      revision: 4,
      occurrences: [
        { occurrenceId: 'o1', recordingId: 'r1', selectedRef: null },
      ],
      currentOccurrenceId: 'o1',
      positionMs: 1200,
      mode: 'paused',
    },
    'queue state preserved',
  );
  assertEqual(state.settings.storefront, 'US', 'settings preserved');
  assertDeepEqual(state.entities, []);
  assertDeepEqual(state.playlists, []);
  // The optional provider/cache columns ALTER in during the migration;
  // a write through the v2 column list must round-trip on a v1-origin DB.
  const widened: Settings = {
    ...SETTINGS,
    lyricsProvider: 'lyrics-lrclib',
    artworkCacheBytes: 268435456,
  };
  assert(
    (await storage.commit({ settings: widened }, ctx().context)).ok,
    'optional settings columns writable post-migration',
  );
  const reread = await loadOk(storage);
  assertEqual(reread.settings.lyricsProvider, 'lyrics-lrclib');
  assertEqual(reread.settings.artworkCacheBytes, 268435456);
  const versions = await driver.transaction(async (conn) =>
    conn.query('SELECT version FROM schema_version WHERE id = 1'),
  );
  assertEqual(versions[0]?.['version'], CURRENT_SCHEMA_VERSION);
  driver.close();
}

// 13b. Two instances sharing one driver initialize concurrently: the
// initialize tails serialize probe+backup+migrate, so the second
// instance observes the migrated version and runs no migration of its
// own — no DDL replay, one backup.
async function sharedDriverInitialize(): Promise<void> {
  const driver = new NodeSqliteDriver();
  driver.execScript(`${MIGRATIONS[0]?.join(';\n') ?? ''};`);
  driver.execScript(`
    INSERT INTO schema_version (id, version) VALUES (1, 1);
  `);
  const first = new SqliteStorage(driver, SETTINGS);
  const second = new SqliteStorage(driver, SETTINGS);
  const [a, b] = await Promise.all([
    first.initialize(ctx().context),
    second.initialize(ctx().context),
  ]);
  assert(a.ok, 'first concurrent initialize resolves');
  assert(b.ok, 'second concurrent initialize resolves');
  assertDeepEqual(driver.backups, ['v1'], 'migration ran exactly once');
  const versions = await driver.transaction(async (conn) =>
    conn.query('SELECT version FROM schema_version WHERE id = 1'),
  );
  assertEqual(versions[0]?.['version'], CURRENT_SCHEMA_VERSION);
  driver.close();
}

// 14. A file-backed database takes a real pre-migration image at
// <db>.bak-v1 and drops it once the migration commits — no durable
// copy persists.
async function migrationBackupFile(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'auqw-v1-'));
  try {
    const file = join(dir, 'library.db');
    const driver = new NodeSqliteDriver(file);
    driver.execScript(`${MIGRATIONS[0]?.join(';\n') ?? ''};`);
    driver.execScript(`
      INSERT INTO schema_version (id, version) VALUES (1, 1);
      INSERT INTO settings (id, catalog_provider, playback_provider, storefront, quality_kbps, theme, prefetch)
        VALUES (1, 'itunes', 'youtube-music', NULL, 256, 'system', 1);
      INSERT INTO queue_state (id, revision, current_occurrence_id, position_ms, mode, blocked_error_json)
        VALUES (1, 0, NULL, 0, 'stopped', NULL);
      INSERT INTO recordings (id, title, artist, album, duration_ms, release_year, artwork_json, explicit, genre, isrc, version_labels_json)
        VALUES ('r1', 'Song r1', 'Artist', NULL, NULL, NULL, '[]', NULL, NULL, NULL, '[]');
      INSERT INTO source_refs (recording_id, ordinal, provider, kind, source_id)
        VALUES ('r1', 0, 'itunes', 'track', 'i1');
      INSERT INTO likes (entity_kind, entity_id, liked_at_ms)
        VALUES ('track', 'r1', 42);
    `);
    const storage = new SqliteStorage(driver, SETTINGS);
    assert((await storage.initialize(ctx().context)).ok);
    const backupPath = `${file}.bak-v1`;
    assertDeepEqual(driver.backups, ['v1'], 'pre-migration backup taken');
    assertDeepEqual(
      driver.droppedBackups,
      ['v1'],
      'backup dropped after commit',
    );
    assert(
      !existsSync(backupPath),
      'backup file removed once the migration lands',
    );
    driver.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 14b. A failed migration attempt leaves <db>.bak-v1 behind; the next
// initialize must replace it — not wedge on VACUUM INTO's
// existing-target refusal — and clean it up on commit.
async function backupRetryAfterFailure(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'auqw-bak-'));
  try {
    const file = join(dir, 'library.db');
    const driver = new NodeSqliteDriver(file);
    driver.execScript(`${MIGRATIONS[0]?.join(';\n') ?? ''};`);
    driver.execScript(`
      INSERT INTO schema_version (id, version) VALUES (1, 1);
      INSERT INTO settings (id, catalog_provider, playback_provider, storefront, quality_kbps, theme, prefetch)
        VALUES (1, 'itunes', 'youtube-music', NULL, 256, 'system', 1);
      INSERT INTO queue_state (id, revision, current_occurrence_id, position_ms, mode, blocked_error_json)
        VALUES (1, 0, NULL, 0, 'stopped', NULL);
      INSERT INTO recordings (id, title, artist, album, duration_ms, release_year, artwork_json, explicit, genre, isrc, version_labels_json)
        VALUES ('r1', 'Song r1', 'Artist', NULL, NULL, NULL, '[]', NULL, NULL, NULL, '[]');
      INSERT INTO source_refs (recording_id, ordinal, provider, kind, source_id)
        VALUES ('r1', 0, 'itunes', 'track', 'i1');
      INSERT INTO likes (entity_kind, entity_id, liked_at_ms)
        VALUES ('track', 'r1', 42);
    `);
    const failing = new FailingDriver(driver);
    const storage = new SqliteStorage(failing, SETTINGS);
    // Migration txn executes: PRAGMA(1), MIGRATION_2 statements
    // (2..21), version UPDATE(22) — execute 10 lands mid-DDL.
    failing.failBeforeExecute(10);
    const first = await storage.initialize(ctx().context);
    assert(!first.ok && first.error.kind === 'transient');
    const backupPath = `${file}.bak-v1`;
    assert(existsSync(backupPath), 'failed attempt leaves the backup');
    // The abandoned image still holds the pre-migration v1 rows.
    const backup = new NodeSqliteDriver(backupPath);
    const likeRows = await backup.transaction(async (conn) =>
      conn.query('SELECT entity_id, liked_at_ms FROM likes'),
    );
    assertDeepEqual(
      likeRows,
      [{ entity_id: 'r1', liked_at_ms: 42 }],
      'backup holds the pre-migration v1 rows',
    );
    backup.close();
    // Retry replaces the stale image and succeeds — before the fix
    // every retry failed at VACUUM INTO until manual deletion.
    const retried = await storage.initialize(ctx().context);
    assert(retried.ok, 'retry over a stale backup succeeds');
    assert(!existsSync(backupPath), 'backup dropped after commit');
    assertDeepEqual(driver.backups, ['v1', 'v1'], 'backup re-taken');
    assertDeepEqual(driver.droppedBackups, ['v1']);
    const state = await loadOk(storage);
    assertEqual(state.recordings.length, 1, 'v1 rows migrated');
    assertDeepEqual(state.likes, [
      { entityKind: 'track', targetId: 'r1', likedAtMs: 42 },
    ]);
    driver.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type OwnedSections = {
  recordings: Recording[];
  likes: Like[];
  entities: Entity[];
  entitySourceRefs: EntitySourceRef[];
  playlists: Playlist[];
  playlistEntries: PlaylistEntry[];
  playHistory: PlayEvent[];
  playCounts: PlayCount[];
  matchReviews: MatchReview[];
  lyricsCache: LyricsCacheEntry[];
  artworkCache: ArtworkCacheEntry[];
};

function ownedSections(): OwnedSections {
  const recordings: Recording[] = [
    recording('r1', [ref('itunes', 'i1'), ref('youtube-music', 'y1')]),
    recording('r2', [ref('itunes', 'i2')]),
  ];
  return {
    recordings,
    likes: [
      { entityKind: 'track', targetId: 'r1', likedAtMs: 7 },
      { entityKind: 'album', targetId: 'e-album', likedAtMs: 8 },
      { entityKind: 'artist', targetId: 'e-artist', likedAtMs: 9 },
    ],
    entities: [
      {
        entityId: 'e-album',
        kind: 'album',
        title: 'Dummy',
        artistName: 'Portishead',
        artwork: [
          { url: 'https://art.example/d.png', width: 300, height: 300 },
        ],
        createdMs: 10,
      },
      {
        entityId: 'e-artist',
        kind: 'artist',
        title: 'Portishead',
        artistName: null,
        artwork: [],
        createdMs: 11,
      },
    ],
    entitySourceRefs: [
      {
        entityId: 'e-album',
        provider: 'deezer',
        ref: { provider: 'deezer', kind: 'album', id: 'd-alb' },
      },
      {
        entityId: 'e-artist',
        provider: 'deezer',
        ref: { provider: 'deezer', kind: 'artist', id: 'd-art' },
      },
    ],
    playlists: [
      {
        playlistId: 'p1',
        name: 'Favorites',
        createdMs: 20,
        updatedMs: 30,
      },
    ],
    playlistEntries: [
      // The same recording twice — occurrence rows keep identity.
      {
        entryId: 'pe1',
        playlistId: 'p1',
        recordingId: 'r1',
        position: 1,
        selectedRef: ref('youtube-music', 'y1'),
        addedMs: 21,
      },
      {
        entryId: 'pe2',
        playlistId: 'p1',
        recordingId: 'r1',
        position: 2,
        selectedRef: null,
        addedMs: 22,
      },
      {
        entryId: 'pe3',
        playlistId: 'p1',
        recordingId: 'r2',
        position: 2.5,
        selectedRef: null,
        addedMs: 23,
      },
    ],
    playHistory: [
      {
        eventId: 'ev1',
        recordingId: 'r1',
        occurrenceId: 'occ-9',
        playedMs: 100,
        listenedMs: 121_000,
      },
      {
        eventId: 'ev2',
        recordingId: 'r2',
        occurrenceId: null,
        playedMs: 200,
        listenedMs: 40_000,
      },
    ],
    playCounts: [
      { recordingId: 'r1', count: 12, lastMs: 100 },
      { recordingId: 'r2', count: 1, lastMs: 200 },
    ],
    matchReviews: [
      {
        reviewId: 'mr1',
        recordingId: 'r1',
        candidates: [
          {
            metadata: {
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
            ref: ref('youtube-music', 'y1'),
          },
        ],
        status: 'confirmed',
        resolution: { ref: ref('youtube-music', 'y1') },
        createdMs: 50,
        resolvedMs: 60,
      },
      {
        reviewId: 'mr2',
        recordingId: 'r2',
        candidates: [
          {
            metadata: {
              sourceRef: ref('youtube-music', 'y2'),
              title: 'Song r2',
              artist: 'Artist',
              album: null,
              durationMs: 299_000,
              releaseYear: null,
              artwork: [],
              explicit: null,
              genre: null,
              storefront: null,
            },
            ref: ref('youtube-music', 'y2'),
          },
        ],
        status: 'pending',
        resolution: null,
        createdMs: 70,
        resolvedMs: null,
      },
    ],
    lyricsCache: [
      {
        recordingId: 'r1',
        provider: 'lyrics-lrclib',
        kind: 'synced',
        payload: {
          plainLyrics: 'words',
          syncedLyrics: '[00:01.00] words',
          instrumental: false,
        },
        fetchedMs: 80,
      },
    ],
    artworkCache: [
      {
        url: 'https://art.example/d.png',
        filePath: '/tmp/d.png',
        bytes: 1024,
        lastAccessedMs: 90,
      },
    ],
  };
}

async function commitOwned(
  storage: SqliteStorage,
  sections: OwnedSections,
): Promise<void> {
  const committed = await storage.commit(
    { ...sections, queue: EMPTY_QUEUE, settings: SETTINGS },
    ctx().context,
  );
  assert(committed.ok, 'owned commit resolves');
}

// 15. Every v2 owned and cache table round-trips through commit/load.
async function ownedRoundtrip(): Promise<void> {
  const { driver, storage } = rig();
  const sections = ownedSections();
  await commitOwned(storage, sections);
  const state = await loadOk(storage);
  assertDeepEqual(state.recordings, sections.recordings);
  assertDeepEqual(state.likes, sections.likes);
  assertDeepEqual(state.entities, sections.entities);
  assertDeepEqual(state.entitySourceRefs, sections.entitySourceRefs);
  assertDeepEqual(state.playlists, sections.playlists);
  assertDeepEqual(state.playlistEntries, sections.playlistEntries);
  assertDeepEqual(state.playHistory, sections.playHistory);
  assertDeepEqual(state.playCounts, sections.playCounts);
  assertDeepEqual(state.matchReviews, sections.matchReviews);
  assertDeepEqual(state.lyricsCache, sections.lyricsCache);
  assertDeepEqual(state.artworkCache, sections.artworkCache);
  driver.close();
}

// 16. Export carries only owned classes; import into a fresh database
// reproduces them and re-exports an identical document.
async function exportImportRoundtrip(): Promise<void> {
  const { driver, storage } = rig();
  const sections = ownedSections();
  await commitOwned(storage, sections);
  const exported = await storage.exportOwned(5_000, ctx().context);
  assert(exported.ok, 'export resolves');
  assertEqual(exported.value.formatVersion, 1);
  assertEqual(exported.value.exportedAtMs, 5_000);
  // Session state, caches, and diagnostics never appear in the doc.
  assert(!('queue' in exported.value), 'queue excluded');
  assert(!('lyricsCache' in exported.value), 'lyrics cache excluded');
  assert(!('artworkCache' in exported.value), 'artwork cache excluded');
  assert(!('attempts' in exported.value), 'attempts excluded');

  const freshDriver = new NodeSqliteDriver();
  const target = new SqliteStorage(freshDriver, {
    ...SETTINGS,
    theme: 'oled',
  });
  const imported = await target.importOwned(exported.value, ctx().context);
  assert(imported.ok, 'import into a fresh database resolves');
  const state = await loadOk(target);
  assertDeepEqual(state.recordings, sections.recordings);
  assertDeepEqual(state.likes, sections.likes);
  assertDeepEqual(state.entities, sections.entities);
  assertDeepEqual(state.entitySourceRefs, sections.entitySourceRefs);
  assertDeepEqual(state.playlists, sections.playlists);
  assertDeepEqual(state.playlistEntries, sections.playlistEntries);
  assertDeepEqual(state.playHistory, sections.playHistory);
  assertDeepEqual(state.playCounts, sections.playCounts);
  assertDeepEqual(state.matchReviews, sections.matchReviews);
  // The document's settings land; caches stay empty on the fresh side.
  assertDeepEqual(state.settings, SETTINGS);
  assertDeepEqual(state.lyricsCache, []);
  assertDeepEqual(state.artworkCache, []);
  const reexported = await target.exportOwned(5_000, ctx().context);
  assert(reexported.ok);
  assertDeepEqual(
    reexported.value,
    exported.value,
    'export -> import -> export is stable',
  );
  driver.close();
  freshDriver.close();
}

// 17. A malformed document is rejected before any write; an injected
// mid-import failure rolls the whole replace back.
async function importAtomicity(): Promise<void> {
  const { driver, failing, storage } = rig();
  const sections = ownedSections();
  await commitOwned(storage, sections);
  const before = await loadOk(storage);

  const malformed = {
    formatVersion: 1,
    exportedAtMs: 1,
    recordings: [],
    sourceRefs: [
      { recordingId: 'ghost', ref: ref('itunes', 'g1') },
    ],
    mappings: [],
    provenance: 'provider',
    likes: [],
    entities: [],
    entitySourceRefs: [],
    playlists: [],
    playlistEntries: [],
    playHistory: [],
    playCounts: [],
    matchReviews: [],
    settings: SETTINGS,
  };
  const rejected = await storage.importOwned(
    malformed as ExportDocument,
    ctx().context,
  );
  assert(!rejected.ok, 'orphan junction row rejected');
  assertEqual(rejected.error.kind, 'invalid-response');
  assertDeepEqual(
    await loadOk(storage),
    before,
    'malformed import leaves state untouched',
  );

  // A valid document that dies mid-import also leaves state untouched:
  // execute 18 lands inside the recording inserts (after 14 deletes
  // and 2 queue_state statements).
  const doc: ExportDocument = {
    formatVersion: 1,
    exportedAtMs: 2,
    recordings: [
      {
        id: 'r9',
        title: 'Replacement',
        artist: 'Someone',
        album: null,
        durationMs: null,
        releaseYear: null,
        artwork: [],
        explicit: null,
        genre: null,
        isrc: null,
        versionLabels: [],
        provenance: 'provider',
      },
    ],
    sourceRefs: [{ recordingId: 'r9', ref: ref('itunes', 'i9') }],
    mappings: [],
    likes: [{ entityKind: 'track', targetId: 'r9', likedAtMs: 1 }],
    entities: [],
    entitySourceRefs: [],
    playlists: [],
    playlistEntries: [],
    playHistory: [],
    playCounts: [],
    matchReviews: [],
    settings: SETTINGS,
  };
  failing.failBeforeExecute(18);
  const failed = await storage.importOwned(doc, ctx().context);
  assert(!failed.ok, 'injected failure surfaces');
  assertEqual(failed.error.kind, 'transient');
  assertDeepEqual(
    await loadOk(storage),
    before,
    'rolled back to the old state',
  );
  driver.close();
}

// 19. Two storage instances over one driver share its transaction
// tail — concurrent ops must not overlap BEGIN/COMMIT on the shared
// connection.
async function sharedDriverTransactions(): Promise<void> {
  const driver = new NodeSqliteDriver();
  const first = new SqliteStorage(driver, SETTINGS);
  const second = new SqliteStorage(driver, SETTINGS);
  // Initialize once: concurrent initializes from two fresh instances
  // racing a v0 -> v2 migration is a separate coalescing question.
  assert((await first.initialize(ctx().context)).ok);
  const recordings = [recording('r1', [ref('itunes', 'i1')])];
  const [a, b, c, d] = await Promise.all([
    first.commit({ recordings, queue: EMPTY_QUEUE }, ctx().context),
    second.commit({ settings: { ...SETTINGS, theme: 'dark' } }, ctx().context),
    first.loadAttempts(5, ctx().context),
    second.load(ctx().context),
  ]);
  assert(
    a.ok && b.ok && c.ok && d.ok,
    'interleaved instances serialize on the shared driver',
  );
  const state = await loadOk(first);
  assertEqual(state.settings.theme, 'dark');
  assertEqual(state.recordings.length, 1);
  driver.close();
}

// 20. exportOwned never throws: an unsafe timestamp from a broken
// clock returns a typed invalid-response, not a TypeError.
async function exportOwnedUnsafeTimestamp(): Promise<void> {
  const { driver, storage } = rig();
  assert((await storage.initialize(ctx().context)).ok);
  for (const bad of [
    Number.NaN,
    -1,
    2 ** 53,
    Number.POSITIVE_INFINITY,
    1.5,
  ]) {
    const res = await storage.exportOwned(bad, ctx().context);
    assert(!res.ok, `unsafe exportedAtMs rejected: ${bad}`);
    assertEqual(res.error.kind, 'invalid-response');
    assertEqual(
      res.error.message,
      'exportedAtMs must be a safe nonnegative integer',
    );
  }
  driver.close();
}

// 21. Entity-kind cross-checks: a like's entityKind and an
// entity_source_ref's kind must agree with the target entity's kind —
// on both the commit-time and decode-time validators.
async function entityKindCrossCheck(): Promise<void> {
  const { driver, storage } = rig();
  const sections = ownedSections();
  await commitOwned(storage, sections);
  // Commit side: an 'artist' like naming the album entity e-album.
  const badLike = await storage.commit(
    {
      likes: [
        ...sections.likes,
        { entityKind: 'artist', targetId: 'e-album', likedAtMs: 5 },
      ],
    },
    ctx().context,
  );
  assert(
    !badLike.ok && badLike.error.kind === 'invalid-response',
    'mismatched like rejected at commit',
  );
  // Decode side: the same row written past the validator fails load.
  driver.execScript(
    `INSERT INTO likes (entity_kind, target_id, liked_ms)
     VALUES ('artist', 'e-album', 5)`,
  );
  const loaded = await storage.load(ctx().context);
  assert(
    !loaded.ok && loaded.error.kind === 'invalid-response',
    'mismatched like fails decode',
  );
  driver.execScript(
    `DELETE FROM likes WHERE entity_kind = 'artist' AND target_id = 'e-album'`,
  );
  // Commit side: an 'artist' ref on the album entity e-album.
  const badRef = await storage.commit(
    {
      entitySourceRefs: [
        ...sections.entitySourceRefs.filter((r) => r.entityId !== 'e-album'),
        {
          entityId: 'e-album',
          provider: 'deezer',
          ref: { provider: 'deezer', kind: 'artist', id: 'd-alb' },
        },
      ],
    },
    ctx().context,
  );
  assert(
    !badRef.ok && badRef.error.kind === 'invalid-response',
    'mismatched entity ref rejected at commit',
  );
  // Decode side.
  driver.execScript(
    `UPDATE entity_source_refs
     SET ref_json = '{"provider":"deezer","kind":"artist","id":"d-alb"}'
     WHERE entity_id = 'e-album'`,
  );
  const again = await storage.load(ctx().context);
  assert(
    !again.ok && again.error.kind === 'invalid-response',
    'mismatched entity ref fails decode',
  );
  driver.close();
}

// 22. A database holding application-named tables but no
// schema_version row is a foreign file, not a partial schema —
// migrations are single transactions, so a legit partial can never
// persist. initialize rejects it instead of silently merging into
// tables whose constraints were never ours.
async function foreignSchemaRejected(): Promise<void> {
  const driver = new NodeSqliteDriver();
  driver.execScript(`
    CREATE TABLE recordings (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, album TEXT,
      duration_ms INTEGER, release_year INTEGER, artwork_json TEXT NOT NULL,
      explicit INTEGER, genre TEXT, isrc TEXT, version_labels_json TEXT NOT NULL
    );
    INSERT INTO recordings VALUES
      ('r1', 'Song r1', 'Artist', NULL, NULL, NULL, '[]', NULL, NULL, NULL, '[]');
  `);
  const storage = new SqliteStorage(driver, SETTINGS);
  const init = await storage.initialize(ctx().context);
  assert(
    !init.ok && init.error.kind === 'invalid-response',
    'foreign database rejected at initialize',
  );
  driver.close();
}

// 23. The same rejection covers the tables the newest migrations
// own — a foreign file holding only slice-3 tables is still
// foreign, and KNOWN_TABLES must name them all. Case doesn't dodge
// the probe either: SQLite identifiers are case-insensitive, so a
// foreign "Downloads" would collide in-migration just the same.
async function foreignNewestTablesRejected(): Promise<void> {
  for (const table of ['downloads', 'Local_Sources', 'local_files']) {
    const driver = new NodeSqliteDriver();
    driver.execScript(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
    const storage = new SqliteStorage(driver, SETTINGS);
    const init = await storage.initialize(ctx().context);
    assert(
      !init.ok && init.error.kind === 'invalid-response',
      `foreign ${table} table rejected at initialize`,
    );
    driver.close();
  }
}

// Non-table schema objects share the same namespace: a foreign
// index named like one a migration creates (or a table shadowing a
// mid-migration throwaway such as likes_new) would pass a
// tables-only probe, then die inside the migration transaction
// instead of rejecting cleanly.
async function foreignSchemaObjectsRejected(): Promise<void> {
  const indexCollision = new NodeSqliteDriver();
  indexCollision.execScript(`
    CREATE TABLE scratchpad (id TEXT PRIMARY KEY);
    CREATE INDEX downloads_state_idx ON scratchpad(id);
  `);
  const indexInit = await new SqliteStorage(indexCollision, SETTINGS).initialize(
    ctx().context,
  );
  assert(
    !indexInit.ok && indexInit.error.kind === 'invalid-response',
    'foreign index named like a migration index rejected at initialize',
  );
  indexCollision.close();

  const shadow = new NodeSqliteDriver();
  shadow.execScript(`CREATE TABLE likes_new (id TEXT PRIMARY KEY)`);
  const shadowInit = await new SqliteStorage(shadow, SETTINGS).initialize(
    ctx().context,
  );
  assert(
    !shadowInit.ok && shadowInit.error.kind === 'invalid-response',
    'foreign table shadowing a migration throwaway rejected',
  );
  shadow.close();
}

// 24. Unrelated user tables outside the schema's names are
// tolerated: only a collision with a table this schema owns is
// rejected.
async function unrelatedTablesTolerated(): Promise<void> {
  const driver = new NodeSqliteDriver();
  driver.execScript(`
    CREATE TABLE scratchpad (note TEXT);
    INSERT INTO scratchpad VALUES ('keep me');
  `);
  const storage = new SqliteStorage(driver, SETTINGS);
  const init = await storage.initialize(ctx().context);
  assert(init.ok, 'unrelated tables do not block initialize');
  driver.close();
}

// 18. Import resets the rows that foreign-key into the replaced
// recordings (queue occurrences, lyrics cache); attempt traces and
// the artwork cache have no such keys and survive untouched.
async function importResetsExcluded(): Promise<void> {
  const { driver, storage } = rig();
  const sections = ownedSections();
  const queue: QueueSnapshot = {
    revision: 3,
    occurrences: [occurrence('o1', 'r1', ref('youtube-music', 'y1'))],
    currentOccurrenceId: 'o1',
    positionMs: 800,
    mode: 'playing',
  };
  const committed = await storage.commit(
    {
      ...sections,
      queue,
      settings: SETTINGS,
      attempts: [trace('t-keep')],
    },
    ctx().context,
  );
  assert(committed.ok);
  const doc: ExportDocument = {
    formatVersion: 1,
    exportedAtMs: 2,
    recordings: [
      {
        id: 'r9',
        title: 'Replacement',
        artist: null,
        album: null,
        durationMs: null,
        releaseYear: null,
        artwork: [],
        explicit: null,
        genre: null,
        isrc: null,
        versionLabels: [],
        provenance: 'provider',
      },
    ],
    sourceRefs: [{ recordingId: 'r9', ref: ref('itunes', 'i9') }],
    mappings: [],
    likes: [],
    entities: [],
    entitySourceRefs: [],
    playlists: [],
    playlistEntries: [],
    playHistory: [],
    playCounts: [],
    matchReviews: [],
    settings: { ...SETTINGS, theme: 'dark' },
  };
  const imported = await storage.importOwned(doc, ctx().context);
  assert(imported.ok, 'import resolves');
  const after = await loadOk(storage);
  assertDeepEqual(after.recordings.map((r) => r.id), ['r9']);
  assertDeepEqual(
    after.queue,
    {
      revision: 4,
      occurrences: [],
      currentOccurrenceId: null,
      positionMs: 0,
      mode: 'stopped',
    },
    'queue reset to an empty stopped session',
  );
  assertDeepEqual(after.lyricsCache, [], 'lyrics cache cleared');
  assertDeepEqual(
    after.artworkCache,
    sections.artworkCache,
    'artwork cache untouched',
  );
  assertEqual(after.settings.theme, 'dark', 'document settings land');
  const traces = await storage.loadAttempts(10, ctx().context);
  assert(traces.ok);
  assertDeepEqual(
    traces.value.map((t) => t.requestId),
    ['t-keep'],
    'attempt traces untouched',
  );
  driver.close();
}

function download(
  recordingId: string,
  overrides: Partial<DownloadRecord> = {},
): DownloadRecord {
  return {
    downloadId: `dl-${recordingId}`,
    recordingId,
    provider: 'itunes',
    sourceRef: ref('itunes', 'i1'),
    filePath: `/downloads/${recordingId}.m4a`,
    bytes: 4_194_304,
    state: 'available',
    committedOffset: 4_194_304,
    checksum: 'a'.repeat(64),
    mime: 'audio/mp4',
    itag: 140,
    expiresAtMs: 500_000,
    error: null,
    priority: 2,
    requestedMs: 100,
    downloadedMs: 200,
    ...overrides,
  };
}

// 15. v2 -> v3 migration: pre-existing rows survive, ALTERed columns
// take their defaults, and the new tables accept rows.
async function migrationV2toV3(): Promise<void> {
  const driver = new NodeSqliteDriver();
  driver.execScript(`${MIGRATIONS[0]?.join(';\n') ?? ''};`);
  driver.execScript(`${MIGRATIONS[1]?.join(';\n') ?? ''};`);
  driver.execScript(`
    INSERT INTO schema_version (id, version) VALUES (1, 2);
    INSERT INTO settings (id, catalog_provider, playback_provider, storefront, quality_kbps, theme, prefetch, lyrics_provider, radio_provider, artwork_cache_bytes)
      VALUES (1, 'itunes', 'youtube-music', 'US', 256, 'system', 1, NULL, NULL, NULL);
    INSERT INTO queue_state (id, revision, current_occurrence_id, position_ms, mode, blocked_error_json)
      VALUES (1, 0, NULL, 0, 'stopped', NULL);
    INSERT INTO recordings (id, title, artist, album, duration_ms, release_year, artwork_json, explicit, genre, isrc, version_labels_json)
      VALUES ('r1', 'Song r1', 'Artist', 'Album', 300000, 2020, '[]', NULL, 'Rock', NULL, '[]');
    INSERT INTO source_refs (recording_id, ordinal, provider, kind, source_id)
      VALUES ('r1', 0, 'itunes', 'track', 'i1');
  `);
  const storage = new SqliteStorage(driver, SETTINGS);
  assert((await storage.initialize(ctx().context)).ok, 'v2 -> v3 runs');
  const state = await loadOk(storage);
  assertEqual(state.recordings.length, 1);
  assertEqual(
    state.recordings[0]?.provenance,
    'provider',
    'pre-slice-3 rows are provider-sourced',
  );
  assertEqual(
    state.settings.downloadMetered,
    undefined,
    'metered downloads default off',
  );
  assertDeepEqual(state.downloads, []);
  assertDeepEqual(state.localSources, []);
  assertDeepEqual(state.localFiles, []);
  const versions = await driver.transaction(async (conn) =>
    conn.query('SELECT version FROM schema_version WHERE id = 1'),
  );
  assertEqual(versions[0]?.['version'], CURRENT_SCHEMA_VERSION);
  driver.close();
}

// 16. downloads + local_sources + local_files round-trip through
// commit/load; a recording rewrite cascades its dependents; an
// interrupted write rolls back.
async function downloadLocalRoundtrip(): Promise<void> {
  const { driver, failing, storage } = rig();
  const recordings = [
    recording('r1', [ref('itunes', 'i1')]),
    recording('r2', [ref('local', 'lf-1')], [], { provenance: 'local' }),
  ];
  assert(
    (await storage.commit({ recordings }, ctx().context)).ok,
    'recordings commit',
  );
  const sources: LocalSource[] = [
    {
      sourceId: 'src-1',
      treeUri: 'content://tree/music',
      label: 'Music',
      addedMs: 10,
      lastScanMs: null,
    },
  ];
  const files: LocalFile[] = [
    {
      fileId: 'lf-1',
      sourceId: 'src-1',
      docId: 'doc-42',
      size: 4_194_304,
      fingerprint: 'fp-abc',
      modifiedMs: 1_700_000_000_000,
      title: 'Local Song',
      artist: null,
      album: null,
      durationMs: null,
      genre: null,
      recordingId: 'r2',
    },
  ];
  const downloads: DownloadRecord[] = [
    download('r1'),
    download('r2', {
      downloadId: 'dl-r2',
      provider: 'local',
      sourceRef: ref('local', 'lf-1'),
      filePath: '/downloads/lf-1.flac',
      state: 'transferring',
      committedOffset: 1_048_576,
      checksum: null,
      downloadedMs: null,
      error: null,
    }),
  ];
  const committed = await storage.commit(
    { downloads, localSources: sources, localFiles: files },
    ctx().context,
  );
  assert(committed.ok, 'download/local sections commit');
  const state = await loadOk(storage);
  assertDeepEqual(state.downloads, downloads, 'downloads round-trip');
  assertDeepEqual(state.localSources, sources, 'sources round-trip');
  assertDeepEqual(state.localFiles, files, 'files round-trip');
  // A recording rewrite that orphans a download row fails validation —
  // dependents must be rewritten consistently inside the batch.
  const dangling = await storage.commit(
    { recordings: [recordings[1]!] },
    ctx().context,
  );
  assert(!dangling.ok, 'dangling download recording_id rejected');
  const rescoped = await storage.commit(
    {
      recordings: [recordings[1]!],
      downloads: [downloads[1]!],
      localSources: sources,
      localFiles: files,
    },
    ctx().context,
  );
  assert(rescoped.ok, 'consistent subset commit');
  const after = await loadOk(storage);
  assertEqual(
    after.recordings.length,
    1,
    'recordings section replaced wholesale',
  );
  assertDeepEqual(after.downloads, [downloads[1]!], 'downloads cascade');
  assertDeepEqual(after.localFiles, files, 'local files cascade');
  // An interrupted write mid-insert rolls back the whole commit:
  // execute 1 is the downloads DELETE, execute 2 the download INSERT.
  const base = await loadOk(storage);
  failing.failBeforeExecute(2);
  const failed = await storage.commit(
    { downloads: [download('r2', { downloadId: 'dl-x' })] },
    ctx().context,
  );
  assert(!failed.ok, 'injected mid-write failure surfaces');
  const restored = await loadOk(storage);
  assertDeepEqual(restored, base, 'interrupted write rolls back');
  driver.close();
}

// 17. v3 -> v4: local_files gains modified_ms; pre-existing rows
// read back with a null stamp.
async function migrationV3toV4(): Promise<void> {
  const driver = new NodeSqliteDriver();
  driver.execScript(`${MIGRATIONS[0]?.join(';\n') ?? ''};`);
  driver.execScript(`${MIGRATIONS[1]?.join(';\n') ?? ''};`);
  driver.execScript(`${MIGRATIONS[2]?.join(';\n') ?? ''};`);
  driver.execScript(`
    INSERT INTO schema_version (id, version) VALUES (1, 3);
    INSERT INTO settings (id, catalog_provider, playback_provider, storefront, quality_kbps, theme, prefetch, lyrics_provider, radio_provider, artwork_cache_bytes, download_metered)
      VALUES (1, 'a', 'b', NULL, 256, 'dark', 1, NULL, NULL, NULL, 0);
    INSERT INTO queue_state (id, revision, current_occurrence_id, position_ms, mode, blocked_error_json)
      VALUES (1, 0, NULL, 0, 'stopped', NULL);
    INSERT INTO recordings (id, title, artist, album, duration_ms, release_year, artwork_json, explicit, genre, isrc, version_labels_json, provenance)
      VALUES ('r1', 'Local Song', 'A', NULL, 9000, NULL, '[]', NULL, NULL, NULL, '[]', 'local');
    INSERT INTO source_refs (recording_id, ordinal, provider, kind, source_id)
      VALUES ('r1', 0, 'local', 'track', 'lf-1');
    INSERT INTO local_sources (source_id, tree_uri, label, added_ms, last_scan_ms)
      VALUES ('src-1', 'content://tree/music', 'Music', 10, NULL);
    INSERT INTO local_files (file_id, source_id, doc_id, size, fingerprint, title, artist, album, duration_ms, genre, recording_id)
      VALUES ('lf-1', 'src-1', 'doc-42', 4096, 'fp-abc', 'Local Song', NULL, NULL, 9000, NULL, 'r1');
  `);
  const storage = new SqliteStorage(driver, SETTINGS);
  assert((await storage.initialize(ctx().context)).ok, 'v3 -> v4 runs');
  const state = await loadOk(storage);
  assertEqual(state.localFiles.length, 1, 'row migrated');
  assertEqual(
    state.localFiles[0]?.modifiedMs,
    null,
    'pre-v4 rows carry no stamp',
  );
  const versions = await driver.transaction(async (conn) =>
    conn.query('SELECT version FROM schema_version WHERE id = 1'),
  );
  assertEqual(versions[0]?.['version'], CURRENT_SCHEMA_VERSION);
  driver.close();
}

// 18. `recordingsMerge` applies to the transaction's fresh read —
// rows written between a caller's snapshot and its commit survive.
async function recordingsMergeCommit(): Promise<void> {
  const { driver, storage } = rig();
  const r1 = recording('r1', [ref('itunes', 'i1')]);
  const r2 = recording('r2', [ref('local', 'lf-1')], [], {
    provenance: 'local',
  });
  assert((await storage.commit({ recordings: [r1] }, ctx().context)).ok);
  const committed = await storage.commit(
    { recordingsMerge: (current) => [...current, r2] },
    ctx().context,
  );
  assert(committed.ok, 'merge commit ok');
  const state = await loadOk(storage);
  assertEqual(state.recordings.length, 2, 'merge appended over fresh');
  assert(
    state.recordings.some((r) => r.id === 'r2'),
    'merged row present',
  );
  // Both forms in one batch is a caller bug — rejected, not
  // silently resolved.
  const both = await storage.commit(
    { recordings: [r1], recordingsMerge: (current) => current },
    ctx().context,
  );
  assert(
    !both.ok && both.error.kind === 'internal',
    'recordings + recordingsMerge rejected',
  );
  driver.close();
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['concurrentOperations', concurrentOperations],
  ['initializeAndCoalesce', initializeAndCoalesce],
  ['fullRoundtrip', fullRoundtrip],
  ['commitRollback', commitRollback],
  ['cancellationRollback', cancellationRollback],
  ['migrationFailureRetry', migrationFailureRetry],
  ['malformedRows', malformedRows],
  ['corruptedRelations', corruptedRelations],
  ['schemaVersionEdges', schemaVersionEdges],
  ['attemptTraces', attemptTraces],
  ['sectionScopedCommits', sectionScopedCommits],
  ['sharedDriverVisibility', sharedDriverVisibility],
  ['cancelledBoundaries', cancelledBoundaries],
  ['coalescedCancel', coalescedCancel],
  ['parameterization', parameterization],
  ['migrationV1toV2', migrationV1toV2],
  ['sharedDriverInitialize', sharedDriverInitialize],
  ['migrationBackupFile', migrationBackupFile],
  ['migrationV2toV3', migrationV2toV3],
  ['migrationV3toV4', migrationV3toV4],
  ['downloadLocalRoundtrip', downloadLocalRoundtrip],
  ['recordingsMergeCommit', recordingsMergeCommit],
  ['backupRetryAfterFailure', backupRetryAfterFailure],
  ['ownedRoundtrip', ownedRoundtrip],
  ['exportImportRoundtrip', exportImportRoundtrip],
  ['importAtomicity', importAtomicity],
  ['importResetsExcluded', importResetsExcluded],
  ['sharedDriverTransactions', sharedDriverTransactions],
  ['exportOwnedUnsafeTimestamp', exportOwnedUnsafeTimestamp],
  ['entityKindCrossCheck', entityKindCrossCheck],
  ['foreignSchemaRejected', foreignSchemaRejected],
  ['foreignNewestTablesRejected', foreignNewestTablesRejected],
  ['foreignSchemaObjectsRejected', foreignSchemaObjectsRejected],
  ['unrelatedTablesTolerated', unrelatedTablesTolerated],
];

for (const [name, fn] of TESTS) {
  try {
    await fn();
  } catch (thrown) {
    throw new Error(`storage test failed: ${name}`, { cause: thrown });
  }
}
