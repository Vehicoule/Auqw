import {
  isDownloadRecord,
  isEntityRef,
  isLocalFile,
  isLocalSource,
  isRecording,
  isSettings,
  isSourceRef,
  isTrackMetadata,
  isTrackRef,
  recordingFromMetadata,
} from './domain.ts';
import type {
  DownloadRecord,
  LocalFile,
  LocalSource,
  Settings,
  SourceRef,
  TrackMetadata,
} from './domain.ts';
import { assert, assertEqual } from './testing/assert.ts';

const REF: SourceRef = {
  provider: 'youtube-music',
  kind: 'track',
  id: 'dQw4w9WgXcQ',
};

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: 'US',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
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

  // Settings: artworkCacheBytes is optional but bounded when present.
  assert(isSettings(SETTINGS));
  assert(
    isSettings({ ...SETTINGS, artworkCacheBytes: 200 * 1024 * 1024 }),
  );
  assert(
    !isSettings({ ...SETTINGS, artworkCacheBytes: 8 * 1024 * 1024 }),
    'below the 16 MB floor',
  );
  assert(
    !isSettings({
      ...SETTINGS,
      artworkCacheBytes: 2 * 1024 * 1024 * 1024,
    }),
    'above the 1 GB cap',
  );
  assert(
    !isSettings({ ...SETTINGS, artworkCacheBytes: 1.5 }),
    'non-integer rejected',
  );
  assert(!isSettings({ ...SETTINGS, stray: true }));

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
  assert(
    isSettings({ ...settings, downloadMetered: true }),
    'metered downloads opt-in is a boolean',
  );
  assert(!isSettings({ ...settings, downloadMetered: 1 }));

  assertEqual(recording.provenance, 'provider', 'provider minted');
  assert(
    !isRecording({ ...recording, provenance: 'external' }),
    'provenance is a closed enum',
  );
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

  // Slice-3 records: downloads, local sources, local files.
  const download: DownloadRecord = {
    downloadId: 'dl-1',
    recordingId: 'rec-1',
    provider: 'itunes',
    sourceRef: REF,
    filePath: '/downloads/rec-1.m4a',
    bytes: 4_194_304,
    state: 'available',
    committedOffset: 4_194_304,
    checksum: 'a'.repeat(64),
    mime: 'audio/mp4',
    itag: 140,
    expiresAtMs: 500_000,
    error: null,
    priority: 2,
    requestedMs: 100,
    downloadedMs: 200,
  };
  assert(isDownloadRecord(download));
  assert(
    !isDownloadRecord({ ...download, state: 'deleted' }),
    'download state is a closed enum',
  );
  assert(
    !isDownloadRecord({ ...download, committedOffset: download.bytes + 1 }),
    'resume offset cannot exceed the file',
  );
  assert(
    !isDownloadRecord({ ...download, checksum: 'not-hex' }),
    'checksum is sha-256 hex',
  );
  assert(
    !isDownloadRecord({
      ...download,
      state: 'available' as const,
      downloadedMs: null,
    }),
    'an available download carries its completion stamp',
  );
  assert(
    isDownloadRecord({
      ...download,
      state: 'failed_with_retry' as const,
      downloadedMs: null,
      error: { kind: 'storage-full', message: 'disk full' },
    }),
  );
  assert(
    !isDownloadRecord({
      ...download,
      error: { kind: 'x'.repeat(65), message: 'k' },
    }),
  );
  assert(!isDownloadRecord({ ...download, extra: true }));

  const source: LocalSource = {
    sourceId: 'src-1',
    treeUri: 'content://com.android.externalstorage.documents/tree/music',
    label: 'Music',
    addedMs: 10,
    lastScanMs: null,
  };
  assert(isLocalSource(source));
  assert(isLocalSource({ ...source, lastScanMs: 20 }));
  assert(!isLocalSource({ ...source, lastScanMs: -1 }));
  assert(!isLocalSource({ ...source, treeUri: '' }));

  const file: LocalFile = {
    fileId: 'lf-1',
    sourceId: 'src-1',
    docId: 'doc-9',
    size: 4_194_304,
    fingerprint: 'fp-abc',
    title: 'Song',
    artist: null,
    album: null,
    durationMs: null,
    genre: null,
    recordingId: 'rec-1',
  };
  assert(isLocalFile(file));
  assert(
    isLocalFile({
      ...file,
      title: null,
      durationMs: 300_000,
      genre: 'Rock',
    }),
  );
  assert(!isLocalFile({ ...file, size: -1 }));
  assert(!isLocalFile({ ...file, durationMs: 1.5 }));
}
