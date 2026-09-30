import { useEffect, useRef } from 'react';
import { CapsLabel, Icon, Pressable, Spinner, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { TrackRow, indexAdapter, useTrackList } from './track-row.tsx';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  UnavailableState,
} from './states.tsx';
import type { SearchStateModel } from '@auqw/ui-shared';
import {
  useSearchScreenController,
  type SearchScreenHandlers,
} from '@auqw/ui-shared/controllers';

// Recent-query and completion rows share the row's Pressable+Icon+Text.
function SearchRow({
  icon,
  label,
  a11yLabel,
  onPress,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly a11yLabel: string;
  readonly onPress?: (() => void) | undefined;
}) {
  return (
    <Pressable onPress={onPress} ariaLabel={a11yLabel} className="uw-search__recent">
      <Icon name={icon} size={14} color="var(--text-secondary)" />
      <Text variant="body" color="primary" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export type SearchScreenProps = SearchScreenHandlers & {
  readonly state: SearchStateModel;
  /**
   * The live editing text for the input — `state.query` is the
   * *submitted* query (what the hints quote), which can never carry
   * keystrokes back to the box. Falls back to `state.query` so static
   * fixtures still render filled.
   */
  readonly query?: string | undefined;
  readonly scrollEnabled?: boolean | undefined;
  /** Submitted queries, newest first — rendered on the idle phase. */
  readonly recents?: readonly string[] | undefined;
  /**
   * Keystroke completions for the live text — rendered whenever the
   * box's text differs from the committed `state.query`, so results
   * from an older search never impersonate matches for the draft.
   */
  readonly suggestions?: readonly string[] | undefined;
  /**
   * Focus the input — passes through to the DOM autofocus attribute
   * on a visible mount, marks the input `[data-autofocus]` so a
   * keep-alive host (WorldPanes) can re-focus it on reveal, and
   * re-focuses whenever `focusSignal` bumps.
   */
  readonly autoFocus?: boolean | undefined;
  /**
   * Bump to re-focus the input without a remount — the '/' global
   * shortcut refocuses even when the tab never left (the old
   * `key={searchFocusTick}` remount cost a full screen re-inflation).
   */
  readonly focusSignal?: number | undefined;
};

export function SearchScreen({
  scrollEnabled = true,
  autoFocus = false,
  focusSignal,
  ...input
}: SearchScreenProps) {
  const view = useSearchScreenController(input);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus, focusSignal]);
  const list = useTrackList({
    count: input.state.results.length,
    onActivate: indexAdapter(input.state.results, input.onResultPress),
    onContext: indexAdapter(input.state.results, input.onContext),
  });
  return (
    <div
      className="uw-screen uw-search"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <div className="uw-search__field">
        <Icon name="search" size={14} color="var(--text-secondary)" />
        <input
          ref={inputRef}
          type="search"
          className="uw-search__input"
          aria-label={view.field.label}
          placeholder={view.field.label}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          data-autofocus={autoFocus ? '' : undefined}
          value={view.field.value}
          onChange={
            view.field.onChange === undefined
              ? undefined
              : (event) => view.field.onChange?.(event.currentTarget.value)
          }
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              view.field.onSubmit?.();
            }
          }}
          readOnly={view.field.readOnly}
        />
        {view.field.loading && (
          <>
            <Spinner size={14} />
            {view.field.cancel !== null && (
              <Pressable
                onPress={view.field.cancel.onPress}
                ariaLabel={view.field.cancel.a11yLabel}
                className="uw-search__cancel"
              >
                <Text variant="metadata" color="accent">
                  {view.field.cancel.label}
                </Text>
              </Pressable>
            )}
          </>
        )}
        {view.field.clear !== null && (
          <Pressable
            onPress={view.field.clear.onPress}
            ariaLabel={view.field.clear.a11yLabel}
            className="uw-search__clear"
          >
            <Icon name="close" size={12} color="var(--text-secondary)" />
          </Pressable>
        )}
      </div>
      {view.suggestions !== null && (
        <div role="list" aria-label={view.suggestions.a11yLabel}>
          <CapsLabel className="uw-search__recents-label">
            {view.suggestions.heading}
          </CapsLabel>
          <SearchRow {...view.suggestions.commit} />
          {view.suggestions.items.map((suggestion) => (
            <SearchRow key={suggestion.label} {...suggestion} />
          ))}
        </div>
      )}
      {view.resultsHead !== null && (
        <div className="uw-search__results-head">
          <Text variant="heading" color="bright">
            {view.resultsHead.title}
          </Text>
          <Text variant="metadata" color="secondary" className="uw-search__count">
            {view.resultsHead.metaLabel}
          </Text>
        </div>
      )}
      {view.idle !== null &&
        (view.idle.kind === 'recents' ? (
          <div>
            <CapsLabel className="uw-search__recents-label">
              {view.idle.heading}
            </CapsLabel>
            {view.idle.items.map((recent) => (
              <SearchRow key={recent.label} {...recent} />
            ))}
          </div>
        ) : (
          <EmptyState
            title={view.idle.title}
            hint={view.idle.hint}
            icon={view.idle.icon}
          />
        ))}
      {view.status?.kind === 'loading' && (
        <LoadingState title={view.status.title} hint={view.status.hint} />
      )}
      {view.status?.kind === 'empty' && (
        <EmptyState
          title={view.status.title}
          hint={view.status.hint}
          icon={view.status.icon}
        />
      )}
      {view.status?.kind === 'error' && (
        <ErrorState
          title={view.status.title}
          hint={view.status.hint}
          onRetry={view.status.onRetry}
        />
      )}
      {view.status?.kind === 'unavailable' && (
        <UnavailableState title={view.status.title} hint={view.status.hint} />
      )}
      {view.results !== null && (
        <div
          role="list"
          aria-label={view.results.a11yLabel}
          className="uw-list"
          data-scroll={scrollEnabled ? 'true' : 'false'}
          onKeyDown={list.onKeyDown}
        >
          {view.results.rows.map((row, index) => (
            <TrackRow
              key={row.row.key}
              row={row.row}
              tabIndex={list.rowTabIndex(index)}
              onFocusRow={() => list.onRowFocus(index)}
              onPress={row.onPress}
              onIntent={row.onIntent}
              onToggleLike={row.onToggleLike}
              onAddToPlaylist={row.onAddToPlaylist}
              onContext={row.onContext}
            />
          ))}
        </div>
      )}
    </div>
  );
}
