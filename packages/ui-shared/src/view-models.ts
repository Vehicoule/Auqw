import type { ThemeName } from '@auqw/design-tokens';
import type {
  AppError,
  ArtworkRef,
  AuthStatus,
  DownloadProgress,
  Entity,
  EntityKind,
  EntityPage,
  EntityRef,
  EntitySourceRef,
  ErrorKind,
  ImportPreview,
  Like,
  LyricsSheet,
  MatchReview,
  MatchReviewStatus,
  Playlist,
  PlaylistEntry,
  PlayCount,
  PlayEvent,
  QueueOrigin,
  QueueSnapshot,
  RadioTail,
  Recording,
  RepeatMode,
  SessionPlayback,
  Settings,
  SourceRef,
  SyncClientStatus,
  TrackMetadata,
  UpdateApplyStatus,
  UpdateSnapshot,
  UpdateStatus,
} from '@auqw/application';
import {
  ARTWORK_CACHE_BUDGET_DEFAULT_BYTES,
  displayIdentityKey,
  isBotCheckWall,
  matchDisplayKey,
  sameSongIdentity,
  topPlayed,
} from '@auqw/application';
import { fromTag, t, type Locale, type MessageId } from './i18n.ts';
import { errorText } from './error-text.ts';

export type PlatformVariant = 'android' | 'ios';

type TrackRowState = 'available' | 'unavailable' | 'error';

/** Owned-bytes state on a track row — honest download chip. */
export type DownloadChip =
  | 'idle'
  | 'queued'
  | 'downloading'
  | 'stored'
  | 'failed'
  | 'removing';

export type TrackRowModel = {
  readonly key: string;
  readonly title: string;
  readonly versionLabel: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly durationMs: number | null;
  readonly artworkUrl: string | null;
  readonly liked: boolean;
  readonly playing: boolean;
  readonly state: TrackRowState;
  readonly note: string | null;
  readonly download: DownloadChip | null;
  /** The recording already sits in a user playlist — the add-to-playlist
        button draws its check instead of the plus. */
  readonly inPlaylist: boolean;
};

type PlayerStatus = 'preparing' | 'buffering' | 'playing' | 'paused' | 'failed';

export type PlayerModel = {
  readonly status: PlayerStatus;
  /**
   * The user's effective play/pause intent — queue mode is
   * 'playing' AND transport hasn't already paused on its own (a
   * native status pause keeps queue intent but still needs a
   * resume, not another pause). Controls key glyph and action on
   * this, not `status`: a retry backoff publishes 'preparing' while
   * the intent stays playing, and pause must still win there.
   */
  readonly intentPlaying: boolean;
  readonly title: string;
  readonly artist: string | null;
  readonly albumLabel: string | null;
  readonly artworkUrl: string | null;
  readonly positionMs: number;
  readonly durationMs: number | null;
  /** Identity of the queue occurrence on the player — surfaces key
   *  per-track transient state (optimistic scrub holds) on it. */
  readonly occurrenceId: string | null;
  /** The playing item's recording id — the action target for like,
   *  playlist and ⋯ row-actions affordances; null for ref-only play. */
  readonly recordingId: string | null;
  readonly liked: boolean;
  readonly inPlaylist: boolean;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly errorMessage: string | null;
  /**
   * Recovery affordance on a failed attempt — 'sign-in' only when the
   * verdict is a provider bot wall AND the caller reported a signed-out
   * auth seam. `authSignedIn: undefined` (no auth surface at all) hides
   * it: there is nothing to offer. It's a CTA, not a modal — the error
   * line itself is unchanged.
   */
  readonly recovery: 'sign-in' | null;
};

/**
 * Display section of a queue row: the current track first, then the
 * pending entries it leads into, then what already played — the
 * standard player queue anatomy. 'autoplay' is the radio tail's
 * suggestion band: those rows sit at up-next positions but are
 * provider-minted, so they section apart — dimmed, no per-row
 * remove, untouched by the up-next Clear.
 */
export type QueueSectionKey = 'nowPlaying' | 'upNext' | 'autoplay' | 'history';

export type QueueItemModel = {
  readonly occurrenceId: string;
  readonly recordingId: string;
  /** Canonical occurrence index — move calls index into this order. */
  readonly index: number;
  readonly section: QueueSectionKey;
  readonly current: boolean;
  readonly duplicate: boolean;
  readonly row: TrackRowModel;
};

export type QueueSection = {
  readonly key: QueueSectionKey;
  /**
   * Localized header text — 'up next' counts its rows ('up next ·
   * N'), 'autoplay' names its seed ('autoplay · similar to {title}')
   * when the tail's seed resolves to a known title.
   */
  readonly heading: string;
  readonly items: readonly QueueItemModel[];
};

export type QueueModel = {
  /** Canonical occurrence order — the order the engine walks. */
  readonly items: readonly QueueItemModel[];
  /**
   * Display order, grouped: nowPlaying, upNext, autoplay, history —
   * only non-empty sections appear. Reorder interactions are
   * confined to `upNext` items.
   */
  readonly sections: readonly QueueSection[];
  readonly mode: QueueSnapshot['mode'];
  readonly positionMs: number;
  readonly currentOccurrenceId: string | null;
  /**
   * Items remain but nothing is current — the drained (or
   * never-started) queue a surface may keep showing instead of
   * dropping to an empty state.
   */
  readonly ended: boolean;
  /** Which surface minted this queue — the "playing from …" line. */
  readonly origin: QueueOrigin | null;
  /**
   * Whole-queue duration — null when any occurrence's recording is
   * missing or has no duration so the header never under-reports.
   */
  readonly totalDurationMs: number | null;
};

type SearchPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'unavailable';

/** Result-set filter — 'songs' is the whole set today (every result
    is a track) but names the subset the contract reserves. */
export type SearchFilter = 'all' | 'songs' | 'library';

export type SearchHeroModel = {
  readonly row: TrackRowModel;
  /** 'song · artist · year/album' — composed from the #1 result. */
  readonly metaLabel: string;
};

export type SearchStateModel = {
  readonly phase: SearchPhase;
  readonly query: string;
  readonly results: readonly TrackRowModel[];
  readonly filter: SearchFilter;
  /** Provider's top-ranked result after the filter — the hero card. */
  readonly hero: SearchHeroModel | null;
  /**
   * The play context behind `results` — the visible provider items
   * (deduped reps, post-filter). Playing a row queues exactly what the
   * list shows; feeding the raw page would materialize filtered-out
   * tracks as recordings and re-expand 'in your library' membership.
   */
  readonly playItems: readonly TrackMetadata[];
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
  /** Quick-access tiles — the same four the library lists. */
  readonly collections: readonly CollectionTileModel[];
  /** Materialized track recordings ordered by like time. */
  readonly recents: readonly RailCardModel[];
  /** Materialized recordings at their latest counted play. */
  readonly played: readonly RailCardModel[];
  /** Provider metadata from the current committed search page. */
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
  readonly key: CollectionKey;
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
  /**
   * Marks remove/clear actions so surfaces can render the label in
   * the warn color — mirrors the `destructive` flag on sheet actions.
   */
  readonly destructive?: boolean;
};

