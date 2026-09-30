import type { OperationContext } from '../cancellation.ts';
import type { Result } from '../errors.ts';

/**
 * Source descriptor for a waveform peak extraction. The handle is the
 * stream session's read handle — the same positional-pull handle the
 * player uses, so implementations read bytes off it rather than
 * opening a second decode path.
 */
export type PeaksRequest = {
  readonly handle: string;
  readonly durationMs: number | null;
};

/**
 * Decorative extraction bound shared by every `PeaksPort`: decoded
 * PCM for a track past this is a renderer-paid spike, so ports refuse
 * (or the tracker cancels) — the placeholder baseline stays.
 * Exported so the port and the tracker apply the same bound.
 */
export const PEAKS_MAX_DECODE_MS = 8 * 60 * 1000;

/**
 * One normalized asymmetric waveform bar: `up` is the upper
 * excursion magnitude and `down` the lower, each in 0..1 after the
 * shared percentile+gamma normalization (`normalizePeakWindows` in
 * ui-shared). `up` and `down` come from DIFFERENT source energy —
 * left/right channels on stereo material, positive/negative
 * half-wave energy on mono — so real bars are not mirrors.
 */
export type WaveformPeak = {
  readonly up: number;
  readonly down: number;
};

/**
 * Waveform-peak extraction for the Stage seek bar. Peaks are
 * decoration, never semantics: callers render a flat placeholder
 * baseline until this resolves and on any failure. Implementations
 * return one normalized pair per bucket at the shared canonical
 * resolution (`PEAKS_RESOLUTION` in ui-shared); renderers resample to
 * their bar count.
 */
export interface PeaksPort {
  peaks(
    request: PeaksRequest,
    context: OperationContext,
  ): Promise<Result<readonly WaveformPeak[]>>;
}
