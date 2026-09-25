// Seal the packed macOS app bundle with an ad-hoc signature. This runs
// after electron-builder packs the .app and before it builds targets —
// the .dmg is made from this bundle, so the seal has to exist now, not
// after the fact (a post-build fix would leave the installer carrying
// the broken bundle).
//
// electron-builder skips its own signing pass when no identity is
// configured — the alpha case. That leaves the bundle worse than
// unsigned: every Mach-O still carries the ad-hoc signature the arm64
// linker emitted at build time, but no
// Contents/_CodeSignature/CodeResources seal is ever written.
// `codesign --verify --deep --strict` then fails with "code has no
// resources but signature indicates they must be present" and
// Gatekeeper reports the download as *damaged* rather than merely
// *unverified* — the dialog with no recourse but `xattr`.
//
// Ad-hoc sealing is not notarization: Developer ID + notarization is a
// separate, still-open decision (RELEASING.md). This hook only ever
// seals a bundle nobody signed, so adopting a real identity later needs
// no change here.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const run = (args) => {
  const result = spawnSync('codesign', args, { encoding: 'utf8' });
  if (result.error != null) {
    throw new Error(
      `after-pack: cannot run codesign (${result.error.message}) — mac bundles must be sealed on macOS`,
    );
  }
  return result;
};

// `codesign -dvv` reports to stderr. `TeamIdentifier=not set` is what
// an ad-hoc or linker-signed bundle prints; a real Developer ID
// signature prints the team that owns it.
const hasRealIdentity = (appPath) => {
  const team = /^TeamIdentifier=(.+)$/m.exec(run(['-dvv', appPath]).stderr ?? '')?.[1]?.trim();
  return team !== undefined && team !== 'not set';
};

// Exported separately from the electron-builder hook so the seal can be
// run (and checked) against any bundle, not just a freshly packed one.
export function sealAppBundle(appPath) {
  if (!existsSync(appPath)) {
    throw new Error(`after-pack: no app bundle at ${appPath}`);
  }

  if (hasRealIdentity(appPath)) {
    console.log(`after-pack: ${appPath} already carries a real signature — leaving it alone`);
  } else {
    // --deep signs the nested helpers and frameworks along with the
    // bundle. It is safe here precisely because this branch only runs
    // for an unsealed bundle (nothing to clobber) and the gate below
    // proves the outer seal does cover the nested code.
    const signed = run(['--force', '--deep', '--sign', '-', appPath]);
    if (signed.status !== 0) {
      throw new Error(`after-pack: codesign failed for ${appPath}\n${signed.stderr}`);
    }
    console.log(`after-pack: ad-hoc sealed ${appPath}`);
  }

  // Gate, not a report: this is the exact check a broken bundle fails,
  // so a bundle that will not verify stops the build instead of
  // shipping another "damaged" dialog.
  const verified = run(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  if (verified.status !== 0) {
    throw new Error(`after-pack: ${appPath} does not verify\n${verified.stderr}`);
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  sealAppBundle(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
}
