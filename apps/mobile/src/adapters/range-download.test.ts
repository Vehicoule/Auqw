import { CancellationSource } from '@auqw/application';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import { DownloadFailure, downloadTo } from './range-download.ts';
import type {
  ByteSink,
  RangeFetch,
  RangeFetchResponse,
  StreamSource,
} from './range-download.ts';

/** One scripted server answer for a request at an offset. */
type Step =
  | { status: number; body: number[]; range?: string }
  | { hang: true }
  | { throwAbort: true };

function chunk(start: number, bytes: number[], total: number): Step {
  const end = start + bytes.length - 1;
  return { status: 206, body: bytes, range: `bytes ${start}-${end}/${total}` };
}

function sink(): { sink: ByteSink; data: number[]; resets: number } {
  const state = {
    sink: null as unknown as ByteSink,
    data: [] as number[],
    resets: 0,
  };
  state.sink = {
    reset() {
      state.data = [];
      state.resets += 1;
    },
    write(bytes: Uint8Array) {
      state.data.push(...bytes);
    },
  };
  return state;
}

function scriptedFetch(
  pages: Map<number, Step[]>,
  calls: { url: string; start: number }[],
): RangeFetch {
  return async (url, init) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers['Range'] ?? '');
    assert(m !== null, 'every request must carry a Range header');
    const start = Number(m[1]);
    calls.push({ url, start });
    const steps = pages.get(start);
    const step = steps?.shift();
    if (step === undefined) {
      return {
        status: 500,
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      };
    }
    if ('hang' in step) {
      await new Promise<void>((resolve) => {
        init.signal.addEventListener('abort', () => resolve());
      });
      throw new DOMException('aborted', 'AbortError');
    }
    if ('throwAbort' in step) {
      throw new DOMException('aborted', 'AbortError');
    }
    const resp: RangeFetchResponse = {
      status: step.status,
      headers: {
        get: (name) => (name === 'content-range' ? step.range ?? null : null),
      },
      arrayBuffer: () =>
        Promise.resolve(new Uint8Array(step.body).buffer as ArrayBuffer),
    };
    return resp;
  };
}

function source(url = 'https://gvs.example/v'): StreamSource {
  return { url, mime: 'audio/mp4', bitrateKbps: 128, contentLength: 8 };
}

type Options = Parameters<typeof downloadTo>[0];

function baseOptions(
  first: StreamSource,
  remint: () => Promise<StreamSource>,
  state: ReturnType<typeof sink>,
  calls: { url: string; start: number }[],
  pages: Map<number, Step[]>,
): Options {
  return {
    first,
    remint,
    openSink: () => state.sink,
    fetchImpl: scriptedFetch(pages, calls),
    signal: new CancellationSource().signal,
    readyAtBytes: 4,
    onReady: () => undefined,
    chunkSize: 4,
  };
}

async function expectFailure(
  work: () => Promise<unknown>,
  kind: string,
): Promise<void> {
  try {
    await work();
  } catch (thrown) {
    assert(
      thrown instanceof DownloadFailure,
      `expected DownloadFailure, got ${String(thrown)}`,
    );
    assertEqual(thrown.kind, kind);
    return;
  }
  throw new Error('expected the download to fail');
}

