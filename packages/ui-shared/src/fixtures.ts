import type {
  AppError,
  Entity,
  EntityPage,
  EntityRef,
  EntitySourceRef,
  ExportDocument,
  ImportPreview,
  Like,
  MatchReview,
  Playlist,
  PlaylistEntry,
  PlayCount,
  PlayEvent,
  QueueSnapshot,
  RadioTail,
  Recording,
  SessionPlayback,
  Settings,
  SyncClientStatus,
  TrackMetadata,
  WaveformPeak,
} from '@auqw/application';
import { PEAKS_RESOLUTION } from './peaks.ts';
import type { ThemeName } from '@auqw/design-tokens';
import {
  collectionTiles,
  toCollectionModel,
  toCorrectionsModel,
  toSyncModel,
  toEntityModel,
  toImportPreviewModel,
  toLibraryModel,
  toPlaylistModel,
  toQueueModel,
  toRailCard,
  toRadioModel,
  toSearchRowModel,
  toSettingsModel,
  toTrackRowModel,
} from './view-models.ts';
import type {
  CollectionModel,
  CorrectionsFilter,
  CorrectionsModel,
  DiagnosticsModel,
  EntityScreenModel,
  HomeModel,
  ImportPreviewModel,
  LibraryModel,
  NavItemModel,
  PlatformVariant,
  PlayerModel,
  PlaylistModel,
  LyricsModel,
  QueueModel,
  RadioModel,
  SearchStateModel,
  SyncModel,
  TrackRowModel,
  TransferModel,
} from './view-models.ts';

// Embedded solid-color tiles: the gallery must render artwork without a
// network fetch — remote fixture URLs make previews environment-dependent
// and leak requests to a third-party service.
const FIXTURE_ART: readonly string[] = [
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOklEQVR42u3OMQ0AAAgDsOlHD+I4cUE4mlRAUz2vREhISEhISEhISEhISEhISEhISEhISEhISEjozgKnRuce5WwdswAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOklEQVR42u3OMQ0AAAgDsGnnxS0KcEE4mlRAM12vREhISEhISEhISEhISEhISEhISEhISEhISEjozgIDaPgAaWZTuAAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOUlEQVR42u3OQQkAAAgEsOtqZ9sIthAfgwVYpuuVCAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQndWe/N5x5HaL7OAAAAAElFTkSuQmCC',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOklEQVR42u3OQQ0AAAgEoKtuCEPZyhbOBxsBSE2/EiEhISEhISEhISEhISEhISEhISEhISEhISGhOwt5qdfxCeKZnAAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOklEQVR42u3OMQ0AAAgDsOnHF6L4cEE4mlRA0zWvREhISEhISEhISEhISEhISEhISEhISEhISEjozgJieYktqP5RtwAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOklEQVR42u3OQQ0AAAgEoIttVTsYwhbOBxsBSPW8EiEhISEhISEhISEhISEhISEhISEhISEhISGhOwsLfSYttHwdlwAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAO0lEQVR42u3OMQ0AAAgDsPlXghM8ceGCcDSpgKZ6XomQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ0J0FmQSyPMwe2B4AAAAASUVORK5CYII=',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOklEQVR42u3OQQkAAAgEsOufVAQ72EJ8DBZgqZ5XIiQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCR0ZwFG1bhpEAPfAAAAAABJRU5ErkJggg==',
];

function art(seed: string): string {
  let hash = 0;
  for (const ch of seed) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  const tile = FIXTURE_ART[Math.abs(hash) % FIXTURE_ART.length];
  if (tile === undefined) {
    throw new Error('fixture art palette is empty');
  }
  return tile;
}

function recording(partial: {
  id: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  durationMs?: number | null;
  releaseYear?: number | null;
  artSeed?: string | null;
  explicit?: boolean | null;
  genre?: string | null;
  versionLabels?: Recording['versionLabels'];
  provider?: string;
  providerId?: string;
}): Recording {
  const provider = partial.provider ?? 'youtube-music';
  return {
    id: partial.id,
    title: partial.title,
    artist: partial.artist ?? null,
    album: partial.album ?? null,
    durationMs: partial.durationMs ?? null,
    releaseYear: partial.releaseYear ?? null,
    artwork:
      partial.artSeed === null || partial.artSeed === undefined
        ? []
        : [
          {
            url: art(partial.artSeed),
            width: 300,
            height: 300,
          },
        ],
    explicit: partial.explicit ?? null,
    genre: partial.genre ?? null,
    isrc: null,
    versionLabels: partial.versionLabels ?? [],
    sourceRefs: [
      {
        provider,
        kind: 'track',
        id: partial.providerId ?? `${provider}-${partial.id}`,
      },
    ],
    mappings: [],
    provenance: 'provider',
  };
}

function trackMeta(partial: {
  provider: string;
  id: string;
  title: string;
  artist: string | null;
  durationMs: number | null;
  album?: string | null;
  releaseYear?: number | null;
  artSeed?: string;
  explicit?: boolean | null;
  albumRef?: EntityRef;
  artistRef?: EntityRef;
}): TrackMetadata {
  return {
    sourceRef: { provider: partial.provider, kind: 'track', id: partial.id },
    title: partial.title,
    artist: partial.artist,
    album: partial.album ?? null,
    durationMs: partial.durationMs,
    releaseYear: partial.releaseYear ?? null,
    artwork:
      partial.artSeed === undefined
        ? []
        : [{ url: art(partial.artSeed), width: 300, height: 300 }],
    explicit: partial.explicit ?? null,
    genre: null,
    storefront: 'AU',
    ...(partial.albumRef === undefined ? {} : { albumRef: partial.albumRef }),
    ...(partial.artistRef === undefined ? {} : { artistRef: partial.artistRef }),
  };
}

