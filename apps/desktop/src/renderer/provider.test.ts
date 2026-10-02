import type {
  OperationContext,
  ProviderCapability,
  SourceRef,
} from '@auqw/application';
import { CancellationSource } from '@auqw/application';
import { assert, assertDeepEqual, assertEqual } from '@auqw/application/testing';
import type {
  AttemptSummaryPayload,
  HostPluginsResult,
  HostRequestArgs,
  HostCancelArgs,
  RequestOutcomePayload,
} from '../shared/contract.ts';
import type { AuqwHost } from './provider.ts';
import { createPluginProvider } from './provider.ts';

function ref(provider: string, id: string): SourceRef {
  return { provider, kind: 'track', id };
}

const WIRE_TRACK = {
  source_ref: { provider: 'itunes', kind: 'track', id: '123' },
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  duration_ms: 200_000,
  release_year: 2020,
  artwork: [{ url: 'https://art.example/x.png', width: 100, height: 100 }],
  explicit: false,
  genre: 'Rock',
  storefront: 'US',
};

const DOMAIN_TRACK = {
  sourceRef: { provider: 'itunes', kind: 'track', id: '123' },
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  durationMs: 200_000,
  releaseYear: 2020,
  artwork: [{ url: 'https://art.example/x.png', width: 100, height: 100 }],
  explicit: false,
  genre: 'Rock',
  storefront: 'US',
  artistRef: null,
  albumRef: null,
  isrc: null,
};

function attempt(requestId: string): AttemptSummaryPayload {
  return {
    requestId,
    steps: 1,
    httpCalls: 1,
    bytes: 1,
    fuelUsed: 1,
    elapsedMs: 1,
    httpTrace: [],
    guestLog: [],
  };
}

function succeeded(requestId: string, result: unknown): RequestOutcomePayload {
  return {
    type: 'succeeded',
    resultJson: JSON.stringify(result),
    attempt: attempt(requestId),
  };
}

function failed(
  requestId: string,
  kind: string,
  message: string,
): RequestOutcomePayload {
  return { type: 'failed', kind, message, attempt: attempt(requestId) };
}

let contextSeq = 0;

function ctx(source = new CancellationSource()): {
  context: OperationContext;
  source: CancellationSource;
} {
  contextSeq += 1;
  return {
    context: {
      requestId: `t-${contextSeq}`,
      deadlineMs: Number.MAX_SAFE_INTEGER,
      signal: source.signal,
    },
    source,
  };
}

/**
 * The promise-shaped host seam: `request` records the args and parks
 * until `settle`/`succeed`/`fail` resolves it — there is no outcome
 * listener because the resolve value IS the terminal outcome.
 */
class FakeHost implements AuqwHost {
  requests: HostRequestArgs[] = [];
  cancelled: string[] = [];
  nextFailure: unknown = null;
  #pending = new Map<string, (outcome: RequestOutcomePayload) => void>();

  plugins(): Promise<HostPluginsResult> {
    return Promise.resolve({ bindings: 'loaded', plugins: [], manifests: [] });
  }

  request(args: HostRequestArgs): Promise<RequestOutcomePayload> {
    this.requests.push(args);
    if (this.nextFailure !== null) {
      const failure = this.nextFailure;
      this.nextFailure = null;
      return Promise.reject(failure);
    }
    return new Promise((resolve) => {
      this.#pending.set(args.requestId, resolve);
    });
  }

  cancelRequest(args: HostCancelArgs): Promise<void> {
    this.cancelled.push(args.requestId);
    return Promise.resolve();
  }

  /** Resolves the parked request with a raw outcome payload. */
  settle(requestId: string, outcome: RequestOutcomePayload): void {
    const resolve = this.#pending.get(requestId);
    if (resolve === undefined) {
      return;
    }
    this.#pending.delete(requestId);
    resolve(outcome);
  }

  succeed(requestId: string, result: unknown): void {
    this.settle(requestId, succeeded(requestId, result));
  }

  fail(requestId: string, kind: string, message: string): void {
    this.settle(requestId, failed(requestId, kind, message));
  }
}

