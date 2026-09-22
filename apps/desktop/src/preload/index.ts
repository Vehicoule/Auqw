import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { CHANNELS } from '../shared/channels.ts';
import {
  isAppMeta,
  isHostPluginsResult,
  isNetEvent,
  isPrepareOutcomePayload,
  isPreparedStreamPayload,
  isRequestOutcomePayload,
  isStorageBeginResult,
  isStorageExecuteResult,
  isStorageQueryResult,
  isStreamMarksResult,
  isStreamOpenResult,
  isStreamReadResult,
  isStreamServeUrlResult,
  isStringArray,
  isStringOrNull,
  isUndefinedResult,
  isUtilityPingResult,
} from '../shared/contract.ts';
import type {
  AppMeta,
  AuqwApi,
  NetEvent,
  NetSnapshot,
  StorageBeginResult,
  StorageExecuteResult,
  StorageQueryResult,
  StreamPortLike,
  UtilityPingResult,
} from '../shared/contract.ts';
import { isPumpServerMessage } from '../shared/pump-protocol.ts';
import type { SqlValue } from '@auqw/storage-sqlite';
import { isResultEnvelope } from '../shared/envelope.ts';
import { shellError } from '../shared/errors.ts';

let portSeq = 0;

/** The Electron message event carrying the brokered pump MessagePort. */
type PortMessageEvent = {
  readonly ports: readonly MessagePort[];
};

/**
 * `stream:port` — invoke the brokered-channel handshake, then pick the
 * transferred port off the next `stream-bytes` event matching the
 * requestId. The MessagePort itself never crosses the contextBridge —
 * the facade below wraps send/onMessage/close so the sandboxed
 * renderer drives it without owning it.
 */
function channelPort(handle: string): Promise<StreamPortLike> {
  const requestId = `prt-${++portSeq}-${Date.now().toString(36)}`;
  return new Promise<StreamPortLike>((resolve, reject) => {
    const onBytes = (event: IpcRendererEvent, payload: unknown): void => {
      if (
        typeof payload !== 'object' ||
        payload === null ||
        (payload as { requestId?: unknown }).requestId !== requestId
      ) {
        return;
      }
      ipcRenderer.removeListener(CHANNELS.streamBytes, onBytes);
      const port = (event as unknown as PortMessageEvent).ports[0];
      if (port === undefined) {
        reject(
          shellError('invalid-response', 'stream-bytes without port'),
        );
        return;
      }
      resolve(wrapPort(port));
    };
    ipcRenderer.on(CHANNELS.streamBytes, onBytes);
    invoke(
      CHANNELS.streamPort,
      { handle, requestId },
      isUndefinedResult,
    ).catch((thrown: unknown) => {
      ipcRenderer.removeListener(CHANNELS.streamBytes, onBytes);
      reject(thrown instanceof Error ? thrown : shellError('internal', 'stream:port failed'));
    });
  });
}

