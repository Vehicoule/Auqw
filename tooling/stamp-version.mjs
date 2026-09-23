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
//   node tooling/stamp-version.mjs --check   # report, no write
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Strict semver: MAJOR.MINOR.PATCH with optional -prerelease — the
// same grammar electron-builder and Expo accept, so a tag that would
// fail downstream fails here first.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const arg = process.argv[2];

if (arg === '--check' || arg === undefined) {
  const desktop = JSON.parse(
    readFileSync(join(ROOT, 'apps/desktop/package.json'), 'utf8'),
  ).version;
  const mobile = JSON.parse(
    readFileSync(join(ROOT, 'apps/mobile/package.json'), 'utf8'),
  ).version;
  const config = readFileSync(
    join(ROOT, 'apps/mobile/app.config.ts'),
    'utf8',
  ).match(/^\s*version: '([^']+)',$/m)?.[1];
  console.log(
    `desktop: ${desktop}\nmobile: ${mobile}\napp.config: ${config}`,
  );
  process.exit(arg === '--check' ? 0 : 1);
}

const version = arg.startsWith('v') ? arg.slice(1) : arg;
if (!SEMVER.test(version)) {
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
const stamped = config.replace(
  /^(\s*version: ')[^']+(',\s*)$/m,
  `$1${version}$2`,
);
if (stamped === config) {
  console.error(
    'stamp-version: version field not found in app.config.ts',
  );
  process.exit(1);
}
writeFileSync(configPath, stamped);

console.log(`stamped ${version}`);
