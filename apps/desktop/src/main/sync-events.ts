import { CHANNELS } from '../shared/channels.ts';
import type { SyncAppliedEvent, SyncNearbyEvent } from '../shared/contract.ts';
import type { NetSender } from './net-monitor.ts';

/**
 * Utility→main→renderer push legs — the utility posts into main
 * through whitelisted service channels and subscribed renderers get
 * the event. `sync:applied` fires after every applyDelta (the pull is
 * `sync:drainApplied`); `sync:nearby` carries mDNS browse found/lost
 * for the pair sheet's device list. Same sender-registry shape as the
 * net monitor: refcounted attach, destroyed senders drop
 * automatically.
 */
export interface PushService<E> {
  attach(sender: NetSender): void;
  detach(sender: NetSender): void;
  /** Broadcast a validated event to every subscribed sender. */
  notify(event: E): void;
  stop(): void;
}

function createPushService<E>(channel: string): PushService<E> {
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
          sender.send(channel, event);
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

export type AppliedPushService = PushService<SyncAppliedEvent>;

export function createAppliedPushService(): AppliedPushService {
  return createPushService<SyncAppliedEvent>(CHANNELS.syncApplied);
}

export type NearbyPushService = PushService<SyncNearbyEvent>;

export function createNearbyPushService(): NearbyPushService {
  return createPushService<SyncNearbyEvent>(CHANNELS.syncNearby);
}
