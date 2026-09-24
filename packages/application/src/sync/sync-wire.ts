import {
  hasExactKeys,
  hasKeys,
  isRecord,
  isString,
} from '../domain.ts';
import { appError, type AppError, type ErrorKind } from '../errors.ts';
import type { SyncSocket } from '../ports/sync-transport.ts';
import { isSyncCursor, type SyncCursor } from './sync-engine.ts';

/**
 * The phone-side view of the LAN wire (apps/desktop/src/utility/
 * sync-wire.ts + sync-server.ts are the server's implementation; this
 * file is the client's mirror — same `[u32le len][payload]` framing,
 * same phase caps, same validators, Buffer-free so it runs under RN).
 *
 * Wire phases per connection:
 *
 *   C→S hello      {v:1,kind:'hello',deviceId,name,eph,dev}
 *   S→C challenge  {v:1,kind:'challenge',eph,salt,spub,registered}
 *   C→S auth       {t:'pair',code} | {t:'resume'}             (sealed)
 *   S→C welcome    {t:'welcome',device,name} | {t:'reject',reason}
 *   open           ping/pong, devices, sync/delta,
 *                  sync-request (S→C kick), bye, error       (sealed)
 */

export const WIRE_VERSION = 1;

/** Cap while unauthenticated — mirrors the server's handshake cap. */
export const HANDSHAKE_CAP = 16 * 1_024;
/** Must match contract.ts's MAX_SYNC_DOC_BYTES. */
export const MAX_SYNC_DOC_BYTES = 1_048_576;
/** AEAD overhead per frame: 12-byte iv + 16-byte auth tag. */
export const SEAL_OVERHEAD = 28;
/** Post-auth cap — the same budget the server grants on accept. */
export const SESSION_CAP = MAX_SYNC_DOC_BYTES + SEAL_OVERHEAD + 4_096;

/** `since` never crosses 256 on the wire (isSyncReq). */
export const MAX_SINCE_CHARS = 256;

export const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,63}$/;
export const DEVICE_NAME_MAX = 128;
export const PAIR_CODE_PATTERN = /^[0-9]{6}$/;
export const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const B64_SPKI_MAX = 128;

/* ------------------------------ types ----------------------------- */

export type ClientHello = {
  readonly v: number;
  readonly kind: 'hello';
  readonly deviceId: string;
  readonly name: string;
  /** Client ephemeral X25519 SPKI, base64. */
  readonly eph: string;
  /** Client long-lived device X25519 SPKI, base64. */
  readonly dev: string;
};

export type ServerChallenge = {
  readonly v: number;
  readonly kind: 'challenge';
  /** Server ephemeral X25519 SPKI, base64. */
  readonly eph: string;
  readonly salt: string;
  /** Server long-lived X25519 SPKI, base64 — fingerprint source. */
  readonly spub: string;
  readonly registered: boolean;
};

/** The server's record of THIS device inside its registry. */
export type SyncDeviceRecord = {
  readonly id: string;
  readonly name: string;
  readonly pub: string;
  readonly fp: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
};

export type WelcomeMsg = {
  readonly t: 'welcome';
  readonly device: SyncDeviceRecord;
  /** The server's display name. */
  readonly name: string;
  /**
   * The server's bundled POT provider (`host:port`), sent on the
   * connection that actually answered — the authoritative
   * advertisement, refreshed every welcome so a rebound minter
   * port heals the stored peer record.
   */
  readonly pot?: string;
};

export type RejectMsg = { readonly t: 'reject'; readonly reason: string };
export type PongMsg = { readonly t: 'pong' };
export type SyncRequestMsg = { readonly t: 'sync-request' };
export type ByeMsg = { readonly t: 'bye' };
export type ErrorMsg = { readonly t: 'error'; readonly code: string };

/** Only the caller's own record — the wire never dumps the registry. */
export type DevicesMsg = {
  readonly t: 'devices';
  readonly devices: readonly SyncDeviceSummary[];
};
export type SyncDeviceSummary = {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
};

