import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { CHANNELS } from '../shared/channels.ts';
import {
  isAppMeta,
  isAuthSnapshot,
  isHostPluginsResult,
  isLocalAddResult,
  isLocalListResult,
  isLocalPlaybackResult,
  isLocalProbeResult,
  isLocalReadResult,
  isLocalResolveResult,
  isLocalSweepResult,
  isNetEvent,
  isPrepareOutcomePayload,
  isPreparedStreamPayload,
  isRequestOutcomePayload,
  isStorageBeginResult,
  isStorageExecuteResult,
  isStorageQueryResult,
  isStreamMarksResult,
  isStreamOpenResult,
  isStreamProbeResult,
  isStreamReadResult,
  isStreamServeUrlResult,
  isStringArray,
  isStringOrNull,
  isSyncAppliedEvent,
  isSyncDeltasResult,
  isSyncDialResult,
  isSyncNearbyEvent,
  isSyncDevicesResult,
  isSyncDrainAppliedResult,
  isSyncImportDeltaResult,
  isSyncLocalChangesResult,
  isSyncMaterializedResult,
  isSyncPairingResult,
  isSyncStatusResult,
  isSyncTriggerResult,
  isTagreadEnumerateResult,
  isTagreadFingerprintResult,
  isTagreadReadResult,
  isThemeSourceEvent,
  isTransferBeginResult,
  isTransferCommitResult,
  isTransferFetchBodyResult,
  isTransferFetchResult,
  isTransferFinalizeResult,
  isTransferListResult,
  isTransferStatResult,
  isTransferStatsResult,
  isTransferStatusResult,
  isTransferSweepResult,
  isUndefinedResult,
  isUpdateSnapshot,
  isUtilityPingResult,
  isWindowStateEvent,
} from '../shared/contract.ts';
import type {
  AuqwApi,
  StreamPortLike,
} from '../shared/contract.ts';
import { isPumpServerMessage } from '../shared/pump-protocol.ts';
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

/** Refcounted push channel: validate each payload, fan out to the listener. */
function subscribeTo<E>(
  events: string,
  sub: string,
  unsub: string,
  is: (payload: unknown) => payload is E,
): (listener: (event: E) => void) => () => void {
  return (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
      if (is(payload)) {
        listener(payload);
      }
    };
    ipcRenderer.on(events, wrapped);
    ipcRenderer.send(sub);
    return () => {
      ipcRenderer.removeListener(events, wrapped);
      ipcRenderer.send(unsub);
    };
  };
}

