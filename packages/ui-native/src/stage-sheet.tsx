import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  PixelRatio,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import Animated, {
  interpolateColor,
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
import { DarkThemeScope, ThemeProvider, useTheme } from './theme.tsx';
import type { Theme } from './theme.tsx';
import {
  Artwork,
  DownloadIconButton,
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
  resolveSheetTarget,
  stageCollapsedAlpha,
  stageContentAlpha,
  stageCoupled,
  stageScrimAlpha,
  stageSheetWrite,
  stageTopRadius,
} from './stage-motion';
import { MiniPlayer } from './mini-player.tsx';
import { WaveformSeek } from './progress.tsx';
import { QueueList } from './queue-list';
import { EmptyState, StateFor } from './states.tsx';
import type {
  LyricsModel,
  PlatformVariant,
  PlayerModel,
  QueueModel,
  RadioModel,
  SkipPeek,
  StageMode,
  WaveformPeak,
} from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';
import {
  downloadButtonView,
  lyricsHeaderView,
  lyricsPaneView,
  queueClearButton,
  queueMetaLabel,
  queueOriginView,
  queueReorderButton,
  radioRowView,
  stageMetaView,
  STAGE_MODE_ORDER,
  stageModeTabs,
  useStageMode,
  useTransportView,
  type StageQueueHandlers,
} from '@auqw/ui-shared/controllers';


// Settle dynamics — the CMP deck's spring (StiffnessLow + no bounce): the
// release keeps the drag's velocity and lands without overshoot.
// damping 30 sits just past critical at stiffness 200 (critical ≈ 28.3
// for mass 1) and overshootClamping pins the value at the anchor, so a
// velocity-carrying release can never dip past the target and read as a
// settle bounce.
const STAGE_SETTLE_SPRING = {
  stiffness: 200,
  damping: 30,
  overshootClamping: true,
} as const;

// Gesture-release settle — OpenTune's BottomSheetAnimationSpec
// (StiffnessMediumLow ≈ 400 at the Compose default dampingRatio 1.0):
// critically damped, so the flick carries into the anchor with zero
// overshoot. damping 40 is the critical point for stiffness 400.
const SHEET_SETTLE_SPRING = {
  stiffness: 400,
  damping: 40,
  overshootClamping: true,
} as const;

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
} {
  if (variant === 'm3e') {
    return {
      side: { borderRadius: theme.radius.card },
      main: { borderRadius: theme.radius.card, backgroundColor: theme.colors.raised },
      play: {
        borderRadius: theme.radius.float,
        backgroundColor: theme.colors.accent,
        width: 56,
        height: 44,
      },
    };
  }
  const glass: ViewStyle = {
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.glass,
    borderWidth: theme.strokes.hairline,
    borderColor: theme.colors.hairline,
  };
  return {
    side: { borderRadius: theme.radius.card },
    main: glass,
    play: { ...glass, borderRadius: theme.radius.float, width: 56, height: 56 },
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
  const view = useTransportView({
    status,
    intentPlaying,
    liked,
    canPrevious,
    canNext,
    shuffle,
    repeat,
    onPlayPause,
    onPrevious,
    onNext,
    onToggleLike,
    onToggleShuffle,
    onCycleRepeat,
  });
  const c = theme.colors;
  const accent = (on?: boolean) => (on ? c.accent : c.textSecondary);
  const button = (
    b: {
      readonly icon: IconName;
      readonly a11yLabel: string;
      readonly onPress: (() => void) | undefined;
      readonly disabled?: boolean | undefined;
      readonly active?: boolean | undefined;
    },
    color: string,
    main = false,
  ) => (
    <IconButton
      icon={b.icon}
      size={main ? 36 : 32}
      iconSize={main ? 15 : 14}
      color={color}
      accessibilityLabel={b.a11yLabel}
      disabled={b.disabled}
      active={b.active}
      onPress={b.onPress}
      style={main ? v.main : v.side}
    />
  );
  const playColor = variant === 'm3e' ? c.canvas : c.textBright;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.xs + theme.spacing.xxs,
      }}
    >
      {button(view.like, view.like.liked ? c.liked : c.textSecondary)}
      {button(view.previous, c.textPrimary, true)}
      <Pressable
        compact
        onPress={view.play.onPress}
        accessibilityLabel={view.play.a11yLabel}
        accessibilityState={{ selected: view.play.pressed }}
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
        {view.busy ? (
          <Spinner size={18} color={playColor} />
        ) : (
          <PlayPauseIcon playing={view.playing} size={18} color={playColor} />
        )}
      </Pressable>
      {button(view.next, c.textPrimary, true)}
      {button(view.repeat, accent(view.repeat.active))}
    </View>
  );
}

export function ModeSegment({
  mode,
  onSelect,
}: {
  readonly mode: StageMode;
  readonly onSelect?: ((mode: StageMode) => void) | undefined;
}) {
  const outer = useTheme();
  // The floating segment is dark in every scheme — it overlays artwork
  // or a flat stage, where the outer scheme's fg08 pill would wash out
  // grey-on-grey. The nested provider re-scopes colors so labels and
  // icons keep their role names.
  return (
    <ThemeProvider
      theme="dark"
      textScale={outer.textScale}
      reducedMotion={outer.reducedMotion}
    >
      <ModeSegmentPill mode={mode} onSelect={onSelect} />
    </ThemeProvider>
  );
}

