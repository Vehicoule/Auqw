import type { Recording, Settings } from '../domain.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import {
  isArtworkCacheEntry,
  isEntity,
  isEntitySourceRef,
  isExportDocument,
  isLyricsCacheEntry,
  isMatchReview,
  isPersistedState,
  isPlaylist,
  isPlaylistEntry,
  isPlayCount,
  isPlayEvent,
} from './library.ts';
import { assert } from '../testing/assert.ts';

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: 'US',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
};

const QUEUE: QueueSnapshot = {
  revision: 0,
  occurrences: [],
  currentOccurrenceId: null,
  positionMs: 0,
  mode: 'stopped',
};

const TRACK_REF = { provider: 'itunes', kind: 'track' as const, id: 'i1' };
const ALBUM_REF = { provider: 'deezer', kind: 'album' as const, id: 'd1' };

const RECORDING: Recording = {
  id: 'r1',
  title: 'Roads',
  artist: 'Portishead',
  album: 'Dummy',
  durationMs: 300_000,
  releaseYear: 1994,
  artwork: [],
  explicit: null,
  genre: null,
  isrc: null,
  versionLabels: [],
  sourceRefs: [TRACK_REF],
  mappings: [],
};

const ENTITY = {
  entityId: 'e-album',
  kind: 'album' as const,
  title: 'Dummy',
  artistName: 'Portishead',
  artwork: [],
  createdMs: 10,
};

const ENTITY_REF = {
  entityId: 'e-album',
  provider: 'deezer',
  ref: ALBUM_REF,
};

const PLAYLIST = {
  playlistId: 'p1',
  name: 'Favorites',
  createdMs: 20,
  updatedMs: 30,
};

const ENTRY = {
  entryId: 'pe1',
  playlistId: 'p1',
  recordingId: 'r1',
  position: 1,
  selectedRef: TRACK_REF,
  addedMs: 21,
};

const EVENT = {
  eventId: 'ev1',
  recordingId: 'r1',
  occurrenceId: null,
  playedMs: 100,
  listenedMs: 121_000,
};

const COUNT = { recordingId: 'r1', count: 3, lastMs: 100 };

const CANDIDATE = {
  metadata: {
    sourceRef: TRACK_REF,
    title: 'Roads',
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 300_000,
    releaseYear: 1994,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: 'US',
  },
  ref: TRACK_REF,
};

const REVIEW = {
  reviewId: 'mr1',
  recordingId: 'r1',
  candidates: [CANDIDATE],
  status: 'confirmed' as const,
  resolution: { ref: TRACK_REF },
  createdMs: 50,
  resolvedMs: 60,
};

const LYRICS = {
  recordingId: 'r1',
  provider: 'lyrics-lrclib',
  kind: 'synced' as const,
  payload: {
    plainLyrics: 'words',
    syncedLyrics: '[00:01.00] words',
    instrumental: false,
  },
  fetchedMs: 80,
};

const ARTWORK = {
  url: 'https://art.example/d.png',
  filePath: '/tmp/d.png',
  bytes: 1024,
  lastAccessedMs: 90,
};

function persisted(): Record<string, unknown> {
  return {
    recordings: [RECORDING],
    likes: [
      { entityKind: 'track', targetId: 'r1', likedAtMs: 7 },
      { entityKind: 'album', targetId: 'e-album', likedAtMs: 8 },
    ],
    entities: [ENTITY],
    entitySourceRefs: [ENTITY_REF],
    playlists: [PLAYLIST],
    playlistEntries: [
      ENTRY,
      { ...ENTRY, entryId: 'pe2', position: 2, selectedRef: null },
    ],
    playHistory: [EVENT],
    playCounts: [COUNT],
    matchReviews: [REVIEW],
    lyricsCache: [LYRICS],
    artworkCache: [ARTWORK],
    queue: QUEUE,
    settings: SETTINGS,
  };
}

function exportDoc(): Record<string, unknown> {
  const { sourceRefs: _refs, mappings: _mappings, ...core } = RECORDING;
  return {
    formatVersion: 1,
    exportedAtMs: 5_000,
    recordings: [core],
    sourceRefs: [{ recordingId: 'r1', ref: TRACK_REF }],
    mappings: [],
    likes: [{ entityKind: 'album', targetId: 'e-album', likedAtMs: 8 }],
    entities: [ENTITY],
    entitySourceRefs: [ENTITY_REF],
    playlists: [PLAYLIST],
    playlistEntries: [ENTRY],
    playHistory: [EVENT],
    playCounts: [COUNT],
    matchReviews: [REVIEW],
    settings: SETTINGS,
  };
}

