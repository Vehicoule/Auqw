import type { WaveformPeak } from '@auqw/application';

/**
 * Waveform peak extraction and resampling for the Stage's
 * waveform-style seek.
 *
 * The seek renders decoration only — a plain progress bar in
 * waveform clothing — so these helpers model a display profile, not
 * an analysis result. Extractors reduce decoded PCM to raw
 * per-window magnitudes (`PeakWindow`), `normalizePeakWindows`
 * applies the shared 5th–95th percentile normalization plus the
 * gamma lift, and `resamplePeaks` maps that profile onto whatever
 * bar count the layout produces. A zeroed profile is the honest
 * rendering of silence or empty input; callers falling back to the
 * seeded pattern (`waveformPeaks` in waveform.ts) do so on null
 * input, not on zeros.
 */
export type { WaveformPeak } from '@auqw/application';

/** Canonical peak resolution — one pair per envelope bucket. */
export const PEAKS_RESOLUTION = 256;

/**
 * Raw (unnormalized) per-window magnitudes — the currency extractors
 * emit. `up`/`down` are root-mean-square energies of the window's
 * two asymmetry sources: stereo (or wider) splits channel parity —
 * even channels feed `up`, odd feed `down` — while mono splits the
 * half-waves: positive samples feed `up`, negative feed `down`.
 * Values are PCM-domain (≥0); `normalizePeakWindows` maps them onto
 * the display range.
 */
export type PeakWindow = {
  readonly up: number;
  readonly down: number;
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Compressor display floor — normalized values below this still draw
 * a stub bar so the waveform reads continuous through quiet passages.
 */
const PEAK_FLOOR = 0.05;
/** Loudness shaping — darkens mid amplitudes so transients contrast. */
const PEAK_GAMMA = 1.2;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(((sorted.length - 1) * p) / 100)),
  );
  return sorted[i]!;
}

/**
 * Maps raw window magnitudes onto normalized display pairs. One
 * shared scale serves both sides — normalizing `up` and `down`
 * independently would erase the asymmetry the pair exists to carry.
 * The scale is the 5th–95th percentile band of all magnitudes: bars
 * past p95 saturate, bars under p5 sit on the floor, and the spread
 * between keeps dynamics readable instead of the old loudest-bucket
 * normalize that rendered everything loud. When the band collapses
 * onto the bulk — a sparse profile like a single transient over a
 * flat bed — the top anchor relaxes toward half the true max so the
 * bed still reads quiet and the transient still owns its bar.
 * All-zero input yields all-zero output.
 */
export function normalizePeakWindows(
  windows: readonly PeakWindow[],
): readonly WaveformPeak[] {
  if (windows.length === 0) {
    return [];
  }
  const mags = windows.flatMap((w) => [w.up, w.down]).sort((a, b) => a - b);
  const peak = mags[mags.length - 1]!;
  if (peak <= 0) {
    // A wholly silent profile is honest zeros, not floor stubs.
    return windows.map(() => ({ up: 0, down: 0 }));
  }
  const lo = percentile(mags, 5);
  const hi = Math.max(percentile(mags, 95), lo, peak * 0.5);
  const span = hi - lo;
  const shape = (v: number): number => {
    if (v <= 0) {
      return 0;
    }
    const t = span > 1e-9 ? (v - lo) / span : 1;
    return Math.pow(Math.min(1, Math.max(PEAK_FLOOR, t)), PEAK_GAMMA);
  };
  return windows.map((w) => ({ up: shape(w.up), down: shape(w.down) }));
}

/**
 * Reduces per-channel PCM samples (decoded audio, normalized float
 * data) to `count` raw window buckets. With two or more channels the
 * pair splits channel parity (evens → `up`, odds → `down`); a single
 * channel splits by sign (positive samples → `up`, negative →
 * `down`). Either way both arms come from real signal energy, so
 * the rendered bars are asymmetric and honest.
 *
 * @param channels one Float32Array per decoded channel
 * @param count    bucket count of the output profile
 */
export function peakWindowsFromChannels(
  channels: readonly Float32Array[],
  count: number,
): readonly PeakWindow[] {
  if (!Number.isFinite(count) || count <= 0) {
    return [];
  }
  const frames = channels.reduce(
    (min, ch) => Math.min(min, ch.length),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(frames) || frames === 0 || channels.length === 0) {
    return Array.from({ length: count }, () => ({ up: 0, down: 0 }));
  }
  const out = new Array<PeakWindow>(count);
  const step = frames / count;
  const stereo = channels.length >= 2;
  for (let i = 0; i < count; i += 1) {
    const from = Math.floor(i * step);
    const to = Math.min(frames, Math.max(Math.floor((i + 1) * step), from + 1));
    let upSq = 0;
    let downSq = 0;
    let upN = 0;
    let downN = 0;
    for (let c = 0; c < (stereo ? channels.length : 1); c += 1) {
      const ch = channels[c]!;
      const even = c % 2 === 0;
      for (let s = from; s < to; s++) {
        const v = ch[s]!;
        if (stereo ? even : v >= 0) {
          upSq += v * v;
          upN += 1;
        } else {
          downSq += v * v;
          downN += 1;
        }
      }
    }
    out[i] = {
      up: upN > 0 ? Math.sqrt(upSq / upN) : 0,
      down: downN > 0 ? Math.sqrt(downSq / downN) : 0,
    };
  }
  return out;
}

/**
 * Decoded PCM → normalized display pairs — the composition desktop's
 * extractor needs; mobile's adapter instead receives raw windows off
 * the native extractor and calls `normalizePeakWindows` itself.
 */
export function peaksFromChannels(
  channels: readonly Float32Array[],
  count: number,
): readonly WaveformPeak[] {
  return normalizePeakWindows(peakWindowsFromChannels(channels, count));
}

/**
 * Maps a canonical-resolution peak profile onto an arbitrary bar
 * count. Downsampled buckets take the per-side max of their source
 * range (so real transients survive aggregation); upsampled
 * positions linearly interpolate each side. Input shorter than one
 * bucket or empty yields zeroed pairs — the caller decides whether
 * zeros or the seeded pattern is the right fallback.
 */
export function resamplePeaks(
  peaks: readonly WaveformPeak[],
  count: number,
): readonly WaveformPeak[] {
  if (!Number.isFinite(count) || count <= 0) {
    return [];
  }
  const source = peaks.length;
  if (source === 0) {
    return new Array<WaveformPeak>(count).fill({ up: 0, down: 0 });
  }
  const out = new Array<WaveformPeak>(count);
  if (source >= count) {
    for (let i = 0; i < count; i += 1) {
      const from = Math.floor((i * source) / count);
      const to = Math.max(from + 1, Math.floor(((i + 1) * source) / count));
      let up = 0;
      let down = 0;
      for (let s = from; s < to && s < source; s++) {
        const p = peaks[s]!;
        if (p.up > up) up = p.up;
        if (p.down > down) down = p.down;
      }
      out[i] = { up, down };
    }
    return out;
  }
  for (let i = 0; i < count; i += 1) {
    const pos = count > 1 ? (i * (source - 1)) / (count - 1) : 0;
    const a = peaks[Math.floor(pos)]!;
    const b = peaks[Math.min(source - 1, Math.floor(pos) + 1)]!;
    const frac = pos - Math.floor(pos);
    out[i] = {
      up: a.up + (b.up - a.up) * frac,
      down: a.down + (b.down - a.down) * frac,
    };
  }
  return out;
}
