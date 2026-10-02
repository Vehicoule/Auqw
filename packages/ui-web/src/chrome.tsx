import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon, IconButton, Pressable, SegmentItem, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { globalKeyAction } from './keyboard.ts';
import { WorldSearch } from './search-field.tsx';
import type { WorldSearchProps } from './search-field.tsx';
import { useOverlayDismiss } from './stack.tsx';
import { t } from '@auqw/ui-shared';
import type { NavItemModel } from '@auqw/ui-shared';

/**
 * The world's top toolbar — the GTK header bar's form. Start: stage
 * toggle + search. Center: the page switcher. End: the primary menu.
 * The strip is also the frameless drag surface; window caption buttons
 * overlay its far right on win32/linux (see `--uw-caption-w` in
 * styles.css) and the traffic lights sit over the stage column's
 * top-left on macOS — the stage itself carries no chrome of its own:
 * it runs to the window's top edge and collapse lives only on this
 * bar's toggle (design.md's chromeless sidebar).
 */

/** Same key→glyph map the native navbar resolves items with. */
const NAV_ICONS: Record<string, IconName> = {
  home: 'home',
  explore: 'compass',
  search: 'search',
  library: 'library',
  queue: 'queue',
  settings: 'settings',
};

/** Filled variants read on the active tab — same pair the native dock swaps. */
const NAV_ICONS_ACTIVE: Record<string, IconName> = {
  home: 'home-filled',
  explore: 'compass-filled',
  library: 'library-filled',
  settings: 'settings-filled',
};

/**
 * Centered page switcher — the same segmented-pill construction as
 * the stage's mode segment (accentSoft tonal fill, accent glyph +
 * label), just sized down for the strip and carrying larger text.
 */
