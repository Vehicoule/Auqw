import type {
  SyncDiscoveredPeer,
  SyncDiscoverySession,
  ApplyResult,
  CancellationSignal,
  ClockPort,
  IdPort,
  LogPort,
  Result,
  SyncClient,
  SyncClientKeys,
  SyncEngine,
  SyncIdentity,
  SyncLogStore,
} from '@auqw/application';
import {
  appError,
  createSyncClient,
  createSyncEngine,
  createSyncPairHost,
  DEVICE_NAME_MAX,
  ensureSyncIdentity,
  err,
  formatEndpoint,
  ok,
} from '@auqw/application';
import {
  base64Decode,
  createNobleIdentity,
  createNobleSyncCrypto,
  createNobleSyncResponder,
  nobleFingerprintOf,
} from './noble-sync-crypto.ts';
import { createExpoSyncAcceptor } from './expo-sync-listener.ts';
import { createExpoSyncDiscovery } from './expo-sync-discovery.ts';
import { createExpoSyncSockets } from './expo-sync-socket.ts';
import { createSyncPeerRegistry } from './sync-peer-registry.ts';
import { nativeError, type AuqwSyncNative } from './auqw-expo-surface.ts';

/**
 * The whole mobile sync stack over the auqw-expo native seam —
 * socket port + CSPRNG from the Kotlin module, noble crypto, custody
 * over expo-secure-store. `hasSyncSocket()` should gate this at the
 * caller; a missing seam surfaces as typed 'unavailable' at connect,
 * never as a thrown TypeError.
 *
 * Wiring order mirrors what the client requires: custody owns the
 * deviceId (the install's sync identity), the engine stamps it on
 * every local change, and the wire hello claims the same value — so
 * the identity resolves BEFORE the engine and client exist.
 */

export type ExpoSyncDeps = {
  readonly host: AuqwSyncNative;
  /** Durable sync-log custody — SqliteSyncLogStore on the app DB. */
  readonly logStore: SyncLogStore;
  readonly ids: IdPort;
  readonly clock: ClockPort;
  readonly log: LogPort;
  /** Optional custody override — tests inject memory stores. */
  readonly keys?: SyncClientKeys;
  /**
   * Fires after every successful `applyDelta` — the domain-projection
   * seam. The engine hands the `ApplyResult` (merged entries +
   * outcomes) to the Session; applied here so EVERY inbound path
   * (syncNow pages plus any later caller of `surface.engine
   * .applyDelta`) notifies, not just the round driver.
   */
  readonly onApplied?: (applied: ApplyResult) => void;
  /** A peer paired through OUR listener — the UI refreshes custody. */
  readonly onPaired?: () => Promise<unknown> | void;
};

export type ExpoSyncSurface = {
  readonly client: SyncClient;
  readonly engine: SyncEngine;
  readonly deviceId: string;
  /**
   * The pair-host half (symmetric pairing): this device listens and
   * accepts the other side's hello — QR + code flow in reverse.
   * Null when the build lacks the native listener seam.
   */
  readonly host: ExpoPairHostSurface | null;
  /**
   * `_auqw._tcp` browse — the pair sheet's nearby list. Best-effort:
   * a browse failure resolves to an empty list, never a blocker.
   */
  readonly discovery: {
    browse(opts: {
      onFound(peer: SyncDiscoveredPeer): void;
      onLost(key: string): void;
    }): Promise<Result<SyncDiscoverySession>>;
  } | null;
};

export type ExpoPairHostSurface = {
  /** Bind the listener + advertise — resolves the bound port. */
  start(signal?: CancellationSignal): Promise<Result<{ port: number }>>;
  /**
   * Mint the pair offer: the 6-digit code the other side proves AND
   * the QR payload ({v, endpoint, endpoints, code, fp}) it scans —
   * one live offer at a time. Endpoints resolve LAN IPv4 first.
   */
  mintOffer(): Promise<
    Result<{ code: string; payload: string; expiresAt: number }>
  >;
  readonly port: number | null;
  /** LAN IPv4:port list this host advertises — empty pre-start. */
  localEndpoints(): Promise<readonly string[]>;
  /** Last-minted LAN endpoints with the CURRENT port — sync getter
   * for the client hello's `endpoints` advert. */
  advertisedEndpoints(): readonly string[];
  /** Unbind + deadvertise; a later start() binds a fresh port. */
  stop(): Promise<void>;
  /** Terminal teardown — session dispose. */
  close(): Promise<void>;
  /**
   * Subscribe to inbound pairs — the shown offer's code is consumed
   * the moment one lands, so the share UI remints immediately rather
   * than display a dead code until expiry.
   */
  onPaired(cb: () => void): () => void;
};

