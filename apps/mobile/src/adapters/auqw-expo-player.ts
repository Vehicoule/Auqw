import type {
  AppError,
  AttemptTrace,
  PlaybackIdentity,
  PlayerEvent,
  PlayerPort,
  PreparedStream,
  QueueProjection,
  Result,
} from '@auqw/application';
import { appError, err, isAttemptTrace, ok } from '@auqw/application';
import type {
  AuqwExpoPlaybackStatusEvent,
  AuqwExpoPhaseMarkEvent,
  AuqwExpoPlayerLike,
  AuqwExpoPrepareOutcomeEvent,
  AuqwExpoQueueTransitionEvent,
  AuqwExpoSubscription,
} from './auqw-expo-surface.ts';
import { appErrorKind, nativeError } from './auqw-expo-surface.ts';

const PLAYBACK_STATES: ReadonlySet<string> = new Set([
  'idle',
  'buffering',
  'ready',
  'playing',
  'paused',
  'ended',
  'failed',
]);

const TRANSITION_REASONS: ReadonlySet<string> = new Set([
  'ended',
  'remote-next',
  'remote-previous',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isSafeNonNegative(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}

function toIdentity(
  attemptId: unknown,
  queueRev: unknown,
): PlaybackIdentity | null {
  return isBoundedString(attemptId, 128) && isSafeNonNegative(queueRev)
    ? { attemptId, queueRev }
    : null;
}

/**
 * Diagnostics degrade to a zeroed trace rather than corrupting the
 * pipeline: a malformed attempt payload still yields a legal
 * AttemptTrace so the prepare outcome stays consumable.
 */
function toAttemptTrace(
  value: unknown,
  requestId: string,
): AttemptTrace {
  if (isAttemptTrace(value)) {
    return value;
  }
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

function toPreparedStream(value: unknown): PreparedStream | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!isBoundedString(value['handle'], 512)) {
    return null;
  }
  if (!isBoundedString(value['mime'], 128)) {
    return null;
  }
  const stream: {
    handle: string;
    mime: string;
    itag?: number;
    contentLength?: number;
    expiresAtMs?: number;
    bitrateKbps?: number;
  } = { handle: value['handle'], mime: value['mime'] };
  for (const key of [
    'itag',
    'contentLength',
    'expiresAtMs',
    'bitrateKbps',
  ] as const) {
    const field = value[key];
    if (field !== undefined) {
      if (!isSafeNonNegative(field)) {
        return null;
      }
      stream[key] = field;
    }
  }
  return stream;
}

function toAppError(kind: unknown, message: unknown): AppError {
  return appError(
    appErrorKind(typeof kind === 'string' ? kind : 'internal'),
    typeof message === 'string' && message.length > 0
      ? message
      : 'native failure',
  );
}

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (thrown) {
    return err(nativeError(thrown));
  }
}

/**
 * PlayerPort over the auqw-expo streaming seam. The native module is
 * injected as `AuqwExpoPlayerLike`; this file never imports
 * 'auqw-expo' and stays free of React Native / Expo imports so the
 * adapter is testable under plain Node.
 *
 * Method calls forward the attempt identity the port carries and wrap
 * native rejections into typed errors — they never throw. Seam events
 * map to PlayerEvent with their echoed identity (attemptId/queueRev)
 * passed through untouched; events too malformed to form a legal
 * PlayerEvent are dropped rather than emitted with synthesized data.
 */
