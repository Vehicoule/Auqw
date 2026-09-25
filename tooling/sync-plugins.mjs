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
  randomBytes,
  verify as edVerify,
} from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = join(ROOT, 'providers.lock.json');
// Optional first arg: output dir relative to the repo root (desktop's
// packaged plugin set, for example). The default keeps the mobile path.
const outArg = process.argv[2];
const OUT = outArg === undefined ? join(ROOT, 'apps/mobile/assets/plugins') : resolve(ROOT, outArg);
// relative() (not a string prefix check): a sibling named with the repo
// prefix (Auqw-fake) starts with ROOT textually but resolves to '..',
// and the repo root itself is never a valid output dir. '..' is matched
// as a whole segment so an in-repo name like '..plugins' stays valid.
const outRel = relative(ROOT, OUT);
if (
  outRel === '' ||
  outRel === '..' ||
  outRel.startsWith(`..${sep}`) ||
  isAbsolute(outRel)
) {
  throw new Error(`sync-plugins: output dir must stay inside the repo: ${outArg}`);
}
// The spin conformance guest is a fuel-gate test plugin — ship it only
// in the default sync (mobile gate) or behind --conformance, never in a
// packaged consumer artifact's provider list.
const syncSpin =
  outArg === undefined || process.argv.includes('--conformance');

// Resolve a lock-relative source path. On a case-sensitive filesystem a
// sibling checkout may carry different casing than the lock expects
// (e.g. `../auqw-plugins` vs an `Auqw-plugins` clone), so after the
// exact path fails each segment is matched case-insensitively — but a
// segment only falls back when EXACTLY ONE entry matches: multiple
// lookalikes means the lock's intent is ambiguous, and picking one
// could let a stray checkout become the artifact source. If a segment
// is unresolvable the original path is returned so the error still
// names what the lock asked for.
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
    let match = part;
    if (!entries.includes(part)) {
      const lookalikes = entries.filter(
        (e) => e.toLowerCase() === part.toLowerCase(),
      );
      if (lookalikes.length !== 1) {
        if (lookalikes.length > 1) {
          console.error(
            `sync-plugins: ambiguous case-insensitive match for '${part}' in ${cur}: ${lookalikes.join(', ')}`,
          );
        }
        return abs;
      }
      [match] = lookalikes;
    }
    cur = join(cur, match);
  }
  return cur;
};

const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
mkdirSync(OUT, { recursive: true });
// Stage next to OUT: same filesystem so the swap's renames stay atomic,
// outside OUT so an abandoned stage can't enter a packaged recursive
// copy, and mkdtemp-named so a reused PID can never resurrect a killed
// run's leftovers into the live set. The exit hook cleans the live
// stage on every path — a failed sync leaves the previous set
// byte-identical. Stages abandoned by SIGKILL are reclaimed only when
// the owner PID encoded in the name is provably dead — a suspended or
// merely old stage is never touched, and PID reuse errs toward keeping
// (inert residue, not lost work).
for (const entry of readdirSync(dirname(OUT))) {
  const owner = /^\.sync-stage-(\d+)-/.exec(entry)?.[1];
  if (!owner) continue;
  try {
    process.kill(Number(owner), 0);
  } catch (err) {
    if (err.code === 'ESRCH') {
      rmSync(join(dirname(OUT), entry), { recursive: true, force: true });
    }
  }
}
// A `.sync-hold-<outhash>-*` dir is a complete previous provider set
// parked by a swap that died before it finished publishing — the
// resolved OUT path's hash is in the name, so sibling outputs sharing
// this parent can never claim each other's backup no matter what the
// out dir is called. When both it and OUT exist, OUT is already the
// new set and the hold is inert residue; when the crash left OUT
// missing or emptied, the hold goes back wholesale.
const HOLD_PREFIX = `.sync-hold-${createHash('sha256').update(OUT).digest('hex').slice(0, 16)}-`;
for (const entry of readdirSync(dirname(OUT))) {
  if (!entry.startsWith(HOLD_PREFIX)) continue;
  const hold = join(dirname(OUT), entry);
  if (existsSync(OUT) && readdirSync(OUT).length > 0) {
    rmSync(hold, { recursive: true, force: true });
  } else {
    rmSync(OUT, { recursive: true, force: true });
    renameSync(hold, OUT);
  }
}
const STAGE = mkdtempSync(join(dirname(OUT), `.sync-stage-${process.pid}-`));
process.on('exit', () => {
  rmSync(STAGE, { recursive: true, force: true });
});

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
    join(STAGE, `${plugin.id}.wasm`),
  );
  writeFileSync(join(STAGE, `${plugin.id}.manifest.json`), JSON.stringify(manifest));
  console.log(`synced ${plugin.id} ${plugin.version} ${plugin.digest.slice(0, 19)}…`);
}

// Spin conformance guest (fuel gate).
if (syncSpin) {
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
  copyFileSync(spinPath, join(STAGE, 'spin.wasm'));
  writeFileSync(join(STAGE, 'spin.manifest.json'), JSON.stringify(spinManifest));
  console.log(`synced spin ${spinManifest.artifact.digest.slice(0, 19)}…`);
}

// Swap the verified set into OUT. Artifacts dropped from the lock must
// not linger — packaged builds copy OUT wholesale — so the live set
// moves aside wholesale too: non-artifacts are copied into STAGE first,
// then OUT parks under a hold name and STAGE publishes in one rename
// each. A kill between the two renames leaves the complete previous set
// in the hold, which the recovery pass above restores on the next run —
// OUT is never a partial provider set.
for (const entry of readdirSync(OUT)) {
  if (!entry.endsWith('.wasm') && !entry.endsWith('.manifest.json')) {
    // cpSync, not copyFileSync: non-artifacts can be nested directories
    // or symlinks, and verbatimSymlinks preserves a link as a link.
    cpSync(join(OUT, entry), join(STAGE, entry), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}
const HOLD = join(
  dirname(OUT),
  `${HOLD_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`,
);
try {
  renameSync(OUT, HOLD);
  renameSync(STAGE, OUT);
  // Only the success path removes the hold — on any failure the hold
  // keeps the complete previous set on disk for the recovery pass.
  rmSync(HOLD, { recursive: true, force: true });
} catch (thrown) {
  // Restore the hold if the publish rename left OUT missing (either
  // the publish failed or restore itself will report). If restore
  // also fails, the hold stays for the next run's recovery pass.
  try {
    renameSync(HOLD, OUT);
  } catch {
    // OUT exists or restore failed — the recovery pass handles it.
  }
  throw thrown;
}