export type DiagnosticsModel = {
  readonly providerIds: readonly string[];
  readonly attemptCount: number;
  readonly lastAttemptLabel: string | null;
  /**
   * The last failed playback verdict as `kind · message` — the leg
   * that actually died (resolve vs stream vs media), kept after the
   * player recovers so the settings screen can name it.
   */
  readonly lastFailure: string | null;
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
type LyricsState = 'loading' | 'synced' | 'plain' | 'instrumental' | 'unavailable' | 'error';

export type LyricsModel = {
  readonly state: LyricsState;
  readonly lines: readonly string[];
  /** Non-null only when `state === 'synced'` — never else. */
  readonly activeIndex: number | null;
  /** The honest sync-state label (`synced` / `unsynced` + provenance). */
  readonly syncLabel: string | null;
  /** Detail for non-content states — the humanized error reason. */
  readonly message: string | null;
};

/**
 * Maps the session's `LyricsSheet` (plus the fetch lifecycle the
 * caller tracks) to the Stage lyrics model. `activeIndex` is the
 * last timed line at or before `positionMs` — line 0 during the
 * intro, before the first timestamp — and provenance rides the sync
 * label as `<state> · <provider>[ · cached]`.
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
      message: errorText(error),
    };
  }
  const provenance = `${sheet.provider}${sheet.cached ? t('lyrics.cachedSuffix') : ''}`;
  switch (sheet.kind) {
    case 'synced': {
      const found = sheet.lines.findLastIndex(
        (line) => line.tMs <= input.positionMs,
      );
      // Before the first timestamp the intro still owns a highlighted
      // line — holding line 0 beats showing no highlight at all.
      const activeIndex =
        found === -1 ? (sheet.lines.length > 0 ? 0 : null) : found;
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
    case 'unavailable':
      return {
        ...empty,
        state: sheet.kind,
        message: t(
          sheet.kind === 'instrumental'
            ? 'lyrics.instrumentalMessage'
            : 'lyrics.noMatch',
        ),
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
    return { armed: false, status: null, fetching: false, label: null, detail: null };
  }
  return {
    armed: true,
    status: radio.status,
    fetching: radio.fetching,
    label: t('radio.label', { status: t(`radio.status.${radio.status}`) }),
    detail:
      radio.status === 'failed'
        ? (errorText(radio.error) ?? t('radio.continuationFailed'))
        : radio.providerId,
  };
}

// ---- corrections (diagnostics review queue) ------------------------

type ReviewCandidateModel = {
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
  if (review.status !== 'confirmed') {
    return t(`corrections.status.${review.status}`);
  }
  const ref = review.resolution?.ref;
  return ref === null || ref === undefined
    ? t('corrections.status.confirmed')
    : t('corrections.status.confirmedProvider', { provider: ref.provider });
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
      message: errorText(input.error),
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
    .sort((a, b) => rank(a) - rank(b) || b.createdMs - a.createdMs)
    .map((review) => {
      const recording = byId.get(review.recordingId);
      // One row per display group: parked candidates that render
      // identically (same provider + normalized title/artist + same
      // shown duration) collapse to their representative — the first
      // parked member — whose stored index is what `confirm` indexes.
      const seen = new Set<string>();
      const candidates: ReviewCandidateModel[] = [];
      review.candidates.forEach((candidate, index) => {
        const key = matchDisplayKey({
          provider: candidate.ref.provider,
          title: candidate.metadata.title,
          artist: candidate.metadata.artist ?? null,
          durationMs: candidate.metadata.durationMs ?? null,
        });
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        candidates.push({
          index,
          title: candidate.metadata.title,
          subtitle:
            `${candidate.metadata.artist ?? '—'} · ${candidate.ref.provider}` +
            (candidate.metadata.durationMs !== null
              ? ` · ${formatClock(candidate.metadata.durationMs)}`
              : ''),
        });
      });
      return {
        reviewId: review.reviewId,
        title: recording?.title ?? t('corrections.unknownRecording'),
        artist: recording?.artist ?? null,
        status: review.status,
        statusLabel: reviewStatusLabel(review),
        candidates,
      };
    });
  const pending = rows.filter((row) => row.status === 'pending').length;
  const visible =
    input.filter === 'all'
      ? rows
      : rows.filter(
          (row) => (row.status === 'pending') === (input.filter === 'pending'),
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
  /** The humanized reason from the last failed op, if any. */
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
        : t(`sync.state.${view.state === 'open' ? 'connected' : view.state}`),
      syncing: view.syncing,
      lastSyncLabel:
        view.peer.lastSyncAt === undefined
          ? null
          : t('sync.lastSync', { date: fmt(view.peer.lastSyncAt) ?? '—' }),
      endpointLabel: view.peer.endpoints[0] ?? null,
      lastError: errorText(view.lastError),
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

type ImportPreviewRowModel = {
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
    rows: (
      [
        ['recordings', 'import.tracks'],
        ['likes', 'import.likes'],
        ['playlists', 'import.playlists'],
        ['playlistEntries', 'import.playlistEntries'],
        ['entities', 'import.entities'],
        ['playEvents', 'import.playHistory'],
        ['playCounts', 'import.playCounts'],
        ['matchReviews', 'import.matchReviews'],
        ['mappings', 'import.matchMappings'],
      ] as const
    ).map(([key, label]) => ({ key, label: t(label), count: counts[key] })),
  };
}

export type TransferModel = {
  readonly exportPhase: 'idle' | 'working' | 'done' | 'error';
  /** The written path on `done`; the typed message on `error`. */
  readonly exportDetail: string | null;
  readonly importPhase: 'idle' | 'reading' | 'preview' | 'applying' | 'done' | 'error';
  /** The typed message on `error`; the applied summary on `done`. */
  readonly importDetail: string | null;
  readonly preview: ImportPreviewModel | null;
};

export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

/** Long-form duration for header chrome — `48m`, `1h 12m`. */
export function formatLongDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const remainder = minutes % 60;
  return remainder === 0
    ? `${Math.floor(minutes / 60)}h`
    : `${Math.floor(minutes / 60)}h ${remainder}m`;
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
  let best: ArtworkRef | null = null;
  let largest: ArtworkRef | null = artwork[0] ?? null;
  for (const ref of artwork) {
    if (ref.width !== null && ref.width >= (largest?.width ?? 0)) {
      largest = ref;
    }
    const width = ref.width ?? Number.MAX_SAFE_INTEGER;
    const bestWidth = best?.width ?? Number.MAX_SAFE_INTEGER;
    if (width >= targetWidth && width < bestWidth) {
      best = ref;
    }
  }
  return (best ?? largest)?.url ?? null;
}

function albumLabel(recording: Recording): string | null {
  const parts = [recording.album, recording.releaseYear].filter(
    (part) => part !== null,
  );
  return parts.length === 0 ? null : parts.join(' · ');
}

type TrackRowOptions = {
  readonly key?: string;
  readonly liked?: boolean;
  readonly inPlaylist?: boolean;
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
    album: recording.album,
    durationMs: recording.durationMs,
    artworkUrl: pickArtworkUrl(recording.artwork),
    liked: options.liked ?? false,
    inPlaylist: options.inPlaylist ?? false,
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
  inPlaylist = false,
): TrackRowModel {
  return {
    key: `${metadata.sourceRef.provider}:${metadata.sourceRef.id}:${index}`,
    title: metadata.title,
    versionLabel: null,
    artist: metadata.artist,
    album: metadata.album,
    durationMs: metadata.durationMs,
    artworkUrl: pickArtworkUrl(metadata.artwork),
    liked: false,
    // A catalog row marks playing only when its own sourceRef is the
    // ref the player resolved — the accent row + eq overlay the
    // preview draws inside result lists.
    playing:
      playingRef != null &&
      metadata.sourceRef.provider === playingRef.provider &&
      metadata.sourceRef.kind === playingRef.kind &&
      metadata.sourceRef.id === playingRef.id,
    state: 'available',
    note: null,
    download: null,
    inPlaylist,
  };
}

/** The row for a recording that isn't in the library — honest unknown. */
function missingRecordingRow(key: string, playing: boolean): TrackRowModel {
  return {
    inPlaylist: false,
    key,
    title: t('track.unknown'),
    versionLabel: null,
    artist: null,
    album: null,
    durationMs: null,
    artworkUrl: null,
    liked: false,
    playing,
    state: 'unavailable',
    note: t('common.unavailable'),
    download: null,
  };
}

type PlayerModelInput = {
  readonly playback: SessionPlayback;
  readonly queue: QueueSnapshot;
  readonly recordings: readonly Recording[];
  readonly likes: readonly Like[];
  readonly playlistEntries?: readonly PlaylistEntry[];
  readonly repeat: RepeatMode;
  /** The dealt play order under shuffle (occurrence ids); canonical when null. */
  readonly shuffleOrder: readonly string[] | null;
  /**
   * The platform's auth-seam read: `false` = OAuth surface exists and
   * the user is signed out (the wall CTA may offer sign-in), `true`
   * suppresses it (a token is already applied — re-pairing wouldn't
   * fix this wall), `undefined` = no auth seam on this platform.
   */
  readonly authSignedIn?: boolean | undefined;
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

/** Recordings that already sit in any playlist — the addpl check. */
function playlistRecordingIds(
  entries: readonly PlaylistEntry[],
): ReadonlySet<string> {
  return new Set(entries.map((entry) => entry.recordingId));
}

/** SourceRef identity shared by catalog rows and stored selected_refs. */
export function refKey(ref: SourceRef | null | undefined): string | null {
  return ref === null || ref === undefined
    ? null
    : `${ref.provider}:${ref.kind}:${ref.id}`;
}

/** Remote tracks parked in playlists — catalog rows test membership
    on this set. Entries carry the identity two ways: a parked
    `selectedRef` for tracks added straight from a provider, and a
    `recordingId` whose recording's own `sourceRefs` mark the catalog
    tracks it materialized — a saved catalog track tests positive on
    either identity. */
export function playlistSourceRefs(
  entries: readonly PlaylistEntry[],
  recordings: readonly Recording[],
): ReadonlySet<string> {
  const byId = indexById(recordings);
  const refs = new Set<string>();
  for (const entry of entries) {
    const key = refKey(entry.selectedRef);
    if (key !== null) refs.add(key);
    for (const ref of byId.get(entry.recordingId)?.sourceRefs ?? []) {
      refs.add(`${ref.provider}:${ref.kind}:${ref.id}`);
    }
  }
  return refs;
}

/** Every track ref the library owns — 'in your library' membership
    for catalog rows is this set. */
export function librarySourceRefs(
  recordings: readonly Recording[],
): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const recording of recordings) {
    for (const ref of recording.sourceRefs) {
      refs.add(`${ref.provider}:${ref.kind}:${ref.id}`);
    }
  }
  return refs;
}

