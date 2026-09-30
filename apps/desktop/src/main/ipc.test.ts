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
import { createAuthCustodyHandler } from './auth-custody.ts';
import { isShellError } from '../shared/errors.ts';
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
  failPost = false;
  postMessage(
    channel: string,
    payload: unknown,
    transfer?: unknown[],
  ): void {
    if (this.failPost) {
      throw new Error('renderer gone');
    }
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
      theme: {
        attach: () => undefined,
        detach: () => undefined,
        stop: () => undefined,
      },
      syncApplied: {
        attach: () => undefined,
        detach: () => undefined,
      },
      syncNearby: {
        attach: () => undefined,
        detach: () => undefined,
      },
      authState: {
        attach: () => undefined,
        detach: () => undefined,
      },
      update: {
        snapshot: () => ({
          status: { state: 'idle' },
          currentVersion: '0.1.0',
        }),
        check: () =>
          Promise.resolve({
            status: { state: 'idle' },
            currentVersion: '0.1.0',
          }),
        subscribe: () => () => undefined,
        open: () => Promise.resolve(),
      },
      updateState: {
        attach: () => undefined,
        detach: () => undefined,
      },
      openUrl: () => Promise.resolve(),
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

    // sync:local-changes forwards renderer-committed writes to the
    // sync engine seam — the channel is registered, not dead.
    const localWrites = {
      writes: [
        { kind: 'recordings', recordId: 'rec-1', field: 'title', value: 'x' },
      ],
    };
    const synced = await invoke(CHANNELS.syncLocalChanges, localWrites);
    assert(synced.ok, 'sync:local-changes is registered');
    assertDeepEqual(synced.result, {
      routed: 'sync:localChanges',
      args: localWrites,
    });
    const badWrites = await invoke(CHANNELS.syncLocalChanges, {
      writes: [],
    });
    assert(!badWrites.ok && badWrites.error.kind === 'invalid-request');

    // The local file legs the renderer's provider:'local' playback
    // depends on — resolve gates the attach URI, read feeds peaks.
    const resolved = await invoke(CHANNELS.localResolve, {
      uri: 'file:///music/track.flac',
    });
    assert(resolved.ok, 'local:resolve is registered');
    assertDeepEqual(resolved.result, {
      routed: 'local:resolve',
      args: { uri: 'file:///music/track.flac' },
    });
    const read = await invoke(CHANNELS.localRead, {
      uri: 'file:///music/track.flac',
      position: 0,
      maxLen: 4096,
    });
    assert(read.ok, 'local:read is registered');
    assertDeepEqual(read.result, {
      routed: 'local:read',
      args: {
        uri: 'file:///music/track.flac',
        position: 0,
        maxLen: 4096,
      },
    });
    const badResolve = await invoke(CHANNELS.localResolve, { uri: 4 });
    assert(!badResolve.ok && badResolve.error.kind === 'invalid-request');
    const badReadArgs = await invoke(CHANNELS.localRead, {
      uri: 'file:///music/track.flac',
      position: -1,
      maxLen: 4096,
    });
    assert(!badReadArgs.ok && badReadArgs.error.kind === 'invalid-request');

    // Renderer dies mid-handshake: postMessage throws after port1
    // already attached the utility pump. The still-owned peer must be
    // closed — the peer 'close' is the pump's own detach path, so
    // nothing keeps the stream slot alive for a dead receiver.
    let port2Closed = false;
    const deadDeps: ChannelDeps = {
      ...deps,
      messageChannel: () => ({
        port1: { p: 1 },
        port2: {
          close() {
            port2Closed = true;
          },
        },
      }),
    };
    const deadIpc = new FakeIpcMain();
    registerChannels(deadIpc, deadDeps);
    const deadSender = new FakeSender();
    deadSender.failPost = true;
    const dead = await deadIpc.handlers.get(CHANNELS.streamPort)?.(
      { sender: deadSender },
      { handle: 'h-9', requestId: 'prt-2' },
    );
    assert(dead !== undefined && isResultEnvelope(dead));
    assert(!dead.ok && dead.error.kind === 'unavailable');
    assert(port2Closed, 'still-owned peer closes → pump detaches');

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
    const manyArgs = {
      txId: 'tx-1',
      statements: [
        { sql: 'DELETE FROM t WHERE id = ?', params: ['a'] },
        { sql: 'INSERT INTO t VALUES (?)', params: ['b'] },
      ],
    };
    const many = await invoke(CHANNELS.storageExecMany, manyArgs);
    assert(many.ok);
    assertDeepEqual(many.result, {
      routed: 'storage:execMany',
      args: manyArgs,
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
    const badMany = await invoke(CHANNELS.storageExecMany, {
      txId: 'tx-1',
      statements: [{ sql: 'SELECT 1', params: [{}] }],
    });
    assert(!badMany.ok && badMany.error.kind === 'invalid-request');
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

    // ---- auth (OAuth session trust) ------------------------------------
    // The renderer-facing verbs forward verbatim to the utility's auth
    // service — custody, polling, and token application live there.
    for (const channel of [
      CHANNELS.authStatus,
      CHANNELS.authBegin,
      CHANNELS.authCancel,
      CHANNELS.authSignOut,
      CHANNELS.authRetry,
    ]) {
      const forwarded = await invoke(channel, undefined);
      assert(forwarded.ok, `${channel} did not forward`);
      assertDeepEqual(forwarded.result, {
        routed: channel,
        args: undefined,
      });
    }
    const setClient = await invoke(CHANNELS.authSetClient, {
      clientId: 'custom-client-id',
    });
    assert(setClient.ok, 'auth:setClient rejected a valid override');
    assertDeepEqual(setClient.result, {
      routed: 'auth:setClient',
      args: { clientId: 'custom-client-id' },
    });
    // Clearing the override carries null; malformed args never reach
    // the utility.
    const clearClient = await invoke(CHANNELS.authSetClient, {
      clientId: null,
    });
    assert(clearClient.ok);
    const badClient = await invoke(CHANNELS.authSetClient, {
      clientId: 'x'.repeat(600),
    });
    assert(!badClient.ok && badClient.error.kind === 'invalid-request');
    // The verification-URL open is the only outbound URL the renderer
    // can request — the google.com allowlist lives at the dep.
    let opened: string | null = null;
    const depsOpen: ChannelDeps = {
      ...deps,
      openUrl: (url) => {
        opened = url;
        return Promise.resolve();
      },
    };
    const ipcOpen = new FakeIpcMain();
    registerChannels(ipcOpen, depsOpen);
    const open = await ipcOpen.handlers.get(CHANNELS.authOpenUrl)?.(
      event,
      { url: 'https://www.google.com/device' },
    );
    assert(open !== undefined && open.ok, 'auth:openUrl rejected');
    assertEqual(opened, 'https://www.google.com/device');
    const badOpen = await ipcOpen.handlers.get(CHANNELS.authOpenUrl)?.(
      event,
      { url: 42 },
    );
    assert(
      badOpen !== undefined &&
        !badOpen.ok &&
        badOpen.error.kind === 'invalid-request',
    );
    // auth:state subscription refcounts through the push registry.
    let attached = 0;
    let detached = 0;
    const depsPush: ChannelDeps = {
      ...deps,
      authState: {
        attach: () => {
          attached += 1;
        },
        detach: () => {
          detached += 1;
        },
      },
    };
    const ipcPush = new FakeIpcMain();
    registerChannels(ipcPush, depsPush);
    ipcPush.listeners.get(CHANNELS.authSubscribe)?.(event);
    ipcPush.listeners.get(CHANNELS.authUnsubscribe)?.(event);
    assertEqual(attached, 1);
    assertEqual(detached, 1);

    // ---- auth:custody service handler (utility→main, not renderer) --
    // The sealed record round-trips through a real file-backed store;
    // a corrupt payload surfaces typed rather than as absent custody.
    const authSecure = createSecureStore({
      dir: join(dir, 'auth-secure'),
      safeStorage: WORKING_STORAGE,
    });
    const custody = createAuthCustodyHandler({ secure: authSecure });
    const empty = await custody({ op: 'get' });
    assertDeepEqual(empty, { record: null });
    await custody({
      op: 'set',
      record: {
        v: 1,
        refreshToken: 'grant-1',
        clientId: 'cid-1',
        grantClientId: 'issuer-1',
      },
    });
    const roundTrip = await custody({ op: 'get' });
    assertDeepEqual(roundTrip, {
      record: {
        v: 1,
        refreshToken: 'grant-1',
        clientId: 'cid-1',
        grantClientId: 'issuer-1',
      },
    });
    await custody({ op: 'clear' });
    assertDeepEqual(await custody({ op: 'get' }), { record: null });
    // Malformed ops throw a typed shellError.
    await custody({ op: 'nuke' }).then(
      () => assert(false, 'bad op accepted'),
      (thrown: unknown) => {
        assert(
          isShellError(thrown) && thrown.kind === 'invalid-request',
          'bad op threw untyped',
        );
      },
    );
    await custody({ op: 'set', record: { v: 2, refreshToken: 3 } }).then(
      () => assert(false, 'bad record accepted'),
      (thrown: unknown) => {
        assert(
          isShellError(thrown) && thrown.kind === 'invalid-request',
          'bad record threw untyped',
        );
      },
    );

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
