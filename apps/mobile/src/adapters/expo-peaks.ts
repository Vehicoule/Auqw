import { appError, err, ok, PEAKS_MAX_DECODE_MS } from '@auqw/application';
import type { PeaksPort, Result, WaveformPeak } from '@auqw/application';
import { normalizePeakWindows, PEAKS_RESOLUTION } from '@auqw/ui-shared';
import type { PeakWindow } from '@auqw/ui-shared';
import type { AuqwPeaksNative } from './auqw-expo-surface.ts';
import { nativeError } from './auqw-expo-surface.ts';

/** Decoration, not analysis — the same encoded pull cap as the desktop port. */
const MAX_PEAK_BYTES = 24 * 1024 * 1024;
/**
 * Lowest plausible music bitrate — the bound for streams whose
 * `durationMs` is unknown. At this floor, this many encoded bytes
 * can't decode past the 8-minute PCM gate; anything denser is shorter.
 * (Mirrors the desktop port's provisional cap.)
 */
const BITRATE_FLOOR_BPS = 64_000;
const MAX_UNKNOWN_DURATION_BYTES =
  (PEAKS_MAX_DECODE_MS / 1000) * (BITRATE_FLOOR_BPS / 8);

/**
 * Flat `[up, down]` pair list → `PeakWindow[]`, or `null` when the
 * shape is dishonest: wrong length is a partial decode (not a
 * waveform — caching one would stretch a truncated profile over the
 * whole track), and non-finite/negative magnitudes are malformed.
 * A genuinely silent decode still yields `count` zero pairs, which
 * passes and normalizes to honest zeros.
 */
function windowsFromFlat(flat: readonly number[]): PeakWindow[] | null {
  if (flat.length !== PEAKS_RESOLUTION * 2) {
    return null;
  }
  const windows: PeakWindow[] = [];
  for (let i = 0; i < PEAKS_RESOLUTION; i += 1) {
    const up = flat[i * 2];
    const down = flat[i * 2 + 1];
    if (
      up === undefined ||
      down === undefined ||
      !Number.isFinite(up) ||
      !Number.isFinite(down) ||
      up < 0 ||
      down < 0
    ) {
      return null;
    }
    windows.push({ up, down });
  }
  return windows;
}

/**
 * Android `PeaksPort` over the `auqw-expo` native extractor: the
 * Kotlin side borrows the playing stream's handle for positional
 * reads, decodes with MediaExtractor+MediaCodec, and returns raw
 * per-window RMS pairs — this adapter re-pairs them and runs the
 * shared `normalizePeakWindows` so both platforms produce the same
 * normalized contract. iOS has no decoder path: the seam methods
 * are absent there and every call surfaces 'unavailable', keeping
 * the placeholder baseline.
 */
export function createExpoPeaksPort(native: AuqwPeaksNative): PeaksPort {
  return {
    async peaks(request, context): Promise<Result<readonly WaveformPeak[]>> {
      const extract = native.waveformPeaks;
      const cancelNative = native.waveformPeaksCancel;
      if (extract === undefined || cancelNative === undefined) {
        return err(
          appError('unavailable', 'waveform peaks unavailable on this platform'),
        );
      }
      if (
        request.durationMs !== null &&
        request.durationMs > PEAKS_MAX_DECODE_MS
      ) {
        return err(
          appError('budget-exceeded', 'track too long for decorative peaks'),
        );
      }
      // Unknown duration can't gate on time — bound the encoded pull
      // by the lowest plausible bitrate instead, the same provisional
      // cap the desktop port applies.
      const provisional = request.durationMs === null;
      const cap = provisional
        ? Math.min(MAX_PEAK_BYTES, MAX_UNKNOWN_DURATION_BYTES)
        : MAX_PEAK_BYTES;
      const requestId = context.requestId;
      const remainingMs = context.deadlineMs - Date.now();
      if (remainingMs <= 0) {
        return err(appError('timeout', 'peak extraction deadline'));
      }
      const unsubscribe = context.signal.subscribe(() => {
        cancelNative(requestId);
      });
      // The caller's operation deadline is enforced here, not inside
      // the native sweep's own timeouts: expiry cancels the native job
      // and surfaces 'timeout', the same retryable kind the desktop
      // port reports when its read deadline lapses.
      let deadlineFired = false;
      const deadlineTimer = setTimeout(() => {
        deadlineFired = true;
        cancelNative(requestId);
      }, remainingMs);
      // A cancel can race a late native resolve — the caller's
      // signal wins over data that arrived after it fired.
      const settled = (): Result<never> | null =>
        context.signal.cancelled
          ? err(appError('cancelled', 'peak extraction cancelled'))
          : deadlineFired
            ? err(appError('timeout', 'peak extraction deadline'))
            : null;
      // Coarse relay — installed before the call so an early emit
      // isn't missed: the sampled sweep sends its measured profile
      // while refinement still runs, and the tracker draws it as the
      // first real bars. A settled/cancelled call stays silent, and
      // a coarse event that fails the same validation the final
      // result gets is ignored rather than drawn.
      const coarseSub =
        request.onCoarse === undefined ||
        native.addWaveformPeaksCoarseListener === undefined
          ? null
          : native.addWaveformPeaksCoarseListener((event) => {
              if (
                event.requestId !== requestId ||
                settled() !== null ||
                request.onCoarse === undefined
              ) {
                return;
              }
              const windows = windowsFromFlat(event.peaks);
              if (windows !== null) {
                request.onCoarse(normalizePeakWindows(windows));
              }
            });
      try {
        const flat = await extract(
          requestId,
          request.handle,
          PEAKS_RESOLUTION,
          cap,
          provisional,
        );
        const hit = settled();
        if (hit !== null) {
          return hit;
        }
        const windows = windowsFromFlat(flat);
        if (windows === null) {
          return err(
            appError(
              'invalid-response',
              'peak extractor returned a malformed profile',
            ),
          );
        }
        return ok(normalizePeakWindows(windows));
      } catch (thrown) {
        const hit = settled();
        if (hit !== null) {
          return hit;
        }
        return err(nativeError(thrown));
      } finally {
        coarseSub?.remove();
        unsubscribe();
        clearTimeout(deadlineTimer);
      }
    },
  };
}
