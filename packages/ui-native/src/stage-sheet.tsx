import { useEffect, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from './theme.tsx';
import type { Theme } from './theme.tsx';
import {
  Artwork,
  Icon,
  IconButton,
  Pressable,
  Spinner,
  Text,
} from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { WaveformSeek } from './progress.tsx';
import { QueueList } from './queue-list.tsx';
import { EmptyState } from './states.tsx';
import type {
  LyricsModel,
  PlatformVariant,
  PlayerModel,
  QueueModel,
  StageMode,
} from './view-models.ts';

export type { LyricsModel, StageMode } from './view-models.ts';

export type TransportProps = {
  readonly variant?: 'm3e' | 'ios' | undefined;
  readonly status: PlayerModel['status'];
  readonly liked: boolean;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly repeatActive?: boolean | undefined;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  readonly onToggleRepeat?: (() => void) | undefined;
};

function transportVariant(
  theme: Theme,
  variant: 'm3e' | 'ios',
): {
  readonly side: ViewStyle;
  readonly main: ViewStyle;
  readonly play: ViewStyle;
  readonly playSize: number;
} {
  if (variant === 'm3e') {
    return {
      side: { borderRadius: 12 },
      main: { borderRadius: 12, backgroundColor: theme.colors.raised },
      play: {
        borderRadius: 16,
        backgroundColor: theme.colors.accent,
        width: 56,
        height: 44,
      },
      playSize: 56,
    };
  }
  return {
    side: { borderRadius: 999 },
    main: {
      borderRadius: 999,
      backgroundColor: theme.colors.glass,
      borderWidth: theme.strokes.hairline,
      borderColor: theme.colors.hairline,
    },
    play: {
      borderRadius: 999,
      backgroundColor: theme.colors.glass,
      borderWidth: theme.strokes.hairline,
      borderColor: theme.colors.hairline,
      width: 56,
      height: 56,
    },
    playSize: 56,
  };
}

export function TransportControls({
  variant = Platform.OS === 'ios' ? 'ios' : 'm3e',
  status,
  liked,
  canPrevious,
  canNext,
  repeatActive = false,
  onPlayPause,
  onPrevious,
  onNext,
  onToggleLike,
  onToggleRepeat,
}: TransportProps) {
  const theme = useTheme();
  const v = transportVariant(theme, variant);
  const busy = status === 'preparing' || status === 'buffering';
  const playing = status === 'playing';
  const playColor = variant === 'm3e' ? theme.colors.canvas : theme.colors.textBright;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.xs + 2,
      }}
    >
      <IconButton
        icon={liked ? 'heart-filled' : 'heart'}
        size={32}
        iconSize={14}
        color={liked ? theme.colors.liked : theme.colors.textSecondary}
        accessibilityLabel={liked ? 'unlike' : 'like'}
        active={liked}
        onPress={onToggleLike}
        style={v.side}
      />
      <IconButton
        icon="previous"
        size={36}
        iconSize={15}
        color={theme.colors.textPrimary}
        accessibilityLabel="previous"
        disabled={!canPrevious}
        onPress={onPrevious}
        style={v.main}
      />
      <Pressable
        compact
        onPress={onPlayPause}
        accessibilityLabel={playing ? 'pause' : 'play'}
        accessibilityState={{ selected: playing }}
        style={[
          {
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: theme.sizes.touch,
            minHeight: theme.sizes.touch,
          },
          v.play,
        ]}
      >
        {busy ? (
          <Spinner size={18} color={playColor} />
        ) : (
          <Icon
            name={playing ? 'pause' : 'play'}
            size={18}
            color={playColor}
            filled
          />
        )}
      </Pressable>
      <IconButton
        icon="next"
        size={36}
        iconSize={15}
        color={theme.colors.textPrimary}
        accessibilityLabel="next"
        disabled={!canNext}
        onPress={onNext}
        style={v.main}
      />
      <IconButton
        icon="repeat"
        size={32}
        iconSize={14}
        color={repeatActive ? theme.colors.accent : theme.colors.textSecondary}
        accessibilityLabel="repeat"
        active={repeatActive}
        onPress={onToggleRepeat}
        style={v.side}
      />
    </View>
  );
}

const MODES: readonly { key: StageMode; label: string; icon: IconName }[] = [
  { key: 'player', label: 'player', icon: 'note' },
  { key: 'lyrics', label: 'lyrics', icon: 'lyrics' },
  { key: 'queue', label: 'queue', icon: 'queue' },
];

