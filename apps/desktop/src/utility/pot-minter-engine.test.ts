import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { assert, assertEqual } from '@auqw/application/testing';
import {
  createProcessMinter,
  HttpError,
  wireError,
  type MinterReply,
} from './pot-minter-engine.ts';

/** A ChildProcess stand-in — drives the supersede ordering directly. */
function fakeProc(): ChildProcess & { sent: unknown[]; kills: number } {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  const proc = emitter as unknown as ChildProcess & {
    sent: unknown[];
    kills: number;
  };
  proc.sent = sent;
  proc.kills = 0;
  proc.send = ((msg: unknown) => {
    sent.push(msg);
    return true;
  }) as ChildProcess['send'];
  proc.kill = () => {
    proc.kills += 1;
    return true;
  };
  return proc;
}

/**
 * The IPC transport against a real forked stub child (a .mjs script
 * under tmpdir — tests never touch the production minter entry).
 * Asserts the wire round-trips: build → mint → dispose, child crash
 * surfaces as a typed unavailable error, and pending ops fail on exit.
 */
export async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pot-minter-stub-'));
  try {
    const stub = join(dir, 'stub-child.mjs');
    writeFileSync(
      stub,
      [
        "const sessions = new Map(); let next = 1;",
        "process.on('message', (m) => {",
        '  const send = (v) => process.send(v);',
        "  if (m.op === 'build') {",
        "    if (m.fail === true) { send({ id: m.id, ok: false, error: { status: 502, kind: 'upstream', message: 'boom' } }); return; }",
        '    const sessionId = next++; sessions.set(sessionId, true);',
        '    send({ id: m.id, ok: true, value: { sessionId, expiresAtMs: 9999, freshUntilMs: 5000 } }); return;',
        '  }',
        "  if (m.op === 'mint') {",
        '    if (!sessions.has(m.sessionId)) { send({ id: m.id, ok: false, error: { status: 503, kind: \'unavailable\', message: \'gone\' } }); return; }',
        "    send({ id: m.id, ok: true, value: { poToken: 'wire-' + m.contentBinding } }); return;",
        '  }',
        "  if (m.op === 'dispose') {",
        '    sessions.delete(m.sessionId); send({ id: m.id, ok: true, value: {} }); return;',
        '  }',
        '});',
        "process.on('disconnect', () => process.exit(0));",
      ].join('\n'),
    );

    const minter = createProcessMinter({
      childModule: stub,
      spawn: (path) =>
        fork(path, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
    });

    // build → mint → dispose round-trips over the real IPC channel.
    const session = await minter.buildSession();
    assertEqual(await session.mint('b1'), 'wire-b1');
    assertEqual(session.expiresAtMs, 9999);
    assertEqual(session.freshUntilMs, 5000);
    session.dispose?.();
    // Second mint on the disposed wrapper fails fast (no IPC).
    await session
      .mint('b2')
      .then(() => {
        throw new Error('disposed mint should reject');
      })
      .catch((err) => {
        assert(err instanceof HttpError, 'disposed mint not HttpError');
      });
    // Child exits once the engine closes — the disconnect handler ends it.
    await minter.close();

    // A crash mid-session surfaces typed errors to pending mints.
    const deadDir = mkdtempSync(join(tmpdir(), 'pot-minter-dead-'));
    try {
      const deadStub = join(deadDir, 'dead.mjs');
      writeFileSync(
        deadStub,
        "process.on('message', () => process.exit(7));",
      );
      const dead = createProcessMinter({
        childModule: deadStub,
        spawn: (path) =>
          fork(path, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
        requestTimeoutMs: 10_000,
      });
      await dead
        .buildSession()
        .then(() => {
          throw new Error('crashed child should reject build');
        })
        .catch((err) => {
          assert(err instanceof HttpError, 'crash error not HttpError');
          assertEqual(err.status, 503);
        });
      await dead.close();
    } finally {
      rmSync(deadDir, { recursive: true, force: true });
    }

    // A superseded child's late 'exit' must not reject pendings on
    // the replacement: A errors → B spawns → A exits → B's request
    // still resolves off B's own reply.
    const procs: (ChildProcess & { sent: unknown[] })[] = [];
    const gen = createProcessMinter({
      childModule: stub,
      spawn: () => {
        const proc = fakeProc();
        procs.push(proc);
        return proc;
      },
    });
    // Spawn is lazy — the first request creates A.
    const firstBuild = gen.buildSession();
    const first = procs[0];
    assert(first !== undefined, 'first child not spawned');
    const firstReq = first.sent[0] as { id: number };
    first.emit('message', {
      id: firstReq.id,
      ok: true,
      value: { sessionId: 1, expiresAtMs: 1 },
    });
    await firstBuild;
    // A's 'error' retires it; the next request spawns B.
    first.emit('error', new Error('ipc hiccup'));
    const pending = gen.buildSession();
    assert(procs.length === 2, 'replacement child not spawned');
    const second = procs[1];
    assert(second !== undefined, 'second child missing');
    const req = second.sent[0] as { id: number; op: string };
    // Now A's exit lands — under the old shared failAll it would
    // have rejected B's pending request.
    first.emit('exit');
    second.emit('message', {
      id: req.id,
      ok: true,
      value: { sessionId: 7, expiresAtMs: 9999 },
    });
    const recovered = await pending;
    assertEqual(recovered.expiresAtMs, 9999);
    await gen.close();

    // A wedged op times out and kills ITS child — the engine then
    // respawns a clean one for the next request rather than staying
    // stranded behind the corpse.
    const wedged: (ChildProcess & { sent: unknown[]; kills: number })[] =
      [];
    const timed = createProcessMinter({
      childModule: stub,
      spawn: () => {
        const proc = fakeProc();
        wedged.push(proc);
        return proc;
      },
      requestTimeoutMs: 40,
    });
    const wedgedBuild = timed.buildSession();
    const wedgedProc = wedged[0];
    assert(wedgedProc !== undefined, 'wedged child not spawned');
    await wedgedBuild.then(
      () => {
        throw new Error('wedged build should reject');
      },
      (err: unknown) => {
        assert(err instanceof HttpError, 'timeout error not HttpError');
        assert(
          err.message.includes('timed out'),
          'wedged build did not time out',
        );
      },
    );
    assertEqual(wedgedProc.kills, 1, 'timeout killed the wedged child');
    const retry = timed.buildSession();
    const nextProc = wedged[1];
    assert(nextProc !== undefined, 'no replacement spawned');
    const nextReq = nextProc.sent[0] as { id: number };
    nextProc.emit('message', {
      id: nextReq.id,
      ok: true,
      value: { sessionId: 3, expiresAtMs: 5 },
    });
    await retry;
    assertEqual(nextProc.kills, 0, 'replacement child untouched');
    await timed.close();

    // The REAL bundled child entry — packaging/startup coverage a
    // stub can't give. Skipped when `pnpm build` hasn't produced the
    // artifact (typecheck/test alone don't build).
    const bundled = join(
      dirname(process.argv[1] ?? '.'),
      '../dist/utility/pot-minter-child.cjs',
    );
    if (existsSync(bundled)) {
      const real = fork(bundled, {
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      try {
        const awaitReply = (id: number): Promise<MinterReply> =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('bundled child silent')),
              10_000,
            );
            const onMsg = (m: unknown): void => {
              const reply = m as MinterReply;
              if (reply.id === id) {
                clearTimeout(timer);
                real.off('message', onMsg);
                resolve(reply);
              }
            };
            real.on('message', onMsg);
          });
        const mintWait = awaitReply(1);
        real.send({
          id: 1,
          op: 'mint',
          sessionId: 999,
          contentBinding: 'x',
        });
        const mintReply = await mintWait;
        assert(!mintReply.ok, 'unknown session mint should fail');
        if (!mintReply.ok) {
          assertEqual(mintReply.error.status, 503);
          assertEqual(mintReply.error.kind, 'unavailable');
        }
        const disposeWait = awaitReply(2);
        real.send({ id: 2, op: 'dispose', sessionId: 999 });
        assert((await disposeWait).ok, 'dispose should answer ok');
      } finally {
        real.kill('SIGKILL');
      }
    }

    // wireError passes HttpError fields through; foreign exceptions
    // collapse to the generic line (no upstream material crossing).
    const wired = wireError(new HttpError(429, 'unavailable', 'slow'));
    assertEqual(wired.status, 429);
    assertEqual(wired.kind, 'unavailable');
    assertEqual(wired.message, 'slow');
    const foreign = wireError(new TypeError('token=SEKRIT leaked'));
    assertEqual(foreign.status, undefined);
    assert(!foreign.message.includes('SEKRIT'), 'foreign error leaked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
