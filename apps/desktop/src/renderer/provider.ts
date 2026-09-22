import type {
  AppError,
  ArtworkRef,
  EntityMetadata,
  EntityPage,
  LyricsLine,
  LyricsMatch,
  LyricsQuery,
  LyricsResult,
  OperationContext,
  PlayableResource,
  ProviderCapability,
  ProviderPort,
  RadioPage,
  RecordingQuery,
  Result,
  SearchPage,
  SourceRef,
  TrackMetadata,
} from '@auqw/application';
import {
  appError,
  err,
  isArtworkRef,
  isEntityRef,
  isProviderCapability,
  isSourceRef,
  isTrackMetadata,
  ok,
} from '@auqw/application';
import type { ErrorKind } from '@auqw/application';
import { isRecord } from '../shared/check.ts';
import type { AuqwApi, RequestOutcomePayload } from '../shared/contract.ts';
import { createIds } from './runtime.ts';

/**
 * ProviderPort over the desktop `host:*` IPC surface. Each port method
 * builds the wire payload declared in
 * sdk/contract/capabilities.schema.json (snake_case, exact key sets —
 * guests reject unexpected keys), mints a request id, and settles on
 * the promise `host.request` resolves — the napi `startRequest` returns
 * the terminal outcome directly, so there is no out-of-band listener
 * or pending/early correlation map like the mobile adapter keeps. The
 * injected seam is the preload `host` section only; this file stays
 * DOM-free so the adapter is testable under plain Node.
 */
export type AuqwHost = AuqwApi['host'];

/**
 * Host-channel error kinds: the plugin taxonomy a guest legitimately
 * emits plus the shell kinds an IPC/preload rejection can carry (the
 * host folds transport failures into the outcome's `kind`). Unknown
 * slugs degrade to `internal`, matching the mobile map.
 */
const HOST_KIND: Readonly<Record<string, ErrorKind>> = {
  'no-result': 'no-result',
  'not-applicable': 'not-applicable',
  unsupported: 'unsupported',
  'auth-required': 'auth-required',
  'auth-expired': 'auth-expired',
  'rate-limit': 'rate-limit',
  transient: 'transient',
  'expired-resource': 'expired-resource',
  'permission-denied': 'permission-denied',
  'invalid-response': 'invalid-response',
  timeout: 'timeout',
  cancelled: 'cancelled',
  'budget-exceeded': 'budget-exceeded',
  'guest-trap': 'guest-trap',
  'invalid-message': 'invalid-message',
  'artifact-rejected': 'artifact-rejected',
  'streams-capped': 'streams-capped',
  released: 'released',
  superseded: 'superseded',
  evicted: 'evicted',
  expired: 'expired',
  'not-found': 'not-found',
  unavailable: 'unavailable',
  'storage-full': 'storage-full',
  'io-error': 'transient',
  'invalid-request': 'invalid-response',
  'not-implemented': 'unavailable',
  'process-crashed': 'unavailable',
  'corrupt-state': 'internal',
  internal: 'internal',
};

function hostKind(kind: unknown): ErrorKind {
  return typeof kind === 'string' && kind in HOST_KIND
    ? (HOST_KIND[kind] as ErrorKind)
    : 'internal';
}