export type DeltaMsg = { readonly t: 'delta'; readonly delta: unknown };

export type ServerMsg =
  | WelcomeMsg
  | RejectMsg
  | PongMsg
  | DevicesMsg
  | DeltaMsg
  | SyncRequestMsg
  | ByeMsg
  | ErrorMsg;

/** The QR/typed-code pairing payload the server mints. */
export type SyncPairingPayload = {
  readonly v: number;
  /** Preferred `host:port`. */
  readonly endpoint: string;
  /** Every advertised `host:port`, best first. */
  readonly endpoints: readonly string[];
  readonly code: string;
  /** sha256(server SPKI DER) hex — the dial-time identity pin. */
  readonly fp: string;
  /**
   * Bundled POT service's `host:port` on the same endpoint host —
   * present only when the desktop bound its minter. Persisted on
   * the peer record so the host's PluginHost gets a provider URL.
   */
  readonly pot?: string;
};

export type SyncEndpoint = {
  readonly host: string;
  readonly port: number;
};

/* ---------------------------- validators -------------------------- */

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFp(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}

export function isServerChallenge(
  value: unknown,
): value is ServerChallenge {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['v', 'kind', 'eph', 'salt', 'spub', 'registered']) &&
    value['v'] === WIRE_VERSION &&
    value['kind'] === 'challenge' &&
    isString(value['eph'], B64_SPKI_MAX) &&
    isString(value['salt'], 128) &&
    isString(value['spub'], B64_SPKI_MAX) &&
    typeof value['registered'] === 'boolean'
  );
}

export function isSyncDeviceRecord(
  value: unknown,
): value is SyncDeviceRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'id',
      'name',
      'pub',
      'fp',
      'pairedAt',
      'lastSeenAt',
    ]) &&
    isString(value['id'], 64) &&
    DEVICE_ID_PATTERN.test(value['id']) &&
    isString(value['name'], DEVICE_NAME_MAX) &&
    isString(value['pub'], B64_SPKI_MAX) &&
    isFp(value['fp']) &&
    isSafeNonNegative(value['pairedAt']) &&
    isSafeNonNegative(value['lastSeenAt'])
  );
}

export function isWelcomeMsg(value: unknown): value is WelcomeMsg {
  return (
    isRecord(value) &&
    hasKeys(value, ['t', 'device', 'name'], ['pot']) &&
    value['t'] === 'welcome' &&
    isSyncDeviceRecord(value['device']) &&
    isString(value['name'], DEVICE_NAME_MAX) &&
    (value['pot'] === undefined ||
      (isString(value['pot'], 320) && parseEndpoint(value['pot']) !== null))
  );
}

export function isRejectMsg(value: unknown): value is RejectMsg {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['t', 'reason']) &&
    value['t'] === 'reject' &&
    isString(value['reason'], 64)
  );
}

function isSyncDeviceSummary(
  value: unknown,
): value is SyncDeviceSummary {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'name', 'pairedAt', 'lastSeenAt']) &&
    isString(value['id'], 64) &&
    isString(value['name'], DEVICE_NAME_MAX) &&
    isSafeNonNegative(value['pairedAt']) &&
    isSafeNonNegative(value['lastSeenAt'])
  );
}

export function isDevicesMsg(value: unknown): value is DevicesMsg {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['t', 'devices']) &&
    value['t'] === 'devices' &&
    Array.isArray(value['devices']) &&
    (value['devices'] as unknown[]).every(isSyncDeviceSummary)
  );
}

export function isDeltaMsg(value: unknown): value is DeltaMsg {
  // The delta document itself is validated on apply — the wire just
  // needs the envelope shape (a sync delta is an object).
  return (
    isRecord(value) &&
    hasExactKeys(value, ['t', 'delta']) &&
    value['t'] === 'delta' &&
    isRecord(value['delta'])
  );
}

export function isPongMsg(value: unknown): value is PongMsg {
  return isRecord(value) && hasExactKeys(value, ['t']) && value['t'] === 'pong';
}

