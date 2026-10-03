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
      <Icon name={name} size={14} color={color} />
    </Animated.View>
  );
}

export type NavbarProps = {
  readonly items: readonly NavItemModel[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
};

/**
 * The Android dock — the alpha-24 bar: flat on the deep surface,
 * icon-over-label items, and a small accent chip gliding over the
 * active glyph (the M3 indicator's treatment).
 */
export function FloatingNavbar({
  items,
  activeKey,
  onSelect,
}: NavbarProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // One selection mark, not per-slot fills — the accent pill is a
  // single element that glides between slots (the seg indicator's
  // treatment on the dock). Equal flex:1 slots make the target x a
  // pure function of slot width; reduced motion snaps it.
  const [rowW, setRowW] = useState(0);
  const placed = useRef(false);
  const slotW = rowW / Math.max(1, items.length);
  const pillW = Math.max(0, Math.min(56, slotW - theme.spacing.xs));
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
    <View>
      <View
        accessibilityRole="tablist"
        onLayout={onRowLayout}
        style={{
          // The preview's native bar sits on the deep surface.
          backgroundColor: theme.colors.deep,
          flexDirection: 'row',
          paddingTop: theme.spacing.sm,
          // The bar is an overlay, not a layout slot — it must carry
          // the gesture-nav inset itself (the deep surface runs under it).
          paddingBottom: 10 + insets.bottom,
        }}
      >
        {rowW > 0 && pillW > 0 && foundIndex >= 0 && (
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: 'absolute',
                top: theme.spacing.sm,
                left: 0,
                width: pillW,
                height: 30,
                borderRadius: theme.radius.control,
                backgroundColor: theme.colors.accentSoft,
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
                gap: theme.spacing.xs,
                minHeight: theme.sizes.touch,
              }}
            >
              <View
                style={{
                  minWidth: 56,
                  height: 30,
                  borderRadius: theme.radius.control,
                  paddingHorizontal: theme.spacing.screen,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <NavIcon
                  name={iconFor(item.key, active)}
                  active={active}
                  color={
                    active ? theme.colors.accent : theme.colors.textSecondary
                  }
                />
              </View>
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
                  minHeight: theme.sizes.touch,
                }}
              >
                <View
                  style={{
                    minWidth: 44,
                    height: 26,
                    borderRadius: theme.radius.control,
                    paddingHorizontal: 10,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: active
                      ? theme.colors.accentSoft
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
                </View>
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
