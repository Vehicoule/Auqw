/**
 * Waveform peak extraction and resampling for the Stage's
 * waveform-style seek.
 *
 * The seek renders decoration only — a plain progress bar in
 * waveform clothing — so these helpers model a display profile, not
 * an analysis result: `peaksFromChannels` reduces decoded PCM to a
 * canonical-resolution envelope and `resamplePeaks` maps that envelope
 * onto whatever bar count the layout produces. A zeroed profile is
 * the honest rendering of silence or empty input; callers falling
 * back to the seeded pattern (`waveformAmplitudes`) do so on null
 * input, not on zeros.
 */

/** Canonical peak resolution — one float per envelope bucket. */
export const PEAKS_RESOLUTION = 256;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Reduces per-channel PCM samples (decoded audio, normalized float
 * data) to `count` absolute-amplitude buckets, then normalizes by the
 * loudest bucket and applies a gentle square-root lift so quiet
 * passages stay readable against the loud ones.
 *
 * @param channels one Float32Array per decoded channel
 * @param count    bucket count of the output profile
 */
export function peaksFromChannels(
  channels: readonly Float32Array[],
  count: number,
): readonly number[] {
  if (!Number.isFinite(count) || count <= 0) {
    return [];
  }
  const out = new Array<number>(count).fill(0);
  const frames = channels.reduce(
    (min, ch) => Math.min(min, ch.length),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(frames) || frames === 0) {
    return out;
  }
  const step = frames / count;
  let loudest = 0;
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * step);
    const to = Math.min(frames, Math.max(Math.floor((i + 1) * step), from + 1));
    let peak = 0;
    for (const ch of channels) {
      for (let s = from; s < to; s++) {
        const amp = Math.abs(ch[s]!);
        if (amp > peak) peak = amp;
      }
    }
    out[i] = peak;
    if (peak > loudest) loudest = peak;
  }
  if (loudest <= 0) {
    return out;
  }
  // Normalized by the loudest bucket, sqrt-lifted: a bucket at 25% of
  // peak amplitude still renders a half-height bar.
  for (let i = 0; i < count; i++) {
    out[i] = clamp01(Math.sqrt(out[i]! / loudest));
  }
  return out;
}

/**
 * Maps a canonical-resolution peak profile onto an arbitrary bar
 * count. Downsampled buckets take the max of their source range (so
 * real transients survive aggregation); upsampled positions linearly
 * interpolate. Input shorter than one bucket or empty yields zeros —
 * the caller decides whether zeros or the seeded pattern is the right
 * fallback.
 */
export function resamplePeaks(
  peaks: readonly number[],
  count: number,
): readonly number[] {
  if (!Number.isFinite(count) || count <= 0) {
    return [];
  }
  const source = peaks.length;
  if (source === 0) {
    return new Array<number>(count).fill(0);
  }
  const out = new Array<number>(count);
  if (source >= count) {
    for (let i = 0; i < count; i++) {
      const from = Math.floor((i * source) / count);
      const to = Math.max(from + 1, Math.floor(((i + 1) * source) / count));
      let peak = 0;
      for (let s = from; s < to && s < source; s++) {
        if (peaks[s]! > peak) peak = peaks[s]!;
      }
      out[i] = peak;
    }
    return out;
  }
  for (let i = 0; i < count; i++) {
    const pos = count > 1 ? (i * (source - 1)) / (count - 1) : 0;
    const lo = Math.floor(pos);
    const hi = Math.min(source - 1, lo + 1);
    const frac = pos - lo;
    out[i] = peaks[lo]! + (peaks[hi]! - peaks[lo]!) * frac;
  }
  return out;
}
