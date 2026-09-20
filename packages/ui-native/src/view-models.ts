import type { ThemeName } from '@auqw/design-tokens';
import type {
  ArtworkRef,
  QueueSnapshot,
  Recording,
  SessionPlayback,
  Settings,
  TrackLike,
  TrackMetadata,
} from '@auqw/application';

export type PlatformVariant = 'android' | 'ios';

export type TrackRowState = 'available' | 'unavailable' | 'error';

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

export type HomeModel = {
  readonly greeting: string;
  readonly subline: string | null;
  readonly recents: readonly RailCardModel[];
  readonly suggestions: readonly RailCardModel[];
};

export type LibraryModel = {
  readonly likedCount: number;
  readonly items: readonly TrackRowModel[];
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

export type LyricsModel = {
  readonly lines: readonly string[];
  readonly activeIndex: number | null;
  readonly syncLabel: string | null;
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
  };
}

export type PlayerModelInput = {
  readonly playback: SessionPlayback;
  readonly queue: QueueSnapshot;
  readonly recordings: readonly Recording[];
  readonly likes: readonly TrackLike[];
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

function likedIds(likes: readonly TrackLike[]): ReadonlySet<string> {
  return new Set(likes.map((like) => like.recordingId));
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
  readonly likes?: readonly TrackLike[];
  readonly unavailableRecordingIds?: ReadonlySet<string>;
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

export function toLibraryModel(input: {
  readonly recordings: readonly Recording[];
  readonly likes: readonly TrackLike[];
}): LibraryModel {
  const byId = indexById(input.recordings);
  const liked = likedIds(input.likes);
  const ordered = [...input.likes].sort((a, b) => b.likedAtMs - a.likedAtMs);
  const items: TrackRowModel[] = [];
  for (const like of ordered) {
    const recording = byId.get(like.recordingId);
    if (recording === undefined) {
      continue;
    }
    items.push(toTrackRowModel(recording, { liked: liked.has(recording.id) }));
  }
  return { likedCount: items.length, items };
}

export function toRailCard(recording: Recording): RailCardModel {
  return {
    key: recording.id,
    title: recording.title,
    subtitle: recording.artist,
    artworkUrl: pickArtworkUrl(recording.artwork),
  };
}

export function toSettingsModel(
  settings: Settings,
  diagnostics: DiagnosticsModel,
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
    ],
    diagnostics,
  };
}
