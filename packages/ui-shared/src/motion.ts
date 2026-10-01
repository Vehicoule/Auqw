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

export const PLAY_LEFT: Quad = { xs: [8, 12, 12, 8], ys: [5, 8.5, 15.5, 19] };
export const PLAY_RIGHT: Quad = { xs: [12, 19, 12, 12], ys: [8.5, 12, 15.5, 8.5] };
export const PAUSE_LEFT: Quad = { xs: [7.4, 10.8, 10.8, 7.4], ys: [5, 5, 19, 19] };
export const PAUSE_RIGHT: Quad = { xs: [13.2, 16.6, 16.6, 13.2], ys: [5, 5, 19, 19] };

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

// ---- animated-icon geometry ------------------------------------------
// One source for the icon state machines on both platforms. Constants
// are safe inside native worklets (serialized into the closure); the
// layer math stays platform-side — CSS classes on web, shared values
// on native — so no per-frame work ever reaches the JS thread.

/** The download chip's coarse visual phases — one ring icon morphs
    between them: arrow (idle) → indeterminate arc (busy) → circled
    check (done) / circled warn (error). */
export type DownloadIconState = 'idle' | 'busy' | 'done' | 'error';

/** Download glyph — identical to the `download` entry in each
    platform's GLYPHS table; the arrow layer of DownloadIcon. */
export const DOWNLOAD_ARROW_PATH = 'M12 4v11m0 0-4-4m4 4 4-4M4 19h16';

/** Indeterminate arc — r8.5, gap top-right like the `spinner` glyph. */
export const ICON_ARC_PATH = 'M20.5 12A8.5 8.5 0 1 1 12 3.5';

/** The terminal ring as a path (draw-on via stroke-dash). Length is the
    r8.5 circumference — used raw on native, normalized with
    `pathLength` on web. */
export const ICON_RING_PATH =
  'M12 3.5A8.5 8.5 0 1 1 12 20.5A8.5 8.5 0 1 1 12 3.5Z';
export const ICON_RING_LENGTH = 53.5;

/** Check + warn marks inside the r8.5 ring. */
export const CHECK_MINI_PATH = 'm8.6 12.5 2.5 2.5 4.7-5.3';
export const CHECK_MINI_LENGTH = 11;
export const WARN_MINI_LINE_PATH = 'M12 8.4v4.2';
export const WARN_MINI_LINE_LENGTH = 4.3;
export const WARN_MINI_DOT = { cx: 12, cy: 15.7, r: 1 } as const;

/** Full-size status marks — identical geometry to the `check` and
    `warn` GLYPHS, split so each piece can draw on. */
export const CHECK_DRAW_PATH = 'm5 12.5 4.5 4.5L19 7';
export const CHECK_DRAW_LENGTH = 21;
export const WARN_DRAW_TRIANGLE_PATH = 'M12 4 3 20h18z';
export const WARN_DRAW_TRIANGLE_LENGTH = 55;
export const WARN_DRAW_DETAIL_PATH = 'M12 10v4';
export const WARN_DRAW_DETAIL_LENGTH = 4.2;
export const WARN_DRAW_DOT = { cx: 12, cy: 17, r: 1 } as const;

/** `refresh` glyph — retry affordances used the `spinner` arc as a
    static stand-in; a real arrowhead reads as an action, not a busy
    state. */
export const REFRESH_PATH = 'M20 12a8 8 0 1 1-2.34-5.66M20 3.5v5.5h-5.5';

/** Chip → coarse icon phase: every busy chip spins the same arc;
    'stored' completes the ring; 'failed' draws the warn mark. */
export function downloadIconState(
  chip: import('./view-models.ts').DownloadChip,
): DownloadIconState {
  switch (chip) {
    case 'idle':
      return 'idle';
    case 'stored':
      return 'done';
    case 'failed':
      return 'error';
    default:
      return 'busy';
  }
}
