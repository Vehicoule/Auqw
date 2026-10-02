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
// Modes:
//   (default)      verify + stage + swap artifacts into the output dir
//   --check        verify only — resolve every lock source and run the
//                  same checks without staging, copying, or writing
//                  anything (the merge-gate form of the lock read)
//   --release      fail closed on local-build: sources — a packaged or
//                  published artifact may only carry verified release:
//                  sources
//   --conformance  also sync the spin conformance guest (default when
//                  no output dir is given; never in --check — spin is
//                  not a lock entry)
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
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = join(ROOT, 'providers.lock.json');

// relative() (not a string prefix check): a sibling named with the repo
// prefix (Auqw-fake) starts with ROOT textually but resolves to '..',
// and the repo root itself is never a valid target. '..' is matched
// as a whole segment so an in-repo name like '..plugins' stays valid.
// `shown` is the spelling worth reporting (the lock's source text or
// the CLI arg), defaulting to the resolved path itself.
const assertInsideRepo = (abs, what, shown = abs) => {
  const rel = relative(ROOT, abs);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`sync-plugins: ${what} must stay inside the repo: ${shown}`);
  }
  return abs;
};

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
  let cur = parse(abs).root;
  // Split on the platform separator and start from the volume root —
  // `resolve` yields backslash paths and a drive root on Windows, where
  // splitting on '/' never separates a segment and the walk silently
  // degrades to the un-resolved path.
  for (const part of abs.slice(cur.length).split(sep)) {
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

const keyIdOf = (publicPem) =>
  createHash('sha256')
    .update(createPublicKey(publicPem).export({ format: 'der', type: 'spki' }))
    .digest('hex')
    .slice(0, 16);

const canonicalPayload = ({ plugin, version, abi, wasmSha, manifestSha, keyId }) =>
  `auqw-release-v1\n${plugin}\n${version}\n${abi}\n${wasmSha}\n${manifestSha}\n${keyId}\n`;

// Verify a signed release dir end to end: digests, manifest/provenance
// identity agreement, then the ed25519 signature over the canonical
// payload against the key the lock pins. `plugin` is the lock entry —
// its `manifest_digest` pins the manifest bytes so the sandbox grant a
// release was reviewed under cannot drift without a lock change.
const verifyRelease = (plugin, dir, lock) => {
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
  if (provenance.manifest_sha256 !== plugin.manifest_digest) {
    bad(`manifest digest ${provenance.manifest_sha256} != lock manifest_digest ${plugin.manifest_digest}`);
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

// Resolve + verify one lock entry's source, returning the manifest and
// the path of the .wasm artifact a sync would copy. Verification is
// identical in --check and sync modes — only the copying differs.
// `local-build:` stays dev-loop-only: its resolved path (and the
// manifest beside it) must live inside this repo, and --release refuses
// it outright. release: sources legitimately leave the repo — they name
// a directory in the sibling plugins checkout.
const loadPluginArtifacts = (plugin, lock, { releaseOnly = false } = {}) => {
  const source = plugin.source;
  if (source.startsWith('local-build:')) {
    if (releaseOnly) {
      throw new Error(`${plugin.id}: local-build: sources are refused under --release`);
    }
    const wasmPath = assertInsideRepo(
      resolveSourcePath(source.slice('local-build:'.length)),
      'local-build source',
      source,
    );
    const wasm = readFileSync(wasmPath);
    if (sha256(wasm) !== plugin.digest) {
      throw new Error(`${plugin.id}: digest mismatch lock=${plugin.digest} actual=${sha256(wasm)}`);
    }
    const manifestPath = assertInsideRepo(
      resolve(dirname(wasmPath), '../manifest.json'),
      'local-build manifest',
      source,
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return { manifest, artifactPath: wasmPath };
  }
  if (source.startsWith('release:')) {
    if (!lock.keyId || !lock.publicKey) {
      throw new Error('release sources need keyId + publicKey in providers.lock.json');
    }
    const releaseDir = resolveSourcePath(source.slice('release:'.length));
    const { manifest } = verifyRelease(plugin, releaseDir, lock);
    return {
      manifest,
      artifactPath: join(releaseDir, `${plugin.id}-${plugin.version}.wasm`),
    };
  }
  throw new Error(`${plugin.id}: unsupported source ${source}`);
};

// The lock pins identity as well as bytes: a manifest whose id,
// version, or ABI disagrees with the lock entry is not the artifact
// the lock claims, even when the digest matches.
const assertLockAgreement = (plugin, manifest, lock) => {
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
};

const KNOWN_FLAGS = new Set(['--check', '--verify', '--release', '--conformance']);

const main = (argv) => {
  const flags = new Set();
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      if (!KNOWN_FLAGS.has(arg)) {
        throw new Error(`sync-plugins: unknown flag ${arg}`);
      }
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }
  const check = flags.has('--check') || flags.has('--verify');
  const releaseOnly = flags.has('--release');
  // Optional positional arg: output dir relative to the repo root
  // (desktop's packaged plugin set, for example). The default keeps the
  // mobile path. --check writes nothing, so it takes no output dir.
  const outArg = positional[0];
  if (check && outArg !== undefined) {
    throw new Error(`sync-plugins: --check verifies only; no output dir: ${outArg}`);
  }

  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));

  // Lock ids become output filenames below — a duplicate (or a
  // collision with the conformance guest's fixed 'spin' id) would
  // silently overwrite another plugin's synced artifacts.
  const ids = new Set(['spin']);
  const artifacts = [];
  for (const plugin of lock.plugins) {
    if (ids.has(plugin.id)) {
      throw new Error(`providers.lock.json: duplicate plugin id ${plugin.id}`);
    }
    ids.add(plugin.id);
    const { manifest, artifactPath } = loadPluginArtifacts(plugin, lock, { releaseOnly });
    assertLockAgreement(plugin, manifest, lock);
    artifacts.push({ plugin, manifest, artifactPath });
  }

  if (check) {
    for (const { plugin } of artifacts) {
      console.log(`checked ${plugin.id} ${plugin.version} ${plugin.digest.slice(0, 19)}…`);
    }
    return;
  }

  const OUT = outArg === undefined ? join(ROOT, 'apps/mobile/assets/plugins') : resolve(ROOT, outArg);
  assertInsideRepo(OUT, 'output dir', outArg);
  // The spin conformance guest is a fuel-gate test plugin — ship it
  // only in the default sync (mobile gate) or behind --conformance,
  // never in a packaged consumer artifact's provider list.
  const syncSpin = outArg === undefined || flags.has('--conformance');

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

  for (const { plugin, manifest, artifactPath } of artifacts) {
    copyFileSync(artifactPath, join(STAGE, `${plugin.id}.wasm`));
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
};

export { canonicalPayload, keyIdOf, sha256, verifyRelease };

// Importable for tests: run the CLI only when this file is the entry
// point, matching how `node tooling/sync-plugins.mjs` invokes it.
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