export const fixtureRecordings: readonly Recording[] = [
  recording({
    id: 'rec-self-aware',
    title: 'Self Aware',
    artist: 'Temper City',
    album: 'Self Aware',
    durationMs: 180_000,
    releaseYear: 2024,
    artSeed: 'self-aware',
    versionLabels: ['remaster'],
  }),
  recording({
    id: 'rec-petit',
    title: 'Le Petit Pêcheur',
    artist: 'Manon Lisa',
    album: 'Marées',
    durationMs: 221_000,
    releaseYear: 2023,
    artSeed: 'petit',
  }),
  recording({
    id: 'rec-dracula',
    title: 'Dracula',
    artist: 'Tame Impala',
    album: 'Deadbeat',
    durationMs: 242_000,
    releaseYear: 2025,
    artSeed: 'dracula',
    explicit: false,
  }),
  recording({
    id: 'rec-maladie',
    title: 'Maladie',
    artist: 'Mauvais Djo',
    album: null,
    durationMs: 178_000,
    releaseYear: 2024,
    artSeed: 'maladie',
  }),
  recording({
    id: 'rec-roads',
    title: 'Roads',
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 297_000,
    releaseYear: 1994,
    artSeed: 'roads',
  }),
  recording({
    id: 'rec-religion',
    title: 'New Religion',
    artist: null,
    album: null,
    durationMs: 211_000,
    releaseYear: null,
    artSeed: 'religion',
  }),
  recording({
    id: 'rec-cjk',
    title: '夜のドライブ (midnight drive)',
    artist: ' metropolitan echo 都会の残響',
    album: '都会の残響',
    durationMs: 196_000,
    releaseYear: 2024,
    artSeed: 'cjk',
  }),
  recording({
    id: 'rec-long',
    title:
      'A Very Long Track Title That Keeps Going Far Past The Edge Of Any Reasonable Row Width',
    artist: 'The Extraordinarily Verbose Ensemble Orchestra',
    album: 'Deluxe Extended Remastered Anniversary Edition',
    durationMs: 412_000,
    releaseYear: 2022,
    artSeed: 'long',
    explicit: true,
  }),
  recording({
    id: 'rec-noart',
    title: 'Silent Sleeve',
    artist: 'Unknown Covers',
    album: 'No Artwork At All',
    durationMs: 154_000,
    releaseYear: 2021,
    artSeed: null,
  }),
];

const like = (
  entityKind: Like['entityKind'],
  targetId: string,
  likedAtMs: number,
): Like => ({ entityKind, targetId, likedAtMs });

export const fixtureLikes: readonly Like[] = [
  like('track', 'rec-self-aware', 1_700_000_300_000),
  like('track', 'rec-petit', 1_700_000_200_000),
  like('track', 'rec-roads', 1_700_000_100_000),
  like('album', 'entity-deadbeat', 1_700_000_180_000),
  like('artist', 'entity-portishead', 1_700_000_160_000),
  like('album', 'entity-orphan', 1_700_000_120_000),
];

const ownedEntity = (
  entityId: string,
  kind: Entity['kind'],
  title: string,
  artistName: string | null,
  artSeed: string | null,
  createdMs: number,
): Entity => ({
  entityId,
  kind,
  title,
  artistName,
  artwork:
    artSeed === null ? [] : [{ url: art(artSeed), width: 300, height: 300 }],
  createdMs,
});

// Owned album/artist entities — the ownable grid renders the liked
// ones as cards and the artist in the followed rail.
export const fixtureEntities: readonly Entity[] = [
  ownedEntity('entity-deadbeat', 'album', 'Deadbeat', 'Tame Impala', 'dracula', 1_700_000_050_000),
  ownedEntity('entity-portishead', 'artist', 'Portishead', null, 'roads', 1_700_000_040_000),
  // Owned but unreferenced: no provider ref means the card renders
  // unopenable — an honest absence, not a fake link.
  ownedEntity('entity-orphan', 'album', 'Orphaned Pressing', 'Lost & Found', null, 1_699_000_000_000),
];

const DZ_ALBUM_DEADBEAT: EntityRef = {
  provider: 'deezer',
  kind: 'album',
  id: 'dz-album-deadbeat',
};
const DZ_ARTIST_TAME: EntityRef = {
  provider: 'deezer',
  kind: 'artist',
  id: 'dz-artist-tame',
};
const DZ_ARTIST_PORTISHEAD: EntityRef = {
  provider: 'deezer',
  kind: 'artist',
  id: 'dz-artist-portishead',
};

export const fixtureEntitySourceRefs: readonly EntitySourceRef[] = [
  {
    entityId: 'entity-deadbeat',
    provider: 'deezer',
    ref: DZ_ALBUM_DEADBEAT,
  },
  {
    entityId: 'entity-portishead',
    provider: 'deezer',
    ref: DZ_ARTIST_PORTISHEAD,
  },
];

// The orphan entity is liked but carries no EntitySourceRef — its
// card must render unopenable (honest absence, never a fake link).

const playlist = (
  playlistId: string,
  name: string,
  createdMs: number,
  updatedMs: number,
): Playlist => ({ playlistId, name, createdMs, updatedMs });

export const fixturePlaylists: readonly Playlist[] = [
  playlist('pl-late-night', 'late night drives', 1_699_000_000_000, 1_700_000_250_000),
  playlist('pl-morning', 'morning slow', 1_699_500_000_000, 1_700_000_150_000),
  playlist('pl-fresh', 'fresh ideas', 1_700_000_400_000, 1_700_000_400_000),
];

