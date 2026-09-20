import { extractVersionLabels } from './matching/matching-engine.ts';
import type { QueueSnapshot } from './queue/queue-engine.ts';

export type SourceRef = { provider: string; kind: 'track'; id: string };

export type ArtworkRef = {
  url: string;
  width: number | null;
  height: number | null;
};

export type TrackMetadata = {
  sourceRef: SourceRef;
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  releaseYear: number | null;
  artwork: readonly ArtworkRef[];
  explicit: boolean | null;
  genre: string | null;
  storefront: string | null;
};

export type VersionLabel =
  | 'live'
  | 'remix'
  | 'remaster'
  | 'clean'
  | 'explicit'
  | 'alternate';

export type MappingStatus = 'automatic' | 'user-confirmed' | 'rejected';

export type SourceMapping = {
  ref: SourceRef;
  status: MappingStatus;
  matchedAtMs: number;
  evidence: MatchEvidence;
};

export type MatchEvidence = {
  titleSimilarity: number;
  artistSimilarity: number | null;
  durationDeltaMs: number | null;
  exactIsrc: boolean;
  score: number;
  versionLabels: readonly VersionLabel[];
};

export type Recording = {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  releaseYear: number | null;
  artwork: readonly ArtworkRef[];
  explicit: boolean | null;
  genre: string | null;
  isrc: string | null;
  versionLabels: readonly VersionLabel[];
  sourceRefs: readonly SourceRef[];
  mappings: readonly SourceMapping[];
};

export type TrackLike = { recordingId: string; likedAtMs: number };

export type QueueOccurrence = {
  occurrenceId: string;
  recordingId: string;
  selectedRef: SourceRef | null;
};

export type Settings = {
  catalogProvider: string;
  playbackProvider: string;
  storefront: string | null;
  qualityKbps: number;
  theme: 'dark' | 'light' | 'oled' | 'system';
  prefetch: boolean;
};

const VERSION_LABELS: ReadonlySet<string> = new Set([
  'live',
  'remix',
  'remaster',
  'clean',
  'explicit',
  'alternate',
]);

const MAPPING_STATUSES: ReadonlySet<string> = new Set([
  'automatic',
  'user-confirmed',
  'rejected',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

function isString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isOptString(value: unknown, max: number): value is string | null {
  return value === null || isString(value, max);
}

function isSafeNonNegative(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isOptSafeNonNegative(
  value: unknown,
): value is number | null {
  return value === null || isSafeNonNegative(value);
}

function isSimilarity(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function isVersionLabelArray(value: unknown): value is readonly VersionLabel[] {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    new Set(value).size === value.length &&
    value.every((l) => typeof l === 'string' && VERSION_LABELS.has(l))
  );
}

function isStorefront(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && /^[A-Z]{2}$/.test(value))
  );
}

function isArtworkRef(value: unknown): value is ArtworkRef {
  if (!isRecord(value) || !hasExactKeys(value, ['url', 'width', 'height'])) {
    return false;
  }
  if (
    !isString(value['url'], 2048) ||
    !(value['url'] as string).startsWith('https://')
  ) {
    return false;
  }
  for (const key of ['width', 'height'] as const) {
    const dim = value[key];
    if (
      dim !== null &&
      !(typeof dim === 'number' && Number.isSafeInteger(dim) && dim >= 1)
    ) {
      return false;
    }
  }
  return true;
}

export function isSourceRef(value: unknown): value is SourceRef {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['provider', 'kind', 'id']) &&
    isString(value['provider'], 64) &&
    value['kind'] === 'track' &&
    isString(value['id'], 512)
  );
}

function isMatchEvidence(value: unknown): value is MatchEvidence {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'titleSimilarity',
      'artistSimilarity',
      'durationDeltaMs',
      'exactIsrc',
      'score',
      'versionLabels',
    ]) &&
    isSimilarity(value['titleSimilarity']) &&
    (value['artistSimilarity'] === null ||
      isSimilarity(value['artistSimilarity'])) &&
    isOptSafeNonNegative(value['durationDeltaMs']) &&
    typeof value['exactIsrc'] === 'boolean' &&
    typeof value['score'] === 'number' &&
    Number.isFinite(value['score']) &&
    isVersionLabelArray(value['versionLabels'])
  );
}

