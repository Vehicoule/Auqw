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
import type { ClockPort } from '../ports/clock.ts';
import type { LogPort } from '../ports/log.ts';
import type { IdPort } from '../ports/runtime.ts';
import type {
  SyncClientCrypto,
  SyncClientKeys,
  SyncFrameCodec,
  SyncPeer,
  SyncSocket,
  SyncSocketPort,
} from '../ports/sync-transport.ts';
import {
  isSyncDelta,
  type ApplyResult,
  type SyncCursor,
  type SyncDelta,
  type SyncEngine,
} from './sync-engine.ts';
import {
  attachSyncPump,
  cursorToSince,
  decodeJson,
  encodeJson,
  isDeltaMsg,
  isDevicesMsg,
  isErrorMsg,
  isPairingPayload,
  isPongMsg,
  isRejectMsg,
  isServerChallenge,
  isServerMsg,
  isSyncRequestMsg,
  isWelcomeMsg,
  parseEndpoint,
  wireErrorCode,
  wireRejectReason,
  DEVICE_ID_PATTERN,
  HANDSHAKE_CAP,
  MAX_SYNC_DOC_BYTES,
  PAIR_CODE_PATTERN,
  SEAL_OVERHEAD,
  SESSION_CAP,
  type DeltaMsg,
  type DevicesMsg,
  type ErrorMsg,
  type RejectMsg,
  type ServerMsg,
  type SyncDeviceSummary,
  type SyncEndpoint,
  type SyncWirePump,
  type WelcomeMsg,
} from './sync-wire.ts';

/**
 * The phone half of LAN sync (docs/specs/sync.md, slice 4): dials a
 * paired — or pairing — desktop, runs the noise-v1 handshake, and
 * drives deltas through the engine.
 *
 * Ordering rules that mirror the server:
 *  - One request in flight per session — the `session.ops` chain.
 *  - A dead socket settles every pending waiter immediately — nothing
 *    downstream wedges on a mute peer (per-request timeouts are the
 *    backstop for a silent-but-open one).
 *  - `peerCursor` custody rides each round: it is the desktop's
 *    watermark map as reported by its delta, so a crash between
 *    rounds resends (applyDelta dedupes) — never loses entries.
 */
export interface SyncClient {
  /** Custody-derived peers merged with live session state. */
  status(): SyncClientStatus;
  subscribe(listener: (status: SyncClientStatus) => void): () => void;
  /** The custody records — source of truth for the device list. */
  peers(signal?: CancellationSignal): Promise<Result<readonly SyncPeer[]>>;
  /**
   * QR payload or typed-code path — one minted pairing attempt. For
   * the typed path the fingerprint is learned TOFU from the challenge
   * (the 6-digit code is the auth secret; the server rate-limits it).
   */
  pair(
    opts:
      | { readonly payload: string }
      | {
          readonly code: string;
          readonly endpoints: readonly string[];
        },
    signal?: CancellationSignal,
  ): Promise<Result<SyncPeer>>;
  /** One convergence round against a paired desktop. */
  syncNow(
    fp: string,
    signal?: CancellationSignal,
  ): Promise<Result<SyncRoundOutcome>>;
  /** The desktop's view of this device (its `devices` reply). */
  refreshPeer(
    fp: string,
    signal?: CancellationSignal,
  ): Promise<Result<SyncDeviceSummary | null>>;
  /**
   * Local unpair — drops the peer record and says `bye` if a session
   * is live. Sync history is untouched; the desktop's own unpair path
   * owns its side.
   */
  unpair(fp: string, signal?: CancellationSignal): Promise<Result<void>>;
  close(): Promise<void>;
}

export type SyncPeerState = 'offline' | 'connecting' | 'open';

export type SyncPeerView = {
  readonly peer: SyncPeer;
  readonly state: SyncPeerState;
  readonly syncing: boolean;
  readonly lastError?: AppError;
};

export type SyncClientStatus = {
  readonly deviceId: string;
  readonly peers: readonly SyncPeerView[];
};