function nativeRandom(host: AuqwSyncNative): (n: number) => Uint8Array {
  return (n) => {
    const bytes = base64Decode(host.syncRandomBytes(n));
    if (bytes === null || bytes.length !== n) {
      throw new Error('sync: native RNG returned malformed bytes');
    }
    return bytes;
  };
}

export async function createExpoSync(
  deps: ExpoSyncDeps,
): Promise<Result<ExpoSyncSurface>> {
  // One boundary covers native throws anywhere in init — RNG,
  // custody, engine, codec — so a sync failure surfaces as a typed
  // error (honest 'unavailable'), never as a boot-killing rejection.
  try {
    // expo-secure-store resolves through Metro, not plain node —
    // pull it lazily so injected custody never pays the native import.
    const keys =
      deps.keys ??
      (await import('./secure-sync-keys.ts')).createSecureSyncKeys();
    const random = nativeRandom(deps.host);
    const custody = await ensureSyncIdentity({
      keys,
      crypto: { createIdentity: () => createNobleIdentity(random) },
      ids: deps.ids,
    });
    if (!custody.ok) {
      return err(custody.error);
    }
    const deviceId = custody.value.deviceId;
    // The wire `name` is what paired devices display — the OS
    // device name, else the install id's head as before.
    let deviceName = `auqw ${deviceId.slice(0, 8)}`;
    try {
      const nativeName = deps.host.syncDeviceName?.().trim();
      if (nativeName !== undefined && nativeName.length > 0) {
        deviceName = nativeName.slice(0, DEVICE_NAME_MAX);
      }
    } catch {
      // A native throw degrades to the derived label, never fails sync.
    }
    const engine = await createSyncEngine({
      store: deps.logStore,
      clock: deps.clock,
      ids: deps.ids,
      log: deps.log,
      deviceId,
    });
    if (!engine.ok) {
      return err(engine.error);
    }
    // Domain projection seam: wrap applyDelta once so every merge
    // notifies — the round driver's pages AND any direct apply path
    // through the surface land the same projection.
    const wrappedEngine: SyncEngine =
      deps.onApplied === undefined
        ? engine.value
        : {
            ...engine.value,
            applyDelta: async (doc, signal) => {
              const applied = await engine.value.applyDelta(doc, signal);
              if (applied.ok) {
                deps.onApplied?.(applied.value);
              }
              return applied;
            },
          };
    const crypto = createNobleSyncCrypto({
      identity: custody.value.identity,
      randomBytes: random,
    });
    const client = createSyncClient({
      sockets: createExpoSyncSockets(deps.host),
      crypto,
      keys,
      engine: wrappedEngine,
      ids: deps.ids,
      clock: deps.clock,
      log: deps.log,
      deviceId,
      name: deviceName,
      // Advertised endpoints let the responder prefer our real LAN
      // addrs over the socket's (possibly NAT-mistranslated) source.
      // `host` is built below — the getters only run at dial time.
      listenPort: () => host?.port ?? null,
      listenEndpoints: () => host?.advertisedEndpoints() ?? [],
    });
    // Hydrate custody before the surface is exposed — the UI reads
    // status() first, and it must already show the paired desktops.
    const hydrated = await client.peers();
    if (!hydrated.ok) {
      await client.close();
      return err(hydrated.error);
    }
    // The pair-host half — the phone as the QR-side. The native
    // listener seam decides availability; without it the surface is
    // honest-null and the pair sheet hides the show-code affordance.
    const host = buildPairHost({
      native: deps.host,
      identity: custody.value.identity,
      random,
      keys,
      deviceId,
      name: deviceName,
      clock: deps.clock,
      // The resumed peer may have announced a fresh endpoint (its
      // listener port is ephemeral) — reload custody into the client
      // map BEFORE the sync round, or syncNow dials the stale port.
      kickResume: (fp) =>
        void client.refreshPeers().then(() => client.syncNow(fp)),
      onPair: (peer) => {
        // Custody is committed — the displayed code is already
        // consumed, so remint IMMEDIATELY (a slow sync round must not
        // hold a dead code on screen). The sync round then runs
        // independently: reload custody into the client's map first
        // so syncNow dials the fresh endpoint.
        deps.onPaired?.();
        void client
          .refreshPeers()
          .then(() => client.syncNow(peer.fp))
          .catch(() => undefined);
      },
    });
    const discovery =
      deps.host.syncBrowse === undefined
        ? null
        : createExpoSyncDiscovery(deps.host);
    return ok({
      client,
      engine: wrappedEngine,
      deviceId,
      host,
      discovery,
    });
  } catch (thrown) {
    // Native exception text can carry paths, URLs, or stack detail and
    // the log sink performs no redaction — neither the typed error nor
    // the log may quote it; the kind survives as the only signal.
    const mapped = nativeError(thrown);
    void deps.log.write({
      level: 'error',
      message: `sync init failed (${mapped.kind})`,
      atMs: deps.clock.nowMs(),
    });
    return err(appError(mapped.kind, 'sync initialization failed'));
  }
}