const ALL_CAPS: readonly ProviderCapability[] = [
  'catalog.search',
  'catalog.metadata',
  'catalog.artwork',
  'catalog.entity',
  'catalog.suggest',
  'playback.candidates',
  'playback.resolve',
  'lyrics.plain',
  'lyrics.synced',
  'radio.seed',
];

function provider(
  host: FakeHost,
  capabilities: readonly ProviderCapability[] = ALL_CAPS,
) {
  return createPluginProvider(host, 'plugin-x', 'provider-x', capabilities);
}

function rig(
  capabilities: readonly ProviderCapability[] = ALL_CAPS,
): { host: FakeHost; p: ReturnType<typeof provider> } {
  const host = new FakeHost();
  return { host, p: provider(host, capabilities) };
}

async function flush(): Promise<void> {
  // Double-tap: let the async request() wrapper reach host.request
  // registration before the outcome lands.
  await Promise.resolve();
  await Promise.resolve();
}

// 1. Wire payloads match the ABI's exact snake_case key sets.
async function payloadShapes(): Promise<void> {
  const { host, p } = rig();

  const search = p.search(
    { query: 'roads', limit: 5, storefront: 'US' },
    ctx().context,
  );
  await flush();
  assertDeepEqual(host.requests[0], {
    pluginId: 'plugin-x',
    capability: 'catalog.search',
    payloadJson: JSON.stringify({
      query: 'roads',
      limit: 5,
      storefront: 'US',
    }),
    requestId: host.requests[0]?.requestId,
  });
  host.succeed(host.requests[0]!.requestId, {
    items: [WIRE_TRACK],
    storefront: 'US',
  });
  const searchResult = await search;
  assert(searchResult.ok);
  assertDeepEqual(searchResult.value, {
    items: [DOMAIN_TRACK],
    entities: [],
    topHit: null,
    continuation: null,
    storefront: 'US',
  });

  const candidates = p.candidates(
    {
      query: {
        title: 'T',
        artist: 'A',
        album: null,
        durationMs: 1000,
        versionLabels: ['live'],
        isrc: null,
      },
      limit: 3,
    },
    ctx().context,
  );
  await flush();
  assertDeepEqual(host.requests[1], {
    pluginId: 'plugin-x',
    capability: 'playback.candidates',
    payloadJson: JSON.stringify({
      query: {
        title: 'T',
        artist: 'A',
        album: null,
        duration_ms: 1000,
        version_labels: ['live'],
        isrc: null,
      },
      limit: 3,
    }),
    requestId: host.requests[1]?.requestId,
  });
  host.succeed(host.requests[1]!.requestId, { items: [WIRE_TRACK] });
  const candResult = await candidates;
  assert(candResult.ok);
  assertDeepEqual(candResult.value, [DOMAIN_TRACK]);

  const resolve = p.resolvePlayback(
    ref('ytm', 'v1'),
    {
      targetBitrateKbps: 128,
      prefer: ['audio/webm', 'audio/mp4'],
      pinItag: null,
      resumeOffset: null,
    },
    ctx().context,
  );
  await flush();
  assertDeepEqual(host.requests[2], {
    pluginId: 'plugin-x',
    capability: 'playback.resolve',
    payloadJson: JSON.stringify({
      source_ref: { provider: 'ytm', kind: 'track', id: 'v1' },
      target_bitrate_kbps: 128,
      prefer: ['audio/webm', 'audio/mp4'],
      pin_itag: null,
      resume_offset: null,
    }),
    requestId: host.requests[2]?.requestId,
  });
  host.succeed(host.requests[2]!.requestId, {
    url: 'https://cdn.example/x',
    mime: 'audio/mp4',
    bitrate_kbps: 128,
    expires_at_ms: 999,
    client: 'web',
  });
  const resResult = await resolve;
  assert(resResult.ok);
  assertDeepEqual(resResult.value, {
    url: 'https://cdn.example/x',
    mime: 'audio/mp4',
    bitrateKbps: 128,
    expiresAtMs: 999,
    contentLength: null,
    client: 'web',
    itag: null,
    headers: {},
  });

  const artwork = p.artwork(ref('itunes', '123'), { size: 600 }, ctx().context);
  await flush();
  assertDeepEqual(host.requests[3], {
    pluginId: 'plugin-x',
    capability: 'catalog.artwork',
    payloadJson: JSON.stringify({
      ref: { provider: 'itunes', kind: 'track', id: '123' },
      size: 600,
    }),
    requestId: host.requests[3]?.requestId,
  });
  host.succeed(host.requests[3]!.requestId, {
    source_ref: { provider: 'itunes', kind: 'track', id: '123' },
    items: [{ url: 'https://art.example/y.png', width: 300, height: 300 }],
  });
  const artResult = await artwork;
  assert(artResult.ok);
  assertDeepEqual(artResult.value, [
    { url: 'https://art.example/y.png', width: 300, height: 300 },
  ]);
}

