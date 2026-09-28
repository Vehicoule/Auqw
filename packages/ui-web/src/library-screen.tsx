import { Artwork, Icon, Pressable, Text } from './primitives.tsx';
import { TrackRow, useTrackList } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import { NameField } from './sheets.tsx';
import type { LibraryModel } from '@auqw/ui-shared';
import {
  useLibraryScreenController,
  type LibraryCardView,
  type LibraryCollectionView,
  type LibraryScreenHandlers,
} from '@auqw/ui-shared/controllers';

export type LibraryScreenProps = LibraryScreenHandlers & {
  readonly model: LibraryModel;
  readonly scrollEnabled?: boolean | undefined;
};

function CollectionTile({ view }: { readonly view: LibraryCollectionView }) {
  const { tile } = view;
  return (
    <Pressable
      onPress={view.enabled ? view.onOpen : undefined}
      disabled={!view.enabled}
      ariaLabel={view.a11yLabel}
      className={`uw-collection${view.enabled ? '' : ' uw-off'}`}
      data-enabled={view.enabled ? 'true' : 'false'}
    >
      <span className="uw-collection__icon">
        <Icon
          name={view.icon}
          size={20}
          color={view.enabled ? 'var(--accent)' : 'var(--text-secondary)'}
        />
      </span>
      <Text
        variant="title"
        color={view.enabled ? 'bright' : 'primary'}
        numberOfLines={1}
        className="uw-collection__label"
      >
        {tile.label}
      </Text>
      <Text
        variant="body"
        color="secondary"
        numberOfLines={1}
        className="uw-collection__count"
      >
        {view.countLabel}
      </Text>
    </Pressable>
  );
}

function ToggleChip({
  label,
  active,
  onPress,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      ariaLabel={label}
      ariaPressed={active}
      className={`uw-chip${active ? ' uw-chip--active' : ''}`}
    >
      <Text variant="metadata" color={active ? 'accent' : 'secondary'}>
        {label}
      </Text>
    </Pressable>
  );
}

