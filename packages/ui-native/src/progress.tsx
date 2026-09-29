import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import type {
  AccessibilityActionEvent,
  LayoutChangeEvent,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import Svg, { ClipPath, Defs, G, Path, Rect } from 'react-native-svg';
import { useTheme } from './theme.tsx';
import { Artwork, Text } from './primitives.tsx';
import {
  formatClock,
  formatRemaining,
  resamplePeaks,
  t,
  waveformBarLayout,
  waveformPeaks,
} from '@auqw/ui-shared';
import type { WaveformPeak } from '@auqw/ui-shared';
import { progressPathState } from './motion';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

function useMeasuredWidth(initial: number): {
  readonly width: number;
  readonly onLayout: (e: LayoutChangeEvent) => void;
} {
  const [width, setWidth] = useState(initial);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) {
      setWidth(w);
    }
  }, []);
  return { width, onLayout };
}

function clearTimer(ref: {
  current: ReturnType<typeof setTimeout> | null;
}): void {
  if (ref.current !== null) {
    clearTimeout(ref.current);
    ref.current = null;
  }
}

export const SQUARED_RING_PATH =
  'M26 3 L38 3 Q49 3 49 14 L49 38 Q49 49 38 49 L14 49 Q3 49 3 38 L3 14 Q3 3 14 3 Z';
// Arc length of SQUARED_RING_PATH (quadrature over the four corners).
export const SQUARED_RING_LENGTH = 167.40917715109828;

// Worklet twins of the ui-shared helpers — reanimated can't workletize
// functions imported from another package, so the math is duplicated
// here in miniature.
function staggerW(progress: number, index: number, count: number): number {
  'worklet';
  if (count <= 0) {
    return 1;
  }
  const delay = (index / count) * 0.55;
  return Math.min(1, Math.max(0, (progress - delay) / (1 - delay)));
}

function barExtentW(
  amplitude: number,
  maxExtent: number,
  minExtent: number,
  bloom: number,
): number {
  'worklet';
  const t = Number.isFinite(bloom) ? Math.min(1, Math.max(0, bloom)) : 0;
  const eased = 1 - (1 - t) ** 3;
  return minExtent + (maxExtent - minExtent) * amplitude * eased;
}

function barsPathD(
  xs: readonly number[],
  ups: readonly number[],
  downs: readonly number[],
  idx: readonly number[],
  count: number,
  mid: number,
  maxExtent: number,
  bloom: number,
  maxX = Infinity,
): string {
  'worklet';
  let d = '';
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i] ?? 0;
    if (x > maxX) {
      continue;
    }
    const stagger = staggerW(bloom, idx[i] ?? i, count);
    const upExtent = barExtentW(ups[i] ?? 0, maxExtent, 2.4, stagger);
    const downExtent = barExtentW(downs[i] ?? 0, maxExtent, 2.4, stagger);
    d += `M${x.toFixed(2)} ${(mid - upExtent).toFixed(2)} L${x.toFixed(2)} ${(
      mid + downExtent
    ).toFixed(2)}`;
  }
  return d;
}

export type ArtworkRingProps = {
  readonly artworkUrl: string | null;
  readonly progress: number;
  readonly size?: number | undefined;
  readonly artworkSize?: number | undefined;
  readonly dimmed?: boolean | undefined;
  readonly style?: StyleProp<ViewStyle> | undefined;
};

