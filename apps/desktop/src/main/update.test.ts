import { assertDeepEqual, assertEqual } from '@auqw/application/testing';
import type { UpdateApplyPorts } from '@auqw/application';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDmg, bundleForExe } from './darwin-apply.ts';
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

const MAC_RELEASE = {
  tag_name: 'v9.9.9',
  html_url: 'https://github.com/Vehicoule/Auqw/releases/tag/v9.9.9',
  draft: false,
  assets: [
    {
      name: 'auqw-9.9.9-mac-arm64.dmg',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v9.9.9/auqw-9.9.9-mac-arm64.dmg',
    },
    {
      name: 'SHA256SUMS-macOS.txt',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v9.9.9/SHA256SUMS-macOS.txt',
    },
  ],
};

const macFetchJson = () =>
  Promise.resolve({ status: 200, body: [MAC_RELEASE] });

const WIN_RELEASE = {
  tag_name: 'v9.9.9',
  html_url: 'https://github.com/Vehicoule/Auqw/releases/tag/v9.9.9',
  draft: false,
  assets: [
    {
      name: 'auqw-9.9.9-win-x64-setup.exe',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v9.9.9/auqw-9.9.9-win-x64-setup.exe',
    },
    {
      name: 'SHA256SUMS-Windows.txt',
      browser_download_url:
        'https://github.com/Vehicoule/Auqw/releases/download/v9.9.9/SHA256SUMS-Windows.txt',
    },
  ],
};

const winFetchJson = () =>
  Promise.resolve({ status: 200, body: [WIN_RELEASE] });

