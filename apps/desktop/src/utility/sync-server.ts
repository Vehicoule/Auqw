import { randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import {
  attachSyncPump,
  CancellationSource,
  createSyncResponder,
  DEVICE_NAME_MAX,
  type CancellationSignal,
  type ResponderSession,
  type Result,
  type SyncDiscoveryPort,
  type SyncEnginePort,
  type SyncResponder,
  type SyncResponderCrypto,
  type SyncResponderDeps,
} from '@auqw/application';
import {
  hasOnlyKeys,
  isRecord,
} from '../shared/check.ts';
import {
  MAX_SYNC_CURSOR_CHARS,
  MAX_SYNC_DOC_BYTES,
  isSyncDeltaDoc,
  type SyncNearbyEvent,
  type SyncStatusResult,
} from '../shared/contract.ts';
import type { SyncDialer } from './sync-dialer.ts';
import {
  isShellError,
  shellError,
} from '../shared/errors.ts';
import type { UtilityHandler } from './router.ts';
import { nodeNoise } from './noise-node.ts';
import { createSpillJournal } from './sync-journal.ts';
import { createSyncHandlers } from './sync-handlers.ts';
import { type SyncDeviceRecord, type SyncKeys } from './sync-keys.ts';
import type { SyncIdentity } from '@auqw/application';

/**
 * The desktop half of LAN sync per docs/specs/sync.md: the desktop
 * advertises `_auqw._tcp.local` and listens; the phone dials.
 *
 * Wire phases per connection (frames are `[u32le len][payload]` via
 * the shared sync-wire pump; payloads are JSON plaintext until the
 * handshake seals them, then AEAD via the shared noise-v1 codec):
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
 * The responder half of that conversation — phase machine, pairing
 * store + attempt budgets, pair lock, reject-then-end teardown — is
 * the shared `createSyncResponder` driver in @auqw/application (the
 * phone's pair host runs the same one); this service layers the
 * desktop's own surface on top: the spill journal, the IPC handlers,
 * the sync-serving 'sync' wire surface, custody via SyncKeys, and the
 * listener/advertiser lifecycle.
 *
 * Everything user-facing surfaces typed `unavailable` — a dead
 * listener, no LAN address, or a failed mDNS announce never reports a
 * fake healthy status (spec: export/import is the fallback).
 */

interface SyncAdvertiser {
  close(): void;
}

/** mDNS announce seam — production wires bonjour; tests pass a fake. */
export type SyncAdvertise = (opts: {
  port: number;
  name: string;
  /** Identity fingerprint — TXT `dev`, lets browsers pin pre-dial. */
  fp: string;
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
  /** Cipher seam — defaults to the shared noise-v1 suite on node:crypto. */
  readonly cipher?: SyncResponderCrypto;
  /**
   * Wire-pump factory seam — defaults to the shared framed socket
   * pump. Tests wrap it to fault-inject send failures on live sessions.
   */
  readonly pump?: SyncResponderDeps<SyncDeviceRecord>['attach'];
  /** Display name for pairing payloads + mDNS — defaults to hostname. */
  readonly deviceName?: string;
  /**
   * This device's own sync id (the sync-log header id), resolved at
   * start — the welcome's `host.id` the caller echoes into custody.
   * Engine-absent hosts still pair: absent id → no `host` field.
   */
  readonly ownDeviceId?: Promise<string | null>;
  /**
   * Caller half — pair TO a phone-hosted offer (nearby tap or scanned
   * QR). The factory gets the resolved device name + the listener's
   * bound-port getter so the client's hello can carry a dialable
   * endpoint back to the phone.
   */
  readonly dialer?: (opts: {
    listenPort: () => number | null;
    listenEndpoints: () => readonly string[];
    deviceName: string;
  }) => SyncDialer;
  /** `_auqw._tcp` browse — powers the renderer's nearby list. */
  readonly discovery?: SyncDiscoveryPort | null;
  /** Push seam — found/lost events for the renderer's nearby list. */
  readonly notifyNearby?: (event: SyncNearbyEvent) => unknown;
  /**
   * `false` defers the listener and custody (the safeStorage read is
   * what fires the macOS Keychain ACL prompt on ad-hoc builds) until
   * the first sync handler actually runs. Undefined/true starts
   * eagerly — the fail-safe default, and what a previously-synced
   * install passes so paired devices keep finding this desktop.
   */
  readonly armed?: boolean;
  /** mDNS announce factory — null skips advertising entirely. */
  readonly advertise?: SyncAdvertise | null;
  /** Forced endpoint host for payloads; otherwise first LAN IPv4. */
  readonly endpointHost?: string;
  /**
   * Bound port of the bundled POT service — the pairing payload
   * carries it as `pot` (`host:port` on the primary endpoint host)
   * so a paired phone can mint tokens against this desktop. Null or
   * absent → no `pot` field (e.g. AUQW_POT_PROVIDER_URL override,
   * or the service failed to bind).
   */
  readonly potPort?: () => number | null;
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

/* --------------------- wire message validators -------------------- */

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

/* --------------------------- endpoints ---------------------------- */

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

/* -------------------------- the service --------------------------- */

export function createSyncService(deps: SyncServiceDeps): SyncService {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const host = deps.host ?? '0.0.0.0';
  const deviceName =
    deps.deviceName ??
    (hostname().trim().slice(0, DEVICE_NAME_MAX) || 'auqw-desktop');
  /**
   * The spec's on-change sync trigger (docs/specs/sync.md): committed
   * local writes debounce into one trigger pass that marks offline
   * devices pending and kicks live ones. start() fires one too, so a
   * phone that connects after launch still gets the round.
   */
  const AUTO_SYNC_DEBOUNCE_MS = 500;
  let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
  // Devices owed a sync-request kick — marked by trigger passes,
  // cleared when a live session takes the kick.
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
  // The engine carries no key material — resolve it eagerly so the
  // renderer's boot-time log drain works even on a dormant install.
  const engineReady = resolveEngine();
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
  let ownDeviceId: string | null = null;
  let lastSyncAt: number | null = null;
  let closing = false;
  let resolveReady!: (status: SyncStatusResult) => void;
  const ready = new Promise<SyncStatusResult>((resolve) => {
    resolveReady = resolve;
  });

  // Set inside start() once the identity is loaded — connections only
  // arrive after bind, so the responder never reads it before then.
  let syncCipher: SyncResponderCrypto = deps.cipher ?? {
    name: 'uninitialized',
    identity: { pub: '', priv: '' },
    accept() {
      throw shellError('internal', 'sync cipher not initialized');
    },
  };

  const journal = createSpillJournal({
    spillPath: deps.appliedSpillPath,
    notifyApplied: deps.notifyApplied,
  });

  /**
   * Every `ip:port` a phone could try, best first — `endpoint()`
   * stays the canonical primary for status display, the pairing
   * payload carries the full list.
   */
  function endpointHosts(): string[] {
    return deps.endpointHost !== undefined
      ? [deps.endpointHost]
      : lanIpv4s();
  }

  function endpoints(): string[] {
    if (boundPort === null) {
      return [];
    }
    return endpointHosts().map((ip) => {
      const formatted = ip.includes(':') ? `[${ip}]` : ip;
      return `${formatted}:${boundPort}`;
    });
  }

  function endpoint(): string | null {
    return endpoints()[0] ?? null;
  }

  /**
   * `host:port` for the bundled POT service on the primary endpoint
   * host — the same `endpoints()[0]` the phone dials for sync. The
   * service binds IPv4 wildcard only, so an IPv6 `endpointHost`
   * advertises nothing rather than a dead socket.
   */
  function potEndpoint(): string | null {
    const port = deps.potPort?.() ?? null;
    if (port === null) {
      return null;
    }
    const host = endpointHosts().find((h) => !h.includes(':'));
    return host === undefined ? null : `${host}:${port}`;
  }

  // Propagates custody failures — a dead registry is NOT an empty
  // one, and sync:status fails typed instead of reporting a healthy
  // pairedDevices: 0 that contradicts sync:devices.
  async function deviceCount(): Promise<number> {
    return (await deps.keys.deviceList()).devices.length;
  }

  /**
   * The answer observational reads give while dormant — no listener,
   * no custody read, no devices. Dormant means never paired (a paired
   * install's device records arm eager startup), so zero paired
   * devices is the truth, not a custody shortcut.
   */
  function idleStatus(
    state: SyncStatusResult['listener'],
  ): SyncStatusResult {
    return {
      listener: state,
      endpoint: null,
      boundPort: null,
      advertise: 'off',
      pairedDevices: 0,
      sessions: 0,
      lastSyncAt,
      engine: engine === undefined ? 'absent' : 'ready',
      name: deviceName,
      fingerprint,
    };
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
      sessions: [...responder.sessions].filter(
        (s) => s.phase === 'open',
      ).length,
      lastSyncAt,
      engine: engine === undefined ? 'absent' : 'ready',
      name: deviceName,
      fingerprint,
    };
  }

  function kickDevice(deviceId: string): void {
    for (const session of responder.sessions) {
      if (session.deviceId === deviceId) {
        responder.kill(session);
      }
    }
  }

  /** Kick any OTHER session bound to the same key — stale ids die. */
  function kickStaleFp(session: ResponderSession): void {
    for (const other of responder.sessions) {
      if (
        other !== session &&
        other.devFp !== null &&
        other.devFp === session.devFp
      ) {
        responder.kill(other);
      }
    }
  }

  /**
   * The open-phase 'sync' surface the responder serves on the
   * desktop — applyDelta the caller's doc (write-through to the
   * durable outbox before the ack), then exportDelta what it asked
   * for. Anything else the peer sends is the driver's own dispatch.
   */
  async function onSync(
    session: ResponderSession,
    msg: { readonly t: string },
  ): Promise<void> {
    if (!isSyncReq(msg)) {
      responder.send(session, { t: 'error', code: 'bad-request' });
      return;
    }
    if (engine === undefined) {
      responder.send(session, { t: 'error', code: 'engine-absent' });
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
          responder.send(session, {
            t: 'error',
            code: applied.error.kind,
          });
          return;
        }
        // Write-through: the durable outbox append must land
        // before the export answers — an acknowledged delta's
        // outcomes can't die with renderer memory.
        await journal.record(applied.value);
      }
      const exported = await engine.exportDelta(
        msg.since,
        session.cancel.signal,
      );
      if (!exported.ok) {
        responder.send(session, {
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
        responder.send(session, {
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
        responder.send(session, {
          t: 'error',
          code: 'invalid-response',
        });
        return;
      }
      lastSyncAt = nowMs();
      responder.send(session, { t: 'delta', delta: reparsed });
    } catch {
      responder.send(session, { t: 'error', code: 'internal' });
    }
  }

  /**
   * The SessionTable + PairingStore collaborators — the shared
   * responder driver runs the hello→auth→open machine, the mint +
   * attempt budgets, and the pair lock; the service supplies its
   * custody seam (SyncKeys), record shape, welcome extras, and the
   * sync-serving open surface.
   */
  const responder: SyncResponder = createSyncResponder<SyncDeviceRecord>({
    crypto: () => syncCipher,
    attach: deps.pump ?? attachSyncPump,
    name: deviceName,
    // The strict hello guard — canonical SPKI X25519 material, never
    // trusted on shape alone.
    isHello: nodeNoise.isClientHello,
    fingerprintOf: nodeNoise.fingerprintOf,
    mintCode: () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
    nowMs,
    armTimer: (ms, fire) => {
      const timer = setTimeout(fire, ms);
      return {
        cancel: () => {
          clearTimeout(timer);
        },
      };
    },
    decodeJson: (payload) =>
      JSON.parse(Buffer.from(payload).toString('utf8')),
    custody: {
      async find(fp) {
        try {
          const { devices } = await deps.keys.deviceList();
          const prior = devices.find((d) => d.fp === fp);
          return {
            ok: true,
            value:
              prior === undefined
                ? null
                : { id: prior.id, pairedAt: prior.pairedAt },
          };
        } catch {
          return { ok: false };
        }
      },
      async put(record) {
        try {
          await deps.keys.devicePut(record);
          return { ok: true };
        } catch (thrown) {
          return {
            ok: false,
            reason: isShellError(thrown) ? thrown.kind : 'internal',
          };
        }
      },
      async touch(record) {
        try {
          // Update iff still registered — the hello-time custody read
          // races a concurrent unpair, and an unconditional put would
          // resurrect a revoked device.
          return { ok: true, updated: await deps.keys.deviceTouch(record) };
        } catch {
          return { ok: false };
        }
      },
    },
    buildPeer: (session, kind, now) => ({
      role: 'caller',
      // 'pair' keeps the caller's claimed id; 'resume' is pinned to
      // the id custody already binds to this key.
      id:
        kind === 'pair'
          ? session.deviceId ?? ''
          : session.registeredId ?? '',
      name: session.name,
      pub: session.devPub,
      fp: session.devFp ?? '',
      pairedAt: kind === 'pair' ? now : session.pairedAtMs ?? now,
      lastSeenAt: now,
    }),
    async ownDeviceRows(session) {
      try {
        const { devices } = await deps.keys.deviceList();
        // The wire exposes only the caller's own record — every
        // other device's id, name, and activity stays renderer-local
        // (api.sync.devices), not a free registry dump for any key
        // holder.
        return {
          ok: true,
          value: devices
            .filter((d) => d.id === session.deviceId)
            .map((d) => ({
              id: d.id,
              name: d.name,
              pairedAt: d.pairedAt,
              lastSeenAt: d.lastSeenAt,
            })),
        };
      } catch {
        return { ok: false };
      }
    },
    welcomeExtra: () => {
      // The minter advertisement rides the welcome — a guest that
      // paired by typed code (no QR payload) learns it here, and a
      // rebound ephemeral minter port heals on the next resume.
      const pot = potEndpoint();
      return {
        ...(ownDeviceId === null
          ? {}
          : {
              host: {
                id: ownDeviceId,
                name: deviceName,
                pub: syncCipher.identity.pub,
              },
            }),
        ...(pot !== null ? { pot } : {}),
      };
    },
    onSync,
    onPair: (session, record) => {
      // Re-pair under a new id evicted the old record — drop its
      // pending mark too, or triggers report work no device can clear.
      if (
        session.registeredId !== null &&
        session.registeredId !== record.id
      ) {
        pendingSync.delete(session.registeredId);
      }
      // The shown code is dead the moment it's consumed — poke any
      // open pairing sheet to remint before its expiry timer would.
      try {
        deps.notifyNearby?.({ type: 'paired' });
      } catch {
        // push is best-effort
      }
    },
    afterOpen: (session) => {
      kickStaleFp(session);
      // A device marked pending while offline takes its kick the
      // moment its session opens — but the mark clears only when the
      // frame is accepted, so a dead socket keeps the debt.
      if (
        session.deviceId !== null &&
        pendingSync.has(session.deviceId) &&
        responder.send(session, { t: 'sync-request' })
      ) {
        pendingSync.delete(session.deviceId);
      }
    },
    codeTtlMs: deps.codeTtlMs ?? 90_000,
    handshakeCap: deps.handshakeCap,
    sessionCap: deps.sessionCap,
    maxConnections: deps.maxConnections,
    handshakeMs: deps.handshakeMs,
    idleMs: deps.idleMs,
    maxCodeAttempts: deps.maxCodeAttempts,
    maxTotalCodeAttempts: deps.maxTotalCodeAttempts,
  });

  async function start(): Promise<SyncStatusResult> {
    // An async engine resolves before anything reads the seam —
    // status then answers 'ready'/'absent' truthfully even when the
    // listener is disabled.
    await engineReady;
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
    if (identity !== null && !nodeNoise.isUsableIdentity(identity)) {
      identity = null;
      replace = true;
    }
    if (identity === null) {
      identity = nodeNoise.createIdentity();
      if (replace) {
        await deps.keys.identityReplace(identity);
      } else {
        await deps.keys.identitySet(identity);
      }
    }
    syncCipher = deps.cipher ?? nodeNoise.responderCrypto(identity);
    fingerprint = nodeNoise.fingerprintOf(identity.pub);
    ownDeviceId = deps.ownDeviceId === undefined
      ? null
      : await deps.ownDeviceId.catch(() => null);
    server = createServer((socket) => responder.accept(socket));
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
    // On-launch trigger (docs/specs/sync.md): mark every paired device
    // pending so the next connect gets the sync-request kick, and kick
    // any session that somehow already opened.
    scheduleAutoTrigger();
    if (deps.advertise !== undefined && deps.advertise !== null) {
      try {
        advertiser = deps.advertise({
          port: bound,
          name: deviceName,
          fp: fingerprint,
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

  /**
   * One trigger pass: mark offline devices pending FIRST, then a
   * final live pass that sends + clears — a device that opened during
   * the registry await is caught by the pass and never left with a
   * stale mark (the reverse order would snapshot `live` before the
   * await). Shared by the IPC handler and the debounced auto-trigger.
   */
  async function triggerSync(): Promise<{
    triggered: boolean;
    pending: boolean;
  }> {
    let registryError: unknown;
    try {
      const { devices } = await deps.keys.deviceList();
      const live = new Set<string>();
      for (const session of responder.sessions) {
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
    const delivered = new Set<string>();
    const refused = new Set<string>();
    for (const session of responder.sessions) {
      if (session.phase === 'open' && session.deviceId !== null) {
        if (responder.send(session, { t: 'sync-request' })) {
          delivered.add(session.deviceId);
        } else {
          refused.add(session.deviceId);
        }
      }
    }
    // The mark clears only when a kick is accepted — a socket that
    // refuses the frame (dying mid-trigger, wedged writer) leaves the
    // device pending so its next connection still gets the
    // sync-request. One accepted sibling session is enough — refused
    // marks apply only when no live session took the kick.
    for (const id of delivered) {
      pendingSync.delete(id);
    }
    for (const id of refused) {
      if (!delivered.has(id)) {
        pendingSync.add(id);
      }
    }
    const sent = delivered.size > 0;
    // A dead registry is NOT an empty one — after the live kick the
    // custody error still surfaces typed, never a false `pending`.
    if (registryError !== undefined) {
      throw isShellError(registryError)
        ? registryError
        : shellError('internal', 'sync:trigger registry read failed');
    }
    return { triggered: sent, pending: pendingSync.size > 0 };
  }

  /**
   * Debounced auto-trigger — trailing edge, matching the mobile
   * scheduler: each write re-arms the wake so a sustained burst
   * fires once when it goes quiet instead of mid-burst.
   */
  function scheduleAutoTrigger(): void {
    if (closing) {
      return;
    }
    if (autoSyncTimer !== null) {
      clearTimeout(autoSyncTimer);
    }
    autoSyncTimer = setTimeout(() => {
      autoSyncTimer = null;
      void triggerSync().catch(() => {
        // The writes already landed in the log — a failed pass only
        // means the phone learns on its own next round.
      });
    }, AUTO_SYNC_DEBOUNCE_MS);
  }

  /**
   * The engine's materialized record view, byte-paged — the durable
   * recovery path for any outcome stream the outbox lost (drained
   * before ack, evicted, pre-durability version). Records aren't
   * consumed, so no ack exists.
   *
   * One reconcile pass pages a SINGLE snapshot: a fresh `materialize()`
   * per offset would let a concurrent merge shift every later offset —
   * pages would duplicate or omit records mid-pass (Review #46). The
   * snapshot is taken lazily at the pass's first pull, reused for the
   * rest, and dropped when the pass completes or a new pass restarts
   * at offset 0. Merges landing mid-pass aren't lost — their outcomes
   * still flow through the normal applied drain.
   */
  let materializedSnapshot: readonly unknown[] | null = null;
  function materializedChunk(offset: number): {
    readonly records: readonly unknown[];
    readonly nextOffset: number | null;
  } {
    const start = Math.max(0, Math.floor(offset));
    if (start === 0 || materializedSnapshot === null) {
      materializedSnapshot = engine?.materialize?.() ?? [];
    }
    const all = materializedSnapshot;
    const budget = MAX_SYNC_DOC_BYTES - 16_384;
    const page: unknown[] = [];
    let bytes = 2;
    let i = start;
    for (; i < all.length; i += 1) {
      const rec = all[i];
      const size = Buffer.byteLength(JSON.stringify(rec), 'utf8') + 1;
      if (bytes + size > budget) {
        if (page.length === 0) {
          // A lone oversized record can never fit — skip it rather
          // than wedge the pull.
          continue;
        }
        break;
      }
      bytes += size;
      page.push(rec);
    }
    const nextOffset = i < all.length ? i : null;
    if (nextOffset === null) {
      // Pass complete — the next offset-0 pull re-snapshots so a later
      // reconcile sees merges that landed after this pass started.
      materializedSnapshot = null;
    }
    return { records: page, nextOffset };
  }

  // Custody access is deferred until an explicit sync action — a
  // dormant install never touches safeStorage, so the macOS Keychain
  // prompt only fires once the user actually pairs. An `armed`
  // install (paired-device records exist) starts eagerly as before —
  // paired devices expect to find the listener.
  let startPromise: Promise<SyncStatusResult> | null = null;
  function ensureStarted(): Promise<SyncStatusResult> {
    if (closing) {
      // A late request must not bind a listener after teardown — a
      // second close() is a no-op and the socket would leak.
      return Promise.reject(
        shellError('cancelled', 'sync service closed'),
      );
    }
    startPromise ??= start()
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
    return startPromise;
  }

  /* -------------------------- handlers ---------------------------- */

  const { handlers, browse } = createSyncHandlers({
    deps,
    responder,
    journal,
    service: {
      engine: () => engine,
      engineReady,
      cancel: serviceCancel.signal,
      started: () => startPromise !== null,
      closing: () => closing,
      listener: () => listener,
      endpoint,
      endpoints,
      potEndpoint,
      fingerprint: () => fingerprint,
      boundPort: () => boundPort,
      deviceName,
      status,
      idleStatus,
      ensureStarted,
      triggerSync,
      scheduleAutoTrigger,
      kickDevice,
      materialized: materializedChunk,
      pendingSync,
    },
  });

  if (deps.armed !== false) {
    void ensureStarted();
  }

  return {
    handlers,
    status,
    // Resolves once the service has actually run — a dormant install
    // (armed === false, no sync use yet) has no ready status.
    ready,
    async close() {
      if (closing) {
        return;
      }
      closing = true;
      serviceCancel.cancel();
      if (autoSyncTimer !== null) {
        clearTimeout(autoSyncTimer);
        autoSyncTimer = null;
      }
      if (startPromise === null) {
        // Never started — settle `ready` so a dormant awaiter doesn't
        // hang, and mark the listener terminally unavailable: the
        // closing guard above blocks any post-close ensureStarted.
        listener = 'unavailable';
        resolveReady(idleStatus('unavailable'));
      }
      await (startPromise ?? Promise.resolve()).catch(() => undefined);
      // Sessions die first — no handler can queue new spill work, so
      // settle the tail before tearing down: a mid-flight drain's
      // offset write or compaction must not survive close()
      // (Review #46 round-10).
      responder.teardown();
      await journal.settle();
      browse.close();
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
