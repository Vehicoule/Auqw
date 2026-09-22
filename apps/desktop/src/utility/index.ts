import { shellError } from '../shared/errors.ts';
import { isRecord } from '../shared/check.ts';
import type { UtilityResponse } from './envelope.ts';
import { createStreamPump, type PumpPort } from './bytes.ts';
import { createHostRuntime } from './host.ts';
import { createUtilityRouter } from './router.ts';
import { createIndexDb } from './index-db.ts';
import { createLocalService } from './local.ts';
import { createStorageService } from './storage.ts';
import { createStreamHandlers } from './stream.ts';
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
  // The offline file plane: a shared read accessor on the domain db
  // (same file the storage service drives — never a second file), the
  // transfer sink service over `userData/media`, the grant-checked tag
  // reader, and the local probe/list/sweep surface.
  const indexDb = createIndexDb(process.env['AUQW_DB_PATH']);
  const userData = process.env['AUQW_USER_DATA'];
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
    ...transfer.handlers,
    ...createTagService({ database: indexDb.get }).handlers,
    ...createLocalService({ database: indexDb.get, mediaDir }).handlers,
  });
  // Startup integrity: orphans past the bounded age go before the
  // first renderer request arrives.
  void transfer.sweepOrphans();
  port.on('message', (event) => {
    const raw: unknown = event.data;
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
