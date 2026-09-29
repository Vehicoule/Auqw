import { isRecord } from '../domain.ts';
import { compareStamp } from './hlc.ts';
import type { HlcStamp } from './hlc.ts';

/**
 * The merge engine's shared pure helpers — the change-entry total
 * order, the dedupe key, composite record-key separator, and the
 * JSON deep-equality the value compares ride on. Not re-exported by
 * index.ts — package-internal to the sync shard.
 */

/** Composite-key separator — a byte no id component can carry. */
export const KEY_SEP = '\u001f';

/** The total order: (l, c) then deviceId — ties are impossible then. */
export function compareEntryTs(
  a: { hlc: HlcStamp; deviceId: string },
  b: { hlc: HlcStamp; deviceId: string },
): number {
  const byStamp = compareStamp(a.hlc, b.hlc);
  if (byStamp !== 0) {
    return byStamp;
  }
  return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
}

/** Dedupe identity: one stamp from one device is one entry. */
export function entryKey(entry: {
  hlc: HlcStamp;
  deviceId: string;
}): string {
  return `${entry.deviceId}${KEY_SEP}${entry.hlc.l}${KEY_SEP}${entry.hlc.c}`;
}

/** Deep equality over JSON-shaped values (scalars, arrays, records). */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((item, i) => jsonEquals(item, b[i]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) {
    return false;
  }
  const aKeys = Object.keys(a);
  return (
    aKeys.length === Object.keys(b).length &&
    aKeys.every((key) => Object.hasOwn(b, key) && jsonEquals(a[key], b[key]))
  );
}
