import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  interpolate,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import type { SearchFieldView } from '@auqw/ui-shared/controllers';
import { Icon, Pressable, Spinner, Text } from './primitives.tsx';
import { useTheme } from './theme.tsx';

const AnimatedPath = Animated.createAnimatedComponent(Path);

const FAB = 44;

/**
 * The one search field, floating: a solid loupe pinned top-right over
 * every tab that springs open into the field (the loupe icon travels
 * into the field's leading slot — one element, no swap). On focus an
 * accent comet laps the border once, tail drifting, then the head
 * extends to close the ring — the same ringdraw the web field uses.
 */
export type SearchFabProps = {
  readonly field: SearchFieldView;
  /** A query is live — the collapsed loupe tints accent. */
  readonly live: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Bump to open + focus (the app's search-focus signal). */
  readonly focusSignal?: number | undefined;
  /** Focused while the search surface isn't active — the app routes. */
  readonly onNavigateToSearch?: (() => void) | undefined;
  readonly topInset: number;
  /** Pane width the open field grows into. */
  readonly width: number;
};

export function SearchFab({
  field,
  live,
  open,
  onOpenChange,
  focusSignal,
  onNavigateToSearch,
  topInset,
  width,
}: SearchFabProps) {
  const theme = useTheme();
  const inputRef = useRef<TextInput>(null);
  const openT = useSharedValue(open ? 1 : 0);
  const ring = useSharedValue(0);
  const ringOn = useSharedValue(0);
  const [ringWidth, setRingWidth] = useState(0);

  useEffect(() => {
    openT.value = withSpring(open ? 1 : 0, { stiffness: 260, damping: 26 });
    if (open) {
      // The caret lands as the morph settles, not before the field
      // exists — 120ms is well inside the spring's open leg.
      const timer = setTimeout(() => inputRef.current?.focus(), 120);
      return () => clearTimeout(timer);
    }
    // Closing while focused keeps the soft keyboard over the tab —
    // drop the caret with the field.
    inputRef.current?.blur();
    ring.value = 0;
    ringOn.value = 0;
    return undefined;
  }, [open, openT, ring, ringOn]);

  useEffect(() => {
    if (focusSignal !== undefined && focusSignal > 0) {
      onOpenChange(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal]);

  const startRing = () => {
    ringOn.value = 1;
    ring.value = theme.reducedMotion
      ? 1
      : withTiming(1, { duration: 1500 });
  };

  const openWidth = Math.max(FAB, width - theme.spacing.screen * 2);
  const box = useAnimatedStyle(() => ({
    width: interpolate(openT.value, [0, 1], [FAB, openWidth]),
    borderRadius: interpolate(
      openT.value,
      [0, 1],
      [FAB / 2, theme.radius.float],
    ),
  }));
  const loupeStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(openT.value, [0, 1], [1, 0.8]) }],
  }));
  const innerStyle = useAnimatedStyle(() => ({
    // Fade only — no slide; the content materializes once the field
    // is wide enough to hold it.
    opacity: interpolate(openT.value, [0.55, 0.85], [0, 1]),
  }));

  // Comet ring — the dash math mirrors the web `@keyframes ringdraw`
  // over a pathLength=100 ring: lap (0–58%), tail drift + head extend
  // (58–100%); `ring` drives progress, `ringOn` fades the whole ring.
  const ringSegments = (p: number) => {
    'worklet';
    const easeIn = (u: number) => u * u * (3 - 2 * u);
    const easeOut = (u: number) => 1 - (1 - u) * (1 - u) * (1 - u);
    const seg = (
      v0: number,
      v1: number,
      t0: number,
      t1: number,
      e: number,
    ) => {
      'worklet';
      const u = Math.min(1, Math.max(0, (p - t0) / (t1 - t0)));
      const k = e < 0 ? easeIn(u) : e > 0 ? easeOut(u) : u;
      return v0 + (v1 - v0) * k;
    };
    const arc =
      p < 0.3
        ? seg(5, 24, 0, 0.3, -1)
        : p < 0.58
          ? seg(24, 13, 0.3, 0.58, 0)
          : seg(13, 114, 0.58, 1, 1);
    const off =
      p < 0.3
        ? seg(0, -42, 0, 0.3, -1)
        : p < 0.58
          ? seg(-42, -100, 0.3, 0.58, 0)
          : seg(-100, -114, 0.58, 1, 1);
    return { arc, off };
  };
  // Perimeter of the measured field — the normalized dash units
  // (0–114, matching the web keyframes) scale onto it.
  const ringPerim = useSharedValue(0);
  const ringPropsCore = useAnimatedProps(() => {
    const { arc, off } = ringSegments(ring.value);
    const unit = ringPerim.value / 100;
    return {
      strokeDasharray: `${arc * unit} ${Math.max(0.01, (114 - arc) * unit)}`,
      strokeDashoffset: off * unit,
      opacity: ringOn.value,
    };
  });
  const ringPropsHalo = useAnimatedProps(() => {
    const { arc, off } = ringSegments(ring.value);
    const unit = ringPerim.value / 100;
    return {
      strokeDasharray: `${arc * unit} ${Math.max(0.01, (114 - arc) * unit)}`,
      strokeDashoffset: off * unit,
      opacity: ringOn.value * 0.28,
    };
  });

  const ringPath = (w: number) => {
    // Stroke centerline on the hairline border's midline — the arc
    // traces the entry's edge instead of orbiting inside it.
    const inset = 0.8;
    const r = theme.radius.float - inset;
    const x0 = inset;
    const y0 = inset;
    const x1 = w - inset;
    const y1 = FAB - inset;
    return `M ${x0 + r} ${y0} L ${x1 - r} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y0 + r} L ${x1} ${y1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} L ${x0 + r} ${y1} A ${r} ${r} 0 0 1 ${x0} ${y1 - r} L ${x0} ${y0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0} Z`;
  };

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          top: topInset + theme.spacing.xs,
          right: theme.spacing.screen,
          height: FAB,
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: theme.strokes.hairline,
          borderColor: theme.colors.hairline,
          // Solid surface — the field must read over the content it
          // overlays; a blurred loupe cost a glass pass and still
          // showed fragments of the rows beneath.
          backgroundColor: theme.colors.raised,
        },
        box,
      ]}
    >
      <Pressable
        compact
        accessibilityLabel={field.label}
        onPress={() => {
          if (!open) {
            onOpenChange(true);
          } else {
            onNavigateToSearch?.();
          }
        }}
        style={{
          width: FAB - theme.strokes.hairline * 2,
          height: FAB - theme.strokes.hairline * 2,
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Animated.View style={loupeStyle}>
          <Icon
            name="search"
            size={15}
            color={live ? theme.colors.accent : theme.colors.textSecondary}
          />
        </Animated.View>
      </Pressable>
      <Animated.View
        style={[
          {
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            paddingRight: theme.spacing.xs,
          },
          innerStyle,
        ]}
        pointerEvents={open ? 'auto' : 'none'}
      >
        <TextInput
          ref={inputRef}
          value={field.value}
          editable={!field.readOnly}
          onChangeText={(text) => field.onChange?.(text)}
          onSubmitEditing={() => field.onSubmit?.()}
          onFocus={() => {
            startRing();
            onNavigateToSearch?.();
          }}
          onBlur={() => {
            ringOn.value = withTiming(0, { duration: theme.motion.state });
          }}
          placeholder={field.label}
          placeholderTextColor={theme.colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={field.label}
          style={[
            theme.typography.body,
            { flex: 1, color: theme.colors.textPrimary, padding: 0 },
          ]}
        />
        {field.loading ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.xs,
            }}
          >
            <Spinner size={14} />
            {field.cancel !== null && (
              <Pressable
                compact
                onPress={field.cancel.onPress}
                accessibilityLabel={field.cancel.a11yLabel}
              >
                <Text variant="metadata" color="accent">
                  {field.cancel.label}
                </Text>
              </Pressable>
            )}
          </View>
        ) : (
          field.clear !== null && (
            <Pressable
              compact
              onPress={field.clear.onPress}
              accessibilityLabel={field.clear.a11yLabel}
              style={{ padding: theme.spacing.xs }}
            >
              <Icon name="close" size={12} color={theme.colors.textSecondary} />
            </Pressable>
          )
        )}
        <Pressable
          compact
          onPress={() => onOpenChange(false)}
          accessibilityLabel={field.label}
          style={{ padding: theme.spacing.xs }}
        >
          <Icon
            name="chevron-down"
            size={14}
            color={theme.colors.textSecondary}
          />
        </Pressable>
      </Animated.View>
      {/* The comet ring draws on the settled field, not the morph — it
          mounts with `open` and measures itself. */}
      {open && (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          onLayout={(e) => {
            const w = e.nativeEvent.layout.width;
            setRingWidth(w);
            /* Match ringPath's extents: (w-1.6) × (FAB-1.6) at r 15.2. */
            const inset = 0.8;
            const rw = w - inset * 2;
            const rh = FAB - inset * 2;
            const r = theme.radius.float - inset;
            ringPerim.value = 2 * (rw + rh) - 8 * r + 2 * Math.PI * r;
          }}
        >
          {ringWidth > 0 && (
            <Svg width={ringWidth} height={FAB}>
              <AnimatedPath
                d={ringPath(ringWidth)}
                fill="none"
                stroke={theme.colors.accent}
                strokeWidth={4.5}
                strokeLinecap="round"
                animatedProps={ringPropsHalo}
              />
              <AnimatedPath
                d={ringPath(ringWidth)}
                fill="none"
                stroke={theme.colors.accent}
                strokeWidth={1.6}
                strokeLinecap="round"
                animatedProps={ringPropsCore}
              />
            </Svg>
          )}
        </View>
      )}
    </Animated.View>
  );
}