function wrapPort(port: MessagePort): StreamPortLike {
  const listeners = new Set<(message: unknown) => void>();
  let closed = false;
  port.onmessage = (event: MessageEvent): void => {
    const data: unknown = event.data;
    // Only protocol frames cross — anything else is dropped at the seam.
    if (!isPumpServerMessage(data)) {
      return;
    }
    for (const listener of [...listeners]) {
      listener(data);
    }
  };
  // Electron emits `close` on a dead peer — abnormal termination, so
  // surface it as an error frame, never a clean eof (the append loop
  // would endOfStream on truncated media). Epoch 0 keeps the frame
  // protocol-valid — error frames carry no epoch gate at the receiver.
  port.addEventListener('close', () => {
    closed = true;
    for (const listener of [...listeners]) {
      listener({
        kind: 'error',
        epoch: 0,
        code: 'closed',
        message: 'pump port closed',
      });
    }
    listeners.clear();
  });
  return {
    send: (message: unknown): void => {
      if (!closed) {
        port.postMessage(message);
      }
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: (): void => {
      if (!closed) {
        closed = true;
        port.close();
        listeners.clear();
      }
    },
  };
}

/**
 * Every invoke answer is re-validated here — the main side is trusted
 * code, but the bridge contract still verifies shape before a payload
 * reaches the sandboxed renderer.
 */
async function invoke<T>(
  channel: string,
  args: unknown,
  isResult: (value: unknown) => value is T,
): Promise<T> {
  const raw: unknown = await ipcRenderer.invoke(channel, args);
  if (!isResultEnvelope(raw)) {
    throw shellError(
      'invalid-response',
      `malformed reply from ${channel}`,
    );
  }
  if (!raw.ok) {
    throw raw.error;
  }
  if (!isResult(raw.result)) {
    throw shellError(
      'invalid-response',
      `unexpected payload from ${channel}`,
    );
  }
  return raw.result;
}

const api: AuqwApi = {
  app: {
    meta: (): Promise<AppMeta> =>
      invoke(CHANNELS.appMeta, undefined, isAppMeta),
  },
  dialog: {
    pickFolder: (title?: string): Promise<string | null> =>
      invoke(
        CHANNELS.dialogPickFolder,
        title === undefined ? {} : { title },
        isStringOrNull,
      ),
    pickFiles: (title?: string, multiple?: boolean): Promise<readonly string[]> => {
      const args: { title?: string; multiple?: boolean } = {};
      if (title !== undefined) {
        args.title = title;
      }
      if (multiple !== undefined) {
        args.multiple = multiple;
      }
      return invoke(CHANNELS.dialogPickFiles, args, isStringArray);
    },
  },
  net: {
    snapshot: (): Promise<NetSnapshot> =>
      invoke(CHANNELS.netSnapshot, undefined, isNetEvent),
    subscribe: (listener: (event: NetEvent) => void): (() => void) => {
      const wrapped = (
        _event: IpcRendererEvent,
        payload: unknown,
      ): void => {
        if (isNetEvent(payload)) {
          listener(payload);
        }
      };
      ipcRenderer.on(CHANNELS.netEvents, wrapped);
      ipcRenderer.send(CHANNELS.netSubscribe);
      return () => {
        ipcRenderer.removeListener(CHANNELS.netEvents, wrapped);
        ipcRenderer.send(CHANNELS.netUnsubscribe);
      };
    },
  },
  secure: {
    get: (key: string): Promise<string | null> =>
      invoke(CHANNELS.secureGet, { key }, isStringOrNull),
    set: (key: string, value: string): Promise<void> =>
      invoke(CHANNELS.secureSet, { key, value }, isUndefinedResult),
    delete: (key: string): Promise<void> =>
      invoke(CHANNELS.secureDelete, { key }, isUndefinedResult),
  },
  storage: {
    begin: (): Promise<StorageBeginResult> =>
      invoke(CHANNELS.storageBegin, undefined, isStorageBeginResult),
    commit: (txId: string): Promise<void> =>
      invoke(CHANNELS.storageCommit, { txId }, isUndefinedResult),
    rollback: (txId: string): Promise<void> =>
      invoke(CHANNELS.storageRollback, { txId }, isUndefinedResult),
    cancel: (txId: string): Promise<void> =>
      invoke(CHANNELS.storageCancel, { txId }, isUndefinedResult),
    execute: (
      txId: string,
      sql: string,
      params: readonly SqlValue[] = [],
    ): Promise<StorageExecuteResult> =>
      invoke(
        CHANNELS.storageExecute,
        { txId, sql, params },
        isStorageExecuteResult,
      ),
    query: (
      txId: string,
      sql: string,
      params: readonly SqlValue[] = [],
    ): Promise<StorageQueryResult> =>
      invoke(
        CHANNELS.storageQuery,
        { txId, sql, params },
        isStorageQueryResult,
      ),
    backup: (tag: string): Promise<void> =>
      invoke(CHANNELS.storageBackup, { tag }, isUndefinedResult),
    dropBackup: (tag: string): Promise<void> =>
      invoke(CHANNELS.storageDropBackup, { tag }, isUndefinedResult),
  },
  utility: {
    ping: (message: string): Promise<UtilityPingResult> =>
      invoke(CHANNELS.utilityPing, { message }, isUtilityPingResult),
  },
  host: {
    plugins: () => invoke(CHANNELS.hostPlugins, undefined, isHostPluginsResult),
    request: (args) =>
      invoke(CHANNELS.hostRequest, args, isRequestOutcomePayload),
    cancelRequest: (args) =>
      invoke(CHANNELS.hostCancel, args, isUndefinedResult),
  },
  stream: {
    prepare: (args) =>
      invoke(CHANNELS.streamPrepare, args, isPrepareOutcomePayload),
    devPrepare: (args) =>
      invoke(CHANNELS.streamDevPrepare, args, isPreparedStreamPayload),
    serveUrl: (args) =>
      invoke(CHANNELS.streamServeUrl, args, isStreamServeUrlResult),
    open: (args) =>
      invoke(CHANNELS.streamOpen, args, isStreamOpenResult),
    read: (args) =>
      invoke(CHANNELS.streamRead, args, isStreamReadResult),
    close: (args) =>
      invoke(CHANNELS.streamClose, args, isUndefinedResult),
    release: (args) =>
      invoke(CHANNELS.streamRelease, args, isUndefinedResult),
    marks: (args) =>
      invoke(CHANNELS.streamMarks, args, isStreamMarksResult),
    cancel: (args) =>
      invoke(CHANNELS.streamCancel, args, isUndefinedResult),
    channel: (args) => channelPort(args.handle),
  },
};

contextBridge.exposeInMainWorld('auqw', api);