const playlistEntry = (
  entryId: string,
  playlistId: string,
  recordingId: string,
  position: number,
  addedMs: number,
  selectedRef: PlaylistEntry['selectedRef'] = null,
): PlaylistEntry => ({
  entryId,
  playlistId,
  recordingId,
  position,
  selectedRef,
  addedMs,
});

// `pe-3` repeats `pe-1`'s recording — duplicates are occurrences and
// must keep entryId row identity; `pe-3` also pins a selectedRef.
export const fixturePlaylistEntries: readonly PlaylistEntry[] = [
  playlistEntry('pe-1', 'pl-late-night', 'rec-dracula', 1, 1_700_000_210_000),
  playlistEntry('pe-2', 'pl-late-night', 'rec-roads', 2, 1_700_000_220_000),
  playlistEntry('pe-3', 'pl-late-night', 'rec-dracula', 3, 1_700_000_250_000, {
    provider: 'youtube-music',
    kind: 'track',
    id: 'ytm-dracula-pinned',
  }),
  playlistEntry('pe-4', 'pl-morning', 'rec-petit', 1, 1_700_000_160_000),
  playlistEntry('pe-5', 'pl-morning', 'rec-cjk', 2, 1_700_000_170_000),
];

const playEvent = (
  eventId: string,
  recordingId: string,
  occurrenceId: string | null,
  playedMs: number,
  listenedMs: number,
): PlayEvent => ({ eventId, recordingId, occurrenceId, playedMs, listenedMs });

// Deliberately unordered — the model must sort newest-first, and
// `pev-1`/`pev-3` repeat one recording as separate event rows.
export const fixturePlayHistory: readonly PlayEvent[] = [
  playEvent('pev-4', 'rec-petit', null, 1_700_000_700_000, 200_000),
  playEvent('pev-1', 'rec-dracula', 'occ-3', 1_700_001_000_000, 240_000),
  playEvent('pev-3', 'rec-dracula', 'occ-9', 1_700_000_800_000, 240_000),
  playEvent('pev-2', 'rec-self-aware', 'occ-1', 1_700_000_900_000, 180_000),
];

// `pc-ghost` counts a deleted recording — topPlayed drops it honestly.
export const fixturePlayCounts: readonly PlayCount[] = [
  { recordingId: 'rec-dracula', count: 12, lastMs: 1_700_001_000_000 },
  { recordingId: 'rec-self-aware', count: 9, lastMs: 1_700_000_900_000 },
  { recordingId: 'rec-petit', count: 5, lastMs: 1_700_000_700_000 },
  { recordingId: 'rec-roads', count: 3, lastMs: 1_699_999_000_000 },
  { recordingId: 'rec-ghost', count: 99, lastMs: 1_800_000_000_000 },
];

export const fixtureUnavailableIds: ReadonlySet<string> = new Set([
  'rec-roads',
]);

const occ = (
  occurrenceId: string,
  recordingId: string,
): QueueSnapshot['occurrences'][number] => ({
  occurrenceId,
  recordingId,
  selectedRef: null,
});

export const fixtureQueue: QueueSnapshot = {
  revision: 7,
  occurrences: [
    occ('occ-1', 'rec-self-aware'),
    occ('occ-2', 'rec-petit'),
    occ('occ-3', 'rec-dracula'),
    occ('occ-4', 'rec-maladie'),
    occ('occ-5', 'rec-roads'),
    occ('occ-6', 'rec-self-aware'),
    occ('occ-7', 'rec-cjk'),
    occ('occ-8', 'rec-noart'),
  ],
  currentOccurrenceId: 'occ-1',
  positionMs: 97_200,
  mode: 'playing',
};

export const fixtureIdentity = { attemptId: 'attempt-7', queueRev: 7 };

const SELF_AWARE_PLAYBACK = {
  recordingId: 'rec-self-aware',
  occurrenceId: 'occ-1',
  identity: fixtureIdentity,
  handle: 'handle-1',
  positionMs: 0,
  durationMs: 180_000,
};

export const fixturePlaybackPlaying: SessionPlayback = {
  type: 'playing',
  ...SELF_AWARE_PLAYBACK,
  positionMs: 97_200,
};

export const fixturePlaybackPaused: SessionPlayback = {
  type: 'paused',
  ...SELF_AWARE_PLAYBACK,
  positionMs: 61_000,
};

export const fixturePlaybackBuffering: SessionPlayback = {
  type: 'buffering',
  recordingId: 'rec-petit',
  occurrenceId: 'occ-2',
  identity: fixtureIdentity,
  handle: 'handle-2',
  positionMs: 0,
};

export const fixturePlaybackFailed: SessionPlayback = {
  type: 'failed',
  recordingId: 'rec-roads',
  occurrenceId: 'occ-5',
  identity: fixtureIdentity,
  error: {
    kind: 'unavailable',
    message: 'stream unavailable in this storefront',
    retryable: false,
  },
};

export const fixtureSettings: Settings = {
  catalogProvider: 'youtube-music',
  playbackProvider: 'youtube-music',
  storefront: 'AU',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
};

export const fixtureDiagnostics: DiagnosticsModel = {
  providerIds: ['youtube-music', 'spotify'],
  providerPermissions: new Map([
    ['youtube-music', ['network:music.youtube.com', 'network:*.googlevideo.com']],
    ['spotify', ['network:api.spotify.com', 'kv']],
  ]),
  attemptCount: 14,
  lastAttemptLabel: 'ok · 212 ms',
  lastFailure: 'provider-wall · sign in to confirm you’re not a bot',
  persistence: 'ok',
  persistenceDetail: null,
  pendingReviews: 2,
};

