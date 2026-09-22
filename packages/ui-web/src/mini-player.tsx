import {
  IconButton,
  PlayPauseIcon,
  Pressable,
  Spinner,
  Text,
} from './primitives.tsx';
import { ArtworkRing } from './progress.tsx';
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
        ariaLabel={`now playing, ${player.title}${player.artist === null ? '' : `, ${player.artist}`}, ${player.status}, open player`}
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
          ariaLabel="previous"
          onPress={onPrevious}
        />
      )}
      <Pressable
        onPress={onPlayPause}
        ariaLabel={player.status === 'playing' ? 'pause' : 'play'}
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
          ariaLabel="next"
          onPress={onNext}
        />
      )}
      {onToggleLike !== undefined && (
        <IconButton
          icon={player.liked ? 'heart-filled' : 'heart'}
          size={30}
          iconSize={14}
          color={player.liked ? 'var(--liked)' : 'var(--text-secondary)'}
          ariaLabel={player.liked ? 'unlike' : 'like'}
          onPress={onToggleLike}
        />
      )}
      {onDismiss !== undefined && (
        <IconButton
          icon="close"
          size={30}
          iconSize={12}
          ariaLabel="stop and dismiss"
          onPress={onDismiss}
        />
      )}
    </div>
  );
}
