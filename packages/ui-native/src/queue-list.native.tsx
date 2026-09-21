import { FlatList, View } from 'react-native';
import DraggableFlatList, {
  ScaleDecorator,
} from 'react-native-draggable-flatlist';
import type { RenderItemParams } from 'react-native-draggable-flatlist';
import * as Haptics from 'expo-haptics';
import { useTheme } from './theme.tsx';
import { Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import type { QueueItemModel, QueueModel } from './view-models.ts';

// Reorder mode swaps the FlatList for a DraggableFlatList: rows get a
// drag handle, the lift animation comes from ScaleDecorator, and a
// light haptic marks the grab. The committed order is still session
// state — onDragEnd reports indices, the caller issues moveOccurrence.
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
  onMoveItemTo,
}: QueueListProps) {
  const theme = useTheme();
  if (queue.items.length === 0) {
    return <EmptyState title="queue is empty" icon="queue" />;
  }
  const renderItem = ({
    item,
    index,
    onDragStart,
  }: {
    item: QueueItemModel;
    index: number;
    onDragStart?: (() => void) | undefined;
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
        badge={item.duplicate ? 'repeat' : null}
        reorderControls={reordering ? 'drag' : 'none'}
        onDragStart={onDragStart}
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
          reordering && index < queue.items.length - 1 && onMoveItem !== undefined
            ? () => onMoveItem(item.occurrenceId, 1)
            : undefined
        }
      />
    </View>
  );
  if (reordering && onMoveItemTo !== undefined) {
    return (
      <DraggableFlatList
        data={queue.items.slice()}
        keyExtractor={(item) => item.occurrenceId}
        scrollEnabled={scrollEnabled}
        onDragEnd={({ from, to }) => {
          const item = queue.items[from];
          if (item !== undefined) {
            onMoveItemTo(item.occurrenceId, to);
          }
        }}
        renderItem={({
          item,
          drag,
          getIndex,
        }: RenderItemParams<QueueItemModel>) => (
          <ScaleDecorator>
            {renderItem({
              item,
              index: getIndex() ?? 0,
              onDragStart: () => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                drag();
              },
            })}
          </ScaleDecorator>
        )}
      />
    );
  }
  return (
    <FlatList
      data={queue.items}
      keyExtractor={(item) => item.occurrenceId}
      renderItem={({ item, index }) => renderItem({ item, index })}
      scrollEnabled={scrollEnabled}
      initialNumToRender={15}
    />
  );
}
