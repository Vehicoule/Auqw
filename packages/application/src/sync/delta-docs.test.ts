import { appError, err, ok } from '../errors.ts';
import type { Result } from '../errors.ts';
import { assert, assertDeepEqual, assertEqual } from '../testing/assert.ts';
import { CancellationSource } from '../cancellation.ts';
import {
  MAX_SYNC_DELTA_DOC_BYTES,
  MAX_SYNC_DELTA_TEXT_CHARS,
  collectSyncDeltaDocs,
  exportFittedDeltaDoc,
  parseSyncDeltaDocs,
  serializeSyncDeltaDocs,
} from './delta-docs.ts';
import { createSyncEngine } from './sync-engine.ts';
import type { LocalWrite, SyncCursor, SyncDelta } from './sync-engine.ts';
import { utf8ByteLength } from '../utf8.ts';
import {
  FakeClock,
  FakeLog,
  FakeSyncLogStore,
  SequenceIds,
} from '../testing/fakes.ts';

function doc(
  entries: readonly { deviceId: string; seq: number }[],
  more: boolean,
  skipped: Record<string, readonly number[]> = {},
): SyncDelta {
  return {
    formatVersion: 1,
    senderDeviceId: 'dev-a',
    cursor: {},
    entries: entries.map((e, i) => ({
      deviceId: e.deviceId,
      seq: e.seq,
      hlc: { l: 1_800_000_000_000 + i, c: 0 },
      kind: 'like' as const,
      recordId: `like:${e.deviceId}:${e.seq}`,
      field: 'liked',
      tombstone: false,
      value: true,
    })),
    more,
    skipped,
  };
}

