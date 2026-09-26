import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useTheme } from './theme.tsx';
import type { Theme } from './theme.tsx';
import {
  Artwork,
  Icon,
  IconButton,
  Pressable,
  PlayPauseIcon,
  Spinner,
  Text,
} from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { WaveformSeek } from './progress.tsx';
import { QueueList } from './queue-list';
import { EmptyState, ErrorState, LoadingState } from './states.tsx';
import type {
  LyricsModel,
  MessageId,
  PlatformVariant,
  PlayerModel,
  QueueModel,
  RadioModel,
  StageMode,
} from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';

export type { LyricsModel, StageMode } from '@auqw/ui-shared';

export type TransportProps = {
  readonly variant?: 'm3e' | 'ios' | undefined;
  readonly status: PlayerModel['status'];
  readonly liked: boolean;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  /** Owned-bytes state of the current track; null hides the button. */
  readonly download?: import('@auqw/ui-shared').DownloadChip | null | undefined;
  readonly onDownload?: (() => void) | undefined;
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
  onPlayPause,
  onPrevious,
  onNext,
  onToggleLike,
  download = null,
  onDownload,
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
        accessibilityLabel={liked ? t('common.unlike') : t('common.like')}
        active={liked}
        onPress={onToggleLike}
        style={v.side}
      />
      <IconButton
        icon="previous"
        size={36}
        iconSize={15}
        color={theme.colors.textPrimary}
        accessibilityLabel={t('common.previous')}
        disabled={!canPrevious}
        onPress={onPrevious}
        style={v.main}
      />
      <Pressable
        compact
        onPress={onPlayPause}
        accessibilityLabel={
          playing ? t('common.pause') : t('common.play')
        }
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
          <PlayPauseIcon
            playing={playing}
            size={18}
            color={playColor}
          />
        )}
      </Pressable>
      <IconButton
        icon="next"
        size={36}
        iconSize={15}
        color={theme.colors.textPrimary}
        accessibilityLabel={t('common.next')}
        disabled={!canNext}
        onPress={onNext}
        style={v.main}
      />
      {download !== null && (
        <IconButton
          icon={
            download === 'stored'
              ? 'check'
              : download === 'failed'
                ? 'warn'
                : 'download'
          }
          size={32}
          iconSize={14}
          color={
            download === 'failed'
              ? theme.colors.warn
              : download === 'stored'
                ? theme.colors.accent
                : theme.colors.textSecondary
          }
          accessibilityLabel={
            download === 'stored'
              ? t('stage.download.storedA11y')
              : download === 'failed'
                ? t('stage.download.failedA11y')
                : download === 'queued' || download === 'downloading'
                  ? t('stage.download.busyA11y')
                  : t('stage.download.idleA11y')
          }
          active={download === 'stored'}
          onPress={onDownload}
          style={v.side}
        />
      )}
    </View>
  );
}

