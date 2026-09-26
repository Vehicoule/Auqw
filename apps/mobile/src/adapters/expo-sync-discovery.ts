import type {
  Result,
  SyncAdvertiseOpts,
  SyncDiscoveredPeer,
  SyncAdvertiser,
  SyncDiscoveryPort,
  SyncDiscoverySession,
} from '@auqw/application';
import { appError, err, isPairableLanHost, ok } from '@auqw/application';
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
    gen: number;
    onFound: (peer: SyncDiscoveredPeer) => void;
    onLost: (key: string) => void;
  } | null = null;
  // Browse occupancy is claimed SYNCHRONOUSLY (before any await) — a
  // second caller waiting on a pending stop can't slip through the
  // guard and two starts can't co-own the shared listener. `gen`
  // scopes close() to the generation that installed it.
  let browseGen = 0;

  // Native stop is fire-and-forget on the call site (close() is sync)
  // — chain it so a reopen can't start a browse that a late stop then
  // kills from under it. Same for advertise: a rapid share toggle can
  // land an old advertiseStop on top of a fresh registration.
  let stopChain: Promise<void> = Promise.resolve();
  let advertChain: Promise<void> = Promise.resolve();

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
      if (browsing !== null) {
        return err(appError('unavailable', 'sync: already browsing'));
      }
      const gen = ++browseGen;
      browsing = { gen, onFound, onLost };
      await stopChain;
      if (browsing?.gen !== gen) {
        // Superseded while the stop settled — we no longer own the
        // browse slot, so don't install a listener we'd leak.
        return err(appError('cancelled', 'sync: browse superseded'));
      }
      // serviceName → emitted key — a native 'lost' carries only the
      // service name, and a native 'stopped' (async NSD failure) must
      // retract each emitted peer so the UI holds no ghosts.
      const emitted = new Map<string, string>();
      browseSub = native.addSyncDiscoveryListener((event) => {
        if (event.type === 'found') {
          // Shape-check before it becomes a dial target — an advert
          // with a junk port or an unbounded name never reaches the
          // nearby list.
          if (
            event.host !== undefined &&
            event.host.length > 0 &&
            event.host.length <= 255 &&
            isPairableLanHost(event.host) &&
            Number.isSafeInteger(event.port) &&
            (event.port ?? 0) >= 1 &&
            (event.port ?? 0) <= 65_535 &&
            event.name.length > 0 &&
            event.name.length <= 128
          ) {
            // A PRESENT-but-malformed `fp` poisons the pin the pair
            // would dial with — drop the advert rather than serve an
            // unpinned tap-target. NSD reports `fp: null` for a
            // TXT-less advert — that's a valid unpinned candidate.
            if (
              event.fp != null &&
              !/^[0-9a-f]{64}$/.test(event.fp)
            ) {
              return;
            }
            const key = `${event.name}|${event.host}`;
            browsing?.onFound({
              key,
              name: event.name,
              host: event.host,
              port: event.port as number,
              fp: event.fp ?? null,
            });
            emitted.set(event.name, key);
          }
        } else if (event.type === 'lost') {
          const key = emitted.get(event.name);
          emitted.delete(event.name);
          if (key !== undefined) {
            browsing?.onLost(key);
          }
        } else if (event.type === 'stopped') {
          for (const key of emitted.values()) {
            browsing?.onLost(key);
          }
          emitted.clear();
        }
      });
      try {
        await native.syncBrowse();
      } catch (thrown) {
        if (browsing?.gen === gen) {
          browseSub?.remove();
          browseSub = null;
          browsing = null;
        }
        // The native side may have taken the multicast lock and spawned
        // its executor before failing — a rejected start still owes a
        // stop, best-effort and serialized with any real stop.
        const stop = native.syncBrowseStop?.() ?? Promise.resolve();
        stopChain = stopChain.then(
          () => stop.catch(() => undefined),
          () => undefined,
        );
        return err(
          nativeError(thrown) ??
            appError('unavailable', 'sync: browse failed'),
        );
      }
      const session: SyncDiscoverySession = {
        close() {
          // Scoped to our generation — a stale handle can't remove a
          // newer browse's subscription or null its callbacks.
          if (browsing?.gen !== gen) {
            return;
          }
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
    advertise({ port, name, fp, onError }) {
      if (native.syncAdvertise === undefined) {
        return { close() {} };
      }
      advertChain = advertChain.then(
        () =>
          (native.syncAdvertise?.(name, port, fp) ?? Promise.resolve()).catch(
            () => {
              // A rejected announce means the offer pairs by code but
              // is NOT discoverable nearby — surface it, don't leave a
              // live-looking dead advert.
              onError?.();
            },
          ),
        () => undefined,
      );
      return {
        close() {
          advertChain = advertChain.then(
            () =>
              (native.syncAdvertiseStop?.() ?? Promise.resolve()).catch(
                () => undefined,
              ),
            () => undefined,
          );
        },
      };
    },
  };
}
