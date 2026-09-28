// The play/pause morph's quad end-shapes plus the pure path
// serializer and progress-dash model — one source for the web and
// native motion ports. On native these run inside reanimated
// worklets, which serialize imported constants into their closure
// but cannot call non-workletized cross-package imports, so
// ui-native keeps worklet twins of the two functions below; only the
// shared type + the web path consume this copy.
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

export function quadPath(quad: Quad): string {
  return `M${quad.xs[0]} ${quad.ys[0]}L${quad.xs[1]} ${quad.ys[1]}L${quad.xs[2]} ${quad.ys[2]}L${quad.xs[3]} ${quad.ys[3]}Z`;
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
  const amount = Math.min(1, Math.max(0, progress));
  return {
    dashLength: pathLength,
    dashOffset: (1 - amount) * pathLength,
    opacity: amount > 0 ? 1 : 0,
  };
}
