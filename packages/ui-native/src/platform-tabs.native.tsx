import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ImageSourcePropType, Keyboard, Platform, View } from 'react-native';
import TabView, { useBottomTabBarHeight } from 'react-native-bottom-tabs';
import type { AppleIcon } from 'react-native-bottom-tabs';
import { useTheme } from './theme.tsx';
import { StatusBarCover } from './primitives.tsx';
import { FloatingNavbar } from './navbar.tsx';
import { PaneVisibleContext, NavFootprintContext } from './platform-tabs.tsx';
import type { PlatformTabsProps } from './platform-tabs.tsx';
import type { NavItemModel } from '@auqw/ui-shared';
import iconHome from '../assets/tab-icons/home.png';
import iconExplore from '../assets/tab-icons/explore.png';
import iconLibrary from '../assets/tab-icons/library.png';
import iconSettings from '../assets/tab-icons/settings.png';
import iconHomeOutline from '../assets/tab-icons/home_outline.png';
import iconExploreOutline from '../assets/tab-icons/explore_outline.png';
import iconLibraryOutline from '../assets/tab-icons/library_outline.png';
import iconSettingsOutline from '../assets/tab-icons/settings_outline.png';

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

// M3: inactive tabs read the outlined glyph, active switches to filled.
const PNG_ICONS_OUTLINE: Record<string, ImageSourcePropType> = {
  home: iconHomeOutline,
  explore: iconExploreOutline,
  library: iconLibraryOutline,
  settings: iconSettingsOutline,
};

type Route = {
  key: string;
  title: string;
  focusedIcon: ImageSourcePropType | AppleIcon;
  unfocusedIcon?: ImageSourcePropType;
  lazy?: boolean;
};

function routeFor(item: NavItemModel): Route {
  const base = { key: item.key, title: item.label };
  return Platform.OS === 'ios'
    ? { ...base, focusedIcon: { sfSymbol: SF_SYMBOLS[item.key] ?? 'questionmark' } }
    : {
      ...base,
      focusedIcon: PNG_ICONS[item.key] ?? iconHome,
      unfocusedIcon: PNG_ICONS_OUTLINE[item.key] ?? iconHomeOutline,
    };
}

/**
 * The library's BottomTabBarHeightContext only reaches descendants of
 * TabView — this probe ferries the measured height up to PlatformTabs
 * so the Android dock (a sibling overlay, not a per-scene child) can
 * anchor to the bar's top edge. Renders nothing.
 */
function TabBarHeightProbe({
  onHeight,
}: {
  readonly onHeight: (height: number) => void;
}) {
  const height = useBottomTabBarHeight();
  useEffect(() => {
    onHeight(height);
  }, [height, onHeight]);
  return null;
}

