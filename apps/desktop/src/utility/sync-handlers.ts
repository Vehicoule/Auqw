import type {
  AppError,
  CancellationSignal,
  Result,
  SyncDiscoveryPort,
  SyncDiscoverySession,
  SyncEnginePort,
  SyncPeer,
} from '@auqw/application';
import type { SyncResponder } from '@auqw/application';
import {
  isSyncDeltasArgs,
  isSyncDeltasResult,
  isSyncDevicesResult,
  isSyncDrainAppliedResult,
  isSyncImportDeltaArgs,
  isSyncImportDeltaResult,
  isSyncLocalChangesArgs,
  isSyncLocalChangesResult,
  isSyncMaterializedArgs,
  isSyncMaterializedResult,
  isSyncPairingResult,
  isSyncStatusResult,
  isSyncTriggerResult,
  isSyncUnpairArgs,
  isSyncDialArgs,
  isSyncDialPayloadArgs,
  isSyncDialResult,
  type SyncDialResult,
  type SyncNearbyEvent,
  type SyncStatusResult,
} from '../shared/contract.ts';
import {
  shellError,
  type ShellError,
  type ShellErrorKind,
} from '../shared/errors.ts';
import { isDeviceId } from './sync-keys.ts';
import type { SyncDialer } from './sync-dialer.ts';
import type { SpillJournal } from './sync-journal.ts';
import type { SyncServiceDeps } from './sync-server.ts';
import type { UtilityHandler } from './router.ts';

/**
 * The IPC handlers the sync service exposes on the preload bridge —
 * a named collaborator taking the service's other collaborators (the
 * responder driver, the spill journal, the custody keys) plus a live
 * view over the service's own mutable state, so `createSyncService`
 * composes rather than embeds them.
 */

/** Live state the handlers read off the service — closures, not copies. */
export type SyncServiceView = {
  /** The resolved engine (a promise dep settles inside start()). */
  readonly engine: () => SyncEnginePort | undefined;
  readonly engineReady: Promise<void>;
  /**
   * Renderer-originated engine ops bind to the service's lifetime —
   * close() is the cancellation edge.
   */
  readonly cancel: CancellationSignal;
  readonly started: () => boolean;
  readonly closing: () => boolean;
  readonly listener: () => SyncStatusResult['listener'];
  readonly endpoint: () => string | null;
  readonly endpoints: () => string[];
  readonly potEndpoint: () => string | null;
  readonly fingerprint: () => string | null;
  readonly boundPort: () => number | null;
  readonly deviceName: string;
  readonly status: () => Promise<SyncStatusResult>;
  readonly idleStatus: (
    state: SyncStatusResult['listener'],
  ) => SyncStatusResult;
  readonly ensureStarted: () => Promise<SyncStatusResult>;
  readonly triggerSync: () => Promise<{
    triggered: boolean;
    pending: boolean;
  }>;
  readonly scheduleAutoTrigger: () => void;
  readonly kickDevice: (deviceId: string) => void;
  readonly materialized: (offset: number) => {
    readonly records: readonly unknown[];
    readonly nextOffset: number | null;
  };
  readonly pendingSync: Set<string>;
};

/**
 * The mDNS browse refcount — every `sync:nearbyStart` owns one share,
 * a stop while browse() is pending makes the late session self-close.
 */
export interface NearbyBrowse {
  start(): Promise<void>;
  stop(): void;
  close(): void;
}

