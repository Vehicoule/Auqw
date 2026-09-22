import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import { CHANNELS } from '../shared/channels.ts';
import { isResultEnvelope } from '../shared/envelope.ts';
import { createNetService } from './net-monitor.ts';
import type { NetSender } from './net-monitor.ts';
import type {
  ChannelDeps,
  InvokeListener,
  IpcEventLike,
  IpcMainLike,
} from './ipc.ts';
import { registerChannels } from './ipc.ts';
import { createSecureStore } from './secure-store.ts';
import type { SafeStorageLike } from './secure-store.ts';

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, InvokeListener>();
  readonly listeners = new Map<string, (event: IpcEventLike) => void>();

  handle(channel: string, listener: InvokeListener): void {
    this.handlers.set(channel, listener);
  }

  on(channel: string, listener: (event: IpcEventLike) => void): void {
    this.listeners.set(channel, listener);
  }
}

class FakeSender implements NetSender {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  private readonly listeners = new Map<string, Array<() => void>>();
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
  on(
    event: 'destroyed' | 'render-process-gone' | 'did-navigate',
    listener: () => void,
  ): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  readonly posted: Array<{
    channel: string;
    payload: unknown;
    transfer: unknown[] | undefined;
  }> = [];
  postMessage(
    channel: string,
    payload: unknown,
    transfer?: unknown[],
  ): void {
    this.posted.push({ channel, payload, transfer });
  }
  off(
    event: 'destroyed' | 'render-process-gone' | 'did-navigate',
    listener: () => void,
  ): void {
    const list = this.listeners.get(event) ?? [];
    const index = list.indexOf(listener);
    if (index >= 0) {
      list.splice(index, 1);
    }
  }
  emit(event: 'destroyed' | 'render-process-gone' | 'did-navigate'): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener();
    }
  }
}

const WORKING_STORAGE: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (encrypted) => {
    const text = Buffer.from(encrypted).toString('utf8');
    if (!text.startsWith('enc:')) {
      throw new Error('cannot decrypt');
    }
    return text.slice(4);
  },
};

