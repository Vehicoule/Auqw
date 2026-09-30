import { appError, err, ok, PEAKS_MAX_DECODE_MS } from '@auqw/application';
import type {
  AppError,
  ErrorKind,
  OperationContext,
  PeaksPort,
  Result,
  WaveformPeak,
} from '@auqw/application';
import {
  normalizePeakWindows,
  PEAKS_RESOLUTION,
  peakWindowsFromChannels,
  peaksFromChannels,
} from '@auqw/ui-shared';
import type { PeakWindow } from '@auqw/ui-shared';
import { isRecord } from '../shared/check.ts';
import {
  carve,
  resyncScan,
  webmClusterEnd,
  webmClusterTimecode,
  webmCuesIn,
} from './containers.ts';
import type { WebmCue } from './containers.ts';
import type { StreamClient } from './web-player.ts';

/** Minimal decoded-audio surface — what `decodeAudioData` returns. */
export type DecodedAudio = {
  readonly numberOfChannels: number;
  /** Frame count — AudioBuffer.length. */
  readonly length: number;
  /** Frames per second — AudioBuffer.sampleRate. */
  readonly sampleRate: number;
  getChannelData(index: number): Float32Array;
};

/** Decode container bytes to PCM — tests inject a fake. */
type PeaksDecoder = (bytes: Uint8Array) => Promise<DecodedAudio>;

const READ_CHUNK = 1024 * 1024; // matches the stream:read MAX_READ_LEN
/** Decoration, not analysis — never pull more than this for a bar row. */
const MAX_PEAK_BYTES = 24 * 1024 * 1024;
/**
 * `decodeAudioData` expands the whole compressed buffer to per-channel
 * PCM before peak bucketing: 8 min of stereo 48 kHz is ~184 MiB of
 * Float32s. That's the transient spike the renderer pays for a bar
 * row — tracks longer than this keep the placeholder baseline. The
 * shared
 * contract constant (`PEAKS_MAX_DECODE_MS`) is the same bound the
 * tracker applies when a late duration lands mid-sweep.
 */
const MAX_DECODE_MS = PEAKS_MAX_DECODE_MS;
/**
 * Bound for streams whose `durationMs` is unknown: at the lowest
 * plausible music bitrate (64 kbps), this many encoded bytes can't
 * decode past the PCM gate; anything denser is shorter.
 */
const MAX_UNKNOWN_DURATION_BYTES =
  (MAX_DECODE_MS / 1000) * (64_000 / 8);
/**
 * Post-decode belt for the gate: multichannel/high-rate outliers (or a
 * container whose declared duration lies) bail instead of bucketing a
 * giant buffer.
 */
const MAX_PCM_BYTES = 256 * 1024 * 1024;
/** Cold-start patience for the first read — the element's own first
 * byte takes a while too; peaks may wait for the same warm-up. */
const FIRST_READ_TIMEOUT_MS = 15_000;
/**
 * Park threshold for subsequent reads: bytes already committed serve
 * in ~ms, so a read parked past this means the position is an
 * unfetched hole — chasing it would queue demand that outranks the
 * element's own (demand serves min position first), stalling playback
 * for a decoration. Abort instead; the placeholder baseline stays.
 */
const PARK_TIMEOUT_MS = 400;

/* ---- sampled extraction bounds ------------------------------------------
 * Probes are bounded ranged reads through `stream:probe` — they commit
 * into the session's sparse store, so every fetched byte is real media
 * data the player could later serve, never a discarded duplicate. The
 * caps keep a decoration's total spend under ~4 MiB.
 */
/** Head probe: the seam's own chunk bound also caps one probe call. */
const HEAD_PROBE_BYTES = 256 * 1024;
/** One sampled-cluster probe — comfortably over one ~5 s WebM cluster
 * at music bitrates, still bounded enough that a probe is cheap. */
