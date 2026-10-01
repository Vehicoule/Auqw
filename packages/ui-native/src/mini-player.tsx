import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useTheme } from './theme.tsx';
import {
  SKIP_COMMIT_FRACTION,
  resolveSheetTarget,
  resolveSkipCommit,
  skipCommitEdge,
  skipTravelPx,
  stageCollapsedAlpha,
  stageSheetWrite,
} from './stage-motion';
import {
  IconButton,
  PlayPauseIcon,
  Pressable,
  Spinner,
  Text,
} from './primitives.tsx';
import { ArtworkRing } from './progress.tsx';
import { t } from '@auqw/ui-shared';
import type {
  PlatformVariant,
  PlayerModel,
  SkipPeek,
} from '@auqw/ui-shared';

export type MiniPlayerProps = {
  readonly player: PlayerModel;
  readonly platform?: PlatformVariant | undefined;
  readonly onPress?: (() => void) | undefined;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  /** Swipe-down: dismiss stops playback; the queue keeps its items. */
  readonly onDismiss?: (() => void) | undefined;
  /** Drag release committed to collapse while grabbing a mid-flight
      sheet (never fires from the rest anchor — there the pill just
      settles back). */
  readonly onCollapse?: (() => void) | undefined;
  /** Shared 0..1 stage-sheet progress: an upward drag writes it
      directly so the sheet rises with the finger, and the pill fades
      out on the same value. Omitted in static fixtures. */
  readonly progress?: SharedValue<number> | undefined;
  /** Shared pixel travel published by the sheet's layout — finger
      distance is divided by it so the sheet's translation and this
      drag's progress conversion use the same physical distance. Falls
      back to the window height until the sheet has measured. */
  readonly travel?: SharedValue<number> | undefined;
  /** Shared settle-target flag — this drag's release writes the
      committed anchor here so the sheet's `expanded`-flip effect
      doesn't restart the spring and drop the flick's velocity. */
  readonly anchor?: SharedValue<number> | undefined;
  /** False while the sheet owns the screen — keeps the invisible pill
      out of the touch path and the accessibility tree. Ignored when
      `embedded` — the sheet owns the gate there. */
  readonly interactive?: boolean | undefined;
  /** Render inside the stage sheet's morphing surface: only the row
      strip mounts here — the sheet supplies the card chrome, the rest
      position, the fade and the touch gate. */
  readonly embedded?: boolean | undefined;
  /** Shared 0..1 dismiss slide — the unified vertical axis (OpenTune's
      single `value`) writes it on drags below the rest anchor, and the
      release resolves against OpenTune's three-target performFling.
      Omitted in static fixtures. */
  readonly gone?: SharedValue<number> | undefined;
  /** Shared measured height of the morph host — the dismiss strip's
      pixel distance resolves against it (window height fallback). */
  readonly hostHeight?: SharedValue<number> | undefined;
  /** Sideswipe landing rows: the row the drag previews sliding in from
      each edge, resolved with the engine's own walk (dealt order,
      failed skips, repeat wrap, previous-restart) so the commit lands
      exactly where the preview pointed. Null is a dead edge — the
      conveyor rubber-bands and never commits there. Undefined means
      no conveyor at all (static hosts keep the release-threshold
      contract). */
  readonly skipNext?: SkipPeek | null | undefined;
  readonly skipPrevious?: SkipPeek | null | undefined;
  /** True when the forward walk finds no landing row but the cursor
      still lives — the same swipe then drains the queue (advance()
      stops at the tail / all-failed), ending playback. An actionable
      edge: the row travels fully, the empty pill behind it reads as
      the queue running out, and release commits onNext like any
      landing. Distinct from a dead edge, which only rubber-bands. */
  readonly nextEndsQueue?: boolean | undefined;
};

/** The incoming row inside the conveyor — art + meta mirroring the
    current row's geometry, untouchable and out of the a11y tree. */
function SkipPeekRow({ peek }: { readonly peek: SkipPeek }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
      }}
    >
      <ArtworkRing artworkUrl={peek.artworkUrl} progress={0} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          variant="body"
          color="bright"
          numberOfLines={1}
          style={{ fontFamily: theme.fontFamilies.medium }}
        >
          {peek.title}
        </Text>
        <Text variant="metadata" color="secondary" numberOfLines={1}>
          {peek.artist ?? '—'}
        </Text>
      </View>
    </View>
  );
}

