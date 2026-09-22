// Smoke test for the napi boundary: constructs the host, loads the
// echo conformance guest, and asserts the promise-based outcome
// surface (typed rejections, tagged outcomes, id echo, id reuse).
//
//   cargo build -p auqw-node-bindings
//   node crates/node-bindings/test/smoke.mjs
//
// Run from the repo root. The debug artifact is copied to a fresh
// location on every run so a stale binary can never pass for a
// broken build. CI/release packaging is the desktop app's concern
// (slice 4 phase 1b).

import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// The debug artifact name is platform-shaped (cdylib conventions);
// the copy to a fresh .node path is unconditional so a stale binary
// can never pass for a broken build.
const ARTIFACT = {
  linux: 'libauqw_node_bindings.so',
  darwin: 'libauqw_node_bindings.dylib',
  win32: 'auqw_node_bindings.dll',
}[process.platform];
const NODE = join(tmpdir(), `auqw_node_bindings-${process.pid}-${Date.now()}.node`);
copyFileSync(`target/debug/${ARTIFACT}`, NODE);
// A loaded native module stays open (and locked on Windows), so the
// cleanup is best-effort — /tmp churn is bounded by pid+timestamp
// uniqueness, not by this line.
process.on('exit', () => {
  try {
    rmSync(NODE, { force: true });
  } catch {}
});
// ESM takes a specifier, not a path: on Windows a bare absolute path
// parses as the `c:` URL scheme, so the import must go through a
// file:// URL.
const host_ = await import(pathToFileURL(NODE).href);
const bindings = host_.default ?? host_;

const wasm = readFileSync('sdk/conformance/echo/echo.wasm');
const digest = `sha256:${createHash('sha256').update(wasm).digest('hex')}`;
const manifest = JSON.stringify({
  id: 'echo',
  version: '0.1.0',
  abi: '0.1.0',
  capabilities: ['playback.resolve'],
  permissions: [],
  artifact: { path: 'echo.wasm', digest },
});

const host = new bindings.PluginHost({ fuelPerEntry: 200e6, fuelTotal: 2e9 });

// Every rejection carries a machine-readable `cause`: a nested Error
// whose message is JSON `{"code": slug, ...fields}` — napi's fixed
// Status set can't express the taxonomy, so the slug rides the cause.
const codeOf = (err) => JSON.parse(err.cause?.message ?? '{}').code;

assert.equal(host.mintRequestId(), 'req-0');
assert.equal(host.mintRequestId(), 'req-1');

const id = host.loadPlugin(wasm, manifest);
assert.equal(id, 'echo');

// The echo guest returns the invoke message — no url → the promise
// resolves to a typed Failed outcome, never a rejected promise.
const rid = host.mintRequestId();
const outcome = await host.startResolve(id, 'vid12345678', rid);
assert.equal(outcome.type, 'failed');
assert.equal(outcome.kind, 'invalid-response');
assert.equal(outcome.attempt.requestId, rid);

// Synchronous rejections still throw with a machine-readable code:
// unknown plugin, seam absent, invalid arguments.
await assert.rejects(host.startResolve('nope', 'x', host.mintRequestId()), (err) => {
  assert.equal(codeOf(err), 'unknown-plugin');
  return true;
});
assert.throws(() => host.streamOpen('st-0', 0), (err) => {
  assert.equal(codeOf(err), 'unavailable');
  return true;
});
await assert.rejects(host.streamRead('st-0', 0, 64), (err) => {
  assert.equal(codeOf(err), 'unavailable');
  return true;
});

// Boundary validation: a negative read length must reject as
// `invalid-argument` (err.code = InvalidArg), never masquerade as EOF.
await assert.rejects(host.streamRead('st-0', 0, -1), (err) => {
  assert.equal(codeOf(err), 'invalid-argument');
  assert.equal(err.code, 'InvalidArg');
  return true;
});
assert.throws(() => host.streamOpen('st-0', Number.NaN), (err) => {
  assert.equal(codeOf(err), 'invalid-argument');
  return true;
});

// Invalid budgets fail construction — a zero or NaN fuel grant would
// silently starve every guest entry as budget-exceeded.
assert.throws(() => new bindings.PluginHost({ fuelPerEntry: Number.NaN, fuelTotal: 2e9 }), (err) => {
  assert.equal(codeOf(err), 'invalid-argument');
  return true;
});

// An id is reusable immediately once its request has settled — the
// surface releases admission state before the outcome promise resolves,
// so the very next call on the same plugin cannot lose a stale
// `request-in-flight` race.
const reuse = await host.startResolve(id, 'vid12345678', rid);
assert.equal(reuse.type, 'failed');
assert.equal(reuse.kind, 'invalid-response');
assert.equal(reuse.attempt.requestId, rid);

// A second in-flight call with the same id is rejected with the
// typed in-flight error (caller-minted ids must be unique while live).
const spin = readFileSync('sdk/conformance/spin/spin.wasm');
const spinDigest = `sha256:${createHash('sha256').update(spin).digest('hex')}`;
const spinManifest = JSON.stringify({
  id: 'spin',
  version: '0.1.0',
  abi: '0.1.0',
  capabilities: ['playback.resolve'],
  permissions: [],
  artifact: { path: 'spin.wasm', digest: spinDigest },
});
host.loadPlugin(spin, spinManifest);
const dupRid = host.mintRequestId();
const first = host.startResolve('spin', 'x', dupRid);
const second = host.startResolve('spin', 'x', dupRid);
host.cancel(dupRid);
// Registration order across the async worker queue isn't call-ordered:
// either call may win the id. The contract — exactly one call settles
// an outcome, the other is rejected `request-in-flight`.
const results = await Promise.allSettled([first, second]);
const rejections = results.filter((r) => r.status === 'rejected');
assert.equal(rejections.length, 1, 'exactly one duplicate loses');
assert.equal(codeOf(rejections[0].reason), 'request-in-flight');

// The streaming seam: a host with streamPath exercises the session
// lifecycle end-to-end. The dev URL is unroutable loopback — head
// fill fails transiently but the boundary calls themselves are the
// real path (attach, marks, close, release).
const streamHost = new bindings.PluginHost({
  fuelPerEntry: 200e6,
  fuelTotal: 2e9,
  streamPath: mkdtempSync(join(tmpdir(), 'auqw-stream-')),
});
const stream = streamHost.devPrepareUrl('http://127.0.0.1:1/dead.mp4', 'audio/mp4', 1024, false);
assert.equal(stream.mime, 'audio/mp4');
assert.match(stream.handle, /^st-/);
assert.equal(stream.contentLength, 1024);

// Attach at 0 returns the hint length (wire total never lands).
assert.equal(streamHost.streamOpen(stream.handle, 0), 1024);
const marks = streamHost.streamPhaseMarks(stream.handle);
assert.ok(marks.prepareStartedMs > 0);
assert.ok(marks.attachMs > 0);

streamHost.streamClose(stream.handle);
streamHost.streamRelease(stream.handle);
// A released handle answers every seam call with a typed rejection.
await assert.rejects(streamHost.streamRead(stream.handle, 0, 64), (err) => {
  assert.ok(codeOf(err), 'expected a machine-readable rejection code');
  return true;
});
assert.throws(() => streamHost.streamOpen(stream.handle, 0), (err) => {
  assert.ok(codeOf(err), 'expected a machine-readable rejection code');
  return true;
});

console.log('node-bindings smoke: OK');
