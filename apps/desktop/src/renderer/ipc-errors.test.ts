import { appErrorKind } from '@auqw/application';
import { assert, assertEqual } from '@auqw/application/testing';
import type { ShellErrorKind } from '../shared/errors.ts';
import { shellError } from '../shared/errors.ts';
import { rawToAppError, shellToAppError } from './ipc-errors.ts';

export function run(): void {
  // The stream/host legs classify one rejection through two maps —
  // `SHELL_TO_APP` on the `settleIpc` leg and `appErrorKind` inside
  // `rawToAppError` on the web-player/provider legs. For every kind
  // those ops can emit the maps must agree, or the same pump death
  // lands `internal` on one leg and `transient` on the other.
  const seamKinds: readonly ShellErrorKind[] = [
    'io-error',
    'transient',
    'rate-limit',
    'auth-required',
    'released',
    'cancelled',
    'unavailable',
    'invalid-response',
    'internal',
  ];
  for (const kind of seamKinds) {
    const thrown = shellError(kind, 'host call failed: x');
    const viaSettle = shellToAppError(thrown);
    const viaRaw = rawToAppError(thrown, 'fallback');
    assertEqual(viaSettle.kind, viaRaw.kind, `${kind}: maps agree`);
    assertEqual(
      viaRaw.kind,
      appErrorKind(kind),
      `${kind}: canonical slug fold`,
    );
  }

  // The laundering fixes pinned end-to-end: io-error folds to
  // `transient` (not `internal`) on both legs, and the seam kinds the
  // shell taxonomy gained keep their names — `rate-limit` stays
  // retryable where `unavailable` had dropped it.
  const io = shellError('io-error', 'pump stalled');
  assertEqual(shellToAppError(io).kind, 'transient');
  assertEqual(rawToAppError(io, 'x').kind, 'transient');

  const limited = rawToAppError(
    shellError('rate-limit', 'host call failed: rate-limit'),
    'fallback',
  );
  assertEqual(limited.kind, 'rate-limit');
  assert(limited.retryable, 'rate-limit stays retryable');
  const auth = rawToAppError(
    shellError('auth-required', 'host call failed: auth-required'),
    'fallback',
  );
  assertEqual(auth.kind, 'auth-required');
  assert(!auth.retryable, 'auth-required is terminal, not weather');

  // A record's own message wins over the fallback; an Error is itself
  // a record, so its message crosses while the missing kind degrades
  // to internal — the fallback only applies when no message exists.
  assertEqual(
    rawToAppError({ kind: 'transient', message: 'stall @42' }, 'x').message,
    'stall @42',
  );
  const bare = rawToAppError(new Error('boom'), 'stream call failed');
  assertEqual(bare.kind, 'internal');
  assertEqual(bare.message, 'boom');
  assertEqual(
    rawToAppError('nope', 'stream call failed').message,
    'stream call failed',
  );
  // A non-ShellError throw on the settle leg still degrades typed.
  assertEqual(shellToAppError(new Error('boom')).kind, 'internal');
}
