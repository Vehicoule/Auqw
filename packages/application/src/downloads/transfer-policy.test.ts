import { CancellationSource } from '../cancellation.ts';
import type { CancellationSignal } from '../cancellation.ts';
import { appError, err, ok } from '../errors.ts';
import type { Result } from '../errors.ts';
import type { PlayableResource } from '../ports/provider.ts';
import { FakeClock, FakeTransfer } from '../testing/fakes.ts';
import { assert, assertDeepEqual, assertEqual } from '../testing/assert.ts';
import { createSha256 } from './sha256.ts';
import type { ChunkHasher, RangeFetchResponse, TransferOutcome } from './transfer-policy.ts';
import { runTransfer } from './transfer-policy.ts';

type WireRequest = {
  readonly url: string;
  readonly start: number;
  readonly end: number;
};

type WireBehavior =
  | { kind: 'serve' }
  | { kind: 'status'; status: number; contentRange?: string | null; body?: Uint8Array }
  | { kind: 'stall' };

/**
 * Scripted wire: every fetch sends a Range header; the default serve
 * returns a correct 206 window. `script(n)` overrides request n.
 */
class Wire {
  readonly files = new Map<string, Uint8Array>();
  readonly requests: WireRequest[] = [];
  #scripts: (WireBehavior | null)[] = [];

  serve(url: string, body: Uint8Array): void {
    this.files.set(url, body);
  }

  script(requestIndex: number, behavior: WireBehavior): void {
    this.#scripts[requestIndex] = behavior;
  }

  fetch = (
    url: string,
    init: { headers: Record<string, string> },
    signal: CancellationSignal,
  ): Promise<RangeFetchResponse> => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range ?? '');
    if (m === null) {
      throw new Error('wire received a request without a Range header');
    }
    const start = Number(m[1]);
    const end = Number(m[2]);
    const req: WireRequest = { url, start, end };
    const behavior = this.#scripts[this.requests.length] ?? { kind: 'serve' };
    this.requests.push(req);
    if (signal.cancelled) {
      // The adapter would see the abort edge; report as never-landing.
      return new Promise<RangeFetchResponse>(() => {});
    }
    switch (behavior.kind) {
      case 'stall':
        return new Promise<RangeFetchResponse>(() => {});
      case 'status':
        return Promise.resolve(
          makeResponse(
            behavior.status,
            behavior.body ?? new Uint8Array(0),
            behavior.contentRange ?? null,
          ),
        );
      case 'serve': {
        const file = this.files.get(url);
        if (file === undefined) {
          return Promise.resolve(makeResponse(404, new Uint8Array(0), null));
        }
        const bytes = file.subarray(start, end + 1);
        return Promise.resolve(
          makeResponse(206, bytes, `bytes ${start}-${end}/${file.length}`),
        );
      }
    }
  };
}

function makeResponse(
  status: number,
  body: Uint8Array,
  contentRange: string | null,
): RangeFetchResponse {
  return {
    status,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'content-range' ? contentRange : null,
    },
    arrayBuffer: (): Promise<ArrayBuffer> => {
      const copy = new Uint8Array(body.length);
      copy.set(body);
      return Promise.resolve(copy.buffer);
    },
  };
}

function resource(
  url: string,
  contentLength: number | null,
  overrides: Partial<PlayableResource> = {},
): PlayableResource {
  return {
    url,
    mime: 'audio/mp4',
    bitrateKbps: 128,
    expiresAtMs: null,
    contentLength,
    client: 'test',
    itag: 140,
    ...overrides,
  };
}

function remintServes(
  next: PlayableResource,
): (
  resumeOffset: number,
  itag: number | null,
) => Promise<Result<PlayableResource>> {
  return () => Promise.resolve(ok(next));
}

function bytes(n: number, fill = 0x61): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

function source(): CancellationSource {
  return new CancellationSource();
}