export function PlatformTabs({
  items,
  activeKey,
  onSelect,
  renderTab,
  accessory,
  tabBarHidden = false,
  onTabBarHeight,
}: PlatformTabsProps) {
  const theme = useTheme();
  const index = Math.max(
    0,
    items.findIndex((item) => item.key === activeKey),
  );
  // The iOS accessory lives inside the bar's slot, so tabBarHidden takes
  // it down too; the Android dock is a sibling overlay — hide it
  // explicitly so the pill doesn't linger over the expanded sheet.
  const androidDock =
    accessory != null && Platform.OS === 'android' && !tabBarHidden;

  // Android: adjustResize lands the tab bar flush on top of the IME.
  // Platform convention drops it while the keyboard is open; on iOS the
  // keyboard is a separate window covering the bar, no hiding needed.
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }
    const show = Keyboard.addListener('keyboardDidShow', () =>
      setKeyboardOpen(true),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () =>
      setKeyboardOpen(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // navItems() hands a fresh array each render; rebuilt Route objects
  // would recompute icons/items and push a redundant updateItems to the
  // native bar on every render (including every playback tick). Rebuild
  // only when the (key, label) signature actually changes.
  const signature = items
    .map((item) => `${item.key}\n${item.label}`)
    .join('\n');
  const routesRef = useRef<{ signature: string; routes: Route[] } | null>(
    null,
  );
  if (routesRef.current === null || routesRef.current.signature !== signature) {
    routesRef.current = { signature, routes: items.map(routeFor) };
  }
  const routes = routesRef.current.routes;

  // One dock instance for the whole tab host — rendered inside a scene it
  // would unmount/remount on every tab switch (the remount flash), and the
  // reserve padding would flip mid cross-fade. Anchored to the tab bar's
  // top edge instead; the reported height drops to 0 when the bar hides
  // for the keyboard, keeping the dock just above the IME.
  const [tabBarHeight, setTabBarHeight] = useState<number | null>(null);

  // Android replaces the native strip with the floating capsule — the
  // native bar stays hidden and the capsule's measured footprint (bar
  // + bottom margin) feeds the dock anchor, the stage sheet's park
  // strip, and the panes' bottom reserve via NavFootprintContext.
  const [floatFootprint, setFloatFootprint] = useState<number | null>(
    null,
  );
  const floatHidden = tabBarHidden || keyboardOpen;
  useEffect(() => {
    // Only the keyboard zeroes the footprint — the dock then truly
    // parks at the screen bottom. tabBarHidden keeps the last measured
    // value: the sheet's collapse anchor must already hold the dock's
    // resting height before the remounted bar reports it.
    if (Platform.OS === 'android' && keyboardOpen) {
      setFloatFootprint(0);
      onTabBarHeight?.(0);
    }
  }, [keyboardOpen, onTabBarHeight]);
  const dockBottom =
    Platform.OS === 'android' ? (floatFootprint ?? 0) : (tabBarHeight ?? 0);
  const dockUnmeasured =
    Platform.OS === 'android'
      ? floatFootprint === null
      : tabBarHeight === null;

  // Two halves of the per-switch cost on top of the native host's
  // scene keep-alive:
  // 1. Scenes stay mounted natively once `loaded`, but renderScene was
  //    still invoked for every loaded route on every app render —
  //    each position tick reconciled the whole mounted world. Cache
  //    one element per route: the focused scene rebuilds (live props),
  //    a hidden scene freezes on its last element and rebuilds at
  //    focus — the same commit, so nothing stale is ever visible.
  // 2. A first visit still cold-mounted the scene on the gesture.
  //    After the first commit the warm flag flips getLazy to eager,
  //    mounting the remaining scenes off the gesture path.
  const [warm, setWarm] = useState(false);
  useEffect(() => setWarm(true), []);
  const built = useRef(new Map<string, ReactNode>());
  const sceneFor = (key: string): ReactNode => {
    const prev = built.current.get(key);
    if (key === activeKey || prev === undefined) {
      const element = renderTab(key);
      built.current.set(key, element);
      return element;
    }
    return prev;
  };
  return (
    // Android's floating capsule overlays the scenes — panes read the
    // measured strip so their last rows scroll clear of it. iOS keeps 0
    // (its native bar owns a real layout slot).
    <NavFootprintContext.Provider
      value={Platform.OS === 'android' ? (floatFootprint ?? 0) : 0}
    >
      <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
        <TabView
        navigationState={{ index, routes }}
        getLazy={({ route }) => (warm ? false : route.lazy)}
        renderScene={({ route }) => (
          <View
            style={{
              flex: 1,
              backgroundColor: theme.colors.canvas,
            }}
          >
            {/* Scenes keep-alive off-screen like the fallback's panes —
                visibility reaches consumers through context since a
                hidden scene's element is frozen. */}
            <PaneVisibleContext.Provider value={route.key === activeKey}>
              {sceneFor(route.key)}
            </PaneVisibleContext.Provider>
            {/* Scenes draw edge-to-edge — scrolled content passes
                under the status bar mid-scroll; the flat canvas strip
                keeps the clock and icons readable. */}
            <StatusBarCover />
            <TabBarHeightProbe
              onHeight={(h) => {
                setTabBarHeight(h);
                // Android's strip is the floating capsule — its own
                // overlay reports the footprint, not the native bar.
                if (Platform.OS !== 'android') {
                  onTabBarHeight?.(h);
                }
              }}
            />
          </View>
        )}
        onIndexChange={(next) => {
          const key = items[next]?.key;
          if (key !== undefined && key !== activeKey) {
            onSelect(key);
          }
        }}
        tabBarActiveTintColor={theme.colors.accent}
        tabBarInactiveTintColor={theme.colors.textSecondary}
        tabBarStyle={{ backgroundColor: theme.colors.raised }}
        tabLabelStyle={{ fontFamily: theme.fontFamilies.medium }}
        activeIndicatorColor={theme.colors.accentSoft}
        labeled
        hapticFeedbackEnabled
        minimizeBehavior="onScrollDown"
        scrollEdgeAppearance="transparent"
        // Android's native bar is permanently replaced by the floating
        // capsule below (the capsule hides for the IME + stage sheet
        // itself). On iOS the native bar only yields to the sheet.
        tabBarHidden={Platform.OS === 'android' || tabBarHidden}
        {...(accessory != null && Platform.OS === 'ios'
          ? {
              renderBottomAccessoryView: () => (
                <View style={{ paddingHorizontal: theme.spacing.xs }}>{accessory}</View>
              ),
            }
          : {})}
      />
      {Platform.OS === 'android' && !floatHidden && (
        <View
          pointerEvents="box-none"
          onLayout={(event) => {
            const h = event.nativeEvent.layout.height;
            setFloatFootprint(h);
            onTabBarHeight?.(h);
          }}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
        >
          <FloatingNavbar
            items={items}
            activeKey={activeKey}
            onSelect={onSelect}
          />
        </View>
      )}
      {androidDock && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: dockBottom,
            // unmeasured would overlay the bar for a frame
            opacity: dockUnmeasured ? 0 : 1,
          }}
          pointerEvents="box-none"
        >
          {accessory}
        </View>
      )}
      </View>
    </NavFootprintContext.Provider>
  );
}
