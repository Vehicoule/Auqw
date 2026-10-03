import { CancellationSource } from '../cancellation.ts';
import type { OperationContext } from '../cancellation.ts';
import { appError, err, ok } from '../errors.ts';
import type { Result } from '../errors.ts';
import type { ProviderCapability } from '../ports/provider.ts';
import type { ProviderDecoder } from './provider-wire.ts';
import {
  createProviderWirePort,
  manifestPermissions,
} from './provider-wire.ts';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '../testing/assert.ts';

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

/** The host's permission grammar is length-unbounded — a 125-char
 *  DNS name (133-char `network:` permission) the validator accepts
 *  must survive extraction verbatim, alongside the literals and
 *  dedupe; non-strings and empties still drop. */
async function manifestPermissionsKeepLongEntries(): Promise<void> {
  const longHost = `network:${'a'.repeat(60)}.${'b'.repeat(60)}.cd`;
  assert(longHost.length > 128, 'fixture exceeds the old cap');
  const perms = manifestPermissions({
    permissions: [
      'network:music.youtube.com',
      'pot-provider',
      'kv',
      longHost,
      'network:music.youtube.com',
      '',
      7,
      null,
    ],
  });
  assertDeepEqual(
    perms,
    ['network:music.youtube.com', 'pot-provider', 'kv', longHost],
    'declared strings verbatim, deduped',
  );
  assertDeepEqual(manifestPermissions({}), [], 'absent list');
  assertDeepEqual(manifestPermissions(null), [], 'non-record manifest');
  assertEqual(manifestPermissions({ permissions: 'kv' }).length, 0, 'non-array');
}

export async function run(): Promise<void> {
  await mintHeadersKeepProtoName();
  await manifestPermissionsKeepLongEntries();
}
