import { appError, err, ok } from '../errors.ts';
import type { AppError, ErrorKind, Result } from '../errors.ts';
import { CancellationSource } from '../cancellation.ts';
import type { CancellationSignal } from '../cancellation.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { MediaTransferPort, TransferSink } from '../ports/media-transfer.ts';
import type { PlayableResource } from '../ports/provider.ts';

/**
 * Platform-free download wire policy — the rules proven under
 * `apps/mobile/.../range-download.ts` promoted to the owned-download
 * path: strict `206`-only acceptance, `Content-Range` start-equals-
 * request with a stable total, empty/oversized body rejection,
 * per-chunk stall timeout covering headers and body, `403`/`416`
 * re-mint against the durable resume offset, a bounded mint budget,
 * a zero-progress abort, and an encoding-triple change restart —
 * splicing bytes across encodings would corrupt the file.
 *
 * The byte plane is the MediaTransferPort's `.part` sink: `commit()`
 * after every accepted chunk makes `committedOffset` the durable
 * resume point; `finalize` verifies the incremental sha-256 and
 * renames atomically; `abort(keep)` keeps or drops the partial.
 * Everything here is pure TS — no fetch/fs/runtime types escape this
 * module beyond the injected `fetchImpl` signature.
 */

export type RangeFetchResponse = {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
};

/**
 * Wire fetch as the adapter exposes it. Cancellation/timeout arrive
 * via the `CancellationSignal` — the adapter bridges it onto whatever
 * abort primitive its fetch needs (e.g. an AbortController).
 */
export type RangeFetch = (
  url: string,
  init: { headers: Record<string, string> },
  signal: CancellationSignal,
) => Promise<RangeFetchResponse>;

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

/**
 * fetch rejects with TypeError on transport failure (DNS, reset, body
 * read drop) — a retryable blip. Scoped to the fetch site only: a
 * TypeError from the hasher, remint, or a callback is a programmer
 * error and must stay `internal`, not enter a network retry loop.
 */
function asTransport(thrown: unknown): never {
  if (thrown instanceof TypeError) {
    throw new DownloadFailure('transient', 'download network error');
  }
  throw thrown;
}

export const DEFAULT_CHUNK_SIZE = 1_048_576;
export const DEFAULT_MINT_BUDGET = 8;
export const DEFAULT_ZERO_PROGRESS_LIMIT = 2;
export const DEFAULT_CHUNK_TIMEOUT_MS = 60_000;

/** `bytes start-end/total` — the only Content-Range shape a 206 may carry. */
function parseContentRange(
  header: string | null,
): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header ?? '');
  if (match === null) {
    return null;
  }
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3]),
  };
}

type Chunk = {
  status: number;
  contentRange: string | null;
  bytes: Uint8Array;
};

/**
 * Per-chunk timeout: the fetch races the injected clock so the policy
 * needs no timers of its own. On expiry the child signal cancels —
 * the adapter aborts its own wire primitive on that edge.
 */
