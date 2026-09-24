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
};

export function createSupervisor(
  opts: SupervisorOptions,
): UtilitySupervisor {
  const baseBackoffMs = opts.baseBackoffMs ?? 100;
  const maxBackoffMs = opts.maxBackoffMs ?? 4_000;
  const stableAfterMs = opts.stableAfterMs ?? 10_000;

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
      const handler = opts.services?.[raw.channel];
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
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        if (child !== null && spawned) {
          pending.set(id, { resolve, reject });
          try {
            postTo({ id, channel, args });
          } catch {
            pending.delete(id);
            reject(shellError('io-error', 'utility post failed'));
          }
        } else {
          queued.push({ id, channel, args, resolve, reject });
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
