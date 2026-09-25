import { CHANNELS } from '../shared/channels.ts';
import type { NetEvent, NetSnapshot } from '../shared/contract.ts';

/**
 * Anything a connectivity event can be pushed to — a WebContents in real
 * life. Real WebContents also emit `'destroyed'`; when present the sender
 * is dropped automatically so a closed window stops receiving pushes.
 */
export interface NetSender {
  send(channel: string, payload: unknown): void;
  on?(event: 'destroyed', listener: () => void): void;
}

export interface NetService {
  snapshot(): NetSnapshot;
  /**
   * Subscribe a sender to `net:events`; the current state is pushed
   * immediately. Subscriptions are refcounted — every `attach` needs its
   * own `detach`.
   */
  attach(sender: NetSender): void;
  detach(sender: NetSender): void;
  stop(): void;
}

/**
 * Chromium exposes online state in the main process but no change event,
 * so transitions are detected by polling `readOnline` and diffing.
 */
export function createNetService(opts: {
  readOnline(): boolean;
  pollMs?: number;
}): NetService {
  const pollMs = opts.pollMs ?? 2_000;
  const senders = new Map<NetSender, number>();
  // A `destroyed` hook is registered once per sender and outlives a
  // full detach (drop is reference-based and stays correct), so
  // re-attachment must never stack another copy of it.
  const destroyedHooked = new WeakSet<NetSender>();
  let online = opts.readOnline();

  function drop(sender: NetSender): void {
    senders.delete(sender);
  }

  function sendTo(sender: NetSender, event: NetEvent): void {
    // A destroyed WebContents throws on send — isolate each delivery so
    // one dead renderer can never kill the poll for the others.
    try {
      sender.send(CHANNELS.netEvents, event);
    } catch {
      drop(sender);
    }
  }

  function tick(): void {
    const now = opts.readOnline();
    if (now === online) {
      return;
    }
    online = now;
    for (const sender of senders.keys()) {
      sendTo(sender, { online });
    }
  }

  const timer = setInterval(tick, pollMs);
  timer.unref();

  return {
    snapshot() {
      return { online };
    },
    attach(sender) {
      const count = senders.get(sender) ?? 0;
      senders.set(sender, count + 1);
      if (count === 0) {
        if (sender.on !== undefined && !destroyedHooked.has(sender)) {
          destroyedHooked.add(sender);
          sender.on('destroyed', () => drop(sender));
        }
        sendTo(sender, { online });
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
    stop() {
      clearInterval(timer);
      senders.clear();
    },
  };
}
