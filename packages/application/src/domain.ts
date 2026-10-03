import { extractVersionLabels } from './matching/matching-engine.ts';
import type { QueueSnapshot } from './queue/queue-engine.ts';

export type EntityKind = 'album' | 'artist' | 'playlist';

type SourceRefKind = 'track' | EntityKind;

export type SourceRef = { provider: string; kind: SourceRefKind; id: string };

/** Provider reference to a non-track entity (album, artist, or playlist page). */
export type EntityRef = { provider: string; kind: EntityKind; id: string };

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
  /**
   * ABI 0.1.0 catalog evidence: entity refs into the provider's own
   * catalog plus the recording's ISRC when the provider reports one
   * (deezer does, feeding MatchEvidence.exactIsrc). Absent on
   * pre-0.3 providers — the key may be missing or null.
   */
  artistRef?: EntityRef | null;
  albumRef?: EntityRef | null;
  isrc?: string | null;
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
  /**
   * The provider's own artist/album refs carried over from the catalog
   * row that minted the recording — the stage meta links resolve
   * through them. Local-only evidence: never emitted in sync field
   * writes (meaningless off this device's catalog history) and omitted
   * from export docs, so the keys are optional and pre-v16 documents
   * still validate. Absent until a local materialization supplies them.
   */
  artistRef?: EntityRef | null;
  albumRef?: EntityRef | null;
  sourceRefs: readonly SourceRef[];
  mappings: readonly SourceMapping[];
  /**
   * Where the recording came from: 'provider' rows are catalog-sourced
   * and resolve through provider plugins; 'local' rows were materialized
   * by a local-file scan and play through the built-in `local` provider
   * convention. Defaults to 'provider' for pre-slice-3 data.
   */
  provenance: RecordingProvenance;
};

type RecordingProvenance = 'provider' | 'local';

/** The built-in local-files provider id — never routed to a plugin. */
export const LOCAL_PROVIDER = 'local';

/** sourceRef shape for a local file: the stable fingerprint-derived id. */
export function localTrackRef(fileId: string): SourceRef {
  return { provider: LOCAL_PROVIDER, kind: 'track', id: fileId };
}

export type LikeEntityKind = 'track' | EntityKind;

/**
 * Polymorphic like target: 'track' ids name a recording; 'album',
 * 'artist', and 'playlist' ids name an entity. The target table is
 * kind-dependent, so referential integrity is enforced by the
 * validators, not the schema.
 */
export type Like = {
  entityKind: LikeEntityKind;
  targetId: string;
  likedAtMs: number;
};

export type QueueOccurrence = {
  occurrenceId: string;
  recordingId: string;
  selectedRef: SourceRef | null;
};

/**
 * Provenance for a queue: which surface minted it. Persisted and
 * synced inside the queue snapshot so every device can answer
 * "playing from …". `name`/`query` freeze display text at play time
 * for the kinds that carry it; `collection`/`library`/`search`
 * resolve to localized chrome instead.
 */
export type QueueOrigin =
  | {
      readonly kind: 'collection';
      readonly collection: 'liked' | 'top50' | 'history' | 'downloads';
    }
  | { readonly kind: 'playlist'; readonly playlistId: string; readonly name: string }
  | { readonly kind: 'entity'; readonly ref: EntityRef; readonly name: string }
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'library' };

/**
 * Bounds for the optional artwork-cache budget setting, per
 * docs/specs/data.md (artwork ~200 MB, bounded, managed in settings).
 */
export const ARTWORK_CACHE_BUDGET_MIN_BYTES = 16 * 1024 * 1024;
export const ARTWORK_CACHE_BUDGET_MAX_BYTES = 1024 * 1024 * 1024;
export const ARTWORK_CACHE_BUDGET_DEFAULT_BYTES = 200 * 1024 * 1024;

