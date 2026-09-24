import { CHANNELS } from '../shared/channels.ts';
import type {
  AppMeta,
  HostCancelArgs,
  HostRequestArgs,
  PickFilesArgs,
  PickFolderArgs,
  SecureDeleteArgs,
  SecureGetArgs,
  SecureSetArgs,
  StreamCancelArgs,
  StreamDevPrepareArgs,
  StreamHandleArgs,
  StreamOpenArgs,
  StreamPortArgs,
  StreamPrepareArgs,
  StreamReadArgs,
  SyncDeltasArgs,
  SyncImportDeltaArgs,
  SyncLocalChangesArgs,
  SyncUnpairArgs,
  UtilityPingArgs,
} from '../shared/contract.ts';
import {
  isLocalAddArgs,
  isLocalProbeArgs,
  isHostCancelArgs,
  isHostRequestArgs,
  isPickFilesArgs,
  isPickFolderArgs,
  isSecureDeleteArgs,
  isSecureGetArgs,
  isSecureSetArgs,
  isStorageBackupArgs,
  isStorageBeginArgs,
  isStorageBeginResult,
  isStorageExecuteArgs,
  isStorageQueryArgs,
  isStorageTxArgs,
  isStreamCancelArgs,
  isStreamDevPrepareArgs,
  isStreamHandleArgs,
  isStreamOpenArgs,
  isStreamPortArgs,
  isStreamPrepareArgs,
  isStreamReadArgs,
  isSyncDeltasArgs,
  isSyncImportDeltaArgs,
  isSyncLocalChangesArgs,
  isSyncMaterializedArgs,
  isSyncUnpairArgs,
  isTagreadBatchArgs,
  isTagreadEnumerateArgs,
  isTransferAbortArgs,
  isTransferBeginArgs,
  isTransferFinalizeArgs,
  isTransferNameArgs,
  isTransferSinkArgs,
  isTransferSweepArgs,
  isTransferWriteArgs,
  isUtilityPingArgs,
} from '../shared/contract.ts';
import type { ResultEnvelope } from '../shared/envelope.ts';
import { fail, ok } from '../shared/envelope.ts';
import {
  fromUnknown,
  isShellError,
  shellError,
} from '../shared/errors.ts';
import type { NetSender, NetService } from './net-monitor.ts';
import type { SecureStore } from './secure-store.ts';

/** Structural slices of the Electron IPC surface — keeps this module electron-free. */
export interface RendererLifecycle {
  on?(
    event: 'destroyed' | 'render-process-gone' | 'did-navigate',
    listener: () => void,
  ): void;
  off?(
    event: 'destroyed' | 'render-process-gone' | 'did-navigate',
    listener: () => void,
  ): void;
}

export interface IpcEventLike {
  readonly sender: NetSender & RendererLifecycle;
}

type Sender = IpcEventLike['sender'];

export type InvokeListener = (
  event: IpcEventLike,
  args: unknown,
) => Promise<ResultEnvelope<unknown>>;

export interface IpcMainLike {
  handle(channel: string, listener: InvokeListener): void;
  on(channel: string, listener: (event: IpcEventLike) => void): void;
}

/**
 * The channels are invoke/response — cancellation is deliberately not
 * carried across this boundary yet. Long-running work (storage, streams,
 * sync, transfer) lands on the utility-process contract where the
 * CancellationSignal from `packages/application` ships with its ports.
 */
export interface ChannelDeps {
  readonly meta: () => AppMeta;
  /** `sync:applied` push registry — refcounted like `net`. */
  readonly syncApplied: {
    readonly attach: (sender: NetSender) => void;
    readonly detach: (sender: NetSender) => void;
  };
  readonly pickFolder: (
    args: PickFolderArgs,
    sender: NetSender,
  ) => Promise<string | null>;
  readonly pickFiles: (
    args: PickFilesArgs,
    sender: NetSender,
  ) => Promise<readonly string[]>;
  readonly net: NetService;
  readonly secure: SecureStore;
  readonly utility: {
    readonly request: (channel: string, args: unknown) => Promise<unknown>;
    readonly sendToHost: (message: unknown, transfer?: unknown[]) => boolean;
  };
  /** `MessageChannelMain` factory — injected so this module stays electron-free. */
  readonly messageChannel: () => { port1: unknown; port2: unknown };
}

