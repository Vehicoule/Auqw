import {
  fromUnknown,
  isShellError,
  shellError,
} from '../shared/errors.ts';
import type { UtilityRequest } from '../utility/envelope.ts';
import { isServiceCall } from '../utility/service.ts';
import {
  hasRequestId,
  isUtilityResponse,
} from '../utility/validators.ts';

/**
 * Minimal child handle — satisfied by Electron's `UtilityProcess` and by
 * test fakes, so the supervision logic stays electron-free.
 */
export interface UtilityChildLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'spawn', listener: () => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  kill(): void;
}

export type SupervisorOptions = {
  readonly fork: () => UtilityChildLike;
  /** First respawn delay after a crash; doubles per consecutive crash. */
  readonly baseBackoffMs?: number;
  /** Cap for the respawn delay — backoff is bounded, retry is not. */
  readonly maxBackoffMs?: number;
  /**
   * Time a spawned child must stay up before the crash counter resets.
   * A child that exits before this window never resets it, so crash loops
   * keep climbing the backoff instead of restarting every base interval.
   */
  readonly stableAfterMs?: number;
  /**
   * Utility→main service channels: the child can call INTO main on a
   * whitelisted channel name using the same request envelope, e.g.
   * `sync:keys` for safeStorage custody it cannot reach itself. Any
   * channel not registered here is refused `invalid-request` — the
   * child gets no ambient main-process reach.
   */
  readonly services?: Readonly<
    Record<string, (args: unknown) => Promise<unknown>>
  >;
  /**
   * Ceiling on requests waiting for a child to come up. A caller that
   * outpaces a crash-looping utility would otherwise grow `queued`
   * without limit; past the cap a request is refused typed instead of
   * being buffered forever.
   */
  readonly maxQueued?: number;
  /**
   * Ceiling on requests in flight to a live child. A child that stays
   * up but stops answering would otherwise accumulate `pending` with
   * nothing to settle it — `onExit` only clears the map when the child
   * actually dies.
   */
  readonly maxPending?: number;
  /**
   * How long a *queued* request may wait for a child before it is
   * refused. Only the wait for a spawn gets a deadline: an in-flight
   * request is doing real work whose duration is the utility's to
   * govern (a transfer legitimately runs for minutes), and `onExit`
   * already settles the whole `pending` map on a crash. A queued
   * request that expires has never been posted, so refusing it cannot
   * double-run work.
   */
  readonly queueDeadlineMs?: number;
};

export interface UtilitySupervisor {
  request(channel: string, args: unknown): Promise<unknown>;
  /**
   * A one-shot non-envelope message (pump attach) — sent only when a
   * live child exists; unlike `request` it is never queued, since a
   * transferred port cannot wait through a respawn. `false` = no live
   * child, caller must retry or fail typed.
   */
  sendToHost(message: unknown, transfer?: unknown[]): boolean;
  /** Kill the child, drain every queued and in-flight request. */
  shutdown(): void;
  readonly running: boolean;
}

type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};

type Queued = Pending & {
  readonly id: number;
  readonly channel: string;
  readonly args: unknown;
  /** Deadline timer — cleared when the entry is posted or refused. */
  timer: NodeJS.Timeout | null;
};

