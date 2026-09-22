import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { CHANNELS } from '../shared/channels.ts';
import {
  isAppMeta,
  isNetEvent,
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
  UtilityPingResult,
} from '../shared/contract.ts';
import { isResultEnvelope } from '../shared/envelope.ts';
import { shellError } from '../shared/errors.ts';

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
  utility: {
    ping: (message: string): Promise<UtilityPingResult> =>
      invoke(CHANNELS.utilityPing, { message }, isUtilityPingResult),
  },
};

contextBridge.exposeInMainWorld('auqw', api);