function isSourceMapping(value: unknown): value is SourceMapping {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['ref', 'status', 'matchedAtMs', 'evidence']) &&
    isSourceRef(value['ref']) &&
    typeof value['status'] === 'string' &&
    MAPPING_STATUSES.has(value['status']) &&
    isSafeNonNegative(value['matchedAtMs']) &&
    isMatchEvidence(value['evidence'])
  );
}

export function isTrackMetadata(value: unknown): value is TrackMetadata {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'sourceRef',
      'title',
      'artist',
      'album',
      'durationMs',
      'releaseYear',
      'artwork',
      'explicit',
      'genre',
      'storefront',
    ]) &&
    isSourceRef(value['sourceRef']) &&
    isString(value['title'], 512) &&
    isOptString(value['artist'], 512) &&
    isOptString(value['album'], 512) &&
    isOptSafeNonNegative(value['durationMs']) &&
    (value['releaseYear'] === null ||
      (typeof value['releaseYear'] === 'number' &&
        Number.isSafeInteger(value['releaseYear']) &&
        value['releaseYear'] >= 0)) &&
    Array.isArray(value['artwork']) &&
    value['artwork'].length <= 8 &&
    value['artwork'].every(isArtworkRef) &&
    (value['explicit'] === null || typeof value['explicit'] === 'boolean') &&
    isOptString(value['genre'], 512) &&
    isStorefront(value['storefront'])
  );
}

/** (provider, kind, id) keys must be unique within a recording. */
function hasUniqueSourceRefs(refs: readonly SourceRef[]): boolean {
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.provider} ${ref.kind} ${ref.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

export function isRecording(value: unknown): value is Recording {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'id',
      'title',
      'artist',
      'album',
      'durationMs',
      'releaseYear',
      'artwork',
      'explicit',
      'genre',
      'isrc',
      'versionLabels',
      'sourceRefs',
      'mappings',
    ]) &&
    isString(value['id'], 64) &&
    isString(value['title'], 512) &&
    isOptString(value['artist'], 512) &&
    isOptString(value['album'], 512) &&
    isOptSafeNonNegative(value['durationMs']) &&
    (value['releaseYear'] === null ||
      (typeof value['releaseYear'] === 'number' &&
        Number.isSafeInteger(value['releaseYear']) &&
        value['releaseYear'] >= 0)) &&
    Array.isArray(value['artwork']) &&
    value['artwork'].length <= 8 &&
    value['artwork'].every(isArtworkRef) &&
    (value['explicit'] === null || typeof value['explicit'] === 'boolean') &&
    isOptString(value['genre'], 512) &&
    isOptString(value['isrc'], 64) &&
    isVersionLabelArray(value['versionLabels']) &&
    Array.isArray(value['sourceRefs']) &&
    value['sourceRefs'].length >= 1 &&
    value['sourceRefs'].every(isSourceRef) &&
    hasUniqueSourceRefs(value['sourceRefs']) &&
    Array.isArray(value['mappings']) &&
    value['mappings'].every(isSourceMapping)
  );
}

export function isSettings(value: unknown): value is Settings {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'catalogProvider',
      'playbackProvider',
      'storefront',
      'qualityKbps',
      'theme',
      'prefetch',
    ]) &&
    isString(value['catalogProvider'], 64) &&
    isString(value['playbackProvider'], 64) &&
    isStorefront(value['storefront']) &&
    typeof value['qualityKbps'] === 'number' &&
    Number.isSafeInteger(value['qualityKbps']) &&
    value['qualityKbps'] >= 1 &&
    value['qualityKbps'] <= 512 &&
    (value['theme'] === 'dark' ||
      value['theme'] === 'light' ||
      value['theme'] === 'oled' ||
      value['theme'] === 'system') &&
    typeof value['prefetch'] === 'boolean'
  );
}