/** recordingId → occurrence count — duplicates keep row identity. */
function countByRecordingId(
  rows: readonly { readonly recordingId: string }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.recordingId, (counts.get(row.recordingId) ?? 0) + 1);
  }
  return counts;
}

/**
 * The occurrence `session.next()` would land on — mirrors the
 * engine's mark-skipping walk so a UI gate (offline ownership,
 * availability) tests the same row the cursor actually plays. The
 * dealt order is the walk under shuffle, the canonical occurrence
 * order otherwise; rows already marked failed drop out of both.
 * Under repeat=all an exhausted forward walk wraps to the first
 * unmarked row in both walks — matching the cursor's own wrap rules.
 * A null cursor (an ended or never-started queue) yields null —
 * the engine's next() is a no-op there that never wraps.
 */
export function nextQueueDestination(input: {
  readonly queue: {
    readonly occurrences: readonly { readonly occurrenceId: string }[];
    readonly currentOccurrenceId: string | null;
  };
  /** The dealt play order under shuffle; canonical when null/absent. */
  readonly dealtOrder?: readonly string[] | null;
  /** Occurrence ids marked failed this session. */
  readonly failedIds?: ReadonlySet<string>;
  readonly repeat: RepeatMode;
}): string | null {
  const { queue, repeat, failedIds } = input;
  // A null cursor means the queue ended (or never started): the
  // engine's advance() fails 'no-result' on it before any wrap — no
  // destination exists even under repeat=all.
  if (queue.currentOccurrenceId === null) {
    return null;
  }
  const walk =
    input.dealtOrder ?? queue.occurrences.map((o) => o.occurrenceId);
  const unmarked = (id: string): boolean => failedIds?.has(id) !== true;
  const pos = walk.indexOf(queue.currentOccurrenceId);
  const next = pos >= 0 ? walk.slice(pos + 1).find(unmarked) : undefined;
  if (next !== undefined) {
    return next;
  }
  if (repeat !== 'all') {
    return null;
  }
  // The wrap picks the first unmarked head — the same edge the engine
  // makes after `next()` stops at the tail; all-failed ends the walk
  // instead of replaying a known-dead row. A cursor missing from the
  // deal (pos < 0) wraps too — the dealt branch wraps it the same way.
  return walk.find(unmarked) ?? null;
}

/**
 * Verdicts the player line never paints: 'superseded'/'cancelled' are
 * bookkeeping — a queue jump overtook the play or the caller unwound
 * the attempt — not user-facing failure. `errorText` already silences
 * 'superseded'; the player surface adds 'cancelled' (loud elsewhere —
 * providers return it as a real search verdict — but on a playback
 * attempt it can only mean the intent was torn down).
 */
const PLAYER_ERROR_SILENT: ReadonlySet<ErrorKind> = new Set([
  'cancelled',
  'superseded',
]);

export function toPlayerModel(input: PlayerModelInput): PlayerModel | null {
  const { playback, queue, recordings, likes, repeat, shuffleOrder } =
    input;
  const inPlaylist = playlistRecordingIds(input.playlistEntries ?? []);
  if (playback.type === 'idle') {
    return null;
  }
  const byId = indexById(recordings);
  const liked = likedIds(likes);
  // Transport enablement anchors on what's on the player — during a
  // transition the playing occurrence can legitimately differ from
  // the queue's current until the reconcile lands.
  const activeId = playback.occurrenceId ?? queue.currentOccurrenceId;
  // Boundaries live in walk space: the dealt order under shuffle, the
  // canonical occurrence order otherwise — same space the cursor uses.
  const walk = shuffleOrder ?? queue.occurrences.map((o) => o.occurrenceId);
  const currentIndex = activeId === null ? -1 : walk.indexOf(activeId);
  // Under repeat=all the wrap edges are real moves — the transport
  // keeps both controls enabled at walk boundaries so they stay
  // reachable (the cursor applies the same wrap rules; a lone item
  // self-wraps into an in-place restart).
  const wraps = repeat === 'all' && walk.length > 0;
  const recordingId = playback.recordingId;
  const recording = recordingId === null ? undefined : byId.get(recordingId);
  const base = {
    occurrenceId: activeId,
    recordingId,
    artist: recording?.artist ?? null,
    albumLabel: recording === undefined ? null : albumLabel(recording),
    artworkUrl:
      // The player model feeds surfaces from the 52 px mini-player up to
      // the full-bleed stage backdrop — pick at backdrop size; smaller
      // consumers downscale the same cached file.
      recording === undefined ? null : pickArtworkUrl(recording.artwork, 512),
    liked: recordingId !== null && liked.has(recordingId),
    inPlaylist: recordingId !== null && inPlaylist.has(recordingId),
    canPrevious: currentIndex > 0 || (wraps && currentIndex === 0),
    canNext:
      currentIndex >= 0 && (currentIndex < walk.length - 1 || wraps),
    // 'failed' keeps the queue's 'playing' intent but has nothing to
    // pause — the affordance is a retry, so it reads as not-playing.
    intentPlaying:
      queue.mode === 'playing' &&
      playback.type !== 'paused' &&
      playback.type !== 'failed',
  };
  switch (playback.type) {
    case 'preparing':
    case 'failed':
      return {
        ...base,
        status: playback.type,
        title: recording?.title ?? t(`player.title.${playback.type}`),
        // The queue's position is authoritative for both states — the
        // pending 'prepared' outcome plays from the seek intent, and a
        // failed attempt parks the occurrence where retry resumes.
        positionMs: queue.positionMs,
        durationMs: recording?.durationMs ?? null,
        errorMessage:
          playback.type === 'failed' &&
          !PLAYER_ERROR_SILENT.has(playback.error.kind)
            ? errorText(playback.error)
            : null,
        // The wall CTA rides the same failed attempt — a signed-in
        // user (or a platform with no auth seam) gets no offer.
        recovery:
          playback.type === 'failed' &&
          input.authSignedIn === false &&
          isBotCheckWall(playback.error)
            ? 'sign-in'
            : null,
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
        recovery: null,
      };
  }
}

type QueueModelInput = {
  readonly queue: QueueSnapshot;
  readonly recordings: readonly Recording[];
  readonly likes?: readonly Like[];
  readonly playlistEntries?: readonly PlaylistEntry[];
  readonly unavailableRecordingIds?: ReadonlySet<string> | undefined;
  /**
   * Occurrences whose playback attempt failed — marked 'error' so the
   * queue doesn't silently retry them on the way through (advance
   * already steps over the blocked current; the row makes it visible).
   */
  readonly failedOccurrenceIds?: ReadonlySet<string> | undefined;
  /**
   * The playback walk under shuffle — the dealt order the service
   * cursor follows. Section membership and ordering follow it (the
   * next row after current really is "up next"); occurrences absent
   * from the deal — enqueued after it — trail the up-next tail in
   * canonical order. Omitted or a deal that lost the current id falls
   * back to canonical partitioning.
   */
  readonly dealtOrder?: readonly string[] | undefined;
  /**
   * Occurrence ids the radio tail minted — rows in this set that
   * land after the cursor section as 'autoplay' instead of 'upNext'.
   */
  readonly radioOccurrenceIds?: ReadonlySet<string> | undefined;
  /**
   * The armed tail — its `seedRef` names the autoplay section
   * ('autoplay · similar to {title}'). A seed that resolves to no
   * known title keeps the bare 'autoplay' header.
   */
  readonly radio?: RadioTail | null;
  readonly entities?: readonly Entity[] | undefined;
  readonly entitySourceRefs?: readonly EntitySourceRef[] | undefined;
};

