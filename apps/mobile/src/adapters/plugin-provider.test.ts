import type {
  OperationContext,
  PlayableResource,
  ProviderCapability,
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
  artistRef: null,
  albumRef: null,
  isrc: null,
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

const ALL_CAPS: readonly ProviderCapability[] = [
  'catalog.search',
  'catalog.metadata',
  'catalog.artwork',
  'catalog.entity',
  'playback.candidates',
  'playback.resolve',
  'lyrics.plain',
  'lyrics.synced',
  'radio.seed',
];

function provider(
  host: FakeHost,
  caps: readonly ProviderCapability[] = ALL_CAPS,
) {
  return createPluginProvider(host, 'plugin-x', 'itunes', caps);
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
    entities: [],
    topHit: null,
    continuation: null,
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
    headers: {},
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

  const artwork = p.artwork(
    ref('itunes', '123'),
    { size: 1200 },
    ctx().context,
  );
  assertDeepEqual(host.requests[4], {
    pluginId: 'plugin-x',
    capability: 'catalog.artwork',
    payload: {
      ref: { provider: 'itunes', kind: 'track', id: '123' },
      size: 1200,
    },
  });
  host.succeed('req-5', {
    source_ref: { provider: 'itunes', kind: 'track', id: '123' },
    items: [
      { url: 'https://art.example/x.png', width: 1200, height: 1200 },
    ],
  });
  const artworkResult = await artwork;
  assert(artworkResult.ok);
  assertDeepEqual(artworkResult.value, [
    { url: 'https://art.example/x.png', width: 1200, height: 1200 },
  ]);
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
  assertDeepEqual(ra.value, { items: [DOMAIN_TRACK], entities: [], topHit: null, continuation: null, storefront: 'US' });
  assertDeepEqual(rb.value, { items: [], entities: [], topHit: null, continuation: null, storefront: 'FR' });
  assertDeepEqual(rc.value, { items: [], entities: [], topHit: null, continuation: null, storefront: 'DE' });
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
  assertDeepEqual(after.value, { items: [], entities: [], topHit: null, continuation: null, storefront: 'US' });
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
  assertDeepEqual(result.value, { items: [DOMAIN_TRACK], entities: [], topHit: null, continuation: null, storefront: 'US' });
}

// A context deadline caps the whole request: an already-elapsed
// deadline never reaches the host, a stalled startRequest settles
// 'timeout', and a hung outcome cancels the native request and
// settles 'timeout'.
async function requestDeadline(): Promise<void> {
  const expired = new FakeHost();
  const p1 = provider(expired);
  const elapsed = await p1.search(
    { query: 'x', limit: 5, storefront: null },
    {
      requestId: 't-expired',
      deadlineMs: 0,
      signal: new CancellationSource().signal,
    },
  );
  assert(!elapsed.ok && elapsed.error.kind === 'timeout', 'elapsed deadline');
  assertEqual(expired.requests.length, 0, 'expired request never starts');

  const stalled = new FakeHost();
  // The handshake answers long after the deadline — the caller still
  // settles 'timeout', and the late request id is cancelled rather
  // than orphaned.
  stalled.startRequest = () =>
    new Promise<string>((res) => setTimeout(() => res('req-late'), 30));
  const p2 = provider(stalled);
  const hanging = await p2.search(
    { query: 'x', limit: 5, storefront: null },
    {
      requestId: 't-stall',
      deadlineMs: Date.now() + 5,
      signal: new CancellationSource().signal,
    },
  );
  assert(
    !hanging.ok && hanging.error.kind === 'timeout',
    'stalled handshake times out',
  );
  await new Promise((res) => setTimeout(res, 40));
  assertDeepEqual(stalled.cancelled, ['req-late'], 'late id cancelled');

  const pending = new FakeHost();
  const p3 = provider(pending);
  const landed = p3.search(
    { query: 'x', limit: 5, storefront: null },
    {
      requestId: 't-pend',
      deadlineMs: Date.now() + 5,
      signal: new CancellationSource().signal,
    },
  );
  await flush();
  const done = await landed;
  assert(!done.ok && done.error.kind === 'timeout', 'outcome wait times out');
  assertDeepEqual(
    pending.cancelled,
    [pending.lastId],
    'native request cancelled at deadline',
  );
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

  // A synchronous throw is also a typed failure, never a rejection.
  const syncThrow = new FakeHost();
  syncThrow.startRequest = () => {
    throw Object.assign(new Error('host down'), { kind: 'unavailable' });
  };
  const p2 = provider(syncThrow);
  const refused = await p2.search(
    { query: 'x', limit: 5, storefront: null },
    ctx().context,
  );
  assert(!refused.ok && refused.error.kind === 'unavailable');
}

const WIRE_ENTITY = {
  source_ref: { provider: 'deezer', kind: 'album', id: 'a1' },
  kind: 'album',
  title: 'Album Title',
  subtitle: 'Artist',
  artwork: [{ url: 'https://art.example/a.png', width: 500, height: 500 }],
};

// 10. catalog.entity payload and result decode, including the
// complete flag and the optional continuation.
async function entityOp(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const call = p.getEntity(
    { provider: 'deezer', kind: 'album', id: 'a1' },
    ctx().context,
  );
  assertDeepEqual(host.requests[0], {
    pluginId: 'plugin-x',
    capability: 'catalog.entity',
    payload: { ref: { provider: 'deezer', kind: 'album', id: 'a1' } },
  });
  host.succeed('req-1', {
    entity: WIRE_ENTITY,
    items: [WIRE_TRACK],
    continuation: 'next-1',
    complete: false,
  });
  const result = await call;
  assert(result.ok);
  assertDeepEqual(result.value, {
    entity: {
      sourceRef: { provider: 'deezer', kind: 'album', id: 'a1' },
      kind: 'album',
      title: 'Album Title',
      subtitle: 'Artist',
      artwork: [
        { url: 'https://art.example/a.png', width: 500, height: 500 },
      ],
      group: null,
    },
    items: [DOMAIN_TRACK],
    related: [],
    continuation: 'next-1',
    complete: false,
  });
}

// 11. Contradictory or malformed entity pages are invalid-response.
async function entityMalformed(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const kindMismatch = p.getEntity(
    { provider: 'deezer', kind: 'album', id: 'a1' },
    ctx().context,
  );
  await flush();
  host.succeed('req-1', {
    entity: { ...WIRE_ENTITY, kind: 'artist' },
    items: [],
    complete: true,
  });
  const r1 = await kindMismatch;
  assert(!r1.ok && r1.error.kind === 'invalid-response', 'kind mismatch');

  const badComplete = p.getEntity(
    { provider: 'deezer', kind: 'album', id: 'a1' },
    ctx().context,
  );
  await flush();
  host.succeed('req-2', {
    entity: WIRE_ENTITY,
    items: [],
    complete: 'yes',
  });
  const r2 = await badComplete;
  assert(!r2.ok && r2.error.kind === 'invalid-response', 'bad complete');
}

// 11b. A structurally valid artwork answer for a *different* source
// ref is rejected — the wire ref correlates the response with the
// requested provider item, not just the shape.
async function artworkRefMismatch(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const call = p.artwork(
    ref('itunes', '123'),
    { size: 1200 },
    ctx().context,
  );
  await flush();
  host.succeed('req-1', {
    source_ref: { provider: 'itunes', kind: 'track', id: '456' },
    items: [
      { url: 'https://art.example/wrong.png', width: 1200, height: 1200 },
    ],
  });
  const result = await call;
  assert(!result.ok && result.error.kind === 'invalid-response');
}

// 12. Lyrics payloads: prefer picks the wire capability; synced
// degrades to lyrics.plain when the provider declares only that.
async function lyricsOps(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const query = {
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    durationMs: 200_000,
    isrc: null,
  };
  const synced = p.getLyrics({ query, prefer: 'synced' }, ctx().context);
  assertDeepEqual(host.requests[0], {
    pluginId: 'plugin-x',
    capability: 'lyrics.synced',
    payload: {
      query: {
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        duration_ms: 200_000,
        isrc: null,
      },
    },
  });
  host.succeed('req-1', {
    state: 'synced',
    lines: [
      { t_ms: 0, text: 'first' },
      { t_ms: 1_500, text: '' },
    ],
    matched: {
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      duration_ms: 199_000,
    },
  });
  const syncedResult = await synced;
  assert(syncedResult.ok);
  assertDeepEqual(syncedResult.value, {
    kind: 'synced',
    lines: [
      { tMs: 0, text: 'first' },
      { tMs: 1_500, text: '' },
    ],
    matched: {
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      durationMs: 199_000,
    },
  });

  const plain = p.getLyrics({ query, prefer: 'plain' }, ctx().context);
  assertEqual(host.requests[1]?.capability, 'lyrics.plain');
  host.succeed('req-2', {
    state: 'instrumental',
    matched: null,
  });
  const plainResult = await plain;
  assert(plainResult.ok);
  assertDeepEqual(plainResult.value, {
    kind: 'instrumental',
    matched: null,
  });

  // A plain-only provider answers a synced preference with an honest
  // plain variant — never a conversion.
  const plainOnly = provider(host, ['lyrics.plain']);
  const degraded = plainOnly.getLyrics(
    { query, prefer: 'synced' },
    ctx().context,
  );
  await flush();
  assertEqual(host.requests[2]?.capability, 'lyrics.plain');
  host.succeed('req-3', { state: 'plain', text: 'words', matched: null });
  const degradedResult = await degraded;
  assert(degradedResult.ok);
  assertDeepEqual(degradedResult.value, {
    kind: 'plain',
    text: 'words',
    matched: null,
  });
}

// 13. Honest absence and contradictory lyrics payloads.
async function lyricsHonesty(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const query = {
    title: 'Song',
    artist: null,
    album: null,
    durationMs: null,
    isrc: null,
  };
  const absent = p.getLyrics({ query, prefer: 'synced' }, ctx().context);
  await flush();
  host.succeed('req-1', { state: 'absent', matched: null });
  const r1 = await absent;
  assert(r1.ok);
  assertDeepEqual(r1.value, { kind: 'unavailable', matched: null });

  // synced state without lines is a contradiction, not empty lyrics.
  const noLines = p.getLyrics({ query, prefer: 'synced' }, ctx().context);
  await flush();
  host.succeed('req-2', { state: 'synced', lines: null, matched: null });
  const r2 = await noLines;
  assert(!r2.ok && r2.error.kind === 'invalid-response');

  // Plain text never presents as synced.
  const plainText = p.getLyrics({ query, prefer: 'synced' }, ctx().context);
  await flush();
  host.succeed('req-3', { state: 'plain', text: 'x', matched: null });
  const r3 = await plainText;
  assert(!r3.ok && r3.error.kind === 'invalid-response');
}

// 14. radio.seed dual payload and continuation=null honest end.
async function radioOps(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const seed = p.radioSeed(
    { sourceRef: { provider: 'youtube-music', kind: 'track', id: 'v1' } },
    ctx().context,
  );
  assertDeepEqual(host.requests[0], {
    pluginId: 'plugin-x',
    capability: 'radio.seed',
    payload: {
      source_ref: { provider: 'youtube-music', kind: 'track', id: 'v1' },
    },
  });
  host.succeed('req-1', { items: [WIRE_TRACK], continuation: 'cont-1' });
  const seedResult = await seed;
  assert(seedResult.ok);
  assertDeepEqual(seedResult.value, {
    candidates: [DOMAIN_TRACK],
    continuation: 'cont-1',
  });

  const next = p.radioSeed({ continuation: 'cont-1' }, ctx().context);
  assertDeepEqual(host.requests[1]?.payload, { continuation: 'cont-1' });
  host.succeed('req-2', { items: [], continuation: null });
  const nextResult = await next;
  assert(nextResult.ok);
  assertDeepEqual(nextResult.value, {
    candidates: [],
    continuation: null,
  });
}

// 15. An op outside the declared set is unsupported without a host call.
async function undeclaredCapability(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host, ['catalog.search']);
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

// 16. Track metadata carries the ABI 0.1.0 entity refs and isrc through.
async function trackEntityEvidence(): Promise<void> {
  const host = new FakeHost();
  const p = provider(host);
  const call = p.search(
    { query: 'x', limit: 5, storefront: null },
    ctx().context,
  );
  await flush();
  host.succeed('req-1', {
    items: [
      {
        ...WIRE_TRACK,
        artist_ref: { provider: 'itunes', kind: 'artist', id: 'ar1' },
        album_ref: { provider: 'itunes', kind: 'album', id: 'al1' },
        isrc: 'USRC17607839',
      },
    ],
    storefront: 'US',
  });
  const result = await call;
  assert(result.ok);
  assertDeepEqual(result.value.items[0], {
    ...DOMAIN_TRACK,
    artistRef: { provider: 'itunes', kind: 'artist', id: 'ar1' },
    albumRef: { provider: 'itunes', kind: 'album', id: 'al1' },
    isrc: 'USRC17607839',
  });
}

/**
 * The mint `headers` field decodes per the wire contract — it is the
 * leg the download path died on: `hasKeys` rejected the unknown key
 * outright, so every resolve carrying mint headers failed
 * invalid-response before a byte was fetched.
 */
async function resolveHeaders(): Promise<void> {
  const succeed = async (
    host: FakeHost,
    headers: unknown,
  ): Promise<Result<PlayableResource>> => {
    const p = provider(host);
    const call = p.resolvePlayback(
      ref('youtube-music', 'abcDEF123_-'),
      {
        targetBitrateKbps: 128,
        prefer: ['audio/mp4'],
        pinItag: null,
        resumeOffset: null,
      },
      ctx().context,
    );
    await flush();
    host.succeed('req-1', {
      url: 'https://g.example/v',
      mime: 'audio/mp4',
      bitrate_kbps: 128,
      expires_at_ms: 9_999,
      client: 'ios',
      itag: 140,
      headers,
    });
    return call;
  };

  // Absent / null → empty headers.
  {
    const host = new FakeHost();
    const r = await succeed(host, null);
    assert(r.ok, 'null headers decode');
    assertDeepEqual(r.ok ? r.value.headers : null, {}, 'null → {}');
  }
  {
    const host = new FakeHost();
    const r = await succeed(host, { 'user-agent': 'UA/1.0', 'X-Ref': 'r' });
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
    const host = new FakeHost();
    const r = await succeed(host, { 'x-client': headerValue });
    assert(r.ok, `unicode accepted: ${label}`);
  }

  // Every malformed shape → invalid-response, like the native decoder.
  const rejected: readonly [string, unknown][] = [
    ['host-owned name', { range: 'bytes=0-1' }],
    ['host-owned, cased', { Cookie: 'a=b' }],
    ['non-token name', { 'bad name': 'v' }],
    ['empty name', { '': 'v' }],
    ['case-folded dup', { 'X-A': '1', 'x-a': '2' }],
    ['empty value', { 'user-agent': '' }],
    ['non-string value', { 'user-agent': 7 }],
    ['control char', { 'user-agent': 'UA\r\nInjected: x' }],
    ['DEL', { 'user-agent': 'UA\x7f' }],
    ['lone surrogate', { 'user-agent': 'UA\ud800' }],
    ['over-long value', { 'user-agent': 'x'.repeat(513) }],
    ['over 512 bytes multibyte', { 'user-agent': 'Ā'.repeat(257) }],
    ['over 16 entries', Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`x-${i}`, 'v']),
    )],
    ['not an object', ['user-agent']],
    ['a string', 'user-agent'],
  ];
  for (const [label, headers] of rejected) {
    const host = new FakeHost();
    const r = await succeed(host, headers);
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
  ['cancellation', cancellation],
  ['preCancelled', preCancelled],
  ['dispose', dispose],
  ['earlyOutcome', earlyOutcome],
  ['requestDeadline', requestDeadline],
  ['startFailure', startFailure],
  ['entityOp', entityOp],
  ['entityMalformed', entityMalformed],
  ['artworkRefMismatch', artworkRefMismatch],
  ['lyricsOps', lyricsOps],
  ['lyricsHonesty', lyricsHonesty],
  ['radioOps', radioOps],
  ['undeclaredCapability', undeclaredCapability],
  ['trackEntityEvidence', trackEntityEvidence],
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
