import type { OperationContext } from '../cancellation.ts';
import {
  hasExactKeys,
  hasKeys,
  isEntityRef,
  isOptString,
  isRecord,
  isRemoteArtworkRef,
  isSourceRef,
  isStorefront,
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
import { isProviderCapability, isRelatedGroup } from '../ports/provider.ts';
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
  SearchTopHit,
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
    const message =
      typeof outcome.message === 'string' && outcome.message.length > 0
        ? outcome.message
        : 'plugin request failed';
    return err(appError(kindOf(outcome.kind), message, retryAfterMsOf(message)));
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

/**
 * A `failed` wire outcome carries no structured retry hint — guests
 * ride the provider's cooldown in the message as `retry_after=<secs>`
 * (the convention both lyrics-lrclib and deezer use for upstream
 * Retry-After). Parses it into AppError.retryAfterMs so the retry
 * policy honors the provider's own window instead of guessing one.
 * The value is capped by the 10-digit literal, always a safe ms.
 */
function retryAfterMsOf(message: string): number | undefined {
  const m = /\bretry_after=(\d{1,10})/.exec(message);
  return m === null ? undefined : Number(m[1]) * 1000;
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

/** Null, or a nonempty wire string. */
function isOptWireString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0);
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
    !hasKeys(
      value,
      ['items', 'storefront'],
      ['entities', 'top_hit', 'continuation'],
    ) ||
    !isStorefront(value['storefront'])
  ) {
    return null;
  }
  const items = tracksField(value);
  // Absent decodes to [] — an explicit null or non-array poisons the
  // page exactly like a malformed row does `items`.
  const entities =
    value['entities'] === undefined
      ? []
      : toEntityItems(value['entities']);
  const topHit = toTopHit(value['top_hit']);
  const continuation = value['continuation'] ?? null;
  if (
    items === null ||
    entities === null ||
    topHit === undefined ||
    !isOptWireString(continuation)
  ) {
    return null;
  }
  return {
    items,
    entities,
    topHit,
    continuation,
    storefront: value['storefront'],
  };
}

/**
 * Names the host controls on every wire fetch — a mint may never
 * dictate them. Mirrors the plugin-host's own list (host-surface
 * `HOST_OWNED`); a divergence would let a resolve pass here and fail
 * natively on the streaming leg.
 */
const HOST_OWNED_HEADERS: ReadonlySet<string> = new Set([
  'range',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'accept-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'www-authenticate',
  'authorization',
  'cookie',
  'set-cookie',
]);

const MAX_MINT_HEADERS = 16;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;

/**
 * Wire `headers` → the resource's fetch headers, mirroring the
 * plugin-host decoder exactly: ≤16 entries, RFC 9110 token names ≤64
 * unique after lowercase-folding, values 1–512 UTF-8 bytes of visible
 * text (each byte 0x20–0x7e | 0x80–0xff). The native rule runs at the
 * byte level: a codepoint below 0x80 must itself be printable ASCII;
 * at ≥0x80 its whole UTF-8 encoding is all-≥0x80 bytes and admitted.
 * Absent/null → `{}`; any violation poisons the whole resolve
 * result, exactly as the native decoder's `invalid-response`.
 */
function toMintHeaders(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_MINT_HEADERS) {
    return null;
  }
  const seen = new Set<string>();
  // Null prototype: '__proto__' is a valid RFC 9110 token the native
  // Vec-pair decoder carries verbatim — on a plain object literal the
  // assignment below silently no-ops and drops the header.
  const headers: Record<string, string> = Object.create(null);
  for (const [name, headerValue] of entries) {
    const folded = name.toLowerCase();
    if (
      !HEADER_NAME.test(name) ||
      HOST_OWNED_HEADERS.has(folded) ||
      seen.has(folded)
    ) {
      return null;
    }
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      return null;
    }
    let byteLen = 0;
    for (const ch of headerValue) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x80) {
        // Single byte — must be visible ASCII (DEL excluded).
        if (code < 0x20 || code === 0x7f) {
          return null;
        }
        byteLen += 1;
      } else {
        // A lone surrogate can't encode — and can't arrive over the
        // native JSON boundary either; reject rather than diverge.
        if (code >= 0xd800 && code <= 0xdfff) {
          return null;
        }
        // Every UTF-8 byte of a ≥0x80 codepoint is ≥0x80 — admitted.
        byteLen += code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      }
    }
    if (byteLen > 512) {
      return null;
    }
    seen.add(folded);
    headers[folded] = headerValue;
  }
  return headers;
}