async function sha256Vectors(): Promise<void> {
  const h = createSha256();
  h.update(new Uint8Array());
  assertEqual(
    h.digest(),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'empty digest',
  );
  const h2 = createSha256();
  const abc = new Uint8Array([0x61, 0x62, 0x63]);
  h2.update(abc);
  assertEqual(
    h2.digest(),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'abc digest',
  );
  // Incremental update == one-shot digest; digest is a non-destructive peek.
  const h3 = createSha256();
  h3.update(new Uint8Array([0x61]));
  const peek = h3.digest();
  h3.update(new Uint8Array([0x62, 0x63]));
  assertEqual(h3.digest(), h2.digest(), 'incremental digest');
  assert(
    peek !== h3.digest() && peek.length === 64,
    'peek returns the prefix digest and does not consume state',
  );
  // Long input crossing the 64-byte block boundary.
  const h4 = createSha256();
  const long = bytes(200, 0x62);
  h4.update(long.subarray(0, 100));
  h4.update(long.subarray(100));
  const h5 = createSha256();
  h5.update(long);
  assertEqual(h4.digest(), h5.digest(), 'split-update digest');
}

async function happyPath(): Promise<void> {
  const wire = new Wire();
  const file = bytes(10);
  wire.serve('https://cdn/x', file);
  const transfer = new FakeTransfer();
  transfer.enqueueSink({ digest: 'aa'.repeat(32) });
  const clock = new FakeClock();
  const src = source();
  const progress: { committed: number; total: number | null }[] = [];
  const result = await runTransfer({
    destName: 'track.mp4',
    first: resource('https://cdn/x', 10),
    remint: remintServes(resource('https://cdn/y', 10)),
    transfer,
    fetchImpl: wire.fetch,
    clock,
    signal: src.signal,
    hasher: createSha256,
    onProgress: (p) => progress.push({ ...p }),
    chunkSize: 4,
  });
  assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  assertDeepEqual(
    wire.requests.map((r) => [r.start, r.end]),
    [
      [0, 3],
      [4, 7],
      [8, 9],
    ],
    'range plan',
  );
  const outcome = (result as Result<TransferOutcome> & { ok: true }).value;
  assertEqual(outcome.bytes, 10, 'bytes');
  assertEqual(outcome.checksum, 'aa'.repeat(32), 'checksum is the adapter digest');
  assertEqual(outcome.mime, 'audio/mp4');
  assertEqual(outcome.itag, 140);
  assertEqual(outcome.contentLength, 10);
  assertDeepEqual(
    progress.map((p) => p.committed),
    [4, 8, 10],
    'progress offsets',
  );
  // The policy digest covers the whole file → finalize got it.
  const realSha = createSha256();
  realSha.update(file);
  assertEqual(
    transfer.sinks[0]?.finalizedWith,
    realSha.digest(),
    'finalize expected the policy sha-256',
  );
}

async function resumeOffset(): Promise<void> {
  const wire = new Wire();
  const file = bytes(10);
  wire.serve('https://cdn/x', file);
  const transfer = new FakeTransfer();
  transfer.enqueueSink({ digest: 'bb'.repeat(32) });
  const result = await runTransfer({
    destName: 'track.mp4',
    first: resource('https://cdn/x', 10),
    remint: remintServes(resource('https://cdn/x', 10)),
    transfer,
    fetchImpl: wire.fetch,
    clock: new FakeClock(),
    signal: source().signal,
    resumeAtBytes: 4,
    hasher: createSha256,
    chunkSize: 4,
  });
  assert(result.ok, 'resume ok');
  assertEqual(transfer.beginCalls[0]?.resumeAtBytes, 4, 'resumed sink');
  assertDeepEqual(
    wire.requests.map((r) => [r.start, r.end]),
    [
      [4, 7],
      [8, 9],
    ],
    'ranges continue at the resume offset',
  );
  // The incremental hasher cannot cover a prefix it never saw →
  // finalize receives null and computes the digest itself.
  assertEqual(
    transfer.sinks[0]?.finalizedWith,
    null,
    'resumed transfer passes null digest',
  );
  assertEqual(result.value.bytes, 10);
}