const SAMPLE_PROBE_BYTES = 128 * 1024;
/** Tail probe that seeks the Cues index when the head didn't carry it. */
const TAIL_PROBE_BYTES = 128 * 1024;
/** Round-1 sample count — enough buckets for the coarse profile. */
const COARSE_PROBES = 10;
/** Round-2 refinement probes — densify before the final result. */
const REFINE_PROBES = 14;
/** Probe flights overlap; the seam serves committed hits instantly. */
const PROBE_CONCURRENCY = 4;
/**
 * Small files are already inside the pump's speculative head fill —
 * the legacy sequential pull serves them from committed bytes without
 * spending probe requests, so sampled extraction only pays off past
 * this total.
 */
const SAMPLED_MIN_TOTAL_BYTES = 4 * 1024 * 1024;

/** Stream/local-read failure slugs → the peaks port's app kinds:
 * dead-handle slugs collapse to 'released', contract violations to
 * 'invalid-response', anything else reads transient. */
const ERROR_KIND_BY_SLUG: Readonly<Record<string, ErrorKind>> = {
  cancelled: 'cancelled',
  released: 'released',
  evicted: 'released',
  expired: 'released',
  superseded: 'released',
  'not-found': 'released',
  'invalid-request': 'invalid-response',
  'invalid-response': 'invalid-response',
  'invalid-message': 'invalid-response',
};

/**
 * Probe failures are per-sample, never verdicts — a probe's 'expired'
 * is a mint the element's own demand is already re-minting, and a
 * 'rate-limit' is a provider cooldown that expires; both read
 * 'transient' here so a skipped sample can't settle the request.
 */
const PROBE_KIND_BY_SLUG: Readonly<Record<string, ErrorKind>> = {
  ...ERROR_KIND_BY_SLUG,
  expired: 'transient',
  'rate-limit': 'transient',
  'streams-capped': 'transient',
};

function toError(thrown: unknown, kinds = ERROR_KIND_BY_SLUG): AppError {
  if (isRecord(thrown) && typeof thrown['kind'] === 'string') {
    const kind = kinds[thrown['kind']] ?? 'transient';
    const message =
      typeof thrown['message'] === 'string' && thrown['message'].length > 0
        ? thrown['message']
        : 'peak extraction failed';
    return appError(kind, message);
  }
  return appError('internal', 'peak extraction failed');
}

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (thrown) {
    return err(toError(thrown));
  }
}

function fromBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
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

/**
 * A sparse bucket row — `null` marks a window no sample covered.
 * Interpolation fills the gaps for display; a bucket is only ever
 * fabricated at render time, from measured neighbors — never by a
 * seeded pattern.
 */
type SparseWindows = (PeakWindow | null)[];

/** Assign one decoded sample's per-bucket windows into the sparse
 * row; overlapping coverage takes the louder measure — a bucket must
 * keep a real transient, not average it away. */
function mergeSample(
  sparse: SparseWindows,
  mediaMs: number,
  channels: readonly Float32Array[],
  pcmMs: number,
  totalMs: number,
): void {
  const bucketMs = totalMs / PEAKS_RESOLUTION;
  if (!(bucketMs > 0) || pcmMs <= 0) {
    return;
  }
  const first = Math.floor(mediaMs / bucketMs);
  const buckets = Math.max(
    1,
    Math.min(PEAKS_RESOLUTION, Math.ceil(pcmMs / bucketMs)),
  );
  const windows = peakWindowsFromChannels(channels, buckets);
  for (let j = 0; j < windows.length && first + j < PEAKS_RESOLUTION; j++) {
    const i = first + j;
    if (i < 0) {
      continue;
    }
    const w = windows[j]!;
    const prev = sparse[i] ?? null;
    sparse[i] =
      prev === null
        ? w
        : { up: Math.max(prev.up, w.up), down: Math.max(prev.down, w.down) };
  }
}

/**
 * Sparse → dense: unmeasured buckets take their nearest measured
 * neighbor (ties prefer the earlier one — a seek bar reads
 * left-to-right). All-empty input is honest zeros.
 */