export function isSyncRequestMsg(
  value: unknown,
): value is SyncRequestMsg {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['t']) &&
    value['t'] === 'sync-request'
  );
}

export function isByeMsg(value: unknown): value is ByeMsg {
  return isRecord(value) && hasExactKeys(value, ['t']) && value['t'] === 'bye';
}

export function isErrorMsg(value: unknown): value is ErrorMsg {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['t', 'code']) &&
    value['t'] === 'error' &&
    isString(value['code'], 64)
  );
}

/** Envelope guard — any msg with a bounded `t` tag. */
export function isServerMsg(value: unknown): value is ServerMsg {
  return isRecord(value) && isString(value['t'], 32);
}

export function isPairingPayload(
  value: unknown,
): value is SyncPairingPayload {
  return (
    isRecord(value) &&
    hasKeys(
      value,
      ['v', 'endpoint', 'code', 'fp'],
      ['endpoints', 'pot'],
    ) &&
    value['v'] === WIRE_VERSION &&
    isString(value['endpoint'], 320) &&
    PAIR_CODE_PATTERN.test(String(value['code'])) &&
    isFp(value['fp']) &&
    (value['endpoints'] === undefined ||
      (Array.isArray(value['endpoints']) &&
        value['endpoints'].length <= 16 &&
        (value['endpoints'] as unknown[]).every(
          (ep) => isString(ep, 320) && parseEndpoint(ep) !== null,
        ))) &&
    (value['pot'] === undefined ||
      (isString(value['pot'], 320) && parseEndpoint(value['pot']) !== null))
  );
}

/* -------------------------- codec helpers ------------------------- */

/**
 * UTF-8 without TextEncoder/TextDecoder (lib: ES2023 — no DOM types).
 * Encode mirrors local-source.ts: real UTF-8, lone surrogates encode
 * as their own code point — hashing needs determinism, not validity.
 */
