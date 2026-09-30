import { useRef, useState } from 'react';
import { FlatList } from 'react-native';
import type { ViewToken } from 'react-native';
import DraggableFlatList, {
  ScaleDecorator,
} from 'react-native-draggable-flatlist';
import type { RenderItemParams } from 'react-native-draggable-flatlist';
import * as Haptics from 'expo-haptics';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import { QueueRowChrome } from './queue-list.tsx';
import type { QueueListProps } from './queue-list.tsx';
import type { QueueItemModel } from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';

export type { QueueListProps };

// Reorder mode swaps the FlatList for a DraggableFlatList: rows get a
// drag handle, the lift animation comes from ScaleDecorator, and a
// light haptic marks the grab. The committed order is still session
// state — onDragEnd reports indices, the caller issues moveOccurrence.

export function QueueList({
  queue,
  reordering = false,
  scrollEnabled = true,
  contentPaddingBottom = 0,
  onPressItem,
  onRowIntent,
  onViewportRows,
  onRemoveItem,
  onMoveItem,
  onMoveItemTo,
}: QueueListProps) {
  // FlatList requires a stable onViewableItemsChanged — rebind it
  // per render and the list throws, so the latest callback lives in
  // a ref the stable callback reads through.
  const viewportRows = useRef(onViewportRows);
  viewportRows.current = onViewportRows;
  const viewableChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const ids = viewableItems
        .map((token) => token.item as QueueItemModel)
        .filter((item) => item.section !== 'nowPlaying')
        .map((item) => item.occurrenceId);
      viewportRows.current?.(ids);
    },
  );
  // The draggable list animates to the raw drop slot; a drop outside
  // up-next is clamped on write, so the list remounts to re-render
  // from the model — otherwise it keeps showing the rejected landing.
  const [dragRemount, bumpDragRemount] = useState(0);
  // The remount's fresh list starts at the top — carry the last
  // scroll offset across so deep-queue reordering stays put. Both
  // list variants feed the ref and mount at it, so offset survives
  // mode switches too.
  const listScrollY = useRef(0);
  if (queue.items.length === 0) {
    return (
      <EmptyState
        title={t('queue.empty')}
        hint={t('queue.emptyHint')}
        icon="queue"
      />
    );
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
    <QueueRowChrome
      item={item}
      sectionStart={items[index - 1]?.section !== item.section}
    >
      <TrackRow
        row={item.row}
        reorderControls={controls}
        onDragStart={onDragStart}
        onPress={
          onPressItem === undefined || reordering
            ? undefined
            : () => onPressItem(item.occurrenceId)
        }
        onIntent={
          onRowIntent === undefined
            ? undefined
            : () => onRowIntent(item.occurrenceId)
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
    </QueueRowChrome>
  );
  if (reordering && onMoveItemTo !== undefined) {
    return (
      <DraggableFlatList
        key={dragRemount}
        data={items.slice()}
        keyExtractor={(item) => item.occurrenceId}
        scrollEnabled={scrollEnabled}
        scrollEventThrottle={64}
        onViewableItemsChanged={viewableChanged.current}
        onScroll={(event) => {
          listScrollY.current = event.nativeEvent.contentOffset.y;
        }}
        contentOffset={{ x: 0, y: listScrollY.current }}
        contentContainerStyle={{ paddingBottom: contentPaddingBottom }}
        onDragEnd={({ from, to }) => {
          const item = items[from];
          // Reorder is confined to up-next: the drop clamps into the
          // section — and the clamped display slot is the destination
          // the session's move contract indexes. An out-of-bounds drop
          // remounts the list so it can't keep showing the slot the
          // write rejected.
          const destination =
            upNextStart === -1
              ? undefined
              : Math.max(upNextStart, Math.min(to, upNextEnd));
          if (item?.section === 'upNext' && destination !== undefined) {
            if (destination !== to) {
              bumpDragRemount((x) => x + 1);
            }
            onMoveItemTo(item.occurrenceId, destination);
          } else if (item?.section === 'upNext') {
            bumpDragRemount((x) => x + 1);
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
      scrollEventThrottle={64}
      onViewableItemsChanged={viewableChanged.current}
      onScroll={(event) => {
        listScrollY.current = event.nativeEvent.contentOffset.y;
      }}
      contentOffset={{ x: 0, y: listScrollY.current }}
      contentContainerStyle={{ paddingBottom: contentPaddingBottom }}
    />
  );
}
