import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import { CancellationSource } from '@auqw/application';
import type { OperationContext, Settings } from '@auqw/application';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from './storage.ts';
import { createSearchHistoryStore } from './search-history.ts';
import { CANCELLED } from './driver.ts';
import { enqueueDriverTransaction } from './transaction-queue.ts';
import { NodeSqliteDriver } from './testing/node-sqlite-driver.ts';

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: 'US',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
};

function ctx(): OperationContext {
  return {
    requestId: 'search-history-test',
    deadlineMs: Number.MAX_SAFE_INTEGER,
    signal: new CancellationSource().signal,
  };
}

// `load` runs the migrations — search_history exists after it.
async function migrated(driver: NodeSqliteDriver) {
  const storage = new SqliteStorage(driver, SETTINGS);
  const loaded = await storage.load(ctx());
  assert(loaded.ok, 'storage initializes for the search_history table');
  return createSearchHistoryStore(driver);
}

const TESTS: [string, () => Promise<void>][] = [
  [
    'emptyLoad',
    async () => {
      const driver = new NodeSqliteDriver();
      const recents = await migrated(driver);
      assertDeepEqual(await recents.load(), [], 'a fresh store loads empty');
    },
  ],
  [
    'roundTripNewestFirst',
    async () => {
      const driver = new NodeSqliteDriver();
      const recents = await migrated(driver);
      await recents.record('daft punk');
      await recents.record('justice');
      assertDeepEqual(
        await recents.load(),
        ['justice', 'daft punk'],
        'the newest record leads the list',
      );
    },
  ],
  [
    'reRecordFloatsToTop',
    async () => {
      const driver = new NodeSqliteDriver();
      const recents = await migrated(driver);
      await recents.record('a');
      await recents.record('b');
      await recents.record('a');
      assertDeepEqual(
        await recents.load(),
        ['a', 'b'],
        'a re-search dedupes and moves to the head',
      );
    },
  ],
  [
    'capBoundsTheList',
    async () => {
      const driver = new NodeSqliteDriver();
      const recents = await migrated(driver);
      for (let i = 0; i < 12; i += 1) {
        await recents.record(`q-${i}`);
      }
      const loaded = await recents.load();
      assertEqual(loaded.length, 8, 'the rail stays bounded');
      assertDeepEqual(
        loaded[0],
        'q-11',
        'the newest entry survives the prune',
      );
      assert(
        !loaded.includes('q-0'),
        'the oldest entry evicts past the cap',
      );
    },
  ],
  [
    'blankIsANoOp',
    async () => {
      const driver = new NodeSqliteDriver();
      const recents = await migrated(driver);
      await recents.record('   ');
      await recents.record('');
      assertDeepEqual(
        await recents.load(),
        [],
        'blank input never reaches a row',
      );
    },
  ],
  [
    'trimsBeforeCommit',
    async () => {
      const driver = new NodeSqliteDriver();
      const recents = await migrated(driver);
      await recents.record('  air  ');
      assertDeepEqual(
        await recents.load(),
        ['air'],
        'the persisted text is the submitted text',
      );
    },
  ],
  [
    // The user's reported failure: relaunch shows an empty rail.
    'persistsAcrossRestart',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'auqw-recents-'));
      try {
        const file = join(dir, 'library.db');
        const first = new NodeSqliteDriver(file);
        const recents1 = await migrated(first);
        await recents1.record('boards of canada');
        await recents1.record('aphex twin');
        first.close();
        // Cold restart: a NEW driver + store over the same file —
        // nothing in memory survives.
        const second = new NodeSqliteDriver(file);
        const storage = new SqliteStorage(second, SETTINGS);
        const loaded = await storage.load(ctx());
        assert(loaded.ok, 'the reopened file still initializes');
        const recents2 = createSearchHistoryStore(second);
        assertDeepEqual(
          await recents2.load(),
          ['aphex twin', 'boards of canada'],
          'the relaunched store hydrates the persisted rail',
        );
        second.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    // A long domain commit holds the shared connection's BEGIN
    // IMMEDIATE; the record must queue behind it, not collide
    // and get swallowed by the store's catch.
    'recordQueuesBehindAnOpenTransaction',
    async () => {
      const driver = new NodeSqliteDriver();
      const recents = await migrated(driver);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const signal = new CancellationSource().signal;
      const open = enqueueDriverTransaction(
        driver,
        () => gate,
        signal,
        (s) => {
          if (s.cancelled) throw CANCELLED;
        },
      );
      // The transaction is demonstrably open (gate unresolved) when
      // record runs: unqueued, its BEGIN IMMEDIATE would throw inside
      // record's catch and drop the write; queued, `recorded` only
      // settles after `release()` lets the open commit out.
      const recorded = recents.record('overlap');
      release();
      await Promise.all([open, recorded]);
      assertDeepEqual(
        await recents.load(),
        ['overlap'],
        'a queued record survives the collision window',
      );
    },
  ],
  [
    'failureDegradesToEmpty',
    async () => {
      // No migrations ever ran — the table doesn't exist. A miss
      // degrades to an empty list, never a throw.
      const driver = new NodeSqliteDriver();
      const recents = createSearchHistoryStore(driver);
      assertDeepEqual(
        await recents.load(),
        [],
        'a schema-pending database loads empty',
      );
      await recents.record('x');
      assertDeepEqual(
        await recents.load(),
        [],
        'a failed record is a no-op, not a crash',
      );
    },
  ],
];

for (const [name, fn] of TESTS) {
  try {
    await fn();
  } catch (thrown) {
    throw new Error(`search-history test failed: ${name}`, {
      cause: thrown,
    });
  }
}
