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
 * A real-internet check: resolves true when an upstream round-trip
 * actually completed. Implementations must be bounded — a probe that
 * never settles freezes the monitor's state machine.
 */
export type NetProbe = () => Promise<boolean>;

/**
 * Consecutive probe failures needed to publish offline — one dropped
 * round-trip can't flap the surface. A single success publishes online:
 * an answered canary is positive proof.
 */
const PROBE_FAIL_THRESHOLD = 2;

/**
 * An HTTP-canary {@link NetProbe}: true only on the expected status —
 * a captive portal's rewritten 200 is reachable HTTP but is not real
 * internet, and the surfaces' verdicts stay honest by reading it as
 * offline. Any transport failure, or a response that never lands inside
 * `timeoutMs`, counts as unreachable. The timeout races the request
 * rather than relying on `signal`, so a fetch implementation that
 * ignores aborts still can't stall the monitor.
 */
export function createFetchProbe(
  fetchImpl: (
    url: string,
    init: { method: string; signal?: AbortSignal },
  ) => Promise<{ status: number }>,
  opts: {
    url: string;
    expectedStatus: number;
    timeoutMs?: number;
  },
): NetProbe {
  const timeoutMs = opts.timeoutMs ?? 4_000;
  return () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, timeoutMs);
      // Unref'd like the poll timer — a pending probe must never hold
      // the process open. Browser-typed configs return a number.
      if (typeof timer === 'object' && timer !== null) {
        (timer as { unref?: () => void }).unref?.();
      }
    });
    const verdict = fetchImpl(opts.url, {
      method: 'GET',
      signal: controller.signal,
    }).then(
      (res) => res.status === opts.expectedStatus,
      () => false,
    );
    return Promise.race([verdict, timedOut]).finally(() => {
      clearTimeout(timer);
    });
  };
}

/**
 * Chromium exposes online state in the main process but no change event,
 * so transitions are detected by polling `readOnline` and diffing.
 *
 * The NIC view alone lies in both directions — a captive portal or dead
 * upstream reads "online", and a network stack Chromium can't see reads
 * "offline" — so when `probe` is provided it is the verdict of record:
 * NIC edges only re-arm it early (and a down-edge publishes offline
 * without waiting on the round-trip), while a slow cadence catches the
 * changes no NIC transition can — upstream dying or healing while the
 * link stays up. Without `probe` the service degrades to the NIC view.
 */
export function createNetService(opts: {
  readOnline(): boolean;
  pollMs?: number;
  /** Real-internet check; omit to publish the raw NIC view. */
  probe?: NetProbe;
  /** Re-verify cadence while the last probe verdict is healthy. */
  probeIntervalMs?: number;
  /** Re-probe cadence while probes are failing — recovery detection. */
  probeRetryMs?: number;
  now?: () => number;
}): NetService {
  const pollMs = opts.pollMs ?? 2_000;
  const probeIntervalMs = opts.probeIntervalMs ?? 30_000;
  const probeRetryMs = opts.probeRetryMs ?? 8_000;
  const now = opts.now ?? Date.now;
  const senders = new Map<NetSender, number>();
  // A `destroyed` hook is registered once per sender and outlives a
  // full detach (drop is reference-based and stays correct), so
  // re-attachment must never stack another copy of it.
  const destroyedHooked = new WeakSet<NetSender>();
  let nic = opts.readOnline();
  let online = nic;
  let probeFailures = 0;
  let probeInFlight = false;
  let lastProbeSettledAt = 0;
  // A probe verdict is valid only for the NIC generation it started
  // under — an edge increments this so an in-flight probe's settle
  // can't overwrite the state the edge just published.
  let probeGeneration = 0;

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

  function publish(next: boolean): void {
    if (next === online) {
      return;
    }
    online = next;
    for (const sender of senders.keys()) {
      sendTo(sender, { online: next });
    }
  }

  function probeSettled(generation: number, reachable: boolean): void {
    probeInFlight = false;
    if (generation !== probeGeneration) {
      // Stale verdict from before the last NIC transition — discard it
      // and re-arm so the current generation gets its own verdict soon.
      fireProbe();
      return;
    }
    lastProbeSettledAt = now();
    probeFailures = reachable ? 0 : probeFailures + 1;
    if (reachable || probeFailures >= PROBE_FAIL_THRESHOLD) {
      publish(reachable);
    }
  }

  function fireProbe(): void {
    const probe = opts.probe;
    if (probe === undefined || probeInFlight) {
      return;
    }
    probeInFlight = true;
    const generation = probeGeneration;
    void probe().then(
      (reachable) => probeSettled(generation, reachable),
      () => probeSettled(generation, false),
    );
  }

  function tick(): void {
    const nicNow = opts.readOnline();
    if (nicNow !== nic) {
      nic = nicNow;
      probeGeneration += 1;
      if (opts.probe === undefined) {
        publish(nicNow);
      } else if (!nicNow) {
        // The link is down: nothing upstream is reachable — publish
        // now and let the next probe verdict re-prove connectivity
        // rather than holding the edge hostage to a timeout.
        publish(false);
      }
      // Every NIC edge re-arms the probe: an up-edge has to be verified
      // before "online" is real, and a down-edge may itself be a
      // Chromium blind spot (a tunnel it can't see) the probe disproves.
      fireProbe();
      return;
    }
    if (
      opts.probe !== undefined &&
      !probeInFlight &&
      (lastProbeSettledAt === 0 ||
        now() - lastProbeSettledAt >=
          (probeFailures > 0 ? probeRetryMs : probeIntervalMs))
    ) {
      fireProbe();
    }
  }

  const timer = setInterval(tick, pollMs);
  timer.unref();
  // The first verdict lands before renderers attach, so snapshot() and
  // the attach push already carry probed truth instead of the NIC guess.
  fireProbe();

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
