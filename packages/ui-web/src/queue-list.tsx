import type { KeyboardEvent } from 'react';
import { Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import { useTrackList } from './track-row.tsx';
import type { QueueItemModel, QueueModel } from '@auqw/ui-shared';

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

// Web reordering is button-driven: Alt+ArrowUp/ArrowDown moves the
// focused row (the pointer path is the visible chevrons) — no pointer
// drag library for one list.
export function QueueList({
  queue,
  reordering = false,
  scrollEnabled = true,
  onPressItem,
  onRemoveItem,
  onMoveItem,
}: QueueListProps) {
  const list = useTrackList({
    count: queue.items.length,
    onActivate:
      onPressItem === undefined || reordering
        ? undefined
        : (index) => {
            const item = queue.items[index];
            if (item !== undefined) {
              onPressItem(item.occurrenceId);
            }
          },
    onContext: undefined,
  });
  if (queue.items.length === 0) {
    return <EmptyState title="queue is empty" icon="queue" />;
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      reordering &&
      onMoveItem !== undefined &&
      event.altKey &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      const item = queue.items[list.focusIndex];
      if (item !== undefined) {
        event.preventDefault();
        onMoveItem(item.occurrenceId, event.key === 'ArrowUp' ? -1 : 1);
        return;
      }
    }
    list.listProps.onKeyDown(event);
  };
  return (
    <div
      role="list"
      aria-label="queue"
      className="uw-list"
      data-scroll={scrollEnabled ? 'true' : 'false'}
      onKeyDown={onKeyDown}
    >
      {queue.items.map((item, index) => (
        <div key={item.occurrenceId}>
          {item.current && (
            <Text
              variant="label"
              color="accent"
              uppercase
              className="uw-now-playing-label"
            >
              now playing
            </Text>
          )}
          <TrackRow
            row={item.row}
            badge={item.duplicate ? 'repeat' : null}
            reorderControls={reordering ? 'buttons' : 'none'}
            tabIndex={list.rowTabIndex(index)}
            onFocusRow={() => list.onRowFocus(index)}
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
        </div>
      ))}
    </div>
  );
}
