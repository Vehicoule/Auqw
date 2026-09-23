import { hasExactKeys, isRecord, isSafeNonNegative } from '../domain.ts';

/**
 * One stamp of the hybrid logical clock. `l` is the largest
 * wall-millisecond the device has observed — its own clock or a
 * received stamp — and `c` is the counter that orders events
 * sharing a millisecond. This is the standard Kulkarni HLC
 * construction: wall time carries human meaning while the counter
 * keeps the order monotone under clock regression and skew.
 */
export type HlcStamp = {
  readonly l: number;
  readonly c: number;
};

export function isHlcStamp(value: unknown): value is HlcStamp {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['l', 'c']) &&
    isSafeNonNegative(value['l']) &&
    isSafeNonNegative(value['c'])
  );
}

/**
 * The (l, c) half of the total order. Two devices can legitimately
 * emit the same stamp — the entry-level order adds the device id
 * as the final tie-break (see sync-engine.ts).
 */
export function compareStamp(a: HlcStamp, b: HlcStamp): number {
  if (a.l !== b.l) {
    return a.l < b.l ? -1 : 1;
  }
  if (a.c !== b.c) {
    return a.c < b.c ? -1 : 1;
  }
  return 0;
}

/**
 * Device-local hybrid clock. Serialized once per change-log entry;
 * `tick` stamps a local event, `receive` folds a remote stamp in.
 * The counter is bounded: a pathological run of same-millisecond
 * events escapes by bumping `l` forward one tick rather than
 * overflowing the integer — ordering is preserved.
 */
export class HybridClock {
  #l = 0;
  #c = 0;

  /** Rehydrate from the largest stamp this device already knows. */
  constructor(last?: HlcStamp) {
    if (last !== undefined) {
      if (!isHlcStamp(last)) {
        throw new TypeError('invalid initial stamp');
      }
      this.#l = last.l;
      this.#c = last.c;
    }
  }

  /** The stamp the next tick would build on — never decreases. */
  stamp(): HlcStamp {
    return { l: this.#l, c: this.#c };
  }

  /**
   * Stamps a local event. When the wall clock stands still or goes
   * backwards the counter carries the order forward; when it
   * advances the counter resets. `nowMs` must be a safe
   * nonnegative integer (caller-side clock reads are defensive).
   */
  tick(nowMs: number): HlcStamp {
    if (!isSafeNonNegative(nowMs)) {
      throw new TypeError('nowMs must be a safe nonnegative integer');
    }
    if (nowMs > this.#l) {
      this.#l = nowMs;
      this.#c = 0;
    } else if (this.#c === Number.MAX_SAFE_INTEGER) {
      // Terminal stamp: both components saturated. A repeated stamp
      // would alias two distinct events to one entry key — a clock
      // that cannot order must say so rather than mint a duplicate.
      if (this.#l === Number.MAX_SAFE_INTEGER) {
        throw new RangeError('hlc exhausted');
      }
      this.#l += 1;
      this.#c = 0;
    } else {
      this.#c += 1;
    }
    return { l: this.#l, c: this.#c };
  }

  /**
   * Folds a received stamp into the local clock — the standard HLC
   * receive rule and the skew-tolerance mechanism: a remote stamp
   * ahead of the local wall pulls `l` forward, so later local
   * events still order after it.
   */
  receive(remote: HlcStamp, nowMs: number): HlcStamp {
    if (!isHlcStamp(remote)) {
      throw new TypeError('remote must be a valid stamp');
    }
    if (!isSafeNonNegative(nowMs)) {
      throw new TypeError('nowMs must be a safe nonnegative integer');
    }
    const l = Math.max(this.#l, remote.l, nowMs);
    let c: number;
    if (l === this.#l && l === remote.l) {
      c = Math.max(this.#c, remote.c) + 1;
    } else if (l === this.#l) {
      c = this.#c + 1;
    } else if (l === remote.l) {
      c = remote.c + 1;
    } else {
      c = 0;
    }
    if (c > Number.MAX_SAFE_INTEGER) {
      if (l === Number.MAX_SAFE_INTEGER) {
        throw new RangeError('hlc exhausted');
      }
      this.#l = l + 1;
      this.#c = 0;
    } else {
      this.#l = l;
      this.#c = c;
    }
    return { l: this.#l, c: this.#c };
  }
}
