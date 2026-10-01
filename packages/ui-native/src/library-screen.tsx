import { ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Artwork, Icon, Pressable, Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
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
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
};

function CollectionTile({ view }: { readonly view: LibraryCollectionView }) {
  const theme = useTheme();
  const { tile } = view;
  return (
    <Pressable
      compact
      onPress={view.enabled ? view.onOpen : undefined}
      accessibilityLabel={view.a11yLabel}
      accessibilityState={{ disabled: !view.enabled }}
      disabled={!view.enabled}
      style={{
        minHeight: 62,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        borderRadius: theme.radius.control,
        borderWidth: theme.strokes.hairline,
        borderColor: view.enabled ? theme.colors.hairline : theme.colors.fg08,
        backgroundColor: view.enabled ? theme.colors.raised : 'transparent',
        opacity: view.enabled ? 1 : 0.58,
      }}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: theme.radius.control,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: view.enabled
            ? theme.colors.accentSoft
            : theme.colors.fg08,
        }}
      >
        <Icon
          name={view.icon}
          size={15}
          color={
            view.enabled ? theme.colors.accent : theme.colors.textSecondary
          }
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="body" color={view.enabled ? 'bright' : 'primary'}>
          {tile.label}
        </Text>
        <Text variant="metadata" color="secondary" numberOfLines={2}>
          {view.countLabel}
        </Text>
      </View>
      {/*
       * Per-tile play affordance: nested pressable wins responder
       * negotiation, so a play tap never opens the collection.
       * Empty collections disable honestly.
       */}
      {view.enabled && (
        <Pressable
          compact
          onPress={view.onPlay}
          accessibilityLabel={view.playA11yLabel}
          style={({ pressed }) => [
            {
              width: 30,
              height: 30,
              borderRadius: theme.radius.pill,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.colors.accentSoft,
            },
            pressed && { backgroundColor: theme.colors.fg18 },
          ]}
        >
          <Icon name="play" size={13} color={theme.colors.accent} />
        </Pressable>
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
        borderWidth: theme.strokes.hairline,
        borderColor: active ? theme.colors.accent : theme.colors.hairline,
        backgroundColor: active ? theme.colors.accentSoft : 'transparent',
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
  label,
  a11yLabel,
  onPress,
}: {
  readonly view: 'grid' | 'list';
  readonly label: string;
  readonly a11yLabel: string;
  readonly onPress?: (() => void) | undefined;
}) {
  const theme = useTheme();
  if (view === 'list') {
    return (
      <Pressable
        compact
        onPress={onPress}
        accessibilityLabel={a11yLabel}
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
          {label}
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      compact
      onPress={onPress}
      accessibilityLabel={a11yLabel}
      style={{
        width: 104,
        minHeight: 140,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.sm,
        borderRadius: theme.radius.thumb,
        borderWidth: theme.strokes.hairline,
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
  const theme = useTheme();
  const { card } = view;
  const openable =
    card.playlistId !== null || card.entityRef !== null;
  const press = openable ? view.onPress : undefined;
  if (layout === 'list') {
    return (
      <Pressable
        compact
        onPress={press}
        accessibilityLabel={view.a11yLabel}
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
      accessibilityLabel={view.a11yLabel}
      style={{
        width: 104,
        gap: theme.spacing.xs,
        borderRadius: theme.radius.control,
      }}
    >
      <Artwork url={card.artworkUrl} size={104} dimmed={!openable} />
      <View style={{ gap: theme.spacing.xxs }}>
        <Text variant="body" color="primary" numberOfLines={1}>
          {card.title}
        </Text>
        <Text variant="metadata" color="secondary" numberOfLines={1}>
          {card.subtitle}
        </Text>
      </View>
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
  const view = useLibraryScreenController({
    model,
    onPressItem,
    onToggleLike,
    onContext,
    onOpenCollection,
    onPlayCollection,
    onOpenCard,
    onOpenArtist,
    onCreatePlaylist,
  });

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
        {view.title}
      </Text>

      {/* collections 2×2 — liked · downloads · top 50 · history */}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          rowGap: theme.spacing.md,
          justifyContent: 'space-between',
        }}
      >
        {view.collections.map((tile) => (
          <View
            key={tile.tile.key}
            style={{ flexBasis: '48.5%', flexGrow: 1 }}
          >
            <CollectionTile view={tile} />
          </View>
        ))}
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
            {view.headingLabel}
          </Text>
          <View style={{ flex: 1 }} />
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
        </View>
        {(view.filterOptions.length > 2 ||
          // A retained kind filter whose kind left the library must keep
          // the row — `all` is the way back to the remaining cards.
          !view.filterOptions.some((o) => o.key === 'all' && o.active)) && (
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: theme.spacing.sm,
            }}
          >
            {view.filterOptions.map((option) => (
              <ToggleChip
                key={option.key}
                label={option.label}
                active={option.active}
                onPress={option.onPress}
              />
            ))}
          </View>
        )}
      </View>

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
        <View style={{ gap: theme.spacing.lg }}>
          <EmptyState
            title={view.empty.title}
            hint={view.empty.hint}
            icon={view.empty.icon}
          />
          <View style={{ alignItems: 'center' }}>
            {view.newCard !== null && (
              <NewPlaylistCard view="grid" {...view.newCard} />
            )}
          </View>
        </View>
      ) : (
        <View
          style={
            view.layout === 'grid'
              ? {
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  gap: theme.spacing.lg,
                }
              : { marginHorizontal: -theme.spacing.sm, gap: theme.spacing.xxs }
          }
        >
          {view.cards.map((card) => (
            <LibraryCard
              key={card.card.key}
              view={card}
              layout={view.layout}
            />
          ))}
          {view.newCard !== null && (
            <NewPlaylistCard view={view.layout} {...view.newCard} />
          )}
        </View>
      )}

      {view.artists !== null && (
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="heading" color="bright">
            {view.artists.heading}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
              {view.artists.items.map((item) => (
                <Pressable
                  key={item.artist.key}
                  compact
                  onPress={item.onPress}
                  accessibilityLabel={item.a11yLabel}
                  style={{ width: 76, alignItems: 'center' }}
                >
                  <Artwork
                    url={item.artist.artworkUrl}
                    size={76}
                    cornerRadius={38}
                    style={{
                      borderWidth: theme.strokes.hairline,
                      borderColor: theme.colors.hairline,
                    }}
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
                    {item.artist.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {view.recent !== null && (
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="heading" color="bright">
            {view.recent.heading}
          </Text>
          <View style={{ marginHorizontal: -theme.spacing.sm }}>
            {view.recent.rows.map((item) => (
              <TrackRow
                key={`recent-${item.row.key}`}
                row={item.row}
                onPress={item.onPress}
                onIntent={item.onIntent}
                onToggleLike={item.onToggleLike}
                onContext={item.onContext}
              />
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  );
}
