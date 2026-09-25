import { randomInt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  appendFile,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
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
  isSyncMaterializedArgs,
  isSyncMaterializedResult,
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
   * here until the renderer pulls `sync:drainApplied`. Durable mode
   * (`appliedSpillPath` set — always in production): outcomes append
   * to the JSONL spill BEFORE the applyDelta ack goes out (the
   * caller awaits `recordApplied`), so an acknowledged delta can
   * never lose its projection work — same durability horizon as the
   * sync log itself. Drain PEEKS (read only); `sync:ackApplied`
   * consumes the served lines after the renderer confirms its domain
   * commit — crash windows collapse to at-least-once redelivery,
   * which the projector's materialized snapshots make idempotent.
   * Volatile mode (no path — tests) keeps an in-memory FIFO consumed
   * at drain, bounded drop-oldest.
   */
  const APPLIED_OUTBOX_MAX = 4_096;
  const appliedOutbox: unknown[] = [];
  let appliedDropped = false;
  /** Serializes spill appends against drain reads and ack rewrites. */
  let spillTail: Promise<unknown> = Promise.resolve();
  /** Bytes served by the most recent drain, awaiting ack. */
  let awaitingAckBytes = 0;

  /**
   * Incremental line walk over the spill starting at `startOff` —
   * memory bounded by the page budget, not the backlog: served lines
   * stop at the budget but the walk keeps counting for `remaining`.
   * `servedBytes` is the exact byte length the ack advances the
   * durable offset by (line + its newline).
   */
  async function spillScan(
    path: string,
    startOff: number,
    budgetBytes: number,
  ): Promise<{
    readonly served: readonly string[];
    readonly servedBytes: number;
    readonly totalLines: number;
    readonly skippedLines: number;
  }> {
    const served: string[] = [];
    let servedBytes = 0;
    let totalLines = 0;
    let skippedLines = 0;
    let fits = true;
    const take = (line: string): void => {
      totalLines += 1;
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (fits && servedBytes + lineBytes <= budgetBytes) {
        served.push(line);
        servedBytes += lineBytes;
        return;
      }
      if (served.length === 0 && servedBytes === 0) {
        // Poison line: bigger than the whole page, so NO offset ever
        // fits it — leaving it would wedge the drain forever
        // (Review #46 round-9). Consume its bytes so the ack
        // advances past it; the dropped flag surfaces the loss and
        // the materialized reconcile rebuilds the row anyway.
        servedBytes += lineBytes;
        skippedLines += 1;
        return;
      }
      fits = false;
    };
    const stream = createReadStream(path, { start: startOff });
    stream.setEncoding('utf8');
    let carry = '';
    try {
      for await (const chunk of stream) {
        let buf = carry + (chunk as string);
        carry = '';
        for (;;) {
          const nl = buf.indexOf('\n');
          if (nl < 0) {
            break;
          }
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.length > 0) {
            take(line);
          }
        }
        carry = buf;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { served: [], servedBytes: 0, totalLines: 0, skippedLines: 0 };
      }
      throw e;
    }
    if (carry.length > 0) {
      take(carry);
    }
    return { served, servedBytes, totalLines, skippedLines };
  }

  /** The ack sidecar: the byte offset the served prefix ends at. */
  function spillOffsetPath(path: string): string {
    return `${path}.off`;
  }

  /**
   * Durable ack position for the spill, in bytes. A sidecar past EOF
   * is stale — a crash between a compact's rename and its offset
   * reset — so rescan from 0: the compacted file already starts at
   * the old offset and re-serving is correct, not a duplicate.
   */
  async function readSpillOffset(
    offPath: string,
    path: string,
  ): Promise<number> {
    const raw = await readFile(offPath, 'utf8').catch(() => '');
    const off = Number.parseInt(raw.trim(), 10);
    if (!Number.isSafeInteger(off) || off < 0) {
      return 0;
    }
    const size = await stat(path)
      .then((s) => s.size)
      .catch(() => 0);
    return off > size ? 0 : off;
  }

  /**
   * Drop the consumed prefix by streaming the rest into a fresh file
   * — bounded IO per ack: only runs once the dead prefix dominates
   * the file, so each byte is rewritten O(1) times across the
   * backlog's life instead of the whole remainder per page.
   */
  /**
   * fsync a file's current contents — used before the renames that
   * commit a compaction, so a power-loss can't resurrect a torn
   * generation boundary.
   */
  async function fsyncFile(path: string): Promise<void> {
    const fh = await open(path, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async function compactSpill(
    path: string,
    offPath: string,
    startOff: number,
  ): Promise<void> {
    // Commit the zeroed sidecar BEFORE the compacted file: the only
    // bad generation state would be `off > 0` beside the NEW layout
    // (the offset was measured against the old one and would skip
    // unserved rows — Review #46 round-8). Resetting first means a
    // crash mid-compact leaves `off = 0` + the OLD file → rescan
    // and re-serve a prefix (at-least-once, which the projection
    // tolerates), never a stale offset on the new file.
    const offTmp = `${offPath}.tmp`;
    await writeFile(offTmp, '0');
    await fsyncFile(offTmp);
    await rename(offTmp, offPath);
    const tmp = `${path}.tmp`;
    await pipeline(
      createReadStream(path, { start: startOff }),
      createWriteStream(tmp),
    );
    await fsyncFile(tmp);
    await rename(tmp, path);
  }

  function notifyApplied(pending: number): void {
    try {
      void Promise.resolve(deps.notifyApplied?.(pending)).catch(
        () => undefined,
      );
    } catch {
      // The push path is a hint — the pull drain never depends on it.
    }
  }

  function recordApplied(result: unknown): Promise<void> {
    if (!isRecord(result) || !Array.isArray(result['outcomes'])) {
      return Promise.resolve();
    }
    const collected: unknown[] = [];
    for (const outcome of result['outcomes']) {
      if (
        !isRecord(outcome) ||
        outcome['type'] !== 'applied' ||
        !isJsonValue(outcome)
      ) {
        continue;
      }
      collected.push(outcome);
    }
    if (collected.length === 0) {
      return Promise.resolve();
    }
    const path = deps.appliedSpillPath;
    if (path !== undefined) {
      const lines = `${collected.map((o) => JSON.stringify(o)).join('\n')}\n`;
      const append = spillTail.then(() => appendFile(path, lines));
      spillTail = append.then(
        () => undefined,
        () => {
          appliedDropped = true;
        },
      );
      notifyApplied(collected.length);
      return append.catch(() => {
        appliedDropped = true;
      });
    }
    for (const outcome of collected) {
      appliedOutbox.push(outcome);
      if (appliedOutbox.length > APPLIED_OUTBOX_MAX) {
        appliedOutbox.shift();
        appliedDropped = true;
      }
    }
    notifyApplied(collected.length);
    return Promise.resolve();
  }

  /**
   * One byte-bounded pull: pack outcomes until the encoded payload
   * would approach `MAX_SYNC_DOC_BYTES`, leaving headroom for the
   * envelope keys. Spill lines serve before the memory queue (FIFO
   * across both). The read is a PEEK — served file lines stay on
   * disk until `ackApplied` confirms the renderer's domain commit,
   * so a crash between serve and commit replays rather than loses
   * (the projector's snapshots keep replay idempotent). Corrupt or
   * oversized file lines count as served so the ack can drop them —
   * a poison head must not block the queue forever.
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
        // The contract validates the RESULT in UTF-8 bytes — string
        // length undercounts multi-byte metadata, and an over-budget
        // chunk is rejected AFTER these entries were dequeued.
        return Buffer.byteLength(JSON.stringify(next), 'utf8') + 1;
      } catch {
        return -1;
      }
    };

    const path = deps.appliedSpillPath;
    let spilledBacklog = 0;
    let servedFileBytes = 0;
    if (path !== undefined) {
      // Peek inside `spillTail` so a concurrent append or ack rewrite
      // can't interleave with the read — and scan incrementally so a
      // huge backlog can't exhaust utility memory (Review #46).
      const drainFile = spillTail.then(async () => {
        const offPath = spillOffsetPath(path);
        const off = await readSpillOffset(offPath, path);
        const scan = await spillScan(path, off, budget - bytes);
        servedFileBytes = scan.servedBytes;
        // A page that served ONLY poison skips holds nothing the
        // renderer could commit — the durable offset advances now,
        // inside the serialized tail, or the same line re-scans on
        // every later drain (the ack path waits on served bytes;
        // Review #46 round-9).
        if (scan.skippedLines > 0 && scan.served.length === 0) {
          servedFileBytes = 0;
          await advanceSpillOffset(path, offPath, off + scan.servedBytes);
        }
        for (const line of scan.served) {
          try {
            const parsed: unknown = JSON.parse(line);
            if (isJsonValue(parsed)) {
              bytes += Buffer.byteLength(line, 'utf8') + 1;
              chunk.push(parsed);
            } else {
              appliedDropped = true;
            }
          } catch {
            // Torn tail line (killed mid-append) — count it served so
            // the ack drops it rather than poison-blocking the queue.
            appliedDropped = true;
          }
        }
        // Poison-skipped lines were consumed without being served —
        // they are neither backlog nor deliverable; the dropped flag
        // reports the loss honestly (materialized reconcile covers).
        if (scan.skippedLines > 0) {
          appliedDropped = true;
        }
        spilledBacklog =
          scan.totalLines - scan.served.length - scan.skippedLines;
      });
      spillTail = drainFile.then(
        () => undefined,
        () => undefined,
      );
      await drainFile;
    }
    awaitingAckBytes = servedFileBytes;

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
   * Advance the durable offset: persist the new position first, then
   * compact the dead prefix once it dominates the file — linear
   * recovery, never quadratic. Shared by the renderer ack and the
   * drain's poison-skip self-advance.
   */
  async function advanceSpillOffset(
    path: string,
    offPath: string,
    newOff: number,
  ): Promise<void> {
    await writeFile(offPath, String(newOff));
    const size = await stat(path)
      .then((s) => s.size)
      .catch(() => 0);
    if (newOff >= Math.max(1_048_576, size / 2)) {
      await compactSpill(path, offPath, newOff);
    }
  }

  /**
   * Consume the file bytes the most recent drain served — called by
   * the renderer only after its domain commit landed, so served
   * outcomes leave durable storage exactly once they're reflected
   * downstream. The ack persists a byte-offset sidecar (tiny write)
   * instead of rewriting the whole remainder; the dead prefix is
   * compacted only once it dominates the file, so recovery stays
   * linear rather than quadratic (Review #46). A failed ack must
   * REJECT, not swallow: the served prefix stays on disk either way,
   * but the renderer's drain loop stops here instead of re-fetching
   * the same page forever.
   */
  async function ackApplied(): Promise<void> {
    const path = deps.appliedSpillPath;
    const dropBytes = awaitingAckBytes;
    awaitingAckBytes = 0;
    if (path === undefined || dropBytes === 0) {
      return;
    }
    const offPath = spillOffsetPath(path);
    const rewrite = spillTail.then(async () => {
      const off = await readSpillOffset(offPath, path);
      await advanceSpillOffset(path, offPath, off + dropBytes);
    });
    spillTail = rewrite.then(
      () => undefined,
      () => undefined,
    );
    await rewrite.catch(() => {
      throw shellError(
        'io-error',
        'sync applied ack could not persist; drain stopped',
      );
    });
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
        // Records this put can displace — a same-id registration (a
        // live re-pair) or a same-fp record custody dedupes away. The
        // consume-fail rollback must restore them, not leave the phone
        // unpaired behind a still-valid prior registration.
        const { devices: displaced } = await deps.keys
          .deviceList()
          .then((list) => ({
            devices: list.devices.filter(
              (d) => d.id === record.id || (d.fp !== '' && d.fp === record.fp),
            ),
          }))
          .catch(() => ({ devices: [] as SyncDeviceRecord[] }));
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
          // Mint/expire run off-lock, so a peek-ok can still lose —
          // the durable record must not stand: a 'no-pairing' reply
          // with the record kept would grant the phone sync access
          // through the resume path despite the failed pair.
          await deps.keys.deviceDelete(record.id).catch(() => undefined);
          for (const prior of displaced) {
            await deps.keys.devicePut(prior).catch(() => undefined);
          }
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
      const pairPot = potEndpoint();
      sendSealed(session, {
        t: 'welcome',
        device: outcome.record,
        name: deviceName,
        // The minter advertisement rides the welcome too — a guest
        // that paired by typed code (no QR payload) learns it here.
        ...(pairPot !== null ? { pot: pairPot } : {}),
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
      const resumePot = potEndpoint();
      sendSealed(session, {
        t: 'welcome',
        device: record,
        name: deviceName,
        // Refreshed every resume: a rebound ephemeral minter port
        // heals the stored peer record on the next sync connect.
        ...(resumePot !== null ? { pot: resumePot } : {}),
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
            // Write-through: the durable outbox append must land
            // before the export answers — an acknowledged delta's
            // outcomes can't die with renderer memory.
            await recordApplied(applied.value);
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
      const pot = potEndpoint();
      const payload = JSON.stringify({
        v: 1,
        endpoint: ep,
        // All LAN candidates, best first — a multi-homed host's
        // unreachable first interface can't strand the phone.
        endpoints: endpoints(),
        code,
        fp: fingerprint,
        ...(pot !== null ? { pot } : {}),
      });
      return checked(isSyncPairingResult, 'sync:pairing')({
        payload,
        code,
        endpoint: ep,
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
      await recordApplied(applied.value);
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
      // Small ack only — the caller discards per-write results, and
      // echoing the appended batch would overflow the result cap
      // after the writes already landed (Review #46 round-9).
      return checked(isSyncLocalChangesResult, 'sync:localChanges')({
        accepted: Array.isArray(result.value)
          ? result.value.length
          : args.writes.length,
      });
    },

    'sync:drainApplied': async () =>
      checked(isSyncDrainAppliedResult, 'sync:drainApplied')(
        await drainAppliedChunk(),
      ),

    'sync:ackApplied': async () => {
      await ackApplied();
      return undefined;
    },

    'sync:materialized': async (args) => {
      if (!isSyncMaterializedArgs(args)) {
        throw shellError(
          'invalid-request',
          'sync:materialized expects {offset}',
        );
      }
      return checked(isSyncMaterializedResult, 'sync:materialized')(
        materializedChunk(args.offset),
      );
    },
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
      // Sessions are dead — no handler can queue new spill work, so
      // settle the tail before tearing down: a mid-flight drain's
      // offset write or compaction must not survive close()
      // (Review #46 round-10).
      await spillTail.then(
        () => undefined,
        () => undefined,
      );
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