export type Settings = {
  catalogProvider: string;
  playbackProvider: string;
  storefront: string | null;
  qualityKbps: number;
  theme: 'dark' | 'light' | 'oled' | 'system' | 'adaptive';
  prefetch: boolean;
  /**
   * Per-capability provider overrides for lyrics and radio; `null`
   * (or absent) leaves routing to declared capabilities — the sole
   * declaring provider serves, and for `radio.seed` the playback
   * provider is preferred. Optional for schema-v2 compatibility:
   * persistence of the overrides lands with the next schema.
   */
  lyricsProvider?: string | null;
  radioProvider?: string | null;
  /**
   * Optional artwork-cache byte budget. Absent resolves to
   * ARTWORK_CACHE_BUDGET_DEFAULT_BYTES; when present it must stay
   * inside [ARTWORK_CACHE_BUDGET_MIN_BYTES, ARTWORK_CACHE_BUDGET_MAX_BYTES].
   */
  artworkCacheBytes?: number;
  /**
   * Cellular/metered-network downloads opt-in. Absent or false means
   * downloads wait for an unmetered connection.
   */
  downloadMetered?: boolean;
  /**
   * UI language. Absent or 'system' follows the platform locale; a
   * BCP-47 tag (e.g. 'de', 'fr') pins the UI to that locale. Optional
   * for schema compatibility: persistence of it lands with the next
   * schema, per docs/decisions.md (language selection).
   */
  language?: string | null;
};

const VERSION_LABELS: ReadonlySet<string> = new Set([
  'live', 'remix', 'remaster', 'clean', 'explicit', 'alternate',
]);
const MAPPING_STATUSES: ReadonlySet<string> = new Set([
  'automatic', 'user-confirmed', 'rejected',
]);
const SOURCE_REF_KINDS: ReadonlySet<string> = new Set([
  'track',
  'album',
  'artist',
  'playlist',
]);
const ENTITY_KINDS: ReadonlySet<string> = new Set([
  'album',
  'artist',
  'playlist',
]);

const QUEUE_ORIGIN_COLLECTIONS: ReadonlySet<string> = new Set([
  'liked',
  'top50',
  'history',
  'downloads',
]);
const RECORDING_PROVENANCES: ReadonlySet<string> = new Set(['provider', 'local']);
const LIKE_ENTITY_KINDS: ReadonlySet<string> = SOURCE_REF_KINDS;
const THEMES: ReadonlySet<string> = new Set([
  'dark', 'light', 'oled', 'system', 'adaptive',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
) {
  const own = Object.keys(value);
  return (
    own.length === keys.length && keys.every((k) => Object.hasOwn(value, k))
  );
}

/**
 * The exact-keys rule extended to declared optionals: every required
 * key is present and no own key falls outside required ∪ optional.
 */
export function hasKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
) {
  const own = Object.keys(value);
  return (
    own.every((k) => required.includes(k) || optional.includes(k)) &&
    required.every((k) => Object.hasOwn(value, k))
  );
}

export function isString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function isOptString(
  value: unknown,
  max: number,
): value is string | null {
  return value === null || isString(value, max);
}

export function isSafeNonNegative(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}

export function isOptSafeNonNegative(
  value: unknown,
): value is number | null {
  return value === null || isSafeNonNegative(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Membership guard for a string-valued enum set. */
function isIn(set: ReadonlySet<string>, value: unknown): boolean {
  return typeof value === 'string' && set.has(value);
}

function isSimilarity(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function isVersionLabelArray(value: unknown): value is readonly VersionLabel[] {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    new Set(value).size === value.length &&
    value.every((l) => isIn(VERSION_LABELS, l))
  );
}

export function isStorefront(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && /^[A-Z]{2}$/.test(value))
  );
}

/**
 * Host of an `https://` URL, or null when it is not a plain name-based
 * destination. Mirrors `https_host` in
 * `crates/plugin-host/src/manifest.rs`: userinfo and bracketed IPv6 are
 * the two shapes that smuggle a host past a naive prefix check.
 */
