import { CancellationSource } from '../cancellation.ts';
import type { OperationContext } from '../cancellation.ts';
import { appError, err, ok } from '../errors.ts';
import type { Result } from '../errors.ts';
import type { ProviderCapability } from '../ports/provider.ts';
import type { ProviderDecoder } from './provider-wire.ts';
import { createProviderWirePort } from './provider-wire.ts';
import { assert, assertEqual } from '../testing/assert.ts';

function ctx(): OperationContext {
  return {
    requestId: 'r-1',
    deadlineMs: 10_000,
    signal: new CancellationSource().signal,
  };
}

/** A transport that answers every call with one canned wire result. */
function canned(wire: unknown) {
  return <T>(
    _capability: ProviderCapability,
    _payload: Record<string, unknown>,
    _context: OperationContext,
    decode: ProviderDecoder<T>,
  ): Promise<Result<T>> => {
    const decoded = decode(wire);
    return Promise.resolve(
      decoded === null
        ? err(appError('invalid-response', 'bad wire result'))
        : ok(decoded),
    );
  };
}

/** A transport that records each outgoing payload verbatim. */
function spy(wire: unknown) {
  const sent: Record<string, unknown>[] = [];
  const transport = <T>(
    _capability: ProviderCapability,
    payload: Record<string, unknown>,
    _context: OperationContext,
    decode: ProviderDecoder<T>,
  ): Promise<Result<T>> => {
    sent.push(payload);
    const decoded = decode(wire);
    return Promise.resolve(
      decoded === null
        ? err(appError('invalid-response', 'bad wire result'))
        : ok(decoded),
    );
  };
  return { sent, transport };
}

function wireEntity(id: string): Record<string, unknown> {
  return {
    source_ref: { provider: 'p', kind: 'album', id },
    kind: 'album',
    title: 'T',
    artwork: [],
  };
}

const SEARCH_INPUT = {
  query: 'q',
  limit: 10,
  storefront: null,
  kinds: ['track'] as const,
  continuation: 'tok',
};

/** A mint-declared '__proto__' header is a valid RFC 9110 token the
 *  native Vec-pair decoder carries verbatim — the TS decoder must
 *  keep it as an own key rather than silently dropping it. */
async function mintHeadersKeepProtoName(): Promise<void> {
  const port = createProviderWirePort(
    'youtube-music',
    ['playback.resolve'],
    'v1',
    canned({
      url: 'https://cdn.example/stream',
      mime: 'audio/mp4',
      bitrate_kbps: 256,
      expires_at_ms: 4_102_444_800_000,
      client: 'ios',
      // Built through JSON.parse: '__proto__' arrives as an own
      // enumerable key exactly like the wire boundary produces.
      headers: JSON.parse('{"__proto__": "mint-ua", "x-token": "t"}'),
    }),
  );
  const result = await port.resolvePlayback(
    { provider: 'youtube-music', kind: 'track', id: 'y1' },
    {
      targetBitrateKbps: 256,
      prefer: ['audio/mp4'],
      pinItag: null,
      resumeOffset: null,
    },
    ctx(),
  );
  assert(result.ok, 'resolve failed');
  const headers = result.value.headers;
  assertEqual(headers['__proto__'], 'mint-ua', 'proto-named header kept');
  assertEqual(headers['x-token'], 't', 'sibling header kept');
  // The fetch-init merge downstream spreads the record — the name
  // must survive that hop as an own property too.
  const merged: Record<string, string> = { ...headers, Range: 'bytes=0-1' };
  assertEqual(merged['__proto__'], 'mint-ua', 'spread keeps the header');
}

/** Guests built before the scoped-search extension reject widened
 *  payloads on exact keys, so a provider that never declares
 *  `catalog.search.kinds` gets the base payload and answers an
 *  unscoped page rather than failing. */
async function searchDropsExtensionKeysWithoutDeclaration(): Promise<void> {
  const { sent, transport } = spy({ items: [], storefront: null });
  const port = createProviderWirePort(
    'p',
    ['catalog.search'],
    null,
    transport,
  );
  const result = await port.search({ ...SEARCH_INPUT }, ctx());
  assert(result.ok, 'search failed');
  const keys = Object.keys(sent[0] ?? {}).sort();
  assertEqual(
    keys.join(','),
    'limit,query,storefront',
    'payload carries only the base key set',
  );
}

/** A `catalog.search.kinds` declarer opted into the widened payload —
 *  the extension keys ride along verbatim. */
async function searchForwardsExtensionKeysWhenDeclared(): Promise<void> {
  const { sent, transport } = spy({ items: [], storefront: null });
  const port = createProviderWirePort(
    'p',
    ['catalog.search', 'catalog.search.kinds'],
    null,
    transport,
  );
  const result = await port.search({ ...SEARCH_INPUT }, ctx());
  assert(result.ok, 'search failed');
  const payload = sent[0] ?? {};
  assertEqual(
    JSON.stringify(payload['kinds']),
    '["track"]',
    'kinds forwarded',
  );
  assertEqual(payload['continuation'], 'tok', 'continuation forwarded');
}

/** The schema caps `entities`/`related` at 200 — an over-cap guest
 *  answer is invalid, like an over-cap artwork or suggestions list. */
async function entityArraysRejectOverCap(): Promise<void> {
  const port = createProviderWirePort(
    'p',
    ['catalog.search', 'catalog.entity'],
    null,
    canned({
      items: [],
      storefront: null,
      entities: Array.from({ length: 201 }, (_, i) =>
        wireEntity(`e${i}`),
      ),
    }),
  );
  const search = await port.search(
    { query: 'q', limit: 10, storefront: null },
    ctx(),
  );
  assert(!search.ok, 'over-cap entities accepted');
  assertEqual(
    search.ok ? '' : search.error.kind,
    'invalid-response',
    'over-cap entities rejected as invalid-response',
  );

  const atCap = createProviderWirePort(
    'p',
    ['catalog.search'],
    null,
    canned({
      items: [],
      storefront: null,
      entities: Array.from({ length: 200 }, (_, i) =>
        wireEntity(`e${i}`),
      ),
    }),
  );
  const atCapSearch = await atCap.search(
    { query: 'q', limit: 10, storefront: null },
    ctx(),
  );
  assert(atCapSearch.ok, 'at-cap entities rejected');
  assertEqual(atCapSearch.value.entities.length, 200, 'at-cap count');

  const entityPort = createProviderWirePort(
    'p',
    ['catalog.entity'],
    null,
    canned({
      entity: wireEntity('e0'),
      items: [],
      complete: true,
      related: Array.from({ length: 201 }, (_, i) => wireEntity(`r${i}`)),
    }),
  );
  const page = await entityPort.getEntity(
    { provider: 'p', kind: 'album', id: 'e0' },
    ctx(),
  );
  assert(!page.ok, 'over-cap related accepted');
  assertEqual(
    page.ok ? '' : page.error.kind,
    'invalid-response',
    'over-cap related rejected as invalid-response',
  );
}

export async function run(): Promise<void> {
  await mintHeadersKeepProtoName();
  await searchDropsExtensionKeysWithoutDeclaration();
  await searchForwardsExtensionKeysWhenDeclared();
  await entityArraysRejectOverCap();
}
