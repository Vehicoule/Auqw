/**
 * Typed validator combinators. Each factory returns a `Guard<T>`
 * whose narrowing IS the wire type: `Guarded<typeof isX>` reads the
 * payload type back off the validator, so a channel's runtime check
 * and its TypeScript declaration can never drift.
 */
import {
  hasOnlyKeys,
  isBoolean,
  isBoundedString,
  isFiniteNumber,
  isRecord,
  isSafeNonNegativeInt,
} from './check.ts';

/** A validator whose narrowing doubles as the declared type. */
export type Guard<T> = (value: unknown) => value is T;

/** The type a guard certifies — `Guarded<typeof isX>`. */
export type Guarded<G> = G extends Guard<infer T> ? T : never;

declare const OPTIONAL: unique symbol;

/**
 * A field guard that also accepts `undefined` — `object` maps these
 * fields to `key?: T` instead of `key: T`.
 */
type OptionalGuard<T> = Guard<T | undefined> & {
  readonly [OPTIONAL]: true;
};

type ShapeMap = Record<string, Guard<unknown>>;
type ShapeType<S extends ShapeMap> = {
  readonly [K in keyof S as S[K] extends OptionalGuard<unknown>
    ? never
    : K]: Guarded<S[K]>;
} & {
  readonly [K in keyof S as S[K] extends OptionalGuard<unknown>
    ? K
    : never]?: S[K] extends OptionalGuard<infer T> ? T : never;
};

/** Any string, optionally length-capped (empty allowed). */
export function string(max?: number): Guard<string> {
  return (value): value is string =>
    typeof value === 'string' &&
    (max === undefined || value.length <= max);
}

/** Non-empty string with a length cap — `isBoundedString`. */
export function boundedString(max: number): Guard<string> {
  return (value): value is string => isBoundedString(value, max);
}

export function pattern(regex: RegExp): Guard<string> {
  return (value): value is string =>
    typeof value === 'string' && regex.test(value);
}

export function boolean(): Guard<boolean> {
  return isBoolean;
}

/** Safe non-negative integer, optionally bounded above. */
export function int(max?: number): Guard<number> {
  return (value): value is number =>
    isSafeNonNegativeInt(value) && (max === undefined || value <= max);
}

/** Safe integer of any sign. */
export function integer(): Guard<number> {
  return (value): value is number =>
    isFiniteNumber(value) && Number.isSafeInteger(value);
}

export function finite(): Guard<number> {
  return isFiniteNumber;
}

export function literal<
  L extends string | number | boolean | null | undefined,
>(expected: L): Guard<L> {
  return (value): value is L => value === expected;
}

export function literals<L extends string | number | boolean>(
  ...expected: readonly L[]
): Guard<L> {
  return (value): value is L => expected.some((lit) => value === lit);
}

export function nullable<T>(inner: Guard<T>): Guard<T | null> {
  return (value): value is T | null => value === null || inner(value);
}

/** Object field that may be absent or `undefined`. */
export function optional<T>(inner: Guard<T>): OptionalGuard<T> {
  const guard: Guard<T | undefined> = (value) =>
    value === undefined || inner(value);
  return guard as OptionalGuard<T>;
}

export function array<T>(
  item: Guard<T>,
  bounds?: { readonly min?: number; readonly max?: number },
): Guard<readonly T[]> {
  return (value): value is readonly T[] =>
    Array.isArray(value) &&
    (bounds?.min === undefined || value.length >= bounds.min) &&
    (bounds?.max === undefined || value.length <= bounds.max) &&
    value.every(item);
}

/**
 * A record of exactly `shape`'s keys: unknown keys reject, a key whose
 * guard isn't `optional` must hold a passing value, and each field
 * guard checks its own key.
 */
export function object<S extends ShapeMap>(shape: S): Guard<ShapeType<S>> {
  const entries = Object.entries(shape);
  const keys = entries.map(([key]) => key);
  return (value): value is ShapeType<S> =>
    isRecord(value) &&
    hasOnlyKeys(value, keys) &&
    entries.every(([key, guard]) => guard(value[key]));
}

export function union<Gs extends readonly Guard<unknown>[]>(
  ...guards: Gs
): Guard<Guarded<Gs[number]>> {
  return (value): value is Guarded<Gs[number]> =>
    guards.some((guard) => guard(value));
}

/** Extra acceptance rule on an already-typed guard — same narrowing. */
export function refine<T>(
  inner: Guard<T>,
  check: (value: T) => boolean,
): Guard<T> {
  return (value): value is T => inner(value) && check(value);
}

/**
 * A boolean predicate that proves acceptance but narrows nothing —
 * the payload type stays `unknown`.
 */
export function checked(
  predicate: (value: unknown) => boolean,
): Guard<unknown> {
  return (value): value is unknown => predicate(value);
}