export function isTrackLike(value: unknown): value is TrackLike {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['recordingId', 'likedAtMs']) &&
    isString(value['recordingId'], 64) &&
    isSafeNonNegative(value['likedAtMs'])
  );
}

function isQueueOccurrence(value: unknown): value is QueueOccurrence {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['occurrenceId', 'recordingId', 'selectedRef']) &&
    isString(value['occurrenceId'], 64) &&
    isString(value['recordingId'], 64) &&
    (value['selectedRef'] === null || isSourceRef(value['selectedRef']))
  );
}

function isAppErrorLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['kind'] === 'string' &&
    typeof value['message'] === 'string' &&
    typeof value['retryable'] === 'boolean' &&
    (value['retryAfterMs'] === undefined ||
      isSafeNonNegative(value['retryAfterMs']))
  );
}

/** Mirrors the QueueEngine legal-state contract. */
export function isQueueSnapshot(value: unknown): value is QueueSnapshot {
  const required = [
    'revision',
    'occurrences',
    'currentOccurrenceId',
    'positionMs',
    'mode',
  ];
  if (
    !isRecord(value) ||
    !(hasExactKeys(value, required) ||
      hasExactKeys(value, [...required, 'blockedError']))
  ) {
    return false;
  }
  const {
    revision,
    occurrences,
    currentOccurrenceId,
    positionMs,
    mode,
    blockedError,
  } = value;
  if (
    !isSafeNonNegative(revision) ||
    !isSafeNonNegative(positionMs) ||
    !Array.isArray(occurrences) ||
    !occurrences.every(isQueueOccurrence) ||
    (mode !== 'stopped' && mode !== 'paused' && mode !== 'playing') ||
    (currentOccurrenceId !== null && typeof currentOccurrenceId !== 'string') ||
    (blockedError !== undefined && !isAppErrorLike(blockedError))
  ) {
    return false;
  }
  const ids = new Set(occurrences.map((o) => o.occurrenceId));
  if (ids.size !== occurrences.length) {
    return false;
  }
  if (currentOccurrenceId === null) {
    return (
      positionMs === 0 && mode === 'stopped' && blockedError === undefined
    );
  }
  if (!ids.has(currentOccurrenceId)) {
    return false;
  }
  if (mode === 'stopped') {
    return false;
  }
  if (blockedError !== undefined && mode !== 'paused') {
    return false;
  }
  return true;
}

export type PersistedShape = {
  readonly recordings: readonly Recording[];
  readonly likes: readonly TrackLike[];
  readonly queue: QueueSnapshot;
  readonly settings: Settings;
};

/** Validates the whole persisted document, including references. */
export function isPersistedState(value: unknown): value is PersistedShape {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['recordings', 'likes', 'queue', 'settings'])
  ) {
    return false;
  }
  const { recordings, likes, queue, settings } = value;
  if (
    !Array.isArray(recordings) ||
    !recordings.every(isRecording) ||
    !Array.isArray(likes) ||
    !likes.every(isTrackLike) ||
    !isQueueSnapshot(queue) ||
    !isSettings(settings)
  ) {
    return false;
  }
  const recordingIds = new Set(recordings.map((r) => r.id));
  if (recordingIds.size !== recordings.length) {
    return false;
  }
  const likedIds = new Set(likes.map((l) => l.recordingId));
  if (likedIds.size !== likes.length) {
    return false;
  }
  for (const like of likes) {
    if (!recordingIds.has(like.recordingId)) {
      return false;
    }
  }
  for (const occurrence of queue.occurrences) {
    if (!recordingIds.has(occurrence.recordingId)) {
      return false;
    }
  }
  return true;
}

export function recordingFromMetadata(
  metadata: TrackMetadata,
  id: string,
): Recording {
  return {
    id,
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
    durationMs: metadata.durationMs,
    releaseYear: metadata.releaseYear,
    artwork: metadata.artwork,
    explicit: metadata.explicit,
    genre: metadata.genre,
    isrc: null,
    versionLabels: extractVersionLabels(metadata.title, metadata.explicit),
    sourceRefs: [metadata.sourceRef],
    mappings: [],
  };
}