export const fixtureDiagnosticsDegraded: DiagnosticsModel = {
  providerIds: ['youtube-music'],
  providerPermissions: new Map([
    ['youtube-music', ['network:music.youtube.com']],
  ]),
  attemptCount: 3,
  lastAttemptLabel: 'timeout · 15 000 ms',
  lastFailure: 'timeout · resolve timed out',
  persistence: 'degraded',
  persistenceDetail: 'last write not flushed',
  pendingReviews: null,
};

export const fixtureSearchResults: readonly TrackMetadata[] = [
  trackMeta({
    provider: 'youtube-music',
    id: 'ytm-roads-live',
    title: 'Roads (live at roskilde ’94)',
    artist: 'Portishead',
    album: 'Roskilde ’94',
    durationMs: 297_000,
    releaseYear: 1994,
    artSeed: 'roads-live',
  }),
  trackMeta({
    provider: 'youtube-music',
    id: 'ytm-roads',
    title: 'Roads',
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 302_000,
    releaseYear: 1994,
    artSeed: 'roads',
  }),
  trackMeta({
    provider: 'youtube-music',
    id: 'ytm-glory',
    title: 'Glory Box',
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 306_000,
    releaseYear: 1994,
    artSeed: 'glory',
  }),
  trackMeta({
    provider: 'youtube-music',
    id: 'ytm-mysterons',
    title: 'Mysterons',
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 302_000,
    releaseYear: 1994,
  }),
];

function rec(id: string): Recording {
  const found = fixtureRecordings.find((r) => r.id === id);
  if (found === undefined) {
    throw new Error(`missing fixture recording ${id}`);
  }
  return found;
}

export const fixturePlayerPlaying: PlayerModel = {
  status: 'playing',
  intentPlaying: true,
  title: 'Self Aware',
  artist: 'Temper City',
  albumLabel: 'Self Aware · 2024',
  artworkUrl: art('self-aware'),
  artistRef: DZ_ARTIST_TAME,
  albumRef: DZ_ALBUM_DEADBEAT,
  positionMs: 97_200,
  durationMs: 180_000,
  occurrenceId: 'occ-self-aware',
  recordingId: 'rec-self-aware',
  liked: true,
  inPlaylist: false,
  canPrevious: false,
  canNext: true,
  errorMessage: null,
  recovery: null,
};

export const fixturePlayerPaused: PlayerModel = {
  ...fixturePlayerPlaying,
  status: 'paused',
  intentPlaying: false,
  positionMs: 61_000,
};

export const fixturePlayerBuffering: PlayerModel = {
  ...fixturePlayerPlaying,
  status: 'buffering',
  title: 'Le Petit Pêcheur',
  artist: 'Manon Lisa',
  artistRef: null,
  albumRef: null,
  albumLabel: 'Marées · 2023',
  artworkUrl: art('petit'),
  positionMs: 0,
  durationMs: 221_000,
  liked: true,
};

export const fixturePlayerFailed: PlayerModel = {
  ...fixturePlayerPlaying,
  status: 'failed',
  artistRef: null,
  albumRef: null,
  intentPlaying: false,
  title: 'Roads',
  artist: 'Portishead',
  albumLabel: 'Dummy · 1994',
  artworkUrl: art('roads'),
  positionMs: 0,
  durationMs: 297_000,
  liked: true,
  errorMessage: 'stream unavailable in this storefront',
};

const queueModelInput = {
  recordings: fixtureRecordings,
  likes: fixtureLikes,
  unavailableRecordingIds: fixtureUnavailableIds,
};

export const fixtureQueueModel: QueueModel = toQueueModel({
  queue: fixtureQueue,
  ...queueModelInput,
});

export const fixtureQueueModelPaused: QueueModel = toQueueModel({
  queue: { ...fixtureQueue, mode: 'paused' },
  ...queueModelInput,
});

const searchState = (
  phase: SearchStateModel['phase'],
  query: string,
  extra?: Partial<Omit<SearchStateModel, 'phase' | 'query'>>,
): SearchStateModel => ({
  phase,
  query,
  filter: 'all',
  results: [],
  hero: null,
  rails: [],
  hasMore: false,
  loadingMore: false,
  playItems: [],
  providerId: 'youtube-music',
  message: null,
  retryable: false,
  ...extra,
});

export const fixtureSearchStates: readonly SearchStateModel[] = [
  searchState('idle', '', { providerId: null }),
  searchState('loading', 'roads portishead'),
  searchState('ready', 'roads portishead', {
    results: fixtureSearchResults.map((meta, index) =>
      toSearchRowModel(meta, index),
    ),
    playItems: fixtureSearchResults,
    hero: (() => {
      const meta = fixtureSearchResults[0];
      if (meta === undefined) {
        return null;
      }
      return {
        type: 'track',
        row: toSearchRowModel(meta, 0),
        metaLabel: [
          'song',
          meta.artist ?? meta.album ?? '',
          meta.releaseYear ?? '',
        ]
          .filter((part) => part !== '')
          .join(' · '),
      };
    })(),
  }),
  searchState('empty', 'zkq dlpwmx'),
  searchState('error', 'roads portishead', {
    message: 'rate limited by provider',
    retryable: true,
  }),
  searchState('unavailable', 'roads portishead', {
    message: 'provider unavailable in this storefront',
  }),
];