function httpsHost(url: string): string | null {
  if (!url.startsWith('https://')) return null;
  const authority = url.slice('https://'.length).split(/[/?#]/)[0] ?? '';
  if (authority === '' || authority.includes('@') || authority.includes('[')) {
    return null;
  }
  const host = authority.split(':')[0] ?? '';
  return host === '' ? null : host;
}

const IP_V4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Whether a plugin-supplied URL is a destination the shell may fetch
 * and render on that plugin's behalf. A provider result is untrusted
 * input — these URLs are downloaded and drawn as images, so a loopback
 * or private host would turn a plugin into LAN and cloud-metadata
 * probing.
 *
 * This is a reachability floor, not the destination policy. The policy
 * is `allows_destination` in `crates/plugin-host/src/manifest.rs`, and
 * it is deliberately not applied to artwork yet: every provider serves
 * art from a CDN outside its `network:` list (deezer draws from
 * `cdn-images.dzcdn.net` while declaring `api.deezer.com`), so
 * enforcing it needs artwork hosts added to the provider manifests
 * first. DNS rebinding is out of scope as well — this inspects the
 * name, not where it resolves.
 */
export function isPublicHttpsUrl(url: string): boolean {
  const host = httpsHost(url);
  if (host === null) return false;
  const name = host.toLowerCase();
  // Same public-DNS-name test as the manifest grammar: charset, at
  // least one dot, no empty label, no bare IP, no `.localhost`.
  const labels = name.split('.');
  const tld = labels[labels.length - 1];
  return (
    /^[a-z0-9.-]+$/.test(name) &&
    labels.length >= 2 &&
    labels.every((label) => label !== '') &&
    tld !== undefined &&
    !/^\d+$/.test(tld) &&
    !name.endsWith('.localhost') &&
    !IP_V4_LITERAL.test(name)
  );
}

/**
 * Artwork url: a public https cover (catalog art) or a `file://` ref
 * into the platform's content-addressed local-art store (embedded
 * covers extracted by the tag reader). The `file://` form is
 * device-local — it never round-trips an export meaningfully.
 */
export function isArtworkUrl(url: string): boolean {
  return isPublicHttpsUrl(url) || url.startsWith('file:///');
}

function isArtworkRefWith(
  isUrl: (url: string) => boolean,
  value: unknown,
): value is ArtworkRef {
  const isDim = (dim: unknown): boolean =>
    dim === null ||
    (typeof dim === 'number' && Number.isSafeInteger(dim) && dim >= 1);
  return (
    isRecord(value) &&
    hasExactKeys(value, ['url', 'width', 'height']) &&
    isString(value['url'], 2048) &&
    isUrl(value['url']) &&
    isDim(value['width']) &&
    isDim(value['height'])
  );
}

export function isArtworkRef(value: unknown): value is ArtworkRef {
  return isArtworkRefWith(isArtworkUrl, value);
}

/**
 * Guest- and wire-facing artwork — public https only. A `file://` ref
 * is minted exclusively by the platform tag reader against its own
 * art store; admitting one from a provider payload or a sync write
 * would let remote data point the renderer at local files.
 */
export function isRemoteArtworkRef(value: unknown): value is ArtworkRef {
  return isArtworkRefWith(isPublicHttpsUrl, value);
}

/**
 * Artwork as it may cross an export or sync boundary — device-local
 * `file://` store refs are stripped; a receiving device re-derives
 * them from the backing file's own embedded cover.
 */
export function portableArtwork(
  artwork: readonly ArtworkRef[],
): readonly ArtworkRef[] {
  return artwork.filter(isRemoteArtworkRef);
}

export function isSourceRef(value: unknown): value is SourceRef {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['provider', 'kind', 'id']) &&
    isString(value['provider'], 64) &&
    isIn(SOURCE_REF_KINDS, value['kind']) &&
    isString(value['id'], 512)
  );
}

/** Track refs are the only kind a recording/mapping/queue can carry. */
export function isTrackRef(value: unknown): value is SourceRef {
  return isSourceRef(value) && value.kind === 'track';
}

