/** Tiny validator combinators shared across every shell boundary. */

import {
  isFiniteNumber,
  isRecord,
  isSafeNonNegative,
  isString,
} from '@auqw/application';

export {
  isFiniteNumber,
  isRecord,
  isSafeNonNegative as isSafeNonNegativeInt,
  isString as isBoundedString,
};

/**
 * Own keys ⊆ `keys` — a bound only, unlike `hasExactKeys`/`hasKeys`
 * which also require presence.
 */
export function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((k) => keys.includes(k));
}

export function isStringOrUndefined(
  value: unknown,
): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** `err.code` from a thrown fs/system error, without trusting the type. */
export function errorCode(thrown: unknown): string | undefined {
  return isRecord(thrown) && typeof thrown['code'] === 'string'
    ? thrown['code']
    : undefined;
}
