import { Artwork, EqBars, IconButton, Text } from './primitives.tsx';
import { QueueList } from './queue-list.tsx';
import type { PlayerModel, QueueModel } from '@auqw/ui-shared';
import { formatClock } from '@auqw/ui-shared';

export type QueueScreenProps = {
  readonly queue: QueueModel;
  readonly player?: PlayerModel | null | undefined;
  readonly reordering?: boolean | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onToggleReorder?: (() => void) | undefined;
  readonly onPressItem?: ((occurrenceId: string) => void) | undefined;
  readonly onRemoveItem?: ((occurrenceId: string) => void) | undefined;
  readonly onMoveItem?:
    | ((occurrenceId: string, direction: -1 | 1) => void)
    | undefined;
  readonly onMoveItemTo?:
    | ((occurrenceId: string, toIndex: number) => void)
    | undefined;
};

export function QueueScreen({
  queue,
  player = null,
  reordering = false,
  scrollEnabled = true,
  onToggleReorder,
  onPressItem,
  onRemoveItem,
  onMoveItem,
  onMoveItemTo,
}: QueueScreenProps) {
  return (
    <div
      className="uw-screen uw-queue"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <div className="uw-queue__head">
        <Text variant="heading" color="bright">
          queue
        </Text>
        <Text variant="metadata" color="secondary" className="uw-queue__count">
          {queue.items.length} tracks
        </Text>
        {onToggleReorder !== undefined && (
          <IconButton
            icon="drag-handle"
            size={32}
            iconSize={14}
            color={reordering ? 'var(--accent)' : 'var(--text-secondary)'}
            ariaLabel={reordering ? 'done reordering' : 'reorder queue'}
            active={reordering}
            onPress={onToggleReorder}
          />
        )}
      </div>
      {player !== null && (
        <div className="uw-queue__current" data-status={player.status}>
          <span className="uw-track-row__art">
            <Artwork url={player.artworkUrl} size={40} />
            {player.status === 'playing' && (
              <span className="uw-track-row__eq">
                <EqBars size={11} />
              </span>
            )}
          </span>
          <span className="uw-queue__current-text">
            <Text variant="body" color="accent" numberOfLines={1}>
              {player.title}
            </Text>
            <Text variant="metadata" color="secondary" numberOfLines={1}>
              {player.artist ?? '—'} · {formatClock(player.positionMs)} /{' '}
              {formatClock(player.durationMs)}
            </Text>
          </span>
        </div>
      )}
      <QueueList
        queue={queue}
        reordering={reordering}
        scrollEnabled={scrollEnabled}
        onPressItem={onPressItem}
        onRemoveItem={onRemoveItem}
        onMoveItem={onMoveItem}
        onMoveItemTo={onMoveItemTo}
      />
    </div>
  );
}
