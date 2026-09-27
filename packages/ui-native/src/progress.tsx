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
  waveformAmplitudes,
  waveformBarLayout,
} from '@auqw/ui-shared';
import { progressPathState } from './motion';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

type Pt = { readonly x: number; readonly y: number };

type Seg =
  | { readonly kind: 'l'; readonly a: Pt; readonly b: Pt }
  | { readonly kind: 'q'; readonly a: Pt; readonly c: Pt; readonly b: Pt };

const pt = (x: number, y: number): Pt => ({ x, y });

const RING_SEGS: readonly Seg[] = [
  { kind: 'l', a: pt(26, 3), b: pt(38, 3) },
  { kind: 'q', a: pt(38, 3), c: pt(49, 3), b: pt(49, 14) },
  { kind: 'l', a: pt(49, 14), b: pt(49, 38) },
  { kind: 'q', a: pt(49, 38), c: pt(49, 49), b: pt(38, 49) },
  { kind: 'l', a: pt(38, 49), b: pt(14, 49) },
  { kind: 'q', a: pt(14, 49), c: pt(3, 49), b: pt(3, 38) },
  { kind: 'l', a: pt(3, 38), b: pt(3, 14) },
  { kind: 'q', a: pt(3, 14), c: pt(3, 3), b: pt(14, 3) },
  { kind: 'l', a: pt(14, 3), b: pt(26, 3) },
];

function segPoint(seg: Seg, t: number): Pt {
  if (seg.kind === 'l') {
    return pt(seg.a.x + (seg.b.x - seg.a.x) * t, seg.a.y + (seg.b.y - seg.a.y) * t);
  }
  const u = 1 - t;
  return pt(
    u * u * seg.a.x + 2 * u * t * seg.c.x + t * t * seg.b.x,
    u * u * seg.a.y + 2 * u * t * seg.c.y + t * t * seg.b.y,
  );
}

function segLength(seg: Seg): number {
  if (seg.kind === 'l') {
    return Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
  }
  let length = 0;
  let prev = seg.a;
  for (let i = 1; i <= 24; i += 1) {
    const cur = segPoint(seg, i / 24);
    length += Math.hypot(cur.x - prev.x, cur.y - prev.y);
    prev = cur;
  }
  return length;
}

function sampleRing(
  count: number,
): { readonly points: readonly Pt[]; readonly length: number } {
  const segLens = RING_SEGS.map(segLength);
  const total = segLens.reduce((a, b) => a + b, 0);
  const points: Pt[] = [];
  for (let i = 0; i < count; i += 1) {
    let s = (i / count) * total;
    let segIndex = 0;
    let segLen = segLens[0] ?? total;
    while (segIndex < segLens.length - 1 && s > segLen) {
      s -= segLen;
      segIndex += 1;
      segLen = segLens[segIndex] ?? total;
    }
    const seg = RING_SEGS[segIndex];
    points.push(seg === undefined ? pt(0, 0) : segPoint(seg, segLen === 0 ? 0 : s / segLen));
  }
  return { points, length: total };
}

const RING = sampleRing(200);

export const SQUARED_RING_PATH =
  'M26 3 L38 3 Q49 3 49 14 L49 38 Q49 49 38 49 L14 49 Q3 49 3 38 L3 14 Q3 3 14 3 Z';
