import {
  CapsLabel,
  Icon,
  Pressable,
  SkeletonRows,
  Text,
} from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { TrackRow, indexAdapter, useTrackList } from './track-row.tsx';
import {
  EmptyState,
  ErrorState,
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
};

export function SearchScreen({
  scrollEnabled = true,
  ...input
}: SearchScreenProps) {
  const view = useSearchScreenController(input);
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
        <SkeletonRows
          count={8}
          label={
            view.status.hint
              ? `${view.status.title} · ${view.status.hint}`
              : view.status.title
          }
        />
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