// 2. Concurrent ops settle on their own minted requestId.
async function concurrentCorrelation(): Promise<void> {
  const { host, p } = rig();
  const a = p.search(
    { query: 'a', limit: 1, storefront: null },
    ctx().context,
  );
  const b = p.search(
    { query: 'b', limit: 1, storefront: null },
    ctx().context,
  );
  await flush();
  const [reqA, reqB] = host.requests;
  assert(reqA !== undefined && reqB !== undefined);
  assert(reqA.requestId !== reqB.requestId);
  // Out-of-order settles still correlate by requestId.
  host.succeed(reqB.requestId, {
    items: [{ ...WIRE_TRACK, title: 'B' }],
    storefront: null,
  });
  host.succeed(reqA.requestId, {
    items: [{ ...WIRE_TRACK, title: 'A' }],
    storefront: null,
  });
  const ra = await a;
  const rb = await b;
  assert(ra.ok && rb.ok);
  assertEqual(ra.value.items[0]?.title, 'A');
  assertEqual(rb.value.items[0]?.title, 'B');
}

// 3. Malformed resultJson and validation failures → invalid-response.
async function malformedResults(): Promise<void> {
  const { host, p } = rig();
  const badJson = p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  await flush();
  host.settle(host.requests[0]!.requestId, {
    type: 'succeeded',
    resultJson: '{not json',
    attempt: attempt(host.requests[0]!.requestId),
  });
  const r1 = await badJson;
  assert(!r1.ok && r1.error.kind === 'invalid-response');

  const missingField = p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  await flush();
  // `storefront` missing — decode rejects rather than fabricating.
  host.succeed(host.requests[1]!.requestId, { items: [] });
  const r2 = await missingField;
  assert(!r2.ok && r2.error.kind === 'invalid-response');

  // A succeeded outcome with no resultJson at all is malformed too.
  const absent = p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  await flush();
  host.settle(host.requests[2]!.requestId, {
    type: 'succeeded',
    attempt: attempt(host.requests[2]!.requestId),
  });
  const r3 = await absent;
  assert(!r3.ok && r3.error.kind === 'invalid-response');
}

// 4. failed outcomes map to typed appError by kind.
async function failedOutcomeKinds(): Promise<void> {
  const { host, p } = rig();
  const rate = p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  await flush();
  host.fail(host.requests[0]!.requestId, 'rate-limit', 'slow down');
  const r1 = await rate;
  assert(!r1.ok && r1.error.kind === 'rate-limit');
  assertEqual(r1.error.message, 'slow down');

  const auth = p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  await flush();
  host.fail(host.requests[1]!.requestId, 'auth-required', 'sign in');
  const r2 = await auth;
  assert(!r2.ok && r2.error.kind === 'auth-required');

  // Unknown kind slugs degrade to internal, never a raw throw.
  const weird = p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  await flush();
  host.fail(host.requests[2]!.requestId, 'weird-host-kind', '');
  const r3 = await weird;
  assert(!r3.ok && r3.error.kind === 'internal');

  // Object.prototype member slugs degrade the same way — the kind
  // lookup is an own-property check, never `in`.
  for (const slug of ['toString', 'constructor', '__proto__']) {
    const proto = p.search(
      { query: 'x', limit: 1, storefront: null },
      ctx().context,
    );
    await flush();
    host.fail(host.requests.at(-1)!.requestId, slug, 'x');
    const r = await proto;
    assert(!r.ok && r.error.kind === 'internal', `${slug} degrades`);
  }

  // Same for a rejection carrying a ShellError-shaped proto slug.
  host.nextFailure = { kind: 'hasOwnProperty', message: 'x' };
  const rejected = p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  const r4 = await rejected;
  assert(!r4.ok && r4.error.kind === 'internal');
}

