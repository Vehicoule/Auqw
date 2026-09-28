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
import type {
  AuqwExpoHostLike,
  AuqwExpoRequestOutcome,
} from './auqw-expo-surface.ts';
import { appErrorKind, nativeError } from './auqw-expo-surface.ts';

export { manifestCapabilities, manifestVersion } from '@auqw/application';

/**
 * ProviderPort over the auqw-expo generic-request surface. The
 * transport-free half — manifest parsing, wire payloads, the
 * capability guard, outcome decode — lives in `@auqw/application`'s
 * provider-wire module; this adapter keeps only the
 * startRequest/onRequestOutcome transport: it starts a host request
 * and settles on the correlated `onRequestOutcome` event. The module
 * is injected as `AuqwExpoHostLike`; this file stays free of React
 * Native / Expo imports so the adapter is testable under plain Node.
 */

/** Cap on stashed outcomes that outraced startRequest's promise. */
const EARLY_OUTCOME_CAP = 64;

function timeoutError(): AppError {
  return appError('timeout', 'operation deadline exceeded');
}

type Pending = {
  unsubscribe: () => void;
  settle: (outcome: AuqwExpoRequestOutcome) => void;
  cancel: () => void;
};

export type PluginProvider = ProviderPort & { dispose(): void };

export function createPluginProvider(
  host: AuqwExpoHostLike,
  pluginId: string,
  providerId: string,
  capabilities: readonly ProviderCapability[],
  version: string | null = null,
): PluginProvider {
  const pending = new Map<string, Pending>();
  /** Outcomes that arrived before their pending entry existed. */
  const early = new Map<string, AuqwExpoRequestOutcome>();
  let disposed = false;

  const subscription = host.addRequestOutcomeListener((event) => {
    if (!isRecord(event) || typeof event.requestId !== 'string') {
      return;
    }
    const entry = pending.get(event.requestId);
    if (entry !== undefined) {
      entry.settle(event.outcome);
      return;
    }
    // The outcome can outrace startRequest's promise: stash it briefly
    // for the pending entry to drain on registration.
    if (early.size >= EARLY_OUTCOME_CAP) {
      const oldest = early.keys().next();
      if (!oldest.done) {
        early.delete(oldest.value);
      }
    }
    early.set(event.requestId, event.outcome);
  });

  function dropRequest(requestId: string, entry: Pending): void {
    entry.unsubscribe();
    pending.delete(requestId);
  }

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
    // The context deadline caps the handshake too — a stalled
    // startRequest must not park the caller past it. Deadline timers
    // re-arm in slices: setTimeout overflows past ~24.8 days, so a
    // far-out deadline (e.g. a MAX_SAFE_INTEGER sentinel) re-checks
    // instead of firing early.
    // NaN deadlines (a context built without deadlineMs) must not
    // slip past: `NaN <= 0` is false, and the re-arm would fire every
    // ~0ms forever. `!(x > 0)` fails closed on NaN while Infinity
    // still slices correctly.
    const msLeft = context.deadlineMs - Date.now();
    if (!(msLeft > 0)) {
      return Promise.resolve(err(timeoutError()));
    }
    return (async () => {
      // Race the handshake against the deadline — a startRequest that
      // outlives it still settles here, and its late id is cancelled.
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      let expireStart: (() => void) | undefined;
      const expired = new Promise<{ kind: 'expired' }>((res) => {
        expireStart = () => res({ kind: 'expired' });
      });
      const armStartDeadline = (): void => {
        startTimer = setTimeout(
          () => {
            if (!(context.deadlineMs - Date.now() > 0)) {
              expireStart?.();
            } else {
              armStartDeadline();
            }
          },
          Math.min(context.deadlineMs - Date.now(), 0x7fffffff),
        );
      };
      armStartDeadline();
      let call: Promise<string>;
      try {
        // A synchronous host throw is a typed failure, never a
        // rejection; resolve() also normalizes a non-promise return.
        call = Promise.resolve(
          host.startRequest(pluginId, capability, payload),
        );
      } catch (thrown) {
        clearTimeout(startTimer);
        return err(nativeError(thrown));
      }
      const started = call.then(
        (id) => ({ kind: 'started' as const, id }),
        (thrown) => ({ kind: 'threw' as const, thrown }),
      );
      const first = await Promise.race([started, expired]);
      clearTimeout(startTimer);
      if (first.kind === 'expired') {
        void started.then((late) => {
          if (
            late.kind === 'started' &&
            typeof late.id === 'string' &&
            late.id.length > 0
          ) {
            // Best-effort abort — a throwing host must not turn the
            // already-returned timeout into an unhandled rejection.
            try {
              host.cancel(late.id);
            } catch {
              // dead either way
            }
          }
        });
        return err(timeoutError());
      }
      if (first.kind === 'threw') {
        return err(nativeError(first.thrown));
      }
      const requestId = first.id;
      if (typeof requestId !== 'string' || requestId.length === 0) {
        return err(appError('invalid-response', 'empty request id'));
      }
      if (disposed || signal.cancelled) {
        try {
          host.cancel(requestId);
        } catch {
          // dead either way
        }
        return err(
          disposed
            ? appError('unavailable', 'provider is disposed')
            : providerCancelledError(),
        );
      }
      return new Promise<Result<T>>((resolve) => {
        let unsubscribe = (): void => { };
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: Result<T>): void => {
          const entry = pending.get(requestId);
          if (entry === undefined) {
            return;
          }
          dropRequest(requestId, entry);
          if (deadlineTimer !== undefined) {
            clearTimeout(deadlineTimer);
          }
          resolve(result);
        };
        const settle = (outcome: AuqwExpoRequestOutcome): void => {
          finish(
            decodeProviderOutcome(
              outcome,
              (slug) => appErrorKind(slug ?? ''),
              decode,
            ),
          );
        };
        const cancelInFlight = (): void => {
          const current = pending.get(requestId);
          if (current === undefined) {
            return;
          }
          dropRequest(requestId, current);
          if (deadlineTimer !== undefined) {
            clearTimeout(deadlineTimer);
          }
          // The request is dead to us either way; the host aborts it
          // and any late outcome is dropped.
          try {
            host.cancel(requestId);
          } catch {
            // dead either way
          }
          resolve(err(providerCancelledError()));
        };
        const timeoutInFlight = (): void => {
          const current = pending.get(requestId);
          if (current === undefined) {
            return;
          }
          dropRequest(requestId, current);
          try {
            host.cancel(requestId);
          } catch {
            // dead either way
          }
          resolve(err(timeoutError()));
        };
        const armDeadlineTimer = (): void => {
          deadlineTimer = setTimeout(
            () => {
              if (!(context.deadlineMs - Date.now() > 0)) {
                timeoutInFlight();
              } else {
                armDeadlineTimer();
              }
            },
            Math.min(context.deadlineMs - Date.now(), 0x7fffffff),
          );
        };
        const entry: Pending = {
          unsubscribe: () => unsubscribe(),
          settle,
          cancel: cancelInFlight,
        };
        pending.set(requestId, entry);
        unsubscribe = signal.subscribe(cancelInFlight);
        armDeadlineTimer();
        const stashed = early.get(requestId);
        if (stashed !== undefined) {
          early.delete(requestId);
          settle(stashed);
        }
      });
    })();
  }

  return {
    ...createProviderWirePort(providerId, capabilities, version, request),
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      subscription.remove();
      // In-flight callers resolve as cancelled; the host is told to
      // abort each request it still holds.
      for (const entry of [...pending.values()]) {
        entry.cancel();
      }
      early.clear();
    },
  };
}