function NewPlaylistCard({
  view,
  label,
  a11yLabel,
  onPress,
}: {
  readonly view: 'grid' | 'list';
  readonly label: string;
  readonly a11yLabel: string;
  readonly onPress?: (() => void) | undefined;
}) {
  if (view === 'list') {
    return (
      <Pressable
        onPress={onPress}
        ariaLabel={a11yLabel}
        className="uw-newpl uw-newpl--row"
      >
        <span className="uw-newpl__art">
          <Icon name="list-plus" size={15} />
        </span>
        <Text variant="body" color="secondary">
          {label}
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      ariaLabel={a11yLabel}
      className="uw-newpl uw-newpl--grid"
    >
      <Icon name="list-plus" size={16} />
      <Text variant="metadata" color="secondary" className="uw-newpl__label">
        {label}
      </Text>
    </Pressable>
  );
}

function LibraryCard({
  view,
  layout,
}: {
  readonly view: LibraryCardView;
  readonly layout: 'grid' | 'list';
}) {
  const { card } = view;
  const openable = card.playlistId !== null || card.entityRef !== null;
  const press = openable ? view.onPress : undefined;
  if (layout === 'list') {
    return (
      <Pressable
        onPress={press}
        ariaLabel={view.a11yLabel}
        className="uw-libcard uw-libcard--row"
      >
        <Artwork url={card.artworkUrl} size={40} dimmed={!openable} />
        <span className="uw-libcard__text">
          <Text variant="body" color="primary" numberOfLines={1}>
            {card.title}
          </Text>
          <Text variant="metadata" color="secondary" numberOfLines={1}>
            {card.subtitle}
          </Text>
        </span>
        {openable && (
          <Icon name="chevron-right" size={12} color="var(--text-secondary)" />
        )}
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={press}
      ariaLabel={view.a11yLabel}
      className="uw-libcard uw-libcard--grid"
    >
      <Artwork url={card.artworkUrl} size={132} dimmed={!openable} />
      <Text variant="body" color="primary" numberOfLines={1}>
        {card.title}
      </Text>
      <Text variant="metadata" color="secondary" numberOfLines={1}>
        {card.subtitle}
      </Text>
    </Pressable>
  );
}

export function LibraryScreen({
  model,
  scrollEnabled = true,
  onPressItem,
  onToggleLike,
  onAddToPlaylist,
  onContext,
  onOpenCollection,
  onOpenCard,
  onOpenArtist,
  onCreatePlaylist,
}: LibraryScreenProps) {
  const view = useLibraryScreenController({
    model,
    onPressItem,
    onToggleLike,
    onAddToPlaylist,
    onContext,
    onOpenCollection,
    onOpenCard,
    onOpenArtist,
    onCreatePlaylist,
  });

  const list = useTrackList({
    count: model.recentlyAdded.length,
    onActivate:
      onPressItem === undefined
        ? undefined
        : (index) => {
            const item = model.recentlyAdded[index];
            if (item !== undefined) {
              onPressItem(item.key);
            }
          },
    onContext:
      onContext === undefined
        ? undefined
        : (index) => {
            const item = model.recentlyAdded[index];
            if (item !== undefined) {
              onContext(item.key);
            }
          },
  });

  return (
    <div
      className="uw-screen uw-library"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <Text variant="display" color="bright">
        {view.title}
      </Text>

      {/* collections — liked · downloads · top 50 · history */}
      <div className="uw-collections" role="list">
        {view.collections.map((tile) => (
          <div
            key={tile.tile.key}
            role="listitem"
            className="uw-collections__cell"
          >
            <CollectionTile view={tile} />
          </div>
        ))}
      </div>

      <div className="uw-library__controls">
        <div className="uw-library__controls-row">
          <Text variant="heading" color="bright">
            {view.headingLabel}
          </Text>
          <ToggleChip
            label={view.sortChip.label}
            active={false}
            onPress={view.sortChip.onPress}
          />
          <ToggleChip
            label={view.layoutChip.label}
            active={false}
            onPress={view.layoutChip.onPress}
          />
        </div>
        <div
          className="uw-library__filters"
          role="toolbar"
          aria-label={view.filterA11yLabel}
        >
          {view.filterOptions.map((option) => (
            <ToggleChip
              key={option.key}
              label={option.label}
              active={option.active}
              onPress={option.onPress}
            />
          ))}
        </div>
      </div>

      {view.nameField !== null && (
        <NameField
          value={view.nameField.value}
          placeholder={view.nameField.placeholder}
          autoFocus
          onChange={view.nameField.onChange}
          onSubmit={view.nameField.onSubmit}
          onCancel={view.nameField.onCancel}
        />
      )}

      {view.showEmpty ? (
        <div className="uw-library__empty">
          <EmptyState
            title={view.empty.title}
            hint={view.empty.hint}
            icon={view.empty.icon}
          />
          {view.newCard !== null && (
            <NewPlaylistCard
              view="grid"
              label={view.newCard.label}
              a11yLabel={view.newCard.a11yLabel}
              onPress={view.newCard.onPress}
            />
          )}
        </div>
      ) : view.layout === 'grid' ? (
        <div className="uw-libcards uw-libcards--grid" role="list">
          {view.cards.map((card) => (
            <LibraryCard key={card.card.key} view={card} layout="grid" />
          ))}
          {view.newCard !== null && (
            <NewPlaylistCard
              view="grid"
              label={view.newCard.label}
              a11yLabel={view.newCard.a11yLabel}
              onPress={view.newCard.onPress}
            />
          )}
        </div>
      ) : (
        <div className="uw-libcards uw-libcards--list" role="list">
          {view.cards.map((card) => (
            <LibraryCard key={card.card.key} view={card} layout="list" />
          ))}
          {view.newCard !== null && (
            <NewPlaylistCard
              view="list"
              label={view.newCard.label}
              a11yLabel={view.newCard.a11yLabel}
              onPress={view.newCard.onPress}
            />
          )}
        </div>
      )}

      {view.artists !== null && (
        <div className="uw-library__section">
          <Text variant="heading" color="bright">
            {view.artists.heading}
          </Text>
          <div className="uw-artist-rail" role="list">
            {view.artists.items.map((item) => (
              <Pressable
                key={item.artist.key}
                onPress={item.onPress}
                ariaLabel={item.a11yLabel}
                className="uw-artist"
              >
                <Artwork
                  url={item.artist.artworkUrl}
                  size={96}
                  cornerRadius={48}
                />
                <Text
                  variant="metadata"
                  color="secondary"
                  numberOfLines={2}
                  className="uw-artist__name"
                >
                  {item.artist.name}
                </Text>
              </Pressable>
            ))}
          </div>
        </div>
      )}

      {view.recent !== null && (
        <div className="uw-library__section">
          <Text variant="heading" color="bright">
            {view.recent.heading}
          </Text>
          <div
            role="list"
            aria-label={view.recent.a11yLabel}
            className="uw-list"
            onKeyDown={list.listProps.onKeyDown}
          >
            {view.recent.rows.map((item, index) => (
              <TrackRow
                key={`recent-${item.row.key}`}
                row={item.row}
                tabIndex={list.rowTabIndex(index)}
                onFocusRow={() => list.onRowFocus(index)}
                onPress={item.onPress}
                onToggleLike={item.onToggleLike}
                onAddToPlaylist={item.onAddToPlaylist}
                onContext={item.onContext}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
