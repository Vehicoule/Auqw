import type { ThemeName } from '@auqw/design-tokens';
import type {
  AppError,
  ArtworkRef,
  DownloadProgress,
  Entity,
  EntityKind,
  EntityPage,
  EntityRef,
  EntitySourceRef,
  ImportPreview,
  Like,
  LyricsSheet,
  MatchReview,
  MatchReviewStatus,
  Playlist,
  PlaylistEntry,
  PlayCount,
  PlayEvent,
  QueueSnapshot,
  RadioTail,
  Recording,
  SessionPlayback,
  Settings,
  SourceRef,
  SyncClientStatus,
  TrackMetadata,
} from '@auqw/application';
import { ARTWORK_CACHE_BUDGET_DEFAULT_BYTES, topPlayed } from '@auqw/application';
import { t } from './i18n.ts';

export type PlatformVariant = 'android' | 'ios';

export type TrackRowState = 'available' | 'unavailable' | 'error';

/** Owned-bytes state on a track row — honest download chip. */
export type DownloadChip =
  | 'idle'
  | 'queued'
  | 'downloading'
  | 'stored'
  | 'failed';

export type TrackRowModel = {
  readonly key: string;
  readonly title: string;
  readonly versionLabel: string | null;
  readonly artist: string | null;
  readonly durationMs: number | null;
  readonly artworkUrl: string | null;
  readonly liked: boolean;
  readonly playing: boolean;
  readonly state: TrackRowState;
  readonly note: string | null;
  readonly download: DownloadChip | null;
};

export type PlayerStatus =
  | 'preparing'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'failed';

export type PlayerModel = {
  readonly status: PlayerStatus;
  readonly title: string;
  readonly artist: string | null;
  readonly albumLabel: string | null;
  readonly artworkUrl: string | null;
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly liked: boolean;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly errorMessage: string | null;
};

export type QueueItemModel = {
  readonly occurrenceId: string;
  readonly recordingId: string;
  readonly current: boolean;
  readonly duplicate: boolean;
  readonly row: TrackRowModel;
};

export type QueueModel = {
  readonly items: readonly QueueItemModel[];
  readonly mode: QueueSnapshot['mode'];
  readonly positionMs: number;
  readonly currentOccurrenceId: string | null;
};

export type SearchPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'unavailable';

export type SearchStateModel = {
  readonly phase: SearchPhase;
  readonly query: string;
  readonly results: readonly TrackRowModel[];
  readonly providerId: string | null;
  readonly message: string | null;
  readonly retryable: boolean;
};

export type RailCardModel = {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly artworkUrl: string | null;
};

export type ResumeModel = {
  readonly card: RailCardModel;
  readonly positionMs: number;
  readonly durationMs: number | null;
};

export type HomeModel = {
  readonly greeting: string;
  readonly subline: string | null;
  /** Present when playback is paused mid-track — the resume card. */
  readonly resume: ResumeModel | null;
  readonly recents: readonly RailCardModel[];
  readonly suggestions: readonly RailCardModel[];
};

export type CollectionKey = 'liked' | 'downloads' | 'top50' | 'history';

export type CollectionTileModel = {
  readonly key: CollectionKey;
  readonly label: string;
  readonly count: number;
  readonly enabled: boolean;
  readonly note: string | null;
};

/**
 * One row inside a collection list. `key` is the React key — unique
 * per row, so repeated plays of one recording keep row identity;
 * `recordingId` is the action target for play/like/playlist ops.
 */
export type CollectionRowModel = {
  readonly key: string;
  readonly recordingId: string;
  readonly badge: string | null;
  readonly row: TrackRowModel;
};

export type CollectionModel = {
  readonly key: 'liked' | 'top50' | 'history' | 'downloads';
  readonly title: string;
  readonly rows: readonly CollectionRowModel[];
};

/**
 * An ownable-grid card: a user playlist or a liked album/artist
 * entity. `playlistId` opens the playlist editor; `entityRef` opens
 * the entity page (null when the entity carries no provider ref —
 * the card then renders unopenable, honest absence).
 */
export type LibraryCardModel = {
  readonly key: string;
  readonly kind: 'playlist' | 'album' | 'artist';
  readonly title: string;
  readonly subtitle: string;
  readonly count: number | null;
  readonly artworkUrl: string | null;
  readonly sortMs: number;
  readonly playlistId: string | null;
  readonly entityRef: EntityRef | null;
  readonly entityId: string | null;
};

export type ArtistRailModel = {
  readonly key: string;
  readonly name: string;
  readonly artworkUrl: string | null;
  readonly entityRef: EntityRef | null;
};

export type LibraryModel = {
  readonly likedCount: number;
  readonly items: readonly TrackRowModel[];
  readonly collections: readonly CollectionTileModel[];
  readonly collectionRows: {
    readonly liked: readonly CollectionRowModel[];
    readonly top50: readonly CollectionRowModel[];
    readonly history: readonly CollectionRowModel[];
    readonly downloads: readonly CollectionRowModel[];
  };
  readonly cards: readonly LibraryCardModel[];
  readonly artists: readonly ArtistRailModel[];
  readonly recentlyAdded: readonly TrackRowModel[];
  readonly canCreatePlaylist: boolean;
};

export type PlaylistEntryModel = {
  readonly entryId: string;
  readonly recordingId: string;
  readonly selectedRef: SourceRef | null;
  readonly duplicate: boolean;
  readonly row: TrackRowModel;
};

export type PlaylistModel = {
  readonly playlistId: string;
  readonly name: string;
  readonly count: number;
  readonly artworkUrl: string | null;
  readonly entries: readonly PlaylistEntryModel[];
};

