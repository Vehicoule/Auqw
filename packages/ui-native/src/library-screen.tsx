import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Artwork, Icon, Pressable, Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import type { LibraryModel, TrackRowModel } from './view-models.ts';

export type LibraryScreenProps = {
  readonly model: LibraryModel;
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onPressItem?: ((row: TrackRowModel) => void) | undefined;
  readonly onToggleLike?: ((row: TrackRowModel) => void) | undefined;
  readonly onContext?: ((row: TrackRowModel) => void) | undefined;
};

function CollectionTile({
  label,
  count,
  enabled,
  note,
  onPress,
}: {
  readonly label: string;
  readonly count: number;
  readonly enabled: boolean;
  readonly note: string | null;
  readonly onPress?: (() => void) | undefined;
}) {
  const theme = useTheme();
  return (
    <Pressable
      compact
      onPress={onPress}
      accessibilityLabel={`${label}, ${count} tracks`}
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
        name={label === 'liked' ? 'heart' : label === 'downloads' ? 'download' : 'clock'}
        size={15}
        color={enabled ? theme.colors.accent : theme.colors.textSecondary}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="body" color={enabled ? 'bright' : 'primary'}>
          {label}
        </Text>
        <Text variant="metadata" color="secondary" numberOfLines={1}>
          {note ?? `${count} tracks`}
        </Text>
      </View>
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

export function LibraryScreen({
  model,
  topInset = 0,
  scrollEnabled = true,
  onPressItem,
  onToggleLike,
  onContext,
}: LibraryScreenProps) {
  const theme = useTheme();
  const [filter, setFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<'recent' | 'title'>('recent');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const filters = useMemo(() => {
    const labels = new Set<string>();
    for (const item of model.items) {
      if (item.versionLabel !== null) {
        labels.add(item.versionLabel);
      }
    }
    return [...labels].slice(0, 4);
  }, [model.items]);
  const items = useMemo(() => {
    const filtered =
      filter === null
        ? model.items
        : model.items.filter((item) => item.versionLabel === filter);
    return sort === 'recent'
      ? filtered
      : [...filtered].sort((a, b) => a.title.localeCompare(b.title));
  }, [filter, model.items, sort]);

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
        library
      </Text>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: theme.spacing.sm,
        }}
      >
        {model.collections.map((collection) => (
          <View key={collection.key} style={{ width: '50%' }}>
            <CollectionTile
              label={collection.label}
              count={collection.count}
              enabled={collection.enabled}
              note={collection.note}
              onPress={collection.enabled ? () => setView('list') : undefined}
            />
          </View>
        ))}
      </View>

      <View style={{ gap: theme.spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Text variant="heading" color="bright">
            your library
          </Text>
          <View style={{ flex: 1 }} />
          <ToggleChip
            label={sort}
            active={false}
            onPress={() => setSort(sort === 'recent' ? 'title' : 'recent')}
          />
          <ToggleChip
            label={view}
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
            label="all"
            active={filter === null}
            onPress={() => setFilter(null)}
          />
          {filters.map((label) => (
            <ToggleChip
              key={label}
              label={label}
              active={filter === label}
              onPress={() => setFilter(label)}
            />
          ))}
        </View>
      </View>

      {items.length === 0 ? (
        <EmptyState
          title="nothing here yet"
          hint="liked tracks land here"
          icon="heart"
        />
      ) : view === 'grid' ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: theme.spacing.lg,
          }}
        >
          {items.map((item) => (
            <Pressable
              key={item.key}
              compact
              onPress={
                onPressItem === undefined ? undefined : () => onPressItem(item)
              }
              accessibilityLabel={`${item.title}${item.artist === null ? '' : `, ${item.artist}`}`}
              style={{ width: 104 }}
            >
              <Artwork url={item.artworkUrl} size={104} />
              <Text variant="body" color="primary" numberOfLines={1}>
                {item.title}
              </Text>
              <Text variant="metadata" color="secondary" numberOfLines={1}>
                {item.artist ?? '—'}
              </Text>
            </Pressable>
          ))}
          <View
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
            <Text variant="metadata" color="secondary" style={{ textAlign: 'center' }}>
              playlists arrive in Slice 2
            </Text>
          </View>
        </View>
      ) : (
        <View style={{ marginHorizontal: -theme.spacing.sm }}>
          {items.map((item) => (
            <TrackRow
              key={item.key}
              row={item}
              onPress={
                onPressItem === undefined ? undefined : () => onPressItem(item)
              }
              onToggleLike={
                onToggleLike === undefined ? undefined : () => onToggleLike(item)
              }
              onContext={
                onContext === undefined ? undefined : () => onContext(item)
              }
            />
          ))}
        </View>
      )}

      {model.artists.length > 0 && (
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="heading" color="bright">
            artists
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
              {model.artists.map((artist) => (
                <View key={artist.key} style={{ width: 76, alignItems: 'center' }}>
                  <Artwork url={artist.artworkUrl} size={76} cornerRadius={38} />
                  <Text
                    variant="metadata"
                    color="secondary"
                    numberOfLines={2}
                    style={{ marginTop: theme.spacing.xs, textAlign: 'center' }}
                  >
                    {artist.name}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {model.recentlyAdded.length > 0 && (
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="heading" color="bright">
            recently liked
          </Text>
          <View style={{ marginHorizontal: -theme.spacing.sm }}>
            {model.recentlyAdded.map((item) => (
              <TrackRow
                key={`recent-${item.key}`}
                row={item}
                onPress={
                  onPressItem === undefined ? undefined : () => onPressItem(item)
                }
                onToggleLike={
                  onToggleLike === undefined ? undefined : () => onToggleLike(item)
                }
              />
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  );
}
