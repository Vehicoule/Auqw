import type {
  ConnectivityPort,
  ConnectivitySnapshot,
  Result,
} from '@auqw/application';
import { err, ok } from '@auqw/application';
import type { AuqwApi } from '../shared/contract.ts';
import { shellToAppError } from './ipc-errors.ts';

/**
 * `ConnectivityPort` over `api.net` — the desktop's net-monitor seam
 * shaped for the engines. The monitor reports online edges only; a
 * failed snapshot surfaces typed, never a fabricated `online:true`.
 * `metered` reads false: the desktop monitor observes no metering —
 * matching the unwatched-mobile port's honest-unmetered convention.
 */
export function createDesktopConnectivity(api: AuqwApi): ConnectivityPort {
  return {
    async snapshot(): Promise<Result<ConnectivitySnapshot>> {
      try {
        const snap = await api.net.snapshot();
        return ok({ online: snap.online, metered: false });
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    },
    subscribe(listener) {
      return api.net.subscribe((event) => {
        listener({ online: event.online, metered: false });
      });
    },
  };
}
