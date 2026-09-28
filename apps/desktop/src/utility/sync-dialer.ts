import { connect as netConnect, type Socket } from 'node:net';
import {
  appError,
  createSyncClient,
  err,
  formatEndpoint,
  isPairableLanHost,
  ok,
  type CancellationSignal,
  type Result,
  type SyncClient,
  type SyncClientKeys,
  type SyncEngine,
  type SyncPeer,
  type SyncSocket,
  type SyncSocketPort,
} from '@auqw/application';
import { isShellError } from '../shared/errors.ts';
import { createClock, createIds, createLog } from '../renderer/runtime.ts';
import {
  createNoiseV1ClientCrypto,
  type SyncIdentity,
} from './sync-crypto.ts';
import type { SyncKeys } from './sync-keys.ts';

/**
 * The desktop's caller half — node:net dial + custody adapter + the
 * shared SyncClient, used when the user pairs FROM the desktop to a
 * phone-hosted pair offer (tap a discovered device + its code, or scan
 * its QR payload). Sync rounds never run in this direction: a phone
 * pair host answers `sync` with 'pair-only'; the phone dials back for
 * real rounds. A pair() therefore resolves the stored peer and closes
 * the client — nothing about the session outlives the handshake.
 */

class NodeSyncSocket implements SyncSocket {
  readonly remoteAddress: string | undefined;
  readonly #socket: Socket;

  constructor(socket: Socket) {
    this.#socket = socket;
    this.remoteAddress = socket.remoteAddress;
  }

  write(data: Uint8Array): void {
    this.#socket.write(Buffer.from(data));
  }

  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
  on(
    event: 'error',
    listener: (error: { readonly message: string }) => void,
  ): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown {
    this.#socket.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  end(): void {
    this.#socket.end();
  }

  destroy(): void {
    this.#socket.destroy();
  }
}

function createNodeSyncSockets(): SyncSocketPort {
  const live = new Set<Socket>();
  return {
    connect({ host, port, timeoutMs, signal }) {
      if (!isPairableLanHost(host)) {
        // A pairing dial that isn't LAN-scoped is refused outright —
        // the renderer's typed host:port and QR endpoints alike.
        return Promise.resolve(
          err(
            appError(
              'permission-denied',
              'sync: dial target is not a LAN address',
            ),
          ),
        );
      }
      return new Promise<Result<SyncSocket>>((resolve) => {
        let settled = false;
        const socket = netConnect({ host, port });
        live.add(socket);
        const finish = (result: Result<SyncSocket>): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          unsubscribe?.();
          resolve(result);
        };
        const timer = setTimeout(() => {
          socket.destroy();
          finish(err(appError('timeout', 'sync: dial timed out')));
        }, timeoutMs);
        const unsubscribe = signal?.subscribe(() => {
          socket.destroy();
          finish(err(appError('cancelled', 'sync: dial cancelled')));
        });
        if (signal?.cancelled === true) {
          socket.destroy();
          finish(err(appError('cancelled', 'sync: dial cancelled')));
          return;
        }
        socket.once('connect', () => {
          live.add(socket);
          finish(ok(new NodeSyncSocket(socket)));
        });
        socket.once('error', (thrown) => {
          live.delete(socket);
          // The errno code is safe to surface (ECONNREFUSED etc.) — the
          // full message embeds the peer's host:port, and this error
          // crosses IPC into the renderer.
          const raw = (thrown as { code?: unknown }).code;
          const code =
            typeof raw === 'string' && /^[A-Z_]{2,20}$/.test(raw)
              ? ` (${raw})`
              : '';
          finish(
            err(appError('unavailable', `sync: dial failed${code}`)),
          );
        });
        socket.once('close', () => {
          live.delete(socket);
        });
      });
    },
    close() {
      for (const socket of live) {
        socket.destroy();
      }
      live.clear();
    },
  };
}

