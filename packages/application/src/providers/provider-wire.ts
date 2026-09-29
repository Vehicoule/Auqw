import type { OperationContext } from '../cancellation.ts';
import {
  hasExactKeys,
  hasKeys,
  isArtworkRef,
  isEntityRef,
  isOptString,
  isRecord,
  isSourceRef,
  isString,
  isTrackMetadata,
} from '../domain.ts';
import type {
  ArtworkRef,
  SourceRef,
  TrackMetadata,
} from '../domain.ts';
import { appError, cancelledError, err, ok } from '../errors.ts';
import type { AppError, ErrorKind, Result } from '../errors.ts';
import { isProviderCapability } from '../ports/provider.ts';
import type {
  EntityMetadata,
  EntityPage,
  LyricsLine,
  LyricsMatch,
  LyricsQuery,
  LyricsResult,
  PlayableResource,
  ProviderCapability,
  ProviderPort,
  RadioPage,
  RecordingQuery,
  SearchPage,
} from '../ports/provider.ts';

/**
 * The transport-free half of a ProviderPort adapter: manifest
 * parsing, per-capability wire-payload builders, the wire→domain
 * decoders, and the outcome→Result mapping declared in
 * sdk/contract/capabilities.schema.json (snake_case, exact key sets —
 * guests reject unexpected keys). The desktop (host:* IPC promise)
 * and mobile (auqw-expo startRequest/onRequestOutcome) adapters
 * inject their transport and keep only correlation, cancellation,
 * and dispose bookkeeping.
 */

/** A wire result decoder: null rejects the payload, never throws. */
export type ProviderDecoder<T> = (value: unknown) => T | null;

/**
 * The transport seam each platform adapter injects: issue one
 * capability call with its exact wire payload and settle the decoded
 * domain value (or a typed AppError) on the returned promise.
 */
export type ProviderRequestTransport = <T>(
  capability: ProviderCapability,
  payload: Record<string, unknown>,
  context: OperationContext,
  decode: ProviderDecoder<T>,
) => Promise<Result<T>>;

/**
 * The terminal outcome both transports converge on: `succeeded`
 * carries the raw result JSON for the wire decoders, `failed` the
 * host's kind slug + message. The mobile event outcome and the
 * desktop IPC payload are both structurally assignable here — the
 * attempt trace rides along untouched in either.
 */
export type ProviderWireOutcome = {
  readonly type: 'succeeded' | 'failed';
  readonly resultJson?: string | undefined;
  readonly kind?: string | undefined;
  readonly message?: string | undefined;
};

/**
 * The manifest's declared capability set, filtered to names the ABI
 * knows — anything else cannot be invoked anyway. An absent or
 * malformed list means "declares nothing": every op is `unsupported`.
 */
export function manifestCapabilities(
  manifest: unknown,
): readonly ProviderCapability[] {
  if (!isRecord(manifest)) {
    return [];
  }
  const raw = manifest['capabilities'];
  return Array.isArray(raw)
    ? [...new Set(raw)].filter(isProviderCapability)
    : [];
}

/**
 * The manifest's `version` string — null when absent or malformed.
 * The provider port carries it so the session can age cache rows
 * written under older plugin builds.
 */
export function manifestVersion(manifest: unknown): string | null {
  const version = isRecord(manifest) ? manifest['version'] : null;
  return typeof version === 'string' && version.length > 0
    ? version
    : null;
}

export function providerCancelledError(): AppError {
  return cancelledError();
}

/** A result that fails JSON.parse or capability decode. */
export function invalidProviderResult(): AppError {
  return appError('invalid-response', 'plugin result failed validation');
}

/**
 * outcome → Result: a `failed` outcome maps its slug through the
 * adapter's kind table (unknown slugs degrade there, not here); a
 * `succeeded` outcome is JSON.parsed and run through the capability
 * decoder, and any malformed step settles `invalid-response`.
 */
