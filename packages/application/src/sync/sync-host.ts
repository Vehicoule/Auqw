import {
  CancellationSource,
  type CancellationSignal,
} from '../cancellation.ts';
import {
  appError,
  err,
  ok,
  type Result,
} from '../errors.ts';
import type { ClockPort } from '../ports/clock.ts';
import type {
  SyncAcceptorPort,
  SyncAdvertiseOpts,
  SyncAdvertiser,
  SyncResponderCrypto,
  SyncSocket,
  SyncSocketListener,
} from '../ports/sync-transport.ts';
import {
  attachSyncPump,
  formatEndpoint,
  isClientHello,
  parseEndpoint,
} from './sync-wire.ts';
import type { SyncCallerPeer } from './custody.ts';
import { isPairableLanHost } from './lan.ts';
import {
  createSyncResponder,
  type ResponderSession,
} from './sync-responder.ts';
export {
  createPairingMint,
  normalizeSyncIp,
} from './sync-responder.ts';

/**
 * The responder half of LAN pairing, shared by any host that accepts a
 * dial (docs/specs/sync.md — symmetric pairing). The desktop's
 * sync-server is the full session server; this host deliberately serves
 * a narrower surface — it exists so the *phone* can show its own
 * QR + code and accept a desktop dialing in:
 *
 *   hello → challenge → {pair code | resume} → welcome → open
 *
 * The phase machine itself lives in `createSyncResponder` — this host
 * supplies the custody seam (its peer registry), caller-endpoint
 * bookkeeping, and the pair-only 'sync' answer. In the open phase the
 * driver answers `ping`, `devices` (the caller's own row only), and
 * `bye`; `sync` requests get a typed `pair-only` error — the
 * established sync direction stays the client dialing the desktop for
 * rounds. A resumed caller fires `onResume` so the host app can kick a
 * client-side sync round back.
 *
 * Caller endpoints: a hello carrying `port` advertises the caller's own
 * listener; combined with the socket's remote address it gives this
 * device a dialable endpoint for the peer (stored on the peer record).
 */

/** The host's custody record of one paired caller — the unified
 * `role:'caller'` SyncPeerRecord. */
export type SyncHostPeer = SyncCallerPeer;

/** Device custody for the host role — the platform's secure store. */
export interface SyncHostRegistry {
  /** By device fingerprint — hello-time `registered` answer. */
  find(fp: string, signal?: CancellationSignal): Promise<Result<SyncCallerPeer | null>>;
  /**
   * Insert-or-replace keyed on fp — a re-pair under a new device id
   * rewrites the row (one key pair, one record).
   */
  put(peer: SyncCallerPeer, signal?: CancellationSignal): Promise<Result<void>>;
  /**
   * Refresh name/lastSeenAt/endpoints only when fp is still present —
   * a resume racing an unpair must not resurrect the row. False = the
   * record vanished between hello and auth; the dialer re-pairs.
   */
  touch(peer: SyncCallerPeer, signal?: CancellationSignal): Promise<Result<boolean>>;
}

