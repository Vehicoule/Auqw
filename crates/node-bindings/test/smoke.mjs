// Smoke test for the napi boundary: constructs the host, loads the
// echo conformance guest, and asserts the promise-based outcome
// surface (typed rejections, tagged outcomes, id echo, id reuse).
//
//   cargo build -p auqw-node-bindings
//   cp target/debug/libauqw_node_bindings.so /tmp/auqw_node_bindings.node
//   node crates/node-bindings/test/smoke.mjs
//
// Run from the repo root. Uses the debug artifact — CI/release
// packaging is the desktop app's concern (slice 4 phase 1b).

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const SO = 'target/debug/libauqw_node_bindings.so';
const NODE = '/tmp/auqw_node_bindings.node';
if (!existsSync(NODE) || process.env.REBUILD === '1') {
  copyFileSync(SO, NODE);
}
const host_ = await import(NODE);
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

// Synchronous rejections still throw: unknown plugin, seam absent.
await assert.rejects(host.startResolve('nope', 'x', host.mintRequestId()), /unknown plugin nope/);
assert.throws(() => host.streamOpen('st-0', 0), /stream seam unavailable/);
await assert.rejects(host.streamRead('st-0', 0, 64), /stream seam unavailable/);

// An id is reusable once its request has settled.
await assert.rejects(host.startResolve('nope', 'x', rid), /unknown plugin nope/);

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
await assert.rejects(host.startResolve('spin', 'x', dupRid), /still in flight/);
host.cancel(dupRid);
await first;

console.log('node-bindings smoke: OK');