function fillSparseWindows(sparse: SparseWindows): PeakWindow[] {
  return Array.from({ length: PEAKS_RESOLUTION }, (_, i) => {
    const w = sparse[i];
    if (w != null) {
      return w;
    }
    for (let d = 1; d < PEAKS_RESOLUTION; d++) {
      const a = i - d >= 0 ? sparse[i - d] : undefined;
      if (a != null) {
        return a;
      }
      const b = i + d < PEAKS_RESOLUTION ? sparse[i + d] : undefined;
      if (b != null) {
        return b;
      }
    }
    return { up: 0, down: 0 };
  });
}

/**
 * Desktop/web `PeaksPort`: sample container bytes off the live stream
 * handle with bounded `stream:probe` reads and decode each sample with
 * WebAudio, then bucket to the canonical resolution.
 *
 * The handle is borrowed, never owned — the port only ever calls
 * positional reads, which touch `read_pos` upward-only:
 * `stream:open` re-anchors the session's speculative fill (`attach`
 * resets `read_pos` on every call, so opening at 0 would rewind a
 * mid-track pump's read-ahead window), and `stream:close`/`release`
 * would detach the session and wake every parked reader (the MSE
 * pump) as `cancelled`.
 *
 * Extraction is sampled, not sequential: probes fetch scattered
 * cluster/segment windows without queuing pump demand, so real peaks
 * land inside a round-trip or two instead of trailing the whole-file
 * pull. A coarse profile emits on `request.onCoarse` as soon as the
 * first probe round decodes; the returned promise resolves the
 * refined profile. Whole-file pull remains the honest fallback for
 * local files, small streams, and containers the sampler can't
 * address (non-fragmented mp4, unknown formats).
 */
