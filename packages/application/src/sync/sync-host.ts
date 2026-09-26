import {
  CancellationSource,
  type CancellationSignal,
} from '../cancellation.ts';
import {
  appError,
  err,
  ok,
  type AppError,
  type Result,
} from '../errors.ts';
import { isRecord, isString } from '../domain.ts';
import type { ClockPort } from '../ports/clock.ts';
import type {
  SyncAcceptorPort,
  SyncAdvertiseOpts,
  SyncAdvertiser,
  SyncFrameCodec,
  SyncResponderCrypto,
  SyncSocket,
  SyncSocketListener,
} from '../ports/sync-transport.ts';
import {
  attachSyncPump,
  decodeJson,
  encodeJson,
  isClientHello,
  HANDSHAKE_CAP,
  PAIR_CODE_PATTERN,
  SESSION_CAP,
  type SyncDeviceRecord,
  type SyncWirePump,
} from './sync-wire.ts';

/**
 * The responder half of LAN pairing, shared by any host that accepts a
 * dial (docs/specs/sync.md — symmetric pairing). The desktop's
 * sync-server is the full session server; this host deliberately serves
 * a narrower surface — it exists so the *phone* can show its own
 * QR + code and accept a desktop dialing in:
 *
 *   hello → challenge → {pair code | resume} → welcome → open
 *
 * In the open phase a pair host answers `ping`, `devices` (the caller's
 * own row only), and `bye`; `sync` requests get a typed `pair-only`
 * error — the established sync direction stays the client dialing the
 * desktop for rounds. A resumed caller fires `onResume` so the host app
 * can kick a client-side sync round back.
 *
 * Caller endpoints: a hello carrying `port` advertises the caller's own
 * listener; combined with the socket's remote address it gives this
 * device a dialable endpoint for the peer (stored on the peer record).
 */

/** The host's custody record of one paired caller. */
export type SyncHostPeer = {
  /** The caller's claimed deviceId — registry names it, not the wire. */
  readonly id: string;
  readonly name: string;
  /** Caller's device X25519 SPKI, base64 — audit/display only. */
  readonly pub: string;
  readonly fp: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
  /** Dialable `host:port`s, learned from hello.port — may be empty. */
  readonly endpoints: readonly string[];
};

/** Device custody for the host role — the platform's secure store. */
export interface SyncHostRegistry {
  /** By device fingerprint — hello-time `registered` answer. */
  find(fp: string, signal?: CancellationSignal): Promise<Result<SyncHostPeer | null>>;
  /**
   * Insert-or-replace keyed on fp — a re-pair under a new device id
   * rewrites the row (one key pair, one record).
   */
  put(peer: SyncHostPeer, signal?: CancellationSignal): Promise<Result<void>>;
  /**
   * Refresh name/lastSeenAt/endpoints only when fp is still present —
   * a resume racing an unpair must not resurrect the row. False = the
   * record vanished between hello and auth; the dialer re-pairs.
   */
  touch(peer: SyncHostPeer, signal?: CancellationSignal): Promise<Result<boolean>>;
}

type PairCheck = 'ok' | 'bad-code' | 'pairing-expired' | 'no-pairing';

type PairingState = {
  readonly code: string;
  readonly expiresAt: number;
};

/**
 * The pending pairing offer: minted per `mintOffer` call, expires on
 * TTL, consumed exactly once on success. Wrong codes never burn the
 * mint — rate limiting is per remote address + a global ceiling (see
 * the host's attempt maps) so a hostile LAN peer can't invalidate the
 * code a legitimate caller is typing.
 */
