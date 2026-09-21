import { ok } from '@auqw/application';
import type {
  ConnectivityPort,
  ConnectivitySnapshot,
  Result,
} from '@auqw/application';
import type { AuqwConnectivityNative } from './auqw-expo-surface.ts';

/**
 * ConnectivityPort over the auqw-expo Kotlin monitor. `snapshot()` is
 * a local capabilities read (no probe); `subscribe` forwards change
 * edges — the native side emits a baseline edge on `watch`, so a
 * first subscriber learns the state immediately. The callback
 * registration is refcounted: the last unsubscribe stops it, so a
 * cold app pays zero callback cost.
 */
export function createExpoConnectivity(
  native: AuqwConnectivityNative,
): ConnectivityPort {
  const listeners = new Set<(snapshot: ConnectivitySnapshot) => void>();
  let subscription: { remove(): void } | null = null;
  let watching = false;

  const ensureWatch = (): void => {
    if (watching) {
      return;
    }
    watching = true;
    native.connectivityWatch();
    subscription = native.addConnectivityChangedListener((event) => {
      const snapshot: ConnectivitySnapshot = {
        online: event.online,
        metered: event.metered,
      };
      for (const listener of listeners) {
        try {
          listener(snapshot);
        } catch {
          // A throwing listener must not break fan-out.
        }
      }
    });
  };

  const dropWatch = (): void => {
    if (!watching) {
      return;
    }
    watching = false;
    subscription?.remove();
    subscription = null;
    native.connectivityUnwatch();
  };

  return {
    async snapshot(): Promise<Result<ConnectivitySnapshot>> {
      try {
        const event = await native.connectivitySnapshot();
        return ok({ online: event.online, metered: event.metered });
      } catch {
        // Honest offline is better than a thrown plumbing error — the
        // scheduler treats an unreadable snapshot as offline.
        return ok({ online: false, metered: false });
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      ensureWatch();
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) {
          dropWatch();
        }
      };
    },
  };
}

/**
 * Fallback port for hosts with no connectivity native surface (iOS —
 * the Kotlin monitor is Android-only). Snapshot reports
 * optimistically online/unmetered so remote playback and transfers
 * attempt normally and fail honestly if the network is actually
 * down; `subscribe` never fires (no edge source exists).
 */
export function createUnwatchedConnectivity(): ConnectivityPort {
  return {
    snapshot: () =>
      Promise.resolve(ok({ online: true, metered: false })),
    subscribe: () => () => {},
  };
}