export function ArtworkRing({
  artworkUrl,
  progress,
  size,
  artworkSize = 38,
  dimmed = false,
  style,
}: ArtworkRingProps) {
  const theme = useTheme();
  const box = size ?? theme.sizes.artworkRing;
  const clamped = Math.min(1, Math.max(0, progress));
  const animatedProgress = useSharedValue(clamped);
  const previousProgress = useRef(clamped);
  useEffect(() => {
    const delta = Math.abs(clamped - previousProgress.current);
    previousProgress.current = clamped;
    const duration =
      delta > 0.05 ? theme.motion.state : theme.motion.state * 5;
    animatedProgress.value = theme.reducedMotion
      ? clamped
      : withTiming(clamped, { duration });
  }, [
    animatedProgress,
    clamped,
    theme.motion.state,
    theme.reducedMotion,
  ]);
  const ringState = useDerivedValue(() =>
    progressPathState(animatedProgress.value, SQUARED_RING_LENGTH),
  );
  const progressProps = useAnimatedProps(() => ({
    strokeDasharray: `${ringState.value.dashLength} ${ringState.value.dashLength}`,
    strokeDashoffset: ringState.value.dashOffset,
    opacity: ringState.value.opacity,
  }));
  return (
    <View
      style={[{ width: box, height: box }, style]}
      accessible={false}
    >
      <Artwork
        url={artworkUrl}
        size={artworkSize}
        cornerRadius={7}
        dimmed={dimmed}
        style={{ position: 'absolute', top: (box - artworkSize) / 2, left: (box - artworkSize) / 2 }}
      />
      <Svg
        width={box}
        height={box}
        viewBox="0 0 52 52"
        style={{ position: 'absolute', top: 0, left: 0 }}
      >
        <Path
          d={SQUARED_RING_PATH}
          fill="none"
          stroke={theme.colors.fg18}
          strokeWidth={theme.strokes.hairline}
        />
        <AnimatedPath
          d={SQUARED_RING_PATH}
          fill="none"
          stroke={theme.colors.accent}
          strokeWidth={theme.strokes.progress}
          strokeLinecap="round"
          animatedProps={progressProps}
        />
      </Svg>
    </View>
  );
}

function useSeekGesture(
  durationMs: number | null,
  onSeek:
    | ((ms: number, expectedTrackKey?: string) => void)
    | undefined,
  onPreview: ((ms: number | null) => void) | undefined,
): {
  readonly gesture: ReturnType<typeof Gesture.Pan>;
  readonly onLayout: (e: LayoutChangeEvent) => void;
} {
  const { width, onLayout } = useMeasuredWidth(1);
  const preview = useCallback(
    (x: number) => {
      if (durationMs === null || durationMs <= 0) {
        return;
      }
      const ratio = Math.min(1, Math.max(0, x / width));
      onPreview?.(Math.round(ratio * durationMs));
    },
    [durationMs, onPreview, width],
  );
  const commit = useCallback(
    (x: number) => {
      if (durationMs === null || durationMs <= 0 || onSeek === undefined) {
        onPreview?.(null);
        return;
      }
      const ratio = Math.min(1, Math.max(0, x / width));
      onSeek(Math.round(ratio * durationMs));
    },
    [durationMs, onPreview, onSeek, width],
  );
  const cancel = useCallback(() => {
    onPreview?.(null);
  }, [onPreview]);
  const enabled =
    durationMs !== null && durationMs > 0 && onSeek !== undefined;
  // Stable gesture object — a fresh Pan() per render would cancel a
  // scrub in progress when the position tick re-renders the control.
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .enabled(enabled)
        .onBegin((e) => {
          scheduleOnRN(preview, e.x);
        })
        .onUpdate((e) => {
          scheduleOnRN(preview, e.x);
        })
        // A cancelled pan clears the preview; only a finished gesture
        // moves playback — the same commit-on-release rule the
        // waveform seek and the web range input share.
        .onFinalize((e, success) => {
          scheduleOnRN(success ? commit : cancel, e.x);
        }),
    [cancel, commit, enabled, preview],
  );
  return { gesture, onLayout };
}

const SEEK_STEP_MS = 10_000;

function useSeekA11y(
  positionMs: number,
  durationMs: number | null,
  onSeek: ((ms: number) => void) | undefined,
): (e: AccessibilityActionEvent) => void {
  // `adjustable` promises increment/decrement to AT — the ±10s step is
  // the VoiceOver seek path the pan gesture can't provide.
  return useCallback(
    (e: AccessibilityActionEvent) => {
      if (durationMs === null || durationMs <= 0 || onSeek === undefined) {
        return;
      }
      const name = e.nativeEvent.actionName;
      if (name === 'increment') {
        onSeek(Math.min(durationMs, positionMs + SEEK_STEP_MS));
      } else if (name === 'decrement') {
        onSeek(Math.max(0, positionMs - SEEK_STEP_MS));
      }
    },
    [durationMs, onSeek, positionMs],
  );
}

