import { FlatList, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import type { QueueItemModel, QueueModel } from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';
import { queueSectionLabel } from '@auqw/ui-shared/controllers';

// Shared fallback (web/desktop + any platform without gesture-handler):
// reorder uses paired chevron controls; the native variant swaps this
// whole list for DraggableFlatList + drag handles.
export type QueueListProps = {
  readonly queue: QueueModel;
  readonly reordering?: boolean | undefined;
  readonly scrollEnabled?: boolean | undefined;
  /** Bottom inset inside the scroll content — the stage's floating
      mode segment overlays this zone; the pad lets the last row
      scroll fully clear of it. */
  readonly contentPaddingBottom?: number | undefined;
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
  contentPaddingBottom = 0,
  onPressItem,
  onRemoveItem,
  onMoveItem,
  onMoveItemTo,
}: QueueListProps) {
  const theme = useTheme();
  if (queue.items.length === 0) {
    return <EmptyState title={t('queue.empty')} icon="queue" />;
  }
  // Display order (nowPlaying → upNext → history) is not the canonical
  // order the engine indexes — move calls translate through
  // `item.index` / the displaced neighbor's slot.
  const items = queue.sections.flatMap((section) => section.items);
  const canMove = onMoveItem !== undefined || onMoveItemTo !== undefined;
  const move = (item: QueueItemModel, neighbor: QueueItemModel | undefined) => {
    if (
      item.section !== 'upNext' ||
      neighbor === undefined ||
      neighbor.section !== 'upNext'
    ) {
      return;
    }
    const direction = neighbor.index < item.index ? -1 : 1;
    if (onMoveItem !== undefined) {
      onMoveItem(item.occurrenceId, direction);
    } else {
      onMoveItemTo?.(item.occurrenceId, neighbor.index);
    }
  };
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.occurrenceId}
      scrollEnabled={scrollEnabled}
      initialNumToRender={15}
      contentContainerStyle={{ paddingBottom: contentPaddingBottom }}
      renderItem={({ item, index }) => (
        <View>
          {items[index - 1]?.section !== item.section && (
            <Text
              variant="label"
              color={item.section === 'nowPlaying' ? 'accent' : 'secondary'}
              style={{ paddingHorizontal: theme.spacing.sm, marginBottom: 2 }}
              uppercase
            >
              {queueSectionLabel(item.section)}
            </Text>
          )}
          {item.duplicate && (
            <View
              style={{
                alignSelf: 'flex-start',
                marginHorizontal: theme.spacing.sm,
                marginTop: theme.spacing.xs,
                paddingHorizontal: 7,
                borderRadius: theme.radius.pill,
                borderWidth: theme.strokes.hairline,
                borderColor: theme.colors.hairline,
              }}
            >
              <Text variant="label" color="secondary" uppercase>
                {t('queue.badge.repeat')}
              </Text>
            </View>
          )}
          <TrackRow
            row={item.row}
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
              reordering && canMove &&
              item.section === 'upNext' &&
              items[index - 1]?.section === 'upNext'
                ? () => move(item, items[index - 1])
                : undefined
            }
            onMoveDown={
              reordering && canMove &&
              item.section === 'upNext' &&
              items[index + 1]?.section === 'upNext'
                ? () => move(item, items[index + 1])
                : undefined
            }
          />
        </View>
      )}
    />
  );
}