function WorldTabs({
  tabs,
  activeKey,
  onSelect,
}: {
  readonly tabs: readonly NavItemModel[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
}) {
  return (
    <nav className="uw-tabs" aria-label={t('nav.primaryA11y')}>
      <div className="uw-segment uw-segment--tabs">
        {tabs.map((item) => (
          <SegmentItem
            key={item.key}
            icon={
              (item.key === activeKey
                ? NAV_ICONS_ACTIVE[item.key]
                : undefined) ??
              NAV_ICONS[item.key] ??
              'note'
            }
            label={item.label}
            active={item.key === activeKey}
            onPress={() => onSelect(item.key)}
            iconSize={13}
            textVariant="body"
            numberOfLines={1}
          />
        ))}
      </div>
    </nav>
  );
}

/** The primary menu — today it only carries settings, GTK-parity. */
function WorldMenu({ onOpenSettings }: { readonly onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useOverlayDismiss(open ? close : undefined);
  return (
    <div className="uw-menu">
      <IconButton
        icon="menu"
        size={32}
        iconSize={14}
        color="var(--text-secondary)"
        ariaLabel={t('chrome.menu')}
        active={open}
        onPress={() => setOpen((v) => !v)}
      />
      {open && (
        <>
          <button
            type="button"
            className="uw-menu-backdrop"
            aria-label={t('common.dismiss')}
            onClick={close}
            tabIndex={-1}
          />
          <div className="uw-menu-pop" role="menu">
            <Pressable
              onPress={() => {
                setOpen(false);
                onOpenSettings();
              }}
              ariaLabel={t('nav.settings')}
              className="uw-menu-row"
            >
              <Icon name="settings" size={13} color="var(--text-secondary)" />
              <Text variant="metadata" color="primary">
                {t('nav.settings')}
              </Text>
            </Pressable>
          </div>
        </>
      )}
    </div>
  );
}

export type DesktopChromeProps = {
  /** Page-switcher items shown centered in the world toolbar. */
  readonly tabs: readonly NavItemModel[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
  /**
   * The stage column's body — the app passes NowPlayingScreen (or an
   * empty state while nothing is loaded); the chrome owns the column's
   * golden-ratio geometry and collapse, never its content.
   */
  readonly stage: ReactNode;
  readonly stageOpen?: boolean | undefined;
  readonly onStageOpenChange?: ((open: boolean) => void) | undefined;
  /**
   * '/' targets the search field app-wide — the chrome owns the global
   * keydown so screens never duplicate it. Editable elements keep
   * their keys (isEditableTarget guards inside globalKeyAction).
   */
  readonly onFocusSearch?: (() => void) | undefined;
  readonly onOpenSettings?: (() => void) | undefined;
  /**
   * Extra affordances in the bar's end cluster, rendered left of the
   * primary menu — e.g. the quiet update entry (its badge carries the
   * state; nothing here may pop a surface uninvited).
   */
  readonly updateEntry?: ReactNode;
  /**
   * The one search field — a compact pill in the bar's end cluster that
   * collapses to its loupe while the world body is scrolled. Tab bodies
   * carry no second field.
   */
  readonly search?: Omit<
    WorldSearchProps,
    'collapsed' | 'onExpand' | 'onFocusChange'
  >;
  readonly children: ReactNode;
};

/** Split view: golden-ratio stage column + world column with toolbar. */
export function DesktopChrome({
  tabs,
  activeKey,
  onSelect,
  stage,
  stageOpen,
  onStageOpenChange,
  onFocusSearch,
  onOpenSettings,
  updateEntry,
  search,
  children,
}: DesktopChromeProps) {
  const [internalOpen, setInternalOpen] = useState(true);
  const open = stageOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    setInternalOpen(value);
    onStageOpenChange?.(value);
  };
  // The toolbar field rides the scroll: it drops to its loupe once the
  // body moves, and comes back at the top or on demand. It never hides
  // focus — a focused field stays open regardless of scroll.
  const [searchCollapsed, setSearchCollapsed] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const lastScrollTop = useRef(0);
  // When the bar can't fit field + tabs + caption buttons, the field
  // would paint over the tabs. Tightness must not depend on the
  // field's current form (measuring its own cluster oscillates:
  // expand → overflow → collapse → fits → repeat), so derive it from
  // stable geometry — the bar's content box, the tabs' width, and the
  // end cluster's non-field siblings. Each outer grid track gets half
  // the space left over from the tabs (floor 68px, per the grid def).
  const barRef = useRef<HTMLElement | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [endTight, setEndTight] = useState(false);
  const [expandedWhileTight, setExpandedWhileTight] = useState(false);
  useEffect(() => {
    const bar = barRef.current;
    const end = endRef.current;
    if (bar === null || end === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const tabs = bar.querySelector('.uw-tabs');
      const style = globalThis.getComputedStyle(bar);
      const content =
        bar.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      const trackHalf = Math.max(
        68,
        (content - (tabs === null ? 0 : tabs.clientWidth)) / 2,
      );
      let others = 0;
      for (const child of Array.from(end.children)) {
        if (!child.classList.contains('uw-wsearch')) {
          others += (child as HTMLElement).offsetWidth;
        }
      }
      // 200 = the expanded field's width (.uw-wsearch) + 8px of slack
      // so the overlay engages just before the clip edge.
      setEndTight(trackHalf < others + 208);
    });
    observer.observe(bar);
    observer.observe(end);
    // The tabs' width is an input to the predicate — locale switches
    // widen labels without resizing anything observed.
    const tabs = bar.querySelector('.uw-tabs');
    if (tabs !== null) {
      observer.observe(tabs);
    }
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (endTight) {
      setExpandedWhileTight(false);
      setSearchCollapsed(true);
    }
  }, [endTight]);
  useEffect(() => {
    if (search?.focusSignal !== undefined) {
      setExpandedWhileTight(true);
      setSearchCollapsed(false);
    }
  }, [search?.focusSignal]);
  useEffect(() => {
    if (onFocusSearch === undefined) {
      return;
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (globalKeyAction(event.key, event.target) === 'focus-search') {
        event.preventDefault();
        onFocusSearch();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onFocusSearch]);
  return (
    <div className="uw-chrome" data-stage={open ? 'open' : 'closed'}>
      <aside className="uw-stage-col">
        {/* Invisible drag grip — only rendered at the <860px overlay
            breakpoint, where the floating column covers the toolbar
            and the scrim covers the rest (see styles.css). */}
        <div className="uw-stage-drag" aria-hidden="true" />
        <div className="uw-stage-col__body">{stage}</div>
      </aside>
      {/* Only visible under the 860px overlay breakpoint — tap-outside
          dismissal for the floating column. */}
      {open && (
        <button
          type="button"
          className="uw-stage-scrim"
          aria-label={t('chrome.stage.hide')}
          onClick={() => setOpen(false)}
        />
      )}
      <div className="uw-world">
        <header className="uw-world-bar" ref={barRef}>
          <div className="uw-world-bar__start">
            <IconButton
              icon="sidebar"
              size={32}
              iconSize={14}
              color="var(--text-secondary)"
              ariaLabel={t(open ? 'chrome.stage.hide' : 'chrome.stage.show')}
              active={open}
              onPress={() => setOpen(!open)}
            />
          </div>
          <WorldTabs tabs={tabs} activeKey={activeKey} onSelect={onSelect} />
          <div className="uw-world-bar__end" ref={endRef}>
            {search !== undefined && (
              <WorldSearch
                {...search}
                collapsed={
                  searchCollapsed || (endTight && !expandedWhileTight)
                }
                overlay={endTight}
                onExpand={() => {
                  setExpandedWhileTight(true);
                  setSearchCollapsed(false);
                }}
                onFocusChange={(focused) => {
                  setSearchFocused(focused);
                  if (!focused) {
                    // Tight bars fold the overlay back down on blur —
                    // there's no room to leave the field open.
                    setExpandedWhileTight(false);
                    setSearchCollapsed(lastScrollTop.current > 24 || endTight);
                  }
                }}
              />
            )}
            {updateEntry}
            {onOpenSettings !== undefined && (
              <WorldMenu onOpenSettings={onOpenSettings} />
            )}
          </div>
        </header>
        <main
          className="uw-world__content"
          // Scroll doesn't bubble — capture reaches every pane's own
          // scroller; the target is whichever element scrolled.
          onScrollCapture={(event) => {
            if (search === undefined) {
              return;
            }
            const top = (event.target as HTMLElement).scrollTop;
            lastScrollTop.current = top;
            // A focused field stays open — collapsing it would drop
            // the caret mid-typing; the blur re-applies the scroll.
            if (!searchFocused) {
              setSearchCollapsed(top > 24);
            }
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
