import { EventEmitter } from 'node:events';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import { isShellError, shellError } from '../shared/errors.ts';
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

  // Malformed replies with no live id are dropped; unknown ids are ignored.
  child.emit('message', { id: 998, ok: true });
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

  // A malformed reply that still carries a pending id settles the
  // request instead of leaving it hanging forever.
  const malformed = supervisor.request('utility:ping', { message: 'g' });
  third.emit('message', { id: 6, ok: true });
  await assertRejectsKind(malformed, 'invalid-response');

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

  // sendToHost posts one-way messages only while a child is live.
  {
    const oneWay: FakeChild[] = [];
    const sup = createSupervisor({
      fork: () => {
        const c = new FakeChild();
        oneWay.push(c);
        return c;
      },
      baseBackoffMs: 5,
      maxBackoffMs: 20,
    });
    try {
      assertEqual(sup.sendToHost({ kind: 'stream-pump' }), false,
        'no child yet — refused');
      const req = sup.request('utility:ping', { message: 'w' });
      const c = oneWay[0];
      assert(c !== undefined);
      assertEqual(sup.sendToHost({ kind: 'stream-pump' }), false,
        'pre-spawn refused');
      c.emit('spawn');
      assertEqual(
        sup.sendToHost({ kind: 'stream-pump', handle: 'h' }, [{ p: 1 }]),
        true,
        'spawned child receives the post',
      );
      const posted = c.posted[c.posted.length - 1] as {
        kind?: string;
        handle?: string;
      };
      assertEqual(posted?.kind, 'stream-pump', 'message reached postMessage');
      c.emit('message', { id: 1, ok: true, result: null });
      await req;
    } finally {
      sup.shutdown();
    }
    assertEqual(sup.sendToHost({ kind: 'stream-pump' }), false,
      'post-shutdown refused');
  }

  // Utility→main service calls: a whitelisted channel gets its handler,
  // the reply rides back as a normal response envelope; anything else
  // is refused typed.
  {
    const kids: FakeChild[] = [];
    const seen: unknown[] = [];
    const sup = createSupervisor({
      fork: () => {
        const c = new FakeChild();
        kids.push(c);
        return c;
      },
      baseBackoffMs: 5,
      maxBackoffMs: 20,
      services: {
        'sync:keys': async (args) => {
          seen.push(args);
          return { identity: null };
        },
        'svc:boom': async () => {
          throw new Error('raw boom');
        },
        'svc:typed': async () => {
          throw shellError('unavailable', 'down');
        },
      },
    });
    try {
      const spawnReq = sup.request('utility:ping', undefined);
      const c = kids[0];
      assert(c !== undefined);
      c.emit('spawn');
      // Inbound service call → handler → response posted back.
      c.emit('message', { id: 50, channel: 'sync:keys', args: { op: 'identity-get' } });
      await sleep(5);
      const reply = c.posted[c.posted.length - 1] as {
        id?: number;
        ok?: boolean;
        result?: unknown;
      };
      assertEqual(reply.id, 50, 'service reply correlates');
      assertEqual(reply.ok, true);
      assertDeepEqual(reply.result, { identity: null });
      assertDeepEqual(seen[0], { op: 'identity-get' }, 'args forwarded');

      // Unknown service channel → typed refusal, not silence.
      c.emit('message', { id: 51, channel: 'evil:chan', args: {} });
      await sleep(5);
      const refused = c.posted[c.posted.length - 1] as {
        id?: number;
        ok?: boolean;
        error?: { kind?: string };
      };
      assertEqual(refused.id, 51);
      assertEqual(refused.ok, false);
      assertEqual(refused.error?.kind, 'invalid-request');

      // Prototype members never pass the whitelist — 'constructor'
      // resolves through Object.prototype on a plain index but isn't
      // an own-property service.
      for (const name of ['constructor', 'hasOwnProperty', 'toString']) {
        c.emit('message', { id: 54, channel: name, args: {} });
        await sleep(5);
        const protoRefused = c.posted[c.posted.length - 1] as {
          ok?: boolean;
          error?: { kind?: string };
        };
        assertEqual(protoRefused.ok, false);
        assertEqual(
          protoRefused.error?.kind,
          'invalid-request',
          `prototype member ${name} refused`,
        );
      }

      // Handler throws map onto typed envelopes — never raw.
      c.emit('message', { id: 52, channel: 'svc:boom', args: {} });
      await sleep(5);
      const raw = c.posted[c.posted.length - 1] as {
        ok?: boolean;
        error?: { kind?: string };
      };
      assertEqual(raw.ok, false);
      assertEqual(raw.error?.kind, 'internal');
      c.emit('message', { id: 53, channel: 'svc:typed', args: {} });
      await sleep(5);
      const typed = c.posted[c.posted.length - 1] as {
        ok?: boolean;
        error?: { kind?: string };
      };
      assertEqual(typed.ok, false);
      assertEqual(typed.error?.kind, 'unavailable');

      // A service-shaped message while main also awaits a response
      // never collides — direction-scoped correlation. Same numeric id
      // on both paths: the service reply must not settle the pending
      // main→utility request.
      const pending = sup.request('utility:ping', { message: 'x' });
      const requestPost = c.posted[c.posted.length - 1] as { id?: number };
      const pendingId = requestPost.id;
      assert(typeof pendingId === 'number');
      c.emit('message', { id: pendingId, channel: 'sync:keys', args: { op: 'device-list' } });
      await sleep(5);
      const serviceReply = c.posted[c.posted.length - 1] as {
        id?: number;
        ok?: boolean;
      };
      assertEqual(serviceReply.id, pendingId, 'service id shadows pending id harmlessly');
      assertEqual(serviceReply.ok, true);
      c.emit('message', { id: pendingId, ok: true, result: 'still-answered' });
      assertEqual(await pending, 'still-answered');
      // Settle the spawn request so shutdown doesn't leave it hanging.
      const spawnPost = c.posted[0] as { id?: number };
      c.emit('message', { id: spawnPost.id, ok: true, result: null });
      await spawnReq;
    } finally {
      sup.shutdown();
    }
  }

  // ---- backpressure: bounded queues, deadline only on the spawn wait ----
  {
    // A queued request with no child coming up settles on its own
    // deadline instead of waiting forever — and leaves the queue, so a
    // late spawn cannot post it and double-run the work.
    const kids: FakeChild[] = [];
    const sup = createSupervisor({
      fork: () => {
        const child = new FakeChild();
        kids.push(child);
        return child;
      },
      queueDeadlineMs: 15,
    });
    await assertRejectsKind(
      sup.request('utility:ping', { message: 'late' }),
      'unavailable',
    );
    const child = kids[0];
    assert(child !== undefined);
    child.emit('spawn');
    await sleep(1);
    assertEqual(child.posted.length, 0, 'expired request is never posted');
    sup.shutdown();
  }
  {
    // The queue is capped: a caller outpacing a crash-looping utility is
    // refused typed instead of buffering without limit.
    const sup = createSupervisor({
      fork: () => new FakeChild(),
      maxQueued: 2,
      queueDeadlineMs: 60_000,
    });
    const first = sup.request('utility:ping', { message: '1' });
    const second = sup.request('utility:ping', { message: '2' });
    await assertRejectsKind(
      sup.request('utility:ping', { message: '3' }),
      'unavailable',
    );
    sup.shutdown();
    await assertRejectsKind(first, 'released');
    await assertRejectsKind(second, 'released');
  }
  {
    // In-flight requests are capped too — a child that stays up but
    // stops answering would otherwise accumulate `pending` forever.
    const kids: FakeChild[] = [];
    const sup = createSupervisor({
      fork: () => {
        const child = new FakeChild();
        kids.push(child);
        return child;
      },
      maxPending: 1,
    });
    const inflight = sup.request('utility:ping', { message: 'a' });
    const child = kids[0];
    assert(child !== undefined);
    child.emit('spawn');
    await sleep(1);
    assertEqual(child.posted.length, 1);
    await assertRejectsKind(
      sup.request('utility:ping', { message: 'b' }),
      'unavailable',
    );
    const post = child.posted[0] as { id?: number };
    child.emit('message', { id: post.id, ok: true, result: 'done' });
    assertEqual(await inflight, 'done', 'the one in-flight request still settles');
    sup.shutdown();
  }
  {
    // Promotion to `pending` cancels the spawn deadline, so a slow
    // in-flight request is never settled twice — once by a stale timer
    // and once by its real answer.
    const kids: FakeChild[] = [];
    const sup = createSupervisor({
      fork: () => {
        const child = new FakeChild();
        kids.push(child);
        return child;
      },
      queueDeadlineMs: 15,
    });
    const request = sup.request('utility:ping', { message: 'slow' });
    const child = kids[0];
    assert(child !== undefined);
    child.emit('spawn');
    await sleep(30);
    const post = child.posted[0] as { id?: number };
    child.emit('message', { id: post.id, ok: true, result: 'kept' });
    assertEqual(
      await request,
      'kept',
      'promoted request survives its old spawn deadline',
    );
    sup.shutdown();
  }
}
