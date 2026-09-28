import {
  CancellationSource,
  type CancellationSignal,
} from '../cancellation.ts';
import { hasExactKeys, isRecord, isString } from '../domain.ts';
import type {
  SyncFrameCodec,
  SyncResponderCrypto,
  SyncSocket,
} from '../ports/sync-transport.ts';
import {
  decodeJson,
  encodeJson,
  HANDSHAKE_CAP,
  PAIR_CODE_PATTERN,
  SEAL_OVERHEAD,
  SESSION_CAP,
  type ClientHello,
  type SyncWirePump,
  type WireCloseReason,
} from './sync-wire.ts';

/**
 * The shared responder core of the LAN sync handshake
 * (docs/specs/sync.md — symmetric pairing). Any host that accepts a
 * dial runs the same wire conversation:
 *
 *   hello → challenge → {pair code | resume} → welcome → open
 *
 * The desktop's sync-server and the phone's pair host both used to
 * carry private copies of this phase machine. This driver owns it
 * once — the session table (phases, pumps, timers, the ops chain),
 * the pairing store (mint/peek/consume/restore plus the wrong-code
 * attempt budgets), the pair lock, and the reject-then-end teardown —
 * and is parametrized on everything past the phase machine: the
 * custody seam (find/put/touch), the record each host stores, the
 * welcome's extra fields, and the open-phase `sync` surface
 * ('pair-only' for a pure pair host, full delta serving on the
 * desktop).
 */

/** The custody record's wire-visible fields — the welcome's `device`. */
export type ResponderDeviceRecord = {
  readonly id: string;
  readonly name: string;
  readonly pub: string;
  readonly fp: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
};

/** One row of a 'devices' reply — the caller's own custody view. */
export type ResponderDeviceRow = {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
};

/** What custody already knows about a caller's key at hello time. */
export type ResponderPrior = {
  readonly id: string;
  readonly pairedAt: number;
};

export type ResponderRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

/**
 * A custody write's verdict — `reason` lands verbatim in the wire
 * reject so the caller sees the store's own failure kind.
 */
export type ResponderWrite =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type ResponderTouch =
  | { readonly ok: true; readonly updated: boolean }
  | { readonly ok: false };

/** Device custody for the responder role — the platform secure store. */
export interface SyncResponderCustody<
  TRecord extends ResponderDeviceRecord,
> {
  /** By device fingerprint — the hello-time `registered` answer. */
  find(
    fp: string,
    signal: CancellationSignal,
  ): Promise<ResponderRead<ResponderPrior | null>>;
  /**
   * Insert-or-replace keyed on fp — a re-pair under a new device id
   * rewrites the row (one key pair, one record).
   */
  put(
    record: TRecord,
    signal: CancellationSignal,
  ): Promise<ResponderWrite>;
  /**
   * Refresh name/lastSeenAt only when fp is still present — a resume
   * racing an unpair must not resurrect the row. `updated: false` =
   * the record vanished between hello and auth; the dialer re-pairs.
   */
  touch(
    record: TRecord,
    signal: CancellationSignal,
  ): Promise<ResponderTouch>;
}

export type ResponderPhase = 'hello' | 'auth' | 'open';

/** A cancellable one-shot timer — CancellationSource or a setTimeout wrap. */
export type ResponderTimer = { cancel(): void };

/**
 * The socket shape handed to the pump factory — assignable INTO both
 * the app's `SyncSocket` and the desktop's `WireSocketLike`
 * (net.Socket). The two differ only in the `error` listener's param
 * annotation (`{message:string}` vs `Error`), which is mutually
 * unsatisfiable in either direction, so the seam spells the wider
 * one; the pump attaches listeners and never invents a value for it.
 */
export type ResponderSocket = {
  /** Peer address when the underlying transport knows one. */
  readonly remoteAddress?: string | undefined;
  write(data: Uint8Array): unknown;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  /**
   * Graceful half-close — queued writes flush before FIN (net.Socket
   * semantics). The pump treats a substrate without end() as destroy().
   */
  end?(): unknown;
  destroy(): void;
};

