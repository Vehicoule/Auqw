import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon, IconButton, Pressable, Spinner, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { globalKeyAction } from './keyboard.ts';
import type { NavItemModel } from '@auqw/ui-shared';

const NAV_ICONS: Record<string, IconName> = {
  home: 'home',
  explore: 'compass',
  search: 'search',
  library: 'library',
  queue: 'queue',
  settings: 'settings',
};

function iconFor(key: string): IconName {
  return NAV_ICONS[key] ?? 'note';
}

export type DesktopSidebarProps = {
  readonly items: readonly NavItemModel[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
};

/**
 * The navbar's desktop form: a left rail with icon + label rows,
 * active row reads the accent pill — same model, same vocabulary.
 */
export function DesktopSidebar({
  items,
  activeKey,
  onSelect,
}: DesktopSidebarProps) {
  return (
    <nav className="uw-sidebar" aria-label="primary">
      <div className="uw-sidebar__brand">
        <Icon name="note" size={15} color="var(--accent)" />
        <Text variant="label" color="bright" uppercase>
          auqw
        </Text>
      </div>
      {items.map((item) => {
        const active = item.key === activeKey;
        return (
          <Pressable
            key={item.key}
            onPress={() => onSelect(item.key)}
            ariaLabel={item.label}
            ariaSelected={active}
            className={`uw-sidebar__item${active ? ' uw-sidebar__item--on' : ''}`}
          >
            <Icon
              name={iconFor(item.key)}
              size={14}
              color={active ? 'var(--accent)' : 'var(--text-secondary)'}
            />
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

export type DesktopHeaderProps = {
  readonly title?: string | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly children?: ReactNode | undefined;
};

/**
 * The thin top strip — optional back chevron + screen title on the
 * left, caller-owned controls (search field slot, transport
 * shortcuts) on the right.
 */
export function DesktopHeader({
  title,
  onBack,
  children,
}: DesktopHeaderProps) {
  return (
    <header className="uw-header">
      {onBack !== undefined && (
        <Pressable onPress={onBack} ariaLabel="back" className="uw-back">
          <Icon name="chevron-left" size={16} color="var(--text-secondary)" />
        </Pressable>
      )}
      {title !== undefined && title !== '' && (
        <Text variant="heading" color="bright" numberOfLines={1}>
          {title}
        </Text>
      )}
      <div className="uw-header__slot">{children}</div>
    </header>
  );
}

export type DesktopChromeProps = {
  readonly items: readonly NavItemModel[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
  readonly header?: ReactNode | undefined;
  readonly miniPlayer?: ReactNode | undefined;
  /**
   * '/' targets the search field app-wide — the chrome owns the global
   * keydown so screens never duplicate it. Editable elements keep
   * their keys (isEditableTarget guards inside globalKeyAction).
   */
  readonly onFocusSearch?: (() => void) | undefined;
  readonly children: ReactNode;
};

/** Sidebar + content column + bottom mini-player region. */
export function DesktopChrome({
  items,
  activeKey,
  onSelect,
  header,
  miniPlayer,
  onFocusSearch,
  children,
}: DesktopChromeProps) {
  useEffect(() => {
    if (onFocusSearch === undefined) {
      return;
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (globalKeyAction(event.key, event.target, event.ctrlKey || event.metaKey) === 'focus-search') {
        event.preventDefault();
        onFocusSearch();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onFocusSearch]);
  return (
    <div className="uw-chrome">
      <DesktopSidebar items={items} activeKey={activeKey} onSelect={onSelect} />
      <div className="uw-chrome__main">
        {header}
        <main className="uw-chrome__content">{children}</main>
        {miniPlayer}
      </div>
    </div>
  );
}

export type WorldSearchProps = {
  /**
   * Open state is caller-owned: the world body switches to the search
   * screen while the field is open, and the nav tabs step aside.
   */
  readonly open: boolean;
  readonly query: string;
  readonly loading?: boolean | undefined;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  readonly onQueryChange?: ((query: string) => void) | undefined;
  readonly onSubmit?: (() => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
};

export type WorldChromeProps = {
  /** The centered home|explore|library tabs. */
  readonly items: readonly NavItemModel[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
  readonly search?: WorldSearchProps | undefined;
  /**
   * Bump to focus the toolbar field (the '/' / Ctrl-K path also opens
   * it via onOpenChange).
   */
  readonly focusSignal?: number | undefined;
  readonly onMenu?: (() => void) | undefined;
  readonly stageCollapsed?: boolean | undefined;
  /** Restore affordance shown in the toolbar while the stage is hidden. */
  readonly onRestoreStage?: (() => void) | undefined;
  readonly miniPlayer?: ReactNode | undefined;
  readonly onFocusSearch?: (() => void) | undefined;
  readonly children: ReactNode;
};

export function searchHintKey(): string {
  const platform =
    typeof navigator === 'undefined' ? '' : (navigator.platform ?? '');
  return /mac|iphone|ipad/i.test(platform) ? '⌘K' : '⌃K';
}

function WorldToolbarSearch({
  search,
  focusSignal,
}: {
  readonly search: WorldSearchProps;
  readonly focusSignal?: number | undefined;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { open, query, loading = false } = search;
  // The signal only drives a *change* — mounting with the initial
  // value must not steal focus on boot.
  const lastSignal = useRef(focusSignal);
  useEffect(() => {
    if (focusSignal !== undefined && focusSignal !== lastSignal.current) {
      inputRef.current?.focus();
    }
    lastSignal.current = focusSignal;
  }, [focusSignal]);
  return (
    <div className={`uw-tsrch${open ? ' uw-tsrch--open' : ''}`}>
      {!open && (
        <Pressable
          ariaLabel="search"
          title={`search (${searchHintKey()})`}
          className="uw-tsrch__icon"
          onPress={() => search.onOpenChange?.(true)}
        >
          <Icon name="search" size={13} color="var(--text-secondary)" />
        </Pressable>
      )}
      <input
        ref={inputRef}
        type="search"
        className="uw-tsrch__input"
        aria-label="search"
        placeholder="search"
        autoComplete="off"
        spellCheck={false}
        value={query}
        readOnly={search.onQueryChange === undefined}
        onFocus={() => search.onOpenChange?.(true)}
        onBlur={() => {
          // A non-empty query keeps results on screen — GTK's rule.
          if (query === '') {
            search.onOpenChange?.(false);
          }
        }}
        onChange={
          search.onQueryChange === undefined
            ? undefined
            : (event) => search.onQueryChange?.(event.currentTarget.value)
        }
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            search.onSubmit?.();
            return;
          }
          if (event.key === 'Escape') {
            if (query === '') {
              search.onOpenChange?.(false);
              event.currentTarget.blur();
            } else {
              search.onCancel?.();
            }
            event.preventDefault();
          }
        }}
      />
      {loading && (
        <>
          <Spinner size={13} />
          {search.onCancel !== undefined && (
            <Pressable
              onPress={search.onCancel}
              ariaLabel="cancel search"
              className="uw-tsrch__cancel"
            >
              <Text variant="metadata" color="accent">
                cancel
              </Text>
            </Pressable>
          )}
        </>
      )}
      {!loading && query !== '' && search.onQueryChange !== undefined && (
        <Pressable
          onPress={() => search.onQueryChange?.('')}
          ariaLabel="clear search"
          className="uw-tsrch__clear"
        >
          <Icon name="close" size={11} color="var(--text-secondary)" />
        </Pressable>
      )}
      {open && <kbd className="uw-tsrch__kbd">esc</kbd>}
    </div>
  );
}

/**
 * The omarchy shell's world column: draggable 56px toolbar (expanding
 * search · centered nav tabs · menu + caption-button reservation)
 * over the content region, with the collapsed-stage mini-player pinned
 * at the bottom.
 */
export function WorldChrome({
  items,
  activeKey,
  onSelect,
  search,
  focusSignal,
  onMenu,
  stageCollapsed = false,
  onRestoreStage,
  miniPlayer,
  onFocusSearch,
  children,
}: WorldChromeProps) {
  useEffect(() => {
    if (onFocusSearch === undefined) {
      return;
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (
        globalKeyAction(
          event.key,
          event.target,
          event.ctrlKey || event.metaKey,
        ) === 'focus-search'
      ) {
        event.preventDefault();
        onFocusSearch();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onFocusSearch]);
  const searchOpen = search?.open === true;
  return (
    <div className="uw-world">
      <div className="uw-toolbar">
        {search !== undefined && (
          <WorldToolbarSearch search={search} focusSignal={focusSignal} />
        )}
        {!searchOpen && (
          <div className="uw-navtabs" role="tablist" aria-label="primary">
            {items.map((item) => {
              const active = item.key === activeKey;
              return (
                <Pressable
                  key={item.key}
                  onPress={() => onSelect(item.key)}
                  ariaLabel={item.label}
                  ariaSelected={active}
                  className={`uw-navtab${active ? ' uw-navtab--on' : ''}`}
                >
                  <Icon
                    name={iconFor(item.key)}
                    size={13}
                    color={
                      active ? 'var(--text-bright)' : 'var(--text-secondary)'
                    }
                  />
                  <Text
                    variant="metadata"
                    color={active ? 'bright' : 'secondary'}
                    numberOfLines={1}
                    className={active ? 'uw-text--bold' : undefined}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </div>
        )}
        <div className="uw-toolbar__right">
          {stageCollapsed && (
            <IconButton
              icon="sidebar"
              size={30}
              iconSize={13}
              color="var(--text-secondary)"
              ariaLabel="show stage"
              onPress={onRestoreStage}
            />
          )}
          <IconButton
            icon="menu"
            size={30}
            iconSize={14}
            color="var(--text-secondary)"
            ariaLabel="menu"
            onPress={onMenu}
          />
          <span className="uw-wco" aria-hidden="true" />
        </div>
      </div>
      <main className="uw-world-body">{children}</main>
      {miniPlayer}
    </div>
  );
}
