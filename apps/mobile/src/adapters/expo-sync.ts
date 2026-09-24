import type {
  ApplyResult,
  ClockPort,
  IdPort,
  LogPort,
  Result,
  SyncClient,
  SyncClientKeys,
  SyncEngine,
  SyncLogStore,
} from '@auqw/application';
import {
  appError,
  createSyncClient,
  createSyncEngine,
  ensureSyncIdentity,
  err,
  ok,
} from '@auqw/application';
import {
  base64Decode,
  createNobleIdentity,
  createNobleSyncCrypto,
} from './noble-sync-crypto.ts';
import { createExpoSyncSockets } from './expo-sync-socket.ts';
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
};

export type ExpoSyncSurface = {
  readonly client: SyncClient;
  readonly engine: SyncEngine;
  readonly deviceId: string;
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
      name: `auqw ${deviceId.slice(0, 8)}`,
    });
    // Hydrate custody before the surface is exposed — the UI reads
    // status() first, and it must already show the paired desktops.
    const hydrated = await client.peers();
    if (!hydrated.ok) {
      await client.close();
      return err(hydrated.error);
    }
    return ok({ client, engine: wrappedEngine, deviceId });
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
