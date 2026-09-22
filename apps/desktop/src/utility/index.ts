import { shellError } from '../shared/errors.ts';
import type { UtilityResponse } from './envelope.ts';
import { createHostRuntime } from './host.ts';
import { createUtilityRouter } from './router.ts';
import { createStorageService } from './storage.ts';
import { createStreamHandlers } from './stream.ts';
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
    listener: (event: { data: unknown }) => void,
  ): void;
  start(): void;
};

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
  const route = createUtilityRouter({
    ...createStreamHandlers({
      ...runtime,
      devGateEnabled: process.env.AUQW_DEV_GATE === '1',
    }),
    ...storage.handlers,
  });
  port.on('message', (event) => {
    const raw: unknown = event.data;
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