export function isEntityRef(value: unknown): value is EntityRef {
  return isSourceRef(value) && isIn(ENTITY_KINDS, value.kind);
}

export function isQueueOrigin(value: unknown): value is QueueOrigin {
  if (!isRecord(value)) {
    return false;
  }
  switch (value['kind']) {
    case 'collection':
      return (
        hasExactKeys(value, ['kind', 'collection']) &&
        isIn(QUEUE_ORIGIN_COLLECTIONS, value['collection'])
      );
    case 'playlist':
      return (
        hasExactKeys(value, ['kind', 'playlistId', 'name']) &&
        isString(value['playlistId'], 64) &&
        isString(value['name'], 512)
      );
    case 'entity':
      return (
        hasExactKeys(value, ['kind', 'ref', 'name']) &&
        isEntityRef(value['ref']) &&
        isString(value['name'], 512)
      );
    case 'search':
      return (
        hasExactKeys(value, ['kind', 'query']) &&
        isString(value['query'], 256)
      );
    case 'library':
      return hasExactKeys(value, ['kind']);
    default:
      return false;
  }
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

export function isSourceMapping(value: unknown): value is SourceMapping {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['ref', 'status', 'matchedAtMs', 'evidence']) &&
    isTrackRef(value['ref']) &&
    isIn(MAPPING_STATUSES, value['status']) &&
    isSafeNonNegative(value['matchedAtMs']) &&
    isMatchEvidence(value['evidence'])
  );
}

export function isArtworkList(
  value: unknown,
): value is readonly ArtworkRef[] {
  return (
    Array.isArray(value) && value.length <= 8 && value.every(isArtworkRef)
  );
}

export function isRemoteArtworkList(
  value: unknown,
): value is readonly ArtworkRef[] {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every(isRemoteArtworkRef)
  );
}

/** The audio-metadata fields TrackMetadata and Recording agree on. */
function hasAudioFields(
  value: Record<string, unknown>,
  artworkOk: (artwork: unknown) => boolean,
): boolean {
  return (
    isString(value['title'], 512) &&
    isOptString(value['artist'], 512) &&
    isOptString(value['album'], 512) &&
    isOptSafeNonNegative(value['durationMs']) &&
    isOptSafeNonNegative(value['releaseYear']) &&
    artworkOk(value['artwork']) &&
    (value['explicit'] === null || typeof value['explicit'] === 'boolean') &&
    isOptString(value['genre'], 512)
  );
}

export function isTrackMetadata(value: unknown): value is TrackMetadata {
  return (
    isRecord(value) &&
    hasKeys(
      value,
      [
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
      ],
      ['artistRef', 'albumRef', 'isrc'],
    ) &&
    isTrackRef(value['sourceRef']) &&
    hasAudioFields(value, isRemoteArtworkList) &&
    isStorefront(value['storefront']) &&
    (value['artistRef'] === undefined ||
      value['artistRef'] === null ||
      isEntityRef(value['artistRef'])) &&
    (value['albumRef'] === undefined ||
      value['albumRef'] === null ||
      isEntityRef(value['albumRef'])) &&
    (value['isrc'] === undefined || isOptString(value['isrc'], 64))
  );
}

/** (provider, kind, id) keys must be unique within a recording. */
function hasUniqueSourceRefs(refs: readonly SourceRef[]): boolean {
  return (
    new Set(refs.map((r) => `${r.provider} ${r.kind} ${r.id}`)).size ===
    refs.length
  );
}

