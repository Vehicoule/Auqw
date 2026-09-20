import { useEffect } from 'react';
import type { ReactNode } from 'react';
import {
  Image,
  Pressable as RNPressable,
  StyleSheet,
  Text as RNText,
  View,
} from 'react-native';
import type {
  AccessibilityRole,
  AccessibilityState,
  Insets,
  StyleProp,
  TextStyle,
  ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from './theme.tsx';
import type { Theme } from './theme.tsx';

export type TextVariant = keyof Theme['typography'];

export type TextColor =
  | 'primary'
  | 'bright'
  | 'secondary'
  | 'accent'
  | 'warn'
  | 'liked'
  | 'canvas';

function textColor(theme: Theme, color: TextColor): string {
  switch (color) {
    case 'primary':
      return theme.colors.textPrimary;
    case 'bright':
      return theme.colors.textBright;
    case 'secondary':
      return theme.colors.textSecondary;
    case 'accent':
      return theme.colors.accent;
    case 'warn':
      return theme.colors.warn;
    case 'liked':
      return theme.colors.liked;
    case 'canvas':
      return theme.colors.canvas;
  }
}

export type TextProps = {
  readonly variant?: TextVariant | undefined;
  readonly color?: TextColor;
  readonly numeric?: boolean | undefined;
  readonly uppercase?: boolean | undefined;
  readonly numberOfLines?: number | undefined;
  readonly style?: StyleProp<TextStyle>;
  readonly children: ReactNode;
  readonly accessibilityLabel?: string | undefined;
};

export function Text({
  variant = 'body',
  color = 'primary',
  numeric = false,
  uppercase = false,
  numberOfLines,
  style,
  children,
  accessibilityLabel,
}: TextProps) {
  const theme = useTheme();
  return (
    <RNText
      numberOfLines={numberOfLines}
      accessibilityLabel={accessibilityLabel}
      style={[
        theme.typography[variant],
        { color: textColor(theme, color) },
        numeric && styles.numeric,
        uppercase && styles.uppercase,
        style,
      ]}
    >
      {children}
    </RNText>
  );
}

export function Hairline({
  vertical = false,
  style,
}: {
  readonly vertical?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.hairline,
          ...(vertical
            ? { width: theme.strokes.hairline, alignSelf: 'stretch' as const }
            : { height: theme.strokes.hairline, alignSelf: 'stretch' as const }),
        },
        style,
      ]}
    />
  );
}

export type PressableProps = {
  readonly onPress?: (() => void) | undefined;
  readonly onLongPress?: (() => void) | undefined;
  readonly accessibilityLabel: string;
  readonly accessibilityRole?: AccessibilityRole | undefined;
  readonly accessibilityState?: AccessibilityState | undefined;
  readonly disabled?: boolean | undefined;
  readonly compact?: boolean | undefined;
  readonly style?:
  | StyleProp<ViewStyle>
  | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
  readonly children?: ReactNode | undefined;
};

export function Pressable({
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  disabled = false,
  compact = false,
  style,
  children,
}: PressableProps) {
  const theme = useTheme();
  const slop = Math.max(0, (theme.sizes.touch - 28) / 2);
  // A pressable with no handler is inert — same rule as IconButton:
  // it must look and announce as disabled, not ship as a live
  // control that silently does nothing.
  const off = disabled || (onPress === undefined && onLongPress === undefined);
  return (
    <RNPressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={off}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ ...accessibilityState, disabled: off }}
      hitSlop={compact ? slop : undefined}
      style={({ pressed }) => [
        !compact && {
          minWidth: theme.sizes.touch,
          minHeight: theme.sizes.touch,
        },
        pressed && !off && { backgroundColor: theme.colors.fg08 },
        off && { opacity: 0.4 },
        typeof style === 'function' ? style({ pressed }) : style,
      ]}
    >
      {children}
    </RNPressable>
  );
}

