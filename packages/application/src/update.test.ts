import {
  checksumsNameFor,
  compareVersions,
  createUpdateApplier,
  createUpdateService,
  latestNewer,
  parseRelease,
  parseReleases,
  parseSha256Sums,
  parseVersionTag,
  pickArtifact,
  pickChecksums,
} from './update.ts';
import type {
  UpdateApplyPorts,
  UpdateApplyTarget,
  UpdateFetchJson,
  UpdateTarget,
} from './update.ts';
import { assert, assertDeepEqual, assertEqual } from './testing/assert.ts';
import { appError } from './errors.ts';

const RELEASE_JSON = {
  tag_name: 'v0.0.1-alpha.18',
  html_url: 'https://github.com/Vehicoule/Auqw/releases/tag/v0.0.1-alpha.18',
  draft: false,
  prerelease: true,
  assets: [
    {
      name: 'auqw-0.0.1-alpha.18-android-arm64-v8a.apk',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/auqw-0.0.1-alpha.18-android-arm64-v8a.apk',
    },
    {
      name: 'auqw-0.0.1-alpha.18-linux-x64.AppImage',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/auqw-0.0.1-alpha.18-linux-x64.AppImage',
    },
    {
      name: 'auqw-0.0.1-alpha.18-linux-x64.flatpak',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/auqw-0.0.1-alpha.18-linux-x64.flatpak',
    },
    {
      name: 'auqw-0.0.1-alpha.18-mac-arm64.dmg',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/auqw-0.0.1-alpha.18-mac-arm64.dmg',
    },
    {
      name: 'auqw-0.0.1-alpha.18-win-x64-setup.exe',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/auqw-0.0.1-alpha.18-win-x64-setup.exe',
    },
    {
      name: 'SHA256SUMS-Linux.txt',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/SHA256SUMS-Linux.txt',
    },
    {
      name: 'SHA256SUMS-Android.txt',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/SHA256SUMS-Android.txt',
    },
  ],
};

const ANDROID_ARM64: UpdateTarget = {
  os: 'android',
  supportedAbis: ['arm64-v8a'],
};

function scriptedFetch(
  replies: readonly { status: number; body: unknown }[],
): { calls: number; fetchJson: UpdateFetchJson } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetchJson: () => {
      calls += 1;
      const reply = replies[Math.min(calls - 1, replies.length - 1)]!;
      return Promise.resolve(reply);
    },
  };
}