// 4b. A guest's `retry_after=<secs>` message hint lands on the error's
// retryAfterMs — the retry policy honors the provider's own cooldown.
async function retryAfterHint(): Promise<void> {
  const { host, p } = rig();
  const call = p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  await flush();
  host.fail(
    host.requests[0]!.requestId,
    'rate-limit',
    'rate-limit: lrclib status 429 retry_after=30',
  );
  const r1 = await call;
  assert(!r1.ok && r1.error.kind === 'rate-limit');
  assertEqual(r1.error.retryAfterMs, 30_000, 'hint parsed to ms');

  // No hint → no retryAfterMs; a malformed one is ignored.
  const plain = p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  await flush();
  host.fail(host.requests[1]!.requestId, 'rate-limit', 'slow down');
  const r2 = await plain;
  assert(!r2.ok && r2.error.retryAfterMs === undefined);
  const weird = p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  await flush();
  host.fail(
    host.requests[2]!.requestId,
    'rate-limit',
    'retry_after=abc retry_after=',
  );
  const r3 = await weird;
  assert(!r3.ok && r3.error.retryAfterMs === undefined);
}

// 5. Signal cancellation aborts the host request and settles cancelled;
// a late success must not clobber the cancelled settle.
async function cancellation(): Promise<void> {
  const { host, p } = rig();
  const { context, source } = ctx();
  const call = p.search(
    { query: 'x', limit: 1, storefront: null },
    context,
  );
  await flush();
  const reqId = host.requests[0]!.requestId;
  source.cancel();
  const result = await call;
  assert(!result.ok && result.error.kind === 'cancelled');
  assertDeepEqual(host.cancelled, [reqId]);

  // The host's late terminal outcome lands on a dead settle — the
  // first Result stands.
  host.succeed(reqId, { items: [WIRE_TRACK], storefront: null });
  await flush();
  const again = p.search(
    { query: 'y', limit: 1, storefront: null },
    ctx().context,
  );
  await flush();
  host.succeed(host.requests[1]!.requestId, {
    items: [WIRE_TRACK],
    storefront: null,
  });
  const settled = await again;
  assert(settled.ok);
  assertDeepEqual(settled.value.items, [DOMAIN_TRACK]);
}

// 6. A signal already cancelled pre-op never issues a host request —
// and no stray cancelRequest lands for a request that never existed.
async function preCancelled(): Promise<void> {
  const { host, p } = rig();
  const source = new CancellationSource();
  source.cancel();
  const { context } = ctx(source);
  const result = await p.search(
    { query: 'x', limit: 1, storefront: null },
    context,
  );
  assert(!result.ok && result.error.kind === 'cancelled');
  assertEqual(host.requests.length, 0);
  assertEqual(host.cancelled.length, 0);
}

// 7. dispose settles in-flight ops cancelled and turns later ops
// unavailable — the host gets the abort for what it still holds.
async function dispose(): Promise<void> {
  const { host, p } = rig();
  const inFlight = p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  await flush();
  const reqId = host.requests[0]!.requestId;
  p.dispose();
  const settled = await inFlight;
  assert(!settled.ok && settled.error.kind === 'cancelled');
  assertDeepEqual(host.cancelled, [reqId]);

  const after = await p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  assert(!after.ok && after.error.kind === 'unavailable');
  assertEqual(host.requests.length, 1);
  p.dispose(); // idempotent
}

// 8. A host.request rejection (ShellError-shaped IPC failure) maps to
// the matching typed error.
async function requestRejection(): Promise<void> {
  const { host, p } = rig();
  host.nextFailure = { kind: 'unavailable', message: 'plugin crashed' };
  const crashed = await p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  assert(!crashed.ok && crashed.error.kind === 'unavailable');
  assertEqual(crashed.error.message, 'plugin crashed');

  host.nextFailure = new Error('boom');
  const plain = await p.search(
    { query: 'x', limit: 1, storefront: null },
    ctx().context,
  );
  assert(!plain.ok && plain.error.kind === 'internal');
}

