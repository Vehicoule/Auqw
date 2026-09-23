import { appendFile, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource } from '@auqw/application';
import type {
  ChangeEntry,
  DivergenceEntry,
  OperationContext,
  SyncLogWrite,
} from '@auqw/application';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import { openSyncLogStore } from './sync-log.ts';

/**
 * The JSONL sync-log backing: durable append/load, atomic-ish repair,
 * and the device id that lives in the header. Writes run against a
 * real file — the port's contract is durability, so the test must
 * survive reopen.
 */

function ctx(): OperationContext {
  const source = new CancellationSource();
  return {
    requestId: 't-1',
    deadlineMs: Number.MAX_SAFE_INTEGER,
    signal: source.signal,
  };
}

function entry(seq: number, device = 'dsk-peer'): ChangeEntry {
  return {
    kind: 'playlist',
    recordId: `pl-${seq}`,
    field: 'name',
    value: `playlist ${seq}`,
    tombstone: false,
    hlc: { l: 1_000 + seq, c: 0 },
    deviceId: device,
    seq,
  };
}

function divergence(seq: number): DivergenceEntry {
  return {
    historyId: `h-${seq}`,
    seq,
    kind: 'playlist',
    recordId: `pl-${seq}`,
    field: 'name',
    loser: {
      deviceId: 'dsk-b',
      hlc: { l: 2, c: 0 },
      tombstone: false,
      value: 'old',
    },
    winner: {
      deviceId: 'dsk-a',
      hlc: { l: 3, c: 0 },
      tombstone: false,
      value: 'new',
    },
    observedMs: 1_000,
    origin: 'local',
  };
}

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'auqw-sync-log-'));
}

