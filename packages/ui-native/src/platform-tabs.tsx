import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppNavbar } from './navbar.tsx';
import { useTheme } from './theme.tsx';
import type { NavItemModel } from '@auqw/ui-shared';

export type PlatformTabsProps = {
  readonly items: readonly NavItemModel[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
  readonly renderTab: (key: string) => ReactNode;
  /** Mini player: native Now Playing capsule on iOS 26, docked above the bar elsewhere. */
  readonly accessory?: ReactNode;
  /** Hide the nav bar (and the accessory with it — it lives in the
      bar's slot on iOS): the expanded stage sheet owns the screen. */
  readonly tabBarHidden?: boolean | undefined;
};

// Non-native fallback (web/desktop): the app's own navbar + docked accessory.
export function PlatformTabs({
  items,
  activeKey,
  onSelect,
  renderTab,
  accessory,
  tabBarHidden = false,
}: PlatformTabsProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
      <View style={{ flex: 1 }}>
        {renderTab(activeKey)}
        {/* Same solid-inset band as the native scenes — covers the
            status bar area so scrolled content can't collide with
            the clock/icons (0-height where there is no inset). */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: insets.top,
            backgroundColor: theme.colors.canvas,
          }}
        />
      </View>
      {tabBarHidden ? null : accessory}
      {tabBarHidden ? null : (
      <AppNavbar items={items} activeKey={activeKey} onSelect={onSelect} />
      )}
    </View>
  );
}
