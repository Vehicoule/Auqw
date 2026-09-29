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
import type { QueueItemModel, QueueModel } from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';
import { queueSectionLabel } from '@auqw/ui-shared/controllers';

// Reorder mode swaps the FlatList for a DraggableFlatList: rows get a
// drag handle, the lift animation comes from ScaleDecorator, and a
// light haptic marks the grab. The committed order is still session
// state — onDragEnd reports indices, the caller issues moveOccurrence.
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
  const upNextStart = items.findIndex((item) => item.section === 'upNext');
  const upNextEnd = items.findLastIndex((item) => item.section === 'upNext');
  const renderItem = ({
    item,
    index,
    onDragStart,
    controls,
  }: {
    item: QueueItemModel;
    index: number;
    onDragStart?: (() => void) | undefined;
    controls: 'none' | 'buttons' | 'drag';
  }) => (
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
        reorderControls={controls}
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
          reordering && onMoveItem !== undefined &&
          item.section === 'upNext' &&
          items[index - 1]?.section === 'upNext'
            ? () => onMoveItem(item.occurrenceId, -1)
            : undefined
        }
        onMoveDown={
          reordering && onMoveItem !== undefined &&
          item.section === 'upNext' &&
          items[index + 1]?.section === 'upNext'
            ? () => onMoveItem(item.occurrenceId, 1)
            : undefined
        }
      />
    </View>
  );
  if (reordering && onMoveItemTo !== undefined) {
    return (
      <DraggableFlatList
        data={items.slice()}
        keyExtractor={(item) => item.occurrenceId}
        scrollEnabled={scrollEnabled}
        contentContainerStyle={{ paddingBottom: contentPaddingBottom }}
        onDragEnd={({ from, to }) => {
          const item = items[from];
          // Reorder is confined to up-next: the drop clamps into the
          // section — and the clamped display slot is the destination
          // the session's move contract indexes.
          const destination =
            upNextStart === -1
              ? undefined
              : Math.max(upNextStart, Math.min(to, upNextEnd));
          if (item?.section === 'upNext' && destination !== undefined) {
            onMoveItemTo(item.occurrenceId, destination);
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
              controls: 'drag',
              // Only up-next rows lift — outside the section the
              // handle dims to disabled instead of faking it.
              onDragStart:
                item.section === 'upNext'
                  ? () => {
                    void Haptics.impactAsync(
                      Haptics.ImpactFeedbackStyle.Light,
                    );
                    drag();
                  }
                  : undefined,
            })}
          </ScaleDecorator>
        )}
      />
    );
  }
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.occurrenceId}
      renderItem={({ item, index }) =>
        renderItem({
          item,
          index,
          // Reorder without an absolute handler falls back to paired
          // chevrons (relative moves) instead of a dead drag handle.
          controls:
            reordering && onMoveItem !== undefined ? 'buttons' : 'none',
        })
      }
      scrollEnabled={scrollEnabled}
      initialNumToRender={15}
      contentContainerStyle={{ paddingBottom: contentPaddingBottom }}
    />
  );
}
