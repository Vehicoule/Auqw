/** Tiny validator combinators shared across every shell boundary. */

export function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((k) => keys.includes(k));
}

export function isBoundedString(
  value: unknown,
  max: number,
): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max
  );
}

export function isStringOrUndefined(
  value: unknown,
): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isSafeNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `err.code` from a thrown fs/system error, without trusting the type. */
export function errorCode(thrown: unknown): string | undefined {
  return isRecord(thrown) && typeof thrown['code'] === 'string'
    ? thrown['code']
    : undefined;
}
