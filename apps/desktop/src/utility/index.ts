import { appError, err } from '@auqw/application';
import { isShellError, shellError } from '../shared/errors.ts';
import { isRecord } from '../shared/check.ts';
import type { UtilityResponse } from './envelope.ts';
import { createStreamPump, type PumpPort } from './bytes.ts';
import { createHostRuntime } from './host.ts';
import { createPotService } from './pot-service.ts';
import { createUtilityRouter } from './router.ts';
import { createServiceClient } from './service.ts';
import { createIndexDb } from './index-db.ts';
import { createLocalGrants } from './local-grants.ts';
import { createLocalService } from './local.ts';
import { createStorageService } from './storage.ts';
import { createStreamHandlers } from './stream.ts';
import { createServiceKeys } from './sync-keys.ts';
import {
  createBonjourAdvertise,
  createBonjourBrowse,
} from './sync-mdns.ts';
import { createSyncDialer } from './sync-dialer.ts';
import type { SyncDiscoveryPort } from '@auqw/application';
import {
  createSyncService,
  type SyncAdvertise,
} from './sync-server.ts';
import { openSyncLogStore, type OpenedSyncLog } from './sync-log.ts';
import {
  createUtilitySyncEngine,
  type UtilitySyncEngine,
} from './sync-engine.ts';
import {
  createClock,
  createIds,
  createLog,
} from '@auqw/application';
import { createTagService } from './tags.ts';
import { createTransferService } from './transfer.ts';
import { hasRequestId, isUtilityRequest } from './validators.ts';
import { createAuthService } from './auth.ts';
import { createServiceAuthCustody } from './auth-custody.ts';

/**
 * The Electron-specific shape of `process.parentPort` in a utility
 * process. Declared locally so this entry stays electron-free and the
 * router underneath it is unit-testable under plain node.
 */
type ParentPort = {
  postMessage(message: unknown): void;
  on(
    event: 'message',
    listener: (event: { data: unknown; ports?: unknown[] }) => void,
  ): void;
  start(): void;
};

/**
 * `stream-pump` — the non-envelope message main posts when a renderer
 * asked for a byte channel: `{kind, handle}` plus the transferred
 * MessagePort in `event.ports`. Everything else is a typed request.
 */
function isStreamPumpAttach(
  raw: unknown,
): raw is { kind: 'stream-pump'; handle: string } {
  return (
    isRecord(raw) &&
    raw['kind'] === 'stream-pump' &&
    typeof raw['handle'] === 'string' &&
    raw['handle'].length > 0 &&
    raw['handle'].length <= 512
  );
}

function parentPort(): ParentPort | null {
  const proc = process as unknown as { parentPort?: ParentPort };
  return proc.parentPort ?? null;
}

/**
 * Defer `new Bonjour()` to first use — a constructor failure lands
 * inside the sync service's typed `unavailable` path instead of
 * crashing the child at module init. Same lazy posture for browse.
 */
function lazyBonjour(): SyncAdvertise {
  let factory: SyncAdvertise | null = null;
  return (opts) => (factory ??= createBonjourAdvertise())(opts);
}

function lazyBrowse(): SyncDiscoveryPort {
  let port: SyncDiscoveryPort | null = null;
  return {
    browse: (opts) => (port ??= createBonjourBrowse()).browse(opts),
  };
}

/** AUQW_SYNC_PORT — an explicit port when set, else ephemeral. */
function syncPortEnv(): number | undefined {
  const raw = process.env['AUQW_SYNC_PORT'];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535
    ? parsed
    : undefined;
}