// 9. The context deadline bounds a host call even when nothing
// cancels it: expiry aborts the request utility-side and settles
// typed `timeout`; a deadline already spent never issues at all.
async function deadlineBoundsRequest(): Promise<void> {
  const { host, p } = rig();
  const call = p.search(
    { query: 'x', limit: 1, storefront: null },
    { ...ctx().context, deadlineMs: Date.now() + 15 },
  );
  await flush();
  const reqId = host.requests[0]!.requestId;
  const result = await call;
  assert(!result.ok && result.error.kind === 'timeout');
  assertDeepEqual(host.cancelled, [reqId]);
  // A late terminal outcome can't clobber the timeout settle.
  host.succeed(reqId, { items: [WIRE_TRACK], storefront: null });
  await flush();

  const spent = await p.search(
    { query: 'y', limit: 1, storefront: null },
    { ...ctx().context, deadlineMs: Date.now() - 1 },
  );
  assert(!spent.ok && spent.error.kind === 'timeout');
  assertEqual(host.requests.length, 1);
  assertEqual(host.cancelled.length, 1); // never issued → no cancel
}

// 10. catalog.entity decodes entity + items + continuation honestly.
async function entityOp(): Promise<void> {
  const { host, p } = rig();
  const call = p.getEntity(
    { provider: 'deezer', kind: 'album', id: 'a1' },
    ctx().context,
  );
  await flush();
  assertDeepEqual(host.requests[0], {
    pluginId: 'plugin-x',
    capability: 'catalog.entity',
    payloadJson: JSON.stringify({
      ref: { provider: 'deezer', kind: 'album', id: 'a1' },
    }),
    requestId: host.requests[0]?.requestId,
  });
  host.succeed(host.requests[0]!.requestId, {
    entity: {
      source_ref: { provider: 'deezer', kind: 'album', id: 'a1' },
      kind: 'album',
      title: 'Album T',
      subtitle: 'Artist',
      artwork: [],
    },
    items: [WIRE_TRACK],
    continuation: null,
    complete: true,
  });
  const result = await call;
  assert(result.ok);
  assertEqual(result.value.entity.title, 'Album T');
  assertEqual(result.value.items.length, 1);
  assertEqual(result.value.complete, true);
}

// 11. A mismatched artwork source_ref is a protocol violation, not
// a different track's artwork.
async function artworkRefMismatch(): Promise<void> {
  const { host, p } = rig();
  const call = p.artwork(ref('itunes', '123'), { size: 600 }, ctx().context);
  await flush();
  host.succeed(host.requests[0]!.requestId, {
    source_ref: { provider: 'itunes', kind: 'track', id: 'DIFFERENT' },
    items: [],
  });
  const result = await call;
  assert(!result.ok && result.error.kind === 'invalid-response');
}

// 12. An op outside the declared set is unsupported without a host call.
async function undeclaredCapability(): Promise<void> {
  const { host, p } = rig(['catalog.search']);
  const entity = await p.getEntity(
    { provider: 'deezer', kind: 'album', id: 'a1' },
    ctx().context,
  );
  assert(!entity.ok && entity.error.kind === 'unsupported');
  const lyrics = await p.getLyrics(
    {
      query: {
        title: 'x',
        artist: null,
        album: null,
        durationMs: null,
        isrc: null,
      },
      prefer: 'synced',
    },
    ctx().context,
  );
  assert(!lyrics.ok && lyrics.error.kind === 'unsupported');
  const radio = await p.radioSeed(
    { continuation: 'c' },
    ctx().context,
  );
  assert(!radio.ok && radio.error.kind === 'unsupported');
  const details = await p.getDetails(
    [ref('itunes', '1')],
    ctx().context,
  );
  assert(!details.ok && details.error.kind === 'unsupported');
  const artwork = await p.artwork(
    ref('itunes', '1'),
    { size: 600 },
    ctx().context,
  );
  assert(!artwork.ok && artwork.error.kind === 'unsupported');
  assertEqual(host.requests.length, 0, 'no host request started');
}

