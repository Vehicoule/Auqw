import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Icon, Pressable, Text } from './primitives.tsx';
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
      if (globalKeyAction(event.key, event.target) === 'focus-search') {
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
