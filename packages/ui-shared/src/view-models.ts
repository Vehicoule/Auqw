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
  TrackMetadata,
} from '@auqw/application';
import { ARTWORK_CACHE_BUDGET_DEFAULT_BYTES, topPlayed } from '@auqw/application';

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
  const provenance = `${sheet.provider}${sheet.cached ? ' · cached' : ''}`;
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
        syncLabel: `synced · ${provenance}`,
        message: null,
      };
    }
    case 'plain':
      return {
        state: 'plain',
        lines: sheet.text.split('\n'),
        activeIndex: null,
        syncLabel: `unsynced · ${provenance}`,
        message: null,
      };
    case 'instrumental':
      return {
        ...empty,
        state: 'instrumental',
        message: 'this track is instrumental',
      };
    case 'unavailable':
      return {
        ...empty,
        state: 'unavailable',
        message: 'no lyrics matched this recording',
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
    label: `radio · ${radio.status}`,
    detail:
      radio.status === 'failed'
        ? (radio.error?.message ?? 'continuation failed')
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
        ? 'confirmed'
        : `confirmed · ${ref.provider}`;
    }
    case 'rejected':
      return 'all candidates rejected';
    default:
      return review.status;
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
        title: recording?.title ?? 'unknown recording',
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
      { key: 'recordings', label: 'tracks', count: counts.recordings },
      { key: 'likes', label: 'likes', count: counts.likes },
      { key: 'playlists', label: 'playlists', count: counts.playlists },
      {
        key: 'playlistEntries',
        label: 'playlist entries',
        count: counts.playlistEntries,
      },
      { key: 'entities', label: 'albums & artists', count: counts.entities },
      { key: 'playEvents', label: 'play history', count: counts.playEvents },
      { key: 'playCounts', label: 'play counts', count: counts.playCounts },
      {
        key: 'matchReviews',
        label: 'match reviews',
        count: counts.matchReviews,
      },
      { key: 'mappings', label: 'match mappings', count: counts.mappings },
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
): TrackRowModel {
  return {
    key: `${metadata.sourceRef.provider}:${metadata.sourceRef.id}:${index}`,
    title: metadata.title,
    versionLabel: null,
    artist: metadata.artist,
    durationMs: metadata.durationMs,
    artworkUrl: pickArtworkUrl(metadata.artwork),
    liked: false,
    playing: false,
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
        title: recording?.title ?? 'preparing',
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
        title: recording?.title ?? 'unknown track',
        positionMs: playback.positionMs,
        durationMs: playback.durationMs ?? recording?.durationMs ?? null,
        errorMessage: null,
      };
    case 'failed':
      return {
        ...base,
        status: 'failed',
        title: recording?.title ?? 'playback failed',
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
          title: 'unknown track',
          versionLabel: null,
          artist: null,
          durationMs: null,
          artworkUrl: null,
          liked: false,
          playing: current && queue.mode === 'playing',
          state: 'unavailable',
          note: 'unavailable',
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
          note: unavailable.has(recording.id) ? 'unavailable' : null,
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
    badge: `${entry.count} ${entry.count === 1 ? 'play' : 'plays'}`,
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
      subtitle: `user playlist · ${entries.length} ${entries.length === 1 ? 'track' : 'tracks'}`,
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
          ? `album · ${entity.artistName ?? '—'}`
          : 'artist',
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
        label: 'liked',
        count: items.length,
        enabled: true,
        note: null,
      },
      {
        key: 'downloads',
        label: 'downloads',
        count: (input.downloads ?? []).filter(
          (d) => d.state === 'available',
        ).length,
        enabled: true,
        note: null,
      },
      {
        key: 'top50',
        label: 'top 50',
        count: top50.length,
        enabled: true,
        note: null,
      },
      {
        key: 'history',
        label: 'history',
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
  const titles = {
    liked: 'liked',
    top50: 'top 50',
    history: 'history',
    downloads: 'downloads',
  } as const;
  return { key, title: titles[key], rows: model.collectionRows[key] };
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
    return `${Math.min(99, Math.round((d.transferredBytes / d.totalBytes) * 100))}%`;
  }
  return downloadChip(d.state);
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
          title: 'unknown track',
          versionLabel: null,
          artist: null,
          durationMs: null,
          artworkUrl: null,
          liked: false,
          playing: false,
          state: 'unavailable',
          note: 'unavailable',
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
    items: page.items.map((meta, index) => toSearchRowModel(meta, index)),
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
  } = {},
): SettingsModel {
  return {
    theme: settings.theme,
    rows: [
      {
        key: 'theme',
        label: 'theme',
        value: settings.theme,
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'catalogProvider',
        label: 'catalog provider',
        value: settings.catalogProvider,
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'playbackProvider',
        label: 'playback provider',
        value: settings.playbackProvider,
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'lyricsProvider',
        label: 'lyrics provider',
        value: settings.lyricsProvider ?? 'auto',
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'radioProvider',
        label: 'radio provider',
        value: settings.radioProvider ?? 'auto',
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'storefront',
        label: 'storefront',
        value: settings.storefront ?? 'not set',
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'qualityKbps',
        label: 'quality',
        value: `${settings.qualityKbps} kbps`,
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'prefetch',
        label: 'prefetch',
        value: settings.prefetch ? 'on' : 'off',
        kind: 'toggle',
        enabled: settings.prefetch,
      },
      {
        key: 'downloadMetered',
        label: 'downloads on cellular',
        value: settings.downloadMetered ? 'on' : 'off',
        kind: 'toggle',
        enabled: settings.downloadMetered === true,
      },
      {
        key: 'downloadStorage',
        label: 'download storage',
        value: media.storageText ?? '—',
        kind: 'value',
        enabled: true,
      },
      {
        // Bounded LRU on disk (data.md ~200 MB) — the value is the
        // configured cap; picking a new one commits it and sweeps.
        key: 'artworkCacheBytes',
        label: 'artwork cache',
        value: `${Math.round(
          (settings.artworkCacheBytes ?? ARTWORK_CACHE_BUDGET_DEFAULT_BYTES) /
            (1024 * 1024),
        )} mb`,
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'removeAllDownloads',
        label: 'remove all downloads',
        value:
          media.downloadCount === undefined
            ? null
            : `${media.downloadCount}`,
        kind: 'navigation',
        enabled: (media.downloadCount ?? 0) > 0,
      },
      {
        key: 'localSources',
        label: 'local folders',
        value:
          media.localSupported === false
            ? 'unsupported'
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
        label: `remove “${source.label}”`,
        value: null,
        kind: 'navigation' as const,
        enabled: media.localSupported !== false,
      })),
      {
        key: 'addLocalFolder',
        label: 'add local folder',
        value: null,
        kind: 'navigation',
        enabled: media.localSupported !== false,
      },
      {
        key: 'rescanLocal',
        label: 'rescan local folders',
        value: null,
        kind: 'navigation',
        enabled: media.localSupported !== false,
      },
      {
        key: 'exportLibrary',
        label: 'export library',
        value: null,
        kind: 'navigation',
        enabled: true,
      },
      {
        key: 'importLibrary',
        label: 'import library',
        value: null,
        kind: 'navigation',
        enabled: true,
      },
    ],
    diagnostics,
  };
}
