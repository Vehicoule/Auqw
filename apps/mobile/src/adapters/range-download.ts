import { appError } from '@auqw/application';
import type {
  AppError,
  CancellationSignal,
  ErrorKind,
} from '@auqw/application';

/**
 * Progressive range downloader — the iOS provisional player path's
 * byte seam. Carries the wire rules shared with Slice 0 and the
 * auqw-stream pump: strict `206`-only acceptance, `Content-Range`
 * start-equals-request with a stable total, empty/oversized body
 * rejection, a per-chunk timeout covering headers and body, `403`/`416`
 * re-mint with a zero-progress abort, bounded mint budget, and
 * range-requests always. The fetch and byte sink are injected so the
 * policy is testable under plain Node; the expo-file-system glue lives
 * in the player adapter.
 */

export type RangeFetchResponse = {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type RangeFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<RangeFetchResponse>;

/** Append-only byte target; `reset` discards prior contents. */
export type ByteSink = {
  reset(): Promise<void> | void;
  write(bytes: Uint8Array): Promise<void> | void;
};

/** One minted stream — the identity triple that must survive a re-mint. */
export type StreamSource = {
  readonly url: string;
  readonly mime: string;
  readonly bitrateKbps?: number | undefined;
  readonly contentLength?: number | undefined;
  /** Format pin for re-mints + prepared-stream reporting. */
  readonly itag?: number | undefined;
  readonly expiresAtMs?: number | undefined;
};

export class DownloadFailure extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export function asAppError(thrown: unknown): AppError {
  if (thrown instanceof DownloadFailure) {
    return appError(thrown.kind, thrown.message);
  }
  if (
    typeof thrown === 'object' &&
    thrown !== null &&
    (thrown as { name?: unknown }).name === 'AbortError'
  ) {
    return appError('cancelled', 'cancelled');
  }
  return appError('internal', 'download failed');
}

export const DEFAULT_CHUNK_SIZE = 1_048_576;
export const DEFAULT_MINT_BUDGET = 8;
export const DEFAULT_ZERO_PROGRESS_LIMIT = 2;
export const DEFAULT_CHUNK_TIMEOUT_MS = 60_000;

/** `bytes start-end/total` — the only Content-Range shape a 206 may carry. */
function parseContentRange(
  header: string | null,
): { start: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header ?? '');
  if (match === null) {
    return null;
  }
  return { start: Number(match[1]), total: Number(match[3]) };
}

type Chunk = {
  status: number;
  contentRange: string | null;
  bytes: Uint8Array;
};

