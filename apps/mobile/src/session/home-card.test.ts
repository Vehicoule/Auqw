import type { TrackMetadata } from '@auqw/application';
import type { RailCardModel } from '@auqw/ui-native';
import { activateHomeCard } from './home-card.ts';

const suggestion: TrackMetadata = {
  sourceRef: { provider: 'youtube-music', kind: 'track', id: 'song-1' },
  title: 'Song',
  artist: 'Artist',
  album: null,
  durationMs: null,
  releaseYear: null,
  artwork: [],
  explicit: null,
  genre: null,
  storefront: null,
};
const suggestionCard: RailCardModel = {
  key: 'youtube-music:song-1',
  title: 'Song',
  subtitle: 'Artist',
  artworkUrl: null,
};
const likedCard: RailCardModel = {
  key: 'rec-1',
  title: 'A liked song',
  subtitle: null,
  artworkUrl: null,
};

export function runHomeCard(): void {
  const calls: string[] = [];
  const actions = {
    canPlayMetadata: () => true,
    playMetadata: (metadata: TrackMetadata) =>
      calls.push(`metadata:${metadata.sourceRef.id}`),
    playRecording: (id: string) => calls.push(`recording:${id}`),
  };
  activateHomeCard(suggestionCard, [likedCard], [suggestion], actions);
  assertCalls(calls, ['metadata:song-1'], 'provider suggestion plays via metadata');

  activateHomeCard(likedCard, [likedCard], [suggestion], actions);
  assertCalls(calls, ['metadata:song-1', 'recording:rec-1'], 'liked card uses local id');

  activateHomeCard(suggestionCard, [likedCard], [], actions);
  assertCalls(calls, ['metadata:song-1', 'recording:rec-1'], 'stale suggestion cannot enqueue');

  activateHomeCard(suggestionCard, [likedCard], [suggestion], {
    ...actions,
    canPlayMetadata: () => false,
  });
  assertCalls(calls, ['metadata:song-1', 'recording:rec-1'], 'unowned offline suggestion cannot play');
}

function assertCalls(actual: string[], expected: string[], context: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${context}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
