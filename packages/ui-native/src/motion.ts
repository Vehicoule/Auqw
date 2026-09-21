export type Quad = {
  readonly xs: readonly [number, number, number, number];
  readonly ys: readonly [number, number, number, number];
};

export const PLAY_LEFT: Quad = {
  xs: [8, 12, 8, 8],
  ys: [5, 8.5, 20, 5],
};

export const PLAY_RIGHT: Quad = {
  xs: [12, 19, 12, 12],
  ys: [8.5, 12, 15.5, 8.5],
};

export const PAUSE_LEFT: Quad = {
  xs: [7.4, 10.8, 10.8, 7.4],
  ys: [5, 5, 19, 19],
};

export const PAUSE_RIGHT: Quad = {
  xs: [13.2, 16.6, 16.6, 13.2],
  ys: [5, 5, 19, 19],
};

function clamp01(value: number): number {
  'worklet';

  return Math.min(1, Math.max(0, value));
}

function lerp(from: number, to: number, t: number): number {
  'worklet';

  return from + (to - from) * t;
}

export function morphQuad(from: Quad, to: Quad, amount: number): Quad {
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

export type ProgressPathState = {
  readonly dashLength: number;
  readonly dashOffset: number;
  readonly opacity: number;
};

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