// Entity-page fixtures: one complete album page, one degraded artist
// page (`complete:false` + a continuation token), mirroring what the
// deezer `catalog.entity` shape degrades to when a section truncates.
export const fixtureEntityItems: readonly TrackMetadata[] = [
  trackMeta({
    provider: 'deezer',
    id: 'dz-t-nope',
    title: 'Nope',
    artist: 'Tame Impala',
    album: 'Deadbeat',
    durationMs: 251_000,
    releaseYear: 2025,
    artSeed: 'dracula',
    albumRef: DZ_ALBUM_DEADBEAT,
    artistRef: DZ_ARTIST_TAME,
  }),
  trackMeta({
    provider: 'deezer',
    id: 'dz-t-dracula',
    title: 'Dracula',
    artist: 'Tame Impala',
    album: 'Deadbeat',
    durationMs: 242_000,
    releaseYear: 2025,
    artSeed: 'dracula',
    explicit: false,
    albumRef: DZ_ALBUM_DEADBEAT,
    artistRef: DZ_ARTIST_TAME,
  }),
  trackMeta({
    provider: 'deezer',
    id: 'dz-t-loser',
    title: 'Loser',
    artist: 'Tame Impala',
    album: 'Deadbeat',
    durationMs: 228_000,
    releaseYear: 2025,
    albumRef: DZ_ALBUM_DEADBEAT,
    artistRef: DZ_ARTIST_TAME,
  }),
];

export const fixtureEntityPage: EntityPage = {
  entity: {
    sourceRef: DZ_ALBUM_DEADBEAT,
    kind: 'album',
    title: 'Deadbeat',
    subtitle: 'Tame Impala',
    artwork: [{ url: art('dracula'), width: 300, height: 300 }],
    group: null,
  },
  items: fixtureEntityItems,
  related: [],
  continuation: null,
  complete: true,
};

export const fixtureEntityItemsPartial: readonly TrackMetadata[] = [
  trackMeta({
    provider: 'deezer',
    id: 'dz-t-roads',
    title: 'Roads',
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 302_000,
    releaseYear: 1994,
    artSeed: 'roads',
    artistRef: DZ_ARTIST_PORTISHEAD,
  }),
  trackMeta({
    provider: 'deezer',
    id: 'dz-t-sour',
    title: 'Sour Times',
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 252_000,
    releaseYear: 1994,
    artSeed: 'roads',
    artistRef: DZ_ARTIST_PORTISHEAD,
  }),
];

export const fixtureEntityPagePartial: EntityPage = {
  entity: {
    sourceRef: DZ_ARTIST_PORTISHEAD,
    kind: 'artist',
    title: 'Portishead',
    subtitle: '15 albums',
    artwork: [{ url: art('roads'), width: 300, height: 300 }],
    group: null,
  },
  items: fixtureEntityItemsPartial,
  related: [],
  continuation: 'opaque-next-page-token',
  complete: false,
};

export const fixtureEntityError: AppError = {
  kind: 'transient',
  message: 'provider hiccup — the page may be incomplete',
  retryable: true,
};

export const fixtureLibraryModel: LibraryModel = toLibraryModel({
  recordings: fixtureRecordings,
  likes: fixtureLikes,
  playlists: fixturePlaylists,
  playlistEntries: fixturePlaylistEntries,
  playHistory: fixturePlayHistory,
  playCounts: fixturePlayCounts,
  entities: fixtureEntities,
  entitySourceRefs: fixtureEntitySourceRefs,
});

const NO_LIBRARY = {
  recordings: [],
  likes: [],
  playlists: [],
  playlistEntries: [],
  playHistory: [],
  playCounts: [],
  entities: [],
  entitySourceRefs: [],
};

export const fixtureLibraryModelEmpty: LibraryModel = toLibraryModel(NO_LIBRARY);

export const fixtureCollectionModels: readonly CollectionModel[] = [
  toCollectionModel(fixtureLibraryModel, 'liked'),
  toCollectionModel(fixtureLibraryModel, 'top50'),
  toCollectionModel(fixtureLibraryModel, 'history'),
];

const playlistModelFor = (playlistId: string): PlaylistModel | null =>
  toPlaylistModel({
    playlistId,
    playlists: fixturePlaylists,
    playlistEntries: fixturePlaylistEntries,
    recordings: fixtureRecordings,
    likes: fixtureLikes,
  });

export const fixturePlaylistModel: PlaylistModel | null =
  playlistModelFor('pl-late-night');
export const fixturePlaylistModelEmpty: PlaylistModel | null =
  playlistModelFor('pl-fresh');

const entityModel = (
  page: EntityPage | null,
  error: AppError | null = null,
): EntityScreenModel =>
  toEntityModel({
    page,
    error,
    likes: fixtureLikes,
    entitySourceRefs: fixtureEntitySourceRefs,
  });

export const fixtureEntityModel: EntityScreenModel = entityModel(
  fixtureEntityPage,
);
export const fixtureEntityModelPartial: EntityScreenModel = entityModel(
  fixtureEntityPagePartial,
);
export const fixtureEntityModelLoading: EntityScreenModel = entityModel(null);
export const fixtureEntityModelError: EntityScreenModel = entityModel(
  null,
  fixtureEntityError,
);

export const fixtureSettingsModel = toSettingsModel(
  fixtureSettings,
  fixtureDiagnostics,
);

export const fixtureSettingsModelDegraded = toSettingsModel(
  fixtureSettings,
  fixtureDiagnosticsDegraded,
);

// ---- slice-4 LAN sync --------------------------------------------------