export type SyncPairHostDeps = {
  readonly acceptor: SyncAcceptorPort;
  readonly crypto: SyncResponderCrypto;
  readonly registry: SyncHostRegistry;
  /** This device's own identity — hello + welcome + payload fields. */
  readonly deviceId: string;
  readonly name: string;
  /** sha256(identity SPKI DER) hex — the QR payload's `fp`. */
  readonly fp: string;
  /**
   * sha256(SPKI DER) hex of a peer's `dev` key — the registry lookup
   * key at hello time, before accept() proves the keys. Pure-TS on
   * noble for the phone, node:crypto on the desktop.
   */
  readonly fingerprintOf: (devPubB64: string) => string;
  readonly mintCode: () => string;
  /**
   * A paired caller resumed — the host app uses this to kick a
   * client-side sync round (the caller just proved it wants a round).
   */
  readonly onResume?: (peer: SyncHostPeer) => void;
  /** A caller paired — custody landed, session open. */
  readonly onPair?: (peer: SyncHostPeer) => void;
  /**
   * mDNS announce seam (`_auqw._tcp` with TXT `dev` = our fp) —
   * wired after a successful bind, unwound on close. Best-effort:
   * pairing never depends on it, so a failed announce degrades to
   * "no discoverability", not a start failure.
   */
  readonly advertise?: (
    opts: SyncAdvertiseOpts,
  ) => SyncAdvertiser;
  /**
   * The announce died after bind — the offer stays valid via code
   * (mDNS was only ever best-effort) but is NOT discoverable nearby,
   * so the UI should tell the user rather than imply LocalSend-style
   * visibility.
   */
  readonly onAdvertiseError?: () => void;
  /** Wall clock + cancellable sleep — the client's same seam. */
  readonly clock: ClockPort;
  readonly codeTtlMs?: number;
  readonly handshakeMs?: number;
  readonly idleMs?: number;
  readonly maxConnections?: number;
  readonly handshakeCap?: number;
  readonly sessionCap?: number;
  readonly maxCodeAttempts?: number;
  readonly maxTotalCodeAttempts?: number;
  readonly log?: (line: string) => void;
};

export interface SyncPairHost {
  /** Bind the acceptor; resolves the bound port. Idempotent —
   * retries a failed bind, shares an in-flight one. */
  start(signal?: CancellationSignal): Promise<Result<{ port: number }>>;
  /** Mint a fresh pairing offer — requires start() first. */
  mintOffer(): Result<{ code: string; expiresAt: number }>;
  readonly deviceId: string;
  readonly name: string;
  readonly fp: string;
  /** Bound port — null until start resolves, null again after stop. */
  readonly port: number | null;
  /**
   * Unbind + deadvertise without closing the host: sessions die,
   * minted codes expire, and a later start() binds a fresh port.
   * The pair sheet's "stop sharing" path — a sheet reopen must be
   * able to share again.
   */
  stop(): Promise<void>;
  close(): Promise<void>;
}

