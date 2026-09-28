import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import Svg, {
  Defs,
  FeGaussianBlur,
  Filter,
  G,
  Image as SvgImage,
  LinearGradient,
  Mask,
  Rect,
  Stop,
} from 'react-native-svg';
import { schemes } from '@auqw/design-tokens';
import { ThemeProvider, useTheme } from './theme.tsx';
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
import { useResolvedArtworkUri } from './artwork.tsx';
import {
  resolveStageAnchor,
  stageContentAlpha,
  stageScrimAlpha,
  stageTopRadius,
} from './stage-motion';
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
  WaveformPeak,
} from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';


// Settle dynamics — the CMP deck's spring (StiffnessLow + no bounce): the
// release keeps the drag's velocity and lands without overshoot.
// damping 28 ≈ critically damped at stiffness 200 (ratio ~0.99): the settle
// carries the release velocity without overshooting past the anchor.
const STAGE_SETTLE_SPRING = { stiffness: 200, damping: 28 } as const;

// Corner morph: the pill's card radius at rest opening to the shared
// sheet radius mid-rise, square only at the completed expanded anchor.
const SHEET_CORNER_RADIUS = 28;

export type TransportProps = {
  readonly variant?: 'm3e' | 'ios' | undefined;
  readonly status: PlayerModel['status'];
  /**
   * The user's play/pause intent (queue mode) — the glyph and action
   * follow it even when transport is 'preparing' mid-retry, so pause
   * still wins while no handle exists.
   */
  readonly intentPlaying: PlayerModel['intentPlaying'];
  readonly liked: boolean;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  /** Shuffle toggle state — the cursor walks a dealt play order. */
  readonly shuffle?: boolean | undefined;
  readonly onToggleShuffle?: (() => void) | undefined;
  /** Current repeat mode — off / all / one from the player port. */
  readonly repeat?: 'off' | 'all' | 'one' | undefined;
  readonly onCycleRepeat?: (() => void) | undefined;
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
  intentPlaying,
  liked,
  canPrevious,
  canNext,
  onPlayPause,
  onPrevious,
  onNext,
  onToggleLike,
  shuffle = false,
  onToggleShuffle,
  repeat = 'off',
  onCycleRepeat,
}: TransportProps) {
  const theme = useTheme();
  const v = transportVariant(theme, variant);
  const busy = status === 'preparing' || status === 'buffering';
  const playing = intentPlaying;
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
        icon="shuffle"
        size={32}
        iconSize={14}
        color={shuffle ? theme.colors.accent : theme.colors.textSecondary}
        accessibilityLabel={t('common.shuffle')}
        disabled={onToggleShuffle === undefined}
        active={shuffle}
        onPress={onToggleShuffle}
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
      <IconButton
        icon={repeat === 'one' ? 'repeat-one' : 'repeat'}
        size={32}
        iconSize={14}
        color={
          repeat === 'off' ? theme.colors.textSecondary : theme.colors.accent
        }
        accessibilityLabel={
          repeat === 'one'
            ? t('common.repeatOne')
            : repeat === 'all'
              ? t('common.repeatAll')
              : t('common.repeat')
        }
        disabled={onCycleRepeat === undefined}
        active={repeat !== 'off'}
        onPress={onCycleRepeat}
        style={v.side}
      />
    </View>
  );
}