export async function run(): Promise<void> {
  // Happy path: two chunks land in order; onReady fires at threshold.
  {
    const pages = new Map<number, Step[]>([
      [0, [chunk(0, [1, 2, 3, 4], 8)]],
      [4, [chunk(4, [5, 6, 7, 8], 8)]],
    ]);
    const calls: { url: string; start: number }[] = [];
    const state = sink();
    let readyAt = -1;
    const opts = baseOptions(
      source(),
      () => Promise.reject(new Error('no remint')),
      state,
      calls,
      pages,
    );
    opts.onReady = (n) => {
      readyAt = n;
    };
    const written = await downloadTo(opts);
    assertEqual(written, 8);
    assertDeepEqual(state.data, [1, 2, 3, 4, 5, 6, 7, 8]);
    assertEqual(readyAt, 4);
  }

  // Small file below the ready threshold completes and fires onReady.
  {
    const pages = new Map<number, Step[]>([[0, [chunk(0, [1, 2, 3], 3)]]]);
    const calls: { url: string; start: number }[] = [];
    const state = sink();
    let fired = 0;
    const opts = baseOptions(
      { url: 'https://gvs.example/v', mime: 'audio/mp4', contentLength: 3 },
      () => Promise.reject(new Error('no remint')),
      state,
      calls,
      pages,
    );
    opts.readyAtBytes = 256;
    opts.onReady = () => {
      fired += 1;
    };
    const written = await downloadTo(opts);
    assertEqual(written, 3);
    assertEqual(fired, 1);
  }

  // 403 → same-encoding remint resumes at the written offset.
  {
    const pages = new Map<number, Step[]>([
      [0, [chunk(0, [1, 2, 3, 4], 8)]],
      [4, [{ status: 403, body: [] }, chunk(4, [5, 6, 7, 8], 8)]],
    ]);
    const calls: { url: string; start: number }[] = [];
    const state = sink();
    let mints = 0;
    const opts = baseOptions(
      source(),
      () => {
        mints += 1;
        return Promise.resolve(source('https://gvs.example/fresh'));
      },
      state,
      calls,
      pages,
    );
    const written = await downloadTo(opts);
    assertEqual(written, 8);
    assertEqual(mints, 1);
    assertDeepEqual(state.data, [1, 2, 3, 4, 5, 6, 7, 8]);
    // The resume request started at the written offset on the new URL.
    assertDeepEqual(calls[2], { url: 'https://gvs.example/fresh', start: 4 });
  }

  // 403 → different-encoding remint restarts on a fresh sink.
  {
    const pages = new Map<number, Step[]>([
      [0, [{ status: 403, body: [] }, chunk(0, [9, 9, 9, 9], 8)]],
      [4, [chunk(4, [8, 8, 8, 8], 8)]],
    ]);
    const calls: { url: string; start: number }[] = [];
    const state = sink();
    const opts = baseOptions(
      source(),
      () =>
        Promise.resolve({
          url: 'https://gvs.example/webm',
          mime: 'audio/webm',
          bitrateKbps: 96,
          contentLength: 8,
        }),
      state,
      calls,
      pages,
    );
    const written = await downloadTo(opts);
    assertEqual(written, 8);
    assert(state.resets >= 2, `expected a sink restart, got ${state.resets}`);
    assertDeepEqual(state.data, [9, 9, 9, 9, 8, 8, 8, 8]);
  }

  // Two consecutive zero-progress mints → expired-resource.
  {
    const pages = new Map<number, Step[]>([
      [0, [{ status: 403, body: [] }, { status: 403, body: [] }]],
    ]);
    const calls: { url: string; start: number }[] = [];
    const state = sink();
    let mints = 0;
    const opts = baseOptions(
      source(),
      () => {
        mints += 1;
        return Promise.resolve(source('https://gvs.example/fresh'));
      },
      state,
      calls,
      pages,
    );
    await expectFailure(() => downloadTo(opts), 'expired-resource');
    assertEqual(mints, 1);
  }

  // A mid-stream 200 is a serving violation.
  {
    const pages = new Map<number, Step[]>([
      [0, [{ status: 200, body: [1, 2, 3, 4, 5, 6, 7, 8] }]],
    ]);
    const calls: { url: string; start: number }[] = [];
    const state = sink();
    const opts = baseOptions(
      source(),
      () => Promise.reject(new Error('no remint')),
      state,
      calls,
      pages,
    );
    await expectFailure(() => downloadTo(opts), 'invalid-response');
  }

  // Content-Range lying about its start offset splices foreign bytes.
  {
    const pages = new Map<number, Step[]>([
      [0, [{ status: 206, body: [1, 2, 3, 4], range: 'bytes 100-103/8' }]],
    ]);
    const calls: { url: string; start: number }[] = [];
    const state = sink();
    const opts = baseOptions(
      source(),
      () => Promise.reject(new Error('no remint')),
      state,
      calls,
      pages,
    );
    await expectFailure(() => downloadTo(opts), 'invalid-response');
  }

  // Content-Range total changing mid-stream is corruption.
  {
    const pages = new Map<number, Step[]>([
      [0, [chunk(0, [1, 2, 3, 4], 8)]],
      [4, [{ status: 206, body: [5, 6, 7, 8], range: 'bytes 4-7/16' }]],
    ]);
    const calls: { url: string; start: number }[] = [];
    const state = sink();
    const opts = baseOptions(
      source(),
      () => Promise.reject(new Error('no remint')),
      state,
      calls,
      pages,
    );
    await expectFailure(() => downloadTo(opts), 'invalid-response');
  }

  // Empty body = no progress; oversized = overlapping bytes.
  for (const body of [[], [1, 2, 3, 4, 5]] as number[][]) {
    const pages = new Map<number, Step[]>([
      [
        0,
        [
          {
            status: 206,
            body,
            range: `bytes 0-${body.length - 1}/8`,
          },
        ],
      ],
    ]);
    const calls: { url: string; start: number }[] = [];
    const state = sink();
    const opts = baseOptions(
      source(),
      () => Promise.reject(new Error('no remint')),
      state,
      calls,
      pages,
    );
    await expectFailure(() => downloadTo(opts), 'invalid-response');
  }

  // Cancellation lands as a typed cancelled.
  {
    const pages = new Map<number, Step[]>([
      [0, [chunk(0, [1, 2, 3, 4], 8)]],
      [4, [{ hang: true }]],
    ]);
    const calls: { url: string; start: number }[] = [];
    const state = sink();
    const ctl = new CancellationSource();
    const opts = baseOptions(
      source(),
      () => Promise.reject(new Error('no remint')),
      state,
      calls,
      pages,
    );
    opts.signal = ctl.signal;
    const work = downloadTo(opts);
    ctl.cancel();
    await expectFailure(() => work, 'cancelled');
  }

  // An AbortError without cancel = the chunk timeout → transient.
  {
    const pages = new Map<number, Step[]>([[0, [{ throwAbort: true }]]]);
    const calls: { url: string; start: number }[] = [];
    const state = sink();
    const opts = baseOptions(
      source(),
      () => Promise.reject(new Error('no remint')),
      state,
      calls,
      pages,
    );
    await expectFailure(() => downloadTo(opts), 'transient');
  }

  // Non-https mints are refused at the fetch site.
  {
    const calls: { url: string; start: number }[] = [];
    const state = sink();
    const opts = baseOptions(
      { url: 'http://insecure.example/v', mime: 'audio/mp4', contentLength: 4 },
      () => Promise.reject(new Error('no remint')),
      state,
      calls,
      new Map(),
    );
    await expectFailure(() => downloadTo(opts), 'invalid-response');
    assertEqual(calls.length, 0);
  }
}
