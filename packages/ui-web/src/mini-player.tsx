import {
  IconButton,
  PlayPauseIcon,
  Pressable,
  Spinner,
  Text,
} from './primitives.tsx';
import { ArtworkRing } from './progress.tsx';
import { t } from '@auqw/ui-shared';
import type { PlayerModel } from '@auqw/ui-shared';

export type MiniPlayerProps = {
  readonly player: PlayerModel;
  readonly onPress?: (() => void) | undefined;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  /** Dismiss stops playback; the queue keeps its items. */
  readonly onDismiss?: (() => void) | undefined;
};

// The native swipe gestures become visible affordances on desktop:
// previous/next icons flank play, dismiss is an explicit close.
export function MiniPlayer({
  player,
  onPress,
  onPlayPause,
  onNext,
  onPrevious,
  onToggleLike,
  onDismiss,
}: MiniPlayerProps) {
  const progress =
    player.durationMs === null || player.durationMs <= 0
      ? 0
      : Math.min(1, Math.max(0, player.positionMs / player.durationMs));
  const busy = player.status === 'preparing' || player.status === 'buffering';
  return (
    <div className="uw-mini" data-status={player.status}>
      <Pressable
        onPress={onPress}
        ariaLabel={t('player.a11y.nowPlaying', {
          title: player.title,
          artist: player.artist === null ? '' : t('track.a11y.artistSuffix', { artist: player.artist }),
          status: t(`player.status.${player.status}`),
        })}
        className="uw-mini__open"
      >
        <ArtworkRing artworkUrl={player.artworkUrl} progress={progress} />
        <span className="uw-mini__text">
          <Text variant="body" color="bright" numberOfLines={1}>
            {player.title}
          </Text>
          <Text variant="metadata" color="secondary" numberOfLines={1}>
            {player.artist ?? '—'}
          </Text>
        </span>
      </Pressable>
      {onPrevious !== undefined && (
        <IconButton
          icon="previous"
          size={30}
          iconSize={13}
          ariaLabel={t('common.previous')}
          onPress={onPrevious}
        />
      )}
      <Pressable
        onPress={onPlayPause}
        ariaLabel={player.status === 'playing' ? t('common.pause') : t('common.play')}
        className="uw-mini__play"
      >
        {busy ? (
          <Spinner size={14} color="var(--accent)" />
        ) : (
          <PlayPauseIcon
            playing={player.status === 'playing'}
            size={16}
            color="var(--accent)"
          />
        )}
      </Pressable>
      {onNext !== undefined && (
        <IconButton
          icon="next"
          size={30}
          iconSize={13}
          ariaLabel={t('common.next')}
          onPress={onNext}
        />
      )}
      {onToggleLike !== undefined && (
        <IconButton
          icon={player.liked ? 'heart-filled' : 'heart'}
          size={30}
          iconSize={14}
          color={player.liked ? 'var(--liked)' : 'var(--text-secondary)'}
          ariaLabel={player.liked ? t('common.unlike') : t('common.like')}
          onPress={onToggleLike}
        />
      )}
      {onDismiss !== undefined && (
        <IconButton
          icon="close"
          size={30}
          iconSize={12}
          ariaLabel={t('player.a11y.stopDismiss')}
          onPress={onDismiss}
        />
      )}
    </div>
  );
}