const UNAVAILABLE_STORAGE: SafeStorageLike = {
  ...WORKING_STORAGE,
  isEncryptionAvailable: () => false,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'auqw-ipc-'));
  try {
    let online = true;
    const net = createNetService({ readOnline: () => online, pollMs: 5 });
    const utilityCalls: Array<{ channel: string; args: unknown }> = [];
    let txSeq = 0;
    let beginGate: Promise<void> | null = null;
    const deps: ChannelDeps = {
      meta: () => ({
        version: '0.1.0',
        platform: 'linux',
        userDataPath: '/tmp/auqw',
      }),
      pickFolder: () => Promise.resolve('/picked/dir'),
      pickFiles: () => Promise.resolve(['/a.mp3', '/b.flac']),
      net,
      secure: createSecureStore({ dir: join(dir, 'secure'), safeStorage: WORKING_STORAGE }),
      utility: {
        request: (channel, args) => {
          utilityCalls.push({ channel, args });
          if (channel === CHANNELS.storageBegin) {
            const open = () => ({ txId: `tx-${++txSeq}` });
            return beginGate === null
              ? Promise.resolve(open())
              : beginGate.then(open);
          }
          return Promise.resolve({ routed: channel, args });
        },
        sendToHost: () => true,
      },
      messageChannel: () => ({ port1: { p: 1 }, port2: { p: 2 } }),
    };
    const ipc = new FakeIpcMain();
    registerChannels(ipc, deps);
    const sender = new FakeSender();
    const event: IpcEventLike = { sender };
    const invoke = (channel: string, args?: unknown) => {
      const listener = ipc.handlers.get(channel);
      assert(listener !== undefined, `no handler for ${channel}`);
      return listener(event, args);
    };

    // app:meta
    const meta = await invoke(CHANNELS.appMeta, undefined);
    assert(isResultEnvelope(meta));
    assert(meta.ok);
    assertDeepEqual(meta.result, {
      version: '0.1.0',
      platform: 'linux',
      userDataPath: '/tmp/auqw',
    });

    // invalid args never reach a handler
    const badMeta = await invoke(CHANNELS.appMeta, { junk: 1 });
    assert(!badMeta.ok && badMeta.error.kind === 'invalid-request');
    const badSecure = await invoke(CHANNELS.secureGet, { key: '../escape' });
    assert(!badSecure.ok && badSecure.error.kind === 'invalid-request');
    const badPing = await invoke(CHANNELS.utilityPing, { message: 42 });
    assert(!badPing.ok && badPing.error.kind === 'invalid-request');

    // dialogs
    const folder = await invoke(CHANNELS.dialogPickFolder, undefined);
    assert(folder.ok && folder.result === '/picked/dir');
    const files = await invoke(CHANNELS.dialogPickFiles, { multiple: true });
    assert(files.ok);
    assertDeepEqual(files.result, ['/a.mp3', '/b.flac']);

    // net:snapshot
    const snap = await invoke(CHANNELS.netSnapshot, undefined);
    assert(snap.ok);
    assertDeepEqual(snap.result, { online: true });

    // net:subscribe pushes current state, then transitions until unsubscribe
    const subscribe = ipc.listeners.get(CHANNELS.netSubscribe);
    const unsubscribe = ipc.listeners.get(CHANNELS.netUnsubscribe);
    assert(subscribe !== undefined && unsubscribe !== undefined);
    subscribe(event);
    assertEqual(sender.sent.length, 1, 'attach pushes current state');
    assertDeepEqual(sender.sent[0], {
      channel: CHANNELS.netEvents,
      payload: { online: true },
    });
    online = false;
    await sleep(30);
    assertEqual(sender.sent.length, 2, 'transition pushed while attached');
    unsubscribe(event);
    online = true;
    await sleep(30);
    assertEqual(sender.sent.length, 2, 'no events after unsubscribe');

    // secure round-trip through the real file-backed store
    const setRes = await invoke(CHANNELS.secureSet, {
      key: 'session.token',
      value: 's3cret',
    });
    assert(setRes.ok);
    const got = await invoke(CHANNELS.secureGet, { key: 'session.token' });
    assert(got.ok && got.result === 's3cret');
    const del = await invoke(CHANNELS.secureDelete, { key: 'session.token' });
    assert(del.ok);
    const gone = await invoke(CHANNELS.secureGet, { key: 'session.token' });
    assert(gone.ok && gone.result === null);

    // corrupt store file surfaces a typed error
    writeFileSync(join(dir, 'secure', 'broken.b64'), '!!!', 'utf8');
    const broken = await invoke(CHANNELS.secureGet, { key: 'broken' });
    assert(!broken.ok && broken.error.kind === 'corrupt-state');

    // unavailable backend → typed unavailable, never a raw throw
    const depsDown: ChannelDeps = {
      ...deps,
      secure: createSecureStore({
        dir: join(dir, 'secure2'),
        safeStorage: UNAVAILABLE_STORAGE,
      }),
    };
    const ipcDown = new FakeIpcMain();
    registerChannels(ipcDown, depsDown);
    const down = await ipcDown.handlers.get(CHANNELS.secureGet)?.(
      event,
      { key: 'anything' },
    );
    assert(down !== undefined && !down.ok && down.error.kind === 'unavailable');

    // utility:ping routes through the supervisor facade
    const ping = await invoke(CHANNELS.utilityPing, { message: 'probe' });
    assert(ping.ok);
    assertDeepEqual(ping.result, {
      routed: 'utility:ping',
      args: { message: 'probe' },
    });

    // stream + host channels forward to the utility after validation
    const served = await invoke(CHANNELS.streamServeUrl, { handle: 'h-1' });
    assert(served.ok);
    assertDeepEqual(served.result, {
      routed: 'stream:serve-url',
      args: { handle: 'h-1' },
    });
    const plugins = await invoke(CHANNELS.hostPlugins, undefined);
    assert(plugins.ok);
    assertDeepEqual(plugins.result, {
      routed: 'host:plugins',
      args: undefined,
    });
    const badRead = await invoke(CHANNELS.streamRead, {
      handle: 'h-1',
      position: 0,
      maxLen: 8 * 1024 * 1024,
    });
    assert(!badRead.ok && badRead.error.kind === 'invalid-request');
    const badPrepare = await invoke(CHANNELS.streamPrepare, { pluginId: 1 });
    assert(!badPrepare.ok && badPrepare.error.kind === 'invalid-request');

    // stream:port brokers a channel pair — port1 attaches to the
    // utility's pump, port2 posts back to the renderer on stream-bytes.
    const portRes = await invoke(CHANNELS.streamPort, {
      handle: 'h-9',
      requestId: 'prt-1',
    });
    assert(portRes.ok, 'stream:port brokers when sendToHost succeeds');
    assertDeepEqual(sender.posted[0], {
      channel: CHANNELS.streamBytes,
      payload: { requestId: 'prt-1', handle: 'h-9' },
      transfer: [{ p: 2 }],
    });
    const badPort = await invoke(CHANNELS.streamPort, {
      handle: 'h-9',
      requestId: 4,
    });
    assert(!badPort.ok && badPort.error.kind === 'invalid-request');

    // storage channels forward to the utility with their args intact
    utilityCalls.length = 0;
    const begin = await invoke(CHANNELS.storageBegin, undefined);
    assert(begin.ok);
    assertDeepEqual(begin.result, { txId: 'tx-1' });
    assertDeepEqual(utilityCalls[0], {
      channel: 'storage:begin',
      args: undefined,
    });
    const execArgs = { txId: 'tx-1', sql: 'SELECT 1', params: [1, 'a', null] };
    const exec = await invoke(CHANNELS.storageExecute, execArgs);
    assert(exec.ok);
    assertDeepEqual(exec.result, {
      routed: 'storage:execute',
      args: execArgs,
    });
    const backup = await invoke(CHANNELS.storageBackup, { tag: 'v1' });
    assert(backup.ok);
    assertDeepEqual(backup.result, {
      routed: 'storage:backup',
      args: { tag: 'v1' },
    });

    // malformed storage args are rejected at the boundary
    const badExec = await invoke(CHANNELS.storageExecute, {
      txId: 'tx-1',
      sql: 'SELECT 1',
      params: [true],
    });
    assert(!badExec.ok && badExec.error.kind === 'invalid-request');
    const badCommit = await invoke(CHANNELS.storageCommit, { txId: '' });
    assert(!badCommit.ok && badCommit.error.kind === 'invalid-request');
    const badBackup = await invoke(CHANNELS.storageBackup, { tag: '../x' });
    assert(!badBackup.ok && badBackup.error.kind === 'invalid-request');

    // a renderer that dies mid-tx abandons it — main rolls it back so
    // the utility's single tx slot frees up
    utilityCalls.length = 0;
    sender.emit('did-navigate');
    await sleep(0);
    assertDeepEqual(utilityCalls, [
      { channel: 'storage:rollback', args: { txId: 'tx-1' } },
    ]);

    // a committed tx is no longer tracked — later lifecycle events
    // roll back nothing
    utilityCalls.length = 0;
    const begin2 = await invoke(CHANNELS.storageBegin, undefined);
    assert(begin2.ok && begin2.result !== undefined);
    const committed = await invoke(CHANNELS.storageCommit, {
      txId: 'tx-2',
    });
    assert(committed.ok);
    sender.emit('destroyed');
    await sleep(0);
    assertDeepEqual(utilityCalls, [
      { channel: 'storage:begin', args: undefined },
      { channel: 'storage:commit', args: { txId: 'tx-2' } },
    ]);

    // multiple open txs on one sender all roll back together
    utilityCalls.length = 0;
    await invoke(CHANNELS.storageBegin, undefined);
    await invoke(CHANNELS.storageBegin, undefined);
    sender.emit('render-process-gone');
    await sleep(0);
    assertDeepEqual(utilityCalls.slice(2), [
      { channel: 'storage:rollback', args: { txId: 'tx-3' } },
      { channel: 'storage:rollback', args: { txId: 'tx-4' } },
    ]);

    // senders without lifecycle events never wedge registration
    const plainSender = { send: () => undefined };
    const plainBegin = await ipc.handlers.get(CHANNELS.storageBegin)?.(
      { sender: plainSender },
      undefined,
    );
    assert(plainBegin !== undefined && plainBegin.ok);

    // a begin that resolves only after its renderer navigated rolls
    // back its tx instead of tracking a dead owner
    utilityCalls.length = 0;
    let releaseBegin: () => void = () => undefined;
    beginGate = new Promise((resolve) => {
      releaseBegin = resolve;
    });
    const pendingBegin = invoke(CHANNELS.storageBegin, undefined);
    sender.emit('did-navigate');
    releaseBegin();
    const lateBegin = await pendingBegin;
    assert(lateBegin.ok);
    assertDeepEqual(lateBegin.result, { txId: 'tx-6' });
    await sleep(0);
    assertDeepEqual(utilityCalls, [
      { channel: 'storage:begin', args: undefined },
      { channel: 'storage:rollback', args: { txId: 'tx-6' } },
    ]);

    // a FIRST-ever pending begin has no earlier tx to have installed
    // lifecycle listeners — its renderer dying mid-await must still
    // roll the late tx back or the storage slot is held forever
    utilityCalls.length = 0;
    const firstSender = new FakeSender();
    const firstPending = ipc.handlers.get(CHANNELS.storageBegin)?.(
      { sender: firstSender },
      undefined,
    );
    firstSender.emit('destroyed');
    releaseBegin();
    const firstLate = await firstPending;
    assert(firstLate !== undefined && firstLate.ok);
    assertDeepEqual(firstLate.result, { txId: 'tx-7' });
    await sleep(0);
    assertDeepEqual(utilityCalls, [
      { channel: 'storage:begin', args: undefined },
      { channel: 'storage:rollback', args: { txId: 'tx-7' } },
    ]);
    beginGate = null;
    utilityCalls.length = 0;

    // navigation does not poison the sender's next generation — a
    // post-navigation begin tracks normally and releases on destroy
    const fresh = await invoke(CHANNELS.storageBegin, undefined);
    assert(fresh.ok);
    assertDeepEqual(fresh.result, { txId: 'tx-8' });
    sender.emit('destroyed');
    await sleep(0);
    assertDeepEqual(utilityCalls, [
      { channel: 'storage:begin', args: undefined },
      { channel: 'storage:rollback', args: { txId: 'tx-8' } },
    ]);
    beginGate = null;

    // every handler rejection still produces a well-formed envelope
    const depsThrow: ChannelDeps = {
      ...deps,
      utility: {
        request: () => Promise.reject(new Error('raw failure')),
        sendToHost: () => true,
      },
      messageChannel: () => ({ port1: { p: 1 }, port2: { p: 2 } }),
    };
    const ipcThrow = new FakeIpcMain();
    registerChannels(ipcThrow, depsThrow);
    const raw = await ipcThrow.handlers.get(CHANNELS.utilityPing)?.(
      event,
      { message: 'x' },
    );
    assert(raw !== undefined && isResultEnvelope(raw));
    assert(!raw.ok && raw.error.kind === 'internal');

    net.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
