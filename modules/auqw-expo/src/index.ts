import { requireNativeModule } from 'expo';
import type { EventSubscription, NativeModule } from 'expo-modules-core';

// ---------------------------------------------------------------------------
// Host surface — verbatim contract from the retired plugin-host-expo module.
// ---------------------------------------------------------------------------

export type HostConfig = {
  fuelPerEntry: number;
  fuelTotal: number;
  /** Base URL of a bgutil-compatible PO-token service; omit for anonymous resolves. */
  potProviderUrl?: string | undefined;
};

export type HttpTraceSummary = {
  method: string;
  /** Query/fragment-free URL. */
  url: string;
  status?: number;
  bytes: number;
  elapsedMs: number;
};

export type GuestLogSummary = {
  level: string;
  message: string;
};

export type AttemptSummary = {
  requestId: string;
  steps: number;
  httpCalls: number;
  bytes: number;
  fuelUsed: number;
  elapsedMs: number;
  httpTrace: HttpTraceSummary[];
  guestLog: GuestLogSummary[];
};

export type ResolvedResource = {
  url: string;
  mime: string;
  bitrateKbps?: number;
  expiresAtMs?: number;
  client: string;
  contentLength?: number;
};

export type ResolveOutcome =
  | { type: 'resolved'; resource: ResolvedResource; attempt: AttemptSummary }
  | { type: 'failed'; kind: string; message: string; attempt: AttemptSummary };

/** Outcome of a generic capability request: the raw result JSON plus attempt. */
export type RequestOutcome =
  | { type: 'succeeded'; resultJson: string; attempt: AttemptSummary }
  | { type: 'failed'; kind: string; message: string; attempt: AttemptSummary };

export type SpinReport = {
  elapsedMs: number;
  fuelUsed: number;
  kind: string;
};

export type OutcomeEvent = {
  requestId: string;
  outcome: ResolveOutcome;
};

export type RequestOutcomeEvent = {
  requestId: string;
  outcome: RequestOutcome;
};

// ---------------------------------------------------------------------------
// Player surface — the transport side of PlayerPort (docs/specs/playback.md
// "Streaming seam"). Event payloads never carry the signed URL.
// ---------------------------------------------------------------------------

/** ABI error taxonomy plus the seam's terminal-transition kinds. */
export type ErrorKind =
  | 'transient'
  | 'rate-limit'
  | 'streams-capped'
  | 'cancelled'
  | 'released'
  | 'superseded'
  | 'evicted'
  | 'expired'
  | 'invalid-response'
  | 'no-result'
  | 'not-applicable'
  | 'not-found'
  | 'internal';

/** A stream whose head bytes are staged for attach. Opaque: prepared → attached → released. */
export type PreparedStream = {
  handle: string;
  mime: string;
  contentLength?: number;
  expiresAtMs?: number;
  bitrateKbps?: number;
};

export type PrepareOutcome =
  | { type: 'prepared'; stream: PreparedStream; attempt: AttemptSummary }
  | { type: 'failed'; kind: ErrorKind; message: string; attempt: AttemptSummary };

export type PrepareOutcomeEvent = {
  requestId: string;
  attemptId: string;
  outcome: PrepareOutcome;
};

export type PlaybackState =
  | 'idle'
  | 'buffering'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'failed';

export type PlaybackStatusEvent = {
  handle: string;
  attemptId: string;
  state: PlaybackState;
  positionMs: number;
  durationMs?: number;
  error?: { kind: ErrorKind; message: string };
};

export type PhaseMark = {
  name: string;
  /** Epoch ms (Date.now domain) at the mark, for JS joins. */
  atMs: number;
  /** Ms since the attach that owns this mark sequence. */
  sinceStartMs: number;
};

export type PhaseMarkEvent = PhaseMark & { handle: string };

type AuqwExpoEvents = {
  onResolveOutcome: (event: OutcomeEvent) => void;
  onRequestOutcome: (event: RequestOutcomeEvent) => void;
  onPrepareOutcome: (event: PrepareOutcomeEvent) => void;
  onPlaybackStatus: (event: PlaybackStatusEvent) => void;
  onPhaseMark: (event: PhaseMarkEvent) => void;
};

