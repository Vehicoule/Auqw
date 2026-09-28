import { appError, err, ok } from '../errors.ts';
import type { Result } from '../errors.ts';
import { assert, assertDeepEqual, assertEqual } from '../testing/assert.ts';
import {
  MAX_SYNC_DELTA_DOC_BYTES,
  MAX_SYNC_DELTA_TEXT_CHARS,
  collectSyncDeltaDocs,
  parseSyncDeltaDocs,
  serializeSyncDeltaDocs,
} from './delta-docs.ts';
import type { SyncCursor, SyncDelta } from './sync-engine.ts';

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
}