function entities(): void {
  assert(isEntity(ENTITY));
  assert(isEntity({ ...ENTITY, kind: 'artist', artistName: null }));
  assert(!isEntity({ ...ENTITY, kind: 'track' }));
  assert(!isEntity({ ...ENTITY, entityId: '' }));
  assert(!isEntity({ ...ENTITY, extra: 1 }));
  assert(!isEntity({ ...ENTITY, createdMs: -1 }));
  assert(
    !isEntity({
      ...ENTITY,
      artwork: Array.from({ length: 9 }, () => ({
        url: 'https://a.example/x.png',
        width: null,
        height: null,
      })),
    }),
    'artwork list is bounded',
  );

  assert(isEntitySourceRef(ENTITY_REF));
  // The flat provider must mirror ref.provider — the table keys on it.
  assert(
    !isEntitySourceRef({ ...ENTITY_REF, provider: 'itunes' }),
    'provider mirror mismatch',
  );
  assert(
    !isEntitySourceRef({ ...ENTITY_REF, ref: TRACK_REF }),
    'entity refs must be album/artist kind',
  );

  assert(isPlaylist(PLAYLIST));
  assert(
    !isPlaylist({ ...PLAYLIST, updatedMs: 5 }),
    'updatedMs cannot precede createdMs',
  );
}

function entries(): void {
  assert(isPlaylistEntry(ENTRY));
  assert(isPlaylistEntry({ ...ENTRY, selectedRef: null }));
  assert(isPlaylistEntry({ ...ENTRY, position: 2.5 }));
  assert(
    !isPlaylistEntry({ ...ENTRY, position: Number.POSITIVE_INFINITY }),
    'position must be finite',
  );
  assert(
    !isPlaylistEntry({ ...ENTRY, selectedRef: ALBUM_REF }),
    'selectedRef stays a track ref',
  );

  assert(isPlayEvent(EVENT));
  assert(isPlayEvent({ ...EVENT, occurrenceId: 'occ-1' }));
  assert(!isPlayEvent({ ...EVENT, playedMs: -1 }));
  assert(!isPlayEvent({ ...EVENT, extra: 1 }));

  assert(isPlayCount(COUNT));
  assert(!isPlayCount({ ...COUNT, count: -1 }));
  assert(!isPlayCount({ ...COUNT, count: 1.5 }));
}

function reviews(): void {
  assert(isMatchReview(REVIEW));
  assert(
    isMatchReview({
      ...REVIEW,
      status: 'pending',
      resolution: null,
      resolvedMs: null,
    }),
    'pending is exactly the unresolved state',
  );
  assert(
    !isMatchReview({ ...REVIEW, status: 'pending' }),
    'pending cannot carry a resolution',
  );
  assert(
    !isMatchReview({
      ...REVIEW,
      status: 'dismissed',
      resolvedMs: null,
    }),
    'a resolved status needs resolvedMs',
  );
  assert(
    !isMatchReview({ ...REVIEW, candidates: [] }),
    'a review keeps at least one frozen candidate',
  );
  assert(!isMatchReview({ ...REVIEW, status: 'open' }));
}

function caches(): void {
  assert(isLyricsCacheEntry(LYRICS));
  assert(
    isLyricsCacheEntry({
      ...LYRICS,
      kind: 'plain',
      payload: { ...LYRICS.payload, syncedLyrics: null },
    }),
  );
  assert(
    !isLyricsCacheEntry({
      ...LYRICS,
      payload: { ...LYRICS.payload, syncedLyrics: null },
    }),
    'synced entries must carry timed lines',
  );

  assert(
    !isLyricsCacheEntry({ ...LYRICS, kind: 'karaoke' }),
    'kind is a closed enum',
  );

  assert(isArtworkCacheEntry(ARTWORK));
  assert(
    !isArtworkCacheEntry({ ...ARTWORK, url: 'http://art.example/d.png' }),
    'cached artwork URLs stay https',
  );
  assert(!isArtworkCacheEntry({ ...ARTWORK, bytes: -1 }));
}