export type ResponderSession = {
  readonly pump: SyncWirePump;
  /** Source address for per-peer pairing rate limiting ('' = unknown). */
  readonly remoteIp: string;
  /** Cancelled when the session dies — engine ops can stop mid-flight. */
  readonly cancel: CancellationSource;
  phase: ResponderPhase;
  codec: SyncFrameCodec | null;
  /** Set post-hello — the caller's identity claims. */
  deviceId: string | null;
  devFp: string | null;
  /** Device long-lived public key (SPKI b64) captured at accept(). */
  devPub: string;
  name: string;
  /** Custody lookup result from hello — echoed, not trusted. */
  registered: boolean;
  /** The id custody already binds to this key — resume pins it. */
  registeredId: string | null;
  /** Custody pairedAt for resume, when known. */
  pairedAtMs: number | null;
  /** hello.port → the caller's own dialable listener port. */
  callerPort: number | null;
  /** hello.endpoints → caller-advertised dialable listener addrs. */
  advertisedEndpoints: readonly string[];
  handshakeTimer: ResponderTimer | null;
  idleTimer: ResponderTimer | null;
  /** Per-session op chain — post-open work never interleaves. */
  ops: Promise<void>;
};

/* ------------------------- pairing codes -------------------------- */

type PairCheck = 'ok' | 'bad-code' | 'pairing-expired' | 'no-pairing';

type PairingState = {
  readonly code: string;
  readonly expiresAt: number;
};

/**
 * The pending pairing offer: minted per caller request, expires on
 * TTL, consumed exactly once on success. Wrong codes never burn the
 * mint — rate limiting lives in the pairing store below.
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

/**
 * The PairingStore collaborator: the pending mint plus the two-layer
 * wrong-code budget — per remote address (an attacker exhausts only
 * its own guesses, so the legit caller's window can't be DoS'd away)
 * and one shared ceiling per pending code (address aliases can't
 * split the budget into unbounded total tries). Both layers clear on
 * each fresh mint; the per-IP layer also clears on a successful pair.
 */
function createPairingStore(opts: {
  nowMs: () => number;
  ttlMs: number;
  mintCode: () => string;
  maxCodeAttempts: number;
  maxTotalCodeAttempts: number;
}) {
  const fresh = (): ReturnType<typeof createPairingMint> =>
    createPairingMint({
      nowMs: opts.nowMs,
      ttlMs: opts.ttlMs,
      mintCode: opts.mintCode,
    });
  let mint = fresh();
  const badAttempts = new Map<string, number>();
  let totalBadAttempts = 0;
  return {
    /** A fresh offer is a fresh pairing attempt — budgets restart. */
    offer(): PairingState {
      const minted = mint.mint();
      badAttempts.clear();
      totalBadAttempts = 0;
      return minted;
    },
    peek: (code: string) => mint.peek(code),
    consume: (code: string) => mint.consume(code),
    restore: (taken: PairingState) => mint.restore(taken),
    expire: () => mint.expire(),
    locked(remoteIp: string): boolean {
      return (
        (badAttempts.get(remoteIp) ?? 0) >= opts.maxCodeAttempts ||
        totalBadAttempts >= opts.maxTotalCodeAttempts
      );
    },
    /** Burn one budget slot — true once this miss locks the peer out. */
    recordMiss(remoteIp: string): boolean {
      const misses = (badAttempts.get(remoteIp) ?? 0) + 1;
      badAttempts.set(remoteIp, misses);
      totalBadAttempts += 1;
      return (
        misses >= opts.maxCodeAttempts ||
        totalBadAttempts >= opts.maxTotalCodeAttempts
      );
    },
    clearIp(remoteIp: string): void {
      badAttempts.delete(remoteIp);
    },
    /** stop(): a dead generation's mint can't serve a later window. */
    swap(): void {
      mint = fresh();
    },
  };
}

/* --------------------- wire message validators -------------------- */

type WireMsg = { readonly t: string };

function isWireMsg(value: unknown): value is WireMsg {
  return isRecord(value) && isString(value['t'], 32);
}

function isPairMsg(
  value: unknown,
): value is { t: 'pair'; code: string } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['t', 'code']) &&
    value['t'] === 'pair' &&
    typeof value['code'] === 'string' &&
    PAIR_CODE_PATTERN.test(value['code'])
  );
}

function isResumeMsg(value: unknown): value is { t: 'resume' } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['t']) &&
    value['t'] === 'resume'
  );
}