/** How long a committed conveyor waits for the model flip before the
    parked preview is treated as a skip that never landed and springs
    home. Long enough for a real advance, short enough to feel honest. */
const SKIP_RESET_MS = 520;

// Gesture-release settle — OpenTune BottomSheetAnimationSpec
// (StiffnessMediumLow ≈ 400 at dampingRatio 1.0): critically damped.
// damping 40 is the critical point for stiffness 400 at mass 1, and
// overshootClamping pins the value at the anchor so a velocity-carrying
// flick can never dip past it and read as a bounce.
const SHEET_SETTLE_SPRING = {
  stiffness: 400,
  damping: 40,
  overshootClamping: true,
} as const;

export function MiniPlayer({
  player,
  platform = Platform.OS === 'ios' ? 'ios' : 'android',
  onPress,
  onPlayPause,
  onNext,
  onPrevious,
  onToggleLike,
  onDismiss,
  onCollapse,
  progress: sheetProgress,
  travel: sheetTravel,
  anchor: sheetAnchor,
  interactive = true,
  embedded = false,
  gone: sheetGone,
  hostHeight,
  skipNext,
  skipPrevious,
  nextEndsQueue,
}: MiniPlayerProps) {
  const theme = useTheme();
  const ios = platform === 'ios';
  const { height: windowHeight } = useWindowDimensions();
  const dragStart = useSharedValue(0);
  // Set on the first vertical write — distinguishes a gesture that
  // displaced the sheet from one that merely observed a settle.
  const wroteProgress = useSharedValue(false);
  // Conveyor state: the content row's horizontal offset, the axis the
  // drag committed to (0 undecided / 1 horizontal / 2 vertical), the
  // content box's pixel width (conveyor distance), and a per-drag
  // latch so the threshold haptic ticks once, not every frame.
  const dragX = useSharedValue(0);
  const axis = useSharedValue(0);
  const rowW = useSharedValue(0);
  const ticked = useSharedValue(0);
  // Direction availability mirrored into the UI runtime — the props
  // are fresh objects every position tick and reading them inside the
  // worklet would either go stale or force a gesture rebuild (a fresh
  // Pan() cancels an in-flight swipe).
  const nextLive = useSharedValue(skipNext != null ? 1 : 0);
  const prevLive = useSharedValue(skipPrevious != null ? 1 : 0);
  const nextDrains = useSharedValue(nextEndsQueue === true ? 1 : 0);
  useEffect(() => {
    nextLive.value = skipNext != null ? 1 : 0;
    prevLive.value = skipPrevious != null ? 1 : 0;
    nextDrains.value = nextEndsQueue === true ? 1 : 0;
  }, [skipNext, skipPrevious, nextEndsQueue, nextLive, prevLive, nextDrains]);
  const progress =
    player.durationMs === null || player.durationMs <= 0
      ? 0
      : Math.min(1, Math.max(0, player.positionMs / player.durationMs));
  const busy = player.status === 'preparing' || player.status === 'buffering';
  const playColor = ios ? theme.colors.textBright : theme.colors.accent;
  // Latest callbacks via ref — the parent passes fresh inline closures
  // every position tick, and a deps-listed callback would rebuild the
  // pan (a fresh Pan() cancels the in-flight swipe — exactly the bug
  // the stable-gesture comment below is guarding against).
  const callbacks = useRef({
    onNext,
    onPrevious,
    onPress,
    onDismiss,
    onCollapse,
  });
  const skipData = useRef({ next: skipNext, previous: skipPrevious });
  const occurrenceId = useRef(player.occurrenceId);
  useEffect(() => {
    callbacks.current = {
      onNext,
      onPrevious,
      onPress,
      onDismiss,
      onCollapse,
    };
    skipData.current = { next: skipNext, previous: skipPrevious };
    occurrenceId.current = player.occurrenceId;
  });
  const emit = useCallback(
    (key: 'onNext' | 'onPrevious' | 'onPress' | 'onDismiss' | 'onCollapse') => {
      callbacks.current[key]?.();
    },
    [],
  );
  const hapticTick = useCallback(() => {
    void Haptics.selectionAsync();
  }, []);
  // A committed conveyor parks on the incoming preview until the model
  // flip lands. The timer is the honesty bound for a skip that was
  // gated away (dead target, blocked occurrence): spring the row home
  // rather than leaving the optimistic card seated.
  const pendingSkip = useRef(false);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitSkip = useCallback(
    (dir: 'next' | 'previous') => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const peek =
        dir === 'next' ? skipData.current.next : skipData.current.previous;
      emit(dir === 'next' ? 'onNext' : 'onPrevious');
      if (peek != null && peek.occurrenceId === occurrenceId.current) {
        // 'Previous' past the restart point targets the row already
        // seated — the identical preview is centered, so the snap is
        // invisible.
        dragX.value = 0;
        return;
      }
      pendingSkip.current = true;
      if (skipTimer.current !== null) {
        clearTimeout(skipTimer.current);
      }
      skipTimer.current = setTimeout(() => {
        skipTimer.current = null;
        pendingSkip.current = false;
        dragX.value = theme.reducedMotion
          ? 0
          : withSpring(0, { stiffness: 260, damping: 26 });
      }, SKIP_RESET_MS);
    },
    [emit, dragX, theme.reducedMotion],
  );
  useEffect(() => {
    if (!pendingSkip.current) return;
    // The track flip landed — the preview the conveyor seated IS the
    // row the model just published; snapping home under it is
    // invisible.
    pendingSkip.current = false;
    if (skipTimer.current !== null) {
      clearTimeout(skipTimer.current);
      skipTimer.current = null;
    }
    dragX.value = 0;
  }, [player.occurrenceId, dragX]);
  useEffect(
    () => () => {
      if (skipTimer.current !== null) {
        clearTimeout(skipTimer.current);
      }
    },
    [],
  );
  // Stable gesture object — a fresh Pan() per render would cancel an
  // in-flight swipe when the position tick re-renders the row.
  // ONE pan owns both axes (the pre-morph structure — a Race of two
  // pans ate taps before the inner pressables could resolve): the
  // first 6 px of dominance locks the axis, a horizontal drag drives
  // the track conveyor, a vertical one the stage sheet, and the
  // release commits whichever axis won.
  const swipe = useMemo(() => {
    const travelPx = () => {
      'worklet';
      const measured =
        sheetTravel !== undefined && sheetTravel.value > 0
          ? sheetTravel.value
          : windowHeight;
      return Math.max(1, measured);
    };
    const hostPx = () => {
      'worklet';
      const measured =
        hostHeight !== undefined && hostHeight.value > 0
          ? hostHeight.value
          : windowHeight;
      return Math.max(1, measured);
    };
    // The dismissed strip's pixel depth — the band below the pill's
    // rest anchor, from OpenTune's `collapsedBound - dismissedBound`.
    const collapsedPx = () => {
      'worklet';
      return Math.max(1, hostPx() - travelPx());
    };
    const settleTo = (target: number) => {
      'worklet';
      return theme.reducedMotion
        ? target
        : withSpring(target, SHEET_SETTLE_SPRING);
    };
    // Only settle when this gesture actually displaced the sheet —
    // restoring toward `dragStart` after grabbing a closing sheet
    // would resurrect it mid-collapse (the pill is interactive
    // only while `expanded` is false, so the anchor here is 0).
    const settleBack = () => {
      'worklet';
      if (sheetProgress !== undefined && wroteProgress.value) {
        if (sheetProgress.value > 0) {
          sheetProgress.value = settleTo(0);
        }
        if (sheetGone !== undefined && sheetGone.value > 0) {
          sheetGone.value = settleTo(0);
        }
      }
    };
    const springHome = () => {
      'worklet';
      if (dragX.value === 0) return;
      dragX.value = theme.reducedMotion
        ? 0
        : withSpring(0, { stiffness: 260, damping: 26 });
    };
    return Gesture.Pan()
      .activeOffsetX([-12, 12])
      .activeOffsetY([-8, 8])
      .onBegin(() => {
        axis.value = 0;
        ticked.value = 0;
        if (sheetProgress !== undefined) {
          // The drag start on the unified axis: px above the rest
          // anchor (a drag grabbed mid-dismiss reopens negative).
          dragStart.value =
            sheetProgress.value * travelPx() -
            (sheetGone === undefined ? 0 : sheetGone.value) *
              collapsedPx();
          wroteProgress.value = false;
        }
      })
      .onUpdate((e) => {
        if (axis.value === 0) {
          const ax = Math.abs(e.translationX);
          const ay = Math.abs(e.translationY);
          if (ax < 6 && ay < 6) return;
          axis.value = ax > ay ? 1 : 2;
        }
        if (axis.value === 1) {
          // The conveyor only runs at the pill's rest anchor — a sheet
          // already rising or a dismiss slide owns the drag.
          if (sheetProgress === undefined) return;
          if (sheetProgress.value > 0.001) return;
          if (sheetGone !== undefined && sheetGone.value > 0.001) return;
          const w = Math.max(1, rowW.value);
          // Forward is actionable without a landing row when it drains
          // the queue — the empty pill behind the outgoing row is the
          // honest preview of playback ending.
          const allowed =
            e.translationX < 0
              ? nextLive.value !== 0 || nextDrains.value !== 0
                ? 1
                : 0
              : prevLive.value;
          dragX.value = skipTravelPx(e.translationX, w, allowed !== 0);
          if (
            allowed !== 0 &&
            ticked.value === 0 &&
            Math.abs(dragX.value) >= w * SKIP_COMMIT_FRACTION
          ) {
            ticked.value = 1;
            scheduleOnRN(hapticTick);
          }
          return;
        }
        if (sheetProgress === undefined) return;
        wroteProgress.value = true;
        // One axis, two shared values: above the rest anchor writes the
        // morph progress, below it writes the dismiss slide — the pill
        // tracks the finger continuously across the collapsed→dismissed
        // boundary (OpenTune's single `value`).
        const write = stageSheetWrite(
          dragStart.value - e.translationY,
          travelPx(),
          collapsedPx(),
        );
        sheetProgress.value = write.progress;
        if (sheetGone !== undefined) {
          sheetGone.value = write.gone;
        }
      })
      .onFinalize((e, success) => {
        // RNGH fires onFinalize on END *and* on FAIL/CANCELLED — an OS
        // steal or a failOffset abort carries the finger's last
        // translation, so without the guard a dead gesture still
        // dismisses/skips/commits. Restore whatever it wrote and stop.
        const released = axis.value;
        axis.value = 0;
        if (!success) {
          settleBack();
          springHome();
          return;
        }
        if (released === 1) {
          if (sheetProgress === undefined) {
            // Static hosts (the gallery) keep the release-threshold
            // contract — no conveyor data, but a decisive flick still
            // fires.
            if (e.translationX < -40) {
              scheduleOnRN(emit, 'onNext');
            } else if (e.translationX > 40) {
              scheduleOnRN(emit, 'onPrevious');
            }
            return;
          }
          const w = Math.max(1, rowW.value);
          const allowed =
            e.translationX < 0
              ? nextLive.value !== 0 || nextDrains.value !== 0
                ? 1
                : 0
              : prevLive.value;
          const atRest =
            sheetProgress.value <= 0.001 &&
            (sheetGone === undefined || sheetGone.value <= 0.001);
          if (
            atRest &&
            allowed !== 0 &&
            resolveSkipCommit(e.translationX, e.velocityX, w, true)
          ) {
            // Commit: the seated preview becomes the new current row
            // when the model flip lands — the edge slide just covers
            // the gap.
            const edge = skipCommitEdge(e.translationX, w);
            dragX.value = theme.reducedMotion
              ? edge
              : withTiming(edge, {
                  duration: 140,
                  easing: Easing.out(Easing.quad),
                });
            scheduleOnRN(commitSkip, e.translationX < 0 ? 'next' : 'previous');
          } else {
            springHome();
          }
          return;
        }
        if (sheetProgress === undefined) {
          if (e.translationY > 40) {
            scheduleOnRN(emit, 'onDismiss');
          } else if (e.translationY < -40) {
            scheduleOnRN(emit, 'onPress');
          }
          return;
        }
        const travel = travelPx();
        const collapsed = collapsedPx();
        const raw = dragStart.value - e.translationY;
        const velocityP = -e.velocityY / travel;
        const velocityG = e.velocityY / collapsed;
        if (sheetGone === undefined) {
          // Shared progress but no dismiss axis — the release keeps
          // the two-anchor contract plus the rest-anchor dismiss tap.
          if (dragStart.value <= 0 && e.translationY > 48) {
            scheduleOnRN(emit, 'onDismiss');
            return;
          }
          const target =
            resolveSheetTarget(
              Math.max(0, raw),
              travel,
              collapsed,
              e.velocityY,
            ) === 'expanded'
              ? 1
              : 0;
          if (sheetAnchor !== undefined) {
            sheetAnchor.value = target;
          }
          sheetProgress.value = theme.reducedMotion
            ? target
            : withSpring(target, {
                ...SHEET_SETTLE_SPRING,
                velocity: velocityP,
              });
          if (target === 1) {
            scheduleOnRN(emit, 'onPress');
          } else if (dragStart.value > travel * 0.5) {
            scheduleOnRN(emit, 'onCollapse');
          }
          return;
        }
        // OpenTune performFling: fling direction wins outright (down
        // only dismisses below the collapsed anchor), otherwise the
        // zone midpoints decide.
        const target = resolveSheetTarget(
          raw,
          travel,
          collapsed,
          e.velocityY,
        );
        if (target === 'expanded') {
          if (sheetAnchor !== undefined) {
            sheetAnchor.value = 1;
          }
          // Fling-up out of a dismiss slide carries the surface home
          // and open on two coordinated springs — the expand's rise
          // and the dismiss offset unwind together.
          sheetGone.value = theme.reducedMotion
            ? 0
            : withSpring(0, {
                ...SHEET_SETTLE_SPRING,
                velocity: velocityG,
              });
          sheetProgress.value = theme.reducedMotion
            ? 1
            : withSpring(1, {
                ...SHEET_SETTLE_SPRING,
                velocity: velocityP,
              });
          scheduleOnRN(emit, 'onPress');
          return;
        }
        if (target === 'collapsed') {
          if (sheetAnchor !== undefined) {
            sheetAnchor.value = 0;
          }
          if (raw > 0) {
            sheetProgress.value = theme.reducedMotion
              ? 0
              : withSpring(0, {
                  ...SHEET_SETTLE_SPRING,
                  velocity: velocityP,
                });
          } else {
            sheetGone.value = theme.reducedMotion
              ? 0
              : withSpring(0, {
                  ...SHEET_SETTLE_SPRING,
                  velocity: velocityG,
                });
          }
          // A mid-flight grab settling home commits the collapse —
          // from the rest anchor itself it would be a spurious flip.
          if (dragStart.value > travel * 0.5) {
            scheduleOnRN(emit, 'onCollapse');
          }
          return;
        }
        // Dismissed: the slide-off lands before the host tears the
        // player down — emit on the spring's completion so the pill
        // visibly leaves instead of vanishing mid-travel.
        if (sheetAnchor !== undefined) {
          sheetAnchor.value = 0;
        }
        sheetProgress.value = 0;
        if (theme.reducedMotion) {
          sheetGone.value = 1;
          scheduleOnRN(emit, 'onDismiss');
        } else {
          sheetGone.value = withSpring(
            1,
            { ...SHEET_SETTLE_SPRING, velocity: velocityG },
            (finished) => {
              if (finished === true) {
                scheduleOnRN(emit, 'onDismiss');
              }
            },
          );
        }
      });
  }, [
    emit,
    commitSkip,
    hapticTick,
    sheetProgress,
    sheetTravel,
    sheetAnchor,
    sheetGone,
    hostHeight,
    windowHeight,
    theme.reducedMotion,
    dragStart,
    wroteProgress,
    dragX,
    axis,
    rowW,
    ticked,
    nextLive,
    prevLive,
    nextDrains,
  ]);
  // The pill fades out inside the sheet's first stretch of travel —
  // the fade window ends exactly where the expanded content's reveal
  // begins — and drifts down slightly for depth as the sheet takes over.
  const fade = useAnimatedStyle(() => {
    const p = sheetProgress === undefined ? 0 : sheetProgress.value;
    return {
      opacity: sheetProgress === undefined ? 1 : stageCollapsedAlpha(p),
      transform: [{ translateY: p * 16 }],
    };
  });
  const conveyorStyle = useAnimatedStyle(() => {
    const w = rowW.value;
    const f = w > 1 ? Math.min(1, Math.abs(dragX.value) / w) : 0;
    return {
      transform: [{ translateX: dragX.value }],
      opacity: 1 - 0.45 * f,
    };
  });
  const nextPeekStyle = useAnimatedStyle(() => {
    const w = rowW.value;
    const f = w > 1 ? Math.min(1, Math.max(0, -dragX.value) / (w * 0.45)) : 0;
    return {
      transform: [{ translateX: dragX.value + w }],
      opacity: f,
    };
  });
  const prevPeekStyle = useAnimatedStyle(() => {
    const w = rowW.value;
    const f = w > 1 ? Math.min(1, Math.max(0, dragX.value) / (w * 0.45)) : 0;
    return {
      transform: [{ translateX: dragX.value - w }],
      opacity: f,
    };
  });
  /*
   * The row strip is shared between the standalone card and the
   * embedded mount — inside the sheet's morphing surface the card
   * chrome, glass backdrop, rest position and fade all live on the
   * sheet's leaf instead.
   */
  const row = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs,
        height: theme.sizes.miniPlayer,
        paddingHorizontal: theme.spacing.sm,
      }}
    >
      {/*
       * The conveyor box owns the content slot: clipped, measured
       * for the shared rowW, and hosting the sliding current row
       * plus the two off-screen landing previews.
       */}
      <View
        style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}
        onLayout={(e) => {
          rowW.value = e.nativeEvent.layout.width;
        }}
      >
        <Animated.View style={[{ flex: 1, minWidth: 0 }, conveyorStyle]}>
          <Pressable
            compact
            feedback="opacity"
            onPress={onPress}
            accessibilityLabel={t('player.a11y.nowPlaying', {
              title: player.title,
              artist:
                player.artist === null
                  ? ''
                  : t('track.a11y.artistSuffix', {
                      artist: player.artist,
                    }),
              status: t(`player.status.${player.status}`),
            })}
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.md,
            }}
          >
            <ArtworkRing artworkUrl={player.artworkUrl} progress={progress} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                variant="body"
                color="bright"
                numberOfLines={1}
                style={{ fontFamily: theme.fontFamilies.medium }}
              >
                {player.title}
              </Text>
              <Text variant="metadata" color="secondary" numberOfLines={1}>
                {player.artist ?? '—'}
              </Text>
            </View>
          </Pressable>
        </Animated.View>
        {skipPrevious != null && (
          <Animated.View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[StyleSheet.absoluteFill, prevPeekStyle]}
          >
            <SkipPeekRow peek={skipPrevious} />
          </Animated.View>
        )}
        {skipNext != null && (
          <Animated.View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[StyleSheet.absoluteFill, nextPeekStyle]}
          >
            <SkipPeekRow peek={skipNext} />
          </Animated.View>
        )}
      </View>
      {onToggleLike !== undefined && (
        <IconButton
          icon={player.liked ? 'heart-filled' : 'heart'}
          size={30}
          iconSize={14}
          color={player.liked ? theme.colors.liked : theme.colors.textSecondary}
          accessibilityLabel={
            player.liked ? t('common.unlike') : t('common.like')
          }
          onPress={onToggleLike}
        />
      )}
      <Pressable
        compact
        onPress={onPlayPause}
        accessibilityLabel={
          player.intentPlaying ? t('common.pause') : t('common.play')
        }
        style={{
          width: 32,
          height: 32,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: ios ? 16 : 12,
          backgroundColor: ios
            ? theme.colors.glassControl
            : theme.colors.accentSoft,
          borderWidth: ios ? theme.strokes.hairline : 0,
          borderColor: theme.colors.hairline,
        }}
      >
        {busy ? (
          <Spinner size={14} color={playColor} />
        ) : (
          <PlayPauseIcon
            playing={player.intentPlaying}
            size={16}
            color={playColor}
          />
        )}
      </Pressable>
    </View>
  );
  if (embedded) {
    return <GestureDetector gesture={swipe}>{row}</GestureDetector>;
  }
  return (
    <GestureDetector gesture={swipe}>
      <Animated.View
        style={fade}
        pointerEvents={interactive ? 'auto' : 'none'}
        accessibilityElementsHidden={!interactive}
        importantForAccessibility={interactive ? 'auto' : 'no-hide-descendants'}
      >
        <View
          style={{
            marginHorizontal: theme.spacing.md,
            marginBottom: theme.spacing.md,
            borderRadius: theme.radius.float,
            borderWidth: theme.strokes.hairline,
            borderColor: theme.colors.hairline,
            backgroundColor: ios ? theme.colors.glass : theme.colors.raised,
            overflow: 'hidden',
          }}
        >
          {/*
           * iOS 26+: real Liquid Glass backdrop; below that the BlurView
           * stays. Off-iOS GlassView is a plain View passthrough anyway.
           */}
          {ios &&
            (isLiquidGlassAvailable() ? (
              <GlassView
                glassEffectStyle="regular"
                colorScheme={theme.scheme === 'light' ? 'light' : 'dark'}
                style={StyleSheet.absoluteFill}
              />
            ) : (
              <BlurView
                intensity={60}
                tint={theme.scheme === 'light' ? 'light' : 'dark'}
                style={StyleSheet.absoluteFill}
              />
            ))}
          {/*
           * Action buttons are siblings of the open-player pressable,
           * not children: a labelled pressable groups its descendants
           * into one VoiceOver element on iOS, hiding the controls.
           */}
          {row}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}
