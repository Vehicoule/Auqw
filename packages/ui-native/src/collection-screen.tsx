import { FlatList, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { BackButton, bind, PillButton, Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import type {
  CollectionModel,
  CollectionRowModel,
  MessageId,
} from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';

export type CollectionScreenProps = {
  readonly model: CollectionModel;
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly onPlayAll?: (() => void) | undefined;
  readonly onPressItem?: ((row: CollectionRowModel) => void) | undefined;
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
  onPlayAll,
  onPressItem,
  onToggleLike,
  onContext,
}: CollectionScreenProps) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.canvas,
        paddingTop: topInset + theme.spacing.sm,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          paddingHorizontal: theme.spacing.lg,
          marginBottom: theme.spacing.sm,
        }}
      >
        <BackButton onPress={onBack} accessibilityLabel={t('common.back')} />
        <Text variant="display" color="bright" style={{ flex: 1 }}>
          {model.title}
        </Text>
        <Text variant="metadata" color="secondary">
          {t('common.trackCount', { count: model.rows.length })}
        </Text>
        <PillButton
          label={t('collection.playAll')}
          tone="soft"
          disabled={model.rows.length === 0}
          onPress={onPlayAll}
          accessibilityLabel={t('collection.playAllA11y', { title: model.title })}
        />
      </View>
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
            paddingBottom: theme.spacing.xxl,
          }}
          renderItem={({ item }) => (
            <TrackRow
              row={item.row}
              badge={item.badge}
              onPress={bind(onPressItem, item)}
              onToggleLike={bind(onToggleLike, item)}
              onContext={bind(onContext, item)}
            />
          )}
        />
      )}
    </View>
  );
}
