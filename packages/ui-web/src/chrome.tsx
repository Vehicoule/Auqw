import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon, IconButton, Pressable, SegmentItem, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { globalKeyAction } from './keyboard.ts';
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
            icon={NAV_ICONS[item.key] ?? 'note'}
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
  children,
}: DesktopChromeProps) {
  const [internalOpen, setInternalOpen] = useState(true);
  const open = stageOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    setInternalOpen(value);
    onStageOpenChange?.(value);
  };
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
        <header className="uw-world-bar">
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
            {onFocusSearch !== undefined && (
              <IconButton
                icon="search"
                size={32}
                iconSize={14}
                color="var(--text-secondary)"
                ariaLabel={t('search.fieldLabel')}
                onPress={onFocusSearch}
              />
            )}
          </div>
          <WorldTabs tabs={tabs} activeKey={activeKey} onSelect={onSelect} />
          <div className="uw-world-bar__end">
            {onOpenSettings !== undefined && (
              <WorldMenu onOpenSettings={onOpenSettings} />
            )}
          </div>
        </header>
        <main className="uw-world__content">{children}</main>
      </div>
    </div>
  );
}
