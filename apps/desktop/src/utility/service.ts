import { isShellError, shellError } from '../shared/errors.ts';
import { isRecord } from '../shared/check.ts';
import type { UtilityResponse } from './envelope.ts';
import { isUtilityResponse } from './validators.ts';

/**
 * Utility→main service calls. The parent port is symmetric: the same
 * `{id, channel, args}` → `{id, ok, result|error}` envelope main uses
 * to reach the utility carries utility-initiated calls back the other
 * way — safeStorage (device key custody) lives in main, so the sync
 * server's custody ops ride this. Responses are correlated by id on
 * the sending side; request and response shapes are disjoint, so a
 * reply can never be misrouted as an inbound request.
 */
export interface ServiceClient {
  request(channel: string, args: unknown): Promise<unknown>;
  /**
   * Returns true when `raw` was a service response this client owns —
   * the caller skips its normal request routing for that message.
   */
  onMessage(raw: unknown): boolean;
  /** Reject every in-flight call — shutdown path. */
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createServiceClient(opts: {
  post: (message: unknown) => void;
  timeoutMs?: number;
}): ServiceClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let nextId = 1;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();

  function settle(
    id: number,
    action: (slot: (typeof pending extends Map<number, infer S> ? S : never)) => void,
  ): void {
    const slot = pending.get(id);
    if (slot === undefined) {
      return;
    }
    pending.delete(id);
    clearTimeout(slot.timer);
    action(slot);
  }

  return {
    request(channel, args) {
      if (closed) {
        return Promise.reject(
          shellError('released', 'service client is closed'),
        );
      }
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(id, (slot) =>
            slot.reject(
              shellError('io-error', `service call ${channel} timed out`),
            ),
          );
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          opts.post({ id, channel, args });
        } catch {
          settle(id, (slot) =>
            slot.reject(shellError('io-error', 'service post failed')),
          );
        }
      });
    },
    onMessage(raw) {
      if (!isRecord(raw)) {
        return false;
      }
      // Response-shaped: an `ok` field marks a reply; a numeric id
      // without a request channel is a malformed reply. Either stays
      // out of the request dispatcher — a bounced 'malformed request'
      // reply shares the id space and can collide with an in-flight
      // request in the other direction.
      if (
        raw['ok'] === undefined &&
        !(typeof raw['id'] === 'number' && typeof raw['channel'] !== 'string')
      ) {
        return false;
      }
      if (!isUtilityResponse(raw)) {
        // Malformed, but names an outstanding call — settle it now
        // rather than leaving the caller to wait out the timeout.
        // Still carrying a request channel makes it ambiguous whether
        // this is a reply at all: consume it without rejecting — a
        // genuine reply (or the timeout) settles the call instead.
        if (
          typeof raw['id'] === 'number' &&
          typeof raw['channel'] !== 'string' &&
          pending.has(raw['id'])
        ) {
          settle(raw['id'], (slot) =>
            slot.reject(
              shellError('invalid-response', 'malformed service reply'),
            ),
          );
        }
        return true;
      }
      const response: UtilityResponse = raw;
      if (!pending.has(response.id)) {
        // A response-shaped message that matches nothing is a late reply
        // to an already-settled call (timeout, close). Consume it —
        // falling through to the request dispatcher would bounce a
        // 'malformed request' reply whose id can collide with an
        // in-flight request in the other direction.
        return true;
      }
      if (response.ok) {
        settle(response.id, (slot) => slot.resolve(response.result));
      } else {
        settle(response.id, (slot) => slot.reject(response.error));
      }
      return true;
    },
    close() {
      closed = true;
      const error = shellError('released', 'service client is closed');
      for (const [id, slot] of pending) {
        clearTimeout(slot.timer);
        slot.reject(error);
        pending.delete(id);
      }
    },
  };
}

/** Type guard a main-side dispatcher uses for inbound service calls. */
export function isServiceCall(
  value: unknown,
): value is { id: number; channel: string; args: unknown } {
  return (
    isRecord(value) &&
    typeof value['id'] === 'number' &&
    Number.isSafeInteger(value['id']) &&
    value['id'] >= 0 &&
    typeof value['channel'] === 'string' &&
    value['channel'].length > 0 &&
    value['channel'].length <= 128 &&
    Object.hasOwn(value, 'args') &&
    Object.keys(value).every((k) => ['id', 'channel', 'args'].includes(k))
  );
}