/** The phone-side responder + listener composition — null when the
 * build lacks the native listener (`syncListen`). */
function buildPairHost(opts: {
  native: AuqwSyncNative;
  identity: SyncIdentity;
  random: (n: number) => Uint8Array;
  keys: SyncClientKeys;
  deviceId: string;
  name: string;
  clock: ClockPort;
  kickResume: (fp: string) => void;
  onPair: (peer: { readonly fp: string }) => void;
}): ExpoPairHostSurface | null {
  if (opts.native.syncListen === undefined) {
    return null;
  }
  const discovery = createExpoSyncDiscovery(opts.native);
  const fp = nobleFingerprintOf(opts.identity.pub);
  const pairedSubs = new Set<() => void>();
  const pairHost = createSyncPairHost({
    acceptor: createExpoSyncAcceptor(opts.native),
    crypto: createNobleSyncResponder({
      identity: opts.identity,
      randomBytes: opts.random,
    }),
    registry: createSyncPeerRegistry(opts.keys),
    deviceId: opts.deviceId,
    name: opts.name,
    fp,
    fingerprintOf: nobleFingerprintOf,
    advertise: discovery.advertise,
    mintCode: () => {
      const bytes = opts.random(4);
      const value =
        (((bytes[0] ?? 0) << 24) |
          ((bytes[1] ?? 0) << 16) |
          ((bytes[2] ?? 0) << 8) |
          (bytes[3] ?? 0)) >>>
        0;
      return (value % 1_000_000).toString().padStart(6, '0');
    },
    clock: opts.clock,
    onResume: (peer) => opts.kickResume(peer.fp),
    onPair: (peer) => {
      for (const cb of pairedSubs) {
        try {
          cb();
        } catch {
          // a dead UI subscriber must not kill the pair path
        }
      }
      opts.onPair(peer);
    },
  });
  // Last LAN hosts the native layer reported — refreshed on each
  // mint; the advertised-endpoint getter formats them with whatever
  // port the listener CURRENTLY holds.
  let cachedLanHosts: readonly string[] = [];
  const localEndpoints = async (): Promise<readonly string[]> => {
    if (
      opts.native.syncLocalHosts === undefined ||
      pairHost.port === null
    ) {
      return [];
    }
    const { hosts } = await opts.native.syncLocalHosts();
    cachedLanHosts = hosts;
    const port = pairHost.port;
    return port === null ? [] : hosts.map((h) => formatEndpoint(h, port));
  };
  return {
    start: (signal) => pairHost.start(signal),
    async mintOffer() {
      const minted = pairHost.mintOffer();
      if (!minted.ok) {
        return minted;
      }
      const endpoints = await localEndpoints();
      const primary = endpoints[0];
      if (primary === undefined) {
        // No LAN IPv4 → nothing for a QR to point at. The minted
        // code just expires unused — report honestly.
        return err(
          appError('unavailable', 'sync: no LAN address to advertise'),
        );
      }
      const payload = JSON.stringify({
        v: 1,
        endpoint: primary,
        endpoints,
        code: minted.value.code,
        fp,
      });
      return ok({
        code: minted.value.code,
        payload,
        expiresAt: minted.value.expiresAt,
      });
    },
    get port() {
      return pairHost.port;
    },
    advertisedEndpoints() {
      const port = pairHost.port;
      return port === null
        ? []
        : cachedLanHosts.map((h) => formatEndpoint(h, port));
    },
    localEndpoints,
    onPaired(cb) {
      pairedSubs.add(cb);
      return () => pairedSubs.delete(cb);
    },
    stop: () => pairHost.stop(),
    close: () => pairHost.close(),
  };
}
