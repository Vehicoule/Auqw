#!/usr/bin/env node
// Stamp the product version into the release-facing manifests:
// apps/desktop/package.json (electron-builder artifact name + app
// version) and apps/mobile/app.config.ts (Expo user-facing version).
//
// The git tag is the release source of truth — CI calls this with the
// tag's version before building so an alpha.N bump needs no manifest
// edit. Running it locally does the same rewrite; either way every
// version a build reports comes from one argument.
//
//   node tooling/stamp-version.mjs 0.0.1-alpha.1
//   node tooling/stamp-version.mjs --check [version]
//     exit 0 iff all three manifests carry the same version (and it
//     equals `version` when given) — a gate, not just a report.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE =
  'usage: stamp-version.mjs <version>|--check [version]';

// Strict semver: MAJOR.MINOR.PATCH with optional -prerelease — the
// same grammar electron-builder and Expo accept, so a tag that would
// fail downstream fails here first. (Build metadata is deliberately
// not accepted — release tags never carry it.)
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

// The char class above can't express semver's rule that an all-digit
// prerelease identifier must not carry a leading zero (alpha.01 is
// invalid; alpha.0 / 0 are fine). Check each identifier explicitly.
const isSemver = (value) => {
  const match = SEMVER.exec(value);
  if (match === null) return false;
  const prerelease = match[4];
  if (prerelease === undefined) return true;
  return !prerelease
    .split('.')
    .some((ident) => /^\d+$/.test(ident) && ident.length > 1 && ident.startsWith('0'));
};

const readVersions = () => ({
  desktop: JSON.parse(
    readFileSync(join(ROOT, 'apps/desktop/package.json'), 'utf8'),
  ).version,
  mobile: JSON.parse(
    readFileSync(join(ROOT, 'apps/mobile/package.json'), 'utf8'),
  ).version,
  config: readFileSync(
    join(ROOT, 'apps/mobile/app.config.ts'),
    'utf8',
  ).match(/^\s*version: '([^']+)',$/m)?.[1],
});

const arg = process.argv[2];

if (arg === '--check') {
  const wanted = process.argv[3];
  const found = readVersions();
  console.log(
    `desktop: ${found.desktop}\nmobile: ${found.mobile}\napp.config: ${found.config}`,
  );
  const versions = [found.desktop, found.mobile, found.config];
  const agree =
    versions.every((v) => v !== undefined && v === versions[0]) &&
    (wanted === undefined || versions[0] === wanted);
  if (!agree) {
    console.error(
      wanted === undefined
        ? 'stamp-version: manifests do not carry one version'
        : `stamp-version: manifests do not all carry ${wanted}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (arg === undefined) {
  console.error(USAGE);
  process.exit(1);
}

const version = arg.startsWith('v') ? arg.slice(1) : arg;
if (!isSemver(version)) {
  console.error(
    `stamp-version: '${arg}' is not a semver (x.y.z[-channel])`,
  );
  process.exit(1);
}

for (const rel of [
  'apps/desktop/package.json',
  'apps/mobile/package.json',
]) {
  const path = join(ROOT, rel);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  json.version = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

const configPath = join(ROOT, 'apps/mobile/app.config.ts');
const config = readFileSync(configPath, 'utf8');
const FIELD = /^(\s*version: ')[^']+(',\s*)$/m;
// Existence, not change — stamping the version the file already
// carries is an idempotent no-op, not a missing-field failure.
if (!FIELD.test(config)) {
  console.error(
    'stamp-version: version field not found in app.config.ts',
  );
  process.exit(1);
}
writeFileSync(configPath, config.replace(FIELD, `$1${version}$2`));

console.log(`stamped ${version}`);
