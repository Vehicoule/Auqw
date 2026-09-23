import { randomInt } from 'node:crypto';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  CancellationSource,
  type AppError,
  type CancellationSignal,
  type Result,
  type SyncEnginePort,
} from '@auqw/application';
import {
  hasOnlyKeys,
  isBoundedString,
  isRecord,
} from '../shared/check.ts';
import {
  MAX_SYNC_CURSOR_CHARS,
  MAX_SYNC_DOC_BYTES,
  isJsonValue,
  isSyncDeltasArgs,
  isSyncDeltasResult,
  isSyncDeltaDoc,
  isSyncDevicesResult,
  isSyncDrainAppliedResult,
  isSyncImportDeltaArgs,
  isSyncImportDeltaResult,
  isSyncLocalChangesArgs,
  isSyncLocalChangesResult,
  isSyncPairingResult,
  isSyncStatusResult,
  isSyncTriggerResult,
  isSyncUnpairArgs,
  type SyncStatusResult,
} from '../shared/contract.ts';
import {
  isShellError,
  shellError,
  type ShellError,
  type ShellErrorKind,
} from '../shared/errors.ts';
import type { UtilityHandler } from './router.ts';
import {
  createNoiseV1Cipher,
  fingerprintOf,
  generateIdentity,
  isClientHello,
  isUsableIdentity,
  type SessionCodec,
  type SyncCipher,
  type SyncIdentity,
} from './sync-crypto.ts';
import {
  isDeviceId,
  type SyncDeviceRecord,
  type SyncKeys,
} from './sync-keys.ts';
import {
  attachWirePump,
  type WirePump,
  type WireSocketLike,
} from './sync-wire.ts';

/**
 * The desktop half of LAN sync per docs/specs/sync.md: the desktop
 * advertises `_auqw._tcp.local` and listens; the phone dials.
 *
 * Wire phases per connection (frames are `[u32le len][payload]` via
 * sync-wire; payloads are JSON plaintext until the handshake seals
 * them, then AEAD via the SyncCipher's SessionCodec):
 *
 *   C→S hello      {v:1,kind:'hello',deviceId,name,eph,dev}
 *   S→C challenge  {v:1,kind:'challenge',eph,salt,spub,registered}
 *   C→S auth       {t:'pair',code} | {t:'resume'}            (sealed)
 *   S→C welcome    {t:'welcome',device,name}                 (sealed)
 *   S→C reject     {t:'reject',reason}  then close           (sealed)
 *   open           ping/pong, devices, sync/delta, error,
 *                  sync-request (S→C kick), bye              (sealed)
 *
 * Pairing is a challenge-response the code carries through: the QR
 * payload `{v,endpoint,code,fp}` and the 6-digit typed path mint the
 * same pending session; the phone proves code possession inside the
 * DH-authenticated channel, then the device key installs for good.
 * A wrong code is a typed reject AND the device never registers.
 *
 * Everything user-facing surfaces typed `unavailable` — a dead
 * listener, no LAN address, or a failed mDNS announce never reports a
 * fake healthy status (spec: export/import is the fallback).
 */

export interface SyncAdvertiser {
  close(): void;
}

/** mDNS announce seam — production wires bonjour; tests pass a fake. */
export type SyncAdvertise = (opts: {
  port: number;
  name: string;
  /** Async announce failure — flips status to 'unavailable', no throw. */
  onError?: () => void;
}) => SyncAdvertiser;

export type SyncServiceDeps = {
  /** Listen host — '0.0.0.0' LAN default; tests pass '127.0.0.1'. */
  readonly host?: string;
  /** 0 = ephemeral (default); a configured port survives restarts. */
  readonly port?: number;
  /** AUQW_SYNC_DISABLED=1 → everything reports 'disabled'. */
  readonly disabled?: boolean;
  readonly keys: SyncKeys;
  /**
   * The merge engine — a `SyncEnginePort` directly, or the promise
   * of one while construction (log open + hydrate) is still in
   * flight; `start()` resolves it before anything reads the seam.
   * Absent: delta channels answer typed 'unavailable', pairing
   * still works.
   */
  readonly engine?: SyncEnginePort | Promise<SyncEnginePort | null>;
  /**
   * Renderer-committed edits pushed into the engine log — the
   * `sync:localChanges` emission seam. Each write re-validates
   * inside the engine (`validLocalWrite`), so the channel owes only
   * the contract's bounded-shape check. Absent: typed 'unavailable'.
   */
  readonly localChanges?: (
    writes: readonly unknown[],
    signal?: CancellationSignal,
  ) => Promise<Result<unknown>>;
  /**
   * Push seam toward the renderer: after every successful applyDelta
   * the applied merge outcomes queue into a bounded outbox, and this
   * is invoked with the current queue depth so main can broadcast
   * `sync:applied`. Errors are swallowed — the pull drain still
   * reaches the same queue.
   */
  readonly notifyApplied?: (pending: number) => unknown;
  /**
   * Durability seam for the applied outbox: when set, outcomes that
   * overflow the in-memory cap append to a JSONL spill file here
   * (same durability horizon as the sync log) and the drain serves
   * them before the memory queue — nothing is lost while the
   * renderer is booting or dead. Absent: overflow drops oldest and
   * sets `dropped`, honest but lossy.
   */
  readonly appliedSpillPath?: string;
  /** Cipher seam — defaults to the noise-style node:crypto impl. */
  readonly cipher?: SyncCipher;
  /** Display name for pairing payloads + mDNS — defaults to hostname. */
  readonly deviceName?: string;
  /** mDNS announce factory — null skips advertising entirely. */
  readonly advertise?: SyncAdvertise | null;
  /** Forced endpoint host for payloads; otherwise first LAN IPv4. */
  readonly endpointHost?: string;
  readonly nowMs?: () => number;
  /* Tuning knobs — production defaults; tests shrink them. */
  readonly handshakeCap?: number;
  readonly sessionCap?: number;
  readonly maxConnections?: number;
  readonly handshakeMs?: number;
  readonly idleMs?: number;
  readonly codeTtlMs?: number;
  readonly maxCodeAttempts?: number;
  /**
   * Shared miss ceiling per pending code — bounds total brute-force
   * space regardless of how many source addresses an attacker can
   * alias. Defaults to 3× `maxCodeAttempts`.
   */
  readonly maxTotalCodeAttempts?: number;
};

