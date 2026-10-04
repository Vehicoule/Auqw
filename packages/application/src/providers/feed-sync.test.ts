import { appError } from '../errors.ts';
import { createSha256 } from '../downloads/sha256.ts';
import { utf8Decode, utf8Encode } from '../utf8.ts';
import {
  PLUGIN_ABI,
  b64Encode,
  parsePluginFeed,
  parsePluginPair,
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

function pairDoc(
  id: string,
  version: string,
  wasm: Uint8Array,
  manifest: Uint8Array,
  signature = 'c2ln',
): string {
  return JSON.stringify({
    id,
    version,
    abi: PLUGIN_ABI,
    wasm_sha256: sha256Hex(wasm),
    manifest_sha256: sha256Hex(manifest),
    signature,
    manifest: utf8Decode(manifest),
    wasm: b64Encode(wasm),
  });
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
    const { ready } = await syncPluginFeed({
      feedUrl: 'https://feed.test/releases/feed.json',
      keyId: KEY_ID,
      publicKey: PUB,
      dir: '/plug',
      ports,
    });
    assertDeepEqualSorted(ready, ['alpha', 'beta']);
    const alphaPair = JSON.parse(utf8Decode(files.get('/plug/alpha.json') ?? new Uint8Array())) as Record<string, unknown>;
    assertEqual(alphaPair['id'], 'alpha');
    assertEqual(alphaPair['wasm_sha256'], sha256Hex(WASM_A));
    assert(
      !files.has('/plug/alpha.wasm') && !files.has('/plug/alpha.manifest.json'),
      'single pair doc, no two-file residue',
    );
  }

  // Matching on-disk digests are a cache hit — no artifact fetches.
  {
    const files = new Map([
      ['/plug/alpha.json', utf8Encode(pairDoc('alpha', '0.2.0', WASM_A, MANIFEST_A))],
      ['/plug/beta.json', utf8Encode(pairDoc('beta', '1.0.0', WASM_B, MANIFEST_B))],
    ]);
    const { ports, fetched } = fakePorts({ files, fetch: feedUrls() });
    const { ready } = await syncPluginFeed({
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
      ['/plug/alpha.json', utf8Encode(pairDoc('alpha', '0.2.0', stale, stale))],
      ['/plug/beta.json', utf8Encode(pairDoc('beta', '1.0.0', WASM_B, MANIFEST_B))],
    ]);
    const urls = feedUrls();
    urls.set(
      'https://feed.test/releases/alpha/0.2.0/alpha-0.2.0.wasm',
      utf8Encode('corrupted'),
    );
    const { ports } = fakePorts({ files, fetch: urls });
    const { ready } = await syncPluginFeed({
      feedUrl: 'https://feed.test/releases/feed.json',
      keyId: KEY_ID,
      publicKey: PUB,
      dir: '/plug',
      ports,
    });
    assertDeepEqualSorted(ready, ['beta']);
    assertEqual(
      utf8Decode(files.get('/plug/alpha.json') ?? new Uint8Array()),
      pairDoc('alpha', '0.2.0', stale, stale),
      'stale kept',
    );
  }

  // A bad signature refuses the write — and with nothing cached
  // that is a feed-level failure (compatible>0, ready=0).
  {
    const { ports, files } = fakePorts({
      fetch: feedUrls(),
      verify: () => false,
    });
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
    assert(threw, 'zero ready with compatible entries throws');
    assertEqual(files.size, 0);
  }

  // Artifacts absent from the feed are swept.
  {
    const files = new Map([
      ['/plug/alpha.json', utf8Encode(pairDoc('alpha', '0.2.0', WASM_A, MANIFEST_A))],
      ['/plug/beta.json', utf8Encode(pairDoc('beta', '1.0.0', WASM_B, MANIFEST_B))],
      ['/plug/dead.json', utf8Encode(pairDoc('dead', '0.1.0', WASM_A, MANIFEST_A))],
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
    assert(!files.has('/plug/dead.json'));
    assert(!files.has('/plug/dead.wasm'), 'legacy wasm swept');
    assert(!files.has('/plug/dead.manifest.json'), 'legacy manifest swept');
    assert(files.has('/plug/keep.txt'), 'non-artifact files survive');
  }

  // A fetch failure for one plugin keeps its last-known-good pair.
  {
    const files = new Map([
      ['/plug/alpha.json', utf8Encode(pairDoc('alpha', '0.2.0', WASM_A, MANIFEST_A))],
      ['/plug/beta.json', utf8Encode(pairDoc('beta', '9.9.9', new Uint8Array([8]), new Uint8Array([8])))],
    ]);
    const urls = feedUrls();
    urls.delete('https://feed.test/releases/beta/1.0.0/beta-1.0.0.wasm');
    const { ports } = fakePorts({ files, fetch: urls });
    const { ready } = await syncPluginFeed({
      feedUrl: 'https://feed.test/releases/feed.json',
      keyId: KEY_ID,
      publicKey: PUB,
      dir: '/plug',
      ports,
    });
    assertDeepEqualSorted(ready, ['alpha']);
    assert(files.has('/plug/beta.json'), 'lkg survives fetch failure');
  }

  // An abi this build can't serve is skipped for download, but the
  // installed pair survives the sweep — the feed still names the id.
  {
    const files = new Map([
      ['/plug/alpha.json', utf8Encode(pairDoc('alpha', '0.2.0', WASM_A, MANIFEST_A))],
      ['/plug/next.json', utf8Encode(pairDoc('next', '0.1.0', WASM_A, MANIFEST_A))],
    ]);
    const feed = JSON.parse(FEED_BODY) as {
      plugins: { id: string; abi: string }[];
    };
    feed.plugins = feed.plugins.filter((e) => e.id === 'alpha');
    feed.plugins.push({ ...entry('next', '0.3.0', WASM_B, MANIFEST_B), abi: '9.9.9' });
    const urls = feedUrls();
    urls.set(
      'https://feed.test/releases/feed.json',
      utf8Encode(JSON.stringify(feed)),
    );
    const { ports, fetched } = fakePorts({ files, fetch: urls });
    const { ready, compatible, current } = await syncPluginFeed({
      feedUrl: 'https://feed.test/releases/feed.json',
      keyId: KEY_ID,
      publicKey: PUB,
      dir: '/plug',
      ports,
    });
    assertDeepEqualSorted(ready, ['alpha']);
    assertDeepEqualSorted(compatible, ['alpha']);
    // `current` keeps every id the feed names.
    assertDeepEqualSorted(current, ['alpha', 'next']);
    assert(
      files.has('/plug/next.json'),
      'unsupported-abi pair survives the sweep',
    );
    assert(
      !fetched.some((u) => u.includes('/next/')),
      'unsupported abi is never downloaded',
    );
  }

  // A multi-abi feed lists one release per line: the sync picks the
  // newest release it can serve, and a broken newest line falls back
  // to the older one rather than stranding the plugin.
  {
    const WASM_NEXT = utf8Encode('wasm-next-bytes');
    const MANIFEST_NEXT = utf8Encode('{"id":"alpha","v":2}');
    const multi = {
      keyId: KEY_ID,
      plugins: [
        { ...entry('alpha', '0.2.0', WASM_A, MANIFEST_A), abi: '0.1.0' },
        { ...entry('alpha', '0.3.0', WASM_NEXT, MANIFEST_NEXT), abi: '0.1.1' },
      ],
    };
    const base = 'https://feed.test/releases';
    const urls = new Map<string, Uint8Array>([
      [`${base}/feed.json`, utf8Encode(JSON.stringify(multi))],
      [`${base}/alpha/0.3.0/plugin.manifest.json`, MANIFEST_NEXT],
      [`${base}/alpha/0.3.0/alpha-0.3.0.wasm`, WASM_NEXT],
      [`${base}/alpha/0.2.0/plugin.manifest.json`, MANIFEST_A],
      [`${base}/alpha/0.2.0/alpha-0.2.0.wasm`, WASM_A],
    ]);
    {
      const { ports, files } = fakePorts({ fetch: urls });
      const { ready } = await syncPluginFeed({
        feedUrl: `${base}/feed.json`,
        keyId: KEY_ID,
        publicKey: PUB,
        dir: '/plug',
        ports,
      });
      assertDeepEqual(ready, ['alpha']);
      const pair = JSON.parse(
        utf8Decode(files.get('/plug/alpha.json') ?? new Uint8Array()),
      ) as Record<string, unknown>;
      assertEqual(pair['version'], '0.3.0', 'newest servable line wins');
      assertEqual(pair['abi'], '0.1.1');
    }
    {
      // The 0.1.1 artifacts 404 — the older abi line still answers.
      const flaky = new Map(urls);
      flaky.delete(`${base}/alpha/0.3.0/alpha-0.3.0.wasm`);
      const { ports, files } = fakePorts({ fetch: flaky });
      const { ready } = await syncPluginFeed({
        feedUrl: `${base}/feed.json`,
        keyId: KEY_ID,
        publicKey: PUB,
        dir: '/plug',
        ports,
      });
      assertDeepEqual(ready, ['alpha'], 'older abi line is the fallback');
      const pair = JSON.parse(
        utf8Decode(files.get('/plug/alpha.json') ?? new Uint8Array()),
      ) as Record<string, unknown>;
      assertEqual(pair['version'], '0.2.0');
      assertEqual(pair['abi'], '0.1.0');
    }
    {
      // An installed pair on the older line upgrades to the newest.
      const files = new Map([
        ['/plug/alpha.json', utf8Encode(pairDoc('alpha', '0.2.0', WASM_A, MANIFEST_A))],
      ]);
      const { ports } = fakePorts({ files, fetch: urls });
      const { ready } = await syncPluginFeed({
        feedUrl: `${base}/feed.json`,
        keyId: KEY_ID,
        publicKey: PUB,
        dir: '/plug',
        ports,
      });
      assertDeepEqual(ready, ['alpha']);
      const pair = JSON.parse(
        utf8Decode(files.get('/plug/alpha.json') ?? new Uint8Array()),
      ) as Record<string, unknown>;
      assertEqual(pair['version'], '0.3.0', 'installed pair upgrades');
    }
  }

  // Version components past the safe-integer range still order
  // correctly — a `Number` compare would collapse them equal and let
  // feed order pick the older release.
  {
    const V_LO = '0.0.9007199254740992';
    const V_HI = '0.0.9007199254740993';
    const WASM_HI = utf8Encode('wasm-hi-bytes');
    const MANIFEST_HI = utf8Encode('{"id":"alpha","v":3}');
    const base = 'https://feed.test/releases';
    const urls = new Map<string, Uint8Array>([
      [
        `${base}/feed.json`,
        utf8Encode(
          JSON.stringify({
            keyId: KEY_ID,
            plugins: [
              entry('alpha', V_LO, WASM_A, MANIFEST_A),
              entry('alpha', V_HI, WASM_HI, MANIFEST_HI),
            ],
          }),
        ),
      ],
      [`${base}/alpha/${V_LO}/plugin.manifest.json`, MANIFEST_A],
      [`${base}/alpha/${V_LO}/alpha-${V_LO}.wasm`, WASM_A],
      [`${base}/alpha/${V_HI}/plugin.manifest.json`, MANIFEST_HI],
      [`${base}/alpha/${V_HI}/alpha-${V_HI}.wasm`, WASM_HI],
    ]);
    const { ports, files } = fakePorts({ fetch: urls });
    const { ready } = await syncPluginFeed({
      feedUrl: `${base}/feed.json`,
      keyId: KEY_ID,
      publicKey: PUB,
      dir: '/plug',
      ports,
    });
    assertDeepEqual(ready, ['alpha']);
    const pair = JSON.parse(
      utf8Decode(files.get('/plug/alpha.json') ?? new Uint8Array()),
    ) as Record<string, unknown>;
    assertEqual(pair['version'], V_HI, 'largest component wins');
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
    assert(e === 'invalid-response', 'duplicate (id, abi) rejected');
    const multiAbi = tryParse(
      JSON.stringify({
        keyId: KEY_ID,
        plugins: [
          { ...entry('alpha', '0.2.0', WASM_A, MANIFEST_A), abi: '0.1.0' },
          { ...entry('alpha', '0.3.0', WASM_B, MANIFEST_B), abi: '0.1.1' },
        ],
      }),
    );
    assert(multiAbi === 'ok', 'one id across distinct abis parses');
    const concatCollision = tryParse(
      JSON.stringify({
        keyId: KEY_ID,
        plugins: [
          { ...entry('ab', '0.2.0', WASM_A, MANIFEST_A), abi: '0.1.1' },
          { ...entry('ab0', '0.3.0', WASM_B, MANIFEST_B), abi: '.1.1' },
        ],
      }),
    );
    assert(
      concatCollision === 'ok',
      'distinct (id, abi) lines parse — a flat concat would collide them',
    );
    e = tryParse('{"keyId":"x","plugins":[{"id":"Alpha"}]}');
    assert(e === 'invalid-response');
    e = tryParse('not json');
    assert(e === 'invalid-response');
    const parsed = parsePluginFeed(FEED_BODY, KEY_ID);
    assertEqual(parsed.plugins.length, 2);
    assertEqual(parsed.keyId, KEY_ID);
  }

  // parsePluginPair re-verifies offline: tampered bytes, forged
  // digests, bad signatures, and wrong abi all refuse.
  {
    const verify = {
      keyId: KEY_ID,
      publicKey: PUB,
      verify: ((..._args: unknown[]) => true) as FeedSyncPorts['ed25519Verify'],
    };
    const good = pairDoc('alpha', '0.2.0', WASM_A, MANIFEST_A);
    const pair = parsePluginPair(good, verify);
    assert(pair !== null && pair.id === 'alpha');
    const tampered = JSON.parse(good) as Record<string, unknown>;
    tampered['wasm'] = b64Encode(new Uint8Array([0]));
    assertEqual(parsePluginPair(JSON.stringify(tampered), verify), null);
    const forged = JSON.parse(good) as Record<string, unknown>;
    forged['wasm_sha256'] = sha256Hex(new Uint8Array([0]));
    forged['wasm'] = b64Encode(new Uint8Array([0]));
    // digests now self-consistent — only the signature can refuse it,
    // and 'c2ln' still verifies under the fake; the real path re-verifies.
    assert(
      parsePluginPair(JSON.stringify(forged), {
        ...verify,
        verify: () => false,
      }) === null,
      'forged pair rejected when signature fails',
    );
    const wrongAbi = JSON.parse(good) as Record<string, unknown>;
    wrongAbi['abi'] = '0.2.0';
    assertEqual(parsePluginPair(JSON.stringify(wrongAbi), verify), null);
    assertEqual(parsePluginPair('not json', verify), null);
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