const api: AuqwApi = {
  app: {
    meta: () => invoke(CHANNELS.appMeta, undefined, isAppMeta),
  },
  chrome: {
    platform: process.platform,
    control: (op) => {
      ipcRenderer.send(CHANNELS.windowControl, { op });
    },
    onState: subscribeTo(
      CHANNELS.windowStateEvents,
      CHANNELS.windowStateSubscribe,
      CHANNELS.windowStateUnsubscribe,
      isWindowStateEvent,
    ),
  },
  dialog: {
    pickFolder: (title) =>
      invoke(
        CHANNELS.dialogPickFolder,
        title === undefined ? {} : { title },
        isStringOrNull,
      ),
    pickFiles: (title, multiple) =>
      invoke(
        CHANNELS.dialogPickFiles,
        {
          ...(title !== undefined ? { title } : {}),
          ...(multiple !== undefined ? { multiple } : {}),
        },
        isStringArray,
      ),
  },
  net: {
    snapshot: () => invoke(CHANNELS.netSnapshot, undefined, isNetEvent),
    subscribe: subscribeTo(
      CHANNELS.netEvents,
      CHANNELS.netSubscribe,
      CHANNELS.netUnsubscribe,
      isNetEvent,
    ),
  },
  theme: {
    subscribe: subscribeTo(
      CHANNELS.themeEvents,
      CHANNELS.themeSubscribe,
      CHANNELS.themeUnsubscribe,
      isThemeSourceEvent,
    ),
  },
  secure: {
    get: (key) => invoke(CHANNELS.secureGet, { key }, isStringOrNull),
    set: (key, value) =>
      invoke(CHANNELS.secureSet, { key, value }, isUndefinedResult),
    delete: (key) =>
      invoke(CHANNELS.secureDelete, { key }, isUndefinedResult),
  },
  storage: {
    begin: () =>
      invoke(CHANNELS.storageBegin, undefined, isStorageBeginResult),
    commit: (txId) =>
      invoke(CHANNELS.storageCommit, { txId }, isUndefinedResult),
    rollback: (txId) =>
      invoke(CHANNELS.storageRollback, { txId }, isUndefinedResult),
    cancel: (txId) =>
      invoke(CHANNELS.storageCancel, { txId }, isUndefinedResult),
    execute: (txId, sql, params = []) =>
      invoke(
        CHANNELS.storageExecute,
        { txId, sql, params },
        isStorageExecuteResult,
      ),
    execMany: (txId, statements) =>
      invoke(
        CHANNELS.storageExecMany,
        { txId, statements },
        isUndefinedResult,
      ),
    query: (txId, sql, params = []) =>
      invoke(
        CHANNELS.storageQuery,
        { txId, sql, params },
        isStorageQueryResult,
      ),
    backup: (tag) =>
      invoke(CHANNELS.storageBackup, { tag }, isUndefinedResult),
    dropBackup: (tag) =>
      invoke(CHANNELS.storageDropBackup, { tag }, isUndefinedResult),
  },
  sync: {
    status: () => invoke(CHANNELS.syncStatus, undefined, isSyncStatusResult),
    pairing: () =>
      invoke(CHANNELS.syncPairing, undefined, isSyncPairingResult),
    devices: () =>
      invoke(CHANNELS.syncDevices, undefined, isSyncDevicesResult),
    unpair: (args) =>
      invoke(CHANNELS.syncUnpair, args, isUndefinedResult),
    deltas: (args) =>
      invoke(CHANNELS.syncDeltas, args, isSyncDeltasResult),
    importDelta: (args) =>
      invoke(
        CHANNELS.syncImportDelta,
        args,
        isSyncImportDeltaResult,
      ),
    trigger: () =>
      invoke(CHANNELS.syncTrigger, undefined, isSyncTriggerResult),
    localChanges: (args) =>
      invoke(
        CHANNELS.syncLocalChanges,
        args,
        isSyncLocalChangesResult,
      ),
    drainApplied: () =>
      invoke(
        CHANNELS.syncDrainApplied,
        undefined,
        isSyncDrainAppliedResult,
      ),
    ackApplied: () =>
      invoke(CHANNELS.syncAckApplied, undefined, isUndefinedResult),
    materialized: (args) =>
      invoke(
        CHANNELS.syncMaterialized,
        args,
        isSyncMaterializedResult,
      ),
    onApplied: subscribeTo(
      CHANNELS.syncApplied,
      CHANNELS.syncAppliedSubscribe,
      CHANNELS.syncAppliedUnsubscribe,
      isSyncAppliedEvent,
    ),
    nearbyStart: () =>
      invoke(CHANNELS.syncNearbyStart, undefined, isUndefinedResult),
    nearbyStop: () =>
      invoke(CHANNELS.syncNearbyStop, undefined, isUndefinedResult),
    onNearby: subscribeTo(
      CHANNELS.syncNearby,
      CHANNELS.syncNearbySubscribe,
      CHANNELS.syncNearbyUnsubscribe,
      isSyncNearbyEvent,
    ),
    dial: (args) => invoke(CHANNELS.syncDial, args, isSyncDialResult),
    dialPayload: (args) =>
      invoke(CHANNELS.syncDialPayload, args, isSyncDialResult),
  },
  utility: {
    ping: (message) =>
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
    probe: (args) =>
      invoke(CHANNELS.streamProbe, args, isStreamProbeResult),
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
  transfer: {
    ensureDir: () =>
      invoke(CHANNELS.transferEnsureDir, undefined, isUndefinedResult),
    begin: (args) =>
      invoke(CHANNELS.transferBegin, args, isTransferBeginResult),
    write: (args) =>
      invoke(CHANNELS.transferWrite, args, isUndefinedResult),
    commit: (args) =>
      invoke(CHANNELS.transferCommit, args, isTransferCommitResult),
    finalize: (args) =>
      invoke(CHANNELS.transferFinalize, args, isTransferFinalizeResult),
    abort: (args) =>
      invoke(CHANNELS.transferAbort, args, isUndefinedResult),
    stat: (args) =>
      invoke(CHANNELS.transferStat, args, isTransferStatResult),
    remove: (args) =>
      invoke(CHANNELS.transferRemove, args, isUndefinedResult),
    sweepPartials: (args) =>
      invoke(
        CHANNELS.transferSweepPartials,
        args,
        isTransferSweepResult,
      ),
    sweepFinalized: (args) =>
      invoke(
        CHANNELS.transferSweepFinalized,
        args,
        isTransferSweepResult,
      ),
    list: () =>
      invoke(CHANNELS.transferList, undefined, isTransferListResult),
    status: (args) =>
      invoke(CHANNELS.transferStatus, args, isTransferStatusResult),
    stats: () =>
      invoke(CHANNELS.transferStats, undefined, isTransferStatsResult),
    fetch: (args) =>
      invoke(CHANNELS.transferFetch, args, isTransferFetchResult),
    fetchBody: (args) =>
      invoke(CHANNELS.transferFetchBody, args, isTransferFetchBodyResult),
    fetchAbort: (args) =>
      invoke(CHANNELS.transferFetchAbort, args, isUndefinedResult),
  },
  tagread: {
    enumerate: (args) =>
      invoke(
        CHANNELS.tagreadEnumerate,
        args,
        isTagreadEnumerateResult,
      ),
    fingerprint: (args) =>
      invoke(
        CHANNELS.tagreadFingerprint,
        args,
        isTagreadFingerprintResult,
      ),
    read: (args) =>
      invoke(CHANNELS.tagreadRead, args, isTagreadReadResult),
  },
  local: {
    add: (args) => invoke(CHANNELS.localAdd, args, isLocalAddResult),
    probe: (args) =>
      invoke(CHANNELS.localProbe, args, isLocalProbeResult),
    resolve: (args) =>
      invoke(CHANNELS.localResolve, args, isLocalResolveResult),
    read: (args) =>
      invoke(CHANNELS.localRead, args, isLocalReadResult),
    list: () => invoke(CHANNELS.localList, undefined, isLocalListResult),
    playback: () =>
      invoke(CHANNELS.localPlayback, undefined, isLocalPlaybackResult),
    sweep: () =>
      invoke(CHANNELS.localSweep, undefined, isLocalSweepResult),
  },
  auth: {
    status: () => invoke(CHANNELS.authStatus, undefined, isAuthSnapshot),
    begin: () => invoke(CHANNELS.authBegin, undefined, isUndefinedResult),
    cancel: () =>
      invoke(CHANNELS.authCancel, undefined, isUndefinedResult),
    signOut: () =>
      invoke(CHANNELS.authSignOut, undefined, isUndefinedResult),
    setClient: (clientId) =>
      invoke(CHANNELS.authSetClient, { clientId }, isUndefinedResult),
    retry: () => invoke(CHANNELS.authRetry, undefined, isUndefinedResult),
    openUrl: (url) =>
      invoke(CHANNELS.authOpenUrl, { url }, isUndefinedResult),
    onState: subscribeTo(
      CHANNELS.authState,
      CHANNELS.authSubscribe,
      CHANNELS.authUnsubscribe,
      isAuthSnapshot,
    ),
  },
  update: {
    status: () =>
      invoke(CHANNELS.updateStatus, undefined, isUpdateSnapshot),
    check: (kind) =>
      invoke(CHANNELS.updateCheck, { kind }, isUpdateSnapshot),
    open: () => invoke(CHANNELS.updateOpen, undefined, isUndefinedResult),
    apply: () => invoke(CHANNELS.updateApply, undefined, isUndefinedResult),
    reapply: () =>
      invoke(CHANNELS.updateReapply, undefined, isUndefinedResult),
    cancel: () =>
      invoke(CHANNELS.updateCancel, undefined, isUndefinedResult),
    restart: () =>
      invoke(CHANNELS.updateRestart, undefined, isUndefinedResult),
    onState: subscribeTo(
      CHANNELS.updateState,
      CHANNELS.updateSubscribe,
      CHANNELS.updateUnsubscribe,
      isUpdateSnapshot,
    ),
  },
};

contextBridge.exposeInMainWorld('auqw', api);