async function remintResumeOn403(): Promise<void> {
  const wire = new Wire();
  wire.serve('https://cdn/a', bytes(8));
  wire.serve('https://cdn/b', bytes(8));
  // Request 1 (a fresh mint after the first chunk) 403s once.
  wire.script(1, { kind: 'status', status: 403 });
  const transfer = new FakeTransfer();
  transfer.enqueueSink({ digest: 'cc'.repeat(32) });
  const remintCalls: { offset: number; itag: number | null }[] = [];
  const result = await runTransfer({
    destName: 'track.mp4',
    first: resource('https://cdn/a', 8),
    remint: (resumeOffset, itag) => {
      remintCalls.push({ offset: resumeOffset, itag });
      return Promise.resolve(ok(resource('https://cdn/b', 8)));
    },
    transfer,
    fetchImpl: wire.fetch,
    clock: new FakeClock(),
    signal: source().signal,
    hasher: createSha256,
    chunkSize: 4,
  });
  assert(result.ok, `remint-resume ok, got ${JSON.stringify(result)}`);
  assertDeepEqual(
    remintCalls,
    [{ offset: 4, itag: 140 }],
    'remint got the durable offset and itag pin',
  );
  assertEqual(transfer.sinks.length, 1, 'same encoding keeps the sink');
  assertDeepEqual(
    wire.requests.map((r) => [r.url, r.start, r.end]),
    [
      ['https://cdn/a', 0, 3],
      ['https://cdn/a', 4, 7],
      ['https://cdn/b', 4, 7],
    ],
    'resumed on the fresh url',
  );
}

async function remint416Too(): Promise<void> {
  const wire = new Wire();
  wire.serve('https://cdn/a', bytes(4));
  wire.serve('https://cdn/b', bytes(4));
  wire.script(1, { kind: 'status', status: 416 });
  const transfer = new FakeTransfer();
  transfer.enqueueSink({ digest: 'dd'.repeat(32) });
  const result = await runTransfer({
    destName: 't.mp4',
    first: resource('https://cdn/a', 4),
    remint: remintServes(resource('https://cdn/b', 4)),
    transfer,
    fetchImpl: wire.fetch,
    clock: new FakeClock(),
    signal: source().signal,
    hasher: createSha256,
    chunkSize: 4,
  });
  assert(result.ok, '416 remint ok');
  assertEqual(result.value.checksum, 'dd'.repeat(32));
}

async function encodingChangeRestarts(): Promise<void> {
  const wire = new Wire();
  wire.serve('https://cdn/a', bytes(8));
  wire.serve('https://cdn/c', bytes(4));
  wire.script(1, { kind: 'status', status: 403 });
  const transfer = new FakeTransfer();
  transfer.enqueueSink({}); // first sink holds the old prefix
  transfer.enqueueSink({ digest: 'ee'.repeat(32) }); // restart sink
  const result = await runTransfer({
    destName: 't.mp4',
    first: resource('https://cdn/a', 8),
    // Encoding triple changed → bytes from the old file can't splice.
    remint: remintServes(
      resource('https://cdn/c', 4, { bitrateKbps: 256 }),
    ),
    transfer,
    fetchImpl: wire.fetch,
    clock: new FakeClock(),
    signal: source().signal,
    hasher: createSha256,
    chunkSize: 4,
  });
  assert(result.ok, 'encoding restart ok');
  assertEqual(transfer.sinks.length, 2, 'new sink after restart');
  assertEqual(
    transfer.sinks[0]?.abortedKeep,
    false,
    'old prefix dropped',
  );
  assertDeepEqual(
    wire.requests.map((r) => [r.url, r.start, r.end]),
    [
      ['https://cdn/a', 0, 3],
      ['https://cdn/a', 4, 7],
      ['https://cdn/c', 0, 3],
    ],
    'restarted at 0 on the new encoding',
  );
  assertEqual(result.value.bytes, 4);
}

async function zeroProgressExpires(): Promise<void> {
  const wire = new Wire();
  wire.script(0, { kind: 'status', status: 403 });
  wire.script(1, { kind: 'status', status: 403 });
  const transfer = new FakeTransfer();
  transfer.enqueueSink({});
  const result = await runTransfer({
    destName: 't.mp4',
    first: resource('https://cdn/a', 8),
    remint: remintServes(resource('https://cdn/b', 8)),
    transfer,
    fetchImpl: wire.fetch,
    clock: new FakeClock(),
    signal: source().signal,
    hasher: createSha256,
    chunkSize: 4,
  });
  assert(!result.ok, 'zero-progress must fail');
  assertEqual(result.error.kind, 'expired-resource');
  // .part kept — resume-capable.
  assertEqual(transfer.sinks[0]?.abortedKeep, true);
}

