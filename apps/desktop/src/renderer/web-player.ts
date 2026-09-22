import type {
  AppError,
  AttemptTrace,
  ErrorKind,
  PlaybackIdentity,
  PlayerEvent,
  PlayerPort,
  PreparedStream,
  QueueProjection,
  QueueProjectionItem,
  QueueTransitionReason,
  Result,
} from '@auqw/application';
import { appError, err, ok } from '@auqw/application';
import type {
  AttemptSummaryPayload,
  AuqwApi,
  PrepareOutcomePayload,
  PreparedStreamPayload,
  StreamMarksResult,
} from '../shared/contract.ts';
import { isRecord } from '../shared/check.ts';
import type { ShellError } from '../shared/errors.ts';
import {
  attachMseSource,
  type MseFactories,
  type MseSource,
} from './mse-source.ts';

/** The preload `stream` section as injected — never reaches for
 * `window` itself, so the port is testable under plain node. */
export type StreamClient = AuqwApi['stream'];

/**
 * The DOM Audio element surface the port drives. Declared minimally so
 * tests inject a fake without a DOM.
 */
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

/** `navigator.mediaSession` — OS media-key actions only. */
export type MediaSessionLike = {
  playbackState: string;
  setActionHandler(
    action: 'play' | 'pause' | 'nexttrack' | 'previoustrack',
    handler: (() => void) | null,
  ): void;
};

const SLUG_KIND: Readonly<Record<string, ErrorKind>> = {
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
  'io-error': 'transient',
  'invalid-request': 'invalid-response',
  'not-implemented': 'unavailable',
  'process-crashed': 'unavailable',
  'corrupt-state': 'internal',
  internal: 'internal',
};

function toKind(kind: unknown): ErrorKind {
  return typeof kind === 'string' && kind in SLUG_KIND
    ? (SLUG_KIND[kind] as ErrorKind)
    : 'internal';
}

function toError(thrown: unknown): AppError {
  if (isRecord(thrown)) {
    const kind = toKind(thrown['kind']);
    const message =
      typeof thrown['message'] === 'string' && thrown['message'].length > 0
        ? (thrown['message'] as string)
        : 'stream call failed';
    return appError(kind, message);
  }
  return appError('internal', 'stream call failed');
}

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

function toPreparedStream(
  payload: PreparedStreamPayload,
): PreparedStream {
  const stream: PreparedStream = {
    handle: payload.handle,
    mime: payload.mime,
  };
  const out = stream as {
    itag?: number;
    contentLength?: number;
    expiresAtMs?: number;
    bitrateKbps?: number;
  };
  if (payload.itag !== undefined) out.itag = payload.itag;
  if (payload.contentLength !== undefined)
    out.contentLength = payload.contentLength;
  if (payload.expiresAtMs !== undefined)
    out.expiresAtMs = payload.expiresAtMs;
  if (payload.bitrateKbps !== undefined)
    out.bitrateKbps = payload.bitrateKbps;
  return stream;
}

/** Diagnostics degrade to a zeroed trace rather than corrupting the
 * pipeline — mirrors the mobile adapter's convention. */
function toAttemptTrace(
  payload: AttemptSummaryPayload | undefined,
  requestId: string,
): AttemptTrace {
  if (payload === undefined) {
    return {
      requestId,
      steps: 0,
      httpCalls: 0,
      bytes: 0,
      fuelUsed: 0,
      elapsedMs: 0,
      httpTrace: [],
      guestLog: [],
    };
  }
  return {
    requestId: payload.requestId,
    steps: payload.steps,
    httpCalls: payload.httpCalls,
    bytes: payload.bytes,
    fuelUsed: payload.fuelUsed,
    elapsedMs: payload.elapsedMs,
    httpTrace: payload.httpTrace.map((entry) => {
      const out: {
        method: string;
        url: string;
        status?: number;
        bytes: number;
        elapsedMs: number;
      } = {
        method: entry.method,
        url: entry.url,
        bytes: entry.bytes,
        elapsedMs: entry.elapsedMs,
      };
      if (entry.status !== undefined) out.status = entry.status;
      return out;
    }),
    guestLog: payload.guestLog.map((entry) => ({
      level: entry.level,
      message: entry.message,
    })),
  };
}

