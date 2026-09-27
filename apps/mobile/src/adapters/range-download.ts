import {
  DownloadFailure,
  asAppError,
  createSha256,
  err,
  ok,
  runTransfer,
} from '@auqw/application';
import type {
  CancellationSignal,
  MediaTransferPort,
  PlayableResource,
  RangeFetch as PolicyFetch,
  RangeFetchResponse,
  TransferSink,
} from '@auqw/application';
import { createClock } from './runtime.ts';

/**
 * Progressive range downloader — the iOS provisional player path's
 * byte seam. The wire rules are the shared transfer policy's
 * (`@auqw/application`'s `runTransfer`): strict `206`-only acceptance,
 * `Content-Range` start-equals-request with a stable total, exact
 * declared-length bodies, a per-chunk stall timeout covering headers
 * and body, `403`/`416` re-mint with a zero-progress abort, a bounded
 * mint budget, range-requests always, and an encoding-triple restart —
 * splicing bytes across encodings would corrupt the file. What remains
 * here is only the provisional wiring: the AbortSignal-carrying fetch
 * contract the expo-audio adapter speaks, and the expo-file-system
 * `ByteSink` behind a MediaTransferPort facade.
 */

export type { RangeFetchResponse };

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

export {
  DownloadFailure,
  asAppError,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MINT_BUDGET,
  DEFAULT_ZERO_PROGRESS_LIMIT,
  DEFAULT_CHUNK_TIMEOUT_MS,
} from '@auqw/application';

function toResource(source: StreamSource): PlayableResource {
  return {
    url: source.url,
    mime: source.mime,
    bitrateKbps: source.bitrateKbps ?? null,
    contentLength: source.contentLength ?? null,
    itag: source.itag ?? null,
    expiresAtMs: source.expiresAtMs ?? null,
    client: '',
  };
}

/**
 * Download `first` to a fresh sink, reminting through `remint` on
 * cap-death. Returns the total bytes written. `onReady` fires once —
 * either when `readyAtBytes` are committed or when the whole resource
 * fits below that mark. A re-mint that changes the encoding
 * descriptor (mime/length/bitrate/itag) restarts the file: splicing
 * bytes across encodings would corrupt the stream.
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
  const { signal, fetchImpl, openSink, remint, onReady, readyAtBytes } = options;

  // The encoding the next sink opens for — the policy only calls
  // `begin` at start and after an encoding-changing re-mint, so the
  // remint wrapper is where a fresh mime arrives.
  let pendingMime = options.first.mime;
  let readyFired = false;
  let sinkOpened = false;

  // ByteSink behind the transfer port: the expo file handle's writes
  // are durable as they land, so `commit` just reports the offset and
  // `finalize` echoes the policy's streamed digest — the provisional
  // file's lifecycle (eviction, delete) belongs to the player record,
  // not the port, so resume/sweep/accounting verbs are unused here.
  const transfer: MediaTransferPort = {
    ensureDir: () => Promise.resolve(ok(undefined)),
    begin: async ({ resumeAtBytes }) => {
      if (sinkOpened) {
        // A reopened sink is an encoding restart — the ready
        // threshold re-arms on the fresh encoding's bytes (progress
        // offsets alone can't see a one-chunk catch-up).
        readyFired = false;
      }
      sinkOpened = true;
      const byteSink = openSink(pendingMime);
      await byteSink.reset();
      let written = resumeAtBytes;
      const sink: TransferSink = {
        write: async (bytes) => {
          await byteSink.write(bytes);
          written += bytes.length;
          return ok(undefined);
        },
        commit: () => Promise.resolve(ok(written)),
        finalize: (expected) => Promise.resolve(ok(expected ?? '')),
        abort: async (keep) => {
          if (!keep) {
            await byteSink.reset();
          }
          return ok(undefined);
        },
      };
      return Promise.resolve(ok(sink));
    },
    sweepPartials: () => Promise.resolve(ok(0)),
    usage: () => Promise.resolve(ok(0)),
    freeBytes: () => Promise.resolve(ok(Number.MAX_SAFE_INTEGER)),
    removeFile: () => Promise.resolve(ok(undefined)),
    stat: () => Promise.resolve(ok({ exists: false, bytes: null })),
  };

  // AbortSignal bridge: the provisional fetch contract carries the
  // abort primitive inside init; the policy hands the chunk a
  // CancellationSignal instead. The subscription must outlive the
  // headers — a body stall still has to reach the wire read — so it
  // releases when the body lands. An AbortError with no cancel behind
  // it is a fetch-side abort, reported as a stall (transient).
  const wireFetch: PolicyFetch = async (url, init, chunkSignal) => {
    const ctl = new AbortController();
    const release = chunkSignal.subscribe(() => ctl.abort());
    if (chunkSignal.cancelled) {
      ctl.abort();
    }
    try {
      const resp = await fetchImpl(url, {
        headers: init.headers,
        signal: ctl.signal,
      });
      return {
        status: resp.status,
        headers: resp.headers,
        arrayBuffer: async () => {
          try {
            return await resp.arrayBuffer();
          } catch (thrown) {
            // A body-phase abort with no cancel behind it is the same
            // fetch-side abort as above — a stall, not a cancel.
            if (
              !chunkSignal.cancelled &&
              (thrown as { name?: unknown }).name === 'AbortError'
            ) {
              throw new DownloadFailure(
                'transient',
                'chunk body aborted',
              );
            }
            throw thrown;
          } finally {
            release();
          }
        },
      };
    } catch (thrown) {
      release();
      if (
        !chunkSignal.cancelled &&
        (thrown as { name?: unknown }).name === 'AbortError'
      ) {
        throw new DownloadFailure('transient', 'chunk fetch aborted');
      }
      throw thrown;
    }
  };

  const outcome = await runTransfer({
    destName: 'provisional.part',
    first: toResource(options.first),
    remint: async () => {
      try {
        const fresh = await remint();
        pendingMime = fresh.mime;
        return ok(toResource(fresh));
      } catch (thrown) {
        return err(asAppError(thrown));
      }
    },
    transfer,
    fetchImpl: wireFetch,
    clock: createClock(),
    signal,
    hasher: createSha256,
    onProgress: ({ committed }) => {
      if (!readyFired && committed >= readyAtBytes) {
        readyFired = true;
        onReady(committed);
      }
    },
    ...(options.chunkSize === undefined
      ? {}
      : { chunkSize: options.chunkSize }),
    ...(options.mintBudget === undefined
      ? {}
      : { mintBudget: options.mintBudget }),
    ...(options.zeroProgressLimit === undefined
      ? {}
      : { zeroProgressLimit: options.zeroProgressLimit }),
    ...(options.chunkTimeoutMs === undefined
      ? {}
      : { chunkTimeoutMs: options.chunkTimeoutMs }),
  });
  if (!outcome.ok) {
    throw new DownloadFailure(outcome.error.kind, outcome.error.message);
  }
  // A resource smaller than readyAtBytes completes in one fetch — a
  // finished file is "enough data" by definition.
  if (!readyFired) {
    onReady(outcome.value.bytes);
  }
  return outcome.value.bytes;
}
