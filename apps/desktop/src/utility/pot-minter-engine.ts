import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { PotSession } from './pot-service.ts';
import type { ShellError } from '../shared/errors.ts';

/**
 * The minter engine boundary: sessions minted somewhere other than
 * this process. `createProcessMinter` runs the BotGuard flow in a
 * dedicated child process — the remote interpreter executes
 * `eval`/`Function`-style code against whatever globals it can reach,
 * and `node:vm` is an isolation boundary, NOT a security boundary
 * (host-realm escapes are reachable through callable prototypes).
 * Keeping it in a bare child means an escaped interpreter lands in a
 * process with no Electron surface, no bindings, and a scrubbed
 * environment — never the utility's custody or credential surface.
 * The containment is blast radius, not a boundary: the child still
 * runs a plain Node with ambient filesystem and network reach
 * (PATH/HOME and the proxy family pass through), so a realm escape
 * keeps token-poisoning plus whatever a bare process can reach.
 */

export type MinterEngine = {
  /** Build a fresh integrity session in the child (spawned lazily). */
  buildSession(): Promise<PotSession>;
  /** Kill the child and every session inside it. */
  close(): Promise<void>;
};

/** Error taxonomy the HTTP surface answers with — shared over IPC. */
export class HttpError extends Error {
  readonly status: number;
  readonly kind: ShellError['kind'];

  constructor(status: number, kind: ShellError['kind'], message: string) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

/* ----------------------------- IPC wire ---------------------------- */

export type MinterRequest =
  | { readonly id: number; readonly op: 'build' }
  | {
      readonly id: number;
      readonly op: 'mint';
      readonly sessionId: number;
      readonly contentBinding: string;
    }
  | { readonly id: number; readonly op: 'dispose'; readonly sessionId: number };

export type MinterBuilt = {
  readonly sessionId: number;
  readonly expiresAtMs: number;
  readonly freshUntilMs?: number;
};

export type MinterErrorPayload = {
  readonly status?: number;
  readonly kind?: string;
  readonly message: string;
};

export type MinterReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: MinterErrorPayload };

/**
 * Serialize an error for the wire: HttpError fields only (its
 * messages are our own static strings) — an upstream exception can
 * carry request details or token material and degrades to a generic
 * line instead.
 */
export function wireError(thrown: unknown): MinterErrorPayload {
  if (thrown instanceof HttpError) {
    return {
      status: thrown.status,
      kind: thrown.kind,
      message: thrown.message,
    };
  }
  return { message: 'pot: minter failed' };
}

export function unwiredError(payload: MinterErrorPayload): Error {
  if (
    typeof payload.status === 'number' &&
    typeof payload.kind === 'string'
  ) {
    return new HttpError(
      payload.status,
      payload.kind as ShellError['kind'],
      payload.message,
    );
  }
  return new HttpError(503, 'unavailable', 'pot: minter failed');
}

/* ---------------------------- env scrub ---------------------------- */

/**
 * The child inherits nothing by default: PATH/HOME for module/DNS
 * machinery, the proxy family for hosts that need it, and
 * ELECTRON_RUN_AS_NODE so `fork` on the utility's Electron binary
 * lands a plain node runtime instead of a second Electron host.
 */
const CHILD_ENV_KEYS: readonly string[] = [
  'HOME',
  'PATH',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];

