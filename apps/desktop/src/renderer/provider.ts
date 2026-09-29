import type {
  OperationContext,
  ProviderCapability,
  ProviderPort,
  Result,
} from '@auqw/application';
import {
  appError,
  appErrorKind,
  createIds,
  createProviderWirePort,
  decodeProviderOutcome,
  err,
  providerCancelledError,
} from '@auqw/application';
import type { AuqwApi, RequestOutcomePayload } from '../shared/contract.ts';
import { rawToAppError } from './ipc-errors.ts';

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
      let unsubscribe: () => void = () => undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      // First-settle-wins: a late outcome landing after a cancel (or a
      // dispose) must not overwrite the settled Result.
      const finish = (result: Result<T>): void => {
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
      const hostAbort = (): void => {
        // Skip the cancel when the request was never issued (a signal
        // that fired synchronously inside subscribe()).
        if (issued) {
          void host.cancelRequest({ requestId }).catch(() => undefined);
        }
      };
      const cancelInFlight = (): void => {
        hostAbort();
        finish(err(providerCancelledError()));
      };
      inFlight.set(requestId, cancelInFlight);
      // The context's own deadline bounds the call even when nothing
      // cancels it. Expiry aborts utility-side and settles typed
      // `timeout` — retryable, not the engine's `cancelled`.
      // setTimeout overflows above 2^31-1ms, so a farther-out deadline
      // re-arms until the absolute deadline has actually passed.
      const onDeadline = (): void => {
        const left = context.deadlineMs - Date.now();
        if (left > 0) {
          deadlineTimer = setTimeout(
            onDeadline,
            Math.min(left, 2_147_483_647),
          );
          return;
        }
        hostAbort();
        finish(
          err(appError('timeout', 'provider request deadline exceeded')),
        );
      };
      const left = context.deadlineMs - Date.now();
      if (left <= 0) {
        finish(
          err(appError('timeout', 'provider request deadline exceeded')),
        );
        return;
      }
      deadlineTimer = setTimeout(onDeadline, Math.min(left, 2_147_483_647));
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
        .then(
          (outcome: RequestOutcomePayload) =>
            finish(decodeProviderOutcome(outcome, appErrorKind, decode)),
          (thrown: unknown) =>
            finish(err(rawToAppError(thrown, 'host call failed'))),
        );
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
