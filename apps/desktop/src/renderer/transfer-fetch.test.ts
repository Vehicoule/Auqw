import type { CancellationSignal } from '@auqw/application';
import { CancellationSource, DownloadFailure } from '@auqw/application';
import { SequenceIds } from '@auqw/application/testing';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import type { AuqwApi } from '../shared/contract.ts';
import { shellError } from '../shared/errors.ts';
import { createTransferFetch } from './transfer-fetch.ts';

type FetchApi = Pick<
  AuqwApi['transfer'],
  'fetch' | 'fetchBody' | 'fetchAbort'
>;

/** A scripted `transfer:fetch*` api — records calls, answers per script. */
function fakeApi(over: {
  head?: { status: number; headers: [string, string][] };
  headError?: ReturnType<typeof shellError>;
  body?: string;
  bodyError?: ReturnType<typeof shellError>;
  /** Park head until `resolve` is called — aborts must still work. */
  holdHead?: boolean;
}): FetchApi & {
  calls: string[];
  releases: (() => void)[];
} {
  const calls: string[] = [];
  const releases: (() => void)[] = [];
  return {
    calls,
    releases,
    fetch: (args: { requestId: string; url: string }) => {
      calls.push(`fetch:${args.requestId}:${args.url}`);
      if (over.holdHead === true) {
        return new Promise((resolve) => {
          releases.push(() => {
            resolve(over.head ?? { status: 200, headers: [] });
          });
        });
      }
      if (over.headError !== undefined) {
        return Promise.reject(over.headError);
      }
      return Promise.resolve(
        over.head ?? { status: 206, headers: [['content-range', 'b']] },
      );
    },
    fetchBody: (args: { requestId: string }) => {
      calls.push(`fetchBody:${args.requestId}`);
      if (over.bodyError !== undefined) {
        return Promise.reject(over.bodyError);
      }
      return Promise.resolve({
        data: over.body ?? Buffer.from('hi').toString('base64'),
      });
    },
    fetchAbort: (args: { requestId: string }) => {
      calls.push(`fetchAbort:${args.requestId}`);
      return Promise.resolve(undefined);
    },
  };
}

async function happyPath(): Promise<void> {
  const api = fakeApi({
    head: {
      status: 206,
      headers: [
        ['Content-Range', 'bytes 0-1/2'],
        ['Accept-Ranges', 'bytes'],
      ],
    },
  });
  const fetch = createTransferFetch(api, new SequenceIds());
  const source = new CancellationSource();
  const response = await fetch(
    'https://cdn.example/x',
    { headers: { 'user-agent': 'UA', Range: 'bytes=0-1' } },
    source.signal,
  );
  assertEqual(response.status, 206, 'status');
  assertEqual(
    response.headers.get('content-range'),
    'bytes 0-1/2',
    'header names case-fold',
  );
  assertEqual(response.headers.get('accept-ranges'), 'bytes');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertDeepEqual([...bytes], [...new TextEncoder().encode('hi')]);
  assertDeepEqual(
    api.calls,
    ['fetch:fetch-1:https://cdn.example/x', 'fetchBody:fetch-1'],
    'head then body on the same requestId',
  );
}

async function shellErrorKinds(): Promise<void> {
  const source = new CancellationSource();
  const signal = source.signal;

  // Retryable shell kinds → transient DownloadFailure.
  for (const kind of ['transient', 'unavailable', 'io-error'] as const) {
    const api = fakeApi({ headError: shellError(kind, 'x') });
    const fetch = createTransferFetch(api, new SequenceIds());
    try {
      await fetch('https://cdn.example/x', { headers: {} }, signal);
      assert(false, `${kind} must throw`);
    } catch (thrown) {
      assert(
        thrown instanceof DownloadFailure && thrown.kind === 'transient',
        `${kind} → transient`,
      );
    }
  }

  // Non-retryable kinds → invalid-response.
  const api = fakeApi({
    headError: shellError('invalid-request', 'bad url'),
  });
  const fetch = createTransferFetch(api, new SequenceIds());
  try {
    await fetch('https://cdn.example/x', { headers: {} }, signal);
    assert(false, 'must throw');
  } catch (thrown) {
    assert(
      thrown instanceof DownloadFailure &&
        thrown.kind === 'invalid-response',
      'invalid-request → invalid-response',
    );
  }

  // Utility-side 'cancelled' without a caller cancel → transient
  // (a stall killed it — not a user cancel).
  const stalled = fakeApi({
    headError: shellError('cancelled', 'aborted'),
  });
  const stallFetch = createTransferFetch(stalled, new SequenceIds());
  try {
    await stallFetch('https://cdn.example/x', { headers: {} }, signal);
    assert(false, 'must throw');
  } catch (thrown) {
    assert(
      thrown instanceof DownloadFailure && thrown.kind === 'transient',
      'orphan shell-cancelled → transient',
    );
  }
}

async function callerCancelAborts(): Promise<void> {
  const api = fakeApi({ holdHead: true });
  const fetch = createTransferFetch(api, new SequenceIds());
  const source = new CancellationSource();
  const pending = fetch(
    'https://cdn.example/x',
    { headers: {} },
    source.signal,
  );
  source.cancel();
  api.releases.forEach((release) => {
    release();
  });
  try {
    await pending;
    assert(false, 'must throw');
  } catch (thrown) {
    assert(
      thrown instanceof DownloadFailure && thrown.kind === 'cancelled',
      'caller cancel → cancelled',
    );
  }
  assertDeepEqual(
    api.calls,
    ['fetch:fetch-1:https://cdn.example/x', 'fetchAbort:fetch-1'],
    'abort fires on cancel',
  );
}

async function preCancelled(): Promise<void> {
  const api = fakeApi({});
  const fetch = createTransferFetch(api, new SequenceIds());
  const source = new CancellationSource();
  source.cancel();
  try {
    await fetch('https://cdn.example/x', { headers: {} }, source.signal);
    assert(false, 'must throw');
  } catch (thrown) {
    assert(
      thrown instanceof DownloadFailure && thrown.kind === 'cancelled',
      'pre-cancelled signal → cancelled',
    );
  }
  // The abort subscription fires immediately on an already-cancelled
  // signal — an idempotent no-op on the service — but no fetch issues.
  assertDeepEqual(
    api.calls,
    ['fetchAbort:fetch-1'],
    'no fetch issued when pre-cancelled',
  );
}

async function bodyErrorMaps(): Promise<void> {
  const api = fakeApi({
    bodyError: shellError('invalid-response', 'oversize'),
  });
  const fetch = createTransferFetch(api, new SequenceIds());
  const source = new CancellationSource();
  const response = await fetch(
    'https://cdn.example/x',
    { headers: {} },
    source.signal,
  );
  try {
    await response.arrayBuffer();
    assert(false, 'must throw');
  } catch (thrown) {
    assert(
      thrown instanceof DownloadFailure &&
        thrown.kind === 'invalid-response',
      'body error kind maps',
    );
  }
}

export async function run(): Promise<void> {
  await happyPath();
  await shellErrorKinds();
  await callerCancelAborts();
  await preCancelled();
  await bodyErrorMaps();
}
