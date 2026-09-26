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
    gen: number;
    onFound: (peer: {
      name: string;
      host: string;
      port: number;
      fp: string | null;
    }) => void;
    onLost: (name: string) => void;
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
      // Names we've emitted `found` for — a native 'stopped' (async NSD
      // start failure) must retract each so the UI list doesn't hold
      // ghosts.
      const emitted = new Set<string>();
      browseSub = native.addSyncDiscoveryListener((event) => {
        if (event.type === 'found') {
          // Shape-check before it becomes a dial target — an advert
          // with a junk port or an unbounded name never reaches the
          // nearby list.
          if (
            event.host !== undefined &&
            event.host.length > 0 &&
            event.host.length <= 255 &&
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
            browsing?.onFound({
              name: event.name,
              host: event.host,
              port: event.port as number,
              fp: event.fp ?? null,
            });
            emitted.add(event.name);
          }
        } else if (event.type === 'lost') {
          emitted.delete(event.name);
          browsing?.onLost(event.name);
        } else if (event.type === 'stopped') {
          for (const name of emitted) {
            browsing?.onLost(name);
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
    advertise({ port, name, fp }) {
      if (native.syncAdvertise === undefined) {
        return { close() {} };
      }
      advertChain = advertChain.then(
        () =>
          (native.syncAdvertise?.(name, port, fp) ?? Promise.resolve()).catch(
            () => undefined,
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
