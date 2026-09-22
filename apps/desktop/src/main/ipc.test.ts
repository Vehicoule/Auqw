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
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
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
        request: (channel, args) =>
          Promise.resolve({ routed: channel, args }),
      },
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

    // every handler rejection still produces a well-formed envelope
    const depsThrow: ChannelDeps = {
      ...deps,
      utility: {
        request: () => Promise.reject(new Error('raw failure')),
      },
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