export function toQueueModel(input: QueueModelInput): QueueModel {
  const { queue, recordings } = input;
  const byId = indexById(recordings);
  const liked = likedIds(input.likes ?? []);
  const inPlaylist = playlistRecordingIds(input.playlistEntries ?? []);
  const unavailable = input.unavailableRecordingIds ?? new Set<string>();
  const currentIndex = queue.occurrences.findIndex(
    (o) => o.occurrenceId === queue.currentOccurrenceId,
  );
  const dealt = input.dealtOrder;
  const dealIndex = new Map<string, number>();
  dealt?.forEach((id, i) => {
    dealIndex.set(id, dealIndex.get(id) ?? i);
  });
  const useWalk =
    dealt !== undefined &&
    queue.currentOccurrenceId !== null &&
    dealIndex.has(queue.currentOccurrenceId);
  // Position in the playback walk; undealt rows sit past the dealt
  // tail in canonical order so a fresh enqueue can't land in history.
  const walkPos = (occurrenceId: string, canonicalIndex: number): number =>
    useWalk
      ? (dealIndex.get(occurrenceId) ?? dealt.length + canonicalIndex)
      : canonicalIndex;
  const currentWalk =
    queue.currentOccurrenceId === null
      ? -1
      : walkPos(queue.currentOccurrenceId, currentIndex);
  const failed = new Set(input.failedOccurrenceIds ?? []);
  // A blocked current is a failed current — mark it even when the
  // caller didn't pass the playback state through.
  if (queue.blockedError !== undefined && queue.currentOccurrenceId !== null) {
    failed.add(queue.currentOccurrenceId);
  }
  const occurrencesByRecording = countByRecordingId(queue.occurrences);
  const radioIds = input.radioOccurrenceIds ?? new Set<string>();
  const items: QueueItemModel[] = queue.occurrences.map(
    (occurrence, index) => {
      const recording = byId.get(occurrence.recordingId);
      const current = occurrence.occurrenceId === queue.currentOccurrenceId;
      const isFailed = failed.has(occurrence.occurrenceId);
      const pos = walkPos(occurrence.occurrenceId, index);
      const suggested = radioIds.has(occurrence.occurrenceId);
      const section: QueueSectionKey =
        currentIndex === -1
          ? suggested
            ? 'autoplay'
            : 'upNext'
          : current
            ? 'nowPlaying'
            : pos > currentWalk
              ? suggested
                ? 'autoplay'
                : 'upNext'
              : 'history';
      const row: TrackRowModel =
        recording === undefined
          ? missingRecordingRow(
              occurrence.occurrenceId,
              current && queue.mode === 'playing',
            )
          : toTrackRowModel(recording, {
              key: occurrence.occurrenceId,
              liked: liked.has(recording.id),
              inPlaylist: inPlaylist.has(recording.id),
              playing: current && queue.mode === 'playing',
              state: isFailed
                ? 'error'
                : unavailable.has(recording.id)
                  ? 'unavailable'
                  : 'available',
              note: isFailed
                ? t('queue.failed')
                : unavailable.has(recording.id)
                  ? t('common.unavailable')
                  : null,
            });
      return {
        occurrenceId: occurrence.occurrenceId,
        recordingId: occurrence.recordingId,
        index,
        section,
        current,
        duplicate:
          (occurrencesByRecording.get(occurrence.recordingId) ?? 0) > 1,
        row,
      };
    },
  );
  // The seed that armed the tail: a track seed names its recording's
  // title, an entity seed its entity's title — either may be gone
  // from the library by read time (bare 'autoplay' then).
  const seed = input.radio?.seedRef ?? null;
  const autoplaySeed =
    seed === null
      ? null
      : seed.kind === 'track'
        ? (recordings.find((recording) =>
            recording.sourceRefs.some((ref) => refKey(ref) === refKey(seed)),
          )?.title ?? null)
        : ((input.entities ?? []).find(
            (entity) =>
              entity.entityId ===
              (input.entitySourceRefs ?? []).find(
                (entry) => refKey(entry.ref) === refKey(seed),
              )?.entityId,
          )?.title ?? null);
  let totalDurationMs = 0;
  for (const occurrence of queue.occurrences) {
    const durationMs = byId.get(occurrence.recordingId)?.durationMs;
    if (durationMs === undefined || durationMs === null) {
      totalDurationMs = -1;
      break;
    }
    totalDurationMs += durationMs;
  }
  const sections: QueueSection[] = (
    ['nowPlaying', 'upNext', 'autoplay', 'history'] as const
  ).flatMap((key) => {
    // Within a section rows follow the playback walk — under shuffle
    // the dealt order, otherwise canonical.
    const sectionItems = items
      .filter((item) => item.section === key)
      .sort(
        (a, b) =>
          walkPos(a.occurrenceId, a.index) - walkPos(b.occurrenceId, b.index),
      );
    if (sectionItems.length === 0) {
      return [];
    }
    const heading =
      key === 'upNext'
        ? `${t('queue.upNext')} · ${sectionItems.length}`
        : key === 'autoplay'
          ? autoplaySeed === null
            ? t('queue.autoplay')
            : t('queue.autoplaySimilar', { name: autoplaySeed })
          : t(`queue.${key}`);
    return [{ key, heading, items: sectionItems }];
  });
  return {
    items,
    sections,
    mode: queue.mode,
    positionMs: queue.positionMs,
    currentOccurrenceId: queue.currentOccurrenceId,
    ended: items.length > 0 && queue.currentOccurrenceId === null,
    origin: queue.origin ?? null,
    totalDurationMs: totalDurationMs <= 0 ? null : totalDurationMs,
  };
}

/**
 * One sideswipe landing row — the track the mini-player's conveyor
 * previews sliding in from its edge. `occurrenceId` (not recordingId)
 * identifies it because 'previous' past the restart threshold targets
 * the occurrence already on the player, and the pill's commit path
 * keys its invisible reset on that identity.
 */
export type SkipPeek = {
  readonly occurrenceId: string;
  readonly title: string;
  readonly artist: string | null;
  readonly artworkUrl: string | null;
};

/**
 * The conveyor's landing row for an already-resolved walk-space
 * target (advanceTargetId's answer — engine semantics, dealt order
 * and failed marks included). Null target or a target missing from
 * the model is a dead edge: no peek, no commit.
 */
export function skipPeekFor(
  queue: QueueModel,
  occurrenceId: string | null,
): SkipPeek | null {
  if (occurrenceId === null) {
    return null;
  }
  const item = queue.items.find((i) => i.occurrenceId === occurrenceId);
  if (item === undefined) {
    return null;
  }
  return {
    occurrenceId,
    title: item.row.title,
    artist: item.row.artist,
    artworkUrl: item.row.artworkUrl,
  };
}

function likedEntityIds(likes: readonly Like[]): ReadonlySet<string> {
  return new Set(
    likes
      .filter((like) => like.entityKind !== 'track')
      .map((like) => `${like.entityKind} ${like.targetId}`),
  );
}

const EMPTY_ENTRIES: readonly PlaylistEntry[] = [];

/**
 * All playlist entries bucketed by playlist, each bucket sorted by
 * position — one pass for models that need every playlist's entries
 * instead of a filter+sort per playlist.
 */
