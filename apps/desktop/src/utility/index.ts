import { shellError } from '../shared/errors.ts';
import type { UtilityResponse } from './envelope.ts';
import { createUtilityRouter } from './router.ts';
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
  const route = createUtilityRouter();
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
