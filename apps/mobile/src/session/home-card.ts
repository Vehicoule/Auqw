import type { TrackMetadata } from '@auqw/application';
import type { RailCardModel } from '@auqw/ui-native';

type HomeCardActions = {
  readonly canPlayMetadata: (metadata: TrackMetadata) => boolean;
  readonly playMetadata: (metadata: TrackMetadata) => void;
  readonly playRecording: (recordingId: string) => void;
};

/**
 * A liked card carries a materialized recording id; a search-sourced
 * suggestion carries a provider ref. Do not enqueue that ref as an id.
 */
export function activateHomeCard(
  card: RailCardModel,
  likedCards: readonly RailCardModel[],
  suggestions: readonly TrackMetadata[],
  actions: HomeCardActions,
): void {
  if (likedCards.some((liked) => liked.key === card.key)) {
    actions.playRecording(card.key);
    return;
  }
  const metadata = suggestions.find(
    (item) =>
      `${item.sourceRef.provider}:${item.sourceRef.id}` === card.key,
  );
  if (metadata !== undefined && actions.canPlayMetadata(metadata)) {
    actions.playMetadata(metadata);
  }
}