export type IconButtonProps = {
  readonly icon: IconName;
  readonly onPress?: (() => void) | undefined;
  readonly accessibilityLabel: string;
  readonly size?: number | undefined;
  readonly iconSize?: number | undefined;
  readonly color?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly active?: boolean | undefined;
  readonly filled?: boolean | undefined;
  readonly hitSlop?: number | Insets | undefined;
  readonly style?: StyleProp<ViewStyle>;
};

export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 32,
  iconSize = 14,
  color,
  disabled = false,
  active = false,
  filled = false,
  hitSlop,
  style,
}: IconButtonProps) {
  const theme = useTheme();
  // Adjacent small buttons (queue chevrons) clamp the slop so their
  // hit regions can't bleed into each other.
  const slop = hitSlop ?? Math.max(0, (theme.sizes.touch - size) / 2);
  // A button with no handler is inert — it must look and announce as
  // disabled, not ship as a live control that silently does nothing.
  const off = disabled || onPress === undefined;
  return (
    <RNPressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active, disabled: off }}
      hitSlop={slop}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: theme.radius.control,
          opacity: off ? 0.4 : 1,
        },
        pressed && !off && { backgroundColor: theme.colors.fg08 },
        style,
      ]}
    >
      <Icon
        name={icon}
        size={iconSize}
        color={color ?? theme.colors.textSecondary}
        filled={filled}
      />
    </RNPressable>
  );
}

export type ArtworkProps = {
  readonly url: string | null;
  readonly size?: number | undefined;
  readonly fill?: boolean | undefined;
  readonly cornerRadius?: number | undefined;
  readonly monogram?: string | null | undefined;
  readonly dimmed?: boolean | undefined;
  readonly style?: StyleProp<ViewStyle> | undefined;
};

export function Artwork({
  url,
  size = 40,
  fill = false,
  cornerRadius,
  monogram,
  dimmed = false,
  style,
}: ArtworkProps) {
  const theme = useTheme();
  const r = cornerRadius ?? theme.radius.thumb;
  return (
    <View
      accessible={false}
      style={[
        fill ? { width: '100%', height: '100%' } : { width: size, height: size },
        {
          borderRadius: r,
          overflow: 'hidden',
          backgroundColor: theme.colors.raised,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: dimmed ? 0.4 : 1,
        },
        style,
      ]}
    >
      {url === null ? (
        monogram !== null && monogram !== undefined && monogram !== '' ? (
          <RNText
            style={[
              theme.typography.heading,
              {
                color: theme.colors.textSecondary,
                fontSize: fill ? 28 : size * 0.34,
              },
            ]}
          >
            {monogram.slice(0, 2).toUpperCase()}
          </RNText>
        ) : (
          <Icon
            name="note"
            size={fill ? 36 : size * 0.44}
            color={theme.colors.textSecondary}
          />
        )
      ) : (
        <Image
          source={{ uri: url }}
          style={
            fill
              ? { width: '100%', height: '100%' }
              : { width: size, height: size }
          }
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
      )}
    </View>
  );
}

export type IconName =
  | 'play'
  | 'pause'
  | 'next'
  | 'previous'
  | 'search'
  | 'heart'
  | 'heart-filled'
  | 'queue'
  | 'settings'
  | 'close'
  | 'drag-handle'
  | 'spinner'
  | 'warn'
  | 'download'
  | 'list-plus'
  | 'home'
  | 'compass'
  | 'library'
  | 'note'
  | 'repeat'
  | 'shuffle'
  | 'clock'
  | 'lyrics'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-up'
  | 'chevron-down'
  | 'menu';

type GlyphShape =
  | { readonly kind: 'path'; readonly d: string }
  | { readonly kind: 'circle'; readonly cx: number; readonly cy: number; readonly r: number }
  | {
    readonly kind: 'rect';
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly rx?: number;
  };

type Glyph = {
  readonly filled: boolean;
  readonly shapes: readonly GlyphShape[];
};

function p(d: string): GlyphShape {
  return { kind: 'path', d };
}

function c(cx: number, cy: number, r: number): GlyphShape {
  return { kind: 'circle', cx, cy, r };
}

function rr(
  x: number,
  y: number,
  w: number,
  h: number,
  rx?: number,
): GlyphShape {
  return rx === undefined
    ? { kind: 'rect', x, y, w, h }
    : { kind: 'rect', x, y, w, h, rx };
}

