/**
 * The macOS dmg apply leg — what the user's drag-to-Applications
 * does, done for them where the build allows it. A verified dmg
 * can't self-apply in place, but a PACKAGED build can replace its
 * own .app: mount the verified image, `ditto` the bundle into a
 * sibling, rename-swap it over the running one, detach, and let
 * 'ready-to-restart' relaunch into the new bytes. Every step is
 * reversible up to the swap, and any failure throws so the leg can
 * fall back to the manual surface — never a half-swapped bundle
 * presented as 'installed'.
 *
 * The manual leg (unpackaged dev runs, or a refused assist) opens
 * the image so Finder fronts its installer window — the
 * drag-to-Applications affordance itself — and reveals the staged
 * file when even that mount is refused.
 */
import { execFile } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { shellError } from '../shared/errors.ts';

/** One shelled step — injectable so tests drive the whole sequence
    without hdiutil/ditto. */
export type DarwinInstallRun = (
  cmd: string,
  args: readonly string[],
) => Promise<void>;

const execRun: DarwinInstallRun = (cmd, args) =>
  new Promise<void>((resolve, reject) => {
    execFile(cmd, [...args], (error) => {
      if (error !== null) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

/** The .app that owns a packaged exe (`<app>/Contents/MacOS/<bin>`),
    null for anything else — dev launches never reach here anyway
    (isPackaged gates), this is the belt to its suspenders. */
export function bundleForExe(exePath: string): string | null {
  // <bundle>.app / Contents / MacOS / <exe>
  const contents = dirname(dirname(exePath));
  const bundle = dirname(contents);
  return bundle.endsWith('.app') ? bundle : null;
}

/**
 * Replace `appBundlePath` with the .app inside `dmgPath`.
 *
 * The dmg mounts on a private mountpoint, its bundle copies to
 * `<bundle>.auqw-new` (ditto preserves the signature + resources),
 * the running bundle moves to `<bundle>.auqw-old`, the new one takes
 * its place, and the old one is removed. A failure before the second
 * rename leaves the running bundle untouched; a failure AT it puts
 * the old bundle back. Throws on any step's refusal.
 */
export async function installFromDmg(
  dmgPath: string,
  appBundlePath: string,
  run: DarwinInstallRun = execRun,
): Promise<void> {
  const mount = mkdtempSync(join(tmpdir(), 'auqw-update-'));
  const staged = `${appBundlePath}.auqw-new`;
  const replaced = `${appBundlePath}.auqw-old`;
  try {
    await run('hdiutil', [
      'attach',
      dmgPath,
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      mount,
    ]);
    try {
      const bundle = readdirSync(mount).find((name) =>
        name.endsWith('.app'),
      );
      if (bundle === undefined) {
        throw new Error(`no .app inside ${dmgPath}`);
      }
      rmSync(staged, { force: true, recursive: true });
      rmSync(replaced, { force: true, recursive: true });
      try {
        await run('ditto', [join(mount, bundle), staged]);
      } catch (thrown) {
        // A partial copy must not strand beside the app — when the
        // manual fallback succeeds, this attempt leaves no residue.
        rmSync(staged, { force: true, recursive: true });
        throw thrown;
      }
      renameSync(appBundlePath, replaced);
      try {
        renameSync(staged, appBundlePath);
      } catch (thrown) {
        // Put the old bundle back — a half-swap is worse than no swap.
        renameSync(replaced, appBundlePath);
        rmSync(staged, { force: true, recursive: true });
        throw thrown;
      }
      rmSync(replaced, { force: true, recursive: true });
    } finally {
      // Detach covers every post-attach failure — a prep throw before
      // the copy must not leave the private image mounted.
      await run('hdiutil', ['detach', mount, '-quiet']).catch(() =>
        run('hdiutil', ['detach', mount, '-force', '-quiet']).catch(
          () => undefined,
        ),
      );
    }
  } finally {
    rmSync(mount, { force: true, recursive: true });
  }
}

/**
 * The whole dmg leg: assisted install where the build allows it
 * (packaged .app), the Finder-mounted image otherwise. 'relaunch'
 * when the .app was swapped, 'installed' when Finder owns the rest.
 * An openPath refusal reveals the verified file and throws — the
 * applier lands 'failed' with a retryable error, never a false
 * 'installed'.
 */
export async function applyDmg(deps: {
  readonly dmgPath: string;
  readonly isPackaged: boolean;
  readonly exePath: string;
  /** Electron `shell.openPath` — resolves its error text, never
      rejects. */
  readonly openPath: (path: string) => Promise<string>;
  readonly showItemInFolder: (path: string) => void;
  readonly run?: DarwinInstallRun;
}): Promise<'relaunch' | 'installed'> {
  const bundle = deps.isPackaged ? bundleForExe(deps.exePath) : null;
  if (bundle !== null) {
    try {
      await installFromDmg(
        deps.dmgPath,
        bundle,
        deps.run ?? execRun,
      );
      return 'relaunch';
    } catch {
      // The assist refused (permissions, odd mount) — the manual
      // surface below stays the honest fallback.
    }
  }
  const error = await deps.openPath(deps.dmgPath);
  if (error !== '') {
    // Still put the verified file in front of the user — a manual
    // hdiutil attach stays one double-click away.
    deps.showItemInFolder(deps.dmgPath);
    throw shellError('transient', `dmg open: ${error}`);
  }
  return 'installed';
}