export function isRecording(value: unknown): value is Recording {
  return (
    isRecord(value) &&
    hasKeys(
      value,
      [
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
        'provenance',
      ],
      ['artistRef', 'albumRef'],
    ) &&
    isString(value['id'], 64) &&
    hasAudioFields(value, isArtworkList) &&
    isOptString(value['isrc'], 64) &&
    (value['artistRef'] === undefined ||
      value['artistRef'] === null ||
      isEntityRef(value['artistRef'])) &&
    (value['albumRef'] === undefined ||
      value['albumRef'] === null ||
      isEntityRef(value['albumRef'])) &&
    isVersionLabelArray(value['versionLabels']) &&
    Array.isArray(value['sourceRefs']) &&
    value['sourceRefs'].length >= 1 &&
    value['sourceRefs'].every(isTrackRef) &&
    hasUniqueSourceRefs(value['sourceRefs']) &&
    Array.isArray(value['mappings']) &&
    value['mappings'].every(isSourceMapping) &&
    isIn(RECORDING_PROVENANCES, value['provenance'])
  );
}

export function isSettings(value: unknown): value is Settings {
  return (
    isRecord(value) &&
    hasKeys(
      value,
      [
        'catalogProvider',
        'playbackProvider',
        'storefront',
        'qualityKbps',
        'theme',
        'prefetch',
      ],
      [
        'lyricsProvider',
        'radioProvider',
        'artworkCacheBytes',
        'downloadMetered',
        'language',
      ],
    ) &&
    isString(value['catalogProvider'], 64) &&
    isString(value['playbackProvider'], 64) &&
    isStorefront(value['storefront']) &&
    typeof value['qualityKbps'] === 'number' &&
    Number.isSafeInteger(value['qualityKbps']) &&
    value['qualityKbps'] >= 1 &&
    value['qualityKbps'] <= 512 &&
    isIn(THEMES, value['theme']) &&
    typeof value['prefetch'] === 'boolean' &&
    (value['lyricsProvider'] === undefined ||
      isOptString(value['lyricsProvider'], 64)) &&
    (value['radioProvider'] === undefined ||
      isOptString(value['radioProvider'], 64)) &&
    (value['artworkCacheBytes'] === undefined ||
      (typeof value['artworkCacheBytes'] === 'number' &&
        Number.isSafeInteger(value['artworkCacheBytes']) &&
        value['artworkCacheBytes'] >= ARTWORK_CACHE_BUDGET_MIN_BYTES &&
        value['artworkCacheBytes'] <= ARTWORK_CACHE_BUDGET_MAX_BYTES)) &&
    (value['downloadMetered'] === undefined ||
      typeof value['downloadMetered'] === 'boolean') &&
    (value['language'] === undefined ||
      isOptString(value['language'], 24))
  );
}

export function isLike(value: unknown): value is Like {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['entityKind', 'targetId', 'likedAtMs']) &&
    isIn(LIKE_ENTITY_KINDS, value['entityKind']) &&
    isString(value['targetId'], 64) &&
    isSafeNonNegative(value['likedAtMs'])
  );
}

export function isQueueOccurrence(value: unknown): value is QueueOccurrence {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['occurrenceId', 'recordingId', 'selectedRef']) &&
    isString(value['occurrenceId'], 64) &&
    isString(value['recordingId'], 64) &&
    (value['selectedRef'] === null || isTrackRef(value['selectedRef']))
  );
}