const GLYPHS: Record<IconName, Glyph> = {
  play: { filled: true, shapes: [p('M7 4.5v15l13-7.5z')] },
  pause: {
    filled: true,
    shapes: [rr(6.5, 5, 4, 14), rr(13.5, 5, 4, 14)],
  },
  previous: {
    filled: true,
    shapes: [p('M17 5v14L7 12z'), rr(5, 5, 2, 14)],
  },
  next: {
    filled: true,
    shapes: [p('M7 5v14l10-7z'), rr(17, 5, 2, 14)],
  },
  search: {
    filled: false,
    shapes: [c(10.5, 10.5, 6), p('m15 15 5.5 5.5')],
  },
  heart: {
    filled: false,
    shapes: [
      p(
        'M12 20s-8-4.7-8-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.3-8 10-8 10z',
      ),
    ],
  },
  'heart-filled': {
    filled: true,
    shapes: [
      p(
        'M12 20s-8-4.7-8-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.3-8 10-8 10z',
      ),
    ],
  },
  queue: {
    filled: false,
    shapes: [
      p('M5 6h14M5 11h14M5 16h9'),
      p('M17 14v6m0 0-2-2m2 2 2-2'),
    ],
  },
  settings: {
    filled: false,
    shapes: [
      c(12, 12, 3),
      p(
        'M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M18 6l-2 2M8 16l-2 2',
      ),
    ],
  },
  close: { filled: false, shapes: [p('M6 6l12 12M18 6 6 18')] },
  'drag-handle': { filled: false, shapes: [p('M5 9h14M5 15h14')] },
  spinner: { filled: false, shapes: [p('M20 12a8 8 0 1 1-8-8')] },
  warn: {
    filled: false,
    shapes: [p('M12 4 3 20h18zM12 10v4m0 3v.5')],
  },
  download: {
    filled: false,
    shapes: [p('M12 4v11m0 0-4-4m4 4 4-4M4 19h16')],
  },
  'list-plus': {
    filled: false,
    shapes: [p('M4 6h12M4 11h12M4 16h7m4 0h6m-3-3v6')],
  },
  home: {
    filled: false,
    shapes: [p('M4 11 12 4l8 7v8h-5v-5H9v5H4z')],
  },
  compass: {
    filled: false,
    shapes: [c(12, 12, 8), p('m15.5 8.5-2 5-5 2 2-5z')],
  },
  library: {
    filled: false,
    shapes: [p('M5 5v14M9.5 5v14M14 6l5 1.2L16 19l-5-1.2z')],
  },
  note: {
    filled: false,
    shapes: [p('M9 18V6l10-2v11'), c(6.5, 18, 2.5), c(16.5, 15, 2.5)],
  },
  repeat: {
    filled: false,
    shapes: [
      p('M17 4l3 3-3 3M20 7H7a3 3 0 0 0-3 3v1M7 20l-3-3 3-3M4 17h13a3 3 0 0 0 3-3v-1'),
    ],
  },
  shuffle: {
    filled: false,
    shapes: [
      p('M4 6h4l9 12h5m0 0-3-3m3 3-3 3M4 18h4l2.5-3.3M14.5 9.3 16 7.5h5m0 0-3-3m3 3-3 3'),
    ],
  },
  clock: {
    filled: false,
    shapes: [c(12, 12, 8), p('M12 7v5l3.5 2')],
  },
  lyrics: {
    filled: false,
    shapes: [p('M5 5h14M5 10h14M5 15h9M5 20h6')],
  },
  'chevron-left': { filled: false, shapes: [p('m14 6-6 6 6 6')] },
  'chevron-right': { filled: false, shapes: [p('m10 6 6 6-6 6')] },
  'chevron-up': { filled: false, shapes: [p('m6 14 6-6 6 6')] },
  'chevron-down': { filled: false, shapes: [p('m6 10 6 6 6-6')] },
  menu: {
    filled: false,
    shapes: [p('M4 7h16M4 12h16M4 17h16')],
  },
};

