import { appError, err, ok, PEAKS_MAX_DECODE_MS } from '@auqw/application';
import type {
  AppError,
  ErrorKind,
  OperationContext,
  PeaksPort,
  Result,
} from '@auqw/application';
import { PEAKS_RESOLUTION, peaksFromChannels } from '@auqw/ui-shared';
import { isRecord } from '../shared/check.ts';
import type { StreamClient } from './web-player.ts';

/** Minimal decoded-audio surface — what `decodeAudioData` returns. */
export type DecodedAudio = {
  readonly numberOfChannels: number;
  /** Frame count — AudioBuffer.length. */
  readonly length: number;
  getChannelData(index: number): Float32Array;
};

/** Decode container bytes to PCM — tests inject a fake. */
export type PeaksDecoder = (bytes: Uint8Array) => Promise<DecodedAudio>;

const READ_CHUNK = 1024 * 1024; // matches the stream:read MAX_READ_LEN
/** Decoration, not analysis — never pull more than this for a bar row. */
const MAX_PEAK_BYTES = 24 * 1024 * 1024;
/**
 * `decodeAudioData` expands the whole compressed buffer to per-channel
 * PCM before peak bucketing: 8 min of stereo 48 kHz is ~184 MiB of
 * Float32s. That's the transient spike the renderer pays for a bar
 * row — tracks longer than this keep the seeded pattern. The shared
 * contract constant (`PEAKS_MAX_DECODE_MS`) is the same bound the
 * tracker applies when a late duration lands mid-sweep.
 */
const MAX_DECODE_MS = PEAKS_MAX_DECODE_MS;
/**
 * Lowest plausible music bitrate — the bound for streams whose
 * `durationMs` is unknown. At this floor, this many encoded bytes
 * can't decode past the 8-minute PCM gate; anything denser is shorter.
 */
const BITRATE_FLOOR_BPS = 64_000;
const MAX_UNKNOWN_DURATION_BYTES =
  (MAX_DECODE_MS / 1000) * (BITRATE_FLOOR_BPS / 8);
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
 * for a decoration. Abort instead; the seeded pattern stays.
 */
const PARK_TIMEOUT_MS = 400;

const DEAD_HANDLE: ReadonlySet<string> = new Set([
  'released',
  'evicted',
  'expired',
  'superseded',
  'not-found',
]);

function toError(thrown: unknown): AppError {
  if (isRecord(thrown) && typeof thrown['kind'] === 'string') {
    const slug = thrown['kind'];
    const kind: ErrorKind =
      slug === 'cancelled'
        ? 'cancelled'
        : DEAD_HANDLE.has(slug)
          ? 'released'
          : slug === 'invalid-request' ||
              slug === 'invalid-response' ||
              slug === 'invalid-message'
            ? 'invalid-response'
            : 'transient';
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

/**
 * Desktop/web `PeaksPort`: pull bytes off the live stream handle and
 * decode them with WebAudio, then bucket to the canonical resolution.
 *
 * The handle is borrowed, never owned — the port only ever calls
 * positional `stream:read`, which touches `read_pos` upward-only:
 * `stream:open` re-anchors the session's speculative fill (`attach`
 * resets `read_pos` on every call, so opening at 0 would rewind a
 * mid-track pump's read-ahead window), and `stream:close`/`release`
 * would detach the session and wake every parked reader (the MSE
 * pump) as `cancelled`.
 *
 * Extraction is opportunistic: reads beyond the first must hit bytes
 * already committed, because a `read` parked on a hole queues demand
 * that serves minimum-position-first — chasing an unfetched gap would
 * starve the element's own mid-track demand for a decoration. The
 * seeded pattern stays whenever a pull outruns the stream's fill.
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
    // `<=` so an exactly-`cap` stream still reaches its EOF read.
    while (total <= cap) {
      const chunk =
        localUri !== null && localRead !== undefined
          ? await readWithDeadline(
              () =>
                localRead({
                  uri: localUri,
                  position,
                  maxLen: READ_CHUNK,
                }),
              timeoutMs,
              context,
            )
          : await readWithDeadline(
              () =>
                deps.stream.read({
                  handle,
                  position,
                  maxLen: READ_CHUNK,
                }),
              timeoutMs,
              context,
            );
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
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return ok(out);
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
      // Unknown duration can't gate on time — bound the encoded pull
      // by the lowest plausible bitrate instead, so decoded PCM stays
      // under the same ceiling the duration gate enforces.
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
      // A decode failure means the bytes weren't audio as expected —
      // `invalid-response`, and the renderer keeps the seeded pattern.
      const decoded = await decode(bytes.value).then(
        (audio) => ok(audio),
        () => err(appError('invalid-response', 'audio decode failed')),
      );
      if (!decoded.ok) {
        return decoded;
      }
      // Belt for the gates above: a container that decodes wider than
      // its duration suggests (multichannel, high sample rate, a lying
      // header) stops here rather than bucketing a giant buffer. This
      // is 'budget-exceeded', not 'not-applicable' — the PCM ceiling is
      // duration-independent, so the failure is terminal even when
      // durationMs arrived late.
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
    },
  };
}
