#!/usr/bin/env node
// Sync pinned plugin artifacts into the mobile app's assets.
// Reads providers.lock.json, verifies each artifact's sha256, and
// copies `<id>.wasm` + `<id>.manifest.json` into
// apps/mobile/assets/plugins/. Also syncs the spin conformance guest
// for the on-device fuel gate.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = join(ROOT, 'providers.lock.json');
const OUT = join(ROOT, 'apps/mobile/assets/plugins');

const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
mkdirSync(OUT, { recursive: true });

for (const plugin of lock.plugins) {
  const source = plugin.source;
  if (!source.startsWith('local-build:')) {
    throw new Error(`${plugin.id}: unsupported source ${source}`);
  }
  const wasmPath = resolve(ROOT, source.slice('local-build:'.length));
  const wasm = readFileSync(wasmPath);
  const digest = sha256(wasm);
  if (digest !== plugin.digest) {
    throw new Error(`${plugin.id}: digest mismatch lock=${plugin.digest} actual=${digest}`);
  }
  const manifestPath = join(dirname(wasmPath), '../manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // The lock pins identity as well as bytes: a manifest whose id,
  // version, or ABI disagrees with the lock entry is not the artifact
  // the lock claims, even when the digest matches.
  for (const key of ['id', 'version', 'abi']) {
    if (manifest[key] !== plugin[key]) {
      throw new Error(
        `${plugin.id}: manifest ${key} ${manifest[key]} != lock ${plugin[key]}`,
      );
    }
  }
  if (plugin.abi !== lock.abi) {
    throw new Error(`${plugin.id}: lock abi ${plugin.abi} != lockfile abi ${lock.abi}`);
  }
  if (manifest.artifact.digest !== plugin.digest) {
    throw new Error(`${plugin.id}: manifest digest ${manifest.artifact.digest} != lock ${plugin.digest}`);
  }
  copyFileSync(wasmPath, join(OUT, `${plugin.id}.wasm`));
  writeFileSync(join(OUT, `${plugin.id}.manifest.json`), JSON.stringify(manifest));
  console.log(`synced ${plugin.id} ${plugin.version} ${digest.slice(0, 19)}…`);
}

// Spin conformance guest (fuel gate).
const spinPath = join(ROOT, 'sdk/conformance/spin/spin.wasm');
const spin = readFileSync(spinPath);
const spinManifest = {
  id: 'spin',
  version: '0.1.0',
  abi: lock.abi,
  capabilities: ['playback.resolve'],
  permissions: [],
  artifact: { path: 'spin.wasm', digest: sha256(spin) },
};
copyFileSync(spinPath, join(OUT, 'spin.wasm'));
writeFileSync(join(OUT, 'spin.manifest.json'), JSON.stringify(spinManifest));
console.log(`synced spin ${spinManifest.artifact.digest.slice(0, 19)}…`);