export function createNearbyBrowse(opts: {
  discovery: SyncDiscoveryPort | null | undefined;
  notifyNearby?: ((event: SyncNearbyEvent) => unknown) | undefined;
  mapError: (error: AppError) => ShellError;
}): NearbyBrowse {
  let browseSession: SyncDiscoverySession | null = null;
  let browsePending: Promise<Result<SyncDiscoverySession>> | null = null;
  let browseOwners = 0;
  return {
    /**
     * LocalSend-style discovery: browse `_auqw._tcp` while the
     * renderer's nearby list is open. mDNS only — no custody read, no
     * keychain prompt — so it doesn't need ensureStarted().
     */
    async start() {
      browseOwners += 1;
      if (browseSession !== null) {
        return;
      }
      // A joiner awaits the shared pending start — on failure it rolls
      // back its own owner count, on success the session is shared.
      if (browsePending !== null) {
        const shared = await browsePending;
        if (!shared.ok) {
          browseOwners -= 1;
          throw opts.mapError(shared.error);
        }
        return;
      }
      if (opts.discovery === undefined || opts.discovery === null) {
        browseOwners -= 1;
        throw shellError('unavailable', 'sync: discovery not installed');
      }
      const pending = opts.discovery.browse({
        onFound: (peer) => {
          try {
            opts.notifyNearby?.({ type: 'found', peer });
          } catch {
            // A dead push channel must not kill the browse.
          }
        },
        onLost: (key) => {
          try {
            opts.notifyNearby?.({ type: 'lost', key });
          } catch {
            // best effort
          }
        },
      });
      browsePending = pending;
      const opened = await pending;
      browsePending = null;
      if (!opened.ok) {
        browseOwners -= 1;
        throw opts.mapError(opened.error);
      }
      if (browseOwners === 0) {
        // Every owner stopped while browse() was pending — drop the
        // late session rather than browse without a subscriber.
        try {
          opened.value.close();
        } catch {
          // best effort
        }
        return;
      }
      browseSession = opened.value;
    },
    stop() {
      browseOwners = Math.max(0, browseOwners - 1);
      if (browseOwners === 0) {
        browseSession?.close();
        browseSession = null;
      }
    },
    close() {
      browseOwners = 0;
      browseSession?.close();
      browseSession = null;
    },
  };
}

