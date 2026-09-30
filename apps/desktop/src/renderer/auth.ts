import type { AuthSnapshot, AuthStatus, Result } from '@auqw/application';
import { appErrorKind, err, ok } from '@auqw/application';
import type { AuthShellPort } from '@auqw/app-shell';
import type { AuqwApi, AuthSnapshotPayload } from '../shared/contract.ts';
import { shellToAppError } from './ipc-errors.ts';

/**
 * The renderer's AuthShellPort: a local snapshot cache fed by the
 * `auth:state` push channel plus one `auth:status` pull on first
 * subscribe (the pull covers publishes that landed before the page
 * subscribed). Verbs forward to the utility's auth service — the
 * refresh/access tokens themselves never cross this surface.
 */
export function createDesktopAuth(api: AuqwApi): AuthShellPort {
  let snap: AuthSnapshot = {
    status: { state: 'signed-out' },
    clientId: null,
    bearerLive: false,
  };
  const listeners = new Set<() => void>();
  let wired = false;
  let pushes = 0;

  function toStatus(status: AuthSnapshotPayload['status']): AuthStatus {
    // The wire error's `kind` is a slug — map back through the
    // taxonomy so an untyped value never reaches errorText.
    if (status.state === 'failed') {
      return {
        state: 'failed',
        error: {
          kind: appErrorKind(status.error.kind),
          message: status.error.message,
          retryable: status.error.retryable,
          ...(status.error.retryAfterMs !== undefined
            ? { retryAfterMs: status.error.retryAfterMs }
            : {}),
        },
      };
    }
    return status;
  }

  function apply(payload: AuthSnapshotPayload): void {
    snap = {
      status: toStatus(payload.status),
      clientId: payload.clientId,
      bearerLive: payload.bearerLive,
    };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a throwing subscriber must not wedge the publisher
      }
    }
  }

  function wire(): void {
    if (wired) {
      return;
    }
    wired = true;
    api.auth.onState((payload) => {
      pushes += 1;
      apply(payload);
    });
    // The pull lands AFTER the subscription is armed so a snapshot
    // published between the two can't be missed — but a delayed pull
    // reply must not roll back a push that already landed (the pull
    // is only valid if nothing arrived since it was sent).
    const gen = pushes;
    void api.auth
      .status()
      .then((payload) => {
        if (pushes === gen) {
          apply(payload);
        }
      })
      .catch(() => undefined);
  }

  return {
    snapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      wire();
      return () => {
        listeners.delete(listener);
      };
    },
    beginSignIn() {
      void api.auth.begin().catch(() => undefined);
    },
    cancelSignIn() {
      void api.auth.cancel().catch(() => undefined);
    },
    signOut(): Promise<Result<void>> {
      return api.auth.signOut().then(
        () => ok(undefined),
        (thrown: unknown) => err(shellToAppError(thrown)),
      );
    },
    retryNow() {
      void api.auth.retry().catch(() => undefined);
    },
    setClientOverride(clientId: string | null): Promise<Result<void>> {
      return api.auth.setClient(clientId).then(
        () => ok(undefined),
        (thrown: unknown) => err(shellToAppError(thrown)),
      );
    },
    copyText(text: string): void {
      void navigator.clipboard.writeText(text).catch(() => undefined);
    },
    openUrl(url: string): void {
      void api.auth.openUrl(url).catch(() => undefined);
    },
  };
}