const fixtureSyncFp =
  'a3f1c92d5e47b80691ac4f2e8d0b6c53f71e09d28c4b5a6f3e2d1c0b9a8f7e6d5';

const fixtureSyncStatusPaired: SyncClientStatus = {
  deviceId: 'phone-fixture-1',
  peers: [
    {
      peer: {
        role: 'responder',
        fp: fixtureSyncFp,
        name: 'workstation',
        endpoints: ['192.168.1.20:48715'],
        pairedAt: 1_700_000_000_000,
        lastSeenAt: 1_700_000_500_000,
        peerCursor: { 'phone-fixture-1': 4 },
        lastSyncAt: 1_700_000_500_000,
      },
      state: 'open',
      syncing: false,
    },
    {
      peer: {
        role: 'responder',
        fp: 'b4e2d01c6f58a91702bd5e3f9e1c7d64a82f10e39d5c6b7a4f3e2d1c0b9a8f7e6',
        name: 'laptop',
        endpoints: ['192.168.1.44:48715'],
        pairedAt: 1_699_000_000_000,
        lastSeenAt: 1_699_500_000_000,
        peerCursor: {},
      },
      state: 'offline',
      syncing: false,
      lastError: {
        kind: 'unavailable',
        message: 'dial timed out',
        retryable: true,
      },
    },
  ],
};

const syncModel = (status: SyncClientStatus | null): SyncModel =>
  toSyncModel({ available: status !== null, status });

export const fixtureSyncModelPaired: SyncModel = syncModel(
  fixtureSyncStatusPaired,
);

export const fixtureSyncModelSyncing: SyncModel = syncModel({
  deviceId: fixtureSyncStatusPaired.deviceId,
  peers: [
    {
      peer: fixtureSyncStatusPaired.peers[0]!.peer,
      state: 'open',
      syncing: true,
    },
  ],
});

export const fixtureSyncModelUnpaired: SyncModel = syncModel({
  deviceId: 'phone-fixture-1',
  peers: [],
});

export const fixtureSyncModelUnavailable: SyncModel = syncModel(null);

export const fixtureHomeModel: HomeModel = {
  greeting: 'good evening',
  subline: 'wednesday · 3 new releases in your library',
  resume: {
    card: toRailCard(fixtureRecordings[0]!),
    positionMs: 83_000,
    durationMs: 214_000,
  },
  collections: collectionTiles({
    recordings: fixtureRecordings,
    likes: fixtureLikes,
    playHistory: fixturePlayHistory,
    playCounts: fixturePlayCounts,
  }),
  recents: fixtureRecordings.slice(0, 5).map(toRailCard),
  played: [
    fixtureRecordings[2]!,
    fixtureRecordings[0]!,
    fixtureRecordings[1]!,
  ].map(toRailCard),
  suggestions: fixtureRecordings.slice(5, 9).map(toRailCard),
};

// Mirrors NAV_ITEMS in apps/mobile/App.tsx — the gallery must preview the
// destinations the app actually shows, not a stale model.
export const fixtureNavItems: readonly NavItemModel[] = [
  { key: 'home', label: 'home' },
  { key: 'explore', label: 'explore' },
  { key: 'library', label: 'library' },
  { key: 'settings', label: 'settings' },
];

const SYNCED_LINES: readonly string[] = [
  '(Oh)',
  'No smoke with no fire',
  'No silence if there’s no sound',
  'One way or another',
  'You’re going to put me out',
  'Drinks flowing like water',
  'Too drunk to turn off the light',
  'Stay under the covers',
  'Who knows how we’ll end the night',
];

export const fixtureLyricsSynced: LyricsModel = {
  state: 'synced',
  lines: SYNCED_LINES,
  activeIndex: 6,
  syncLabel: 'synced · lyrics-lrclib',
  message: null,
};

const LYRICS_EMPTY = {
  lines: [],
  activeIndex: null,
  syncLabel: null,
} satisfies Partial<LyricsModel>;

const lyricsState = (
  state: LyricsModel['state'],
  message: string | null,
): LyricsModel => ({ ...LYRICS_EMPTY, state, message });

// Plain text never earns synced treatment: no activeIndex, no
// accent — the sync label says `unsynced` and names the provider.
export const fixtureLyricsPlain: LyricsModel = {
  ...lyricsState('plain', null),
  lines: SYNCED_LINES,
  syncLabel: 'unsynced · lyrics-lrclib',
};

export const fixtureLyricsInstrumental: LyricsModel = lyricsState(
  'instrumental',
  'this track is instrumental',
);

export const fixtureLyricsUnavailable: LyricsModel = lyricsState(
  'unavailable',
  'no lyrics matched this recording',
);

export const fixtureLyricsError: LyricsModel = lyricsState(
  'error',
  'rate limited by provider',
);

export const fixtureLyricsLoading: LyricsModel = lyricsState('loading', null);

export const fixtureLyricsStates: readonly LyricsModel[] = [
  fixtureLyricsSynced,
  fixtureLyricsPlain,
  fixtureLyricsInstrumental,
  fixtureLyricsUnavailable,
  fixtureLyricsError,
  fixtureLyricsLoading,
];

// Kept for the gallery's default Stage preview.
export const fixtureLyrics: LyricsModel = fixtureLyricsSynced;

// ---- radio --------------------------------------------------------

export const fixtureRadioTailGrowing: RadioTail = {
  seedRef: { provider: 'deezer', kind: 'track', id: 'dz-t-roads' },
  providerId: 'deezer',
  status: 'growing',
  fetching: false,
};

