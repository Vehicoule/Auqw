import type { ErrorKind, QueueProjection } from '@auqw/application';
import { appError } from '@auqw/application';
import type { AppError } from '@auqw/application';

/**
 * The injected surface of the `auqw-expo` native module. The module is
 * not present on this branch, so every adapter takes this structural
 * interface instead of importing 'auqw-expo'; the shapes below mirror
 * the seam contract (modules/auqw-expo `index.ts` and
 * docs/specs/playback.md "Streaming seam") field-for-field.
 */

export type AuqwExpoSubscription = { remove(): void };

export type AuqwExpoHostConfig = {
  fuelPerEntry: number;
  fuelTotal: number;
  /** Base URL of a bgutil-compatible PO-token service; omit for anonymous resolves. */
  potProviderUrl?: string | undefined;
  /** Plugin KV file; defaults to the app-private files dir. */
  statePath?: string | undefined;
  /** Stream-seam sparse cache dir; defaults to the app-private cache dir. */
  streamPath?: string | undefined;
  /** Container preference order for playback.resolve — the surface's
   * prefer hint (webm-first Android/desktop, mp4-only iOS); omit for
   * the guest's own default. */
  prefer?: readonly string[] | undefined;
};

/** Diagnostics for one guest attempt; identical shape to AttemptTrace. */
export type AuqwExpoAttemptSummary = {
  requestId: string;
  steps: number;
  httpCalls: number;
  bytes: number;
  fuelUsed: number;
  elapsedMs: number;
  httpTrace: readonly {
    method: string;
    url: string;
    status?: number;
    bytes: number;
    elapsedMs: number;
  }[];
  guestLog: readonly { level: string; message: string }[];
};

export type AuqwExpoRequestOutcome =
  | { type: 'succeeded'; resultJson: string; attempt: AuqwExpoAttemptSummary }
  | { type: 'failed'; kind: string; message: string; attempt: AuqwExpoAttemptSummary };

export type AuqwExpoRequestOutcomeEvent = {
  requestId: string;
  outcome: AuqwExpoRequestOutcome;
};

export type AuqwExpoPreparedStream = {
  handle: string;
  mime: string;
  itag?: number;
  contentLength?: number;
  expiresAtMs?: number;
  bitrateKbps?: number;
};

export type AuqwExpoPrepareOutcome =
  | { type: 'prepared'; stream: AuqwExpoPreparedStream; attempt: AuqwExpoAttemptSummary }
  | { type: 'failed'; kind: string; message: string; attempt: AuqwExpoAttemptSummary };

export type AuqwExpoPrepareOutcomeEvent = {
  requestId: string;
  attemptId: string;
  queueRev: number;
  outcome: AuqwExpoPrepareOutcome;
};

export type AuqwExpoPlaybackState =
  | 'idle'
  | 'buffering'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'failed';

export type AuqwExpoPlaybackStatusEvent = {
  handle: string;
  attemptId: string;
  queueRev: number;
  state: AuqwExpoPlaybackState;
  positionMs: number;
  durationMs?: number;
  error?: { kind: string; message: string };
};

export type AuqwExpoPhaseMarkEvent = {
  handle: string;
  attemptId: string;
  queueRev: number;
  name: string;
  atMs: number;
  sinceStartMs: number;
};

export type AuqwExpoQueueTransitionReason =
  | 'ended'
  | 'remote-next'
  | 'remote-previous';

export type AuqwExpoQueueTransitionEvent = {
  projectionId: string;
  projectedQueueRev: number;
  fromOccurrenceId: string | null;
  toOccurrenceId: string | null;
  reason: AuqwExpoQueueTransitionReason;
  positionMs: number;
  identity: { attemptId: string; queueRev: number } | null;
  handle: string | null;
};

