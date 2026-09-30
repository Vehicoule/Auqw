// Waveform bar geometry shared by the native and web progress
// controls. Renderers prefer measured pairs (`peaks.ts`) when a
// `PeaksPort` supplies them; while extraction is pending or after
// failure they render `waveformPlaceholder` — a flat baseline that
// claims nothing, rather than a fabricated amplitude pattern the
// real measurement would visibly replace.

import type { WaveformPeak } from '@auqw/application';

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The pending/failure placeholder: every bar at zero amplitude, so
 * it renders at `waveformBarExtent`'s minimum — a thin baseline
 * that reads as 'no measurement yet' instead of a fake waveform.
 */
export function waveformPlaceholder(
  count: number,
): readonly WaveformPeak[] {
  if (count <= 0 || !Number.isFinite(count)) {
    return [];
  }
  // Distinct objects — a shared instance would let one caller's
  // mutation rewrite every bar.
  return Array.from({ length: count }, () => ({ up: 0, down: 0 }));
}

export type WaveformBarLayout = {
  readonly count: number;
  readonly step: number;
  readonly barWidth: number;
  /** Bar center x positions in pixels. */
  readonly xs: readonly number[];
};

export function waveformBarLayout(
  width: number,
  barWidth = 3,
  gap = 2.5,
): WaveformBarLayout {
  const step = barWidth + gap;
  // n bars need n·barWidth + (n−1)·gap ≤ width.
  const count = Math.max(0, Math.floor((width + gap) / step));
  if (count <= 0) {
    return { count: 0, step, barWidth, xs: [] };
  }
  const leftover = width - (count * step - gap);
  const xs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    xs.push(leftover / 2 + i * step + barWidth / 2);
  }
  return { count, step, barWidth, xs };
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export function waveformBarExtent(
  amplitude: number,
  maxExtent: number,
  minExtent = 2.4,
  bloom = 1,
): number {
  const eased = Number.isFinite(bloom)
    ? easeOutCubic(clamp01(bloom))
    : 0;
  return minExtent + (maxExtent - minExtent) * amplitude * eased;
}
