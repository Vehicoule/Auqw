import { ImageSourcePropType, Platform, View } from 'react-native';
import TabView from 'react-native-bottom-tabs';
import type { AppleIcon } from 'react-native-bottom-tabs';
import { useTheme } from './theme.tsx';
import type { PlatformTabsProps } from './platform-tabs.tsx';
import type { NavItemModel } from './view-models.ts';
import iconHome from '../assets/tab-icons/home.png';
import iconExplore from '../assets/tab-icons/explore.png';
import iconLibrary from '../assets/tab-icons/library.png';
import iconSettings from '../assets/tab-icons/settings.png';

const SF_SYMBOLS: Record<string, AppleIcon['sfSymbol']> = {
  home: 'house',
  explore: 'magnifyingglass',
  library: 'square.stack',
  settings: 'gearshape',
};

const PNG_ICONS: Record<string, ImageSourcePropType> = {
  home: iconHome,
  explore: iconExplore,
  library: iconLibrary,
  settings: iconSettings,
};

// Space reserved at a scene's bottom edge while the Android docked
// accessory overlays it (mini player height + its margins).
const ACCESSORY_RESERVE = 78;

type Route = {
  key: string;
  title: string;
  focusedIcon: ImageSourcePropType | AppleIcon;
};

function routeFor(item: NavItemModel): Route {
  const symbol = SF_SYMBOLS[item.key] ?? 'questionmark';
  return {
    key: item.key,
    title: item.label,
    focusedIcon:
      Platform.OS === 'ios' ? { sfSymbol: symbol } : PNG_ICONS[item.key] ?? iconHome,
  };
}

export function PlatformTabs({
  items,
  activeKey,
  onSelect,
  renderTab,
  accessory,
}: PlatformTabsProps) {
  const theme = useTheme();
  const index = Math.max(
    0,
    items.findIndex((item) => item.key === activeKey),
  );
  const androidDock = accessory != null && Platform.OS === 'android';
  return (
    <TabView
      navigationState={{ index, routes: items.map(routeFor) }}
      renderScene={({ route }) => (
        <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
          {renderTab(route.key)}
          {androidDock && route.key === activeKey ? (
            <View
              style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
              pointerEvents="box-none"
            >
              {accessory}
            </View>
          ) : null}
        </View>
      )}
      onIndexChange={(next) => {
        const item = items[next];
        if (item !== undefined && item.key !== activeKey) {
          onSelect(item.key);
        }
      }}
      tabBarActiveTintColor={theme.colors.accent}
      tabBarInactiveTintColor={theme.colors.textSecondary}
      tabBarStyle={{ backgroundColor: theme.colors.canvas }}
      activeIndicatorColor={theme.colors.accentSoft}
      labeled
      hapticFeedbackEnabled
      minimizeBehavior="onScrollDown"
      scrollEdgeAppearance="transparent"
      getSceneStyle={({ route }) => ({
        paddingBottom:
          androidDock && route.key === activeKey ? ACCESSORY_RESERVE : 0,
      })}
      {...(accessory != null && Platform.OS === 'ios'
        ? {
            renderBottomAccessoryView: () => (
              <View style={{ paddingHorizontal: 4 }}>{accessory}</View>
            ),
          }
        : {})}
    />
  );
}
