import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource } from '@auqw/application';
import type {
  AttemptTrace,
  MatchEvidence,
  OperationContext,
  PersistedState,
  QueueOccurrence,
  QueueSnapshot,
  Recording,
  Settings,
  SourceMapping,
  SourceRef,
  Like,
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
  const versions = await driver.transaction(async (conn) =>
    conn.query('SELECT version FROM schema_version WHERE id = 1'),
  );
  assertEqual(versions[0]?.['version'], CURRENT_SCHEMA_VERSION);
  driver.close();
}

// 14. A file-backed database leaves a real pre-migration image at
// <db>.bak-v1 holding the old rows.
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
    assert(
      existsSync(backupPath),
      'backup file written next to the database',
    );
    const backup = new NodeSqliteDriver(backupPath);
    const likeRows = await backup.transaction(async (conn) =>
      conn.query('SELECT entity_id, liked_at_ms FROM likes'),
    );
    assertDeepEqual(
      likeRows,
      [{ entity_id: 'r1', liked_at_ms: 42 }],
      'backup holds the pre-migration v1 rows',
    );
    const versions = await backup.transaction(async (conn) =>
      conn.query('SELECT version FROM schema_version'),
    );
    assertEqual(versions[0]?.['version'], 1, 'backup stays at v1');
    backup.close();
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
  ['migrationBackupFile', migrationBackupFile],
  ['ownedRoundtrip', ownedRoundtrip],
  ['exportImportRoundtrip', exportImportRoundtrip],
  ['importAtomicity', importAtomicity],
  ['importResetsExcluded', importResetsExcluded],
];

for (const [name, fn] of TESTS) {
  try {
    await fn();
  } catch (thrown) {
    throw new Error(`storage test failed: ${name}`, { cause: thrown });
  }
}