export async function run(): Promise<void> {
  // ---- version parsing ----

  assertEqual(parseVersionTag('v0.0.1-alpha.18'), '0.0.1-alpha.18');
  assertEqual(parseVersionTag('0.0.1'), '0.0.1');
  assertEqual(parseVersionTag('v1.2.3-beta.4'), '1.2.3-beta.4');
  assertEqual(parseVersionTag('release-alpha-2'), null);
  assertEqual(parseVersionTag('v0.0.1-'), null);
  assertEqual(parseVersionTag('nightly'), null);
  // the snapshot contract bounds version at 64 chars — a longer
  // normalization is unshippable, skipped like an unparseable tag
  assertEqual(
    parseVersionTag(`v1.2.3-${'a'.repeat(58)}`),
    `1.2.3-${'a'.repeat(58)}`,
  );
  assertEqual(parseVersionTag(`v1.2.3-${'a'.repeat(59)}`), null);

  // ---- semver ordering ----

  assert(compareVersions('0.0.1-alpha.18', '0.0.1-alpha.1') > 0);
  assert(compareVersions('0.0.1-alpha.2', '0.0.1-alpha.18') < 0);
  assert(compareVersions('0.0.1', '0.0.1-alpha.99') > 0);
  assert(compareVersions('0.0.2-alpha.1', '0.0.1') > 0);
  assert(compareVersions('1.0.0', '1.0.0') === 0);
  assert(compareVersions('0.1.0', '0.0.99') > 0);
  // numeric identifiers sort before alphanumeric; prefix sorts
  // before its extension; prerelease tags order alphabetically
  assert(compareVersions('1.0.0-rc.1', '1.0.0-beta.1') > 0);
  assert(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0);
  assert(compareVersions('garbage', '0.0.1') === 0);
  // a hyphen is legal INSIDE a prerelease identifier — 'alpha-1'
  // is one alphanumeric identifier, not a truncated 'alpha'
  assert(compareVersions('1.0.0-alpha-1', '1.0.0-alpha.5') > 0);
  assert(compareVersions('1.0.0-alpha-1', '1.0.0-alpha') > 0);
  assert(compareVersions('1.0.0-alpha-1', '1.0.0-beta') < 0);

  // ---- release parsing ----

  const parsed = parseRelease(RELEASE_JSON);
  assert(parsed !== null);
  assertEqual(parsed.version, '0.0.1-alpha.18');
  assertEqual(parsed.assets.length, 7);

  // drafts and non-version tags drop out
  assertEqual(parseRelease({ ...RELEASE_JSON, draft: true }), null);
  assertEqual(parseRelease({ ...RELEASE_JSON, tag_name: 'nightly' }), null);
  assertEqual(parseRelease('nonsense'), null);
  assertEqual(parseRelease({ ...RELEASE_JSON, html_url: 'javascript:x' }), null);

  const releases = parseReleases([RELEASE_JSON, { draft: true }, 42]);
  assertEqual(releases.length, 1);
  assertDeepEqual(parseReleases({}), []);

  // asset names must arrive as basenames — a `..`/separator would
  // escape every platform's staging dir at join() time
  const escaped = parseRelease({
    ...RELEASE_JSON,
    assets: [
      {
        name: '../escape.apk',
        browser_download_url:
          'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/escape.apk',
      },
      {
        name: 'sub\\dir.apk',
        browser_download_url:
          'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/dir.apk',
      },
      {
        name: '..',
        browser_download_url:
          'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/dotdot',
      },
      RELEASE_JSON.assets[0],
    ],
  })!;
  assertDeepEqual(
    escaped.assets.map((a) => a.name),
    ['auqw-0.0.1-alpha.18-android-arm64-v8a.apk'],
  );

  // ---- latestNewer + pickArtifact ----

  const older = parseRelease({
    ...RELEASE_JSON,
    tag_name: 'v0.0.1-alpha.2',
  })!;
  assertDeepEqual(latestNewer([older, parsed], '0.0.1-alpha.1'), parsed);
  assertEqual(latestNewer([parsed], '0.0.1-alpha.18'), null);
  // 0.0.1 release outranks every alpha of the same triple
  assertEqual(latestNewer([parsed], '0.0.1'), null);
  const stable = parseRelease({ ...RELEASE_JSON, tag_name: 'v0.0.1' });
  assertDeepEqual(latestNewer([parsed, stable!], '0.0.1-alpha.18'), stable);

  const assets = parsed.assets;
  assertEqual(
    pickArtifact(assets, ANDROID_ARM64)?.name,
    'auqw-0.0.1-alpha.18-android-arm64-v8a.apk',
  );
  // an x86_64 device must refuse the arm64-only asset — array-first
  // would download ~50 MB into INSTALL_FAILED_NO_MATCHING_ABIS
  assertEqual(
    pickArtifact(assets, { os: 'android', supportedAbis: ['x86_64'] }),
    null,
  );
  // several splits → the device's ABI preference order wins, not
  // asset order; 'universal' is the fallback for an unmatched list
  const multiAbi = [
    ...assets,
    {
      name: 'auqw-0.0.1-alpha.18-android-x86_64.apk',
      url: 'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/auqw-0.0.1-alpha.18-android-x86_64.apk',
    },
    {
      name: 'auqw-0.0.1-alpha.18-android-universal.apk',
      url: 'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/auqw-0.0.1-alpha.18-android-universal.apk',
    },
  ];
  assertEqual(
    pickArtifact(multiAbi, { os: 'android', supportedAbis: ['x86_64'] })
      ?.name,
    'auqw-0.0.1-alpha.18-android-x86_64.apk',
  );
  assertEqual(
    pickArtifact(multiAbi, {
      os: 'android',
      supportedAbis: ['armeabi-v7a'],
    })?.name,
    'auqw-0.0.1-alpha.18-android-universal.apk',
  );
  // a version prerelease may itself contain '-android-' — the LAST
  // tag carries the abi; and a wall of repeated tags parses
  // linearly, never backtracking (CodeQL js/redos on the regex)
  assertEqual(
    pickArtifact(
      [
        {
          name: 'auqw-1.2.3-android-beta-android-arm64-v8a.apk',
          url: 'https://example.com/a',
        },
      ],
      { os: 'android', supportedAbis: ['arm64-v8a'] },
    )?.name,
    'auqw-1.2.3-android-beta-android-arm64-v8a.apk',
  );
  assertEqual(
    pickArtifact(
      [{ name: `${'-android-'.repeat(4000)}x.apk`, url: 'https://example.com/b' }],
      ANDROID_ARM64,
    ),
    null,
  );
  // pickArtifact's own basename gate — an artifact built outside
  // parseRelease (the seam's sanitizing boundary) stages into the
  // same dirs, so separators must not pick either
  assertEqual(
    pickArtifact(
      [
        { name: '../escape.AppImage', url: 'https://example.com/a' },
        { name: 'sub/dir.AppImage', url: 'https://example.com/b' },
      ],
      { os: 'linux', prefer: 'appimage' },
    ),
    null,
  );
  assertEqual(
    pickArtifact(assets, { os: 'linux', prefer: 'appimage' })?.name,
    'auqw-0.0.1-alpha.18-linux-x64.AppImage',
  );
  assertEqual(
    pickArtifact(assets, { os: 'linux', prefer: 'flatpak' })?.name,
    'auqw-0.0.1-alpha.18-linux-x64.flatpak',
  );
  assertEqual(
    pickArtifact(assets, { os: 'mac' })?.name,
    'auqw-0.0.1-alpha.18-mac-arm64.dmg',
  );
  assertEqual(
    pickArtifact(assets, { os: 'win' })?.name,
    'auqw-0.0.1-alpha.18-win-x64-setup.exe',
  );
  assertEqual(pickArtifact(assets, { os: 'other' }), null);
  assertEqual(pickArtifact([], ANDROID_ARM64), null);

  // ---- checksums pick + parse ----

  assertEqual(checksumsNameFor(ANDROID_ARM64), 'SHA256SUMS-Android.txt');
  assertEqual(
    checksumsNameFor({ os: 'linux', prefer: 'appimage' }),
    'SHA256SUMS-Linux.txt',
  );
  assertEqual(checksumsNameFor({ os: 'mac' }), 'SHA256SUMS-macOS.txt');
  assertEqual(checksumsNameFor({ os: 'win' }), 'SHA256SUMS-Windows.txt');
  assertEqual(checksumsNameFor({ os: 'other' }), null);

  assertEqual(
    pickChecksums(assets, ANDROID_ARM64)?.name,
    'SHA256SUMS-Android.txt',
  );
  assertEqual(
    pickChecksums(assets, { os: 'linux', prefer: 'flatpak' })?.name,
    'SHA256SUMS-Linux.txt',
  );
  // the fixture ships no Windows sums — an unverifiable artifact
  // carries null, and a null checksums never self-installs
  assertEqual(pickChecksums(assets, { os: 'win' }), null);
  assertEqual(pickChecksums(assets, { os: 'other' }), null);

  const HEX64 = 'a'.repeat(64);
  const sums = parseSha256Sums(
    `${HEX64}  file-a.apk\n` +
      `${'B'.repeat(64)} *file-b.exe\n` +
      'not-a-sum line\n' +
      `${'c'.repeat(63)} too-short.txt\n` +
      `  ${'d'.repeat(64)}  leading-space.txt\n`,
  );
  assertEqual(sums.get('file-a.apk'), HEX64);
  assertEqual(sums.get('file-b.exe'), 'b'.repeat(64));
  assertEqual(sums.get('too-short.txt'), undefined);
  assertEqual(sums.get('not-a-sum line'), undefined);
  assertEqual(sums.size, 2);

  // ---- service ----

  const service = createUpdateService({
    currentVersion: '0.0.1-alpha.1',
    target: ANDROID_ARM64,
    fetchJson: scriptedFetch([{ status: 200, body: [RELEASE_JSON] }]).fetchJson,
  });

  const notifications: string[] = [];
  service.subscribe(() =>
    notifications.push(service.snapshot().status.state),
  );

  // boot check resolves 'available' with the platform artifact
  const settled = await service.check('boot');
  assertEqual(settled.status.state, 'available');
  assert(settled.status.state === 'available');
  assertEqual(settled.status.version, '0.0.1-alpha.18');
  assertEqual(
    settled.status.artifact?.name,
    'auqw-0.0.1-alpha.18-android-arm64-v8a.apk',
  );
  assertDeepEqual(notifications, ['checking', 'available']);

  // a second boot check is a no-op — once per process
  let calls = 0;
  const bootedService = createUpdateService({
    currentVersion: '0.0.1',
    target: { os: 'other' },
    fetchJson: () => {
      calls += 1;
      return Promise.resolve({ status: 200, body: [RELEASE_JSON] });
    },
  });
  await bootedService.check('boot');
  assertEqual(bootedService.snapshot().status.state, 'current');
  const again = await bootedService.check('boot');
  assertEqual(again.status.state, 'current');
  assertEqual(calls, 1, 'boot check must not refetch');
  // manual does refetch
  await bootedService.check('manual');
  assertEqual(calls, 2);

  // in-flight manual checks dedupe
  let slowCalls = 0;
  let releaseReply: ((reply: { status: number; body: unknown }) => void) | null =
    null;
  const slow = createUpdateService({
    currentVersion: '0.0.1',
    target: { os: 'other' },
    fetchJson: () => {
      slowCalls += 1;
      return new Promise((resolve) => {
        releaseReply = resolve;
      });
    },
  });
  const pendingA = slow.check('manual');
  const pendingB = slow.check('manual');
  releaseReply!({ status: 200, body: [] });
  const [a, b] = await Promise.all([pendingA, pendingB]);
  assertEqual(a, b);
  assertEqual(slowCalls, 1, 'in-flight checks share one request');

  // 'current' when nothing newer
  const current = createUpdateService({
    currentVersion: '9.9.9',
    target: { os: 'other' },
    fetchJson: () => Promise.resolve({ status: 200, body: [RELEASE_JSON] }),
  });
  assertEqual((await current.check('manual')).status.state, 'current');

  // error mapping: rate-limit, transient, throw → transient
  const limited = createUpdateService({
    currentVersion: '0.0.1',
    target: { os: 'other' },
    fetchJson: () => Promise.resolve({ status: 403, body: null }),
  });
  const limitedSnap = await limited.check('manual');
  assert(limitedSnap.status.state === 'failed');
  assertEqual(limitedSnap.status.error.kind, 'rate-limit');

  const serverError = createUpdateService({
    currentVersion: '0.0.1',
    target: { os: 'other' },
    fetchJson: () => Promise.resolve({ status: 502, body: null }),
  });
  const serverSnap = await serverError.check('manual');
  assert(serverSnap.status.state === 'failed');
  assertEqual(serverSnap.status.error.kind, 'transient');

  const offline = createUpdateService({
    currentVersion: '0.0.1',
    target: { os: 'other' },
    fetchJson: () => Promise.reject(new TypeError('fetch failed')),
  });
  const offlineSnap = await offline.check('manual');
  assert(offlineSnap.status.state === 'failed');
  assertEqual(offlineSnap.status.error.kind, 'transient');

  // a 200 whose body isn't the releases list fails the check — it
  // must not land as 'current'
  const malformed = createUpdateService({
    currentVersion: '0.0.1',
    target: { os: 'other' },
    fetchJson: () => Promise.resolve({ status: 200, body: '<html>' }),
  });
  const malformedSnap = await malformed.check('manual');
  assert(malformedSnap.status.state === 'failed');
  assertEqual(malformedSnap.status.error.kind, 'invalid-response');

  // a failed boot check doesn't consume the one-boot budget —
  // a later manual retry still fetches
  const failed = createUpdateService({
    currentVersion: '0.0.1-alpha.1',
    target: { os: 'other' },
    fetchJson: scriptedFetch([
      { status: 500, body: null },
      { status: 200, body: [RELEASE_JSON] },
    ]).fetchJson,
  });
  assertEqual((await failed.check('boot')).status.state, 'failed');
  assertEqual((await failed.check('manual')).status.state, 'available');

  // ---- apply pipeline ----

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) {
      await Promise.resolve();
    }
  };
  const APK_NAME = 'auqw-0.0.1-alpha.18-android-arm64-v8a.apk';
  const APK_URL = `https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/${APK_NAME}`;
  const GOOD_HEX = 'f'.repeat(64);
  const APK_TARGET: UpdateApplyTarget = {
    version: '0.0.1-alpha.18',
    artifact: { name: APK_NAME, url: APK_URL },
    checksums: {
      name: 'SHA256SUMS-Android.txt',
      url: 'https://github.com/Vehicoule/Auqw/releases/download/v0.0.1-alpha.18/SHA256SUMS-Android.txt',
    },
  };
  const fakePorts = (overrides?: {
    readonly sumsBody?: string;
    readonly applyOutcome?: 'relaunch' | 'installed';
    readonly shaHex?: string;
    readonly hangDownload?: boolean;
  }): {
    calls: { downloads: number; applies: number; removed: string[]; progress: number[] };
    ports: UpdateApplyPorts;
  } => {
    const calls = {
      downloads: 0,
      applies: 0,
      removed: [] as string[],
      progress: [] as number[],
    };
    return {
      calls,
      ports: {
        stagePath: (artifact) => `/stage/${artifact.name}`,
        fetchText: () =>
          Promise.resolve(
            overrides?.sumsBody ?? `${GOOD_HEX}  ${APK_NAME}\n`,
          ),
        download: (_url, _path, onProgress, _signal) => {
          calls.downloads += 1;
          if (overrides?.hangDownload === true) {
            return new Promise(() => {});
          }
          onProgress(512, 1024);
          onProgress(1024, 1024);
          return Promise.resolve();
        },
        sha256Hex: () =>
          Promise.resolve(overrides?.shaHex ?? GOOD_HEX),
        apply: () => {
          calls.applies += 1;
          return Promise.resolve(overrides?.applyOutcome ?? 'installed');
        },
        remove: (path) => {
          calls.removed.push(path);
          return Promise.resolve();
        },
      },
    };
  };

  // happy path → 'applied'; progress ticks publish receivedBytes
  {
    const { calls, ports } = fakePorts();
    const applier = createUpdateApplier(ports);
    const states: string[] = [];
    applier.subscribe(() => states.push(applier.snapshot().state));
    applier.begin(APK_TARGET);
    await settle();
    assertDeepEqual(
      states,
      ['downloading', 'downloading', 'downloading', 'verifying', 'applying', 'applied'],
    );
    assertEqual(calls.downloads, 1);
    assertEqual(calls.applies, 1);
    assertEqual(applier.snapshot().state, 'applied');
    // 'applied' is terminal — a second begin is a no-op
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(calls.downloads, 1);
  }

  // 'relaunch' outcome lands 'ready-to-restart'
  {
    const { ports } = fakePorts({ applyOutcome: 'relaunch' });
    const applier = createUpdateApplier(ports);
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(applier.snapshot().state, 'ready-to-restart');
  }

  // no checksums → refuse BEFORE any bytes land
  {
    const { calls, ports } = fakePorts();
    const applier = createUpdateApplier(ports);
    applier.begin({ ...APK_TARGET, checksums: null });
    await settle();
    assertEqual(applier.snapshot().state, 'failed');
    const snap = applier.snapshot();
    assert(snap.state === 'failed');
    assertEqual(snap.error.kind, 'unavailable');
    assertEqual(calls.downloads, 0, 'unverifiable artifact must not download');
  }

  // artifact absent from the sums file → 'invalid-response'
  {
    const { calls, ports } = fakePorts({ sumsBody: `${GOOD_HEX}  other.apk\n` });
    const applier = createUpdateApplier(ports);
    applier.begin(APK_TARGET);
    await settle();
    const snap = applier.snapshot();
    assert(snap.state === 'failed');
    assertEqual(snap.error.kind, 'invalid-response');
    assertEqual(calls.downloads, 0);
  }

  // checksum mismatch → 'artifact-rejected' + staged file removed
  {
    const { calls, ports } = fakePorts({ shaHex: '0'.repeat(64) });
    const applier = createUpdateApplier(ports);
    applier.begin(APK_TARGET);
    await settle();
    const snap = applier.snapshot();
    assert(snap.state === 'failed');
    assertEqual(snap.error.kind, 'artifact-rejected');
    assertDeepEqual(calls.removed, [`/stage/${APK_NAME}`]);
    assertEqual(calls.applies, 0, 'a rejected artifact never installs');
  }

  // a failed run is retryable by begin — same affordance
  {
    const { calls, ports } = fakePorts({ shaHex: '0'.repeat(64) });
    const applier = createUpdateApplier(ports);
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(applier.snapshot().state, 'failed');
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(calls.downloads, 2, 'failed apply retries through begin');
  }

  // cancel mid-download → back to 'idle'; the stale run's settles
  // can't publish over it (generation guard)
  {
    let hang = true;
    const { calls, ports } = fakePorts();
    const applier = createUpdateApplier({
      ...ports,
      download: (url, path, onProgress, signal) =>
        hang
          ? new Promise<void>(() => {})
          : ports.download(url, path, onProgress, signal),
    });
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(applier.snapshot().state, 'downloading');
    applier.cancel();
    assertEqual(applier.snapshot().state, 'idle');
    await settle();
    assertEqual(applier.snapshot().state, 'idle');
    // and a fresh begin still runs after the cancel
    hang = false;
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(applier.snapshot().state, 'applied');
    // only the retry reached the download port — the hung first run
    // never got that far
    assertEqual(calls.downloads, 1);
  }

  // a second begin while the first run is still inside fetchText
  // must not start a second pipeline — the latch is set
  // synchronously, before the first publish exists
  {
    let releaseSums: ((body: string) => void) | null = null;
    const { calls, ports } = fakePorts();
    const applier = createUpdateApplier({
      ...ports,
      fetchText: () =>
        new Promise<string>((resolve) => {
          releaseSums = resolve;
        }),
    });
    applier.begin(APK_TARGET);
    applier.begin(APK_TARGET);
    await settle();
    releaseSums!(`${GOOD_HEX}  ${APK_NAME}\n`);
    await settle();
    assertEqual(calls.downloads, 1, 'concurrent begins must not double-run');
    assertEqual(applier.snapshot().state, 'applied');
  }

  // cancel while the checksum is hashing must keep the run from
  // reaching apply — hash is not abortable, so the generation check
  // between stages is the only gate
  {
    let resolveHash: ((hex: string) => void) | null = null;
    const { calls, ports } = fakePorts();
    const applier = createUpdateApplier({
      ...ports,
      sha256Hex: () =>
        new Promise<string>((resolve) => {
          resolveHash = resolve;
        }),
    });
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(applier.snapshot().state, 'verifying');
    applier.cancel();
    assertEqual(applier.snapshot().state, 'idle');
    resolveHash!(GOOD_HEX);
    await settle();
    assertEqual(
      calls.applies,
      0,
      'a run cancelled mid-verify must never reach apply',
    );
    assertDeepEqual(
      calls.removed,
      [`/stage/${APK_NAME}`],
      'a run cancelled mid-verify still drops its staged file',
    );
  }

  // ownership is per PATH: a stale run drops its leftover even when
  // a successor claimed a DIFFERENT path (another release's name)
  {
    const { calls, ports } = fakePorts({
      sumsBody: `${GOOD_HEX}  a.apk\n${GOOD_HEX}  b.apk\n`,
    });
    const hashes = new Map<string, (hex: string) => void>();
    const applier = createUpdateApplier({
      ...ports,
      sha256Hex: (p) =>
        new Promise<string>((resolve) => {
          hashes.set(p, resolve);
        }),
    });
    const target = (name: string): UpdateApplyTarget => ({
      ...APK_TARGET,
      artifact: { ...APK_TARGET.artifact, name },
    });
    applier.begin(target('a.apk'));
    await settle();
    assertEqual(applier.snapshot().state, 'verifying');
    applier.cancel();
    applier.begin(target('b.apk'));
    await settle();
    assertEqual(applier.snapshot().state, 'verifying');
    hashes.get('/stage/a.apk')!(GOOD_HEX);
    await settle();
    assertDeepEqual(
      calls.removed,
      ['/stage/a.apk'],
      'a stale run must drop its own path even after another version claimed staging',
    );
    hashes.get('/stage/b.apk')!(GOOD_HEX);
    await settle();
    assertEqual(applier.snapshot().state, 'applied');
  }

  // service.apply() gates: no-op while not 'available', and merges
  // the applier feed into the snapshot
  {
    const { calls, ports } = fakePorts();
    const svc = createUpdateService({
      currentVersion: '0.0.1-alpha.1',
      target: ANDROID_ARM64,
      fetchJson: scriptedFetch([{ status: 200, body: [RELEASE_JSON] }])
        .fetchJson,
      applier: createUpdateApplier(ports),
    });
    svc.apply();
    await settle();
    assertEqual(calls.downloads, 0, 'apply before any check is a no-op');
    const settled2 = await svc.check('boot');
    assert(settled2.status.state === 'available');
    assertEqual(settled2.status.checksums?.name, 'SHA256SUMS-Android.txt');
    svc.apply();
    await settle();
    const snap = svc.snapshot();
    assertEqual(snap.apply.state, 'applied');
    assertEqual(calls.downloads, 1);
  }

  // 'applied' is not a dead end: the OS sheet owned the outcome and
  // may never have landed (cancelled sheet, failed install) —
  // reapply() refires the handoff on the still-staged verified file
  {
    const { calls, ports } = fakePorts();
    const applier = createUpdateApplier(ports);
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(applier.snapshot().state, 'applied');
    applier.reapply();
    assertEqual(applier.snapshot().state, 'applying');
    await settle();
    assertEqual(applier.snapshot().state, 'applied');
    assertEqual(calls.applies, 2, 'reapply refires the install port');
    assertEqual(calls.downloads, 1, 'reapply must not re-download');
  }

  // reapply is inert in any other phase — 'idle', mid-run, 'failed'
  {
    const { calls, ports } = fakePorts();
    const applier = createUpdateApplier(ports);
    applier.reapply();
    applier.begin(APK_TARGET);
    applier.reapply();
    await settle();
    assertEqual(applier.snapshot().state, 'applied');
    assertEqual(calls.applies, 1, 'reapply outside applied is a no-op');
  }

  // a reapply whose handoff throws reports 'failed' and drops the
  // retained file — a dead handoff can't keep masquerading as staged
  {
    let fail = false;
    const { calls, ports } = fakePorts();
    const applier = createUpdateApplier({
      ...ports,
      apply: () => {
        calls.applies += 1;
        return fail
          ? Promise.reject(appError('internal', 'intent died'))
          : Promise.resolve('installed' as const);
      },
    });
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(applier.snapshot().state, 'applied');
    fail = true;
    applier.reapply();
    await settle();
    const snap = applier.snapshot();
    assertEqual(snap.state, 'failed');
    applier.reapply();
    await settle();
    assertEqual(
      calls.applies,
      2,
      'a failed reapply clears the staged handoff — retry begins fresh',
    );
  }

  // a checked NEWER release supersedes an 'applied' run: begin for a
  // different version runs its own pipeline and reclaims the older
  // stage — reapply is only the same-version affordance
  {
    const NEWER_NAME = 'b.apk';
    const { calls, ports } = fakePorts({
      sumsBody: `${GOOD_HEX}  ${APK_NAME}\n${GOOD_HEX}  ${NEWER_NAME}\n`,
    });
    const applier = createUpdateApplier(ports);
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(applier.snapshot().state, 'applied');
    applier.begin({
      ...APK_TARGET,
      version: '0.0.1-alpha.19',
      artifact: { ...APK_TARGET.artifact, name: NEWER_NAME },
    });
    await settle();
    const snap = applier.snapshot();
    assertEqual(snap.state, 'applied');
    assert(snap.state === 'applied');
    assertEqual(snap.version, '0.0.1-alpha.19');
    assertEqual(calls.downloads, 2, 'a newer release starts its own pipeline');
    assertDeepEqual(
      calls.removed,
      [`/stage/${APK_NAME}`],
      'the superseded release stage is reclaimed',
    );
  }

  // but a same-version begin on 'applied' still no-ops — reapply()
  // owns that affordance
  {
    const { calls, ports } = fakePorts();
    const applier = createUpdateApplier(ports);
    applier.begin(APK_TARGET);
    await settle();
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(
      calls.downloads,
      1,
      'a same-version begin on applied stays inert',
    );
    assertEqual(calls.applies, 1);
  }

  // a permission-gated install is not a failed run: the verified
  // stage stays staged, the state parks as 'needs-permission', and
  // reapply refires the install leg on the retained file — no
  // re-download
  {
    let gated = true;
    const { calls, ports } = fakePorts();
    const applier = createUpdateApplier({
      ...ports,
      apply: () => {
        calls.applies += 1;
        return gated
          ? Promise.reject(appError('permission-denied', 'unknown-sources'))
          : Promise.resolve('installed' as const);
      },
    });
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(applier.snapshot().state, 'needs-permission');
    assertDeepEqual(
      calls.removed,
      [],
      'a permission gate keeps the verified stage',
    );
    // A same-version begin must not re-download over the kept stage —
    // reapply owns that affordance too.
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(calls.downloads, 1, 'no re-download while gated');
    gated = false;
    applier.reapply();
    assertEqual(applier.snapshot().state, 'applying');
    await settle();
    assertEqual(applier.snapshot().state, 'applied');
    assertEqual(calls.applies, 2, 'reapply refires the install port');
    assertEqual(calls.downloads, 1, 'reapply ran on the retained stage');
  }

  // a still-gated reapply reparks 'needs-permission' — the stage
  // stays for the next attempt rather than reading as failed
  {
    const { calls, ports } = fakePorts();
    const applier = createUpdateApplier({
      ...ports,
      apply: () => {
        calls.applies += 1;
        return Promise.reject(
          appError('permission-denied', 'unknown-sources'),
        );
      },
    });
    applier.begin(APK_TARGET);
    await settle();
    applier.reapply();
    await settle();
    assertEqual(applier.snapshot().state, 'needs-permission');
    assertEqual(calls.applies, 2, 'the handoff refired');
    assertDeepEqual(calls.removed, [], 'stage still retained');
  }

  // a permission-gated supersede behaves like 'applied': begin for a
  // newer release reclaims the retained stage and runs fresh
  {
    const NEWER_NAME = 'b.apk';
    const { calls, ports } = fakePorts({
      sumsBody: `${GOOD_HEX}  ${APK_NAME}\n${GOOD_HEX}  ${NEWER_NAME}\n`,
    });
    let gated = true;
    const applier = createUpdateApplier({
      ...ports,
      apply: () => {
        calls.applies += 1;
        return gated
          ? Promise.reject(appError('permission-denied', 'unknown-sources'))
          : Promise.resolve('installed' as const);
      },
    });
    applier.begin(APK_TARGET);
    await settle();
    assertEqual(applier.snapshot().state, 'needs-permission');
    gated = false;
    applier.begin({
      ...APK_TARGET,
      version: '0.0.1-alpha.19',
      artifact: { ...APK_TARGET.artifact, name: NEWER_NAME },
    });
    await settle();
    const snap = applier.snapshot();
    assertEqual(snap.state, 'applied');
    assertEqual(calls.downloads, 2, 'a newer release runs its own pipeline');
    assertDeepEqual(
      calls.removed,
      [`/stage/${APK_NAME}`],
      'the gated release stage is reclaimed by the newer run',
    );
  }
}