export function decodeProviderOutcome<T>(
  outcome: ProviderWireOutcome,
  kindOf: (slug: string | undefined) => ErrorKind,
  decode: ProviderDecoder<T>,
): Result<T> {
  if (outcome.type === 'failed') {
    return err(
      appError(
        kindOf(outcome.kind),
        outcome.message || 'plugin request failed',
      ),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.resultJson ?? '');
  } catch {
    return err(invalidProviderResult());
  }
  const decoded = decode(parsed);
  return decoded === null ? err(invalidProviderResult()) : ok(decoded);
}

function isStorefront(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && /^[A-Z]{2}$/.test(value))
  );
}

function isOptInt(
  value: unknown,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max)
  );
}

/** Absent/null pass; a present value must be a well-formed EntityRef. */
function isOptEntityRef(value: unknown): boolean {
  return value === undefined || value === null || isEntityRef(value);
}

/** Wire `trackMetadata` (snake_case) → domain `TrackMetadata`. */
function toTrackMetadata(value: unknown): TrackMetadata | null {
  if (!isRecord(value)) {
    return null;
  }
  // ABI 0.3.0 optional catalog evidence; absent and null normalize
  // to null, a malformed value rejects the whole track.
  const artistRef = value['artist_ref'];
  const albumRef = value['album_ref'];
  const isrc = value['isrc'];
  if (
    !isOptEntityRef(artistRef) ||
    !isOptEntityRef(albumRef) ||
    (isrc !== undefined && !isOptString(isrc, 16))
  ) {
    return null;
  }
  const candidate = {
    sourceRef: value['source_ref'],
    title: value['title'],
    artist: value['artist'],
    album: value['album'],
    durationMs: value['duration_ms'],
    releaseYear: value['release_year'],
    artwork: value['artwork'],
    explicit: value['explicit'],
    genre: value['genre'],
    storefront: value['storefront'],
    artistRef: artistRef ?? null,
    albumRef: albumRef ?? null,
    isrc: isrc ?? null,
  };
  return isTrackMetadata(candidate) ? candidate : null;
}

/**
 * Shared `trackMetadata.items` decode: the wire schema leaves
 * `source_ref.kind` permissive and providers legitimately emit
 * album/artist rows (deezer catalog.entity/metadata), so a well-formed
 * non-track item is dropped rather than poisoning the whole page. An
 * item that fails the full metadata decode — including a non-track
 * row missing required fields — still rejects the batch.
 */
function toTrackItems(items: readonly unknown[]): TrackMetadata[] | null {
  const out: TrackMetadata[] = [];
  for (const item of items) {
    const track = toTrackMetadata(item);
    if (track !== null) {
      out.push(track);
      continue;
    }
    // "Well-formed non-track" = every field validates with only the
    // kind constraint relaxed — decode again with the ref re-keyed
    // as 'track'; a row that still fails is malformed, not non-track.
    if (isRecord(item)) {
      const sourceRef = item['source_ref'];
      if (
        isSourceRef(sourceRef) &&
        sourceRef.kind !== 'track' &&
        toTrackMetadata({
          ...item,
          source_ref: { ...sourceRef, kind: 'track' },
        }) !== null
      ) {
        continue;
      }
    }
    return null;
  }
  return out;
}

/** `items` field decode shared by every list-shaped result. */
function tracksField(
  value: Record<string, unknown>,
): TrackMetadata[] | null {
  const items = value['items'];
  return Array.isArray(items) ? toTrackItems(items) : null;
}

function toTrackList(value: unknown): readonly TrackMetadata[] | null {
  return isRecord(value) && hasExactKeys(value, ['items'])
    ? tracksField(value)
    : null;
}

function toSearchPage(value: unknown): SearchPage | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['items', 'storefront']) ||
    !isStorefront(value['storefront'])
  ) {
    return null;
  }
  const items = tracksField(value);
  return items === null
    ? null
    : { items, storefront: value['storefront'] };
}

