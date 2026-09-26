import { connect as netConnect, type Socket } from 'node:net';
import {
  appError,
  createSyncClient,
  err,
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

/**
 * Dotted-decimal IPv4 parse — returns null on anything that isn't a
 * strict `a.b.c.d` literal with each octet in range.
 */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) {
    return null;
  }
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255)
    ? [octets[0]!, octets[1]!, octets[2]!, octets[3]!]
    : null;
}

/**
 * Pairing targets are LAN-scoped: the IPC caller (renderer) may be
 * compromised, so `host` must be an address a LAN pairing protocol
 * legitimately dials — a private/loopback/link-local/CGNAT/ULA
 * literal, or an mDNS-style `.local`/`.lan` name. Public literals and
 * arbitrary DNS names are refused before `netConnect` runs.
 */
/**
 * Whole-literal IPv6 parse → eight 16-bit groups, or null. Handles
 * `::` compression, a `%zone` scope suffix, and a trailing embedded
 * dotted-quad — and rejects every byte that isn't part of a valid
 * literal, so nothing here can smuggle a DNS name through.
 */
function parseIpv6(addr: string): number[] | null {
  const zoneless = addr.split('%', 1)[0] ?? '';
  if (zoneless === '') {
    return null;
  }
  const halves = zoneless.split('::');
  if (halves.length > 2) {
    return null;
  }
  const group = (g: string): number | null =>
    /^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : null;
  const leftRaw = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const rightRaw =
    halves[1] === undefined ? null : halves[1] === '' ? [] : halves[1].split(':');
  // An embedded IPv4 tail contributes the last two groups.
  const tailList = rightRaw ?? leftRaw;
  const tail = tailList[tailList.length - 1];
  let v4Groups: number[] = [];
  if (tail !== undefined && tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) {
      return null;
    }
    tailList.pop();
    v4Groups = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
  }
  const left = leftRaw.map(group);
  const right = (rightRaw ?? []).map(group);
  if (left.includes(null) || right.includes(null)) {
    return null;
  }
  const leftN = left as number[];
  const rightN = right as number[];
  const total = leftN.length + rightN.length + v4Groups.length;
  if (rightRaw === null) {
    // No `::` — the literal must carry all eight groups exactly.
    return total === 8 ? [...leftN, ...v4Groups] : null;
  }
  if (total > 7) {
    return null;
  }
  const pad = Array<number>(8 - total).fill(0);
  return [...leftN, ...pad, ...rightN, ...v4Groups];
}

/**
 * Pairing targets are LAN-scoped: the IPC caller (renderer) may be
 * compromised, so `host` must be an IP literal a LAN pairing protocol
 * legitimately dials — private/loopback/link-local/CGNAT/ULA —
 * never a DNS name, which could resolve anywhere.
 */
export function isPairableLanHost(host: string): boolean {
  const bare =
    host.startsWith('[') && host.endsWith(']')
      ? host.slice(1, -1)
      : host;
  const v4direct = parseIpv4(bare);
  const groups = v4direct === null ? parseIpv6(bare) : null;
  const v4 =
    v4direct ??
    // IPv4-mapped form: ::ffff:a.b.c.d → groups [0,0,0,0,0,ffff,…].
    (groups !== null &&
    groups.slice(0, 5).every((g) => g === 0) &&
    groups[5] === 0xffff
      ? [
          (groups[6]! >> 8) & 0xff,
          groups[6]! & 0xff,
          (groups[7]! >> 8) & 0xff,
          groups[7]! & 0xff,
        ]
      : null);
  if (v4 !== null) {
    const [a, b] = v4;
    return (
      a === 10 || // RFC1918
      a === 127 || // loopback
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT (overlay VPNs)
    );
  }
  if (groups === null) {
    return false;
  }
  if (groups.every((g) => g === 0)) {
    return false; // :: — unspecified
  }
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return true; // ::1 loopback
  }
  const first = groups[0]!;
  return (
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xfe00) === 0xfc00 // fc00::/7 ULA
  );
}

export function createNodeSyncSockets(): SyncSocketPort {
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
export function createDesktopSyncDialerKeys(deps: {
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
}): SyncDialer {
  async function withClient<T>(
    run: (client: SyncClient) => Promise<Result<T>>,
    signal?: CancellationSignal,
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
    });
    try {
      return await run(client);
    } finally {
      await client.close();
      sockets.close?.();
    }
  }

  return {
    pairTo({ host, port, code, fp, signal }) {
      return withClient(
        (client) =>
          client.pair(
            {
              code,
              endpoints: [`${host}:${port}`],
              ...(fp !== undefined ? { fp } : {}),
            },
            signal,
          ),
        signal,
      );
    },
    pairPayload(payload, signal) {
      return withClient(
        (client) => client.pair({ payload }, signal),
        signal,
      );
    },
  };
}
