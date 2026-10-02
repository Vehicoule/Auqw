import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  Image,
  PixelRatio,
  Pressable as RNPressable,
  StyleSheet,
  Text as RNText,
  useWindowDimensions,
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
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';
import { useTheme } from './theme.tsx';
import type { Theme } from './theme.tsx';
import { useResolvedArtworkUri } from './artwork.tsx';
import {
  clamp01,
  DOWNLOAD_TARGETS,
  markDotProgress,
  markStrokeProgress,
  morphPlayPause,
  quadPath,
} from './motion.ts';
import {
  CHECK_DRAW_LENGTH,
  CHECK_DRAW_PATH,
  CHECK_MINI_LENGTH,
  CHECK_MINI_PATH,
  DOWNLOAD_ARROW_PATH,
  downloadIconState,
  ICON_ARC_PATH,
  ICON_RING_LENGTH,
  ICON_RING_PATH,
  REFRESH_PATH,
  WARN_DRAW_DETAIL_LENGTH,
  WARN_DRAW_DETAIL_PATH,
  WARN_DRAW_DOT,
  WARN_DRAW_TRIANGLE_LENGTH,
  WARN_DRAW_TRIANGLE_PATH,
  WARN_MINI_DOT,
  WARN_MINI_LINE_LENGTH,
  WARN_MINI_LINE_PATH,
} from '@auqw/ui-shared';
import type { DownloadChip } from '@auqw/ui-shared';
import type { DownloadButtonView } from '@auqw/ui-shared/controllers';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

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
  const colors: Record<TextColor, string> = {
    primary: theme.colors.textPrimary,
    bright: theme.colors.textBright,
    secondary: theme.colors.textSecondary,
    accent: theme.colors.accent,
    warn: theme.colors.warn,
    liked: theme.colors.liked,
    canvas: theme.colors.canvas,
  };
  return colors[color];
}

export type TextProps = {
  readonly variant?: TextVariant | undefined;
  readonly color?: TextColor;
  readonly numeric?: boolean | undefined;
  readonly uppercase?: boolean | undefined;
  readonly numberOfLines?: number | undefined;
  readonly adjustsFontSizeToFit?: boolean | undefined;
  readonly minimumFontScale?: number | undefined;
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
  adjustsFontSizeToFit,
  minimumFontScale,
  style,
  children,
  accessibilityLabel,
}: TextProps) {
  const theme = useTheme();
  const base = theme.typography[variant];
  const letterSpacing = (base as TextStyle).letterSpacing;
  const scaled =
    theme.textScale === 1
      ? base
      : {
        ...base,
        fontSize: base.fontSize * theme.textScale,
        lineHeight: base.lineHeight * theme.textScale,
        letterSpacing:
          letterSpacing === undefined
            ? undefined
            : letterSpacing * theme.textScale,
      };
  return (
    <RNText
      // Theme textScale already carries the OS font scale — disabling
      // native font scaling keeps it from being applied a second time.
      allowFontScaling={false}
      numberOfLines={numberOfLines}
      adjustsFontSizeToFit={adjustsFontSizeToFit}
      minimumFontScale={minimumFontScale}
      accessibilityLabel={accessibilityLabel}
      style={[
        scaled,
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
          alignSelf: 'stretch',
          ...(vertical
            ? { width: theme.strokes.hairline }
            : { height: theme.strokes.hairline }),
        },
        style,
      ]}
    />
  );
}

/**
 * The edge-to-edge veil: content scrolls under the status bar and a
 * soft canvas ramp — not a hard band — keeps the clock and icons
 * readable. `height` covers the inset plus a short tail below it.
 */
export function StatusBarFade({
  height,
}: {
  readonly height: number;
}) {
  const theme = useTheme();
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height,
      }}
    >
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient id="uw-sbfade" x1="0" y1="0" x2="0" y2="1">
            <Stop
              offset="0"
              stopColor={theme.colors.canvas}
              stopOpacity={0.85}
            />
            <Stop
              offset="0.55"
              stopColor={theme.colors.canvas}
              stopOpacity={0.4}
            />
            <Stop
              offset="1"
              stopColor={theme.colors.canvas}
              stopOpacity={0}
            />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width="100%" height={height} fill="url(#uw-sbfade)" />
      </Svg>
    </View>
  );
}

