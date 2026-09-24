import { CHANNELS } from '../shared/channels.ts';
import type { SyncAppliedEvent } from '../shared/contract.ts';
import type { NetSender } from './net-monitor.ts';

/**
 * The `sync:applied` push leg — the utility posts into main through the
 * whitelisted `sync:applied` service channel after every applyDelta,
 * and subscribed renderers get the event so they can pull
 * `sync:drainApplied` promptly. Same sender-registry shape as the net
 * monitor: refcounted attach, destroyed senders drop automatically.
 */
export interface AppliedPushService {
  attach(sender: NetSender): void;
  detach(sender: NetSender): void;
  /** Broadcast a validated event to every subscribed sender. */
  notify(event: SyncAppliedEvent): void;
  stop(): void;
}

export function createAppliedPushService(): AppliedPushService {
  const senders = new Map<NetSender, number>();

  function drop(sender: NetSender): void {
    senders.delete(sender);
  }

  return {
    attach(sender) {
      const count = senders.get(sender) ?? 0;
      senders.set(sender, count + 1);
      if (count === 0) {
        sender.on?.('destroyed', () => drop(sender));
      }
    },
    detach(sender) {
      const count = senders.get(sender) ?? 0;
      if (count <= 1) {
        drop(sender);
      } else {
        senders.set(sender, count - 1);
      }
    },
    notify(event) {
      for (const sender of senders.keys()) {
        try {
          sender.send(CHANNELS.syncApplied, event);
        } catch {
          // A dead WebContents throws on send — isolate each delivery
          // so one dead renderer never kills the fan-out.
          drop(sender);
        }
      }
    },
    stop() {
      senders.clear();
    },
  };
}
