import type {
  Result,
  SyncAcceptorPort,
  SyncSocket,
  SyncSocketListener,
} from '@auqw/application';
import { appError, err, ok } from '@auqw/application';
import {
  nativeError,
  type AuqwExpoSubscription,
  type AuqwSyncNative,
} from './auqw-expo-surface.ts';
import { ExpoSyncSocket } from './expo-sync-socket.ts';

/**
 * SyncAcceptorPort over the auqw-expo listener: `syncListen` binds an
 * ephemeral TCP port natively; each accepted socket arrives as an
 * `onSyncSocketAccepted` event with an `accept-<n>` id and joins the
 * same live-map as dialed sockets so the shared data/closed events
 * route identically.
 *
 * The listener is single-shot by design — the pair sheet owns its
 * lifecycle (open → listen + mint, close → stop) — and `listen` while
 * one is bound is a typed 'unavailable', never a silent rebind.
 */
export function createExpoSyncAcceptor(
  native: AuqwSyncNative,
): SyncAcceptorPort {
  const live = new Map<string, ExpoSyncSocket>();
  let acceptSub: AuqwExpoSubscription | null = null;
  let dataSub: AuqwExpoSubscription | null = null;
  let closedSub: AuqwExpoSubscription | null = null;
  let listening: {
    onSocket: (socket: SyncSocket) => void;
  } | null = null;

  const ensureWatch = (): void => {
    if (acceptSub !== null) {
      return;
    }
    dataSub = native.addSyncSocketDataListener((event) => {
      live.get(event.socketId)?.handleData(event.data);
    });
    closedSub = native.addSyncSocketClosedListener((event) => {
      const socket = live.get(event.socketId);
      if (socket !== undefined) {
        socket.handleClosed(event.reason);
        live.delete(event.socketId);
      }
    });
    acceptSub = native.addSyncSocketAcceptedListener?.((event) => {
      const socket = new ExpoSyncSocket({
        native,
        socketId: event.socketId,
        remoteAddress: event.remoteAddress,
      });
      live.set(event.socketId, socket);
      listening?.onSocket(socket);
    }) ?? null;
  };

  // The handle's close() is synchronous but the native stop is async —
  // a stop that lands AFTER a fresh syncListen() would kill the new
  // bind. Chain every stop so a listen can never precede a pending one.
  let nativeChain: Promise<void> = Promise.resolve();

  return {
    async listen({ onSocket }) {
      if (native.syncListen === undefined) {
        return err(
          appError('unavailable', 'sync: native listener seam absent'),
        );
      }
      ensureWatch();
      try {
        await nativeChain;
      } catch {
        // a dead pending stop must not block a fresh bind
      }
      if (listening !== null) {
        return err(appError('unavailable', 'sync: already listening'));
      }
      try {
        const { port } = await native.syncListen();
        listening = { onSocket };
        const handle: SyncSocketListener = {
          port,
          close() {
            listening = null;
            for (const socket of live.values()) {
              socket.destroy();
            }
            live.clear();
            const stop = native.syncListenStop?.() ?? Promise.resolve();
            nativeChain = nativeChain.then(
              () => stop.catch(() => undefined),
              () => undefined,
            );
          },
        };
        return ok(handle);
      } catch (thrown) {
        return err(
          nativeError(thrown) ?? appError('unavailable', 'sync: listen failed'),
        );
      }
    },
  };
}
