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
  } finally {
    service.stop();
  }
}
