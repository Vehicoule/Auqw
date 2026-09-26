import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon, IconButton, Pressable, Text } from './primitives.tsx';
import { globalKeyAction } from './keyboard.ts';
import { useOverlayDismiss } from './stack.tsx';
import { t } from '@auqw/ui-shared';
import type { NavItemModel } from '@auqw/ui-shared';

/**
 * The world's top toolbar — the GTK header bar's form. Start: stage
 * toggle + search. Center: the page switcher. End: the primary menu.
 * The strip is also the frameless drag surface; window caption buttons
 * overlay its far right on win32/linux (see `--uw-caption-w` in
 * styles.css) and the traffic lights sit over the stage column on
 * macOS.
 */

export type WorldTabsProps = {
  readonly tabs: readonly NavItemModel[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
};

/** Centered page switcher — text pills, active one reads accent. */
export function WorldTabs({ tabs, activeKey, onSelect }: WorldTabsProps) {
  return (
    <nav className="uw-tabs" aria-label={t('nav.primaryA11y')}>
      {tabs.map((item) => {
        const active = item.key === activeKey;
        return (
          <Pressable
            key={item.key}
            onPress={() => onSelect(item.key)}
            ariaLabel={item.label}
            ariaSelected={active}
            className={`uw-tabs__item${active ? ' uw-tabs__item--on' : ''}`}
          >
            <Text
              variant="metadata"
              color={active ? 'accent' : 'secondary'}
              numberOfLines={1}
              className={active ? 'uw-text--bold' : undefined}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </nav>
  );
}

export type WorldMenuProps = {
  readonly onOpenSettings: () => void;
};

/** The primary menu — today it only carries settings, GTK-parity. */
export function WorldMenu({ onOpenSettings }: WorldMenuProps) {
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
   * Stops playback and clears the stage's track (the queue keeps its
   * items — the old mini-player's dismiss). Omitted when nothing is
   * loaded, so no dead button shows over the empty state.
   */
  readonly onStopPlayback?: (() => void) | undefined;
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
  onStopPlayback,
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
        <div className="uw-stage-head">
          <span className="uw-stage-head__fill" />
          {onStopPlayback !== undefined && (
            <IconButton
              icon="close"
              size={32}
              iconSize={14}
              color="var(--text-secondary)"
              ariaLabel={t('player.a11y.stopDismiss')}
              onPress={onStopPlayback}
            />
          )}
          <IconButton
            icon="chevron-left"
            size={32}
            iconSize={14}
            color="var(--text-secondary)"
            ariaLabel={t('chrome.stage.hide')}
            onPress={() => setOpen(false)}
          />
        </div>
        <div className="uw-stage-col__body">{stage}</div>
      </aside>
      <div className="uw-world">
        <header className="uw-world-bar">
          <IconButton
            icon="sidebar"
            size={32}
            iconSize={14}
            color="var(--text-secondary)"
            ariaLabel={t('chrome.stage.show')}
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
          <WorldTabs tabs={tabs} activeKey={activeKey} onSelect={onSelect} />
          {onOpenSettings !== undefined && (
            <WorldMenu onOpenSettings={onOpenSettings} />
          )}
        </header>
        <main className="uw-world__content">{children}</main>
      </div>
    </div>
  );
}
