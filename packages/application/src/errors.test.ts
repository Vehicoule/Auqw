import {
  appError,
  err,
  fromUnknown,
  ok,
} from './errors.ts';
import type { ErrorKind } from './errors.ts';
import { assert, assertEqual } from './testing/assert.ts';

export function run(): void {
  const retryable: readonly ErrorKind[] = [
    'rate-limit',
    'transient',
    'expired-resource',
    'timeout',
    'streams-capped',
    'expired',
    'internal',
  ];
  const all: readonly ErrorKind[] = [
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
    'internal',
  ];
  for (const kind of all) {
    const error = appError(kind, 'm');
    assertEqual(
      error.retryable,
      retryable.includes(kind),
      `retryable(${kind})`,
    );
    assertEqual(error.retryAfterMs, undefined, `no retryAfter ${kind}`);
  }

  const withAfter = appError('rate-limit', 'slow down', 30_000);
  assertEqual(withAfter.retryAfterMs, 30_000);

  const good = ok(42);
  assert(good.ok && good.value === 42);
  const bad = err(appError('transient', 'x'));
  assert(!bad.ok && bad.error.kind === 'transient');

  const mapped = fromUnknown(new Error('secret internals'));
  assertEqual(mapped.kind, 'internal');
  assertEqual(mapped.retryable, true);
  assert(!mapped.message.includes('secret internals'));
  const mappedString = fromUnknown('plain string');
  assertEqual(mappedString.kind, 'internal');
}
