import type {
  OperationContext,
  Result,
  SourceRef,
} from '@auqw/application';
import { CancellationSource } from '@auqw/application';
import { assert, assertDeepEqual, assertEqual } from '@auqw/application/testing';
import type {
  AuqwExpoHostLike,
  AuqwExpoRequestOutcome,
  AuqwExpoRequestOutcomeEvent,
  AuqwExpoSubscription,
} from './auqw-expo-surface.ts';
import { createPluginProvider } from './plugin-provider.ts';

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
};

function attempt(requestId: string) {
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

function succeeded(requestId: string, result: unknown): AuqwExpoRequestOutcome {
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
): AuqwExpoRequestOutcome {
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

class FakeHost implements AuqwExpoHostLike {
  requests: {
    pluginId: string;
    capability: string;
    payload: Record<string, unknown>;
  }[] = [];
  cancelled: string[] = [];
  startFailure: unknown = null;
  removals = 0;
  #seq = 0;
  #lastId = '';
  #listeners = new Set<
    (event: AuqwExpoRequestOutcomeEvent) => void
  >();

  startRequest(
    pluginId: string,
    capability: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    this.requests.push({ pluginId, capability, payload });
    if (this.startFailure !== null) {
      return Promise.reject(this.startFailure);
    }
    this.#seq += 1;
    this.#lastId = `req-${this.#seq}`;
    return Promise.resolve(this.#lastId);
  }

  get lastId(): string {
    return this.#lastId;
  }

  cancel(requestId: string): void {
    this.cancelled.push(requestId);
  }

  addRequestOutcomeListener(
    listener: (event: AuqwExpoRequestOutcomeEvent) => void,
  ): AuqwExpoSubscription {
    this.#listeners.add(listener);
    return {
      remove: () => {
        this.#listeners.delete(listener);
        this.removals += 1;
      },
    };
  }

  listenerCount(): number {
    return this.#listeners.size;
  }

  emit(requestId: string, outcome: AuqwExpoRequestOutcome): void {
    for (const listener of [...this.#listeners]) {
      listener({ requestId, outcome });
    }
  }

  succeed(requestId: string, result: unknown): void {
    this.emit(requestId, succeeded(requestId, result));
  }

  fail(requestId: string, kind: string, message: string): void {
    this.emit(requestId, failed(requestId, kind, message));
  }
}

function provider(host: FakeHost) {
  return createPluginProvider(host, 'plugin-x', 'itunes');
}

/** Lets the pending registration land after startRequest resolves. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// 1. Payloads match the wire schema exactly per capability.
async function payloadShapes(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const search = p.search(
    { query: 'roads', limit: 25, storefront: 'US' },
    ctx().context,
  );
  assertDeepEqual(host.requests[0], {
    pluginId: 'plugin-x',
    capability: 'catalog.search',
    payload: { query: 'roads', limit: 25, storefront: 'US' },
  });
  host.succeed('req-1', { items: [WIRE_TRACK], storefront: 'US' });
  const searchResult = await search;
  assert(searchResult.ok, 'search ok');
  assertDeepEqual(searchResult.value, {
    items: [DOMAIN_TRACK],
    storefront: 'US',
  });

  const candidates = p.candidates(
    {
      query: {
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        durationMs: 200_000,
        versionLabels: ['live', 'remaster'],
        isrc: 'USRC17607839',
      },
      limit: 25,
    },
    ctx().context,
  );
  assertDeepEqual(host.requests[1], {
    pluginId: 'plugin-x',
    capability: 'playback.candidates',
    payload: {
      query: {
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        duration_ms: 200_000,
        version_labels: ['live', 'remaster'],
        isrc: 'USRC17607839',
      },
      limit: 25,
    },
  });
  host.succeed('req-2', { items: [WIRE_TRACK] });
  const candidatesResult = await candidates;
  assert(candidatesResult.ok);
  assertDeepEqual(candidatesResult.value, [DOMAIN_TRACK]);

  const resolve = p.resolvePlayback(
    ref('youtube-music', 'abcDEF123_-'),
    {
      targetBitrateKbps: 128,
      prefer: ['audio/mp4', 'audio/webm'],
      pinItag: null,
      resumeOffset: null,
    },
    ctx().context,
  );
  assertDeepEqual(host.requests[2], {
    pluginId: 'plugin-x',
    capability: 'playback.resolve',
    payload: {
      source_ref: { provider: 'youtube-music', kind: 'track', id: 'abcDEF123_-' },
      target_bitrate_kbps: 128,
      prefer: ['audio/mp4', 'audio/webm'],
      pin_itag: null,
      resume_offset: null,
    },
  });
  host.succeed('req-3', {
    url: 'https://g.example/v',
    mime: 'audio/mp4',
    bitrate_kbps: 128,
    expires_at_ms: 9_999,
    content_length: 1_024,
    client: 'ios',
    itag: 140,
  });
  const resolved = await resolve;
  assert(resolved.ok, 'resolve ok');
  assertDeepEqual(resolved.value, {
    url: 'https://g.example/v',
    mime: 'audio/mp4',
    bitrateKbps: 128,
    expiresAtMs: 9_999,
    contentLength: 1_024,
    client: 'ios',
    itag: 140,
  });

  const details = p.getDetails(
    [ref('itunes', '1'), ref('itunes', '2')],
    ctx().context,
  );
  assertDeepEqual(host.requests[3], {
    pluginId: 'plugin-x',
    capability: 'catalog.metadata',
    payload: {
      refs: [
        { provider: 'itunes', kind: 'track', id: '1' },
        { provider: 'itunes', kind: 'track', id: '2' },
      ],
    },
  });
  host.succeed('req-4', { items: [WIRE_TRACK] });
  const detailsResult = await details;
  assert(detailsResult.ok);
  assertDeepEqual(detailsResult.value, [DOMAIN_TRACK]);
}

// 2. Request-id correlation across concurrent calls.
async function concurrentCorrelation(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const a = p.search({ query: 'a', limit: 5, storefront: null }, ctx().context);
  const b = p.search({ query: 'b', limit: 5, storefront: null }, ctx().context);
  const c = p.search({ query: 'c', limit: 5, storefront: null }, ctx().context);
  await flush();
  // Outcomes return out of order; each call resolves with its own page.
  host.succeed('req-3', { items: [], storefront: 'DE' });
  host.succeed('req-1', { items: [WIRE_TRACK], storefront: 'US' });
  host.succeed('req-2', { items: [], storefront: 'FR' });
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert(ra.ok && rb.ok && rc.ok);
  assertDeepEqual(ra.value, { items: [DOMAIN_TRACK], storefront: 'US' });
  assertDeepEqual(rb.value, { items: [], storefront: 'FR' });
  assertDeepEqual(rc.value, { items: [], storefront: 'DE' });
}

// 3. Malformed resultJson and wrong shapes are invalid-response.
async function malformedResults(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const badJson = p.search(
    { query: 'x', limit: 5, storefront: null },
    ctx().context,
  );
  await flush();
  host.emit('req-1', {
    type: 'succeeded',
    resultJson: '{not-json',
    attempt: attempt('req-1'),
  });
  const r1 = await badJson;
  assert(!r1.ok && r1.error.kind === 'invalid-response', 'bad JSON');

  const wrongShape = p.search(
    { query: 'x', limit: 5, storefront: null },
    ctx().context,
  );
  await flush();
  host.succeed('req-2', { items: 'not-an-array', storefront: 'US' });
  const r2 = await wrongShape;
  assert(!r2.ok && r2.error.kind === 'invalid-response', 'wrong shape');

  const badTrack = p.search(
    { query: 'x', limit: 5, storefront: null },
    ctx().context,
  );
  await flush();
  host.succeed('req-3', {
    items: [{ ...WIRE_TRACK, title: '' }],
    storefront: 'US',
  });
  const r3 = await badTrack;
  assert(!r3.ok && r3.error.kind === 'invalid-response', 'bad track');

  const extraKeys = p.search(
    { query: 'x', limit: 5, storefront: null },
    ctx().context,
  );
  await flush();
  host.succeed('req-4', {
    items: [WIRE_TRACK],
    storefront: 'US',
    extra: true,
  });
  const r4 = await extraKeys;
  assert(!r4.ok && r4.error.kind === 'invalid-response', 'extra keys');
}

// 4. A host `failed` outcome surfaces the typed taxonomy kind.
async function failedOutcomeKinds(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const call = p.search(
    { query: 'x', limit: 5, storefront: null },
    ctx().context,
  );
  await flush();
  host.fail('req-1', 'rate-limit', 'slow down');
  const result = await call;
  assert(!result.ok, 'failed outcome is an error');
  assertEqual(result.error.kind, 'rate-limit');
  assertEqual(result.error.retryable, true);
  assertEqual(result.error.message, 'slow down');

  const unknown = p.search(
    { query: 'x', limit: 5, storefront: null },
    ctx().context,
  );
  await flush();
  host.fail('req-2', 'some-future-kind', 'x');
  const weird = await unknown;
  assert(!weird.ok && weird.error.kind === 'internal', 'unknown → internal');
}

// 5. Signal cancellation aborts the host request and resolves
// cancelled; a late outcome is dropped.
async function cancellation(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const { context, source } = ctx();
  const call = p.search({ query: 'x', limit: 5, storefront: null }, context);
  await flush();
  source.cancel();
  const result = await call;
  assert(!result.ok && result.error.kind === 'cancelled', 'cancelled result');
  assertDeepEqual(host.cancelled, ['req-1'], 'host cancel forwarded');

  // A late outcome for the cancelled request is dropped; a subsequent
  // call still correlates cleanly.
  host.succeed('req-1', { items: [WIRE_TRACK], storefront: 'US' });
  const next = p.search(
    { query: 'y', limit: 5, storefront: null },
    ctx().context,
  );
  await flush();
  host.succeed('req-2', { items: [], storefront: 'US' });
  const after = await next;
  assert(after.ok, 'next call resolves');
  assertDeepEqual(after.value, { items: [], storefront: 'US' });
}

// 6. An already-cancelled signal never reaches the host.
async function preCancelled(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const { context, source } = ctx();
  source.cancel();
  const result = await p.search(
    { query: 'x', limit: 5, storefront: null },
    context,
  );
  assert(!result.ok && result.error.kind === 'cancelled');
  assertEqual(host.requests.length, 0, 'no request started');
}

// 7. Dispose settles in-flight calls as cancelled, removes the
// listener, and refuses new calls.
async function dispose(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const call = p.search({ query: 'x', limit: 5, storefront: null }, ctx().context);
  await flush();
  p.dispose();
  const result = await call;
  assert(!result.ok && result.error.kind === 'cancelled', 'in-flight cancelled');
  assertDeepEqual(host.cancelled, ['req-1']);
  assertEqual(host.removals, 1, 'outcome listener removed');
  assertEqual(host.listenerCount(), 0);
  const after = await p.search(
    { query: 'x', limit: 5, storefront: null },
    ctx().context,
  );
  assert(!after.ok && after.error.kind === 'unavailable', 'disposed refuses');
}

// 8. An outcome that outraces startRequest's promise is drained on
// registration.
async function earlyOutcome(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const call = p.search({ query: 'x', limit: 5, storefront: null }, ctx().context);
  // Emit before the adapter's startRequest continuation has run —
  // the outcome lands in the early stash and is drained on register.
  host.succeed('req-1', { items: [WIRE_TRACK], storefront: 'US' });
  const result = await call;
  assert(result.ok, 'early outcome consumed');
  assertDeepEqual(result.value, { items: [DOMAIN_TRACK], storefront: 'US' });
}

// 9. A startRequest rejection becomes a typed error, never throws.
async function startFailure(): Promise<void> {
  const host = new FakeHost();
  host.startFailure = Object.assign(new Error('host down'), {
    kind: 'unavailable',
  });
  const p = provider(host);
  const result = await p.search(
    { query: 'x', limit: 5, storefront: null },
    ctx().context,
  );
  assert(!result.ok && result.error.kind === 'unavailable');
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['payloadShapes', payloadShapes],
  ['concurrentCorrelation', concurrentCorrelation],
  ['malformedResults', malformedResults],
  ['failedOutcomeKinds', failedOutcomeKinds],
  ['cancellation', cancellation],
  ['preCancelled', preCancelled],
  ['dispose', dispose],
  ['earlyOutcome', earlyOutcome],
  ['startFailure', startFailure],
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
