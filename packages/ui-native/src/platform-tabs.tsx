import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { AppNavbar } from './navbar.tsx';
import { StatusBarCover } from './primitives.tsx';
import { useTheme } from './theme.tsx';
import type { NavItemModel } from '@auqw/ui-shared';

/**
 * Whether the pane containing the consumer is the visible one. Context
 * — not a prop — because a hidden pane's element stays frozen on its
 * last build: only a context change reaches inside it. True outside a
 * keep-alive host (gallery, tests).
 */
const PaneVisibleContext = createContext(true);

export function usePaneVisible(): boolean {
  return useContext(PaneVisibleContext);
}

export { PaneVisibleContext };

/**
 * The strip a floating nav bar overlays at the bottom of the scenes —
 * panes add it to their scroll padding so the last rows clear the bar.
 * 0 on iOS (the native bar reserves its own layout slot) and on the
 * fallback renderer (its bar sits in flow).
 */
const NavFootprintContext = createContext(0);
export { NavFootprintContext };

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
  /** The measured tab-bar height, reported upward — the stage sheet's
      collapsed strip (OpenTune's `collapsedBound`) anchors the
      floating pill to the bar's top edge. */
  readonly onTabBarHeight?: ((height: number) => void) | undefined;
};

// Non-native fallback (web/desktop): the app's own navbar + docked
// accessory. Panes keep-alive like the native tab host does (and like
// the ui-web WorldPanes): a switch used to be a conditional mount that
// paid a full cold mount per screen. Visited panes stay mounted under
// display:'none'; a hidden pane freezes on its last-built element and
// rebuilds at activation — the same commit — so no per-render
// reconcile runs across the mounted world.
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
  // Warm-mount the hidden panes after the first commit — first visits
  // then flip display instead of cold-mounting on the gesture.
  const [warm, setWarm] = useState(false);
  useEffect(() => setWarm(true), []);
  const built = useRef(new Map<string, ReactNode>());
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
      <View style={{ flex: 1 }}>
        {items.map((item) => {
          const active = item.key === activeKey;
          const prev = built.current.get(item.key);
          let element = prev;
          if (active || (warm && prev === undefined)) {
            element = renderTab(item.key);
            built.current.set(item.key, element);
          }
          return (
            <PaneVisibleContext.Provider key={item.key} value={active}>
              <View
                style={active ? { flex: 1 } : { display: 'none' }}
                pointerEvents={active ? 'auto' : 'none'}
                accessibilityElementsHidden={!active}
                importantForAccessibility={
                  active ? 'auto' : 'no-hide-descendants'
                }
              >
                {element}
              </View>
            </PaneVisibleContext.Provider>
          );
        })}
        {/* An activeKey outside `items` still renders — the pane set is
            a keep-alive policy, not a filter on what may show. */}
        {items.some((item) => item.key === activeKey)
          ? null
          : renderTab(activeKey)}
        {/* Edge-to-edge cover: scrolled content glides under a flat
            canvas strip that keeps the clock and icons readable. */}
        <StatusBarCover />
      </View>
      {!tabBarHidden && (
        <>
          {accessory}
          <View
            onLayout={(e) =>
              onTabBarHeight?.(e.nativeEvent.layout.height)
            }
          >
            <AppNavbar items={items} activeKey={activeKey} onSelect={onSelect} />
          </View>
        </>
      )}
    </View>
  );
}
