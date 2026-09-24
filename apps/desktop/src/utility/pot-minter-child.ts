import {
  buildBotGuardSession,
  type PotSession,
} from './pot-service.ts';
import { wireError, type MinterRequest, type MinterReply } from './pot-minter-engine.ts';

/**
 * The POT minter child entry — a dedicated process that owns every
 * BotGuard session so the remote interpreter's `eval` surface never
 * shares the utility's address space. Speaks the narrow `MinterRequest`
 * /`MinterReply` protocol over `process.send` IPC: `build` runs the
 * homepage → interpreter → vm → GenerateIT flow and registers a
 * session id; `mint` turns a content binding into a token against a
 * registered session; `dispose` releases it.
 *
 * Errors cross as `{status, kind, message}` — HttpError fields are
 * our own static strings; anything else collapses to a generic line
 * upstream material can't leak through.
 *
 * Spawned with a scrubbed environment (proxy vars + HOME/PATH only)
 * and ELECTRON_RUN_AS_NODE so Electron's utility binary runs it as
 * plain node.
 */

const sessions = new Map<number, PotSession>();
let nextSessionId = 1;

function reply(msg: MinterReply): void {
  if (typeof process.send === 'function') {
    try {
      process.send(msg);
    } catch {
      // Parent is gone — the exit handler unloads sessions anyway.
    }
  }
}

async function handle(msg: MinterRequest): Promise<void> {
  if (msg.op === 'build') {
    const session = await buildBotGuardSession(fetch, Date.now);
    const sessionId = nextSessionId++;
    sessions.set(sessionId, session);
    reply({
      id: msg.id,
      ok: true,
      value: {
        sessionId,
        expiresAtMs: session.expiresAtMs,
        freshUntilMs: session.freshUntilMs,
      },
    });
    return;
  }
  if (msg.op === 'mint') {
    const session = sessions.get(msg.sessionId);
    if (session === undefined) {
      reply({
        id: msg.id,
        ok: false,
        error: {
          status: 503,
          kind: 'unavailable',
          message: 'pot: session gone',
        },
      });
      return;
    }
    const poToken = await session.mint(msg.contentBinding);
    reply({ id: msg.id, ok: true, value: { poToken } });
    return;
  }
  if (msg.op === 'dispose') {
    const session = sessions.get(msg.sessionId);
    sessions.delete(msg.sessionId);
    session?.dispose?.();
    reply({ id: msg.id, ok: true, value: {} });
    return;
  }
}

process.on('message', (msg: unknown) => {
  const request = msg as MinterRequest;
  if (typeof request?.id !== 'number' || typeof request.op !== 'string') {
    return;
  }
  handle(request).catch((thrown) => {
    reply({ id: request.id, ok: false, error: wireError(thrown) });
  });
});

// Parent disconnect (its close()) is the child's shutdown signal —
// an orphaned minter process holding timers must not outlive it.
process.on('disconnect', () => {
  for (const session of sessions.values()) {
    session.dispose?.();
  }
  sessions.clear();
  process.exit(0);
});
