import { assert, assertEqual } from '@auqw/application/testing';
import { CancellationSource } from '@auqw/application';
import type { OperationContext } from '@auqw/application';
import { shellError } from '../shared/errors.ts';
import type { StreamClient } from './web-player.ts';
import { createWebPeaksPort } from './web-peaks.ts';
import type { DecodedAudio } from './web-peaks.ts';
import { PEAKS_RESOLUTION } from '@auqw/ui-shared';
import type { WaveformPeak } from '@auqw/application';

type Call = { method: string; args: unknown };

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Scripted stream: `chunks` are served positionally, errors throw a
 * shell-typed rejection exactly like the IPC boundary does.
 */
function fakeStream(opts: {
  readonly remaining?: number | null;
  readonly chunks?: ReadonlyMap<number, Uint8Array>;
  readonly errors?: ReadonlyMap<number, unknown>;
  readonly probeChunks?: ReadonlyMap<number, Uint8Array>;
  readonly probeTotal?: number | null;
  /** Contiguous fake file the probe slices from — mirrors the seam's
   * positional serve semantics (bounded, eof at the end). */
  readonly probeFile?: Uint8Array;
}): StreamClient & { calls: Call[] } {
  const calls: Call[] = [];
  const record = (method: string, args: unknown) => {
    calls.push({ method, args });
  };
  return {
    calls,
    prepare: (args) => {
      record('prepare', args);
      return Promise.reject(new Error('unused'));
    },
    devPrepare: (args) => {
      record('devPrepare', args);
      return Promise.reject(new Error('unused'));
    },
    serveUrl: (args) => {
      record('serveUrl', args);
      return Promise.reject(new Error('unused'));
    },
    open: (args) => {
      record('open', args);
      return Promise.resolve({ remaining: opts.remaining ?? null });
    },
    read: (args) => {
      record('read', args);
      const failure = opts.errors?.get(args.position);
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      return Promise.resolve({
        data: toBase64(opts.chunks?.get(args.position) ?? new Uint8Array(0)),
      });
    },
    probe: (args) => {
      record('probe', args);
      const file = opts.probeFile;
      if (file !== undefined) {
        const slice = file.subarray(
          args.position,
          args.position + args.maxLen,
        );
        return Promise.resolve({
          data: toBase64(slice),
          total: opts.probeTotal ?? file.length,
          eof: args.position + args.maxLen >= file.length,
        });
      }
      // Default: an unfetched hole — the legacy path must still run.
      const chunk = opts.probeChunks?.get(args.position);
      return Promise.resolve({
        data: toBase64(chunk ?? new Uint8Array(0)),
        total: opts.probeTotal ?? null,
        eof: chunk === undefined,
      });
    },
    close: (args) => {
      record('close', args);
      return Promise.resolve(undefined);
    },
    release: (args) => {
      record('release', args);
      return Promise.resolve(undefined);
    },
    marks: (args) => {
      record('marks', args);
      return Promise.reject(new Error('unused'));
    },
    cancel: (args) => {
      record('cancel', args);
      return Promise.resolve(undefined);
    },
    channel: (args) => {
      record('channel', args);
      return Promise.reject(new Error('unused'));
    },
  };
}

function fakeDecode(channels: Float32Array[]): (bytes: Uint8Array) => Promise<DecodedAudio> {
  return () =>
    Promise.resolve({
      numberOfChannels: channels.length,
      length: channels[0]?.length ?? 0,
      sampleRate: 44100,
      getChannelData: (i: number) => channels[i] ?? new Float32Array(0),
    });
}

function context(signal?: CancellationSource): OperationContext {
  return {
    requestId: 'peaks-test',
    deadlineMs: Date.now() + 30_000,
    signal: signal?.signal ?? new CancellationSource().signal,
  };
}

/* ---- EBML fixture writer ------------------------------------------------- */

