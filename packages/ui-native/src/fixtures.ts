import type {
  AppError,
  Entity,
  EntityPage,
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
  TrackMetadata,
} from '@auqw/application';
import type { ThemeName } from '@auqw/design-tokens';
import {
  toCollectionModel,
  toCorrectionsModel,
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

export const fixtureLikes: readonly Like[] = [
  {
    entityKind: 'track',
    targetId: 'rec-self-aware',
    likedAtMs: 1_700_000_300_000,
  },
  {
    entityKind: 'track',
    targetId: 'rec-petit',
    likedAtMs: 1_700_000_200_000,
  },
  { entityKind: 'track', targetId: 'rec-roads', likedAtMs: 1_700_000_100_000 },
  {
    entityKind: 'album',
    targetId: 'entity-deadbeat',
    likedAtMs: 1_700_000_180_000,
  },
  {
    entityKind: 'artist',
    targetId: 'entity-portishead',
    likedAtMs: 1_700_000_160_000,
  },
  {
    entityKind: 'album',
    targetId: 'entity-orphan',
    likedAtMs: 1_700_000_120_000,
  },
];

// Owned album/artist entities — the ownable grid renders the liked
// ones as cards and the artist in the followed rail.
export const fixtureEntities: readonly Entity[] = [
  {
    entityId: 'entity-deadbeat',
    kind: 'album',
    title: 'Deadbeat',
    artistName: 'Tame Impala',
    artwork: [{ url: art('dracula'), width: 300, height: 300 }],
    createdMs: 1_700_000_050_000,
  },
  {
    entityId: 'entity-portishead',
    kind: 'artist',
    title: 'Portishead',
    artistName: null,
    artwork: [{ url: art('roads'), width: 300, height: 300 }],
    createdMs: 1_700_000_040_000,
  },
  // Owned but unreferenced: no provider ref means the card renders
  // unopenable — an honest absence, not a fake link.
  {
    entityId: 'entity-orphan',
    kind: 'album',
    title: 'Orphaned Pressing',
    artistName: 'Lost & Found',
    artwork: [],
    createdMs: 1_699_000_000_000,
  },
];

export const fixtureEntitySourceRefs: readonly EntitySourceRef[] = [
  {
    entityId: 'entity-deadbeat',
    provider: 'deezer',
    ref: { provider: 'deezer', kind: 'album', id: 'dz-album-deadbeat' },
  },
  {
    entityId: 'entity-portishead',
    provider: 'deezer',
    ref: { provider: 'deezer', kind: 'artist', id: 'dz-artist-portishead' },
  },
];

// The orphan entity is liked but carries no EntitySourceRef — its
// card must render unopenable (honest absence, never a fake link).

export const fixturePlaylists: readonly Playlist[] = [
  {
    playlistId: 'pl-late-night',
    name: 'late night drives',
    createdMs: 1_699_000_000_000,
    updatedMs: 1_700_000_250_000,
  },
  {
    playlistId: 'pl-morning',
    name: 'morning slow',
    createdMs: 1_699_500_000_000,
    updatedMs: 1_700_000_150_000,
  },
  {
    playlistId: 'pl-fresh',
    name: 'fresh ideas',
    createdMs: 1_700_000_400_000,
    updatedMs: 1_700_000_400_000,
  },
];

// `pe-3` repeats `pe-1`'s recording — duplicates are occurrences and
// must keep entryId row identity; `pe-3` also pins a selectedRef.
export const fixturePlaylistEntries: readonly PlaylistEntry[] = [
  {
    entryId: 'pe-1',
    playlistId: 'pl-late-night',
    recordingId: 'rec-dracula',
    position: 1,
    selectedRef: null,
    addedMs: 1_700_000_210_000,
  },
  {
    entryId: 'pe-2',
    playlistId: 'pl-late-night',
    recordingId: 'rec-roads',
    position: 2,
    selectedRef: null,
    addedMs: 1_700_000_220_000,
  },
  {
    entryId: 'pe-3',
    playlistId: 'pl-late-night',
    recordingId: 'rec-dracula',
    position: 3,
    selectedRef: {
      provider: 'youtube-music',
      kind: 'track',
      id: 'ytm-dracula-pinned',
    },
    addedMs: 1_700_000_250_000,
  },
  {
    entryId: 'pe-4',
    playlistId: 'pl-morning',
    recordingId: 'rec-petit',
    position: 1,
    selectedRef: null,
    addedMs: 1_700_000_160_000,
  },
  {
    entryId: 'pe-5',
    playlistId: 'pl-morning',
    recordingId: 'rec-cjk',
    position: 2,
    selectedRef: null,
    addedMs: 1_700_000_170_000,
  },
];

// Deliberately unordered — the model must sort newest-first, and
// `pev-1`/`pev-3` repeat one recording as separate event rows.
export const fixturePlayHistory: readonly PlayEvent[] = [
  {
    eventId: 'pev-4',
    recordingId: 'rec-petit',
    occurrenceId: null,
    playedMs: 1_700_000_700_000,
    listenedMs: 200_000,
  },
  {
    eventId: 'pev-1',
    recordingId: 'rec-dracula',
    occurrenceId: 'occ-3',
    playedMs: 1_700_001_000_000,
    listenedMs: 240_000,
  },
  {
    eventId: 'pev-3',
    recordingId: 'rec-dracula',
    occurrenceId: 'occ-9',
    playedMs: 1_700_000_800_000,
    listenedMs: 240_000,
  },
  {
    eventId: 'pev-2',
    recordingId: 'rec-self-aware',
    occurrenceId: 'occ-1',
    playedMs: 1_700_000_900_000,
    listenedMs: 180_000,
  },
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

export const fixtureQueue: QueueSnapshot = {
  revision: 7,
  occurrences: [
    { occurrenceId: 'occ-1', recordingId: 'rec-self-aware', selectedRef: null },
    { occurrenceId: 'occ-2', recordingId: 'rec-petit', selectedRef: null },
    { occurrenceId: 'occ-3', recordingId: 'rec-dracula', selectedRef: null },
    { occurrenceId: 'occ-4', recordingId: 'rec-maladie', selectedRef: null },
    { occurrenceId: 'occ-5', recordingId: 'rec-roads', selectedRef: null },
    { occurrenceId: 'occ-6', recordingId: 'rec-self-aware', selectedRef: null },
    { occurrenceId: 'occ-7', recordingId: 'rec-cjk', selectedRef: null },
    { occurrenceId: 'occ-8', recordingId: 'rec-noart', selectedRef: null },
  ],
  currentOccurrenceId: 'occ-1',
  positionMs: 97_200,
  mode: 'playing',
};

export const fixtureIdentity = { attemptId: 'attempt-7', queueRev: 7 };

export const fixturePlaybackPlaying: SessionPlayback = {
  type: 'playing',
  recordingId: 'rec-self-aware',
  occurrenceId: 'occ-1',
  identity: fixtureIdentity,
  handle: 'handle-1',
  positionMs: 97_200,
  durationMs: 180_000,
};

export const fixturePlaybackPaused: SessionPlayback = {
  type: 'paused',
  recordingId: 'rec-self-aware',
  occurrenceId: 'occ-1',
  identity: fixtureIdentity,
  handle: 'handle-1',
  positionMs: 61_000,
  durationMs: 180_000,
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
  attemptCount: 14,
  lastAttemptLabel: 'ok · 212 ms',
  persistence: 'ok',
  persistenceDetail: null,
  pendingReviews: 2,
};

export const fixtureDiagnosticsDegraded: DiagnosticsModel = {
  providerIds: ['youtube-music'],
  attemptCount: 3,
  lastAttemptLabel: 'timeout · 15 000 ms',
  persistence: 'degraded',
  persistenceDetail: 'last write not flushed',
  pendingReviews: null,
};

export const fixtureSearchResults: readonly TrackMetadata[] = [
  {
    sourceRef: { provider: 'youtube-music', kind: 'track', id: 'ytm-roads-live' },
    title: 'Roads (live at roskilde ’94)',
    artist: 'Portishead',
    album: 'Roskilde ’94',
    durationMs: 297_000,
    releaseYear: 1994,
    artwork: [{ url: art('roads-live'), width: 300, height: 300 }],
    explicit: null,
    genre: null,
    storefront: 'AU',
  },
  {
    sourceRef: { provider: 'youtube-music', kind: 'track', id: 'ytm-roads' },
    title: 'Roads',
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 302_000,
    releaseYear: 1994,
    artwork: [{ url: art('roads'), width: 300, height: 300 }],
    explicit: null,
    genre: null,
    storefront: 'AU',
  },
  {
    sourceRef: { provider: 'youtube-music', kind: 'track', id: 'ytm-glory' },
    title: 'Glory Box',
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 306_000,
    releaseYear: 1994,
    artwork: [{ url: art('glory'), width: 300, height: 300 }],
    explicit: null,
    genre: null,
    storefront: 'AU',
  },
  {
    sourceRef: { provider: 'youtube-music', kind: 'track', id: 'ytm-mysterons' },
    title: 'Mysterons',
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 302_000,
    releaseYear: 1994,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: 'AU',
  },
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
  title: 'Self Aware',
  artist: 'Temper City',
  albumLabel: 'Self Aware · 2024',
  artworkUrl: art('self-aware'),
  positionMs: 97_200,
  durationMs: 180_000,
  liked: true,
  canPrevious: false,
  canNext: true,
  errorMessage: null,
};

export const fixturePlayerPaused: PlayerModel = {
  ...fixturePlayerPlaying,
  status: 'paused',
  positionMs: 61_000,
};

export const fixturePlayerBuffering: PlayerModel = {
  ...fixturePlayerPlaying,
  status: 'buffering',
  title: 'Le Petit Pêcheur',
  artist: 'Manon Lisa',
  albumLabel: 'Marées · 2023',
  artworkUrl: art('petit'),
  positionMs: 0,
  durationMs: 221_000,
  liked: true,
};

export const fixturePlayerFailed: PlayerModel = {
  ...fixturePlayerPlaying,
  status: 'failed',
  title: 'Roads',
  artist: 'Portishead',
  albumLabel: 'Dummy · 1994',
  artworkUrl: art('roads'),
  positionMs: 0,
  durationMs: 297_000,
  liked: true,
  errorMessage: 'stream unavailable in this storefront',
};

export const fixtureQueueModel: QueueModel = toQueueModel({
  queue: fixtureQueue,
  recordings: fixtureRecordings,
  likes: fixtureLikes,
  unavailableRecordingIds: fixtureUnavailableIds,
});

export const fixtureQueueModelPaused: QueueModel = toQueueModel({
  queue: { ...fixtureQueue, mode: 'paused' },
  recordings: fixtureRecordings,
  likes: fixtureLikes,
  unavailableRecordingIds: fixtureUnavailableIds,
});

export const fixtureSearchStates: readonly SearchStateModel[] = [
  { phase: 'idle', query: '', results: [], providerId: null, message: null, retryable: false },
  {
    phase: 'loading',
    query: 'roads portishead',
    results: [],
    providerId: 'youtube-music',
    message: null,
    retryable: false,
  },
  {
    phase: 'ready',
    query: 'roads portishead',
    results: fixtureSearchResults.map(toSearchRowModel),
    providerId: 'youtube-music',
    message: null,
    retryable: false,
  },
  {
    phase: 'empty',
    query: 'zkq dlpwmx',
    results: [],
    providerId: 'youtube-music',
    message: null,
    retryable: false,
  },
  {
    phase: 'error',
    query: 'roads portishead',
    results: [],
    providerId: 'youtube-music',
    message: 'rate limited by provider',
    retryable: true,
  },
  {
    phase: 'unavailable',
    query: 'roads portishead',
    results: [],
    providerId: 'youtube-music',
    message: 'provider unavailable in this storefront',
    retryable: false,
  },
];

// Entity-page fixtures: one complete album page, one degraded artist
// page (`complete:false` + a continuation token), mirroring what the
// deezer `catalog.entity` shape degrades to when a section truncates.
export const fixtureEntityItems: readonly TrackMetadata[] = [
  {
    sourceRef: { provider: 'deezer', kind: 'track', id: 'dz-t-nope' },
    title: 'Nope',
    artist: 'Tame Impala',
    album: 'Deadbeat',
    durationMs: 251_000,
    releaseYear: 2025,
    artwork: [{ url: art('dracula'), width: 300, height: 300 }],
    explicit: null,
    genre: null,
    storefront: 'AU',
    albumRef: { provider: 'deezer', kind: 'album', id: 'dz-album-deadbeat' },
    artistRef: { provider: 'deezer', kind: 'artist', id: 'dz-artist-tame' },
  },
  {
    sourceRef: { provider: 'deezer', kind: 'track', id: 'dz-t-dracula' },
    title: 'Dracula',
    artist: 'Tame Impala',
    album: 'Deadbeat',
    durationMs: 242_000,
    releaseYear: 2025,
    artwork: [{ url: art('dracula'), width: 300, height: 300 }],
    explicit: false,
    genre: null,
    storefront: 'AU',
    albumRef: { provider: 'deezer', kind: 'album', id: 'dz-album-deadbeat' },
    artistRef: { provider: 'deezer', kind: 'artist', id: 'dz-artist-tame' },
  },
  {
    sourceRef: { provider: 'deezer', kind: 'track', id: 'dz-t-loser' },
    title: 'Loser',
    artist: 'Tame Impala',
    album: 'Deadbeat',
    durationMs: 228_000,
    releaseYear: 2025,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: 'AU',
    albumRef: { provider: 'deezer', kind: 'album', id: 'dz-album-deadbeat' },
    artistRef: { provider: 'deezer', kind: 'artist', id: 'dz-artist-tame' },
  },
];

export const fixtureEntityPage: EntityPage = {
  entity: {
    sourceRef: { provider: 'deezer', kind: 'album', id: 'dz-album-deadbeat' },
    kind: 'album',
    title: 'Deadbeat',
    subtitle: 'Tame Impala',
    artwork: [{ url: art('dracula'), width: 300, height: 300 }],
  },
  items: fixtureEntityItems,
  continuation: null,
  complete: true,
};

export const fixtureEntityItemsPartial: readonly TrackMetadata[] = [
  {
    sourceRef: { provider: 'deezer', kind: 'track', id: 'dz-t-roads' },
    title: 'Roads',
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 302_000,
    releaseYear: 1994,
    artwork: [{ url: art('roads'), width: 300, height: 300 }],
    explicit: null,
    genre: null,
    storefront: 'AU',
    artistRef: {
      provider: 'deezer',
      kind: 'artist',
      id: 'dz-artist-portishead',
    },
  },
  {
    sourceRef: { provider: 'deezer', kind: 'track', id: 'dz-t-sour' },
    title: 'Sour Times',
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 252_000,
    releaseYear: 1994,
    artwork: [{ url: art('roads'), width: 300, height: 300 }],
    explicit: null,
    genre: null,
    storefront: 'AU',
    artistRef: {
      provider: 'deezer',
      kind: 'artist',
      id: 'dz-artist-portishead',
    },
  },
];

export const fixtureEntityPagePartial: EntityPage = {
  entity: {
    sourceRef: {
      provider: 'deezer',
      kind: 'artist',
      id: 'dz-artist-portishead',
    },
    kind: 'artist',
    title: 'Portishead',
    subtitle: '15 albums',
    artwork: [{ url: art('roads'), width: 300, height: 300 }],
  },
  items: fixtureEntityItemsPartial,
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

export const fixtureLibraryModelEmpty: LibraryModel = toLibraryModel({
  recordings: [],
  likes: [],
  playlists: [],
  playlistEntries: [],
  playHistory: [],
  playCounts: [],
  entities: [],
  entitySourceRefs: [],
});

export const fixtureCollectionModels: readonly CollectionModel[] = [
  toCollectionModel(fixtureLibraryModel, 'liked'),
  toCollectionModel(fixtureLibraryModel, 'top50'),
  toCollectionModel(fixtureLibraryModel, 'history'),
];

export const fixturePlaylistModel: PlaylistModel | null = toPlaylistModel({
  playlistId: 'pl-late-night',
  playlists: fixturePlaylists,
  playlistEntries: fixturePlaylistEntries,
  recordings: fixtureRecordings,
  likes: fixtureLikes,
});

export const fixturePlaylistModelEmpty: PlaylistModel | null =
  toPlaylistModel({
    playlistId: 'pl-fresh',
    playlists: fixturePlaylists,
    playlistEntries: fixturePlaylistEntries,
    recordings: fixtureRecordings,
    likes: fixtureLikes,
  });

export const fixtureEntityModel: EntityScreenModel = toEntityModel({
  page: fixtureEntityPage,
  error: null,
  likes: fixtureLikes,
  entitySourceRefs: fixtureEntitySourceRefs,
});

export const fixtureEntityModelPartial: EntityScreenModel = toEntityModel({
  page: fixtureEntityPagePartial,
  error: null,
  likes: fixtureLikes,
  entitySourceRefs: fixtureEntitySourceRefs,
});

export const fixtureEntityModelLoading: EntityScreenModel = toEntityModel({
  page: null,
  error: null,
  likes: fixtureLikes,
  entitySourceRefs: fixtureEntitySourceRefs,
});

export const fixtureEntityModelError: EntityScreenModel = toEntityModel({
  page: null,
  error: fixtureEntityError,
  likes: fixtureLikes,
  entitySourceRefs: fixtureEntitySourceRefs,
});

export const fixtureSettingsModel = toSettingsModel(
  fixtureSettings,
  fixtureDiagnostics,
);

export const fixtureSettingsModelDegraded = toSettingsModel(
  fixtureSettings,
  fixtureDiagnosticsDegraded,
);

export const fixtureHomeModel: HomeModel = {
  greeting: 'good evening',
  subline: 'wednesday · 3 new releases in your library',
  resume: {
    card: toRailCard(fixtureRecordings[0]!),
    positionMs: 83_000,
    durationMs: 214_000,
  },
  recents: [
    fixtureRecordings[0],
    fixtureRecordings[1],
    fixtureRecordings[2],
    fixtureRecordings[3],
    fixtureRecordings[4],
  ]
    .filter((r): r is Recording => r !== undefined)
    .map(toRailCard),
  suggestions: [
    fixtureRecordings[5],
    fixtureRecordings[6],
    fixtureRecordings[7],
    fixtureRecordings[8],
  ]
    .filter((r): r is Recording => r !== undefined)
    .map(toRailCard),
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

// Plain text never earns synced treatment: no activeIndex, no
// accent — the sync label says `unsynced` and names the provider.
export const fixtureLyricsPlain: LyricsModel = {
  state: 'plain',
  lines: SYNCED_LINES,
  activeIndex: null,
  syncLabel: 'unsynced · lyrics-lrclib',
  message: null,
};

export const fixtureLyricsInstrumental: LyricsModel = {
  state: 'instrumental',
  lines: [],
  activeIndex: null,
  syncLabel: null,
  message: 'this track is instrumental',
};

export const fixtureLyricsUnavailable: LyricsModel = {
  state: 'unavailable',
  lines: [],
  activeIndex: null,
  syncLabel: null,
  message: 'no lyrics matched this recording',
};

export const fixtureLyricsError: LyricsModel = {
  state: 'error',
  lines: [],
  activeIndex: null,
  syncLabel: null,
  message: 'rate limited by provider',
};

export const fixtureLyricsLoading: LyricsModel = {
  state: 'loading',
  lines: [],
  activeIndex: null,
  syncLabel: null,
  message: null,
};

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

function reviewCandidate(
  metadata: TrackMetadata,
): MatchReview['candidates'][number] {
  return { metadata, ref: metadata.sourceRef };
}

function candidateMeta(partial: {
  provider: string;
  id: string;
  title: string;
  artist: string | null;
  durationMs: number | null;
}): TrackMetadata {
  return {
    sourceRef: { provider: partial.provider, kind: 'track', id: partial.id },
    title: partial.title,
    artist: partial.artist,
    album: null,
    durationMs: partial.durationMs,
    releaseYear: null,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: 'AU',
  };
}

export const fixtureMatchReviews: readonly MatchReview[] = [
  {
    reviewId: 'rev-roads',
    recordingId: 'rec-roads',
    candidates: [
      reviewCandidate(
        candidateMeta({
          provider: 'deezer',
          id: 'dz-roads',
          title: 'Roads',
          artist: 'Portishead',
          durationMs: 302_000,
        }),
      ),
      reviewCandidate(
        candidateMeta({
          provider: 'youtube-music',
          id: 'ytm-roads',
          title: 'Roads',
          artist: 'Portishead',
          durationMs: 297_000,
        }),
      ),
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
      reviewCandidate(
        candidateMeta({
          provider: 'deezer',
          id: 'dz-religion',
          title: 'New Religion',
          artist: null,
          durationMs: 211_000,
        }),
      ),
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
      reviewCandidate(
        candidateMeta({
          provider: 'itunes',
          id: 'it-cjk',
          title: '夜のドライブ',
          artist: 'metropolitan echo',
          durationMs: 196_000,
        }),
      ),
    ],
    status: 'rejected',
    resolution: { ref: null },
    createdMs: 1_700_000_200_000,
    resolvedMs: 1_700_000_260_000,
  },
];

export const fixtureCorrectionsModel: CorrectionsModel =
  toCorrectionsModel({
    reviews: fixtureMatchReviews,
    error: null,
    recordings: fixtureRecordings,
    filter: 'all',
  });

export const fixtureCorrectionsModelPending: CorrectionsModel =
  toCorrectionsModel({
    reviews: fixtureMatchReviews,
    error: null,
    recordings: fixtureRecordings,
    filter: 'pending',
  });

export const fixtureCorrectionsModelEmpty: CorrectionsModel =
  toCorrectionsModel({
    reviews: [],
    error: null,
    recordings: fixtureRecordings,
    filter: 'pending',
  });

export const fixtureCorrectionsModelLoading: CorrectionsModel =
  toCorrectionsModel({
    reviews: null,
    error: null,
    recordings: fixtureRecordings,
    filter: 'pending',
  });

export const fixtureCorrectionsModelError: CorrectionsModel =
  toCorrectionsModel({
    reviews: null,
    error: fixtureEntityError,
    recordings: fixtureRecordings,
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

export const fixtureTransferModel: TransferModel = {
  exportPhase: 'idle',
  exportDetail: null,
  importPhase: 'idle',
  importDetail: null,
  preview: null,
};

export const fixtureTransferModelPreview: TransferModel = {
  exportPhase: 'done',
  exportDetail: 'auqw-library-2023-11-14.json',
  importPhase: 'preview',
  importDetail: null,
  preview: fixtureImportPreviewModel,
};

export const fixtureTransferModelDone: TransferModel = {
  ...fixtureTransferModelPreview,
  importPhase: 'done',
  importDetail: 'imported 3 tracks · 3 likes · 2 playlists',
};

export const fixtureTransferModelError: TransferModel = {
  exportPhase: 'idle',
  exportDetail: null,
  importPhase: 'error',
  importDetail: 'import document failed validation',
  preview: null,
};

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
