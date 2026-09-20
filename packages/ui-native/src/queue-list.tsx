import { FlatList, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import type { QueueItemModel, QueueModel } from './view-models.ts';

// Reorder uses explicit up/down affordances rather than drag-to-reorder:
// honest per-row controls, no long-press/drag state to get wrong in v1.
export type QueueListProps = {
  readonly queue: QueueModel;
  readonly reordering?: boolean | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onPressItem?: ((occurrenceId: string) => void) | undefined;
  readonly onRemoveItem?: ((occurrenceId: string) => void) | undefined;
  readonly onMoveItem?:
  | ((occurrenceId: string, direction: -1 | 1) => void)
  | undefined;
};

export function QueueList({
  queue,
  reordering = false,
  scrollEnabled = true,
  onPressItem,
  onRemoveItem,
  onMoveItem,
}: QueueListProps) {
  const theme = useTheme();
  if (queue.items.length === 0) {
    return <EmptyState title="queue is empty" icon="queue" />;
  }
  const renderItem = ({
    item,
    index,
  }: {
    item: QueueItemModel;
    index: number;
  }) => (
    <View>
      {item.current && (
        <Text
          variant="label"
          color="accent"
          style={{ paddingHorizontal: theme.spacing.sm, marginBottom: 2 }}
          uppercase
        >
          now playing
        </Text>
      )}
      <TrackRow
        row={item.row}
        reorderControls={reordering ? 'buttons' : 'none'}
        onPress={
          onPressItem === undefined
            ? undefined
            : () => onPressItem(item.occurrenceId)
        }
        onRemove={
          onRemoveItem === undefined || item.current
            ? undefined
            : () => onRemoveItem(item.occurrenceId)
        }
        onMoveUp={
          reordering && index > 0 && onMoveItem !== undefined
            ? () => onMoveItem(item.occurrenceId, -1)
            : undefined
        }
        onMoveDown={
          reordering && index < queue.items.length - 1 && onMoveItem !== undefined
            ? () => onMoveItem(item.occurrenceId, 1)
            : undefined
        }
      />
    </View>
  );
  return (
    <FlatList
      data={queue.items}
      keyExtractor={(item) => item.occurrenceId}
      renderItem={renderItem}
      scrollEnabled={scrollEnabled}
      initialNumToRender={15}
    />
  );
}