const MODES: readonly {
  key: StageMode;
  label: MessageId;
  icon: IconName;
}[] = [
  // Same order as the desktop segment — player leads on both platforms.
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
        borderRadius: theme.radius.pill,
      }}
    >
      {MODES.map((m) => {
        const active = m.key === mode;
        // M3E segmented-button: the selected segment reads as a tonal
        // (secondary-container) pill; iOS keeps the raised slab.
        // The pill silhouette matches the rounded transport controls —
        // only the fill differs per platform (tonal on Android, raised
        // on iOS).
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
              borderRadius: theme.radius.pill,
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

// Immersive player backdrop (CMP reference): the artwork full-bleed,
// then a statically blurred copy of it revealed by an alpha-gradient
// mask so the frost fades in only where the bottom controls sit — one
// rasterized blur pass, no live blur view and no hard edge — and a
// dark scrim gradient over the top for text contrast.
const FROST_TOP_FRACTION = 0.5;
const NIGHT = schemes.dark.deep;
// Mask ramps ride luminance — a bright token, alpha carried by
// stopOpacity.
const MASK_LIGHT = schemes.dark.textBright;

function PlayerBackdrop({
  artworkUrl,
}: {
  readonly artworkUrl: string;
}) {
  // One resolution for both copies — a second useResolvedArtworkUri
  // inside Artwork would repeat the persisted lookup and access-time
  // write; the blurred layer must read the same cache-local file the
  // sharp copy does anyway (offline a remote refetch is just absent).
  const { uri, pending, markRemote } = useResolvedArtworkUri(artworkUrl);
  const theme = useTheme();
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {pending || uri === null ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: theme.colors.raised,
              alignItems: 'center',
              justifyContent: 'center',
            },
          ]}
        >
          <Icon name="note" size={36} color={theme.colors.textSecondary} />
        </View>
      ) : (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={markRemote}
          accessibilityIgnoresInvertColors
        />
      )}
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="uwfp-scrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={NIGHT} stopOpacity="0.30" />
            <Stop offset="1" stopColor={NIGHT} stopOpacity="0.82" />
          </LinearGradient>
          {/* Alpha ramp for the frost mask: invisible until the
              frost zone, fully opaque by the transport row. */}
          <LinearGradient id="uwfp-frost-reveal" x1="0" y1="0" x2="0" y2="1">
            <Stop offset={FROST_TOP_FRACTION} stopColor={MASK_LIGHT} stopOpacity="0" />
            <Stop offset="0.72" stopColor={MASK_LIGHT} stopOpacity="0.55" />
            <Stop offset="0.9" stopColor={MASK_LIGHT} stopOpacity="1" />
          </LinearGradient>
          <Mask
            id="uwfp-frost"
            x="0"
            y="0"
            width="100%"
            height="100%"
            maskUnits="userSpaceOnUse"
            maskContentUnits="userSpaceOnUse"
          >
            <Rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              fill="url(#uwfp-frost-reveal)"
            />
          </Mask>
          <Filter id="uwfp-blur">
            <FeGaussianBlur stdDeviation={36} />
          </Filter>
        </Defs>
        {!pending && uri !== null && (
          <G mask="#uwfp-frost">
            <SvgImage
              href={uri}
              x="0"
              y="0"
              width="100%"
              height="100%"
              preserveAspectRatio="xMidYMid slice"
              filter="#uwfp-blur"
            />
          </G>
        )}
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#uwfp-scrim)" />
      </Svg>
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
  /** Bottom safe-area inset (home indicator / gesture bar) — the
      floating mode segment clears it. Hosts without edge insets
      (the gallery) omit it. */
  readonly bottomInset?: number | undefined;
  /** Shared 0..1 morph progress — the mini-player's rise drag writes it
      directly, so the sheet tracks the finger instead of replaying the
      `expanded` change after the fact. Standalone hosts (the gallery)
      omit it and the sheet animates from `expanded` alone. */
  readonly progress?: SharedValue<number> | undefined;
  /** Shared pixel travel for the morph — the sheet publishes its
      measured height here so the mini-player's drag converts finger
      pixels to progress against the same distance the sheet translates
      over. Standalone hosts omit it and the sheet measures itself. */
  readonly travel?: SharedValue<number> | undefined;
  /** Shared settle-target flag (-1 = idle, else 0/1): whichever
      gesture's release committed this anchor already launched its own
      velocity-carrying spring, so the `expanded`-flip effect must not
      restart the settle cold. Standalone hosts omit it. */
  readonly anchor?: SharedValue<number> | undefined;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  readonly download?: import('@auqw/ui-shared').DownloadChip | null | undefined;
  readonly onDownload?: (() => void) | undefined;
  readonly onAddToPlaylist?: (() => void) | undefined;
  readonly shuffle?: boolean | undefined;
  readonly onToggleShuffle?: (() => void) | undefined;
  readonly repeat?: 'off' | 'all' | 'one' | undefined;
  readonly onCycleRepeat?: (() => void) | undefined;
  readonly onSeek?: ((ms: number) => void) | undefined;
  /**
   * Real measured waveform peaks (canonical `PEAKS_RESOLUTION`
   * pairs) for the Stage seek — Android extractor output normalized
   * JS-side. Absent/null keeps the seeded pattern, which is also
   * the pending and failure fallback.
   */
  readonly peaks?: readonly WaveformPeak[] | null | undefined;
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
  dragPreview,
  topInset = 0,
  bottomInset = 0,
  progress: progressProp,
  travel: travelProp,
  anchor: anchorProp,
  onPlayPause,
  onNext,
  onPrevious,
  onToggleLike,
  download = null,
  onDownload,
  onAddToPlaylist,
  shuffle = false,
  onToggleShuffle,
  repeat = 'off',
  onCycleRepeat,
  onSeek,
  peaks,
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
  const { width: windowWidth } = useWindowDimensions();
  const [height, setHeight] = useState(0);
  const internalProgress = useSharedValue(expanded ? 1 : 0);
  // One progress drives the morph: the pill's rise drag writes it from
  // the UI thread, `expanded` flips only on commit.
  const progress = progressProp ?? internalProgress;
  const internalTravel = useSharedValue(0);
  // The measured sheet height is the morph's travel distance; the pill
  // divides finger pixels by this same value so the rise is 1:1.
  const travelPx = travelProp ?? internalTravel;
  const internalAnchor = useSharedValue(-1);
  const anchor = anchorProp ?? internalAnchor;
  const dragStart = useSharedValue(0);
  const [internalMode, setInternalMode] = useState<StageMode>('player');
  const activeMode = mode ?? internalMode;

  // The parent re-renders on every position tick and passes fresh
  // inline closures — a deps-listed callback would rebuild the pan
  // (canceling the in-flight drag), so the gesture commits through a
  // ref instead.
  const onExpandChangeRef = useRef(onExpandChange);
  useEffect(() => {
    onExpandChangeRef.current = onExpandChange;
  }, [onExpandChange]);

  useEffect(() => {
    const target = expanded ? 1 : 0;
    // A gesture's release already launched a velocity-carrying spring
    // toward this anchor — restarting it here would drop the flick.
    const gestureOwned = anchor.value === target;
    anchor.value = -1;
    if (gestureOwned) {
      return;
    }
    progress.value = theme.reducedMotion
      ? target
      : withSpring(target, STAGE_SETTLE_SPRING);
  }, [expanded, theme.reducedMotion, progress, anchor]);

  // Gallery-only preview states — production never passes dragPreview,
  // and this must not run for ordinary `expanded` flips or it would
  // stomp the settle spring the expand effect just started.
  useEffect(() => {
    if (dragPreview === undefined) return;
    if (dragPreview === 'rest') {
      progress.value = expanded ? 1 : 0;
    } else if (dragPreview === 'mid-drag') {
      progress.value = 0.75;
    } else {
      progress.value = 0;
    }
  }, [dragPreview, expanded, progress]);

  const commitAnchor = useCallback((target: number) => {
    onExpandChangeRef.current?.(target === 1);
  }, []);

  // Tap on the uncovered region dismisses — including mid-morph, where
  // `expanded` is still false and the state flip alone wouldn't move
  // the spring.
  const dismissBackdrop = useCallback(() => {
    progress.value = theme.reducedMotion
      ? 0
      : withSpring(0, STAGE_SETTLE_SPRING);
    onExpandChangeRef.current?.(false);
  }, [progress, theme.reducedMotion]);

  // The gesture object is stable across renders — a fresh Pan() per
  // render would cancel an in-flight sheet drag on the next tick.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(8)
        .failOffsetX([-16, 16])
        .onBegin(() => {
          dragStart.value = progress.value;
        })
        .onUpdate((e) => {
          const travel = Math.max(1, travelPx.value);
          progress.value = Math.min(
            1,
            Math.max(0, dragStart.value - e.translationY / travel),
          );
        })
        .onFinalize((e) => {
          const travel = Math.max(1, travelPx.value);
          const target =
            resolveStageAnchor(
              dragStart.value,
              progress.value,
              e.velocityY,
            ) === 'expanded'
              ? 1
              : 0;
          // Mark the settle as gesture-owned so the `expanded` flip the
          // commit schedules doesn't cold-restart this spring.
          anchor.value = target;
          progress.value = theme.reducedMotion
            ? target
            : withSpring(target, {
                ...STAGE_SETTLE_SPRING,
                velocity: -e.velocityY / travel,
              });
          scheduleOnRN(commitAnchor, target);
        }),
    [travelPx, theme.reducedMotion, progress, dragStart, anchor, commitAnchor],
  );

  const restCorner = theme.radius.float;
  const animatedStyle = useAnimatedStyle(() => {
    const radius = stageTopRadius(
      progress.value,
      restCorner,
      SHEET_CORNER_RADIUS,
    );
    return {
      // Before the first layout measure lands, keep the sheet parked
      // off-screen rather than flashing a zero-travel frame.
      transform: [
        {
          translateY:
            travelPx.value <= 0
              ? 4000
              : // progress may overshoot 1 while the spring settles — clamp
                // so the sheet never paints past the top edge.
                travelPx.value * (1 - Math.min(1, progress.value)),
        },
      ],
      borderTopLeftRadius: radius,
      borderTopRightRadius: radius,
    };
  });

  const contentStyle = useAnimatedStyle(() => ({
    opacity: stageContentAlpha(progress.value),
  }));

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: stageScrimAlpha(progress.value),
  }));

  // The floating segment clears the home-indicator zone; its footprint
  // (lift + touch block + 3px padding each side + a md gap) is the
  // reserve pinned content keeps clear of — scrollable modes put the
  // same reserve inside their content so rows/lines glide beneath it.
  const segmentLift = bottomInset + theme.spacing.sm;
  const segmentReserve =
    segmentLift + theme.sizes.touch + 6 + theme.spacing.md;

  const immersive = activeMode === 'player' && player.artworkUrl !== null;
  // StageSheet's own inline colors must follow the sheet's surface —
  // children re-resolve via the nested dark provider, but a color read
  // here is bound to the outer (possibly light) scheme.
  const colors = immersive ? schemes.dark : theme.colors;

  // The full-bleed artwork + blur is expensive enough that a parked
  // sheet shouldn't keep it mounted; it mounts the moment the sheet
  // starts rising (a mid-flight drag must never reveal bare surface)
  // and unmounts only once the morph is fully back at the pill — the
  // settle-back path still gets its backdrop.
  const [risenOn, setRisenOn] = useState(expanded);
  // `expanded` mirrored onto the UI thread — the reaction below must
  // read a shared value; a captured ref only snapshots at worklet
  // creation and would pin a sheet mounted-expanded forever. Synced
  // in a layout effect so the write lands inside the same commit as
  // the expanded flip: a passive effect would leave a window where
  // the gate still reads stale and taps leak underneath.
  const expandedShared = useSharedValue(expanded);
  useLayoutEffect(() => {
    expandedShared.value = expanded;
  }, [expanded, expandedShared]);
  useAnimatedReaction(
    () => progress.value > 0.001,
    (risen, prev) => {
      if (risen === prev) return;
      scheduleOnRN(setRisenOn, risen || expandedShared.value);
    },
    [progress],
  );
  // The dismiss surface's touch + a11y gate rides the morph on the
  // UI thread: on native the surface stays mounted and starts
  // intercepting the same frame the sheet lifts off the pill (or the
  // expanded anchor lands) — a state-mounted surface would leave a
  // JS-hop window where a tap slips through to content underneath.
  // RNW writes those non-style animated props as inert DOM
  // attributes: the wrapper's pe:none class is baked at mount and
  // never swaps, and `pointer-events` inherits — RNW Pressable
  // emits no pe class of its own, so the web gate pairs the
  // Pressable's mount (`dismissOn`, which also covers the
  // synchronous expanded flip) with an explicit pointerEvents='auto'
  // that overrides the inherited dead class. On native 'auto' is
  // the default and the wrapper's 'none' still gates the subtree.
  const dismissSurfaceProps = useAnimatedProps(() => {
    const on = progress.value > 0.001 || expandedShared.value;
    return {
      pointerEvents: on ? 'auto' : 'none',
      accessibilityElementsHidden: !on,
      importantForAccessibility: on ? 'auto' : 'no-hide-descendants',
    } as const;
  });
  const dismissOn = risenOn || expanded;

  const body = (
    <>
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
              backgroundColor: colors.fg40,
            }}
          />
        </View>
      </GestureDetector>
      {/* Radio lives top-center on the player surface, under the grab
          handle — a seed affordance or the armed tail's status. */}
      {activeMode === 'player' &&
        radio !== undefined &&
        (radio.armed || onStartRadio !== undefined) && (
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'center',
              marginTop: theme.spacing.sm,
            }}
          >
            {/* Same accent pill as the mode selector's active item —
                accentSoft fill, accent content, pill radius. */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.sm,
                borderRadius: theme.radius.pill,
                backgroundColor: colors.accentSoft,
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.xs,
              }}
            >
              <Icon
                name="radio"
                size={13}
                color={
                  radio.status === 'failed' ? colors.warn : colors.accent
                }
              />
              {radio.armed ? (
                <>
                  <Text
                    variant="metadata"
                    color={radio.status === 'failed' ? 'warn' : 'accent'}
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
                  <Text variant="metadata" color="accent">
                    {t('stage.radio.start')}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
        )}
      {activeMode === 'player' && (
        <>
          {/* Title/artist bottom-anchored in the light-frost zone; the
              timeline/transport cluster stays pinned at the bottom. */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }}
          >
            {player.artworkUrl === null && (
              <View
                style={{
                  // Sized off the measured sheet height so short screens
                  // keep room for the meta/transport cluster below it,
                  // and capped by the padded content width so narrow
                  // screens don't overflow.
                  width: Math.min(
                    Math.max(160, Math.min(360, height * 0.36)),
                    windowWidth - theme.spacing.xl * 2,
                  ),
                  aspectRatio: 1,
                  alignSelf: 'center',
                  marginBottom: theme.spacing.lg,
                }}
              >
                <Artwork url={null} fill />
              </View>
            )}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-end',
                gap: theme.spacing.sm,
                paddingBottom: theme.spacing.lg,
              }}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="display" color="bright" numberOfLines={2}>
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
              {/* Ownership actions hug the right edge of the meta
                  line — download state icon first, then the
                  playlist-picker affordance. */}
              {(download !== null || onAddToPlaylist !== undefined) && (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.xs,
                  }}
                >
                  {download !== null && (
                    <IconButton
                      icon={
                        download === 'stored'
                          ? 'check'
                          : download === 'failed'
                            ? 'warn'
                            : 'download'
                      }
                      size={36}
                      iconSize={15}
                      color={
                        download === 'failed'
                          ? colors.warn
                          : download === 'stored'
                            ? colors.accent
                            : colors.textSecondary
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
                    />
                  )}
                  {onAddToPlaylist !== undefined && (
                    <IconButton
                      icon="list-plus"
                      size={36}
                      iconSize={15}
                      color={colors.textSecondary}
                      accessibilityLabel={t('sheets.addToPlaylist')}
                      onPress={onAddToPlaylist}
                    />
                  )}
                </View>
              )}
            </View>
          </ScrollView>
          <WaveformSeek
            positionMs={player.positionMs}
            durationMs={player.durationMs}
            onSeek={onSeek}
            trackKey={player.occurrenceId}
            seed={`${player.title}|${player.artist ?? ''}`}
            peaks={peaks}
            loading={player.status === 'preparing' || player.durationMs === null}
            visible={expanded}
          />
          <View style={{ marginTop: theme.spacing.md }}>
            <TransportControls
              variant={platform === 'ios' ? 'ios' : 'm3e'}
              status={player.status}
              intentPlaying={player.intentPlaying}
              liked={player.liked}
              canPrevious={player.canPrevious}
              canNext={player.canNext}
              onPlayPause={onPlayPause}
              onPrevious={onPrevious}
              onNext={onNext}
              onToggleLike={onToggleLike}
              shuffle={shuffle}
              onToggleShuffle={onToggleShuffle}
              repeat={repeat}
              onCycleRepeat={onCycleRepeat}
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
            <ScrollView
              style={{ flex: 1, marginTop: theme.spacing.sm }}
              // Lines glide beneath the floating segment; the pad lets
              // the last line scroll fully clear of it.
              contentContainerStyle={{ paddingBottom: segmentReserve }}
            >
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
                      queueReordering ? colors.accent : colors.textSecondary
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
                contentPaddingBottom={segmentReserve}
                onPressItem={onPressQueueItem}
                onRemoveItem={onRemoveQueueItem}
                onMoveItem={onMoveQueueItem}
                onMoveItemTo={onMoveQueueItemTo}
              />
            </>
          )}
        </View>
      )}
      {/* The mode segment floats over the sheet's bottom safe zone —
          it takes no layout space, so lyrics/queue rows and the
          transport never reflow around it or hide beneath it. */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: theme.spacing.xl,
          right: theme.spacing.xl,
          bottom: segmentLift,
        }}
      >
        <ModeSegment
          mode={activeMode}
          onSelect={(m) => {
            setInternalMode(m);
            if (onModeChange !== undefined) {
              onModeChange(m);
            }
          }}
        />
      </View>
    </>
  );

  return (
    <>
      {/* Scrim over whatever the rising sheet hasn't covered yet — same
          role as the CMP deck's scrim: it fades in with progress and is
          tappable to collapse once the sheet is the presented surface. */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.colors.scrim },
          scrimStyle,
        ]}
      />
      {/* Dismiss surface — taps on the uncovered region (or through
          the parked sheet's pointerEvents=none mid-morph) collapse
          the morph instead of leaking to content underneath. The
          wrapper mounts always: on native its gate rides the UI
          thread — a JS-gated ancestor in the hit path would reopen
          the hop — while on web it is inert and the Pressable's own
          mount plus its explicit pointerEvents='auto' (overriding
          the wrapper's inherited dead class) is the gate. */}
      <Animated.View
        animatedProps={dismissSurfaceProps}
        style={StyleSheet.absoluteFill}
      >
        {(dismissOn || Platform.OS !== 'web') && (
          <Pressable
            compact
            onPress={dismissBackdrop}
            accessibilityLabel={t('sheets.closeA11y')}
            pointerEvents="auto"
            style={StyleSheet.absoluteFill}
          />
        )}
      </Animated.View>
      <Animated.View
        onLayout={(e) => {
          setHeight(e.nativeEvent.layout.height);
          travelPx.value = e.nativeEvent.layout.height;
        }}
        pointerEvents={expanded ? 'auto' : 'none'}
        accessibilityViewIsModal={expanded}
        style={[
          {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            overflow: 'hidden',
            backgroundColor: immersive
              ? schemes.dark.stage
              : theme.colors.stage,
          },
          animatedStyle,
          style,
        ]}
      >
        {/* Staged reveal: the surface sweeps up as a tone first, the
            artwork and controls fade in through the pill's fade window
            and are fully present at the input gate. */}
        <Animated.View style={[StyleSheet.absoluteFill, contentStyle]}>
          {immersive && risenOn && (
            <PlayerBackdrop artworkUrl={player.artworkUrl} />
          )}
          {immersive ? (
            <ThemeProvider
              theme="dark"
              textScale={theme.textScale}
              reducedMotion={theme.reducedMotion}
            >
              <View
                style={{
                  flex: 1,
                  paddingHorizontal: theme.spacing.xl,
                  // The player's pinned tail (waveform + transport) can't
                  // scroll beneath the segment, so it reserves the
                  // segment's footprint here; lyrics/queue put it inside
                  // their scroll content instead.
                  paddingBottom:
                    activeMode === 'player' ? segmentReserve : 0,
                }}
              >
                {body}
              </View>
            </ThemeProvider>
          ) : (
            <View
              style={{
                flex: 1,
                paddingHorizontal: theme.spacing.xl,
                paddingBottom:
                  activeMode === 'player' ? segmentReserve : 0,
              }}
            >
              {body}
            </View>
          )}
        </Animated.View>
      </Animated.View>
    </>
  );
}