async function mintBudgetExpires(): Promise<void> {
  const wire = new Wire();
  // Each mint serves one good chunk then a 403 → progress resets the
  // zero-progress counter, so only the mint budget can stop it.
  wire.serve('https://cdn/a', bytes(100));
  const transfer = new FakeTransfer();
  transfer.enqueueSink({});
  let mints = 0;
  const urls = ['https://cdn/a'];
  for (let i = 0; i < 20; i += 1) {
    urls.push(`https://cdn/m${i}`);
    wire.serve(`https://cdn/m${i}`, bytes(100));
    // script index: request 0 good; pattern good,403 per mint.
    wire.script(2 * i + 1, { kind: 'status', status: 403 });
  }
  const result = await runTransfer({
    destName: 't.mp4',
    first: resource('https://cdn/a', 100),
    remint: () => {
      const url = urls[mints + 1] ?? 'https://cdn/z';
      mints += 1;
      return Promise.resolve(ok(resource(url, 100)));
    },
    transfer,
    fetchImpl: wire.fetch,
    clock: new FakeClock(),
    signal: source().signal,
    hasher: createSha256,
    chunkSize: 4,
    mintBudget: 3,
  });
  assert(!result.ok, 'mint budget must fail');
  assertEqual(result.error.kind, 'expired-resource');
  assertEqual(mints, 3, 'stopped at the mint budget');
}

async function statusViolations(): Promise<void> {
  const cases: { name: string; status: number; contentRange?: string | null; body?: Uint8Array }[] = [
    { name: 'whole-file 200', status: 200, body: bytes(100) },
    { name: '404', status: 404 },
    { name: '500', status: 500 },
  ];
  for (const c of cases) {
    const wire = new Wire();
    wire.serve('https://cdn/x', bytes(4));
    wire.script(0, {
      kind: 'status',
      status: c.status,
      ...(c.body === undefined ? {} : { body: c.body }),
      contentRange: c.contentRange ?? null,
    });
    const transfer = new FakeTransfer();
    transfer.enqueueSink({});
    const result = await runTransfer({
      destName: 't.mp4',
      first: resource('https://cdn/x', 4),
      remint: remintServes(resource('https://cdn/x', 4)),
      transfer,
      fetchImpl: wire.fetch,
      clock: new FakeClock(),
      signal: source().signal,
      hasher: createSha256,
    });
    assert(!result.ok, `${c.name} must fail`);
    assertEqual(result.error.kind, 'invalid-response', c.name);
  }
}

async function contentRangeViolations(): Promise<void> {
  const mk = (
    contentRange: string | null,
    label: string,
  ): Promise<void> => {
    return (async () => {
      const wire = new Wire();
      wire.serve('https://cdn/x', bytes(10));
      wire.script(0, {
        kind: 'status',
        status: 206,
        body: bytes(4),
        contentRange,
      });
      const transfer = new FakeTransfer();
      transfer.enqueueSink({});
      const result = await runTransfer({
        destName: 't.mp4',
        first: resource('https://cdn/x', 10),
        remint: remintServes(resource('https://cdn/x', 10)),
        transfer,
        fetchImpl: wire.fetch,
        clock: new FakeClock(),
        signal: source().signal,
        hasher: createSha256,
        chunkSize: 4,
      });
      assert(!result.ok, `${label} must fail`);
      assertEqual(result.error.kind, 'invalid-response', label);
    })();
  };
  await mk('bytes 1-4/10', 'wrong start');
  await mk('bytes 0-4/0', 'zero total');
  await mk('garbage', 'unparseable');
  await mk(null, 'missing header');
  // Total changes mid-stream.
  const wire = new Wire();
  wire.serve('https://cdn/x', bytes(10));
  wire.script(1, {
    kind: 'status',
    status: 206,
    body: bytes(4),
    contentRange: 'bytes 4-7/20',
  });
  const transfer = new FakeTransfer();
  transfer.enqueueSink({});
  const result = await runTransfer({
    destName: 't.mp4',
    first: resource('https://cdn/x', 10),
    remint: remintServes(resource('https://cdn/x', 10)),
    transfer,
    fetchImpl: wire.fetch,
    clock: new FakeClock(),
    signal: source().signal,
    hasher: createSha256,
    chunkSize: 4,
  });
  assert(!result.ok, 'mid-stream total change must fail');
  assertEqual(result.error.kind, 'invalid-response');
}