export type SyncRoundOutcome = {
  readonly peerFp: string;
  /** Delta entries received from the desktop across the round. */
  readonly remoteEntries: number;
  /** Delta entries exported to the desktop across the round. */
  readonly sentEntries: number;
  /** Divergence rows produced while merging. */
  readonly divergence: number;
  readonly rounds: number;
};

export type SyncClientDeps = {
  readonly sockets: SyncSocketPort;
  readonly crypto: SyncClientCrypto;
  readonly keys: SyncClientKeys;
  readonly engine: SyncEngine;
  readonly ids: IdPort;
  readonly clock: ClockPort;
  readonly log: LogPort;
  /** Wire identity — must equal `engine.deviceId`. */
  readonly deviceId: string;
  readonly name?: string;
  readonly connectMs?: number;
  readonly handshakeMs?: number;
  readonly requestMs?: number;
  /** Keepalive cadence — under the server's 120s idle kill. */
  readonly pingMs?: number;
};

type SessionPhase = 'challenge' | 'auth' | 'open';

type PendingWaiter = {
  readonly accepts: (msg: unknown) => boolean;
  readonly done: (result: Result<unknown>) => void;
};

type ClientSession = {
  /** The pinned server fingerprint — custody key for the peer. */
  peerFp: string;
  readonly socket: SyncSocket;
  readonly pump: SyncWirePump;
  /** Engine/cancel boundary — teardown cancels in-flight merges. */
  readonly cancel: CancellationSource;
  phase: SessionPhase;
  codec: SyncFrameCodec | null;
  pending: PendingWaiter | null;
  ops: Promise<void>;
  closed: boolean;
  /** A server `sync-request` arrived since the last drain. */
  kickPending: boolean;
  /** A kick round is already queued on ops. */
  kickQueued: boolean;
  activeOps: number;
};

type PeerView = {
  readonly state: SyncPeerState;
  readonly lastError?: AppError;
};

/** Pages per sync round — each page is one `sync` request/response. */
const MAX_SYNC_PAGES = 64;
/** Entry bound the export refit starts from — the engine's wire cap. */
const MAX_EXPORT_PAGE = 10_000;

/**
 * Mint-or-load the phone's sync identity — the deviceId the wire
 * hello claims AND the one every engine entry stamps. Resolved before
 * engine construction so both share one id.
 */
export async function ensureSyncIdentity(opts: {
  keys: SyncClientKeys;
  /** Only keygen is needed — a suite's mint is stateless. */
  crypto: Pick<SyncClientCrypto, 'createIdentity'>;
  ids: IdPort;
  signal?: CancellationSignal;
}): Promise<Result<{ deviceId: string; identity: ReturnType<SyncClientCrypto['createIdentity']> }>> {
  const existing = await opts.keys.identityGet(opts.signal);
  if (!existing.ok) {
    return existing;
  }
  if (existing.value !== null) {
    return ok(existing.value);
  }
  const deviceId = opts.ids.next('phone');
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return err(
      appError('internal', 'sync: minted deviceId fails the wire pattern'),
    );
  }
  const record = { deviceId, identity: opts.crypto.createIdentity() };
  const written = await opts.keys.identitySet(record, opts.signal);
  if (!written.ok) {
    return written;
  }
  return ok(record);
}

