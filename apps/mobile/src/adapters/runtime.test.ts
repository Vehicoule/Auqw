import { CancellationSource } from '@auqw/application';
import { assert, assertEqual } from '@auqw/application/testing';
import { createClock, createIds, createLog } from './runtime.ts';

// 1. The wall clock reports Date.now and sleeps resolve ok.
async function clockBasics(): Promise<void> {
  const clock = createClock();
  const before = Date.now();
  const now = clock.nowMs();
  assert(now >= before && now <= Date.now() + 1, 'nowMs is wall time');
  const source = new CancellationSource();
  const result = await clock.sleep(1, source.signal);
  assert(result.ok, 'sleep resolves ok');
}

// 2. A cancelled signal resolves sleep as cancelled and clears the
// pending timer.
async function sleepCancellation(): Promise<void> {
  const clock = createClock();
  const source = new CancellationSource();
  const pre = await clock.sleep(10, source.signal);
  assert(pre.ok, 'uncancelled sleep resolves');
  const sleeping = clock.sleep(60_000, source.signal);
  source.cancel();
  const result = await sleeping;
  assert(!result.ok && result.error.kind === 'cancelled', 'sleep cancelled');
  const already = new CancellationSource();
  already.cancel();
  const late = await clock.sleep(1, already.signal);
  assert(!late.ok && late.error.kind === 'cancelled', 'pre-cancelled');
}

// 3. Ids are unique and carry the prefix.
async function idGeneration(): Promise<void> {
  const ids = createIds();
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const id = ids.next('attempt');
    assert(id.startsWith('attempt-'), 'id carries prefix');
    assert(!seen.has(id), `id unique: ${id}`);
    seen.add(id);
  }
  assertEqual(ids.next('rec').split('-')[0], 'rec');
}

// 4. The default log writes without throwing; a failing sink becomes
// a typed error instead of a crash.
async function logSink(): Promise<void> {
  const entries: { level: string; message: string; atMs: number }[] = [];
  const log = createLog((entry) => entries.push(entry));
  const result = await log.write({
    level: 'warn',
    message: 'queue transition rejected',
    atMs: 1,
  });
  assert(result.ok, 'write resolves ok');
  assertEqual(entries.length, 1);
  assertEqual(entries[0]?.level, 'warn');
  assertEqual(entries[0]?.message, 'queue transition rejected');

  const broken = createLog(() => {
    throw new Error('sink exploded');
  });
  const failed = await broken.write({ level: 'info', message: 'x', atMs: 2 });
  assert(!failed.ok && failed.error.kind === 'internal', 'sink error typed');

  const console_ = createLog();
  assert(
    (await console_.write({ level: 'debug', message: 'd', atMs: 3 })).ok,
    'console sink resolves',
  );
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['clockBasics', clockBasics],
  ['sleepCancellation', sleepCancellation],
  ['idGeneration', idGeneration],
  ['logSink', logSink],
];

export async function run(): Promise<void> {
  for (const [name, fn] of TESTS) {
    try {
      await fn();
    } catch (thrown) {
      throw new Error(`runtime test failed: ${name}`, { cause: thrown });
    }
  }
}
