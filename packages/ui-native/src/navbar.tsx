import { Platform, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme } from './theme.tsx';
import { Icon, Pressable, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import type { NavItemModel, PlatformVariant } from './view-models.ts';

const NAV_ICONS: Record<string, IconName> = {
  home: 'home',
  explore: 'compass',
  library: 'library',
  settings: 'settings',
};

function iconFor(key: string): IconName {
  return NAV_ICONS[key] ?? 'note';
}

export type NavbarProps = {
  readonly items: readonly NavItemModel[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
  readonly gestureHandle?: boolean;
};

export function AndroidNavbar({
  items,
  activeKey,
  onSelect,
  gestureHandle = true,
}: NavbarProps) {
  const theme = useTheme();
  return (
    <View>
      <View
        accessibilityRole="tablist"
        style={{
          backgroundColor: theme.colors.deep,
          flexDirection: 'row',
          paddingTop: theme.spacing.sm,
          paddingBottom: 10,
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
                gap: 3,
                minHeight: theme.sizes.touch,
              }}
            >
              <View
                style={{
                  minWidth: 56,
                  height: 30,
                  borderRadius: 15,
                  paddingHorizontal: 14,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: active
                    ? theme.colors.accentSoft
                    : 'transparent',
                }}
              >
                <Icon
                  name={iconFor(item.key)}
                  size={14}
                  color={
                    active ? theme.colors.accent : theme.colors.textSecondary
                  }
                />
              </View>
              <Text
                variant="metadata"
                color={active ? 'accent' : 'secondary'}
                style={[
                  { fontSize: 9.5 },
                  active && { fontFamily: theme.fontFamilies.bold },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {gestureHandle && <GestureHandle background={theme.colors.deep} />}
    </View>
  );
}

export function IosGlassNavbar({
  items,
  activeKey,
  onSelect,
  gestureHandle = true,
}: NavbarProps) {
  const theme = useTheme();
  return (
    <View>
      <View
        style={{
          marginHorizontal: 14,
          marginBottom: theme.spacing.sm,
          borderRadius: 24,
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
            padding: theme.spacing.xs + 2,
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
                  gap: 2,
                  minHeight: theme.sizes.touch,
                }}
              >
                <View
                  style={{
                    minWidth: 44,
                    height: 26,
                    borderRadius: 13,
                    paddingHorizontal: 10,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: active
                      ? theme.colors.accentSoft
                      : 'transparent',
                  }}
                >
                  <Icon
                    name={iconFor(item.key)}
                    size={14}
                    color={
                      active ? theme.colors.accent : theme.colors.textSecondary
                    }
                  />
                </View>
                <Text
                  variant="metadata"
                  color={active ? 'accent' : 'secondary'}
                  style={[
                    { fontSize: 9 },
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
      {gestureHandle && <GestureHandle background="transparent" />}
    </View>
  );
}

function GestureHandle({ background }: { readonly background: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        height: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: background,
      }}
      accessible={false}
    >
      <View
        style={{
          width: 96,
          height: 4,
          borderRadius: 2,
          backgroundColor: theme.colors.fg25,
        }}
      />
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
    <AndroidNavbar {...props} />
  );
}