const MODES: readonly {
  key: StageMode;
  label: MessageId;
  icon: IconName;
}[] = [
  { key: 'player', label: 'stage.mode.player', icon: 'note' },
  { key: 'lyrics', label: 'stage.mode.lyrics', icon: 'lyrics' },
  { key: 'queue', label: 'stage.mode.queue', icon: 'queue' },
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
        // M3E segmented-button: the selected segment reads as a tonal
        // (secondary-container) pill; iOS keeps the raised slab.
        const m3e = Platform.OS === 'android';
        const activeBg = m3e ? theme.colors.accentSoft : theme.colors.raised;
        const activeColor = m3e ? theme.colors.accent : theme.colors.textBright;
        return (
          <Pressable
            key={m.key}
            compact
            onPress={onSelect === undefined ? undefined : () => onSelect(m.key)}
            accessibilityRole="tab"
            accessibilityLabel={t(m.label)}
            accessibilityState={{ selected: active }}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              minHeight: theme.sizes.touch,
              borderRadius: m3e ? theme.radius.pill : 4,
              backgroundColor: active ? activeBg : 'transparent',
            }}
          >
            <Icon
              name={m.icon}
              size={12}
              color={active ? activeColor : theme.colors.textSecondary}
            />
            <Text
              variant="metadata"
              color={active ? (m3e ? 'accent' : 'bright') : 'secondary'}
              style={[
                active && { fontFamily: theme.fontFamilies.bold },
              ]}
            >
              {t(m.label)}
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
  readonly radio?: RadioModel | undefined;
  readonly queueReordering?: boolean | undefined;
  readonly queueScrollEnabled?: boolean | undefined;
  readonly dragPreview?: 'rest' | 'mid-drag' | 'dismissed' | undefined;
  readonly topInset?: number | undefined;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  readonly download?: import('@auqw/ui-shared').DownloadChip | null | undefined;
  readonly onDownload?: (() => void) | undefined;
  readonly onSeek?: ((ms: number) => void) | undefined;
  readonly onRetryLyrics?: (() => void) | undefined;
  readonly onStartRadio?: (() => void) | undefined;
  readonly onStopRadio?: (() => void) | undefined;
  readonly onModeChange?: ((mode: StageMode) => void) | undefined;
  readonly onPressQueueItem?: ((occurrenceId: string) => void) | undefined;
  readonly onRemoveQueueItem?: ((occurrenceId: string) => void) | undefined;
  readonly onToggleQueueReorder?: (() => void) | undefined;
  readonly onMoveQueueItem?:
  | ((occurrenceId: string, direction: -1 | 1) => void)
  | undefined;
  readonly onMoveQueueItemTo?:
  | ((occurrenceId: string, toIndex: number) => void)
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
  radio,
  queueReordering = false,
  queueScrollEnabled = true,
  dragPreview = 'rest',
  topInset = 0,
  onPlayPause,
  onNext,
  onPrevious,
  onToggleLike,
  download = null,
  onDownload,
  onSeek,
  onRetryLyrics,
  onStartRadio,
  onStopRadio,
  onModeChange,
  onPressQueueItem,
  onRemoveQueueItem,
  onToggleQueueReorder,
  onMoveQueueItem,
  onMoveQueueItemTo,
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

  useEffect(() => {
    if (dragPreview === 'rest') {
      translateY.value = expanded ? 0 : height;
      opacity.value = expanded ? 1 : 0;
    } else if (dragPreview === 'mid-drag') {
      translateY.value = Math.max(0, height * 0.25);
      opacity.value = 0.86;
    } else {
      translateY.value = height;
      opacity.value = 0;
    }
  }, [dragPreview, expanded, height, opacity, translateY]);

  const collapse = useCallback(() => {
    onExpandChange?.(false);
  }, [onExpandChange]);

  // The gesture object is stable across renders — a fresh Pan() per
  // render would cancel an in-flight sheet drag on the next tick.
  const pan = useMemo(
    () =>
      Gesture.Pan()
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
            scheduleOnRN(collapse);
          } else {
            translateY.value = theme.reducedMotion
              ? 0
              : withTiming(0, { duration: theme.motion.gesture.duration });
            opacity.value = theme.reducedMotion
              ? 1
              : withTiming(1, { duration: theme.motion.gesture.duration });
          }
        }),
    [
      height,
      theme.reducedMotion,
      theme.motion.sheet,
      theme.motion.gesture.duration,
      collapse,
      dragStart,
      translateY,
      opacity,
    ],
  );

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
                style={{ marginTop: 4 }}
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
              onPlayPause={onPlayPause}
              onPrevious={onPrevious}
              onNext={onNext}
              onToggleLike={onToggleLike}
              download={download}
              onDownload={onDownload}
            />
          </View>
          {/*
           * The live radio element: a seed affordance when no tail is
           * armed, the tail's honest status when one is — 'failed'
           * carries the typed message, and stop always clears.
           */}
          {radio !== undefined && (radio.armed || onStartRadio !== undefined) && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: theme.spacing.sm,
                marginTop: theme.spacing.md,
              }}
            >
              <Icon
                name="radio"
                size={13}
                color={
                  radio.armed && radio.status !== 'failed'
                    ? theme.colors.accent
                    : theme.colors.textSecondary
                }
              />
              {radio.armed ? (
                <>
                  <Text
                    variant="metadata"
                    color={radio.status === 'failed' ? 'warn' : 'secondary'}
                  >
                    {radio.label}
                    {radio.fetching ? t('stage.radio.fetchingSuffix') : ''}
                    {radio.detail === null ? '' : ` · ${radio.detail}`}
                  </Text>
                  <Pressable
                    compact
                    onPress={onStopRadio}
                    accessibilityLabel={t('stage.radio.stopA11y')}
                    style={{ paddingHorizontal: theme.spacing.xs }}
                  >
                    <Text variant="metadata" color="primary">
                      {t('stage.radio.stop')}
                    </Text>
                  </Pressable>
                </>
              ) : (
                <Pressable
                  compact
                  onPress={onStartRadio}
                  accessibilityLabel={t('stage.radio.start')}
                  style={{ paddingHorizontal: theme.spacing.xs }}
                >
                  <Text variant="metadata" color="secondary">
                    {t('stage.radio.start')}
                  </Text>
                </Pressable>
              )}
            </View>
          )}
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
          {/*
           * Honest lyrics: only `state === 'synced'` highlights the
           * active line — plain text never gets synced treatment,
           * instrumental/unavailable/error are explicit states, and
           * loading is bounded by the session's own op deadline.
           */}
          {lyrics === undefined ? (
            <EmptyState title={t('lyrics.empty')} icon="lyrics" />
          ) : lyrics.state === 'loading' ? (
            <LoadingState title={t('lyrics.loading')} />
          ) : lyrics.state === 'error' ? (
            <ErrorState
              title={t('lyrics.errorTitle')}
              hint={lyrics.message}
              onRetry={onRetryLyrics}
            />
          ) : lyrics.state === 'instrumental' ? (
            <EmptyState
              title={t('lyrics.instrumental')}
              hint={lyrics.message}
              icon="lyrics"
            />
          ) : lyrics.state === 'unavailable' ? (
            <EmptyState
              title={t('lyrics.empty')}
              hint={lyrics.message}
              icon="lyrics"
            />
          ) : lyrics.lines.length === 0 ? (
            <EmptyState title={t('lyrics.empty')} icon="lyrics" />
          ) : (
            <ScrollView style={{ flex: 1, marginTop: theme.spacing.sm }}>
              {lyrics.lines.map((line, i) => (
                <Text
                  key={i}
                  variant="body"
                  color={
                    i === lyrics.activeIndex
                      ? 'accent'
                      : lyrics.state === 'plain'
                        ? 'primary'
                        : 'secondary'
                  }
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
            <EmptyState title={t('queue.empty')} icon="queue" />
          ) : (
            <>
              {onToggleQueueReorder !== undefined && (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    marginBottom: theme.spacing.xs,
                  }}
                >
                  <IconButton
                    icon="drag-handle"
                    size={32}
                    iconSize={14}
                    color={
                      queueReordering
                        ? theme.colors.accent
                        : theme.colors.textSecondary
                    }
                    accessibilityLabel={
                      queueReordering ? t('queue.reorderDone') : t('queue.reorder')
                    }
                    active={queueReordering}
                    onPress={onToggleQueueReorder}
                  />
                </View>
              )}
              <QueueList
                queue={queue}
                reordering={queueReordering}
                scrollEnabled={queueScrollEnabled}
                onPressItem={onPressQueueItem}
                onRemoveItem={onRemoveQueueItem}
                onMoveItem={onMoveQueueItem}
                onMoveItemTo={onMoveQueueItemTo}
              />
            </>
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