function progressOf(positionMs: number, durationMs: number | null): number {
  if (durationMs === null || durationMs <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, positionMs / durationMs));
}

export type LinearScrubberProps = {
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly onSeek?:
    | ((ms: number, expectedTrackKey?: string) => void)
    | undefined;
  /** Identity of the track on the player — scopes the optimistic
   *  hold so a track change never displays the previous track's
   *  committed position. */
  readonly trackKey?: string | null | undefined;
  readonly style?: StyleProp<ViewStyle> | undefined;
};

export function LinearScrubber({
  positionMs,
  durationMs,
  onSeek,
  trackKey,
  style,
}: LinearScrubberProps) {
  const theme = useTheme();
  const [previewMs, setPreviewMs] = useState<number | null>(null);
  const [heldMs, setHeldMs] = useState<number | null>(null);
  const heldBaseline = useRef(0);
  const positionRef = useRef(positionMs);
  positionRef.current = positionMs;
  const trackKeyRef = useRef(trackKey);
  trackKeyRef.current = trackKey;
  const heldKey = useRef(trackKey);
  const gestureKey = useRef<string | null | undefined>(undefined);
  // A pan whose track flipped mid-gesture: its remaining updates
  // and finalize are dead — previews must not restart a gesture on
  // the new track or let the release seek it.
  const gestureDead = useRef(false);
  const heldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The first preview of a pan marks the gesture's track — the hold
  // it may produce belongs to that identity even if a new track
  // lands before release.
  const onPreview = useCallback((ms: number | null) => {
    if (ms === null) {
      gestureKey.current = undefined;
      gestureDead.current = false;
    } else {
      if (gestureDead.current) {
        return;
      }
      if (gestureKey.current === undefined) {
        gestureKey.current = trackKeyRef.current;
      }
    }
    setPreviewMs(ms);
  }, []);
  // Optimistic fill: the committed target stays shown until the
  // publish round-trip lands (or the settle timer lapses) — the same
  // hold the waveform seek applies.
  const commit = useCallback(
    (ms: number) => {
      const begunOn = gestureKey.current;
      const wasDead = gestureDead.current;
      gestureDead.current = false;
      gestureKey.current = undefined;
      setPreviewMs(null);
      // A dead gesture's release does nothing but drain it; a track
      // change since the pan began abandons the release — it must not
      // seek the new track to a position the preview only ever showed
      // on the old one.
      if (
        wasDead ||
        (begunOn !== undefined && begunOn !== trackKeyRef.current)
      ) {
        return;
      }
      heldBaseline.current = positionRef.current;
      heldKey.current = trackKeyRef.current;
      setHeldMs(ms);
      clearTimer(heldTimer);
      heldTimer.current = setTimeout(() => {
        heldTimer.current = null;
        setHeldMs(null);
      }, 800);
      // The begun-on key rides to the session too — the ref compare
      // covers flips React already rendered; the session guard
      // covers the sub-frame window before it.
      onSeek?.(ms, begunOn ?? undefined);
    },
    [onSeek],
  );
  useEffect(() => {
    if (heldMs !== null && positionMs !== heldBaseline.current) {
      clearTimer(heldTimer);
      setHeldMs(null);
    }
  }, [positionMs, heldMs]);
  // A track change hides the hold at render regardless — clear the
  // state + settle timer rather than let them die on the clock, and
  // drop a mid-flight preview too: the gesture's commit guard makes
  // the same key check.
  useEffect(() => {
    if (heldMs !== null && heldKey.current !== trackKey) {
      clearTimer(heldTimer);
      setHeldMs(null);
    }
    if (
      gestureKey.current !== undefined &&
      gestureKey.current !== trackKey
    ) {
      gestureKey.current = undefined;
      gestureDead.current = true;
      setPreviewMs(null);
    }
  }, [trackKey, heldMs]);
  useEffect(() => () => clearTimer(heldTimer), []);
  const { gesture, onLayout } = useSeekGesture(
    durationMs,
    commit,
    onPreview,
  );
  const shownMs =
    (previewMs !== null && gestureKey.current === trackKey
      ? previewMs
      : null) ??
    (heldMs !== null && heldKey.current === trackKey ? heldMs : null) ??
    positionMs;
  const onAccessibilityAction = useSeekA11y(shownMs, durationMs, onSeek);
  const p = progressOf(shownMs, durationMs);
  return (
    <GestureDetector gesture={gesture}>
      <View
        onLayout={onLayout}
        accessibilityRole="adjustable"
        accessibilityLabel={t('progress.a11y.seek')}
        accessibilityValue={{
          min: 0,
          max: durationMs ?? 0,
          now: Math.round(positionMs),
          text: t('progress.a11y.value', {
            position: formatClock(positionMs),
            duration: formatClock(durationMs),
          }),
        }}
        accessibilityActions={[
          { name: 'increment' },
          { name: 'decrement' },
        ]}
        onAccessibilityAction={onAccessibilityAction}
        style={[
          {
            minHeight: theme.sizes.touch,
            justifyContent: 'center',
          },
          style,
        ]}
      >
        <View
          style={{
            height: theme.strokes.progress,
            borderRadius: theme.strokes.progress / 2,
            backgroundColor: theme.colors.fg18,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: `${p * 100}%`,
              backgroundColor: theme.colors.accent,
            }}
          />
        </View>
      </View>
    </GestureDetector>
  );
}