export function ModeSegment({
  mode,
  onSelect,
}: {
  readonly mode: StageMode;
  readonly onSelect?: ((mode: StageMode) => void) | undefined;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 2,
        backgroundColor: theme.colors.fg08,
        padding: 3,
        borderRadius: theme.radius.control,
        marginTop: theme.spacing.md,
      }}
    >
      {MODES.map((m) => {
        const active = m.key === mode;
        return (
          <Pressable
            key={m.key}
            compact
            onPress={onSelect === undefined ? undefined : () => onSelect(m.key)}
            accessibilityRole="tab"
            accessibilityLabel={m.label}
            accessibilityState={{ selected: active }}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              minHeight: theme.sizes.touch,
              borderRadius: 4,
              backgroundColor: active ? theme.colors.raised : 'transparent',
            }}
          >
            <Icon
              name={m.icon}
              size={12}
              color={active ? theme.colors.textBright : theme.colors.textSecondary}
            />
            <Text
              variant="metadata"
              color={active ? 'bright' : 'secondary'}
              style={[
                { fontSize: 10.5 },
                active && { fontFamily: theme.fontFamilies.bold },
              ]}
            >
              {m.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export type StageSheetProps = {
  readonly player: PlayerModel;
  readonly expanded: boolean;
  readonly onExpandChange: ((expanded: boolean) => void) | undefined;
  readonly platform?: PlatformVariant | undefined;
  readonly mode?: StageMode | undefined;
  readonly queue?: QueueModel | undefined;
  readonly lyrics?: LyricsModel | undefined;
  readonly topInset?: number | undefined;
  readonly repeatActive?: boolean | undefined;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  readonly onToggleRepeat?: (() => void) | undefined;
  readonly onSeek?: ((ms: number) => void) | undefined;
  readonly onModeChange?: ((mode: StageMode) => void) | undefined;
  readonly onPressQueueItem?: ((occurrenceId: string) => void) | undefined;
  readonly onRemoveQueueItem?: ((occurrenceId: string) => void) | undefined;
  readonly onMoveQueueItem?:
  | ((occurrenceId: string, direction: -1 | 1) => void)
  | undefined;
  readonly style?: StyleProp<ViewStyle> | undefined;
};

export function StageSheet({
  player,
  expanded,
  onExpandChange,
  platform = Platform.OS === 'ios' ? 'ios' : 'android',
  mode,
  queue,
  lyrics,
  topInset = 0,
  repeatActive = false,
  onPlayPause,
  onNext,
  onPrevious,
  onToggleLike,
  onToggleRepeat,
  onSeek,
  onModeChange,
  onPressQueueItem,
  onRemoveQueueItem,
  onMoveQueueItem,
  style,
}: StageSheetProps) {
  const theme = useTheme();
  const [height, setHeight] = useState(0);
  const translateY = useSharedValue(2000);
  const opacity = useSharedValue(expanded ? 1 : 0);
  const dragStart = useSharedValue(0);
  const [internalMode, setInternalMode] = useState<StageMode>('player');
  const activeMode = mode ?? internalMode;

  useEffect(() => {
    const target = expanded ? 0 : height;
    const fade = expanded ? 1 : 0;
    if (theme.reducedMotion) {
      translateY.value = expanded ? 0 : height;
      opacity.value = fade;
    } else {
      translateY.value = withTiming(target, { duration: theme.motion.sheet });
      opacity.value = withTiming(fade, { duration: theme.motion.state });
    }
  }, [expanded, height, theme.reducedMotion, theme.motion, translateY, opacity]);

  const collapse = () => {
    if (onExpandChange !== undefined) {
      onExpandChange(false);
    }
  };

  const pan = Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetX([-16, 16])
    .onBegin(() => {
      dragStart.value = translateY.value;
    })
    .onUpdate((e) => {
      translateY.value = Math.max(0, dragStart.value + e.translationY);
    })
    .onEnd((e) => {
      const shouldClose = e.translationY > 120 || e.velocityY > 700;
      if (shouldClose) {
        translateY.value = theme.reducedMotion
          ? height
          : withTiming(height, { duration: theme.motion.sheet });
        opacity.value = theme.reducedMotion
          ? 0
          : withTiming(0, { duration: theme.motion.sheet });
        runOnJS(collapse)();
      } else {
        translateY.value = theme.reducedMotion
          ? 0
          : withTiming(0, { duration: theme.motion.gesture.duration });
        opacity.value = theme.reducedMotion
          ? 1
          : withTiming(1, { duration: theme.motion.gesture.duration });
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      pointerEvents={expanded ? 'auto' : 'none'}
      accessibilityViewIsModal={expanded}
      style={[
        {
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: theme.colors.stage,
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.lg,
        },
        animatedStyle,
        style,
      ]}
    >
      <GestureDetector gesture={pan}>
        <View
          style={{
            alignItems: 'center',
            paddingTop: Math.max(32, topInset + theme.spacing.sm),
          }}
        >
          <View
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.colors.fg40,
            }}
          />
        </View>
      </GestureDetector>
      {activeMode === 'player' && (
        <>
          <View
            style={{ width: '100%', aspectRatio: 1, marginTop: theme.spacing.md }}
          >
            <Artwork url={player.artworkUrl} fill />
          </View>
          <View style={{ flex: 1 }} />
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: theme.spacing.sm,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="title" color="bright" numberOfLines={1}>
                {player.title}
              </Text>
              <Text
                variant="body"
                color="primary"
                numberOfLines={1}
                style={{ marginTop: 4, fontSize: 11.5 }}
              >
                {player.artist ?? '—'}
              </Text>
              {player.albumLabel !== null && (
                <Text
                  variant="metadata"
                  color="secondary"
                  numberOfLines={1}
                  style={{ marginTop: 3 }}
                >
                  {player.albumLabel}
                </Text>
              )}
              {player.errorMessage !== null && (
                <Text
                  variant="metadata"
                  color="warn"
                  numberOfLines={2}
                  style={{ marginTop: 3 }}
                >
                  {player.errorMessage}
                </Text>
              )}
            </View>
            <View style={{ flexDirection: 'row', gap: 2 }}>
              <IconButton
                icon="download"
                size={28}
                iconSize={14}
                accessibilityLabel="download"
              />
              <IconButton
                icon="list-plus"
                size={28}
                iconSize={14}
                accessibilityLabel="add to playlist"
              />
            </View>
          </View>
          <View style={{ flex: 1 }} />
          <WaveformSeek
            positionMs={player.positionMs}
            durationMs={player.durationMs}
            onSeek={onSeek}
          />
          <View style={{ marginTop: theme.spacing.md }}>
            <TransportControls
              variant={platform === 'ios' ? 'ios' : 'm3e'}
              status={player.status}
              liked={player.liked}
              canPrevious={player.canPrevious}
              canNext={player.canNext}
              repeatActive={repeatActive}
              onPlayPause={onPlayPause}
              onPrevious={onPrevious}
              onNext={onNext}
              onToggleLike={onToggleLike}
              onToggleRepeat={onToggleRepeat}
            />
          </View>
        </>
      )}
      {activeMode === 'lyrics' && (
        <>
          <View style={{ marginTop: theme.spacing.md }}>
            <Text variant="title" color="bright" numberOfLines={1}>
              {player.title}
            </Text>
            <Text
              variant="metadata"
              color="secondary"
              numberOfLines={1}
              style={{ marginTop: 3 }}
            >
              {player.artist ?? '—'}
              {lyrics?.syncLabel != null ? ` · ${lyrics.syncLabel}` : ''}
            </Text>
          </View>
          {lyrics === undefined || lyrics.lines.length === 0 ? (
            <EmptyState title="no lyrics" icon="lyrics" />
          ) : (
            <ScrollView style={{ flex: 1, marginTop: theme.spacing.sm }}>
              {lyrics.lines.map((line, i) => (
                <Text
                  key={i}
                  variant="body"
                  color={i === lyrics.activeIndex ? 'accent' : 'secondary'}
                  style={[
                    {
                      paddingVertical: 9,
                      paddingHorizontal: theme.spacing.sm,
                      borderRadius: theme.radius.control,
                    },
                    i === lyrics.activeIndex && {
                      fontFamily: theme.fontFamilies.bold,
                    },
                  ]}
                >
                  {line}
                </Text>
              ))}
            </ScrollView>
          )}
        </>
      )}
      {activeMode === 'queue' && (
        <View style={{ flex: 1, marginTop: theme.spacing.md }}>
          {queue === undefined ? (
            <EmptyState title="queue is empty" icon="queue" />
          ) : (
            <QueueList
              queue={queue}
              onPressItem={onPressQueueItem}
              onRemoveItem={onRemoveQueueItem}
              onMoveItem={onMoveQueueItem}
            />
          )}
        </View>
      )}
      <ModeSegment
        mode={activeMode}
        onSelect={(m) => {
          setInternalMode(m);
          if (onModeChange !== undefined) {
            onModeChange(m);
          }
        }}
      />
    </Animated.View>
  );
}