export type IconProps = {
  readonly name: IconName;
  readonly size?: number | undefined;
  readonly color?: string | undefined;
  readonly strokeWidth?: number | undefined;
  readonly filled?: boolean | undefined;
};

export function Icon({
  name,
  size = 14,
  color,
  strokeWidth,
  filled,
}: IconProps) {
  const theme = useTheme();
  const glyph = GLYPHS[name];
  const useFill = filled ?? glyph.filled;
  const paint = color ?? theme.colors.textPrimary;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      accessible={false}
    >
      {glyph.shapes.map((shape, i) => {
        switch (shape.kind) {
          case 'path':
            return (
              <Path
                key={i}
                d={shape.d}
                stroke={useFill ? 'none' : paint}
                strokeWidth={strokeWidth ?? theme.strokes.progress}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill={useFill ? paint : 'none'}
              />
            );
          case 'circle':
            return (
              <Circle
                key={i}
                cx={shape.cx}
                cy={shape.cy}
                r={shape.r}
                stroke={useFill ? 'none' : paint}
                strokeWidth={strokeWidth ?? theme.strokes.progress}
                fill={useFill ? paint : 'none'}
              />
            );
          case 'rect':
            return (
              <Rect
                key={i}
                x={shape.x}
                y={shape.y}
                width={shape.w}
                height={shape.h}
                rx={shape.rx ?? 0}
                stroke={useFill ? 'none' : paint}
                strokeWidth={strokeWidth ?? theme.strokes.progress}
                fill={useFill ? paint : 'none'}
              />
            );
        }
      })}
    </Svg>
  );
}

export function Spinner({
  size = 16,
  color,
}: {
  readonly size?: number | undefined;
  readonly color?: string | undefined;
}) {
  const theme = useTheme();
  const rotation = useSharedValue(0);
  useEffect(() => {
    if (theme.reducedMotion) {
      return undefined;
    }
    rotation.value = withRepeat(
      withTiming(360, { duration: 900, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(rotation);
  }, [rotation, theme.reducedMotion]);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  return (
    <Animated.View style={[{ width: size, height: size }, animatedStyle]}>
      <Icon
        name="spinner"
        size={size}
        color={color ?? theme.colors.accent}
        strokeWidth={theme.strokes.progressAndroid}
      />
    </Animated.View>
  );
}

const EQ_HEIGHTS = [0.45, 1, 0.65] as const;

export function EqBars({
  color,
  animated = true,
  size = 11,
}: {
  readonly color?: string | undefined;
  readonly animated?: boolean;
  readonly size?: number | undefined;
}) {
  const theme = useTheme();
  const paint = color ?? theme.colors.accent;
  const run = animated && !theme.reducedMotion;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        height: size,
        gap: 2,
      }}
    >
      {EQ_HEIGHTS.map((h, i) => (
        <EqBar
          key={i}
          height={size}
          scale={h}
          color={paint}
          delay={i * 250}
          run={run}
        />
      ))}
    </View>
  );
}

function EqBar({
  height,
  scale,
  color,
  delay,
  run,
}: {
  readonly height: number;
  readonly scale: number;
  readonly color: string;
  readonly delay: number;
  readonly run: boolean;
}) {
  const progress = useSharedValue(scale);
  useEffect(() => {
    if (!run) {
      // Static fallback keeps each bar's own height — a uniform value
      // would render three identical stubs, not an EQ.
      progress.value = scale;
      return undefined;
    }
    const id = setTimeout(() => {
      progress.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 450, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.3, { duration: 450, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        true,
      );
    }, delay);
    return () => {
      clearTimeout(id);
      cancelAnimation(progress);
    };
  }, [progress, run, delay, scale]);
  const animatedStyle = useAnimatedStyle(() => ({
    height: Math.max(2, progress.value * height),
  }));
  return (
    <Animated.View
      style={[
        {
          width: 2.5,
          borderRadius: 1,
          backgroundColor: color,
        },
        animatedStyle,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  numeric: { fontVariant: ['tabular-nums'] },
  uppercase: { textTransform: 'uppercase' },
});