/** Remote-IP the attempt budgets key on — IPv6-wrapped v4 unwrapped. */
export function normalizeSyncIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/* --------------------------- the driver ---------------------------- */

export type SyncResponderDeps<TRecord extends ResponderDeviceRecord> = {
  /**
   * The responder's cipher — a getter so a host may resolve identity
   * inside its own start() before the first session exists.
   */
  readonly crypto: () => SyncResponderCrypto;
  /** The wire-pump factory — desktop's attachWirePump fits the shape. */
  readonly attach: (opts: {
    socket: ResponderSocket;
    maxPayload: number;
    onFrame: (payload: Uint8Array) => void;
    onClose: (reason: WireCloseReason) => void;
  }) => SyncWirePump;
  /** This host's display name — the welcome's `name` field. */
  readonly name: string;
  /**
   * Hello validation — the shape-only shared guard on the phone, or a
   * stricter impl that loads the SPKI keys (desktop node:crypto).
   */
  readonly isHello: (value: unknown) => value is ClientHello;
  /** sha256(SPKI DER) hex of a peer's `dev` key — the custody key. */
  readonly fingerprintOf: (devPubB64: string) => string;
  readonly mintCode: () => string;
  readonly nowMs: () => number;
  readonly armTimer: (ms: number, fire: () => void) => ResponderTimer;
  /** Frame JSON decode — defaults to the shared UTF-8 decoder. */
  readonly decodeJson?: (payload: Uint8Array) => unknown;
  readonly custody: SyncResponderCustody<TRecord>;
  /**
   * Build the host's custody record — 'pair' claims `session.deviceId`,
   * 'resume' is pinned to the custody-named `registeredId`. Called
   * inside the pair lock / after the resume gate.
   */
  readonly buildPeer: (
    session: ResponderSession,
    kind: 'pair' | 'resume',
    now: number,
  ) => TRecord;
  /** The caller's own custody rows for a 'devices' reply. */
  readonly ownDeviceRows: (
    session: ResponderSession,
    signal: CancellationSignal,
  ) => Promise<ResponderRead<readonly ResponderDeviceRow[]>>;
  /** Extra fields merged into the welcome (host identity, pot, …). */
  readonly welcomeExtra?: (
    session: ResponderSession,
  ) => Readonly<Record<string, unknown>>;
  /**
   * The open-phase 'sync' surface — absent answers 'pair-only'
   * (a pure pair host); the desktop serves deltas here.
   */
  readonly onSync?: (
    session: ResponderSession,
    msg: WireMsg,
  ) => Promise<void> | void;
  /** After the pair welcome lands — custody has the record. */
  readonly onPair?: (
    session: ResponderSession,
    record: TRecord,
  ) => void;
  /** Post-enterOpen on a resume — ordering hook for sync kicks. */
  readonly onResume?: (
    session: ResponderSession,
    record: TRecord,
  ) => void;
  /** End of enterOpen — e.g. kicking stale same-fp sessions. */
  readonly afterOpen?: (session: ResponderSession) => void;
  /* Tuning knobs — the hosts' own defaults, not shared. */
  readonly codeTtlMs: number;
  readonly handshakeCap?: number | undefined;
  readonly sessionCap?: number | undefined;
  readonly maxConnections?: number | undefined;
  readonly handshakeMs?: number | undefined;
  readonly idleMs?: number | undefined;
  readonly maxCodeAttempts?: number | undefined;
  readonly maxTotalCodeAttempts?: number | undefined;
};

export interface SyncResponder {
  /** Feed a freshly-accepted socket — owns pump, timers, phases. */
  accept(socket: SyncSocket): void;
  /** Mint a pairing code and restart its attempt budgets. */
  mintOffer(): PairingState;
  /** Drop the pending mint — close/stop teardown. */
  expireOffer(): void;
  /** The live generation's sessions (status, kicks, broadcasts). */
  readonly sessions: ReadonlySet<ResponderSession>;
  /**
   * Sealed send — false when the pump refused the frame, so state
   * keyed on delivery (pending marks) never clears on a dead socket.
   */
  send(session: ResponderSession, msg: unknown): boolean;
  kill(session: ResponderSession): void;
  /**
   * stop()'s eager half: atomically swap the live session set and
   * remint — a socket accepted by a post-stop generation never lands
   * in the set a pending teardown kills. Returns the doomed sessions
   * for the caller to kill after its own awaits.
   */
  rotateGeneration(): readonly ResponderSession[];
  /** Terminal teardown — cancel, expire, kill every live session. */
  teardown(): void;
}