export async function run(): Promise<void> {
  // Single page — no follow-up needed.
  {
    const seen: SyncCursor[] = [];
    const res = await collectSyncDeltaDocs(async (cursor) => {
      seen.push({ ...cursor });
      return ok(doc([{ deviceId: 'a', seq: 1 }], false));
    });
    assert(res.ok && res.value.length === 1, 'one page collects one doc');
    assertDeepEqual(seen, [{}], 'first page ships an empty cursor');
  }

  // Multi-page: coverage advances on the shipped seqs; `more` gates.
  {
    const seen: SyncCursor[] = [];
    const res = await collectSyncDeltaDocs(async (cursor) => {
      seen.push({ ...cursor });
      const pageIndex = seen.length - 1;
      if (pageIndex === 0) {
        return ok(
          doc(
            [
              { deviceId: 'a', seq: 1 },
              { deviceId: 'b', seq: 7 },
            ],
            true,
            { c: [4] },
          ),
        );
      }
      return ok(doc([{ deviceId: 'a', seq: 2 }], false));
    });
    assert(res.ok && res.value.length === 2, 'two pages collect');
    assertDeepEqual(
      seen[1],
      { a: 1, b: 7, c: 4 },
      'skipped seqs advance coverage like shipped ones',
    );
  }

  // A `more` page that advances nothing terminates — no infinite spin.
  {
    let calls = 0;
    const res = await collectSyncDeltaDocs(async () => {
      calls += 1;
      return ok(doc([], true));
    });
    assert(res.ok && calls === 1, 'a static more page stops the walk');
  }

  // Page failure propagates the typed error.
  {
    const failure = appError('unavailable', 'engine absent');
    const res = await collectSyncDeltaDocs(
      async (): Promise<Result<SyncDelta>> => err(failure),
    );
    assert(!res.ok && res.error.kind === 'unavailable', 'page error crosses');
  }

  // Malformed seqs abort the walk rather than mint a wrong cursor.
  {
    const bad = doc([], false);
    const docWithBadSeq = {
      ...bad,
      entries: [{ ...bad.entries, deviceId: 'a', seq: -1 }] as never,
    };
    const res = await collectSyncDeltaDocs(async () => ok(docWithBadSeq));
    assert(!res.ok && res.error.kind === 'invalid-response');
  }

  // A page past the per-doc wire cap aborts — the IPC side would
  // reject it anyway, so the batch never ships it.
  {
    const base = doc([{ deviceId: 'a', seq: 1 }], false);
    const oversized = {
      ...base,
      entries: base.entries.map((e) => ({
        ...e,
        value: 'x'.repeat(MAX_SYNC_DELTA_DOC_BYTES),
      })),
    };
    const res = await collectSyncDeltaDocs(async () => ok(oversized));
    assert(
      !res.ok && res.error.kind === 'invalid-response',
      'an over-cap page fails the export',
    );
  }

  // Pages that keep advancing past the batch cap stop with a typed
  // budget error — shipping more would mint an unimportable payload.
  {
    let calls = 0;
    const res = await collectSyncDeltaDocs(async () => {
      calls += 1;
      const base = doc([{ deviceId: 'a', seq: calls }], true);
      return ok({
        ...base,
        entries: base.entries.map((e) => ({
          ...e,
          value: 'x'.repeat(900_000),
        })),
      });
    });
    assert(
      !res.ok && res.error.kind === 'budget-exceeded' && calls < 64,
      'a ballooning batch hits the byte budget',
    );
  }

  // Serialization: one doc ships bare, many ship as an array.
  {
    const single = doc([{ deviceId: 'a', seq: 1 }], false);
    assertEqual(
      serializeSyncDeltaDocs([single]),
      JSON.stringify(single),
      'a single doc ships unwrapped',
    );
    const two = [single, doc([{ deviceId: 'a', seq: 2 }], false)];
    assertEqual(
      serializeSyncDeltaDocs(two),
      JSON.stringify(two),
      'multiple docs ship as an array',
    );
  }

  // Parse: single doc, doc array, and the failure modes.
  {
    const single = doc([{ deviceId: 'a', seq: 1 }], false);
    const parsed = parseSyncDeltaDocs(JSON.stringify(single));
    assert(parsed !== null && parsed.length === 1, 'single doc parses');
    const multi = parseSyncDeltaDocs(JSON.stringify([single, single]));
    assert(multi !== null && multi.length === 2, 'doc array parses');
    assertEqual(parseSyncDeltaDocs(''), null);
    assertEqual(parseSyncDeltaDocs('not json'), null);
    assertEqual(parseSyncDeltaDocs('{"formatVersion":2}'), null);
    assertEqual(parseSyncDeltaDocs('[1,2]'), null);
    assertEqual(parseSyncDeltaDocs('[]'), null, 'an empty array imports nothing');
    assertEqual(
      parseSyncDeltaDocs('x'.repeat(MAX_SYNC_DELTA_TEXT_CHARS + 1)),
      null,
      'oversized text never reaches JSON.parse',
    );
    // A doc over the byte cap is refused even though its envelope is
    // structurally valid — entry rows are apply-validated, so the
    // envelope check alone can't spot the bloat.
    const bigEntryDoc = {
      ...single,
      entries: [
        {
          deviceId: 'a',
          seq: 1,
          hlc: { l: 1, c: 0 },
          kind: 'like',
          recordId: 'like:a:1',
          field: 'liked',
          tombstone: false,
          value: 'x'.repeat(MAX_SYNC_DELTA_DOC_BYTES),
        },
      ],
    };
    assertEqual(parseSyncDeltaDocs(JSON.stringify(bigEntryDoc)), null);
  }

  // exportFittedDeltaDoc: the engine pages by entry count but the
  // wire caps serialized bytes — the adapter halves the entry limit
  // until the page fits (the refit mobile's clipboard export was
  // missing; the desktop IPC adapter already runs it).
  {
    const seen: number[] = [];
    const res = await exportFittedDeltaDoc(
      async (_cursor, limit) => {
        seen.push(limit);
        const n = Math.min(limit, 5_000);
        const base = doc(
          Array.from({ length: n }, (_, i) => ({
            deviceId: 'a',
            seq: i + 1,
          })),
          n > 2_500,
        );
        return ok({
          ...base,
          entries: base.entries.map((e) => ({
            ...e,
            value: 'x'.repeat(80),
          })),
        });
      },
      {},
      new CancellationSource().signal,
    );
    assert(res.ok, 'a shrunk page ships');
    assertDeepEqual(
      seen,
      [10_000, 5_000, 2_500],
      'the entry limit halves until the doc fits',
    );
    assert(
      res.ok &&
        utf8ByteLength(JSON.stringify(res.value)) <=
          MAX_SYNC_DELTA_DOC_BYTES,
      'the shipped page honors the doc cap',
    );
  }

  // A single entry that can't fit errors at limit 1 — nothing left
  // to page down to.
  {
    const base = doc([{ deviceId: 'a', seq: 1 }], false);
    const oversized = {
      ...base,
      entries: base.entries.map((e) => ({
        ...e,
        value: 'x'.repeat(MAX_SYNC_DELTA_DOC_BYTES),
      })),
    };
    let calls = 0;
    const res = await exportFittedDeltaDoc(
      async () => {
        calls += 1;
        return ok(oversized);
      },
      {},
      new CancellationSource().signal,
    );
    assert(
      !res.ok && res.error.kind === 'invalid-response' && calls > 1,
      'an unfittable entry fails after refit, not before it',
    );
  }

  // The same refit against the REAL engine: a log whose default
  // 10k-entry page outgrows the doc cap exports as several fitted
  // pages — the exact path mobile's copy-delta now takes.
  {
    const created = await createSyncEngine({
      store: new FakeSyncLogStore(),
      clock: new FakeClock(1_000),
      ids: new SequenceIds(),
      log: new FakeLog(),
      deviceId: 'dev-a',
    });
    assert(created.ok, 'engine builds');
    const engine = created.value;
    const writes: LocalWrite[] = Array.from({ length: 2_000 }, (_, i) => ({
      kind: 'recording',
      recordId: `r${i}`,
      field: 'title',
      value: 't'.repeat(500),
    }));
    const wrote = await engine.localChangeBatch(
      writes,
      new CancellationSource().signal,
    );
    assert(wrote.ok, 'bulk writes land');
    const res = await collectSyncDeltaDocs((cursor) =>
      exportFittedDeltaDoc(
        engine.exportDelta,
        cursor,
        new CancellationSource().signal,
      ),
    );
    assert(res.ok, 'fitted export collects a large log');
    assert(
      res.ok && res.value.length > 1,
      'the oversized default page refits into smaller docs',
    );
    let shipped = 0;
    for (const d of res.value) {
      shipped += d.entries.length;
      assert(
        utf8ByteLength(JSON.stringify(d)) <= MAX_SYNC_DELTA_DOC_BYTES,
        'every page honors the doc cap',
      );
    }
    assertEqual(shipped, writes.length, 'every entry ships exactly once');
    assert(
      parseSyncDeltaDocs(serializeSyncDeltaDocs(res.value)) !== null,
      'the fitted batch re-parses',
    );
  }

  // The serialized ARRAY is the budgeted payload — doc bytes alone
  // can sit under the cap while brackets + commas push it over
  // (review regression). An exact-fit batch ships and re-parses; one
  // byte past it is refused.
  {
    const N = 16;
    // '[' + ']' plus a comma per join — the framing serialize adds.
    const framing = N + 1;
    const sizes = Array.from({ length: N }, () => MAX_SYNC_DELTA_DOC_BYTES);
    sizes[0] = MAX_SYNC_DELTA_DOC_BYTES - framing;
    const sized = (seq: number, size: number, more: boolean): SyncDelta => {
      const base = doc([{ deviceId: 'a', seq }], more);
      const shell = utf8ByteLength(
        JSON.stringify({
          ...base,
          entries: base.entries.map((e) => ({ ...e, value: '' })),
        }),
      );
      return {
        ...base,
        entries: base.entries.map((e) => ({
          ...e,
          value: 'x'.repeat(size - shell),
        })),
      };
    };
    let page = 0;
    const res = await collectSyncDeltaDocs(async () => {
      page += 1;
      return ok(sized(page, sizes[page - 1] ?? 0, page < N));
    });
    assert(res.ok && res.value.length === N, 'an exact-fit batch collects');
    const text = serializeSyncDeltaDocs(res.value);
    assertEqual(
      text.length,
      MAX_SYNC_DELTA_TEXT_CHARS,
      'the batch serializes exactly to the cap',
    );
    assert(
      parseSyncDeltaDocs(text) !== null,
      'the boundary payload re-parses',
    );

    // One byte past the boundary — the payload could never re-parse,
    // so the walk must stop with the typed budget error.
    page = 0;
    const over = await collectSyncDeltaDocs(async () => {
      page += 1;
      return ok(
        sized(page, (sizes[page - 1] ?? 0) + (page === 1 ? 1 : 0), page < N),
      );
    });
    assert(
      !over.ok && over.error.kind === 'budget-exceeded',
      'one byte over the cap refuses',
    );
  }
}
