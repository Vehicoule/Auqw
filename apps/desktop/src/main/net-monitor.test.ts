import { assert, assertDeepEqual, assertEqual } from '@auqw/application/testing';
import { CHANNELS } from '../shared/channels.ts';
import { createNetService } from './net-monitor.ts';
import type { NetSender } from './net-monitor.ts';

class CollectingSender implements NetSender {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
}

/** Sender that throws on every send — stands in for a destroyed WebContents. */
class DeadSender implements NetSender {
  send(): void {
    throw new Error('web contents destroyed');
  }
}

/** Sender with a `destroyed` hook — mirrors real WebContents lifecycle. */
class DestroyableSender extends CollectingSender {
  private destroyed: (() => void) | null = null;
  on(event: 'destroyed', listener: () => void): void {
    assert(event === 'destroyed');
    this.destroyed = listener;
  }
  destroy(): void {
    this.destroyed?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(): Promise<void> {
  let online = true;
  const service = createNetService({
    readOnline: () => online,
    pollMs: 5,
  });
  try {
    assertDeepEqual(service.snapshot(), { online: true });

    // Attaching pushes the current state immediately.
    const a = new CollectingSender();
    const b = new CollectingSender();
    service.attach(a);
    service.attach(b);
    assertEqual(a.sent.length, 1);
    assertDeepEqual(a.sent[0], {
      channel: CHANNELS.netEvents,
      payload: { online: true },
    });

    // A transition is pushed to every attached sender.
    online = false;
    await sleep(40);
    assertEqual(a.sent.length, 2);
    assertEqual(b.sent.length, 2);
    assertDeepEqual(b.sent[1], {
      channel: CHANNELS.netEvents,
      payload: { online: false },
    });

    // No transition → no push.
    await sleep(40);
    assertEqual(a.sent.length, 2);

    // Detached senders stop receiving.
    service.detach(a);
    online = true;
    await sleep(40);
    assertEqual(a.sent.length, 2, 'detached sender gets nothing');
    assertEqual(b.sent.length, 3, 'attached sender still gets events');
    assertDeepEqual(service.snapshot(), { online: true });

    // Subscriptions are refcounted: two attaches need two detaches.
    service.attach(b);
    service.detach(b);
    online = false;
    await sleep(40);
    assertEqual(b.sent.length, 4, 'refcounted sender keeps events');
    service.detach(b);
    online = true;
    await sleep(40);
    assertEqual(b.sent.length, 4, 'fully detached sender stops');

    // A sender whose send throws is dropped without killing the poll.
    const dead = new DeadSender();
    const c = new CollectingSender();
    service.attach(dead);
    service.attach(c);
    online = false;
    await sleep(40);
    assertEqual(c.sent.length, 2, 'healthy sender unaffected by dead one');
    online = true;
    await sleep(40);
    assertEqual(c.sent.length, 3, 'poll keeps running after drop');

    // A 'destroyed' event removes the sender without an explicit detach.
    const d = new DestroyableSender();
    service.attach(d);
    d.destroy();
    online = false;
    await sleep(40);
    assertEqual(d.sent.length, 1, 'destroyed sender only got initial push');
    assertEqual(c.sent.length, 4, 'other senders still receive events');
  } finally {
    service.stop();
  }
}
