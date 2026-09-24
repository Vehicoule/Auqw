import { assert, assertEqual } from '@auqw/application/testing';
import { isUtilityPingResult } from '../shared/contract.ts';
import { createUtilityRouter } from './router.ts';

export async function run(): Promise<void> {
  const route = createUtilityRouter();

  const pong = await route({
    id: 1,
    channel: 'utility:ping',
    args: { message: 'round-trip' },
  });
  assert(pong.ok, 'ping resolves');
  assertEqual(pong.id, 1, 'response carries request id');
  assert(
    isUtilityPingResult(pong.result) && pong.result.echo === 'round-trip',
    'ping echoes the message',
  );

  const badArgs = await route({
    id: 2,
    channel: 'utility:ping',
    args: { unexpected: 1 },
  });
  assert(!badArgs.ok && badArgs.error.kind === 'invalid-request');

  for (const channel of [
    'storage:get',
    'stream:open',
    'sync:push',
    'transfer:start',
    'tagread:file',
  ]) {
    const res = await route({ id: 3, channel, args: {} });
    assert(
      !res.ok && res.error.kind === 'not-implemented',
      `${channel} must answer not-implemented`,
    );
    assertEqual(res.id, 3);
  }

  const unknown = await route({ id: 9, channel: 'bogus:thing', args: {} });
  assert(!unknown.ok && unknown.error.kind === 'invalid-request');

  // A raw throw inside a handler becomes a typed internal error; the
  // original message never crosses the boundary.
  const exploding = createUtilityRouter({
    'x:explode': () => Promise.reject(new Error('raw secret detail')),
  });
  const exploded = await exploding({ id: 4, channel: 'x:explode', args: {} });
  assert(!exploded.ok && exploded.error.kind === 'internal');
  assertEqual(exploded.error.message, 'unexpected shell failure');
}
