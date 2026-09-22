import { EventEmitter } from 'node:events';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import { isShellError } from '../shared/errors.ts';
import type { UtilityChildLike } from './supervisor.ts';
import { createSupervisor } from './supervisor.ts';

class FakeChild extends EventEmitter implements UtilityChildLike {
  readonly posted: unknown[] = [];
  killed = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  kill(): void {
    this.killed = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertRejectsKind(
  promise: Promise<unknown>,
  kind: string,
): Promise<void> {
  try {
    await promise;
  } catch (thrown) {
    assert(
      isShellError(thrown) && thrown.kind === kind,
      `expected ${kind}, got ${JSON.stringify(thrown)}`,
    );
    return;
  }
  throw new Error(`expected rejection with ${kind}`);
}

export async function run(): Promise<void> {
  const children: FakeChild[] = [];
  const supervisor = createSupervisor({
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    baseBackoffMs: 5,
    maxBackoffMs: 20,
  });

  // Requests made before spawn queue up and flush on 'spawn'.
  const first = supervisor.request('utility:ping', { message: 'a' });
  assertEqual(children.length, 1, 'fork happens on first request');
  const child = children[0];
  assert(child !== undefined);
  assertEqual(child.posted.length, 0, 'nothing posts before spawn');
  child.emit('spawn');
  assertEqual(child.posted.length, 1, 'queued request flushed on spawn');
  assertDeepEqual(child.posted[0], {
    id: 1,
    channel: 'utility:ping',
    args: { message: 'a' },
  });

  // Malformed replies are dropped; unknown ids are ignored.
  child.emit('message', { id: 1, ok: true });
  child.emit('message', { not: 'an envelope' });
  child.emit('message', { id: 999, ok: true, result: 0 });
  child.emit('message', { id: 1, ok: true, result: { reply: 'pong' } });
  const answered = await first;
  assertDeepEqual(answered, { reply: 'pong' });

  // Typed errors come back as rejections, not thrown raw.
  const typed = supervisor.request('utility:ping', { message: 'b' });
  child.emit('message', {
    id: 2,
    ok: false,
    error: { kind: 'not-implemented', message: 'nope', retryable: false },
  });
  await assertRejectsKind(typed, 'not-implemented');

  // Crash: the in-flight request rejects process-crashed and a new
  // child is forked after the bounded backoff.
  const inflight = supervisor.request('utility:ping', { message: 'c' });
  child.emit('exit', 1);
  await assertRejectsKind(inflight, 'process-crashed');
  assertEqual(children.length, 1, 'respawn waits out the backoff');
  await sleep(40);
  assertEqual(children.length, 2, 'child respawned after backoff');
  const respawned = children[1];
  assert(respawned !== undefined);
  respawned.emit('spawn');
  const afterRespawn = supervisor.request('utility:ping', {
    message: 'd',
  });
  assertEqual(respawned.posted.length, 1);
  respawned.emit('message', { id: 4, ok: true, result: 'alive' });
  assertEqual(await afterRespawn, 'alive');

  // A request issued while the child is down queues for the next spawn.
  respawned.emit('exit', 0);
  const queued = supervisor.request('utility:ping', { message: 'e' });
  await sleep(40);
  assertEqual(children.length, 3, 'second respawn forked');
  const third = children[2];
  assert(third !== undefined);
  third.emit('spawn');
  assertEqual(third.posted.length, 1, 'queued request posted on respawn');

  // Shutdown drains queued + in-flight, kills the child, stops respawn.
  supervisor.shutdown();
  await assertRejectsKind(queued, 'released');
  assert(third.killed, 'shutdown kills the live child');
  await sleep(40);
  assertEqual(children.length, 3, 'no further respawn after shutdown');
  await assertRejectsKind(
    supervisor.request('utility:ping', { message: 'f' }),
    'released',
  );

  // Backoff escalates across a crash loop: spawn must NOT reset the
  // counter — only a child that stays up past stableAfterMs does.
  const looped: FakeChild[] = [];
  const storm = createSupervisor({
    fork: () => {
      const next = new FakeChild();
      looped.push(next);
      return next;
    },
    baseBackoffMs: 10,
    maxBackoffMs: 60,
    stableAfterMs: 5_000,
  });
  try {
    const x = storm.request('utility:ping', { message: 'x' });
    assertEqual(looped.length, 1);
    looped[0]?.emit('spawn');
    looped[0]?.emit('exit', 1);
    await assertRejectsKind(x, 'process-crashed');
    await sleep(18);
    assertEqual(looped.length, 2, 'first respawn after ~base delay');
    looped[1]?.emit('spawn');
    looped[1]?.emit('exit', 1);
    await sleep(12);
    assertEqual(looped.length, 2, 'second respawn still waiting (>base)');
    await sleep(30);
    assertEqual(looped.length, 3, 'second respawn after doubled delay');
    looped[2]?.emit('spawn');
    looped[2]?.emit('exit', 1);
    await sleep(15);
    assertEqual(looped.length, 3, 'third respawn backed off further');
    await sleep(60);
    assertEqual(looped.length, 4, 'third respawn eventually lands');
  } finally {
    storm.shutdown();
  }

  // A child that stays up past stableAfterMs resets the counter — the
  // next crash goes back to the base delay instead of doubling further.
  const stable: FakeChild[] = [];
  const recovered = createSupervisor({
    fork: () => {
      const next = new FakeChild();
      stable.push(next);
      return next;
    },
    baseBackoffMs: 20,
    maxBackoffMs: 200,
    stableAfterMs: 40,
  });
  try {
    const y = recovered.request('utility:ping', { message: 'y' });
    stable[0]?.emit('spawn');
    await sleep(60);
    stable[0]?.emit('exit', 1);
    await assertRejectsKind(y, 'process-crashed');
    await sleep(35);
    assertEqual(stable.length, 2, 'healthy child respawns at base delay');
    stable[1]?.emit('spawn');
    await sleep(60);
    const z = recovered.request('utility:ping', { message: 'z' });
    stable[1]?.emit('exit', 1);
    await assertRejectsKind(z, 'process-crashed');
    await sleep(30);
    assertEqual(
      stable.length,
      3,
      'crash counter reset — delay is base, not doubled',
    );
  } finally {
    recovered.shutdown();
  }
}
