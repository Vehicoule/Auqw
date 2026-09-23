import { appError, err, ok } from '@auqw/application';
import type { LocalWrite } from '@auqw/application';
import { createSyncEmit } from './sync-emit.ts';

/**
 * Emission ordering + pre-surface buffering — the review fix moved
 * the queue logic out of the controller so it can be driven here.
 */

function write(id: string): LocalWrite {
  return {
    kind: 'playlist',
    recordId: id,
    field: 'name',
    value: `name-${id}`,
  };
}

type Batch = readonly LocalWrite[];
type BatchResult = ReturnType<typeof ok> | ReturnType<typeof err>;

function fakeSurface(): {
  batches: readonly Batch[];
  failNext(error: ReturnType<typeof appError>): void;
  localChangeBatch(writes: readonly LocalWrite[]): Promise<BatchResult>;
} {
  const batches: LocalWrite[][] = [];
  let failWith: ReturnType<typeof appError> | null = null;
  return {
    get batches() {
      return batches;
    },
    failNext(error: ReturnType<typeof appError>) {
      failWith = error;
    },
    localChangeBatch(writes: readonly LocalWrite[]) {
      if (failWith !== null) {
        const e = failWith;
        failWith = null;
        return Promise.resolve(err(e));
      }
      batches.push([...writes]);
      return Promise.resolve(ok(undefined));
    },
  };
}

export async function runSyncEmit(): Promise<void> {
  // Pre-surface writes buffer; the first post-surface emit flushes
  // the buffer ahead of its own writes.
  {
    const live = fakeSurface();
    let up = false;
    const emit = createSyncEmit({ surface: () => (up ? live : null) });
    const r1 = await emit([write('a')]);
    assert(r1.ok, 'buffered emit resolves ok');
    expectEq(live.batches.length, 0, 'nothing sent pre-surface');
    up = true;
    const r2 = await emit([write('b')]);
    assert(r2.ok);
    expectEq(live.batches.length, 1, 'one flush batch');
    assertDeepIds(
      live.batches[0],
      ['a', 'b'],
      'buffer first, then write',
    );
  }

  // An empty flush call drains the buffer — the post-build hook.
  {
    const live = fakeSurface();
    let up = false;
    const emit = createSyncEmit({ surface: () => (up ? live : null) });
    await emit([write('x')]);
    up = true;
    const r = await emit([]);
    assert(r.ok);
    assertDeepIds(live.batches[0], ['x'], 'empty flush drains buffer');
  }

  // Concurrent emits serialize — batches arrive in call order even
  // when the first localChangeBatch is slow.
  {
    const slow = fakeSurface();
    const original = slow.localChangeBatch;
    let release!: () => void;
    const blocker = new Promise<void>((res) => {
      release = res;
    });
    let held = true;
    (slow as { localChangeBatch: typeof original }).localChangeBatch =
      async (w) => {
        if (held) {
          held = false;
          await blocker;
        }
        return original(w);
      };
    const emit = createSyncEmit({ surface: () => slow });
    const p1 = emit([write('a')]);
    const p2 = emit([write('b')]);
    const p3 = emit([write('c')]);
    release();
    await Promise.all([p1, p2, p3]);
    expectEq(slow.batches.length, 3, 'three serialized batches');
    assertDeepIds(slow.batches[0], ['a']);
    assertDeepIds(slow.batches[1], ['b']);
    assertDeepIds(slow.batches[2], ['c']);
  }

  // A failed batch re-pends its buffered prefix for the next emit.
  {
    const live = fakeSurface();
    let up = false;
    const emit = createSyncEmit({ surface: () => (up ? live : null) });
    await emit([write('a')]);
    up = true;
    live.failNext(appError('unavailable', 'log full'));
    const failed = await emit([write('b')]);
    assert(!failed.ok, 'failure surfaces typed');
    // The flushed batch contained buffer+write; 'a' re-pends.
    const retry = await emit([write('c')]);
    assert(retry.ok);
    const last = live.batches.at(-1);
    assertDeepIds(last, ['a', 'c'], 're-pended prefix leads retry');
  }

  // Drop-oldest bound while the surface never appears.
  {
    const live = fakeSurface();
    let up = false;
    const emit = createSyncEmit({
      surface: () => (up ? live : null),
      maxBuffered: 2,
    });
    await emit([write('a'), write('b'), write('c')]);
    up = true;
    await emit([]);
    assertDeepIds(live.batches[0], ['b', 'c'], 'oldest dropped at cap');
  }
}

function expectEq(actual: number, expected: number, msg?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg ?? 'count'}: expected ${expected}, got ${actual}`,
    );
  }
}

function assert(cond: boolean, msg?: string): asserts cond {
  if (!cond) {
    throw new Error(msg ?? 'assertion failed');
  }
}

function assertDeepIds(
  batch: readonly LocalWrite[] | undefined,
  expected: readonly string[],
  msg?: string,
): void {
  const ids = (batch ?? []).map((w) => String(w.recordId));
  if (JSON.stringify(ids) !== JSON.stringify([...expected])) {
    throw new Error(
      `${msg ?? 'ids'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(ids)}`,
    );
  }
}