export function createSupervisor(
  opts: SupervisorOptions,
): UtilitySupervisor {
  const baseBackoffMs = opts.baseBackoffMs ?? 100;
  const maxBackoffMs = opts.maxBackoffMs ?? 4_000;
  const stableAfterMs = opts.stableAfterMs ?? 10_000;
  const maxQueued = opts.maxQueued ?? 256;
  const maxPending = opts.maxPending ?? 1_024;
  const queueDeadlineMs = opts.queueDeadlineMs ?? 30_000;

  let child: UtilityChildLike | null = null;
  let spawned = false;
  let stopped = false;
  let consecutiveCrashes = 0;
  let nextId = 1;
  let respawnTimer: NodeJS.Timeout | null = null;
  let stabilityTimer: NodeJS.Timeout | null = null;

  const pending = new Map<number, Pending>();
  const queued: Queued[] = [];

  function spawn(): void {
    if (stopped) {
      return;
    }
    let next: UtilityChildLike;
    try {
      next = opts.fork();
    } catch {
      // A failed fork is treated like a crash: retry with backoff.
      consecutiveCrashes += 1;
      scheduleRespawn();
      return;
    }
    child = next;
    spawned = false;
    next.on('spawn', onSpawn);
    next.on('message', onMessage);
    next.on('exit', onExit);
  }

  function postTo(request: UtilityRequest): void {
    child?.postMessage(request);
  }

  function onSpawn(): void {
    spawned = true;
    // The crash counter resets only once the child has stayed up for
    // `stableAfterMs`; a crash loop therefore keeps doubling the delay.
    stabilityTimer = setTimeout(() => {
      stabilityTimer = null;
      consecutiveCrashes = 0;
    }, stableAfterMs);
    stabilityTimer.unref();
    for (const entry of queued.splice(0)) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      pending.set(entry.id, entry);
      try {
        postTo({ id: entry.id, channel: entry.channel, args: entry.args });
      } catch {
        pending.delete(entry.id);
        entry.reject(
          shellError('io-error', 'utility post failed after spawn'),
        );
      }
    }
  }

  function onMessage(raw: unknown): void {
    if (isUtilityResponse(raw)) {
      const slot = pending.get(raw.id);
      if (slot === undefined) {
        return;
      }
      pending.delete(raw.id);
      if (raw.ok) {
        slot.resolve(raw.result);
      } else {
        slot.reject(raw.error);
      }
      return;
    }
    if (isServiceCall(raw)) {
      // Utility→main service call — same envelope, other direction.
      // The channel must be whitelisted; handler failures answer typed.
      // Own-property only — an `Object.prototype` member (e.g.
      // 'constructor') resolves through the chain on a plain index
      // and would pass the whitelist check.
      const handler =
        opts.services !== undefined &&
        Object.hasOwn(opts.services, raw.channel)
          ? opts.services[raw.channel]
          : undefined;
      const target = child;
      const reply = (message: unknown): void => {
        try {
          target?.postMessage(message);
        } catch {
          // The child died mid-call — its own timeout settles it.
        }
      };
      if (handler === undefined || target === null) {
        reply({
          id: raw.id,
          ok: false,
          error: shellError(
            'invalid-request',
            `unknown service channel ${raw.channel}`,
          ),
        });
        return;
      }
      void Promise.resolve()
        .then(() => handler(raw.args))
        .then(
          (result) => reply({ id: raw.id, ok: true, result }),
          (thrown: unknown) =>
            reply({
              id: raw.id,
              ok: false,
              error: isShellError(thrown) ? thrown : fromUnknown(thrown),
            }),
        );
      return;
    }
    if (hasRequestId(raw)) {
      // A malformed reply that still names a pending request settles it —
      // otherwise the renderer would wait forever on a broken answer.
      const slot = pending.get(raw.id);
      if (slot !== undefined) {
        pending.delete(raw.id);
        slot.reject(
          shellError('invalid-response', 'malformed utility reply'),
        );
      }
    }
  }

  function onExit(): void {
    child = null;
    spawned = false;
    if (stabilityTimer !== null) {
      clearTimeout(stabilityTimer);
      stabilityTimer = null;
    }
    const error = shellError(
      'process-crashed',
      'utility process exited',
    );
    for (const slot of pending.values()) {
      slot.reject(error);
    }
    pending.clear();
    if (!stopped) {
      consecutiveCrashes += 1;
      scheduleRespawn();
    }
  }

  function scheduleRespawn(): void {
    if (stopped || respawnTimer !== null) {
      return;
    }
    const delay = Math.min(
      baseBackoffMs * 2 ** Math.max(0, consecutiveCrashes - 1),
      maxBackoffMs,
    );
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      spawn();
    }, delay);
    respawnTimer.unref();
  }

  function ensureChild(): void {
    if (child === null && respawnTimer === null) {
      spawn();
    }
  }

  return {
    request(channel, args) {
      if (stopped) {
        return Promise.reject(
          shellError('released', 'supervisor is shut down'),
        );
      }
      const live = child !== null && spawned;
      // Refuse past the cap rather than buffer without limit — a caller
      // outpacing a crash-looping utility, or a child that has quietly
      // stopped answering, would otherwise grow these maps forever.
      if (live ? pending.size >= maxPending : queued.length >= maxQueued) {
        return Promise.reject(
          shellError(
            'unavailable',
            live
              ? 'too many in-flight utility requests'
              : 'utility request queue is full',
          ),
        );
      }
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        if (live) {
          pending.set(id, { resolve, reject });
          try {
            postTo({ id, channel, args });
          } catch {
            pending.delete(id);
            reject(shellError('io-error', 'utility post failed'));
          }
        } else {
          const entry: Queued = {
            id,
            channel,
            args,
            resolve,
            reject,
            timer: null,
          };
          // Deadline only the wait for a spawn. This entry has not been
          // posted yet, so expiring it cannot double-run work; an
          // in-flight request's duration is the utility's to govern.
          entry.timer = setTimeout(() => {
            entry.timer = null;
            const at = queued.indexOf(entry);
            if (at !== -1) {
              queued.splice(at, 1);
            }
            reject(
              shellError('unavailable', 'utility did not start in time'),
            );
          }, queueDeadlineMs);
          // Deliberately not `unref`d, unlike the respawn timers: this
          // one owes the caller a settlement, so it has to be able to
          // fire even when nothing else holds the process open. It is
          // short-lived — cleared the moment the entry is posted,
          // refused, or shut down.
          queued.push(entry);
          ensureChild();
        }
      });
    },
    sendToHost(message, transfer) {
      if (stopped || child === null || !spawned) {
        return false;
      }
      try {
        child.postMessage(message, transfer);
        return true;
      } catch {
        return false;
      }
    },
    shutdown() {
      stopped = true;
      if (respawnTimer !== null) {
        clearTimeout(respawnTimer);
        respawnTimer = null;
      }
      if (stabilityTimer !== null) {
        clearTimeout(stabilityTimer);
        stabilityTimer = null;
      }
      const error = shellError('released', 'supervisor shut down');
      for (const slot of pending.values()) {
        slot.reject(error);
      }
      pending.clear();
      for (const entry of queued.splice(0)) {
        if (entry.timer !== null) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
        entry.reject(error);
      }
      const current = child;
      child = null;
      try {
        current?.kill();
      } catch {
        // Best effort — the child may already be gone.
      }
    },
    get running() {
      return child !== null;
    },
  };
}
