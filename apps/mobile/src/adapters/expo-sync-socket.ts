import type {
  Result,
  SyncSocket,
  SyncSocketPort,
} from '@auqw/application';
import { appError, err, ok } from '@auqw/application';
import { base64Decode, base64Encode } from './noble-sync-crypto.ts';
import {
  nativeError,
  type AuqwExpoSubscription,
  type AuqwSyncNative,
} from './auqw-expo-surface.ts';

/**
 * SyncSocketPort over the auqw-expo Kotlin socket manager: each
 * connect() mints a socketId, the native side owns the reader thread
 * and pushes frames back over two bridge events, demultiplexed here
 * into per-socket listeners. Data crosses as base64 — the bridge is
 * JSON, never binary.
 *
 * Event → node net.Socket mapping (what attachSyncPump consumes):
 *   onSyncSocketData           → 'data'
 *   onSyncSocketClosed 'peer'  → 'end' then 'close(false)'
 *   onSyncSocketClosed 'error' → 'error' then 'close(true)'
 *   onSyncSocketClosed 'local' → 'close(false)' after our destroy()
 *
 * The port tolerates an absent seam ('unavailable' at connect) so the
 * app surfaces honest-off on builds without the native socket.
 */

type SocketListeners = {
  data: ((chunk: Uint8Array) => void)[];
  close: ((hadError: boolean) => void)[];
  error: ((error: { readonly message: string }) => void)[];
  end: (() => void)[];
};

class ExpoSyncSocket implements SyncSocket {
  readonly remoteAddress: string | undefined;

  #listeners: SocketListeners = { data: [], close: [], error: [], end: [] };
  #closed = false;
  #native: AuqwSyncNative;
  #socketId: string;

  constructor(opts: {
    native: AuqwSyncNative;
    socketId: string;
    remoteAddress: string | null;
  }) {
    this.#native = opts.native;
    this.#socketId = opts.socketId;
    this.remoteAddress = opts.remoteAddress ?? undefined;
  }

  write(data: Uint8Array): void {
    if (this.#closed) {
      return;
    }
    this.#native
      .syncSend(this.#socketId, base64Encode(data))
      .catch(() => {
        // A dead socket reports through 'closed' — a write that raced
        // teardown is delivery noise, not a new failure.
      });
  }

  end(): void {
    if (this.#closed) {
      return;
    }
    this.#native.syncClose(this.#socketId).catch(() => {
      this.destroy();
    });
  }

  destroy(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    void this.#native.syncDestroy(this.#socketId).catch(() => undefined);
    this.#emitAll('close', false);
  }

  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
  on(
    event: 'error',
    listener: (error: { readonly message: string }) => void,
  ): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown {
    if (event === 'data') {
      this.#listeners.data.push(listener as (chunk: Uint8Array) => void);
    } else if (event === 'close') {
      this.#listeners.close.push(
        listener as (hadError: boolean) => void,
      );
    } else if (event === 'error') {
      this.#listeners.error.push(
        listener as (error: { readonly message: string }) => void,
      );
    } else if (event === 'end') {
      this.#listeners.end.push(listener as () => void);
    }
    return this;
  }

  /** Native pushed a frame. */
  handleData(b64: string): void {
    if (this.#closed) {
      return;
    }
    const bytes = base64Decode(b64);
    if (bytes === null) {
      this.handleClosed('error');
      return;
    }
    this.#emitAll('data', bytes);
  }

  /** Native reports the socket gone. */
  handleClosed(reason: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (reason === 'peer') {
      this.#emitAll('end');
      this.#emitAll('close', false);
    } else if (reason === 'error') {
      this.#emitAll('error', { message: 'sync: socket fault' });
      this.#emitAll('close', true);
    } else {
      this.#emitAll('close', false);
    }
    this.#listeners = { data: [], close: [], error: [], end: [] };
  }

  #emitAll(event: 'data', chunk: Uint8Array): void;
  #emitAll(event: 'close', hadError: boolean): void;
  #emitAll(event: 'error', error: { readonly message: string }): void;
  #emitAll(event: 'end'): void;
  #emitAll(event: string, arg?: unknown): void {
    const list =
      event === 'data'
        ? this.#listeners.data
        : event === 'close'
          ? this.#listeners.close
          : event === 'error'
            ? this.#listeners.error
            : this.#listeners.end;
    for (const listener of list.slice()) {
      (listener as (arg?: unknown) => void)(arg);
    }
  }
}

let socketSeq = 0;

export function createExpoSyncSockets(
  native: AuqwSyncNative,
): SyncSocketPort {
  const live = new Map<string, ExpoSyncSocket>();
  let dataSub: AuqwExpoSubscription | null = null;
  let closedSub: AuqwExpoSubscription | null = null;
  let released = false;

  const ensureWatch = (): void => {
    if (dataSub !== null) {
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
  };

  return {
    async connect({ host, port, timeoutMs, signal }) {
      if (released) {
        return err(appError('released', 'sync: socket port closed'));
      }
      const socketId = `sync-${(socketSeq += 1)}-${Date.now().toString(36)}`;
      ensureWatch();
      const unsubscribe: (() => void)[] = [];
      const cancelled = new Promise<Result<SyncSocket>>((resolve) => {
        if (signal === undefined) {
          return;
        }
        unsubscribe.push(
          signal.subscribe(() => {
            void native
              .syncDestroy(socketId)
              .catch(() => undefined)
              .finally(() =>
                resolve(err(appError('cancelled', 'sync: dial cancelled'))),
              );
          }),
        );
        if (signal.cancelled) {
          resolve(err(appError('cancelled', 'sync: dial cancelled')));
        }
      });
      const dial = (async (): Promise<Result<SyncSocket>> => {
        try {
          const reply = await native.syncConnect(
            socketId,
            host,
            port,
            timeoutMs,
          );
          if (signal?.cancelled === true) {
            void native.syncDestroy(socketId).catch(() => undefined);
            return err(appError('cancelled', 'sync: dial cancelled'));
          }
          if (released) {
            // close() ran mid-dial — the live set was already cleared,
            // so registering now would leak a native socket nobody
            // owns. Destroy the dial and answer released.
            void native.syncDestroy(socketId).catch(() => undefined);
            return err(appError('released', 'sync: socket port closed'));
          }
          const socket = new ExpoSyncSocket({
            native,
            socketId,
            remoteAddress: reply.remoteAddress,
          });
          live.set(socketId, socket);
          return ok(socket);
        } catch (thrown) {
          const mapped = nativeError(thrown);
          return err(
            mapped.kind === 'internal'
              ? appError('unavailable', `sync: dial failed — ${mapped.message}`)
              : mapped,
          );
        }
      })();
      const result = await Promise.race([dial, cancelled]);
      unsubscribe[0]?.();
      return result;
    },
    close() {
      if (released) {
        return;
      }
      released = true;
      // Bridge subscriptions outlive the client if not removed —
      // controller disposal would stack dead listeners forever.
      dataSub?.remove();
      dataSub = null;
      closedSub?.remove();
      closedSub = null;
      for (const socket of live.values()) {
        socket.destroy();
      }
      live.clear();
    },
  };
}