export const SQUARED_RING_LENGTH = RING.length;

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
  amps: readonly number[],
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
    const extent = barExtentW(
      amps[i] ?? 0,
      maxExtent,
      2.4,
      staggerW(bloom, idx[i] ?? i, count),
    );
    d += `M${x.toFixed(2)} ${(mid - extent).toFixed(2)} L${x.toFixed(2)} ${(
      mid + extent
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
  onSeek: ((ms: number) => void) | undefined,
): {
  readonly gesture: ReturnType<typeof Gesture.Pan>;
  readonly onLayout: (e: LayoutChangeEvent) => void;
} {
  const [width, setWidth] = useState(1);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) {
      setWidth(w);
    }
  }, []);
  const seek = useCallback(
    (x: number) => {
      if (durationMs === null || durationMs <= 0 || onSeek === undefined) {
        return;
      }
      const ratio = Math.min(1, Math.max(0, x / width));
      onSeek(Math.round(ratio * durationMs));
    },
    [durationMs, onSeek, width],
  );
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
          scheduleOnRN(seek, e.x);
        })
        .onUpdate((e) => {
          scheduleOnRN(seek, e.x);
        }),
    [enabled, seek],
  );
  return { gesture, onLayout };
}

const SEEK_STEP_MS = 10_000;

function useSeekA11y(
  positionMs: number,
  durationMs: number | null,
  onSeek: ((ms: number) => void) | undefined,
): {
  readonly onAccessibilityAction: (e: AccessibilityActionEvent) => void;
} {
  // `adjustable` promises increment/decrement to AT — the ±10s step is
  // the VoiceOver seek path the pan gesture can't provide.
  const onAccessibilityAction = useCallback(
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
  return { onAccessibilityAction };
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
  readonly onSeek?: ((ms: number) => void) | undefined;
  readonly style?: StyleProp<ViewStyle> | undefined;
};

export function LinearScrubber({
  positionMs,
  durationMs,
  onSeek,
  style,
}: LinearScrubberProps) {
  const theme = useTheme();
  const { gesture, onLayout } = useSeekGesture(durationMs, onSeek);
  const { onAccessibilityAction } = useSeekA11y(positionMs, durationMs, onSeek);
  const p = progressOf(positionMs, durationMs);
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
  readonly amps: readonly number[];
  readonly idx: readonly number[];
};

// Three amplitude terciles → three stroke opacities, so the quieter
// bars read quieter without one animated component per bar.
function partitionBars(
  xs: readonly number[],
  amps: readonly number[],
): readonly [BarGroup, BarGroup, BarGroup] {
  const sorted = [...amps].sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length / 3)] ?? Infinity;
  const t2 = sorted[Math.floor((sorted.length * 2) / 3)] ?? Infinity;
  const groups: [BarGroup, BarGroup, BarGroup] = [
    { xs: [], amps: [], idx: [] },
    { xs: [], amps: [], idx: [] },
    { xs: [], amps: [], idx: [] },
  ];
  for (let i = 0; i < xs.length; i += 1) {
    const amp = amps[i] ?? 0;
    const g = amp <= t1 ? 0 : amp <= t2 ? 1 : 2;
    const group = groups[g];
    (group.xs as number[]).push(xs[i] ?? 0);
    (group.amps as number[]).push(amp);
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
   * `waveformAmplitudes` pattern — extraction is lazy, so the seeded
   * bars are both the pending state and the failure fallback.
   */
  readonly peaks?: readonly number[] | null | undefined;
  readonly loading?: boolean | undefined;
  readonly labels?: boolean | undefined;
  readonly visible?: boolean | undefined;
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
  style,
}: WaveformSeekProps) {
  const theme = useTheme();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) {
      setWidth(w);
    }
  }, []);
  const { onAccessibilityAction } = useSeekA11y(positionMs, durationMs, onSeek);

  const isLoading = loading || durationMs === null;
  const progress = progressOf(positionMs, durationMs);
  const layout = useMemo(
    () => waveformBarLayout(width, WAVE_BAR_WIDTH, WAVE_BAR_GAP),
    [width],
  );
  const amps = useMemo(
    () =>
      peaks !== undefined && peaks !== null && peaks.length > 0
        ? resamplePeaks(peaks, layout.count)
        : waveformAmplitudes(seed, layout.count),
    [peaks, seed, layout.count],
  );
  const groups = useMemo(() => partitionBars(layout.xs, amps), [layout, amps]);
  const allBars = useMemo<BarGroup>(
    () => ({
      xs: layout.xs,
      amps,
      idx: layout.xs.map((_, i) => i),
    }),
    [layout, amps],
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
    if (delta > 0 && settleTimer.current !== null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    if (scrubActive.current) {
      return;
    }
    const duration = delta > 0.05 ? theme.motion.state : 900;
    fill.value = theme.reducedMotion
      ? progress
      : withTiming(progress, { duration });
  }, [fill, progress, theme.motion.state, theme.reducedMotion]);
  useEffect(
    () => () => {
      if (settleTimer.current !== null) {
        clearTimeout(settleTimer.current);
      }
    },
    [],
  );
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

  const preview = useCallback(
    (fraction: number) => {
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
  const commit = useCallback(
    (fraction: number) => {
      scrubActive.current = false;
      scrubSec.current = -1;
      setScrubMs(null);
      if (durationMs !== null && durationMs > 0) {
        onSeek?.(Math.round(fraction * durationMs));
      }
      // Optimistic fill: when no position tick confirms the seek
      // (paused playback, noop onSeek) fall back to the real
      // progress instead of disagreeing with the labels forever.
      if (settleTimer.current !== null) {
        clearTimeout(settleTimer.current);
      }
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
    [durationMs, fill, onSeek, theme.motion.state, theme.reducedMotion],
  );
  // A cancelled pan clears the preview and restores the real fill —
  // only a finished gesture may move playback.
  const cancelScrub = useCallback(() => {
    scrubActive.current = false;
    scrubSec.current = -1;
    setScrubMs(null);
    fill.value = theme.reducedMotion
      ? latestProgress.current
      : withTiming(latestProgress.current, {
          duration: theme.motion.state,
        });
  }, [fill, theme.motion.state, theme.reducedMotion]);
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
          const f = Math.min(1, Math.max(0, e.x / width));
          fill.value = f;
          scrubbing.value = 1;
          scheduleOnRN(preview, f);
        })
        .onUpdate((e) => {
          'worklet';
          const f = Math.min(1, Math.max(0, e.x / width));
          fill.value = f;
          scheduleOnRN(preview, f);
        })
        .onFinalize((e, success) => {
          'worklet';
          const f = Math.min(1, Math.max(0, e.x / width));
          scrubbing.value = 0;
          scheduleOnRN(success ? commit : cancelScrub, f);
        }),
    [cancelScrub, commit, enabled, fill, preview, scrubbing, width],
  );
  const dLow = useDerivedValue(() =>
    barsPathD(
      groups[0].xs,
      groups[0].amps,
      groups[0].idx,
      layout.count,
      WAVE_MID,
      WAVE_MAX_EXTENT,
      bloom.value,
    ),
  );
  const dMid = useDerivedValue(() =>
    barsPathD(
      groups[1].xs,
      groups[1].amps,
      groups[1].idx,
      layout.count,
      WAVE_MID,
      WAVE_MAX_EXTENT,
      bloom.value,
    ),
  );
  const dHigh = useDerivedValue(() =>
    barsPathD(
      groups[2].xs,
      groups[2].amps,
      groups[2].idx,
      layout.count,
      WAVE_MID,
      WAVE_MAX_EXTENT,
      bloom.value,
    ),
  );
  // No clip-path here: react-native-svg drops animated prop updates
  // inside <ClipPath>, so the played layer is rebuilt each frame as
  // the subset of bars whose center sits left of the fill edge.
  const dAll = useDerivedValue(() =>
    barsPathD(
      allBars.xs,
      allBars.amps,
      allBars.idx,
      layout.count,
      WAVE_MID,
      WAVE_MAX_EXTENT,
      bloom.value,
      fill.value * width,
    ),
  );
  const lowProps = useAnimatedProps(() => ({ d: dLow.value }));
  const midProps = useAnimatedProps(() => ({ d: dMid.value }));
  const highProps = useAnimatedProps(() => ({ d: dHigh.value }));
  const playedProps = useAnimatedProps(() => ({ d: dAll.value }));
  const shimmerProps = useAnimatedProps(() => ({
    x: shimmer.value * (width + width * 0.16) - width * 0.16,
  }));

  const shownMs = scrubMs ?? positionMs;
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
