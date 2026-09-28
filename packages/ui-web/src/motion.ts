// Web motion is CSS: transitions live in styles.css against the
// --motion-* token values, and components only choose between the two
// end states. The play/pause morph therefore keeps just the quad end
// shapes + the path serializer (the interpolation itself is the
// browser's `d` path transition), and the ring progress keeps the same
// dash model the native ports share — all sourced from
// @auqw/ui-shared's motion module and re-exported here so in-package
// imports don't churn.
export {
  PLAY_LEFT,
  PLAY_RIGHT,
  PAUSE_LEFT,
  PAUSE_RIGHT,
  quadPath,
  progressPathState,
  type Quad,
  type ProgressPathState,
} from '@auqw/ui-shared';