export function createWebPeaksPort(deps: {
  readonly stream: StreamClient;
  /**
   * `lf-*` handle → its resolved `file://` URI (the web player's
   * local map). A non-null answer switches `pullBytes` off
   * `stream:read` — local handles have no seam session — onto
   * `localRead`, the utility's realpath-gated ranged file read.
   */
  readonly localUriFor?: (handle: string) => string | null;
  /**
   * `local:read` — `{uri, position, maxLen} → {data: base64}`, empty
   * data at EOF. Same contract as `stream:read`'s result shape.
   */
  readonly localRead?: (args: {
    uri: string;
    position: number;
    maxLen: number;
  }) => Promise<{ data: string }>;
  readonly decode?: PeaksDecoder;
  readonly maxBytes?: number;
  readonly maxDecodeMs?: number;
  readonly maxUnknownDurationBytes?: number;
  readonly maxPcmBytes?: number;
  readonly firstReadTimeoutMs?: number;
  readonly parkTimeoutMs?: number;
  /** Sampled-path knobs — tests shrink them. */
  readonly headProbeBytes?: number;
  readonly sampleProbeBytes?: number;
  readonly coarseProbes?: number;
  readonly refineProbes?: number;
  readonly sampledMinTotalBytes?: number;
  readonly now?: () => number;
}): PeaksPort {
  const maxBytes = deps.maxBytes ?? MAX_PEAK_BYTES;
  const maxDecodeMs = deps.maxDecodeMs ?? MAX_DECODE_MS;
  const maxUnknownDurationBytes =
    deps.maxUnknownDurationBytes ?? MAX_UNKNOWN_DURATION_BYTES;
  const maxPcmBytes = deps.maxPcmBytes ?? MAX_PCM_BYTES;
  const firstReadTimeoutMs =
    deps.firstReadTimeoutMs ?? FIRST_READ_TIMEOUT_MS;
  const parkTimeoutMs = deps.parkTimeoutMs ?? PARK_TIMEOUT_MS;
  const headProbeBytes = deps.headProbeBytes ?? HEAD_PROBE_BYTES;
  const sampleProbeBytes = deps.sampleProbeBytes ?? SAMPLE_PROBE_BYTES;
  const coarseProbes = deps.coarseProbes ?? COARSE_PROBES;
  const refineProbes = deps.refineProbes ?? REFINE_PROBES;
  const sampledMinTotal = deps.sampledMinTotalBytes ?? SAMPLED_MIN_TOTAL_BYTES;
  const now = deps.now ?? (() => Date.now());

  // Lazily minted — AudioContext decodes off-thread in Chromium, so a
  // suspended context costs nothing between tracks.
  let audioContext: BaseAudioContext | null = null;
  const decode: PeaksDecoder =
    deps.decode ??
    ((bytes) => {
      // OfflineAudioContext decodes without touching the output device;
      // fall back to AudioContext where Offline is absent.
      if (audioContext === null) {
        audioContext =
          typeof OfflineAudioContext !== 'undefined'
            ? new OfflineAudioContext(1, 1, 44100)
            : new AudioContext();
      }
      // decodeAudioData may detach the buffer it receives — hand it a
      // private copy so the caller's Uint8Array stays valid.
      return audioContext.decodeAudioData(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      );
    });

  async function readWithDeadline(
    read: () => Promise<{ data: string }>,
    timeoutMs: number,
    context_: OperationContext,
  ): Promise<Result<{ data: string }>> {
    if (context_.signal.cancelled) {
      return err(appError('cancelled', 'peak extraction cancelled'));
    }
    const remainingMs = Math.min(
      timeoutMs,
      Math.max(0, context_.deadlineMs - now()),
    );
    if (remainingMs <= 0) {
      return err(appError('timeout', 'peak extraction deadline'));
    }
    const timed = guard(read);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), remainingMs);
    });
    // A JS-side timeout cannot retract the native demand: the losing
    // read keeps its `fetch_through` position queued until bytes land
    // there (the first commit covering it releases it — a probe fetch,
    // not the full want) or its own read deadline lapses. Since reads
    // here run sequentially and each attempt issues one, at most one
    // stale demand per attempt lingers; a per-read cancel needs a
    // `stream:read` requestId, a contract-level change deferred to
    // decisions.md.
    const raced = await Promise.race([timed, timeout]);
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (raced === 'timeout') {
      return err(appError('timeout', 'stream read timed out'));
    }
    return raced;
  }

  /**
   * One bounded probe against the seam. `{bytes:null}` marks an
   * unfetched hole a `fetch:false` probe refused to chase; probe
   * errors map through the retriable-kind table — a skipped sample
   * never settles the request.
   */
  async function probe(
    handle: string,
    position: number,
    maxLen: number,
    fetch: boolean,
    context: OperationContext,
  ): Promise<Result<{ bytes: Uint8Array | null; total: number | null }>> {
    if (context.signal.cancelled) {
      return err(appError('cancelled', 'peak extraction cancelled'));
    }
    if (now() > context.deadlineMs) {
      return err(appError('timeout', 'peak extraction deadline'));
    }
    const probeFn = deps.stream.probe;
    if (typeof probeFn !== 'function') {
      return err(appError('unavailable', 'stream:probe not supported'));
    }
    try {
      const r = await probeFn({ handle, position, maxLen, fetch });
      return ok({
        bytes: r.eof || r.data.length > 0 ? fromBase64(r.data) : null,
        total: r.total,
      });
    } catch (thrown) {
      return err(toError(thrown, PROBE_KIND_BY_SLUG));
    }
  }

  async function pullBytes(
    handle: string,
    cap: number,
    provisionalCap: boolean,
    context: OperationContext,
  ): Promise<Result<Uint8Array>> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let position = 0;
    let ended = false;
    // The first read gets cold-start patience; later reads must hit
    // already-committed bytes — a parked read is an unfetched hole,
    // and chasing holes steals the pump's demand priority from the
    // element mid-track.
    let timeoutMs = firstReadTimeoutMs;
    // `lf-*` handles are element-attached files — bytes come from a
    // grant-gated ranged `local:read`, not the seam. Both legs share
    // the deadline machinery; a local read parks only on slow disk,
    // never on a demand hole, so the park bound is decorative there.
    const localUri = deps.localUriFor?.(handle) ?? null;
    const localRead = deps.localRead;
    const read =
      localUri !== null && localRead !== undefined
        ? () => localRead({ uri: localUri, position, maxLen: READ_CHUNK })
        : () => deps.stream.read({ handle, position, maxLen: READ_CHUNK });
    // `<=` so an exactly-`cap` stream still reaches its EOF read.
    while (total <= cap) {
      const chunk = await readWithDeadline(read, timeoutMs, context);
      // The park bound exists to stop hole-chasing on the seam — a
      // local:read parks only on slow disk, so local reads keep the
      // cold-start patience every round.
      timeoutMs = localUri !== null ? firstReadTimeoutMs : parkTimeoutMs;
      if (!chunk.ok) {
        // A park-timeout is not a failure worth caching hard —
        // 'unavailable' reads as "not buffered yet" to the caller.
        if (chunk.error.kind === 'timeout') {
          return err(
            appError('unavailable', 'stream bytes not yet buffered'),
          );
        }
        return chunk;
      }
      const bytes = fromBase64(chunk.value.data);
      if (bytes.byteLength === 0) {
        ended = true;
        break;
      }
      total += bytes.byteLength;
      chunks.push(bytes);
      position += bytes.byteLength;
    }
    if (!ended) {
      // 'not-applicable' marks the tighter unknown-duration bound —
      // not terminal, unlike the PCM ceiling or a known-long track:
      // a durationMs update deserves one pull at the real cap.
      return err(
        appError(
          provisionalCap ? 'not-applicable' : 'budget-exceeded',
          'stream too large for peak extraction',
        ),
      );
    }
    return ok(concatBytes(chunks));
  }

  /** Decode + gate + bucket a contiguous file — the legacy path's
   * shared tail for local files and structural fallbacks. */
  async function decodeWhole(
    bytes: Uint8Array,
  ): Promise<Result<readonly WaveformPeak[]>> {
    const decoded = await decode(bytes).then(
      (audio) => ok(audio),
      () => err(appError('invalid-response', 'audio decode failed')),
    );
    if (!decoded.ok) {
      return decoded;
    }
    const pcmBytes =
      decoded.value.length * decoded.value.numberOfChannels * 4;
    if (pcmBytes > maxPcmBytes) {
      return err(
        appError('budget-exceeded', 'decoded audio too large for peaks'),
      );
    }
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.value.numberOfChannels; c++) {
      channels.push(decoded.value.getChannelData(c));
    }
    return ok(peaksFromChannels(channels, PEAKS_RESOLUTION));
  }

  /**
   * Decode one probe buffer assembled as `init + segment window`:
   * WebM accepts init followed by any cluster, so a synthetic doc of
   * [init, cluster] decodes just that cluster's PCM. A decode failure
   * marks the sample unusable — its buckets stay unmeasured, never
   * fabricated.
   */
  async function decodeSample(
    assembled: Uint8Array,
  ): Promise<DecodedAudio | null> {
    const decoded = await decode(assembled).then(
      (audio) => ok(audio),
      () => err(appError('invalid-response', 'audio decode failed')),
    );
    if (!decoded.ok) {
      return null;
    }
    const pcmBytes =
      decoded.value.length * decoded.value.numberOfChannels * 4;
    if (pcmBytes > maxPcmBytes) {
      return null;
    }
    return decoded.value;
  }

  /**
   * Sampled WebM extraction: the head probe hands over init + (usually)
   * the first clusters; a tail probe finds Cues when the head didn't
   * carry them; per-sample probes fetch one cluster window each and a
   * synthetic `init + cluster` doc decodes it off-thread. Bucket
   * positions come from cue times or the cluster's own Timecode
   * element — never a guessed offset.
   */
  async function sampledWebm(
    head: Uint8Array,
    total: number | null,
    segDataStart: number,
    scaleMs: number,
    boundaries: readonly number[],
    headCues: readonly WebmCue[],
    request: { durationMs: number | null },
    context: OperationContext,
    handle: string,
    onCoarse: ((peaks: readonly WaveformPeak[]) => void) | undefined,
  ): Promise<Result<readonly WaveformPeak[] | null>> {
    const initEnd = boundaries[0];
    if (initEnd === undefined || initEnd <= 0) {
      return ok(null); // no cluster boundary in the head — legacy path
    }
    const init = head.subarray(0, initEnd);

    // The Cues index rides the head on some muxes; otherwise one tail
    // probe finds it (it's the standard tail element). No index at all
    // degrades to uniform byte probes + per-cluster timecodes.
    let cues = headCues;
    if (cues.length === 0 && total !== null && total > TAIL_PROBE_BYTES) {
      const tail = await probe(
        handle,
        total - TAIL_PROBE_BYTES,
        TAIL_PROBE_BYTES,
        true,
        context,
      );
      if (tail.ok && tail.value.bytes !== null) {
        cues = webmCuesIn(tail.value.bytes, segDataStart, scaleMs);
      }
    }

    // The duration map: declared duration wins; otherwise the furthest
    // measured edge grows the estimate as samples land — a late
    // durationMs re-pull reuses the now-committed extents for free.
    let totalMs = request.durationMs ?? 0;
    const sparse: SparseWindows = new Array<PeakWindow | null>(
      PEAKS_RESOLUTION,
    ).fill(null);
    const measured = (): number =>
      sparse.reduce((n, w) => n + (w === null ? 0 : 1), 0);

    const apply = async (
      assembled: Uint8Array,
      mediaMs: number,
    ): Promise<boolean> => {
      const audio = await decodeSample(assembled);
      if (audio === null || audio.sampleRate <= 0) {
        return false;
      }
      const channels: Float32Array[] = [];
      for (let c = 0; c < audio.numberOfChannels; c++) {
        channels.push(audio.getChannelData(c));
      }
      const pcmMs = (audio.length / audio.sampleRate) * 1000;
      totalMs = Math.max(totalMs, mediaMs + pcmMs);
      mergeSample(sparse, mediaMs, channels, pcmMs, totalMs);
      return true;
    };

    // Free coverage: the head already carries the first complete
    // clusters — decode them in one assembled doc (they're contiguous
    // from cluster 0, so the PCM maps to [tc0, tc0 + pcmMs]).
    let seeded = false;
    if (boundaries.length > 0) {
      const last = boundaries[boundaries.length - 1]!;
      const end = webmClusterEnd(head, last);
      const tc0 = webmClusterTimecode(head, boundaries[0]!, scaleMs);
      if (end > initEnd && tc0 !== null) {
        seeded = await apply(head.subarray(0, end), tc0);
      }
    }

    // Sample targets: cue-keyed when the index exists (byte-exact
    // cluster starts), else a uniform byte grid resynced per probe.
    const positions: { byte: number; mediaMs: number | null }[] = [];
    if (cues.length > 0) {
      const wanted = coarseProbes + refineProbes;
      const stride = Math.max(1, Math.floor(cues.length / wanted));
      for (let i = 0; i < cues.length && positions.length < wanted; i += stride) {
        const cue = cues[i]!;
        // A cue landing inside the head's already-committed span is
        // still probed — the seam serves committed extents for free,
        // and the assemble+decode cost is the real spend either way.
        positions.push({ byte: cue.byte, mediaMs: cue.mediaMs });
      }
    } else if (total !== null && totalMs > 0) {
      const spanStart = segDataStart;
      const wanted = coarseProbes + refineProbes;
      for (let i = 0; i < wanted; i++) {
        const byte = Math.floor(
          spanStart + ((total - spanStart) * (i + 0.5)) / wanted,
        );
        positions.push({ byte, mediaMs: null });
      }
    }
    if (positions.length === 0 && !seeded) {
      return ok(null); // nowhere honest to sample — legacy path
    }

    let next = 0;
    let probed = 0;
    let coarseSent = false;
    const probeOne = async (): Promise<void> => {
      while (next < positions.length) {
        if (context.signal.cancelled || now() > context.deadlineMs) {
          return;
        }
        const target = positions[next]!;
        next += 1;
        const r = await probe(
          handle,
          target.byte,
          sampleProbeBytes,
          true,
          context,
        );
        if (!r.ok || r.value.bytes === null || r.value.bytes.length === 0) {
          continue;
        }
        const buf = r.value.bytes;
        // Cue path lands on the cluster element; uniform probes resync
        // to the first header-shaped cluster in the window.
        const clusterAt =
          target.mediaMs !== null ? 0 : resyncScan(buf, 'webm');
        const end = clusterAt < 0 ? -1 : webmClusterEnd(buf, clusterAt);
        if (clusterAt < 0 || end === -1 || end <= clusterAt) {
          continue;
        }
        const mediaMs =
          target.mediaMs ??
          webmClusterTimecode(buf, clusterAt, scaleMs);
        if (mediaMs === null) {
          continue;
        }
        await apply(
          concatBytes([init, buf.subarray(clusterAt, end)]),
          mediaMs,
        );
        probed += 1;
        // Coarse boundary: once the first batch has landed enough
        // measured buckets, emit the filled profile — real bars in
        // the sub-200 ms window; the rest of the flight refines
        // under it without a visual pop.
        if (
          !coarseSent &&
          probed + (seeded ? 1 : 0) >=
            Math.max(2, Math.floor(coarseProbes / 2)) &&
          onCoarse !== undefined
        ) {
          coarseSent = true;
          onCoarse(normalizePeakWindows(fillSparseWindows(sparse)));
        }
      }
    };
    await Promise.all(
      Array.from({ length: PROBE_CONCURRENCY }, () => probeOne()),
    );

    if (context.signal.cancelled) {
      return err(appError('cancelled', 'peak extraction cancelled'));
    }
    if (measured() === 0) {
      // Every sample failed — the bytes aren't what the head claimed;
      // the whole-file pull may still decode. 'null' = fall back.
      return ok(null);
    }
    return ok(normalizePeakWindows(fillSparseWindows(sparse)));
  }

  return {
    async peaks(request, context) {
      if (
        request.durationMs !== null &&
        request.durationMs > maxDecodeMs
      ) {
        return err(
          appError('budget-exceeded', 'track too long for decorative peaks'),
        );
      }

      const localUri = deps.localUriFor?.(request.handle) ?? null;

      // ---- sampled path: webm over the probe seam --------------------
      // Local files and seam-less handles keep the legacy pull — disk
      // reads don't wait on a pump. A probeless `stream` (older shell)
      // also falls straight through.
      if (localUri === null && typeof deps.stream.probe === 'function') {
        const head = await probe(
          request.handle,
          0,
          headProbeBytes,
          true,
          context,
        );
        if (head.ok && head.value.bytes !== null && head.value.bytes.length > 0) {
          const carved = carve(head.value.bytes);
          const total = head.value.total;
          if (
            carved.kind === 'ok' &&
            carved.container === 'webm' &&
            carved.boundaries.length > 0 &&
            (total === null || total > sampledMinTotal)
          ) {
            const sampled = await sampledWebm(
              head.value.bytes,
              total,
              carved.segDataStart,
              carved.scaleMs,
              carved.boundaries,
              carved.cues,
              request,
              context,
              request.handle,
              request.onCoarse,
            );
            if (!sampled.ok) {
              return sampled;
            }
            if (sampled.value !== null) {
              return ok(sampled.value);
            }
            // sampled.value === null → structural fallback below.
          }
        } else if (!head.ok) {
          // The head probe's own failure (dead handle, cooldown) is
          // the honest result — the fallback pull would hit the same
          // session state with worse accounting.
          if (
            head.error.kind === 'released' ||
            head.error.kind === 'cancelled'
          ) {
            return err(head.error);
          }
        }
      }

      // ---- legacy whole-file path ------------------------------------
      const cap =
        request.durationMs === null
          ? Math.min(maxBytes, maxUnknownDurationBytes)
          : maxBytes;
      const bytes = await pullBytes(
        request.handle,
        cap,
        request.durationMs === null,
        context,
      );
      if (!bytes.ok) {
        return bytes;
      }
      return decodeWhole(bytes.value);
    },
  };
}
