import { useMemo } from 'react';
import { Platform, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useTheme } from './theme.tsx';
import {
  Icon,
  IconButton,
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
};

export function MiniPlayer({
  player,
  platform = Platform.OS === 'ios' ? 'ios' : 'android',
  onPress,
  onPlayPause,
  onNext,
  onPrevious,
  onToggleLike,
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
            runOnJS(onNext)();
          } else if (e.translationX > 40 && onPrevious !== undefined) {
            runOnJS(onPrevious)();
          } else if (e.translationY < -40 && onPress !== undefined) {
            runOnJS(onPress)();
          }
        }),
    [onNext, onPrevious, onPress],
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
        {ios && (
          <BlurView
            intensity={60}
            tint={theme.scheme === 'light' ? 'light' : 'dark'}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
            }}
          />
        )}
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
                style={{ fontSize: 11.5, fontFamily: theme.fontFamilies.medium }}
              >
                {player.title}
              </Text>
              <Text
                variant="metadata"
                color="secondary"
                numberOfLines={1}
                style={{ fontSize: 9 }}
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
                ? 'rgba(255,255,255,0.12)'
                : theme.colors.accentSoft,
              borderWidth: ios ? theme.strokes.hairline : 0,
              borderColor: theme.colors.hairline,
            }}
          >
            {busy ? (
              <Spinner size={14} color={ios ? theme.colors.textBright : theme.colors.accent} />
            ) : (
              <Icon
                name={player.status === 'playing' ? 'pause' : 'play'}
                size={16}
                color={ios ? theme.colors.textBright : theme.colors.accent}
                filled
              />
            )}
          </Pressable>
        </View>
        <View
          accessible={false}
          style={{
            height: theme.strokes.progress,
            backgroundColor: theme.colors.fg18,
          }}
        >
          <View
            style={{
              height: theme.strokes.progress,
              width: `${progress * 100}%`,
              backgroundColor: theme.colors.accent,
            }}
          />
        </View>
      </View>
    </GestureDetector>
  );
}