/**
 * `PlayerPort` over HTML audio + Media Session, fed by the stream
 * seam's loopback leg (`streamServeUrl`) through the utility host.
 * Status/phase events are synthesized from element events + the
 * session's phase marks; the queue projection cursor moves per the
 * contract — `ended`/`remote-next` reach the immediate successor,
 * `remote-previous` restarts or steps back — and lands as
 * `queue-transition` events for the session to reconcile.
 */
/** The port's full surface — `noteMime` feeds the MSE gate mimes the
 * page learned outside `prepare` (the dev-gate's `stream.devPrepare`). */
export type WebPlayerPort = PlayerPort & {
  noteMime(handle: string, mime: string): void;
};

export function createWebPlayerPort(deps: {
  stream: StreamClient;
  audio: AudioLike;
  mediaSession?: MediaSessionLike | null;
  now?: () => number;
  /**
   * MSE factories — present under Electron (real `MediaSource` + blob
   * URLs); absent in tests/node, where the serve-url path is the only
   * leg. The MSE attach is preferred for every mime it can take; a
   * non-fragmented container still falls back to `streamServeUrl`.
   */
  mse?: MseFactories | null;
}): WebPlayerPort {
  const { stream, audio } = deps;
  const now = deps.now ?? Date.now;
  const listeners = new Set<(event: PlayerEvent) => void>();
  let current: {
    handle: string;
    identity: PlaybackIdentity;
    occurrenceId: string | null;
  } | null = null;
  /** `handle` → container mime, recorded from this port's own prepares
   * — `play()` args carry no mime, so the MSE gate reads it here. */
  const handleMimes = new Map<string, string>();
  /** The live MSE attach, keyed by the handle it serves. */
  let activeMse: { handle: string; source: MseSource } | null = null;

  function installMse(handle: string, source: MseSource | null): void {
    activeMse = source === null ? null : { handle, source };
    // Post-attach pump/SourceBuffer death — the element's own error
    // event never fires for a dead MSE feed (a revoked object URL does
    // not detach the element), so the session reports it here the same
    // way the audio error path does.
    source?.onFail((error) => {
      // Liveness is `activeMse` itself — a successor op's dropMse
      // already cleared us, and a play()-installed source has no
      // `current` entry to compare against.
      if (activeMse === null || activeMse.source !== source) {
        return;
      }
      dropMse();
      status('failed', appError('transient', error.message));
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

  /**
   * The MSE-first attach: when the mime is known and MSE-decodable the
   * byte pump feeds a SourceBuffer; anything it refuses — non-fragmented
   * mp4 above all — takes the `streamServeUrl` loopback instead.
   *
   * `url` lands fast enough to attach (a MediaSource only opens once
   * its object URL is on the element — waiting for first-append
   * readiness before assigning `audio.src` would deadlock `sourceopen`).
   * `settle` then resolves the committed outcome: the MSE source once a
   * segment lands, or the serve-url leg when the attach refuses
   * mid-stream.
   */
  async function attachUrl(
    handle: string,
    mimeHint?: string,
  ): Promise<{
    url: string;
    settle: Promise<{ url: string; source: MseSource | null }>;
    abort(): void;
  }> {
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
          async (): Promise<{ url: string; source: MseSource | null }> => {
            const served = await stream.serveUrl({ handle });
            return { url: served.url, source: null };
          },
        );
        return { url: attach.url, settle, abort: attach.abort };
      } catch {
        // Pre-wire MSE refusal (mime gate / dead broker) — the loopback
        // leg serves the same element through server.rs.
      }
    }
    const { url } = await stream.serveUrl({ handle });
    return {
      url,
      settle: Promise.resolve({ url, source: null }),
      abort: () => undefined,
    };
  }
  let projection: QueueProjection | null = null;
  let mediaActionsInstalled = false;
  let seq = 0;
  /** Monotonic op generation — a superseded async completion (play,
   * cursor attach) must never touch `current` or the element. */
  let opGen = 0;
  /** In-flight `play` ops keyed by handle — the newest writer wins,
   * each play removes only its own token. A `release` of a tracked
   * handle or a matching `pause` invalidates that op (bumps opGen) so
   * its late serveUrl completion can't start a host-dropped stream or
   * resume audio past a successful pause. `positionMs` tracks the
   * newest seek issued against the op's identity so a seek during the
   * resolve isn't overwritten by the play's older start position. */
  const pendingPlayGens = new Map<
    string,
    {
      gen: number;
      identity: PlaybackIdentity;
      positionMs: number;
      occurrenceId: string | null;
    }
  >();

  /**
   * A mime learned outside `prepare` — the dev-gate calls
   * `stream.devPrepare` through the page, never through this port, so
   * the page reports the payload's mime for the MSE gate to read.
   */
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
        pendingPlayGens.delete(handle);
        opGen++;
      }
    }
  }

  const posMs = (): number => Math.max(0, Math.round(audio.currentTime * 1000));
  const durMs = (): number | undefined =>
    Number.isFinite(audio.duration)
      ? Math.round(audio.duration * 1000)
      : undefined;

  function emit(event: PlayerEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A throwing subscriber must not break event fan-out.
      }
    }
  }

  function status(
    state:
      | 'idle'
      | 'buffering'
      | 'ready'
      | 'playing'
      | 'paused'
      | 'ended'
      | 'failed',
    error?: AppError,
  ): void {
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
    let handle: string | undefined;
    // Once this op owns `current`, failure-emit ownership is the
    // handle match — emitTransition already swapped the projection
    // reference, so `projection === p` can no longer prove liveness.
    let attached = false;
    try {
      const outcome = await stream.prepare({
        pluginId: item.provider,
        sourceRef: item.sourceRef,
        requestId,
      });
      if (outcome.type !== 'prepared' || outcome.stream === undefined) {
        // A stale op's failure is not the live attempt's — suppress it
        // rather than label the stream the session already moved to.
        if (gen === opGen && projection === p) {
          const kind =
            outcome.type === 'superseded' ? 'superseded' : toKind(outcome.kind);
          status(
            'failed',
            appError(kind, outcome.message ?? 'successor prepare failed'),
          );
        }
        return;
      }
      handle = outcome.stream.handle;
      noteMime(handle, outcome.stream.mime);
      const first = await attachUrl(handle, outcome.stream.mime);
      // A later play/attach/prepare or a moved projection makes this
      // completion stale — release its minted handle and stay out of
      // the element; the live attempt keeps ownership.
      if (gen !== opGen || projection !== p) {
        first.abort();
        void first.settle.then((s) => s.source?.destroy());
        void stream.release({ handle }).catch(() => undefined);
        return;
      }
      // The successor's pump must close before this source installs —
      // two live pumps on one element attach is the leak the review
      // flagged (dropMse only ran inside play()).
      dropMse();
      const identity: PlaybackIdentity = {
        attemptId: `watt-id-${seq}`,
        queueRev: p.queueRev,
      };
      current = { handle, identity, occurrenceId: item.occurrenceId };
      attached = true;
      audio.src = first.url;
      audio.currentTime = 0;
      emitTransition(p, item.occurrenceId, reason, 0, identity, handle);
      emitMarks(handle, identity);
      const settled = await first.settle;
      // Liveness past the element install is the handle match —
      // our own emitTransition already swapped the `projection`
      // reference, so `projection === p` can no longer prove this op
      // is the live attempt.
      if (
        gen !== opGen ||
        current === null ||
        current.handle !== handle
      ) {
        settled.source?.destroy();
        void stream.release({ handle }).catch(() => undefined);
        return;
      }
      installMse(handle, settled.source);
      // A mid-stream MSE refusal swaps the element onto the loopback leg.
      if (settled.url !== first.url) {
        audio.src = settled.url;
        audio.currentTime = 0;
      }
      const shouldPlay = reason === 'ended' || p.mode === 'playing';
      if (shouldPlay) {
        await audio.play();
      }
      if (deps.mediaSession !== null && deps.mediaSession !== undefined) {
        deps.mediaSession.playbackState = shouldPlay ? 'playing' : 'paused';
      }
    } catch (thrown) {
      // A minted-but-never-attached handle is ours to reap — repeated
      // leaks would cap the registry.
      if (handle !== undefined) {
        void stream.release({ handle }).catch(() => undefined);
      }
      // A stale op's rejection must not label the live attempt — its
      // outcome belongs to the op the session already replaced.
      // Ownership is the handle match once this op set `current` (our
      // own emitTransition already replaced the projection reference),
      // or the untouched projection before attach.
      const stillMine =
        gen === opGen &&
        (attached
          ? current !== null && current.handle === handle
          : projection === p);
      if (stillMine) {
        status('failed', toError(thrown));
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
    if (reason === 'remote-previous') {
      const restart = posMs() >= 3000 || idx === 0;
      if (restart) {
        // Restart the current stream in place — same attempt echoes the
        // live re-keyed revision per the transition contract.
        const cur = current;
        if (cur === null) {
          return;
        }
        emitTransition(
          p,
          p.currentOccurrenceId,
          reason,
          0,
          cur.identity,
          cur.handle,
        );
        audio.currentTime = 0;
        if (p.mode === 'playing') {
          void audio.play().catch(() => undefined);
        }
        return;
      }
      const item = p.items[idx - 1];
      if (item === undefined) {
        return;
      }
      void attachItem(p, item, reason);
      return;
    }
    const successor = idx + 1 < p.items.length ? p.items[idx + 1] : undefined;
    if (successor === undefined) {
      const tailPositionMs = posMs();
      if (reason !== 'ended') {
        // A remote skip at the tail leaves the element live — detach
        // it so playback stops with the queue, not after it.
        opGen++;
        dropMse();
        current = null;
        audio.pause();
        audio.src = '';
        if (deps.mediaSession !== null && deps.mediaSession !== undefined) {
          deps.mediaSession.playbackState = 'none';
        }
      }
      // Tail of the queue — a null target means the cursor ran off.
      emitTransition(p, null, reason, tailPositionMs, null, null);
      return;
    }
    void attachItem(p, successor, reason);
  }

  function emitMarks(
    handle: string,
    identity: PlaybackIdentity,
  ): void {
    void stream
      .marks({ handle })
      .then((marks: StreamMarksResult) => {
        if (current === null || current.handle !== handle) {
          return;
        }
        // `resolveMs`/`mintMs` are durations already; the later marks
        // are wall-clock epochs — convert through `prepareStartedMs`,
        // skipping any the conversion cannot anchor.
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

  audio.addEventListener('playing', () => status('playing'));
  audio.addEventListener('waiting', () => status('buffering'));
  audio.addEventListener('loadedmetadata', () => status('ready'));
  audio.addEventListener('pause', () => {
    if (audio.paused && !audio.ended) {
      status('paused');
    }
  });
  audio.addEventListener('seeked', () =>
    status(audio.paused ? 'paused' : 'playing'),
  );
  audio.addEventListener('timeupdate', () => {
    if (!audio.paused) {
      status('playing');
    }
  });
  audio.addEventListener('ended', () => {
    status('ended');
    advanceQueue('ended');
  });
  audio.addEventListener('error', () => {
    status('failed', appError('transient', 'audio element failed'));
  });

  function installMediaActions(): void {
    const ms = deps.mediaSession;
    if (ms === null || ms === undefined || mediaActionsInstalled) {
      return;
    }
    mediaActionsInstalled = true;
    ms.setActionHandler('play', () => {
      void audio.play().catch(() => undefined);
    });
    ms.setActionHandler('pause', () => {
      // A media-key pause is transport-wide — a pending play's late
      // serveUrl must not start audio after it, whatever attempt the
      // op belongs to. Each killed op is reported paused with its own
      // identity so the session reconciles the attempt — otherwise
      // play() resolving with no attach and no event strands it in
      // buffering.
      const killed = [...pendingPlayGens.entries()];
      invalidatePendingPlays(null);
      audio.pause();
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
    ms.setActionHandler('nexttrack', () => advanceQueue('remote-next'));
    ms.setActionHandler('previoustrack', () =>
      advanceQueue('remote-previous'),
    );
  }

  function stale(identity: PlaybackIdentity): Result<never> | null {
    if (current !== null && !identityEq(identity, current.identity)) {
      return err(
        appError('invalid-message', 'stale playback identity'),
      );
    }
    return null;
  }

  return {
    async prepare(input) {
      const requestId = `wreq-${++seq}`;
      const emitFailed = (error: AppError): void => {
        emit({
          type: 'prepare',
          requestId,
          identity: input.identity,
          outcome: {
            type: 'failed',
            error,
            attempt: toAttemptTrace(undefined, requestId),
          },
        });
      };
      if (input.provider === 'local') {
        // Desktop local files are the Phase-4 adapter — no seam leg yet.
        emitFailed(
          appError('unavailable', 'desktop local files not implemented'),
        );
        return ok(requestId);
      }
      // Return the requestId up front — the terminal outcome arrives
      // as a `prepare` event, so a session-side deadline can reach
      // `cancelPrepare` while the utility is still resolving.
      opGen++;
      void stream
        .prepare({
          pluginId: input.provider,
          sourceRef: input.sourceRef,
          requestId,
        })
        .then((outcome: PrepareOutcomePayload) => {
          if (
            outcome.type === 'prepared' &&
            outcome.stream !== undefined
          ) {
            const prepared = toPreparedStream(outcome.stream);
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
          } else {
            const kind =
              outcome.type === 'superseded'
                ? 'superseded'
                : toKind(outcome.kind);
            emit({
              type: 'prepare',
              requestId,
              identity: input.identity,
              outcome: {
                type: 'failed',
                error: appError(
                  kind,
                  outcome.message ?? 'prepare failed',
                ),
                attempt: toAttemptTrace(outcome.attempt, requestId),
              },
            });
          }
        })
        .catch((thrown) => emitFailed(toError(thrown)));
      return ok(requestId);
    },

    async play(input) {
      const gen = ++opGen;
      pendingPlayGens.set(input.handle, {
        gen,
        identity: { ...input.identity },
        positionMs: input.positionMs ?? 0,
        occurrenceId: projection?.currentOccurrenceId ?? null,
      });
      return guard(async () => {
        try {
          const first = await attachUrl(input.handle);
          // A newer play/prepare/stop superseded this one while the
          // attach resolved — the late completion must not retake
          // the element. A release of this same handle landed too: it
          // bumped opGen through the pendingPlayGens guard.
          if (gen !== opGen) {
            first.abort();
            void first.settle.then((s) => s.source?.destroy());
            return;
          }
          // The surviving token is authoritative — a queue mutation may
          // have re-keyed its queueRev since this op was issued, and
          // attaching the caller's stale revision would fail every
          // later control as `invalid-message`.
          const pending = pendingPlayGens.get(input.handle);
          const identity = pending?.identity ?? input.identity;
          dropMse();
          current = {
            handle: input.handle,
            identity,
            occurrenceId:
              pending?.occurrenceId ?? projection?.currentOccurrenceId ?? null,
          };
          audio.src = first.url;
          audio.currentTime =
            (pending?.positionMs ?? input.positionMs ?? 0) / 1000;
          status('buffering');
          emitMarks(input.handle, identity);
          const settled = await first.settle;
          // Superseded while the MSE attach settled — whatever source
          // it produced belongs to a dead op.
          if (gen !== opGen) {
            settled.source?.destroy();
            return;
          }
          installMse(input.handle, settled.source);
          // A mid-stream MSE refusal swaps the element onto the
          // loopback leg.
          if (settled.url !== first.url) {
            audio.src = settled.url;
            audio.currentTime =
              (pending?.positionMs ?? input.positionMs ?? 0) / 1000;
          }
          await audio.play();
          if (deps.mediaSession !== null && deps.mediaSession !== undefined) {
            deps.mediaSession.playbackState = 'playing';
          }
        } finally {
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
      // A play still awaiting its serve URL has not attached `current`
      // yet — without invalidating it, the late completion would start
      // audio after this pause already succeeded. `stale` can't see it,
      // so match it by the same identity contract a live attempt uses.
      invalidatePendingPlays(identity);
      audio.pause();
      if (deps.mediaSession !== null && deps.mediaSession !== undefined) {
        deps.mediaSession.playbackState = 'paused';
      }
      return ok(undefined);
    },

    async seekTo(input) {
      const bad = stale(input.identity);
      if (bad !== null) {
        return bad;
      }
      // A play still awaiting its serve URL applies its captured
      // position when it lands — keep the pending op's position in
      // step so a seek issued during the resolve isn't overwritten.
      for (const pending of pendingPlayGens.values()) {
        if (identityEq(input.identity, pending.identity)) {
          pending.positionMs = input.positionMs;
        }
      }
      audio.currentTime = input.positionMs / 1000;
      // An uncovered position re-anchors the pump through the
      // journal/Cues index; a covered one just plays from buffer.
      activeMse?.source.seekTo(input.positionMs);
      return ok(undefined);
    },

    async stop(identity) {
      const bad = stale(identity);
      if (bad !== null) {
        return bad;
      }
      opGen++;
      dropMse();
      audio.pause();
      audio.src = '';
      if (deps.mediaSession !== null && deps.mediaSession !== undefined) {
        deps.mediaSession.playbackState = 'none';
      }
      status('idle');
      current = null;
      return ok(undefined);
    },

    async cancelPrepare(input) {
      return guard(() => stream.cancel({ requestId: input.requestId }));
    },

    noteMime,

    async release(input) {
      if (current !== null && current.handle === input.handle) {
        audio.pause();
        audio.src = '';
        current = null;
      }
      dropMse(input.handle);
      handleMimes.delete(input.handle);
      // Releasing a handle an in-flight play is about to attach must
      // invalidate that op — otherwise its late serveUrl resolves into
      // an already-dropped host stream and audio resumes post-teardown.
      if (pendingPlayGens.delete(input.handle)) {
        opGen++;
      }
      return guard(() => stream.release({ handle: input.handle }));
    },

    async setQueueProjection(next) {
      projection = next;
      // The session re-keys the live attempt's queueRev whenever it
      // projects queue state for the SAME occurrence, then sends that
      // re-keyed identity to transport calls — keep ours in step or the
      // stale guard rejects legitimate pause/seek/stop. A projection
      // naming another occurrence is left alone: that attach arrives
      // through a fresh play() carrying its own revision.
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
      // re-key — the session re-issues pause/seek under the new
      // revision, so a stale queueRev here would strand their
      // identity match the way an un-re-keyed `current` would.
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
      return ok(undefined);
    },

    subscribe(listener) {
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        listeners.delete(listener);
      };
    },
  };
}
