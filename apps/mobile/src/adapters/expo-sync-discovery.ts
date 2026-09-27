import type {
  Result,
  SyncAdvertiseOpts,
  SyncDiscoveredPeer,
  SyncAdvertiser,
  SyncDiscoveryPort,
  SyncDiscoverySession,
} from '@auqw/application';
import { appError, err, ok, pickDialableHost } from '@auqw/application';
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
      // name → (key → {port, fp}) — an instance name is NOT unique on
      // a LAN (two devices can both advertise "Phone"), so rows
      // coexist per service. The generation identity is the advert's
      // `dev` fp when present — it survives hostname/port/address
      // changes — falling back to the listener port for unpinned
      // adverts. A native 'lost' carries only the service name, and a
      // native 'stopped' (async NSD failure) must retract each emitted
      // peer so the UI holds no ghosts.
      const emitted = new Map<
        string,
        Map<string, { port: number | undefined; fp: string | null }>
      >();
      const validFp = (v: unknown): string | null =>
        typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null;
      // Retract rows of one generation: by fp when the record pins
      // one, else by port — and every row under the name when neither
      // is usable. A `found` that fails the gates below must still
      // retract rows a previous `found` emitted — otherwise the last
      // usable endpoint stays dialable after the advert turned
      // unpairable.
      const retract = (
        name: string,
        fp: string | null,
        port?: number,
      ) => {
        const entries = emitted.get(name);
        if (entries === undefined) {
          return;
        }
        for (const [key, e] of entries) {
          const hit =
            fp !== null
              ? e.fp === fp
              : port === undefined || e.port === undefined || e.port === port;
          if (hit) {
            entries.delete(key);
            browsing?.onLost(key);
          }
        }
        if (entries.size === 0) {
          emitted.delete(name);
        }
      };
      browseSub = native.addSyncDiscoveryListener((event) => {
        if (event.type === 'found') {
          // `hosts` carries every resolved address — pick the dialable
          // one (a public v4 or bare fe80:: literal must not shadow a
          // pairable address behind it). Older module revisions emit
          // only `host`, which stays the single-candidate fallback.
          const host = pickDialableHost(
            event.hosts ?? (event.host !== undefined ? [event.host] : []),
          );
          const port =
            Number.isSafeInteger(event.port) &&
            (event.port ?? 0) >= 1 &&
            (event.port ?? 0) <= 65_535
              ? (event.port as number)
              : undefined;
          // A PRESENT-but-malformed `fp` poisons the pin the pair
          // would dial with — drop the advert rather than serve an
          // unpinned tap-target. NSD reports `fp: null` for a
          // TXT-less advert — that's a valid unpinned candidate.
          const fp = validFp(event.fp);
          const malformedFp = event.fp != null && fp === null;
          // Shape-check before it becomes a dial target — an advert
          // with a junk port or an unbounded name never reaches the
          // nearby list.
          if (
            host === null ||
            port === undefined ||
            event.name.length === 0 ||
            event.name.length > 128 ||
            malformedFp
          ) {
            retract(
              event.name,
              fp,
              Number.isSafeInteger(event.port)
                ? (event.port as number)
                : undefined,
            );
            return;
          }
          const key = `${event.name}|${host}`;
          let entries = emitted.get(event.name);
          if (entries === undefined) {
            entries = new Map();
            emitted.set(event.name, entries);
          }
          // Same service re-announcing: match the generation by its
          // advert fp (survives port/address churn), else by listener
          // port for unpinned adverts — the 'lost' event is name-only
          // and would retract every row under the name.
          const prior = [...entries.entries()].find(([, e]) =>
            fp !== null
              ? e.fp === fp
              : e.fp === null && e.port === port,
          )?.[0];
          if (prior !== undefined && prior !== key) {
            entries.delete(prior);
            browsing?.onLost(prior);
          }
          browsing?.onFound({
            key,
            name: event.name,
            host,
            port,
            fp,
          });
          entries.set(key, { port, fp });
        } else if (event.type === 'lost') {
          // NSD reports only the service name on loss — every row
          // under it goes (a surviving same-named neighbor re-announces
          // on its next PTR refresh).
          retract(event.name, null);
        } else if (event.type === 'stopped') {
          for (const entries of emitted.values()) {
            for (const key of entries.keys()) {
              browsing?.onLost(key);
            }
          }
          emitted.clear();
        }
      });
      try {
        await native.syncBrowse();
      } catch (thrown) {
        // Failure cleanup is scoped to OUR generation: if a newer
        // browse took the slot meanwhile, its native session owns the
        // multicast lock — stopping here would kill the newer browse.
        const ours = browsing?.gen === gen;
        if (ours) {
          browseSub?.remove();
          browseSub = null;
          browsing = null;
        }
        // The native side may have taken the multicast lock and spawned
        // its executor before failing — a rejected start still owes a
        // stop, but only while we still own the slot.
        if (ours) {
          const stop = native.syncBrowseStop?.() ?? Promise.resolve();
          stopChain = stopChain.then(
            () => stop.catch(() => undefined),
            () => undefined,
          );
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