async function bodyViolations(): Promise<void> {
  // Empty 206 body.
  {
    const wire = new Wire();
    wire.serve('https://cdn/x', bytes(10));
    wire.script(0, {
      kind: 'status',
      status: 206,
      body: new Uint8Array(0),
      contentRange: 'bytes 0-3/10',
    });
    const transfer = new FakeTransfer();
    transfer.enqueueSink({});
    const result = await runTransfer({
      destName: 't.mp4',
      first: resource('https://cdn/x', 10),
      remint: remintServes(resource('https://cdn/x', 10)),
      transfer,
      fetchImpl: wire.fetch,
      clock: new FakeClock(),
      signal: source().signal,
      hasher: createSha256,
      chunkSize: 4,
    });
    assert(!result.ok, 'empty body must fail');
    assertEqual(result.error.kind, 'invalid-response');
  }
  // Oversized body.
  {
    const wire = new Wire();
    wire.serve('https://cdn/x', bytes(10));
    wire.script(0, {
      kind: 'status',
      status: 206,
      body: bytes(6),
      contentRange: 'bytes 0-3/10',
    });
    const transfer = new FakeTransfer();
    transfer.enqueueSink({});
    const result = await runTransfer({
      destName: 't.mp4',
      first: resource('https://cdn/x', 10),
      remint: remintServes(resource('https://cdn/x', 10)),
      transfer,
      fetchImpl: wire.fetch,
      clock: new FakeClock(),
      signal: source().signal,
      hasher: createSha256,
      chunkSize: 4,
    });
    assert(!result.ok, 'oversized body must fail');
    assertEqual(result.error.kind, 'invalid-response');
  }
}

async function nonHttps(): Promise<void> {
  const wire = new Wire();
  const transfer = new FakeTransfer();
  transfer.enqueueSink({});
  const result = await runTransfer({
    destName: 't.mp4',
    first: resource('http://cdn/x', 4),
    remint: remintServes(resource('https://cdn/x', 4)),
    transfer,
    fetchImpl: wire.fetch,
    clock: new FakeClock(),
    signal: source().signal,
    hasher: createSha256,
  });
  assert(!result.ok, 'http url must fail');
  assertEqual(result.error.kind, 'invalid-response');
  assertEqual(wire.requests.length, 0, 'no request was made');
}

async function stallTimeout(): Promise<void> {
  const wire = new Wire();
  wire.serve('https://cdn/x', bytes(4));
  wire.script(0, { kind: 'stall' });
  const transfer = new FakeTransfer();
  transfer.enqueueSink({});
  const clock = new FakeClock();
  const p = runTransfer({
    destName: 't.mp4',
    first: resource('https://cdn/x', 4),
    remint: remintServes(resource('https://cdn/x', 4)),
    transfer,
    fetchImpl: wire.fetch,
    clock,
    signal: source().signal,
    hasher: createSha256,
    chunkTimeoutMs: 1_000,
  });
  // Spin microtasks until the sleeper registers, then fire the clock.
  for (let i = 0; i < 200 && clock.pendingSleepers === 0; i += 1) {
    await Promise.resolve();
  }
  clock.advance(1_000);
  const result = await p;
  assert(!result.ok, 'stalled chunk must fail');
  assertEqual(result.error.kind, 'transient');
}

async function midTransferCancel(): Promise<void> {
  const wire = new Wire();
  wire.serve('https://cdn/x', bytes(10));
  const src = source();
  const cancelOnSecond = wire.fetch;
  let calls = 0;
  wire.fetch = (url, init, signal) => {
    calls += 1;
    if (calls === 2) {
      src.cancel();
    }
    return cancelOnSecond(url, init, signal);
  };
  const transfer = new FakeTransfer();
  transfer.enqueueSink({});
  const result = await runTransfer({
    destName: 't.mp4',
    first: resource('https://cdn/x', 10),
    remint: remintServes(resource('https://cdn/x', 10)),
    transfer,
    fetchImpl: wire.fetch,
    clock: new FakeClock(),
    signal: src.signal,
    hasher: createSha256,
    chunkSize: 4,
  });
  assert(!result.ok, 'cancel must fail');
  assertEqual(result.error.kind, 'cancelled');
  assertEqual(transfer.sinks[0]?.abortedKeep, true, '.part kept');
}

async function preCancelled(): Promise<void> {
  const wire = new Wire();
  wire.serve('https://cdn/x', bytes(4));
  const src = source();
  src.cancel();
  const transfer = new FakeTransfer();
  const result = await runTransfer({
    destName: 't.mp4',
    first: resource('https://cdn/x', 4),
    remint: remintServes(resource('https://cdn/x', 4)),
    transfer,
    fetchImpl: wire.fetch,
    clock: new FakeClock(),
    signal: src.signal,
    hasher: createSha256,
  });
  assert(!result.ok, 'pre-cancelled must fail');
  assertEqual(result.error.kind, 'cancelled');
  assertEqual(wire.requests.length, 0, 'no request fired');
}