export function createSyncResponder<
  TRecord extends ResponderDeviceRecord,
>(deps: SyncResponderDeps<TRecord>): SyncResponder {
  const nowMs = deps.nowMs;
  const handshakeCap = deps.handshakeCap ?? HANDSHAKE_CAP;
  const sessionCap = deps.sessionCap ?? SESSION_CAP;
  const maxConnections = deps.maxConnections ?? 16;
  const handshakeMs = deps.handshakeMs ?? 15_000;
  const idleMs = deps.idleMs ?? 120_000;
  const decode = deps.decodeJson ?? decodeJson;

  const pairing = createPairingStore({
    nowMs,
    ttlMs: deps.codeTtlMs,
    mintCode: deps.mintCode,
    maxCodeAttempts: deps.maxCodeAttempts ?? 5,
    maxTotalCodeAttempts:
      deps.maxTotalCodeAttempts ?? (deps.maxCodeAttempts ?? 5) * 3,
  });

  // The pair path's peek → put → consume is one logical transaction:
  // serialized here so a losing session sees the consumed code at
  // peek — never writes its key into custody at all. (Custody
  // serializes too, but a consume lost AFTER a write can't unwrite
  // the sibling's record without a rollback that could hit a legit
  // same-fp record.)
  let pairChain: Promise<unknown> = Promise.resolve();
  function withPairLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = pairChain.then(fn);
    pairChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // `sessions` is swapped wholesale on rotateGeneration — a socket
  // accepted by a post-stop generation never lands in the set a
  // pending teardown is killing.
  let sessions = new Set<ResponderSession>();
  // Custody ops bind to the responder's whole lifetime — cancelled
  // only at teardown, so an in-flight write inside a stop() window
  // still completes (the caller's drainWrites relies on that).
  const custodySignal = new CancellationSource();

  /* ------------------------ session plumbing ----------------------- */

  function sendSealed(session: ResponderSession, msg: unknown): boolean {
    const codec = session.codec;
    if (codec === null) {
      return false;
    }
    const plain = encodeJson(msg);
    if (plain.length + SEAL_OVERHEAD > session.pump.maxPayload) {
      // Never silently drop a response: a document that fits the
      // contract but overflows the sealed frame gets a typed error
      // instead — and the codec seals that (small) reply, so the
      // sequence stays contiguous for the peer.
      const errPayload = encodeJson({ t: 'error', code: 'too-large' });
      return session.pump.send(codec.seal(errPayload));
    }
    return session.pump.send(codec.seal(plain));
  }

  function cleanupSession(session: ResponderSession): void {
    session.handshakeTimer?.cancel();
    session.handshakeTimer = null;
    session.idleTimer?.cancel();
    session.idleTimer = null;
    session.cancel.cancel();
  }

  function dropSession(session: ResponderSession): void {
    if (!sessions.delete(session)) {
      return;
    }
    cleanupSession(session);
  }

  function killSession(session: ResponderSession): void {
    // Cleanup isn't gated on the LIVE set: rotateGeneration() moves
    // doomed sessions out before teardown kills them, and their
    // timers/cancellation must still run (pump.close is idempotent).
    sessions.delete(session);
    cleanupSession(session);
    session.pump.close();
  }

  function resetIdle(session: ResponderSession): void {
    session.idleTimer?.cancel();
    session.idleTimer = deps.armTimer(idleMs, () =>
      killSession(session),
    );
  }

  function sendWelcome(
    session: ResponderSession,
    record: TRecord,
  ): void {
    sendSealed(session, {
      t: 'welcome',
      device: {
        // Only the wire contract's fields cross — a host record may
        // carry extras (endpoints) that stay local.
        id: record.id,
        name: record.name,
        pub: record.pub,
        fp: record.fp,
        pairedAt: record.pairedAt,
        lastSeenAt: record.lastSeenAt,
      },
      name: deps.name,
      ...deps.welcomeExtra?.(session),
    });
  }

  /* ----------------------------- hello ----------------------------- */

  async function onHello(
    session: ResponderSession,
    payload: Uint8Array,
  ): Promise<void> {
    // Advance the phase BEFORE the first await: a second hello frame
    // while custody lookup/DH is in flight would otherwise re-run
    // this body concurrently and overwrite codec + peer identity.
    // Now the stray frame routes to onAuthFrame, which kills on a
    // null codec.
    session.phase = 'auth';
    let msg: unknown;
    try {
      msg = decode(payload);
    } catch {
      killSession(session);
      return;
    }
    if (!deps.isHello(msg)) {
      killSession(session);
      return;
    }
    const devFp = deps.fingerprintOf(msg.dev);
    const found = await deps.custody.find(devFp, custodySignal.signal);
    if (!found.ok) {
      killSession(session);
      return;
    }
    const prior = found.value;
    let accepted;
    try {
      accepted = deps
        .crypto()
        .accept(msg, { registered: prior !== null });
    } catch {
      killSession(session);
      return;
    }
    session.deviceId = msg.deviceId;
    session.devFp = accepted.peer.devFp;
    session.devPub = accepted.peer.devPub;
    session.name = accepted.peer.name;
    session.callerPort = msg.port ?? null;
    session.advertisedEndpoints = msg.endpoints ?? [];
    session.registered = prior !== null;
    // Custody — never the wire — names a resumed device. Rows from
    // before deviceId custody stay id-less (''), paired by fp alone;
    // claiming a different id under an old key fills nothing (touch
    // only writes a non-empty id).
    session.registeredId = prior === null ? null : prior.id;
    session.pairedAtMs = prior?.pairedAt ?? null;
    session.codec = accepted.codec;
    session.pump.upgrade(sessionCap);
    session.pump.send(accepted.challenge);
  }

  /* ----------------------------- auth ------------------------------ */

  async function onAuthFrame(
    session: ResponderSession,
    payload: Uint8Array,
  ): Promise<void> {
    const codec = session.codec;
    if (codec === null || session.deviceId === null) {
      killSession(session);
      return;
    }
    let msg: unknown;
    try {
      msg = decode(codec.open(payload));
    } catch {
      killSession(session);
      return;
    }
    const reject = (reason: string): void => {
      sendSealed(session, { t: 'reject', reason });
      // Flush the reject frame before the socket dies — destroy()
      // would discard queued output and leave the peer at a mute EOF.
      // killSession stays the path where no reply is owed.
      session.pump.end();
    };
    const now = nowMs();
    if (isPairMsg(msg)) {
      type Outcome =
        | { readonly ok: true; readonly record: TRecord }
        | { readonly ok: false; readonly reason: string };
      const outcome = await withPairLock(async (): Promise<Outcome> => {
        // A peer that already blew its code budget never reaches the
        // checker — a correct guess after the cap can't quietly pair.
        if (pairing.locked(session.remoteIp)) {
          return { ok: false, reason: 'pairing-attempts' };
        }
        const check = pairing.peek(msg.code);
        if (check === 'bad-code') {
          const locked = pairing.recordMiss(session.remoteIp);
          return {
            ok: false,
            reason: locked ? 'pairing-attempts' : 'bad-code',
          };
        }
        if (check !== 'ok') {
          return { ok: false, reason: check };
        }
        // Consume BEFORE the durable write closes the mint window: a
        // code consumed while its custody write is in flight can't
        // also be claimed by a second session racing in. A failed
        // write restores the taken state — the code stays pending so
        // the same retry still pairs, unless a fresh mint already
        // replaced the window.
        const taken = pairing.consume(msg.code);
        if (taken === null) {
          // Defensive: inside the lock a peek-ok always consumes —
          // this can only mean state was cleared out-of-band.
          return { ok: false, reason: 'no-pairing' };
        }
        const record = deps.buildPeer(session, 'pair', now);
        // A stop() swapped the sessions set — a session not in the
        // live set belongs to a dead generation; its custody write
        // must not start outside the window.
        if (!sessions.has(session)) {
          return { ok: false, reason: 'unavailable' };
        }
        const put = await deps.custody.put(
          record,
          custodySignal.signal,
        );
        if (!put.ok) {
          pairing.restore(taken);
          return { ok: false, reason: put.reason };
        }
        pairing.clearIp(session.remoteIp);
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
      deps.onPair?.(session, outcome.record);
      enterOpen(session);
      return;
    }
    if (isResumeMsg(msg)) {
      // Custody — not the claimed id — names a resumed device; a
      // paired key presenting a foreign deviceId cannot take its slot.
      if (
        !session.registered ||
        session.registeredId === null ||
        session.devFp === null
      ) {
        reject('unpaired');
        return;
      }
      session.deviceId = session.registeredId;
      const record = deps.buildPeer(session, 'resume', now);
      if (!sessions.has(session)) {
        // Stop-window rejections must not masquerade as 'unpaired' —
        // the caller would delete custody we still hold.
        reject('unavailable');
        return;
      }
      const touched = await deps.custody.touch(
        record,
        custodySignal.signal,
      );
      if (!touched.ok) {
        // A custody read/write hiccup isn't a verdict: 'unpaired'
        // would have the caller erase a record we may still hold.
        reject('unavailable');
        return;
      }
      if (!touched.updated) {
        reject('unpaired');
        return;
      }
      if (!sessions.has(session)) {
        return;
      }
      sendWelcome(session, record);
      enterOpen(session);
      // After the welcome lands — the hook may kick a sync round
      // that itself dials out; keeping it post-enterOpen keeps
      // ordering sane.
      deps.onResume?.(session, record);
      return;
    }
    reject('bad-auth');
  }

  /* ----------------------------- open ------------------------------ */

  function enterOpen(session: ResponderSession): void {
    session.phase = 'open';
    session.handshakeTimer?.cancel();
    session.handshakeTimer = null;
    resetIdle(session);
    deps.afterOpen?.(session);
  }

  function onOpenFrame(
    session: ResponderSession,
    payload: Uint8Array,
  ): void {
    resetIdle(session);
    session.ops = session.ops.then(() => onOpenMsg(session, payload));
  }

  async function onOpenMsg(
    session: ResponderSession,
    payload: Uint8Array,
  ): Promise<void> {
    const codec = session.codec;
    if (codec === null || session.pump.closed) {
      return;
    }
    let msg: unknown;
    try {
      msg = decode(codec.open(payload));
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
        // Only the caller's own rows ever cross — no custody dump.
        const rows = await deps.ownDeviceRows(
          session,
          custodySignal.signal,
        );
        if (!rows.ok) {
          sendSealed(session, { t: 'error', code: 'unavailable' });
          return;
        }
        sendSealed(session, { t: 'devices', devices: rows.value });
        return;
      }
      case 'sync': {
        if (deps.onSync === undefined) {
          sendSealed(session, { t: 'error', code: 'pair-only' });
          return;
        }
        await deps.onSync(session, msg);
        return;
      }
      case 'bye':
        killSession(session);
        return;
      default:
        sendSealed(session, { t: 'error', code: 'bad-request' });
    }
  }

  /* ---------------------------- accept ----------------------------- */

  return {
    accept(socket) {
      if (sessions.size >= maxConnections) {
        socket.destroy();
        return;
      }
      const session: ResponderSession = {
        pump: deps.attach({
          // SyncSocket and WireSocketLike disagree on the error
          // listener's param annotation in both directions; the
          // ResponderSocket shape is the common ground the pump
          // actually needs (it only ever attaches listeners).
          socket: socket as ResponderSocket,
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
        advertisedEndpoints: [],
        handshakeTimer: null,
        idleTimer: null,
        ops: Promise.resolve(),
      };
      // A socket that never finishes pairing dies instead of idling
      // in the handshake phase forever.
      session.handshakeTimer = deps.armTimer(handshakeMs, () =>
        killSession(session),
      );
      sessions.add(session);
    },
    mintOffer() {
      return pairing.offer();
    },
    expireOffer() {
      pairing.expire();
    },
    get sessions() {
      return sessions;
    },
    send: sendSealed,
    kill: killSession,
    rotateGeneration() {
      const doomed = [...sessions];
      sessions = new Set();
      pairing.swap();
      return doomed;
    },
    teardown() {
      custodySignal.cancel();
      pairing.expire();
      for (const session of [...sessions]) {
        killSession(session);
      }
      sessions.clear();
    },
  };
}