/**
 * App-package peer custody over the desktop's `SyncKeys` channel.
 * Shapes differ by design: the desktop's record is the responder's
 * security view (id + pub, fp derived + enforced); the client's
 * SyncPeer is the caller's dial book (endpoints/cursors). The desktop
 * dials only to PAIR, so endpoints/cursors/pot are dropped on write
 * and absent on read — the record's `id`/`pub` come through
 * `SyncPeer.deviceId`/`pub` (the welcome's host disclosure); a peer
 * that never sent them can't become a desktop device record at all.
 */
function createDesktopSyncDialerKeys(deps: {
  keys: SyncKeys;
  /** The desktop's own sync-log deviceId (async — engine boot). */
  ownDeviceId: () => Promise<string | null>;
}): SyncClientKeys {
  const toError = (thrown: unknown) =>
    isShellError(thrown)
      ? appError(
          // The custody kinds that overlap the wire taxonomy map
          // through; storage-internal kinds land on 'internal'.
          thrown.kind === 'permission-denied'
            ? 'permission-denied'
            : thrown.kind === 'unavailable'
              ? 'unavailable'
              : thrown.kind === 'cancelled'
                ? 'cancelled'
                : thrown.kind === 'storage-full'
                  ? 'storage-full'
                  : thrown.kind === 'corrupt-state'
                    ? 'internal'
                    : 'internal',
          `sync: custody — ${thrown.message}`,
        )
      : appError('internal', 'sync: custody failed');
  return {
    async identityGet(signal) {
      if (signal?.cancelled === true) {
        return err(appError('cancelled', 'sync: cancelled'));
      }
      try {
        const identity = await deps.keys.identityGet();
        if (identity === null) {
          return ok(null);
        }
        const deviceId = await deps.ownDeviceId();
        if (deviceId === null) {
          return ok(null);
        }
        return ok({ deviceId, identity });
      } catch (thrown) {
        return err(toError(thrown));
      }
    },
    async identitySet(record, signal) {
      if (signal?.cancelled === true) {
        return err(appError('cancelled', 'sync: cancelled'));
      }
      try {
        await deps.keys.identitySet(record.identity);
        return ok(undefined);
      } catch (thrown) {
        return err(toError(thrown));
      }
    },
    async peerList(signal) {
      if (signal?.cancelled === true) {
        return err(appError('cancelled', 'sync: cancelled'));
      }
      try {
        const { devices } = await deps.keys.deviceList();
        return ok(
          devices.map(
            (record): SyncPeer => ({
              fp: record.fp,
              name: record.name,
              endpoints: [],
              pairedAt: record.pairedAt,
              lastSeenAt: record.lastSeenAt,
              peerCursor: {},
              deviceId: record.id,
              pub: record.pub,
            }),
          ),
        );
      } catch (thrown) {
        return err(toError(thrown));
      }
    },
    async peerPut(peer, signal) {
      if (signal?.cancelled === true) {
        return err(appError('cancelled', 'sync: cancelled'));
      }
      if (peer.deviceId === undefined || peer.pub === undefined) {
        return err(
          appError(
            'invalid-message',
            'sync: peer never disclosed its device key — cannot custody',
          ),
        );
      }
      try {
        await deps.keys.devicePut({
          id: peer.deviceId,
          name: peer.name,
          pub: peer.pub,
          fp: peer.fp,
          pairedAt: peer.pairedAt,
          lastSeenAt: peer.lastSeenAt,
        });
        return ok(undefined);
      } catch (thrown) {
        return err(toError(thrown));
      }
    },
    async peerMerge(peer, signal) {
      // Desktop custody carries no sync cursors — `peerCursor`/`pot`
      // live in the sync-log DB, not the device record — so the merge
      // contract's preserved fields don't exist here and a put IS the
      // merge (devicePut keeps the original pairedAt internally).
      return this.peerPut(peer, signal);
    },
    async peerTouch(peer, signal) {
      if (signal?.cancelled === true) {
        return err(appError('cancelled', 'sync: cancelled'));
      }
      if (peer.deviceId === undefined || peer.pub === undefined) {
        return err(
          appError(
            'invalid-message',
            'sync: peer never disclosed its device key — cannot custody',
          ),
        );
      }
      try {
        // device-touch serializes the existence check + write in the
        // service — an unpair racing this update can't be undone by
        // a stale put landing after the delete.
        const updated = await deps.keys.deviceTouch({
          id: peer.deviceId,
          name: peer.name,
          pub: peer.pub,
          fp: peer.fp,
          pairedAt: peer.pairedAt,
          lastSeenAt: peer.lastSeenAt,
        });
        return ok(updated);
      } catch (thrown) {
        return err(toError(thrown));
      }
    },
    async peerDelete(fp, signal) {
      if (signal?.cancelled === true) {
        return err(appError('cancelled', 'sync: cancelled'));
      }
      try {
        const { devices } = await deps.keys.deviceList();
        const record = devices.find((d) => d.fp === fp);
        if (record !== undefined) {
          await deps.keys.deviceDelete(record.id);
        }
        return ok(undefined);
      } catch (thrown) {
        return err(toError(thrown));
      }
    },
  };
}