export function utf8Encode(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const cp = input.codePointAt(i) ?? 0;
    if (cp > 0xffff) {
      i += 1; // low surrogate consumed with the pair
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(
        0xe0 | (cp >> 12),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

/** UTF-8 byte count without encoding — for size budgets. */
export function utf8ByteLength(input: string): number {
  let bytes = 0;
  for (let i = 0; i < input.length; i += 1) {
    const cp = input.codePointAt(i) ?? 0;
    if (cp > 0xffff) {
      i += 1;
    }
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Replacement-char decode — malformed bytes never throw. */
export function utf8Decode(bytes: Uint8Array): string {
  const cps: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    let cp: number;
    let len: number;
    if (b0 < 0x80) {
      cp = b0;
      len = 1;
    } else if (b0 >= 0xc2 && b0 < 0xe0) {
      cp = b0 & 0x1f;
      len = 2;
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      cp = b0 & 0x0f;
      len = 3;
    } else if (b0 >= 0xf0 && b0 < 0xf8) {
      cp = b0 & 0x07;
      len = 4;
    } else {
      cps.push(0xfffd);
      i += 1;
      continue;
    }
    let valid = i + len <= bytes.length;
    if (valid) {
      for (let j = 1; j < len; j += 1) {
        const cont = bytes[i + j] ?? 0;
        if ((cont & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        cp = (cp << 6) | (cont & 0x3f);
      }
    }
    if (!valid) {
      cps.push(0xfffd);
      i += 1;
      continue;
    }
    cps.push(cp > 0x10ffff ? 0xfffd : cp);
    i += len;
  }
  let out = '';
  for (const cp of cps) {
    out += String.fromCodePoint(cp);
  }
  return out;
}

export function encodeJson(msg: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(msg));
}

export function decodeJson(payload: Uint8Array): unknown {
  return JSON.parse(utf8Decode(payload));
}

/**
 * `host:port`, with `[v6]` bracketed — the same shape the server's
 * endpoints() mints. Returns null on any malformed input.
 */
export function parseEndpoint(raw: string): SyncEndpoint | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 320) {
    return null;
  }
  const open = trimmed.startsWith('[');
  let host: string;
  let portPart: string;
  if (open) {
    const close = trimmed.indexOf(']');
    if (close <= 1 || trimmed[close + 1] !== ':') {
      return null;
    }
    host = trimmed.slice(1, close);
    portPart = trimmed.slice(close + 2);
  } else {
    const split = trimmed.lastIndexOf(':');
    if (split <= 0 || split === trimmed.length - 1) {
      return null;
    }
    host = trimmed.slice(0, split);
    portPart = trimmed.slice(split + 1);
  }
  if (host.length === 0 || host.length > 255) {
    return null;
  }
  if (!/^[0-9]{1,5}$/.test(portPart)) {
    return null;
  }
  const port = Number(portPart);
  return port >= 1 && port <= 65_535 ? { host, port } : null;
}

/**
 * The `since` string is just the JSON cursor — '' means "no watermark"
 * (the server exports everything). Bounded to the wire's 256-char cap:
 * entries are kept highest-watermark first, so truncation sacrifices
 * the smallest (cheapest to resend) — a partial cursor is always safe,
 * never lossy.
 */
export function cursorToSince(cursor: SyncCursor): string {
  const entries = Object.entries(cursor);
  if (entries.length === 0) {
    return '';
  }
  const kept: [string, number][] = [...entries].sort((a, b) => b[1] - a[1]);
  let out = JSON.stringify(Object.fromEntries(kept));
  while (kept.length > 0 && out.length > MAX_SINCE_CHARS) {
    kept.pop();
    out = JSON.stringify(Object.fromEntries(kept));
  }
  return out.length <= MAX_SINCE_CHARS ? out : '';
}

export function sinceToCursor(since: string): SyncCursor | null {
  if (since === '') {
    return {};
  }
  if (since.length > MAX_SINCE_CHARS) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(since);
    return isSyncCursor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* --------------------------- error maps --------------------------- */

const ERROR_KINDS: ReadonlySet<string> = new Set<ErrorKind>([
  'no-result',
  'not-applicable',
  'unsupported',
  'auth-required',
  'auth-expired',
  'rate-limit',
  'transient',
  'expired-resource',
  'permission-denied',
  'invalid-response',
  'timeout',
  'cancelled',
  'budget-exceeded',
  'guest-trap',
  'invalid-message',
  'artifact-rejected',
  'streams-capped',
  'released',
  'superseded',
  'evicted',
  'expired',
  'not-found',
  'unavailable',
  'storage-full',
  'internal',
]);

/**
 * `{t:'error',code}` — wire-reserved codes map to their domain kind;
 * the server also echoes engine AppError kinds verbatim, so anything
 * already in the taxonomy passes through. Unknown codes are internal.
 */
export function wireErrorCode(code: string): AppError {
  switch (code) {
    case 'bad-request':
      return appError('invalid-message', 'sync: peer rejected the frame');
    case 'engine-absent':
      return appError(
        'unavailable',
        'sync: peer has no merge engine wired',
      );
    case 'too-large':
      return appError('budget-exceeded', 'sync: document exceeds the wire cap');
    default:
      return appError(
        ERROR_KINDS.has(code) ? (code as ErrorKind) : 'internal',
        `sync: peer error ${code}`,
      );
  }
}

/** `{t:'reject',reason}` — auth-phase refusal kinds. */
export function wireRejectReason(reason: string): AppError {
  switch (reason) {
    case 'bad-code':
      return appError('permission-denied', 'sync: pairing code rejected');
    case 'pairing-expired':
    case 'no-pairing':
      return appError(
        'expired',
        'sync: no live pairing window on the desktop',
      );
    case 'pairing-attempts':
      return appError('rate-limit', 'sync: pairing attempt budget spent', 30_000);
    case 'unpaired':
      return appError('auth-required', 'sync: device no longer registered');
    case 'unavailable':
      return appError('unavailable', 'sync: desktop custody unavailable');
    default:
      return appError('internal', `sync: rejected (${reason})`);
  }
}

/* ------------------------------ the pump --------------------------- */

export type WireCloseReason = 'peer' | 'error' | 'oversize' | 'local';

export type SyncWirePump = {
  /** false when the payload exceeds the phase cap or the pump is dead. */
  send(payload: Uint8Array): boolean;
  /** Raise the payload cap once the session is authenticated. */
  upgrade(maxPayload: number): void;
  readonly maxPayload: number;
  readonly closed: boolean;
  /** Immediate teardown — queued writes are discarded. */
  close(): void;
  /** Close only after queued writes flush — the peer reads the reply. */
  end(): void;
};

const HEADER_BYTES = 4;

/**
 * The `attachWirePump` port — identical semantics, Buffer-free:
 * u32le head, strict phase cap (0 or >cap destroys the socket before
 * a byte of payload is allocated), concat-on-chunk receive path.
 */
export function attachSyncPump(opts: {
  socket: SyncSocket;
  maxPayload: number;
  onFrame: (payload: Uint8Array) => void;
  onClose: (reason: WireCloseReason) => void;
}): SyncWirePump {
  const { socket } = opts;
  let maxPayload = opts.maxPayload;
  let buffered: Uint8Array = new Uint8Array(0);
  let closed = false;

  function finish(reason: WireCloseReason): void {
    if (closed) {
      return;
    }
    closed = true;
    opts.onClose(reason);
  }

  function declaredAt(bytes: Uint8Array, offset: number): number {
    return (
      (bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)
    ) >>> 0;
  }

  function drain(): void {
    while (!closed && buffered.length >= HEADER_BYTES) {
      const declared = declaredAt(buffered, 0);
      if (declared === 0 || declared > maxPayload) {
        socket.destroy();
        finish('oversize');
        return;
      }
      if (buffered.length < HEADER_BYTES + declared) {
        return;
      }
      const frame = buffered.subarray(HEADER_BYTES, HEADER_BYTES + declared);
      buffered = buffered.subarray(HEADER_BYTES + declared);
      opts.onFrame(frame);
    }
  }

  socket.on('data', (chunk: Uint8Array) => {
    if (closed) {
      return;
    }
    if (buffered.length === 0) {
      buffered = chunk;
    } else {
      const next = new Uint8Array(buffered.length + chunk.length);
      next.set(buffered, 0);
      next.set(chunk, buffered.length);
      buffered = next;
    }
    drain();
  });
  socket.on('close', () => finish('peer'));
  socket.on('end', () => finish('peer'));
  socket.on('error', () => finish('error'));

  return {
    send(payload) {
      if (closed || payload.length > maxPayload) {
        return false;
      }
      const head = new Uint8Array(HEADER_BYTES);
      head[0] = payload.length & 0xff;
      head[1] = (payload.length >>> 8) & 0xff;
      head[2] = (payload.length >>> 16) & 0xff;
      head[3] = (payload.length >>> 24) & 0xff;
      const frame = new Uint8Array(HEADER_BYTES + payload.length);
      frame.set(head, 0);
      frame.set(payload, HEADER_BYTES);
      try {
        socket.write(frame);
      } catch {
        finish('error');
        return false;
      }
      return true;
    },
    upgrade(nextMax: number): void {
      maxPayload = nextMax;
    },
    get maxPayload(): number {
      return maxPayload;
    },
    get closed(): boolean {
      return closed;
    },
    close(): void {
      if (closed) {
        return;
      }
      try {
        socket.destroy();
      } catch {
        // Best effort — the peer may already be gone.
      }
      finish('local');
    },
    end(): void {
      if (closed) {
        return;
      }
      try {
        if (socket.end !== undefined) {
          socket.end();
        } else {
          socket.destroy();
        }
      } catch {
        try {
          socket.destroy();
        } catch {
          // Best effort — the peer may already be gone.
        }
      }
      finish('local');
    },
  };
}
