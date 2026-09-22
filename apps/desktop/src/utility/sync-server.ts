import { randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  CancellationSource,
  type AppError,
  type SyncEngine,
} from '@auqw/application';
import {
  hasOnlyKeys,
  isBoundedString,
  isRecord,
} from '../shared/check.ts';
import {
  isSyncDeltasArgs,
  isSyncDeltasResult,
  isSyncDeltaDoc,
  isSyncDevicesResult,
  isSyncImportDeltaArgs,
  isSyncImportDeltaResult,
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
import { isDeviceId, type SyncKeys } from './sync-keys.ts';
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
   * The merge engine — absent until the engine leg lands; delta
   * channels answer typed 'unavailable', pairing still works.
   */
  readonly engine?: SyncEngine;
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
    value['since'].length <= 256 &&
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

function pickLanIpv4(): string | null {
  let fallback: string | null = null;
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) {
        continue;
      }
      // Prefer a private LAN address — a VPN/tunnel/public interface
      // may be unreachable for the phone; keep it as fallback anyway
      // (a reachable non-LAN setup is better than an honest null).
      if (isPrivateLanIp(iface.address)) {
        return iface.address;
      }
      fallback ??= iface.address;
    }
  }
  return fallback;
}

/** '::ffff:a.b.c.d' is the same peer as 'a.b.c.d' — fold before keying. */
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const host = deps.host ?? '0.0.0.0';
  const handshakeCap = deps.handshakeCap ?? 16 * 1_024;
  const sessionCap = deps.sessionCap ?? 1_048_576;
  const maxConnections = deps.maxConnections ?? 16;
  const handshakeMs = deps.handshakeMs ?? 15_000;
  const idleMs = deps.idleMs ?? 120_000;
  const deviceName = deps.deviceName ?? 'auqw-desktop';
  const pairing = createPairing({
    nowMs,
    ttlMs: deps.codeTtlMs ?? 90_000,
  });
  // Wrong-code budget per remote address: an attacking peer exhausts
  // its own guesses while the pending code stays valid for every other
  // address — the legit phone's window can't be DoS'd away. Cleared on
  // each fresh mint and on successful pairing.
  const maxCodeAttempts = deps.maxCodeAttempts ?? 5;
  const badAttempts = new Map<string, number>();

  const sessions = new Set<Session>();
  const pendingSync = new Set<string>();
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

  function endpoint(): string | null {
    if (boundPort === null) {
      return null;
    }
    const ip = deps.endpointHost ?? pickLanIpv4();
    if (ip === null) {
      return null;
    }
    const formatted = ip.includes(':') ? `[${ip}]` : ip;
    return `${formatted}:${boundPort}`;
  }

  async function deviceCount(): Promise<number> {
    try {
      return (await deps.keys.deviceList()).devices.length;
    } catch {
      return 0;
    }
  }

  async function status(): Promise<SyncStatusResult> {
    return {
      listener,
      endpoint: endpoint(),
      boundPort,
      advertise: advertiseState,
      pairedDevices: await deviceCount(),
      sessions: [...sessions].filter((s) => s.phase === 'open').length,
      lastSyncAt,
      engine: deps.engine === undefined ? 'absent' : 'ready',
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

  /** AEAD overhead per frame: 12-byte iv + 16-byte auth tag. */
  const SEAL_OVERHEAD = 28;

  function sendSealed(session: Session, msg: unknown): void {
    const codec = session.codec;
    if (codec === null) {
      return;
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
      session.pump.send(codec.seal(err));
      return;
    }
    session.pump.send(codec.seal(plain));
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
      pendingSync.delete(session.deviceId)
    ) {
      sendSealed(session, { t: 'sync-request' });
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
      // A peer that already blew its code budget never reaches the
      // checker — a correct guess after the cap can't quietly pair.
      const misses = badAttempts.get(session.remoteIp) ?? 0;
      if (misses >= maxCodeAttempts) {
        reject('pairing-attempts');
        return;
      }
      const check = pairing.peek(msg.code);
      if (check === 'bad-code') {
        badAttempts.set(session.remoteIp, misses + 1);
        reject(
          misses + 1 >= maxCodeAttempts
            ? 'pairing-attempts'
            : 'bad-code',
        );
        return;
      }
      if (check !== 'ok') {
        reject(check);
        return;
      }
      const record = {
        id: session.deviceId,
        name: session.name,
        pub: session.devPub,
        fp: session.devFp ?? '',
        pairedAt: now,
        lastSeenAt: now,
      };
      try {
        await deps.keys.devicePut(record);
      } catch (thrown) {
        // Consume only AFTER the registry write — a transient custody
        // failure leaves the still-valid code open for retry.
        reject(
          isShellError(thrown) ? thrown.kind : 'internal',
        );
        return;
      }
      if (!pairing.consume(msg.code)) {
        // A racing session consumed it — the device is registered but
        // this connection never authenticates; it can resume instead.
        reject('no-pairing');
        return;
      }
      badAttempts.delete(session.remoteIp);
      sendSealed(session, {
        t: 'welcome',
        device: record,
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
        await deps.keys.devicePut(record);
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
        const engine = deps.engine;
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
          lastSyncAt = nowMs();
          sendSealed(session, { t: 'delta', delta: exported.value });
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
        advertiser = deps.advertise({ port: bound, name: deviceName });
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
      const payload = JSON.stringify({
        v: 1,
        endpoint: ep,
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
      const engine = deps.engine;
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
      const engine = deps.engine;
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
      return checked(isSyncImportDeltaResult, 'sync:importDelta')({
        result: applied.value,
      });
    },

    'sync:trigger': async () => {
      let sent = false;
      const live = new Set<string>();
      for (const session of sessions) {
        if (session.phase === 'open' && session.deviceId !== null) {
          live.add(session.deviceId);
          sendSealed(session, { t: 'sync-request' });
          sent = true;
        }
      }
      try {
        const { devices } = await deps.keys.deviceList();
        for (const device of devices) {
          if (!live.has(device.id)) {
            pendingSync.add(device.id);
          }
        }
      } catch {
        // A dead custody channel doesn't block the live kick.
      }
      return checked(isSyncTriggerResult, 'sync:trigger')({
        triggered: sent,
        pending: pendingSync.size > 0,
      });
    },
  };

  const started = start()
    .then((status) => {
      resolveReady(status);
      return status;
    })
    .catch(() => {
      listener = 'unavailable';
      return status().then((status) => {
        resolveReady(status);
        return status;
      });
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