/**
 * Port-delivery capable sender — a real WebContents posts the brokered
 * pump port over `stream-bytes`; send-only senders can't take ports.
 */
type PortSender = NetSender & {
  postMessage?(
    channel: string,
    payload: unknown,
    transfer?: unknown[],
  ): void;
};

type Handler = {
  readonly validate: (value: unknown) => boolean;
  readonly run: (
    args: unknown,
    deps: ChannelDeps,
    sender: NetSender,
  ) => Promise<unknown>;
};

function channel<A>(
  validate: (value: unknown) => value is A,
  run: (args: A, deps: ChannelDeps, sender: NetSender) => Promise<unknown>,
): Handler {
  return {
    validate,
    // Registration calls `run` only after `validate` has narrowed the
    // payload, so the assertion here holds by construction.
    run: (args, deps, sender) => run(args as A, deps, sender),
  };
}

function noArgs(value: unknown): value is undefined {
  return value === undefined;
}

const HANDLERS: ReadonlyArray<readonly [string, Handler]> = [
  [
    CHANNELS.appMeta,
    channel(noArgs, (_args, deps) => Promise.resolve(deps.meta())),
  ],
  [
    CHANNELS.dialogPickFolder,
    channel(isPickFolderArgs, (args, deps, sender) =>
      deps.pickFolder(args, sender),
    ),
  ],
  [
    CHANNELS.dialogPickFiles,
    channel(isPickFilesArgs, (args, deps, sender) =>
      deps.pickFiles(args, sender),
    ),
  ],
  [
    CHANNELS.netSnapshot,
    channel(noArgs, (_args, deps) =>
      Promise.resolve(deps.net.snapshot()),
    ),
  ],
  [
    CHANNELS.secureGet,
    channel(isSecureGetArgs, (args: SecureGetArgs, deps) =>
      deps.secure.get(args.key),
    ),
  ],
  [
    CHANNELS.secureSet,
    channel(isSecureSetArgs, (args: SecureSetArgs, deps) =>
      deps.secure.set(args.key, args.value),
    ),
  ],
  [
    CHANNELS.secureDelete,
    channel(isSecureDeleteArgs, (args: SecureDeleteArgs, deps) =>
      deps.secure.delete(args.key),
    ),
  ],
  [
    CHANNELS.utilityPing,
    channel(isUtilityPingArgs, (args: UtilityPingArgs, deps) =>
      deps.utility.request(CHANNELS.utilityPing, args),
    ),
  ],
  [
    CHANNELS.hostPlugins,
    channel(noArgs, (_args, deps) =>
      deps.utility.request(CHANNELS.hostPlugins, undefined),
    ),
  ],
  [
    CHANNELS.hostRequest,
    channel(isHostRequestArgs, (args: HostRequestArgs, deps) =>
      deps.utility.request(CHANNELS.hostRequest, args),
    ),
  ],
  [
    CHANNELS.hostCancel,
    channel(isHostCancelArgs, (args: HostCancelArgs, deps) =>
      deps.utility.request(CHANNELS.hostCancel, args),
    ),
  ],
  [
    CHANNELS.streamPrepare,
    channel(isStreamPrepareArgs, (args: StreamPrepareArgs, deps) =>
      deps.utility.request(CHANNELS.streamPrepare, args),
    ),
  ],
  [
    CHANNELS.streamDevPrepare,
    channel(isStreamDevPrepareArgs, (args: StreamDevPrepareArgs, deps) =>
      deps.utility.request(CHANNELS.streamDevPrepare, args),
    ),
  ],
  [
    CHANNELS.streamServeUrl,
    channel(isStreamHandleArgs, (args: StreamHandleArgs, deps) =>
      deps.utility.request(CHANNELS.streamServeUrl, args),
    ),
  ],
  [
    CHANNELS.streamOpen,
    channel(isStreamOpenArgs, (args: StreamOpenArgs, deps) =>
      deps.utility.request(CHANNELS.streamOpen, args),
    ),
  ],
  [
    CHANNELS.streamRead,
    channel(isStreamReadArgs, (args: StreamReadArgs, deps) =>
      deps.utility.request(CHANNELS.streamRead, args),
    ),
  ],
  [
    CHANNELS.streamClose,
    channel(isStreamHandleArgs, (args: StreamHandleArgs, deps) =>
      deps.utility.request(CHANNELS.streamClose, args),
    ),
  ],
  [
    CHANNELS.streamRelease,
    channel(isStreamHandleArgs, (args: StreamHandleArgs, deps) =>
      deps.utility.request(CHANNELS.streamRelease, args),
    ),
  ],
  [
    CHANNELS.streamMarks,
    channel(isStreamHandleArgs, (args: StreamHandleArgs, deps) =>
      deps.utility.request(CHANNELS.streamMarks, args),
    ),
  ],
  [
    CHANNELS.streamCancel,
    channel(isStreamCancelArgs, (args: StreamCancelArgs, deps) =>
      deps.utility.request(CHANNELS.streamCancel, args),
    ),
  ],
  // The MSE byte path: broker a MessageChannel — one end rides to the
  // utility's pump attach (with the transfer), the other to the
  // renderer (posted on `stream-bytes`, correlated by requestId).
  [
    CHANNELS.streamPort,
    channel(isStreamPortArgs, (args: StreamPortArgs, deps, sender) => {
      const target = sender as PortSender;
      if (target.postMessage === undefined) {
        return Promise.reject(
          shellError('unavailable', 'sender cannot receive ports'),
        );
      }
      const { port1, port2 } = deps.messageChannel();
      const attached = deps.utility.sendToHost(
        { kind: 'stream-pump', handle: args.handle },
        [port1],
      );
      if (!attached) {
        for (const p of [port1, port2]) {
          try {
            (p as { close(): void }).close();
          } catch {
            // best effort
          }
        }
        return Promise.reject(
          shellError('unavailable', 'no live utility process'),
        );
      }
      try {
        target.postMessage(
          CHANNELS.streamBytes,
          { requestId: args.requestId, handle: args.handle },
          [port2],
        );
      } catch {
        // The renderer died mid-handshake — port1's pump is already
        // attached on the utility side. port2 is still ours: closing
        // it fires `close` on the transferred peer, which is the pump's
        // own detach path. Without this the attach would sit open
        // holding a stream slot for a receiver that never lands.
        try {
          (port2 as { close(): void }).close();
        } catch {
          // best effort
        }
        return Promise.reject(
          shellError('unavailable', 'renderer port delivery failed'),
        );
      }
      return Promise.resolve(undefined);
    }),
  ],
  // Storage channels forward verbatim to the utility process — it
  // re-validates args against the same contract before touching the db.
  [
    CHANNELS.storageBegin,
    channel(isStorageBeginArgs, (args, deps) =>
      deps.utility.request(CHANNELS.storageBegin, args),
    ),
  ],
  [
    CHANNELS.storageCommit,
    channel(isStorageTxArgs, (args, deps) =>
      deps.utility.request(CHANNELS.storageCommit, args),
    ),
  ],
  [
    CHANNELS.storageRollback,
    channel(isStorageTxArgs, (args, deps) =>
      deps.utility.request(CHANNELS.storageRollback, args),
    ),
  ],
  [
    CHANNELS.storageCancel,
    channel(isStorageTxArgs, (args, deps) =>
      deps.utility.request(CHANNELS.storageCancel, args),
    ),
  ],
  [
    CHANNELS.storageExecute,
    channel(isStorageExecuteArgs, (args, deps) =>
      deps.utility.request(CHANNELS.storageExecute, args),
    ),
  ],
  [
    CHANNELS.storageQuery,
    channel(isStorageQueryArgs, (args, deps) =>
      deps.utility.request(CHANNELS.storageQuery, args),
    ),
  ],
  [
    CHANNELS.storageBackup,
    channel(isStorageBackupArgs, (args, deps) =>
      deps.utility.request(CHANNELS.storageBackup, args),
    ),
  ],
  [
    CHANNELS.storageDropBackup,
    channel(isStorageBackupArgs, (args, deps) =>
      deps.utility.request(CHANNELS.storageDropBackup, args),
    ),
  ],
  // Sync channels forward to the utility's LAN service — status,
  // pairing, the device registry, and the engine seam. They are
  // plugin-independent: zero plugins still syncs.
  [
    CHANNELS.syncStatus,
    channel(noArgs, (_args, deps) =>
      deps.utility.request(CHANNELS.syncStatus, undefined),
    ),
  ],
  [
    CHANNELS.syncPairing,
    channel(noArgs, (_args, deps) =>
      deps.utility.request(CHANNELS.syncPairing, undefined),
    ),
  ],
  [
    CHANNELS.syncDevices,
    channel(noArgs, (_args, deps) =>
      deps.utility.request(CHANNELS.syncDevices, undefined),
    ),
  ],
  [
    CHANNELS.syncUnpair,
    channel(isSyncUnpairArgs, (args: SyncUnpairArgs, deps) =>
      deps.utility.request(CHANNELS.syncUnpair, args),
    ),
  ],
  [
    CHANNELS.syncDeltas,
    channel(isSyncDeltasArgs, (args: SyncDeltasArgs, deps) =>
      deps.utility.request(CHANNELS.syncDeltas, args),
    ),
  ],
  [
    CHANNELS.syncImportDelta,
    channel(isSyncImportDeltaArgs, (args: SyncImportDeltaArgs, deps) =>
      deps.utility.request(CHANNELS.syncImportDelta, args),
    ),
  ],
  [
    CHANNELS.syncLocalChanges,
    channel(isSyncLocalChangesArgs, (args: SyncLocalChangesArgs, deps) =>
      deps.utility.request(CHANNELS.syncLocalChanges, args),
    ),
  ],
  [
    CHANNELS.syncTrigger,
    channel(noArgs, (_args, deps) =>
      deps.utility.request(CHANNELS.syncTrigger, undefined),
    ),
  ],
  [
    CHANNELS.syncDrainApplied,
    channel(noArgs, (_args, deps) =>
      deps.utility.request(CHANNELS.syncDrainApplied, undefined),
    ),
  ],
  [
    CHANNELS.syncAckApplied,
    channel(noArgs, (_args, deps) =>
      deps.utility.request(CHANNELS.syncAckApplied, undefined),
    ),
  ],
  [
    CHANNELS.syncMaterialized,
    channel(isSyncMaterializedArgs, (args, deps) =>
      deps.utility.request(CHANNELS.syncMaterialized, args),
    ),
  ],
  // The offline file plane — the utility re-validates each payload
  // against the same contract before touching disk or db.
  [
    CHANNELS.transferEnsureDir,
    channel(noArgs, (args, deps) =>
      deps.utility.request(CHANNELS.transferEnsureDir, args),
    ),
  ],
  [
    CHANNELS.transferBegin,
    channel(isTransferBeginArgs, (args, deps) =>
      deps.utility.request(CHANNELS.transferBegin, args),
    ),
  ],
  [
    CHANNELS.transferWrite,
    channel(isTransferWriteArgs, (args, deps) =>
      deps.utility.request(CHANNELS.transferWrite, args),
    ),
  ],
  [
    CHANNELS.transferCommit,
    channel(isTransferSinkArgs, (args, deps) =>
      deps.utility.request(CHANNELS.transferCommit, args),
    ),
  ],
  [
    CHANNELS.transferFinalize,
    channel(isTransferFinalizeArgs, (args, deps) =>
      deps.utility.request(CHANNELS.transferFinalize, args),
    ),
  ],
  [
    CHANNELS.transferAbort,
    channel(isTransferAbortArgs, (args, deps) =>
      deps.utility.request(CHANNELS.transferAbort, args),
    ),
  ],
  [
    CHANNELS.transferStat,
    channel(isTransferNameArgs, (args, deps) =>
      deps.utility.request(CHANNELS.transferStat, args),
    ),
  ],
  [
    CHANNELS.transferRemove,
    channel(isTransferNameArgs, (args, deps) =>
      deps.utility.request(CHANNELS.transferRemove, args),
    ),
  ],
  [
    CHANNELS.transferSweepPartials,
    channel(isTransferSweepArgs, (args, deps) =>
      deps.utility.request(CHANNELS.transferSweepPartials, args),
    ),
  ],
  [
    CHANNELS.transferList,
    channel(noArgs, (args, deps) =>
      deps.utility.request(CHANNELS.transferList, args),
    ),
  ],
  [
    CHANNELS.transferStatus,
    channel(isTransferSinkArgs, (args, deps) =>
      deps.utility.request(CHANNELS.transferStatus, args),
    ),
  ],
  [
    CHANNELS.transferStats,
    channel(noArgs, (args, deps) =>
      deps.utility.request(CHANNELS.transferStats, args),
    ),
  ],
  [
    CHANNELS.tagreadEnumerate,
    channel(isTagreadEnumerateArgs, (args, deps) =>
      deps.utility.request(CHANNELS.tagreadEnumerate, args),
    ),
  ],
  [
    CHANNELS.tagreadFingerprint,
    channel(isTagreadBatchArgs, (args, deps) =>
      deps.utility.request(CHANNELS.tagreadFingerprint, args),
    ),
  ],
  [
    CHANNELS.tagreadRead,
    channel(isTagreadBatchArgs, (args, deps) =>
      deps.utility.request(CHANNELS.tagreadRead, args),
    ),
  ],
  [
    CHANNELS.localAdd,
    channel(isLocalAddArgs, (args, deps) =>
      deps.utility.request(CHANNELS.localAdd, args),
    ),
  ],
  [
    CHANNELS.localProbe,
    channel(isLocalProbeArgs, (args, deps) =>
      deps.utility.request(CHANNELS.localProbe, args),
    ),
  ],
  [
    CHANNELS.localList,
    channel(noArgs, (args, deps) =>
      deps.utility.request(CHANNELS.localList, args),
    ),
  ],
  [
    CHANNELS.localPlayback,
    channel(noArgs, (args, deps) =>
      deps.utility.request(CHANNELS.localPlayback, args),
    ),
  ],
  [
    CHANNELS.localSweep,
    channel(noArgs, (args, deps) =>
      deps.utility.request(CHANNELS.localSweep, args),
    ),
  ],
];