async function sinkFailures(): Promise<void> {
  // begin fails.
  {
    const transfer = new FakeTransfer();
    transfer.failNextBegin(appError('storage-full', 'disk full'));
    // 'storage-full' is a typed terminal failure, not retryable.
    const result = await runTransfer({
      destName: 't.mp4',
      first: resource('https://cdn/x', 4),
      remint: remintServes(resource('https://cdn/x', 4)),
      transfer,
      fetchImpl: new Wire().fetch,
      clock: new FakeClock(),
      signal: source().signal,
      hasher: createSha256,
    });
    assert(!result.ok, 'begin failure must surface');
    assertEqual(result.error.kind, 'storage-full');
  }
  // write fails after the first chunk.
  {
    const wire = new Wire();
    wire.serve('https://cdn/x', bytes(8));
    const transfer = new FakeTransfer();
    transfer.enqueueSink({ failWritesAfter: 1 });
    const result = await runTransfer({
      destName: 't.mp4',
      first: resource('https://cdn/x', 8),
      remint: remintServes(resource('https://cdn/x', 8)),
      transfer,
      fetchImpl: wire.fetch,
      clock: new FakeClock(),
      signal: source().signal,
      hasher: createSha256,
      chunkSize: 4,
    });
    assert(!result.ok, 'write failure must surface');
    assertEqual(transfer.sinks[0]?.abortedKeep, true);
  }
  // finalize fails.
  {
    const wire = new Wire();
    wire.serve('https://cdn/x', bytes(4));
    const transfer = new FakeTransfer();
    transfer.enqueueSink({
      finalizeError: appError('invalid-response', 'checksum mismatch'),
    });
    const result = await runTransfer({
      destName: 't.mp4',
      first: resource('https://cdn/x', 4),
      remint: remintServes(resource('https://cdn/x', 4)),
      transfer,
      fetchImpl: wire.fetch,
      clock: new FakeClock(),
      signal: source().signal,
      hasher: createSha256,
    });
    assert(!result.ok, 'finalize failure must surface');
    assertEqual(result.error.kind, 'invalid-response');
  }
  // remint fails typed.
  {
    const wire = new Wire();
    wire.script(0, { kind: 'status', status: 403 });
    const transfer = new FakeTransfer();
    transfer.enqueueSink({});
    const result = await runTransfer({
      destName: 't.mp4',
      first: resource('https://cdn/a', 4),
      remint: () =>
        Promise.resolve(err(appError('unavailable', 'gone'))),
      transfer,
      fetchImpl: wire.fetch,
      clock: new FakeClock(),
      signal: source().signal,
      hasher: createSha256,
    });
    assert(!result.ok, 'remint failure must surface');
    assertEqual(result.error.kind, 'unavailable');
  }
}

async function totalUnknown(): Promise<void> {
  // contentLength null → the first Content-Range total sets it.
  const wire = new Wire();
  wire.serve('https://cdn/x', bytes(6));
  const transfer = new FakeTransfer();
  transfer.enqueueSink({ digest: 'ff'.repeat(32) });
  const progress: (number | null)[] = [];
  const result = await runTransfer({
    destName: 't.mp4',
    first: resource('https://cdn/x', null),
    remint: remintServes(resource('https://cdn/x', 6)),
    transfer,
    fetchImpl: wire.fetch,
    clock: new FakeClock(),
    signal: source().signal,
    hasher: createSha256,
    chunkSize: 4,
    onProgress: (p) => progress.push(p.total),
  });
  assert(result.ok, 'unknown-total ok');
  assertEqual(result.value.contentLength, 6);
  assertDeepEqual(progress, [6, 6], 'total learned from the wire');
}

export async function run(): Promise<void> {
  await sha256Vectors();
  await happyPath();
  await resumeOffset();
  await remintResumeOn403();
  await remint416Too();
  await encodingChangeRestarts();
  await zeroProgressExpires();
  await mintBudgetExpires();
  await statusViolations();
  await contentRangeViolations();
  await bodyViolations();
  await nonHttps();
  await stallTimeout();
  await midTransferCancel();
  await preCancelled();
  await sinkFailures();
  await totalUnknown();
}