export type SyncDialer = {
  /**
   * Pair TO a discovered/typed phone host — `code` is the 6-digit
   * offer the phone is displaying; `fp` pins the responder when the
   * caller learned it out-of-band (QR payload or mDNS TXT).
   */
  pairTo(opts: {
    host: string;
    port: number;
    code: string;
    fp?: string;
    /** All resolved dial candidates (best-first) — `host` is the
     * fallback when absent; the dial iterates the list. */
    hosts?: readonly string[];
    signal?: CancellationSignal;
  }): Promise<Result<SyncPeer>>;
  /** Pair TO a phone's scanned QR payload verbatim. */
  pairPayload(
    payload: string,
    signal?: CancellationSignal,
  ): Promise<Result<SyncPeer>>;
};

export function createSyncDialer(deps: {
  keys: SyncKeys;
  ownDeviceId: () => Promise<string | null>;
  engine: () => Promise<SyncEngine | null>;
  deviceName: string;
  /** The desktop listener's bound port — carried in the hello so the
   * phone can dial back for resume rounds. */
  listenPort: () => number | null;
  /**
   * This desktop's own dialable listener endpoints — advertised in
   * the hello so the responder prefers them over the socket's
   * (possibly NAT/VPN-mistranslated) remote address.
   */
  listenEndpoints: () => readonly string[];
}): SyncDialer {
  async function withClient<T>(
    run: (client: SyncClient) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const engine = await deps.engine();
    const deviceId = await deps.ownDeviceId();
    if (engine === null || deviceId === null) {
      return err(
        appError('unavailable', 'sync: engine not available'),
      );
    }
    let identity: SyncIdentity | null;
    try {
      identity = await deps.keys.identityGet();
    } catch (thrown) {
      return err(
        isShellError(thrown)
          ? appError('unavailable', `sync: custody — ${thrown.message}`)
          : appError('internal', 'sync: custody failed'),
      );
    }
    if (identity === null) {
      return err(
        appError('unavailable', 'sync: identity not installed'),
      );
    }
    const sockets = createNodeSyncSockets();
    const client = createSyncClient({
      sockets,
      crypto: createNoiseV1ClientCrypto(identity),
      keys: createDesktopSyncDialerKeys({
        keys: deps.keys,
        ownDeviceId: deps.ownDeviceId,
      }),
      engine,
      ids: createIds(),
      clock: createClock(),
      log: createLog(),
      deviceId,
      name: deps.deviceName,
      listenPort: deps.listenPort,
      listenEndpoints: deps.listenEndpoints,
    });
    try {
      return await run(client);
    } finally {
      await client.close();
      sockets.close?.();
    }
  }

  return {
    pairTo({ host, port, code, fp, hosts, signal }) {
      const candidates =
        hosts !== undefined && hosts.length > 0 ? hosts : [host];
      return withClient((client) =>
        client.pair(
          {
            code,
            endpoints: [...new Set(candidates)].map((h) =>
              formatEndpoint(h, port),
            ),
            ...(fp !== undefined ? { fp } : {}),
          },
          signal,
        ),
      );
    },
    pairPayload(payload, signal) {
      return withClient((client) => client.pair({ payload }, signal));
    },
  };
}
