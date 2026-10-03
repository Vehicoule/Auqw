import { appError } from '../errors.ts';
import { createSha256 } from '../downloads/sha256.ts';
import { utf8Encode } from '../utf8.ts';
import {
  PLUGIN_ABI,
  parsePluginFeed,
  syncPluginFeed,
} from './feed-sync.ts';
import type { FeedSyncPorts, PluginFeedEntry } from './feed-sync.ts';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '../testing/assert.ts';

const KEY_ID = '42d8cac606f16c04';
const PUB = new Uint8Array(32).fill(7);

function sha256Hex(bytes: Uint8Array): string {
  const h = createSha256();
  h.update(bytes);
  return `sha256:${h.digest()}`;
}

const WASM_A = utf8Encode('wasm-a-bytes');
const MANIFEST_A = utf8Encode('{"id":"alpha"}');
const WASM_B = utf8Encode('wasm-b-bytes');
const MANIFEST_B = utf8Encode('{"id":"beta"}');

function entry(
  id: string,
  version: string,
  wasm: Uint8Array,
  manifest: Uint8Array,
  signature = 'c2ln',
): PluginFeedEntry {
  return {
    id,
    version,
    abi: PLUGIN_ABI,
    wasm_sha256: sha256Hex(wasm),
    manifest_sha256: sha256Hex(manifest),
    signature,
  };
}

const FEED_BODY = JSON.stringify({
  keyId: KEY_ID,
  plugins: [
    entry('alpha', '0.2.0', WASM_A, MANIFEST_A),
    entry('beta', '1.0.0', WASM_B, MANIFEST_B),
  ],
});

function fakePorts(opts: {
  files?: Map<string, Uint8Array>;
  fetch?: Map<string, Uint8Array>;
  verify?: (sig: Uint8Array) => boolean;
}): { ports: FeedSyncPorts; files: Map<string, Uint8Array>; fetched: string[] } {
  const files = opts.files ?? new Map();
  const fetched: string[] = [];
  const ports: FeedSyncPorts = {
    fetchBytes: async (url) => {
      fetched.push(url);
      const b = opts.fetch?.get(url);
      if (b === undefined) {
        throw appError('transient', `fetch ${url} 404`);
      }
      return b;
    },
    ed25519Verify: (_m, sig, _pk) => opts.verify?.(sig) ?? true,
    list: async (dir) =>
      [...files.keys()]
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1)),
    read: async (path) => files.get(path) ?? null,
    write: async (path, bytes) => {
      files.set(path, bytes);
    },
    remove: async (path) => {
      files.delete(path);
    },
  };
  return { ports, files, fetched };
}

function feedUrls(): Map<string, Uint8Array> {
  return new Map([
    ['https://feed.test/releases/feed.json', utf8Encode(FEED_BODY)],
    [
      'https://feed.test/releases/alpha/0.2.0/plugin.manifest.json',
      MANIFEST_A,
    ],
    ['https://feed.test/releases/alpha/0.2.0/alpha-0.2.0.wasm', WASM_A],
    [
      'https://feed.test/releases/beta/1.0.0/plugin.manifest.json',
      MANIFEST_B,
    ],
    ['https://feed.test/releases/beta/1.0.0/beta-1.0.0.wasm', WASM_B],
  ]);
}