// The detail-screen chrome button — every pushed screen's chevron.
export function BackButton({
  onPress,
  accessibilityLabel,
}: {
  readonly onPress?: (() => void) | undefined;
  readonly accessibilityLabel: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      compact
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      style={{ padding: theme.spacing.xs }}
    >
      <Icon name="chevron-left" size={16} color={theme.colors.textSecondary} />
    </Pressable>
  );
}

// The pushed-screen header shell: chevron + trailing content row.
export function BackRow({
  onPress,
  accessibilityLabel,
  children,
}: {
  readonly onPress?: (() => void) | undefined;
  readonly accessibilityLabel: string;
  readonly children?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        marginBottom: theme.spacing.sm,
      }}
    >
      <BackButton
        onPress={onPress}
        accessibilityLabel={accessibilityLabel}
      />
      {children}
    </View>
  );
}

// Curry an optional handler — undefined stays undefined so the control
// stays honest-inert instead of shipping a dead press.
export function bind<A extends readonly unknown[]>(
  fn: ((...args: A) => void) | undefined,
  ...args: A
): (() => void) | undefined {
  return fn === undefined ? undefined : () => fn(...args);
}

export type PressableProps = {
  readonly onPress?: (() => void) | undefined;
  /** Touch-down advisory — earlier than onPress; used for row-intent warm. */
  readonly onPressIn?: (() => void) | undefined;
  readonly onLongPress?: (() => void) | undefined;
  readonly delayLongPress?: number | undefined;
  readonly accessibilityLabel: string;
  readonly accessibilityHint?: string | undefined;
  readonly accessibilityRole?: AccessibilityRole | undefined;
  readonly accessibilityState?: AccessibilityState | undefined;
  readonly disabled?: boolean | undefined;
  readonly pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only' | undefined;
  readonly compact?: boolean | undefined;
  readonly hitSlop?: Insets | undefined;
  /** Press feedback — 'fill' washes the surface fg08 while held;
      'opacity' dims instead (drag surfaces where the fill reads as a
      persistent highlight, e.g. the mini-player row). */
  readonly feedback?: 'fill' | 'opacity' | undefined;
  readonly style?:
  | StyleProp<ViewStyle>
  | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
  readonly children?: ReactNode | undefined;
};

export function Pressable({
  onPress,
  onPressIn,
  onLongPress,
  delayLongPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = 'button',
  accessibilityState,
  disabled = false,
  pointerEvents,
  compact = false,
  hitSlop,
  feedback = 'fill',
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
      onPressIn={onPressIn}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      disabled={off}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ ...accessibilityState, disabled: off }}
      pointerEvents={pointerEvents}
      hitSlop={hitSlop ?? (compact ? slop : undefined)}
      style={({ pressed }) => [
        !compact && {
          minWidth: theme.sizes.touch,
          minHeight: theme.sizes.touch,
        },
        pressed && !off && feedback === 'fill' && {
          backgroundColor: theme.colors.fg08,
        },
        pressed && !off && feedback === 'opacity' && { opacity: 0.82 },
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

/**
 * Chrome shared by IconButton + DownloadIconButton: hit slop, a11y
 * role/state, the pressed tint, and the tap scale bounce (a single
 * worklet transform — no JS work per frame).
 */
function IconButtonShell({
  onPress,
  accessibilityLabel,
  size = 32,
  disabled = false,
  active = false,
  hitSlop,
  style,
  children,
}: {
  readonly onPress?: (() => void) | undefined;
  readonly accessibilityLabel: string;
  readonly size?: number | undefined;
  readonly disabled?: boolean | undefined;
  readonly active?: boolean | undefined;
  readonly hitSlop?: number | Insets | undefined;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  // Adjacent small buttons (queue chevrons) clamp the slop so their
  // hit regions can't bleed into each other.
  const slop = hitSlop ?? Math.max(0, (theme.sizes.touch - size) / 2);
  // A button with no handler is inert — it must look and announce as
  // disabled, not ship as a live control that silently does nothing.
  const off = disabled || onPress === undefined;
  const press = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: press.value }],
  }));
  const bounce = !off && !theme.reducedMotion;
  return (
    <RNPressable
      onPress={onPress}
      onPressIn={
        bounce
          ? () => {
              press.value = withTiming(0.82, {
                duration: theme.motion.press,
              });
            }
          : undefined
      }
      onPressOut={
        bounce
          ? () => {
              press.value = withTiming(1, { duration: theme.motion.state });
            }
          : undefined
      }
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
      <Animated.View
        style={[
          { flex: 1, alignItems: 'center', justifyContent: 'center' },
          pressStyle,
        ]}
      >
        {children}
      </Animated.View>
    </RNPressable>
  );
}