/** Wire `playbackResolveResult` → domain `PlayableResource`. */
function toPlayableResource(value: unknown): PlayableResource | null {
  if (
    !isRecord(value) ||
    !hasKeys(
      value,
      ['url', 'mime', 'bitrate_kbps', 'expires_at_ms', 'client'],
      ['content_length', 'itag'],
    )
  ) {
    return null;
  }
  const url = value['url'];
  const mime = value['mime'];
  const client = value['client'];
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    typeof mime !== 'string' ||
    mime.length === 0 ||
    typeof client !== 'string' ||
    client.length === 0
  ) {
    return null;
  }
  const bitrateKbps = value['bitrate_kbps'];
  const expiresAtMs = value['expires_at_ms'];
  const contentLength = value['content_length'] ?? null;
  const itag = value['itag'] ?? null;
  if (
    !isOptInt(bitrateKbps, 0, 4294967295) ||
    !isOptInt(expiresAtMs, 0) ||
    !isOptInt(contentLength, 1) ||
    !isOptInt(itag, 0, 4294967295)
  ) {
    return null;
  }
  return { url, mime, bitrateKbps, expiresAtMs, contentLength, client, itag };
}

/** Wire `entityMetadata` → domain `EntityMetadata`. */
function toEntityMetadata(value: unknown): EntityMetadata | null {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['source_ref', 'kind', 'title', 'artwork'], ['subtitle'])
  ) {
    return null;
  }
  const sourceRef = value['source_ref'];
  if (!isEntityRef(sourceRef) || value['kind'] !== sourceRef.kind) {
    // `kind` and `source_ref.kind` name the same field; a mismatch is
    // ambiguous rather than decorative.
    return null;
  }
  const title = value['title'];
  const subtitle = value['subtitle'] ?? null;
  const artwork = value['artwork'];
  if (
    typeof title !== 'string' ||
    title.length === 0 ||
    title.length > 512 ||
    (subtitle !== null &&
      (typeof subtitle !== 'string' || subtitle.length === 0)) ||
    !Array.isArray(artwork) ||
    artwork.length > 8 ||
    !artwork.every(isArtworkRef)
  ) {
    return null;
  }
  return {
    sourceRef,
    kind: sourceRef.kind,
    title,
    subtitle,
    artwork,
  };
}

/** Wire `catalogEntityResult` → domain `EntityPage`. */
function toEntityPage(value: unknown): EntityPage | null {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['entity', 'items', 'complete'], ['continuation'])
  ) {
    return null;
  }
  const entity = toEntityMetadata(value['entity']);
  if (entity === null || typeof value['complete'] !== 'boolean') {
    return null;
  }
  const tracks = tracksField(value);
  if (tracks === null) {
    return null;
  }
  const continuation = value['continuation'] ?? null;
  if (
    continuation !== null &&
    (typeof continuation !== 'string' || continuation.length === 0)
  ) {
    return null;
  }
  return {
    entity,
    items: tracks,
    continuation,
    complete: value['complete'],
  };
}

/** Wire `lyricsMatched` → domain `LyricsMatch`; null stays null. */
function toLyricsMatch(value: unknown): LyricsMatch | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['title', 'artist', 'album', 'duration_ms'])
  ) {
    return null;
  }
  const title = value['title'];
  const artist = value['artist'];
  const album = value['album'];
  const durationMs = value['duration_ms'];
  if (
    typeof title !== 'string' ||
    title.length === 0 ||
    title.length > 512 ||
    !(artist === null || (typeof artist === 'string' && artist.length > 0)) ||
    !(album === null || (typeof album === 'string' && album.length > 0)) ||
    !isOptInt(durationMs, 0)
  ) {
    return null;
  }
  return { title, artist, album, durationMs };
}

function matchedField(value: Record<string, unknown>): LyricsMatch | null | undefined {
  const raw = value['matched'];
  return raw === null ? null : (toLyricsMatch(raw) ?? undefined);
}

