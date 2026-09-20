/** Tiny dependency-free assertion helpers; throw on failure. */

export function assert(
  condition: boolean,
  message = 'assertion failed',
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEqual<T>(
  actual: T,
  expected: T,
  message?: string,
): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      message ??
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
    );
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  return aKeys.every(
    (key) => Object.hasOwn(bRec, key) && deepEqual(aRec[key], bRec[key]),
  );
}

export function assertDeepEqual(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      message ??
      `deep equal failed: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`,
    );
  }
}
