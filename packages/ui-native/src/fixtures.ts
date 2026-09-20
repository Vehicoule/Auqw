import type {
  QueueSnapshot,
  Recording,
  SessionPlayback,
  Settings,
  TrackLike,
  TrackMetadata,
} from '@auqw/application';
import type { ThemeName } from '@auqw/design-tokens';
import {
  toLibraryModel,
  toQueueModel,
  toRailCard,
  toSearchRowModel,
  toSettingsModel,
  toTrackRowModel,
} from './view-models.ts';
import type {
  DiagnosticsModel,
  HomeModel,
  LibraryModel,
  NavItemModel,
  PlatformVariant,
  PlayerModel,
  LyricsModel,
  QueueModel,
  SearchStateModel,
  TrackRowModel,
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

export const fixtureLikes: readonly TrackLike[] = [
  { recordingId: 'rec-self-aware', likedAtMs: 1_700_000_300_000 },
  { recordingId: 'rec-petit', likedAtMs: 1_700_000_200_000 },
  { recordingId: 'rec-roads', likedAtMs: 1_700_000_100_000 },
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
};

export const fixtureDiagnosticsDegraded: DiagnosticsModel = {
  providerIds: ['youtube-music'],
  attemptCount: 3,
  lastAttemptLabel: 'timeout · 15 000 ms',
  persistence: 'degraded',
  persistenceDetail: 'last write not flushed',
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

export const fixtureLibraryModel: LibraryModel = toLibraryModel({
  recordings: fixtureRecordings,
  likes: fixtureLikes,
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

export const fixtureLyrics: LyricsModel = {
  lines: [
    '(Oh)',
    'No smoke with no fire',
    'No silence if there’s no sound',
    'One way or another',
    'You’re going to put me out',
    'Drinks flowing like water',
    'Too drunk to turn off the light',
    'Stay under the covers',
    'Who knows how we’ll end the night',
  ],
  activeIndex: 6,
  syncLabel: 'estimated timing',
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
    'queue',
    'settings',
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