/** The non-text states both lyrics results share. */
function staticLyrics(
  state: unknown,
  matched: LyricsMatch | null,
): LyricsResult | null {
  if (state === 'instrumental') {
    return { kind: 'instrumental', matched };
  }
  return state === 'absent' ? { kind: 'unavailable', matched } : null;
}

/** Wire `lyricsSyncedResult` → domain `LyricsResult`. */
function toSyncedLyrics(value: unknown): LyricsResult | null {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['state', 'matched'], ['lines'])
  ) {
    return null;
  }
  const matched = matchedField(value);
  if (matched === undefined) {
    return null;
  }
  const state = value['state'];
  const rawLines = value['lines'] ?? null;
  if (state === 'synced') {
    if (!Array.isArray(rawLines) || rawLines.length === 0) {
      return null;
    }
    const lines: LyricsLine[] = [];
    for (const raw of rawLines) {
      if (!isRecord(raw) || !hasExactKeys(raw, ['t_ms', 'text'])) {
        return null;
      }
      const tMs = raw['t_ms'];
      const text = raw['text'];
      if (
        typeof tMs !== 'number' ||
        !Number.isSafeInteger(tMs) ||
        tMs < 0 ||
        typeof text !== 'string' ||
        text.length > 1024
      ) {
        return null;
      }
      lines.push({ tMs, text });
    }
    return { kind: 'synced', lines, matched };
  }
  // Timed lines on a non-synced state contradict it; never dropped.
  if (rawLines !== null) {
    return null;
  }
  return staticLyrics(state, matched);
}

/** Wire `lyricsPlainResult` → domain `LyricsResult`. */
function toPlainLyrics(value: unknown): LyricsResult | null {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['state', 'matched'], ['text'])
  ) {
    return null;
  }
  const matched = matchedField(value);
  if (matched === undefined) {
    return null;
  }
  const state = value['state'];
  const text = value['text'] ?? null;
  if (state === 'plain') {
    return typeof text === 'string' && text.length > 0
      ? { kind: 'plain', text, matched }
      : null;
  }
  if (text !== null) {
    return null;
  }
  return staticLyrics(state, matched);
}

/** Wire `{suggestions: string[]}` → flat completion list. */
function toSuggestionList(value: unknown): readonly string[] | null {
  if (!isRecord(value) || !hasExactKeys(value, ['suggestions'])) {
    return null;
  }
  const suggestions = value['suggestions'];
  if (
    !Array.isArray(suggestions) ||
    suggestions.length > 32 ||
    !suggestions.every((s): s is string => isString(s, 512))
  ) {
    return null;
  }
  return suggestions;
}

/** Wire `radioSeedResult` → domain `RadioPage`. */
function toRadioPage(value: unknown): RadioPage | null {
  if (!isRecord(value) || !hasExactKeys(value, ['items', 'continuation'])) {
    return null;
  }
  const candidates = tracksField(value);
  if (candidates === null) {
    return null;
  }
  const continuation = value['continuation'];
  if (
    continuation !== null &&
    (typeof continuation !== 'string' || continuation.length === 0)
  ) {
    return null;
  }
  return { candidates, continuation };
}

/** Wire `catalogArtworkResult` → domain `ArtworkRef` list. */
function toArtworkItems(
  value: unknown,
  ref: SourceRef,
): readonly ArtworkRef[] | null {
  if (!isRecord(value) || !hasExactKeys(value, ['source_ref', 'items'])) {
    return null;
  }
  const sourceRef = value['source_ref'];
  if (!isSourceRef(sourceRef)) {
    return null;
  }
  // The wire ref is the plugin's own correlation answer: artwork for a
  // different provider item is valid JSON that belongs to another track.
  if (
    sourceRef.provider !== ref.provider ||
    sourceRef.kind !== ref.kind ||
    sourceRef.id !== ref.id
  ) {
    return null;
  }
  const items = value['items'];
  if (
    !Array.isArray(items) ||
    items.length > 8 ||
    !items.every(isArtworkRef)
  ) {
    return null;
  }
  return items;
}

