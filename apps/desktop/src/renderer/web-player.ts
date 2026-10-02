import type {
  AppError,
  AttemptTrace,
  PlaybackIdentity,
  PlayerEvent,
  PlayerPort,
  PreparedStream,
  QueueProjection,
  QueueProjectionItem,
  QueueTransitionReason,
  Result,
} from '@auqw/application';
import { appError, appErrorKind, err, ok } from '@auqw/application';
import type {
  AttemptSummaryPayload,
  AuqwApi,
  PrepareOutcomePayload,
  PreparedStreamPayload,
  StreamMarksResult,
} from '../shared/contract.ts';
import { mimeForPath } from '../shared/audio-mime.ts';
import { rawToAppError } from './ipc-errors.ts';
import {
  attachMseSource,
  MseAborted,
  PumpFailure,
  type MseFactories,
  type MseSource,
} from './mse-source.ts';

/** The preload `stream` section as injected — never reaches for
 * `window` itself, so the port is testable under plain node. */
export type StreamClient = AuqwApi['stream'];

/** The DOM Audio element surface the port drives — declared minimally
 * so tests inject a fake without a DOM. */
export type AudioLike = {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/** Details on a transport action — `seekto` carries `seekTime`,
 * `seekbackward`/`seekforward` carry `seekOffset` (seconds, may be
 * absent; the OS default is 10). */
export type MediaActionDetails = {
  seekTime?: number;
  seekOffset?: number;
};

/** The `MediaMetadata` init bag — the DOM ctor is injected as a
 * factory so the port stays testable under plain node. */
export type MediaMetadataInit = {
  title: string;
  artist?: string;
  album?: string;
  artwork?: Array<{ src: string; sizes?: string; type?: string }>;
};

/** `navigator.mediaSession` — transport actions plus the OS
 * now-playing surface (macOS Now Playing, Windows SMTC, Linux MPRIS —
 * Chromium feeds all three from this one API). */
export type MediaSessionLike = {
  playbackState: string;
  /** The `MediaMetadata` instance the factory minted, or null. */
  metadata: unknown;
  setActionHandler(
    action:
      | 'play'
      | 'pause'
      | 'nexttrack'
      | 'previoustrack'
      | 'seekto'
      | 'seekbackward'
      | 'seekforward'
      | 'stop',
    handler: ((details?: MediaActionDetails) => void) | null,
  ): void;
  /** Optional — older embeds may lack it; publishing is best-effort. */
  setPositionState?(state: {
    duration: number;
    playbackRate: number;
    position: number;
  }): void;
};

/** Dead-resource kinds — a failed op with one of these means the
 * registry dropped the session, which the session layer re-prepares. */
const DEAD_HANDLE_KINDS: ReadonlySet<ErrorKind> = new Set([
  'released',
  'evicted',
  'expired',
  'superseded',
  'not-found',
]);

type ErrorKind = AppError['kind'];
type StatusState = Extract<PlayerEvent, { type: 'status' }>['state'];
type Settled = { url: string; source: MseSource | null };
type AttachLeg = { url: string; settle: Promise<Settled>; abort(): void };

/** Pump codes whose retry belongs to the app's policy, not an in-band
 * reattach — a loopback GET would burn the same latched verdict and
 * launder the kind (and its retryAfter) through the element. */
const POLICY_RETRY_CODES = new Set(['rate-limit', 'streams-capped']);

const toError = (thrown: unknown): AppError =>
  rawToAppError(thrown, 'stream call failed');

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (thrown) {
    return err(toError(thrown));
  }
}

function identityEq(a: PlaybackIdentity, b: PlaybackIdentity): boolean {
  return a.attemptId === b.attemptId && a.queueRev === b.queueRev;
}

/** First `skipsForward`-unmarked item after `walkPos` in the dealt
 * order — the step-over rule every forward move shares. */
function unflaggedAfter(
  p: QueueProjection,
  order: readonly number[],
  walkPos: number,
): QueueProjectionItem | undefined {
  for (let i = walkPos + 1; i < order.length; i += 1) {
    const item = p.items[order[i] ?? -1];
    if (item !== undefined && item.skipsForward !== true) {
      return item;
    }
  }
  return undefined;
}

function toPreparedStream(p: PreparedStreamPayload): PreparedStream {
  return {
    handle: p.handle,
    mime: p.mime,
    ...(p.itag === undefined ? {} : { itag: p.itag }),
    ...(p.contentLength === undefined
      ? {}
      : { contentLength: p.contentLength }),
    ...(p.expiresAtMs === undefined ? {} : { expiresAtMs: p.expiresAtMs }),
    ...(p.bitrateKbps === undefined ? {} : { bitrateKbps: p.bitrateKbps }),
  };
}

/** Diagnostics degrade to a zeroed trace rather than corrupting the
 * pipeline; the payload shape is already the trace shape. */
function toAttemptTrace(
  payload: AttemptSummaryPayload | undefined,
  requestId: string,
): AttemptTrace {
  return (
    payload ?? {
      requestId,
      steps: 0,
      httpCalls: 0,
      bytes: 0,
      fuelUsed: 0,
      elapsedMs: 0,
      httpTrace: [],
      guestLog: [],
    }
  );
}

/** The port's full surface — `noteMime` feeds the MSE gate mimes the
 * page learned outside `prepare` (the dev-gate's `stream.devPrepare`). */
export type WebPlayerPort = PlayerPort & {
  noteMime(handle: string, mime: string): void;
  /** `lf-*` handle → its resolved `file://` URI, else null — the
   * peaks port reads local bytes through `local:read` with this. */
  localUriFor(handle: string): string | null;
};

/**
 * `PlayerPort` over HTML audio + Media Session, fed by the stream
 * seam's loopback leg (`streamServeUrl`) through the utility host.
 * Status/phase events are synthesized from element events + the
 * session's phase marks; the queue projection cursor moves per the
 * contract — `ended`/`remote-next` reach the immediate successor,
 * `remote-previous` restarts or steps back — and lands as
 * `queue-transition` events for the session to reconcile.
 */
