import {
  compareVersions,
  createUpdateService,
  latestNewer,
  parseRelease,
  parseReleases,
  parseVersionTag,
  pickArtifact,
} from './update.ts';
import type { UpdateFetchJson } from './update.ts';
import { assert, assertDeepEqual, assertEqual } from './testing/assert.ts';

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
  ],
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

  // ---- release parsing ----

  const parsed = parseRelease(RELEASE_JSON);
  assert(parsed !== null);
  assertEqual(parsed.version, '0.0.1-alpha.18');
  assertEqual(parsed.assets.length, 6);

  // drafts and non-version tags drop out
  assertEqual(parseRelease({ ...RELEASE_JSON, draft: true }), null);
  assertEqual(parseRelease({ ...RELEASE_JSON, tag_name: 'nightly' }), null);
  assertEqual(parseRelease('nonsense'), null);
  assertEqual(parseRelease({ ...RELEASE_JSON, html_url: 'javascript:x' }), null);

  const releases = parseReleases([RELEASE_JSON, { draft: true }, 42]);
  assertEqual(releases.length, 1);
  assertDeepEqual(parseReleases({}), []);

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
    pickArtifact(assets, { os: 'android' })?.name,
    'auqw-0.0.1-alpha.18-android-arm64-v8a.apk',
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
  assertEqual(pickArtifact([], { os: 'android' }), null);

  // ---- service ----

  const service = createUpdateService({
    currentVersion: '0.0.1-alpha.1',
    target: { os: 'android' },
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
}