export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 32,
  iconSize = 14,
  color,
  disabled = false,
  active = false,
  filled,
  hitSlop,
  style,
}: IconButtonProps) {
  const theme = useTheme();
  return (
    <IconButtonShell
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      size={size}
      disabled={disabled}
      active={active}
      hitSlop={hitSlop}
      style={style}
    >
      {icon === 'heart' || icon === 'heart-filled' ? (
        <HeartIcon
          filled={icon === 'heart-filled' || filled === true}
          size={iconSize}
          color={color ?? theme.colors.textSecondary}
        />
      ) : icon === 'list-plus' && filled !== undefined ? (
        <PlaylistAddIcon
          added={filled}
          size={iconSize}
          color={color ?? theme.colors.textSecondary}
        />
      ) : (
        <Icon
          name={icon}
          size={iconSize}
          color={color ?? theme.colors.textSecondary}
          filled={filled}
        />
      )}
    </IconButtonShell>
  );
}

type PillTone = 'accent' | 'soft' | 'outline' | 'warn';

type PillButtonProps = {
  readonly label: string;
  readonly onPress?: (() => void) | undefined;
  readonly accessibilityLabel?: string | undefined;
  readonly accessibilityState?: AccessibilityState | undefined;
  readonly disabled?: boolean | undefined;
  readonly icon?: IconName | undefined;
  readonly tone?: PillTone | undefined;
  readonly minHeight?: number | undefined;
  readonly style?: StyleProp<ViewStyle> | undefined;
};

/**
 * The one small labeled button — every row/header pill routes through
 * the same four tones so accent (filled CTA), soft (tonal), outline
 * (default) and warn (destructive) read identically across screens.
 */
export function PillButton({
  label,
  onPress,
  accessibilityLabel,
  accessibilityState,
  disabled = false,
  icon,
  tone = 'outline',
  minHeight = 30,
  style,
}: PillButtonProps) {
  const theme = useTheme();
  const fg: Record<PillTone, TextColor> = {
    accent: 'canvas',
    soft: 'accent',
    outline: 'primary',
    warn: 'warn',
  };
  const bg: Record<PillTone, string> = {
    accent: theme.colors.accent,
    soft: theme.colors.accentSoft,
    outline: 'transparent',
    warn: 'transparent',
  };
  const bordered = tone === 'outline' || tone === 'warn';
  return (
    <Pressable
      compact
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={accessibilityState}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.spacing.sm,
          paddingHorizontal: theme.spacing.md,
          minHeight,
          borderRadius: theme.radius.control,
          backgroundColor: bg[tone],
          borderWidth: bordered ? theme.strokes.hairline : 0,
          borderColor: theme.colors.hairline,
        },
        pressed && {
          borderColor: bordered ? theme.colors.fg25 : theme.colors.hairline,
          backgroundColor: bordered ? theme.colors.fg08 : bg[tone],
          ...(bordered ? {} : { opacity: 0.85 }),
        },
        style,
      ]}
    >
      {icon !== undefined && (
        <Icon name={icon} size={13} color={textColor(theme, fg[tone])} />
      )}
      <Text variant="metadata" color={fg[tone]}>
        {label}
      </Text>
    </Pressable>
  );
}

export type ArtworkProps = {
  readonly url: string | null;
  readonly size?: number | undefined;
  readonly fill?: boolean | undefined;
  readonly cornerRadius?: number | undefined;
  readonly monogram?: string | null | undefined;
  readonly dimmed?: boolean | undefined;
  readonly loading?: boolean | undefined;
  readonly style?: StyleProp<ViewStyle> | undefined;
};