export function createWebPlayerPort(deps: {
  stream: StreamClient;
  audio: AudioLike;
  mediaSession?: MediaSessionLike | null;
  /** `MediaMetadata` ctor as a factory — the projection row's
   * title/artist/artwork lands on the OS surface through it. */
  mediaMetadata?: ((init: MediaMetadataInit) => unknown) | null;
  now?: () => number;
  /** MSE factories — present under Electron; absent in tests/node,
   * where the serve-url path is the only leg. */
  mse?: MseFactories | null;
  /** MIME for extensionless managed-download `file://` URIs — the
   * ledger records the stream's mime at finalize. */
  localMime?: ((uri: string) => string | null) | null;
  /** `local:resolve` — the utility's realpath + grant-confinement gate
   * on a `file://` URI; a null answer fails the prepare 'unavailable'
   * so a lexical URI can't attach bytes outside the granted set. */
  localResolve?: ((uri: string) => Promise<string | null>) | null;
}): WebPlayerPort {
  const { stream, audio } = deps;
  const now = deps.now ?? Date.now;
  const mediaSession = deps.mediaSession ?? null;
  const mediaMetadata = deps.mediaMetadata ?? null;
  const localResolve = deps.localResolve ?? null;
  const listeners = new Set<(event: PlayerEvent) => void>();
  let current: {
    handle: string;
    identity: PlaybackIdentity;
    occurrenceId: string | null;
  } | null = null;
  /** `handle` → container mime — `play()` args carry no mime, so the
   * MSE gate reads it here. */
  const handleMimes = new Map<string, string>();
  /** `provider:'local'` mints `lf-*` handles keyed to their `file://`
   * URI — the stream seam never sees them (the mobile adapter's
   * `lf-*` convention — the ref id IS the URI). */
  const localHandles = new Map<string, string>();
  /** requestId → minted handle for `lf-req-*` prepares — lets
   * `cancelPrepare` reclaim an adopted-but-unattached handle. */
  const localPrepares = new Map<string, string>();
  /** `lf-req-*` ids whose `local:resolve` is still in flight — the
   * requestId is live before the mint so `cancelPrepare` can stop a
   * pending resolve from minting at all. */
  const pendingLocalResolve = new Set<string>();
  let localSeq = 0;
  /** The live MSE attach, keyed by the handle it serves. */
  let activeMse: { handle: string; source: MseSource } | null = null;
  /** In-flight attachUrl aborts keyed by op generation — between
   * `attachUrl` and its `settle` there is no `activeMse` for dropMse
   * to kill, so a superseding op must abort the pending attach
   * directly or its pump lease outlives the op. */
  const pendingAttaches = new Map<number, { handle: string; abort: () => void }>();
  let projection: QueueProjection | null = null;
  let mediaActionsInstalled = false;
  let seq = 0;
  /** Monotonic op generation — a superseded async completion (play,
   * cursor attach) must never touch `current` or the element. */
  let opGen = 0;
  /** In-flight `play` ops keyed by handle — the newest writer wins.
   * A `release` of a tracked handle or a matching `pause` bumps opGen
   * so the late serveUrl can't start a dropped stream or resume audio
   * past the pause; `positionMs` tracks the newest seek so one issued
   * mid-resolve isn't overwritten by the play's start position. */
  const pendingPlayGens = new Map<
    string,
    {
      gen: number;
      identity: PlaybackIdentity;
      positionMs: number;
      occurrenceId: string | null;
    }
  >();

  function abortPendingAttaches(handle?: string): void {
    for (const [gen, pending] of [...pendingAttaches]) {
      if (handle === undefined || pending.handle === handle) {
        pendingAttaches.delete(gen);
        pending.abort();
      }
    }
  }

  /** Mint an `lf-*` handle for a `file://` URI. The mime derives from
   * the extension table, then the ledger mime for `dl-*` names;
   * 'audio/*' reports "container unknown — the element sniffs". */
  function mintLocalHandle(
    sourceRef: string,
  ): Result<{ handle: string; mime: string }> {
    // A renderer URI is lexical — the bound matches `local:resolve`.
    if (!sourceRef.startsWith('file://') || sourceRef.length > 8192) {
      return err(appError('invalid-response', 'bad local sourceRef'));
    }
    const handle = `lf-${++localSeq}`;
    localHandles.set(handle, sourceRef);
    const mime =
      mimeForPath(sourceRef) ?? deps.localMime?.(sourceRef) ?? 'audio/*';
    noteMime(handle, mime);
    return ok({ handle, mime });
  }

  /** Drop the `lf-req-*` → handle entry an adopted local prepare left. */
  function reapLocalPrepare(handle: string): void {
    for (const [requestId, minted] of localPrepares) {
      if (minted === handle) {
        localPrepares.delete(requestId);
        break;
      }
    }
  }

  /** Reap a handle an attach leg minted but must not keep — `lf-*`
   * drops locally, anything else rides the seam's release. */
  function releaseMinted(handle: string): void {
    if (localHandles.delete(handle)) {
      handleMimes.delete(handle);
      reapLocalPrepare(handle);
      return;
    }
    void stream.release({ handle }).catch(() => undefined);
  }

  /** Drop a pending-play marker; the global bump only fires while the
   * dropped play is still the newest op — a younger op already holding
   * `opGen` must not be killed by a route it never registered. */
  function dropPendingPlay(handle: string): void {
    const pending = pendingPlayGens.get(handle);
    if (pending === undefined) {
      return;
    }
    pendingPlayGens.delete(handle);
    if (pending.gen === opGen) {
      opGen++;
    }
  }

  /** Drop every local route aimed at handles an outcome reports as
   * superseded/pruned — dead registry-side. `current` is left alone:
   * only the op installing its replacement supersedes it, and
   * stale-identity reporting needs the entry. */
  function dropSuperseded(handles: readonly string[] | undefined): void {
    if (handles === undefined) {
      return;
    }
    for (const handle of handles) {
      handleMimes.delete(handle);
      abortPendingAttaches(handle);
      dropMse(handle);
      dropPendingPlay(handle);
    }
  }

  function installMse(handle: string, source: MseSource | null): void {
    activeMse = source === null ? null : { handle, source };
    // Post-attach pump/SourceBuffer death never fires the element's
    // error event (a revoked blob URL doesn't detach it) — report it
    // here the same way the audio error path does.
    source?.onFail((error) => {
      if (activeMse === null || activeMse.source !== source) {
        return;
      }
      dropMse();
      // Transport codes stay transient weather; a taxonomy slug from
      // a re-mint rides verbatim — a provider wall laundered to
      // 'transient' would retry the same refusal and toast the
      // generic interruption copy instead of the wall's.
      const kind =
        error instanceof PumpFailure &&
        error.code !== 'io-error' &&
        error.code !== 'closed'
          ? appErrorKind(error.code)
          : 'transient';
      status('failed', appError(kind, error.message));
    });
  }

  function dropMse(handle?: string): void {
    if (
      activeMse !== null &&
      (handle === undefined || activeMse.handle === handle)
    ) {
      const { source } = activeMse;
      activeMse = null;
      source.destroy();
    }
  }

  /** A killed op's attach must not settle into the element — abort the
   * pump lease and destroy whatever source the late settle produced. */
  function dropAttach(gen: number, first: AttachLeg): void {
    pendingAttaches.delete(gen);
    first.abort();
    void first.settle
      .then((s) => s.source?.destroy())
      .catch(() => undefined);
  }

  /** The attach's own teardown rejects `settle` with MseAborted — a
   * killed op finishes quietly instead of surfacing a failure. */
  function settleOrNull(settle: Promise<Settled>): Promise<Settled | null> {
    return settle.catch((thrown) => {
      if (thrown instanceof MseAborted) {
        return null;
      }
      throw thrown;
    });
  }

  /**
   * MSE-first attach: a known MSE-decodable mime feeds a SourceBuffer;
   * anything it refuses — non-fragmented mp4 above all — takes the
   * `streamServeUrl` loopback instead. `url` must land on the element
   * for `sourceopen` to fire at all; `settle` then resolves the
   * committed outcome (the MSE source once a segment lands, or the
   * serve-url leg when the attach refuses mid-stream).
   */
  async function attachUrl(
    handle: string,
    mimeHint?: string,
  ): Promise<AttachLeg> {
    const localUri = localHandles.get(handle);
    if (localUri !== undefined) {
      // The element reads `file://` itself — no pump to lease, no
      // settle stage, nothing to abort.
      return {
        url: localUri,
        settle: Promise.resolve({ url: localUri, source: null }),
        abort: () => undefined,
      };
    }
    const mime = mimeHint ?? handleMimes.get(handle);
    if (
      deps.mse != null &&
      mime !== undefined &&
      (deps.mse.isTypeSupported === undefined ||
        deps.mse.isTypeSupported(mime))
    ) {
      try {
        const attach = await attachMseSource({
          handle,
          mime,
          channel: (args) => stream.channel(args),
          mse: deps.mse,
        });
        const settle = attach.ready.then(
          (source) => ({ url: attach.url, source }),
          // An aborted attach is a killed op, not a refusal — the
          // serve-url leg would mint a stream for a dead playback.
          async (thrown): Promise<Settled> => {
            if (thrown instanceof MseAborted) {
              throw thrown;
            }
            // A terminal pump verdict isn't an MSE refusal — the
            // loopback would re-serve the same dead stream and
            // launder the kind to transient through the element.
            // Weather codes keep the fallback: a fresh attach on
            // the live session clears its latched read failure.
            if (
              thrown instanceof PumpFailure &&
              thrown.code !== 'io-error' &&
              thrown.code !== 'closed'
            ) {
              const mapped = appError(
                appErrorKind(thrown.code),
                thrown.message,
              );
              if (
                !mapped.retryable ||
                POLICY_RETRY_CODES.has(thrown.code)
              ) {
                throw mapped;
              }
            }
            const served = await stream.serveUrl({ handle });
            return { url: served.url, source: null };
          },
        );
        return { url: attach.url, settle, abort: attach.abort };
      } catch {
        // Pre-wire MSE refusal — the loopback leg serves the element.
      }
    }
    const { url } = await stream.serveUrl({ handle });
    return {
      url,
      settle: Promise.resolve({ url, source: null }),
      abort: () => undefined,
    };
  }

  /** A mime learned outside `prepare` — the dev-gate reports the
   * payload's mime for the MSE gate to read. */
  function noteMime(handle: string, mime: string): void {
    if (handle.length <= 512 && mime.length <= 128) {
      handleMimes.set(handle, mime);
    }
  }

  /** Drop pending plays — `identity` matches the same contract `stale`
   * applies to a live attempt; `null` drops all (a transport-wide
   * media-key pause has no attempt identity). */
  function invalidatePendingPlays(identity: PlaybackIdentity | null): void {
    for (const [handle, pending] of [...pendingPlayGens]) {
      if (identity === null || identityEq(identity, pending.identity)) {
        abortPendingAttaches(handle);
        dropPendingPlay(handle);
      }
    }
  }

  const posMs = (): number =>
    Math.max(0, Math.round(audio.currentTime * 1000));
  const durMs = (): number | undefined =>
    Number.isFinite(audio.duration)
      ? Math.round(audio.duration * 1000)
      : undefined;

  /** The projection row `current` names — the only honest source for
   * the OS surface; a missing row clears rather than guesses. */
  function projectedItem(
    occurrenceId: string | null,
  ): QueueProjectionItem | null {
    if (occurrenceId === null) {
      return null;
    }
    return (
      projection?.items.find(
        (item) => item.occurrenceId === occurrenceId,
      ) ?? null
    );
  }

  /** Now-playing title/artist/art — published when `current` changes
   * and when the projection it reads is swapped (corrections,
   * re-queues). A different current occurrence is left for the
   * successor's own attach to publish — eagerly naming it would
   * mislabel the track still playing. */
  function publishMetadata(): void {
    if (mediaSession === null || mediaMetadata === null) {
      return;
    }
    const item = projectedItem(current?.occurrenceId ?? null);
    if (item === null) {
      mediaSession.metadata = null;
      return;
    }
    const artwork = osArtwork(item);
    mediaSession.metadata = mediaMetadata({
      title: item.title,
      ...(item.artist === null ? {} : { artist: item.artist }),
      ...(item.album ? { album: item.album } : {}),
      ...(artwork.length === 0 ? {} : { artwork }),
    });
  }

  /** The artwork candidates the OS may pick from — the projection's
   * full list when it carries one, else the single `artworkUrl`
   * pick. `sizes` is emitted only when both dims are known. */
  function osArtwork(
    item: QueueProjectionItem,
  ): Array<{ src: string; sizes?: string }> {
    const list =
      item.artwork ??
      (item.artworkUrl === null
        ? []
        : [{ url: item.artworkUrl, width: null, height: null }]);
    return list.map((a) => ({
      src: a.url,
      ...(a.width !== null && a.height !== null
        ? { sizes: `${a.width}x${a.height}` }
        : {}),
    }));
  }

  /** Position mirror — the OS interpolates between pushes via
   * playbackRate, so publishing on element state changes is enough;
   * `status()` runs on every relevant event. A finite duration is
   * required for a meaningful state — before `loadedmetadata` there
   * is nothing to report. The rate must be nonzero (a 0 update is
   * rejected): paused rides `playbackState`, not this field. */
  function publishPosition(): void {
    const duration = durMs();
    if (
      mediaSession?.setPositionState === undefined ||
      duration === undefined ||
      duration <= 0
    ) {
      return;
    }
    mediaSession.setPositionState({
      duration: duration / 1000,
      playbackRate: 1,
      position: Math.min(posMs(), duration) / 1000,
    });
  }

  /** Playback torn down — the OS card goes blank rather than freeze
   * on the last track's info. */
  function clearOsSurface(): void {
    if (mediaSession === null) {
      return;
    }
    mediaSession.playbackState = 'none';
    mediaSession.metadata = null;
  }

  function emit(event: PlayerEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A throwing subscriber must not break event fan-out.
      }
    }
  }

  function status(state: StatusState, error?: AppError): void {
    if (current === null) {
      return;
    }
    const duration = durMs();
    emit({
      type: 'status',
      handle: current.handle,
      identity: current.identity,
      state,
      positionMs: posMs(),
      ...(duration === undefined ? {} : { durationMs: duration }),
      ...(error === undefined ? {} : { error }),
    });
    publishPosition();
    refreshTransportButtons();
  }

  function emitTransition(
    p: QueueProjection,
    toOccurrenceId: string | null,
    reason: QueueTransitionReason,
    positionMs: number,
    identity: PlaybackIdentity | null,
    handle: string | null,
  ): void {
    projection = { ...p, currentOccurrenceId: toOccurrenceId };
    refreshTransportButtons();
    emit({
      type: 'queue-transition',
      projectionId: p.projectionId,
      projectedQueueRev: p.queueRev,
      fromOccurrenceId: p.currentOccurrenceId,
      toOccurrenceId,
      reason,
      positionMs,
      identity,
      handle,
    });
  }

  /**
   * Freshly resolve+attach a projected item — the contract's service
   * cursor move. The session adopts the emitted identity/handle as the
   * live attempt, so the stream must already be attached to the element
   * before the transition event lands. A failed attach surfaces as a
   * `failed` status instead of an illegal transition.
   */
  async function attachItem(
    p: QueueProjection,
    item: QueueProjectionItem,
    reason: QueueTransitionReason,
  ): Promise<void> {
    if (item.provider === null || item.sourceRef === null) {
      status(
        'failed',
        appError('unavailable', 'projected item is not attachable'),
      );
      return;
    }
    const requestId = `watt-${++seq}`;
    const gen = ++opGen;
    // A new remote transition supersedes every older op — kill their
    // pump leases now rather than at settle.
    abortPendingAttaches();
    let handle: string | undefined;
    // Once this op owns `current`, liveness is the handle match —
    // emitTransition already swapped the projection reference, so
    // `projection === p` can no longer prove liveness.
    let attached = false;
    try {
      let mime: string;
      if (item.provider === 'local') {
        // Same realpath confinement as prepare: a lexical URI could
        // resolve to an escaped path post-scan. A REJECTED resolve
        // propagates to the outer catch (the retryable toError path),
        // not the 'unavailable' a null means.
        const resolved =
          localResolve === null
            ? item.sourceRef
            : await localResolve(item.sourceRef);
        if (resolved === null) {
          if (gen === opGen && projection === p) {
            status(
              'failed',
              appError('unavailable', 'local file not readable'),
            );
          }
          return;
        }
        const minted = mintLocalHandle(resolved);
        if (!minted.ok) {
          if (gen === opGen && projection === p) {
            status('failed', minted.error);
          }
          return;
        }
        handle = minted.value.handle;
        mime = minted.value.mime;
      } else {
        const outcome = await stream.prepare({
          pluginId: item.provider,
          sourceRef: item.sourceRef,
          requestId,
        });
        if (outcome.type !== 'prepared' || outcome.stream === undefined) {
          // A stale op's failure is not the live attempt's — suppress
          // it rather than label the stream the session moved to.
          if (gen === opGen && projection === p) {
            status(
              'failed',
              appError(
                appErrorKind(outcome.kind),
                outcome.message ?? 'successor prepare failed',
              ),
            );
          }
          return;
        }
        handle = outcome.stream.handle;
        mime = outcome.stream.mime;
        dropSuperseded(outcome.superseded);
        noteMime(handle, mime);
      }
      const first = await attachUrl(handle, mime);
      pendingAttaches.set(gen, { handle, abort: first.abort });
      // Superseded while the attach resolved — release the minted
      // handle and stay out of the element.
      if (gen !== opGen || projection !== p) {
        dropAttach(gen, first);
        releaseMinted(handle);
        return;
      }
      // The successor's pump must close before this source installs —
      // two live pumps on one element attach is the leak dropMse
      // previously missed outside play().
      dropMse();
      const identity: PlaybackIdentity = {
        attemptId: `watt-id-${seq}`,
        queueRev: p.queueRev,
      };
      current = { handle, identity, occurrenceId: item.occurrenceId };
      attached = true;
      publishMetadata();
      audio.src = first.url;
      audio.currentTime = 0;
      emitTransition(p, item.occurrenceId, reason, 0, identity, handle);
      emitMarks(handle, identity);
      const settled = await settleOrNull(first.settle);
      if (settled === null) {
        // Aborted — this op is dead and its minted-but-never-installed
        // handle is ours to reap, or repeated supersessions leak
        // registry slots.
        pendingAttaches.delete(gen);
        if (current !== null && current.handle === handle) {
          current = null;
        }
        releaseMinted(handle);
        return;
      }
      if (
        gen !== opGen ||
        current === null ||
        current.handle !== handle
      ) {
        pendingAttaches.delete(gen);
        settled.source?.destroy();
        releaseMinted(handle);
        return;
      }
      pendingAttaches.delete(gen);
      installMse(handle, settled.source);
      // A mid-stream MSE refusal swaps the element onto the loopback.
      if (settled.url !== first.url) {
        audio.src = settled.url;
        audio.currentTime = 0;
      }
      const shouldPlay = reason === 'ended' || p.mode === 'playing';
      if (shouldPlay) {
        await audio.play();
      }
      if (mediaSession !== null) {
        mediaSession.playbackState = shouldPlay ? 'playing' : 'paused';
      }
    } catch (thrown) {
      // A failed op's pending attach can't outlive it — a settle that
      // never resolved would leave its pump lease running.
      pendingAttaches.get(gen)?.abort();
      pendingAttaches.delete(gen);
      const stillMine =
        gen === opGen &&
        (attached
          ? current !== null && current.handle === handle
          : projection === p);
      // A minted-but-never-attached handle is ours to reap. For a
      // local mint whose `current` was set, reaping alone would leave
      // a live `lf-*` pointer and a later element error would probe
      // the dead handle on the seam — report 'unavailable' FIRST
      // (status() needs `current` to name the failing handle), then
      // tear the element down. 'unavailable' over the retryable
      // 'internal' a DOM rejection reads as: the file exists but
      // can't play.
      const failedLocal =
        handle !== undefined && localHandles.has(handle);
      if (stillMine) {
        status(
          'failed',
          failedLocal
            ? appError('unavailable', 'local file not playable')
            : toError(thrown),
        );
      }
      if (handle !== undefined) {
        releaseMinted(handle);
        if (
          failedLocal &&
          current !== null &&
          current.handle === handle
        ) {
          audio.src = '';
          current = null;
        }
      }
    }
  }

  function advanceQueue(reason: QueueTransitionReason): void {
    const p = projection;
    if (p === null) {
      return;
    }
    const idx = p.items.findIndex(
      (item) => item.occurrenceId === p.currentOccurrenceId,
    );
    if (idx < 0) {
      return;
    }
    // The cursor walks `order` positions — the dealt play order under
    // shuffle, failed rows still in it flagged `skipsForward`; an
    // absent list reads as canonical identity.
    const order = p.order.length === 0 ? p.items.map((_, i) => i) : p.order;
    const pos = order.indexOf(idx);
    if (pos < 0) {
      return;
    }
    const restartInPlace = (): boolean => {
      // Same-item cursor move: the live attach replays — the emitted
      // transition carries the attempt's own identity per the
      // remote-previous restart rule.
      const cur = current;
      if (cur === null) {
        return false;
      }
      emitTransition(
        p,
        p.currentOccurrenceId,
        reason,
        0,
        cur.identity,
        cur.handle,
      );
      // The track start may have been evicted — the source re-anchors
      // it, matching the seekTo path.
      activeMse?.source.seekTo(0);
      audio.currentTime = 0;
      if (reason === 'ended' || p.mode === 'playing') {
        void audio.play().catch(() => undefined);
      }
      return true;
    };
    if (reason === 'remote-previous') {
      // Past the restart threshold previous restarts the current item;
      // at the walk's head, repeat=all wraps to its tail instead.
      const wrapTo =
        pos === 0 && p.repeat === 'all' && order.length > 1
          ? p.items[order[order.length - 1] ?? -1]
          : undefined;
      if (posMs() > 3000 || (pos === 0 && wrapTo === undefined)) {
        if (restartInPlace()) {
          return;
        }
      } else {
        const item = wrapTo ?? p.items[order[pos - 1] ?? -1];
        if (item === undefined) {
          return;
        }
        void attachItem(p, item, reason);
      }
      return;
    }
    // repeat=one replays the cursor item on a natural end (manual
    // remote-next still advances); repeat=all wraps the walk to its
    // first unflagged entry. `skipsForward` rows are stepped over
    // exactly like the engine's next(); backward moves still reach
    // them.
    const successor =
      reason === 'ended' && p.repeat === 'one'
        ? p.items[idx]
        : (unflaggedAfter(p, order, pos) ??
          (p.repeat === 'all' && order.length > 0
            ? unflaggedAfter(p, order, -1)
            : undefined));
    if (successor === undefined) {
      const tailPositionMs = posMs();
      if (reason !== 'ended') {
        // A remote skip at the tail leaves the element live — detach
        // it so playback stops with the queue, not after it.
        opGen++;
        abortPendingAttaches();
        dropMse();
        current = null;
        audio.pause();
        audio.src = '';
        clearOsSurface();
      } else {
        // Natural end keeps the element loaded — 'paused' leaves the
        // OS transport replay-able until the session releases the
        // handle (which then clears the surface).
        if (mediaSession !== null) {
          mediaSession.playbackState = 'paused';
        }
      }
      // Tail of the queue — a null target means the cursor ran off.
      emitTransition(p, null, reason, tailPositionMs, null, null);
      return;
    }
    if (successor.occurrenceId === p.currentOccurrenceId) {
      restartInPlace();
      return;
    }
    void attachItem(p, successor, reason);
  }

  function emitMarks(
    handle: string,
    identity: PlaybackIdentity,
  ): void {
    if (localHandles.has(handle)) {
      // A local attach has no seam session to mark.
      return;
    }
    void stream
      .marks({ handle })
      .then((marks: StreamMarksResult) => {
        if (current === null || current.handle !== handle) {
          return;
        }
        // `resolveMs`/`mintMs` are durations; the later marks are
        // wall-clock epochs converted through `prepareStartedMs`.
        const started = marks.prepareStartedMs;
        const phases: ReadonlyArray<
          readonly [string, number | undefined, boolean]
        > = [
          ['resolve', marks.resolveMs, false],
          ['mint', marks.mintMs, false],
          ['first-byte', marks.firstByteMs, true],
          ['head-ready', marks.headReadyMs, true],
          ['attach', marks.attachMs, true],
        ];
        for (const [name, value, epoch] of phases) {
          if (value === undefined) {
            continue;
          }
          const sinceStartMs = epoch
            ? started === undefined
              ? undefined
              : Math.max(0, value - started)
            : value;
          if (sinceStartMs === undefined) {
            continue;
          }
          emit({
            type: 'phase',
            handle,
            identity,
            name,
            atMs: epoch ? value : now(),
            sinceStartMs,
          });
        }
      })
      .catch(() => undefined);
  }

  /** Chromium kills the OS media session the instant the element ends
   * — a parked tail's card would stay dead to OS play presses no
   * matter what gets published after (`playbackState`/metadata writes
   * and rewinds don't revive it). The port intercepts ~ε before the
   * real end instead: pause keeps the element short of `ended` (the
   * card stays live-paused) while the same 'ended' status +
   * transition feed the session. `timeupdate` arms a self-correcting
   * timer; a window missed to background timer slack degrades to the
   * real `ended` — the old surface kill, never a wrong state. */
  const END_INTERCEPT_WINDOW_MS = 1_500;
  const END_INTERCEPT_EPS_MS = 80;
  let endCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** The handle whose end the intercept already fed — a real `ended`
   * landing for it anyway must not emit a second end. */
  let endSynthesizedFor: string | null = null;

  function checkEndIntercept(): void {
    const owner = current;
    if (owner === null || audio.paused || audio.ended) {
      return;
    }
    const duration = durMs();
    if (duration === undefined) {
      return;
    }
    const remaining = duration - posMs();
    if (remaining > END_INTERCEPT_WINDOW_MS) {
      return;
    }
    if (remaining <= END_INTERCEPT_EPS_MS) {
      endSynthesizedFor = owner.handle;
      audio.pause();
      status('ended');
      advanceQueue('ended');
      return;
    }
    if (endCheckTimer === null) {
      // A timer landing early (background slack) re-checks and
      // tightens itself; the ≥60 ms floor keeps a stalled tail cheap.
      endCheckTimer = setTimeout(() => {
        endCheckTimer = null;
        checkEndIntercept();
      }, Math.max(60, remaining - END_INTERCEPT_EPS_MS));
    }
  }

  audio.addEventListener('playing', () => {
    endSynthesizedFor = null;
    status('playing');
  });
  audio.addEventListener('waiting', () => status('buffering'));
  audio.addEventListener('loadedmetadata', () => status('ready'));
  audio.addEventListener('pause', () => {
    if (audio.paused && !audio.ended) {
      status('paused');
    }
  });
  audio.addEventListener('seeked', () => {
    activeMse?.source.notePosition(posMs());
    status(audio.paused ? 'paused' : 'playing');
  });
  audio.addEventListener('timeupdate', () => {
    activeMse?.source.notePosition(posMs());
    if (!audio.paused) {
      status('playing');
    }
    checkEndIntercept();
  });
  audio.addEventListener('ended', () => {
    // An intercepted end already fed the session — its element event
    // is spent, and emitting again would double-advance the queue.
    if (current !== null && current.handle === endSynthesizedFor) {
      return;
    }
    status('ended');
    advanceQueue('ended');
  });
  // Duration can resolve late under MSE appends — the OS scrubber
  // needs the push even though no status event maps to it.
  audio.addEventListener('durationchange', () => publishPosition());
  audio.addEventListener('error', () => {
    const owner = current;
    if (owner === null) {
      status('failed', appError('transient', 'audio element failed'));
      return;
    }
    if (localHandles.has(owner.handle)) {
      // No stream to probe — the element IS the resource; report
      // non-retryable, never a dead-handle kind (that would loop
      // re-prepares over the same bad file).
      status(
        'failed',
        appError('unavailable', 'local file could not be played'),
      );
      return;
    }
    // A media error on a reaped loopback URL is the stream's death
    // arriving async (e.g. a paused seek past the registry TTL
    // refetches a dead URL) — probe the handle so the session sees
    // the dead-resource kind it re-prepares instead of a transient
    // failure that fails the occurrence. A resolved probe means the
    // stream lives (a real flake — stays 'transient'), and a non-dead
    // probe failure says nothing (stays 'transient' too).
    const gen = opGen;
    void stream.marks({ handle: owner.handle }).then(
      () => {
        if (current?.handle === owner.handle && gen === opGen) {
          status('failed', appError('transient', 'audio element failed'));
        }
      },
      (thrown) => {
        const probeError = toError(thrown);
        if (current?.handle === owner.handle && gen === opGen) {
          status(
            'failed',
            DEAD_HANDLE_KINDS.has(probeError.kind)
              ? probeError
              : appError('transient', 'audio element failed'),
          );
        }
      },
    );
  });

  function installMediaActions(): void {
    if (mediaSession === null || mediaActionsInstalled) {
      return;
    }
    mediaActionsInstalled = true;
    mediaSession.setActionHandler('play', () => {
      void audio
        .play()
        .then(() => {
          // 'playing' only once the element confirms — a rejected
          // play leaves the state alone, and a pause/stop landing
          // mid-flight wins (the element is paused and already
          // reported its newer state).
          if (!audio.paused) {
            mediaSession.playbackState = 'playing';
          }
        })
        .catch(() => undefined);
    });
    mediaSession.setActionHandler('pause', () => {
      // A media-key pause is transport-wide — each killed pending play
      // is reported paused with its own identity so the session
      // reconciles the attempt instead of stranding it in buffering.
      const killed = [...pendingPlayGens.entries()];
      invalidatePendingPlays(null);
      audio.pause();
      mediaSession.playbackState = 'paused';
      for (const [handle, pending] of killed) {
        emit({
          type: 'status',
          handle,
          identity: pending.identity,
          state: 'paused',
          positionMs: pending.positionMs,
        });
      }
    });
    // The OS scrubber and step seeks share the seekTo landing: a
    // mid-attach play owns the position through its pending slot.
    mediaSession.setActionHandler('seekto', (details) => {
      if (details?.seekTime === undefined) {
        return;
      }
      applyOsSeek(Math.max(0, Math.round(details.seekTime * 1000)));
    });
    mediaSession.setActionHandler('seekbackward', (details) => {
      applyOsSeek(
        Math.max(
          0,
          osSeekBaseMs() - Math.round((details?.seekOffset ?? 10) * 1000),
        ),
      );
    });
    mediaSession.setActionHandler('seekforward', (details) => {
      applyOsSeek(
        Math.min(
          durMs() ?? Number.MAX_SAFE_INTEGER,
          osSeekBaseMs() + Math.round((details?.seekOffset ?? 10) * 1000),
        ),
      );
    });
    mediaSession.setActionHandler('stop', () => {
      // Nothing attached — the stop still kills a mid-resolve play so
      // it can't start after the surface clears.
      if (current === null) {
        invalidatePendingPlays(null);
        audio.pause();
        return;
      }
      // No queue installed (dev harness): the session can't reconcile
      // a reported stop, so the teardown is local.
      if (projection === null) {
        hardStop();
        return;
      }
      // Kill the play machinery — a settling attach must not restart
      // the element — then report the stop for the session to
      // reconcile; its release of this handle runs the real teardown.
      opGen++;
      invalidatePendingPlays(null);
      audio.pause();
      mediaSession.playbackState = 'paused';
      emitTransition(projection, null, 'remote-stop', posMs(), null, null);
    });
    // next/previous grey at the walk's edges rather than no-op.
    refreshTransportButtons();
  }

  /** The position a step seek starts from — a mid-attach play's
   * pending resume target when one owns the element's future, else
   * the element's live position. A superseded play's slot can linger
   * until its promise settles — only the live generation counts. */
  function osSeekBaseMs(): number {
    for (const pending of pendingPlayGens.values()) {
      if (pending.gen !== opGen) {
        continue;
      }
      if (
        current === null ||
        identityEq(pending.identity, current.identity)
      ) {
        return pending.positionMs;
      }
    }
    return posMs();
  }

  /** The shared landing for every OS seek shape — a mid-attach play
   * owns the position through its pending slot instead. */
  function applyOsSeek(positionMs: number): void {
    for (const pending of pendingPlayGens.values()) {
      if (
        pending.gen === opGen &&
        (current === null ||
          identityEq(pending.identity, current.identity))
      ) {
        pending.positionMs = positionMs;
      }
    }
    audio.currentTime = positionMs / 1000;
    activeMse?.source.seekTo(positionMs);
  }

  /** The element teardown the port `stop` and the OS stop action
   * share. */
  function hardStop(): void {
    opGen++;
    abortPendingAttaches();
    dropMse();
    audio.pause();
    audio.src = '';
    clearOsSurface();
    status('idle');
    current = null;
  }

  /** Chromium greys an OS transport button whose handler is null —
   * mirror the walk's real edges instead of letting a press no-op or
   * detach through advanceQueue. Refreshed on every cursor move
   * (emitTransition), projection swap, and status tick — the >3 s
   * restart threshold turns 'previoustrack' back on mid-track. */
  function refreshTransportButtons(): void {
    if (mediaSession === null) {
      return;
    }
    let next = false;
    let prev = false;
    const p = projection;
    if (p !== null) {
      const idx = p.items.findIndex(
        (item) => item.occurrenceId === p.currentOccurrenceId,
      );
      if (idx >= 0) {
        const order =
          p.order.length === 0 ? p.items.map((_, i) => i) : p.order;
        const pos = order.indexOf(idx);
        if (pos >= 0) {
          next =
            unflaggedAfter(p, order, pos) !== undefined ||
            (p.repeat === 'all' &&
              unflaggedAfter(p, order, -1) !== undefined);
          // Mirror advanceQueue's remote-previous leg: mid-walk a
          // backward step always lands; at the head a repeat=all wrap
          // or a live element (restart in place) makes it real.
          prev =
            pos > 0 ||
            (pos === 0 && p.repeat === 'all' && order.length > 1) ||
            (pos === 0 && current !== null);
        }
      }
    }
    mediaSession.setActionHandler(
      'nexttrack',
      next ? () => advanceQueue('remote-next') : null,
    );
    mediaSession.setActionHandler(
      'previoustrack',
      prev ? () => advanceQueue('remote-previous') : null,
    );
  }

  function stale(identity: PlaybackIdentity): Result<never> | null {
    if (current !== null && !identityEq(identity, current.identity)) {
      return err(appError('invalid-message', 'stale playback identity'));
    }
    return null;
  }

  /**
   * The `provider:'local'` prepare leg — `lf-*` in the mobile
   * adapter's convention. The sourceRef already IS the `file://` URI,
   * but the mint runs on the utility's realpath-checked answer: a
   * renderer-side URI is lexical, and only the utility can confine it
   * to the granted roots (null → 'unavailable'; with no resolver the
   * lexical ref is trusted). The outcome emits on a microtask like the
   * stream leg's `.then` so the session's event ordering stays exact.
   */
  function issueLocalPrepare(
    input: { sourceRef: string; identity: PlaybackIdentity },
    requestId: string,
    emitFailed: (error: AppError) => void,
  ): void {
    pendingLocalResolve.add(requestId);
    const mint = (resolved: string | null): void => {
      if (!pendingLocalResolve.delete(requestId)) {
        // cancelPrepare arrived mid-resolve — the cancelled outcome
        // mirrors the microtask path below.
        emitFailed(appError('cancelled', 'local prepare cancelled'));
        return;
      }
      if (resolved === null) {
        emitFailed(appError('unavailable', 'local file not readable'));
        return;
      }
      const minted = mintLocalHandle(resolved);
      if (!minted.ok) {
        emitFailed(minted.error);
        return;
      }
      // The entry lands before the outcome so a `cancelPrepare` racing
      // the microtask finds and reclaims the minted handle.
      localPrepares.set(requestId, minted.value.handle);
      queueMicrotask(() => {
        if (!localPrepares.has(requestId)) {
          emitFailed(appError('cancelled', 'local prepare cancelled'));
          return;
        }
        emit({
          type: 'prepare',
          requestId,
          identity: input.identity,
          outcome: {
            type: 'prepared',
            stream: {
              handle: minted.value.handle,
              mime: minted.value.mime,
            },
            attempt: toAttemptTrace(undefined, requestId),
          },
        });
      });
    };
    if (localResolve === null) {
      queueMicrotask(() => mint(input.sourceRef));
      return;
    }
    // A REJECTED resolve is a bridge/utility failure — the retryable
    // toError path, not the terminal 'unavailable' a null means.
    localResolve(input.sourceRef).then(mint, (thrown) => {
      if (!pendingLocalResolve.delete(requestId)) {
        emitFailed(appError('cancelled', 'local prepare cancelled'));
        return;
      }
      emitFailed(toError(thrown));
    });
  }

  /** The shared stream-seam resolve+prepare leg behind `prepare` and
   * `prewarm` — they differ only in playback-intent side effects
   * (op generation, attach teardown), not this path. */
  function issueStreamPrepare(
    input: {
      provider: string;
      sourceRef: string;
      identity: PlaybackIdentity;
    },
    requestId: string,
  ): void {
    const emitFailed = (
      error: AppError,
      attempt?: AttemptSummaryPayload,
    ): void => {
      emit({
        type: 'prepare',
        requestId,
        identity: input.identity,
        outcome: {
          type: 'failed',
          error,
          attempt: toAttemptTrace(attempt, requestId),
        },
      });
    };
    if (input.provider === 'local') {
      issueLocalPrepare(input, requestId, emitFailed);
      return;
    }
    void stream
      .prepare({
        pluginId: input.provider,
        sourceRef: input.sourceRef,
        requestId,
      })
      .then((outcome: PrepareOutcomePayload) => {
        if (
          outcome.type !== 'prepared' ||
          outcome.stream === undefined
        ) {
          emitFailed(
            appError(
              appErrorKind(outcome.kind),
              outcome.message ?? 'prepare failed',
            ),
            outcome.attempt,
          );
          return;
        }
        const prepared = toPreparedStream(outcome.stream);
        dropSuperseded(outcome.superseded);
        noteMime(prepared.handle, prepared.mime);
        emit({
          type: 'prepare',
          requestId,
          identity: input.identity,
          outcome: {
            type: 'prepared',
            stream: prepared,
            attempt: toAttemptTrace(outcome.attempt, requestId),
          },
        });
      })
      .catch((thrown) => emitFailed(toError(thrown)));
  }

  const mintRequestId = (provider: string): string =>
    provider === 'local' ? `lf-req-${++localSeq}` : `wreq-${++seq}`;

  return {
    async prepare(input) {
      // The requestId returns up front — the terminal outcome arrives
      // as a `prepare` event, so a session-side deadline can reach
      // `cancelPrepare` while the utility is still resolving. The
      // opGen bump already kills in-flight ops' generations; kill
      // their in-flight attaches too, or a stalled stream keeps its
      // pump lease for a settle that will never be accepted.
      const requestId = mintRequestId(input.provider);
      opGen++;
      abortPendingAttaches();
      issueStreamPrepare(input, requestId);
      return ok(requestId);
    },

    /** Advisory warm: the same leg minus playback intent — no op-gen
     * bump and no attach teardown, so an in-flight attach or pending
     * play outlives the speculation. The outcome still arrives as a
     * `prepare` event. */
    async prewarm(input) {
      const requestId = mintRequestId(input.provider);
      issueStreamPrepare(input, requestId);
      return ok(requestId);
    },

    async play(input) {
      const gen = ++opGen;
      abortPendingAttaches();
      pendingPlayGens.set(input.handle, {
        gen,
        identity: { ...input.identity },
        positionMs: input.positionMs ?? 0,
        occurrenceId: projection?.currentOccurrenceId ?? null,
      });
      return guard(async () => {
        try {
          const first = await attachUrl(input.handle);
          pendingAttaches.set(gen, {
            handle: input.handle,
            abort: first.abort,
          });
          if (gen !== opGen) {
            dropAttach(gen, first);
            return;
          }
          // The surviving token is authoritative — a queue mutation
          // may have re-keyed its queueRev since this op was issued.
          const pending = pendingPlayGens.get(input.handle);
          const identity = pending?.identity ?? input.identity;
          dropMse();
          current = {
            handle: input.handle,
            identity,
            occurrenceId:
              pending?.occurrenceId ??
              projection?.currentOccurrenceId ??
              null,
          };
          publishMetadata();
          audio.src = first.url;
          audio.currentTime =
            (pending?.positionMs ?? input.positionMs ?? 0) / 1000;
          status('buffering');
          emitMarks(input.handle, identity);
          const settled = await settleOrNull(first.settle);
          if (settled === null) {
            return;
          }
          if (gen !== opGen) {
            pendingAttaches.delete(gen);
            settled.source?.destroy();
            return;
          }
          pendingAttaches.delete(gen);
          installMse(input.handle, settled.source);
          // Read live: a seek during the settle await updates `pending`
          // (the pending slot, not the element, holds it mid-flight).
          const startMs = pending?.positionMs ?? input.positionMs ?? 0;
          if (settled.url !== first.url) {
            audio.src = settled.url;
            audio.currentTime = startMs / 1000;
          }
          // The pump always opens at byte 0 — a resume position (or a
          // mid-flight seek) must re-anchor the source.
          if (startMs > 0) {
            settled.source?.seekTo(startMs);
          }
          await audio.play();
          if (mediaSession !== null) {
            mediaSession.playbackState = 'playing';
          }
        } finally {
          // An attach still pending on exit must not keep its pump
          // lease running past the dead op.
          const attach = pendingAttaches.get(gen);
          if (attach !== undefined) {
            pendingAttaches.delete(gen);
            attach.abort();
          }
          // Only this op's own token is removed — a superseded play
          // must not clear the marker of the play that replaced it.
          if (pendingPlayGens.get(input.handle)?.gen === gen) {
            pendingPlayGens.delete(input.handle);
          }
        }
      });
    },

    async pause(identity) {
      const bad = stale(identity);
      if (bad !== null) {
        return bad;
      }
      // A play still awaiting its serve URL hasn't attached `current`
      // — without invalidating it, the late completion would start
      // audio after this pause succeeded.
      invalidatePendingPlays(identity);
      audio.pause();
      if (mediaSession !== null) {
        mediaSession.playbackState = 'paused';
      }
      return ok(undefined);
    },

    async seekTo(input) {
      const bad = stale(input.identity);
      if (bad !== null) {
        return bad;
      }
      // Keep a pending play's position in step so a seek issued during
      // the resolve isn't overwritten when it lands.
      for (const pending of pendingPlayGens.values()) {
        if (identityEq(input.identity, pending.identity)) {
          pending.positionMs = input.positionMs;
        }
      }
      audio.currentTime = input.positionMs / 1000;
      // An uncovered position re-anchors the pump through the
      // journal/Cues index; a covered one plays from buffer.
      activeMse?.source.seekTo(input.positionMs);
      return ok(undefined);
    },

    async stop(identity) {
      const bad = stale(identity);
      if (bad !== null) {
        return bad;
      }
      hardStop();
      return ok(undefined);
    },

    async cancelPrepare(input) {
      // `lf-req-*` ids never reached the seam — the cancel reclaims
      // the minted handle locally.
      if (input.requestId.startsWith('lf-req-')) {
        pendingLocalResolve.delete(input.requestId);
        const handle = localPrepares.get(input.requestId);
        localPrepares.delete(input.requestId);
        if (handle !== undefined) {
          localHandles.delete(handle);
          handleMimes.delete(handle);
        }
        return ok(undefined);
      }
      return guard(() => stream.cancel({ requestId: input.requestId }));
    },

    noteMime,

    localUriFor: (handle) => localHandles.get(handle) ?? null,

    async release(input) {
      if (current !== null && current.handle === input.handle) {
        audio.pause();
        audio.src = '';
        current = null;
        clearOsSurface();
      }
      dropMse(input.handle);
      abortPendingAttaches(input.handle);
      handleMimes.delete(input.handle);
      // A release on a handle an in-flight play is about to attach
      // must invalidate that op — otherwise its late serveUrl starts
      // an already-dropped stream and audio resumes post-teardown.
      dropPendingPlay(input.handle);
      if (localHandles.delete(input.handle)) {
        reapLocalPrepare(input.handle);
        // The seam never saw this handle — nothing to release.
        return ok(undefined);
      }
      return guard(() => stream.release({ handle: input.handle }));
    },

    async setQueueProjection(next) {
      projection = next;
      // The session re-keys the live attempt's queueRev whenever it
      // projects queue state for the SAME occurrence, then sends that
      // identity to transport calls — keep ours in step or the stale
      // guard rejects legitimate pause/seek/stop. A projection naming
      // another occurrence is left alone: that attach arrives through
      // a fresh play() carrying its own revision.
      if (
        current !== null &&
        next !== null &&
        next.currentOccurrenceId !== null &&
        next.currentOccurrenceId === current.occurrenceId
      ) {
        current = {
          ...current,
          identity: {
            attemptId: current.identity.attemptId,
            queueRev: next.queueRev,
          },
        };
      }
      // Pending plays pinned to the same occurrence ride the same
      // re-key.
      if (next !== null && next.currentOccurrenceId !== null) {
        for (const pending of pendingPlayGens.values()) {
          if (pending.occurrenceId === next.currentOccurrenceId) {
            pending.identity = {
              ...pending.identity,
              queueRev: next.queueRev,
            };
          }
        }
      }
      installMediaActions();
      refreshTransportButtons();
      publishMetadata();
      return ok(undefined);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
