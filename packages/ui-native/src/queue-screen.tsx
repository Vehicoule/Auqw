import { View } from 'react-native';
import { useTheme } from './theme.tsx';
import {
  IconButton,
  PlayingArtwork,
  Pressable,
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
  onOpenContext,
  onPressItem,
  onRemoveItem,
  onMoveItem,
  onMoveItemTo,
  onClearUpcoming,
}: QueueScreenProps) {
  const theme = useTheme();
  const view = useQueueScreenController({
    queue,
    player,
    reordering,
    onToggleReorder,
    onOpenContext,
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
        <Text variant="metadata" color="secondary" style={{ marginLeft: theme.spacing.sm }}>
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
      {view.origin !== null && (
        <Pressable
          onPress={view.origin.onPress}
          accessibilityLabel={view.origin.label}
          compact
          feedback="opacity"
          style={{
            alignSelf: 'flex-start',
            marginHorizontal: theme.spacing.screen,
            marginTop: -theme.spacing.sm,
            marginBottom: theme.spacing.sm,
          }}
        >
          <Text variant="metadata" color="secondary" numberOfLines={1}>
            {view.origin.label}
          </Text>
        </Pressable>
      )}
      {view.current !== null && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            marginHorizontal: theme.spacing.screen,
            marginBottom: theme.spacing.sm,
            padding: theme.spacing.sm,
            borderRadius: theme.radius.control,
            backgroundColor: theme.colors.accentSoft,
          }}
        >
          <PlayingArtwork
            url={view.current.artworkUrl}
            playing={view.current.playing}
          />
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
        onClearUpcoming={onClearUpcoming}
      />
    </View>
  );
}
