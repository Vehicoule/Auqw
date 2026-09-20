import { FlatList, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Icon, Pressable, Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import type { CollectionModel, CollectionRowModel } from './view-models.ts';

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

const EMPTY_HINTS = {
  liked: 'liked tracks land here',
  top50: 'plays count once you listen',
  history: 'played tracks land here',
} as const;

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
        <Pressable
          compact
          onPress={onBack}
          accessibilityLabel="back"
          style={{ padding: theme.spacing.xs }}
        >
          <Icon
            name="chevron-left"
            size={16}
            color={theme.colors.textSecondary}
          />
        </Pressable>
        <Text variant="display" color="bright" style={{ flex: 1 }}>
          {model.title}
        </Text>
        <Text variant="metadata" color="secondary">
          {model.rows.length} {model.rows.length === 1 ? 'track' : 'tracks'}
        </Text>
        <Pressable
          compact
          onPress={model.rows.length === 0 ? undefined : onPlayAll}
          accessibilityLabel={`play ${model.title}`}
          accessibilityState={{ disabled: model.rows.length === 0 }}
          style={{
            paddingHorizontal: theme.spacing.md,
            minHeight: 30,
            justifyContent: 'center',
            borderRadius: theme.radius.pill,
            backgroundColor:
              model.rows.length === 0
                ? theme.colors.fg08
                : theme.colors.accentSoft,
          }}
        >
          <Text
            variant="metadata"
            color={model.rows.length === 0 ? 'secondary' : 'accent'}
          >
            play all
          </Text>
        </Pressable>
      </View>
      {model.rows.length === 0 ? (
        <EmptyState
          title={`${model.title} is empty`}
          hint={EMPTY_HINTS[model.key]}
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
              onPress={
                onPressItem === undefined
                  ? undefined
                  : () => onPressItem(item)
              }
              onToggleLike={
                onToggleLike === undefined
                  ? undefined
                  : () => onToggleLike(item)
              }
              onContext={
                onContext === undefined ? undefined : () => onContext(item)
              }
            />
          )}
        />
      )}
    </View>
  );
}
