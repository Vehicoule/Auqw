import { shellError } from '../shared/errors.ts';
import { isRecord } from '../shared/check.ts';
import type { UtilityResponse } from './envelope.ts';
import { createStreamPump, type PumpPort } from './bytes.ts';
import { createHostRuntime } from './host.ts';
import { createUtilityRouter } from './router.ts';
import { createServiceClient } from './service.ts';
import { createStorageService } from './storage.ts';
import { createStreamHandlers } from './stream.ts';
import { createServiceKeys } from './sync-keys.ts';
import { createBonjourAdvertise } from './sync-mdns.ts';
import {
  createSyncService,
  type SyncAdvertise,
} from './sync-server.ts';
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
  const runtime = createHostRuntime({
    env: process.env,
    resourcesPath:
      typeof process.resourcesPath === 'string'
        ? process.resourcesPath
        : undefined,
    repoRoot: process.env.AUQW_REPO_ROOT,
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
  // The LAN sync service: listener + pairing + device registry +
  // engine seam. Engine itself lands with the parallel sync-engine
  // leg — absent here, delta channels answer typed `unavailable`.
  const syncPort = syncPortEnv();
  const syncHost = process.env['AUQW_SYNC_HOST'];
  const syncName = process.env['AUQW_SYNC_NAME'];
  const syncService = createSyncService({
    ...(syncHost !== undefined ? { host: syncHost } : {}),
    ...(syncPort !== undefined ? { port: syncPort } : {}),
    disabled: process.env['AUQW_SYNC_DISABLED'] === '1',
    ...(syncName !== undefined ? { deviceName: syncName } : {}),
    keys: createServiceKeys(serviceClient.request),
    advertise:
      process.env['AUQW_SYNC_NO_MDNS'] === '1'
        ? null
        : lazyBonjour(),
  });
  const route = createUtilityRouter({
    ...createStreamHandlers({
      ...runtime,
      devGateEnabled: process.env.AUQW_DEV_GATE === '1',
    }),
    ...storage.handlers,
    ...syncService.handlers,
  });
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
