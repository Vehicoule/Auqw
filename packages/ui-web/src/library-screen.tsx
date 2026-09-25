import { useMemo, useState } from 'react';
import { Artwork, Icon, IconButton, Pressable, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { TrackRow, useTrackList } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import { NameField } from './sheets.tsx';
import { t } from '@auqw/ui-shared';
import type {
  ArtistRailModel,
  CollectionKey,
  LibraryCardModel,
  LibraryModel,
  MessageId,
} from '@auqw/ui-shared';

export type LibraryScreenProps = {
  readonly model: LibraryModel;
  readonly scrollEnabled?: boolean | undefined;
  readonly onPressItem?: ((recordingId: string) => void) | undefined;
  readonly onToggleLike?: ((recordingId: string) => void) | undefined;
  readonly onContext?: ((recordingId: string) => void) | undefined;
  readonly onOpenCollection?:
    | ((key: 'liked' | 'top50' | 'history' | 'downloads') => void)
    | undefined;
  readonly onPlayCollection?:
    | ((key: 'liked' | 'top50' | 'history' | 'downloads') => void)
    | undefined;
  readonly onOpenCard?: ((card: LibraryCardModel) => void) | undefined;
  readonly onOpenArtist?: ((artist: ArtistRailModel) => void) | undefined;
  readonly onCreatePlaylist?: ((name: string) => void) | undefined;
};

const COLLECTION_ICONS: Record<CollectionKey, IconName> = {
  liked: 'heart',
  downloads: 'download',
  top50: 'queue',
  history: 'clock',
};

// Labels are message ids resolved at render — never cache translated
// strings at module scope or they go stale on a locale switch.
const KIND_FILTERS: readonly {
  readonly key: 'playlist' | 'album' | 'artist';
  readonly label: MessageId;
}[] = [
  { key: 'playlist', label: 'library.filter.playlists' },
  { key: 'album', label: 'library.filter.albums' },
  { key: 'artist', label: 'library.filter.artists' },
];

function CollectionTile({
  tile,
  onOpen,
  onPlay,
}: {
  readonly tile: LibraryModel['collections'][number];
  readonly onOpen?: (() => void) | undefined;
  readonly onPlay?: (() => void) | undefined;
}) {
  const enabled = tile.enabled;
  return (
    <div
      className={`uw-collection${enabled ? '' : ' uw-off'}`}
      data-enabled={enabled ? 'true' : 'false'}
    >
      <Pressable
        onPress={enabled ? onOpen : undefined}
        disabled={!enabled}
        ariaLabel={t('library.tileA11y', { label: tile.label, count: tile.count })}
        className="uw-collection__body"
      >
        <Icon
          name={COLLECTION_ICONS[tile.key]}
          size={15}
          color={enabled ? 'var(--accent)' : 'var(--text-secondary)'}
        />
        <span className="uw-collection__text">
          <Text variant="body" color={enabled ? 'bright' : 'primary'}>
            {tile.label}
          </Text>
          <Text variant="metadata" color="secondary" numberOfLines={2}>
            {tile.note ?? t('common.trackCount', { count: tile.count })}
          </Text>
        </span>
      </Pressable>
      {enabled && (
        <IconButton
          icon="play"
          size={30}
          iconSize={13}
          color="var(--text-bright)"
          ariaLabel={t('library.tilePlayA11y', { label: tile.label })}
          onPress={tile.count === 0 ? undefined : onPlay}
        />
      )}
    </div>
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
  onPress,
}: {
  readonly view: 'grid' | 'list';
  readonly onPress?: (() => void) | undefined;
}) {
  if (view === 'list') {
    return (
      <Pressable
        onPress={onPress}
        ariaLabel={t('common.newPlaylist')}
        className="uw-newpl uw-newpl--row"
      >
        <span className="uw-newpl__art">
          <Icon name="list-plus" size={15} color="var(--text-secondary)" />
        </span>
        <Text variant="body" color="secondary">
          {t('common.newPlaylist')}
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      ariaLabel={t('common.newPlaylist')}
      className="uw-newpl uw-newpl--grid"
    >
      <Icon name="list-plus" size={16} color="var(--text-secondary)" />
      <Text variant="metadata" color="secondary" className="uw-newpl__label">
        {t('common.newPlaylist')}
      </Text>
    </Pressable>
  );
}

function LibraryCard({
  card,
  view,
  onPress,
}: {
  readonly card: LibraryCardModel;
  readonly view: 'grid' | 'list';
  readonly onPress?: (() => void) | undefined;
}) {
  const openable = card.playlistId !== null || card.entityRef !== null;
  const press = openable ? onPress : undefined;
  const label = t('common.cardA11y', { title: card.title, subtitle: card.subtitle });
  if (view === 'list') {
    return (
      <Pressable
        onPress={press}
        ariaLabel={label}
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
      ariaLabel={label}
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
  onContext,
  onOpenCollection,
  onPlayCollection,
  onOpenCard,
  onOpenArtist,
  onCreatePlaylist,
}: LibraryScreenProps) {
  const [filter, setFilter] = useState<'all' | 'playlist' | 'album' | 'artist'>(
    'all',
  );
  const [sort, setSort] = useState<'recent' | 'title'>('recent');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');

  const kindsPresent = useMemo(() => {
    const kinds = new Set(model.cards.map((card) => card.kind));
    return KIND_FILTERS.filter((f) => kinds.has(f.key));
  }, [model.cards]);

  const cards = useMemo(() => {
    const filtered =
      filter === 'all'
        ? model.cards
        : model.cards.filter((card) => card.kind === filter);
    return sort === 'recent'
      ? [...filtered].sort((a, b) => b.sortMs - a.sortMs)
      : [...filtered].sort((a, b) => a.title.localeCompare(b.title));
  }, [filter, model.cards, sort]);

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
        {t('nav.library')}
      </Text>

      {/* collections — liked · downloads · top 50 · history */}
      <div className="uw-collections" role="list">
        {model.collections.map((tile) => {
          const key = tile.key;
          return (
            <div key={tile.key} role="listitem" className="uw-collections__cell">
              <CollectionTile
                tile={tile}
                onOpen={
                  key === null || onOpenCollection === undefined
                    ? undefined
                    : () => onOpenCollection(key)
                }
                onPlay={
                  key === null || onPlayCollection === undefined
                    ? undefined
                    : () => onPlayCollection(key)
                }
              />
            </div>
          );
        })}
      </div>

      <div className="uw-library__controls">
        <div className="uw-library__controls-row">
          <Text variant="heading" color="bright">
            {t('library.heading')}
          </Text>
          <ToggleChip
            label={t(`library.sort.${sort}`)}
            active={false}
            onPress={() => setSort(sort === 'recent' ? 'title' : 'recent')}
          />
          <ToggleChip
            label={t(`library.view.${view}`)}
            active={false}
            onPress={() => setView(view === 'grid' ? 'list' : 'grid')}
          />
        </div>
        <div className="uw-library__filters" role="toolbar" aria-label={t('library.kindFilterA11y')}>
          <ToggleChip
            label={t('library.filter.all')}
            active={filter === 'all'}
            onPress={() => setFilter('all')}
          />
          {kindsPresent.map((f) => (
            <ToggleChip
              key={f.key}
              label={t(f.label)}
              active={filter === f.key}
              onPress={() => setFilter(f.key)}
            />
          ))}
        </div>
      </div>

      {creating && (
        <NameField
          value={draft}
          placeholder={t('common.newPlaylistName')}
          autoFocus
          onChange={setDraft}
          onSubmit={
            onCreatePlaylist === undefined
              ? undefined
              : (name) => {
                  onCreatePlaylist(name);
                  setDraft('');
                  setCreating(false);
                }
          }
          onCancel={() => {
            setDraft('');
            setCreating(false);
          }}
        />
      )}

      {cards.length === 0 && !creating ? (
        <div className="uw-library__empty">
          <EmptyState
            title={t('library.emptyTitle')}
            hint={t('library.emptyHint')}
            icon="list-plus"
          />
          <NewPlaylistCard
            view="grid"
            onPress={
              onCreatePlaylist === undefined
                ? undefined
                : () => setCreating(true)
            }
          />
        </div>
      ) : view === 'grid' ? (
        <div className="uw-libcards uw-libcards--grid" role="list">
          {cards.map((card) => (
            <LibraryCard
              key={card.key}
              card={card}
              view="grid"
              onPress={
                onOpenCard === undefined ? undefined : () => onOpenCard(card)
              }
            />
          ))}
          {creating ? null : (
            <NewPlaylistCard
              view="grid"
              onPress={
                onCreatePlaylist === undefined
                  ? undefined
                  : () => setCreating(true)
              }
            />
          )}
        </div>
      ) : (
        <div className="uw-libcards uw-libcards--list" role="list">
          {cards.map((card) => (
            <LibraryCard
              key={card.key}
              card={card}
              view="list"
              onPress={
                onOpenCard === undefined ? undefined : () => onOpenCard(card)
              }
            />
          ))}
          {creating ? null : (
            <NewPlaylistCard
              view="list"
              onPress={
                onCreatePlaylist === undefined
                  ? undefined
                  : () => setCreating(true)
              }
            />
          )}
        </div>
      )}

      {model.artists.length > 0 && (
        <div className="uw-library__section">
          <Text variant="heading" color="bright">
            {t('library.artistsHeading')}
          </Text>
          <div className="uw-artist-rail" role="list">
            {model.artists.map((artist) => {
              const openable =
                artist.entityRef !== null && onOpenArtist !== undefined;
              return (
                <Pressable
                  key={artist.key}
                  onPress={openable ? () => onOpenArtist(artist) : undefined}
                  ariaLabel={artist.name}
                  className="uw-artist"
                >
                  <Artwork url={artist.artworkUrl} size={96} cornerRadius={48} />
                  <Text
                    variant="metadata"
                    color="secondary"
                    numberOfLines={2}
                    className="uw-artist__name"
                  >
                    {artist.name}
                  </Text>
                </Pressable>
              );
            })}
          </div>
        </div>
      )}

      {model.recentlyAdded.length > 0 && (
        <div className="uw-library__section">
          <Text variant="heading" color="bright">
            {t('library.recentlyLiked')}
          </Text>
          <div
            role="list"
            aria-label={t('library.recentlyLiked')}
            className="uw-list"
            onKeyDown={list.listProps.onKeyDown}
          >
            {model.recentlyAdded.map((item, index) => (
              <TrackRow
                key={`recent-${item.key}`}
                row={item}
                tabIndex={list.rowTabIndex(index)}
                onFocusRow={() => list.onRowFocus(index)}
                onPress={
                  onPressItem === undefined
                    ? undefined
                    : () => onPressItem(item.key)
                }
                onToggleLike={
                  onToggleLike === undefined
                    ? undefined
                    : () => onToggleLike(item.key)
                }
                onContext={
                  onContext === undefined ? undefined : () => onContext(item.key)
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
