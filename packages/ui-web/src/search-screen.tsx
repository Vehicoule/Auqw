import { useRef } from 'react';
import { Icon, Pressable, Spinner, Text } from './primitives.tsx';
import { TrackRow, useTrackList } from './track-row.tsx';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  UnavailableState,
} from './states.tsx';
import { t } from '@auqw/ui-shared';
import type { SearchStateModel, TrackRowModel } from '@auqw/ui-shared';

export type SearchScreenProps = {
  readonly state: SearchStateModel;
  /**
   * The live editing text for the input — `state.query` is the
   * *submitted* query (what the hints quote), which can never carry
   * keystrokes back to the box. Falls back to `state.query` so static
   * fixtures still render filled.
   */
  readonly query?: string | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onQueryChange?: ((query: string) => void) | undefined;
  readonly onSubmit?: (() => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly onResultPress?: ((row: TrackRowModel) => void) | undefined;
  readonly onToggleLike?: ((row: TrackRowModel) => void) | undefined;
  readonly onContext?: ((row: TrackRowModel) => void) | undefined;
  /** Submitted queries, newest first — rendered on the idle phase. */
  readonly recents?: readonly string[] | undefined;
  readonly onRecentPress?: ((query: string) => void) | undefined;
  /** Focus the input on mount — the '/' global shortcut lands here. */
  readonly autoFocus?: boolean | undefined;
};

export function SearchScreen({
  state,
  query,
  scrollEnabled = true,
  onQueryChange,
  onSubmit,
  onCancel,
  onRetry,
  onResultPress,
  onToggleLike,
  onContext,
  recents = [],
  onRecentPress,
  autoFocus = false,
}: SearchScreenProps) {
  const loading = state.phase === 'loading';
  const editing = query ?? state.query;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const list = useTrackList({
    count: state.results.length,
    onActivate:
      onResultPress === undefined
        ? undefined
        : (index) => {
            const row = state.results[index];
            if (row !== undefined) {
              onResultPress(row);
            }
          },
    onContext:
      onContext === undefined
        ? undefined
        : (index) => {
            const row = state.results[index];
            if (row !== undefined) {
              onContext(row);
            }
          },
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
          aria-label={t('search.fieldLabel')}
          placeholder={t('search.fieldLabel')}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={editing}
          onChange={
            onQueryChange === undefined
              ? undefined
              : (event) => onQueryChange(event.currentTarget.value)
          }
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onSubmit?.();
            }
          }}
          readOnly={onQueryChange === undefined}
        />
        {loading && (
          <>
            <Spinner size={14} />
            {onCancel !== undefined && (
              <Pressable
                onPress={onCancel}
                ariaLabel={t('search.a11y.cancel')}
                className="uw-search__cancel"
              >
                <Text variant="metadata" color="accent">
                  {t('common.cancel')}
                </Text>
              </Pressable>
            )}
          </>
        )}
        {!loading && editing !== '' && onQueryChange !== undefined && (
          <Pressable
            onPress={() => onQueryChange('')}
            ariaLabel={t('search.a11y.clear')}
            className="uw-search__clear"
          >
            <Icon name="close" size={12} color="var(--text-secondary)" />
          </Pressable>
        )}
      </div>
      {state.phase === 'ready' && (
        <div className="uw-search__results-head">
          <Text variant="heading" color="bright">
            {t('search.results')}
          </Text>
          <Text variant="metadata" color="secondary" className="uw-search__count">
            {t('search.resultsMeta', {
              provider: state.providerId ?? t('search.providerFallback'),
              count: state.results.length,
            })}
          </Text>
        </div>
      )}
      {state.phase === 'idle' &&
        (recents.length > 0 ? (
          <div>
            <Text
              variant="label"
              color="secondary"
              uppercase
              className="uw-search__recents-label"
            >
              {t('search.recent')}
            </Text>
            {recents.map((recent) => (
              <Pressable
                key={recent}
                onPress={
                  onRecentPress === undefined
                    ? undefined
                    : () => onRecentPress(recent)
                }
                ariaLabel={t('search.a11y.again', { query: recent })}
                className="uw-search__recent"
              >
                <Icon name="clock" size={14} color="var(--text-secondary)" />
                <Text variant="body" color="primary" numberOfLines={1}>
                  {recent}
                </Text>
              </Pressable>
            ))}
          </div>
        ) : (
          <EmptyState
            title={t('search.emptyTitle')}
            hint={t('search.emptyHint')}
            icon="search"
          />
        ))}
      {state.phase === 'loading' && state.results.length === 0 && (
        <LoadingState title={t('search.loading')} hint={state.query} />
      )}
      {state.phase === 'empty' && (
        <EmptyState
          title={t('search.noResults', { query: state.query })}
          hint={t('search.noResultsHint')}
          icon="search"
        />
      )}
      {state.phase === 'error' && (
        <ErrorState
          title={t('search.failed')}
          hint={state.message}
          onRetry={state.retryable ? onRetry : undefined}
        />
      )}
      {state.phase === 'unavailable' && (
        <UnavailableState
          title={t('search.unavailableTitle')}
          hint={state.message}
        />
      )}
      {(state.phase === 'ready' || state.phase === 'loading') &&
        state.results.length > 0 && (
          <div
            role="list"
            aria-label={t('search.resultsA11y')}
            className="uw-list"
            data-scroll={scrollEnabled ? 'true' : 'false'}
            onKeyDown={list.listProps.onKeyDown}
          >
            {state.results.map((row, index) => (
              <TrackRow
                key={row.key}
                row={row}
                tabIndex={list.rowTabIndex(index)}
                onFocusRow={() => list.onRowFocus(index)}
                onPress={
                  onResultPress === undefined
                    ? undefined
                    : () => onResultPress(row)
                }
                onToggleLike={
                  onToggleLike === undefined
                    ? undefined
                    : () => onToggleLike(row)
                }
                onContext={
                  onContext === undefined ? undefined : () => onContext(row)
                }
              />
            ))}
          </div>
        )}
    </div>
  );
}
