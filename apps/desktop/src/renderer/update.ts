import type { UpdateSnapshot, UpdateStatus } from '@auqw/application';
import { appErrorKind } from '@auqw/application';
import type { UpdateShellPort } from '@auqw/app-shell';
import type { AuqwApi, UpdateSnapshotPayload } from '../shared/contract.ts';

/**
 * The renderer's UpdateShellPort: a local snapshot cache fed by the
 * `update:state` push channel plus one `update:status` pull on first
 * subscribe (the pull covers publishes that landed before the page
 * subscribed) — same shape as `createDesktopAuth`. The check itself
 * runs in main: the renderer CSP admits only 'self', and the only
 * egress is the releases list. Desktop's install level is 'open' —
 * no updater infra ships in the alpha packaging, so `act()` opens
 * the release page through main's allowlisted `update:open`.
 */
export function createDesktopUpdate(api: AuqwApi): UpdateShellPort {
  let snap: UpdateSnapshot = {
    status: { state: 'idle' },
    currentVersion: '',
  };
  const listeners = new Set<() => void>();
  let wired = false;
  let pushes = 0;

  function toStatus(status: UpdateSnapshotPayload['status']): UpdateStatus {
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

  function apply(payload: UpdateSnapshotPayload): void {
    snap = {
      status: toStatus(payload.status),
      currentVersion: payload.currentVersion,
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
    api.update.onState((payload) => {
      pushes += 1;
      apply(payload);
    });
    // The pull lands AFTER the subscription is armed so a snapshot
    // published between the two can't be missed — but a delayed pull
    // reply must not roll back a push that already landed.
    const gen = pushes;
    void api.update
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
    check(kind) {
      // The settled snapshot both applies locally and arrives again
      // over `update:state` — the push is the same object, so the
      // double-apply is a no-op notify.
      void api.update
        .check(kind)
        .then(apply)
        .catch(() => undefined);
    },
    action: 'open',
    act() {
      void api.update.open().catch(() => undefined);
    },
  };
}
