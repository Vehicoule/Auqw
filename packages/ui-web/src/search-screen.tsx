import {
  Artwork,
  CapsLabel,
  Icon,
  IconButton,
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
import { t } from '@auqw/ui-shared';
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
      {view.filters !== null && (
        <div
          className="uw-search__chips"
          role="group"
          aria-label={view.filters.a11yLabel}
        >
          {view.filters.chips.map((chip) => (
            <Pressable
              key={chip.key}
              onPress={chip.onPress}
              ariaLabel={chip.label}
              ariaPressed={chip.active}
              className={`uw-chip${chip.active ? ' uw-chip--active' : ''}`}
            >
              <Text variant="metadata" color={chip.active ? 'accent' : 'secondary'}>
                {chip.label}
              </Text>
            </Pressable>
          ))}
        </div>
      )}
      {view.topRow !== null && (
        <div className="uw-search__toprow">
          <div className="uw-search__topres-col">
            <Text variant="heading" color="bright" className="uw-search__band-title">
              {view.topRow.topResultTitle}
            </Text>
            <div className="uw-topres" onMouseEnter={view.topRow.hero.onIntent}>
              <Artwork
                url={view.topRow.hero.row.artworkUrl}
                size={96}
                cornerRadius={10}
                dimmed={view.topRow.hero.row.state !== 'available'}
              />
              <span className="uw-topres__text">
                <Text variant="title" color="bright" numberOfLines={2}>
                  {view.topRow.hero.row.title}
                </Text>
                <Text variant="metadata" color="secondary" numberOfLines={1}>
                  {view.topRow.hero.metaLabel}
                </Text>
              </span>
              <IconButton
                icon="play"
                size={40}
                iconSize={18}
                className="uw-topres__play"
                ariaLabel={view.topRow.hero.a11yLabel}
                onPress={view.topRow.hero.onPress}
              />
            </div>
          </div>
          <div className="uw-search__songs">
            <Text variant="heading" color="bright" className="uw-search__band-title">
              {view.topRow.songsTitle}
            </Text>
            <div role="list" aria-label={view.topRow.songsA11yLabel}>
              {view.topRow.songs.map((row, index) => (
                <TrackRow
                  key={row.row.key}
                  row={row.row}
                  index={`${index + 1}`}
                  album={row.row.album}
                  onPress={row.onPress}
                  onIntent={row.onIntent}
                  onToggleLike={row.onToggleLike}
                  onAddToPlaylist={row.onAddToPlaylist}
                  onContext={row.onContext}
                />
              ))}
            </div>
          </div>
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
      {view.results !== null && (
        <div className="uw-search__thead" aria-hidden="true">
          <span className="uw-search__th uw-search__th--idx">
            <Text variant="label" color="secondary">#</Text>
          </span>
          <span className="uw-search__th uw-search__th--art" />
          <span className="uw-search__th uw-search__th--title">
            <Text variant="label" color="secondary">
              {t('search.table.title')}
            </Text>
          </span>
          <span className="uw-search__th uw-search__th--album">
            <Text variant="label" color="secondary">
              {t('search.table.album')}
            </Text>
          </span>
          <span className="uw-search__th uw-search__th--time">
            <Text variant="label" color="secondary">
              {t('search.table.time')}
            </Text>
          </span>
          <span className="uw-search__th uw-search__th--tail" />
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
              index={`${index + 1}`}
              album={row.row.album}
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