export interface SyncService {
  readonly handlers: Readonly<Record<string, UtilityHandler>>;
  status(): Promise<SyncStatusResult>;
  close(): Promise<void>;
  /** Settles once the listener reaches a terminal state. */
  readonly ready: Promise<SyncStatusResult>;
}

/* ------------------------- pairing codes -------------------------- */

type PairingState = {
  readonly code: string;
  readonly expiresAt: number;
};

type PairCheck =
  | 'ok'
  | 'bad-code'
  | 'pairing-expired'
  | 'no-pairing';

/**
 * The pending pairing code: minted per `sync:pairing` call, expires on
 * TTL, consumed exactly once on success. Wrong-code attempts do NOT
 * burn the code — rate limiting is per remote address (see the
 * service's bad-attempt map) so a hostile LAN peer can't invalidate a
 * code the legitimate phone is about to type.
 */
function createPairing(opts: {
  nowMs: () => number;
  ttlMs: number;
}): {
  mint(): { code: string; expiresAt: number };
  /** Validate without consuming — the registry write must land first. */
  peek(code: string): PairCheck;
  /**
   * Consume iff the same code is still pending — one winner only, so a
   * racing session can't double-register off one mint.
   */
  consume(code: string): boolean;
  expire(): void;
} {
  let current: PairingState | null = null;
  return {
    mint() {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      current = {
        code,
        expiresAt: opts.nowMs() + opts.ttlMs,
      };
      return { code, expiresAt: current.expiresAt };
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
        return false;
      }
      current = null; // a code pairs exactly once
      return true;
    },
    expire() {
      current = null;
    },
  };
}

/* --------------------- wire message validators -------------------- */

type WireMsg = { readonly t: string };

function isWireMsg(value: unknown): value is WireMsg {
  return (
    isRecord(value) && isBoundedString(value['t'], 32)
  );
}

function isPairMsg(value: unknown): value is { t: 'pair'; code: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['t', 'code']) &&
    value['t'] === 'pair' &&
    typeof value['code'] === 'string' &&
    /^[0-9]{6}$/.test(value['code'])
  );
}

function isResumeMsg(value: unknown): value is { t: 'resume' } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['t']) &&
    value['t'] === 'resume'
  );
}

function isSyncReq(
  value: unknown,
): value is { t: 'sync'; since: string; delta?: unknown } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['t', 'since', 'delta']) &&
    value['t'] === 'sync' &&
    typeof value['since'] === 'string' &&
    value['since'].length <= MAX_SYNC_CURSOR_CHARS &&
    (value['delta'] === undefined || isSyncDeltaDoc(value['delta']))
  );
}

function parseJson(payload: Uint8Array): unknown {
  return JSON.parse(Buffer.from(payload).toString('utf8'));
}

/* -------------------------- the service --------------------------- */

type SessionPhase = 'hello' | 'auth' | 'open';

type Session = {
  readonly pump: WirePump;
  /** Source address for per-peer pairing rate limiting ('' = unknown). */
  readonly remoteIp: string;
  /** Cancelled when the session dies — engine ops can stop mid-flight. */
  readonly cancel: CancellationSource;
  phase: SessionPhase;
  codec: SessionCodec | null;
  deviceId: string | null;
  devFp: string | null;
  /** Device long-lived public key (SPKI b64) captured at accept(). */
  devPub: string;
  /** Registry lookup result from accept() — echoed, not trusted. */
  registered: boolean;
  /** The id the registry already binds to this key — resume pins it. */
  registeredId: string | null;
  /** Registry pairedAt for resume, when known. */
  pairedAtMs: number | null;
  name: string;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Per-session op chain — engine calls never interleave. */
  ops: Promise<void>;
};

/** RFC1918 — the address class a phone on the same LAN can reach. */
function isPrivateLanIp(ip: string): boolean {
  const parts = ip.split('.');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Every non-internal IPv4 a phone could reach — private LAN first,
 * deduped. A multi-homed host can carry VPN/tunnel/public addresses
 * the phone can't reach: advertising only the first candidate would
 * publish an endpoint that never answers, so the pairing payload
 * ships the whole list and lets the client pick whichever responds.
 */
function lanIpv4s(): string[] {
  const privateIps: string[] = [];
  const otherIps: string[] = [];
  const seen = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (
        iface.family !== 'IPv4' ||
        iface.internal ||
        seen.has(iface.address)
      ) {
        continue;
      }
      seen.add(iface.address);
      if (isPrivateLanIp(iface.address)) {
        privateIps.push(iface.address);
      } else {
        otherIps.push(iface.address);
      }
    }
  }
  return [...privateIps, ...otherIps];
}