export function Artwork({
  url,
  size = 40,
  fill = false,
  cornerRadius,
  monogram,
  dimmed = false,
  loading = false,
  style,
}: ArtworkProps) {
  const theme = useTheme();
  // The resolver caches what it downloads — ask it for the smallest
  // variant covering the rendered pixels instead of the provider's
  // full-res file, so the radio fetch, disk entry, and decode all
  // shrink by the same ratio (a 40px row needs ~120px, not 3000).
  const { width: windowWidth } = useWindowDimensions();
  const targetPx = Math.ceil(
    (fill ? windowWidth : size) * PixelRatio.get(),
  );
  const { uri, pending, markSourceError } = useResolvedArtworkUri(
    url,
    targetPx,
  );
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
      {loading ? (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.raised,
          }}
        >
          <Spinner size={fill ? 24 : Math.max(10, size * 0.3)} />
        </View>
      ) : url === null || pending ? (
        monogram !== null && monogram !== undefined && monogram !== '' ? (
          <RNText
            // Monogram size is pure geometry — never font-scale it.
            allowFontScaling={false}
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
          source={{ uri: uri ?? undefined }}
          style={
            fill
              ? { width: '100%', height: '100%' }
              : { width: size, height: size }
          }
          resizeMode="cover"
          onError={markSourceError}
          accessibilityIgnoresInvertColors
        />
      )}
    </View>
  );
}

/** Artwork with the playing-state scrim + EqBars overlay. */
export function PlayingArtwork({
  url,
  playing,
  size = 40,
  dimmed = false,
}: {
  readonly url: string | null;
  readonly playing: boolean;
  readonly size?: number | undefined;
  readonly dimmed?: boolean | undefined;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: theme.radius.thumb,
        overflow: 'hidden',
      }}
      accessible={false}
    >
      <Artwork url={url} size={size} dimmed={dimmed} />
      {playing && (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.scrim,
          }}
        >
          <EqBars size={11} />
        </View>
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
  | 'podium'
  | 'settings'
  | 'close'
  | 'drag-handle'
  | 'spinner'
  | 'warn'
  | 'download'
  | 'list-plus'
  | 'list-remove'
  | 'home'
  | 'home-filled'
  | 'compass'
  | 'compass-filled'
  | 'library'
  | 'library-filled'
  | 'settings-filled'
  | 'note'
  | 'repeat'
  | 'repeat-one'
  | 'shuffle'
  | 'clock'
  | 'lyrics'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-up'
  | 'chevron-down'
  | 'radio'
  | 'check'
  | 'refresh'
  | 'menu'
  | 'ellipsis';

type GlyphShape =
  | {
      readonly kind: 'path';
      readonly d: string;
      /** evenodd fill-rule — knockout subpaths (filled variants). */
      readonly eo?: boolean;
      /** stays stroked when the glyph itself fills (filled variants). */
      readonly stroke?: boolean;
    }
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

function peo(d: string): GlyphShape {
  return { kind: 'path', d, eo: true };
}

