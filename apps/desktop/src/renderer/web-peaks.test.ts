import { assert, assertEqual } from '@auqw/application/testing';
import { CancellationSource } from '@auqw/application';
import type { OperationContext } from '@auqw/application';
import { shellError } from '../shared/errors.ts';
import type { StreamClient } from './web-player.ts';
import { createWebPeaksPort } from './web-peaks.ts';
import type { DecodedAudio } from './web-peaks.ts';
import { PEAKS_RESOLUTION } from '@auqw/ui-shared';

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
      (result.value[200] ?? 0) === 1,
      'the decoded impulse owns its bucket',
    );
    const firstRead = stream.calls[0];
    assertEqual(firstRead?.method, 'read', 'extraction reads first');
    assertEqual(
      (firstRead?.args as { position: number }).position,
      0,
      'extraction starts at position 0',
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
      { handle: 'h-2', durationMs: null },
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
      { handle: 'h-3', durationMs: null },
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
      (result.value[0] ?? 0) === 1,
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
  // the element's demand priority — 'unavailable', seeded stays.
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

  // Decode failure maps to invalid-response — the seeded pattern stays.
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
}