function wireRecordingQuery(query: RecordingQuery): Record<string, unknown> {
  return {
    title: query.title,
    artist: query.artist,
    album: query.album,
    duration_ms: query.durationMs,
    version_labels: query.versionLabels,
    isrc: query.isrc,
  };
}

function wireLyricsQuery(query: LyricsQuery): Record<string, unknown> {
  return {
    title: query.title,
    artist: query.artist,
    album: query.album,
    duration_ms: query.durationMs,
    isrc: query.isrc,
  };
}

function wireSourceRef(ref: SourceRef): Record<string, unknown> {
  return { provider: ref.provider, kind: ref.kind, id: ref.id };
}

/**
 * The ProviderPort method table over an injected transport: each op
 * guards the manifest-declared capability, builds that capability's
 * exact wire payload, and decodes the outcome through the matching
 * wire decoder. Both platform adapters delegate here so the ABI key
 * sets and decode strictness exist exactly once.
 */
export function createProviderWirePort(
  providerId: string,
  capabilities: readonly ProviderCapability[],
  version: string | null,
  transport: ProviderRequestTransport,
): ProviderPort {
  /** An op the manifest never declared never reaches the host. */
  function guard(capability: ProviderCapability): AppError | null {
    return capabilities.includes(capability)
      ? null
      : appError(
          'unsupported',
          `provider does not declare ${capability}`,
        );
  }

  function call<T>(
    capability: ProviderCapability,
    payload: Record<string, unknown>,
    context: OperationContext,
    decode: ProviderDecoder<T>,
  ): Promise<Result<T>> {
    const blocked = guard(capability);
    return blocked !== null
      ? Promise.resolve(err(blocked))
      : transport(capability, payload, context, decode);
  }

  return {
    id: providerId,
    capabilities,
    version,
    search(input, context) {
      return call(
        'catalog.search',
        {
          query: input.query,
          limit: input.limit,
          storefront: input.storefront,
        },
        context,
        toSearchPage,
      );
    },
    candidates(input, context) {
      return call(
        'playback.candidates',
        { query: wireRecordingQuery(input.query), limit: input.limit },
        context,
        toTrackList,
      );
    },
    resolvePlayback(ref, input, context) {
      return call(
        'playback.resolve',
        {
          source_ref: wireSourceRef(ref),
          target_bitrate_kbps: input.targetBitrateKbps,
          prefer: input.prefer,
          pin_itag: input.pinItag,
          resume_offset: input.resumeOffset,
        },
        context,
        toPlayableResource,
      );
    },
    getDetails(refs, context) {
      return call(
        'catalog.metadata',
        { refs: refs.map(wireSourceRef) },
        context,
        toTrackList,
      );
    },
    getEntity(ref, context) {
      return call(
        'catalog.entity',
        { ref: wireSourceRef(ref) },
        context,
        toEntityPage,
      );
    },
    artwork(ref, input, context) {
      return call(
        'catalog.artwork',
        { ref: wireSourceRef(ref), size: input.size },
        context,
        (value) => toArtworkItems(value, ref),
      );
    },
    getLyrics(input, context) {
      // `prefer` picks the capability: a synced request degrades to
      // lyrics.plain when the provider declares only that; a plain
      // request never climbs to synced.
      const capability =
        input.prefer === 'plain' || !capabilities.includes('lyrics.synced')
          ? 'lyrics.plain'
          : 'lyrics.synced';
      return call(
        capability,
        { query: wireLyricsQuery(input.query) },
        context,
        capability === 'lyrics.synced' ? toSyncedLyrics : toPlainLyrics,
      );
    },
    radioSeed(input, context) {
      return call(
        'radio.seed',
        'sourceRef' in input
          ? { source_ref: wireSourceRef(input.sourceRef) }
          : { continuation: input.continuation },
        context,
        toRadioPage,
      );
    },
    suggest(input, context) {
      return call(
        'catalog.suggest',
        { input: input.input, limit: input.limit },
        context,
        toSuggestionList,
      );
    },
  };
}
