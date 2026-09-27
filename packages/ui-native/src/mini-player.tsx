import { useMemo } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useTheme } from './theme.tsx';
import {
  resolveStageAnchor,
  stageCollapsedAlpha,
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
import type { PlatformVariant, PlayerModel } from '@auqw/ui-shared';

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
  /** False while the sheet owns the screen — keeps the invisible pill
      out of the touch path and the accessibility tree. */
  readonly interactive?: boolean | undefined;
};

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
  interactive = true,
}: MiniPlayerProps) {
  const theme = useTheme();
  const ios = platform === 'ios';
  const { height: windowHeight } = useWindowDimensions();
  const dragStart = useSharedValue(0);
  // Set on the first vertical-dominant update — distinguishes a gesture
  // that displaced the sheet from one that merely observed a settle.
  const wroteProgress = useSharedValue(false);
  const progress =
    player.durationMs === null || player.durationMs <= 0
      ? 0
      : Math.min(1, Math.max(0, player.positionMs / player.durationMs));
  const busy = player.status === 'preparing' || player.status === 'buffering';
  // Stable gesture object — a fresh Pan() per render would cancel an
  // in-flight swipe when the position tick re-renders the row.
  // ONE pan owns both axes (the pre-morph structure — a Race of two
  // pans ate taps before the inner pressables could resolve): it
  // activates on either axis, tracks the rise only while vertical
  // dominates, and the release picks the axis by dominance.
  const swipe = useMemo(() => {
    const travelPx = () => {
      'worklet';
      const measured =
        sheetTravel !== undefined && sheetTravel.value > 0
          ? sheetTravel.value
          : windowHeight;
      return Math.max(1, measured);
    };
    return Gesture.Pan()
      .activeOffsetX([-12, 12])
      .activeOffsetY([-8, 8])
      .onBegin(() => {
        if (sheetProgress !== undefined) {
          dragStart.value = sheetProgress.value;
          wroteProgress.value = false;
        }
      })
      .onUpdate((e) => {
        if (sheetProgress === undefined) return;
        // Horizontal intent owns the recognizer without lifting the
        // sheet — only a vertically-dominant pull writes progress.
        if (Math.abs(e.translationX) > Math.abs(e.translationY)) return;
        wroteProgress.value = true;
        sheetProgress.value = Math.min(
          1,
          Math.max(0, dragStart.value - e.translationY / travelPx()),
        );
      })
      .onFinalize((e) => {
        if (sheetProgress === undefined) {
          // Static hosts (the gallery) keep the release-threshold
          // contract — no shared progress to track.
          if (e.translationX < -40 && onNext !== undefined) {
            scheduleOnRN(onNext);
          } else if (e.translationX > 40 && onPrevious !== undefined) {
            scheduleOnRN(onPrevious);
          } else if (e.translationY > 40 && onDismiss !== undefined) {
            scheduleOnRN(onDismiss);
          } else if (e.translationY < -40 && onPress !== undefined) {
            scheduleOnRN(onPress);
          }
          return;
        }
        if (Math.abs(e.translationX) >= Math.abs(e.translationY)) {
          // Only settle when this gesture actually displaced the sheet —
          // restoring toward `dragStart` after grabbing a closing sheet
          // would resurrect it mid-collapse (the pill is interactive
          // only while `expanded` is false, so the anchor here is 0).
          if (wroteProgress.value && sheetProgress.value > 0) {
            sheetProgress.value = theme.reducedMotion
              ? 0
              : withSpring(0, { stiffness: 200, damping: 28 });
          }
          if (e.translationX < -40 && onNext !== undefined) {
            scheduleOnRN(onNext);
          } else if (e.translationX > 40 && onPrevious !== undefined) {
            scheduleOnRN(onPrevious);
          }
          return;
        }
        // A pull-down that never left the rest anchor dismisses the
        // player outright rather than bouncing an unmoved sheet.
        if (
          dragStart.value < 0.01 &&
          e.translationY > 48 &&
          onDismiss !== undefined
        ) {
          scheduleOnRN(onDismiss);
          return;
        }
        const travel = travelPx();
        const target =
          resolveStageAnchor(
            dragStart.value,
            sheetProgress.value,
            e.velocityY,
          ) === 'expanded'
            ? 1
            : 0;
        sheetProgress.value = theme.reducedMotion
          ? target
          : withSpring(target, {
              stiffness: 200,
              damping: 28,
              velocity: -e.velocityY / travel,
            });
        if (target === 1) {
          if (onPress !== undefined) scheduleOnRN(onPress);
        } else if (dragStart.value > 0.5 && onCollapse !== undefined) {
          scheduleOnRN(onCollapse);
        }
      });
  }, [
    onNext,
    onPrevious,
    onPress,
    onDismiss,
    onCollapse,
    sheetProgress,
    sheetTravel,
    windowHeight,
    theme.reducedMotion,
    dragStart,
    wroteProgress,
  ]);
  // The pill fades out inside the sheet's first stretch of travel — the
  // fade window ends exactly where the expanded content's reveal begins.
  const fade = useAnimatedStyle(() => ({
    opacity:
      sheetProgress === undefined
        ? 1
        : stageCollapsedAlpha(sheetProgress.value),
  }));
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
          marginHorizontal: 10,
          marginBottom: theme.spacing.sm,
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
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            height: theme.sizes.miniPlayer,
            paddingHorizontal: 7,
          }}
        >
          <Pressable
            compact
            onPress={onPress}
            accessibilityLabel={t('player.a11y.nowPlaying', {
              title: player.title,
              artist:
                player.artist === null
                  ? ''
                  : t('track.a11y.artistSuffix', { artist: player.artist }),
              status: t(`player.status.${player.status}`),
            })}
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <ArtworkRing
              artworkUrl={player.artworkUrl}
              progress={progress}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                variant="body"
                color="bright"
                numberOfLines={1}
                style={{ fontFamily: theme.fontFamilies.medium }}
              >
                {player.title}
              </Text>
              <Text
                variant="metadata"
                color="secondary"
                numberOfLines={1}
              >
                {player.artist ?? '—'}
              </Text>
            </View>
          </Pressable>
          {onToggleLike !== undefined && (
            <IconButton
              icon={player.liked ? 'heart-filled' : 'heart'}
              size={30}
              iconSize={14}
              color={
                player.liked ? theme.colors.liked : theme.colors.textSecondary
              }
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
              <Spinner size={14} color={ios ? theme.colors.textBright : theme.colors.accent} />
            ) : (
              <PlayPauseIcon
                playing={player.intentPlaying}
                size={16}
                color={ios ? theme.colors.textBright : theme.colors.accent}
              />
            )}
          </Pressable>
        </View>
      </View>
      </Animated.View>
    </GestureDetector>
  );
}
