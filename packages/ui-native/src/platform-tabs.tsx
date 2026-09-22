import type { ReactNode } from 'react';
import { View } from 'react-native';
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
};

// Non-native fallback (web/desktop): the app's own navbar + docked accessory.
export function PlatformTabs({
  items,
  activeKey,
  onSelect,
  renderTab,
  accessory,
}: PlatformTabsProps) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
      <View style={{ flex: 1 }}>{renderTab(activeKey)}</View>
      {accessory}
      <AppNavbar items={items} activeKey={activeKey} onSelect={onSelect} />
    </View>
  );
}
