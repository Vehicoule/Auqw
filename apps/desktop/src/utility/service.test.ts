import { assert, assertEqual } from '@auqw/application/testing';
import { isShellError } from '../shared/errors.ts';
import { createServiceClient, isServiceCall } from './service.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertRejectsKind(
  promise: Promise<unknown>,
  kind: string,
): Promise<void> {
  try {
    await promise;
  } catch (thrown) {
    assert(
      isShellError(thrown) && thrown.kind === kind,
      `expected ${kind}, got ${JSON.stringify(thrown)}`,
    );
    return;
  }
  throw new Error(`expected rejection with ${kind}`);
}

export async function run(): Promise<void> {
  const posted: unknown[] = [];
  const client = createServiceClient({
    post: (m) => posted.push(m),
    timeoutMs: 40,
  });

  // A request posts the envelope and resolves on the correlated reply.
  const req = client.request('sync:keys', { op: 'identity-get' });
  assertEqual(posted.length, 1);
  const sent = posted[0] as { id?: number; channel?: string; args?: unknown };
  assertEqual(sent.channel, 'sync:keys');
  assert(
    client.onMessage({ id: sent.id, ok: true, result: { identity: null } }),
    'reply consumed',
  );
  const answered = await req;
  assertEqual(JSON.stringify(answered), JSON.stringify({ identity: null }));

  // Non-response messages are not consumed — the router keeps them.
  assertEqual(client.onMessage({ id: 999, channel: 'x', args: {} }), false);
  assertEqual(client.onMessage('noise'), false);
  // A response-shaped message for an id nothing tracks is a late reply:
  // consumed, never bounced into the request dispatcher.
  assertEqual(client.onMessage({ id: 999, ok: true, result: 1 }), true);
  assertEqual(client.onMessage({ id: 999, ok: false, error: { kind: 'internal', message: 'm', retryable: true } }), true);

  // Malformed response-shaped messages are consumed too — a bounced
  // 'malformed request' reply shares the id space and can collide
  // with an in-flight request in the other direction.
  assertEqual(client.onMessage({ id: 999, ok: 'yes' }), true);
  assertEqual(client.onMessage({ id: 999, ok: false, stray: 1 }), true);
  assertEqual(client.onMessage({ id: 999 }), true);
  // A genuine request still reaches the dispatcher.
  assertEqual(client.onMessage({ id: 999, channel: 'sync:keys' }), false);

  // Typed failures reject; unknown ids are dropped.
  const failing = client.request('sync:keys', { op: 'x' });
  const failingId = (posted[posted.length - 1] as { id?: number }).id;
  client.onMessage({ id: 9_999, ok: false, error: { kind: 'internal', message: 'm', retryable: true } });
  client.onMessage({
    id: failingId,
    ok: false,
    error: { kind: 'unavailable', message: 'down', retryable: true },
  });
  await assertRejectsKind(failing, 'unavailable');

  // Timeout settles a request main never answers.
  const hanging = client.request('sync:keys', { op: 'device-list' });
  await assertRejectsKind(hanging, 'io-error');

  // A malformed reply that names an outstanding id settles the call
  // immediately — the caller gets invalid-response, not the timeout.
  const duped = client.request('sync:keys', { op: 'device-list' });
  const dupedId = (posted[posted.length - 1] as { id?: number }).id;
  assertEqual(client.onMessage({ id: dupedId, ok: 'yes' }), true);
  await assertRejectsKind(duped, 'invalid-response');

  // isServiceCall recognizes exactly the request shape.
  assert(isServiceCall({ id: 1, channel: 'sync:keys', args: { op: 'x' } }));
  assert(!isServiceCall({ id: 1, ok: true, result: null }));
  assert(!isServiceCall({ id: 1, channel: 'x' }));
  assert(!isServiceCall({ id: 1, channel: 'x', args: {}, extra: 1 }));

  // close() drains in-flight and refuses new calls.
  const late = client.request('sync:keys', { op: 'x' });
  client.close();
  await assertRejectsKind(late, 'released');
  await assertRejectsKind(
    client.request('sync:keys', { op: 'x' }),
    'released',
  );

  await sleep(60); // let any stray timers settle
}