export type EntityScreenModel = {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly kind: EntityKind | null;
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly artworkUrl: string | null;
  readonly complete: boolean;
  readonly liked: boolean;
  readonly canLike: boolean;
  readonly items: readonly TrackRowModel[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly message: string | null;
};

export type SettingsRowModel = {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
  readonly kind: 'navigation' | 'toggle' | 'value';
  readonly enabled: boolean;
};

export type DiagnosticsModel = {
  readonly providerIds: readonly string[];
  readonly attemptCount: number;
  readonly lastAttemptLabel: string | null;
  readonly persistence: 'ok' | 'degraded' | 'failed';
  readonly persistenceDetail: string | null;
  /**
   * Pending corrections-queue reviews when the caller has loaded
   * them; `null` renders the row without a count (reviews are live
   * reads, not session state).
   */
  readonly pendingReviews: number | null;
};

export type SettingsModel = {
  readonly theme: ThemeName;
  readonly rows: readonly SettingsRowModel[];
  readonly diagnostics: DiagnosticsModel;
};

export type NavItemModel = {
  readonly key: string;
  readonly label: string;
};

export type StageMode = 'player' | 'lyrics' | 'queue';

/**
 * The Stage lyrics mode's honest states (design.md — "title +
 * honest sync state"). The gate that matters: only a `synced` sheet
 * earns `state: 'synced'` and a non-null `activeIndex`; `plain`,
 * `instrumental`, and `unavailable` results never receive line
 * highlighting or any synced treatment.
 */
export type LyricsState =
  | 'loading'
  | 'synced'
  | 'plain'
  | 'instrumental'
  | 'unavailable'
  | 'error';

export type LyricsModel = {
  readonly state: LyricsState;
  readonly lines: readonly string[];
  /** Non-null only when `state === 'synced'` — never else. */
  readonly activeIndex: number | null;
  /** The honest sync-state label (`synced` / `unsynced` + provenance). */
  readonly syncLabel: string | null;
  /** Detail for non-content states — the typed error's message. */
  readonly message: string | null;
};

/**
 * Maps the session's `LyricsSheet` (plus the fetch lifecycle the
 * caller tracks) to the Stage lyrics model. `activeIndex` is the
 * last timed line at or before `positionMs` — null before the first
 * line — and provenance rides the sync label as
 * `<state> · <provider>[ · cached]`.
 */
export function toLyricsModel(input: {
  readonly sheet: LyricsSheet | null;
  readonly error: AppError | null;
  readonly loading: boolean;
  readonly positionMs: number;
}): LyricsModel {
  const empty = {
    lines: [],
    activeIndex: null,
    syncLabel: null,
  };
  const { sheet, error, loading } = input;
  if (sheet === null) {
    if (loading) {
      return { ...empty, state: 'loading', message: null };
    }
    return {
      ...empty,
      state: error === null ? 'unavailable' : 'error',
      message: error?.message ?? null,
    };
  }
  const provenance = `${sheet.provider}${sheet.cached ? t('lyrics.cachedSuffix') : ''}`;
  switch (sheet.kind) {
    case 'synced': {
      let activeIndex: number | null = null;
      sheet.lines.forEach((line, index) => {
        if (line.tMs <= input.positionMs) {
          activeIndex = index;
        }
      });
      return {
        state: 'synced',
        lines: sheet.lines.map((line) => line.text),
        activeIndex,
        syncLabel: t('lyrics.synced', { provenance }),
        message: null,
      };
    }
    case 'plain':
      return {
        state: 'plain',
        lines: sheet.text.split('\n'),
        activeIndex: null,
        syncLabel: t('lyrics.unsynced', { provenance }),
        message: null,
      };
    case 'instrumental':
      return {
        ...empty,
        state: 'instrumental',
        message: t('lyrics.instrumentalMessage'),
      };
    case 'unavailable':
      return {
        ...empty,
        state: 'unavailable',
        message: t('lyrics.noMatch'),
      };
  }
}

/**
 * The Now-Playing radio affordance model. `armed` mirrors
 * `session.radio !== null`; `detail` carries the provider that owns
 * the tail, or the typed error when the tail failed.
 */
export type RadioModel = {
  readonly armed: boolean;
  readonly status: 'growing' | 'ended' | 'failed' | null;
  readonly fetching: boolean;
  readonly label: string | null;
  readonly detail: string | null;
};

export function toRadioModel(radio: RadioTail | null): RadioModel {
  if (radio === null) {
    return {
      armed: false,
      status: null,
      fetching: false,
      label: null,
      detail: null,
    };
  }
  return {
    armed: true,
    status: radio.status,
    fetching: radio.fetching,
    label: t('radio.label', { status: t(`radio.status.${radio.status}`) }),
    detail:
      radio.status === 'failed'
        ? (radio.error?.message ?? t('radio.continuationFailed'))
        : radio.providerId,
  };
}

// ---- corrections (diagnostics review queue) ------------------------

export type ReviewCandidateModel = {
  /** The index `confirmReview` expects — never renumbered. */
  readonly index: number;
  readonly title: string;
  readonly subtitle: string;
};

export type ReviewRowModel = {
  readonly reviewId: string;
  readonly title: string;
  readonly artist: string | null;
  readonly status: MatchReviewStatus;
  readonly statusLabel: string;
  readonly candidates: readonly ReviewCandidateModel[];
};

export type CorrectionsFilter = 'pending' | 'resolved' | 'all';

export type CorrectionsModel = {
  /** Live-read lifecycle — never an indefinite spinner. */
  readonly state: 'loading' | 'ready' | 'error';
  readonly message: string | null;
  readonly filter: CorrectionsFilter;
  readonly pendingCount: number;
  readonly resolvedCount: number;
  readonly rows: readonly ReviewRowModel[];
};

function reviewStatusLabel(review: MatchReview): string {
  switch (review.status) {
    case 'confirmed': {
      const ref = review.resolution?.ref;
      return ref === null || ref === undefined
        ? t('corrections.status.confirmed')
        : t('corrections.status.confirmedProvider', { provider: ref.provider });
    }
    case 'rejected':
      return t('corrections.status.rejected');
    case 'pending':
      return t('corrections.status.pending');
    case 'dismissed':
      return t('corrections.status.dismissed');
  }
}

/**
 * The diagnostics review queue: pending reviews first (they are the
 * actionable queue), then resolved ones newest-first. Candidates
 * keep their wire index — `confirmReview` addresses them by it.
 * `reviews: null` is the loading state; counts always reflect the
 * full list while `rows` honor the display filter.
 */
export function toCorrectionsModel(input: {
  readonly reviews: readonly MatchReview[] | null;
  readonly error: AppError | null;
  readonly recordings: readonly Recording[];
  readonly filter: CorrectionsFilter;
}): CorrectionsModel {
  if (input.reviews === null) {
    return {
      state: input.error === null ? 'loading' : 'error',
      message: input.error?.message ?? null,
      filter: input.filter,
      pendingCount: 0,
      resolvedCount: 0,
      rows: [],
    };
  }
  const byId = indexById(input.recordings);
  const rank = (review: MatchReview): number =>
    review.status === 'pending' ? 0 : 1;
  const rows: ReviewRowModel[] = [...input.reviews]
    .sort(
      (a, b) => rank(a) - rank(b) || b.createdMs - a.createdMs,
    )
    .map((review) => {
      const recording = byId.get(review.recordingId);
      return {
        reviewId: review.reviewId,
        title: recording?.title ?? t('corrections.unknownRecording'),
        artist: recording?.artist ?? null,
        status: review.status,
        statusLabel: reviewStatusLabel(review),
        candidates: review.candidates.map((candidate, index) => ({
          index,
          title: candidate.metadata.title,
          subtitle: `${candidate.metadata.artist ?? '—'} · ${candidate.ref.provider}`,
        })),
      };
    });
  const pending = rows.filter((row) => row.status === 'pending').length;
  const visible =
    input.filter === 'all'
      ? rows
      : rows.filter((row) =>
        input.filter === 'pending'
          ? row.status === 'pending'
          : row.status !== 'pending',
      );
  return {
    state: 'ready',
    message: null,
    filter: input.filter,
    pendingCount: pending,
    resolvedCount: rows.length - pending,
    rows: visible,
  };
}

// ---- LAN sync (docs/specs/sync.md, slice 4) --------------------------

export type SyncPeerModel = {
  /** Custody key — the desktop's pinned fingerprint. */
  readonly key: string;
  readonly name: string;
  readonly state: 'offline' | 'connecting' | 'open';
  readonly stateLabel: string;
  readonly syncing: boolean;
  /** 'last sync <iso>' — null before the first converged round. */
  readonly lastSyncLabel: string | null;
  /** First dialed endpoint — the honest 'where' for the row. */
  readonly endpointLabel: string | null;
  /** The typed error message from the last failed op, if any. */
  readonly lastError: string | null;
  readonly fpShort: string;
};

export type SyncModel = {
  /** False where the platform lacks the socket seam (iOS today). */
  readonly available: boolean;
  /** This install's wire identity — null before bring-up resolves. */
  readonly deviceId: string | null;
  readonly peers: readonly SyncPeerModel[];
  /** One-line summary for the settings row's value slot. */
  readonly statusLabel: string;
};

export function toSyncModel(input: {
  readonly available: boolean;
  /** `client.status()` — null while bring-up is pending or failed. */
  readonly status: SyncClientStatus | null;
  /** Format one epoch-ms — locale-free short date or '—'. */
  readonly formatSyncAt?: ((ms: number) => string | null) | undefined;
}): SyncModel {
  const fmt = input.formatSyncAt ?? formatExportDate;
  const peers: SyncPeerModel[] = (input.status?.peers ?? []).map(
    (view) => ({
      key: view.peer.fp,
      name: view.peer.name,
      state: view.state,
      stateLabel: view.syncing
        ? t('sync.state.syncing')
        : view.state === 'open'
          ? t('sync.state.connected')
          : view.state === 'connecting'
            ? t('sync.state.connecting')
            : t('sync.state.offline'),
      syncing: view.syncing,
      lastSyncLabel:
        view.peer.lastSyncAt === undefined
          ? null
          : t('sync.lastSync', { date: fmt(view.peer.lastSyncAt) ?? '—' }),
      endpointLabel: view.peer.endpoints[0] ?? null,
      lastError: view.lastError?.message ?? null,
      fpShort: view.peer.fp.slice(0, 12),
    }),
  );
  const open = peers.filter((p) => p.state === 'open').length;
  return {
    available: input.available,
    deviceId: input.status?.deviceId ?? null,
    peers,
    statusLabel:
      input.status === null
        ? t('sync.status.unavailable')
        : peers.length === 0
          ? t('sync.status.notPaired')
          : open > 0
            ? t('sync.status.connectedCount', { count: open })
            : t('sync.status.pairedCount', { count: peers.length }),
  };
}

// ---- library transfer (export / import) ----------------------------

export type ImportPreviewRowModel = {
  readonly key: string;
  readonly label: string;
  readonly count: number;
};

export type ImportPreviewModel = {
  readonly formatVersion: number;
  readonly sourceLabel: string;
  readonly exportedLabel: string | null;
  readonly rows: readonly ImportPreviewRowModel[];
};

function formatExportDate(ms: number): string | null {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    return null;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** The confirm screen's section counts for an import document. */
export function toImportPreviewModel(
  preview: ImportPreview,
  sourceLabel: string,
): ImportPreviewModel {
  const counts = preview.counts;
  return {
    formatVersion: preview.doc.formatVersion,
    sourceLabel,
    exportedLabel: formatExportDate(preview.exportedAtMs),
    rows: [
      { key: 'recordings', label: t('import.tracks'), count: counts.recordings },
      { key: 'likes', label: t('import.likes'), count: counts.likes },
      { key: 'playlists', label: t('import.playlists'), count: counts.playlists },
      {
        key: 'playlistEntries',
        label: t('import.playlistEntries'),
        count: counts.playlistEntries,
      },
      { key: 'entities', label: t('import.entities'), count: counts.entities },
      {
        key: 'playEvents',
        label: t('import.playHistory'),
        count: counts.playEvents,
      },
      {
        key: 'playCounts',
        label: t('import.playCounts'),
        count: counts.playCounts,
      },
      {
        key: 'matchReviews',
        label: t('import.matchReviews'),
        count: counts.matchReviews,
      },
      { key: 'mappings', label: t('import.matchMappings'), count: counts.mappings },
    ],
  };
}

export type TransferModel = {
  readonly exportPhase: 'idle' | 'working' | 'done' | 'error';
  /** The written path on `done`; the typed message on `error`. */
  readonly exportDetail: string | null;
  readonly importPhase:
  | 'idle'
  | 'reading'
  | 'preview'
  | 'applying'
  | 'done'
  | 'error';
  /** The typed message on `error`; the applied summary on `done`. */
  readonly importDetail: string | null;
  readonly preview: ImportPreviewModel | null;
};

export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatRemaining(
  positionMs: number,
  durationMs: number | null,
): string {
  if (durationMs === null) {
    return '—';
  }
  const left = Math.max(0, durationMs - Math.max(0, positionMs));
  return `-${formatClock(left)}`;
}

export function pickArtworkUrl(
  artwork: readonly ArtworkRef[],
  targetWidth = 128,
): string | null {
  const first = artwork[0];
  if (first === undefined) {
    return null;
  }
  let best: ArtworkRef | null = null;
  let largest: ArtworkRef = first;
  for (const ref of artwork) {
    if (ref.width !== null && ref.width >= (largest.width ?? 0)) {
      largest = ref;
    }
    const width = ref.width ?? Number.MAX_SAFE_INTEGER;
    const bestWidth = best?.width ?? Number.MAX_SAFE_INTEGER;
    if (width >= targetWidth && width < bestWidth) {
      best = ref;
    }
  }
  return (best ?? largest).url;
}

function albumLabel(recording: Recording): string | null {
  const parts: string[] = [];
  if (recording.album !== null) {
    parts.push(recording.album);
  }
  if (recording.releaseYear !== null) {
    parts.push(String(recording.releaseYear));
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

export type TrackRowOptions = {
  readonly key?: string;
  readonly liked?: boolean;
  readonly playing?: boolean;
  readonly state?: TrackRowState;
  readonly note?: string | null;
  readonly download?: DownloadChip | null;
};

export function toTrackRowModel(
  recording: Recording,
  options: TrackRowOptions = {},
): TrackRowModel {
  return {
    key: options.key ?? recording.id,
    title: recording.title,
    versionLabel:
      recording.versionLabels.length === 0
        ? null
        : recording.versionLabels.join(' · '),
    artist: recording.artist,
    durationMs: recording.durationMs,
    artworkUrl: pickArtworkUrl(recording.artwork),
    liked: options.liked ?? false,
    playing: options.playing ?? false,
    state: options.state ?? 'available',
    note: options.note ?? null,
    download: options.download ?? null,
  };
}

export function toSearchRowModel(
  metadata: TrackMetadata,
  index: number,
  playingRef?: SourceRef | null,
): TrackRowModel {
  return {
    key: `${metadata.sourceRef.provider}:${metadata.sourceRef.id}:${index}`,
    title: metadata.title,
    versionLabel: null,
    artist: metadata.artist,
    durationMs: metadata.durationMs,
    artworkUrl: pickArtworkUrl(metadata.artwork),
    liked: false,
    // A catalog row marks playing only when its own sourceRef is the
    // ref the player resolved — the accent row + eq overlay the
    // preview draws inside result lists.
    playing:
      playingRef !== null &&
      playingRef !== undefined &&
      metadata.sourceRef.provider === playingRef.provider &&
      metadata.sourceRef.kind === playingRef.kind &&
      metadata.sourceRef.id === playingRef.id,
    state: 'available',
    note: null,
    download: null,
  };
}

export type PlayerModelInput = {
  readonly playback: SessionPlayback;
  readonly queue: QueueSnapshot;
  readonly recordings: readonly Recording[];
  readonly likes: readonly Like[];
};

function indexById(
  recordings: readonly Recording[],
): ReadonlyMap<string, Recording> {
  const map = new Map<string, Recording>();
  for (const recording of recordings) {
    map.set(recording.id, recording);
  }
  return map;
}

function likedIds(likes: readonly Like[]): ReadonlySet<string> {
  return new Set(
    likes
      .filter((like) => like.entityKind === 'track')
      .map((like) => like.targetId),
  );
}

export function toPlayerModel(input: PlayerModelInput): PlayerModel | null {
  const { playback, queue, recordings, likes } = input;
  if (playback.type === 'idle') {
    return null;
  }
  const byId = indexById(recordings);
  const liked = likedIds(likes);
  // Transport enablement anchors on what's on the player — during a
  // transition the playing occurrence can legitimately differ from
  // the queue's current until the reconcile lands.
  const activeId = playback.occurrenceId ?? queue.currentOccurrenceId;
  const currentIndex = queue.occurrences.findIndex(
    (o) => o.occurrenceId === activeId,
  );
  const canPrevious = currentIndex > 0;
  const canNext =
    currentIndex >= 0 && currentIndex < queue.occurrences.length - 1;
  const recordingId = playback.recordingId;
  const recording = recordingId === null ? undefined : byId.get(recordingId);
  const base = {
    artist: recording?.artist ?? null,
    albumLabel: recording === undefined ? null : albumLabel(recording),
    artworkUrl:
      recording === undefined ? null : pickArtworkUrl(recording.artwork),
    liked: recordingId !== null && liked.has(recordingId),
    canPrevious,
    canNext,
  };
  switch (playback.type) {
    case 'preparing':
      return {
        ...base,
        status: 'preparing',
        title: recording?.title ?? t('player.title.preparing'),
        positionMs: 0,
        durationMs: recording?.durationMs ?? null,
        errorMessage: null,
      };
    case 'buffering':
    case 'playing':
    case 'paused':
      return {
        ...base,
        status: playback.type,
        title: recording?.title ?? t('player.title.unknown'),
        positionMs: playback.positionMs,
        durationMs: playback.durationMs ?? recording?.durationMs ?? null,
        errorMessage: null,
      };
    case 'failed':
      return {
        ...base,
        status: 'failed',
        title: recording?.title ?? t('player.title.failed'),
        positionMs: 0,
        durationMs: recording?.durationMs ?? null,
        errorMessage: playback.error.message,
      };
  }
}

export type QueueModelInput = {
  readonly queue: QueueSnapshot;
  readonly recordings: readonly Recording[];
  readonly likes?: readonly Like[];
  readonly unavailableRecordingIds?: ReadonlySet<string> | undefined;
};

export function toQueueModel(input: QueueModelInput): QueueModel {
  const { queue, recordings } = input;
  const byId = indexById(recordings);
  const liked = likedIds(input.likes ?? []);
  const unavailable = input.unavailableRecordingIds ?? new Set<string>();
  const occurrencesByRecording = new Map<string, number>();
  for (const occurrence of queue.occurrences) {
    const count = occurrencesByRecording.get(occurrence.recordingId) ?? 0;
    occurrencesByRecording.set(occurrence.recordingId, count + 1);
  }
  const items: QueueItemModel[] = queue.occurrences.map((occurrence) => {
    const recording = byId.get(occurrence.recordingId);
    const current = occurrence.occurrenceId === queue.currentOccurrenceId;
    const row: TrackRowModel =
      recording === undefined
        ? {
          key: occurrence.occurrenceId,
          title: t('track.unknown'),
          versionLabel: null,
          artist: null,
          durationMs: null,
          artworkUrl: null,
          liked: false,
          playing: current && queue.mode === 'playing',
          state: 'unavailable',
          note: t('common.unavailable'),
          download: null,
        }
        : {
          key: occurrence.occurrenceId,
          title: recording.title,
          versionLabel:
            recording.versionLabels.length === 0
              ? null
              : recording.versionLabels.join(' · '),
          artist: recording.artist,
          durationMs: recording.durationMs,
          artworkUrl: pickArtworkUrl(recording.artwork),
          liked: liked.has(recording.id),
          playing: current && queue.mode === 'playing',
          state: unavailable.has(recording.id) ? 'unavailable' : 'available',
          note: unavailable.has(recording.id) ? t('common.unavailable') : null,
          download: null,
        };
    return {
      occurrenceId: occurrence.occurrenceId,
      recordingId: occurrence.recordingId,
      current,
      duplicate:
        (occurrencesByRecording.get(occurrence.recordingId) ?? 0) > 1,
      row,
    };
  });
  return {
    items,
    mode: queue.mode,
    positionMs: queue.positionMs,
    currentOccurrenceId: queue.currentOccurrenceId,
  };
}

function likedEntityIds(likes: readonly Like[]): ReadonlySet<string> {
  return new Set(
    likes
      .filter((like) => like.entityKind !== 'track')
      .map((like) => `${like.entityKind} ${like.targetId}`),
  );
}

function playlistEntriesFor(
  entries: readonly PlaylistEntry[],
  playlistId: string,
): PlaylistEntry[] {
  return entries
    .filter((entry) => entry.playlistId === playlistId)
    .sort((a, b) => a.position - b.position);
}

function entityRefFor(
  refs: readonly EntitySourceRef[],
  entityId: string,
): EntityRef | null {
  const hit = refs.find((s) => s.entityId === entityId);
  return hit === undefined ? null : hit.ref;
}

/** The app-side entity an EntityRef resolves to, when materialized. */
export function entityIdForRef(
  refs: readonly EntitySourceRef[],
  ref: EntityRef,
): string | null {
  const hit = refs.find(
    (s) =>
      s.provider === ref.provider &&
      s.ref.kind === ref.kind &&
      s.ref.id === ref.id,
  );
  return hit === undefined ? null : hit.entityId;
}

export function toLibraryModel(input: {
  readonly recordings: readonly Recording[];
  /** Live download rows — the downloads collection and row chips. */
  readonly downloads?: readonly DownloadProgress[];
  readonly likes: readonly Like[];
  readonly playlists: readonly Playlist[];
  readonly playlistEntries: readonly PlaylistEntry[];
  readonly playHistory: readonly PlayEvent[];
  readonly playCounts: readonly PlayCount[];
  readonly entities: readonly Entity[];
  readonly entitySourceRefs: readonly EntitySourceRef[];
}): LibraryModel {
  const byId = indexById(input.recordings);
  const liked = likedIds(input.likes);
  const ordered = [...input.likes]
    .filter((like) => like.entityKind === 'track')
    .sort((a, b) => b.likedAtMs - a.likedAtMs);
  const items: TrackRowModel[] = [];
  for (const like of ordered) {
    const recording = byId.get(like.targetId);
    if (recording === undefined) {
      continue;
    }
    items.push(toTrackRowModel(recording, { liked: liked.has(recording.id) }));
  }

  // Top 50: durable play-count ranking (count desc, recency, id) via
  // the library's own topPlayed — unresolvable ids drop honestly.
  const top50: CollectionRowModel[] = topPlayed(
    input.playCounts,
    input.recordings,
  ).map((entry, index) => ({
    key: `top50-${entry.recording.id}-${index}`,
    recordingId: entry.recording.id,
    badge: t('collection.plays', { count: entry.count }),
    row: toTrackRowModel(entry.recording, {
      key: `top50-${entry.recording.id}-${index}`,
      liked: liked.has(entry.recording.id),
    }),
  }));

  // History: one row per counted play, most recent first; repeated
  // plays of one recording keep their own event-keyed rows.
  const history: CollectionRowModel[] = [...input.playHistory]
    .sort((a, b) => b.playedMs - a.playedMs)
    .flatMap((event) => {
      const recording = byId.get(event.recordingId);
      if (recording === undefined) {
        return [];
      }
      return [
        {
          key: `hist-${event.eventId}`,
          recordingId: recording.id,
          badge: null,
          row: toTrackRowModel(recording, {
            key: `hist-${event.eventId}`,
            liked: liked.has(recording.id),
          }),
        },
      ];
    });

  const likedRows: CollectionRowModel[] = items.map((row) => ({
    key: `liked-${row.key}`,
    recordingId: row.key,
    badge: null,
    row: { ...row, key: `liked-${row.key}` },
  }));

  // Ownable grid: user playlists plus liked album/artist entities.
  const entityLikes = likedEntityIds(input.likes);
  const cards: LibraryCardModel[] = [];
  for (const playlist of input.playlists) {
    const entries = playlistEntriesFor(
      input.playlistEntries,
      playlist.playlistId,
    );
    const first = entries[0];
    const artworkRecording =
      first === undefined ? undefined : byId.get(first.recordingId);
    cards.push({
      key: `playlist-${playlist.playlistId}`,
      kind: 'playlist',
      title: playlist.name,
      subtitle: t('playlist.meta', { count: entries.length }),
      count: entries.length,
      artworkUrl:
        artworkRecording === undefined
          ? null
          : pickArtworkUrl(artworkRecording.artwork),
      sortMs: playlist.updatedMs,
      playlistId: playlist.playlistId,
      entityRef: null,
      entityId: null,
    });
  }
  for (const entity of input.entities) {
    if (!entityLikes.has(`${entity.kind} ${entity.entityId}`)) {
      continue;
    }
    cards.push({
      key: `entity-${entity.entityId}`,
      kind: entity.kind,
      title: entity.title,
      subtitle:
        entity.kind === 'album'
          ? t('library.card.album', { artist: entity.artistName ?? '—' })
          : t('library.card.artist'),
      count: null,
      artworkUrl: pickArtworkUrl(entity.artwork),
      sortMs: entity.createdMs,
      playlistId: null,
      entityRef: entityRefFor(input.entitySourceRefs, entity.entityId),
      entityId: entity.entityId,
    });
  }

  // Followed-artists rail: liked artist entities (openable) then
  // artist names derived from liked tracks (browsable only).
  const rail = new Map<string, ArtistRailModel>();
  for (const entity of input.entities) {
    if (
      entity.kind !== 'artist' ||
      !entityLikes.has(`artist ${entity.entityId}`) ||
      rail.has(entity.title)
    ) {
      continue;
    }
    rail.set(entity.title, {
      key: `entity-${entity.entityId}`,
      name: entity.title,
      artworkUrl: pickArtworkUrl(entity.artwork),
      entityRef: entityRefFor(input.entitySourceRefs, entity.entityId),
    });
  }
  for (const item of items) {
    if (item.artist === null || rail.has(item.artist)) {
      continue;
    }
    rail.set(item.artist, {
      key: `artist-${item.artist}`,
      name: item.artist,
      artworkUrl: item.artworkUrl,
      entityRef: null,
    });
  }

  return {
    likedCount: items.length,
    items,
    collections: [
      {
        key: 'liked',
        label: t('collection.liked'),
        count: items.length,
        enabled: true,
        note: null,
      },
      {
        key: 'downloads',
        label: t('collection.downloads'),
        count: (input.downloads ?? []).filter(
          (d) => d.state === 'available',
        ).length,
        enabled: true,
        note: null,
      },
      {
        key: 'top50',
        label: t('collection.top50'),
        count: top50.length,
        enabled: true,
        note: null,
      },
      {
        key: 'history',
        label: t('collection.history'),
        count: history.length,
        enabled: true,
        note: null,
      },
    ],
    collectionRows: {
      liked: likedRows,
      top50,
      history,
      downloads: (input.downloads ?? [])
        .filter((d) => d.state !== 'removing')
        .sort((a, b) =>
          // Stored rows first, then in-flight, then failed; stable by
          // recordingId inside a state.
          chipRank(a.state) - chipRank(b.state) ||
          a.recordingId.localeCompare(b.recordingId),
        )
        .flatMap((d) => {
          const recording = byId.get(d.recordingId);
          if (recording === undefined) {
            return [];
          }
          return [
            {
              key: `dl-${d.downloadId}`,
              recordingId: recording.id,
              badge: downloadBadge(d),
              row: toTrackRowModel(recording, {
                key: `dl-${d.downloadId}`,
                liked: liked.has(recording.id),
                download: downloadChip(d.state),
              }),
            },
          ];
        }),
    },
    cards,
    artists: [...rail.values()],
    recentlyAdded: items.slice(0, 3),
    canCreatePlaylist: true,
  };
}

export function toCollectionModel(
  model: LibraryModel,
  key: 'liked' | 'top50' | 'history' | 'downloads',
): CollectionModel {
  return { key, title: t(`collection.${key}`), rows: model.collectionRows[key] };
}

function downloadChip(state: DownloadProgress['state']): DownloadChip {
  switch (state) {
    case 'requested':
      return 'queued';
    case 'transferring':
      return 'downloading';
    case 'available':
      return 'stored';
    default:
      return 'failed';
  }
}

function chipRank(state: DownloadProgress['state']): number {
  return state === 'available'
    ? 0
    : state === 'transferring' || state === 'requested'
      ? 1
      : 2;
}

function downloadBadge(d: DownloadProgress): string {
  if (
    d.state === 'transferring' &&
    d.totalBytes !== null &&
    d.totalBytes > 0
  ) {
    return t('collection.badge.percent', {
      value: Math.min(99, Math.round((d.transferredBytes / d.totalBytes) * 100)),
    });
  }
  return t(`track.download.${downloadChip(d.state)}`);
}

export function toPlaylistModel(input: {
  readonly playlistId: string;
  readonly playlists: readonly Playlist[];
  readonly playlistEntries: readonly PlaylistEntry[];
  readonly recordings: readonly Recording[];
  readonly likes: readonly Like[];
}): PlaylistModel | null {
  const playlist = input.playlists.find(
    (p) => p.playlistId === input.playlistId,
  );
  if (playlist === undefined) {
    return null;
  }
  const byId = indexById(input.recordings);
  const liked = likedIds(input.likes);
  const entries = playlistEntriesFor(
    input.playlistEntries,
    playlist.playlistId,
  );
  const perRecording = new Map<string, number>();
  for (const entry of entries) {
    perRecording.set(
      entry.recordingId,
      (perRecording.get(entry.recordingId) ?? 0) + 1,
    );
  }
  const rows: PlaylistEntryModel[] = entries.map((entry) => {
    const recording = byId.get(entry.recordingId);
    // Entry rows key on entryId — a duplicate keeps its own row.
    const row: TrackRowModel =
      recording === undefined
        ? {
          key: entry.entryId,
          title: t('track.unknown'),
          versionLabel: null,
          artist: null,
          durationMs: null,
          artworkUrl: null,
          liked: false,
          playing: false,
          state: 'unavailable',
          note: t('common.unavailable'),
          download: null,
        }
        : toTrackRowModel(recording, {
          key: entry.entryId,
          liked: liked.has(recording.id),
        });
    return {
      entryId: entry.entryId,
      recordingId: entry.recordingId,
      selectedRef: entry.selectedRef,
      duplicate: (perRecording.get(entry.recordingId) ?? 0) > 1,
      row,
    };
  });
  const first = entries[0];
  const artworkRecording =
    first === undefined ? undefined : byId.get(first.recordingId);
  return {
    playlistId: playlist.playlistId,
    name: playlist.name,
    count: rows.length,
    artworkUrl:
      artworkRecording === undefined
        ? null
        : pickArtworkUrl(artworkRecording.artwork),
    entries: rows,
  };
}

export function toEntityModel(input: {
  readonly page: EntityPage | null;
  readonly error: AppError | null;
  readonly likes: readonly Like[];
  readonly entitySourceRefs: readonly EntitySourceRef[];
  readonly loadingMore?: boolean | undefined;
  readonly playingRef?: SourceRef | null | undefined;
}): EntityScreenModel {
  const { page, error } = input;
  if (page === null) {
    return {
      phase: error === null ? 'loading' : 'error',
      kind: null,
      title: null,
      subtitle: null,
      artworkUrl: null,
      complete: true,
      liked: false,
      canLike: false,
      items: [],
      hasMore: false,
      loadingMore: false,
      message: error?.message ?? null,
    };
  }
  const entityId = entityIdForRef(
    input.entitySourceRefs,
    page.entity.sourceRef,
  );
  const liked =
    entityId !== null &&
    input.likes.some(
      (like) =>
        like.entityKind === page.entity.kind &&
        like.targetId === entityId,
    );
  return {
    phase: 'ready',
    kind: page.entity.kind,
    title: page.entity.title,
    subtitle: page.entity.subtitle,
    artworkUrl: pickArtworkUrl(page.entity.artwork, 256),
    complete: page.complete,
    liked,
    canLike: entityId !== null,
    items: page.items.map((meta, index) =>
      toSearchRowModel(meta, index, input.playingRef),
    ),
    hasMore: page.continuation !== null,
    loadingMore: input.loadingMore ?? false,
    // A refresh error while content stays surfaces as a flagged note.
    message: error?.message ?? null,
  };
}

export function toRailCard(recording: Recording): RailCardModel {
  return {
    key: recording.id,
    title: recording.title,
    subtitle: recording.artist,
    artworkUrl: pickArtworkUrl(recording.artwork),
  };
}

export function toHomeModel(input: {
  readonly recordings: readonly Recording[];
  readonly likes: readonly Like[];
  readonly suggestions: readonly TrackMetadata[];
  readonly playback: SessionPlayback;
  readonly greeting: string;
  readonly subline: string;
}): HomeModel {
  const byId = new Map(input.recordings.map((recording) => [recording.id, recording]));
  const recents = [...input.likes]
    .sort((a, b) => b.likedAtMs - a.likedAtMs)
    .map((like) =>
      like.entityKind === 'track' ? byId.get(like.targetId) : undefined,
    )
    .filter((recording): recording is Recording => recording !== undefined)
    .slice(0, 12)
    .map(toRailCard);
  const suggestions = input.suggestions.slice(0, 12).map((metadata) => ({
    key: `${metadata.sourceRef.provider}:${metadata.sourceRef.id}`,
    title: metadata.title,
    subtitle: metadata.artist,
    artworkUrl: pickArtworkUrl(metadata.artwork),
  }));
  const paused =
    input.playback.type === 'paused' ? input.playback : null;
  const resumeRecording =
    paused === null ? undefined : byId.get(paused.recordingId);
  const resume: ResumeModel | null =
    paused === null || resumeRecording === undefined
      ? null
      : {
          card: toRailCard(resumeRecording),
          positionMs: paused.positionMs,
          durationMs: paused.durationMs ?? null,
        };
  return {
    greeting: input.greeting,
    subline: input.subline,
    resume,
    recents,
    suggestions,
  };
}

export type LanguageOption = {
  readonly key: string;
  readonly label: string;
};

/**
 * The language picker's choices — 'system' plus every shipped
 * locale. Labels are endonyms (each language named in its own
 * language), so they are intentionally identical across catalogs.
 */
export function languageOptions(): readonly LanguageOption[] {
  return [
    { key: 'system', label: t('settings.languageValue.system') },
    { key: 'en', label: t('settings.languageValue.en') },
    { key: 'de', label: t('settings.languageValue.de') },
  ];
}

/**
 * Reduce a stored `Settings.language` to a `languageOptions()` key —
 * a persisted value may be a full BCP-47 tag ('de-DE'), so match on
 * the primary language subtag. Absent and unsupported values read as
 * 'system', mirroring how resolveLocale treats them.
 */
export function languageOptionKey(setting: string | null | undefined): string {
  const primary =
    setting === undefined || setting === null
      ? 'system'
      : (setting.toLowerCase().split('-').shift() ?? '');
  return languageOptions().some((option) => option.key === primary)
    ? primary
    : 'system';
}

/** Display name for a `Settings.language` value; unknown reads system. */
function languageLabel(setting: string | null | undefined): string {
  return (
    languageOptions().find(
      (option) => option.key === languageOptionKey(setting),
    )?.label ?? t('settings.languageValue.system')
  );
}

export function toSettingsModel(
  settings: Settings,
  diagnostics: DiagnosticsModel,
  media: {
    readonly storageText?: string | null;
    readonly localFolderCount?: number | undefined;
    readonly localSources?:
      | readonly { sourceId: string; label: string }[]
      | undefined;
    readonly downloadCount?: number | undefined;
    /**
     * False where the platform has no tag-reader surface (iOS today)
     * — the local-folder actions stay visible but disabled, never
     * silently dead.
     */
    readonly localSupported?: boolean;
    /**
     * False where the platform has no LAN-sync socket seam (iOS
     * today) — the row reports 'unavailable' and stays disabled.
     */
    readonly syncSupported?: boolean;
    /** 'not paired' / 'N connected' / 'N paired' — the row's value. */
    readonly syncLabel?: string | null;
  } = {},
): SettingsModel {
  return {
    theme: settings.theme,
    rows: [
      {
        key: 'theme',
        label: t('settings.theme'),
        value: t(`settings.themeValue.${settings.theme}`),
        kind: 'navigation',
        enabled: true,
      },
      {
        // Display preference, same shape as theme: a navigation row
        // whose value is the current choice; the host opens the
        // picker (LanguagePickerSheet) on select.
        key: 'language',
        label: t('settings.language'),
        value: languageLabel(settings.language),
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'catalogProvider',
        label: t('settings.catalogProvider'),
        value: settings.catalogProvider,
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'playbackProvider',
        label: t('settings.playbackProvider'),
        value: settings.playbackProvider,
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'lyricsProvider',
        label: t('settings.lyricsProvider'),
        value: settings.lyricsProvider ?? t('settings.value.auto'),
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'radioProvider',
        label: t('settings.radioProvider'),
        value: settings.radioProvider ?? t('settings.value.auto'),
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'storefront',
        label: t('settings.storefront'),
        value: settings.storefront ?? t('settings.value.notSet'),
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'qualityKbps',
        label: t('settings.quality'),
        value: t('settings.qualityUnit', { value: settings.qualityKbps }),
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'prefetch',
        label: t('settings.prefetch'),
        value: settings.prefetch
          ? t('settings.value.on')
          : t('settings.value.off'),
        kind: 'toggle',
        enabled: settings.prefetch,
      },
      {
        key: 'downloadMetered',
        label: t('settings.downloadMetered'),
        value: settings.downloadMetered
          ? t('settings.value.on')
          : t('settings.value.off'),
        kind: 'toggle',
        enabled: settings.downloadMetered === true,
      },
      {
        key: 'downloadStorage',
        label: t('settings.downloadStorage'),
        value: media.storageText ?? '—',
        kind: 'value',
        enabled: true,
      },
      {
        // Bounded LRU on disk (data.md ~200 MB) — the value is the
        // configured cap; picking a new one commits it and sweeps.
        key: 'artworkCacheBytes',
        label: t('settings.artworkCache'),
        value: t('settings.cacheUnit', {
          value: Math.round(
            (settings.artworkCacheBytes ?? ARTWORK_CACHE_BUDGET_DEFAULT_BYTES) /
              (1024 * 1024),
          ),
        }),
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'removeAllDownloads',
        label: t('settings.removeAllDownloads'),
        value:
          media.downloadCount === undefined
            ? null
            : `${media.downloadCount}`,
        kind: 'navigation',
        enabled: (media.downloadCount ?? 0) > 0,
      },
      {
        key: 'localSources',
        label: t('settings.localFolders'),
        value:
          media.localSupported === false
            ? t('settings.value.unsupported')
            : media.localFolderCount === undefined
              ? '—'
              : `${media.localFolderCount}`,
        kind: 'value',
        enabled: true,
      },
      // One removal row per granted source — the plan's local-files
      // "remove" affordance without a picker surface.
      ...(media.localSources ?? []).map((source) => ({
        key: `localSourceRemove:${source.sourceId}`,
        label: t('settings.removeSource', { label: source.label }),
        value: null,
        kind: 'navigation' as const,
        enabled: media.localSupported !== false,
      })),
      {
        key: 'addLocalFolder',
        label: t('settings.addLocalFolder'),
        value: null,
        kind: 'navigation',
        enabled: media.localSupported !== false,
      },
      {
        key: 'rescanLocal',
        label: t('settings.rescanLocal'),
        value: null,
        kind: 'navigation',
        enabled: media.localSupported !== false,
      },
      {
        key: 'sync',
        label: t('settings.sync'),
        value:
          media.syncSupported === false
            ? t('sync.status.unavailable')
            : (media.syncLabel ?? t('sync.status.notPaired')),
        kind: 'navigation',
        enabled: media.syncSupported !== false,
      },
      {
        key: 'exportLibrary',
        label: t('settings.exportLibrary'),
        value: null,
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'importLibrary',
        label: t('settings.importLibrary'),
        value: null,
        kind: 'navigation',
        enabled: true,
      },
    ],
    diagnostics,
  };
}

/* ------------------------------------------------------------------ */
/* Sync — LAN pairing panel: listener status, device list, the minted  */
/* pairing offer. The shapes mirror the desktop `api.sync.*` contract  */
/* verbatim (kept structural here so ui-web never imports app code).   */
/* ------------------------------------------------------------------ */

export type SyncStatusInput = {
  readonly listener: 'starting' | 'listening' | 'unavailable' | 'disabled';
  /** `ip:port` a peer dials, or null when nothing is up. */
  readonly endpoint: string | null;
  readonly boundPort: number | null;
  readonly advertise: 'off' | 'announcing' | 'unavailable';
  readonly pairedDevices: number;
  readonly sessions: number;
  readonly lastSyncAt: number | null;
  readonly engine: 'ready' | 'absent';
  readonly name: string;
  readonly fingerprint: string | null;
};

export type SyncDeviceInput = {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
};

/** The minted offer `api.sync.pairing()` returns — code + QR payload. */
export type SyncPairingInput = {
  readonly payload: string;
  readonly code: string;
  /** Primary `ip:port` — the typed path needs it shown next to the code. */
  readonly endpoint: string;
  readonly expiresAt: number;
};

export type SyncDeviceModel = {
  readonly id: string;
  readonly name: string;
  /** Relative label — 'paired 2h ago'. */
  readonly pairedLabel: string;
  /** Relative label — 'seen 5m ago'. */
  readonly lastSeenLabel: string;
};

export type SyncStatusModel = {
  readonly listenerLabel: string;
  readonly engineLabel: string;
  readonly nameLabel: string;
  /** The dialable address — null when the listener is down. */
  readonly addressLabel: string | null;
  readonly advertiseLabel: string;
  /** 'none' | '2 live' — active sync sessions. */
  readonly sessionsLabel: string;
  /** 'never' until the first exchange lands. */
  readonly lastSyncLabel: string;
  /** The device fingerprint — null until identity materializes. */
  readonly fingerprintLabel: string | null;
};

export type PairingModel = {
  readonly code: string;
  readonly payload: string;
  /** `ip:port` the typed code path dials. */
  readonly endpointLabel: string;
  /** 'expires in 4m' counting down to the offer's expiry; 'expired' past it. */
  readonly expiresLabel: string;
};

export type SyncPanelModel = {
  readonly status: SyncStatusModel | null;
  readonly devices: readonly SyncDeviceModel[];
  readonly pairing: PairingModel | null;
  /** Last pairing-mint failure (listener down, no address) — null when fine. */
  readonly pairErrorLabel: string | null;
};

/** Relative-time label: 'just now' / '5m' / '2h' / '3d' / ISO date. */
export function formatAgo(ms: number, nowMs: number): string {
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) {
    return '—';
  }
  const delta = nowMs - ms;
  if (delta < 0) {
    return '—';
  }
  if (delta < 60_000) {
    return t('ago.justNow');
  }
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) {
    return t('ago.minutes', { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t('ago.hours', { count: hours });
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return t('ago.days', { count: days });
  }
  return formatExportDate(ms) ?? '—';
}

function formatExpiry(expiresAt: number, nowMs: number): string {
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return t('sync.expires.expired');
  }
  const left = Math.ceil((expiresAt - nowMs) / 60_000);
  if (left >= 60) {
    return t('sync.expires.hours', { hours: Math.floor(left / 60) });
  }
  return t('sync.expires.minutes', { minutes: Math.max(1, left) });
}

export function toSyncPanel(
  status: SyncStatusInput | null,
  devices: readonly SyncDeviceInput[],
  pairing: SyncPairingInput | null,
  nowMs: number,
  pairError: string | null = null,
): SyncPanelModel {
  return {
    pairErrorLabel: pairError,
    status:
      status === null
        ? null
        : {
            listenerLabel: t(`sync.listener.${status.listener}`),
            engineLabel: t(`sync.engine.${status.engine}`),
            nameLabel: status.name,
            addressLabel: status.endpoint,
            advertiseLabel: t(`sync.advertise.${status.advertise}`),
            sessionsLabel:
              status.sessions === 0
                ? t('sync.sessions.none')
                : t('sync.sessions.live', { count: status.sessions }),
            lastSyncLabel:
              status.lastSyncAt === null
                ? t('sync.never')
                : formatAgo(status.lastSyncAt, nowMs),
            fingerprintLabel: status.fingerprint,
          },
    devices: devices.map((device) => ({
      id: device.id,
      name: device.name,
      pairedLabel: t('sync.device.paired', {
        when: formatAgo(device.pairedAt, nowMs),
      }),
      lastSeenLabel: t('sync.device.seen', {
        when: formatAgo(device.lastSeenAt, nowMs),
      }),
    })),
    pairing:
      pairing === null
        ? null
        : {
            code: pairing.code,
            payload: pairing.payload,
            endpointLabel: pairing.endpoint,
            expiresLabel: formatExpiry(pairing.expiresAt, nowMs),
          },
  };
}