function persistedState(): void {
  const doc = persisted();
  assert(isPersistedState(doc), 'valid document');

  assert(
    !isPersistedState({ ...doc, extra: [] }),
    'exact keys on the document',
  );
  assert(
    !isPersistedState({
      ...doc,
      likes: [{ entityKind: 'track', targetId: 'ghost', likedAtMs: 1 }],
    }),
    'track likes must name a recording',
  );
  assert(
    !isPersistedState({
      ...doc,
      likes: [{ entityKind: 'album', targetId: 'ghost', likedAtMs: 1 }],
    }),
    'entity likes must name an entity',
  );
  assert(
    !isPersistedState({
      ...doc,
      likes: [
        { entityKind: 'track', targetId: 'r1', likedAtMs: 1 },
        { entityKind: 'track', targetId: 'r1', likedAtMs: 2 },
      ],
    }),
    'duplicate (kind, target) likes rejected',
  );
  // The same recording twice keeps distinct row identities.
  assert(
    isPersistedState({
      ...doc,
      playlistEntries: [
        ENTRY,
        { ...ENTRY, entryId: 'pe2', position: 2, selectedRef: null },
      ],
    }),
    'duplicate recordings in a playlist are legal occurrences',
  );
  assert(
    !isPersistedState({
      ...doc,
      playlistEntries: [
        ENTRY,
        { ...ENTRY, entryId: 'pe2', position: 1, selectedRef: null },
      ],
    }),
    'positions are unique per playlist',
  );
  assert(
    !isPersistedState({
      ...doc,
      playlistEntries: [{ ...ENTRY, playlistId: 'ghost' }],
    }),
    'entries must name a playlist',
  );
  assert(
    !isPersistedState({
      ...doc,
      entitySourceRefs: [{ ...ENTITY_REF, entityId: 'ghost' }],
    }),
    'entity refs must name an entity',
  );
  assert(
    !isPersistedState({
      ...doc,
      entitySourceRefs: [
        ENTITY_REF,
        { ...ENTITY_REF, ref: { ...ALBUM_REF, id: 'd2' } },
      ],
    }),
    'one provider attachment per entity',
  );
  assert(
    !isPersistedState({
      ...doc,
      playHistory: [{ ...EVENT, recordingId: 'ghost' }],
    }),
    'history must name a recording',
  );
  assert(
    !isPersistedState({
      ...doc,
      playCounts: [COUNT, { ...COUNT, count: 9 }],
    }),
    'one count row per recording',
  );
  assert(
    !isPersistedState({
      ...doc,
      matchReviews: [{ ...REVIEW, recordingId: 'ghost' }],
    }),
    'reviews must name a recording',
  );
  assert(
    !isPersistedState({
      ...doc,
      lyricsCache: [{ ...LYRICS, recordingId: 'ghost' }],
    }),
    'lyrics cache must name a recording',
  );
  assert(
    !isPersistedState({
      ...doc,
      queue: {
        ...QUEUE,
        occurrences: [
          { occurrenceId: 'o1', recordingId: 'ghost', selectedRef: null },
        ],
      },
    }),
    'queue occurrences must name a recording',
  );
}

function exportDocument(): void {
  const doc = exportDoc();
  assert(isExportDocument(doc), 'valid export document');

  assert(
    !isExportDocument({ ...doc, formatVersion: 2 }),
    'only formatVersion 1',
  );
  assert(
    !isExportDocument({ ...doc, queue: [] }),
    'session state is not an export key',
  );
  assert(!isExportDocument({ ...doc, exportedAtMs: -1 }));
  assert(
    !isExportDocument({ ...doc, sourceRefs: [] }),
    'a recording needs at least one source ref after reassembly',
  );
  assert(
    !isExportDocument({
      ...doc,
      sourceRefs: [{ recordingId: 'ghost', ref: TRACK_REF }],
    }),
    'junction rows must name a recording',
  );
  assert(
    !isExportDocument({
      ...doc,
      sourceRefs: [
        { recordingId: 'r1', ref: TRACK_REF },
        { recordingId: 'r1', ref: TRACK_REF },
      ],
    }),
    'duplicate source refs rejected on reassembly',
  );
  assert(
    !isExportDocument({
      ...doc,
      sourceRefs: [{ recordingId: 'r1', ref: ALBUM_REF }],
    }),
    'recording source refs stay track refs',
  );
  assert(
    !isExportDocument({
      ...doc,
      recordings: [
        doc['recordings']?.[0],
        doc['recordings']?.[0],
      ],
    }),
    'duplicate recording ids rejected',
  );
  // Owned sections only: caches/queue/attempts have no place here.
  for (const key of ['lyricsCache', 'artworkCache', 'attempts', 'queue']) {
    assert(
      !isExportDocument({ ...doc, [key]: [] }),
      `${key} is not part of the owned document`,
    );
  }
}

export function run(): void {
  entities();
  entries();
  reviews();
  caches();
  persistedState();
  exportDocument();
}
