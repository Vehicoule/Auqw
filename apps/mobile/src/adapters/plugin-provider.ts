import type {
  AppError,
  OperationContext,
  PlayableResource,
  ProviderPort,
  RecordingQuery,
  Result,
  SearchPage,
  SourceRef,
  TrackMetadata,
} from '@auqw/application';
import { appError, err, isTrackMetadata, ok } from '@auqw/application';
import type {
  AuqwExpoHostLike,
  AuqwExpoRequestOutcome,
} from './auqw-expo-surface.ts';
import { appErrorKind, nativeError } from './auqw-expo-surface.ts';

/**
 * ProviderPort over the auqw-expo generic-request surface. Each port
 * method builds the wire payload declared in
 * sdk/contract/capabilities.schema.json (snake_case, exact key sets —
 * guests reject unexpected keys), starts a host request, and settles
 * on the correlated `onRequestOutcome` event. The module is injected
 * as `AuqwExpoHostLike`; this file stays free of React Native / Expo
 * imports so the adapter is testable under plain Node.
 */

/** Cap on stashed outcomes that outraced startRequest's promise. */
const EARLY_OUTCOME_CAP = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

function isStorefront(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && /^[A-Z]{2}$/.test(value))
  );
}

function isSafeNonNegative(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}

function isOptInt(value: unknown, min: number): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= min)
  );
}

/** Wire `trackMetadata` (snake_case) → domain `TrackMetadata`. */
function toTrackMetadata(value: unknown): TrackMetadata | null {
  if (!isRecord(value)) {
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
  };
  return isTrackMetadata(candidate) ? candidate : null;
}

function toTrackList(value: unknown): readonly TrackMetadata[] | null {
  if (!isRecord(value) || !hasExactKeys(value, ['items'])) {
    return null;
  }
  const items = value['items'];
  if (!Array.isArray(items)) {
    return null;
  }
  const out: TrackMetadata[] = [];
  for (const item of items) {
    const track = toTrackMetadata(item);
    if (track === null) {
      return null;
    }
    out.push(track);
  }
  return out;
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
  const out: TrackMetadata[] = [];
  for (const item of items) {
    const track = toTrackMetadata(item);
    if (track === null) {
      return null;
    }
    out.push(track);
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
    !isOptInt(bitrateKbps, 0) ||
    !isOptInt(expiresAtMs, 0) ||
    !isOptInt(contentLength, 1) ||
    !isOptInt(itag, 0)
  ) {
    return null;
  }
  return { url, mime, bitrateKbps, expiresAtMs, contentLength, client, itag };
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

function wireSourceRef(ref: SourceRef): Record<string, unknown> {
  return { provider: ref.provider, kind: ref.kind, id: ref.id };
}

function cancelledError(): AppError {
  return appError('cancelled', 'cancelled');
}

function invalidResult(): AppError {
  return appError('invalid-response', 'plugin result failed validation');
}

type Pending = {
  unsubscribe: () => void;
  settle: (outcome: AuqwExpoRequestOutcome) => void;
  cancel: () => void;
};

export type PluginProvider = ProviderPort & { dispose(): void };

export function createPluginProvider(
  host: AuqwExpoHostLike,
  pluginId: string,
  providerId: string,
): PluginProvider {
  const pending = new Map<string, Pending>();
  /** Outcomes that arrived before their pending entry existed. */
  const early = new Map<string, AuqwExpoRequestOutcome>();
  let disposed = false;

  const subscription = host.addRequestOutcomeListener((event) => {
    if (!isRecord(event) || typeof event.requestId !== 'string') {
      return;
    }
    const entry = pending.get(event.requestId);
    if (entry !== undefined) {
      entry.settle(event.outcome);
      return;
    }
    // The outcome can outrace startRequest's promise: stash it briefly
    // for the pending entry to drain on registration.
    if (early.size >= EARLY_OUTCOME_CAP) {
      const oldest = early.keys().next();
      if (!oldest.done) {
        early.delete(oldest.value);
      }
    }
    early.set(event.requestId, event.outcome);
  });

  function dropRequest(requestId: string, entry: Pending): void {
    entry.unsubscribe();
    pending.delete(requestId);
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
    return (async () => {
      let requestId: string;
      try {
        requestId = await host.startRequest(pluginId, capability, payload);
      } catch (thrown) {
        return err(nativeError(thrown));
      }
      if (typeof requestId !== 'string' || requestId.length === 0) {
        return err(appError('invalid-response', 'empty request id'));
      }
      if (disposed || signal.cancelled) {
        host.cancel(requestId);
        return err(
          disposed
            ? appError('unavailable', 'provider is disposed')
            : cancelledError(),
        );
      }
      return new Promise<Result<T>>((resolve) => {
        let unsubscribe = (): void => { };
        const finish = (result: Result<T>): void => {
          const entry = pending.get(requestId);
          if (entry === undefined) {
            return;
          }
          dropRequest(requestId, entry);
          resolve(result);
        };
        const settle = (outcome: AuqwExpoRequestOutcome): void => {
          if (outcome.type === 'failed') {
            finish(
              err(
                appError(
                  appErrorKind(outcome.kind),
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
            parsed = JSON.parse(outcome.resultJson);
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
          const current = pending.get(requestId);
          if (current === undefined) {
            return;
          }
          dropRequest(requestId, current);
          // The request is dead to us either way; the host aborts it
          // and any late outcome is dropped.
          host.cancel(requestId);
          resolve(err(cancelledError()));
        };
        const entry: Pending = {
          unsubscribe: () => unsubscribe(),
          settle,
          cancel: cancelInFlight,
        };
        pending.set(requestId, entry);
        unsubscribe = signal.subscribe(cancelInFlight);
        const stashed = early.get(requestId);
        if (stashed !== undefined) {
          early.delete(requestId);
          settle(stashed);
        }
      });
    })();
  }

  return {
    id: providerId,
    search(input, context) {
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
      return request(
        'playback.candidates',
        { query: wireRecordingQuery(input.query), limit: input.limit },
        context,
        toTrackList,
      );
    },
    resolvePlayback(ref, input, context) {
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
      return request(
        'catalog.metadata',
        { refs: refs.map(wireSourceRef) },
        context,
        toTrackList,
      );
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      subscription.remove();
      // In-flight callers resolve as cancelled; the host is told to
      // abort each request it still holds.
      for (const entry of [...pending.values()]) {
        entry.cancel();
      }
      early.clear();
    },
  };
}
