import { assert, assertDeepEqual, assertEqual } from '@auqw/application/testing';
import { CHANNELS } from '../shared/channels.ts';
import type { NetSender } from './net-monitor.ts';
import { createAppliedPushService } from './sync-events.ts';

/** Sender with a `destroyed` hook — mirrors real WebContents lifecycle. */
class DestroyableSender implements NetSender {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  private readonly listeners: Array<() => void> = [];
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
  on(event: 'destroyed', listener: () => void): void {
    assert(event === 'destroyed');
    this.listeners.push(listener);
  }
  hookedCount(): number {
    return this.listeners.length;
  }
  destroy(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

/** Refcounted fan-out, destroyed-drop, and one destroyed hook per sender. */
function pushServiceLifecycle(): void {
  const service = createAppliedPushService();
  const a = new DestroyableSender();
  const b = new DestroyableSender();
  service.attach(a);
  service.attach(b);

  // Subscriptions are refcounted: two attaches need two detaches.
  service.attach(a);
  service.detach(a);
  service.notify({ pending: 1 });
  assertEqual(a.sent.length, 1, 'refcounted sender still receives');
  service.detach(a);
  service.notify({ pending: 2 });
  assertEqual(a.sent.length, 1, 'fully detached sender stops');
  assertEqual(b.sent.length, 2, 'attached sender still gets events');
  assertDeepEqual(b.sent[0], {
    channel: CHANNELS.syncApplied,
    payload: { pending: 1 },
  });

  // A 'destroyed' event removes the sender without an explicit detach.
  b.destroy();
  service.notify({ pending: 3 });
  assertEqual(b.sent.length, 2, 'destroyed sender gets nothing more');
}

/**
 * The subscribe → unsubscribe → resubscribe cycle (live today via
 * `sync:nearby`'s pair-sheet effect) must not stack a `destroyed`
 * listener per round trip — Electron warns past ~10 copies and each
 * one is a retained callback. The hook outlives a detach so a sender
 * is hooked once, ever.
 */
function destroyedHookInstallsOnce(): void {
  const service = createAppliedPushService();
  const sender = new DestroyableSender();
  for (let i = 0; i < 12; i++) {
    service.attach(sender);
    service.detach(sender);
  }
  assertEqual(
    sender.hookedCount(),
    1,
    're-attachment stacks no extra destroyed listener',
  );
  // The single hook still works: destroy after a fresh attach drops
  // the sender instead of notifying a dead renderer.
  service.attach(sender);
  sender.destroy();
  service.notify({ pending: 1 });
  assertEqual(sender.sent.length, 0, 'destroyed sender is dropped');
  service.stop();
}

export async function run(): Promise<void> {
  pushServiceLifecycle();
  destroyedHookInstallsOnce();
}
