import type {
  UpdateApplyStatus,
  UpdateSnapshot,
  UpdateStatus,
} from '@auqw/application';
import type { AppError } from '@auqw/application';
import { appErrorKind } from '@auqw/application';
import type { UpdateShellPort } from '@auqw/app-shell';
import type { AuqwApi, UpdateSnapshotPayload } from '../shared/contract.ts';

/**
 * The renderer's UpdateShellPort: a local snapshot cache fed by the
 * `update:state` push channel plus one `update:status` pull on first
 * subscribe (the pull covers publishes that landed before the page
 * subscribed) — same shape as `createDesktopAuth`. The check + the
 * whole apply pipeline run in main: the renderer CSP admits only
 * 'self', so the artifact's bytes and its SHA256SUMS verification
 * never cross the bridge — snapshots and verbs only. `action` is
 * main's own capability verdict riding the snapshot: 'install' on
 * AppImage + NSIS, 'download' on dmg, 'open' on flatpak and unknown
 * builds — `act()` routes on it and on the live apply phase.
 */
export function createDesktopUpdate(api: AuqwApi): UpdateShellPort {
  let snap: UpdateSnapshot = {
    status: { state: 'idle' },
    currentVersion: '',
    apply: { state: 'idle' },
  };
  let capability: UpdateSnapshotPayload['capability'] = 'open';
  const listeners = new Set<() => void>();
  let wired = false;
  let pushes = 0;

  type WireError = {
    readonly kind: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
  };

  function toError(error: WireError): AppError {
    // The wire error's `kind` is a slug — map back through the
    // taxonomy so an untyped value never reaches errorText.
    return {
      kind: appErrorKind(error.kind),
      message: error.message,
      retryable: error.retryable,
      ...(error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
    };
  }

  function toStatus(status: UpdateSnapshotPayload['status']): UpdateStatus {
    if (status.state === 'failed') {
      return { state: 'failed', error: toError(status.error) };
    }
    return status;
  }

  function toApply(apply: UpdateSnapshotPayload['apply']): UpdateApplyStatus {
    if (apply.state === 'failed') {
      return { ...apply, error: toError(apply.error) };
    }
    return apply;
  }

  function apply(payload: UpdateSnapshotPayload): void {
    snap = {
      status: toStatus(payload.status),
      currentVersion: payload.currentVersion,
      apply: toApply(payload.apply),
    };
    capability = payload.capability;
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
    get action() {
      // The banner label follows the capability, except when the
      // release can't prove the artifact — no artifact at all, or
      // one it ships without checksums: an unverifiable artifact
      // never installs, so the page is the honest affordance.
      return snap.status.state === 'available' &&
        (snap.status.artifact === null || snap.status.checksums === null)
        ? 'open'
        : capability;
    },
    act() {
      const applyState = snap.apply.state;
      if (applyState === 'ready-to-restart') {
        void api.update.restart().catch(() => undefined);
        return;
      }
      if (applyState === 'applied' && snap.apply.state === 'applied') {
        const status = snap.status;
        // A newer release starts its own pipeline (or the page when
        // this build can't install it); re-acting on the APPLIED
        // release refires the OS handoff — the verified dmg is still
        // staged, so re-mounting costs no download and a closed
        // installer window never dead-ends the update.
        if (
          status.state === 'available' &&
          status.version === snap.apply.version
        ) {
          void api.update.reapply().catch(() => undefined);
          return;
        }
        if (
          status.state === 'available' &&
          capability !== 'open' &&
          status.artifact !== null &&
          status.checksums !== null
        ) {
          void api.update.apply().catch(() => undefined);
        } else {
          void api.update.open().catch(() => undefined);
        }
        return;
      }
      if (
        applyState === 'downloading' ||
        applyState === 'verifying' ||
        applyState === 'applying'
      ) {
        return;
      }
      // 'idle' or 'failed' — the affordance starts (or retries) the
      // pipeline on self-install builds, opens the page on 'open'.
      if (
        capability !== 'open' &&
        snap.status.state === 'available' &&
        snap.status.artifact !== null &&
        snap.status.checksums !== null
      ) {
        void api.update.apply().catch(() => undefined);
      } else {
        void api.update.open().catch(() => undefined);
      }
    },
    cancel() {
      void api.update.cancel().catch(() => undefined);
    },
  };
}
