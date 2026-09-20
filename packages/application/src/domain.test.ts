import {
  isRecording,
  isSourceRef,
  isTrackMetadata,
  recordingFromMetadata,
} from './domain.ts';
import type { SourceRef, TrackMetadata } from './domain.ts';
import { assert, assertEqual } from './testing/assert.ts';

const REF: SourceRef = {
  provider: 'youtube-music',
  kind: 'track',
  id: 'dQw4w9WgXcQ',
};

const META: TrackMetadata = {
  sourceRef: REF,
  title: 'Roads (Live)',
  artist: 'Portishead',
  album: 'Roseland NYC Live',
  durationMs: 300_000,
  releaseYear: 1998,
  artwork: [{ url: 'https://img/x.jpg', width: 120, height: 120 }],
  explicit: null,
  genre: 'Trip-hop',
  storefront: 'US',
};

export function run(): void {
  assert(isSourceRef(REF));
  assert(!isSourceRef({ ...REF, kind: 'album' }));
  assert(!isSourceRef({ ...REF, id: '' }));
  assert(!isSourceRef({ ...REF, extra: 1 }));
  assert(!isSourceRef('dQw4w9WgXcQ'));
  assert(!isSourceRef(null));

  assert(isTrackMetadata(META));
  assert(!isTrackMetadata({ ...META, title: '' }));
  assert(!isTrackMetadata({ ...META, title: 'x'.repeat(513) }));
  assert(!isTrackMetadata({ ...META, durationMs: -1 }));
  assert(!isTrackMetadata({ ...META, durationMs: 1.5 }));
  assert(
    !isTrackMetadata({
      ...META,
      artwork: [{ url: 'http://img/x.jpg', width: 1, height: 1 }],
    }),
  );
  assert(
    !isTrackMetadata({
      ...META,
      artwork: [{ url: 'https://img/x.jpg', width: 0, height: 1 }],
    }),
  );
  assert(
    isTrackMetadata({
      ...META,
      artwork: [{ url: 'https://img/x.jpg', width: null, height: null }],
    }),
  );
  assert(!isTrackMetadata({ ...META, stray: true }));

  // Inherited properties must not satisfy required keys.
  const inherited = Object.create(META) as Record<string, unknown>;
  assert(!isTrackMetadata(inherited), 'inherited keys are not own keys');
  const inheritedRef = Object.create(REF) as Record<string, unknown>;
  assert(!isSourceRef(inheritedRef));

  // Storefront follows the wire contract: null or /^[A-Z]{2}$/.
  assert(isTrackMetadata({ ...META, storefront: 'US' }));
  assert(!isTrackMetadata({ ...META, storefront: 'us' }));
  assert(!isTrackMetadata({ ...META, storefront: 'USA' }));
  assert(!isTrackMetadata({ ...META, storefront: 'U1' }));

  const recording = recordingFromMetadata(META, 'rec-1');
  assert(isRecording(recording));
  assertEqual(recording.id, 'rec-1');
  assertEqual(recording.title, 'Roads (Live)');
  assert(recording.versionLabels.includes('live'));
  assertEqual(recording.sourceRefs.length, 1);
  assertEqual(recording.mappings.length, 0);
  assertEqual(recording.isrc, null);

  assert(!isRecording({ ...recording, id: '' }));
  assert(!isRecording({ ...recording, versionLabels: ['bogus'] }));
  assert(
    !isRecording({ ...recording, versionLabels: ['live', 'live'] }),
    'duplicate labels rejected',
  );
  assert(
    !isRecording({ ...recording, sourceRefs: [] }),
    'recordings need at least one source ref',
  );
  assert(
    !isRecording({
      ...recording,
      mappings: [
        {
          ref: REF,
          status: 'user-confirmed',
          matchedAtMs: 1,
          evidence: {
            titleSimilarity: 1.5,
            artistSimilarity: null,
            durationDeltaMs: null,
            exactIsrc: false,
            score: 0,
            versionLabels: [],
          },
        },
      ],
    }),
  );
}
