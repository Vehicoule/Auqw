import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  sign as edSign,
} from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  canonicalPayload,
  keyIdOf,
  sha256,
  verifyRelease,
} from './sync-plugins.mjs';

// verifyRelease() is the whole artifact authenticity check for
// release:-sourced plugins — every lock pin (wasm digest, manifest
// digest, key id, signature) has to hold against a fresh ed25519
// keypair and a signed fixture release built the same way
// auqw-plugins/tooling/sign.mjs lays out releases/<id>/<version>/:
//   <id>-<version>.wasm   the artifact bytes, verbatim
//   plugin.manifest.json  the manifest, verbatim
//   provenance.json       digests + signer identity
//   signature             base64 ed25519 over the canonical payload

const keypair = () =>
  generateKeyPairSync('ed25519', {
    publicKeyEncoding: { format: 'pem', type: 'spki' },
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  });

// Returns { dir, plugin, lock, sign(payload) } — `plugin` is the lock
// entry for the fixture release in `dir`, `lock` carries the pinned
// key, and `sign` re-signs a payload when a test mutates one field.
const makeRelease = () => {
  const { publicKey, privateKey } = keypair();
  const keyId = keyIdOf(publicKey);
  const wasm = Buffer.from('fixture wasm bytes');
  const wasmSha = sha256(wasm);
  const manifest = {
    id: 'fixture-plugin',
    version: '1.0.0',
    abi: '0.3.0',
    capabilities: ['playback.resolve'],
    permissions: [],
    artifact: { path: 'dist/fixture-plugin.wasm', digest: wasmSha },
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
  const manifestSha = sha256(manifestBuf);
  const plugin = {
    id: 'fixture-plugin',
    version: '1.0.0',
    abi: '0.3.0',
    digest: wasmSha,
    manifest_digest: manifestSha,
    source: 'release:../fixtures/releases/fixture-plugin/1.0.0',
  };
  const lock = { abi: '0.3.0', keyId, publicKey, plugins: [plugin] };
  const provenance = {
    plugin: plugin.id,
    version: plugin.version,
    abi_version: plugin.abi,
    wasm_sha256: wasmSha,
    manifest_sha256: manifestSha,
    signed_at: new Date().toISOString(),
    key_id: keyId,
    toolchain: { node: process.version, platform: `${process.platform}/${process.arch}` },
  };
  const payload = canonicalPayload({
    plugin: plugin.id,
    version: plugin.version,
    abi: plugin.abi,
    wasmSha,
    manifestSha,
    keyId,
  });
  const dir = mkdtempSync(join(tmpdir(), 'sync-plugins-test-'));
  writeFileSync(join(dir, `${plugin.id}-${plugin.version}.wasm`), wasm);
  writeFileSync(join(dir, 'plugin.manifest.json'), manifestBuf);
  writeFileSync(join(dir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  writeFileSync(
    join(dir, 'signature'),
    `${edSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')}\n`,
  );
  const sign = (payloadBuf, key = privateKey) =>
    edSign(null, payloadBuf, key).toString('base64');
  return { dir, plugin, lock, sign };
};

const throwsWith = (fn, pattern) =>
  assert.throws(fn, (err) => pattern.test(err.message));

const patchProvenance = (dir, patch) => {
  const provenance = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));
  Object.assign(provenance, patch);
  writeFileSync(join(dir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
};

test('a well-formed signed release verifies', (t) => {
  const { dir, plugin, lock } = makeRelease();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { wasm, manifest } = verifyRelease(plugin, dir, lock);
  assert.equal(manifest.id, 'fixture-plugin');
  assert.equal(manifest.artifact.digest, plugin.digest);
  assert.equal(sha256(wasm), plugin.digest);
});

test('wrong wasm digest is rejected', (t) => {
  const { dir, plugin, lock } = makeRelease();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, `${plugin.id}-${plugin.version}.wasm`), 'tampered wasm bytes');
  throwsWith(() => verifyRelease(plugin, dir, lock), /wasm digest drift/);
});

test('a signature from the wrong private key is rejected', (t) => {
  const { dir, plugin, lock, sign } = makeRelease();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Provenance still claims the pinned key — only the signature is
  // made by an attacker key, so the failure lands at edVerify.
  const { privateKey: attacker } = keypair();
  const payload = canonicalPayload({
    plugin: plugin.id,
    version: plugin.version,
    abi: plugin.abi,
    wasmSha: plugin.digest,
    manifestSha: plugin.manifest_digest,
    keyId: lock.keyId,
  });
  writeFileSync(join(dir, 'signature'), `${sign(Buffer.from(payload, 'utf8'), attacker)}\n`);
  throwsWith(() => verifyRelease(plugin, dir, lock), /ed25519 signature does not verify/);
});

test('a release signed under the wrong key id is rejected', (t) => {
  const { dir, plugin, lock } = makeRelease();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  patchProvenance(dir, { key_id: 'deadbeefdeadbeef' });
  throwsWith(() => verifyRelease(plugin, dir, lock), /signed by key deadbeefdeadbeef/);
});

test('mutated provenance identity is rejected', (t) => {
  const { dir, plugin, lock } = makeRelease();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  patchProvenance(dir, { version: '9.9.9' });
  throwsWith(() => verifyRelease(plugin, dir, lock), /provenance id\/version\/abi disagree/);
});

test('a lock manifest_digest the provenance does not match is rejected', (t) => {
  const { dir, plugin, lock } = makeRelease();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const drifted = { ...plugin, manifest_digest: sha256('not the reviewed manifest') };
  throwsWith(() => verifyRelease(drifted, dir, lock), /lock manifest_digest/);
});
