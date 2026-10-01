import {
  PAUSE_LEFT,
  PAUSE_RIGHT,
  PLAY_LEFT,
  PLAY_RIGHT,
  type Quad,
} from '@auqw/ui-shared';
export {
  PLAY_LEFT,
  PLAY_RIGHT,
  PAUSE_LEFT,
  PAUSE_RIGHT,
  type Quad,
} from '@auqw/ui-shared';
import type { DownloadIconState, ProgressPathState } from '@auqw/ui-shared';

// The functions below are worklets: they run on reanimated's UI
// runtime inside useDerivedValue/useAnimatedProps, which cannot call
// non-workletized cross-package imports — so the math stays here as a
// twin of @auqw/ui-shared's pure motion helpers rather than being
// imported from it (same constraint progress.tsx's worklet twins
// document). The shared ProgressPathState type above is safe to
// import: types are erased before the worklet transform runs.

export function clamp01(value: number): number {
  'worklet';

  return Math.min(1, Math.max(0, value));
}

function lerp(from: number, to: number, t: number): number {
  'worklet';

  return from + (to - from) * t;
}

function morphQuad(from: Quad, to: Quad, amount: number): Quad {
  'worklet';

  const t = clamp01(amount);
  return {
    xs: [
      lerp(from.xs[0], to.xs[0], t),
      lerp(from.xs[1], to.xs[1], t),
      lerp(from.xs[2], to.xs[2], t),
      lerp(from.xs[3], to.xs[3], t),
    ],
    ys: [
      lerp(from.ys[0], to.ys[0], t),
      lerp(from.ys[1], to.ys[1], t),
      lerp(from.ys[2], to.ys[2], t),
      lerp(from.ys[3], to.ys[3], t),
    ],
  };
}

export function quadPath(quad: Quad): string {
  'worklet';

  return `M${quad.xs[0]} ${quad.ys[0]}L${quad.xs[1]} ${quad.ys[1]}L${quad.xs[2]} ${quad.ys[2]}L${quad.xs[3]} ${quad.ys[3]}Z`;
}

export function morphPlayPause(amount: number): {
  readonly left: Quad;
  readonly right: Quad;
} {
  'worklet';

  return {
    left: morphQuad(PLAY_LEFT, PAUSE_LEFT, amount),
    right: morphQuad(PLAY_RIGHT, PAUSE_RIGHT, amount),
  };
}

export function progressPathState(
  progress: number,
  pathLength: number,
): ProgressPathState {
  'worklet';

  const amount = clamp01(progress);
  return {
    dashLength: pathLength,
    dashOffset: (1 - amount) * pathLength,
    opacity: amount > 0 ? 1 : 0,
  };
}

// ---- download icon state machine -------------------------------------
// Phase -> channel targets: `morph` crossfades arrow to ring, `draw`
// sweeps the ring + terminal mark, `spin` loops the indeterminate arc
// only while the chip is busy. Plain data (no closures) so it serializes
// into worklet closures safely.

export const DOWNLOAD_TARGETS = {
  idle: { morph: 0, draw: 0, spin: false },
  busy: { morph: 1, draw: 0, spin: true },
  done: { morph: 1, draw: 1, spin: false },
  error: { morph: 1, draw: 1, spin: false },
} as const satisfies Record<
  DownloadIconState,
  { morph: number; draw: number; spin: boolean }
>;

/** The terminal mark waits for the ring to be mostly closed, then draws
    inside the same `draw` sweep. */
export function markStrokeProgress(draw: number): number {
  'worklet';

  return clamp01((draw - 0.35) / 0.65);
}

/** The warn dot pops once the stroke has finished. */
export function markDotProgress(draw: number): number {
  'worklet';

  return clamp01((draw - 0.75) / 0.25);
}