/** Wire `playbackResolveResult` → domain `PlayableResource`. */
function toPlayableResource(value: unknown): PlayableResource | null {
  if (
    !isRecord(value) ||
    !hasKeys(
      value,
      ['url', 'mime', 'bitrate_kbps', 'expires_at_ms', 'client'],
      ['content_length', 'itag', 'headers'],
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
  const headers = toMintHeaders(value['headers']);
  if (headers === null) {
    return null;
  }
  return {
    url,
    mime,
    bitrateKbps,
    expiresAtMs,
    contentLength,
    client,
    itag,
    headers,
  };
}

/** Wire `entityMetadata` → domain `EntityMetadata`. */
function toEntityMetadata(value: unknown): EntityMetadata | null {
  if (
    !isRecord(value) ||
    !hasKeys(
      value,
      ['source_ref', 'kind', 'title', 'artwork'],
      ['subtitle', 'group'],
    )
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
  const group = value['group'] ?? null;
  if (
    !isString(title, 512) ||
    !isOptWireString(subtitle) ||
    !Array.isArray(artwork) ||
    artwork.length > 8 ||
    !artwork.every(isRemoteArtworkRef) ||
    !(group === null || isRelatedGroup(group))
  ) {
    return null;
  }
  return {
    sourceRef,
    kind: sourceRef.kind,
    title,
    subtitle,
    artwork,
    group,
  };
}

/** The schema's `maxItems` on `entities`/`related`. */
const MAX_ENTITY_ITEMS = 200;

/**
 * `entities`/`related` field decode: every entry must be a well-formed
 * entityMetadata — a malformed one poisons the page exactly like a
 * malformed track row does `items`. An over-cap array is invalid,
 * not truncated — the same poison rule as the artwork/suggestions caps.
 */
function toEntityItems(value: unknown): EntityMetadata[] | null {
  if (!Array.isArray(value) || value.length > MAX_ENTITY_ITEMS) {
    return null;
  }
  const out: EntityMetadata[] = [];
  for (const item of value) {
    const entity = toEntityMetadata(item);
    if (entity === null) {
      return null;
    }
    out.push(entity);
  }
  return out;
}

/** Wire `top_hit` → domain `SearchTopHit`; the tag discriminates. */
function toTopHit(value: unknown): SearchTopHit | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'item'])) {
    return undefined;
  }
  if (value['type'] === 'track') {
    const item = toTrackMetadata(value['item']);
    return item === null ? undefined : { type: 'track', item };
  }
  if (value['type'] === 'entity') {
    const item = toEntityMetadata(value['item']);
    return item === null ? undefined : { type: 'entity', item };
  }
  return undefined;
}

/** Wire `catalogEntityResult` → domain `EntityPage`. */
function toEntityPage(value: unknown): EntityPage | null {
  if (
    !isRecord(value) ||
    !hasKeys(
      value,
      ['entity', 'items', 'complete'],
      ['continuation', 'related'],
    )
  ) {
    return null;
  }
  const entity = toEntityMetadata(value['entity']);
  if (entity === null || typeof value['complete'] !== 'boolean') {
    return null;
  }
  const tracks = tracksField(value);
  const related =
    value['related'] === undefined
      ? []
      : toEntityItems(value['related']);
  if (tracks === null || related === null) {
    return null;
  }
  const continuation = value['continuation'] ?? null;
  if (!isOptWireString(continuation)) {
    return null;
  }
  return {
    entity,
    items: tracks,
    related,
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
    !isOptWireString(artist) ||
    !isOptWireString(album) ||
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

/**
 * Shared lyrics-record preamble: `{state, matched}` keys plus the
 * capability's own payload key. Null rejects; `extra` is the payload.
 */
function lyricsBase(
  value: unknown,
  payloadKey: 'lines' | 'text',
): { state: unknown; matched: LyricsMatch | null; extra: unknown } | null {
  if (!isRecord(value) || !hasKeys(value, ['state', 'matched'], [payloadKey])) {
    return null;
  }
  const matched = matchedField(value);
  if (matched === undefined) {
    return null;
  }
  return {
    state: value['state'],
    matched,
    extra: value[payloadKey] ?? null,
  };
}

function toLyricsLine(raw: unknown): LyricsLine | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['t_ms', 'text'])) {
    return null;
  }
  const tMs = raw['t_ms'];
  const text = raw['text'];
  return typeof tMs === 'number' &&
    Number.isSafeInteger(tMs) &&
    tMs >= 0 &&
    typeof text === 'string' &&
    text.length <= 1024
    ? { tMs, text }
    : null;
}

/** Wire `lyricsSyncedResult` → domain `LyricsResult`. */
function toSyncedLyrics(value: unknown): LyricsResult | null {
  const base = lyricsBase(value, 'lines');
  if (base === null) {
    return null;
  }
  if (base.state === 'synced') {
    if (!Array.isArray(base.extra) || base.extra.length === 0) {
      return null;
    }
    const lines: LyricsLine[] = [];
    for (const raw of base.extra) {
      const line = toLyricsLine(raw);
      if (line === null) {
        return null;
      }
      lines.push(line);
    }
    return { kind: 'synced', lines, matched: base.matched };
  }
  // Timed lines on a non-synced state contradict it; never dropped.
  if (base.extra !== null) {
    return null;
  }
  return staticLyrics(base.state, base.matched);
}

/** Wire `lyricsPlainResult` → domain `LyricsResult`. */
function toPlainLyrics(value: unknown): LyricsResult | null {
  const base = lyricsBase(value, 'text');
  if (base === null) {
    return null;
  }
  if (base.state === 'plain') {
    return isOptWireString(base.extra) && base.extra !== null
      ? { kind: 'plain', text: base.extra, matched: base.matched }
      : null;
  }
  if (base.extra !== null) {
    return null;
  }
  return staticLyrics(base.state, base.matched);
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
  if (candidates === null || !isOptWireString(value['continuation'])) {
    return null;
  }
  return { candidates, continuation: value['continuation'] };
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
    !items.every(isRemoteArtworkRef)
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
      // `kinds`/`continuation` widen the base search payload — a
      // guest built before the extension rejects the extra keys
      // outright, so they go only to providers declaring
      // `catalog.search.kinds`. Everyone else gets the original
      // exact-key payload: an unscoped first page, not a guest error.
      const scoped = capabilities.includes('catalog.search.kinds');
      return call(
        'catalog.search',
        {
          query: input.query,
          limit: input.limit,
          storefront: input.storefront,
          // Optional fields stay absent when unset — guests enforce
          // exact key sets, and an empty kinds set has no meaning.
          ...(scoped && input.kinds !== undefined && input.kinds.length > 0
            ? { kinds: [...input.kinds] }
            : {}),
          ...(scoped &&
          input.continuation !== undefined &&
          input.continuation.length > 0
            ? { continuation: input.continuation }
            : {}),
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
