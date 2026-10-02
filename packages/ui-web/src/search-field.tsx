import { useEffect, useRef } from 'react';
import type { SearchFieldView } from '@auqw/ui-shared/controllers';
import { Icon, Spinner } from './primitives.tsx';

export type WorldSearchProps = {
  /** Field view from `useSearchScreenController` — the toolbar field IS
      the single search field (the tab body carries no second box). */
  readonly field: SearchFieldView;
  /** A query is live — the collapsed loupe tints accent. */
  readonly live: boolean;
  /**
   * Collapse-controlled: the chrome drops the field to a loupe while the
   * world body is scrolled so search stays reachable without stealing
   * header space; expand is a tap or the '/' global key.
   */
  readonly collapsed: boolean;
  readonly onExpand: () => void;
  /** Bump (the '/' global key) — expands + focuses the input. */
  readonly focusSignal?: number | undefined;
  /** Focused while the search surface isn't active — the app routes. */
  readonly onNavigateToSearch?: (() => void) | undefined;
};

/**
 * The compact world-toolbar search field. Collapsed it is a bare loupe;
 * expanded it is a pill field whose accent ring does one comet lap on
 * focus, then the head extends to close the border (`.uw-wsearch__ring`).
 */
export function WorldSearch({
  field,
  live,
  collapsed,
  onExpand,
  focusSignal,
  onNavigateToSearch,
}: WorldSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, [focusSignal]);
  // Collapse→expand transition lands the caret — the loupe press and the
  // '/' signal both route through it (the input only exists expanded).
  const wasCollapsed = useRef(collapsed);
  useEffect(() => {
    if (wasCollapsed.current && !collapsed) {
      inputRef.current?.focus();
    }
    wasCollapsed.current = collapsed;
  }, [collapsed]);
  if (collapsed) {
    return (
      <button
        type="button"
        className="uw-wsearch uw-wsearch--loupe"
        data-live={live || undefined}
        aria-label={field.label}
        onClick={onExpand}
      >
        <Icon name="search" size={14} />
      </button>
    );
  }
  return (
    <div className="uw-wsearch" data-live={live || undefined}>
      <Icon name="search" size={14} />
      <input
        ref={inputRef}
        className="uw-wsearch__input"
        value={field.value}
        readOnly={field.readOnly}
        placeholder={field.label}
        aria-label={field.label}
        onFocus={onNavigateToSearch}
        onChange={(event) => field.onChange?.(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            field.onSubmit?.();
          }
        }}
      />
      {field.loading ? (
        <>
          <Spinner size={12} />
          {field.cancel !== null && (
            <button
              type="button"
              className="uw-wsearch__cancel"
              aria-label={field.cancel.a11yLabel}
              onClick={field.cancel.onPress}
            >
              {field.cancel.label}
            </button>
          )}
        </>
      ) : (
        field.clear !== null && (
          <button
            type="button"
            className="uw-wsearch__clear"
            aria-label={field.clear.a11yLabel}
            onClick={field.clear.onPress}
          >
            <Icon name="close" size={12} />
          </button>
        )
      )}
      <kbd className="uw-wsearch__hint" aria-hidden="true">
        /
      </kbd>
      {/* Comet ring — laps the border once on focus, then the head
          extends until the entry is ringed. Pure CSS on focus-within;
          reduced-motion paints the settled ring. */}
      <svg className="uw-wsearch__ring" aria-hidden="true">
        <rect className="halo" x="1" y="1" pathLength="100" />
        <rect className="core" x="1" y="1" pathLength="100" />
      </svg>
    </div>
  );
}
