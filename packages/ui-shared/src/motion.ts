// The play/pause morph's quad end-shapes — one source for the web and
// native motion ports. The path serializer + interpolators stay
// per-platform: on native they run inside reanimated worklets, which
// serialize imported constants into their closure but cannot call
// non-workletized imports, so only the data can be shared.
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
