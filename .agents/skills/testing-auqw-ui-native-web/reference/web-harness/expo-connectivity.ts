// Alias target for the app's own `expo-connectivity.ts` adapter
// specifier (Metro can't alias a relative path into a package import).
// Reuses the fake module's singleton via the 'auqw-expo' specifier —
// which Metro resolves to fake-auqw-expo.ts under the same alias.
import type {
  ConnectivityPort,
  ConnectivitySnapshot,
} from '@auqw/application';
import { ok } from '@auqw/application';
// @ts-expect-error — resolved by the Metro alias, not the package.
import * as Native from 'auqw-expo';

export function createExpoConnectivity(): ConnectivityPort {
  const listeners = new Set<(s: ConnectivitySnapshot) => void>();
  let sub: { remove(): void } | null = null;
  return {
    snapshot() {
      return Native.connectivitySnapshot()
        .then((e: { online: boolean; metered: boolean }) =>
          ok({ online: e.online, metered: e.metered }),
        )
        .catch(() => ok({ online: false, metered: false }));
    },
    subscribe(listener) {
      listeners.add(listener);
      sub ??= Native.addConnectivityChangedListener(
        (e: { online: boolean; metered: boolean }) => {
          for (const l of [...listeners]) {
            try {
              l({ online: e.online, metered: e.metered });
            } catch {
              // A throwing listener must not break fan-out.
            }
          }
        },
      );
      Native.connectivityWatch();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          sub?.remove();
          sub = null;
          Native.connectivityUnwatch();
        }
      };
    },
  };
}

export function createUnwatchedConnectivity(): ConnectivityPort {
  return createExpoConnectivity();
}