async function fetchChunk(
  url: string,
  start: number,
  end: number,
  signal: CancellationSignal,
  fetchImpl: RangeFetch,
  timeoutMs: number,
): Promise<Chunk> {
  // The minted url is validated against the manifest allowlist by the
  // host; the fetch site's own belt refuses anything else.
  if (!url.startsWith('https://')) {
    throw new DownloadFailure('invalid-response', 'non-https stream url');
  }
  const ctl = new AbortController();
  const unsubscribe = signal.subscribe(() => ctl.abort());
  if (signal.cancelled) {
    ctl.abort();
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: ctl.signal,
    });
    // Buffering a non-206 body would read a whole-file 200 or an
    // unbounded error page into memory for nothing.
    const bytes =
      resp.status === 206
        ? new Uint8Array(await resp.arrayBuffer())
        : new Uint8Array(0);
    return {
      status: resp.status,
      contentRange: resp.headers.get('content-range'),
      bytes,
    };
  } catch (thrown) {
    if (!signal.cancelled && (thrown as { name?: unknown }).name === 'AbortError') {
      throw new DownloadFailure('transient', `chunk ${start}-${end}: timed out`);
    }
    throw thrown;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

function checkSignal(signal: CancellationSignal): void {
  if (signal.cancelled) {
    throw new DownloadFailure('cancelled', 'cancelled');
  }
}

/**
 * Download `first` to a fresh sink, reminting through `remint` on
 * cap-death. Returns the total bytes written. `onReady` fires once —
 * either when `readyAtBytes` are committed or when the whole resource
 * fits below that mark. A re-mint that changes the encoding
 * (mime/length/bitrate triple) restarts the file: splicing bytes
 * across encodings would corrupt the stream.
 */
export async function downloadTo(options: {
  first: StreamSource;
  remint: () => Promise<StreamSource>;
  openSink: (mime: string) => ByteSink;
  fetchImpl: RangeFetch;
  signal: CancellationSignal;
  readyAtBytes: number;
  onReady: (written: number) => void;
  chunkSize?: number;
  mintBudget?: number;
  zeroProgressLimit?: number;
  chunkTimeoutMs?: number;
}): Promise<number> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const mintBudget = options.mintBudget ?? DEFAULT_MINT_BUDGET;
  const zeroProgressLimit =
    options.zeroProgressLimit ?? DEFAULT_ZERO_PROGRESS_LIMIT;
  const chunkTimeoutMs = options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
  const { signal, fetchImpl, openSink, remint, onReady, readyAtBytes } = options;

  // The stream whose bytes are in the sink right now — the only valid
  // baseline for resume-vs-restart (an A → B → A mint flip resumes A
  // into a sink holding B's bytes otherwise).
  let current = options.first;
  let url = current.url;
  let sink = openSink(current.mime);
  await sink.reset();
  let start = 0;
  let total = current.contentLength ?? -1;
  let mints = 0;
  let zeroProgress = 0;
  let mintStart = 0;
  let readyFired = false;

  const fireReady = (): void => {
    if (!readyFired && start >= readyAtBytes) {
      readyFired = true;
      onReady(start);
    }
  };

  while (total < 0 || start < total) {
    checkSignal(signal);
    const end =
      total < 0 ? start + chunkSize - 1 : Math.min(start + chunkSize - 1, total - 1);
    const chunk = await fetchChunk(url, start, end, signal, fetchImpl, chunkTimeoutMs);
    // 403 is the known cap signal; 416 on an in-range request means the
    // mint no longer serves bytes we know exist — same treatment:
    // re-mint and resume, bounded by the progress budget.
    if (chunk.status === 403 || chunk.status === 416) {
      zeroProgress = start === mintStart ? zeroProgress + 1 : 0;
      if (zeroProgress >= zeroProgressLimit || mints >= mintBudget) {
        throw new DownloadFailure(
          'expired-resource',
          'stream capped by provider',
        );
      }
      mints += 1;
      const fresh = await remint();
      checkSignal(signal);
      if (
        fresh.mime === current.mime &&
        fresh.contentLength === current.contentLength &&
        fresh.bitrateKbps === current.bitrateKbps
      ) {
        mintStart = start;
        url = fresh.url;
      } else {
        current = fresh;
        url = fresh.url;
        sink = openSink(fresh.mime);
        await sink.reset();
        start = 0;
        total = fresh.contentLength ?? -1;
        mintStart = 0;
        readyFired = false;
      }
      continue;
    }
    // Every request sends a Range: any other status is a serving
    // violation — a mid-stream 200 would append the whole file at the
    // resume offset and corrupt the download.
    if (chunk.status !== 206) {
      throw new DownloadFailure(
        'invalid-response',
        `chunk ${start}-${end}: HTTP ${chunk.status}`,
      );
    }
    // The served window must start where we asked — a 206 lying about
    // its offset or total splices foreign bytes into the file.
    const range = parseContentRange(chunk.contentRange);
    if (range === null || range.start !== start || range.total <= 0) {
      throw new DownloadFailure(
        'invalid-response',
        `chunk ${start}-${end}: bad Content-Range`,
      );
    }
    if (total < 0) {
      total = range.total;
    } else if (range.total !== total) {
      throw new DownloadFailure(
        'invalid-response',
        `chunk ${start}-${end}: Content-Range total changed mid-stream`,
      );
    }
    // An empty partial body makes no progress — without this check the
    // loop re-requests the same window forever. An oversized body
    // would overlap the next range fetch.
    if (chunk.bytes.length === 0 || chunk.bytes.length > end - start + 1) {
      throw new DownloadFailure(
        'invalid-response',
        `chunk ${start}-${end}: ${chunk.bytes.length === 0 ? 'empty' : 'oversized'} body`,
      );
    }
    await sink.write(chunk.bytes);
    checkSignal(signal);
    start += chunk.bytes.length;
    fireReady();
  }
  // A resource smaller than readyAtBytes completes in one fetch — a
  // finished file is "enough data" by definition.
  if (!readyFired) {
    readyFired = true;
    onReady(start);
  }
  return start;
}
