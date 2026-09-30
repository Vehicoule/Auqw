import {
  appError,
  appErrorKind,
  err,
  fromUnknown,
  isBotCheckWall,
  isPermanentFailure,
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
    'provider-wall',
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

  // isBotCheckWall: the dedicated `provider-wall` kind is a wall on
  // its own — no message sniffing needed.
  assert(isBotCheckWall(appError('provider-wall', 'provider-wall: bot-check')));
  assert(isBotCheckWall(appError('provider-wall', 'anything')));
  // A wall is terminal but never condemns the row — it sits in
  // neither set.
  assert(!appError('provider-wall', 'w').retryable);
  assert(!isPermanentFailure(appError('provider-wall', 'w')));
  // The slug decodes through the boundary table.
  assertEqual(appErrorKind('provider-wall'), 'provider-wall');

  // The legacy shape: the guest's 'bot-check' detail survives every
  // host prefix-wrap as the LAST `:`-separated segment — only a
  // `transient` verdict ending in exactly that token is the wall.
  const walls = [
    'bot-check',
    'transient: bot-check',
    'transient: bot-check ',
    'guest failure (transient): transient: bot-check',
    'transient: guest failure (transient): transient: bot-check',
  ];
  for (const message of walls) {
    assert(
      isBotCheckWall(appError('transient', message)),
      `wall recognized: ${message}`,
    );
  }
  const notWalls: readonly [ErrorKind, string][] = [
    ['transient', 'socket hangup'],
    ['transient', 'streams-capped'],
    ['transient', 'transient: bot-checksum'],
    ['transient', 'rung bot-check failed'],
    ['transient', 'bot-check: recheck later'],
    ['rate-limit', 'transient: bot-check'],
    ['timeout', 'bot-check'],
    ['not-found', 'bot-check'],
  ];
  for (const [kind, message] of notWalls) {
    assert(
      !isBotCheckWall(appError(kind, message)),
      `not a wall: ${kind} / ${message}`,
    );
  }
}
