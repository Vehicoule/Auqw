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
 * Waveform-peak extraction for the Stage seek bar. Peaks are
 * decoration, never semantics: callers render the seeded amplitude
 * pattern until this resolves and on any failure. Implementations
 * return one normalized amplitude per bucket at the shared canonical
 * resolution (`PEAKS_RESOLUTION` in ui-shared); renderers resample to
 * their bar count.
 */
export interface PeaksPort {
  peaks(
    request: PeaksRequest,
    context: OperationContext,
  ): Promise<Result<readonly number[]>>;
}