/** A `host.request` rejection is a ShellError-shaped value crossing IPC. */
function hostError(thrown: unknown): AppError {
  if (isRecord(thrown)) {
    const kind = hostKind(thrown['kind']);
    const message =
      typeof thrown['message'] === 'string' && thrown['message'].length > 0
        ? (thrown['message'] as string)
        : 'host call failed';
    return appError(kind, message);
  }
  return appError('internal', 'host call failed');
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

/** Exact-keys with declared optionals: required present, own keys ⊆ required ∪ optional. */
function hasKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const own = Object.keys(value);
  return (
    own.every((k) => required.includes(k) || optional.includes(k)) &&
    required.every((k) => Object.hasOwn(value, k))
  );
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

/** Wire `trackMetadata` (snake_case) → domain `TrackMetadata`. */
function toTrackMetadata(value: unknown): TrackMetadata | null {
  if (!isRecord(value)) {
    return null;
  }
  // ABI 0.3.0 optional catalog evidence; absent and null normalize
  // to null, a malformed value rejects the whole track.
  const artistRef = value['artist_ref'];
  if (
    artistRef !== undefined &&
    artistRef !== null &&
    !isEntityRef(artistRef)
  ) {
    return null;
  }
  const albumRef = value['album_ref'];
  if (
    albumRef !== undefined &&
    albumRef !== null &&
    !isEntityRef(albumRef)
  ) {
    return null;
  }
  const isrc = value['isrc'];
  if (
    isrc !== undefined &&
    !(
      isrc === null ||
      (typeof isrc === 'string' && isrc.length > 0 && isrc.length <= 16)
    )
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

function toTrackList(value: unknown): readonly TrackMetadata[] | null {
  if (!isRecord(value) || !hasExactKeys(value, ['items'])) {
    return null;
  }
  const items = value['items'];
  if (!Array.isArray(items)) {
    return null;
  }
  return toTrackItems(items);
}

function toSearchPage(value: unknown): SearchPage | null {
  if (!isRecord(value) || !hasExactKeys(value, ['items', 'storefront'])) {
    return null;
  }
  if (!isStorefront(value['storefront'])) {
    return null;
  }
  const items = value['items'];
  if (!Array.isArray(items)) {
    return null;
  }
  const out = toTrackItems(items);
  if (out === null) {
    return null;
  }
  return { items: out, storefront: value['storefront'] };
}

/** Wire `playbackResolveResult` → domain `PlayableResource`. */
function toPlayableResource(value: unknown): PlayableResource | null {
  if (
    !isRecord(value) ||
    !(
      hasExactKeys(value, [
        'url',
        'mime',
        'bitrate_kbps',
        'expires_at_ms',
        'client',
      ]) ||
      hasExactKeys(value, [
        'url',
        'mime',
        'bitrate_kbps',
        'expires_at_ms',
        'client',
        'content_length',
      ]) ||
      hasExactKeys(value, [
        'url',
        'mime',
        'bitrate_kbps',
        'expires_at_ms',
        'client',
        'itag',
      ]) ||
      hasExactKeys(value, [
        'url',
        'mime',
        'bitrate_kbps',
        'expires_at_ms',
        'client',
        'content_length',
        'itag',
      ])
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
  const items = value['items'];
  if (!Array.isArray(items)) {
    return null;
  }
  const tracks = toTrackItems(items);
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
  if (state === 'instrumental') {
    return { kind: 'instrumental', matched };
  }
  if (state === 'absent') {
    return { kind: 'unavailable', matched };
  }
  return null;
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
  if (state === 'instrumental') {
    return { kind: 'instrumental', matched };
  }
  if (state === 'absent') {
    return { kind: 'unavailable', matched };
  }
  return null;
}

/** Wire `radioSeedResult` → domain `RadioPage`. */
function toRadioPage(value: unknown): RadioPage | null {
  if (!isRecord(value) || !hasExactKeys(value, ['items', 'continuation'])) {
    return null;
  }
  const items = value['items'];
  if (!Array.isArray(items)) {
    return null;
  }
  const candidates = toTrackItems(items);
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

function cancelledError(): AppError {
  return appError('cancelled', 'cancelled');
}

function invalidResult(): AppError {
  return appError('invalid-response', 'plugin result failed validation');
}

export type PluginProvider = ProviderPort & { dispose(): void };

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
  if (!Array.isArray(raw)) {
    return [];
  }
  return [...new Set(raw)].filter(isProviderCapability);
}

export function createPluginProvider(
  host: AuqwHost,
  pluginId: string,
  providerId: string,
  capabilities: readonly ProviderCapability[],
): PluginProvider {
  const ids = createIds();
  /** requestId → abort: in-flight calls a dispose() must settle. */
  const inFlight = new Map<string, () => void>();
  let disposed = false;

  /** An op the manifest never declared never reaches the host. */
  function guard(capability: ProviderCapability): AppError | null {
    return capabilities.includes(capability)
      ? null
      : appError(
          'unsupported',
          `provider does not declare ${capability}`,
        );
  }

  function request<T>(
    capability: string,
    payload: Record<string, unknown>,
    context: OperationContext,
    decode: (value: unknown) => T | null,
  ): Promise<Result<T>> {
    const signal = context.signal;
    if (disposed) {
      return Promise.resolve(
        err(appError('unavailable', 'provider is disposed')),
      );
    }
    if (signal.cancelled) {
      return Promise.resolve(err(cancelledError()));
    }
    return new Promise<Result<T>>((resolve) => {
      const requestId = ids.next('req');
      let done = false;
      let issued = false;
      let unsubscribe: () => void = () => { };
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: Result<T>): void => {
        // First-settle-wins: a late outcome landing after a cancel (or
        // a dispose) must not overwrite the settled Result.
        if (done) {
          return;
        }
        done = true;
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
        }
        unsubscribe();
        inFlight.delete(requestId);
        resolve(result);
      };
      const settle = (outcome: RequestOutcomePayload): void => {
        if (outcome.type === 'failed') {
          finish(
            err(
              appError(
                hostKind(outcome.kind),
                typeof outcome.message === 'string' &&
                  outcome.message.length > 0
                  ? outcome.message
                  : 'plugin request failed',
              ),
            ),
          );
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(outcome.resultJson ?? '');
        } catch {
          finish(err(invalidResult()));
          return;
        }
        const decoded = decode(parsed);
        if (decoded === null) {
          finish(err(invalidResult()));
          return;
        }
        finish(ok(decoded));
      };
      const cancelInFlight = (): void => {
        // The request is dead to us either way; the host aborts it and
        // any late outcome is dropped by the `done` guard. Skip the
        // cancel when the request was never issued (a signal that was
        // already fired synchronously inside subscribe()).
        if (issued) {
          void host.cancelRequest({ requestId }).catch(() => undefined);
        }
        finish(err(cancelledError()));
      };
      inFlight.set(requestId, cancelInFlight);
      // The context's own deadline bounds the call even when nothing
      // cancels it: a wedged host request can't outlive it. Expiry
      // aborts utility-side (same path as signal cancel) and settles
      // typed `timeout` — retryable, not the engine's `cancelled`.
      const remaining = context.deadlineMs - Date.now();
      if (remaining <= 0) {
        finish(err(appError('timeout', 'provider request deadline exceeded')));
        return;
      }
      // setTimeout overflows above 2^31-1ms — a MAX_SAFE_INTEGER
      // deadline means "no effective bound", so clamp, never wrap.
      deadlineTimer = setTimeout(
        () => {
          if (issued) {
            void host.cancelRequest({ requestId }).catch(() => undefined);
          }
          finish(
            err(
              appError('timeout', 'provider request deadline exceeded'),
            ),
          );
        },
        Math.min(remaining, 2_147_483_647),
      );
      // subscribe() fires the listener synchronously when the signal
      // is already cancelled — `done` then suppresses the host call.
      unsubscribe = signal.subscribe(cancelInFlight);
      if (done) {
        return;
      }
      issued = true;
      host
        .request({
          pluginId,
          capability,
          payloadJson: JSON.stringify(payload),
          requestId,
        })
        .then(settle, (thrown: unknown) => finish(err(hostError(thrown))));
    });
  }

  return {
    id: providerId,
    capabilities,
    search(input, context) {
      const blocked = guard('catalog.search');
      if (blocked !== null) {
        return Promise.resolve(err(blocked));
      }
      return request(
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
      const blocked = guard('playback.candidates');
      if (blocked !== null) {
        return Promise.resolve(err(blocked));
      }
      return request(
        'playback.candidates',
        { query: wireRecordingQuery(input.query), limit: input.limit },
        context,
        toTrackList,
      );
    },
    resolvePlayback(ref, input, context) {
      const blocked = guard('playback.resolve');
      if (blocked !== null) {
        return Promise.resolve(err(blocked));
      }
      return request(
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
      const blocked = guard('catalog.metadata');
      if (blocked !== null) {
        return Promise.resolve(err(blocked));
      }
      return request(
        'catalog.metadata',
        { refs: refs.map(wireSourceRef) },
        context,
        toTrackList,
      );
    },
    getEntity(ref, context) {
      const blocked = guard('catalog.entity');
      if (blocked !== null) {
        return Promise.resolve(err(blocked));
      }
      return request(
        'catalog.entity',
        { ref: wireSourceRef(ref) },
        context,
        toEntityPage,
      );
    },
    artwork(ref, input, context) {
      const blocked = guard('catalog.artwork');
      if (blocked !== null) {
        return Promise.resolve(err(blocked));
      }
      return request(
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
      const blocked = guard(capability);
      if (blocked !== null) {
        return Promise.resolve(err(blocked));
      }
      return request(
        capability,
        { query: wireLyricsQuery(input.query) },
        context,
        capability === 'lyrics.synced' ? toSyncedLyrics : toPlainLyrics,
      );
    },
    radioSeed(input, context) {
      const blocked = guard('radio.seed');
      if (blocked !== null) {
        return Promise.resolve(err(blocked));
      }
      return request(
        'radio.seed',
        'sourceRef' in input
          ? { source_ref: wireSourceRef(input.sourceRef) }
          : { continuation: input.continuation },
        context,
        toRadioPage,
      );
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      // In-flight callers resolve as cancelled; the host is told to
      // abort each request it still holds.
      for (const cancel of [...inFlight.values()]) {
        cancel();
      }
    },
  };
}