declare class AuqwExpoNative extends NativeModule<AuqwExpoEvents> {
  createHost(config: HostConfig): Promise<void>;
  loadPlugin(wasmBase64: string, manifestJson: string): Promise<string>;
  startResolve(pluginId: string, sourceRef: string): Promise<string>;
  startRequest(pluginId: string, capability: string, payloadJson: string): Promise<string>;
  cancel(requestId: string): void;
  runSpin(wasmBase64: string, manifestJson: string): Promise<SpinReport>;
  prepare(provider: string, sourceRef: string, attemptId: string, queueRev: number): Promise<string>;
  play(handle: string, attemptId: string, queueRev: number, positionMs?: number): Promise<void>;
  pause(): Promise<void>;
  seekTo(positionMs: number): Promise<void>;
  stop(): Promise<void>;
  cancelPrepare(requestId: string): Promise<void>;
  releaseStream(handle: string): Promise<void>;
  phaseMarks(handle: string): Promise<PhaseMark[]>;
  devAttachFile(path: string): Promise<string>;
}

const native = requireNativeModule<AuqwExpoNative>('AuqwExpo');

export function createHost(config: HostConfig): Promise<void> {
  return native.createHost(config);
}

export function loadPlugin(wasmBase64: string, manifestJson: string): Promise<string> {
  return native.loadPlugin(wasmBase64, manifestJson);
}

export function startResolve(pluginId: string, sourceRef: string): Promise<string> {
  return native.startResolve(pluginId, sourceRef);
}

/**
 * Begin a generic capability request; resolves with its request id.
 * `payload` is serialized to the plugin's input JSON — it must be an
 * object. The outcome arrives via `onRequestOutcome`.
 */
export function startRequest(pluginId: string, capability: string, payload: Record<string, unknown>): Promise<string> {
  return native.startRequest(pluginId, capability, JSON.stringify(payload));
}

export function cancel(requestId: string): void {
  native.cancel(requestId);
}

export function runSpin(wasmBase64: string, manifestJson: string): Promise<SpinReport> {
  return native.runSpin(wasmBase64, manifestJson);
}

/**
 * Speculative prepare: resolve + mint + bounded head fill, cancelable.
 * Resolves with the request id; the outcome arrives via
 * `onPrepareOutcome` and carries the stream handle for `play`.
 */
export function prepare(
  provider: string,
  sourceRef: string,
  attemptId: string,
  queueRev: number,
): Promise<string> {
  return native.prepare(provider, sourceRef, attemptId, queueRev);
}

/** Attach a prepared handle to the warm player and start playback. */
export function play(
  handle: string,
  attemptId: string,
  queueRev: number,
  positionMs?: number,
): Promise<void> {
  return native.play(handle, attemptId, queueRev, positionMs);
}

export function pause(): Promise<void> {
  return native.pause();
}

/** Seek in milliseconds; may target unfetched offsets (fetch-through). */
export function seekTo(positionMs: number): Promise<void> {
  return native.seekTo(positionMs);
}

export function stop(): Promise<void> {
  return native.stop();
}

export function cancelPrepare(requestId: string): Promise<void> {
  return native.cancelPrepare(requestId);
}

/** Idempotent: prepared → attached → released; release is a no-op otherwise. */
export function releaseStream(handle: string): Promise<void> {
  return native.releaseStream(handle);
}

/** Rust-side seam marks for a handle (durations + epoch joins). */
export function phaseMarks(handle: string): Promise<PhaseMark[]> {
  return native.phaseMarks(handle);
}

/**
 * Gate-0 file leg: attach a pushed local file through the SAME warm
 * player so the attach→rendered-first-frame floor is measured without
 * the seam. Dev instrumentation; resolves with the dev handle.
 */
export function devAttachFile(path: string): Promise<string> {
  return native.devAttachFile(path);
}

export function addResolveOutcomeListener(
  listener: (event: OutcomeEvent) => void,
): EventSubscription {
  return native.addListener('onResolveOutcome', listener);
}

export function addRequestOutcomeListener(
  listener: (event: RequestOutcomeEvent) => void,
): EventSubscription {
  return native.addListener('onRequestOutcome', listener);
}

export function addPrepareOutcomeListener(
  listener: (event: PrepareOutcomeEvent) => void,
): EventSubscription {
  return native.addListener('onPrepareOutcome', listener);
}

export function addPlaybackStatusListener(
  listener: (event: PlaybackStatusEvent) => void,
): EventSubscription {
  return native.addListener('onPlaybackStatus', listener);
}

export function addPhaseMarkListener(
  listener: (event: PhaseMarkEvent) => void,
): EventSubscription {
  return native.addListener('onPhaseMark', listener);
}
