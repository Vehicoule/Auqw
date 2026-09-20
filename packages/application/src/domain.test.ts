import {
  isEntityRef,
  isRecording,
  isSettings,
  isSourceRef,
  isTrackMetadata,
  isTrackRef,
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
  assert(!isSourceRef({ ...REF, kind: 'playlist' }));
  assert(!isSourceRef({ ...REF, id: '' }));
  assert(!isSourceRef({ ...REF, extra: 1 }));
  assert(!isSourceRef('dQw4w9WgXcQ'));
  assert(!isSourceRef(null));

  // Kind is a union now: album/artist refs are valid source refs but
  // never valid where a track ref is required.
  const albumRef = { ...REF, kind: 'album' as const };
  assert(isSourceRef(albumRef));
  assert(!isTrackRef(albumRef));
  assert(isEntityRef(albumRef));
  assert(isTrackRef(REF));
  assert(!isEntityRef(REF));

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

  // ABI 0.3.0 optional evidence: entity refs and isrc may be absent
  // or null, but a malformed value rejects the record.
  const artistRef = { provider: 'deezer', kind: 'artist' as const, id: 'x' };
  assert(
    isTrackMetadata({ ...META, artistRef, albumRef, isrc: 'USRC17607839' }),
  );
  assert(
    isTrackMetadata({ ...META, artistRef: null, albumRef: null, isrc: null }),
  );
  assert(!isTrackMetadata({ ...META, artistRef: REF }), 'track ref rejected');
  assert(!isTrackMetadata({ ...META, albumRef: 'al1' }));
  assert(!isTrackMetadata({ ...META, isrc: 42 }));
  assert(!isTrackMetadata({ ...META, isrc: '' }));
  assert(!isTrackMetadata({ ...META, isrc: 'x'.repeat(65) }));

  const recording = recordingFromMetadata(META, 'rec-1');
  assert(isRecording(recording));
  assertEqual(recording.id, 'rec-1');
  assertEqual(recording.title, 'Roads (Live)');
  assert(recording.versionLabels.includes('live'));
  assertEqual(recording.sourceRefs.length, 1);
  assertEqual(recording.mappings.length, 0);
  assertEqual(recording.isrc, null);
  // Provider-supplied isrc lands on the recording.
  const withIsrc = recordingFromMetadata(
    { ...META, isrc: 'USRC17607839' },
    'rec-2',
  );
  assertEqual(withIsrc.isrc, 'USRC17607839');

  // Settings optional provider overrides: absent or null, otherwise
  // a provider id; malformed values reject.
  const settings = {
    catalogProvider: 'itunes',
    playbackProvider: 'youtube-music',
    storefront: 'US',
    qualityKbps: 256,
    theme: 'system' as const,
    prefetch: true,
  };
  assert(isSettings(settings));
  assert(
    isSettings({ ...settings, lyricsProvider: 'lyrics-lrclib' }),
  );
  assert(
    isSettings({
      ...settings,
      lyricsProvider: null,
      radioProvider: 'youtube-music',
    }),
  );
  assert(!isSettings({ ...settings, lyricsProvider: 7 }));
  assert(!isSettings({ ...settings, radioProvider: '' }));
  assert(!isSettings({ ...settings, strayProvider: 'x' }));

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
      sourceRefs: [{ provider: 'deezer', kind: 'album', id: 'a1' }],
    }),
    'recording source refs must be track refs',
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