/**
 * Maps `channel` → `{ validator, handle }` onto `ipcMain`. Every inbound
 * payload passes its hand-rolled validator first; invalid payloads never
 * reach a handler, and every reply — success or failure — is a typed
 * `ResultEnvelope`.
 */
export function registerChannels(
  ipcMain: IpcMainLike,
  deps: ChannelDeps,
): void {
  // A tx is owned by the renderer that began it; the utility survives
  // renderer reloads, so an abandoned tx would hold the single storage
  // slot forever. Txs a dead/navigated/crashed renderer left open are
  // rolled back through the same channel. Each sender's generation
  // bumps on every lifecycle event, so a `begin` dispatched before the
  // event but resolving after is rolled back instead of tracking an
  // owner that's already gone. Weak keys: destroyed senders collect
  // out instead of being retained for the app's lifetime.
  const generations = new WeakMap<Sender, number>();
  const openTxs = new Map<Sender, Set<string>>();
  const watched = new WeakSet<Sender>();
  const dropSenderTxs = (sender: Sender): void => {
    generations.set(sender, (generations.get(sender) ?? 0) + 1);
    const txs = openTxs.get(sender);
    if (txs === undefined) {
      return;
    }
    openTxs.delete(sender);
    for (const txId of txs) {
      void deps.utility
        .request(CHANNELS.storageRollback, { txId })
        .then(
          () => undefined,
          () => undefined,
        );
    }
  };
  const watch = (sender: Sender): void => {
    if (sender.on === undefined || watched.has(sender)) {
      return;
    }
    watched.add(sender);
    const release = (): void => dropSenderTxs(sender);
    const onDestroyed = (): void => {
      watched.delete(sender);
      dropSenderTxs(sender);
      sender.off?.('destroyed', onDestroyed);
      sender.off?.('render-process-gone', release);
      sender.off?.('did-navigate', release);
    };
    sender.on('destroyed', onDestroyed);
    sender.on('render-process-gone', release);
    sender.on('did-navigate', release);
  };
  const trackTx = (
    name: string,
    sender: Sender,
    args: unknown,
    result: unknown,
    generation: number | null,
  ): void => {
    if (name === CHANNELS.storageBegin && isStorageBeginResult(result)) {
      if ((generations.get(sender) ?? 0) !== generation) {
        // The owner navigated or died while the begin waited on the
        // tx slot — no renderer remains to close it, so close it now.
        void deps.utility
          .request(CHANNELS.storageRollback, { txId: result.txId })
          .then(
            () => undefined,
            () => undefined,
          );
        return;
      }
      let txs = openTxs.get(sender);
      if (txs === undefined) {
        txs = new Set();
        openTxs.set(sender, txs);
      }
      txs.add(result.txId);
      watch(sender);
      return;
    }
    if (
      (name === CHANNELS.storageCommit ||
        name === CHANNELS.storageRollback) &&
      isStorageTxArgs(args)
    ) {
      const txs = openTxs.get(sender);
      if (txs === undefined) {
        return;
      }
      txs.delete(args.txId);
      if (txs.size === 0) {
        openTxs.delete(sender);
      }
    }
  };
  for (const [name, handler] of HANDLERS) {
    ipcMain.handle(name, async (event, args) => {
      if (!handler.validate(args)) {
        return fail(
          shellError(
            'invalid-request',
            `invalid arguments for ${name}`,
          ),
        );
      }
      try {
        if (name === CHANNELS.storageBegin) {
          // Lifecycle listeners must exist BEFORE the begin awaits —
          // `trackTx` only installs them after a tx lands, so a sender
          // destroyed during its first pending begin would otherwise
          // escape the generation check and strand the tx slot.
          watch(event.sender);
        }
        const generation =
          name === CHANNELS.storageBegin
            ? (generations.get(event.sender) ?? 0)
            : null;
        const result = await handler.run(args, deps, event.sender);
        trackTx(name, event.sender, args, result, generation);
        return ok(result);
      } catch (thrown) {
        return fail(
          isShellError(thrown) ? thrown : fromUnknown(thrown),
        );
      }
    });
  }
  ipcMain.on(CHANNELS.netSubscribe, (event) => {
    deps.net.attach(event.sender);
  });
  ipcMain.on(CHANNELS.netUnsubscribe, (event) => {
    deps.net.detach(event.sender);
  });
  ipcMain.on(CHANNELS.syncAppliedSubscribe, (event) => {
    deps.syncApplied.attach(event.sender);
  });
  ipcMain.on(CHANNELS.syncAppliedUnsubscribe, (event) => {
    deps.syncApplied.detach(event.sender);
  });
}
