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
  interactive = true,
}: MiniPlayerProps) {
  const theme = useTheme();
  const ios = platform === 'ios';
  const { height: windowHeight } = useWindowDimensions();
  const dragStart = useSharedValue(0);
  const progress =
    player.durationMs === null || player.durationMs <= 0
      ? 0
      : Math.min(1, Math.max(0, player.positionMs / player.durationMs));
  const busy = player.status === 'preparing' || player.status === 'buffering';
  // Stable gesture object — a fresh Pan() per render would cancel an
  // in-flight swipe when the position tick re-renders the row.
  // Horizontal swipes keep their release-threshold semantics
  // (next/previous); the vertical pan owns the rise/dismiss axis.
  const swipe = useMemo(() => {
    const horizontal = Gesture.Pan()
      .activeOffsetX([-12, 12])
      .failOffsetY([-24, 24])
      .onEnd((e) => {
        if (e.translationX < -40 && onNext !== undefined) {
          scheduleOnRN(onNext);
        } else if (e.translationX > 40 && onPrevious !== undefined) {
          scheduleOnRN(onPrevious);
        }
      });
    const vertical = Gesture.Pan()
      .activeOffsetY([-8, 8])
      .failOffsetX([-24, 24])
      .onBegin(() => {
        if (sheetProgress !== undefined) {
          dragStart.value = sheetProgress.value;
        }
      })
      .onUpdate((e) => {
        if (sheetProgress !== undefined) {
          const travel = Math.max(1, windowHeight);
          sheetProgress.value = Math.min(
            1,
            Math.max(0, dragStart.value - e.translationY / travel),
          );
        }
      })
      .onFinalize((e) => {
        if (sheetProgress === undefined) {
          // Static hosts (the gallery) keep the release-threshold
          // contract — no shared progress to track.
          if (e.translationY > 40 && onDismiss !== undefined) {
            scheduleOnRN(onDismiss);
          } else if (e.translationY < -40 && onPress !== undefined) {
            scheduleOnRN(onPress);
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
        const travel = Math.max(1, windowHeight);
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
              damping: 26,
              velocity: -e.velocityY / travel,
            });
        if (target === 1) {
          if (onPress !== undefined) scheduleOnRN(onPress);
        } else if (dragStart.value > 0.5 && onCollapse !== undefined) {
          scheduleOnRN(onCollapse);
        }
      });
    return Gesture.Race(vertical, horizontal);
  }, [
    onNext,
    onPrevious,
    onPress,
    onDismiss,
    onCollapse,
    sheetProgress,
    windowHeight,
    theme.reducedMotion,
    dragStart,
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