/** '::ffff:a.b.c.d' is the same peer as 'a.b.c.d' — fold before keying. */
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const host = deps.host ?? '0.0.0.0';
  const handshakeCap = deps.handshakeCap ?? 16 * 1_024;
  /** AEAD overhead per frame: 12-byte iv + 16-byte auth tag. */
  const SEAL_OVERHEAD = 28;
  // A sealed frame carries the protocol wrapper around a contract-max
  // delta doc — budget the cap above MAX_SYNC_DOC_BYTES + seal or a
  // valid max-size delta can't cross the wire at all.
  const sessionCap =
    deps.sessionCap ?? MAX_SYNC_DOC_BYTES + SEAL_OVERHEAD + 4_096;
  const maxConnections = deps.maxConnections ?? 16;
  const handshakeMs = deps.handshakeMs ?? 15_000;
  const idleMs = deps.idleMs ?? 120_000;
  const deviceName = deps.deviceName ?? 'auqw-desktop';
  const pairing = createPairing({
    nowMs,
    ttlMs: deps.codeTtlMs ?? 90_000,
  });
  // Wrong-code budget, two layers: per remote address (an attacker
  // exhausts only its own guesses — the legit phone's window can't be
  // DoS'd away) and one shared ceiling per pending code (address
  // aliases can't split the attacker's budget into unbounded total
  // tries). Both cleared on each fresh mint; per-IP also on success.
  const maxCodeAttempts = deps.maxCodeAttempts ?? 5;
  const maxTotalCodeAttempts =
    deps.maxTotalCodeAttempts ?? maxCodeAttempts * 3;
  const badAttempts = new Map<string, number>();
  let totalBadAttempts = 0;
  // The pair path's peek → put → consume is one logical transaction:
  // serialized here so a losing session sees the consumed code at
  // peek — never writes its key into the registry at all. (Custody
  // serializes too, but a consume lost AFTER a write can't unwrite
  // the sibling's record without a rollback that could hit a legit
  // same-fp record.)
  let pairChain: Promise<void> = Promise.resolve();
  function withPairLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = pairChain.then(fn);
    pairChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  const sessions = new Set<Session>();
  const pendingSync = new Set<string>();
  // The resolved engine — a promise dep settles inside start(),
  // and every consumer reads this, never `deps.engine` (which may
  // itself be the unsettled promise).
  let engine: SyncEnginePort | undefined;

  async function resolveEngine(): Promise<void> {
    const candidate = deps.engine;
    if (candidate === undefined) {
      engine = undefined;
      return;
    }
    if (candidate instanceof Promise) {
      try {
        engine = (await candidate) ?? undefined;
      } catch {
        // A failed engine build degrades to absent — pairing and
        // the listener still serve.
        engine = undefined;
      }
      return;
    }
    engine = candidate;
  }
  // Renderer-originated engine ops bind to the service's lifetime —
  // there is no per-request cancel on the IPC boundary, so close() is
  // the cancellation edge (sessions use their own per-socket source).
  const serviceCancel = new CancellationSource();
  let server: Server | null = null;
  let advertiser: SyncAdvertiser | null = null;
  let listener: SyncStatusResult['listener'] = 'starting';
  let advertiseState: SyncStatusResult['advertise'] = 'off';
  let boundPort: number | null = null;
  let fingerprint: string | null = null;
  let lastSyncAt: number | null = null;
  let closing = false;
  let resolveReady!: (status: SyncStatusResult) => void;
  const ready = new Promise<SyncStatusResult>((resolve) => {
    resolveReady = resolve;
  });

  /* ------------- applied-outcome outbox (renderer drain) ---------- */
  /**
   * Every successful applyDelta's 'applied' merge outcomes queue
   * here until the renderer pulls `sync:drainApplied`. Flat FIFO
   * bounded in memory; overflow spills to `appliedSpillPath` (JSONL,
   * same horizon as the sync log) so a deep queue loses nothing —
   * the drain serves spill first, and a spill IO failure degrades to
   * the honest `dropped` flag. Volatile mode (no path) keeps the
   * drop-oldest bound for tests.
   */
  const APPLIED_OUTBOX_MAX = 4_096;
  const appliedOutbox: unknown[] = [];
  let appliedDropped = false;
  /** Serializes spill appends against drain rewrites. */
  let spillTail: Promise<unknown> = Promise.resolve();

  function spillOutcomes(spilled: readonly unknown[]): void {
    if (spilled.length === 0) {
      return;
    }
    const path = deps.appliedSpillPath;
    if (path === undefined) {
      appliedDropped = true;
      return;
    }
    const lines = `${spilled.map((o) => JSON.stringify(o)).join('\n')}\n`;
    spillTail = spillTail
      .then(() => appendFile(path, lines))
      .catch(() => {
        appliedDropped = true;
      });
  }

  function recordApplied(result: unknown): void {
    if (!isRecord(result) || !Array.isArray(result['outcomes'])) {
      return;
    }
    let pushed = 0;
    for (const outcome of result['outcomes']) {
      if (
        !isRecord(outcome) ||
        outcome['type'] !== 'applied' ||
        !isJsonValue(outcome)
      ) {
        continue;
      }
      appliedOutbox.push(outcome);
      pushed += 1;
    }
    if (appliedOutbox.length > APPLIED_OUTBOX_MAX) {
      spillOutcomes(
        appliedOutbox.splice(0, appliedOutbox.length - APPLIED_OUTBOX_MAX),
      );
    }
    if (pushed > 0) {
      try {
        void Promise.resolve(
          deps.notifyApplied?.(appliedOutbox.length),
        ).catch(() => undefined);
      } catch {
        // The push path is a hint — the pull drain never depends on it.
      }
    }
  }

  /**
   * One byte-bounded pull: pack outcomes until the encoded payload
   * would approach `MAX_SYNC_DOC_BYTES`, leaving headroom for the
   * envelope keys. Spill lines serve before the memory queue (FIFO
   * across both); oversized or unparsable entries drop with the flag
   * set — a queue entry that can never serialize is exactly what the
   * bound exists for.
   */
  async function drainAppliedChunk(): Promise<{
    readonly outcomes: readonly unknown[];
    readonly dropped: boolean;
    readonly remaining: number;
  }> {
    const budget = MAX_SYNC_DOC_BYTES - 16_384;
    const chunk: unknown[] = [];
    let bytes = 2; // '[]'
    const sizeOf = (next: unknown): number => {
      try {
        return JSON.stringify(next).length + 1;
      } catch {
        return -1;
      }
    };

    const path = deps.appliedSpillPath;
    let spilledBacklog = 0;
    if (path !== undefined) {
      // Run the whole read-modify-rename inside `spillTail`: appends
      // chain onto the same tail, so a rewrite can never rename over
      // an outcome spilled between the read and the rename.
      const drainFile = spillTail.then(async () => {
        const raw = await readFile(path, 'utf8').catch(
          (e: NodeJS.ErrnoException) =>
            e.code === 'ENOENT' ? '' : Promise.reject(e),
        );
        const lines = raw.split('\n').filter((l) => l.length > 0);
        const keep: string[] = [];
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          if (line === undefined) {
            break;
          }
          if (bytes + line.length + 1 > budget) {
            // Stop at the first non-fitting line and keep the whole
            // suffix — spill order IS merge order, so a smaller
            // later outcome must not leapfrog it across pages.
            keep.push(...lines.slice(i));
            break;
          }
          try {
            const parsed: unknown = JSON.parse(line);
            if (isJsonValue(parsed)) {
              bytes += line.length + 1;
              chunk.push(parsed);
            } else {
              appliedDropped = true;
            }
          } catch {
            // Torn tail line (killed mid-append) — drop it, keep the
            // rest.
            appliedDropped = true;
          }
        }
        spilledBacklog = keep.length;
        // Rewrite only when the consumed share changes the file — an
        // untouched read pays no write.
        if (lines.length !== keep.length) {
          const tmp = `${path}.tmp`;
          const rewritten = keep.length > 0 ? `${keep.join('\n')}\n` : '';
          await writeFile(tmp, rewritten)
            .then(() => rename(tmp, path))
            .catch(() => {
              // Consume nothing we couldn't persist back — replay the
              // file next drain rather than lose the tail.
              appliedDropped = true;
            });
        }
      });
      spillTail = drainFile.then(
        () => undefined,
        () => undefined,
      );
      await drainFile;
    }

    while (appliedOutbox.length > 0) {
      const next = appliedOutbox[0];
      const size = sizeOf(next);
      if (size < 0) {
        appliedOutbox.shift();
        appliedDropped = true;
        continue;
      }
      if (bytes + size > budget) {
        if (chunk.length === 0) {
          appliedOutbox.shift();
          appliedDropped = true;
          continue;
        }
        break;
      }
      appliedOutbox.shift();
      bytes += size;
      chunk.push(next);
    }
    const dropped = appliedDropped;
    appliedDropped = false;
    return {
      outcomes: chunk,
      dropped,
      remaining: spilledBacklog + appliedOutbox.length,
    };
  }

  /**
   * Every `ip:port` a phone could try, best first — `endpoint()`
   * stays the canonical primary for status display, the pairing
   * payload carries the full list.
   */
  function endpoints(): string[] {
    if (boundPort === null) {
      return [];
    }
    const hosts =
      deps.endpointHost !== undefined ? [deps.endpointHost] : lanIpv4s();
    return hosts.map((ip) => {
      const formatted = ip.includes(':') ? `[${ip}]` : ip;
      return `${formatted}:${boundPort}`;
    });
  }

  function endpoint(): string | null {
    return endpoints()[0] ?? null;
  }

  // Propagates custody failures — a dead registry is NOT an empty
  // one, and sync:status fails typed instead of reporting a healthy
  // pairedDevices: 0 that contradicts sync:devices.
  async function deviceCount(): Promise<number> {
    return (await deps.keys.deviceList()).devices.length;
  }

  async function status(): Promise<SyncStatusResult> {
    return {
      listener,
      endpoint: endpoint(),
      boundPort,
      advertise: advertiseState,
      // Disabled is a stable answer, not a custody question — an
      // explicit AUQW_SYNC_DISABLED must never depend on safeStorage.
      pairedDevices:
        listener === 'disabled' ? 0 : await deviceCount(),
      sessions: [...sessions].filter((s) => s.phase === 'open').length,
      lastSyncAt,
      engine: engine === undefined ? 'absent' : 'ready',
      name: deviceName,
      fingerprint,
    };
  }

  function dropSession(session: Session): void {
    if (!sessions.has(session)) {
      return;
    }
    sessions.delete(session);
    session.cancel.cancel();
    if (session.handshakeTimer !== null) {
      clearTimeout(session.handshakeTimer);
      session.handshakeTimer = null;
    }
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  /** True iff a frame was accepted by the pump — callers that key
   *  state off delivery (pendingSync marks) must not clear on a dead
   *  socket where the kick never went out. */
  function sendSealed(session: Session, msg: unknown): boolean {
    const codec = session.codec;
    if (codec === null) {
      return false;
    }
    const plain = Buffer.from(JSON.stringify(msg), 'utf8');
    if (plain.length + SEAL_OVERHEAD > session.pump.maxPayload) {
      // Never silently drop a response: a document that fits the
      // contract but overflows the sealed frame gets a typed error
      // instead — and the codec seals that (small) reply, so the
      // sequence stays contiguous for the peer.
      const err = Buffer.from(
        JSON.stringify({ t: 'error', code: 'too-large' }),
        'utf8',
      );
      return session.pump.send(codec.seal(err));
    }
    return session.pump.send(codec.seal(plain));
  }

  function killSession(session: Session): void {
    dropSession(session);
    session.pump.close();
  }

  function kickDevice(deviceId: string): void {
    for (const session of sessions) {
      if (session.deviceId === deviceId) {
        killSession(session);
      }
    }
  }

  /** Kick any OTHER session bound to the same key — stale ids die. */
  function kickStaleFp(session: Session): void {
    for (const other of sessions) {
      if (
        other !== session &&
        other.devFp !== null &&
        other.devFp === session.devFp
      ) {
        killSession(other);
      }
    }
  }

  function resetIdle(session: Session): void {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
    }
    session.idleTimer = setTimeout(() => killSession(session), idleMs);
  }

  async function enterOpen(session: Session): Promise<void> {
    session.phase = 'open';
    if (session.handshakeTimer !== null) {
      clearTimeout(session.handshakeTimer);
      session.handshakeTimer = null;
    }
    resetIdle(session);
    kickStaleFp(session);
    if (
      session.deviceId !== null &&
      pendingSync.has(session.deviceId) &&
      sendSealed(session, { t: 'sync-request' })
    ) {
      pendingSync.delete(session.deviceId);
    }
  }

  async function onAuthFrame(session: Session, payload: Uint8Array) {
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
      // would discard queued output and leave the phone with a mute
      // EOF. killSession stays the path where no reply is owed.
      session.pump.end();
    };
    const now = nowMs();
    if (isPairMsg(msg)) {
      type Outcome =
        | { readonly ok: true; readonly record: SyncDeviceRecord }
        | { readonly ok: false; readonly reason: string };
      const outcome = await withPairLock(async (): Promise<Outcome> => {
        // A peer that already blew its code budget never reaches the
        // checker — a correct guess after the cap can't quietly pair.
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
        const record = {
          id: session.deviceId ?? '',
          name: session.name,
          pub: session.devPub,
          fp: session.devFp ?? '',
          pairedAt: now,
          lastSeenAt: now,
        };
        try {
          await deps.keys.devicePut(record);
        } catch (thrown) {
          // Consume only AFTER the registry write — a transient
          // custody failure leaves the still-valid code open for
          // retry.
          return {
            ok: false,
            reason: isShellError(thrown) ? thrown.kind : 'internal',
          };
        }
        if (!pairing.consume(msg.code)) {
          // Defensive: inside the lock a peek-ok always consumes —
          // this can only mean state was cleared out-of-band.
          return { ok: false, reason: 'no-pairing' };
        }
        badAttempts.delete(session.remoteIp);
        return { ok: true, record };
      });
      if (!outcome.ok) {
        reject(outcome.reason);
        return;
      }
      // Re-pair under a new id evicted the old record — drop its
      // pending mark too, or triggers report work no device can clear.
      if (
        session.registeredId !== null &&
        session.registeredId !== outcome.record.id
      ) {
        pendingSync.delete(session.registeredId);
      }
      sendSealed(session, {
        t: 'welcome',
        device: outcome.record,
        name: deviceName,
      });
      await enterOpen(session);
      return;
    }
    if (isResumeMsg(msg)) {
      // The registry — not the client's claimed id — names a resumed
      // device. A paired key presenting a foreign deviceId cannot take
      // that id's slot: the canonical id is pinned to the stored key.
      if (!session.registered || session.registeredId === null) {
        reject('unpaired');
        return;
      }
      session.deviceId = session.registeredId;
      const record = {
        id: session.registeredId,
        name: session.name,
        pub: session.devPub,
        fp: session.devFp ?? '',
        pairedAt: session.pairedAtMs ?? now,
        lastSeenAt: now,
      };
      try {
        // Update iff still registered — the hello-time registry read
        // races a concurrent unpair, and an unconditional put would
        // resurrect a revoked device.
        const updated = await deps.keys.deviceTouch(record);
        if (!updated) {
          reject('unpaired');
          return;
        }
      } catch {
        reject('unavailable');
        return;
      }
      sendSealed(session, {
        t: 'welcome',
        device: record,
        name: deviceName,
      });
      await enterOpen(session);
      return;
    }
    reject('bad-auth');
  }

  async function onHello(session: Session, payload: Uint8Array) {
    // Advance the phase BEFORE the first await: a second hello frame
    // while registry lookup/DH is in flight would otherwise run this
    // body concurrently and overwrite codec + peer identity. Now the
    // stray frame routes to onAuthFrame, which kills on a null codec.
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
    let registered = false;
    let registeredId: string | null = null;
    let pairedAt: number | undefined;
    const devFp = fingerprintOf(msg.dev);
    try {
      const { devices } = await deps.keys.deviceList();
      for (const device of devices) {
        if (device.fp === devFp) {
          registered = true;
          registeredId = device.id;
          pairedAt = device.pairedAt;
          break;
        }
      }
    } catch {
      killSession(session);
      return;
    }
    let accepted;
    try {
      accepted = syncCipher.accept(msg, { registered });
    } catch {
      killSession(session);
      return;
    }
    session.deviceId = msg.deviceId;
    session.devFp = devFp;
    session.name = msg.name;
    session.codec = accepted.codec;
    session.devPub = msg.dev;
    session.registered = registered;
    session.registeredId = registeredId;
    session.pairedAtMs = pairedAt ?? null;
    session.pump.upgrade(sessionCap);
    session.pump.send(accepted.challenge);
  }

  function onOpenFrame(session: Session, payload: Uint8Array): void {
    resetIdle(session);
    session.ops = session.ops.then(() =>
      onOpenMsg(session, payload),
    );
  }

  async function onOpenMsg(session: Session, payload: Uint8Array) {
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
        try {
          const { devices } = await deps.keys.deviceList();
          // The wire exposes only the caller's own record — every
          // other device's id, name, and activity stays renderer-local
          // (api.sync.devices), not a free registry dump for any key
          // holder.
          sendSealed(session, {
            t: 'devices',
            devices: devices
              .filter((d) => d.id === session.deviceId)
              .map((d) => ({
                id: d.id,
                name: d.name,
                pairedAt: d.pairedAt,
                lastSeenAt: d.lastSeenAt,
              })),
          });
        } catch {
          sendSealed(session, { t: 'error', code: 'unavailable' });
        }
        return;
      }
      case 'sync': {
        if (!isSyncReq(msg)) {
          sendSealed(session, { t: 'error', code: 'bad-request' });
          return;
        }
        if (engine === undefined) {
          sendSealed(session, { t: 'error', code: 'engine-absent' });
          return;
        }
        const deviceId = session.deviceId ?? 'unknown';
        try {
          if (msg.delta !== undefined) {
            const applied = await engine.applyDelta(
              msg.delta,
              deviceId,
              session.cancel.signal,
            );
            if (!applied.ok) {
              sendSealed(session, {
                t: 'error',
                code: applied.error.kind,
              });
              return;
            }
            recordApplied(applied.value);
          }
          const exported = await engine.exportDelta(
            msg.since,
            session.cancel.signal,
          );
          if (!exported.ok) {
            sendSealed(session, {
              t: 'error',
              code: exported.error.kind,
            });
            return;
          }
          // The engine returns `unknown` — the wire carries only the
          // strict JSON domain, and JSON.stringify silently rewrites
          // anything outside it (undefined drops, NaN→null, sparse
          // slots→null). The live check rejects those inputs outright.
          if (!isSyncDeltaDoc(exported.value)) {
            sendSealed(session, {
              t: 'error',
              code: 'invalid-response',
            });
            return;
          }
          // Then serialize once and validate the REPARSED document —
          // a plain graph is what the wire actually carries, so an
          // exotic survivor (a proxy whose descriptors lied) can only
          // ever ship the self-consistent form validation approved.
          let reparsed: unknown = null;
          try {
            reparsed = JSON.parse(JSON.stringify(exported.value));
          } catch {
            reparsed = null;
          }
          if (reparsed === null || !isSyncDeltaDoc(reparsed)) {
            sendSealed(session, {
              t: 'error',
              code: 'invalid-response',
            });
            return;
          }
          lastSyncAt = nowMs();
          sendSealed(session, { t: 'delta', delta: reparsed });
        } catch {
          sendSealed(session, { t: 'error', code: 'internal' });
        }
        return;
      }
      case 'bye':
        killSession(session);
        return;
      default:
        sendSealed(session, { t: 'error', code: 'bad-request' });
    }
  }

  function onConnection(socket: WireSocketLike): void {
    if (sessions.size >= maxConnections) {
      socket.destroy();
      return;
    }
    const session: Session = {
      pump: attachWirePump({
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
      remoteIp: normalizeIp(socket.remoteAddress ?? ''),
      cancel: new CancellationSource(),
      phase: 'hello',
      codec: null,
      deviceId: null,
      devFp: null,
      devPub: '',
      registered: false,
      registeredId: null,
      pairedAtMs: null,
      name: '',
      handshakeTimer: null,
      idleTimer: null,
      ops: Promise.resolve(),
    };
    // A socket that never finishes pairing dies instead of idling in
    // the handshake phase forever.
    session.handshakeTimer = setTimeout(
      () => killSession(session),
      handshakeMs,
    );
    sessions.add(session);
  }

  // Set inside start() once the identity is loaded — connections only
  // arrive after bind, so `onConnection` never runs before it.
  let syncCipher: SyncCipher = deps.cipher ?? {
    name: 'uninitialized',
    identity: { pub: '', priv: '' },
    accept() {
      throw shellError('internal', 'sync cipher not initialized');
    },
  };

  async function start(): Promise<SyncStatusResult> {
    // An async engine resolves before anything reads the seam —
    // status then answers 'ready'/'absent' truthfully even when the
    // listener is disabled.
    await resolveEngine();
    if (deps.disabled === true) {
      listener = 'disabled';
      return status();
    }
    // Custody keeps shape-valid records; usable is stronger — the
    // material must load as X25519 keys. A corrupt or unusable read
    // must REPLACE the stored record: create-once identity-set would
    // refuse over it and wedge sync on every later launch.
    let identity: SyncIdentity | null = null;
    let replace = false;
    try {
      identity = await deps.keys.identityGet();
    } catch (thrown) {
      // A record that can't even parse is replaced below; every other
      // custody failure (no safeStorage backend etc.) fails startup.
      if (isShellError(thrown) && thrown.kind === 'corrupt-state') {
        replace = true;
      } else {
        throw thrown;
      }
    }
    if (identity !== null && !isUsableIdentity(identity)) {
      identity = null;
      replace = true;
    }
    if (identity === null) {
      identity = generateIdentity();
      if (replace) {
        await deps.keys.identityReplace(identity);
      } else {
        await deps.keys.identitySet(identity);
      }
    }
    syncCipher = deps.cipher ?? createNoiseV1Cipher(identity);
    fingerprint = fingerprintOf(identity.pub);
    server = createServer((socket) => onConnection(socket));
    const bound = await new Promise<number | null>((resolve) => {
      const srv = server;
      if (srv === null) {
        resolve(null);
        return;
      }
      srv.once('error', () => resolve(null));
      srv.listen(
        { host, port: deps.port ?? 0 },
        () => {
          const address = srv.address();
          resolve(
            address !== null && typeof address === 'object'
              ? address.port
              : null,
          );
        },
      );
    });
    if (bound === null) {
      listener = 'unavailable';
      server = null;
      return status();
    }
    boundPort = bound;
    listener = 'listening';
    if (deps.advertise !== undefined && deps.advertise !== null) {
      try {
        advertiser = deps.advertise({
          port: bound,
          name: deviceName,
          onError: () => {
            // An async mdns failure after startup degrades the
            // advertise state — the listener itself is unaffected.
            advertiseState = 'unavailable';
            try {
              advertiser?.close();
            } catch {
              // best effort
            }
          },
        });
        advertiseState = 'announcing';
      } catch {
        // mDNS is best-effort: pairing still works via the typed code.
        advertiseState = 'unavailable';
      }
    }
    return status();
  }

  /* -------------------------- handlers ---------------------------- */

  /**
   * AppError → ShellError: the engine speaks the application taxonomy,
   * the IPC boundary the shell one. Equivalent kinds map directly;
   * retryable failures without a shell twin land on 'unavailable' and
   * the rest on 'internal' — a failed export is never reported as an
   * actionable 'internal' when the engine named something better.
   */
  const ENGINE_ERROR_KINDS: Readonly<
    Partial<Record<AppError['kind'], ShellErrorKind>>
  > = {
    'invalid-response': 'invalid-response',
    cancelled: 'cancelled',
    released: 'released',
    'storage-full': 'io-error',
    'not-found': 'invalid-request',
    'not-applicable': 'invalid-request',
    'invalid-message': 'invalid-request',
    'artifact-rejected': 'invalid-request',
    'permission-denied': 'invalid-request',
    'auth-expired': 'invalid-request',
    'budget-exceeded': 'invalid-request',
    'guest-trap': 'invalid-request',
    internal: 'internal',
  };

  function engineError(error: AppError): ShellError {
    return shellError(
      ENGINE_ERROR_KINDS[error.kind] ??
        (error.retryable ? 'unavailable' : 'internal'),
      error.message,
    );
  }

  // Outbound re-validation per the utility boundary pattern: a
  // malformed service result must surface as a typed invalid-response,
  // never as a confused renderer.
  const checked = <T>(
    isResult: (value: unknown) => value is T,
    label: string,
  ): ((value: unknown) => T) => {
    return (value) => {
      if (!isResult(value)) {
        throw shellError(
          'invalid-response',
          `${label}: service returned malformed payload`,
        );
      }
      return value;
    };
  };

  const handlers: Record<string, UtilityHandler> = {
    'sync:status': async () =>
      checked(isSyncStatusResult, 'sync:status')(await status()),

    'sync:pairing': async () => {
      if (listener !== 'listening') {
        throw shellError(
          'unavailable',
          `sync listener is ${listener}`,
        );
      }
      const ep = endpoint();
      if (ep === null) {
        throw shellError('unavailable', 'no LAN address to pair to');
      }
      const { code, expiresAt } = pairing.mint();
      badAttempts.clear(); // a fresh code means a fresh budget
      totalBadAttempts = 0;
      const payload = JSON.stringify({
        v: 1,
        endpoint: ep,
        // All LAN candidates, best first — a multi-homed host's
        // unreachable first interface can't strand the phone.
        endpoints: endpoints(),
        code,
        fp: fingerprint,
      });
      return checked(isSyncPairingResult, 'sync:pairing')({
        payload,
        code,
        expiresAt,
      });
    },

    'sync:devices': async () => {
      const { devices } = await deps.keys.deviceList();
      return checked(isSyncDevicesResult, 'sync:devices')({
        devices: devices.map((d) => ({
          id: d.id,
          name: d.name,
          pairedAt: d.pairedAt,
          lastSeenAt: d.lastSeenAt,
        })),
      });
    },

    'sync:unpair': async (args) => {
      if (!isSyncUnpairArgs(args) || !isDeviceId(args.id)) {
        throw shellError('invalid-request', 'sync:unpair expects {id}');
      }
      await deps.keys.deviceDelete(args.id);
      pendingSync.delete(args.id);
      kickDevice(args.id);
      // Library data stays — unpair revokes the key, nothing more.
      // undefined, not null — the preload boundary validates void as
      // strictly undefined.
      return undefined;
    },

    'sync:deltas': async (args) => {
      if (!isSyncDeltasArgs(args)) {
        throw shellError('invalid-request', 'sync:deltas expects {since}');
      }
      if (engine === undefined) {
        throw shellError('unavailable', 'sync engine not installed');
      }
      const result = await engine.exportDelta(
        args.since,
        serviceCancel.signal,
      );
      if (!result.ok) {
        throw engineError(result.error);
      }
      return checked(isSyncDeltasResult, 'sync:deltas')({
        delta: result.value,
      });
    },

    'sync:importDelta': async (args) => {
      if (!isSyncImportDeltaArgs(args)) {
        throw shellError(
          'invalid-request',
          'sync:importDelta expects {delta}',
        );
      }
      if (engine === undefined) {
        throw shellError('unavailable', 'sync engine not installed');
      }
      const applied = await engine.applyDelta(
        args.delta,
        args.deviceId ?? 'local-import',
        serviceCancel.signal,
      );
      if (!applied.ok) {
        throw engineError(applied.error);
      }
      recordApplied(applied.value);
      return checked(isSyncImportDeltaResult, 'sync:importDelta')({
        result: applied.value,
      });
    },

    'sync:trigger': async () => {
      // Mark offline devices pending FIRST, then do a final live pass
      // that sends + clears: a device that opened during the registry
      // await is caught by the pass and never left with a stale mark
      // (the reverse order would snapshot `live` before the await).
      let registryError: unknown;
      try {
        const { devices } = await deps.keys.deviceList();
        const live = new Set<string>();
        for (const session of sessions) {
          if (session.phase === 'open' && session.deviceId !== null) {
            live.add(session.deviceId);
          }
        }
        for (const device of devices) {
          if (!live.has(device.id)) {
            pendingSync.add(device.id);
          }
        }
      } catch (thrown) {
        registryError = thrown;
      }
      let sent = false;
      for (const session of sessions) {
        if (session.phase === 'open' && session.deviceId !== null) {
          // The mark clears only when the kick is accepted — a socket
          // dying mid-trigger must leave the device pending so its next
          // connection still gets the sync-request.
          if (sendSealed(session, { t: 'sync-request' })) {
            sent = true;
            pendingSync.delete(session.deviceId);
          }
        }
      }
      // A dead registry is NOT an empty one — after the live kick the
      // custody error still surfaces typed, never a false `pending`.
      if (registryError !== undefined) {
        throw isShellError(registryError)
          ? registryError
          : shellError('internal', 'sync:trigger registry read failed');
      }
      return checked(isSyncTriggerResult, 'sync:trigger')({
        triggered: sent,
        pending: pendingSync.size > 0,
      });
    },

    'sync:localChanges': async (args) => {
      if (!isSyncLocalChangesArgs(args)) {
        throw shellError(
          'invalid-request',
          'sync:localChanges expects {writes}',
        );
      }
      if (deps.localChanges === undefined) {
        throw shellError('unavailable', 'sync engine not installed');
      }
      const result = await deps.localChanges(
        args.writes,
        serviceCancel.signal,
      );
      if (!result.ok) {
        throw engineError(result.error);
      }
      return checked(isSyncLocalChangesResult, 'sync:localChanges')({
        result: result.value,
      });
    },

    'sync:drainApplied': async () =>
      checked(isSyncDrainAppliedResult, 'sync:drainApplied')(
        await drainAppliedChunk(),
      ),
  };

  const started = start()
    .then((status) => {
      resolveReady(status);
      return status;
    })
    .catch(async () => {
      listener = 'unavailable';
      try {
        const assembled = await status();
        resolveReady(assembled);
        return assembled;
      } catch {
        // Custody is down — status() can't assemble the count, but
        // ready must still resolve or the wiring hangs. listener:
        // 'unavailable' is the honest dominant signal; sync:status
        // calls keep failing typed against the same custody error.
        const degraded: SyncStatusResult = {
          listener,
          endpoint: endpoint(),
          boundPort,
          advertise: advertiseState,
          pairedDevices: 0,
          sessions: 0,
          lastSyncAt,
          engine: engine === undefined ? 'absent' : 'ready',
          name: deviceName,
          fingerprint,
        };
        resolveReady(degraded);
        return degraded;
      }
    });

  return {
    handlers,
    status,
    ready: started,
    async close() {
      if (closing) {
        return;
      }
      closing = true;
      serviceCancel.cancel();
      await started.catch(() => undefined);
      for (const session of [...sessions]) {
        killSession(session);
      }
      pairing.expire();
      if (advertiser !== null) {
        try {
          advertiser.close();
        } catch {
          // Best effort.
        }
        advertiser = null;
      }
      if (server !== null) {
        await new Promise<void>((resolve) => {
          server?.close(() => resolve());
        });
        server = null;
      }
    },
  };
}