export const fixtureRadioTailFetching: RadioTail = {
  ...fixtureRadioTailGrowing,
  fetching: true,
};

export const fixtureRadioTailEnded: RadioTail = {
  ...fixtureRadioTailGrowing,
  status: 'ended',
};

export const fixtureRadioTailFailed: RadioTail = {
  ...fixtureRadioTailGrowing,
  status: 'failed',
  error: {
    kind: 'transient',
    message: 'continuation timed out',
    retryable: true,
  },
};

export const fixtureRadioModels: readonly RadioModel[] = [
  toRadioModel(null),
  toRadioModel(fixtureRadioTailGrowing),
  toRadioModel(fixtureRadioTailFetching),
  toRadioModel(fixtureRadioTailEnded),
  toRadioModel(fixtureRadioTailFailed),
];

// ---- corrections --------------------------------------------------

function candidate(partial: {
  provider: string;
  id: string;
  title: string;
  artist: string | null;
  durationMs: number | null;
}): MatchReview['candidates'][number] {
  const metadata = trackMeta(partial);
  return { metadata, ref: metadata.sourceRef };
}

export const fixtureMatchReviews: readonly MatchReview[] = [
  {
    reviewId: 'rev-roads',
    recordingId: 'rec-roads',
    candidates: [
      candidate({
        provider: 'deezer',
        id: 'dz-roads',
        title: 'Roads',
        artist: 'Portishead',
        durationMs: 302_000,
      }),
      candidate({
        provider: 'youtube-music',
        id: 'ytm-roads',
        title: 'Roads',
        artist: 'Portishead',
        durationMs: 297_000,
      }),
    ],
    status: 'pending',
    resolution: null,
    createdMs: 1_700_000_600_000,
    resolvedMs: null,
  },
  {
    reviewId: 'rev-religion',
    recordingId: 'rec-religion',
    candidates: [
      candidate({
        provider: 'deezer',
        id: 'dz-religion',
        title: 'New Religion',
        artist: null,
        durationMs: 211_000,
      }),
    ],
    status: 'confirmed',
    resolution: {
      ref: { provider: 'deezer', kind: 'track', id: 'dz-religion' },
    },
    createdMs: 1_700_000_400_000,
    resolvedMs: 1_700_000_450_000,
  },
  {
    reviewId: 'rev-cjk',
    recordingId: 'rec-cjk',
    candidates: [
      candidate({
        provider: 'itunes',
        id: 'it-cjk',
        title: '夜のドライブ',
        artist: 'metropolitan echo',
        durationMs: 196_000,
      }),
    ],
    status: 'rejected',
    resolution: { ref: null },
    createdMs: 1_700_000_200_000,
    resolvedMs: 1_700_000_260_000,
  },
];

const correctionsFixture = (input: {
  reviews: readonly MatchReview[] | null;
  filter: CorrectionsFilter;
  error?: AppError | null;
}): CorrectionsModel =>
  toCorrectionsModel({
    error: null,
    recordings: fixtureRecordings,
    ...input,
  });

export const fixtureCorrectionsModel: CorrectionsModel = correctionsFixture({
  reviews: fixtureMatchReviews,
  filter: 'all',
});

export const fixtureCorrectionsModelPending: CorrectionsModel =
  correctionsFixture({ reviews: fixtureMatchReviews, filter: 'pending' });

export const fixtureCorrectionsModelEmpty: CorrectionsModel =
  correctionsFixture({ reviews: [], filter: 'pending' });

export const fixtureCorrectionsModelLoading: CorrectionsModel =
  correctionsFixture({ reviews: null, filter: 'pending' });

export const fixtureCorrectionsModelError: CorrectionsModel =
  correctionsFixture({
    reviews: null,
    error: fixtureEntityError,
    filter: 'pending',
  });

// ---- library transfer ----------------------------------------------

export const fixtureExportDoc: ExportDocument = {
  formatVersion: 1,
  exportedAtMs: 1_700_001_100_000,
  recordings: fixtureRecordings
    .slice(0, 3)
    .map(({ sourceRefs: _sourceRefs, mappings: _mappings, ...rest }) => rest),
  sourceRefs: [],
  mappings: [],
  likes: fixtureLikes.slice(0, 3),
  entities: fixtureEntities.slice(0, 2),
  entitySourceRefs: fixtureEntitySourceRefs,
  playlists: fixturePlaylists.slice(0, 2),
  playlistEntries: fixturePlaylistEntries.slice(0, 3),
  playHistory: fixturePlayHistory,
  playCounts: fixturePlayCounts.slice(0, 3),
  matchReviews: fixtureMatchReviews.slice(0, 1),
  settings: fixtureSettings,
};

export const fixtureImportPreview: ImportPreview = {
  doc: fixtureExportDoc,
  exportedAtMs: fixtureExportDoc.exportedAtMs,
  counts: {
    recordings: fixtureExportDoc.recordings.length,
    sourceRefs: fixtureExportDoc.sourceRefs.length,
    mappings: fixtureExportDoc.mappings.length,
    likes: fixtureExportDoc.likes.length,
    entities: fixtureExportDoc.entities.length,
    entitySourceRefs: fixtureExportDoc.entitySourceRefs.length,
    playlists: fixtureExportDoc.playlists.length,
    playlistEntries: fixtureExportDoc.playlistEntries.length,
    playEvents: fixtureExportDoc.playHistory.length,
    playCounts: fixtureExportDoc.playCounts.length,
    matchReviews: fixtureExportDoc.matchReviews.length,
  },
};

