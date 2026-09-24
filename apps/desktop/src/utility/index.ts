import { appError, err } from '@auqw/application';
import { shellError } from '../shared/errors.ts';
import { isRecord } from '../shared/check.ts';
import type { UtilityResponse } from './envelope.ts';
import { createStreamPump, type PumpPort } from './bytes.ts';
import { createHostRuntime } from './host.ts';
import { createPotService } from './pot-service.ts';
import { createUtilityRouter } from './router.ts';
import { createServiceClient } from './service.ts';
import { createIndexDb } from './index-db.ts';
import { createLocalService } from './local.ts';
import { createStorageService } from './storage.ts';
import { createStreamHandlers } from './stream.ts';
import { createServiceKeys } from './sync-keys.ts';
import { createBonjourAdvertise } from './sync-mdns.ts';
import {
  createSyncService,
  type SyncAdvertise,
} from './sync-server.ts';
import { openSyncLogStore } from './sync-log.ts';
import {
  createUtilitySyncEngine,
  type UtilitySyncEngine,
} from './sync-engine.ts';
import {
  createClock,
  createIds,
  createLog,
} from '../renderer/runtime.ts';
import { createTagService } from './tags.ts';
import { createTransferService } from './transfer.ts';
import { hasRequestId, isUtilityRequest } from './validators.ts';

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
 * crashing the child at module init.
 */
function lazyBonjour(): SyncAdvertise {
  let factory: SyncAdvertise | null = null;
  return (opts) => {
    factory ??= createBonjourAdvertise();
    return factory(opts);
  };
}

/** AUQW_SYNC_PORT — an explicit port when set, else ephemeral. */
function syncPortEnv(): number | undefined {
  const raw = process.env['AUQW_SYNC_PORT'];
  if (raw === undefined || raw === '') {
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
  // The bundled POT minter (bgutil /get_pot): a LAN-visible service
  // the plugin host mints through and the phone discovers via the
  // pairing payload. AUQW_POT_PROVIDER_URL points the host at an
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
  const runtime = createHostRuntime({
    env: process.env,
    resourcesPath:
      typeof process.resourcesPath === 'string'
        ? process.resourcesPath
        : undefined,
    repoRoot: process.env.AUQW_REPO_ROOT,
    potProviderUrl: () => {
      const url = pot.loopbackUrl();
      if (url === null) {
        potRetry();
      }
      return url;
    },
  });
  // The database path arrives from main in the fork environment —
  // `AUQW_DB_PATH` points under userData; the service opens lazily on
  // the first storage request so a missing path is a typed
  // `unavailable`, not a crashed child.
  const storage = createStorageService({
    dbPath: process.env['AUQW_DB_PATH'],
  });
  // Utility→main service client: safeStorage exists only in main, so
  // the sync service's identity + device key custody rides the
  // whitelisted `sync:keys` channel. Its replies share the envelope
  // shape but are consumed by the client, never by the router.
  const serviceClient = createServiceClient({
    post: (message) => port.postMessage(message),
  });
  // The merge engine: a JSONL change log under userData plus the
  // app's DOM-free runtime ports (clock/ids/log are shared with the
  // renderer — one clock, one id source, one log voice). The store
  // header mints the device id: its durability horizon IS the log it
  // stamps. Construction is async, so the service resolves the
  // promise inside start() — a failed build degrades to
  // engine-absent and the listener/pairing still serve.
  const userData = process.env['AUQW_USER_DATA'];
  const enginePromise: Promise<UtilitySyncEngine | null> | null =
    userData === undefined
      ? null
      : (async () => {
          const opened = await openSyncLogStore(
            `${userData}/sync-log.jsonl`,
          );
          if (!opened.ok) {
            return null;
          }
          const built = await createUtilitySyncEngine({
            store: opened.value.store,
            clock: createClock(),
            ids: createIds(),
            log: createLog(),
            deviceId: opened.value.deviceId,
          });
          return built.ok ? built.value : null;
        })();
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
    ...(syncName !== undefined ? { deviceName: syncName } : {}),
    keys: createServiceKeys(serviceClient.request),
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
          notifyApplied: (pending) =>
            serviceClient
              .request('sync:applied', { pending })
              .then(
                () => undefined,
                () => undefined,
              ),
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
  const indexDb = createIndexDb(process.env['AUQW_DB_PATH']);
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
    ...createTagService({ database: indexDb.get }).handlers,
    ...createLocalService({ database: indexDb.get, mediaDir }).handlers,
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
