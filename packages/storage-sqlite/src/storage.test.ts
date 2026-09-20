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
  TrackLike,
} from '@auqw/application';
import { assert, assertDeepEqual, assertEqual } from '@auqw/application/testing';
import { CURRENT_SCHEMA_VERSION } from './migrations.ts';
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
  assertEqual(failing.transactions, 1, 'one migration transaction');
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
  const likes: TrackLike[] = [
    { recordingId: 'r1', likedAtMs: 7 },
    { recordingId: 'r2', likedAtMs: 9 },
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
  // Commit txn executes: 6 deletes, then inserts — fail mid-inserts.
  failing.failBeforeExecute(8);
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
  // Mid-commit: the hook cancels at statement 10 (inside deletes).
  const { context: midCtx, source: mid } = ctx();
  failing.hookAtStatement(10, () => mid.cancel());
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
            likes: [{ recordingId: 'r1', likedAtMs: 1 }],
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
      'wrong like kind',
      `DROP TABLE likes;
       CREATE TABLE likes (entity_kind TEXT, entity_id TEXT, liked_at_ms INTEGER);
       INSERT INTO likes VALUES ('track', 'r1', 1), ('album', 'r1', 2)`,
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
    driver.execScript('UPDATE schema_version SET version = 2 WHERE id = 1');
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
  assertEqual(failing.transactions, 1, 'still one migration transaction');
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
];

for (const [name, fn] of TESTS) {
  try {
    await fn();
  } catch (thrown) {
    throw new Error(`storage test failed: ${name}`, { cause: thrown });
  }
}