export function createAuqwExpoPlayer(
  module: AuqwExpoPlayerLike,
): PlayerPort {
  const listeners = new Set<(event: PlayerEvent) => void>();
  let subscriptions: readonly AuqwExpoSubscription[] | null = null;

  function emit(event: PlayerEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A throwing subscriber must not break event fan-out.
      }
    }
  }

  function onPrepareOutcome(event: AuqwExpoPrepareOutcomeEvent): void {
    if (!isRecord(event)) {
      return;
    }
    if (!isBoundedString(event.requestId, 128)) {
      return;
    }
    const identity = toIdentity(event.attemptId, event.queueRev);
    if (identity === null) {
      return;
    }
    const outcome = event.outcome;
    if (!isRecord(outcome)) {
      return;
    }
    if (outcome.type === 'prepared') {
      const stream = toPreparedStream(outcome.stream);
      const attempt = toAttemptTrace(outcome.attempt, event.requestId);
      if (stream === null) {
        emit({
          type: 'prepare',
          requestId: event.requestId,
          identity,
          outcome: {
            type: 'failed',
            error: appError(
              'invalid-response',
              'malformed prepared stream',
            ),
            attempt,
          },
        });
        return;
      }
      emit({
        type: 'prepare',
        requestId: event.requestId,
        identity,
        outcome: { type: 'prepared', stream, attempt },
      });
      return;
    }
    if (outcome.type === 'failed') {
      emit({
        type: 'prepare',
        requestId: event.requestId,
        identity,
        outcome: {
          type: 'failed',
          error: toAppError(outcome.kind, outcome.message),
          attempt: toAttemptTrace(outcome.attempt, event.requestId),
        },
      });
    }
  }

  function onPlaybackStatus(event: AuqwExpoPlaybackStatusEvent): void {
    if (!isRecord(event)) {
      return;
    }
    if (
      !isBoundedString(event.handle, 512) ||
      !isSafeNonNegative(event.positionMs) ||
      (event.durationMs !== undefined &&
        !isSafeNonNegative(event.durationMs)) ||
      typeof event.state !== 'string' ||
      !PLAYBACK_STATES.has(event.state)
    ) {
      return;
    }
    const identity = toIdentity(event.attemptId, event.queueRev);
    if (identity === null) {
      return;
    }
    const state = event.state;
    const error =
      event.error === undefined
        ? undefined
        : toAppError(event.error.kind, event.error.message);
    emit({
      type: 'status',
      handle: event.handle,
      identity,
      state,
      positionMs: event.positionMs,
      ...(event.durationMs === undefined
        ? {}
        : { durationMs: event.durationMs }),
      ...(error === undefined ? {} : { error }),
    });
  }

  function onPhaseMark(event: AuqwExpoPhaseMarkEvent): void {
    if (!isRecord(event)) {
      return;
    }
    const identity = toIdentity(event.attemptId, event.queueRev);
    if (
      identity === null ||
      !isBoundedString(event.handle, 512) ||
      !isBoundedString(event.name, 128) ||
      !isSafeNonNegative(event.atMs) ||
      !isSafeNonNegative(event.sinceStartMs)
    ) {
      return;
    }
    emit({
      type: 'phase',
      handle: event.handle,
      identity,
      name: event.name,
      atMs: event.atMs,
      sinceStartMs: event.sinceStartMs,
    });
  }

  function onQueueTransition(event: AuqwExpoQueueTransitionEvent): void {
    if (!isRecord(event)) {
      return;
    }
    const identity =
      event.identity === null
        ? null
        : isRecord(event.identity)
          ? toIdentity(event.identity.attemptId, event.identity.queueRev)
          : null;
    if (
      !isBoundedString(event.projectionId, 128) ||
      !isSafeNonNegative(event.projectedQueueRev) ||
      !isSafeNonNegative(event.positionMs) ||
      typeof event.reason !== 'string' ||
      !TRANSITION_REASONS.has(event.reason) ||
      (event.fromOccurrenceId !== null &&
        typeof event.fromOccurrenceId !== 'string') ||
      (event.toOccurrenceId !== null &&
        typeof event.toOccurrenceId !== 'string') ||
      (event.handle !== null && typeof event.handle !== 'string') ||
      (event.identity !== null && identity === null)
    ) {
      return;
    }
    emit({
      type: 'queue-transition',
      projectionId: event.projectionId,
      projectedQueueRev: event.projectedQueueRev,
      fromOccurrenceId: event.fromOccurrenceId,
      toOccurrenceId: event.toOccurrenceId,
      reason: event.reason,
      positionMs: event.positionMs,
      identity,
      handle: event.handle,
    });
  }

  function ensureSubscriptions(): void {
    if (subscriptions !== null) {
      return;
    }
    subscriptions = [
      module.addPrepareOutcomeListener(onPrepareOutcome),
      module.addPlaybackStatusListener(onPlaybackStatus),
      module.addPhaseMarkListener(onPhaseMark),
      module.addQueueTransitionListener(onQueueTransition),
    ];
  }

  return {
    prepare(input) {
      return guard(() =>
        module.prepare(
          input.provider,
          input.sourceRef,
          input.identity.attemptId,
          input.identity.queueRev,
        ),
      );
    },
    play(input) {
      return guard(() =>
        module.play(
          input.handle,
          input.identity.attemptId,
          input.identity.queueRev,
          input.positionMs,
        ),
      );
    },
    pause() {
      return guard(() => module.pause());
    },
    seekTo(input) {
      return guard(() => module.seekTo(input.positionMs));
    },
    stop() {
      return guard(() => module.stop());
    },
    cancelPrepare(input) {
      return guard(() => module.cancelPrepare(input.requestId));
    },
    release(input) {
      return guard(() => module.releaseStream(input.handle));
    },
    setQueueProjection(projection: QueueProjection) {
      return guard(() => module.setQueueProjection(projection));
    },
    subscribe(listener) {
      listeners.add(listener);
      // All four native listeners attach on the first subscription and
      // detach when the last subscriber leaves.
      ensureSubscriptions();
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0 && subscriptions !== null) {
          for (const subscription of subscriptions) {
            subscription.remove();
          }
          subscriptions = null;
        }
      };
    },
  };
}
