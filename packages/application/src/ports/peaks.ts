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
  /**
   * Fires at most once, when a coarse-but-real profile is ready
   * before the refined result lands: sampled extractors emit it
   * after their first probe round so the seek bar draws measured
   * bars in the sub-200ms window instead of holding the placeholder
   * for the full sweep. The promise still resolves the refined
   * profile — coarse output is real measured data, never a
   * fabricated-looking placeholder, and the final result always
   * supersedes it.
   */
  readonly onCoarse?: (peaks: readonly WaveformPeak[]) => void;
};

/**
 * Persistence for finished peak profiles, keyed by content identity
 * (the recording id, not an attempt — a re-prepared stream replays
 * the same audio, so attempt-keyed entries guaranteed cold repeats
 * on every retry). Implementations live wherever the app keeps
 * device-local caches; a `null` store keeps the tracker memory-only.
 */
export interface PeaksStore {
  /** Load the persisted profile for `recordingId`, if one exists. */
  load(recordingId: string): Promise<readonly WaveformPeak[] | null>;
  /** Persist a final (never coarse, never failed) profile. */
  save(recordingId: string, peaks: readonly WaveformPeak[]): Promise<void>;
}

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