export async function run(): Promise<void> {
  // —— A missing file mints the header + device id ——
  {
    const dir = await freshDir();
    const path = join(dir, 'sync-log.jsonl');
    const opened = await openSyncLogStore(path);
    assert(opened.ok, `open failed: ${JSON.stringify(opened)}`);
    if (!opened.ok) {
      return;
    }
    assertEqual(opened.value.repaired, false);
    assert(
      /^dsk-[0-9a-f]{32}$/.test(opened.value.deviceId),
      `device id shape: ${opened.value.deviceId}`,
    );
    const raw = await readFile(path, 'utf8');
    const header: unknown = JSON.parse(raw.split('\n')[0] ?? '');
    assertDeepEqual(header, { v: 1, deviceId: opened.value.deviceId });
    const loaded = await opened.value.store.load(ctx());
    assert(loaded.ok);
    if (loaded.ok) {
      assertDeepEqual(loaded.value, {
        entries: [],
        divergence: [],
        watermarks: {},
      });
    }
  }

  // —— Appends survive reopen and fold into the snapshot ——
  {
    const dir = await freshDir();
    const path = join(dir, 'sync-log.jsonl');
    const first = await openSyncLogStore(path);
    assert(first.ok);
    if (!first.ok) {
      return;
    }
    const write: SyncLogWrite = {
      entries: [entry(1), entry(2)],
      divergence: [divergence(5)],
      watermarks: { 'dsk-peer': 2, 'dsk-self': 1 },
    };
    const appended = await first.value.store.append(write, ctx());
    assert(appended.ok, `append failed: ${JSON.stringify(appended)}`);

    const reopened = await openSyncLogStore(path);
    assert(reopened.ok);
    if (!reopened.ok) {
      return;
    }
    // The id survives reopen — it lives in the header, not the process.
    assertEqual(reopened.value.deviceId, first.value.deviceId);
    const loaded = await reopened.value.store.load(ctx());
    assert(loaded.ok);
    if (loaded.ok) {
      assertEqual(loaded.value.entries.length, 2);
      assertEqual(loaded.value.divergence.length, 1);
      assertDeepEqual(loaded.value.watermarks, {
        'dsk-peer': 2,
        'dsk-self': 1,
      });
    }
  }

  // —— Watermarks fold per-device max; the floor drops divergence ——
  {
    const dir = await freshDir();
    const path = join(dir, 'sync-log.jsonl');
    const opened = await openSyncLogStore(path);
    assert(opened.ok);
    if (!opened.ok) {
      return;
    }
    const writes: SyncLogWrite[] = [
      { watermarks: { 'dsk-a': 2, 'dsk-b': 1 } },
      {
        watermarks: { 'dsk-a': 5 },
        divergence: [divergence(1), divergence(4)],
        dropDivergenceBefore: 3,
      },
      { divergence: [divergence(7)], dropDivergenceBefore: 4 },
    ];
    for (const write of writes) {
      const appended = await opened.value.store.append(write, ctx());
      assert(appended.ok);
    }
    const loaded = await opened.value.store.load(ctx());
    assert(loaded.ok);
    if (loaded.ok) {
      assertDeepEqual(loaded.value.watermarks, { 'dsk-a': 5, 'dsk-b': 1 });
      // The floor drops seqs strictly below it: seq 1 went with the
      // first floor, seqs 4+ survive the raised floor.
      assertDeepEqual(
        loaded.value.divergence.map((row) => row.seq),
        [4, 7],
      );
      assertEqual(loaded.value.divergenceFloor, 4);
    }
  }

  // —— A torn tail truncates at the first invalid line ——
  {
    const dir = await freshDir();
    const path = join(dir, 'sync-log.jsonl');
    const opened = await openSyncLogStore(path);
    assert(opened.ok);
    if (!opened.ok) {
      return;
    }
    const good = await opened.value.store.append(
      { entries: [entry(1)] },
      ctx(),
    );
    assert(good.ok);
    // Simulate a crash mid-append: a half-written line, then (oddly)
    // bytes after it. Repair keeps only the committed prefix.
    await appendFile(path, '{"entries":[{"kind":"pla', 'utf8');
    await appendFile(path, '\n{"watermarks":{"dsk-x":9}}\n', 'utf8');
    const repaired = await openSyncLogStore(path);
    assert(repaired.ok);
    if (!repaired.ok) {
      return;
    }
    assertEqual(repaired.value.repaired, true);
    assertEqual(repaired.value.deviceId, opened.value.deviceId);
    const loaded = await repaired.value.store.load(ctx());
    assert(loaded.ok);
    if (loaded.ok) {
      assertEqual(loaded.value.entries.length, 1);
      assertDeepEqual(loaded.value.watermarks, {});
    }
  }

  // —— A foreign file moves aside; a fresh log mints a fresh id ——
  {
    const dir = await freshDir();
    const path = join(dir, 'sync-log.jsonl');
    await writeFile(path, '{"v":9,"junk":true}\n{"entries":[]}\n', 'utf8');
    const opened = await openSyncLogStore(path);
    assert(opened.ok);
    if (!opened.ok) {
      return;
    }
    assertEqual(opened.value.repaired, true);
    const names = await readdir(dir);
    assert(
      names.some((name) => name.startsWith('sync-log.jsonl.corrupt-')),
      `foreign file renamed aside: ${names.join(',')}`,
    );
    // The NEW file parses and answers an empty snapshot.
    const loaded = await opened.value.store.load(ctx());
    assert(loaded.ok);
    if (loaded.ok) {
      assertEqual(loaded.value.entries.length, 0);
    }
  }

  // —— Concurrent appends serialize in issue order ——
  {
    const dir = await freshDir();
    const path = join(dir, 'sync-log.jsonl');
    const opened = await openSyncLogStore(path);
    assert(opened.ok);
    if (!opened.ok) {
      return;
    }
    const seqs = [1, 2, 3, 4, 5];
    await Promise.all(
      seqs.map((seq) =>
        opened.value.store.append({ entries: [entry(seq)] }, ctx()),
      ),
    );
    const loaded = await opened.value.store.load(ctx());
    assert(loaded.ok);
    if (loaded.ok) {
      assertDeepEqual(
        loaded.value.entries.map((e) => e.seq),
        seqs,
      );
    }
  }

  // —— A cancelled append declines without touching the tail ——
  {
    const dir = await freshDir();
    const path = join(dir, 'sync-log.jsonl');
    const opened = await openSyncLogStore(path);
    assert(opened.ok);
    if (!opened.ok) {
      return;
    }
    const cancelled = new CancellationSource();
    cancelled.cancel();
    const result = await opened.value.store.append(
      { entries: [entry(1)] },
      {
        requestId: 't-2',
        deadlineMs: Number.MAX_SAFE_INTEGER,
        signal: cancelled.signal,
      },
    );
    assert(!result.ok);
    if (!result.ok) {
      assertEqual(result.error.kind, 'cancelled');
    }
  }

  console.log('sync-log tests passed');
}
