// Web motion is CSS: transitions live in styles.css against the
// --motion-* token values, and components only choose between the two
// end states. The play/pause morph therefore keeps just the quad end
// shapes + the path serializer (the interpolation itself is the
// browser's `d` path transition), and the ring progress keeps the same
// dash model the native ports share.
import type { Quad } from '@auqw/ui-shared';
export {
  PLAY_LEFT,
  PLAY_RIGHT,
  PAUSE_LEFT,
  PAUSE_RIGHT,
  type Quad,
} from '@auqw/ui-shared';

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
