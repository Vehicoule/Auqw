import { HybridClock, compareStamp, isHlcStamp } from './hlc.ts';
import { assert, assertEqual, assertDeepEqual } from '../testing/assert.ts';

function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function stampShape(): void {
  assert(isHlcStamp({ l: 0, c: 0 }), 'zero stamp valid');
  assert(isHlcStamp({ l: 12, c: 3 }), 'plain stamp valid');
  assert(!isHlcStamp({ l: -1, c: 0 }), 'negative l rejected');
  assert(!isHlcStamp({ l: 1.5, c: 0 }), 'fractional l rejected');
  assert(!isHlcStamp({ l: 1, c: -2 }), 'negative c rejected');
  assert(!isHlcStamp({ l: 1 }), 'missing c rejected');
  assert(!isHlcStamp({ l: 1, c: 0, x: 1 }), 'extra key rejected');
  assert(!isHlcStamp(null), 'null rejected');
  assert(!isHlcStamp('1,0'), 'string rejected');
  assert(
    !isHlcStamp({ l: Number.MAX_SAFE_INTEGER + 1, c: 0 }),
    'unsafe l rejected',
  );
}

function ordering(): void {
  assert(compareStamp({ l: 1, c: 0 }, { l: 2, c: 0 }) < 0, 'l orders first');
  assert(compareStamp({ l: 2, c: 0 }, { l: 1, c: 9 }) > 0, 'l dominates c');
  assert(compareStamp({ l: 2, c: 3 }, { l: 2, c: 4 }) < 0, 'c breaks ties');
  assertEqual(
    compareStamp({ l: 2, c: 4 }, { l: 2, c: 4 }),
    0,
    'equal stamps compare 0',
  );
}

function tickMonotonic(): void {
  const clock = new HybridClock();
  // First tick adopts the wall clock.
  assertDeepEqual(clock.tick(100), { l: 100, c: 0 });
  // Same millisecond: the counter carries the order.
  assertDeepEqual(clock.tick(100), { l: 100, c: 1 });
  assertDeepEqual(clock.tick(100), { l: 100, c: 2 });
  // Wall regression keeps l monotone — never goes backwards.
  assertDeepEqual(clock.tick(50), { l: 100, c: 3 });
  // Wall advance resets the counter.
  assertDeepEqual(clock.tick(200), { l: 200, c: 0 });
  // Every stamp strictly larger than the last.
  let prev = clock.stamp();
  for (const now of [200, 199, 200, 400, 400, 300]) {
    const next = clock.tick(now);
    assert(
      compareStamp(next, prev) > 0,
      `tick(${now}) must stay monotone: ${JSON.stringify(prev)} -> ${JSON.stringify(next)}`,
    );
    prev = next;
  }
}

function tickOverflowEscape(): void {
  const clock = new HybridClock({ l: 7, c: Number.MAX_SAFE_INTEGER });
  // Counter at the ceiling escapes by bumping l, keeping the order.
  assertDeepEqual(clock.tick(7), { l: 8, c: 0 });
}

function receiveSkew(): void {
  const clock = new HybridClock();
  clock.tick(100);
  // Remote stamp far ahead (skewed sender): l is pulled forward so the
  // next local event still orders after the remote one.
  const merged = clock.receive({ l: 1_000, c: 5 }, 100);
  assertDeepEqual(merged, { l: 1_000, c: 6 });
  // Same-l merge: counter is max(local, remote) + 1.
  const again = clock.receive({ l: 1_000, c: 5 }, 100);
  assertDeepEqual(again, { l: 1_000, c: 7 });
  // Remote behind the local wall: local counter just increments.
  const clock2 = new HybridClock({ l: 500, c: 3 });
  assertDeepEqual(clock2.receive({ l: 100, c: 9 }, 500), { l: 500, c: 4 });
  // Wall ahead of both stamps: fresh counter.
  const clock3 = new HybridClock({ l: 10, c: 1 });
  assertDeepEqual(clock3.receive({ l: 20, c: 2 }, 900), { l: 900, c: 0 });
  // Remote l wins when it's the max but wall/local are lower.
  const clock4 = new HybridClock({ l: 10, c: 0 });
  assertDeepEqual(clock4.receive({ l: 42, c: 0 }, 30), { l: 42, c: 1 });
  // Receive stays monotone as well.
  let prev = clock.stamp();
  for (const remote of [
    { l: 900, c: 0 },
    { l: 1_000, c: 9 },
    { l: 50, c: 0 },
    { l: 2_000, c: 0 },
  ]) {
    const next = clock.receive(remote, 100);
    assert(
      compareStamp(next, prev) > 0,
      `receive must stay monotone: ${JSON.stringify(prev)} -> ${JSON.stringify(next)}`,
    );
    prev = next;
  }
}

function receiveOverflowEscape(): void {
  const clock = new HybridClock({ l: 9, c: Number.MAX_SAFE_INTEGER });
  const merged = clock.receive({ l: 9, c: Number.MAX_SAFE_INTEGER }, 9);
  assertDeepEqual(merged, { l: 10, c: 0 });
}

function validation(): void {
  const clock = new HybridClock();
  assert(throws(() => clock.tick(-1)), 'negative nowMs throws');
  assert(throws(() => clock.tick(1.5)), 'fractional nowMs throws');
  assert(
    throws(() => clock.tick(Number.MAX_SAFE_INTEGER + 1)),
    'unsafe nowMs throws',
  );
  assert(
    throws(() => clock.receive({ l: -1, c: 0 }, 0)),
    'invalid remote throws',
  );
  assert(
    throws(() => clock.receive({ l: 0, c: 0 }, -3)),
    'invalid nowMs throws',
  );
  assert(
    throws(() => new HybridClock({ l: -1, c: 0 })),
    'invalid seed throws',
  );
  const seeded = new HybridClock({ l: 33, c: 4 });
  assertDeepEqual(seeded.stamp(), { l: 33, c: 4 });
  assertDeepEqual(seeded.tick(10), { l: 33, c: 5 });
}

export function run(): void {
  stampShape();
  ordering();
  tickMonotonic();
  tickOverflowEscape();
  receiveSkew();
  receiveOverflowEscape();
  validation();
}
