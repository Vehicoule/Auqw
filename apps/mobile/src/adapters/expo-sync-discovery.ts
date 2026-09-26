import type {
  Result,
  SyncAdvertiseOpts,
  SyncAdvertiser,
  SyncDiscoveryPort,
  SyncDiscoverySession,
} from '@auqw/application';
import { appError, err, ok } from '@auqw/application';
import {
  nativeError,
  type AuqwExpoSubscription,
  type AuqwSyncNative,
} from './auqw-expo-surface.ts';

/**
 * SyncDiscoveryPort + advertise seam over the auqw-expo NSD bridge —
 * `syncBrowse`/`syncAdvertise` natives with `onSyncDiscovery` events
 * fanned into found/lost callbacks. The same `dev` TXT carries our fp
 * on advertise and the peer's fp on browse.
 */
export function createExpoSyncDiscovery(
  native: AuqwSyncNative,
): SyncDiscoveryPort & {
  advertise(opts: SyncAdvertiseOpts): SyncAdvertiser;
} {
  let browseSub: AuqwExpoSubscription | null = null;
  let browsing: {
    onFound: (peer: {
      name: string;
      host: string;
      port: number;
      fp: string | null;
    }) => void;
    onLost: (name: string) => void;
  } | null = null;

  // Native stop is fire-and-forget on the call site (close() is sync)
  // — chain it so a reopen can't start a browse that a late stop then
  // kills from under it.
  let stopChain: Promise<void> = Promise.resolve();

  return {
    async browse({ onFound, onLost }) {
      if (
        native.syncBrowse === undefined ||
        native.addSyncDiscoveryListener === undefined
      ) {
        return err(
          appError('unavailable', 'sync: discovery seam absent'),
        );
      }
      if (browseSub !== null) {
        return err(appError('unavailable', 'sync: already browsing'));
      }
      await stopChain;
      browsing = { onFound, onLost };
      browseSub = native.addSyncDiscoveryListener((event) => {
        if (event.type === 'found') {
          if (event.host !== undefined && event.port !== undefined) {
            // The TXT fp is a pin, not a payload — a malformed advert
            // downgrades to unpinned rather than poisoning the dial.
            const fp =
              typeof event.fp === 'string' &&
              /^[0-9a-f]{64}$/.test(event.fp)
                ? event.fp
                : null;
            browsing?.onFound({
              name: event.name,
              host: event.host,
              port: event.port,
              fp,
            });
          }
        } else if (event.type === 'lost') {
          browsing?.onLost(event.name);
        }
      });
      try {
        await native.syncBrowse();
      } catch (thrown) {
        browseSub?.remove();
        browseSub = null;
        browsing = null;
        return err(
          nativeError(thrown) ??
            appError('unavailable', 'sync: browse failed'),
        );
      }
      const session: SyncDiscoverySession = {
        close() {
          browseSub?.remove();
          browseSub = null;
          browsing = null;
          const stop = native.syncBrowseStop?.() ?? Promise.resolve();
          stopChain = stopChain.then(
            () => stop.catch(() => undefined),
            () => undefined,
          );
        },
      };
      return ok(session);
    },
    advertise({ port, name, fp }) {
      if (native.syncAdvertise === undefined) {
        return { close() {} };
      }
      void native.syncAdvertise(name, port, fp).catch(() => undefined);
      return {
        close() {
          void native.syncAdvertiseStop?.().catch(() => undefined);
        },
      };
    },
  };
}