export function createSyncHandlers(input: {
  readonly deps: SyncServiceDeps;
  readonly service: SyncServiceView;
  readonly responder: SyncResponder;
  readonly journal: SpillJournal;
}): {
  handlers: Record<string, UtilityHandler>;
  browse: NearbyBrowse;
} {
  const { deps, service, responder, journal } = input;

  /**
   * AppError → ShellError: the engine speaks the application taxonomy,
   * the IPC boundary the shell one. Equivalent kinds map directly;
   * retryable failures without a shell twin land on 'unavailable' and
   * the rest on 'internal' — a failed export is never reported as an
   * actionable 'internal' when the engine named something better.
   */
  const ENGINE_ERROR_KINDS: Readonly<
    Partial<Record<AppError['kind'], ShellErrorKind>>
  > = {
    'invalid-response': 'invalid-response',
    cancelled: 'cancelled',
    released: 'released',
    'storage-full': 'io-error',
    'not-found': 'invalid-request',
    'not-applicable': 'invalid-request',
    'invalid-message': 'invalid-request',
    'artifact-rejected': 'invalid-request',
    'permission-denied': 'invalid-request',
    'auth-expired': 'invalid-request',
    'budget-exceeded': 'invalid-request',
    'guest-trap': 'invalid-request',
    internal: 'internal',
  };

  function engineError(error: AppError): ShellError {
    return shellError(
      ENGINE_ERROR_KINDS[error.kind] ??
      (error.retryable ? 'unavailable' : 'internal'),
      error.message,
    );
  }

  // Outbound re-validation per the utility boundary pattern: a
  // malformed service result must surface as a typed invalid-response,
  // never as a confused renderer.
  const checked = <T>(
    isResult: (value: unknown) => value is T,
    label: string,
  ): ((value: unknown) => T) => {
    return (value) => {
      if (!isResult(value)) {
        throw shellError(
          'invalid-response',
          `${label}: service returned malformed payload`,
        );
      }
      return value;
    };
  };

  const browse = createNearbyBrowse({
    discovery: deps.discovery,
    notifyNearby: deps.notifyNearby,
    mapError: engineError,
  });

  let dialerInstance: SyncDialer | null = null;

  /**
   * Shared dial path — ensureStarted first so identity custody + the
   * bound port exist (the keychain prompt rightly fires here: pairing
   * IS the sync use). A failed listener still pairs — hello just
   * omits `port`, the phone can't dial back until a later run.
   */
  async function dialPair(
    run: (
      dialer: SyncDialer,
      signal: CancellationSignal,
    ) => Promise<Result<SyncPeer>>,
  ): Promise<SyncDialResult> {
    if (deps.dialer === undefined) {
      throw shellError('unavailable', 'sync: caller not installed');
    }
    await service.ensureStarted();
    dialerInstance ??= deps.dialer({
      listenPort: service.boundPort,
      listenEndpoints: service.endpoints,
      deviceName: service.deviceName,
    });
    const result = await run(dialerInstance, service.cancel);
    if (!result.ok) {
      throw engineError(result.error);
    }
    const peer = result.value;
    if (peer.deviceId === undefined) {
      // The custody adapter refuses peers without deviceId, so an ok
      // here without one means a custody write was silently dropped —
      // surface it rather than return a row the device list won't show.
      throw shellError(
        'invalid-response',
        'sync: paired peer disclosed no device id',
      );
    }
    return checked(isSyncDialResult, 'sync:dial')({
      device: {
        id: peer.deviceId,
        name: peer.name,
        pairedAt: peer.pairedAt,
        lastSeenAt: peer.lastSeenAt,
      },
    });
  }

  const handlers: Record<string, UtilityHandler> = {
    'sync:nearbyStart': async () => {
      await browse.start();
      return undefined;
    },

    'sync:nearbyStop': async () => {
      browse.stop();
      return undefined;
    },

    /**
     * Pair TO a phone-hosted offer — the desktop is the caller. The
     * peer's pair-host is pairing-only; the phone dials back (hello
     * carries our bound port) for real rounds.
     */
    'sync:dial': async (args) => {
      if (!isSyncDialArgs(args)) {
        throw shellError(
          'invalid-request',
          'sync:dial expects {host,port,code,fp?}',
        );
      }
      return dialPair(async (dialer, signal) =>
        dialer.pairTo({
          host: args.host,
          port: args.port,
          code: args.code,
          ...(args.fp !== undefined ? { fp: args.fp } : {}),
          ...(args.hosts !== undefined ? { hosts: args.hosts } : {}),
          signal,
        }),
      );
    },

    'sync:dialPayload': async (args) => {
      if (!isSyncDialPayloadArgs(args)) {
        throw shellError(
          'invalid-request',
          'sync:dialPayload expects {payload}',
        );
      }
      return dialPair(async (dialer, signal) =>
        dialer.pairPayload(args.payload, signal),
      );
    },

    'sync:status': async () => {
      // Observational read: the settings panel polls this on every
      // settings visit. Starting sync here would mint an identity and
      // (on macOS) fire the Keychain ACL prompt for users who only
      // opened settings — the explicit start edge is sync:pairing.
      if (!service.started()) {
        await service.engineReady;
        return checked(isSyncStatusResult, 'sync:status')(
          service.idleStatus(
            service.closing()
              ? 'unavailable'
              : deps.disabled === true
                ? 'disabled'
                : 'dormant',
          ),
        );
      }
      return checked(isSyncStatusResult, 'sync:status')(
        await service.status(),
      );
    },

    'sync:pairing': async () => {
      await service.ensureStarted();
      const listener = service.listener();
      if (listener !== 'listening') {
        throw shellError(
          'unavailable',
          `sync listener is ${listener}`,
        );
      }
      const ep = service.endpoint();
      if (ep === null) {
        throw shellError('unavailable', 'no LAN address to pair to');
      }
      const { code, expiresAt } = responder.mintOffer();
      const pot = service.potEndpoint();
      const payload = JSON.stringify({
        v: 1,
        endpoint: ep,
        // All LAN candidates, best first — a multi-homed host's
        // unreachable first interface can't strand the phone.
        endpoints: service.endpoints(),
        code,
        fp: service.fingerprint(),
        ...(pot !== null ? { pot } : {}),
      });
      return checked(isSyncPairingResult, 'sync:pairing')({
        payload,
        code,
        endpoint: ep,
        expiresAt,
      });
    },

    'sync:devices': async () => {
      // Dormant ⟺ never paired — the empty list is truthful without
      // a custody read.
      if (!service.started()) {
        return checked(isSyncDevicesResult, 'sync:devices')({
          devices: [],
        });
      }
      const { devices } = await deps.keys.deviceList();
      return checked(isSyncDevicesResult, 'sync:devices')({
        devices: devices.map((d) => ({
          id: d.id,
          name: d.name,
          pairedAt: d.pairedAt,
          lastSeenAt: d.lastSeenAt,
        })),
      });
    },

    'sync:unpair': async (args) => {
      if (!isSyncUnpairArgs(args) || !isDeviceId(args.id)) {
        throw shellError('invalid-request', 'sync:unpair expects {id}');
      }
      // Dormant installs have no device records to delete — a truthful
      // no-op that keeps custody untouched.
      if (!service.started()) {
        return undefined;
      }
      await deps.keys.deviceDelete(args.id);
      service.pendingSync.delete(args.id);
      service.kickDevice(args.id);
      // Library data stays — unpair revokes the key, nothing more.
      // undefined, not null — the preload boundary validates void as
      // strictly undefined.
      return undefined;
    },

    'sync:deltas': async (args) => {
      if (!isSyncDeltasArgs(args)) {
        throw shellError('invalid-request', 'sync:deltas expects {since}');
      }
      await service.engineReady;
      const engine = service.engine();
      if (engine === undefined) {
        throw shellError('unavailable', 'sync engine not installed');
      }
      const result = await engine.exportDelta(
        args.since,
        service.cancel,
      );
      if (!result.ok) {
        throw engineError(result.error);
      }
      return checked(isSyncDeltasResult, 'sync:deltas')({
        delta: result.value,
      });
    },

    'sync:importDelta': async (args) => {
      if (!isSyncImportDeltaArgs(args)) {
        throw shellError(
          'invalid-request',
          'sync:importDelta expects {delta}',
        );
      }
      await service.engineReady;
      const engine = service.engine();
      if (engine === undefined) {
        throw shellError('unavailable', 'sync engine not installed');
      }
      const applied = await engine.applyDelta(
        args.delta,
        args.deviceId,
        service.cancel,
      );
      if (!applied.ok) {
        throw engineError(applied.error);
      }
      await journal.record(applied.value);
      return checked(isSyncImportDeltaResult, 'sync:importDelta')({
        result: applied.value,
      });
    },

    'sync:trigger': async () => {
      // No paired devices exist while dormant — nothing to kick.
      if (!service.started()) {
        return checked(isSyncTriggerResult, 'sync:trigger')({
          triggered: false,
          pending: false,
        });
      }
      return checked(isSyncTriggerResult, 'sync:trigger')(
        await service.triggerSync(),
      );
    },

    'sync:localChanges': async (args) => {
      if (!isSyncLocalChangesArgs(args)) {
        throw shellError(
          'invalid-request',
          'sync:localChanges expects {writes}',
        );
      }
      if (deps.localChanges === undefined) {
        throw shellError('unavailable', 'sync engine not installed');
      }
      const result = await deps.localChanges(
        args.writes,
        service.cancel,
      );
      if (!result.ok) {
        throw engineError(result.error);
      }
      // Committed writes trigger the spec's on-change sync — the
      // debounce coalesces the burst into one trigger pass.
      if (args.writes.length > 0) {
        service.scheduleAutoTrigger();
      }
      // Small ack only — the caller discards per-write results, and
      // echoing the appended batch would overflow the result cap
      // after the writes already landed (Review #46 round-9).
      return checked(isSyncLocalChangesResult, 'sync:localChanges')({
        accepted: Array.isArray(result.value)
          ? result.value.length
          : args.writes.length,
      });
    },

    'sync:drainApplied': async () =>
      checked(isSyncDrainAppliedResult, 'sync:drainApplied')(
        await journal.drain(),
      ),

    'sync:ackApplied': async () => {
      await journal.ack();
      return undefined;
    },

    'sync:materialized': async (args) => {
      if (!isSyncMaterializedArgs(args)) {
        throw shellError(
          'invalid-request',
          'sync:materialized expects {offset}',
        );
      }
      await service.engineReady;
      return checked(isSyncMaterializedResult, 'sync:materialized')(
        service.materialized(args.offset),
      );
    },
  };

  return { handlers, browse };
}