const port = parentPort();
if (port === null) {
  // Only an Electron utilityProcess provides a parent port; running this
  // entry any other way is a wiring bug, not a usable mode.
  process.exitCode = 1;
} else {
  // Utility→main service client: safeStorage exists only in main, so
  // the sync service's identity + device key custody rides the
  // whitelisted `sync:keys` channel. Its replies share the envelope
  // shape but are consumed by the client, never by the router.
  const serviceClient = createServiceClient({
    post: (message) => port.postMessage(message),
  });
  // Fire-and-forget pushes into main — the service call's reply is
  // never read, and a dead client must not reject upward.
  const push = (channel: string, args: unknown): Promise<void> =>
    serviceClient.request(channel, args).then(
      () => undefined,
      () => undefined,
    );
  // The bundled POT minter (bgutil /get_pot): binds loopback by
  // default — the endpoint answers unauthenticated, so a wildcard
  // listen would let any LAN peer mint under this host's residential
  // IP. `AUQW_POT_LAN=1` opts into `0.0.0.0` for the paired-phone
  // shape, and the custody channel must prove a paired device (a
  // paired phone legitimately shares this host's public IP);
  // opt-in without a pairing falls back to loopback.
  // AUQW_POT_PROVIDER_URL points the host at an
  // external provider instead — then this never binds and pairing
  // advertises nothing. The bind rides the startup gate below so a
  // QR minted early can't advertise a dead endpoint.
  // An empty override reads as "unset" — `VAR=` in a launch env must
  // not suppress the bundled minter into a provider-less state.
  const potOverrideEnv = process.env['AUQW_POT_PROVIDER_URL'];
  const potOverride =
    potOverrideEnv !== undefined && potOverrideEnv.trim() !== ''
      ? potOverrideEnv
      : undefined;
  const pot = createPotService({
    log: (line) => console.warn(`[auqw] ${line}`),
    lanOptIn: process.env['AUQW_POT_LAN'] === '1',
    lanReady: async () => {
      try {
        const { devices } = await createServiceKeys(
          serviceClient.request,
        ).deviceList();
        return devices.length > 0;
      } catch {
        return false;
      }
    },
  });
  const potBound: Promise<number | null> =
    potOverride === undefined
      ? pot.bind().catch(() => null)
      : Promise.resolve(null);
  // A failed startup bind is retryable — re-kick it on each read so
  // a transient failure heals without a utility restart. The current
  // caller still gets "no provider"; a retried bind is pushed into
  // the live host through setPotProvider and read by future host
  // constructions through the config callback.
  const potRetry = (): void => {
    if (pot.port() === null) {
      void pot
        .bind()
        .then((bound) => {
          // A host constructed while the bind was down cached no
          // provider — push the retry's port into it so desktop
          // playback can mint without a utility restart.
          if (bound !== null) {
            runtime.hostIfLoaded()?.setPotProvider(pot.loopbackUrl());
          }
        })
        .catch(() => null);
    }
  };
  // The live OAuth access token — kept here so a token minted before
  // the lazy bindings load still reaches the PluginHost constructor;
  // a running host gets updates through setAuthToken instead.
  let authTokenCurrent: string | null = null;
  const runtime = createHostRuntime({
    env: process.env,
    resourcesPath:
      typeof process.resourcesPath === 'string'
        ? process.resourcesPath
        : undefined,
    repoRoot: process.env.AUQW_REPO_ROOT,
    authToken: () => authTokenCurrent,
    potProviderUrl: () => {
      const url = pot.loopbackUrl();
      if (url === null) {
        potRetry();
      }
      return url;
    },
  });
  // Warm the plugin directory scan + wasm load at boot — otherwise the
  // laziness rides the user's first `stream.prepare`. The warm waits for
  // the startup bind to settle first: constructing while it pends reads
  // a null provider URL, and a failed bind + shared-pending retry could
  // leave the warm's host providerless with nothing left to re-kick the
  // read. After settlement the construction read behaves exactly like a
  // first click — success hands the URL over, failure kicks `potRetry`,
  // whose success pushes the port into the live host. Fire-and-forget:
  // a rejection clears the memoized promise (`ready` resets on
  // failure), so the real prepare retries and surfaces its own typed
  // failure; only the log line lands here, and raw rejections can
  // carry fs paths, so only the ShellError's safe text is printed.
  void potBound.then(() => runtime.pluginsReady()).catch((thrown: unknown) => {
    console.warn(
      `[auqw] plugin warm failed: ${
        isShellError(thrown)
          ? `${thrown.kind}: ${thrown.message}`
          : 'unexpected failure'
      }`,
    );
  });
  // The database path arrives from main in the fork environment —
  // `AUQW_DB_PATH` points under userData; the service opens lazily on
  // the first storage request so a missing path is a typed
  // `unavailable`, not a crashed child.
  const indexDb = createIndexDb(process.env['AUQW_DB_PATH']);
  const userData = process.env['AUQW_USER_DATA'];
  // The authoritative local-file grant store — utility-owned file
  // under userData (local-grants.ts): `local:add` mints, the storage
  // commit-diff revokes, a renderer's `local_sources` writes do
  // neither. Bootstrap imports pre-existing rows once on first boot.
  const localGrants = createLocalGrants({
    path:
      userData === undefined
        ? undefined
        : `${userData}/local-grants.json`,
    database: indexDb.get,
    log: (line) => console.warn(`[auqw] ${line}`),
  });
  const storage = createStorageService({
    dbPath: process.env['AUQW_DB_PATH'],
    localGrants,
    log: (line) => console.warn(`[auqw] ${line}`),
  });
  // OAuth session trust: custody rides `auth:custody` up to main's
  // sealed store; the access token (memory-only) lands in the host
  // slot — a host that isn't loaded yet gets it via the constructor
  // thunk when the first stream call builds it. Env overrides are the
  // advanced path (settings' client-id row wins over them).
  const auth = createAuthService({
    custody: createServiceAuthCustody(serviceClient.request),
    applyToken: (token) => {
      authTokenCurrent = token;
      runtime.hostIfLoaded()?.setAuthToken(token);
    },
    ...(process.env.AUQW_OAUTH_CLIENT_ID !== undefined &&
    process.env.AUQW_OAUTH_CLIENT_ID.trim() !== ''
      ? { clientId: process.env.AUQW_OAUTH_CLIENT_ID }
      : {}),
    ...(process.env.AUQW_OAUTH_CLIENT_SECRET !== undefined &&
    process.env.AUQW_OAUTH_CLIENT_SECRET !== ''
      ? { clientSecret: process.env.AUQW_OAUTH_CLIENT_SECRET }
      : {}),
    push,
  });
  // The merge engine: a JSONL change log under userData plus the
  // app's DOM-free runtime ports (clock/ids/log are shared with the
  // renderer — one clock, one id source, one log voice). The store
  // header mints the device id: its durability horizon IS the log it
  // stamps. Construction is async, so the service resolves the
  // promise inside start() — a failed build degrades to
  // engine-absent and the listener/pairing still serve.
  const syncLogOpened: Promise<OpenedSyncLog | null> | null =
    userData === undefined
      ? null
      : openSyncLogStore(`${userData}/sync-log.jsonl`).then((opened) =>
          opened.ok ? opened.value : null,
        );
  const enginePromise: Promise<UtilitySyncEngine | null> | null =
    syncLogOpened === null
      ? null
      : syncLogOpened.then(async (opened) => {
          if (opened === null) {
            return null;
          }
          const built = await createUtilitySyncEngine({
            store: opened.store,
            clock: createClock(),
            ids: createIds(),
            log: createLog(),
            deviceId: opened.deviceId,
          });
          return built.ok ? built.value : null;
        });
  // The LAN sync service: listener + pairing + device registry +
  // engine seam.
  const syncPort = syncPortEnv();
  const syncHost = process.env['AUQW_SYNC_HOST'];
  const syncName = process.env['AUQW_SYNC_NAME'];
  const syncService = createSyncService({
    ...(syncHost !== undefined ? { host: syncHost } : {}),
    // A specific bind address is the only address the listener can be
    // reached at — pairing payloads must advertise it, not the first
    // LAN interface. Wildcard binds keep automatic selection.
    ...(syncHost !== undefined &&
    syncHost !== '0.0.0.0' &&
    syncHost !== '::'
      ? { endpointHost: syncHost }
      : {}),
    ...(syncPort !== undefined ? { port: syncPort } : {}),
    ...(potOverride === undefined
      ? {
          potPort: () => {
            const bound = pot.port();
            if (bound === null) {
              potRetry();
            }
            return bound;
          },
        }
      : {}),
    disabled: process.env['AUQW_SYNC_DISABLED'] === '1',
    // Armed = a persisted identity already exists (set by main from
    // the custody dir). A fresh install stays dormant — no listener
    // bind and no safeStorage/keychain read — until a sync handler
    // runs; unset env keeps the eager default for standalone runs.
    armed: process.env['AUQW_SYNC_ARMED'] !== '0',
    ...(syncName !== undefined ? { deviceName: syncName } : {}),
    keys: createServiceKeys(serviceClient.request),
    // The caller half — pair TO a phone's offer. Shares the custody
    // channel + the sync-log deviceId; the bound-port getter comes
    // from the service so the hello advertises a dialable endpoint.
    dialer: ({ listenPort, listenEndpoints, deviceName }) =>
      createSyncDialer({
        keys: createServiceKeys(serviceClient.request),
        ownDeviceId: async () =>
          (await syncLogOpened)?.deviceId ?? null,
        engine: async () =>
          (await enginePromise)?.engine ?? null,
        deviceName,
        listenPort,
        listenEndpoints,
      }),
    discovery:
      process.env['AUQW_SYNC_NO_MDNS'] === '1' ? null : lazyBrowse(),
    notifyNearby: (event) => push('sync:nearby', event),
    ...(syncLogOpened === null
      ? {}
      : {
          ownDeviceId: syncLogOpened.then(
            (opened) => opened?.deviceId ?? null,
          ),
        }),
    ...(enginePromise === null
      ? {}
      : {
          engine: enginePromise.then(
            (utility) => utility?.port ?? null,
          ),
          // Renderer-committed edits ride their own channel into the
          // same engine — the dep awaits the shared build instead of
          // racing it.
          localChanges: async (writes, signal) => {
            const utility = await enginePromise;
            if (utility === null) {
              return err(
                appError('unavailable', 'sync engine not installed'),
              );
            }
            return utility.localChanges(writes, signal);
          },
          // Renderer-facing push: the applied-outcome outbox depth
          // rides the whitelisted `sync:applied` service call into
          // main, which broadcasts to subscribed renderers.
          notifyApplied: (pending) => push('sync:applied', { pending }),
          // Outbox overflow spills beside the durable log — renderer-
          // side projection survives the queue's memory bound.
          appliedSpillPath: `${userData}/sync-applied.jsonl`,
        }),
    advertise:
      process.env['AUQW_SYNC_NO_MDNS'] === '1'
        ? null
        : lazyBonjour(),
  });
  // The offline file plane: a shared read accessor on the domain db
  // (same file the storage service drives — never a second file), the
  // transfer sink service over `userData/media`, the grant-checked tag
  // reader, and the local probe/list/sweep surface.
  const mediaDir =
    userData === undefined ? undefined : `${userData}/media`;
  const transfer = createTransferService({
    mediaDir,
    database: indexDb.get,
  });
  const route = createUtilityRouter({
    ...createStreamHandlers({
      ...runtime,
      devGateEnabled: process.env.AUQW_DEV_GATE === '1',
    }),
    ...storage.handlers,
    ...syncService.handlers,
    ...transfer.handlers,
    ...createTagService({
      grants: localGrants,
    }).handlers,
    ...createLocalService({
      database: indexDb.get,
      mediaDir,
      grants: localGrants,
    }).handlers,
    ...auth.handlers,
  });
  // Startup integrity resolves before the port starts delivering:
  // `.replace` recovery renames and the orphan reap can only race
  // publishes or reconciles once requests arrive, so the port waits
  // for the sweep rather than trusting it to finish first. The pot
  // bind rides the same gate — a `sync:pairing` payload minted
  // before it resolves would advertise an endpoint that isn't there.
  void Promise.all([
    transfer.sweepOrphans().catch(() => undefined),
    potBound,
  ]).then(() => {
    port.on('message', (event) => {
      const raw: unknown = event.data;
      if (serviceClient.onMessage(raw)) {
        return;
      }
      if (isStreamPumpAttach(raw)) {
        const transfer = event.ports?.[0];
        if (transfer === undefined) {
          return;
        }
        createStreamPump({
          host: runtime.host,
          handle: raw.handle,
          port: transfer as PumpPort,
        });
        return;
      }
      void respond(port, raw, route);
    });
    port.start();
    // Boot restore: read custody + exchange a stored refresh grant for
    // an access token. Kicked only after port.start() — the custody
    // channel's replies ride the same parent-port dispatch.
    void auth.restore();
  });
  // The supervisor kills the child outright on shutdown; when the
  // platform delivers SIGTERM first, drain what this entry owns — the
  // listener, sessions, and the mDNS announce — instead of letting
  // forced teardown drop them. (On Windows utilityProcess.kill is
  // TerminateProcess: no signal, forced teardown stands.)
  process.on('SIGTERM', () => {
    serviceClient.close();
    void pot.close().catch(() => undefined);
    void syncService
      .close()
      .catch(() => undefined)
      .then(() => {
        process.exit(0);
      });
  });
}

async function respond(
  port: ParentPort,
  raw: unknown,
  route: ReturnType<typeof createUtilityRouter>,
): Promise<void> {
  if (!isUtilityRequest(raw)) {
    if (hasRequestId(raw)) {
      const failure: UtilityResponse = {
        id: raw.id,
        ok: false,
        error: shellError('invalid-request', 'malformed request'),
      };
      port.postMessage(failure);
    }
    return;
  }
  port.postMessage(await route(raw));
}
