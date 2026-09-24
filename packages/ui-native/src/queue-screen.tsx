import { View } from 'react-native';
import { useTheme } from './theme.tsx';
import {
  Artwork,
  EqBars,
  IconButton,
  Text,
} from './primitives.tsx';
import { QueueList } from './queue-list';
import type {
  PlayerModel,
  QueueModel,
} from '@auqw/ui-shared';
import { formatClock } from '@auqw/ui-shared';

export type QueueScreenProps = {
  readonly queue: QueueModel;
  readonly player?: PlayerModel | null | undefined;
  readonly reordering?: boolean | undefined;
  readonly topInset?: number | undefined;
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
  topInset = 0,
  scrollEnabled = true,
  onToggleReorder,
  onPressItem,
  onRemoveItem,
  onMoveItem,
  onMoveItemTo,
}: QueueScreenProps) {
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
          alignItems: 'center',
          paddingHorizontal: theme.spacing.screen,
          marginTop: theme.spacing.sm,
          marginBottom: theme.spacing.md,
        }}
      >
        <Text variant="heading" color="bright">
          queue
        </Text>
        <Text variant="metadata" color="secondary" style={{ marginLeft: 10 }}>
          {queue.items.length} tracks
        </Text>
        <View style={{ flex: 1 }} />
        {onToggleReorder !== undefined && (
          <IconButton
            icon="drag-handle"
            size={32}
            iconSize={14}
            color={
              reordering ? theme.colors.accent : theme.colors.textSecondary
            }
            accessibilityLabel={reordering ? 'done reordering' : 'reorder queue'}
            active={reordering}
            onPress={onToggleReorder}
          />
        )}
      </View>
      {player !== null && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 11,
            marginHorizontal: theme.spacing.screen,
            marginBottom: theme.spacing.sm,
            padding: theme.spacing.sm,
            borderRadius: theme.radius.control,
            backgroundColor: theme.colors.accentSoft,
          }}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: theme.radius.thumb,
              overflow: 'hidden',
            }}
          >
            <Artwork url={player.artworkUrl} size={40} />
            {player.status === 'playing' && (
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.colors.scrim,
                }}
              >
                <EqBars size={11} />
              </View>
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="body" color="accent" numberOfLines={1}>
              {player.title}
            </Text>
            <Text variant="metadata" color="secondary" numberOfLines={1}>
              {player.artist ?? '—'} · {formatClock(player.positionMs)} /{' '}
              {formatClock(player.durationMs)}
            </Text>
          </View>
        </View>
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
    </View>
  );
}