export function createPairingMint(opts: {
  nowMs: () => number;
  ttlMs: number;
  /** CSPRNG-backed 6-digit mint — platform-provided. */
  mintCode: () => string;
}): {
  mint(): PairingState;
  peek(code: string): PairCheck;
  consume(code: string): PairingState | null;
  restore(taken: PairingState): void;
  expire(): void;
  readonly pending: boolean;
} {
  let current: PairingState | null = null;
  return {
    mint() {
      const code = opts.mintCode();
      if (!PAIR_CODE_PATTERN.test(code)) {
        throw new Error('pairing mint produced an off-pattern code');
      }
      current = { code, expiresAt: opts.nowMs() + opts.ttlMs };
      return current;
    },
    peek(code) {
      if (current === null) {
        return 'no-pairing';
      }
      if (opts.nowMs() >= current.expiresAt) {
        current = null;
        return 'pairing-expired';
      }
      return code === current.code ? 'ok' : 'bad-code';
    },
    consume(code) {
      if (
        current === null ||
        current.code !== code ||
        opts.nowMs() >= current.expiresAt
      ) {
        return null;
      }
      const taken = current;
      current = null; // a code pairs exactly once
      return taken;
    },
    restore(taken) {
      if (current === null) {
        current = taken;
      }
    },
    expire() {
      current = null;
    },
    get pending() {
      return current !== null;
    },
  };
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

type SessionPhase = 'hello' | 'auth' | 'open';

type HostSession = {
  readonly pump: SyncWirePump;
  readonly remoteIp: string;
  readonly cancel: CancellationSource;
  phase: SessionPhase;
  codec: SyncFrameCodec | null;
  /** Set post-hello — the caller's identity claims. */
  deviceId: string | null;
  devFp: string | null;
  devPub: string;
  name: string;
  /** Registry-resolved id/fp at hello time — resume authorization. */
  registered: boolean;
  registeredId: string | null;
  pairedAtMs: number | null;
  /** hello.port → the caller's own dialable listener port. */
  callerPort: number | null;
  handshakeTimer: CancellationSource | null;
  idleTimer: CancellationSource | null;
  ops: Promise<void>;
};

function parseJson(payload: Uint8Array): unknown {
  return decodeJson(payload);
}

function isWireMsg(value: unknown): value is { readonly t: string } {
  return isRecord(value) && isString(value['t'], 32);
}

function isPairMsg(value: unknown): value is { t: 'pair'; code: string } {
  return (
    isRecord(value) &&
    value['t'] === 'pair' &&
    typeof value['code'] === 'string' &&
    PAIR_CODE_PATTERN.test(value['code'])
  );
}

function isResumeMsg(value: unknown): value is { t: 'resume' } {
  return isRecord(value) && value['t'] === 'resume';
}

/** Remote-IP the attempt budgets key on — IPv6-wrapped v4 unwrapped. */
export function normalizeSyncIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function createSyncPairHost(deps: SyncPairHostDeps): SyncPairHost {
  const nowMs = () => deps.clock.nowMs();
  const handshakeCap = deps.handshakeCap ?? HANDSHAKE_CAP;
  const sessionCap = deps.sessionCap ?? SESSION_CAP;
  const maxConnections = deps.maxConnections ?? 16;
  const handshakeMs = deps.handshakeMs ?? 15_000;
  const idleMs = deps.idleMs ?? 120_000;
  const maxCodeAttempts = deps.maxCodeAttempts ?? 5;
  const maxTotalCodeAttempts =
    deps.maxTotalCodeAttempts ?? maxCodeAttempts * 3;

  let pairing = createPairingMint({
    nowMs,
    ttlMs: deps.codeTtlMs ?? 120_000,
    mintCode: deps.mintCode,
  });

  const badAttempts = new Map<string, number>();
  let totalBadAttempts = 0;

  // Pair-check serialization — same guarantee as the desktop's
  // pairChain: peek+consume inside one lane so a losing session sees
  // the consumed code at its own peek, not the pre-consume state.
  let pairChain: Promise<unknown> = Promise.resolve();
  function withPairLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = pairChain.then(fn);
    pairChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // `sessions` is swapped wholesale on stop — a socket accepted by a
  // post-stop generation never lands in the set a pending teardown is
  // killing.
  let sessions = new Set<HostSession>();
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
  let serviceCancel = new CancellationSource();
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

  /* ------------------------- session plumbing ---------------------- */

  function sendSealed(session: HostSession, msg: unknown): void {
    if (session.codec === null) {
      return;
    }
    session.pump.send(session.codec.seal(encodeJson(msg)));
  }

  function dropSession(session: HostSession): void {
    if (!sessions.delete(session)) {
      return;
    }
    session.handshakeTimer?.cancel();
    session.handshakeTimer = null;
    session.idleTimer?.cancel();
    session.idleTimer = null;
    session.cancel.cancel();
  }

  function killSession(session: HostSession): void {
    dropSession(session);
    session.pump.close();
  }

  function resetIdle(session: HostSession): void {
    session.idleTimer?.cancel();
    session.idleTimer = armTimer(idleMs, () => killSession(session));
  }

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

  function welcomeDevice(peer: SyncHostPeer): SyncDeviceRecord {
    return {
      id: peer.id,
      name: peer.name,
      pub: peer.pub,
      fp: peer.fp,
      pairedAt: peer.pairedAt,
      lastSeenAt: peer.lastSeenAt,
    };
  }

  function sendWelcome(session: HostSession, peer: SyncHostPeer): void {
    sendSealed(session, {
      t: 'welcome',
      device: welcomeDevice(peer),
      name: deps.name,
      host: {
        id: deps.deviceId,
        name: deps.name,
        pub: deps.crypto.identity.pub,
      },
    });
  }

  function endpointOf(session: HostSession): string | null {
    return session.callerPort === null || session.remoteIp === ''
      ? null
      : `${session.remoteIp}:${session.callerPort}`;
  }

  /* ----------------------------- hello ----------------------------- */

  async function onHello(session: HostSession, payload: Uint8Array) {
    // Advance the phase BEFORE the first await — a second hello frame
    // while registry lookup is in flight would re-run this body.
    session.phase = 'auth';
    let msg: unknown;
    try {
      msg = parseJson(payload);
    } catch {
      killSession(session);
      return;
    }
    if (!isClientHello(msg)) {
      killSession(session);
      return;
    }
    const devFp = deps.fingerprintOf(msg.dev);
    const found = await deps.registry.find(devFp, serviceCancel.signal);
    if (!found.ok) {
      killSession(session);
      return;
    }
    const prior = found.value;
    let accepted;
    try {
      accepted = deps.crypto.accept(msg, { registered: prior !== null });
    } catch {
      killSession(session);
      return;
    }
    session.deviceId = msg.deviceId;
    session.devFp = accepted.peer.devFp;
    session.devPub = accepted.peer.devPub;
    session.name = accepted.peer.name;
    session.callerPort = msg.port ?? null;
    session.registered = prior !== null;
    // The registry — never the wire — names a resumed device. Rows
    // from before deviceId custody stay id-less (''), paired by fp
    // alone; claiming a different id under an old key fills nothing
    // (touch only writes a non-empty id).
    session.registeredId = prior === null ? null : prior.id;
    session.pairedAtMs = prior?.pairedAt ?? null;
    session.codec = accepted.codec;
    session.pump.upgrade(sessionCap);
    session.pump.send(accepted.challenge);
  }

  /* ----------------------------- auth ------------------------------ */

  async function onAuthFrame(session: HostSession, payload: Uint8Array) {
    const codec = session.codec;
    if (codec === null || session.deviceId === null) {
      killSession(session);
      return;
    }
    let msg: unknown;
    try {
      msg = parseJson(codec.open(payload));
    } catch {
      killSession(session);
      return;
    }
    const reject = (reason: string): void => {
      sendSealed(session, { t: 'reject', reason });
      // Flush the reject frame before the socket dies — destroy()
      // would discard queued output and leave the caller at a mute EOF.
      session.pump.end();
    };
    const now = nowMs();
    if (isPairMsg(msg)) {
      type Outcome =
        | { readonly ok: true; readonly record: SyncHostPeer }
        | { readonly ok: false; readonly reason: string };
      const outcome = await withPairLock(async (): Promise<Outcome> => {
        const misses = badAttempts.get(session.remoteIp) ?? 0;
        if (
          misses >= maxCodeAttempts ||
          totalBadAttempts >= maxTotalCodeAttempts
        ) {
          return { ok: false, reason: 'pairing-attempts' };
        }
        const check = pairing.peek(msg.code);
        if (check === 'bad-code') {
          badAttempts.set(session.remoteIp, misses + 1);
          totalBadAttempts += 1;
          const locked =
            misses + 1 >= maxCodeAttempts ||
            totalBadAttempts >= maxTotalCodeAttempts;
          return {
            ok: false,
            reason: locked ? 'pairing-attempts' : 'bad-code',
          };
        }
        if (check !== 'ok') {
          return { ok: false, reason: check };
        }
        // Consume BEFORE the durable write — a consumed code while the
        // put is in flight can't be claimed by a racing session.
        const taken = pairing.consume(msg.code);
        if (taken === null) {
          return { ok: false, reason: 'no-pairing' };
        }
        const endpoint = endpointOf(session);
        const record: SyncHostPeer = {
          id: session.deviceId ?? '',
          name: session.name,
          pub: session.devPub,
          fp: session.devFp ?? '',
          pairedAt: now,
          lastSeenAt: now,
          endpoints: endpoint !== null ? [endpoint] : [],
        };
        // A stop() swapped the sessions set — a session not in the
        // live set belongs to a dead generation; its custody write
        // must not start outside the window.
        if (!sessions.has(session)) {
          return { ok: false, reason: 'unavailable' };
        }
        const put = await trackWrite(
          deps.registry.put(record, serviceCancel.signal),
        );
        if (!put.ok) {
          pairing.restore(taken);
          return { ok: false, reason: put.error.kind };
        }
        badAttempts.delete(session.remoteIp);
        return { ok: true, record };
      });
      if (!outcome.ok) {
        reject(outcome.reason);
        return;
      }
      if (!sessions.has(session)) {
        // The write settled inside the stop window but the socket is
        // already dead — custody has the peer; nothing more to emit.
        return;
      }
      sendWelcome(session, outcome.record);
      deps.onPair?.(outcome.record);
      enterOpen(session);
      return;
    }
    if (isResumeMsg(msg)) {
      // The registry — not the claimed id — names a resumed device; a
      // paired key presenting a foreign deviceId cannot take its slot.
      if (
        !session.registered ||
        session.registeredId === null ||
        session.devFp === null
      ) {
        reject('unpaired');
        return;
      }
      const endpoint = endpointOf(session);
      const record: SyncHostPeer = {
        id: session.registeredId,
        name: session.name,
        pub: session.devPub,
        fp: session.devFp,
        pairedAt: session.pairedAtMs ?? now,
        lastSeenAt: now,
        endpoints: endpoint !== null ? [endpoint] : [],
      };
      if (!sessions.has(session)) {
        reject('unpaired');
        return;
      }
      const touched = await trackWrite(
        deps.registry.touch(record, serviceCancel.signal),
      );
      if (!touched.ok || !touched.value) {
        reject('unpaired');
        return;
      }
      if (!sessions.has(session)) {
        return;
      }
      sendWelcome(session, record);
      enterOpen(session);
      // After the welcome lands — the hook may kick a sync round that
      // itself dials out; keeping it post-enterOpen keeps ordering sane.
      deps.onResume?.(record);
      return;
    }
    reject('bad-auth');
  }

  /* ----------------------------- open ------------------------------ */

  function enterOpen(session: HostSession): void {
    session.phase = 'open';
    session.handshakeTimer?.cancel();
    session.handshakeTimer = null;
    resetIdle(session);
  }

  function onOpenFrame(session: HostSession, payload: Uint8Array): void {
    resetIdle(session);
    session.ops = session.ops.then(() => onOpenMsg(session, payload));
  }

  async function onOpenMsg(session: HostSession, payload: Uint8Array) {
    const codec = session.codec;
    if (codec === null || session.pump.closed) {
      return;
    }
    let msg: unknown;
    try {
      msg = parseJson(codec.open(payload));
    } catch {
      killSession(session);
      return;
    }
    if (!isWireMsg(msg)) {
      sendSealed(session, { t: 'error', code: 'bad-request' });
      return;
    }
    switch (msg.t) {
      case 'ping':
        sendSealed(session, { t: 'pong' });
        return;
      case 'devices': {
        // Only the caller's own row ever crosses — no registry dump.
        const found = await deps.registry.find(
          session.devFp ?? '',
          serviceCancel.signal,
        );
        if (!found.ok) {
          sendSealed(session, { t: 'error', code: 'unavailable' });
          return;
        }
        const own = found.value;
        sendSealed(session, {
          t: 'devices',
          devices:
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
        });
        return;
      }
      case 'sync':
        sendSealed(session, { t: 'error', code: 'pair-only' });
        return;
      case 'bye':
        killSession(session);
        return;
      default:
        sendSealed(session, { t: 'error', code: 'bad-request' });
    }
  }

  /* --------------------------- the host ---------------------------- */

  function onSocket(socket: SyncSocket): void {
    if (closed) {
      socket.destroy();
      return;
    }
    if (sessions.size >= maxConnections) {
      socket.destroy();
      return;
    }
    const session: HostSession = {
      pump: attachSyncPump({
        socket,
        maxPayload: handshakeCap,
        onFrame: (payload) => {
          if (session.phase === 'hello') {
            void onHello(session, payload);
          } else if (session.phase === 'auth') {
            void onAuthFrame(session, payload);
          } else {
            onOpenFrame(session, payload);
          }
        },
        onClose: () => dropSession(session),
      }),
      remoteIp: normalizeSyncIp(socket.remoteAddress ?? ''),
      cancel: new CancellationSource(),
      phase: 'hello',
      codec: null,
      deviceId: null,
      devFp: null,
      devPub: '',
      name: '',
      registered: false,
      registeredId: null,
      pairedAtMs: null,
      callerPort: null,
      handshakeTimer: null,
      idleTimer: null,
      ops: Promise.resolve(),
    };
    // A socket that never finishes pairing dies instead of idling in
    // the handshake phase forever.
    session.handshakeTimer = armTimer(handshakeMs, () =>
      killSession(session),
    );
    sessions.add(session);
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
      const doomed = sessions;
      sessions = new Set();
      const mint = pairing;
      pairing = createPairingMint({
        nowMs,
        ttlMs: deps.codeTtlMs ?? 120_000,
        mintCode: deps.mintCode,
      });
      // Enqueue teardown AFTER any in-flight work — a start() that
      // begins during our await still binds behind this teardown via
      // the shared lifecycle chain, so it can't collide on the
      // acceptor's single native listener.
      const teardown = async (): Promise<void> => {
        await starting;
        serviceCancel.cancel();
        serviceCancel = new CancellationSource();
        mint.expire();
        for (const session of doomed) {
          killSession(session);
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
      const minted = pairing.mint();
      return ok({ code: minted.code, expiresAt: minted.expiresAt });
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      serviceCancel.cancel();
      pairing.expire();
      for (const session of sessions) {
        killSession(session);
      }
      sessions.clear();
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