async function fetchChunk(
  url: string,
  start: number,
  end: number,
  signal: CancellationSignal,
  fetchImpl: RangeFetch,
  clock: ClockPort,
  timeoutMs: number,
): Promise<Chunk> {
  // The minted url is validated against the manifest allowlist by the
  // host; the fetch site's own belt refuses anything else.
  if (!url.startsWith('https://')) {
    throw new DownloadFailure('invalid-response', 'non-https stream url');
  }
  const child = new CancellationSource();
  const unsubscribe = signal.subscribe(() => child.cancel());
  if (signal.cancelled) {
    child.cancel();
  }
  try {
    // The timeout covers headers AND body — a stalled arrayBuffer()
    // must lose this race or the transfer hangs past its stall budget.
    const result = await Promise.race([
      fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` } }, child.signal)
        .then(async (resp) => ({
          resp,
          // Buffering a non-206 body would read a whole-file 200 or an
          // unbounded error page into memory for nothing.
          bytes:
            resp.status === 206
              ? new Uint8Array(await resp.arrayBuffer())
              : new Uint8Array(0),
        }))
        .catch(asTransport),
      clock.sleep(timeoutMs, child.signal).then(() => null),
    ]);
    if (result === null) {
      // Sleep resolved first — either the timeout elapsed or the
      // signal cancelled. The outer signal distinguishes them.
      if (signal.cancelled) {
        throw new DownloadFailure('cancelled', 'cancelled');
      }
      // Cancel the fetch so the wire primitive aborts, then report
      // the stall as transient — a resume can pick it back up.
      child.cancel();
      throw new DownloadFailure(
        'transient',
        `chunk ${start}-${end}: timed out`,
      );
    }
    const resp = result.resp;
    // Response and body are in — release the timeout sleeper early
    // so it doesn't linger a full timeout per chunk.
    child.cancel();
    return {
      status: resp.status,
      contentRange: resp.headers.get('content-range'),
      bytes: result.bytes,
    };
  } catch (thrown) {
    if (thrown instanceof DownloadFailure) {
      throw thrown;
    }
    if (child.signal.cancelled && !signal.cancelled) {
      throw new DownloadFailure(
        'transient',
        `chunk ${start}-${end}: timed out`,
      );
    }
    throw thrown;
  } finally {
    unsubscribe();
  }
}

function checkSignal(signal: CancellationSignal): void {
  if (signal.cancelled) {
    throw new DownloadFailure('cancelled', 'cancelled');
  }
}

/** Incremental sha-256 over committed bytes, for the publish checksum. */
export interface ChunkHasher {
  update(bytes: Uint8Array): void;
  digest(): string;
}

/** What a finished transfer reports to the DownloadManager. */
export type TransferOutcome = {
  /** Total bytes committed — the final file size. */
  bytes: number;
  /** sha-256 hex over the complete file, verified at finalize. */
  checksum: string;
  mime: string;
  itag: number | null;
  contentLength: number | null;
  expiresAtMs: number | null;
};

/** Live progress callback, fired after each committed chunk. */
export type TransferProgress = {
  /** Bytes durably committed — the resume offset. */
  committed: number;
  /** Wire total when known (Content-Range), else null. */
  total: number | null;
};

/**
 * Download `first` through `transfer`, resuming from
 * `resumeAtBytes` when the sink already holds a committed prefix.
 * `remint(resumeOffset, itag)` must re-resolve through
 * `resolvePlayback(ref, { resumeOffset: committed, pinItag })` and
 * return the fresh resource; the encoding descriptor
 * (mime/contentLength/bitrateKbps/itag) pins the file — a change
 * restarts at 0, since bytes from another encoding cannot be spliced.
 * A resume (`resumeAtBytes` > 0) first checks `first` against
 * `expectedEncoding`, the persisted descriptor of the mint that
 * produced the `.part` prefix — appending foreign bytes would
 * publish a corrupt file that still checksums cleanly.
 *
 * Fails typed: `expired-resource` when the mint budget or the
 * zero-progress limit runs out, `invalid-response` on wire-rule
 * violations, `cancelled` on the signal, `transient` on timeouts.
 * On any failure the `.part` is kept (resume-capable); the caller
 * decides to retry or remove.
 */
export async function runTransfer(options: {
  /** Managed-dir file name — never a path. */
  destName: string;
  /** First minted resource for this transfer. */
  first: PlayableResource;
  /**
   * Re-mint hook: re-resolve through resolvePlayback with the durable
   * resume offset and the itag pin. The result's encoding triple
   * decides resume-vs-restart.
   */
  remint: (
    resumeOffset: number,
    itag: number | null,
  ) => Promise<Result<PlayableResource>>;
  transfer: MediaTransferPort;
  fetchImpl: RangeFetch;
  clock: ClockPort;
  signal: CancellationSignal;
  /**
   * Durable resume offset — 0 for a fresh file. When >0 the file
   * already holds committed bytes the policy hasher cannot cover;
   * `finalize` then computes the true digest from disk.
   */
  resumeAtBytes?: number;
  /**
   * Descriptor of the mint that produced the existing prefix —
   * required for honest resume. `null` `mime`/`contentLength` mean
   * "not recorded" and skip that check; `itag` always compares —
   * null is a real value (the mint had no format pin). Any mismatch
   * with `first` restarts at 0.
   */
  expectedEncoding?: {
    readonly mime: string | null;
    readonly contentLength: number | null;
    readonly itag: number | null;
  };
  hasher: () => ChunkHasher;
  onProgress?: (progress: TransferProgress) => void;
  chunkSize?: number;
  mintBudget?: number;
  zeroProgressLimit?: number;
  chunkTimeoutMs?: number;
}): Promise<Result<TransferOutcome>> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const mintBudget = options.mintBudget ?? DEFAULT_MINT_BUDGET;
  const zeroProgressLimit =
    options.zeroProgressLimit ?? DEFAULT_ZERO_PROGRESS_LIMIT;
  const chunkTimeoutMs = options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
  const { signal, fetchImpl, transfer, remint, onProgress, destName, clock } =
    options;

  try {
    const ensured = await transfer.ensureDir(signal);
    if (!ensured.ok) {
      return ensured;
    }
    checkSignal(signal);

    // The stream whose bytes are in the sink right now — the only
    // valid baseline for resume-vs-restart (an A → B → A mint flip
    // would otherwise resume A into a sink holding B's bytes).
    let current = options.first;
    let url = current.url;
    let start = options.resumeAtBytes ?? 0;
    let total = current.contentLength;
    const expected = options.expectedEncoding;
    if (
      start > 0 &&
      expected !== undefined &&
      (expected.mime !== current.mime ||
        (expected.contentLength !== null &&
          expected.contentLength !== current.contentLength) ||
        expected.itag !== current.itag)
    ) {
      // The existing prefix was minted under a different encoding —
      // the mint ignored the pin, or the provider changed the format.
      // Discarding bytes loses progress; splicing them publishes a
      // corrupt file — restart clean.
      start = 0;
    }
    let mints = 0;
    let zeroProgress = 0;
    let mintStart = start;
    // The incremental digest covers only bytes streamed this run — it
    // is the finalize cross-check only when the run wrote the whole
    // file (fresh start or an encoding restart back to offset 0).
    let hasher = options.hasher();
    let digestCoversFile = start === 0;
    let sink: TransferSink;
    const openSink = async (resume: number): Promise<TransferSink> => {
      const opened = await transfer.begin(
        { destPath: destName, resumeAtBytes: resume },
        signal,
      );
      if (!opened.ok) {
        throw new DownloadFailure(
          opened.error.kind,
          opened.error.message,
        );
      }
      sink = opened.value;
      return sink;
    };
    sink = await openSink(start);

    let sinkOpen = true;
    const closeAbort = async (keep: boolean): Promise<void> => {
      if (!sinkOpen) {
        return;
      }
      sinkOpen = false;
      await sink.abort(keep);
    };

    try {
      while (total === null || start < total) {
        checkSignal(signal);
        const end =
          total === null
            ? start + chunkSize - 1
            : Math.min(start + chunkSize - 1, total - 1);
        const chunk = await fetchChunk(
          url,
          start,
          end,
          signal,
          fetchImpl,
          clock,
          chunkTimeoutMs,
        );
        // 403 is the known cap signal; 416 on an in-range request
        // means the mint no longer serves bytes we know exist — same
        // treatment: re-mint and resume, bounded by the budgets.
        if (chunk.status === 403 || chunk.status === 416) {
          zeroProgress = start === mintStart ? zeroProgress + 1 : 0;
          if (zeroProgress >= zeroProgressLimit || mints >= mintBudget) {
            throw new DownloadFailure(
              'expired-resource',
              'stream capped by provider',
            );
          }
          mints += 1;
          const fresh = await remint(start, current.itag);
          checkSignal(signal);
          if (!fresh.ok) {
            throw new DownloadFailure(fresh.error.kind, fresh.error.message);
          }
          const sameEncoding =
            fresh.value.mime === current.mime &&
            fresh.value.contentLength === total &&
            fresh.value.bitrateKbps === current.bitrateKbps &&
            fresh.value.itag === current.itag;
          if (sameEncoding) {
            mintStart = start;
            url = fresh.value.url;
          } else {
            current = fresh.value;
            url = fresh.value.url;
            // Encoding changed: keep no bytes — the prefix is a
            // different file now.
            await closeAbort(false);
            start = 0;
            total = fresh.value.contentLength;
            mintStart = 0;
            hasher = options.hasher();
            digestCoversFile = true;
            sink = await openSink(start);
            sinkOpen = true;
          }
          continue;
        }
        // Every request sends a Range: any other status is a serving
        // violation — a mid-stream 200 would append the whole file at
        // the resume offset and corrupt the download.
        if (chunk.status !== 206) {
          throw new DownloadFailure(
            'invalid-response',
            `chunk ${start}-${end}: HTTP ${chunk.status}`,
          );
        }
        // The served window must start where we asked and stay inside
        // the request — a 206 lying about its span splices foreign
        // bytes.
        const range = parseContentRange(chunk.contentRange);
        if (
          range === null ||
          range.start !== start ||
          range.end < range.start ||
          range.end > end ||
          range.end >= range.total ||
          range.total <= 0
        ) {
          throw new DownloadFailure(
            'invalid-response',
            `chunk ${start}-${end}: bad Content-Range`,
          );
        }
        if (total === null) {
          total = range.total;
        } else if (range.total !== total) {
          throw new DownloadFailure(
            'invalid-response',
            `chunk ${start}-${end}: Content-Range total changed mid-stream`,
          );
        }
        // The body must be exactly what Content-Range declares — a
        // shorter/longer read shifts every later offset.
        const declared = range.end - range.start + 1;
        if (chunk.bytes.length !== declared) {
          throw new DownloadFailure(
            'invalid-response',
            `chunk ${start}-${end}: body ${chunk.bytes.length}B vs declared ${declared}B`,
          );
        }
        const written = await sink.write(chunk.bytes);
        if (!written.ok) {
          throw new DownloadFailure(written.error.kind, written.error.message);
        }
        hasher.update(chunk.bytes);
        const committed = await sink.commit();
        if (!committed.ok) {
          throw new DownloadFailure(
            committed.error.kind,
            committed.error.message,
          );
        }
        start = committed.value;
        checkSignal(signal);
        onProgress?.({ committed: start, total });
      }
    } catch (thrown) {
      // Resume-capable by default — the caller decides remove/retry.
      await closeAbort(true);
      throw thrown;
    }

    checkSignal(signal);
    sinkOpen = false;
    const finalized = await sink.finalize(
      digestCoversFile ? hasher.digest() : null,
    );
    if (!finalized.ok) {
      return finalized;
    }
    return ok({
      bytes: start,
      checksum: finalized.value,
      mime: current.mime,
      itag: current.itag,
      contentLength: total,
      expiresAtMs: current.expiresAtMs,
    });
  } catch (thrown) {
    return err(asAppError(thrown));
  }
}
