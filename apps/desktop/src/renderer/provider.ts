import type {
  AppError,
  OperationContext,
  ProviderCapability,
  ProviderPort,
  Result,
} from '@auqw/application';
import {
  appError,
  createProviderWirePort,
  decodeProviderOutcome,
  err,
  isRecord,
  providerCancelledError,
} from '@auqw/application';
import type { ErrorKind } from '@auqw/application';
import type { AuqwApi, RequestOutcomePayload } from '../shared/contract.ts';
import { createIds } from '@auqw/application';

export { manifestCapabilities } from '@auqw/application';

/**
 * ProviderPort over the desktop `host:*` IPC surface. The
 * transport-free half — manifest parsing, wire payloads, the
 * capability guard, outcome decode — lives in `@auqw/application`'s
 * provider-wire module; this adapter keeps only the `host.request`
 * promise transport: it mints a request id and settles on the promise
 * `host.request` resolves — the napi `startRequest` returns the
 * terminal outcome directly, so there is no out-of-band listener
 * or pending/early correlation map like the mobile adapter keeps. The
 * injected seam is the preload `host` section only; this file stays
 * DOM-free so the adapter is testable under plain Node.
 */
export type AuqwHost = AuqwApi['host'];

/**
 * Host-channel error kinds: the plugin taxonomy a guest legitimately
 * emits plus the shell kinds an IPC/preload rejection can carry (the
 * host folds transport failures into the outcome's `kind`). Unknown
 * slugs degrade to `internal`, matching the mobile map.
 */
const HOST_KIND: Readonly<Record<string, ErrorKind>> = {
  'no-result': 'no-result',
  'not-applicable': 'not-applicable',
  unsupported: 'unsupported',
  'auth-required': 'auth-required',
  'auth-expired': 'auth-expired',
  'rate-limit': 'rate-limit',
  transient: 'transient',
  'expired-resource': 'expired-resource',
  'permission-denied': 'permission-denied',
  'invalid-response': 'invalid-response',
  timeout: 'timeout',
  cancelled: 'cancelled',
  'budget-exceeded': 'budget-exceeded',
  'guest-trap': 'guest-trap',
  'invalid-message': 'invalid-message',
  'artifact-rejected': 'artifact-rejected',
  'streams-capped': 'streams-capped',
  released: 'released',
  superseded: 'superseded',
  evicted: 'evicted',
  expired: 'expired',
  'not-found': 'not-found',
  unavailable: 'unavailable',
  'storage-full': 'storage-full',
  'io-error': 'transient',
  'invalid-request': 'invalid-response',
  'not-implemented': 'unavailable',
  'process-crashed': 'unavailable',
  'corrupt-state': 'internal',
  internal: 'internal',
};

function hostKind(kind: unknown): ErrorKind {
  return typeof kind === 'string' && kind in HOST_KIND
    ? (HOST_KIND[kind] as ErrorKind)
    : 'internal';
}

/** A `host.request` rejection is a ShellError-shaped value crossing IPC. */
function hostError(thrown: unknown): AppError {
  if (isRecord(thrown)) {
    const kind = hostKind(thrown['kind']);
    const message =
      typeof thrown['message'] === 'string' && thrown['message'].length > 0
        ? (thrown['message'] as string)
        : 'host call failed';
    return appError(kind, message);
  }
  return appError('internal', 'host call failed');
}

export type PluginProvider = ProviderPort & { dispose(): void };

export function createPluginProvider(
  host: AuqwHost,
  pluginId: string,
  providerId: string,
  capabilities: readonly ProviderCapability[],
  version: string | null = null,
): PluginProvider {
  const ids = createIds();
  /** requestId → abort: in-flight calls a dispose() must settle. */
  const inFlight = new Map<string, () => void>();
  let disposed = false;

  function request<T>(
    capability: ProviderCapability,
    payload: Record<string, unknown>,
    context: OperationContext,
    decode: (value: unknown) => T | null,
  ): Promise<Result<T>> {
    const signal = context.signal;
    if (disposed) {
      return Promise.resolve(
        err(appError('unavailable', 'provider is disposed')),
      );
    }
    if (signal.cancelled) {
      return Promise.resolve(err(providerCancelledError()));
    }
    return new Promise<Result<T>>((resolve) => {
      const requestId = ids.next('req');
      let done = false;
      let issued = false;
      let unsubscribe: () => void = () => { };
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: Result<T>): void => {
        // First-settle-wins: a late outcome landing after a cancel (or
        // a dispose) must not overwrite the settled Result.
        if (done) {
          return;
        }
        done = true;
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
        }
        unsubscribe();
        inFlight.delete(requestId);
        resolve(result);
      };
      const settle = (outcome: RequestOutcomePayload): void => {
        finish(decodeProviderOutcome(outcome, hostKind, decode));
      };
      const cancelInFlight = (): void => {
        // The request is dead to us either way; the host aborts it and
        // any late outcome is dropped by the `done` guard. Skip the
        // cancel when the request was never issued (a signal that was
        // already fired synchronously inside subscribe()).
        if (issued) {
          void host.cancelRequest({ requestId }).catch(() => undefined);
        }
        finish(err(providerCancelledError()));
      };
      inFlight.set(requestId, cancelInFlight);
      // The context's own deadline bounds the call even when nothing
      // cancels it: a wedged host request can't outlive it. Expiry
      // aborts utility-side (same path as signal cancel) and settles
      // typed `timeout` — retryable, not the engine's `cancelled`.
      const onDeadline = (): void => {
        // setTimeout overflows above 2^31-1ms, so a deadline farther
        // out than that (MAX_SAFE_INTEGER ≈ unbounded) is enforced in
        // segments: re-arm while time remains, fire only when the
        // absolute deadline has actually passed.
        const left = context.deadlineMs - Date.now();
        if (left > 0) {
          deadlineTimer = setTimeout(
            onDeadline,
            Math.min(left, 2_147_483_647),
          );
          return;
        }
        if (issued) {
          void host.cancelRequest({ requestId }).catch(() => undefined);
        }
        finish(
          err(
            appError('timeout', 'provider request deadline exceeded'),
          ),
        );
      };
      if (context.deadlineMs - Date.now() <= 0) {
        finish(
          err(
            appError('timeout', 'provider request deadline exceeded'),
          ),
        );
        return;
      }
      deadlineTimer = setTimeout(
        onDeadline,
        Math.min(context.deadlineMs - Date.now(), 2_147_483_647),
      );
      // subscribe() fires the listener synchronously when the signal
      // is already cancelled — `done` then suppresses the host call.
      unsubscribe = signal.subscribe(cancelInFlight);
      if (done) {
        return;
      }
      issued = true;
      host
        .request({
          pluginId,
          capability,
          payloadJson: JSON.stringify(payload),
          requestId,
        })
        .then(settle, (thrown: unknown) => finish(err(hostError(thrown))));
    });
  }

  return {
    ...createProviderWirePort(providerId, capabilities, version, request),
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      // In-flight callers resolve as cancelled; the host is told to
      // abort each request it still holds.
      for (const cancel of [...inFlight.values()]) {
        cancel();
      }
    },
  };
}