export function isAppErrorLike(value: unknown): boolean {
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
  if (
    !isRecord(value) ||
    !hasKeys(
      value,
      ['revision', 'occurrences', 'currentOccurrenceId', 'positionMs', 'mode'],
      ['blockedError', 'origin'],
    )
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
    origin,
  } = value;
  if (
    !isSafeNonNegative(revision) ||
    !isSafeNonNegative(positionMs) ||
    !Array.isArray(occurrences) ||
    !occurrences.every(isQueueOccurrence) ||
    (mode !== 'stopped' && mode !== 'paused' && mode !== 'playing') ||
    (currentOccurrenceId !== null && typeof currentOccurrenceId !== 'string') ||
    (blockedError !== undefined && !isAppErrorLike(blockedError)) ||
    (origin !== undefined && !isQueueOrigin(origin))
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
  return (
    ids.has(currentOccurrenceId) &&
    mode !== 'stopped' &&
    (blockedError === undefined || mode === 'paused')
  );
}

/** The Recording fields a provider metadata record refreshes. */
function audioFields(metadata: TrackMetadata) {
  return {
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
    durationMs: metadata.durationMs,
    releaseYear: metadata.releaseYear,
    artwork: metadata.artwork,
    explicit: metadata.explicit,
    genre: metadata.genre,
    versionLabels: extractVersionLabels(metadata.title, metadata.explicit),
  };
}

export function recordingFromMetadata(
  metadata: TrackMetadata,
  id: string,
): Recording {
  return {
    id,
    ...audioFields(metadata),
    isrc: metadata.isrc ?? null,
    artistRef: metadata.artistRef ?? null,
    albumRef: metadata.albumRef ?? null,
    sourceRefs: [metadata.sourceRef],
    mappings: [],
    provenance:
      metadata.sourceRef.provider === LOCAL_PROVIDER ? 'local' : 'provider',
  };
}

/**
 * Refreshes a recording's metadata fields from a provider record for
 * one of its own refs — version labels are re-derived and an ISRC /
 * entity ref is only ever filled in, never removed. Identity fields
 * (`id`, `sourceRefs`, `mappings`) are untouched.
 */
export function mergeRecordingMetadata(
  recording: Recording,
  metadata: TrackMetadata,
): Recording {
  return {
    ...recording,
    ...audioFields(metadata),
    isrc: metadata.isrc ?? recording.isrc,
    artistRef: metadata.artistRef ?? recording.artistRef ?? null,
    albumRef: metadata.albumRef ?? recording.albumRef ?? null,
  };
}

// ---- downloads (slice 3) -------------------------------------------------

/**
 * The download FSM's persisted states. `requested` is queued but
 * unstarted; `transferring` holds a live or resumable transfer;
 * `available` is the durable terminal (files never expire);
 * `failed_with_retry` keeps the row for an explicit retry;
 * `removing` is the delete-in-flight mark that startup finishes.
 */
export type DownloadState =
  | 'requested'
  | 'transferring'
  | 'available'
  | 'failed_with_retry'
  | 'removing';

/**
 * One owned download row — at most one per recording
 * (`recording_id UNIQUE`; a re-download replaces the row). `filePath`
 * is device-local transport detail: it is never exported.
 */
export type DownloadRecord = {
  downloadId: string;
  recordingId: string;
  /** The minting provider id — the provider that owns `sourceRef`. */
  provider: string;
  /** The mapping the transfer minted from, for resume/re-mint. */
  sourceRef: SourceRef;
  /** Absolute path of the committed file (device-local). */
  filePath: string;
  /** Final byte size once `state` is `available`; the sink size before. */
  bytes: number;
  state: DownloadState;
  /** Durable resume offset — bytes the sink has committed. */
  committedOffset: number;
  /** SHA-256 hex of the finalized file; null until finalize. */
  checksum: string | null;
  mime: string | null;
  /** Minted format pin (provider-specific, e.g. itag); null when none. */
  itag: number | null;
  /**
   * Mint expiry of the in-flight/last source. Honest for partial
   * downloads; `available` rows ignore it.
   */
  expiresAtMs: number | null;
  /** The last typed failure on a `failed_with_retry` row. */
  error: { kind: string; message: string } | null;
  /** Scheduler band: lower starts earlier (see download-manager). */
  priority: number;
  requestedMs: number;
  downloadedMs: number | null;
};

/** A user-pinned local-files folder (SAF tree grant). */
export type LocalSource = {
  sourceId: string;
  /** Persisted SAF tree URI grant. */
  treeUri: string;
  label: string;
  addedMs: number;
  lastScanMs: number | null;
};

/**
 * One scanned local file. `fileId` is fingerprint-derived (stable
 * across moves); `docId` is the SAF document locator — refreshable,
 * never exported.
 */
export type LocalFile = {
  fileId: string;
  sourceId: string;
  docId: string;
  size: number;
  fingerprint: string;
  /**
   * The provider's last-modified stamp at scan time — the cheap
   * change token for same-size in-place replacements. `null` for
   * providers that don't report one; those entries re-fingerprint
   * on every scan instead of trusting size alone.
   */
  modifiedMs: number | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  genre: string | null;
  recordingId: string;
};

/** Live transfer progress for UI rows (not persisted). */
export type DownloadProgress = {
  downloadId: string;
  recordingId: string;
  state: DownloadState;
  /** Bytes committed so far; equals `committedOffset` while live. */
  transferredBytes: number;
  /** Total when the wire reports it; null while unknown. */
  totalBytes: number | null;
};

const DOWNLOAD_STATES: ReadonlySet<string> = new Set([
  'requested',
  'transferring',
  'available',
  'failed_with_retry',
  'removing',
]);

function isDownloadState(value: unknown): value is DownloadState {
  return isIn(DOWNLOAD_STATES, value);
}

export function isDownloadRecord(value: unknown): value is DownloadRecord {
  if (!isRecord(value)) {
    return false;
  }
  const error = value['error'];
  return (
    hasExactKeys(value, [
      'downloadId',
      'recordingId',
      'provider',
      'sourceRef',
      'filePath',
      'bytes',
      'state',
      'committedOffset',
      'checksum',
      'mime',
      'itag',
      'expiresAtMs',
      'error',
      'priority',
      'requestedMs',
      'downloadedMs',
    ]) &&
    isString(value['downloadId'], 64) &&
    isString(value['recordingId'], 64) &&
    isString(value['provider'], 64) &&
    isTrackRef(value['sourceRef']) &&
    isString(value['filePath'], 1024) &&
    isSafeNonNegative(value['bytes']) &&
    isDownloadState(value['state']) &&
    isSafeNonNegative(value['committedOffset']) &&
    value['committedOffset'] <= value['bytes'] &&
    (value['checksum'] === null ||
      (typeof value['checksum'] === 'string' &&
        /^[0-9a-f]{64}$/.test(value['checksum']))) &&
    isOptString(value['mime'], 128) &&
    (value['itag'] === null ||
      (typeof value['itag'] === 'number' &&
        Number.isSafeInteger(value['itag']))) &&
    isOptSafeNonNegative(value['expiresAtMs']) &&
    (error === null ||
      (isRecord(error) &&
        hasExactKeys(error, ['kind', 'message']) &&
        isString(error['kind'], 64) &&
        typeof error['message'] === 'string' &&
        error['message'].length <= 2048)) &&
    isSafeNonNegative(value['priority']) &&
    isSafeNonNegative(value['requestedMs']) &&
    isOptSafeNonNegative(value['downloadedMs']) &&
    (value['state'] !== 'available' || value['downloadedMs'] !== null)
  );
}

export function isLocalSource(value: unknown): value is LocalSource {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'sourceId',
      'treeUri',
      'label',
      'addedMs',
      'lastScanMs',
    ]) &&
    isString(value['sourceId'], 64) &&
    isString(value['treeUri'], 2048) &&
    isString(value['label'], 512) &&
    isSafeNonNegative(value['addedMs']) &&
    isOptSafeNonNegative(value['lastScanMs'])
  );
}

export function isLocalFile(value: unknown): value is LocalFile {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'fileId',
      'sourceId',
      'docId',
      'size',
      'fingerprint',
      'modifiedMs',
      'title',
      'artist',
      'album',
      'durationMs',
      'genre',
      'recordingId',
    ]) &&
    isString(value['fileId'], 128) &&
    isString(value['sourceId'], 64) &&
    isString(value['docId'], 2048) &&
    isSafeNonNegative(value['size']) &&
    isString(value['fingerprint'], 128) &&
    isOptSafeNonNegative(value['modifiedMs']) &&
    isOptString(value['title'], 512) &&
    isOptString(value['artist'], 512) &&
    isOptString(value['album'], 512) &&
    isOptSafeNonNegative(value['durationMs']) &&
    isOptString(value['genre'], 512) &&
    isString(value['recordingId'], 64)
  );
}