function playlistEntriesByPlaylist(
  entries: readonly PlaylistEntry[],
): Map<string, PlaylistEntry[]> {
  const byPlaylist = new Map<string, PlaylistEntry[]>();
  for (const entry of entries) {
    const bucket = byPlaylist.get(entry.playlistId);
    if (bucket === undefined) {
      byPlaylist.set(entry.playlistId, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  for (const bucket of byPlaylist.values()) {
    bucket.sort((a, b) => a.position - b.position);
  }
  return byPlaylist;
}

/** entityId → ref lookup — one pass for models resolving many refs. */
function entityRefMap(
  refs: readonly EntitySourceRef[],
): Map<string, EntityRef> {
  const map = new Map<string, EntityRef>();
  for (const ref of refs) {
    map.set(ref.entityId, map.get(ref.entityId) ?? ref.ref);
  }
  return map;
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
  const inPlaylist = playlistRecordingIds(input.playlistEntries);
  const collectionRow = (
    key: string,
    recording: Recording,
    badge: string | null,
    extra?: TrackRowOptions,
  ): CollectionRowModel => ({
    key,
    recordingId: recording.id,
    badge,
    row: toTrackRowModel(recording, {
      key,
      liked: liked.has(recording.id),
      inPlaylist: inPlaylist.has(recording.id),
      ...extra,
    }),
  });
  const items: TrackRowModel[] = [...input.likes]
    .filter((like) => like.entityKind === 'track')
    .sort((a, b) => b.likedAtMs - a.likedAtMs)
    .flatMap((like) => {
      const recording = byId.get(like.targetId);
      return recording === undefined
        ? []
        : [
            toTrackRowModel(recording, {
              liked: liked.has(recording.id),
              inPlaylist: inPlaylist.has(recording.id),
            }),
          ];
    });

  // Top 50: durable play-count ranking (count desc, recency, id) via
  // the library's own topPlayed — unresolvable ids drop honestly.
  const top50: CollectionRowModel[] = topPlayed(
    input.playCounts,
    input.recordings,
  ).map((entry, index) =>
    collectionRow(
      `top50-${entry.recording.id}-${index}`,
      entry.recording,
      t('collection.plays', { count: entry.count }),
    ),
  );

  // History: one row per recording at its most recent counted play,
  // newest first; play events themselves stay intact.
  const seen = new Set<string>();
  const history: CollectionRowModel[] = [...input.playHistory]
    .sort((a, b) => b.playedMs - a.playedMs)
    .flatMap((event) => {
      if (seen.has(event.recordingId)) return [];
      const recording = byId.get(event.recordingId);
      if (recording === undefined) return [];
      seen.add(event.recordingId);
      return [collectionRow(`hist-${recording.id}`, recording, null)];
    });

  const likedRows: CollectionRowModel[] = items.map((row) => {
    const key = `liked-${row.key}`;
    return { key, recordingId: row.key, badge: null, row: { ...row, key } };
  });

  // Ownable grid: user playlists plus liked album/artist entities.
  const entityLikes = likedEntityIds(input.likes);
  const entriesByPlaylist = playlistEntriesByPlaylist(
    input.playlistEntries,
  );
  const refByEntity = entityRefMap(input.entitySourceRefs);
  const cards: LibraryCardModel[] = [];
  for (const playlist of input.playlists) {
    const entries =
      entriesByPlaylist.get(playlist.playlistId) ?? EMPTY_ENTRIES;
    cards.push({
      key: `playlist-${playlist.playlistId}`,
      kind: 'playlist',
      title: playlist.name,
      subtitle: t('playlist.meta', { count: entries.length }),
      count: entries.length,
      artworkUrl: headArtwork(byId, entries),
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
      entityRef: refByEntity.get(entity.entityId) ?? null,
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
      entityRef: refByEntity.get(entity.entityId) ?? null,
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

  // One ledger rule across surfaces: every kept record counts — the
  // collections tile, the page rows, and the settings badge agree.
  // 'removing' rows are already leaving and count nowhere.
  const downloadRows: CollectionRowModel[] = (input.downloads ?? [])
    .filter((d) => d.state !== 'removing')
    .sort((a, b) =>
      // Stored rows first, then in-flight, then failed; stable by
      // recordingId inside a state.
      chipRank(a.state) - chipRank(b.state) ||
      a.recordingId.localeCompare(b.recordingId),
    )
    .flatMap((d) => {
      const recording = byId.get(d.recordingId);
      return recording === undefined
        ? []
        : [
            collectionRow(`dl-${d.downloadId}`, recording, downloadBadge(d), {
              download: downloadChip(d.state),
            }),
          ];
    });

  return {
    likedCount: items.length,
    items,
    collections: collectionTiles(input),
    collectionRows: {
      liked: likedRows,
      top50,
      history,
      downloads: downloadRows,
    },
    cards,
    artists: [...rail.values()],
    recentlyAdded: items.slice(0, 3),
    canCreatePlaylist: true,
  };
}

export function toCollectionModel(
  model: LibraryModel,
  key: CollectionKey,
): CollectionModel {
  return { key, title: t(`collection.${key}`), rows: model.collectionRows[key] };
}

/** Chip + ledger rank per download state — one exhaustive table. */
const DOWNLOAD_ROW_META: Record<
  DownloadProgress['state'],
  { readonly chip: DownloadChip; readonly rank: number }
> = {
  requested: { chip: 'queued', rank: 1 },
  transferring: { chip: 'downloading', rank: 1 },
  available: { chip: 'stored', rank: 0 },
  failed_with_retry: { chip: 'failed', rank: 2 },
  removing: { chip: 'removing', rank: 2 },
};

export function downloadChip(state: DownloadProgress['state']): DownloadChip {
  return DOWNLOAD_ROW_META[state].chip;
}

/** Records shown in the downloads ledger — kept rows, not mid-delete ones. */
export function downloadLedgerCount(
  downloads: readonly Pick<DownloadProgress, 'state'>[],
): number {
  return downloads.filter((d) => d.state !== 'removing').length;
}

/**
 * One chip map for every row surface — built off `list()`, which
 * still carries 'removing' rows, so a mid-delete row reads busy on
 * both platforms instead of failed-or-hidden.
 */
export function downloadChipsByRecording(
  downloads: readonly DownloadProgress[],
): ReadonlyMap<string, DownloadChip> {
  return new Map(downloads.map((d) => [d.recordingId, downloadChip(d.state)]));
}

function chipRank(state: DownloadProgress['state']): number {
  return DOWNLOAD_ROW_META[state].rank;
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

const headArtwork = (
  byId: ReadonlyMap<string, Recording>,
  entries: readonly { readonly recordingId: string }[],
): string | null => {
  const recording =
    entries[0] === undefined ? undefined : byId.get(entries[0].recordingId);
  return recording === undefined ? null : pickArtworkUrl(recording.artwork);
};

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
  const inPlaylist = playlistRecordingIds(input.playlistEntries);
  const entries = input.playlistEntries
    .filter((entry) => entry.playlistId === playlist.playlistId)
    .sort((a, b) => a.position - b.position);
  const perRecording = countByRecordingId(entries);
  // Entry rows key on entryId — a duplicate keeps its own row.
  const rows: PlaylistEntryModel[] = entries.map((entry) => {
    const recording = byId.get(entry.recordingId);
    const row: TrackRowModel =
      recording === undefined
        ? missingRecordingRow(entry.entryId, false)
        : toTrackRowModel(recording, {
          key: entry.entryId,
          liked: liked.has(recording.id),
          inPlaylist: inPlaylist.has(recording.id),
        });
    return {
      entryId: entry.entryId,
      recordingId: entry.recordingId,
      selectedRef: entry.selectedRef,
      duplicate: (perRecording.get(entry.recordingId) ?? 0) > 1,
      row,
    };
  });
  return {
    playlistId: playlist.playlistId,
    name: playlist.name,
    count: rows.length,
    artworkUrl: headArtwork(byId, entries),
    entries: rows,
  };
}

export function toEntityModel(input: {
  readonly page: EntityPage | null;
  readonly error: AppError | null;
  readonly likes: readonly Like[];
  readonly playlistEntries?: readonly PlaylistEntry[];
  /** Library recordings — joins playlist entries to catalog refs. */
  readonly recordings?: readonly Recording[];
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
      message: errorText(error),
    };
  }
  const entityId = entityIdForRef(
    input.entitySourceRefs,
    page.entity.sourceRef,
  );
  const inPlaylist = playlistSourceRefs(
    input.playlistEntries ?? [],
    input.recordings ?? [],
  );
  const playingKey = refKey(input.playingRef);
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
    items: dedupeTrackListings(page.items).map(({ meta, index, group }) => ({
      ...toSearchRowModel(
        meta,
        index,
        null,
        group.some((m) => inPlaylist.has(refKey(m.sourceRef) ?? '')),
      ),
      playing:
        playingKey !== null &&
        group.some((m) => refKey(m.sourceRef) === playingKey),
    })),
    hasMore: page.continuation !== null,
    loadingMore: input.loadingMore ?? false,
    // A refresh error while content stays surfaces as a flagged note.
    message: errorText(error),
  };
}

/**
 * Drops provider listings a user cannot tell apart — same analyzed
 * song title, artist, and whole-second duration under different ids
 * — keeping the first (provider-relevance order) of each group. The
 * surviving rows carry their ORIGINAL page index: row keys embed it,
 * and callers' key→metadata lookup maps still resolve the press.
 */
export function dedupeTrackListings(
  items: readonly TrackMetadata[],
): readonly {
  meta: TrackMetadata;
  index: number;
  /** Every listing sharing the kept row's display identity — callers
      propagate indicators (playing, playlist membership) across it so a
      hidden duplicate's ref still lights the visible row. */
  group: readonly TrackMetadata[];
}[] {
  const groupsByKey = new Map<
    string,
    { meta: TrackMetadata; index: number; group: TrackMetadata[] }[]
  >();
  const kept: {
    meta: TrackMetadata;
    index: number;
    group: readonly TrackMetadata[];
  }[] = [];
  items.forEach((meta, index) => {
    const key = displayIdentityKey({
      provider: meta.sourceRef.provider,
      title: meta.title,
      artist: meta.artist,
      durationMs: meta.durationMs,
    });
    const groups = groupsByKey.get(key);
    // Same display key alone doesn't make one song — the identity
    // verdict does, against EVERY member: an uncoded listing can
    // absorb coded ones whose ISRCs conflict, so checking only the
    // representative would merge distinct recordings into one row.
    const host = groups?.find((g) =>
      g.group.every((m) => sameSongIdentity(m, meta)),
    );
    if (host !== undefined) {
      host.group.push(meta);
    } else {
      const entry = { meta, index, group: [meta] };
      if (groups === undefined) {
        groupsByKey.set(key, [entry]);
      } else {
        groups.push(entry);
      }
      kept.push(entry);
    }
  });
  return kept;
}

export function toRailCard(recording: Recording): RailCardModel {
  return {
    key: recording.id,
    title: recording.title,
    subtitle: recording.artist,
    artworkUrl: pickArtworkUrl(recording.artwork),
  };
}

/**
 * The four collection tiles — one counting rule shared by home and
 * library so a number never disagrees between surfaces. Counts mirror
 * the collection row lists: materialized likes, kept downloads,
 * resolvable top-played entries, and distinct played recordings.
 */
export function collectionTiles(input: {
  readonly recordings: readonly Recording[];
  readonly likes: readonly Like[];
  readonly playHistory: readonly PlayEvent[];
  readonly playCounts: readonly PlayCount[];
  readonly downloads?: readonly DownloadProgress[] | undefined;
}): readonly CollectionTileModel[] {
  const byId = indexById(input.recordings);
  const liked = input.likes.reduce(
    (count, like) =>
      like.entityKind === 'track' && byId.has(like.targetId)
        ? count + 1
        : count,
    0,
  );
  const downloads = (input.downloads ?? []).reduce(
    (count, entry) =>
      entry.state !== 'removing' && byId.has(entry.recordingId)
        ? count + 1
        : count,
    0,
  );
  const played = new Set<string>();
  for (const event of input.playHistory) {
    if (byId.has(event.recordingId)) {
      played.add(event.recordingId);
    }
  }
  const counts = [
    ['liked', liked],
    ['downloads', downloads],
    ['top50', topPlayed(input.playCounts, input.recordings).length],
    ['history', played.size],
  ] as const;
  return counts.map(([key, count]) => ({
    key,
    label: t(`collection.${key}`),
    count,
    enabled: true,
    note: null,
  }));
}

export function toHomeModel(input: {
  readonly recordings: readonly Recording[];
  readonly likes: readonly Like[];
  readonly playHistory: readonly PlayEvent[];
  readonly suggestions: readonly TrackMetadata[];
  readonly playback: SessionPlayback;
  readonly greeting: string;
  readonly subline: string;
  readonly playCounts?: readonly PlayCount[] | undefined;
  readonly downloads?: readonly DownloadProgress[] | undefined;
}): HomeModel {
  const byId = indexById(input.recordings);
  const recents = [...input.likes]
    .sort((a, b) => b.likedAtMs - a.likedAtMs)
    .flatMap((like) => {
      const recording =
        like.entityKind === 'track' ? byId.get(like.targetId) : undefined;
      return recording === undefined ? [] : [recording];
    })
    .slice(0, 12)
    .map(toRailCard);
  // Latest play wins per recording — ties (clamped timestamps after a
  // clock rollback) resolve to the later array element, which is the
  // more recent event on both orderings this list can carry (live
  // appends; restored `played_ms, event_id` order).
  const latestById = new Map<
    string,
    { recording: Recording; playedMs: number; at: number }
  >();
  input.playHistory.forEach((event, at) => {
    const recording = byId.get(event.recordingId);
    const cur = latestById.get(event.recordingId);
    if (recording !== undefined && (cur === undefined || event.playedMs >= cur.playedMs)) {
      latestById.set(event.recordingId, { recording, playedMs: event.playedMs, at });
    }
  });
  const played = [...latestById.values()]
    .sort((a, b) => b.playedMs - a.playedMs || b.at - a.at)
    .slice(0, 12)
    .map((entry) => toRailCard(entry.recording));
  const suggestions = dedupeTrackListings(input.suggestions)
    .slice(0, 12)
    .map(({ meta: metadata }) => ({
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
    collections: collectionTiles({
      recordings: input.recordings,
      likes: input.likes,
      playHistory: input.playHistory,
      playCounts: input.playCounts ?? [],
      downloads: input.downloads,
    }),
    recents,
    played,
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
  return (['system', 'en', 'de', 'es', 'fr', 'zh'] as const).map((key) => ({
    key,
    label: t(`settings.languageValue.${key}`),
  }));
}

/**
 * Reduce a stored `Settings.language` to a `languageOptions()` key —
 * a persisted value may be a full BCP-47 tag ('de-DE'). Reuses the same
 * tag mapping as `resolveLocale` so the displayed key always matches
 * what activation selects: absent and unsupported values (including
 * Traditional Chinese, which has no shipped catalog) read as 'system'.
 */
export function languageOptionKey(
  setting: string | null | undefined,
): Locale | 'system' {
  return fromTag(setting) ?? 'system';
}

/** Display name for a `Settings.language` value; unknown reads system. */
function languageLabel(setting: string | null | undefined): string {
  return t(`settings.languageValue.${languageOptionKey(setting)}`);
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
    /**
     * The OAuth session-trust seam — `undefined` on harnesses with no
     * auth surface: the account rows omit themselves entirely, keeping
     * signed-out settings identical to before the slice.
     */
    readonly auth?:
      | {
          readonly state: AuthStatus['state'];
          readonly clientId: string | null;
        }
      | undefined;
    /**
     * The update-check seam — `undefined` where the platform wires no
     * update port: the version + check rows omit themselves entirely.
     */
    readonly update?:
      | {
          readonly status: UpdateStatus;
          readonly apply: UpdateApplyStatus;
          readonly currentVersion: string;
        }
      | undefined;
  } = {},
): SettingsModel {
  const nav = (
    key: string,
    label: string,
    value: string | null,
    enabled = true,
    destructive = false,
  ): SettingsRowModel => ({
    key,
    label,
    value,
    kind: 'navigation',
    enabled,
    ...(destructive ? { destructive: true } : {}),
  });
  const val = (
    key: string,
    label: string,
    value: string | null,
  ): SettingsRowModel => ({ key, label, value, kind: 'value', enabled: true });
  const tog = (key: string, label: string, on: boolean): SettingsRowModel => ({
    key,
    label,
    value: t(on ? 'settings.value.on' : 'settings.value.off'),
    kind: 'toggle',
    enabled: on,
  });
  return {
    theme: settings.theme,
    rows: [
      nav('theme', t('settings.theme'), t(`settings.themeValue.${settings.theme}`)),
      // Display preference, same shape as theme: a navigation row
      // whose value is the current choice; the host opens the
      // picker (LanguagePickerSheet) on select.
      nav('language', t('settings.language'), languageLabel(settings.language)),
      nav('catalogProvider', t('settings.catalogProvider'), settings.catalogProvider),
      nav('playbackProvider', t('settings.playbackProvider'), settings.playbackProvider),
      nav('lyricsProvider', t('settings.lyricsProvider'), settings.lyricsProvider ?? t('settings.value.auto')),
      nav('radioProvider', t('settings.radioProvider'), settings.radioProvider ?? t('settings.value.auto')),
      nav('storefront', t('settings.storefront'), settings.storefront ?? t('settings.value.notSet')),
      // OAuth session trust — the sign-in sheet opens off 'googleAuth';
      // 'authSignOut' shows only while linked, and 'authClientId' is the
      // advanced override row (its own ValueFieldSheet).
      ...(media.auth === undefined
        ? []
        : [
            nav(
              'googleAuth',
              t('settings.googleAuth'),
              media.auth.state === 'signed-in'
                ? t('settings.googleAuthValue.linked')
                : media.auth.state === 'starting' ||
                    media.auth.state === 'authorizing'
                  ? t('settings.googleAuthValue.working')
                  : media.auth.state === 'failed'
                    ? t('settings.googleAuthValue.failed')
                    : null,
            ),
            ...(media.auth.state === 'signed-in'
              ? [
                  nav(
                    'authSignOut',
                    t('settings.googleAuthSignOut'),
                    null,
                    true,
                    true,
                  ),
                ]
              : []),
            nav(
              'authClientId',
              t('settings.authClientId'),
              media.auth.clientId ?? t('settings.value.auto'),
            ),
          ]),
      nav('qualityKbps', t('settings.quality'), t('settings.qualityUnit', { value: settings.qualityKbps })),
      tog('prefetch', t('settings.prefetch'), settings.prefetch),
      tog('downloadMetered', t('settings.downloadMetered'), settings.downloadMetered === true),
      val('downloadStorage', t('settings.downloadStorage'), media.storageText ?? '—'),
      // Bounded LRU on disk (data.md ~200 MB) — the value is the
      // configured cap; picking a new one commits it and sweeps.
      nav(
        'artworkCacheBytes',
        t('settings.artworkCache'),
        t('settings.cacheUnit', {
          value: Math.round(
            (settings.artworkCacheBytes ?? ARTWORK_CACHE_BUDGET_DEFAULT_BYTES) /
              (1024 * 1024),
          ),
        }),
      ),
      nav(
        'removeAllDownloads',
        t('settings.removeAllDownloads'),
        media.downloadCount === undefined ? null : `${media.downloadCount}`,
        (media.downloadCount ?? 0) > 0,
        true,
      ),
      val(
        'localSources',
        t('settings.localFolders'),
        media.localSupported === false
          ? t('settings.value.unsupported')
          : media.localFolderCount === undefined
            ? '—'
            : `${media.localFolderCount}`,
      ),
      // One removal row per granted source — the plan's local-files
      // "remove" affordance without a picker surface.
      ...(media.localSources ?? []).map((source) =>
        nav(
          `localSourceRemove:${source.sourceId}`,
          t('settings.removeSource', { label: source.label }),
          null,
          media.localSupported !== false,
          true,
        ),
      ),
      nav('addLocalFolder', t('settings.addLocalFolder'), null, media.localSupported !== false),
      nav('rescanLocal', t('settings.rescanLocal'), null, media.localSupported !== false),
      nav(
        'sync',
        t('settings.sync'),
        media.syncSupported === false
          ? t('sync.status.unavailable')
          : (media.syncLabel ?? t('sync.status.notPaired')),
        media.syncSupported !== false,
      ),
      nav('exportLibrary', t('settings.exportLibrary'), null),
      nav('importLibrary', t('settings.importLibrary'), null),
      // The update seam — a value row surfaces the running version;
      // the nav row is the manual check (or the 'get it' action once
      // a newer release is found). Absent seam → no rows, like auth.
      ...(media.update === undefined
        ? []
        : [
            val(
              'appVersion',
              t('settings.appVersion'),
              media.update.currentVersion,
            ),
            nav(
              'checkUpdate',
              t('settings.checkUpdate'),
              updateRowValue(media.update.status, media.update.apply),
              media.update.status.state !== 'checking' &&
                media.update.apply.state !== 'downloading' &&
                media.update.apply.state !== 'verifying' &&
                media.update.apply.state !== 'applying',
            ),
          ]),
    ],
    diagnostics,
  };
}

/** The check row's value — check status reduced to one line, with the
    apply pipeline taking precedence while it runs. */
function updateRowValue(
  status: UpdateStatus,
  apply: UpdateApplyStatus,
): string | null {
  switch (apply.state) {
    case 'downloading':
      return downloadProgressText(apply, 'update.value.downloading', 'update.value.downloadingUnknown');
    case 'verifying':
      return t('update.value.verifying');
    case 'applying':
      return t('update.value.applying');
    case 'ready-to-restart':
      return t('update.value.restart');
    case 'applied':
      return t('update.value.applied');
    case 'needs-permission':
      return t('update.value.needsPermission');
    case 'failed':
      return t('update.value.applyFailed');
    case 'idle':
      break;
  }
  switch (status.state) {
    case 'idle':
      return t('update.value.idle');
    case 'checking':
      return t('update.value.checking');
    case 'current':
      return t('update.value.current');
    case 'available':
      return t('update.value.available', { version: status.version });
    case 'failed':
      return t('update.value.failed');
  }
}

/** '42%' when the server told us a length, '12 mb' when it didn't. */
function downloadProgressText(
  apply: UpdateApplyStatus & { readonly state: 'downloading' },
  knownKey: MessageId,
  unknownKey: MessageId,
): string {
  const percent =
    apply.totalBytes !== null && apply.totalBytes > 0
      ? Math.min(100, Math.round((100 * apply.receivedBytes) / apply.totalBytes))
      : null;
  return percent !== null
    ? t(knownKey, { percent: `${percent}` })
    : t(unknownKey, {
        mb: `${Math.floor(apply.receivedBytes / (1024 * 1024))}`,
      });
}

/**
 * The dismissible update banner — present while a newer release is
 * known and the user hasn't dismissed THIS version this session
 * (dismissal is per-version: a newer release re-surfaces it). The
 * apply pipeline reshapes it: 'cancelable' means the action button
 * aborts the in-flight work, and 'applied' hands the story to the OS
 * surface so the banner retires itself.
 */
export type UpdateBannerModel = {
  readonly version: string;
  readonly label: string;
  /** null hides the action entirely — a phase with no honest
      affordance (mid-apply) shows the label alone. */
  readonly actionLabel: string | null;
  /** The action aborts the pipeline (cancel) rather than starting it. */
  readonly cancelable: boolean;
};

export function toUpdateBanner(
  snapshot: UpdateSnapshot | null,
  action: 'open' | 'download' | 'install',
  dismissedVersion: string | null,
): UpdateBannerModel | null {
  if (snapshot === null || snapshot.status.state !== 'available') {
    return null;
  }
  const version = snapshot.status.version;
  const apply = snapshot.apply;
  // A dismissed live run finishes silently — the user already said
  // "not now"; the result still applies where the OS surface owns
  // the rest ('applied', 'ready-to-restart').
  if (apply.state !== 'idle' && version === dismissedVersion) {
    return null;
  }
  switch (apply.state) {
    case 'downloading':
      return {
        version,
        label: downloadProgressText(
          apply,
          'update.banner.downloading',
          'update.banner.downloadingUnknown',
        ),
        actionLabel: t('update.action.cancel'),
        cancelable: true,
      };
    case 'verifying':
      return {
        version,
        label: t('update.banner.verifying'),
        actionLabel: t('update.action.cancel'),
        cancelable: true,
      };
    case 'applying':
      // The installer already holds the file — nothing honest to
      // abort into, so no action affordance at all.
      return {
        version,
        label: t('update.banner.applying'),
        actionLabel: null,
        cancelable: false,
      };
    case 'ready-to-restart':
      if (version === dismissedVersion) {
        return null;
      }
      return {
        version,
        label: t('update.banner.restart', { version }),
        actionLabel: t('update.action.restart'),
        cancelable: false,
      };
    case 'applied':
      // The installer / file manager owns the story now.
      return null;
    case 'needs-permission':
      // The OS gated the install — the verified stage is kept, so a
      // retry refires the handoff rather than a re-download.
      return {
        version,
        label: t('update.banner.needsPermission'),
        actionLabel: t('update.action.retry'),
        cancelable: false,
      };
    case 'failed':
      if (version === dismissedVersion) {
        return null;
      }
      return {
        version,
        label: t('update.banner.failed'),
        actionLabel: t('update.action.retry'),
        cancelable: false,
      };
    case 'idle':
      break;
  }
  if (version === dismissedVersion) {
    return null;
  }
  return {
    version,
    label: t('update.banner', { version }),
    actionLabel: t(
      action === 'install'
        ? 'update.action.install'
        : action === 'download'
          ? 'update.action.download'
          : 'update.action.open',
    ),
    cancelable: false,
  };
}

/**
 * The mobile update card — the floating progress surface that
 * replaces the top snack. One model carries the prompt, every
 * pipeline phase, and the failure state so the card never fabricates
 * a phase: `progress` is the real byte fraction (null = unknown
 * total or a phase with no honest fill), `chip` feeds the
 * DownloadIcon morph, and `dismissible` stays false while a run is
 * live — hiding the card mid-apply would bury the only cancel
 * affordance and let a ~55 MB download continue invisibly.
 */
export type UpdateCardModel = {
  readonly version: string;
  readonly title: string;
  /** Secondary line — the version while prompting, byte progress
      while downloading, the humanized failure kind after 'failed'. */
  readonly detail: string;
  /** 0..1 for the determinate bar; null when the honest answer is
      "no fill" (unknown total, non-download phases). */
  readonly progress: number | null;
  /** DownloadIcon phase: idle arrow to prompt, busy arc while the
      pipeline runs, warn mark on failure. */
  readonly chip: DownloadChip;
  readonly actionLabel: string | null;
  /** The action aborts the pipeline (cancel) rather than starting it. */
  readonly cancelable: boolean;
  /** Only a settled surface may hide: prompt, failure, restart. */
  readonly dismissible: boolean;
};

export function toUpdateCard(
  snapshot: UpdateSnapshot | null,
  action: 'open' | 'download' | 'install',
  dismissedVersion: string | null,
): UpdateCardModel | null {
  if (snapshot === null || snapshot.status.state !== 'available') {
    return null;
  }
  const version = snapshot.status.version;
  const apply = snapshot.apply;
  const dismissed = version === dismissedVersion;
  switch (apply.state) {
    case 'downloading':
      return {
        version,
        title: t('update.card.downloading'),
        detail: downloadProgressText(
          apply,
          'update.card.downloadingDetail',
          'update.card.downloadingDetailUnknown',
        ),
        progress:
          apply.totalBytes !== null && apply.totalBytes > 0
            ? Math.min(1, apply.receivedBytes / apply.totalBytes)
            : null,
        chip: 'downloading',
        actionLabel: t('update.action.cancel'),
        cancelable: true,
        dismissible: false,
      };
    case 'verifying':
      return {
        version,
        title: t('update.banner.verifying'),
        detail: '',
        progress: null,
        chip: 'downloading',
        actionLabel: t('update.action.cancel'),
        cancelable: true,
        dismissible: false,
      };
    case 'applying':
      // The OS surface is already firing — nothing honest to abort.
      return {
        version,
        title: t('update.banner.applying'),
        detail: '',
        progress: null,
        chip: 'downloading',
        actionLabel: null,
        cancelable: false,
        dismissible: false,
      };
    case 'ready-to-restart':
      return dismissed
        ? null
        : {
            version,
            title: t('update.banner.restart', { version }),
            detail: '',
            progress: null,
            chip: 'stored',
            actionLabel: t('update.action.restart'),
            cancelable: false,
            dismissible: true,
          };
    case 'applied':
      // A newer checked release owns the card — labeling it 'open
      // installer' would send its tap at the new version's download,
      // so it renders the ordinary offer below.
      if (apply.version !== version) {
        break;
      }
      // 'install' builds are done — the OS surface owns the story;
      // when its outcome never lands (cancelled sheet, failed
      // install) the settings row re-offers it (reapply refires the
      // handoff, no re-download). 'download' builds are NOT done:
      // the verified dmg sits mounted in Finder and the replace is
      // still the user's drag, so the card stays up to name that
      // step instead of silently retiring mid-journey.
      if (action !== 'download') {
        return null;
      }
      return dismissed
        ? null
        : {
            version,
            title: t('update.card.appliedTitle'),
            detail: t('update.card.appliedDetail'),
            progress: null,
            chip: 'stored',
            actionLabel: t('update.action.reopen'),
            cancelable: false,
            dismissible: true,
          };
    case 'needs-permission':
      // The OS gated the install — the verified stage is kept, so a
      // retry refires the handoff rather than a re-download.
      return dismissed
        ? null
        : {
            version,
            title: t('update.card.needsPermission'),
            detail: t('update.card.needsPermissionDetail'),
            progress: null,
            chip: 'failed',
            actionLabel: t('update.action.retry'),
            cancelable: false,
            dismissible: true,
          };
    case 'failed':
      return dismissed
        ? null
        : {
            version,
            title: t('update.card.failed'),
            detail: errorText(apply.error) ?? '',
            progress: null,
            chip: 'failed',
            actionLabel: t('update.action.retry'),
            cancelable: false,
            dismissible: true,
          };
    case 'idle':
      break;
  }
  if (dismissed) {
    return null;
  }
  return {
    version,
    title: t('update.card.title'),
    detail: t('update.card.detail', { version }),
    progress: null,
    chip: 'idle',
    actionLabel: t(
      action === 'install'
        ? 'update.action.install'
        : action === 'download'
          ? 'update.action.download'
          : 'update.action.open',
    ),
    cancelable: false,
    dismissible: true,
  };
}

/**
 * The flat settings row list chunked into labeled cards for
 * presentation. Boundaries are keyed, not positional: a row whose key
 * starts a group opens a new card, every other row continues the
 * current one — model order is preserved verbatim and a row added mid-
 * list lands inside whatever group surrounds it.
 */
type SettingsGroup = {
  /** The boundary row's key — stable React key for the group. */
  readonly key: string;
  readonly label: string;
  readonly rows: readonly SettingsRowModel[];
};

/**
 * The device-flow sheet's view — the auth status union flattened to
 * display fields so the UI packages never import the application's
 * `AuthStatus` (and `AppError` collapses to its errorText line).
 */
export type AuthSheetModel = {
  readonly state: AuthStatus['state'];
  /** The user-facing device pair — only present while 'authorizing'. */
  readonly userCode: string | null;
  readonly verificationUrl: string | null;
  /** Localized failure line on 'failed'; null elsewhere. */
  readonly errorMessage: string | null;
};

export function toAuthSheetModel(status: AuthStatus): AuthSheetModel {
  switch (status.state) {
    case 'authorizing':
      return {
        state: 'authorizing',
        userCode: status.userCode,
        verificationUrl: status.verificationUrl,
        errorMessage: null,
      };
    case 'failed':
      return {
        state: 'failed',
        userCode: null,
        verificationUrl: null,
        errorMessage: errorText(status.error),
      };
    default:
      return {
        state: status.state,
        userCode: null,
        verificationUrl: null,
        errorMessage: null,
      };
  }
}

const SETTINGS_GROUP_STARTS: readonly (readonly [string, MessageId])[] = [
  ['theme', 'settings.section.appearance'],
  ['catalogProvider', 'settings.section.providers'],
  ['googleAuth', 'settings.section.account'],
  ['qualityKbps', 'settings.section.playback'],
  ['downloadMetered', 'settings.section.downloads'],
  ['localSources', 'settings.section.localFiles'],
  ['sync', 'settings.section.library'],
  ['appVersion', 'settings.section.app'],
];

export function settingsGroups(
  rows: readonly SettingsRowModel[],
): readonly SettingsGroup[] {
  const starts = new Map<string, MessageId>(SETTINGS_GROUP_STARTS);
  const groups: { key: string; label: string; rows: SettingsRowModel[] }[] = [];
  for (const row of rows) {
    const labelId = starts.get(row.key);
    if (labelId !== undefined || groups.length === 0) {
      groups.push({
        key: row.key,
        label: t(labelId ?? 'settings.section.appearance'),
        rows: [],
      });
    }
    groups[groups.length - 1]!.rows.push(row);
  }
  return groups;
}

/**
 * Destructive value/navigation rows arm a two-tap confirm on both
 * platforms — toggles flip state but never destroy, so they stay
 * one-press.
 */
export function settingsRowConfirms(row: SettingsRowModel): boolean {
  return row.destructive === true && row.kind !== 'toggle';
}

/* ------------------------------------------------------------------ */
/* Sync — LAN pairing panel: listener status, device list, the minted  */
/* pairing offer. The shapes mirror the desktop `api.sync.*` contract  */
/* verbatim (kept structural here so ui-web never imports app code).   */
/* ------------------------------------------------------------------ */

type SyncStatusInput = {
  readonly listener:
    | 'starting'
    | 'listening'
    | 'unavailable'
    | 'dormant'
    | 'disabled';
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

type SyncDeviceInput = {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
};

/** The minted offer `api.sync.pairing()` returns — code + QR payload. */
type SyncPairingInput = {
  readonly payload: string;
  readonly code: string;
  /** Primary `ip:port` — the typed path needs it shown next to the code. */
  readonly endpoint: string;
  readonly expiresAt: number;
};

type SyncDeviceModel = {
  readonly id: string;
  readonly name: string;
  /** Relative label — 'paired 2h ago'. */
  readonly pairedLabel: string;
  /** Relative label — 'seen 5m ago'. */
  readonly lastSeenLabel: string;
};

type SyncStatusModel = {
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
  const delta = nowMs - ms;
  if (!Number.isFinite(delta) || delta < 0) {
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
  return days < 7 ? t('ago.days', { count: days }) : (formatExportDate(ms) ?? '—');
}

export function formatExpiry(expiresAt: number, nowMs: number): string {
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
