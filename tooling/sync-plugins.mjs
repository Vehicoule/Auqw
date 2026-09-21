#!/usr/bin/env node
// Sync pinned plugin artifacts into the mobile app's assets.
// Reads providers.lock.json, verifies each artifact's sha256, and
// copies `<id>.wasm` + `<id>.manifest.json` into
// apps/mobile/assets/plugins/. Also syncs the spin conformance guest
// for the on-device fuel gate.
//
// Source kinds:
//   local-build:<path-to-wasm>   dev loop — digest + manifest checks only
//   release:<path-to-release-dir>  signed release — digest, manifest,
//     provenance, and the ed25519 signature are all verified against
//     the lock's pinned keyId/publicKey before anything is copied.
//
// The canonical payload and key_id derivation mirror
// auqw-plugins/tooling/sign.mjs — keep them in lockstep.
import {
  createHash,
  createPublicKey,
  verify as edVerify,
} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = join(ROOT, 'providers.lock.json');
const OUT = join(ROOT, 'apps/mobile/assets/plugins');

// Resolve a lock-relative source path. On a case-sensitive filesystem a
// sibling checkout may carry different casing than the lock expects
// (e.g. `../auqw-plugins` vs an `Auqw-plugins` clone), so after the
// exact path fails each segment is matched case-insensitively — the
// first sorted match wins, keeping the fallback deterministic. If any
// segment is unresolvable the original path is returned so the error
// still names what the lock asked for.
const resolveSourcePath = (rel) => {
  const abs = resolve(ROOT, rel);
  if (existsSync(abs)) return abs;
  let cur = '/';
  for (const part of abs.split('/')) {
    if (!part) continue;
    let entries;
    try {
      entries = readdirSync(cur);
    } catch {
      return abs;
    }
    const match = entries.includes(part)
      ? part
      : entries
          .filter((e) => e.toLowerCase() === part.toLowerCase())
          .sort()[0];
    if (match === undefined) return abs;
    cur = join(cur, match);
  }
  return cur;
};

const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
mkdirSync(OUT, { recursive: true });

const keyIdOf = (publicPem) =>
  createHash('sha256')
    .update(createPublicKey(publicPem).export({ format: 'der', type: 'spki' }))
    .digest('hex')
    .slice(0, 16);

const canonicalPayload = ({ plugin, version, abi, wasmSha, manifestSha, keyId }) =>
  `auqw-release-v1\n${plugin}\n${version}\n${abi}\n${wasmSha}\n${manifestSha}\n${keyId}\n`;

// Verify a signed release dir end to end: digests, manifest/provenance
// identity agreement, then the ed25519 signature over the canonical
// payload against the key the lock pins.
const verifyRelease = (plugin, dir) => {
  const bad = (msg) => {
    throw new Error(`${plugin.id}: ${msg}`);
  };
  const need = (name) => {
    const p = join(dir, name);
    try {
      return readFileSync(p);
    } catch {
      bad(`release dir is missing ${name}`);
    }
  };
  if (readdirSync(dir).filter((f) => f.endsWith('.wasm')).length !== 1) {
    bad('release dir must hold exactly one .wasm artifact');
  }
  const wasm = need(`${plugin.id}-${plugin.version}.wasm`);
  const manifestBuf = need('plugin.manifest.json');
  const provenance = JSON.parse(need('provenance.json').toString('utf8'));
  const signature = need('signature');

  const wasmSha = sha256(wasm);
  if (wasmSha !== plugin.digest) {
    bad(`wasm digest drift: ${wasmSha} != lock ${plugin.digest}`);
  }
  if (provenance.wasm_sha256 !== wasmSha) {
    bad(`wasm digest ${wasmSha} != provenance ${provenance.wasm_sha256}`);
  }
  const manifestSha = sha256(manifestBuf);
  if (manifestSha !== provenance.manifest_sha256) {
    bad(`manifest digest ${manifestSha} != provenance ${provenance.manifest_sha256}`);
  }
  if (
    provenance.plugin !== plugin.id ||
    provenance.version !== plugin.version ||
    provenance.abi_version !== plugin.abi
  ) {
    bad('provenance id/version/abi disagree with the lock entry');
  }
  if (provenance.key_id !== lock.keyId) {
    bad(`signed by key ${provenance.key_id}; lock pins ${lock.keyId}`);
  }
  if (keyIdOf(lock.publicKey) !== lock.keyId) {
    bad(`lock publicKey derives key ${keyIdOf(lock.publicKey)} != lock keyId ${lock.keyId}`);
  }
  const payload = canonicalPayload({
    plugin: plugin.id,
    version: plugin.version,
    abi: plugin.abi,
    wasmSha,
    manifestSha,
    keyId: lock.keyId,
  });
  const ok = edVerify(
    null,
    Buffer.from(payload, 'utf8'),
    lock.publicKey,
    Buffer.from(signature.toString('utf8').trim(), 'base64'),
  );
  if (!ok) bad('ed25519 signature does not verify');
  return { wasm, manifest: JSON.parse(manifestBuf.toString('utf8')) };
};

// Lock ids become output filenames below — a duplicate (or a collision
// with the conformance guest's fixed 'spin' id) would silently overwrite
// another plugin's synced artifacts.
const ids = new Set(['spin']);
for (const plugin of lock.plugins) {
  if (ids.has(plugin.id)) {
    throw new Error(`providers.lock.json: duplicate plugin id ${plugin.id}`);
  }
  ids.add(plugin.id);
  const source = plugin.source;
  let wasm;
  let manifest;
  let wasmPath;
  let releaseDir;
  if (source.startsWith('local-build:')) {
    wasmPath = resolveSourcePath(source.slice('local-build:'.length));
    wasm = readFileSync(wasmPath);
    if (sha256(wasm) !== plugin.digest) {
      throw new Error(`${plugin.id}: digest mismatch lock=${plugin.digest} actual=${sha256(wasm)}`);
    }
    manifest = JSON.parse(readFileSync(join(dirname(wasmPath), '../manifest.json'), 'utf8'));
  } else if (source.startsWith('release:')) {
    if (!lock.keyId || !lock.publicKey) {
      throw new Error('release sources need keyId + publicKey in providers.lock.json');
    }
    releaseDir = resolveSourcePath(source.slice('release:'.length));
    ({ wasm, manifest } = verifyRelease(plugin, releaseDir));
  } else {
    throw new Error(`${plugin.id}: unsupported source ${source}`);
  }
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
  copyFileSync(
    wasmPath ?? join(releaseDir, `${plugin.id}-${plugin.version}.wasm`),
    join(OUT, `${plugin.id}.wasm`),
  );
  writeFileSync(join(OUT, `${plugin.id}.manifest.json`), JSON.stringify(manifest));
  console.log(`synced ${plugin.id} ${plugin.version} ${plugin.digest.slice(0, 19)}…`);
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
