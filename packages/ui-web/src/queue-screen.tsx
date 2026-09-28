import { Artwork, EqBars, IconButton, Text } from './primitives.tsx';
import { QueueList } from './queue-list.tsx';
import type { PlayerModel, QueueModel } from '@auqw/ui-shared';
import {
  useQueueScreenController,
  type QueueScreenHandlers,
} from '@auqw/ui-shared/controllers';

export type QueueScreenProps = QueueScreenHandlers & {
  readonly queue: QueueModel;
  readonly player?: PlayerModel | null | undefined;
  readonly reordering?: boolean | undefined;
  readonly scrollEnabled?: boolean | undefined;
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
  const view = useQueueScreenController({
    queue,
    player,
    reordering,
    onToggleReorder,
  });
  return (
    <div
      className="uw-screen uw-queue"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <div className="uw-queue__head">
        <Text variant="heading" color="bright">
          {view.title}
        </Text>
        <Text variant="metadata" color="secondary" className="uw-queue__count">
          {view.countLabel}
        </Text>
        {view.reorder !== null && (
          <IconButton
            icon={view.reorder.icon}
            size={32}
            iconSize={14}
            color={
              view.reorder.active ? 'var(--accent)' : 'var(--text-secondary)'
            }
            ariaLabel={view.reorder.a11yLabel}
            active={view.reorder.active}
            onPress={view.reorder.onPress}
          />
        )}
      </div>
      {view.current !== null && (
        <div className="uw-queue__current" data-status={view.current.status}>
          <span className="uw-track-row__art">
            <Artwork url={view.current.artworkUrl} size={40} />
            {view.current.playing && (
              <span className="uw-track-row__eq">
                <EqBars size={11} />
              </span>
            )}
          </span>
          <span className="uw-queue__current-text">
            <Text variant="body" color="accent" numberOfLines={1}>
              {view.current.title}
            </Text>
            <Text variant="metadata" color="secondary" numberOfLines={1}>
              {view.current.metaLabel}
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