// 13. radio.seed dual payload and continuation=null honest end.
async function radioOps(): Promise<void> {
  const { host, p } = rig();
  const seed = p.radioSeed(
    { sourceRef: { provider: 'youtube-music', kind: 'track', id: 'v1' } },
    ctx().context,
  );
  await flush();
  assertDeepEqual(host.requests[0], {
    pluginId: 'plugin-x',
    capability: 'radio.seed',
    payloadJson: JSON.stringify({
      source_ref: { provider: 'youtube-music', kind: 'track', id: 'v1' },
    }),
    requestId: host.requests[0]?.requestId,
  });
  host.succeed(host.requests[0]!.requestId, {
    items: [WIRE_TRACK],
    continuation: 'cont-1',
  });
  const seedResult = await seed;
  assert(seedResult.ok);
  assertDeepEqual(seedResult.value, {
    candidates: [DOMAIN_TRACK],
    continuation: 'cont-1',
  });

  const next = p.radioSeed({ continuation: 'cont-1' }, ctx().context);
  await flush();
  assertDeepEqual(host.requests[1]?.payloadJson, JSON.stringify({ continuation: 'cont-1' }));
  host.succeed(host.requests[1]!.requestId, { items: [], continuation: null });
  const nextResult = await next;
  assert(nextResult.ok);
  assertDeepEqual(nextResult.value, {
    candidates: [],
    continuation: null,
  });
}

// 14. Lyrics prefer routing: synced when declared, plain otherwise;
// honesty states decode (plain never presents as synced).
async function lyricsOps(): Promise<void> {
  const { host, p } = rig();
  const query = {
    title: 'Song',
    artist: 'Artist',
    album: null,
    durationMs: 200_000,
    isrc: null,
  };
  const synced = p.getLyrics({ query, prefer: 'synced' }, ctx().context);
  await flush();
  assertEqual(host.requests[0]?.capability, 'lyrics.synced');
  host.succeed(host.requests[0]!.requestId, {
    state: 'synced',
    lines: [{ t_ms: 0, text: 'line one' }],
    matched: null,
  });
  const syncedResult = await synced;
  assert(syncedResult.ok && syncedResult.value.kind === 'synced');

  const plainOnly = provider(host, ['lyrics.plain']);
  const degraded = plainOnly.getLyrics(
    { query, prefer: 'synced' },
    ctx().context,
  );
  await flush();
  assertEqual(host.requests[1]?.capability, 'lyrics.plain');
  host.succeed(host.requests[1]!.requestId, {
    state: 'plain',
    text: 'plain words',
    matched: null,
  });
  const degradedResult = await degraded;
  assert(degradedResult.ok && degradedResult.value.kind === 'plain');
}

// 15. catalog.suggest carries {input, limit} verbatim and decodes the
// suggestion list strictly — extra keys or empty entries fail closed,
// an undeclared capability never reaches the host.
async function suggestOps(): Promise<void> {
  const { host, p } = rig();
  const call = p.suggest({ input: 'awa', limit: 7 }, ctx().context);
  await flush();
  assertDeepEqual(host.requests[0], {
    pluginId: 'plugin-x',
    capability: 'catalog.suggest',
    payloadJson: JSON.stringify({ input: 'awa', limit: 7 }),
    requestId: host.requests[0]?.requestId,
  });
  host.succeed(host.requests[0]!.requestId, {
    suggestions: ['awa lacrim', 'awa 2 lacrim'],
  });
  const result = await call;
  assert(result.ok);
  assertDeepEqual(result.value, ['awa lacrim', 'awa 2 lacrim']);

  // An empty suggestion string fails the whole list closed.
  const emptyEntry = p.suggest({ input: 'x' }, ctx().context);
  await flush();
  host.succeed(host.requests[1]!.requestId, { suggestions: ['ok', ''] });
  const r2 = await emptyEntry;
  assert(!r2.ok && r2.error.kind === 'invalid-response');

  // So does an unexpected extra key alongside `suggestions`.
  const extraKey = p.suggest({ input: 'x' }, ctx().context);
  await flush();
  host.succeed(host.requests[2]!.requestId, {
    suggestions: ['ok'],
    continuation: 'c',
  });
  const r3 = await extraKey;
  assert(!r3.ok && r3.error.kind === 'invalid-response');

  const capped = provider(host, ['catalog.search']);
  const denied = await capped.suggest({ input: 'x' }, ctx().context);
  assert(!denied.ok && denied.error.kind === 'unsupported');
  assertEqual(host.requests.length, 3, 'no host request started');
}