function childEnv(): Record<string, string> {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/* --------------------------- engine ---------------------------- */

/** Hard ceiling per child op — a hostile interpreter could park the
 * child in a loop; the timeout kills the whole process (and every
 * session inside it) rather than queue behind it. */
const CHILD_OP_TIMEOUT_MS = 120_000;

export type ProcessMinterDeps = {
  readonly log?: (line: string) => void;
  /** Child entry path — defaults to the bundled sibling artifact. */
  readonly childModule?: string;
  readonly requestTimeoutMs?: number;
  /** Spawn seam — tests pass a stub transport instead of a process. */
  readonly spawn?: (modulePath: string) => ChildProcess;
};

export function createProcessMinter(deps: ProcessMinterDeps): MinterEngine {
  const log = deps.log ?? ((): void => undefined);
  // The child bundle sits beside the utility entry — `argv[1]` is
  // the launched file in every mode this runs (dist bundle,
  // strip-types dev). `import.meta`/`__dirname` are unusable here:
  // this module must parse in BOTH cjs bundles and ESM tests.
  const modulePath =
    deps.childModule ??
    join(dirname(process.argv[1] ?? '.'), 'pot-minter-child.cjs');
  const timeoutMs = deps.requestTimeoutMs ?? CHILD_OP_TIMEOUT_MS;
  const spawn =
    deps.spawn ??
    ((path: string) =>
      fork(path, {
        env: childEnv(),
        execArgv: [],
        // Guest stdout/stderr is remote-code output, not lifecycle
        // signal — interpreter-thrown text can carry URLs or
        // challenge material, so it never reaches this log.
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }));

  let child: ChildProcess | null = null;
  let closed = false;
  let nextReqId = 1;
  // Requests belong to the child they were sent to — a superseded
  // child's exit rejects only ITS pendings, never the replacement's.
  const pending = new Map<
    number,
    {
      proc: ChildProcess;
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
    }
  >();

  const failProc = (proc: ChildProcess, err: Error): void => {
    for (const [id, waiter] of pending) {
      if (waiter.proc === proc) {
        pending.delete(id);
        waiter.reject(err);
      }
    }
  };

  // Kills ONE child — clears `child` only while it still IS this
  // proc, so a replacement already serving new requests is never
  // touched. Safe on an already-dead proc: kill() is a no-op there
  // and its pendings were rejected when it died.
  const killProc = (proc: ChildProcess): void => {
    if (child === proc) {
      child = null;
    }
    proc.removeAllListeners();
    proc.kill('SIGKILL');
    failProc(proc, new HttpError(503, 'unavailable', 'pot: minter exited'));
  };

  const kill = (): void => {
    if (child !== null) {
      killProc(child);
    }
  };

  function ensure(): ChildProcess {
    if (closed) {
      throw new HttpError(503, 'unavailable', 'pot: minter closed');
    }
    if (child === null) {
      const proc = spawn(modulePath);
      child = proc;
      proc.on('message', (msg: unknown) => {
        const reply = msg as MinterReply;
        const waiter = pending.get(reply.id);
        if (waiter === undefined) {
          return;
        }
        pending.delete(reply.id);
        if (reply.ok) {
          waiter.resolve(reply.value);
        } else {
          waiter.reject(unwiredError(reply.error));
        }
      });
      proc.on('exit', () => {
        if (child === proc) {
          child = null;
        }
        log('pot-minter: child exited');
        failProc(
          proc,
          new HttpError(503, 'unavailable', 'pot: minter exited'),
        );
      });
      proc.on('error', () => {
        // Spawn failure / IPC channel fault — same as an exit.
        if (child === proc) {
          child = null;
        }
        log('pot-minter: child failed');
        failProc(
          proc,
          new HttpError(503, 'unavailable', 'pot: minter failed'),
        );
      });
    }
    return child;
  }

  type RequestBody =
    | { readonly op: 'build' }
    | {
        readonly op: 'mint';
        readonly sessionId: number;
        readonly contentBinding: string;
      }
    | { readonly op: 'dispose'; readonly sessionId: number };

  function request(msg: RequestBody): Promise<unknown> {
    const id = nextReqId++;
    let target: ChildProcess;
    try {
      target = ensure();
    } catch (thrown) {
      return Promise.reject(
        thrown instanceof HttpError
          ? thrown
          : new HttpError(503, 'unavailable', 'pot: minter send failed'),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // A wedged child can't be trusted again — kill THAT child,
        // not whatever is current: a replacement may already serve
        // new requests and must not pay for this one's stall.
        killProc(target);
        reject(
          new HttpError(503, 'unavailable', 'pot: minter op timed out'),
        );
      }, timeoutMs);
      pending.set(id, {
        proc: target,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        target.send({ ...msg, id } as MinterRequest);
      } catch (thrown) {
        clearTimeout(timer);
        pending.delete(id);
        reject(
          thrown instanceof HttpError
            ? thrown
            : new HttpError(503, 'unavailable', 'pot: minter send failed'),
        );
      }
    });
  }

  return {
    async buildSession(): Promise<PotSession> {
      const built = (await request({ op: 'build' })) as MinterBuilt;
      if (typeof built.sessionId !== 'number') {
        throw new HttpError(
          503,
          'unavailable',
          'pot: minter built no session',
        );
      }
      const sessionId = built.sessionId;
      let disposed = false;
      return {
        mint: (contentBinding) => {
          if (disposed) {
            return Promise.reject(
              new HttpError(
                503,
                'unavailable',
                'pot: session disposed',
              ),
            );
          }
          return request({
            op: 'mint',
            sessionId,
            contentBinding,
          }).then((value) => {
            const record = value as { poToken?: unknown };
            return typeof record.poToken === 'string'
              ? record.poToken
              : '';
          });
        },
        expiresAtMs: built.expiresAtMs,
        ...(built.freshUntilMs !== undefined
          ? { freshUntilMs: built.freshUntilMs }
          : {}),
        dispose: () => {
          if (disposed) {
            return;
          }
          disposed = true;
          // Fire-and-forget — a dead child answers nothing and the
          // error would be noise; its exit already killed sessions.
          void request({ op: 'dispose', sessionId }).catch(() => {});
        },
      };
    },
    async close(): Promise<void> {
      closed = true;
      kill();
    },
  };
}
