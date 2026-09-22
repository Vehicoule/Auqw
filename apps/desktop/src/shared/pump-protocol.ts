import {
  hasOnlyKeys,
  isBoundedString,
  isRecord,
  isSafeNonNegativeInt,
} from './check.ts';

/**
 * The stream-pump protocol over the brokered MessagePort (`stream:port`
 * handshake). Both ends validate every inbound frame — the port is a
 * privileged byte channel, not a typed-envelope one.
 *
 * Flow control is credit-based: the pump only reads while `credit`
 * remains; each `data` frame decrements it by `bytes.byteLength`.
 * `seek` resets the read position, bumps `epoch`, and zeroes credit —
 * frames from an older epoch are stale and dropped by the client.
 */

// ---- client → pump ------------------------------------------------------

export type PumpGrant = { readonly kind: 'grant'; readonly bytes: number };

export type PumpSeek = {
  readonly kind: 'seek';
  readonly position: number;
  readonly epoch: number;
};

export type PumpClose = { readonly kind: 'close' };

export type PumpClientMessage = PumpGrant | PumpSeek | PumpClose;

export function isPumpClientMessage(
  value: unknown,
): value is PumpClientMessage {
  if (!isRecord(value)) {
    return false;
  }
  switch (value['kind']) {
    case 'grant':
      return (
        hasOnlyKeys(value, ['kind', 'bytes']) &&
        isSafeNonNegativeInt(value['bytes']) &&
        (value['bytes'] as number) > 0 &&
        (value['bytes'] as number) <= 16 * 1024 * 1024
      );
    case 'seek':
      return (
        hasOnlyKeys(value, ['kind', 'position', 'epoch']) &&
        isSafeNonNegativeInt(value['position']) &&
        isSafeNonNegativeInt(value['epoch'])
      );
    case 'close':
      return hasOnlyKeys(value, ['kind']);
    default:
      return false;
  }
}

// ---- pump → client ------------------------------------------------------

/** `ready` fires once after the attach's `streamOpen` settles. */
export type PumpReady = {
  readonly kind: 'ready';
  readonly remaining: number | null;
  readonly epoch: number;
};

export type PumpData = {
  readonly kind: 'data';
  readonly position: number;
  readonly epoch: number;
  readonly bytes: Uint8Array;
};

export type PumpEof = { readonly kind: 'eof'; readonly epoch: number };

export type PumpError = {
  readonly kind: 'error';
  readonly epoch: number;
  readonly code: string;
  readonly message: string;
};

export type PumpServerMessage =
  | PumpReady
  | PumpData
  | PumpEof
  | PumpError;

export function isPumpServerMessage(
  value: unknown,
): value is PumpServerMessage {
  if (!isRecord(value)) {
    return false;
  }
  switch (value['kind']) {
    case 'ready':
      return (
        hasOnlyKeys(value, ['kind', 'remaining', 'epoch']) &&
        (value['remaining'] === null ||
          isSafeNonNegativeInt(value['remaining'])) &&
        isSafeNonNegativeInt(value['epoch'])
      );
    case 'data':
      return (
        hasOnlyKeys(value, ['kind', 'position', 'epoch', 'bytes']) &&
        isSafeNonNegativeInt(value['position']) &&
        isSafeNonNegativeInt(value['epoch']) &&
        value['bytes'] instanceof Uint8Array &&
        (value['bytes'] as Uint8Array).byteLength <= 2 * 1024 * 1024
      );
    case 'eof':
      return (
        hasOnlyKeys(value, ['kind', 'epoch']) &&
        isSafeNonNegativeInt(value['epoch'])
      );
    case 'error':
      return (
        hasOnlyKeys(value, ['kind', 'epoch', 'code', 'message']) &&
        isSafeNonNegativeInt(value['epoch']) &&
        isBoundedString(value['code'], 64) &&
        isBoundedString(value['message'], 512)
      );
    default:
      return false;
  }
}