function ps(d: string): GlyphShape {
  return { kind: 'path', d, stroke: true };
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
  podium: {
    filled: false,
    shapes: [rr(4, 10, 4, 9, 1), rr(10, 5, 4, 14, 1), rr(16, 13, 4, 6, 1)],
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
  'settings-filled': {
    filled: true,
    shapes: [
      c(12, 12, 4.5),
      ps('M12 2.5v3m0 13v3M2.5 12h3m13 0h3M5.2 5.2l2.1 2.1m9.4 9.4 2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1'),
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
  'list-remove': {
    filled: false,
    shapes: [p('M4 6h12M4 11h12M4 16h7'), p('m11 13 5 5m0-5-5 5')],
  },
  home: {
    filled: false,
    shapes: [p('M4 11 12 4l8 7v8h-5v-5H9v5H4z')],
  },
  'home-filled': {
    filled: true,
    shapes: [p('M4 11 12 4l8 7v8h-5v-5H9v5H4z')],
  },
  compass: {
    filled: false,
    shapes: [c(12, 12, 8), p('m15.5 8.5-2 5-5 2 2-5z')],
  },
  'compass-filled': {
    filled: true,
    shapes: [
      peo('M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM15.5 8.5l-2 5-5 2 2-5z'),
    ],
  },
  library: {
    filled: false,
    shapes: [p('M5 5v14M9.5 5v14M14 6l5 1.2L16 19l-5-1.2z')],
  },
  'library-filled': {
    filled: true,
    shapes: [
      rr(4.1, 5, 1.8, 14, 0.4),
      rr(8.6, 5, 1.8, 14, 0.4),
      p('M14 6l5 1.2L16 19l-5-1.2z'),
    ],
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
  'repeat-one': {
    filled: false,
    shapes: [
      p('M17 4l3 3-3 3M20 7H7a3 3 0 0 0-3 3v1M7 20l-3-3 3-3M4 17h13a3 3 0 0 0 3-3v-1'),
      p('M13 15V9h-1l-2 1v1h1.5v4H13z'),
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
  radio: {
    filled: false,
    shapes: [
      c(12, 12, 1.6),
      p('M8.46 8.46a5 5 0 0 0 0 7.08M15.54 8.46a5 5 0 0 1 0 7.08'),
      p('M5.64 5.64a9 9 0 0 0 0 12.72M18.36 5.64a9 9 0 0 1 0 12.72'),
    ],
  },
  check: { filled: false, shapes: [p('m5 12.5 4.5 4.5L19 7')] },
  refresh: { filled: false, shapes: [p(REFRESH_PATH)] },
  menu: {
    filled: false,
    shapes: [p('M4 7h16M4 12h16M4 17h16')],
  },
  ellipsis: {
    filled: false,
    shapes: [p('M5 12h.01M12 12h.01M19 12h.01')],
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
  const stroke = useFill ? 'none' : paint;
  const strokeW = strokeWidth ?? theme.strokes.icon;
  const fill = useFill ? paint : 'none';
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      accessible={false}
    >
      {glyph.shapes.map((shape, i) => {
        const common = { stroke, strokeWidth: strokeW, fill };
        switch (shape.kind) {
          case 'path': {
            const keepStroke = shape.stroke === true;
            return (
              <Path
                key={i}
                {...common}
                stroke={useFill && !keepStroke ? 'none' : paint}
                fill={useFill && !keepStroke ? fill : 'none'}
                fillRule={shape.eo === true ? 'evenodd' : 'nonzero'}
                d={shape.d}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          }
          case 'circle':
            return (
              <Circle
                key={i}
                {...common}
                cx={shape.cx}
                cy={shape.cy}
                r={shape.r}
              />
            );
          case 'rect':
            return (
              <Rect
                key={i}
                {...common}
                x={shape.x}
                y={shape.y}
                width={shape.w}
                height={shape.h}
                rx={shape.rx ?? 0}
              />
            );
        }
      })}
    </Svg>
  );
}

export function PlayPauseIcon({
  playing,
  size = 18,
  color,
}: {
  readonly playing: boolean;
  readonly size?: number | undefined;
  readonly color?: string | undefined;
}) {
  const theme = useTheme();
  const amount = useSharedValue(playing ? 1 : 0);
  useEffect(() => {
    const target = playing ? 1 : 0;
    amount.value = theme.reducedMotion
      ? target
      : withTiming(target, { duration: theme.motion.state });
  }, [amount, playing, theme.motion.state, theme.reducedMotion]);
  const leftPath = useDerivedValue(() =>
    quadPath(morphPlayPause(amount.value).left),
  );
  const rightPath = useDerivedValue(() =>
    quadPath(morphPlayPause(amount.value).right),
  );
  const leftProps = useAnimatedProps(() => ({ d: leftPath.value }));
  const rightProps = useAnimatedProps(() => ({ d: rightPath.value }));
  const paint = color ?? theme.colors.textPrimary;
  const morph = morphPlayPause(playing ? 1 : 0);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessible={false}>
      <AnimatedPath
        d={quadPath(morph.left)}
        fill={paint}
        animatedProps={leftProps}
      />
      <AnimatedPath
        d={quadPath(morph.right)}
        fill={paint}
        animatedProps={rightProps}
      />
    </Svg>
  );
}

export function HeartIcon({
  filled,
  size = 14,
  color,
}: {
  readonly filled: boolean;
  readonly size?: number | undefined;
  readonly color?: string | undefined;
}) {
  const theme = useTheme();
  const fill = useSharedValue(filled ? 1 : 0);
  const scale = useSharedValue(1);
  const burst = useSharedValue(1);
  const didMount = useRef(false);
  useEffect(() => {
    const first = !didMount.current;
    didMount.current = true;
    if (theme.reducedMotion) {
      fill.value = filled ? 1 : 0;
      scale.value = 1;
      burst.value = 1;
      return undefined;
    }
    if (filled) {
      fill.value = withTiming(1, { duration: theme.motion.press });
      scale.value = withSequence(
        withTiming(1.14, { duration: theme.motion.press }),
        withTiming(1, { duration: theme.motion.state }),
      );
      // The ring splashes only on a tap after mount — a list of
      // already-liked rows doesn't burst on arrival.
      if (!first) {
        burst.value = withSequence(
          withTiming(0, { duration: 0 }),
          withTiming(1, { duration: theme.motion.state }),
        );
      }
    } else {
      fill.value = withTiming(0, { duration: theme.motion.press });
      scale.value = withTiming(1, { duration: theme.motion.press });
    }
    return undefined;
  }, [
    fill,
    scale,
    burst,
    filled,
    theme.motion.press,
    theme.motion.state,
    theme.reducedMotion,
  ]);
  const style = useAnimatedStyle(() => ({
    opacity: fill.value,
    transform: [{ scale: scale.value }],
  }));
  // The burst ring splashes once on fill, then is gone.
  const ringStyle = useAnimatedStyle(() => ({
    opacity: interpolate(burst.value, [0, 0.15, 1], [0, 0.7, 0]),
    transform: [{ scale: interpolate(burst.value, [0, 1], [0.6, 1.5]) }],
  }));
  const paint = color ?? theme.colors.textSecondary;
  return (
    <View style={{ width: size, height: size }} accessible={false}>
      <Animated.View
        style={[
          {
            position: 'absolute',
            top: -2,
            left: -2,
            width: size + 4,
            height: size + 4,
            borderRadius: (size + 4) / 2,
            borderWidth: theme.strokes.icon,
            borderColor: theme.colors.liked,
          },
          ringStyle,
        ]}
      />
      <Icon name="heart" size={size} color={paint} />
      <Animated.View
        style={[
          {
            position: 'absolute',
            top: 0,
            left: 0,
            width: size,
            height: size,
            alignItems: 'center',
            justifyContent: 'center',
          },
          style,
        ]}
      >
        <Icon name="heart-filled" size={size} color={paint} />
      </Animated.View>
    </View>
  );
}

/** The add-to-playlist mark: the plus glyph spins out while the check
    draws on — same layered construction as DownloadIcon and the web
    PlaylistAddIcon. `added` is the in-playlist truth. */
export function PlaylistAddIcon({
  added,
  size = 14,
  color,
}: {
  readonly added: boolean;
  readonly size?: number | undefined;
  readonly color?: string | undefined;
}) {
  const theme = useTheme();
  const plus = useSharedValue(added ? 0 : 1);
  const draw = useSharedValue(added ? 1 : 0);
  useEffect(() => {
    if (theme.reducedMotion) {
      plus.value = added ? 0 : 1;
      draw.value = added ? 1 : 0;
      return undefined;
    }
    plus.value = withTiming(added ? 0 : 1, {
      duration: theme.motion.press,
    });
    draw.value = withTiming(added ? 1 : 0, {
      duration: theme.motion.state,
    });
    return undefined;
  }, [plus, draw, added, theme.motion.press, theme.motion.state, theme.reducedMotion]);
  const plusStyle = useAnimatedStyle(() => ({
    opacity: plus.value,
    transform: [
      { rotate: `${(1 - plus.value) * 90}deg` },
      { scale: 1 - 0.5 * (1 - plus.value) },
    ],
  }));
  const checkProps = useAnimatedProps(() => ({
    strokeDashoffset: CHECK_DRAW_LENGTH * (1 - draw.value),
    opacity: draw.value,
  }));
  const paint = color ?? theme.colors.textSecondary;
  return (
    <View style={{ width: size, height: size }} accessible={false}>
      <Animated.View
        style={[
          { position: 'absolute', top: 0, left: 0, width: size, height: size },
          plusStyle,
        ]}
      >
        <Icon name="list-plus" size={size} color={paint} />
      </Animated.View>
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={{ position: 'absolute', top: 0, left: 0 }}
      >
        <AnimatedPath
          d={CHECK_DRAW_PATH}
          stroke={paint}
          strokeWidth={theme.strokes.icon}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray={CHECK_DRAW_LENGTH}
          animatedProps={checkProps}
        />
      </Svg>
    </View>
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
        strokeWidth={theme.strokes.icon}
      />
    </Animated.View>
  );
}

// ---- animated icons -------------------------------------------------
// Download state machine — three shared values drive every layer on
// the UI thread; the JS thread only updates targets when the chip
// changes, so no per-frame render ever happens.
//
//   morph   0 arrow ⇄ 1 ring-side (opacity/scale crossfade)
//   draw    0→1 terminal draw: ring closes, then check/warn draws
//   spin    arc rotation, looping only while the phase is 'busy'
//
//   idle    arrow           busy   arc spins
//   done    ring + check    error  ring + warn mark
//
// `animated={false}` (dense lists) and `theme.reducedMotion` snap the
// same layers to their end state — same markup, zero motion.

export type DownloadIconProps = {
  readonly state: DownloadChip;
  readonly size?: number | undefined;
  readonly color?: string | undefined;
  readonly strokeWidth?: number | undefined;
  readonly animated?: boolean | undefined;
};

export function DownloadIcon({
  state,
  size = 14,
  color,
  strokeWidth,
  animated = true,
}: DownloadIconProps) {
  const theme = useTheme();
  const phase = downloadIconState(state);
  const initial = DOWNLOAD_TARGETS[phase];
  const morph = useSharedValue(initial.morph);
  const draw = useSharedValue(initial.draw);
  const spin = useSharedValue(0);
  const run = animated && !theme.reducedMotion;
  useEffect(() => {
    const target = DOWNLOAD_TARGETS[phase];
    morph.value = run
      ? withTiming(target.morph, { duration: theme.motion.state })
      : target.morph;
    draw.value = run
      ? withTiming(target.draw, { duration: theme.motion.state * 1.6 })
      : target.draw;
    if (run && target.spin) {
      spin.value = withRepeat(
        withTiming(360, { duration: 900, easing: Easing.linear }),
        -1,
        false,
      );
      return () => cancelAnimation(spin);
    }
    cancelAnimation(spin);
    spin.value = 0;
    return undefined;
  }, [morph, draw, spin, phase, run, theme.motion.state]);
  const paint = color ?? theme.colors.textPrimary;
  const sw = strokeWidth ?? theme.strokes.icon;
  const box = {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    width: size,
    height: size,
  };
  const arrowStyle = useAnimatedStyle(() => ({
    opacity: 1 - morph.value,
    transform: [{ scale: 1 - 0.45 * morph.value }],
  }));
  const arcStyle = useAnimatedStyle(() => ({
    opacity: morph.value * (1 - draw.value),
    transform: [{ rotate: `${spin.value}deg` }],
  }));
  const ringProps = useAnimatedProps(() => ({
    strokeDashoffset: ICON_RING_LENGTH * (1 - draw.value),
    opacity: morph.value,
  }));
  // The terminal mark waits for the ring to be mostly closed, then
  // draws inside the same `draw` sweep (sub-progress of the channel).
  const checkProps = useAnimatedProps(() => ({
    strokeDashoffset: CHECK_MINI_LENGTH * (1 - markStrokeProgress(draw.value)),
    opacity: phase === 'done' ? 1 : 0,
  }));
  const warnLineProps = useAnimatedProps(() => ({
    strokeDashoffset:
      WARN_MINI_LINE_LENGTH * (1 - markStrokeProgress(draw.value)),
    opacity: phase === 'error' ? 1 : 0,
  }));
  const warnDotProps = useAnimatedProps(() => ({
    opacity: phase === 'error' ? markDotProgress(draw.value) : 0,
  }));
  return (
    <View style={{ width: size, height: size }} accessible={false}>
      <Animated.View style={[box, arrowStyle]}>
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d={DOWNLOAD_ARROW_PATH}
            stroke={paint}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </Animated.View>
      <Animated.View style={[box, arcStyle]}>
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d={ICON_ARC_PATH}
            stroke={paint}
            strokeWidth={sw}
            strokeLinecap="round"
          />
        </Svg>
      </Animated.View>
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        style={box}
      >
        <AnimatedPath
          d={ICON_RING_PATH}
          stroke={paint}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={`${ICON_RING_LENGTH}`}
          animatedProps={ringProps}
        />
        <AnimatedPath
          d={CHECK_MINI_PATH}
          stroke={paint}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={`${CHECK_MINI_LENGTH}`}
          animatedProps={checkProps}
        />
        <AnimatedPath
          d={WARN_MINI_LINE_PATH}
          stroke={paint}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={`${WARN_MINI_LINE_LENGTH}`}
          animatedProps={warnLineProps}
        />
        <AnimatedCircle
          cx={WARN_MINI_DOT.cx}
          cy={WARN_MINI_DOT.cy}
          r={WARN_MINI_DOT.r}
          fill={paint}
          animatedProps={warnDotProps}
        />
      </Svg>
    </View>
  );
}

/** The download affordance as a real button — IconButton chrome with
    the animated icon; paint + selected state come from the view. */
export function DownloadIconButton({
  view,
  size = 32,
  iconSize = 14,
  color,
  disabled = false,
  hitSlop,
  style,
}: {
  readonly view: DownloadButtonView;
  readonly size?: number | undefined;
  readonly iconSize?: number | undefined;
  readonly color?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly hitSlop?: number | Insets | undefined;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const paint =
    color ??
    (view.failed
      ? theme.colors.warn
      : view.stored
        ? theme.colors.accent
        : theme.colors.textSecondary);
  return (
    <IconButtonShell
      onPress={view.onPress}
      accessibilityLabel={view.a11yLabel}
      size={size}
      disabled={disabled}
      active={view.stored}
      hitSlop={hitSlop}
      style={style}
    >
      <DownloadIcon state={view.state} size={iconSize} color={paint} />
    </IconButtonShell>
  );
}

/** A status mark that draws itself once on mount — for states that
    arrive by unmount/remount (sheet rows, footers) where there is no
    persistent element to transition. */
export function StatusMark({
  kind,
  size = 15,
  color,
  strokeWidth,
}: {
  readonly kind: 'check' | 'warn';
  readonly size?: number | undefined;
  readonly color?: string | undefined;
  readonly strokeWidth?: number | undefined;
}) {
  const theme = useTheme();
  const draw = useSharedValue(theme.reducedMotion ? 1 : 0);
  useEffect(() => {
    draw.value = theme.reducedMotion
      ? 1
      : withTiming(1, { duration: theme.motion.state * 1.6 });
    return undefined;
  }, [draw, theme.motion.state, theme.reducedMotion]);
  const paint = color ?? theme.colors.accent;
  const sw = strokeWidth ?? theme.strokes.icon;
  const drawProps = useAnimatedProps(() => ({
    strokeDashoffset:
      (kind === 'check' ? CHECK_DRAW_LENGTH : WARN_DRAW_TRIANGLE_LENGTH) *
      (1 - draw.value),
  }));
  const detailProps = useAnimatedProps(() => ({
    strokeDashoffset:
      WARN_DRAW_DETAIL_LENGTH * (1 - clamp01((draw.value - 0.5) / 0.5)),
  }));
  const dotProps = useAnimatedProps(() => ({
    opacity: markDotProgress(draw.value),
  }));
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      accessible={false}
    >
      {kind === 'check' ? (
        <AnimatedPath
          d={CHECK_DRAW_PATH}
          stroke={paint}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={`${CHECK_DRAW_LENGTH}`}
          animatedProps={drawProps}
        />
      ) : (
        <>
          <AnimatedPath
            d={WARN_DRAW_TRIANGLE_PATH}
            stroke={paint}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={`${WARN_DRAW_TRIANGLE_LENGTH}`}
            animatedProps={drawProps}
          />
          <AnimatedPath
            d={WARN_DRAW_DETAIL_PATH}
            stroke={paint}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={`${WARN_DRAW_DETAIL_LENGTH}`}
            animatedProps={detailProps}
          />
          <AnimatedCircle
            cx={WARN_DRAW_DOT.cx}
            cy={WARN_DRAW_DOT.cy}
            r={WARN_DRAW_DOT.r}
            fill={paint}
            animatedProps={dotProps}
          />
        </>
      )}
    </Svg>
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
        gap: theme.spacing.xxs,
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