/**
 * The mint `headers` field decodes per the wire contract — the leg
 * the desktop download path died on: the strict key check rejected
 * the unknown `headers` key, so every resolve carrying mint headers
 * failed invalid-response before a byte was fetched.
 */
async function resolveHeaders(): Promise<void> {
  const succeed = async (headers: unknown) => {
    const { host, p } = rig();
    const call = p.resolvePlayback(
      ref('ytm', 'v1'),
      {
        targetBitrateKbps: 128,
        prefer: ['audio/mp4'],
        pinItag: null,
        resumeOffset: null,
      },
      ctx().context,
    );
    await flush();
    host.succeed(host.requests[0]!.requestId, {
      url: 'https://cdn.example/x',
      mime: 'audio/mp4',
      bitrate_kbps: 128,
      expires_at_ms: 999,
      client: 'web',
      itag: 140,
      headers,
    });
    return call;
  };

  // Absent / null → empty headers.
  {
    const r = await succeed(null);
    assert(r.ok, 'null headers decode');
    assertDeepEqual(r.ok ? r.value.headers : null, {}, 'null → {}');
  }
  {
    const r = await succeed({ 'user-agent': 'UA/1.0', 'X-Ref': 'r' });
    assert(r.ok, 'mint headers decode');
    assertDeepEqual(r.ok ? r.value.headers : null, {
      'user-agent': 'UA/1.0',
      'x-ref': 'r',
    });
  }
  // ≥0x80 codepoints encode to all-≥0x80 UTF-8 bytes — the native
  // byte-level rule admits them; the TS decoder must agree.
  for (const [label, headerValue] of [
    ['2-byte char', 'Ā'],
    ['4-byte char', '\u{1F3B5}'],
    ['exactly 512 bytes', 'Ā'.repeat(256)],
  ] as const) {
    const r = await succeed({ 'x-client': headerValue });
    assert(r.ok, `unicode accepted: ${label}`);
  }

  // Every malformed shape → invalid-response, like the native decoder.
  const rejected: readonly [string, unknown][] = [
    ['host-owned name', { range: 'bytes=0-1' }],
    ['host-owned, cased', { Cookie: 'a=b' }],
    ['non-token name', { 'bad name': 'v' }],
    ['case-folded dup', { 'X-A': '1', 'x-a': '2' }],
    ['control char', { 'user-agent': 'UA\nInjected: x' }],
    ['lone surrogate', { 'user-agent': 'UA\ud800' }],
    ['over-long value', { 'user-agent': 'x'.repeat(513) }],
    ['over 512 bytes multibyte', { 'user-agent': 'Ā'.repeat(257) }],
    [
      'over 16 entries',
      Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [`x-${i}`, 'v']),
      ),
    ],
    ['not an object', ['user-agent']],
  ];
  for (const [label, headers] of rejected) {
    const r = await succeed(headers);
    assert(
      !r.ok && r.error.kind === 'invalid-response',
      `headers rejected: ${label}`,
    );
  }
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['payloadShapes', payloadShapes],
  ['resolveHeaders', resolveHeaders],
  ['concurrentCorrelation', concurrentCorrelation],
  ['malformedResults', malformedResults],
  ['failedOutcomeKinds', failedOutcomeKinds],
  ['retryAfterHint', retryAfterHint],
  ['cancellation', cancellation],
  ['preCancelled', preCancelled],
  ['dispose', dispose],
  ['requestRejection', requestRejection],
  ['deadlineBoundsRequest', deadlineBoundsRequest],
  ['entityOp', entityOp],
  ['artworkRefMismatch', artworkRefMismatch],
  ['undeclaredCapability', undeclaredCapability],
  ['radioOps', radioOps],
  ['lyricsOps', lyricsOps],
  ['suggestOps', suggestOps],
];

export async function run(): Promise<void> {
  for (const [name, fn] of TESTS) {
    try {
      await fn();
    } catch (thrown) {
      throw new Error(`plugin-provider test failed: ${name}`, {
        cause: thrown,
      });
    }
  }
}
