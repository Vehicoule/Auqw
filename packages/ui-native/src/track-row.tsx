import { View } from 'react-native';
import { useTheme } from './theme.tsx';
import {
  Artwork,
  EqBars,
  Icon,
  IconButton,
  Pressable,
  Text,
} from './primitives.tsx';
import { formatClock } from './view-models.ts';
import type { TrackRowModel } from './view-models.ts';

export type TrackRowProps = {
  readonly row: TrackRowModel;
  readonly onPress?: (() => void) | undefined;
  readonly onLongPress?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  readonly onContext?: (() => void) | undefined;
  readonly reorderControls?: 'none' | 'drag' | 'buttons' | undefined;
  readonly onMoveUp?: (() => void) | undefined;
  readonly onMoveDown?: (() => void) | undefined;
  readonly onRemove?: (() => void) | undefined;
};

export function TrackRow({
  row,
  onPress,
  onLongPress,
  onToggleLike,
  onContext,
  reorderControls = 'none',
  onMoveUp,
  onMoveDown,
  onRemove,
}: TrackRowProps) {
  const theme = useTheme();
  const unavailable = row.state !== 'available';
  const sub =
    row.note ??
    [row.artist, formatClock(row.durationMs)]
      .filter((part): part is string => part !== null && part !== '—')
      .join(' · ');
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      compact
      accessibilityLabel={`${row.title}${row.artist === null ? '' : `, ${row.artist}`}${unavailable ? ', unavailable' : ''}${row.playing ? ', playing' : ''}`}
      accessibilityRole="button"
      accessibilityState={{ selected: row.playing }}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 11,
          height: theme.sizes.trackRow,
          paddingHorizontal: theme.spacing.sm,
          borderRadius: theme.radius.control,
        },
        row.playing && { backgroundColor: theme.colors.accentSoft },
        pressed && { backgroundColor: theme.colors.fg08 },
      ]}
    >
      {reorderControls !== 'none' && (
        <View style={{ marginRight: -4 }}>
          {reorderControls === 'drag' ? (
            <Icon
              name="drag-handle"
              size={14}
              color={theme.colors.textSecondary}
            />
          ) : (
            <View style={{ gap: 2 }}>
              <IconButton
                icon="chevron-up"
                size={20}
                iconSize={10}
                accessibilityLabel="move up"
                onPress={onMoveUp}
              />
              <IconButton
                icon="chevron-down"
                size={20}
                iconSize={10}
                accessibilityLabel="move down"
                onPress={onMoveDown}
              />
            </View>
          )}
        </View>
      )}
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: theme.radius.thumb,
          overflow: 'hidden',
        }}
        accessible={false}
      >
        <Artwork url={row.artworkUrl} size={40} dimmed={unavailable} />
        {row.playing && (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(0,0,0,0.45)',
            }}
          >
            <EqBars size={11} />
          </View>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          variant="body"
          color={
            row.playing
              ? 'accent'
              : unavailable
                ? 'secondary'
                : 'primary'
          }
          numberOfLines={1}
          style={[
            { fontSize: 11.5 },
            row.playing
              ? { fontFamily: theme.fontFamilies.bold }
              : undefined,
          ]}
        >
          {row.title}
        </Text>
        {sub !== '' && (
          <Text
            variant="metadata"
            color="secondary"
            numberOfLines={1}
            style={{ marginTop: 2, fontSize: 9.5 }}
          >
            {sub}
          </Text>
        )}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {row.state !== 'available' && (
          <View
            style={{
              width: 30,
              height: 30,
              alignItems: 'center',
              justifyContent: 'center',
            }}
            accessible={false}
          >
            <Icon name="warn" size={14} color={theme.colors.warn} />
          </View>
        )}
        {row.liked && (
          <IconButton
            icon="heart-filled"
            size={30}
            iconSize={14}
            color={theme.colors.liked}
            accessibilityLabel="liked"
            onPress={onToggleLike}
          />
        )}
        {!row.liked && onToggleLike !== undefined && (
          <IconButton
            icon="heart"
            size={30}
            iconSize={14}
            accessibilityLabel="like"
            onPress={onToggleLike}
          />
        )}
        {onRemove !== undefined && (
          <IconButton
            icon="close"
            size={30}
            iconSize={14}
            accessibilityLabel="remove from queue"
            onPress={onRemove}
          />
        )}
        {onContext !== undefined && (
          <IconButton
            icon="list-plus"
            size={30}
            iconSize={14}
            accessibilityLabel={`more actions for ${row.title}`}
            onPress={onContext}
          />
        )}
      </View>
    </Pressable>
  );
}
