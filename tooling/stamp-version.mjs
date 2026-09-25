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

// Play and PackageManager both refuse an install whose versionCode is
// not strictly greater than the one already on the device, so it has to
// rise with every release tag. It is derived from the version rather
// than maintained beside it — a second hand-written number is exactly
// what goes stale and silently blocks upgrades.
//
// Layout `MAJOR*10^6 + MINOR*10^4 + PATCH*100 + slot`, where `slot` is
// the prerelease counter (`-alpha.5` -> 5), 0 for a prerelease without
// one, and 99 on a bare stable tag. That keeps `0.0.1` above
// `0.0.1-alpha.98` and `0.0.2-alpha.1` above both, at the cost of 98
// prereleases per patch line.
const versionCodeOf = (version) => {
  const match = SEMVER.exec(version);
  if (match === null) return null;
  const [, major, minor, patch, prerelease] = match;
  const counter =
    prerelease === undefined ? undefined : /[.](\d+)$/.exec(prerelease)?.[1];
  const slot =
    prerelease === undefined
      ? 99
      : counter === undefined
        ? 0
        : Math.min(Number(counter), 98);
  return Number(major) * 1_000_000 + Number(minor) * 10_000 + Number(patch) * 100 + slot;
};

const readAppConfig = () =>
  readFileSync(join(ROOT, 'apps/mobile/app.config.ts'), 'utf8');

const readVersions = () => {
  const config = readAppConfig();
  return {
    desktop: JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop/package.json'), 'utf8'),
    ).version,
    mobile: JSON.parse(
      readFileSync(join(ROOT, 'apps/mobile/package.json'), 'utf8'),
    ).version,
    config: config.match(/^\s*version: '([^']+)',\s*$/m)?.[1],
    code: config.match(/^\s*versionCode: (\d+),\s*$/m)?.[1],
  };
};

const arg = process.argv[2];

if (arg === '--check') {
  const wanted = process.argv[3];
  const found = readVersions();
  console.log(
    `desktop: ${found.desktop}\nmobile: ${found.mobile}\napp.config: ${found.config}\nversionCode: ${found.code}`,
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
  // versionCode derives from that version, so a mismatch means it was
  // hand-edited — refuse rather than ship a build that cannot
  // upgrade-install over the previous one.
  const expected = String(versionCodeOf(versions[0] ?? ''));
  if (found.code !== expected) {
    console.error(
      `stamp-version: app.config versionCode is ${found.code ?? 'missing'}, expected ${expected}`,
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
const CODE_FIELD = /^(\s*versionCode: )\d+(,\s*)$/m;
// Existence, not change — stamping the version the file already
// carries is an idempotent no-op, not a missing-field failure.
if (!FIELD.test(config) || !CODE_FIELD.test(config)) {
  console.error(
    'stamp-version: version/versionCode field not found in app.config.ts',
  );
  process.exit(1);
}
const code = String(versionCodeOf(version));
writeFileSync(
  configPath,
  config.replace(FIELD, `$1${version}$2`).replace(CODE_FIELD, `$1${code}$2`),
);

console.log(`stamped ${version} (versionCode ${code})`);
