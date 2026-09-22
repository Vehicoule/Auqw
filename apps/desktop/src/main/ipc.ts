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
export interface IpcEventLike {
  readonly sender: NetSender;
}

export type InvokeListener = (
  event: IpcEventLike,
  args: unknown,
) => Promise<ResultEnvelope<unknown>>;

export interface IpcMainLike {
  handle(channel: string, listener: InvokeListener): void;
  on(channel: string, listener: (event: IpcEventLike) => void): void;
}

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
        return ok(await handler.run(args, deps, event.sender));
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