export function createSyncClient(deps: SyncClientDeps): SyncClient {
  if (deps.engine.deviceId !== deps.deviceId) {
    throw new TypeError(
      'sync client: engine.deviceId must equal the wire deviceId',
    );
  }
  if (!DEVICE_ID_PATTERN.test(deps.deviceId)) {
    throw new TypeError('sync client: deviceId fails the wire pattern');
  }
  const connectMs = deps.connectMs ?? 5_000;
  const handshakeMs = deps.handshakeMs ?? 15_000;
  const requestMs = deps.requestMs ?? 15_000;
  const pingMs = deps.pingMs ?? 45_000;
  const name = deps.name ?? 'auqw-phone';

  const peers = new Map<string, SyncPeer>();
  const views = new Map<string, PeerView>();
  const sessions = new Map<string, ClientSession>();
  /** In-flight dials keyed by fp — concurrent syncNow shares one. */
  const connecting = new Map<
    string,
    Promise<Result<{ session: ClientSession; welcome: WelcomeMsg }>>
  >();
  const listeners = new Set<(status: SyncClientStatus) => void>();
  let peersLoaded = false;
  let closing = false;

  function snapshot(): SyncClientStatus {
    return {
      deviceId: deps.deviceId,
      peers: [...peers.values()].map((peer) => {
        const view = views.get(peer.fp);
        const session = sessions.get(peer.fp);
        return {
          peer,
          state: view?.state ?? 'offline',
          syncing: session !== undefined && session.activeOps > 0,
          ...(view?.lastError !== undefined
            ? { lastError: view.lastError }
            : {}),
        };
      }),
    };
  }

  function emit(): void {
    const status = snapshot();
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        // A throwing subscriber must not break fan-out.
      }
    }
  }

  function setView(fp: string, view: PeerView): void {
    views.set(fp, view);
    emit();
  }

  /* --------------------------- lifecycle --------------------------- */

  async function loadPeers(
    signal?: CancellationSignal,
  ): Promise<Result<void>> {
    if (peersLoaded) {
      return ok(undefined);
    }
    const listed = await deps.keys.peerList(signal);
    if (!listed.ok) {
      return listed;
    }
    for (const peer of listed.value) {
      peers.set(peer.fp, peer);
    }
    peersLoaded = true;
    // Custody hydration changes what status() reports — subscribers
    // learn about restored pairings without waiting for an op.
    emit();
    return ok(undefined);
  }

  function settlePending(session: ClientSession, error: AppError): void {
    const pending = session.pending;
    session.pending = null;
    pending?.done(err(error));
  }

  function killSession(
    session: ClientSession,
    cause: AppError | null,
  ): void {
    if (session.closed) {
      return;
    }
    session.closed = true;
    // Settle the in-flight request with the real cause BEFORE cancels
    // fire — otherwise its signal subscriber resolves it 'cancelled'.
    settlePending(
      session,
      cause ?? appError('transient', 'sync: connection lost'),
    );
    session.cancel.cancel();
    session.pump.close();
    if (sessions.get(session.peerFp) === session) {
      sessions.delete(session.peerFp);
    }
    const view = views.get(session.peerFp);
    if (view !== undefined && view.state !== 'offline') {
      setView(session.peerFp, {
        state: 'offline',
        ...(cause !== null ? { lastError: cause } : {}),
      });
    }
  }

  /* ------------------------------ io ------------------------------ */

  function sendSealed(session: ClientSession, msg: unknown): boolean {
    const codec = session.codec;
    if (codec === null || session.closed) {
      return false;
    }
    const plain = encodeJson(msg);
    if (plain.length + SEAL_OVERHEAD > session.pump.maxPayload) {
      return false;
    }
    try {
      return session.pump.send(codec.seal(plain));
    } catch {
      return false;
    }
  }

  function routeFrame(session: ClientSession, payload: Uint8Array): void {
    if (session.closed) {
      return;
    }
    if (session.phase === 'challenge') {
      // The challenge is the only legal plaintext frame.
      let msg: unknown;
      try {
        msg = decodeJson(payload);
      } catch {
        killSession(
          session,
          appError('invalid-response', 'sync: malformed challenge'),
        );
        return;
      }
      const pending = session.pending;
      if (pending === null || !isServerChallenge(msg)) {
        killSession(
          session,
          appError('invalid-response', 'sync: unexpected challenge frame'),
        );
        return;
      }
      session.pending = null;
      pending.done(ok(msg));
      return;
    }
    const codec = session.codec;
    if (codec === null) {
      killSession(
        session,
        appError('invalid-response', 'sync: frame before codec'),
      );
      return;
    }
    let msg: unknown;
    try {
      msg = decodeJson(codec.open(payload));
    } catch {
      // Bad seal or bad JSON — tamper or desync; the peer is dead.
      killSession(
        session,
        appError('invalid-response', 'sync: sealed frame failed to open'),
      );
      return;
    }
    if (!isServerMsg(msg)) {
      killSession(
        session,
        appError('invalid-response', 'sync: malformed server message'),
      );
      return;
    }
    if (isSyncRequestMsg(msg)) {
      session.kickPending = true;
      drainKick(session);
      return;
    }
    const pending = session.pending;
    if (pending !== null && pending.accepts(msg)) {
      session.pending = null;
      pending.done(ok(msg));
      return;
    }
    // Unsolicited replies (a pong after its timeout, a stray delta)
    // are dropped — the request already settled.
    void deps.log.write({
      level: 'debug',
      message: `sync: unsolicited ${msg.t} from ${session.peerFp.slice(0, 12)}`,
      atMs: deps.clock.nowMs(),
    });
  }

  /**
   * One request → one reply. Serialized by the caller (the ops chain),
   * so `session.pending` is always free here. Settles on the reply,
   * the caller's cancel, the reply deadline, or session death —
   * whichever lands first.
   */
  function sessionRequest<T>(
    session: ClientSession,
    msg: unknown,
    accepts: (m: unknown) => m is T,
    ms: number,
    signal?: CancellationSignal,
  ): Promise<Result<T>> {
    return new Promise<Result<T>>((resolve) => {
      let settled = false;
      let unsubscribe: () => void = () => {};
      const finish = (result: Result<T>): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (session.pending?.done === finish) {
          session.pending = null;
        }
        unsubscribe();
        resolve(result);
      };
      if (session.closed || session.pending !== null) {
        finish(err(appError('internal', 'sync: request slot busy')));
        return;
      }
      session.pending = { accepts, done: finish as PendingWaiter['done'] };
      // The wire carries no request id — a late reply to a timed-out
      // or cancelled request would complete whatever request a retry
      // parked next. Cancel/timeout/send-fail therefore kill the
      // session too; the next op redials clean. The caller still
      // gets the original error.
      unsubscribe =
        signal?.subscribe(() => {
          if (settled) {
            return;
          }
          const failure = appError('cancelled', 'cancelled');
          finish(err(failure));
          killSession(session, failure);
        }) ?? (() => {});
      void deps.clock.sleep(ms, session.cancel.signal).then((slept) => {
        // The sleeper outlives a settled waiter — only kill when this
        // request is actually the one timing out.
        if (!slept.ok || settled) {
          return;
        }
        const failure = appError('timeout', 'sync: reply deadline passed');
        finish(err(failure));
        killSession(session, failure);
      });
      const sent =
        session.codec === null
          ? session.pump.send(encodeJson(msg))
          : sendSealed(session, msg);
      if (!sent && !settled) {
        const failure = appError('transient', 'sync: send failed — socket dead');
        finish(err(failure));
        killSession(session, failure);
      }
    });
  }

  /** Serialized op runner — one caller at a time per session. */
  function enqueue<T>(
    session: ClientSession,
    op: () => Promise<T>,
  ): Promise<T> {
    const run = session.ops.then(op);
    session.ops = run.then(
      () => undefined,
      () => undefined,
    );
    session.activeOps += 1;
    emit();
    const done = run.finally(() => {
      session.activeOps -= 1;
      if (session.kickPending && session.activeOps === 0) {
        drainKick(session);
      }
      emit();
    });
    return done;
  }

  /* ------------------------- connect/auth ------------------------- */

  async function dial(
    endpoints: readonly SyncEndpoint[],
    signal?: CancellationSignal,
  ): Promise<Result<SyncSocket>> {
    let lastError: AppError = appError(
      'unavailable',
      'sync: no usable endpoints',
    );
    for (const ep of endpoints) {
      if (signal?.cancelled || closing) {
        return err(appError('cancelled', 'cancelled'));
      }
      const connected = await deps.sockets.connect({
        host: ep.host,
        port: ep.port,
        timeoutMs: connectMs,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (connected.ok) {
        return connected;
      }
      lastError = connected.error;
    }
    return err(lastError);
  }

  /**
   * dial → hello → challenge → sealed auth → welcome. `code` present
   * means the pair path; absent means resume (custody pins `fp`).
   */
  async function openSession(opts: {
    endpoints: readonly string[];
    code?: string;
    pinnedFp?: string;
    signal?: CancellationSignal;
  }): Promise<Result<{ session: ClientSession; welcome: WelcomeMsg }>> {
    const parsed: SyncEndpoint[] = [];
    for (const raw of opts.endpoints) {
      const ep = parseEndpoint(raw);
      if (ep !== null) {
        parsed.push(ep);
      }
    }
    if (parsed.length === 0) {
      return err(
        appError('invalid-message', 'sync: no usable endpoint in pair spec'),
      );
    }
    const socket = await dial(parsed, opts.signal);
    if (!socket.ok) {
      return socket;
    }
    const handshake = deps.crypto.begin({ deviceId: deps.deviceId, name });
    const session: ClientSession = {
      peerFp: opts.pinnedFp ?? '',
      socket: socket.value,
      pump: attachSyncPump({
        socket: socket.value,
        maxPayload: HANDSHAKE_CAP,
        onFrame: (payload) => routeFrame(session, payload),
        onClose: (reason) =>
          killSession(
            session,
            reason === 'oversize'
              ? appError('invalid-response', 'sync: oversize frame')
              : reason === 'error'
                ? appError('transient', 'sync: socket error')
                : null,
          ),
      }),
      cancel: new CancellationSource(),
      phase: 'challenge',
      codec: null,
      pending: null,
      ops: Promise.resolve(),
      closed: false,
      kickPending: false,
      kickQueued: false,
      activeOps: 0,
    };
    const challenged = await sessionRequest(
      session,
      handshake.hello(),
      isServerChallenge,
      handshakeMs,
      opts.signal,
    );
    if (!challenged.ok) {
      killSession(session, challenged.error);
      return err(challenged.error);
    }
    const completed = handshake.complete(challenged.value, {
      ...(opts.pinnedFp !== undefined ? { pinnedFp: opts.pinnedFp } : {}),
    });
    if (!completed.ok) {
      killSession(session, completed.error);
      return completed;
    }
    session.codec = completed.value.codec;
    session.peerFp = completed.value.serverFp;
    session.phase = 'auth';
    session.pump.upgrade(SESSION_CAP);
    // code present → pair (re-pair refreshes the record); absent →
    // resume. `registered` is advisory — the server decides for real.
    const auth =
      opts.code !== undefined
        ? { t: 'pair', code: opts.code }
        : { t: 'resume' };
    const replied = await sessionRequest(
      session,
      auth,
      (m): m is WelcomeMsg | RejectMsg | ErrorMsg =>
        isWelcomeMsg(m) || isRejectMsg(m) || isErrorMsg(m),
      handshakeMs,
      opts.signal,
    );
    if (!replied.ok) {
      killSession(session, replied.error);
      return err(replied.error);
    }
    if (isRejectMsg(replied.value)) {
      const failure = wireRejectReason(replied.value.reason);
      killSession(session, failure);
      return err(failure);
    }
    if (isErrorMsg(replied.value)) {
      const failure = wireErrorCode(replied.value.code);
      killSession(session, failure);
      return err(failure);
    }
    session.phase = 'open';
    keepalive(session);
    return ok({ session, welcome: replied.value });
  }

  /* --------------------------- keepalive --------------------------- */

  function keepalive(session: ClientSession): void {
    void (async () => {
      while (!session.closed) {
        const slept = await deps.clock.sleep(pingMs, session.cancel.signal);
        if (!slept.ok || session.closed) {
          return;
        }
        const pong = await enqueue(session, () =>
          sessionRequest(session, { t: 'ping' }, isPongMsg, requestMs),
        );
        if (!pong.ok && !session.closed) {
          killSession(
            session,
            appError('transient', 'sync: keepalive failed'),
          );
          return;
        }
      }
    })();
  }

  /* ---------------------------- the round -------------------------- */

  function drainKick(session: ClientSession): void {
    if (
      !session.kickPending ||
      session.closed ||
      session.activeOps > 0 ||
      session.kickQueued
    ) {
      return;
    }
    session.kickQueued = true;
    void enqueue(session, async () => {
      session.kickQueued = false;
      session.kickPending = false;
      const peer = peers.get(session.peerFp);
      if (peer === undefined || session.closed) {
        return;
      }
      const outcome = await syncRound(session, peer);
      if (!outcome.ok) {
        void deps.log.write({
          level: 'warn',
          message: `sync-requested round failed: ${outcome.error.kind}`,
          atMs: deps.clock.nowMs(),
        });
      }
    });
  }

  async function syncRound(
    session: ClientSession,
    peer: SyncPeer,
    signal?: CancellationSignal,
  ): Promise<Result<SyncRoundOutcome>> {
    // Caller cancellation flows into engine ops too — a walked-away
    // syncNow must not leave merge work running.
    const joined = new CancellationSource();
    const unsubs: (() => void)[] = [
      signal?.subscribe(() => joined.cancel()) ?? (() => {}),
      session.cancel.signal.subscribe(() => joined.cancel()),
    ];
    const cleanup = (): void => {
      for (const unsub of unsubs) {
        unsub();
      }
    };
    let remoteEntries = 0;
    let sentEntries = 0;
    let divergence = 0;
    let rounds = 0;
    let converged = false;
    let current: SyncPeer = peer;
    try {
      for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
        if (joined.signal.cancelled) {
          return err(appError('cancelled', 'cancelled'));
        }
        rounds += 1;
        const fitted = await exportFittedPage(
          session,
          current.peerCursor,
          joined.signal,
        );
        if (!fitted.ok) {
          return fitted;
        }
        const own = fitted.value.delta;
        const reply = await sessionRequest(
          session,
          fitted.value.msg,
          (m): m is DeltaMsg | ErrorMsg => isDeltaMsg(m) || isErrorMsg(m),
          requestMs,
          joined.signal,
        );
        if (!reply.ok) {
          return reply;
        }
        if (isErrorMsg(reply.value)) {
          return err(wireErrorCode(reply.value.code));
        }
        const delta = reply.value.delta;
        if (!isSyncDelta(delta)) {
          killSession(
            session,
            appError('invalid-response', 'sync: malformed delta'),
          );
          return err(
            appError('invalid-response', 'sync: malformed delta'),
          );
        }
        const applied: Result<ApplyResult> = await deps.engine.applyDelta(
          delta,
          joined.signal,
        );
        if (!applied.ok) {
          return applied;
        }
        remoteEntries += applied.value.entries.length;
        divergence += applied.value.divergence.length;
        sentEntries += own.entries.length;
        current = {
          ...current,
          peerCursor: delta.cursor,
          lastSeenAt: deps.clock.nowMs(),
          lastSyncAt: deps.clock.nowMs(),
        };
        peers.set(current.fp, current);
        const persisted = await deps.keys.peerPut(current, joined.signal);
        if (!persisted.ok) {
          return persisted;
        }
        converged = !own.more && !delta.more;
        const progressed = own.entries.length > 0 || delta.entries.length > 0;
        if (converged || !progressed) {
          break;
        }
      }
      if (!converged) {
        // The page budget or a stall left advertised work undone — a
        // converged-looking ok would hide a resolvable backlog.
        return err(
          appError(
            'budget-exceeded',
            'sync: round incomplete — entries remain after the page budget',
          ),
        );
      }
      return ok({
        peerFp: session.peerFp,
        remoteEntries,
        sentEntries,
        divergence,
        rounds,
      });
    } finally {
      cleanup();
      emit();
    }
  }

  /**
   * Engine pages by entry count; the wire caps serialized bytes —
   * halve the page until the delta doc fits MAX_SYNC_DOC_BYTES and
   * the sealed request frame fits the session bound, so a large log
   * can never emit a payload the receiver rejects (which would
   * strand the cursor forever). `more` stays honest: the engine sets
   * it against the applied limit. Mirrors the desktop adapter's
   * refit (apps/desktop/src/utility/sync-engine.ts).
   */
  async function exportFittedPage(
    session: ClientSession,
    cursor: SyncCursor,
    signal: CancellationSignal,
  ): Promise<
    Result<{ delta: SyncDelta; msg: Record<string, unknown> }>
  > {
    let limit = MAX_EXPORT_PAGE;
    for (;;) {
      const own = await deps.engine.exportDelta(cursor, limit, signal);
      if (!own.ok) {
        return own;
      }
      const msg: Record<string, unknown> = {
        t: 'sync',
        since: cursorToSince(deps.engine.cursor()),
      };
      if (own.value.entries.length > 0 || own.value.more) {
        msg['delta'] = own.value;
      }
      // Two caps both bind: the receiver validates the nested delta
      // doc against MAX_SYNC_DOC_BYTES, and the sealed frame must fit
      // the session payload bound. A delta in the gap between them
      // ships fine and dies server-side — so both gates must pass.
      if (
        encodeJson(own.value).length <= MAX_SYNC_DOC_BYTES &&
        encodeJson(msg).length + SEAL_OVERHEAD <= session.pump.maxPayload
      ) {
        return ok({ delta: own.value, msg });
      }
      if (limit === 1) {
        return err(
          appError(
            'invalid-response',
            'sync: single delta entry exceeds the wire bound',
          ),
        );
      }
      limit = Math.max(1, Math.floor(limit / 2));
    }
  }

  /* --------------------------- public ops -------------------------- */

  async function pairOp(
    endpoints: readonly string[],
    code: string,
    pinnedFp: string | undefined,
    pot: string | undefined,
    signal?: CancellationSignal,
  ): Promise<Result<SyncPeer>> {
    const opened = await openSession({
      endpoints,
      code,
      ...(pinnedFp !== undefined ? { pinnedFp } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!opened.ok) {
      return err(opened.error);
    }
    const { session, welcome } = opened.value;
    const stored: SyncPeer = {
      fp: session.peerFp,
      name: welcome.name,
      endpoints: endpoints.filter((ep) => parseEndpoint(ep) !== null),
      pairedAt: welcome.device.pairedAt,
      lastSeenAt: deps.clock.nowMs(),
      peerCursor: {},
      ...(pot !== undefined ? { pot } : {}),
    };
    const prior = sessions.get(stored.fp);
    if (prior !== undefined && prior !== session) {
      killSession(prior, appError('superseded', 'sync: re-paired'));
    }
    sessions.set(stored.fp, session);
    peers.set(stored.fp, stored);
    const persisted = await deps.keys.peerPut(stored, signal);
    if (!persisted.ok) {
      peers.delete(stored.fp);
      sessions.delete(stored.fp);
      killSession(session, persisted.error);
      return persisted;
    }
    setView(stored.fp, { state: 'open' });
    emit();
    return ok(stored);
  }

  return {
    status: snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async peers(signal) {
      const loaded = await loadPeers(signal);
      if (!loaded.ok) {
        return loaded;
      }
      return ok([...peers.values()]);
    },

    async pair(opts, signal) {
      if (closing) {
        return err(appError('released', 'sync: client closed'));
      }
      const loaded = await loadPeers(signal);
      if (!loaded.ok) {
        return loaded;
      }
      if ('payload' in opts) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(opts.payload);
        } catch {
          return err(
            appError('invalid-message', 'sync: pairing payload is not JSON'),
          );
        }
        if (!isPairingPayload(decoded)) {
          return err(
            appError('invalid-message', 'sync: malformed pairing payload'),
          );
        }
        const endpoints =
          decoded.endpoints !== undefined && decoded.endpoints.length > 0
            ? decoded.endpoints
            : [decoded.endpoint];
        return pairOp(
          endpoints,
          decoded.code,
          decoded.fp,
          decoded.pot,
          signal,
        );
      }
      if (!PAIR_CODE_PATTERN.test(opts.code)) {
        return err(
          appError('invalid-message', 'sync: pairing code must be 6 digits'),
        );
      }
      return pairOp(opts.endpoints, opts.code, undefined, undefined, signal);
    },

    async syncNow(fp, signal) {
      if (closing) {
        return err(appError('released', 'sync: client closed'));
      }
      const loaded = await loadPeers(signal);
      if (!loaded.ok) {
        return loaded;
      }
      const peer = peers.get(fp);
      if (peer === undefined) {
        return err(appError('not-found', 'sync: unknown peer fingerprint'));
      }
      let session = sessions.get(fp);
      if (session === undefined || session.closed) {
        setView(fp, { state: 'connecting' });
        // Concurrent syncNow shares one dial — the map entry exists
        // from the synchronous start until the shared promise lands.
        let opening = connecting.get(fp);
        if (opening === undefined) {
          opening = openSession({
            endpoints: peer.endpoints,
            pinnedFp: peer.fp,
            ...(signal !== undefined ? { signal } : {}),
          });
          connecting.set(fp, opening);
        }
        const opened = await opening;
        if (connecting.get(fp) === opening) {
          connecting.delete(fp);
        }
        if (!opened.ok) {
          setView(fp, { state: 'offline', lastError: opened.error });
          if (opened.error.kind === 'auth-required') {
            // The desktop forgot us — local custody is stale too.
            peers.delete(fp);
            void deps.keys.peerDelete(fp, signal);
          }
          return err(opened.error);
        }
        session = opened.value.session;
        if (session.peerFp !== fp) {
          // The dialed endpoint answered under a different identity —
          // never let a mismatched server claim the custody slot.
          killSession(
            session,
            appError('permission-denied', 'sync: fingerprint mismatch'),
          );
          return err(
            appError('permission-denied', 'sync: fingerprint mismatch'),
          );
        }
        const prior = sessions.get(fp);
        if (prior !== undefined && prior !== session && !prior.closed) {
          // A connect that slipped the dedupe window already owns the
          // slot — the superseded dial must not leak its keepalive.
          killSession(
            session,
            appError('superseded', 'sync: superseded connect'),
          );
          session = prior;
        } else {
          sessions.set(fp, session);
          setView(fp, { state: 'open' });
          if (opened.value.welcome.device.id !== deps.deviceId) {
            // The desktop rebound our key to another id — custody is
            // stale on their side; treat as unpaired and drop locally.
            killSession(
              session,
              appError('auth-required', 'sync: device re-bound remotely'),
            );
            peers.delete(fp);
            void deps.keys.peerDelete(fp, signal);
            return err(
              appError('auth-required', 'sync: device re-bound remotely'),
            );
          }
        }
      }
      const outcome = await enqueue(session, () =>
        syncRound(session, peer, signal),
      );
      if (!session.closed) {
        // A dead session already reported its cause through
        // killSession. On a live one the round's verdict is the
        // lastError — a failed round must not read as connected.
        setView(
          fp,
          outcome.ok
            ? { state: 'open' }
            : { state: 'open', lastError: outcome.error },
        );
      }
      return outcome;
    },

    async refreshPeer(fp, signal) {
      if (closing) {
        return err(appError('released', 'sync: client closed'));
      }
      const loaded = await loadPeers(signal);
      if (!loaded.ok) {
        return loaded;
      }
      const session = sessions.get(fp);
      if (session === undefined || session.closed) {
        return err(appError('unavailable', 'sync: peer not connected'));
      }
      return enqueue(session, async () => {
        const reply = await sessionRequest(
          session,
          { t: 'devices' },
          (m): m is DevicesMsg | ErrorMsg => isDevicesMsg(m) || isErrorMsg(m),
          requestMs,
          signal,
        );
        if (!reply.ok) {
          return reply;
        }
        if (isErrorMsg(reply.value)) {
          return err(wireErrorCode(reply.value.code));
        }
        return ok(
          reply.value.devices.find((d) => d.id === deps.deviceId) ?? null,
        );
      });
    },

    async unpair(fp, signal) {
      const loaded = await loadPeers(signal);
      if (!loaded.ok) {
        return loaded;
      }
      const session = sessions.get(fp);
      if (session !== undefined && !session.closed) {
        sendSealed(session, { t: 'bye' });
        killSession(session, null);
      }
      peers.delete(fp);
      views.delete(fp);
      const removed = await deps.keys.peerDelete(fp, signal);
      emit();
      return removed;
    },

    async close() {
      closing = true;
      for (const session of sessions.values()) {
        sendSealed(session, { t: 'bye' });
        killSession(session, null);
      }
      sessions.clear();
      deps.sockets.close?.();
      emit();
    },
  };
}
