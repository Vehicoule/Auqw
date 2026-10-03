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
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

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
    // bundle. No --force: the loose binaries under Resources/ were
    // signed to their final bytes before writeUtilityIntegrity hashed
    // them, so the seal must keep those signatures — rewriting them
    // here would ship bytes the runtime digest check refuses. Nested
    // code that is still unsigned gets signed regardless, and the
    // outer seal covers the manifest in CodeResources either way.
    const signed = run(['--deep', '--sign', '-', appPath]);
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

// Loose-file integrity: `asarUnpack` puts dist/utility/** outside
// app.asar, and the napi artifact ships loose at the resources root —
// the fuse asar-integrity check covers neither. Write
// utility-integrity.sha256 under resources/ in the sha256sum format
// tooling/checksums.mjs uses ("<hex>  <relpath>", POSIX separators,
// rel against the resources dir); main verifies every entry before
// each utilityProcess.fork (src/main/utility-integrity.ts).
// The files utility-integrity.sha256 covers: everything asarUnpack
// put outside app.asar plus the loose napi artifacts at resources
// root. Signing and hashing must enumerate the identical set, so
// both read from here.
function coveredUtilityFiles(resourcesDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        files.push(abs);
      }
    }
  };
  const unpacked = join(resourcesDir, 'app.asar.unpacked');
  if (existsSync(unpacked)) {
    walk(unpacked);
  }
  for (const name of readdirSync(resourcesDir).sort()) {
    const abs = join(resourcesDir, name);
    if (name.endsWith('.node') && statSync(abs).isFile()) {
      files.push(abs);
    }
  }
  return files;
}

// First four bytes, big-endian, for every Mach-O container: thin
// 32/64-bit in both byte orders, plus fat and fat-64 universal
// headers.
const MACHO_MAGICS = new Set([
  0xfeedface, 0xcefaedfe,
  0xfeedfacf, 0xcffaedfe,
  0xcafebabe, 0xbebafeca, 0xcafebabf,
]);

function isMachO(abs) {
  const head = Buffer.alloc(4);
  const fd = openSync(abs, 'r');
  try {
    if (readSync(fd, head, 0, 4, 0) < 4) {
      return false;
    }
    return MACHO_MAGICS.has(head.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

// Signing rewrites a Mach-O's bytes — the arm64 linker already
// ad-hoc signed every binary electron-builder packed. Covered
// binaries are therefore signed to their final signature FIRST, so
// the manifest hashes the bytes that actually ship; the bundle seal
// then runs without --force and leaves them untouched. Non-Mach-O
// files (the unpacked utility js) pass through unchanged.
export function signCoveredMachOs(resourcesDir) {
  for (const abs of coveredUtilityFiles(resourcesDir)) {
    if (!isMachO(abs)) {
      continue;
    }
    const signed = run(['--force', '--sign', '-', abs]);
    if (signed.status !== 0) {
      throw new Error(
        `after-pack: codesign failed for ${abs}\n${signed.stderr}`,
      );
    }
    console.log(`after-pack: ad-hoc signed ${abs}`);
  }
}

export function writeUtilityIntegrity(resourcesDir) {
  const files = coveredUtilityFiles(resourcesDir);
  if (files.length === 0) {
    throw new Error(
      `after-pack: no loose utility files under ${resourcesDir} — the integrity manifest would cover nothing`,
    );
  }
  const lines = files
    .map((abs) => {
      const rel = relative(resourcesDir, abs).split(sep).join('/');
      const hex = createHash('sha256').update(readFileSync(abs)).digest('hex');
      return `${hex}  ${rel}`;
    })
    .sort();
  writeFileSync(
    join(resourcesDir, 'utility-integrity.sha256'),
    lines.join('\n') + '\n',
  );
  console.log(
    `after-pack: utility-integrity.sha256 covers ${files.length} loose file(s)`,
  );
}

function resourcesDirOf(context) {
  return context.electronPlatformName === 'darwin'
    ? join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents',
        'Resources',
      )
    : join(context.appOutDir, 'resources');
}

export default async function afterPack(context) {
  const resourcesDir = resourcesDirOf(context);
  if (context.electronPlatformName !== 'darwin') {
    writeUtilityIntegrity(resourcesDir);
    return;
  }
  // Ordering on macOS: covered Mach-Os get their final signature
  // first (signing rewrites their bytes), the manifest hashes those
  // shipped bytes, and the bundle seal lands last — its --deep pass
  // preserves the nested signatures and writes a CodeResources seal
  // that covers the manifest.
  signCoveredMachOs(resourcesDir);
  writeUtilityIntegrity(resourcesDir);
  sealAppBundle(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
}