/** Ports whose apply resolves 'relaunch' — enough to drive a full run. */
function fakeApplyPorts(
  applied: { count: number },
  assetName = 'auqw-9.9.9.AppImage',
): UpdateApplyPorts {
  return {
    stagePath: (artifact) => `/stage/${artifact.name}`,
    fetchText: () =>
      Promise.resolve(`${'f'.repeat(64)}  ${assetName}\n`),
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

  // AppImage self-installs only when the runtime reports an absolute
  // image path inside a writable dir — an unpackaged dev run, an
  // empty/relative APPIMAGE, or a root-owned image dir all stay on
  // the page.
  assertEqual(
    updateCapabilityFor(
      { os: 'linux', prefer: 'appimage' },
      { APPIMAGE: '/opt/auqw.AppImage' },
      () => true,
    ),
    'install',
  );
  assertEqual(
    updateCapabilityFor(
      { os: 'linux', prefer: 'appimage' },
      { APPIMAGE: '/opt/auqw.AppImage' },
      () => false,
    ),
    'open',
  );
  assertEqual(
    updateCapabilityFor(
      { os: 'linux', prefer: 'appimage' },
      { APPIMAGE: 'auqw.AppImage' },
      () => true,
    ),
    'open',
  );
  assertEqual(
    updateCapabilityFor(
      { os: 'linux', prefer: 'appimage' },
      { APPIMAGE: '' },
      () => true,
    ),
    'open',
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

  // reapply refires the OS handoff on the retained stage — no
  // re-download (the dmg re-mount / APK re-sheet affordance)
  const reopened = { count: 0 };
  const installedPorts: UpdateApplyPorts = {
    ...fakeApplyPorts(reopened, 'auqw-9.9.9-mac-arm64.dmg'),
    apply: () => {
      reopened.count += 1;
      return Promise.resolve('installed');
    },
  };
  const settled = createDesktopUpdate({
    currentVersion: '0.0.1',
    target: { os: 'mac' },
    fetchJson: macFetchJson,
    openExternal: () => Promise.resolve(),
    capability: 'download',
    applyPorts: installedPorts,
  });
  await settled.check('manual');
  await settled.apply();
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
  assertEqual(settled.snapshot().apply.state, 'applied');
  await settled.reapply();
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
  assertEqual(reopened.count, 2);
  assertEqual(settled.snapshot().apply.state, 'applied');
  // reapply outside 'applied' is a no-op, not a third run
  const idleUpdate = createDesktopUpdate({
    currentVersion: '0.0.1',
    target: { os: 'mac' },
    fetchJson: macFetchJson,
    openExternal: () => Promise.resolve(),
    capability: 'download',
    applyPorts: installedPorts,
  });
  await idleUpdate.reapply();
  assertEqual(reopened.count, 2);

  // a process that already handed the installer to the OS never
  // refires — 'applied' inside the pre-quit window is the spawn
  // having landed, not a retriable offer (one wizard per run)
  const spawned = { count: 0 };
  const guarded = createDesktopUpdate({
    currentVersion: '0.0.1',
    target: { os: 'win' },
    fetchJson: winFetchJson,
    openExternal: () => Promise.resolve(),
    capability: 'download',
    installerSpawnedInProcess: () => true,
    applyPorts: {
      ...fakeApplyPorts(spawned, 'auqw-9.9.9-win-x64-setup.exe'),
      apply: () => {
        spawned.count += 1;
        return Promise.resolve('installed');
      },
    },
  });
  await guarded.check('manual');
  await guarded.apply();
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
  assertEqual(guarded.snapshot().apply.state, 'applied');
  await guarded.reapply();
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
  assertEqual(spawned.count, 1);

  // ---- the dmg leg ----

  assertEqual(
    bundleForExe('/Applications/auqw.app/Contents/MacOS/auqw'),
    '/Applications/auqw.app',
  );
  assertEqual(bundleForExe('/opt/electron/Electron'), null);

  // unpackaged → the manual leg: Finder opens the image, 'installed'
  const manualCalls: string[] = [];
  assertEqual(
    await applyDmg({
      dmgPath: '/stage/auqw-9.9.9.dmg',
      isPackaged: false,
      exePath: '/opt/electron/Electron',
      openPath: (p) => {
        manualCalls.push(`open:${p}`);
        return Promise.resolve('');
      },
      showItemInFolder: (p) => manualCalls.push(`reveal:${p}`),
    }),
    'installed',
  );
  assertDeepEqual(manualCalls, ['open:/stage/auqw-9.9.9.dmg']);

  // a refused mount reveals the staged file and lands 'failed'
  // (retryable 'transient'), never a false 'installed'
  let openFailure: string | null = null;
  await applyDmg({
    dmgPath: '/stage/auqw-9.9.9.dmg',
    isPackaged: false,
    exePath: '/opt/electron/Electron',
    openPath: () => Promise.resolve('mount failed'),
    showItemInFolder: (p) => manualCalls.push(`reveal:${p}`),
  }).catch((thrown: { kind?: string }) => {
    openFailure = thrown.kind ?? 'raw';
  });
  assertEqual(openFailure, 'transient');
  assertEqual(manualCalls[1], 'reveal:/stage/auqw-9.9.9.dmg');

  // packaged → the assist does the user's drag: the fake run serves
  // a mounted bundle + copies it, the leg swaps it over the running
  // .app and reports 'relaunch'
  const dir = mkdtempSync(join(tmpdir(), 'auqw-dmg-test-'));
  const running = join(dir, 'auqw.app');
  mkdirSync(join(running, 'Contents', 'MacOS'), { recursive: true });
  const exe = join(running, 'Contents', 'MacOS', 'auqw');
  const fakeRun = (cmd: string, args: readonly string[]) => {
    if (cmd === 'hdiutil' && args[0] === 'attach') {
      // The fixture 'mounts' a bundle at the private mountpoint
      const mount = args[args.length - 1];
      if (mount === undefined) {
        return Promise.reject(new Error('no mountpoint'));
      }
      mkdirSync(join(mount, 'auqw.app', 'Contents', 'MacOS'), {
        recursive: true,
      });
      return Promise.resolve();
    }
    if (cmd === 'ditto' && args[0] !== undefined && args[1] !== undefined) {
      cpSync(args[0], args[1], { recursive: true });
      return Promise.resolve();
    }
    return Promise.resolve();
  };
  assertEqual(
    await applyDmg({
      dmgPath: join(dir, 'auqw-9.9.9.dmg'),
      isPackaged: true,
      exePath: exe,
      openPath: () => Promise.resolve('should not open'),
      showItemInFolder: () => undefined,
      run: fakeRun,
    }),
    'relaunch',
  );
  // The new bundle took the running path; no .auqw-new/.auqw-old
  // staging residue lingers beside it
  assertDeepEqual(readdirSync(dir), ['auqw.app']);

  // a refused assist (e.g. hdiutil fails) still gets the manual leg
  let refusedOpen = false;
  assertEqual(
    await applyDmg({
      dmgPath: join(dir, 'auqw-9.9.9.dmg'),
      isPackaged: true,
      exePath: exe,
      openPath: () => {
        refusedOpen = true;
        return Promise.resolve('');
      },
      showItemInFolder: () => undefined,
      run: () => Promise.reject(new Error('attach failed')),
    }),
    'installed',
  );
  assertEqual(refusedOpen, true);
  rmSync(dir, { force: true, recursive: true });

  // a dmg image with no .app throws before the copy — the private
  // mount must still detach (prep failures can't leak attachments)
  const dir2 = mkdtempSync(join(tmpdir(), 'auqw-dmg-test-'));
  mkdirSync(join(dir2, 'auqw.app', 'Contents', 'MacOS'), {
    recursive: true,
  });
  const noAppCalls: string[] = [];
  assertEqual(
    await applyDmg({
      dmgPath: join(dir2, 'x.dmg'),
      isPackaged: true,
      exePath: join(dir2, 'auqw.app', 'Contents', 'MacOS', 'auqw'),
      openPath: () => Promise.resolve(''),
      showItemInFolder: () => undefined,
      run: (cmd, args) => {
        noAppCalls.push(`${cmd}:${String(args[0])}`);
        return Promise.resolve();
      },
    }),
    'installed',
  );
  assertDeepEqual(noAppCalls, ['hdiutil:attach', 'hdiutil:detach']);
  rmSync(dir2, { force: true, recursive: true });

  // a failed ditto sweeps its partial staged copy — the manual
  // fallback succeeding leaves no `.auqw-new` residue
  const dir3 = mkdtempSync(join(tmpdir(), 'auqw-dmg-test-'));
  mkdirSync(join(dir3, 'auqw.app', 'Contents', 'MacOS'), {
    recursive: true,
  });
  const partialCopyRun = (cmd: string, args: readonly string[]) => {
    if (cmd === 'hdiutil' && args[0] === 'attach') {
      const mount = args[args.length - 1];
      if (mount === undefined) {
        return Promise.reject(new Error('no mountpoint'));
      }
      mkdirSync(join(mount, 'auqw.app', 'Contents', 'MacOS'), {
        recursive: true,
      });
      return Promise.resolve();
    }
    if (cmd === 'ditto') {
      const staged = args[1];
      if (staged !== undefined) {
        mkdirSync(staged, { recursive: true });
      }
      return Promise.reject(new Error('no space left'));
    }
    return Promise.resolve();
  };
  assertEqual(
    await applyDmg({
      dmgPath: join(dir3, 'x.dmg'),
      isPackaged: true,
      exePath: join(dir3, 'auqw.app', 'Contents', 'MacOS', 'auqw'),
      openPath: () => Promise.resolve(''),
      showItemInFolder: () => undefined,
      run: partialCopyRun,
    }),
    'installed',
  );
  assertDeepEqual(readdirSync(dir3), ['auqw.app']);
  rmSync(dir3, { force: true, recursive: true });

  // a dmg holding two .app bundles refuses the assist — readdir order
  // can't choose which one swaps over the running app; falls to the
  // manual leg like any invalid payload
  const dir4 = mkdtempSync(join(tmpdir(), 'auqw-dmg-test-'));
  mkdirSync(join(dir4, 'auqw.app', 'Contents', 'MacOS'), {
    recursive: true,
  });
  let twoAppOpened = false;
  assertEqual(
    await applyDmg({
      dmgPath: join(dir4, 'x.dmg'),
      isPackaged: true,
      exePath: join(dir4, 'auqw.app', 'Contents', 'MacOS', 'auqw'),
      openPath: () => {
        twoAppOpened = true;
        return Promise.resolve('');
      },
      showItemInFolder: () => undefined,
      run: (cmd, args) => {
        if (cmd === 'hdiutil' && args[0] === 'attach') {
          const mount = args[args.length - 1];
          if (mount === undefined) {
            return Promise.reject(new Error('no mountpoint'));
          }
          mkdirSync(join(mount, 'auqw.app'), { recursive: true });
          mkdirSync(join(mount, 'helper.app'), { recursive: true });
        }
        return Promise.resolve();
      },
    }),
    'installed',
  );
  assertEqual(twoAppOpened, true);
  assertDeepEqual(readdirSync(dir4), ['auqw.app']);
  rmSync(dir4, { force: true, recursive: true });

  // a symlink wearing the '.app' extension is not a bundle — the
  // image must hold one real directory
  const dir5 = mkdtempSync(join(tmpdir(), 'auqw-dmg-test-'));
  mkdirSync(join(dir5, 'auqw.app', 'Contents', 'MacOS'), {
    recursive: true,
  });
  let symlinkOpened = false;
  assertEqual(
    await applyDmg({
      dmgPath: join(dir5, 'x.dmg'),
      isPackaged: true,
      exePath: join(dir5, 'auqw.app', 'Contents', 'MacOS', 'auqw'),
      openPath: () => {
        symlinkOpened = true;
        return Promise.resolve('');
      },
      showItemInFolder: () => undefined,
      run: (cmd, args) => {
        if (cmd === 'hdiutil' && args[0] === 'attach') {
          const mount = args[args.length - 1];
          if (mount === undefined) {
            return Promise.reject(new Error('no mountpoint'));
          }
          mkdirSync(join(mount, 'payload'), { recursive: true });
          symlinkSync(join(mount, 'payload'), join(mount, 'fake.app'));
        }
        return Promise.resolve();
      },
    }),
    'installed',
  );
  assertEqual(symlinkOpened, true);
  rmSync(dir5, { force: true, recursive: true });

  // a swap killed mid-gap leaves `<app>.auqw-old` orphaned with no
  // `.app` — the next apply restores the survivor before the residue
  // sweep can delete it
  const dir6 = mkdtempSync(join(tmpdir(), 'auqw-dmg-test-'));
  mkdirSync(join(dir6, 'auqw.app.auqw-old'), { recursive: true });
  writeFileSync(join(dir6, 'auqw.app.auqw-old', 'survivor'), '');
  let orphanOpened = false;
  assertEqual(
    await applyDmg({
      dmgPath: join(dir6, 'x.dmg'),
      isPackaged: true,
      exePath: join(dir6, 'auqw.app', 'Contents', 'MacOS', 'auqw'),
      openPath: () => {
        orphanOpened = true;
        return Promise.resolve('');
      },
      showItemInFolder: () => undefined,
      run: (cmd, args) => {
        if (cmd === 'hdiutil' && args[0] === 'attach') {
          const mount = args[args.length - 1];
          if (mount === undefined) {
            return Promise.reject(new Error('no mountpoint'));
          }
          mkdirSync(join(mount, 'auqw.app'), { recursive: true });
          return Promise.resolve();
        }
        if (cmd === 'ditto') {
          // the manual leg after the restore — what matters is the
          // old bundle being back at its path, not a new install
          return Promise.reject(new Error('copy refused'));
        }
        return Promise.resolve();
      },
    }),
    'installed',
  );
  assertEqual(orphanOpened, true);
  assertEqual(existsSync(join(dir6, 'auqw.app', 'survivor')), true);
  rmSync(dir6, { force: true, recursive: true });

  // once the swap lands, cleanup failures don't flip the verdict —
  // a detach refusal plus a mount dir that won't remove still report
  // 'relaunch', never the manual surface over a replaced app
  const dir7 = mkdtempSync(join(tmpdir(), 'auqw-dmg-test-'));
  const running7 = join(dir7, 'auqw.app');
  mkdirSync(join(running7, 'Contents', 'MacOS'), { recursive: true });
  let mountDir: string | null = null;
  const busyMountRun = (cmd: string, args: readonly string[]) => {
    if (cmd === 'hdiutil' && args[0] === 'attach') {
      const mount = args[args.length - 1];
      if (mount === undefined) {
        return Promise.reject(new Error('no mountpoint'));
      }
      mountDir = mount;
      mkdirSync(join(mount, 'auqw.app', 'Contents', 'MacOS'), {
        recursive: true,
      });
      return Promise.resolve();
    }
    if (cmd === 'ditto' && args[0] !== undefined && args[1] !== undefined) {
      cpSync(args[0], args[1], { recursive: true });
      return Promise.resolve();
    }
    if (cmd === 'hdiutil' && args[0] === 'detach') {
      // The image stays mounted and the mountpoint is made
      // unremovable — the residue rm throws after the swap.
      chmodSync(mountDir ?? '', 0o000);
      return Promise.reject(new Error('detach refused'));
    }
    return Promise.resolve();
  };
  assertEqual(
    await applyDmg({
      dmgPath: join(dir7, 'x.dmg'),
      isPackaged: true,
      exePath: join(running7, 'Contents', 'MacOS', 'auqw'),
      openPath: () => Promise.resolve('should not open'),
      showItemInFolder: () => undefined,
      run: busyMountRun,
    }),
    'relaunch',
  );
  if (mountDir !== null) {
    chmodSync(mountDir, 0o700);
    rmSync(mountDir, { force: true, recursive: true });
  }
  assertDeepEqual(readdirSync(dir7), ['auqw.app']);
  rmSync(dir7, { force: true, recursive: true });

  // a swapped-out `.auqw-old` that refuses removal is residue for the
  // next apply, not a failed install — the swap already owns the
  // verdict
  const dir8 = mkdtempSync(join(tmpdir(), 'auqw-dmg-test-'));
  const running8 = join(dir8, 'auqw.app');
  mkdirSync(join(running8, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(running8, 'Contents', 'MacOS', 'auqw'), '');
  chmodSync(running8, 0o000);
  const stubbornOldRun = (cmd: string, args: readonly string[]) => {
    if (cmd === 'hdiutil' && args[0] === 'attach') {
      const mount = args[args.length - 1];
      if (mount === undefined) {
        return Promise.reject(new Error('no mountpoint'));
      }
      mkdirSync(join(mount, 'auqw.app', 'Contents', 'MacOS'), {
        recursive: true,
      });
      return Promise.resolve();
    }
    if (cmd === 'ditto' && args[0] !== undefined && args[1] !== undefined) {
      cpSync(args[0], args[1], { recursive: true });
      return Promise.resolve();
    }
    return Promise.resolve();
  };
  assertEqual(
    await applyDmg({
      dmgPath: join(dir8, 'x.dmg'),
      isPackaged: true,
      exePath: join(running8, 'Contents', 'MacOS', 'auqw'),
      openPath: () => Promise.resolve('should not open'),
      showItemInFolder: () => undefined,
      run: stubbornOldRun,
    }),
    'relaunch',
  );
  chmodSync(join(dir8, 'auqw.app.auqw-old'), 0o700);
  assertDeepEqual(readdirSync(dir8).sort(), [
    'auqw.app',
    'auqw.app.auqw-old',
  ]);
  rmSync(dir8, { force: true, recursive: true });
}
