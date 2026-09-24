import { assert, assertEqual } from '@auqw/application/testing';
import {
  createPotService,
  type PotSession,
} from './pot-service.ts';

type Response = {
  readonly status: number;
  readonly body: unknown;
};

async function post(
  base: string,
  body: string,
): Promise<Response> {
  const res = await fetch(`${base}/get_pot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { status: res.status, body: await res.json() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * HTTP surface with the mint machinery stubbed through the `session`
 * seam — the BotGuard leg is covered by the live evidence run, not a
 * unit test.
 */
export async function run(): Promise<void> {
  const now = { ms: 1_000_000 };
  let builds = 0;
  const svc = createPotService({
    nowMs: () => now.ms,
    log: () => {},
    session: async (): Promise<PotSession> => {
      builds += 1;
      return {
        mint: async (binding) => `tok-${binding}`,
        expiresAtMs: now.ms + 3_600_000,
      };
    },
  });
  const port = await svc.bind();
  assert(port !== null && port > 0, 'bind returned no port');
  // Memoized: a second bind returns the same port.
  assertEqual(await svc.bind(), port, 'rebind changed the port');
  const base = svc.loopbackUrl();
  assert(base !== null && base.startsWith('http://127.0.0.1:'));
  assert(base.endsWith(`:${port}`));

  // Happy path — response carries the three fields the guest reads.
  const first = await post(base, JSON.stringify({ content_binding: 'v1' }));
  assertEqual(first.status, 200);
  assert(isRecord(first.body), 'mint response is not an object');
  assertEqual(first.body['poToken'], 'tok-v1');
  assertEqual(first.body['contentBinding'], 'v1');
  assert(
    typeof first.body['expiresAt'] === 'string' &&
      !Number.isNaN(Date.parse(first.body['expiresAt'])),
    'expiresAt is not an ISO timestamp',
  );
  // Session memoized while fresh — one build serves both mints.
  const second = await post(base, JSON.stringify({ content_binding: 'v2' }));
  assertEqual(second.status, 200);
  assert(isRecord(second.body));
  assertEqual(second.body['poToken'], 'tok-v2');
  assertEqual(builds, 1, 'fresh session rebuilt');

  // Validation.
  const empty = await post(base, JSON.stringify({ content_binding: '' }));
  assertEqual(empty.status, 400);
  const missing = await post(base, JSON.stringify({}));
  assertEqual(missing.status, 400);
  const wrongType = await post(base, JSON.stringify({ content_binding: 7 }));
  assertEqual(wrongType.status, 400);
  const oversized = await post(
    base,
    JSON.stringify({ content_binding: 'x'.repeat(600) }),
  );
  assertEqual(oversized.status, 400);
  const notJson = await post(base, 'not json');
  assertEqual(notJson.status, 400);
  const notFound = await fetch(`${base}/nope`, { method: 'POST' });
  assertEqual(notFound.status, 404);
  const wrongMethod = await fetch(`${base}/get_pot`, { method: 'GET' });
  assertEqual(wrongMethod.status, 404);
  const ping = await fetch(`${base}/ping`);
  assertEqual(ping.status, 200);

  // Oversized body → 413.
  const huge = await fetch(`${base}/get_pot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content_binding: 'y'.repeat(9000) }),
  });
  assertEqual(huge.status, 413);

  // Expired session → rebuild on next mint.
  now.ms += 3_600_000;
  const third = await post(base, JSON.stringify({ content_binding: 'v3' }));
  assertEqual(third.status, 200);
  assertEqual(builds, 2, 'expired session not rebuilt');

  await svc.close();
  assertEqual(svc.port(), null, 'port leaked after close');

  // Rate limit: burst 2, no refill — third request is 429.
  const limited = createPotService({
    nowMs: () => now.ms,
    log: () => {},
    rateLimitPerSec: 0,
    rateLimitBurst: 2,
    session: async (): Promise<PotSession> => ({
      mint: async () => 'tok',
      expiresAtMs: now.ms + 60_000,
    }),
  });
  const lport = await limited.bind();
  assert(lport !== null);
  const lbase = `http://127.0.0.1:${lport}`;
  assertEqual(
    (await post(lbase, JSON.stringify({ content_binding: 'a' }))).status,
    200,
  );
  assertEqual(
    (await post(lbase, JSON.stringify({ content_binding: 'b' }))).status,
    200,
  );
  assertEqual(
    (await post(lbase, JSON.stringify({ content_binding: 'c' }))).status,
    429,
  );
  await limited.close();

  // Build failure → 503, cooldown suppresses immediate retries, the
  // window lapses → success.
  let flakyBuilds = 0;
  const flaky = createPotService({
    nowMs: () => now.ms,
    log: () => {},
    session: async (): Promise<PotSession> => {
      flakyBuilds += 1;
      if (flakyBuilds === 1) {
        throw new Error('upstream down');
      }
      return {
        mint: async () => 'tok-back',
        expiresAtMs: now.ms + 60_000,
      };
    },
  });
  const fport = await flaky.bind();
  assert(fport !== null);
  const fbase = `http://127.0.0.1:${fport}`;
  const failed = await post(fbase, JSON.stringify({ content_binding: 'x' }));
  assertEqual(failed.status, 503);
  assert(isRecord(failed.body));
  assertEqual(failed.body['error'], 'unavailable');
  const cooled = await post(fbase, JSON.stringify({ content_binding: 'x' }));
  assertEqual(cooled.status, 503);
  assertEqual(flakyBuilds, 1, 'cooldown let a retry through');
  now.ms += 16_000;
  const recovered = await post(
    fbase,
    JSON.stringify({ content_binding: 'x' }),
  );
  assertEqual(recovered.status, 200);
  assert(isRecord(recovered.body));
  assertEqual(recovered.body['poToken'], 'tok-back');
  await flaky.close();

  // A mint-time failure drops the session — the next mint rebuilds.
  let dropBuilds = 0;
  const dropper = createPotService({
    nowMs: () => now.ms,
    log: () => {},
    session: async (): Promise<PotSession> => {
      dropBuilds += 1;
      if (dropBuilds === 1) {
        return {
          mint: async () => {
            throw new Error('po mint blew up');
          },
          expiresAtMs: now.ms + 60_000,
        };
      }
      return {
        mint: async () => 'tok-new',
        expiresAtMs: now.ms + 60_000,
      };
    },
  });
  const dport = await dropper.bind();
  assert(dport !== null);
  const dbase = `http://127.0.0.1:${dport}`;
  assertEqual(
    (await post(dbase, JSON.stringify({ content_binding: 'x' }))).status,
    503,
  );
  const rebuilt = await post(dbase, JSON.stringify({ content_binding: 'x' }));
  assertEqual(rebuilt.status, 200);
  assert(isRecord(rebuilt.body));
  assertEqual(rebuilt.body['poToken'], 'tok-new');
  assertEqual(dropBuilds, 2, 'failed session was reused');
  await dropper.close();
}
