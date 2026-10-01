import { assertDeepEqual, assertEqual } from '@auqw/application/testing';
import type { UpdateApplyPorts } from '@auqw/application';
import {
  appImageRelaunchOptions,
  createDesktopUpdate,
  updateCapabilityFor,
  updateTargetFor,
} from './update.ts';

const RELEASE = {
  tag_name: 'v9.9.9',
  html_url: 'https://github.com/Vehicoule/Auqw/releases/tag/v9.9.9',
  draft: false,
  assets: [
    {
      name: 'auqw-9.9.9.AppImage',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v9.9.9/auqw-9.9.9.AppImage',
    },
    {
      name: 'SHA256SUMS-Linux.txt',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v9.9.9/SHA256SUMS-Linux.txt',
    },
  ],
};

const fetchJson = () =>
  Promise.resolve({ status: 200, body: [RELEASE] });

/** Ports whose apply resolves 'relaunch' — enough to drive a full run. */
function fakeApplyPorts(applied: { count: number }): UpdateApplyPorts {
  return {
    stagePath: (artifact) => `/stage/${artifact.name}`,
    fetchText: () =>
      Promise.resolve(`${'f'.repeat(64)}  auqw-9.9.9.AppImage\n`),
    download: (_u, _p, onProgress) => {
      onProgress(1, 1);
      return Promise.resolve();
    },
    sha256Hex: () => Promise.resolve('f'.repeat(64)),
    apply: () => {
      applied.count += 1;
      return Promise.resolve('relaunch');
    },
    remove: () => Promise.resolve(),
  };
}

export async function run(): Promise<void> {
  // ---- per-format target + capability routing ----

  assertDeepEqual(
    updateTargetFor('linux', {}),
    { os: 'linux', prefer: 'appimage' },
  );
  assertDeepEqual(
    updateTargetFor('linux', { FLATPAK_ID: 'io.auqw' }),
    { os: 'linux', prefer: 'flatpak' },
  );
  assertDeepEqual(updateTargetFor('darwin', {}), { os: 'mac' });
  assertDeepEqual(updateTargetFor('win32', {}), { os: 'win' });
  assertDeepEqual(updateTargetFor('freebsd', {}), { os: 'other' });

  // AppImage self-installs only when the runtime reports the image —
  // an unpackaged dev run has no APPIMAGE and stays on the page.
  assertEqual(
    updateCapabilityFor({ os: 'linux', prefer: 'appimage' }, {
      APPIMAGE: '/opt/auqw.AppImage',
    }),
    'install',
  );
  assertEqual(
    updateCapabilityFor({ os: 'linux', prefer: 'appimage' }, {}),
    'open',
  );
  // flatpak can't reach the host installer from the sandbox — 'open'
  assertEqual(
    updateCapabilityFor({ os: 'linux', prefer: 'flatpak' }, {}),
    'open',
  );
  // dmg gets the verified-download floor, NSIS self-installs
  assertEqual(updateCapabilityFor({ os: 'mac' }, {}), 'download');
  assertEqual(updateCapabilityFor({ os: 'win' }, {}), 'install');
  assertEqual(updateCapabilityFor({ os: 'other' }, {}), 'open');

  // ---- the wrapper ----

  const opened: string[] = [];
  const update = createDesktopUpdate({
    currentVersion: '0.0.1',
    target: { os: 'linux', prefer: 'appimage' },
    fetchJson,
    openExternal: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    capability: 'install',
    applyPorts: fakeApplyPorts({ count: 0 }),
    relaunch: () => undefined,
  });
  const snap = await update.check('manual');
  assertEqual(snap.status.state, 'available');
  assertEqual(snap.capability, 'install');

  // open rides the snapshot's own URL — nothing renderer-supplied
  await update.open();
  assertDeepEqual(opened, [RELEASE.html_url]);

  // apply drives the shared pipeline to 'ready-to-restart'
  const applied = { count: 0 };
  const applying = createDesktopUpdate({
    currentVersion: '0.0.1',
    target: { os: 'linux', prefer: 'appimage' },
    fetchJson,
    openExternal: () => Promise.resolve(),
    capability: 'install',
    applyPorts: fakeApplyPorts(applied),
    relaunch: () => undefined,
  });
  await applying.check('manual');
  await applying.apply();
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
  assertEqual(applying.snapshot().apply.state, 'ready-to-restart');
  assertEqual(applied.count, 1);
  // restart inside 'ready-to-restart' relaunches
  let relaunches = 0;
  const restarting = createDesktopUpdate({
    currentVersion: '0.0.1',
    target: { os: 'linux', prefer: 'appimage' },
    fetchJson,
    openExternal: () => Promise.resolve(),
    capability: 'install',
    applyPorts: fakeApplyPorts({ count: 0 }),
    relaunch: () => {
      relaunches += 1;
    },
  });
  await restarting.check('manual');
  await restarting.apply();
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
  await restarting.restart();
  assertEqual(relaunches, 1);

  // the restart handoff execs the replaced image, not process.execPath
  // — and carries the launch argv so the new image keeps the flags
  assertDeepEqual(
    appImageRelaunchOptions(
      ['/usr/bin/Auqw.AppImage', '--no-sandbox', '--proxy=1'],
      '/usr/bin/Auqw.AppImage',
    ),
    { args: ['--no-sandbox', '--proxy=1'], execPath: '/usr/bin/Auqw.AppImage' },
  );
  assertDeepEqual(
    appImageRelaunchOptions(['electron', 'app', '--flag'], undefined),
    { args: ['app', '--flag'] },
  );

  // a renderer can't summon apply on an 'open' build — the verb
  // rejects rather than pretending capability
  const open = createDesktopUpdate({
    currentVersion: '0.0.1',
    target: { os: 'other' },
    fetchJson,
    openExternal: () => Promise.resolve(),
    capability: 'open',
  });
  let applyError: string | null = null;
  await open.apply().catch((thrown: { kind?: string }) => {
    applyError = thrown.kind ?? 'raw';
  });
  assertEqual(applyError, 'invalid-request');

  // restart out of phase refuses — 'idle' has nothing to relaunch into
  let phaseError: string | null = null;
  await open.restart().catch((thrown: { kind?: string }) => {
    phaseError = thrown.kind ?? 'raw';
  });
  assertEqual(phaseError, 'invalid-request');

  // a release URL outside the repo's releases tree never opens —
  // the allowlist rejects what the snapshot carried
  const rogue = createDesktopUpdate({
    currentVersion: '0.0.1',
    target: { os: 'other' },
    fetchJson: () =>
      Promise.resolve({
        status: 200,
        body: [
          {
            ...RELEASE,
            html_url: 'https://evil.example/x',
          },
        ],
      }),
    openExternal: () => Promise.resolve(),
    capability: 'open',
  });
  await rogue.check('manual');
  let openError: string | null = null;
  await rogue.open().catch((thrown: { kind?: string }) => {
    openError = thrown.kind ?? 'raw';
  });
  assertEqual(openError, 'invalid-request');
}
