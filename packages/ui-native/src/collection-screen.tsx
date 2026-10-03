import { useContext } from 'react';
import { FlatList, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { NavFootprintContext } from './platform-tabs.tsx';
import { BackRow, bind, Icon, Pressable, Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import type { LibraryCollectionView } from '@auqw/ui-shared/controllers';
import type {
  CollectionModel,
  CollectionRowModel,
  MessageId,
} from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';

/** One quick-access tile — shared by home and library. */
export function CollectionTile({
  view,
}: {
  readonly view: LibraryCollectionView;
}) {
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
        alignItems: 'stretch',
        borderRadius: theme.radius.control,
        borderWidth: theme.strokes.hairline,
        borderColor: view.enabled
          ? theme.colors.hairline
          : theme.colors.fg08,
        backgroundColor: view.enabled
          ? theme.colors.accentSoft
          : theme.colors.fg08,
        opacity: view.enabled ? 1 : 0.58,
        overflow: 'hidden',
      }}
    >
      {/* The tile is a small shell: the icon sits on the accent stage
          side and the body card anchors to the tile's right edges
          with only its seam side rounded — the world card's seam. */}
      <View
        style={{
          width: 50,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon
          name={view.icon}
          size={20}
          color={
            view.enabled ? theme.colors.accent : theme.colors.textSecondary
          }
        />
      </View>
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          paddingHorizontal: theme.spacing.md,
          borderTopLeftRadius: theme.radius.float,
          borderBottomLeftRadius: theme.radius.float,
          borderLeftWidth: theme.strokes.hairline,
          borderLeftColor: theme.colors.hairline,
          backgroundColor: view.enabled ? theme.colors.raised : 'transparent',
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="body" color={view.enabled ? 'bright' : 'primary'}>
            {tile.label}
          </Text>
          <Text variant="metadata" color="secondary" numberOfLines={2}>
            {view.countLabel}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

export type CollectionScreenProps = {
  readonly model: CollectionModel;
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly onPressItem?: ((row: CollectionRowModel) => void) | undefined;
  /** Advisory row intent — touch-down on a row; the caller warms it. */
  readonly onRowIntent?: ((row: CollectionRowModel) => void) | undefined;
  readonly onToggleLike?: ((row: CollectionRowModel) => void) | undefined;
  readonly onContext?: ((row: CollectionRowModel) => void) | undefined;
};

const EMPTY_HINTS: Readonly<
  Record<'liked' | 'top50' | 'history' | 'downloads', MessageId>
> = {
  liked: 'collection.emptyHint.liked',
  top50: 'collection.emptyHint.top50',
  history: 'collection.emptyHint.history',
  downloads: 'collection.emptyHint.downloads',
};

export function CollectionScreen({
  model,
  topInset = 0,
  scrollEnabled = true,
  onBack,
  onPressItem,
  onRowIntent,
  onToggleLike,
  onContext,
}: CollectionScreenProps) {
  const theme = useTheme();
  const navPad = useContext(NavFootprintContext);
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.canvas,
        paddingTop: topInset + theme.spacing.sm,
      }}
    >
      <BackRow onPress={onBack} accessibilityLabel={t('common.back')}>
        <Text variant="display" color="bright" style={{ flex: 1 }}>
          {model.title}
        </Text>
        <Text variant="metadata" color="secondary">
          {t('common.trackCount', { count: model.rows.length })}
        </Text>
      </BackRow>
      {model.rows.length === 0 ? (
        <EmptyState
          title={t('collection.empty', { title: model.title })}
          hint={t(EMPTY_HINTS[model.key])}
          icon={model.key === 'history' ? 'clock' : 'note'}
        />
      ) : (
        <FlatList
          data={model.rows}
          keyExtractor={(row) => row.key}
          scrollEnabled={scrollEnabled}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.sm,
            paddingBottom: theme.spacing.xxl + navPad,
          }}
          renderItem={({ item }) => (
            <TrackRow
              row={item.row}
              badge={item.badge}
              onPress={bind(onPressItem, item)}
              onIntent={bind(onRowIntent, item)}
              onToggleLike={bind(onToggleLike, item)}
              onContext={bind(onContext, item)}
            />
          )}
        />
      )}
    </View>
  );
}