const WAVE_HEIGHT = 48;
const WAVE_MID = 24;
const WAVE_MAX_EXTENT = 20;
const WAVE_BAR_WIDTH = 3;
const WAVE_BAR_GAP = 2.5;

type BarGroup = {
  readonly xs: readonly number[];
  readonly ups: readonly number[];
  readonly downs: readonly number[];
  readonly idx: readonly number[];
};

// Three amplitude terciles → three stroke opacities, so the quieter
// bars read quieter without one animated component per bar. A bar's
// loudness is its longer arm.
function partitionBars(
  xs: readonly number[],
  peaks: readonly WaveformPeak[],
): readonly [BarGroup, BarGroup, BarGroup] {
  const sorted = peaks
    .map((p) => Math.max(p.up, p.down))
    .sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length / 3)] ?? Infinity;
  const t2 = sorted[Math.floor((sorted.length * 2) / 3)] ?? Infinity;
  const groups: [BarGroup, BarGroup, BarGroup] = [
    { xs: [], ups: [], downs: [], idx: [] },
    { xs: [], ups: [], downs: [], idx: [] },
    { xs: [], ups: [], downs: [], idx: [] },
  ];
  for (let i = 0; i < xs.length; i += 1) {
    const amp = Math.max(peaks[i]?.up ?? 0, peaks[i]?.down ?? 0);
    const g = amp <= t1 ? 0 : amp <= t2 ? 1 : 2;
    const group = groups[g];
    (group.xs as number[]).push(xs[i] ?? 0);
    (group.ups as number[]).push(peaks[i]?.up ?? 0);
    (group.downs as number[]).push(peaks[i]?.down ?? 0);
    (group.idx as number[]).push(i);
  }
  return groups;
}

export type WaveformSeekProps = {
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly onSeek?: ((ms: number) => void) | undefined;
  readonly seed?: string | undefined;
  /**
   * Real measured peaks at the canonical resolution (`peaks.ts`),
   * resampled to the bar count. Absent/null keeps the seeded
   * `waveformPeaks` pattern — extraction is lazy, so the seeded
   * bars are both the pending state and the failure fallback.
   */
  readonly peaks?: readonly WaveformPeak[] | null | undefined;
  readonly loading?: boolean | undefined;
  readonly labels?: boolean | undefined;
  readonly visible?: boolean | undefined;
  /** Identity of the track on the player — a pan that began on one
   *  track abandons rather than seeking the next on release. */
  readonly trackKey?: string | null | undefined;
  readonly style?: StyleProp<ViewStyle> | undefined;
};

