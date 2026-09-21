import { useMemo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { useTheme } from './theme.tsx';
import {
  IconButton,
  PlayPauseIcon,
  Pressable,
  Spinner,
  Text,
} from './primitives.tsx';
import { ArtworkRing } from './progress.tsx';
import type { PlatformVariant, PlayerModel } from './view-models.ts';

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
}: MiniPlayerProps) {
  const theme = useTheme();
  const ios = platform === 'ios';
  const progress =
    player.durationMs === null || player.durationMs <= 0
      ? 0
      : Math.min(1, Math.max(0, player.positionMs / player.durationMs));
  const busy = player.status === 'preparing' || player.status === 'buffering';
  // Stable gesture object — a fresh Pan() per render would cancel an
  // in-flight swipe when the position tick re-renders the row.
  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-12, 12])
        .activeOffsetY([-24, 24])
        .onEnd((e) => {
          if (e.translationX < -40 && onNext !== undefined) {
            scheduleOnRN(onNext);
          } else if (e.translationX > 40 && onPrevious !== undefined) {
            scheduleOnRN(onPrevious);
          } else if (e.translationY > 40 && onDismiss !== undefined) {
            scheduleOnRN(onDismiss);
          } else if (e.translationY < -40 && onPress !== undefined) {
            scheduleOnRN(onPress);
          }
        }),
    [onNext, onPrevious, onPress, onDismiss],
  );
  return (
    <GestureDetector gesture={swipe}>
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
            accessibilityLabel={`now playing, ${player.title}${player.artist === null ? '' : `, ${player.artist}`
              }, ${player.status}, open player`}
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
              platform={platform}
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
              accessibilityLabel={player.liked ? 'unlike' : 'like'}
              onPress={onToggleLike}
            />
          )}
          <Pressable
            compact
            onPress={onPlayPause}
            accessibilityLabel={player.status === 'playing' ? 'pause' : 'play'}
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
                playing={player.status === 'playing'}
                size={16}
                color={ios ? theme.colors.textBright : theme.colors.accent}
              />
            )}
          </Pressable>
        </View>
      </View>
    </GestureDetector>
  );
}
