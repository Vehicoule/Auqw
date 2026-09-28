import { View } from 'react-native';
import { useTheme } from './theme.tsx';
import {
  Artwork,
  EqBars,
  IconButton,
  Text,
} from './primitives.tsx';
import { QueueList } from './queue-list';
import type { PlayerModel, QueueModel } from '@auqw/ui-shared';
import {
  useQueueScreenController,
  type QueueScreenHandlers,
} from '@auqw/ui-shared/controllers';

export type QueueScreenProps = QueueScreenHandlers & {
  readonly queue: QueueModel;
  readonly player?: PlayerModel | null | undefined;
  readonly reordering?: boolean | undefined;
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
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
  const view = useQueueScreenController({
    queue,
    player,
    reordering,
    onToggleReorder,
  });
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
          {view.title}
        </Text>
        <Text variant="metadata" color="secondary" style={{ marginLeft: 10 }}>
          {view.countLabel}
        </Text>
        <View style={{ flex: 1 }} />
        {view.reorder !== null && (
          <IconButton
            icon={view.reorder.icon}
            size={32}
            iconSize={14}
            color={
              view.reorder.active
                ? theme.colors.accent
                : theme.colors.textSecondary
            }
            accessibilityLabel={view.reorder.a11yLabel}
            active={view.reorder.active}
            onPress={view.reorder.onPress}
          />
        )}
      </View>
      {view.current !== null && (
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
            <Artwork url={view.current.artworkUrl} size={40} />
            {view.current.playing && (
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
              {view.current.title}
            </Text>
            <Text variant="metadata" color="secondary" numberOfLines={1}>
              {view.current.metaLabel}
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
