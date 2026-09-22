import { CHANNELS } from '../shared/channels.ts';
import type { NetSnapshot } from '../shared/contract.ts';

/** Anything a connectivity event can be pushed to — a WebContents in real life. */
export interface NetSender {
  send(channel: string, payload: unknown): void;
}

export interface NetService {
  snapshot(): NetSnapshot;
  /** Subscribe a sender to `net:events`; the current state is pushed immediately. */
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
  const senders = new Set<NetSender>();
  let online = opts.readOnline();

  function tick(): void {
    const now = opts.readOnline();
    if (now === online) {
      return;
    }
    online = now;
    for (const sender of senders) {
      sender.send(CHANNELS.netEvents, { online });
    }
  }

  const timer = setInterval(tick, pollMs);
  timer.unref();

  return {
    snapshot() {
      return { online };
    },
    attach(sender) {
      senders.add(sender);
      sender.send(CHANNELS.netEvents, { online });
    },
    detach(sender) {
      senders.delete(sender);
    },
    stop() {
      clearInterval(timer);
      senders.clear();
    },
  };
}