export const fixtureImportPreviewModel: ImportPreviewModel =
  toImportPreviewModel(fixtureImportPreview, 'auqw-library.json');

const transferModel = (partial: Partial<TransferModel>): TransferModel => ({
  exportPhase: 'idle',
  exportDetail: null,
  importPhase: 'idle',
  importDetail: null,
  preview: null,
  ...partial,
});

export const fixtureTransferModel: TransferModel = transferModel({});

export const fixtureTransferModelPreview: TransferModel = transferModel({
  exportPhase: 'done',
  exportDetail: 'auqw-library-2023-11-14.json',
  importPhase: 'preview',
  preview: fixtureImportPreviewModel,
});

export const fixtureTransferModelDone: TransferModel = {
  ...fixtureTransferModelPreview,
  importPhase: 'done',
  importDetail: 'imported 3 tracks · 3 likes · 2 playlists',
};

export const fixtureTransferModelError: TransferModel = transferModel({
  importPhase: 'error',
  importDetail: 'import document failed validation',
});

export const fixtureRowStates: readonly TrackRowModel[] = [
  toTrackRowModel(rec('rec-self-aware'), { playing: true, liked: true }),
  toTrackRowModel(rec('rec-petit'), { liked: true }),
  toTrackRowModel(rec('rec-dracula')),
  toTrackRowModel(rec('rec-cjk')),
  toTrackRowModel(rec('rec-long')),
  toTrackRowModel(rec('rec-noart')),
  toTrackRowModel(rec('rec-roads'), {
    state: 'unavailable',
    note: 'unavailable',
    liked: true,
  }),
  toTrackRowModel(rec('rec-maladie'), {
    state: 'error',
    note: 'stream failed · tap to retry',
  }),
];

export const fixtureSchemeNames: readonly ThemeName[] = [
  'dark',
  'light',
  'oled',
];

export const fixturePlatforms: readonly PlatformVariant[] = [
  'android',
  'ios',
];

export const fixtureMotionModes: readonly boolean[] = [false, true];

/**
 * Deterministic asymmetric peak pairs for gallery renders — the same
 * contract a decoder-backed port returns after normalization:
 * normalized [0,1] arms where `up` and `down` genuinely diverge, a
 * quiet mid-section so the p95 ceiling stays honest, and a silence
 * run so zero stays zero.
 */
export const fixtureWaveformPeaks: readonly WaveformPeak[] = (() => {
  const peaks: WaveformPeak[] = [];
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  for (let i = 0; i < PEAKS_RESOLUTION; i += 1) {
    const t = i / (PEAKS_RESOLUTION - 1);
    if (t >= 0.62 && t < 0.68) {
      peaks.push({ up: 0, down: 0 });
      continue;
    }
    const swell = t < 0.2 ? 0.3 + t * 2.2 : t < 0.55 ? 0.72 : t < 0.72 ? 0.34 : 0.85;
    const wobble =
      0.11 * Math.sin(i * 1.73) + 0.06 * Math.sin(i * 0.31 + 0.7);
    peaks.push({
      up: clamp01(swell + wobble),
      down: clamp01(swell * 0.62 + 0.09 * Math.sin(i * 2.29 + 1.1)),
    });
  }
  return peaks;
})();

// ---- gallery scenario tuples -----------------------------------------
// `[label, model]` rows both galleries iterate over identically.

export const fixtureLyricsScenarios: readonly (readonly [
  string,
  LyricsModel,
])[] = [
  ['plain', fixtureLyricsPlain],
  ['instrumental', fixtureLyricsInstrumental],
  ['unavailable', fixtureLyricsUnavailable],
  ['error', fixtureLyricsError],
];

export const fixtureCorrectionsScenarios: readonly (readonly [
  string,
  CorrectionsModel,
])[] = [
  ['all reviews', fixtureCorrectionsModel],
  ['pending only', fixtureCorrectionsModelPending],
  ['empty queue', fixtureCorrectionsModelEmpty],
  ['loading', fixtureCorrectionsModelLoading],
  ['error', fixtureCorrectionsModelError],
];

export const fixtureTransferScenarios: readonly (readonly [
  string,
  TransferModel,
])[] = [
  ['preview', fixtureTransferModelPreview],
  ['applied', fixtureTransferModelDone],
  ['error', fixtureTransferModelError],
];

/** Recent-search strings the gallery search section seeds. */
export const fixtureSearchRecents: readonly string[] = [
  'radiohead ok computer',
  'boards of canada',
];
export type GalleryCoverage = {
  readonly sections: readonly string[];
  readonly schemes: readonly ThemeName[];
  readonly platforms: readonly PlatformVariant[];
  readonly reducedMotion: readonly boolean[];
  readonly searchPhases: readonly string[];
  readonly textScales: readonly number[];
  readonly artworkConditions: readonly string[];
  readonly gestureStates: readonly string[];
};

export const galleryCoverage: GalleryCoverage = {
  sections: [
    'track-rows',
    'mini-player',
    'navbars',
    'transport',
    'stage-sheet',
    'search',
    'library',
    'collection',
    'playlist',
    'entity',
    'sheets',
    'queue',
    'settings',
    'corrections',
    'transfer',
    'sync',
    'home',
    'states',
    'progress',
  ],
  schemes: fixtureSchemeNames,
  platforms: fixturePlatforms,
  reducedMotion: fixtureMotionModes,
  searchPhases: fixtureSearchStates.map((s) => s.phase),
  textScales: [1, 2],
  artworkConditions: ['missing', 'slow', 'extreme'],
  gestureStates: ['rest', 'mid-drag', 'dismissed'],
};