function ModeSegmentPill({
  mode,
  onSelect,
}: {
  readonly mode: StageMode;
  readonly onSelect?: ((mode: StageMode) => void) | undefined;
}) {
  const theme = useTheme();
  const tabs = stageModeTabs(STAGE_MODE_ORDER, mode, onSelect);
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: theme.spacing.xxs,
        backgroundColor: theme.colors.raised,
        /* 3px pad is deliberate (web parity): 44 + 2×3 + 2×hairline
           lands the float at the 52px chrome height — the mini
           player's. Don't pull it onto the spacing scale. */
        padding: 3,
        borderRadius: theme.radius.float,
        borderWidth: theme.strokes.hairline,
        borderColor: theme.colors.hairline,
        shadowColor: theme.colors.scrim,
        shadowOpacity: 1,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 6 },
        elevation: 8,
      }}
    >
      {tabs.map((tab) => {
        // M3E segmented-button: the selected segment reads as a tonal
        // (secondary-container) pill; iOS keeps the glass slab.
        // The pill silhouette matches the rounded transport controls —
        // only the fill differs per platform (tonal on Android, glass
        // on iOS).
        const m3e = Platform.OS === 'android';
        const activeBg = m3e
          ? theme.colors.accentSoft
          : theme.colors.glassControl;
        const activeColor = m3e ? theme.colors.accent : theme.colors.textBright;
        return (
          <Pressable
            key={tab.key}
            compact
            onPress={tab.onPress}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: tab.active }}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              minHeight: theme.sizes.touch,
              borderRadius: theme.radius.card,
              backgroundColor: tab.active ? activeBg : 'transparent',
            }}
          >
            <Icon
              name={tab.icon}
              size={12}
              color={tab.active ? activeColor : theme.colors.textSecondary}
            />
            <Text
              variant="metadata"
              color={tab.active ? (m3e ? 'accent' : 'bright') : 'secondary'}
              style={[
                tab.active && { fontFamily: theme.fontFamilies.bold },
              ]}
            >
              {tab.label}
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
  // Screen-width pixels are plenty for the sharp layer — the provider's
  // multi-MP file only costs radio + decode.
  const { width: windowWidth } = useWindowDimensions();
  const { uri, pending, markSourceError } = useResolvedArtworkUri(
    artworkUrl,
    Math.ceil(windowWidth * PixelRatio.get()),
  );
  const theme = useTheme();
  const haveArt = !pending && uri !== null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {!haveArt && (
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
      )}
      {/*
       * Frost composition on native: the blurred copy is the UNDER
       * layer (blurRadius bakes the blur once at image decode — off
       * the render thread — instead of a software SVG filter pass at
       * mount), and the sharp copy sits above masked to fade out
       * exactly where the frost zone begins. Same visual as the
       * web path below, reversed: web has no blurRadius, so there the
       * mask reveals a filtered SvgImage over the sharp Image.
       */}
      {Platform.OS === 'web' ? (
        <>
          {haveArt && (
            <Image
              source={{ uri }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              onError={markSourceError}
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
            {haveArt && (
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
        </>
      ) : (
        <>
          {haveArt && (
            <Image
              source={{ uri }}
              blurRadius={36}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              onError={markSourceError}
              accessibilityIgnoresInvertColors
            />
          )}
          <Svg style={StyleSheet.absoluteFill}>
            <Defs>
              <LinearGradient id="uwfp-scrim" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={NIGHT} stopOpacity="0.30" />
                <Stop offset="1" stopColor={NIGHT} stopOpacity="0.82" />
              </LinearGradient>
              {/* Sharp zone: the inverse of the frost ramp — opaque
                  until the frost zone, fading out where the blurred
                  under-layer takes over, gone by the transport row. */}
              <LinearGradient id="uwfp-sharp-reveal" x1="0" y1="0" x2="0" y2="1">
                <Stop offset={FROST_TOP_FRACTION} stopColor={MASK_LIGHT} stopOpacity="1" />
                <Stop offset="0.72" stopColor={MASK_LIGHT} stopOpacity="0.45" />
                <Stop offset="0.9" stopColor={MASK_LIGHT} stopOpacity="0" />
              </LinearGradient>
              <Mask
                id="uwfp-sharp"
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
                  fill="url(#uwfp-sharp-reveal)"
                />
              </Mask>
            </Defs>
            {haveArt && (
              <G mask="#uwfp-sharp">
                <SvgImage
                  href={uri}
                  x="0"
                  y="0"
                  width="100%"
                  height="100%"
                  preserveAspectRatio="xMidYMid slice"
                />
              </G>
            )}
            <Rect x="0" y="0" width="100%" height="100%" fill="url(#uwfp-scrim)" />
          </Svg>
        </>
      )}
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
  /** Shared pixel travel for the morph — the sheet publishes the
      distance from its top edge to the collapsed pill's top edge here
      so the pill's drag converts finger pixels to progress over the
      same distance the surface translates. Standalone hosts omit it
      and the sheet measures itself. */
  readonly travel?: SharedValue<number> | undefined;
  /** Shared settle-target flag (-1 = idle, else 0/1): whichever
      gesture's release committed this anchor already launched its own
      velocity-carrying spring, so the `expanded`-flip effect must not
      restart the settle cold. Standalone hosts omit it. */
  readonly anchor?: SharedValue<number> | undefined;
  /** Shared 0..1 dismiss slide — drags below the rest anchor write it,
      the whole surface slides offscreen and fades on it (OpenTune's
      dismissed bound below the collapsed one). Standalone hosts omit
      it and the sheet parks at the collapsed anchor. */
  readonly gone?: SharedValue<number> | undefined;
  /** Shared pixel height of the rest strip the collapsed surface parks
      on — pill height + its gap above the tab bar + the tab bar itself
      (OpenTune's `collapsedBound`). The host measures it; standalone
      hosts omit it and the pill floats its own height + gap off the
      bottom edge. */
  readonly collapsedHeight?: SharedValue<number> | undefined;
  /** Sideswipe conveyor peeks for the embedded pill row (the same
      contract MiniPlayer documents — null = dead edge). */
  readonly skipNext?: SkipPeek | null | undefined;
  readonly skipPrevious?: SkipPeek | null | undefined;
  readonly nextEndsQueue?: boolean | undefined;
  /** Swipe-down dismiss on the collapsed surface — the pill's
      slide-off settles, then this fires (the host stops playback). */
  readonly onDismiss?: (() => void) | undefined;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  readonly download?: import('@auqw/ui-shared').DownloadChip | null | undefined;
  readonly onDownload?: (() => void) | undefined;
  readonly onAddToPlaylist?: (() => void) | undefined;
  /** Opens the playing track's row-actions menu (the top-row ⋯). */
  readonly onTrackMenu?: (() => void) | undefined;
  /**
   * Provider-wall recovery affordance — fires when the user taps the
   * 'sign in to fix playback' CTA (`player.recovery === 'sign-in'`).
   * The shell binds it to the auth sheet opener; omitted renders the
   * plain error line exactly as before.
   */
  readonly onRecovery?: (() => void) | undefined;
  readonly shuffle?: boolean | undefined;
  readonly onToggleShuffle?: (() => void) | undefined;
  readonly repeat?: 'off' | 'all' | 'one' | undefined;
  readonly onCycleRepeat?: (() => void) | undefined;
  readonly onSeek?:
    | ((ms: number, expectedOccurrenceId?: string) => void)
    | undefined;
  /**
   * Real measured waveform peaks (canonical `PEAKS_RESOLUTION`
   * pairs) for the Stage seek — Android extractor output normalized
   * JS-side. Absent/null keeps the flat placeholder, which is also
   * the pending and failure fallback.
   */
  readonly peaks?: readonly WaveformPeak[] | null | undefined;
  readonly onRetryLyrics?: (() => void) | undefined;
  readonly onStartRadio?: (() => void) | undefined;
  readonly onStopRadio?: (() => void) | undefined;
  readonly onModeChange?: ((mode: StageMode) => void) | undefined;
  /** The pane the sheet must rest on once parked — a stale `mode` is
      normalized to it through `onModeChange` only after the surface
      reads fully collapsed, so the next rise paints the pane it lands
      on and the descending pane is never swapped mid-fade. Omitted
      leaves the parked mode untouched (standalone hosts). */
  readonly restMode?: StageMode | undefined;
  readonly onPressQueueItem?: ((occurrenceId: string) => void) | undefined;
  /** Advisory row intent — touch-down on a row; the host warms it. */
  readonly onQueueRowIntent?: ((occurrenceId: string) => void) | undefined;
  /** Advisory viewport report — occurrence ids on screen; the host
      warms the set as a wholesale hand. */
  readonly onQueueViewport?:
  | ((occurrenceIds: readonly string[]) => void)
  | undefined;
  readonly onRemoveQueueItem?: ((occurrenceId: string) => void) | undefined;
  readonly onClearQueue?: (() => void) | undefined;
  readonly onOpenQueueContext?: StageQueueHandlers['onOpenQueueContext'];
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
  gone: goneProp,
  collapsedHeight: collapsedHeightProp,
  skipNext,
  skipPrevious,
  nextEndsQueue,
  onDismiss,
  onPlayPause,
  onNext,
  onPrevious,
  onToggleLike,
  download = null,
  onDownload,
  onAddToPlaylist,
  onTrackMenu,
  onRecovery,
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
  restMode,
  onPressQueueItem,
  onQueueRowIntent,
  onQueueViewport,
  onRemoveQueueItem,
  onClearQueue,
  onOpenQueueContext,
  onToggleQueueReorder,
  onMoveQueueItem,
  onMoveQueueItemTo,
  style,
}: StageSheetProps) {
  const theme = useTheme();
  const { width: windowWidth, height: windowHeight, fontScale } =
    useWindowDimensions();
  // Row frames move on width and font scale; the scroll viewport's
  // own frame moves on width and height. Tracked separately so a
  // height-only change can't strand row measurements, and a stale
  // viewport height can't settle the owed scroll.
  const lyricRowGeom = `${windowWidth}:${fontScale}`;
  const lyricViewGeom = `${windowWidth}x${windowHeight}`;
  const [height, setHeight] = useState(0);
  const internalProgress = useSharedValue(expanded ? 1 : 0);
  // One progress drives the morph: the pill's rise drag writes it from
  // the UI thread, `expanded` flips only on commit.
  const progress = progressProp ?? internalProgress;
  const internalTravel = useSharedValue(0);
  // The morph's pixel travel is the distance from the sheet's top edge
  // to the collapsed pill's top edge (sheet height minus the rest
  // strip); the pill divides finger pixels by this same value so the
  // rise is 1:1.
  const travelPx = travelProp ?? internalTravel;
  const internalAnchor = useSharedValue(-1);
  const anchor = anchorProp ?? internalAnchor;
  // The dismissed slide — 0 = at the collapsed anchor, 1 = fully below
  // the host's bottom edge. The same gesture axis as `progress`:
  // OpenTune's single `value` split at the collapsed bound so each half
  // keeps its own unit interval.
  const internalGone = useSharedValue(0);
  const gone = goneProp ?? internalGone;
  // Pixels from the sheet's bottom edge up to the pill's top edge at
  // rest (OpenTune's collapsedBound). Standalone hosts get the pill's
  // own footprint — it floats one gap off the bottom edge.
  const internalCollapsed = useSharedValue(
    theme.sizes.miniPlayer + theme.spacing.md,
  );
  const collapsedPx = collapsedHeightProp ?? internalCollapsed;
  // Measured sheet height as a shared value — gesture worklets read it
  // for the dismiss strip without capturing a stale JS number.
  const sheetH = useSharedValue(0);
  // Each detector snapshots its own drag start — the recognizers
  // mount concurrently (grab strip plus each kept-alive pane's
  // chrome), and a shared baseline would let a second finger's
  // onBegin rewrite the first gesture's start mid-drag.
  const grabDragStart = useSharedValue(0);
  const lyricsChromeDragStart = useSharedValue(0);
  const queueChromeDragStart = useSharedValue(0);
  const playerPaneDragStart = useSharedValue(0);
  // True only when the player pane's content actually overflows its
  // viewport — a scrollable pane keeps its scroll gesture, a fitting
  // one (the common case) is drag chrome for dismiss.
  const [playerCanScroll, setPlayerCanScroll] = useState(false);
  const playerPaneSize = useRef({ viewport: 0, content: 0 });
  const measurePlayerPane = useCallback(() => {
    const { viewport, content } = playerPaneSize.current;
    setPlayerCanScroll(viewport > 0 && content > viewport + 1);
  }, []);
  const { activeMode, select: selectMode } = useStageMode(
    mode,
    onModeChange,
    expanded,
  );
  // All three panes stay mounted — display:none keeps scroll position
  // and fetched state, so a mode switch never remounts a list. The
  // a11y pair keeps a hidden pane unreachable to screen readers.
  const paneProps = (
    m: StageMode,
  ): {
    readonly accessibilityElementsHidden: boolean;
    readonly importantForAccessibility: 'auto' | 'no-hide-descendants';
    readonly style: StyleProp<ViewStyle>;
  } => ({
    accessibilityElementsHidden: activeMode !== m,
    importantForAccessibility:
      activeMode === m ? 'auto' : 'no-hide-descendants',
    style: [{ flex: 1 }, activeMode !== m && { display: 'none' }],
  });
  const meta = stageMetaView(player);
  const lyricsHeader = lyricsHeaderView(player, lyrics);
  const lyricsPane = useMemo(
    () => lyricsPaneView(lyrics, onRetryLyrics),
    [lyrics, onRetryLyrics],
  );
  const radioRow = radioRowView(radio, onStartRadio, onStopRadio);
  const queueReorder = queueReorderButton(
    queueReordering,
    onToggleQueueReorder,
  );
  const queueClear = queueClearButton(
    queue?.items.length ?? 0,
    queue?.currentOccurrenceId != null,
    onClearQueue,
  );
  const queueOrigin = queueOriginView(
    queue?.origin ?? null,
    onOpenQueueContext,
  );
  const queueMeta = queue === undefined ? null : queueMetaLabel(queue);
  const downloadButton =
    download === null ? null : downloadButtonView(download, onDownload);

  // The parent re-renders on every position tick and passes fresh
  // inline closures — a deps-listed callback would rebuild the pan
  // (canceling the in-flight drag), so the gesture commits through a
  // ref instead.
  const onExpandChangeRef = useRef(onExpandChange);
  useEffect(() => {
    onExpandChangeRef.current = onExpandChange;
  }, [onExpandChange]);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);
  const emitDismiss = useCallback(() => {
    onDismissRef.current?.();
  }, []);

  // The travel is derived, not measured directly: sheet height minus
  // the rest strip. A tab-bar hide/show rewrites the strip mid-flight
  // and the pill's rest anchor follows in the same frame.
  useAnimatedReaction(
    () => collapsedPx.value,
    (strip) => {
      if (sheetH.value > 0) {
        travelPx.value = Math.max(0, sheetH.value - strip);
      }
    },
    [collapsedPx],
  );

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
    if (target === 0 && gone.value > 0) {
      // An external close outruns an in-flight dismiss unwind —
      // landing `gone` now makes its completion callback a no-op
      // instead of a delayed reopen.
      gone.value = theme.reducedMotion
        ? 0
        : withSpring(0, STAGE_SETTLE_SPRING);
    }
  }, [expanded, theme.reducedMotion, progress, anchor, gone]);

  // Gallery-only preview states — production never passes dragPreview,
  // and this must not run for ordinary `expanded` flips or it would
  // stomp the settle spring the expand effect just started.
  useEffect(() => {
    if (dragPreview === undefined) return;
    progress.value =
      dragPreview === 'rest'
        ? expanded
          ? 1
          : 0
        : dragPreview === 'mid-drag'
          ? 0.75
          : 0;
    gone.value = dragPreview === 'dismissed' ? 1 : 0;
  }, [dragPreview, expanded, progress, gone]);

  const commitAnchor = useCallback(
    (target: number) => {
      // Gesture commits are queued to JS — a hardware back (or a newer
      // gesture) that moved the anchor in between must cancel them,
      // not let the stale callback reopen the sheet.
      if (anchor.value !== target) {
        return;
      }
      onExpandChangeRef.current?.(target === 1);
    },
    [anchor],
  );

  // Tap on the uncovered region dismisses — including mid-morph, where
  // `expanded` is still false and the state flip alone wouldn't move
  // the spring.
  const dismissBackdrop = useCallback(() => {
    progress.value = theme.reducedMotion
      ? 0
      : withSpring(0, STAGE_SETTLE_SPRING);
    gone.value = theme.reducedMotion ? 0 : withSpring(0, STAGE_SETTLE_SPRING);
    onExpandChangeRef.current?.(false);
  }, [progress, gone, theme.reducedMotion]);

  // The gesture factory is stable across renders — a fresh Pan() per
  // render would cancel an in-flight sheet drag on the next tick. Each
  // detector needs its own instance (a gesture object attaches to a
  // single detector), and kept-alive panes mount their chrome
  // detectors concurrently — so the grab strip and each pane's
  // non-scrollable chrome get dedicated recognizers: the dismiss drag
  // works from any mode while the scrollable lists keep their own
  // scroll gesture.
  //
  // All of them drive one continuous pixel axis (OpenTune's single
  // `value`): px above the rest anchor maps to `progress`, px below it
  // maps to `gone`, and a drag can cross the collapsed→dismissed
  // boundary mid-flight without re-anchoring.
  const makeSheetPan = useCallback(
    (start: SharedValue<number>) =>
      Gesture.Pan()
        .activeOffsetY(8)
        // Horizontal drift past ±16px fails the recognizer — the
        // cancelled finalize must not commit an anchor (see below).
        .failOffsetX([-16, 16])
        .onBegin(() => {
          const collapsed = Math.max(1, sheetH.value - travelPx.value);
          start.value =
            progress.value * travelPx.value - gone.value * collapsed;
        })
        .onUpdate((e) => {
          const write = stageSheetWrite(
            start.value - e.translationY,
            Math.max(1, travelPx.value),
            Math.max(1, sheetH.value - travelPx.value),
          );
          progress.value = write.progress;
          gone.value = write.gone;
        })
        .onFinalize((e, success) => {
          const travel = Math.max(1, travelPx.value);
          const collapsed = Math.max(1, sheetH.value - travel);
          const springTo = (
            target: number,
            velocity: number,
            finished?: (ok: boolean | undefined) => void,
          ) => {
            if (theme.reducedMotion) {
              finished?.(true);
              return target;
            }
            return withSpring(
              target,
              {
                ...SHEET_SETTLE_SPRING,
                velocity,
              },
              finished,
            );
          };
          if (!success) {
            // RNGH fires onFinalize on END *and* on FAIL/CANCELLED —
            // a failed recognizer (failOffsetX drift, OS gesture
            // steal) must not commit the anchor it never earned:
            // spring back onto the sheet's current anchor only.
            if (gone.value > 0) {
              gone.value = springTo(
                0,
                e.velocityY / collapsed,
                (ok) => {
                  if (ok === true && expanded) {
                    progress.value = springTo(
                      1,
                      -e.velocityY / travel,
                    );
                  }
                },
              );
            } else {
              progress.value = springTo(
                expanded ? 1 : 0,
                -e.velocityY / travel,
              );
            }
            return;
          }
          const raw =
            progress.value * travel - gone.value * collapsed;
          const target = resolveSheetTarget(
            raw,
            travel,
            collapsed,
            e.velocityY,
          );
          if (target === 'dismissed') {
            anchor.value = 0;
            progress.value = 0;
            if (expanded) {
              scheduleOnRN(commitAnchor, 0);
            }
            // The slide-off lands before the host tears down — the
            // emit fires on the spring's completion so the surface
            // visibly leaves instead of vanishing mid-travel.
            if (theme.reducedMotion) {
              gone.value = 1;
              scheduleOnRN(emitDismiss);
            } else {
              gone.value = withSpring(
                1,
                {
                  ...SHEET_SETTLE_SPRING,
                  velocity: e.velocityY / collapsed,
                },
                (finished) => {
                  if (finished === true) {
                    scheduleOnRN(emitDismiss);
                  }
                },
              );
            }
            return;
          }
          const num = target === 'expanded' ? 1 : 0;
          // Mark the settle as gesture-owned so the `expanded` flip the
          // commit schedules doesn't cold-restart this spring.
          anchor.value = num;
          if (gone.value > 0) {
            // A dismiss slide unwinds home on `gone` before the sheet
            // expands — both axes ride the same visible offset, so two
            // velocity-bearing springs would double the release speed.
            gone.value = springTo(
              0,
              e.velocityY / collapsed,
              (ok) => {
                // A hardware back or a newer collapse commit clears
                // the anchor to 0 during the unwind; reopening without
                // that check would morph the leaf over navigated-away
                // content. (1 = still pending, -1 = already consumed
                // by the expanded effect — only 0 means cancelled.)
                if (
                  ok === true &&
                  num === 1 &&
                  (expanded || anchor.value !== 0)
                ) {
                  progress.value = springTo(1, -e.velocityY / travel);
                  if (!expanded) {
                    scheduleOnRN(commitAnchor, 1);
                  }
                }
              },
            );
            if (num === 0 && expanded) {
              scheduleOnRN(commitAnchor, 0);
            }
          } else {
            progress.value = springTo(num, -e.velocityY / travel);
            // A settle that lands on the anchor we're already on is a
            // no-op for the host — committing it would fire a spurious
            // expanded flip (the App wrapper maps every commit to
            // player mode, stomping queue/lyrics).
            if (num !== (expanded ? 1 : 0)) {
              scheduleOnRN(commitAnchor, num);
            }
          }
        }),
    [
      travelPx,
      sheetH,
      gone,
      theme.reducedMotion,
      progress,
      anchor,
      commitAnchor,
      emitDismiss,
      expanded,
    ],
  );
  const pan = useMemo(
    () => makeSheetPan(grabDragStart),
    [makeSheetPan, grabDragStart],
  );
  const lyricsChromePan = useMemo(
    () => makeSheetPan(lyricsChromeDragStart),
    [makeSheetPan, lyricsChromeDragStart],
  );
  const queueChromePan = useMemo(
    () => makeSheetPan(queueChromeDragStart),
    [makeSheetPan, queueChromeDragStart],
  );
  // Drag-down-to-dismiss anywhere on the player pane — enabled only
  // while the pane's content fits (no scroll to steal), and the
  // failOffsetX inside makeSheetPan keeps horizontal waveform
  // scrubs on the seek pan.
  const playerPanePan = useMemo(
    () => makeSheetPan(playerPaneDragStart).enabled(!playerCanScroll),
    [makeSheetPan, playerPaneDragStart, playerCanScroll],
  );

  // One offset for the whole vertical axis — OpenTune BottomSheet's
  // `expandedBound - value`: rest parks the surface's top edge on the
  // pill (`travel` px), expansion carries it to 0, and `gone` slides it
  // below rest into dismissal. Transform only — never a layout pass.
  const animatedStyle = useAnimatedStyle(() => {
    const travel = travelPx.value;
    if (travel <= 0) {
      // Before the first layout measure lands, keep the sheet parked
      // off-screen rather than flashing a zero-travel frame.
      return { transform: [{ translateY: 4000 }] };
    }
    const collapsed = Math.max(0, sheetH.value - travel);
    // progress may overshoot 1 while the spring settles — clamp so the
    // sheet never paints past the top edge.
    const p = Math.min(1, progress.value);
    const g = Math.min(1, Math.max(0, gone.value));
    return {
      transform: [
        { translateY: travel * (1 - p) + g * collapsed },
      ],
    };
  });

  const restCorner = theme.radius.float;
  const pillHeight = theme.sizes.miniPlayer;
  const pillGap = theme.spacing.md;
  const iosSurface = platform === 'ios';

  // The reveal rides progress twice — fade and a 4% grow — so the
  // expanded surface settles into place instead of just brightening.
  // Top corners match the leaf's live radius so revealed content clips
  // to the card's rounded edge instead of painting past it.
  const contentStyle = useAnimatedStyle(() => {
    const p = Math.min(1, Math.max(0, progress.value));
    const radius = stageTopRadius(
      progress.value,
      restCorner,
      SHEET_CORNER_RADIUS,
    );
    return {
      opacity: stageContentAlpha(progress.value),
      transform: [{ scale: 0.96 + 0.04 * p }],
      borderTopLeftRadius: radius,
      borderTopRightRadius: radius,
    };
  });

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: stageScrimAlpha(progress.value),
  }));

  // The floating segment clears the home-indicator zone; its footprint
  // (lift + touch block + the pill's padding/border + a lg gap) is the
  // reserve pinned content keeps clear of — scrollable modes put the
  // same reserve inside their content so rows/lines glide beneath it.
  const segmentLift = bottomInset + theme.spacing.sm;
  const segmentReserve =
    segmentLift + theme.sizes.touch + 8 + theme.spacing.lg;

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
    // `expandedShared` is a tracked input, not just a fire-time read:
    // a drag that parks the surface at progress 0 while still expanded
    // keeps `risen` true through the release's `expanded` flip — only
    // this second input firing parks the reaction for real.
    () => progress.value > 0.001 || expandedShared.value,
    (risen, prev) => {
      if (risen === prev) return;
      scheduleOnRN(setRisenOn, risen);
    },
    [progress, expandedShared],
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

  // Parked normalization: a stale mode retires only once the surface
  // reads collapsed — flipping at the close commit would swap the
  // still-descending pane mid-fade; waiting for the open commit would
  // flash it through the whole next rise. `restMode` tracks live while
  // parked (a playback flip under a parked sheet still renames the
  // landing pane before the next drag).
  useEffect(() => {
    if (
      !risenOn &&
      !expanded &&
      restMode !== undefined &&
      mode !== undefined &&
      mode !== restMode
    ) {
      onModeChange?.(restMode);
    }
  }, [risenOn, expanded, mode, restMode, onModeChange]);

  // The backdrop's warm-up bound: mount it once the sheet has ever
  // risen so the artwork resolver and full-size decode only run for
  // a listener who actually opens the player — a queue that never
  // expands never pays the fetch per track. `risenOn` mounts it in
  // the same commit the first rise renders in (a passive-effect latch
  // alone would leave that rising sheet bare for a frame);
  // `backdropWarm` then keeps it mounted across collapses and track
  // changes, so a mid-drag morph never pays a resolver remount.
  const [backdropWarm, setBackdropWarm] = useState(risenOn);
  useEffect(() => {
    if (risenOn) {
      setBackdropWarm(true);
    }
  }, [risenOn]);
  const backdropOn = risenOn || backdropWarm;

  // The morphing surface: a single card whose collapsed geometry IS the
  // pill — its side insets, bottom inset, corner radii, background and
  // hairline all interpolate over the coupled phase on the same
  // progress value the translation rides. The only layout-animating
  // element is this leaf, so a drag frame is a leaf relayout, not a
  // content reflow.
  const leafStartColor = iosSurface
    ? theme.colors.glass
    : theme.colors.raised;
  const leafStyle = useAnimatedStyle(() => {
    const c = stageCoupled(progress.value);
    const g = Math.min(1, Math.max(0, gone.value));
    const h = Math.max(pillHeight, sheetH.value);
    const radius = stageTopRadius(
      progress.value,
      restCorner,
      SHEET_CORNER_RADIUS,
    );
    const end = immersive ? schemes.dark.stage : theme.colors.stage;
    return {
      left: pillGap * (1 - c),
      right: pillGap * (1 - c),
      bottom: (h - pillHeight) * (1 - c),
      borderTopLeftRadius: radius,
      borderTopRightRadius: radius,
      borderBottomLeftRadius: restCorner * (1 - c),
      borderBottomRightRadius: restCorner * (1 - c),
      backgroundColor: interpolateColor(c, [0, 1], [leafStartColor, end]),
      borderColor: interpolateColor(
        c,
        [0, 1],
        [theme.colors.hairline, end],
      ),
      // The dismiss slide takes the whole surface down and eases it
      // out — it leaves fully via the translation; the fade just keeps
      // it from lingering at the edge.
      opacity: 1 - g * 0.75,
    };
  });

  // The iOS glass fills the leaf while it reads as the pill and fades
  // out over the coupled phase as the surface becomes the opaque stage.
  const glassStyle = useAnimatedStyle(() => ({
    opacity: 1 - stageCoupled(progress.value),
  }));

  // The collapsed row rides the leaf's top edge: it fades out inside
  // the same window the old standalone pill used, and its touch/a11y
  // gate follows visibility — once it reads gone it never intercepts.
  const rowStyle = useAnimatedStyle(() => ({
    opacity: stageCollapsedAlpha(progress.value),
  }));
  const rowGateProps = useAnimatedProps(() => {
    const on =
      !expandedShared.value &&
      stageCollapsedAlpha(progress.value) > 0.001 &&
      gone.value < 0.5;
    return {
      pointerEvents: on ? 'auto' : 'none',
      accessibilityElementsHidden: !on,
      importantForAccessibility: on ? 'auto' : 'no-hide-descendants',
    } as const;
  });

  // The expanded content's input gate rides the morph on the UI
  // thread — it opens exactly where the reveal completes (progress >
  // 0.5 is STAGE_CONTENT_GATE) and closes the moment the sheet drops
  // back under it, so a mid-drag pane never eats a stray tap.
  const contentGateProps = useAnimatedProps(() => {
    const on = expandedShared.value || progress.value > 0.5;
    return { pointerEvents: on ? 'auto' : 'none' } as const;
  });

  // Tap-to-seek on the waveform: the scrub pan only ever activates on
  // movement, so a plain tap resolves x→ms through the same commit
  // path. Callbacks live behind a ref — a deps-listed prop would
  // rebuild the gesture on every position-tick re-render. The tap's
  // occurrence is captured on the UI thread at touch-down and checked
  // again at commit — a track flip between the two must not seek the
  // replacement track at the old tap's position.
  const seekTapMeta = useRef({
    width: 0,
    durationMs: player.durationMs,
    occurrenceId: player.occurrenceId,
    onSeek,
  });
  const seekTapOccurrence = useSharedValue(player.occurrenceId);
  const seekTapAtOccurrence = useSharedValue<string | null>(null);
  useEffect(() => {
    seekTapMeta.current.onSeek = onSeek;
    seekTapMeta.current.durationMs = player.durationMs;
    seekTapMeta.current.occurrenceId = player.occurrenceId;
    seekTapOccurrence.value = player.occurrenceId;
  });
  const commitSeekTap = useCallback((x: number, tappedOccurrence: string | null) => {
    const {
      width,
      durationMs,
      occurrenceId,
      onSeek: seek,
    } = seekTapMeta.current;
    if (
      seek === undefined ||
      durationMs === null ||
      durationMs <= 0 ||
      width <= 0 ||
      tappedOccurrence !== occurrenceId
    ) {
      return;
    }
    // The captured occurrence rides to the session too — the meta
    // compare covers flips React already rendered; the session
    // guard covers the sub-frame window before the effect ran.
    seek(
      Math.round(Math.min(1, Math.max(0, x / width)) * durationMs),
      tappedOccurrence ?? undefined,
    );
  }, []);
  const seekTap = useMemo(
    () =>
      Gesture.Tap()
        .onBegin(() => {
          // onBegin = touch-down (the tap's BEGIN state); onStart
          // would only run at activation on release, letting a
          // mid-hold track flip feed the replacement occurrence to
          // both sides of the comparison.
          seekTapAtOccurrence.value = seekTapOccurrence.value;
        })
        .onEnd((e, success) => {
          if (success) {
            scheduleOnRN(commitSeekTap, e.x, seekTapAtOccurrence.value);
          }
        }),
    [commitSeekTap, seekTapAtOccurrence, seekTapOccurrence],
  );

  // Lyrics auto-scroll — the synced active line stays in view. A
  // scroll is owed whenever (occurrence, activeIndex) differs from the
  // pair last scrolled to: a song swap with an unchanged index still
  // owes one, and a line change settles it. Between those, a manual
  // scroll is never yanked back.
  const lyricsScrollRef = useRef<ScrollView>(null);
  const lyricsScrollH = useRef(0);
  const lyricLayouts = useRef<({ y: number; height: number } | undefined)[]>(
    [],
  );
  const lyricScrolledKey = useRef<string | null>(null);
  // The row geometry the stored lyric measurements belong to —
  // invalidated on re-entry when width/font-scale moved while
  // hidden. The scroller stamps its own viewport geometry so a
  // scroll only settles against a height measured for the current
  // window.
  const lyricMeasuredGeom = useRef<string | null>(null);
  const lyricViewMeasuredGeom = useRef<string | null>(null);
  // Layouts live in refs — a counter re-runs the owed-scroll effect
  // when the active row or the scroller itself first measures in.
  const [lyricLayoutTick, bumpLyricLayout] = useState(0);
  const lyricActiveIndex =
    lyricsPane.kind === 'lines' ? lyricsPane.activeIndex : null;
  const lyricScrollKey =
    lyricActiveIndex === null
      ? null
      : `${player.occurrenceId ?? ''}:${lyricActiveIndex}`;
  // A song swap re-measures every line — the previous song's y offsets
  // would otherwise satisfy the owed scroll at stale positions.
  const lyricOccurrenceRef = useRef(player.occurrenceId);
  if (lyricOccurrenceRef.current !== player.occurrenceId) {
    lyricOccurrenceRef.current = player.occurrenceId;
    lyricLayouts.current = [];
  }
  const scrollToLyricLine = useCallback(
    (index: number) => {
      const line = lyricLayouts.current[index];
      // A zero scroller height means its own layout has not landed —
      // scrollTo against uncommitted content clamps and loses, so
      // the owed key must stay unsettled rather than mark a miss.
      if (
        line === undefined ||
        lyricsScrollH.current <= 0 ||
        lyricViewMeasuredGeom.current !== lyricViewGeom
      ) {
        return false;
      }
      lyricsScrollRef.current?.scrollTo({
        y: Math.max(0, line.y + line.height / 2 - lyricsScrollH.current / 2),
        animated: !theme.reducedMotion,
      });
      return true;
    },
    [theme.reducedMotion, lyricViewGeom],
  );
  useEffect(() => {
    if (
      activeMode === 'lyrics' &&
      lyricMeasuredGeom.current !== lyricRowGeom
    ) {
      // The pane was hidden while row geometry moved — mounted
      // rows still hold pre-change frames until the next layout
      // pass refires them, so their stored offsets must not
      // settle the owed scroll.
      lyricMeasuredGeom.current = lyricRowGeom;
      lyricLayouts.current = [];
    }
    if (lyricScrollKey === null || activeMode !== 'lyrics') {
      // Re-entry owes the active line a scroll — the kept-alive
      // measurements are still valid (mounted rows only refire
      // onLayout when geometry actually changes), so only the owed
      // key resets.
      lyricScrolledKey.current = null;
      return;
    }
    if (
      lyricScrolledKey.current !== lyricScrollKey &&
      lyricActiveIndex !== null &&
      scrollToLyricLine(lyricActiveIndex)
    ) {
      lyricScrolledKey.current = lyricScrollKey;
    }
  }, [
    activeMode,
    lyricActiveIndex,
    lyricScrollKey,
    scrollToLyricLine,
    lyricLayoutTick,
    lyricRowGeom,
  ]);

  // The lyrics-mode header rides the pane chrome — the same element
  // sits above the lines list or the state block.
  const lyricsHeaderEl = (
    <View style={{ marginTop: theme.spacing.md }}>
      <Text variant="title" color="bright" numberOfLines={1}>
        {lyricsHeader.title}
      </Text>
      <Text
        variant="metadata"
        color="secondary"
        numberOfLines={1}
        style={{ marginTop: theme.spacing.xxs }}
      >
        {lyricsHeader.subtitle}
      </Text>
    </View>
  );

  // The two heavy subtrees get element-level memoization: an identical
  // element bails out of reconciliation, so a mode switch or a
  // position tick leaves the kept-alive rows/lines untouched.
  const queueListEl = useMemo(
    () =>
      queue === undefined ? null : (
        <QueueList
          queue={queue}
          reordering={queueReordering}
          scrollEnabled={queueScrollEnabled}
          contentPaddingBottom={segmentReserve}
          onPressItem={onPressQueueItem}
          onRowIntent={onQueueRowIntent}
          onViewportRows={onQueueViewport}
          onRemoveItem={onRemoveQueueItem}
          onMoveItem={onMoveQueueItem}
          onMoveItemTo={onMoveQueueItemTo}
        />
      ),
    [
      queue,
      queueReordering,
      queueScrollEnabled,
      segmentReserve,
      onPressQueueItem,
      onQueueRowIntent,
      onQueueViewport,
      onRemoveQueueItem,
      onMoveQueueItem,
      onMoveQueueItemTo,
    ],
  );

  const lyricLineEls = useMemo(
    () =>
      lyricsPane.kind === 'lines'
        ? lyricsPane.lines.map((line, i) => (
            // Occurrence-keyed: a song swap remounts every row so
            // unchanged geometries still emit fresh onLayout —
            // the owed-scroll retry in onLayout depends on it.
            <View
              key={`${player.occurrenceId ?? ''}:${i}`}
              onLayout={(e) => {
                lyricLayouts.current[i] = {
                  y: e.nativeEvent.layout.y,
                  height: e.nativeEvent.layout.height,
                };
                // Layout arriving after the scroll effect ran —
                // first open mid-song, or a swap clearing the
                // measurements — bumps the owed-scroll effect
                // once the active line's own measurement exists.
                if (i === lyricActiveIndex) {
                  bumpLyricLayout((tick) => tick + 1);
                }
              }}
            >
              <Text
                variant="body"
                color={line.color}
                style={[
                  {
                    paddingVertical: 9,
                    paddingHorizontal: theme.spacing.sm,
                    borderRadius: theme.radius.control,
                  },
                  line.active && {
                    fontFamily: theme.fontFamilies.bold,
                  },
                ]}
              >
                {line.text}
              </Text>
            </View>
          ))
        : null,
    [
      lyricsPane,
      player.occurrenceId,
      lyricActiveIndex,
      theme,
    ],
  );

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
              borderRadius: theme.radius.pill,
              backgroundColor: colors.fg40,
            }}
          />
        </View>
      </GestureDetector>
      {/* The player-mode top row — collapse chevron at the left edge,
          radio pill dead-center (a seed affordance or the armed
          tail's status), the playing track's ⋯ menu at the right. */}
      {activeMode === 'player' && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
          }}
        >
          <View style={{ width: 36, alignItems: 'flex-start' }}>
            <IconButton
              icon="chevron-down"
              size={32}
              iconSize={15}
              color={colors.textSecondary}
              accessibilityLabel={t('sheets.closeA11y')}
              onPress={dismissBackdrop}
            />
          </View>
          <View
            style={{
              flex: 1,
              flexDirection: 'row',
              justifyContent: 'center',
            }}
          >
            {radioRow !== null && (
              /* Same accent fill as the mode selector's active item —
                  accentSoft fill, accent content, control radius. */
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.sm,
                  borderRadius: theme.radius.control,
                  backgroundColor: colors.accentSoft,
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: theme.spacing.xs,
                }}
              >
                <Icon
                  name="radio"
                  size={13}
                  color={radioRow.failed ? colors.warn : colors.accent}
                />
                {radioRow.armed ? (
                  <>
                    <Text
                      variant="metadata"
                      color={radioRow.failed ? 'warn' : 'accent'}
                    >
                      {radioRow.statusText}
                    </Text>
                    <Pressable
                      compact
                      onPress={radioRow.stop.onPress}
                      accessibilityLabel={radioRow.stop.a11yLabel}
                      style={{ paddingHorizontal: theme.spacing.xs }}
                    >
                      <Text variant="metadata" color="primary">
                        {radioRow.stop.label}
                      </Text>
                    </Pressable>
                  </>
                ) : (
                  <Pressable
                    compact
                    onPress={radioRow.start.onPress}
                    accessibilityLabel={radioRow.start.a11yLabel}
                    style={{ paddingHorizontal: theme.spacing.xs }}
                  >
                    <Text variant="metadata" color="accent">
                      {radioRow.start.label}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
          <View style={{ width: 36, alignItems: 'flex-end' }}>
            {onTrackMenu !== undefined && (
              <IconButton
                icon="ellipsis"
                size={32}
                iconSize={15}
                color={colors.textSecondary}
                accessibilityLabel={t('track.a11y.rowActions')}
                onPress={onTrackMenu}
              />
            )}
          </View>
        </View>
      )}
      <View {...paneProps('player')}>
        <GestureDetector gesture={playerPanePan}>
          <View style={{ flex: 1 }}>
          {/* Title/artist bottom-anchored in the light-frost zone; the
              timeline/transport cluster stays pinned at the bottom. */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }}
            onLayout={(e) => {
              playerPaneSize.current.viewport = e.nativeEvent.layout.height;
              measurePlayerPane();
            }}
            onContentSizeChange={(_w, h) => {
              playerPaneSize.current.content = h;
              measurePlayerPane();
            }}
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
                <Text variant="display" color="bright" numberOfLines={1}>
                  {meta.title}
                </Text>
                <Text
                  variant="body"
                  color="primary"
                  numberOfLines={1}
                  style={{ marginTop: theme.spacing.xs }}
                >
                  {meta.artistLabel}
                </Text>
                {meta.albumLabel !== null && (
                  <Text
                    variant="metadata"
                    color="secondary"
                    numberOfLines={1}
                    style={{ marginTop: theme.spacing.xxs }}
                  >
                    {meta.albumLabel}
                  </Text>
                )}
                {meta.errorMessage !== null && (
                  <Text
                    variant="metadata"
                    color="warn"
                    numberOfLines={2}
                    style={{ marginTop: theme.spacing.xxs }}
                  >
                    {meta.errorMessage}
                  </Text>
                )}
                {meta.recovery === 'sign-in' &&
                  onRecovery !== undefined && (
                    <Pressable
                      onPress={onRecovery}
                      accessibilityLabel={t('auth.wall.ctaA11y')}
                      style={{
                        alignSelf: 'flex-start',
                        justifyContent: 'center',
                        marginTop: theme.spacing.xxs,
                        paddingHorizontal: theme.spacing.sm,
                        borderRadius: theme.radius.control,
                      }}
                    >
                      <Text variant="label" color="accent">
                        {t('auth.wall.cta')}
                      </Text>
                    </Pressable>
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
                  {downloadButton !== null && (
                    <DownloadIconButton
                      view={downloadButton}
                      size={36}
                      iconSize={15}
                    />
                  )}
                  {onAddToPlaylist !== undefined && (
                    <IconButton
                      icon={player.inPlaylist ? 'check' : 'list-plus'}
                      size={36}
                      iconSize={15}
                      color={
                        player.inPlaylist ? colors.accent : colors.textSecondary
                      }
                      accessibilityLabel={t('sheets.addToPlaylist')}
                      onPress={onAddToPlaylist}
                    />
                  )}
                </View>
              )}
            </View>
          </ScrollView>
          <GestureDetector gesture={seekTap}>
            <View
              onLayout={(e) => {
                seekTapMeta.current.width = e.nativeEvent.layout.width;
              }}
            >
              <WaveformSeek
                positionMs={player.positionMs}
                durationMs={player.durationMs}
                onSeek={onSeek}
                trackKey={meta.trackKey}
                peaks={peaks}
                loading={meta.waveformLoading}
                visible={expanded && activeMode === 'player'}
              />
            </View>
          </GestureDetector>
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
          </View>
        </GestureDetector>
        </View>
      <View {...paneProps('lyrics')}>
        {lyricsPane.kind === 'lines' ? (
          <>
            {/* The header chrome carries the sheet's dismiss drag —
                only the lines list keeps a scroll gesture. */}
            <GestureDetector gesture={lyricsChromePan}>
              {lyricsHeaderEl}
            </GestureDetector>
            <ScrollView
              ref={lyricsScrollRef}
              onLayout={(e) => {
                lyricsScrollH.current = e.nativeEvent.layout.height;
                lyricViewMeasuredGeom.current = lyricViewGeom;
                bumpLyricLayout((tick) => tick + 1);
              }}
              style={{ flex: 1, marginTop: theme.spacing.sm }}
              // Lines glide beneath the floating segment; the pad lets
              // the last line scroll fully clear of it.
              contentContainerStyle={{ paddingBottom: segmentReserve }}
            >
              {lyricLineEls}
            </ScrollView>
          </>
        ) : (
          // No list to scroll — the whole pane is drag chrome.
          <GestureDetector gesture={lyricsChromePan}>
            <View style={{ flex: 1 }}>
              {lyricsHeaderEl}
              <StateFor view={lyricsPane} />
            </View>
          </GestureDetector>
        )}
      </View>
      <View {...paneProps('queue')}>
        <View style={{ flex: 1, marginTop: theme.spacing.md }}>
          {queue === undefined ? (
            // No list to scroll — the pane is drag chrome.
            <GestureDetector gesture={queueChromePan}>
              <View style={{ flex: 1 }}>
                <EmptyState
                  title={t('queue.empty')}
                  hint={t('queue.emptyHint')}
                  icon="queue"
                />
              </View>
            </GestureDetector>
          ) : (
            <>
              {(queueReorder !== null ||
                queueClear !== null ||
                queueOrigin !== null ||
                queueMeta !== null) && (
                <GestureDetector gesture={queueChromePan}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      marginBottom: theme.spacing.xs,
                    }}
                  >
                    <View
                      style={{
                        flex: 1,
                        minWidth: 0,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: theme.spacing.xs,
                      }}
                    >
                      {queueOrigin !== null && (
                        <Pressable
                          onPress={queueOrigin.onPress}
                          accessibilityLabel={queueOrigin.label}
                          accessibilityRole="button"
                          compact
                          feedback="opacity"
                          style={{ flexShrink: 1, minWidth: 0 }}
                        >
                          <Text
                            variant="metadata"
                            color="secondary"
                            numberOfLines={1}
                          >
                            {queueOrigin.label}
                          </Text>
                        </Pressable>
                      )}
                      {queueMeta !== null && (
                        <Text
                          variant="metadata"
                          color="secondary"
                          numberOfLines={1}
                          style={{ flexShrink: 1 }}
                        >
                          {queueMeta}
                        </Text>
                      )}
                    </View>
                    {queueClear !== null && (
                      <IconButton
                        icon={queueClear.icon}
                        size={32}
                        iconSize={14}
                        color={colors.textSecondary}
                        accessibilityLabel={queueClear.a11yLabel}
                        onPress={queueClear.onPress}
                      />
                    )}
                    {queueReorder !== null && (
                      <IconButton
                        icon={queueReorder.icon}
                        size={32}
                        iconSize={14}
                        color={
                          queueReorder.active
                            ? colors.accent
                            : colors.textSecondary
                        }
                        accessibilityLabel={queueReorder.a11yLabel}
                        active={queueReorder.active}
                        onPress={queueReorder.onPress}
                      />
                    )}
                  </View>
                </GestureDetector>
              )}
              {queueListEl}
            </>
          )}
        </View>
      </View>
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
        <ModeSegment mode={activeMode} onSelect={selectMode} />
      </View>
    </>
  );

  // The player's pinned tail (waveform + transport) can't scroll
  // beneath the segment, so it reserves the segment's footprint here;
  // lyrics/queue put it inside their scroll content instead.
  const content = (
    <View
      style={{
        flex: 1,
        paddingHorizontal: theme.spacing.xl,
        paddingBottom: activeMode === 'player' ? segmentReserve : 0,
      }}
    >
      {body}
    </View>
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
          const h = e.nativeEvent.layout.height;
          setHeight(h);
          sheetH.value = h;
          travelPx.value = Math.max(0, h - collapsedPx.value);
        }}
        pointerEvents="box-none"
        accessibilityViewIsModal={expanded}
        style={[
          {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
          },
          animatedStyle,
          style,
        ]}
      >
        {/* The morphing surface — one card whose collapsed geometry is
            the pill itself: side insets, bottom inset, corner radii,
            background and hairline interpolate toward the full sheet
            on the same progress the translation rides, so a tracked
            drag reads as the pill growing into the player, never a
            fade-out/slide-up exchange. */}
        <Animated.View
          pointerEvents="box-none"
          style={[
            {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              overflow: 'hidden',
              borderWidth: theme.strokes.hairline,
            },
            leafStyle,
          ]}
        >
          {/* iOS 26+: real Liquid Glass backdrop; below that the
              BlurView stays. It fades out over the coupled phase as
              the surface becomes the opaque stage. Off-iOS GlassView
              is a plain View passthrough anyway. */}
          {iosSurface && (
            <Animated.View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, glassStyle]}
            >
              {isLiquidGlassAvailable() ? (
                <GlassView
                  glassEffectStyle="regular"
                  colorScheme={
                    theme.scheme === 'light' ? 'light' : 'dark'
                  }
                  style={StyleSheet.absoluteFill}
                />
              ) : (
                <BlurView
                  intensity={60}
                  tint={theme.scheme === 'light' ? 'light' : 'dark'}
                  style={StyleSheet.absoluteFill}
                />
              )}
            </Animated.View>
          )}
          {/* The collapsed row sits at the surface's top edge — the
              same slot OpenTune's collapsedContent occupies — fading
              out as the morph takes over. */}
          <Animated.View
            animatedProps={rowGateProps}
            style={[
              {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: pillHeight,
              },
              rowStyle,
            ]}
          >
            <MiniPlayer
              embedded
              player={player}
              platform={platform}
              progress={progress}
              travel={travelPx}
              anchor={anchor}
              gone={gone}
              hostHeight={sheetH}
              onPress={() => {
                // A tap is a synchronous JS commit — no queue window
                // exists to cancel through, so it commits directly
                // rather than through the token gate (a JS-side
                // anchor write isn't visible to a same-tick JS read
                // anyway). It still mints the token and launches the
                // settle like a velocity-0 gesture release, so the
                // expanded effect's gestureOwned check sees a spring
                // actually in flight. Gesture swipes commit through
                // onExpandCommit instead, which checks the token
                // written at release (a back press clears it and the
                // queued commit drops itself).
                anchor.value = 1;
                progress.value = theme.reducedMotion
                  ? 1
                  : withSpring(1, SHEET_SETTLE_SPRING);
                onExpandChangeRef.current?.(true);
              }}
              onExpandCommit={() => commitAnchor(1)}
              onCollapse={() => commitAnchor(0)}
              onPlayPause={onPlayPause}
              onNext={onNext}
              onPrevious={onPrevious}
              onToggleLike={onToggleLike}
              onDismiss={emitDismiss}
              skipNext={skipNext}
              skipPrevious={skipPrevious}
              nextEndsQueue={nextEndsQueue}
            />
          </Animated.View>
        </Animated.View>
        {/* Staged reveal: constant-fill layer, clipped to the leaf's
            live top radius, fading in through the pill's fade window
            and fully present at the input gate. */}
        <Animated.View
          animatedProps={contentGateProps}
          style={[
            StyleSheet.absoluteFill,
            { overflow: 'hidden' },
            contentStyle,
          ]}
        >
          {/* Mount on the first rise commit and keep mounted across
              collapses, track changes and mode switches — remounting
              mid-morph would pay the artwork resolver and decode
              during the drag, and mounting while parked would fetch
              full-size art the listener never opens. Non-player
              modes just hide it under the flat stage. */}
          {backdropOn && player.artworkUrl !== null && (
            <View
              style={[
                StyleSheet.absoluteFill,
                { display: immersive ? 'flex' : 'none' },
              ]}
              pointerEvents="none"
            >
              <PlayerBackdrop artworkUrl={player.artworkUrl} />
            </View>
          )}
          {/* The immersive dark scope stays one boundary either way —
              a provider↔bare swap would remount every kept-alive pane
              on each switch to or from player mode. */}
          <DarkThemeScope on={immersive}>{content}</DarkThemeScope>
        </Animated.View>
      </Animated.View>
    </>
  );
}