export function WaveformSeek({
  positionMs,
  durationMs,
  onSeek,
  seed = 'auqw',
  peaks,
  loading = false,
  labels = true,
  visible = true,
  trackKey,
  style,
}: WaveformSeekProps) {
  const theme = useTheme();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const { width, onLayout } = useMeasuredWidth(0);
  const onAccessibilityAction = useSeekA11y(positionMs, durationMs, onSeek);

  const isLoading = loading || durationMs === null;
  const progress = progressOf(positionMs, durationMs);
  const layout = useMemo(
    () => waveformBarLayout(width, WAVE_BAR_WIDTH, WAVE_BAR_GAP),
    [width],
  );
  const bars = useMemo(
    () =>
      peaks !== undefined && peaks !== null && peaks.length > 0
        ? resamplePeaks(peaks, layout.count)
        : waveformPeaks(seed, layout.count),
    [peaks, seed, layout.count],
  );
  const groups = useMemo(() => partitionBars(layout.xs, bars), [layout, bars]);
  const allBars = useMemo<BarGroup>(
    () => ({
      xs: layout.xs,
      ups: bars.map((b) => b.up),
      downs: bars.map((b) => b.down),
      idx: layout.xs.map((_, i) => i),
    }),
    [layout, bars],
  );

  const fill = useSharedValue(progress);
  const bloom = useSharedValue(theme.reducedMotion ? 1 : 0);
  const shimmer = useSharedValue(0);
  const scrubbing = useSharedValue(0);
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const scrubActive = useRef(false);
  const scrubSec = useRef(-1);
  const previousProgress = useRef(progress);
  const latestProgress = useRef(progress);
  latestProgress.current = progress;
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const delta = Math.abs(progress - previousProgress.current);
    previousProgress.current = progress;
    if (delta > 0) {
      clearTimer(settleTimer);
    }
    if (scrubActive.current) {
      return;
    }
    const duration = delta > 0.05 ? theme.motion.state : 900;
    fill.value = theme.reducedMotion
      ? progress
      : withTiming(progress, { duration });
  }, [fill, progress, theme.motion.state, theme.reducedMotion]);
  useEffect(() => () => clearTimer(settleTimer), []);
  useEffect(() => {
    bloom.value = 0;
    bloom.value = theme.reducedMotion ? 1 : withTiming(1, { duration: 320 });
    // `peaks` is a second amplitude source: when real bars land they
    // replay the same stagger a new seed would.
  }, [bloom, seed, peaks, theme.reducedMotion]);
  useEffect(() => {
    if (isLoading && visible && !theme.reducedMotion) {
      shimmer.value = 0;
      shimmer.value = withRepeat(
        withTiming(1, { duration: 1600, easing: Easing.linear }),
        -1,
        false,
      );
    } else {
      cancelAnimation(shimmer);
      shimmer.value = 0;
    }
  }, [isLoading, shimmer, theme.reducedMotion, visible]);

  const trackKeyRef = useRef(trackKey);
  trackKeyRef.current = trackKey;
  const gestureKey = useRef<string | null | undefined>(undefined);
  // A pan whose track flipped mid-gesture: its remaining updates
  // and finalize are dead — previews must not restart a gesture on
  // the new track or let the release seek it. `gestureDead` guards
  // the JS side; `dead` stops the worklet from moving the fill.
  const gestureDead = useRef(false);
  const dead = useSharedValue(0);
  const preview = useCallback(
    (fraction: number) => {
      if (gestureDead.current) {
        return;
      }
      // The first preview of a pan marks the track the gesture
      // began on — a release checks it before seeking.
      if (!scrubActive.current) {
        gestureKey.current = trackKeyRef.current;
      }
      // JS-side scrub flag so the position ticker doesn't fight the finger.
      scrubActive.current = true;
      if (durationMs === null) {
        return;
      }
      const ms = Math.round(fraction * durationMs);
      const sec = Math.round(ms / 1000);
      if (sec !== scrubSec.current) {
        scrubSec.current = sec;
        setScrubMs(ms);
      }
    },
    [durationMs],
  );
  // A cancelled pan clears the preview and restores the real fill —
  // only a finished gesture may move playback.
  const cancelScrub = useCallback(() => {
    scrubActive.current = false;
    scrubSec.current = -1;
    gestureKey.current = undefined;
    gestureDead.current = false;
    setScrubMs(null);
    fill.value = theme.reducedMotion
      ? latestProgress.current
      : withTiming(latestProgress.current, {
          duration: theme.motion.state,
        });
  }, [fill, theme.motion.state, theme.reducedMotion]);
  const commit = useCallback(
    (fraction: number) => {
      // A dead gesture's release does nothing but drain it.
      if (gestureDead.current) {
        gestureDead.current = false;
        return;
      }
      // A track change since the pan began abandons the release —
      // seeking now would move a song the preview never showed.
      if (
        gestureKey.current !== undefined &&
        gestureKey.current !== trackKeyRef.current
      ) {
        cancelScrub();
        return;
      }
      gestureKey.current = undefined;
      scrubActive.current = false;
      scrubSec.current = -1;
      setScrubMs(null);
      if (durationMs !== null && durationMs > 0) {
        onSeek?.(Math.round(fraction * durationMs));
      }
      // Optimistic fill: when no position tick confirms the seek
      // (paused playback, noop onSeek) fall back to the real
      // progress instead of disagreeing with the labels forever.
      clearTimer(settleTimer);
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        if (scrubActive.current) {
          return;
        }
        fill.value = theme.reducedMotion
          ? latestProgress.current
          : withTiming(latestProgress.current, {
              duration: theme.motion.state,
            });
      }, 400);
    },
    [cancelScrub, durationMs, fill, onSeek, theme.motion.state, theme.reducedMotion],
  );
  // A track change mid-pan kills the gesture the way a cancelled
  // pan does — and marks it dead so the still-running pan's later
  // updates and finalize can't restart it or seek the new track.
  useEffect(() => {
    if (
      scrubActive.current &&
      gestureKey.current !== undefined &&
      gestureKey.current !== trackKey
    ) {
      cancelScrub();
      gestureDead.current = true;
      dead.value = 1;
    }
  }, [cancelScrub, dead, trackKey]);
  const enabled =
    durationMs !== null && durationMs > 0 && onSeek !== undefined;
  // Stable gesture object — a fresh Pan() per render would cancel a
  // scrub in progress when the position tick re-renders the control.
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .enabled(enabled)
        .onBegin((e) => {
          'worklet';
          if (dead.value === 1) {
            return;
          }
          const f = Math.min(1, Math.max(0, e.x / width));
          fill.value = f;
          scrubbing.value = 1;
          scheduleOnRN(preview, f);
        })
        .onUpdate((e) => {
          'worklet';
          if (dead.value === 1) {
            return;
          }
          const f = Math.min(1, Math.max(0, e.x / width));
          fill.value = f;
          scheduleOnRN(preview, f);
        })
        .onFinalize((e, success) => {
          'worklet';
          dead.value = 0;
          const f = Math.min(1, Math.max(0, e.x / width));
          scrubbing.value = 0;
          scheduleOnRN(success ? commit : cancelScrub, f);
        }),
    [cancelScrub, commit, dead, enabled, fill, preview, scrubbing, width],
  );
  const dTerciles = useDerivedValue((): [string, string, string] => [
    barsPathD(groups[0].xs, groups[0].ups, groups[0].downs, groups[0].idx, layout.count, WAVE_MID, WAVE_MAX_EXTENT, bloom.value),
    barsPathD(groups[1].xs, groups[1].ups, groups[1].downs, groups[1].idx, layout.count, WAVE_MID, WAVE_MAX_EXTENT, bloom.value),
    barsPathD(groups[2].xs, groups[2].ups, groups[2].downs, groups[2].idx, layout.count, WAVE_MID, WAVE_MAX_EXTENT, bloom.value),
  ]);
  // No clip-path here: react-native-svg drops animated prop updates
  // inside <ClipPath>, so the played layer is rebuilt each frame as
  // the subset of bars whose center sits left of the fill edge.
  const dAll = useDerivedValue(() =>
    barsPathD(
      allBars.xs,
      allBars.ups,
      allBars.downs,
      allBars.idx,
      layout.count,
      WAVE_MID,
      WAVE_MAX_EXTENT,
      bloom.value,
      fill.value * width,
    ),
  );
  const lowProps = useAnimatedProps(() => ({ d: dTerciles.value[0] }));
  const midProps = useAnimatedProps(() => ({ d: dTerciles.value[1] }));
  const highProps = useAnimatedProps(() => ({ d: dTerciles.value[2] }));
  const playedProps = useAnimatedProps(() => ({ d: dAll.value }));
  const shimmerProps = useAnimatedProps(() => ({
    x: shimmer.value * (width + width * 0.16) - width * 0.16,
  }));

  const shownMs =
    (scrubMs !== null &&
    scrubActive.current &&
    gestureKey.current === trackKey
      ? scrubMs
      : null) ?? positionMs;
  return (
    <View style={style}>
      <GestureDetector gesture={gesture}>
        <View
          onLayout={onLayout}
          accessibilityRole="adjustable"
          accessibilityLabel={t('progress.a11y.seek')}
          accessibilityValue={{
            min: 0,
            max: durationMs ?? 0,
            now: Math.round(shownMs),
            text: t('progress.a11y.value', {
              position: formatClock(shownMs),
              duration: formatClock(durationMs),
            }),
          }}
          accessibilityActions={[
            { name: 'increment' },
            { name: 'decrement' },
          ]}
          onAccessibilityAction={onAccessibilityAction}
          style={{
            minHeight: theme.sizes.touch,
            justifyContent: 'center',
          }}
        >
          {width > 0 && (
            <Svg width={width} height={WAVE_HEIGHT}>
              {isLoading ? (
                <>
                  {layout.xs.map((x, i) => (
                    <Rect
                      key={i}
                      x={x - WAVE_BAR_WIDTH / 2}
                      y={WAVE_MID - 2.4}
                      width={WAVE_BAR_WIDTH}
                      height={4.8}
                      rx={1.5}
                      fill={theme.colors.fg18}
                    />
                  ))}
                  {!theme.reducedMotion && (
                    <>
                      <Defs>
                        <ClipPath id={`bars-${uid}`}>
                          {layout.xs.map((x, i) => (
                            <Rect
                              key={i}
                              x={x - WAVE_BAR_WIDTH / 2}
                              y={WAVE_MID - 2.4}
                              width={WAVE_BAR_WIDTH}
                              height={4.8}
                              rx={1.5}
                            />
                          ))}
                        </ClipPath>
                      </Defs>
                      <G clipPath={`url(#bars-${uid})`}>
                        <AnimatedRect
                          y={0}
                          width={width * 0.16}
                          height={WAVE_HEIGHT}
                          fill={theme.colors.accent}
                          opacity={0.55}
                          animatedProps={shimmerProps}
                        />
                      </G>
                    </>
                  )}
                </>
              ) : (
                <>
                  <AnimatedPath
                    fill="none"
                    stroke={theme.colors.fg18}
                    strokeWidth={WAVE_BAR_WIDTH}
                    strokeLinecap="round"
                    opacity={0.6}
                    animatedProps={lowProps}
                  />
                  <AnimatedPath
                    fill="none"
                    stroke={theme.colors.fg18}
                    strokeWidth={WAVE_BAR_WIDTH}
                    strokeLinecap="round"
                    opacity={0.8}
                    animatedProps={midProps}
                  />
                  <AnimatedPath
                    fill="none"
                    stroke={theme.colors.fg18}
                    strokeWidth={WAVE_BAR_WIDTH}
                    strokeLinecap="round"
                    opacity={1}
                    animatedProps={highProps}
                  />
                  <AnimatedPath
                    fill="none"
                    stroke={theme.colors.accent}
                    strokeWidth={WAVE_BAR_WIDTH}
                    strokeLinecap="round"
                    animatedProps={playedProps}
                  />
                </>
              )}
            </Svg>
          )}
        </View>
      </GestureDetector>
      {labels && (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginTop: theme.spacing.xs,
          }}
        >
          <Text variant="metadata" color="secondary" numeric>
            {formatClock(shownMs)}
          </Text>
          <Text variant="metadata" color="secondary" numeric>
            {formatRemaining(shownMs, durationMs)}
          </Text>
        </View>
      )}
    </View>
  );
}
