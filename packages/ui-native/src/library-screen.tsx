import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Artwork, Icon, IconButton, Pressable, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import { NameField } from './sheets.tsx';
import type {
  ArtistRailModel,
  CollectionKey,
  LibraryCardModel,
  LibraryModel,
  MessageId,
} from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';

export type LibraryScreenProps = {
  readonly model: LibraryModel;
  readonly topInset?: number | undefined;
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
  const theme = useTheme();
  const enabled = tile.enabled;
  return (
    <Pressable
      compact
      onPress={enabled ? onOpen : undefined}
      accessibilityLabel={t('library.tileA11y', {
        label: tile.label,
        count: tile.count,
      })}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      style={{
        minHeight: 62,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        borderRadius: theme.radius.control,
        borderWidth: theme.strokes.hairline,
        borderColor: enabled ? theme.colors.hairline : theme.colors.fg08,
        backgroundColor: enabled ? theme.colors.raised : 'transparent',
        opacity: enabled ? 1 : 0.58,
      }}
    >
      <Icon
        name={COLLECTION_ICONS[tile.key]}
        size={15}
        color={
          enabled ? theme.colors.accent : theme.colors.textSecondary
        }
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="body" color={enabled ? 'bright' : 'primary'}>
          {tile.label}
        </Text>
        <Text variant="metadata" color="secondary" numberOfLines={2}>
          {tile.note ?? t('common.trackCount', { count: tile.count })}
        </Text>
      </View>
      {/*
       * Per-tile play affordance: nested pressable wins responder
       * negotiation, so a play tap never opens the collection.
       * Empty collections disable honestly.
       */}
      {enabled && (
        <IconButton
          icon="play"
          size={30}
          iconSize={13}
          color={theme.colors.textBright}
          accessibilityLabel={t('library.tilePlayA11y', { label: tile.label })}
          onPress={tile.count === 0 ? undefined : onPlay}
        />
      )}
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
  const theme = useTheme();
  return (
    <Pressable
      compact
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={{
        minHeight: 30,
        justifyContent: 'center',
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radius.pill,
        backgroundColor: active ? theme.colors.accentSoft : theme.colors.fg08,
      }}
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
  const theme = useTheme();
  if (view === 'list') {
    return (
      <Pressable
        compact
        onPress={onPress}
        accessibilityLabel={t('common.newPlaylist')}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          minHeight: theme.sizes.trackRow,
          paddingHorizontal: theme.spacing.sm,
          borderRadius: theme.radius.control,
          borderWidth: theme.strokes.hairline,
          borderStyle: 'dashed',
          borderColor: theme.colors.fg25,
        }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="list-plus" size={15} color={theme.colors.textSecondary} />
        </View>
        <Text variant="body" color="secondary">
          {t('common.newPlaylist')}
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      compact
      onPress={onPress}
      accessibilityLabel={t('common.newPlaylist')}
      style={{
        width: 104,
        minHeight: 140,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.sm,
        borderRadius: theme.radius.thumb,
        borderWidth: theme.strokes.progress,
        borderStyle: 'dashed',
        borderColor: theme.colors.fg25,
      }}
    >
      <Icon name="list-plus" size={16} color={theme.colors.textSecondary} />
      <Text
        variant="metadata"
        color="secondary"
        style={{ textAlign: 'center' }}
      >
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
  const theme = useTheme();
  const openable =
    card.playlistId !== null || card.entityRef !== null;
  const press = openable ? onPress : undefined;
  const label = t('common.cardA11y', {
    title: card.title,
    subtitle: card.subtitle,
  });
  if (view === 'list') {
    return (
      <Pressable
        compact
        onPress={press}
        accessibilityLabel={label}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          minHeight: theme.sizes.trackRow,
          paddingHorizontal: theme.spacing.sm,
          borderRadius: theme.radius.control,
        }}
      >
        <Artwork url={card.artworkUrl} size={40} dimmed={!openable} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="body" color="primary" numberOfLines={1}>
            {card.title}
          </Text>
          <Text variant="metadata" color="secondary" numberOfLines={1}>
            {card.subtitle}
          </Text>
        </View>
        {openable && (
          <Icon
            name="chevron-right"
            size={12}
            color={theme.colors.textSecondary}
          />
        )}
      </Pressable>
    );
  }
  return (
    <Pressable
      compact
      onPress={press}
      accessibilityLabel={label}
      style={{ width: 104 }}
    >
      <Artwork url={card.artworkUrl} size={104} dimmed={!openable} />
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
  topInset = 0,
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
  const theme = useTheme();
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

  return (
    <ScrollView
      scrollEnabled={scrollEnabled}
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: theme.colors.canvas }}
      contentContainerStyle={{
        paddingTop: topInset + theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        paddingBottom: theme.spacing.xxl,
        gap: theme.spacing.lg,
      }}
    >
      <Text variant="display" color="bright">
        {t('nav.library')}
      </Text>

      {/* collections 2×2 — liked · downloads · top 50 · history */}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          rowGap: theme.spacing.sm,
          justifyContent: 'space-between',
        }}
      >
        {model.collections.map((tile) => {
          const key = tile.key;
          return (
            <View key={tile.key} style={{ flexBasis: '48.5%', flexGrow: 1 }}>
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
            </View>
          );
        })}
      </View>

      <View style={{ gap: theme.spacing.sm }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
          }}
        >
          <Text variant="heading" color="bright">
            {t('library.heading')}
          </Text>
          <View style={{ flex: 1 }} />
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
        </View>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: theme.spacing.sm,
          }}
        >
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
        </View>
      </View>

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
        <View style={{ gap: theme.spacing.lg }}>
          <EmptyState
            title={t('library.emptyTitle')}
            hint={t('library.emptyHint')}
            icon="list-plus"
          />
          <View style={{ alignItems: 'center' }}>
            <NewPlaylistCard
              view="grid"
              onPress={
                onCreatePlaylist === undefined
                  ? undefined
                  : () => setCreating(true)
              }
            />
          </View>
        </View>
      ) : view === 'grid' ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: theme.spacing.lg,
          }}
        >
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
        </View>
      ) : (
        <View style={{ marginHorizontal: -theme.spacing.sm, gap: 2 }}>
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
        </View>
      )}

      {model.artists.length > 0 && (
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="heading" color="bright">
            {t('library.artistsHeading')}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
              {model.artists.map((artist) => {
                const openable =
                  artist.entityRef !== null && onOpenArtist !== undefined;
                return (
                  <Pressable
                    key={artist.key}
                    compact
                    onPress={
                      openable ? () => onOpenArtist(artist) : undefined
                    }
                    accessibilityLabel={artist.name}
                    style={{ width: 76, alignItems: 'center' }}
                  >
                    <Artwork
                      url={artist.artworkUrl}
                      size={76}
                      cornerRadius={38}
                    />
                    <Text
                      variant="metadata"
                      color="secondary"
                      numberOfLines={2}
                      style={{
                        marginTop: theme.spacing.xs,
                        textAlign: 'center',
                      }}
                    >
                      {artist.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>
      )}

      {model.recentlyAdded.length > 0 && (
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="heading" color="bright">
            {t('library.recentlyLiked')}
          </Text>
          <View style={{ marginHorizontal: -theme.spacing.sm }}>
            {model.recentlyAdded.map((item) => (
              <TrackRow
                key={`recent-${item.key}`}
                row={item}
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
                  onContext === undefined
                    ? undefined
                    : () => onContext(item.key)
                }
              />
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  );
}
