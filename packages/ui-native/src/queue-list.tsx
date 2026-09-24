import { FlatList, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import type { QueueItemModel, QueueModel } from '@auqw/ui-shared';

// Shared fallback (web/desktop + any platform without gesture-handler):
// reorder uses paired chevron controls; the native variant swaps this
// whole list for DraggableFlatList + drag handles.
export type QueueListProps = {
  readonly queue: QueueModel;
  readonly reordering?: boolean | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onPressItem?: ((occurrenceId: string) => void) | undefined;
  readonly onRemoveItem?: ((occurrenceId: string) => void) | undefined;
  readonly onMoveItem?:
  | ((occurrenceId: string, direction: -1 | 1) => void)
  | undefined;
  readonly onMoveItemTo?:
  | ((occurrenceId: string, toIndex: number) => void)
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
  return (
    <FlatList
      data={queue.items}
      keyExtractor={(item) => item.occurrenceId}
      scrollEnabled={scrollEnabled}
      initialNumToRender={15}
      renderItem={({ item, index }) => (
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
            badge={item.duplicate ? 'repeat' : null}
            reorderControls={reordering ? 'buttons' : 'none'}
            onPress={
              onPressItem === undefined || reordering
                ? undefined
                : () => onPressItem(item.occurrenceId)
            }
            onRemove={
              onRemoveItem === undefined || item.current || reordering
                ? undefined
                : () => onRemoveItem(item.occurrenceId)
            }
            onMoveUp={
              reordering && index > 0 && onMoveItem !== undefined
                ? () => onMoveItem(item.occurrenceId, -1)
                : undefined
            }
            onMoveDown={
              reordering &&
                index < queue.items.length - 1 &&
                onMoveItem !== undefined
                ? () => onMoveItem(item.occurrenceId, 1)
                : undefined
            }
          />
        </View>
      )}
    />
  );
}