/** Generic capability requests (the plugin-host side of the module). */
export type AuqwExpoHostLike = {
  startRequest(
    pluginId: string,
    capability: string,
    payload: Record<string, unknown>,
  ): Promise<string>;
  cancel(requestId: string): void;
  addRequestOutcomeListener(
    listener: (event: AuqwExpoRequestOutcomeEvent) => void,
  ): AuqwExpoSubscription;
};

/** The transport side of the module (the streaming seam). */
export type AuqwExpoPlayerLike = {
  prepare(
    provider: string,
    sourceRef: string,
    attemptId: string,
    queueRev: number,
  ): Promise<string>;
  play(
    handle: string,
    attemptId: string,
    queueRev: number,
    positionMs?: number,
  ): Promise<void>;
  pause(): Promise<void>;
  seekTo(positionMs: number): Promise<void>;
  stop(): Promise<void>;
  cancelPrepare(requestId: string): Promise<void>;
  releaseStream(handle: string): Promise<void>;
  setQueueProjection(projection: QueueProjection): Promise<void>;
  addPrepareOutcomeListener(
    listener: (event: AuqwExpoPrepareOutcomeEvent) => void,
  ): AuqwExpoSubscription;
  addPlaybackStatusListener(
    listener: (event: AuqwExpoPlaybackStatusEvent) => void,
  ): AuqwExpoSubscription;
  addPhaseMarkListener(
    listener: (event: AuqwExpoPhaseMarkEvent) => void,
  ): AuqwExpoSubscription;
  addQueueTransitionListener(
    listener: (event: AuqwExpoQueueTransitionEvent) => void,
  ): AuqwExpoSubscription;
};

/** The whole module: host + player + lifecycle. */
export type AuqwExpoLike = AuqwExpoHostLike &
  AuqwExpoPlayerLike & {
    createHost(config: AuqwExpoHostConfig): Promise<void>;
    setAuthToken(token: string | null): void;
    loadPlugin(wasmBase64: string, manifestJson: string): Promise<string>;
  };

/**
 * The host half plus lifecycle — satisfied by the `auqw-expo` module
 * (which absorbed the retired slice-0 `auqw-plugin-host-expo` surface).
 */
export type AuqwExpoHostModuleLike = AuqwExpoHostLike & {
  createHost(config: AuqwExpoHostConfig): Promise<void>;
  setAuthToken(token: string | null): void;
  loadPlugin(wasmBase64: string, manifestJson: string): Promise<string>;
};

/**
 * Seam/ABI `kind` strings → the application taxonomy. Every seam kind
 * is already a legal application kind (the 24-kind set is the ABI
 * superset: guest kinds plus host kinds plus the seam's terminal
 * transition kinds `released`/`superseded`/`evicted`/`expired`/
 * `not-found`), so the table is the identity map. A kind outside the
 * taxonomy cannot be represented honestly — it degrades to `internal`
 * rather than leaking an untyped string across the port.
 */
const KIND_MAP: Readonly<Record<string, ErrorKind>> = {
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
  internal: 'internal',
};

export function appErrorKind(kind: string): ErrorKind {
  return KIND_MAP[kind] ?? 'internal';
}

/**
 * Maps a value thrown by a native call to a typed AppError. Expo
 * rejections are `Error`s; a `kind`/`code` string property (the
 * module's coded-error convention) picks the taxonomy kind, anything
 * else is `internal`. The message crosses because the seam contract
 * already carries human-readable failure text — it never carries
 * signed URLs.
 */
export function nativeError(thrown: unknown): AppError {
  let kind: ErrorKind = 'internal';
  if (typeof thrown === 'object' && thrown !== null) {
    const coded = thrown as { kind?: unknown; code?: unknown };
    const raw =
      typeof coded.kind === 'string'
        ? coded.kind
        : typeof coded.code === 'string'
          ? coded.code
          : null;
    if (raw !== null) {
      kind = appErrorKind(raw);
    }
  }
  const message =
    thrown instanceof Error && thrown.message.length > 0
      ? thrown.message
      : 'native call failed';
  return appError(kind, message);
}
