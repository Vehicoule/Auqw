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
export function createWebPlayerPort(deps: {
  stream: StreamClient;
  audio: AudioLike;
  mediaSession?: MediaSessionLike | null;
  now?: () => number;
}): PlayerPort {
  const { stream, audio } = deps;
  const now = deps.now ?? Date.now;
  const listeners = new Set<(event: PlayerEvent) => void>();
  let current: {
    handle: string;
    identity: PlaybackIdentity;
    occurrenceId: string | null;
  } | null = null;
  let projection: QueueProjection | null = null;
  let mediaActionsInstalled = false;
  let seq = 0;

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
    try {
      const outcome = await stream.prepare({
        pluginId: item.provider,
        sourceRef: item.sourceRef,
        requestId,
      });
      if (outcome.type !== 'prepared' || outcome.stream === undefined) {
        const kind =
          outcome.type === 'superseded' ? 'superseded' : toKind(outcome.kind);
        status(
          'failed',
          appError(kind, outcome.message ?? 'successor prepare failed'),
        );
        return;
      }
      const handle = outcome.stream.handle;
      const { url } = await stream.serveUrl({ handle });
      const identity: PlaybackIdentity = {
        attemptId: `watt-id-${seq}`,
        queueRev: p.queueRev,
      };
      current = { handle, identity, occurrenceId: item.occurrenceId };
      audio.src = url;
      audio.currentTime = 0;
      emitTransition(p, item.occurrenceId, reason, 0, identity, handle);
      emitMarks(handle, identity);
      const shouldPlay = reason === 'ended' || p.mode === 'playing';
      if (shouldPlay) {
        await audio.play();
      }
      if (deps.mediaSession !== null && deps.mediaSession !== undefined) {
        deps.mediaSession.playbackState = shouldPlay ? 'playing' : 'paused';
      }
    } catch (thrown) {
      status('failed', toError(thrown));
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
      // Tail of the queue — a null target means the cursor ran off.
      emitTransition(p, null, reason, posMs(), null, null);
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
        const phases: ReadonlyArray<readonly [string, number | undefined]> = [
          ['resolve', marks.resolveMs],
          ['mint', marks.mintMs],
          ['first-byte', marks.firstByteMs],
          ['head-ready', marks.headReadyMs],
          ['attach', marks.attachMs],
        ];
        for (const [name, sinceStartMs] of phases) {
          if (sinceStartMs !== undefined) {
            emit({
              type: 'phase',
              handle,
              identity,
              name,
              atMs: now(),
              sinceStartMs,
            });
          }
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
    ms.setActionHandler('pause', () => audio.pause());
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
      try {
        const outcome: PrepareOutcomePayload = await stream.prepare({
          pluginId: input.provider,
          sourceRef: input.sourceRef,
          requestId,
        });
        if (
          outcome.type === 'prepared' &&
          outcome.stream !== undefined
        ) {
          const prepared = toPreparedStream(outcome.stream);
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
      } catch (thrown) {
        emitFailed(toError(thrown));
      }
      return ok(requestId);
    },

    async play(input) {
      return guard(async () => {
        const { url } = await stream.serveUrl({ handle: input.handle });
        const identity = input.identity;
        current = {
          handle: input.handle,
          identity,
          occurrenceId: projection?.currentOccurrenceId ?? null,
        };
        audio.src = url;
        audio.currentTime = (input.positionMs ?? 0) / 1000;
        status('buffering');
        emitMarks(input.handle, identity);
        await audio.play();
        if (deps.mediaSession !== null && deps.mediaSession !== undefined) {
          deps.mediaSession.playbackState = 'playing';
        }
      });
    },

    async pause(identity) {
      const bad = stale(identity);
      if (bad !== null) {
        return bad;
      }
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
      audio.currentTime = input.positionMs / 1000;
      return ok(undefined);
    },

    async stop(identity) {
      const bad = stale(identity);
      if (bad !== null) {
        return bad;
      }
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

    async release(input) {
      if (current !== null && current.handle === input.handle) {
        audio.pause();
        audio.src = '';
        current = null;
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
