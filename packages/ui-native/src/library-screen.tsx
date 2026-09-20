import { FlatList, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Text } from './primitives.tsx';
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

export function LibraryScreen({
  model,
  topInset = 0,
  scrollEnabled = true,
  onPressItem,
  onToggleLike,
  onContext,
}: LibraryScreenProps) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.canvas,
        paddingTop: topInset,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          paddingHorizontal: 14,
          marginTop: theme.spacing.sm,
          marginBottom: theme.spacing.md,
        }}
      >
        <Text variant="heading" color="bright" style={{ fontSize: 12.5 }}>
          liked songs
        </Text>
        <Text variant="metadata" color="secondary" style={{ marginLeft: 10 }}>
          {model.likedCount} tracks
        </Text>
      </View>
      {model.items.length === 0 ? (
        <EmptyState
          title="nothing liked yet"
          hint="liked tracks land here"
          icon="heart"
        />
      ) : (
        <FlatList
          data={model.items}
          keyExtractor={(row) => row.key}
          scrollEnabled={scrollEnabled}
          contentContainerStyle={{ paddingHorizontal: 6 }}
          renderItem={({ item }) => (
            <TrackRow
              row={item}
              onPress={
                onPressItem === undefined ? undefined : () => onPressItem(item)
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