export async function run(): Promise<void> {
  // Fresh sync downloads + writes every feed entry.
  {
    const { ports, files } = fakePorts({ fetch: feedUrls() });
    const ready = await syncPluginFeed({
      feedUrl: 'https://feed.test/releases/feed.json',
      keyId: KEY_ID,
      publicKey: PUB,
      dir: '/plug',
      ports,
    });
    assertDeepEqualSorted(ready, ['alpha', 'beta']);
    assertEqual(files.get('/plug/alpha.wasm'), WASM_A);
    assertEqual(files.get('/plug/alpha.manifest.json'), MANIFEST_A);
    assertEqual(files.get('/plug/beta.wasm'), WASM_B);
  }

  // Matching on-disk digests are a cache hit — no artifact fetches.
  {
    const files = new Map([
      ['/plug/alpha.wasm', WASM_A],
      ['/plug/alpha.manifest.json', MANIFEST_A],
      ['/plug/beta.wasm', WASM_B],
      ['/plug/beta.manifest.json', MANIFEST_B],
    ]);
    const { ports, fetched } = fakePorts({ files, fetch: feedUrls() });
    const ready = await syncPluginFeed({
      feedUrl: 'https://feed.test/releases/feed.json',
      keyId: KEY_ID,
      publicKey: PUB,
      dir: '/plug',
      ports,
    });
    assertEqual(ready.length, 2);
    assertEqual(fetched.length, 1, 'only the feed index is fetched');
  }

  // A sha mismatch refuses the artifact — last-known-good stays.
  {
    const stale = new Uint8Array([1, 2, 3]);
    const files = new Map([
      ['/plug/alpha.wasm', stale],
      ['/plug/alpha.manifest.json', stale],
      ['/plug/beta.wasm', WASM_B],
      ['/plug/beta.manifest.json', MANIFEST_B],
    ]);
    const urls = feedUrls();
    urls.set(
      'https://feed.test/releases/alpha/0.2.0/alpha-0.2.0.wasm',
      utf8Encode('corrupted'),
    );
    const { ports } = fakePorts({ files, fetch: urls });
    const ready = await syncPluginFeed({
      feedUrl: 'https://feed.test/releases/feed.json',
      keyId: KEY_ID,
      publicKey: PUB,
      dir: '/plug',
      ports,
    });
    assertDeepEqualSorted(ready, ['beta']);
    assertEqual(files.get('/plug/alpha.wasm'), stale, 'stale kept');
  }

  // A bad signature refuses the write.
  {
    const { ports, files } = fakePorts({
      fetch: feedUrls(),
      verify: () => false,
    });
    const ready = await syncPluginFeed({
      feedUrl: 'https://feed.test/releases/feed.json',
      keyId: KEY_ID,
      publicKey: PUB,
      dir: '/plug',
      ports,
    });
    assertEqual(ready.length, 0);
    assertEqual(files.size, 0);
  }

  // Artifacts absent from the feed are swept.
  {
    const files = new Map([
      ['/plug/alpha.wasm', WASM_A],
      ['/plug/alpha.manifest.json', MANIFEST_A],
      ['/plug/beta.wasm', WASM_B],
      ['/plug/beta.manifest.json', MANIFEST_B],
      ['/plug/dead.wasm', new Uint8Array([9])],
      ['/plug/dead.manifest.json', new Uint8Array([9])],
      ['/plug/keep.txt', new Uint8Array([1])],
    ]);
    const { ports } = fakePorts({ files, fetch: feedUrls() });
    await syncPluginFeed({
      feedUrl: 'https://feed.test/releases/feed.json',
      keyId: KEY_ID,
      publicKey: PUB,
      dir: '/plug',
      ports,
    });
    assert(!files.has('/plug/dead.wasm'));
    assert(!files.has('/plug/dead.manifest.json'));
    assert(files.has('/plug/keep.txt'), 'non-artifact files survive');
  }

  // A fetch failure for one plugin keeps its last-known-good pair.
  {
    const files = new Map([
      ['/plug/alpha.wasm', WASM_A],
      ['/plug/alpha.manifest.json', MANIFEST_A],
      ['/plug/beta.wasm', new Uint8Array([8])],
      ['/plug/beta.manifest.json', new Uint8Array([8])],
    ]);
    const urls = feedUrls();
    urls.delete('https://feed.test/releases/beta/1.0.0/beta-1.0.0.wasm');
    const { ports } = fakePorts({ files, fetch: urls });
    const ready = await syncPluginFeed({
      feedUrl: 'https://feed.test/releases/feed.json',
      keyId: KEY_ID,
      publicKey: PUB,
      dir: '/plug',
      ports,
    });
    assertDeepEqualSorted(ready, ['alpha']);
    assert(files.has('/plug/beta.wasm'), 'lkg survives fetch failure');
  }

  // Feed-level failure throws — the caller keeps the whole cache.
  {
    const { ports } = fakePorts({ fetch: new Map() });
    let threw = false;
    try {
      await syncPluginFeed({
        feedUrl: 'https://feed.test/releases/feed.json',
        keyId: KEY_ID,
        publicKey: PUB,
        dir: '/plug',
        ports,
      });
    } catch {
      threw = true;
    }
    assert(threw);
  }

  // Feed shape checks: wrong keyId, duplicate ids, malformed entries.
  {
    const good = JSON.parse(FEED_BODY) as Record<string, unknown>;
    let e = tryParse(JSON.stringify({ ...good, keyId: 'bad' }));
    assert(e === 'invalid-response');
    e = tryParse(
      JSON.stringify({
        keyId: KEY_ID,
        plugins: [
          entry('alpha', '0.2.0', WASM_A, MANIFEST_A),
          entry('alpha', '0.3.0', WASM_A, MANIFEST_A),
        ],
      }),
    );
    assert(e === 'invalid-response');
    e = tryParse('{"keyId":"x","plugins":[{"id":"Alpha"}]}');
    assert(e === 'invalid-response');
    e = tryParse('not json');
    assert(e === 'invalid-response');
    const parsed = parsePluginFeed(FEED_BODY, KEY_ID);
    assertEqual(parsed.plugins.length, 2);
    assertEqual(parsed.keyId, KEY_ID);
  }
}

function tryParse(text: string): string {
  try {
    parsePluginFeed(text, KEY_ID);
    return 'ok';
  } catch (thrown) {
    return typeof thrown === 'object' &&
      thrown !== null &&
      'kind' in thrown &&
      typeof (thrown as { kind?: unknown }).kind === 'string'
      ? ((thrown as { kind: string }).kind)
      : 'thrown';
  }
}

function assertDeepEqualSorted(
  actual: readonly string[],
  expected: readonly string[],
): void {
  assertDeepEqual([...actual].sort(), [...expected].sort());
}
