import { useCallback, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import type {
  AccessibilityActionEvent,
  LayoutChangeEvent,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from './theme.tsx';
import { Artwork, Text } from './primitives.tsx';
import { formatClock, formatRemaining } from './view-models.ts';
import type { PlatformVariant } from './view-models.ts';

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

const RING = sampleRing(160);

export const SQUARED_RING_PATH =
  'M26 3 L38 3 Q49 3 49 14 L49 38 Q49 49 38 49 L14 49 Q3 49 3 38 L3 14 Q3 3 14 3 Z';
export const SQUARED_RING_LENGTH = RING.length;

function buildWavyPath(
  points: readonly Pt[],
  amp: number,
  waves: number,
): { readonly d: string; readonly length: number } {
  const n = points.length;
  let d = '';
  let length = 0;
  let prev: Pt | null = null;
  const fallback = points[0] ?? pt(0, 0);
  for (let i = 0; i <= n; i += 1) {
    const cur = points[i % n] ?? fallback;
    const ahead = points[(i + 1) % n] ?? fallback;
    const behind = points[(i - 1 + n) % n] ?? fallback;
    let tx = ahead.x - behind.x;
    let ty = ahead.y - behind.y;
    const m = Math.hypot(tx, ty) || 1;
    tx /= m;
    ty /= m;
    const off = amp * Math.sin((i / n) * 2 * Math.PI * waves);
    const q = pt(cur.x - ty * off, cur.y + tx * off);
    d += `${i === 0 ? 'M' : 'L'}${q.x.toFixed(2)} ${q.y.toFixed(2)}`;
    if (prev !== null) {
      length += Math.hypot(q.x - prev.x, q.y - prev.y);
    }
    prev = q;
  }
  return { d: `${d}Z`, length };
}

const WAVY = buildWavyPath(RING.points, 1.2, 10);

export function ringVariantFor(platform: PlatformVariant): 'wavy' | 'arc' {
  return platform === 'android' ? 'wavy' : 'arc';
}

export type ArtworkRingProps = {
  readonly artworkUrl: string | null;
  readonly progress: number;
  readonly size?: number | undefined;
  readonly artworkSize?: number | undefined;
  readonly platform?: PlatformVariant | undefined;
  readonly dimmed?: boolean | undefined;
  readonly style?: StyleProp<ViewStyle> | undefined;
};

export function ArtworkRing({
  artworkUrl,
  progress,
  size,
  artworkSize = 38,
  platform = Platform.OS === 'ios' ? 'ios' : 'android',
  dimmed = false,
  style,
}: ArtworkRingProps) {
  const theme = useTheme();
  const box = size ?? theme.sizes.artworkRing;
  const variant = ringVariantFor(platform);
  const clamped = Math.min(1, Math.max(0, progress));
  const wavy = variant === 'wavy';
  const stroke = wavy ? theme.strokes.progressAndroid : theme.strokes.progress;
  const trackStroke = wavy
    ? theme.strokes.progressAndroid
    : theme.strokes.hairline;
  const pathLength = wavy ? WAVY.length : SQUARED_RING_LENGTH;
  const path = wavy ? WAVY.d : SQUARED_RING_PATH;
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
          strokeWidth={trackStroke}
        />
        {clamped > 0 && (
          <Path
            d={path}
            fill="none"
            stroke={theme.colors.accent}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${clamped * pathLength} ${pathLength}`}
          />
        )}
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
          runOnJS(seek)(e.x);
        })
        .onUpdate((e) => {
          runOnJS(seek)(e.x);
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
        accessibilityLabel="seek"
        accessibilityValue={{
          min: 0,
          max: durationMs ?? 0,
          now: Math.round(positionMs),
          text: `${formatClock(positionMs)} of ${formatClock(durationMs)}`,
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

const PATTERN = [
  14, 24, 38, 52, 34, 62, 44, 28, 42, 68, 52, 36, 26, 40, 58, 72, 54, 40,
  30, 44, 62, 50, 36, 24, 38, 56, 64, 44, 30, 18,
] as const;

export type WaveformSeekProps = {
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly onSeek?: ((ms: number) => void) | undefined;
  readonly labels?: boolean | undefined;
  readonly style?: StyleProp<ViewStyle> | undefined;
};

export function WaveformSeek({
  positionMs,
  durationMs,
  onSeek,
  labels = true,
  style,
}: WaveformSeekProps) {
  const theme = useTheme();
  const { gesture, onLayout } = useSeekGesture(durationMs, onSeek);
  const { onAccessibilityAction } = useSeekA11y(positionMs, durationMs, onSeek);
  const p = progressOf(positionMs, durationMs);
  return (
    <View style={style}>
      <GestureDetector gesture={gesture}>
        <View
          onLayout={onLayout}
          accessibilityRole="adjustable"
          accessibilityLabel="seek"
          accessibilityValue={{
            min: 0,
            max: durationMs ?? 0,
            now: Math.round(positionMs),
            text: `${formatClock(positionMs)} of ${formatClock(durationMs)}`,
          }}
          accessibilityActions={[
            { name: 'increment' },
            { name: 'decrement' },
          ]}
          onAccessibilityAction={onAccessibilityAction}
          style={{
            height: 46,
            minHeight: theme.sizes.touch,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {PATTERN.map((h, i) => (
            <View
              key={i}
              style={{
                width: 3,
                height: `${h}%`,
                borderRadius: 1.5,
                backgroundColor:
                  i / PATTERN.length < p
                    ? theme.colors.accent
                    : theme.colors.fg18,
              }}
            />
          ))}
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
            {formatClock(positionMs)}
          </Text>
          <Text variant="metadata" color="secondary" numeric>
            {formatRemaining(positionMs, durationMs)}
          </Text>
        </View>
      )}
    </View>
  );
}