function concatAll(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** EBML id bytes: the id is already encoded big-endian, width = the
 * leading set bit's position. */
function elemId(id: number): Uint8Array {
  if (id > 0xffffff) {
    return new Uint8Array([
      (id >> 24) & 0xff,
      (id >> 16) & 0xff,
      (id >> 8) & 0xff,
      id & 0xff,
    ]);
  }
  if (id > 0xffff) {
    return new Uint8Array([(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]);
  }
  if (id > 0xff) {
    return new Uint8Array([(id >> 8) & 0xff, id & 0xff]);
  }
  return new Uint8Array([id & 0xff]);
}

/** EBML size vint — smallest width that doesn't collide with
 * 'unknown size' (all value bits 1). */
function vintSize(n: number): Uint8Array {
  for (let w = 1; w <= 8; w++) {
    if (n < Math.pow(2, 7 * w) - 1) {
      const out = new Uint8Array(w);
      let shift = 8 * (w - 1);
      out[0] = (0x80 >> (w - 1)) | ((n >> shift) & 0xff);
      for (let i = 1; i < w; i++) {
        shift -= 8;
        out[i] = (n >> shift) & 0xff;
      }
      return out;
    }
  }
  throw new Error('vint overflow');
}

function elem(id: number, ...payload: Uint8Array[]): Uint8Array {
  const body = concatAll(payload);
  return concatAll([elemId(id), vintSize(body.length), body]);
}

function uintBytes(n: number): Uint8Array {
  const out = new Uint8Array(Math.max(1, Math.ceil(Math.log2(n + 1) / 8)));
  let v = n;
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v >>= 8;
  }
  return out;
}

const EBML_ID = 0x1a45dfa3;
const WEBM_SEGMENT = 0x18538067;
const WEBM_INFO = 0x1549a966;
const WEBM_TIMECODE_SCALE = 0x2ad7b1;
const WEBM_CLUSTER = 0x1f43b675;
const WEBM_CLUSTER_TIMECODE = 0xe7;
const WEBM_CUES = 0x1c53bb6b;
const WEBM_CUE_POINT = 0xbb;
const WEBM_CUE_TIME = 0xb3;
const WEBM_CUE_TRACK_POSITIONS = 0xb7;
const WEBM_CUE_CLUSTER_POSITION = 0xf1;

/**
 * A structurally real webm: EBML head + Segment(Info scale 1ms,
 * clusters, optional Cues index). The cluster payload bytes are
 * filler — the fake decoder never inspects them.
 */
function fakeWebm(opts: {
  readonly clusters: readonly { tc: number; payload: number }[];
  readonly cues: boolean;
}): { file: Uint8Array; cueBytes: number[] } {
  const head = elem(EBML_ID, new Uint8Array([0x42, 0x86, 0x81, 0x01]));
  const segHead = concatAll([elemId(WEBM_SEGMENT)]);
  // Segment payload is assembled first so cue positions are absolute.
  const segDataStart =
    head.length + segHead.length + 2; // seg size vint reserve (2 bytes)
  const inner: Uint8Array[] = [
    elem(WEBM_INFO, elem(WEBM_TIMECODE_SCALE, uintBytes(1_000_000))), // ns → 1ms
  ];
  const clusterOffsets: number[] = [];
  const cueBytes: number[] = [];
  let cursor = segDataStart + inner[0]!.length;
  for (const { tc, payload } of opts.clusters) {
    const cluster = elem(
      WEBM_CLUSTER,
      elem(WEBM_CLUSTER_TIMECODE, uintBytes(tc)),
      new Uint8Array(payload).fill(0xab),
    );
    inner.push(cluster);
    clusterOffsets.push(cursor);
    cueBytes.push(cursor);
    cursor += cluster.length;
  }
  if (opts.cues) {
    const cuePoints = opts.clusters.map((c, i) =>
      elem(
        WEBM_CUE_POINT,
        elem(WEBM_CUE_TIME, uintBytes(c.tc)),
        elem(
          WEBM_CUE_TRACK_POSITIONS,
          elem(WEBM_CUE_CLUSTER_POSITION, uintBytes(clusterOffsets[i]! - segDataStart)),
        ),
      ),
    );
    inner.push(elem(WEBM_CUES, ...cuePoints));
  }
  const segBody = concatAll(inner);
  const segSize = vintSize(segBody.length);
  assertEqual(
    segSize.length,
    2,
    'fixture reserve matches the real segment size width',
  );
  const file = concatAll([head, segHead, segSize, segBody]);
  return { file, cueBytes };
}

export async function run(): Promise<void> {
  // Happy path: positional reads to EOF, decode to peaks.
  {
    const pcm = new Float32Array(512);
    pcm[400] = 1; // a hot bucket in the back half
    const chunks = new Map<number, Uint8Array>([
      [0, new Uint8Array(1024).fill(7)],
      [1024, new Uint8Array(64).fill(9)],
    ]);
    const stream = fakeStream({ chunks });
    const port = createWebPeaksPort({ stream, decode: fakeDecode([pcm]) });
    const result = await port.peaks(
      { handle: 'h-1', durationMs: 120_000 },
      context(),
    );
    assert(result.ok, 'extraction succeeds');
    assertEqual(
      result.value.length,
      PEAKS_RESOLUTION,
      'peaks arrive at the canonical resolution',
    );
    assert(
      (result.value[200]?.up ?? 0) === 1,
      'the decoded impulse owns its bucket',
    );
    const firstRead = stream.calls.find((c) => c.method === 'read');
    assertEqual(
      (firstRead?.args as { position: number }).position,
      0,
      'the legacy pull still starts at position 0',
    );
    const methods = stream.calls.map((c) => c.method);
    assert(
      methods.every(
        (m) => m !== 'open' && m !== 'close' && m !== 'release',
      ),
      'the borrowed handle is never opened, closed, or released',
    );
  }

  // An oversized stream bails at the byte cap.
  {
    const chunks = new Map<number, Uint8Array>([
      [0, new Uint8Array(700)],
      [700, new Uint8Array(700)],
      [1400, new Uint8Array(0)],
    ]);
    const stream = fakeStream({ chunks });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(8)]),
      maxBytes: 1024,
    });
    const result = await port.peaks(
      { handle: 'h-2', durationMs: 60_000 },
      context(),
    );
    assert(!result.ok && result.error.kind === 'budget-exceeded');
    assertEqual(
      stream.calls.filter((c) => c.method === 'read').length,
      2,
      'reads stop at the byte budget',
    );
  }

  // Unknown total: read until EOF; cap interrupts an over-long pull.
  {
    const chunks = new Map<number, Uint8Array>([
      [0, new Uint8Array(700)],
      [700, new Uint8Array(700)],
      [1400, new Uint8Array(0)],
    ]);
    const stream = fakeStream({ remaining: null, chunks });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(4)]),
      maxBytes: 1000,
    });
    const result = await port.peaks(
      { handle: 'h-3', durationMs: 60_000 },
      context(),
    );
    assert(!result.ok && result.error.kind === 'budget-exceeded');
  }

  // Unknown total with honest EOF: stops on the empty chunk.
  {
    const chunks = new Map<number, Uint8Array>([
      [0, new Uint8Array(64).fill(1)],
      [64, new Uint8Array(0)],
    ]);
    const stream = fakeStream({ remaining: null, chunks });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(16).fill(0.5)]),
    });
    const result = await port.peaks(
      { handle: 'h-4', durationMs: null },
      context(),
    );
    assert(result.ok, 'EOF terminates the pull');
    assertEqual(
      stream.calls.filter((c) => c.method === 'read').length,
      2,
      'reads stop at the empty chunk',
    );
    assert(
      (result.value[0]?.up ?? 0) === 1,
      'a constant PCM decodes to a flat full row',
    );
  }

  // A cancelled signal surfaces typed cancellation, not a hang.
  {
    const source = new CancellationSource();
    const stream = fakeStream({
      remaining: null,
      chunks: new Map([[0, new Uint8Array(64)]]),
    });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(4)]),
    });
    const pending = port.peaks(
      { handle: 'h-5', durationMs: null },
      context(source),
    );
    source.cancel();
    const result = await pending;
    assert(!result.ok && result.error.kind === 'cancelled');
  }

  // A read parked on an unfetched hole aborts rather than stealing
  // the element's demand priority — 'unavailable', placeholder stays.
  {
    const chunks = new Map<number, Uint8Array>([
      [0, new Uint8Array(64)],
    ]);
    const stream = fakeStream({ remaining: null, chunks });
    const reads: number[] = [];
    const slow = {
      ...stream,
      read: (args: { handle: string; position: number; maxLen: number }) => {
        reads.push(args.position);
        if (args.position === 0) {
          return Promise.resolve({ data: toBase64(chunks.get(0)!) });
        }
        // Position past the buffered prefix hangs — a hole.
        return new Promise<{ data: string }>(() => {});
      },
    };
    const port = createWebPeaksPort({
      stream: slow,
      decode: fakeDecode([new Float32Array(4)]),
      firstReadTimeoutMs: 5_000,
      parkTimeoutMs: 25,
    });
    const result = await port.peaks(
      { handle: 'h-park', durationMs: null },
      context(),
    );
    assert(!result.ok && result.error.kind === 'unavailable');
    assertEqual(
      reads.length,
      2,
      'extraction stops at the first hole instead of chasing it',
    );
  }

  // A dead handle surfaces `released`, not a raw throw.
  {
    const stream = fakeStream({
      errors: new Map([[0, shellError('released', 'gone')]]),
    });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(4)]),
    });
    const result = await port.peaks(
      { handle: 'h-6', durationMs: null },
      context(),
    );
    assert(!result.ok && result.error.kind === 'released');
  }

  // Decode failure maps to invalid-response — the placeholder stays.
  {
    const stream = fakeStream({
      chunks: new Map<number, Uint8Array>([
        [0, new Uint8Array(64)],
        [64, new Uint8Array(0)],
      ]),
    });
    const port = createWebPeaksPort({
      stream,
      decode: () => Promise.reject(new Error('not audio')),
    });
    const result = await port.peaks(
      { handle: 'h-7', durationMs: null },
      context(),
    );
    assert(!result.ok && result.error.kind === 'invalid-response');
  }

  // Exactly-cap streams still resolve: the loop reads once past the
  // cap to see EOF instead of bailing on a boundary total.
  {
    const chunks = new Map<number, Uint8Array>([
      [0, new Uint8Array(1024).fill(3)],
      [1024, new Uint8Array(0)],
    ]);
    const stream = fakeStream({ chunks });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(8).fill(0.5)]),
      maxBytes: 1024,
    });
    const result = await port.peaks(
      { handle: 'h-cap', durationMs: null },
      context(),
    );
    assert(result.ok, 'an exactly-capped stream still decodes');
  }

  // Unknown duration falls back to a conservative encoded-bytes cap —
  // a low-bitrate stream that size already decodes past the PCM gate.
  {
    const chunks = new Map<number, Uint8Array>([
      [0, new Uint8Array(64)],
      [64, new Uint8Array(64)],
      [128, new Uint8Array(64)],
      [192, new Uint8Array(0)],
    ]);
    const stream = fakeStream({ chunks });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(4)]),
      maxBytes: 1024,
      maxUnknownDurationBytes: 128,
    });
    const result = await port.peaks(
      { handle: 'h-9', durationMs: null },
      context(),
    );
    // 'not-applicable' marks the provisional bound — the tracker leaves
    // it uncached so a later durationMs gets a pull at the real cap.
    assert(!result.ok && result.error.kind === 'not-applicable');
    assertEqual(
      stream.calls.filter((c) => c.method === 'read').length,
      3,
      'unknown-duration pulls stop at the tighter cap',
    );
  }

  // A decode that produces more PCM than the frames bound — e.g. a
  // multichannel outlier — bails rather than bucketing a giant buffer.
  {
    const chunks = new Map<number, Uint8Array>([
      [0, new Uint8Array(64)],
      [64, new Uint8Array(0)],
    ]);
    const stream = fakeStream({ chunks });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(4096), new Float32Array(4096)]),
      maxPcmBytes: 1024,
    });
    const result = await port.peaks(
      { handle: 'h-10', durationMs: 60_000 },
      context(),
    );
    assert(!result.ok && result.error.kind === 'budget-exceeded');
  }

  // Over-long tracks skip the pull entirely — decoration only.
  {
    const stream = fakeStream({ remaining: null });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(4)]),
      maxDecodeMs: 60_000,
    });
    const result = await port.peaks(
      { handle: 'h-8', durationMs: 120_000 },
      context(),
    );
    assert(!result.ok && result.error.kind === 'budget-exceeded');
    assertEqual(stream.calls.length, 0, 'no stream calls past the gate');
  }

  // An `lf-*` handle reads through `local:read`, not the seam — the
  // resolved file:// URI keys the request and stream:read never runs.
  {
    const pcm = new Float32Array(256);
    pcm[10] = 1;
    const stream = fakeStream({});
    const fileBytes = new Uint8Array(128).fill(3);
    const reads: { uri: string; position: number }[] = [];
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([pcm]),
      localUriFor: (handle) =>
        handle === 'lf-1' ? 'file:///music/rip.flac' : null,
      localRead: (args) => {
        reads.push({ uri: args.uri, position: args.position });
        const slice = fileBytes.subarray(
          args.position,
          args.position + args.maxLen,
        );
        return Promise.resolve({ data: toBase64(slice) });
      },
    });
    const result = await port.peaks(
      { handle: 'lf-1', durationMs: 60_000 },
      context(),
    );
    assert(result.ok, 'local extraction succeeds');
    assert(
      stream.calls.length === 0,
      'a local handle never touches stream:read',
    );
    assert(
      reads.length >= 1 &&
        reads.every((r) => r.uri === 'file:///music/rip.flac'),
      'reads key to the resolved file:// URI',
    );
  }

  // ---- sampled extraction ------------------------------------------------
  // Container bytes here are structural fixtures — the decode is
  // faked, so clusters carry arbitrary payload; only the EBML skeleton
  // (boundaries, timecodes, the Cues index) must be real.

  // A cue-indexed webm extracts by bounded probes alone — no
  // sequential `read`, no whole-file pull — and emits a coarse profile
  // once the first sample batch lands.
  {
    const { file, cueBytes } = fakeWebm({
      clusters: [0, 5000, 10000, 15000, 20000, 25000].map((tc, i) => ({
        tc,
        payload: 40 + i,
      })),
      cues: true,
    });
    const stream = fakeStream({ probeFile: file });
    let decodeCalls = 0;
    const coarseEmits: (readonly WaveformPeak[])[] = [];
    const port = createWebPeaksPort({
      stream,
      decode: (bytes) => {
        decodeCalls += 1;
        return fakeDecode([new Float32Array([0.25, 0.5, 1, 0.5])])(
          bytes,
        );
      },
      sampledMinTotalBytes: 1,
      coarseProbes: 4,
      refineProbes: 2,
    });
    const result = await port.peaks(
      {
        handle: 'h-s1',
        durationMs: 30_000,
        onCoarse: (peaks) => {
          coarseEmits.push(peaks);
        },
      },
      context(),
    );
    assert(result.ok, 'sampled extraction succeeds');
    assertEqual(
      result.value.length,
      PEAKS_RESOLUTION,
      'the refined profile is canonical-resolution',
    );
    assert(
      stream.calls.every((c) => c.method !== 'read'),
      'sampled extraction spends no sequential reads',
    );
    assert(
      stream.calls.some(
        (c) =>
          c.method === 'probe' &&
          (c.args as { position: number }).position === 0,
      ),
      'the head probe anchors init + container discovery',
    );
    assert(
      cueBytes.every((b) =>
        stream.calls.some(
          (c) =>
            c.method === 'probe' &&
            (c.args as { position: number }).position === b,
        ),
      ),
      'every cue index becomes one bounded probe',
    );
    assert(
      decodeCalls >= 2,
      'the head seed plus at least one cluster sample decode',
    );
    assert(
      coarseEmits.length === 1 &&
        coarseEmits[0] !== undefined &&
        coarseEmits[0].length === PEAKS_RESOLUTION,
      'the coarse profile fires once, at canonical resolution',
    );
  }

  // A webm without Cues still samples: uniform probes resync to the
  // next cluster and place by its own Timecode element.
  {
    const { file } = fakeWebm({
      clusters: [0, 3000, 6000].map((tc) => ({ tc, payload: 512 })),
      cues: false,
    });
    const stream = fakeStream({ probeFile: file });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(64).fill(0.4)]),
      sampledMinTotalBytes: 1,
      coarseProbes: 3,
      refineProbes: 1,
    });
    const result = await port.peaks(
      { handle: 'h-s2', durationMs: 9000 },
      context(),
    );
    assert(result.ok, 'resync-based sampling still resolves');
    assert(
      stream.calls.every((c) => c.method !== 'read'),
      'no sequential pull behind the probes',
    );
  }

  // A non-webm head skips the sampler entirely — the legacy pull runs.
  {
    const file = new Uint8Array(64);
    file.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0); // ftyp box
    const stream = fakeStream({
      probeFile: file,
      chunks: new Map([
        [0, new Uint8Array(64).fill(1)],
        [64, new Uint8Array(0)],
      ]),
    });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(8).fill(0.2)]),
      sampledMinTotalBytes: 1,
    });
    const result = await port.peaks(
      { handle: 'h-s3', durationMs: 60_000 },
      context(),
    );
    assert(result.ok, 'mp4 falls back to the whole-file path');
    assert(
      stream.calls.some((c) => c.method === 'read'),
      'the sequential pull covers what the sampler cannot address',
    );
  }

  // A head-probe hole means the sampler has nothing to parse — the
  // legacy pull decides the outcome honestly.
  {
    const stream = fakeStream({
      chunks: new Map([
        [0, new Uint8Array(32).fill(2)],
        [32, new Uint8Array(0)],
      ]),
    });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(8).fill(0.6)]),
      sampledMinTotalBytes: 1,
    });
    const result = await port.peaks(
      { handle: 'h-s4', durationMs: 60_000 },
      context(),
    );
    assert(result.ok, 'the fallback pull finishes what probes cannot');
    assert(
      stream.calls.some((c) => c.method === 'read'),
      'hole-only probes defer to sequential reads',
    );
  }

  // Failed decodes never count toward the coarse threshold — an
  // all-zero "measured" profile would be fabricated bars.
  {
    const { file } = fakeWebm({
      clusters: [0, 5000, 10000, 15000].map((tc, i) => ({
        tc,
        payload: 64 + i,
      })),
      cues: true,
    });
    const stream = fakeStream({ probeFile: file });
    const coarseEmits: number[] = [];
    const port = createWebPeaksPort({
      stream,
      decode: () => Promise.reject(new Error('undecodable')),
      sampledMinTotalBytes: 1,
      coarseProbes: 4,
      refineProbes: 2,
    });
    const result = await port.peaks(
      {
        handle: 'h-s5',
        durationMs: 20_000,
        onCoarse: () => {
          coarseEmits.push(1);
        },
      },
      context(),
    );
    assert(!result.ok, 'a stream that cannot decode fails honestly');
    assertEqual(
      coarseEmits.length,
      0,
      'no coarse emission without a single measured sample',
    );
  }

  // An unknown-total webm with no Cues cannot address a single sample
  // position. A decoded head seed is head-only coverage — it feeds
  // the coarse emit, but it must never settle as the final profile:
  // the row is ~95% nearest-neighbor fill, and caching it as done
  // forecloses the honest whole-file pull.
  {
    const { file } = fakeWebm({
      clusters: [{ tc: 0, payload: 128 }],
      cues: false,
    });
    const stream = fakeStream({
      // The head probe lands the container; total stays unknown and
      // every other position is an unfetched hole.
      probeChunks: new Map([[0, file]]),
      chunks: new Map([
        [0, file],
        [file.length, new Uint8Array(0)],
      ]),
    });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(64).fill(0.4)]),
      sampledMinTotalBytes: 1,
      coarseProbes: 3,
      refineProbes: 1,
    });
    const result = await port.peaks(
      { handle: 'h-s6', durationMs: 4000 },
      context(),
    );
    assert(result.ok, 'the fallback pull still resolves a profile');
    assert(
      stream.calls.some((c) => c.method === 'read'),
      'a head-only seed never settles — the sequential pull runs',
    );
  }

  // Cue-addressed positions exist but every sample probe holes out:
  // the seeded head alone still cannot settle the request. Zero
  // applied samples falls back to the honest pull — never a
  // cloned-bucket row marked final.
  {
    const { file } = fakeWebm({
      clusters: [0, 5000, 10000].map((tc) => ({ tc, payload: 64 })),
      cues: true,
    });
    const stream = fakeStream({
      probeChunks: new Map([[0, file]]),
      chunks: new Map([
        [0, file],
        [file.length, new Uint8Array(0)],
      ]),
    });
    const port = createWebPeaksPort({
      stream,
      decode: fakeDecode([new Float32Array(64).fill(0.4)]),
      sampledMinTotalBytes: 1,
      coarseProbes: 3,
      refineProbes: 1,
    });
    const result = await port.peaks(
      { handle: 'h-s7', durationMs: 15_000 },
      context(),
    );
    assert(result.ok, 'the fallback pull covers what probes cannot');
    assert(
      stream.calls.some((c) => c.method === 'read'),
      'zero applied samples settle nothing — the pull runs',
    );
  }
}
