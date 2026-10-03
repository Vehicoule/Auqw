import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from './theme.tsx';
import { Icon, Pressable, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import type { NavItemModel, PlatformVariant } from '@auqw/ui-shared';

const NAV_ICONS: Record<string, IconName> = {
  home: 'home',
  explore: 'compass',
  search: 'search',
  library: 'library',
  queue: 'queue',
  settings: 'settings',
};

/** Filled variants read on the active tab — same swap the M3 dock's PNG pair does. */
const NAV_ICONS_ACTIVE: Record<string, IconName> = {
  home: 'home-filled',
  explore: 'compass-filled',
  library: 'library-filled',
  settings: 'settings-filled',
};

function iconFor(key: string, active: boolean): IconName {
  return (
    (active ? NAV_ICONS_ACTIVE[key] : undefined) ?? NAV_ICONS[key] ?? 'note'
  );
}

/** Tab glyph with a subtle activation lift — one worklet transform;
    reduced motion snaps straight to the end scale. */
function NavIcon({
  name,
  active,
  color,
}: {
  readonly name: IconName;
  readonly active: boolean;
  readonly color: string;
}) {
  const theme = useTheme();
  const lift = useSharedValue(active ? 1.08 : 1);
  useEffect(() => {
    const target = active ? 1.08 : 1;
    lift.value = theme.reducedMotion
      ? target
      : withTiming(target, { duration: theme.motion.state });
  }, [lift, active, theme.motion.state, theme.reducedMotion]);
  const liftStyle = useAnimatedStyle(() => ({
    transform: [{ scale: lift.value }],
  }));
  return (
    <Animated.View style={liftStyle}>
      <Icon name={name} size={20} color={color} />
    </Animated.View>
  );
}

export type NavbarProps = {
  readonly items: readonly NavItemModel[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
};

/**
 * The Android dock — a floating capsule (the iOS-26 style bar): own
 * raised surface + shadow instead of the flat native strip, which had
 * too little contrast against the canvas. One neutral plate glides
 * between slots and wraps icon + label; the accent stays on the
 * active glyph only.
 */
export function FloatingNavbar({
  items,
  activeKey,
  onSelect,
}: NavbarProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // One selection mark, not per-slot fills — the plate is a single
  // element that glides between slots. Equal flex:1 slots make the
  // target x a pure function of slot width; reduced motion snaps it.
  const [rowW, setRowW] = useState(0);
  const placed = useRef(false);
  const slotW = rowW / Math.max(1, items.length);
  const pillW = Math.max(
    0,
    Math.min(Math.round(slotW * 0.78), slotW - theme.spacing.xxs),
  );
  const foundIndex = items.findIndex((item) => item.key === activeKey);
  const targetX = Math.max(0, foundIndex) * slotW + (slotW - pillW) / 2;
  const pillX = useSharedValue(0);
  useEffect(() => {
    if (rowW === 0 || pillW === 0) {
      return;
    }
    if (!placed.current || theme.reducedMotion) {
      pillX.value = targetX;
      placed.current = true;
      return;
    }
    pillX.value = withSpring(targetX, { stiffness: 260, damping: 26 });
  }, [pillX, targetX, rowW, pillW, theme.reducedMotion]);
  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pillX.value }],
  }));
  const onRowLayout = (event: LayoutChangeEvent) => {
    setRowW(event.nativeEvent.layout.width);
  };
  return (
    <View
      style={{
        marginHorizontal: theme.spacing.screen,
        marginBottom: insets.bottom + theme.spacing.sm,
        borderRadius: theme.radius.pill,
        borderWidth: theme.strokes.hairline,
        borderColor: theme.colors.hairline,
        backgroundColor: theme.colors.raised,
        // Separation comes from the shadow, not a tone step.
        elevation: 8,
        shadowColor: theme.colors.scrim,
        shadowOpacity: 0.28,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
        padding: theme.spacing.xs,
      }}
    >
      {/* The measured row stays padding-free — slot widths (and the
          plate's target x) read straight off its layout box. The plate
          stretches top:0/bottom:0 so it wraps the glyph and the label. */}
      <View
        accessibilityRole="tablist"
        onLayout={onRowLayout}
        style={{
          flexDirection: 'row',
        }}
      >
        {rowW > 0 && pillW > 0 && foundIndex >= 0 && (
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: pillW,
                borderRadius: theme.radius.float,
                borderWidth: theme.strokes.hairline,
                borderColor: theme.colors.hairline,
                backgroundColor: theme.colors.fg18,
              },
              pillStyle,
            ]}
          />
        )}
        {items.map((item) => {
          const active = item.key === activeKey;
          return (
            <Pressable
              key={item.key}
              compact
              onPress={() => onSelect(item.key)}
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{ selected: active }}
              style={{
                flex: 1,
                alignItems: 'center',
                gap: theme.spacing.xxs,
                paddingVertical: theme.spacing.sm,
                minHeight: theme.sizes.touch,
              }}
            >
              <NavIcon
                name={iconFor(item.key, active)}
                active={active}
                color={
                  active ? theme.colors.accent : theme.colors.textSecondary
                }
              />
              <Text
                variant="metadata"
                color={active ? 'accent' : 'secondary'}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
                style={[
                  active && { fontFamily: theme.fontFamilies.bold },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function IosGlassNavbar({
  items,
  activeKey,
  onSelect,
}: NavbarProps) {
  const theme = useTheme();
  return (
    <View>
      <View
        style={{
          marginHorizontal: theme.spacing.screen,
          marginBottom: theme.spacing.sm,
          borderRadius: theme.radius.float,
          borderWidth: theme.strokes.hairline,
          borderColor: theme.colors.hairline,
          backgroundColor: theme.colors.glass,
          overflow: 'hidden',
        }}
      >
        <BlurView
          intensity={60}
          tint={theme.scheme === 'light' ? 'light' : 'dark'}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <View
          accessibilityRole="tablist"
          style={{
            flexDirection: 'row',
            padding: theme.spacing.xs + theme.spacing.xxs,
            minHeight: theme.sizes.navbarIos,
          }}
        >
          {items.map((item) => {
            const active = item.key === activeKey;
            return (
              <Pressable
                key={item.key}
                compact
                onPress={() => onSelect(item.key)}
                accessibilityRole="tab"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: active }}
                style={{
                  flex: 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: theme.spacing.xxs,
                  paddingVertical: theme.spacing.xs,
                  minHeight: theme.sizes.touch,
                }}
              >
                <View
                  style={{
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: theme.spacing.xxs,
                    paddingVertical: theme.spacing.xs,
                    paddingHorizontal: theme.spacing.md,
                    // Bound to the slot or long translations widen the
                    // plate past its neighbor's edge.
                    maxWidth: '100%',
                    borderRadius: theme.radius.float,
                    borderWidth: theme.strokes.hairline,
                    borderColor: active
                      ? theme.colors.hairline
                      : 'transparent',
                    backgroundColor: active
                      ? theme.colors.fg18
                      : 'transparent',
                  }}
                >
                  <NavIcon
                    name={iconFor(item.key, active)}
                    active={active}
                    color={
                      active ? theme.colors.accent : theme.colors.textSecondary
                    }
                  />
                  <Text
                    variant="metadata"
                    color={active ? 'accent' : 'secondary'}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.8}
                    style={[
                      active && { fontFamily: theme.fontFamilies.bold },
                    ]}
                  >
                    {item.label}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

export type AppNavbarProps = NavbarProps & {
  readonly platform?: PlatformVariant;
};

export function AppNavbar({ platform, ...props }: AppNavbarProps) {
  const variant = platform ?? (Platform.OS === 'ios' ? 'ios' : 'android');
  return variant === 'ios' ? (
    <IosGlassNavbar {...props} />
  ) : (
    <FloatingNavbar {...props} />
  );
}
