import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { assert, assertEqual } from '@auqw/application/testing';
import {
  createProcessMinter,
  HttpError,
  wireError,
} from './pot-minter-engine.ts';

/** A ChildProcess stand-in — drives the supersede ordering directly. */
function fakeProc(): ChildProcess & { sent: unknown[] } {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  const proc = emitter as unknown as ChildProcess & { sent: unknown[] };
  proc.sent = sent;
  proc.send = ((msg: unknown) => {
    sent.push(msg);
    return true;
  }) as ChildProcess['send'];
  proc.kill = () => true;
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