export function createSyncPairHost(deps: SyncPairHostDeps): SyncPairHost {
  const nowMs = () => deps.clock.nowMs();

  /** A cancellable one-shot — the clock's sleep + a per-timer source
   * so resetting/cancelling never touches the session's own cancel. */
  function armTimer(ms: number, fire: () => void): CancellationSource {
    const source = new CancellationSource();
    void deps.clock.sleep(ms, source.signal).then((slept) => {
      if (slept.ok) {
        fire();
      }
    });
    return source;
  }

  // Custody writes a stop/close must wait out — a pair whose code was
  // consumed inside the window is allowed to finish writing, but
  // stop() doesn't return until it has (no post-window registration).
  const pendingWrites = new Set<Promise<void>>();

  function trackWrite<T>(write: Promise<T>): Promise<T> {
    const tracked = write.then(
      () => undefined,
      () => undefined,
    );
    pendingWrites.add(tracked);
    void tracked.finally(() => pendingWrites.delete(tracked));
    return write;
  }

  async function drainWrites(): Promise<void> {
    while (pendingWrites.size > 0) {
      await Promise.allSettled([...pendingWrites]);
    }
  }

  let listener: SyncSocketListener | null = null;
  let advertiser: { close(): void } | null = null;
  let startPromise: Promise<Result<{ port: number }>> | null = null;
  let closed = false;
  // Lifecycle generations: stop() bumps the counter, and a bind
  // resolving under a stale generation refuses to install — teardown
  // then only touches artifacts older than its own bump.
  let generation = 0;
  let listenerGen = -1;
  // Teardowns enqueue here and binds chain behind them — a restart
  // can't collide on the still-bound acceptor while an old stop is
  // mid-flight, and teardown never reorders ahead of a bind.
  let lifecycle: Promise<void> = Promise.resolve();

  const log = deps.log ?? (() => undefined);

  /**
   * The endpoints worth redialing for this caller: its own
   * advertised listener addrs first (self-reported, so they survive
   * a NAT/VPN-mistranslated source IP), then the observed
   * remoteIp:callerPort as fallback. Advertised entries are
   * validated LAN literals — anything else is dropped, not trusted.
   */
  function endpointsOf(session: ResponderSession): string[] {
    const list: string[] = [];
    for (const raw of session.advertisedEndpoints) {
      const ep = parseEndpoint(raw);
      if (ep !== null && isPairableLanHost(ep.host)) {
        const normalized = formatEndpoint(ep.host, ep.port);
        if (!list.includes(normalized)) {
          list.push(normalized);
          if (list.length >= 8) {
            break;
          }
        }
      }
    }
    if (session.callerPort !== null && session.remoteIp !== '') {
      const derived = formatEndpoint(session.remoteIp, session.callerPort);
      if (!list.includes(derived)) {
        list.push(derived);
      }
    }
    return list;
  }

  const responder = createSyncResponder<SyncCallerPeer>({
    crypto: () => deps.crypto,
    attach: attachSyncPump,
    name: deps.name,
    isHello: isClientHello,
    fingerprintOf: deps.fingerprintOf,
    mintCode: deps.mintCode,
    nowMs,
    armTimer,
    custody: {
      async find(fp, signal) {
        const found = await deps.registry.find(fp, signal);
        if (!found.ok) {
          return { ok: false };
        }
        const prior = found.value;
        return {
          ok: true,
          value:
            prior === null
              ? null
              : { id: prior.id, pairedAt: prior.pairedAt },
        };
      },
      async put(record, signal) {
        const put = await trackWrite(deps.registry.put(record, signal));
        return put.ok
          ? { ok: true }
          : { ok: false, reason: put.error.kind };
      },
      async touch(record, signal) {
        const touched = await trackWrite(
          deps.registry.touch(record, signal),
        );
        return touched.ok
          ? { ok: true, updated: touched.value }
          : { ok: false };
      },
    },
    buildPeer: (session, kind, now) => ({
      role: 'caller',
      // 'pair' keeps the caller's claimed id; 'resume' is pinned to the
      // id custody already binds to this key.
      id:
        kind === 'pair'
          ? session.deviceId ?? ''
          : session.registeredId ?? '',
      name: session.name,
      pub: session.devPub,
      fp: session.devFp ?? '',
      pairedAt: kind === 'pair' ? now : session.pairedAtMs ?? now,
      lastSeenAt: now,
      endpoints: endpointsOf(session),
    }),
    async ownDeviceRows(session, signal) {
      const found = await deps.registry.find(
        session.devFp ?? '',
        signal,
      );
      if (!found.ok) {
        return { ok: false };
      }
      const own = found.value;
      return {
        ok: true,
        value:
          own === null
            ? []
            : [
                {
                  id: own.id,
                  name: own.name,
                  pairedAt: own.pairedAt,
                  lastSeenAt: own.lastSeenAt,
                },
              ],
      };
    },
    welcomeExtra: () => ({
      host: {
        id: deps.deviceId,
        name: deps.name,
        pub: deps.crypto.identity.pub,
      },
    }),
    onPair: (_session, record) => deps.onPair?.(record),
    onResume: (_session, record) => deps.onResume?.(record),
    codeTtlMs: deps.codeTtlMs ?? 120_000,
    handshakeCap: deps.handshakeCap,
    sessionCap: deps.sessionCap,
    maxConnections: deps.maxConnections,
    handshakeMs: deps.handshakeMs,
    idleMs: deps.idleMs,
    maxCodeAttempts: deps.maxCodeAttempts,
    maxTotalCodeAttempts: deps.maxTotalCodeAttempts,
  });

  function onSocket(socket: SyncSocket): void {
    if (closed) {
      socket.destroy();
      return;
    }
    responder.accept(socket);
  }

  return {
    get deviceId() {
      return deps.deviceId;
    },
    get name() {
      return deps.name;
    },
    get fp() {
      return deps.fp;
    },
    get port() {
      return listener?.port ?? null;
    },
    async start(signal) {
      if (closed) {
        return err(appError('released', 'sync host: closed'));
      }
      if (signal?.cancelled === true) {
        return err(appError('cancelled', 'sync host: start cancelled'));
      }
      // One bind in flight — concurrent starts share the promise.
      // A failed bind clears the cache so the next tap retries.
      if (startPromise === null) {
        // Initialized to null so the async body's `!== attempt`
        // reads a declared variable — the real value lands before
        // the body's first await completes.
        const gen = generation;
        let attempt: Promise<Result<{ port: number }>> | null = null;
        attempt = (async () => {
          // Wait out an in-flight teardown first — the acceptor binds
          // a single native listener, so a fresh bind must not race a
          // pending unbind.
          await lifecycle;
          const bound = await deps.acceptor.listen({ onSocket });
          if (!bound.ok) {
            return bound;
          }
          if (
            closed ||
            startPromise !== attempt ||
            gen !== generation
          ) {
            // A stop/close raced the bind — the listener we just
            // got belongs to a dead generation, drop it.
            bound.value.close();
            return err(
              appError(
                closed ? 'released' : 'cancelled',
                'sync host: start superseded',
              ),
            );
          }
          listener = bound.value;
          listenerGen = gen;
          try {
            advertiser =
              deps.advertise?.({
                port: bound.value.port,
                name: deps.name,
                fp: deps.fp,
                onError: () => {
                  advertiser = null;
                  deps.onAdvertiseError?.();
                },
              }) ?? null;
          } catch {
            // mDNS is best-effort — pairing still works via QR/code.
            advertiser = null;
          }
          log(`sync host listening on :${bound.value.port}`);
          return ok({ port: bound.value.port });
        })();
        startPromise = attempt;
        const settled = await attempt;
        if (!settled.ok && startPromise === attempt) {
          startPromise = null;
        }
        return settled;
      }
      return startPromise;
    },
    async stop() {
      if (closed) {
        return;
      }
      // Bump the generation BEFORE awaiting — a bind resolving during
      // the await sees itself as stale and self-closes, and teardown
      // below only touches artifacts older than this stop.
      const gen = ++generation;
      const starting = startPromise;
      startPromise = null;
      // Atomically swap the live session set + remint — sockets a
      // post-stop generation accepts never land in the doomed set.
      const doomed = responder.rotateGeneration();
      // Enqueue teardown AFTER any in-flight work — a start() that
      // begins during our await still binds behind this teardown via
      // the shared lifecycle chain, so it can't collide on the
      // acceptor's single native listener.
      const teardown = async (): Promise<void> => {
        await starting;
        responder.expireOffer();
        for (const session of doomed) {
          responder.kill(session);
        }
        // In-flight custody writes belong to the window this stop is
        // closing — wait them out so registration can't land after
        // stop() returns. New writes are blocked by the sessions-set
        // swap (the pair/resume paths gate on membership).
        await drainWrites();
        if (listenerGen < gen) {
          const bound = listener;
          listener = null;
          try {
            advertiser?.close();
          } catch {
            // best effort
          }
          advertiser = null;
          try {
            bound?.close();
          } catch {
            // best effort
          }
        }
      };
      const ran = lifecycle.then(teardown, teardown);
      lifecycle = ran.then(
        () => undefined,
        () => undefined,
      );
      await ran;
    },
    mintOffer() {
      if (closed || listener === null) {
        return err(
          appError('unavailable', 'sync host: not listening'),
        );
      }
      // A fresh offer is a fresh pairing attempt — the operator has
      // re-invited, so the per-code brute-force counters restart too
      // (a locked-out peer would otherwise stay banned forever, even
      // after a deliberate re-pair).
      const minted = responder.mintOffer();
      return ok({ code: minted.code, expiresAt: minted.expiresAt });
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      responder.teardown();
      await drainWrites();
      const bound = listener;
      listener = null;
      try {
        advertiser?.close();
      } catch {
        // best effort
      }
      advertiser = null;
      try {
        bound?.close();
      } catch {
        // best effort
      }
      const started = startPromise;
      startPromise = null;
      await started?.catch(() => undefined);
      // Terminal — the acceptor's own subscriptions (native event
      // listeners, accept threads) die with the host.
      try {
        deps.acceptor.close?.();
      } catch {
        // best effort
      }
    },
  };
}
