import { CHANNELS } from '../shared/channels.ts';
import type {
  AppMeta,
  PickFilesArgs,
  PickFolderArgs,
  SecureDeleteArgs,
  SecureGetArgs,
  SecureSetArgs,
  UtilityPingArgs,
} from '../shared/contract.ts';
import {
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
  };
}

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
}
