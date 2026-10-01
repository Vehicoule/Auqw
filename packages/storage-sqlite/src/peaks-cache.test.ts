import { assert, assertEqual } from '@auqw/application/testing';
import { CancellationSource } from '@auqw/application';
import type { OperationContext, Settings } from '@auqw/application';
import { CANCELLED } from './driver.ts';
import type { SqliteDriver } from './driver.ts';
import { SqliteStorage } from './storage.ts';
import { createPeaksCacheStore } from './peaks-cache.ts';
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
    requestId: 'peaks-cache-test',
    deadlineMs: Number.MAX_SAFE_INTEGER,
    signal: new CancellationSource().signal,
  };
}

const row = (up: number, down: number) => ({ up, down });
const profile = (n: number, up = 0.5) =>
  Array.from({ length: n }, () => row(up, up));

async function store() {
  const driver = new NodeSqliteDriver();
  const storage = new SqliteStorage(driver, SETTINGS);
  // `load` runs the migrations — peaks_cache exists after it.
  const loaded = await storage.load(ctx());
  assert(loaded.ok, 'storage initializes for the peaks table');
  return createPeaksCacheStore(driver);
}

const TESTS: [string, () => Promise<void>][] = [
  [
    'roundTrip',
    async () => {
      const peaks = store();
      const saved = profile(256, 0.7);
      await (await peaks).save('rec-1', saved);
      const loaded = await (await peaks).load('rec-1');
      assertEqual(loaded?.length, 256, 'the saved profile loads back');
      assertEqual(loaded?.[0]?.up, 0.7, 'values round-trip');
    },
  ],
  [
    'missIsNull',
    async () => {
      const loaded = await (await store()).load('rec-absent');
      assertEqual(loaded, null, 'a missing row is null, not an error');
    },
  ],
  [
    'overwrite',
    async () => {
      const peaks = await store();
      await peaks.save('rec-2', profile(256, 0.1));
      await peaks.save('rec-2', profile(256, 0.9));
      const loaded = await peaks.load('rec-2');
      assertEqual(loaded?.[0]?.up, 0.9, 'the newest write wins');
    },
  ],
  [
    'lruPrunes',
    async () => {
      const peaks = await store();
      for (let i = 0; i < 260; i++) {
        await peaks.save(`rec-${i}`, profile(4));
      }
      const first = await peaks.load('rec-0');
      const last = await peaks.load('rec-259');
      assertEqual(first, null, 'the oldest row evicts past the cap');
      assert(last !== null, 'the newest row survives');
    },
  ],
  [
    'lruReadsRefreshRecency',
    async () => {
      const driver = new NodeSqliteDriver();
      const storage = new SqliteStorage(driver, SETTINGS);
      const loaded = await storage.load(ctx());
      assert(loaded.ok, 'storage initializes');
      let tick = 0;
      const peaks = createPeaksCacheStore(driver, () => ++tick);
      await peaks.save('cold-a', profile(4));
      await peaks.save('hot', profile(4));
      await peaks.save('cold-b', profile(4));
      for (let i = 0; i < 253; i++) {
        await peaks.save(`cold-${i}`, profile(4));
      }
      // At capacity now; the hot row is the oldest after 'cold-a' has
      // already evicted — reads alone keep it alive.
      await peaks.load('hot');
      for (let i = 0; i < 5; i++) {
        await peaks.save(`cold-new-${i}`, profile(4));
      }
      assert(
        (await peaks.load('hot')) !== null,
        'a row kept hot by reads survives write-age eviction',
      );
      assertEqual(
        await peaks.load('cold-b'),
        null,
        'an untouched older row still evicts',
      );
    },
  ],
  [
    'queuesOnTheSharedDriverTail',
    async () => {
      const inner = new NodeSqliteDriver();
      const storage = new SqliteStorage(inner, SETTINGS);
      const loaded = await storage.load(ctx());
      assert(loaded.ok, 'storage initializes');
      // One driver is one connection: count overlapping transactions
      // the way a driver without JS-level serialization (the expo
      // driver) would experience them.
      let inFlight = 0;
      let maxInFlight = 0;
      const counting: SqliteDriver = {
        transaction: (work, signal) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return inner
            .transaction(work, signal)
            .finally(() => {
              inFlight -= 1;
            });
        },
        backup: (tag) => inner.backup(tag),
        dropBackup: (tag) => inner.dropBackup(tag),
      };
      const peaks = createPeaksCacheStore(counting);
      // Hold a queued transaction open — the spot a SqliteStorage
      // commit or a sync-log append occupies when a peaks op races it.
      let release!: () => void;
      const held = enqueueDriverTransaction(
        counting,
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        ctx().signal,
        (signal) => {
          if (signal.cancelled) {
            throw CANCELLED;
          }
        },
      );
      // A couple of microtask turns lets the held transaction open —
      // BEGIN ran, work is parked on the gate — before the racer fires.
      await Promise.resolve();
      await Promise.resolve();
      const saving = peaks.save('rec-held', profile(4));
      await Promise.resolve();
      await Promise.resolve();
      assertEqual(
        maxInFlight,
        1,
        'a peaks op queues behind an open transaction on the same driver',
      );
      release();
      await held;
      await saving;
      assert(
        (await peaks.load('rec-held')) !== null,
        'the queued save still lands',
      );
    },
  ],
  [
    'corruptRowIsNull',
    async () => {
      const driver = new NodeSqliteDriver();
      const storage = new SqliteStorage(driver, SETTINGS);
      const loaded = await storage.load(ctx());
      assert(loaded.ok, 'storage initializes');
      await driver.transaction((conn) =>
        conn.execute(
          `INSERT INTO peaks_cache (recording_id, peaks_json, fetched_ms)
           VALUES ('rec-bad', 'not json', 1)`,
        ),
      );
      const peaks = createPeaksCacheStore(driver);
      assertEqual(
        await peaks.load('rec-bad'),
        null,
        'a corrupt row degrades to a miss, never a throw',
      );
    },
  ],
];

for (const [name, fn] of TESTS) {
  try {
    await fn();
  } catch (thrown) {
    throw new Error(`peaks-cache test failed: ${name}`, { cause: thrown });
  }
}
