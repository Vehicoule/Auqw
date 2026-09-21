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
  /** Plugin KV file; defaults to the app-private files dir. */
  statePath?: string | undefined;
  /** Stream-seam sparse cache dir; defaults to the app-private cache dir. */
  streamPath?: string | undefined;
  /** Container preference order for playback.resolve — the surface's
   * prefer hint (webm-first Android/desktop, mp4-only iOS); omit for
   * the guest's own default. */
  prefer?: readonly string[] | undefined;
  /** Initial OAuth access token for `Authorization: Bearer` on
   * InnerTube calls — session trust. Omit for anonymous; refresh via
   * {@link setAuthToken}. Never logged. */
  authToken?: string | undefined;
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
  itag?: number;
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

/** ABI error taxonomy plus the seam's terminal-transition kinds —
 * mirrors `packages/application/src/errors.ts` (wire kinds surface
 * verbatim from the host, so the union must cover the whole set). */
export type ErrorKind =
  | 'no-result'
  | 'not-applicable'
  | 'unsupported'
  | 'auth-required'
  | 'auth-expired'
  | 'rate-limit'
  | 'transient'
  | 'expired-resource'
  | 'permission-denied'
  | 'invalid-response'
  | 'timeout'
  | 'cancelled'
  | 'budget-exceeded'
  | 'guest-trap'
  | 'invalid-message'
  | 'artifact-rejected'
  | 'streams-capped'
  | 'released'
  | 'superseded'
  | 'evicted'
  | 'expired'
  | 'not-found'
  | 'unavailable'
  | 'internal';

/** A stream whose head bytes are staged for attach. Opaque: prepared → attached → released. */
export type PreparedStream = {
  handle: string;
  mime: string;
  itag?: number;
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
  queueRev: number;
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
  queueRev: number;
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

export type PhaseMarkEvent = PhaseMark & {
  handle: string;
  attemptId: string;
  queueRev: number;
};

/**
 * The seam's flat lifecycle record for one handle — epochs in ms
 * (`prepareStartedMs`, `firstByteMs`, `headReadyMs`, `attachMs`) plus
 * durations (`resolveMs` of the minting resolve, `remintMs` of the
 * last re-mint). Diagnostics; available after terminal states.
 */
export type StreamPhaseMarks = {
  prepareStartedMs: number;
  resolveMs?: number;
  remintMs?: number;
  firstByteMs?: number;
  headReadyMs?: number;
  attachMs?: number;
};

/** One immutable projected queue item — never carries a signed URL. */
export type QueueProjectionItem = {
  occurrenceId: string;
  provider: string | null;
  sourceRef: string | null;
  title: string;
  artist: string | null;
  artworkUrl: string | null;
};

/**
 * The application's identified queue revision, installed whole: the
 * service moves only a cursor within it and reports
 * `queue-transition` events for reconciliation.
 */
export type QueueProjection = {
  projectionId: string;
  queueRev: number;
  currentOccurrenceId: string | null;
  positionMs: number;
  mode: 'stopped' | 'paused' | 'playing';
  items: QueueProjectionItem[];
};

export type QueueTransitionReason = 'ended' | 'remote-next' | 'remote-previous';

/** Service-reported cursor move inside the installed projection. */
export type QueueTransitionEvent = {
  projectionId: string;
  projectedQueueRev: number;
  fromOccurrenceId: string | null;
  toOccurrenceId: string | null;
  reason: QueueTransitionReason;
  positionMs: number;
  identity: { attemptId: string; queueRev: number } | null;
  handle: string | null;
};

// ---- TagReaderPort surface (slice 3 local files) ----

export type TagReaderEntry = {
  docId: string;
  name: string;
  size: number;
  mime: string;
};

export type TagReaderFingerprint = {
  docId: string;
  fingerprint: string;
};

export type TagReaderTags = {
  docId: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  genre: string | null;
};

type AuqwExpoEvents = {
  onResolveOutcome: (event: OutcomeEvent) => void;
  onRequestOutcome: (event: RequestOutcomeEvent) => void;
  onPrepareOutcome: (event: PrepareOutcomeEvent) => void;
  onPlaybackStatus: (event: PlaybackStatusEvent) => void;
  onPhaseMark: (event: PhaseMarkEvent) => void;
  onQueueTransition: (event: QueueTransitionEvent) => void;
};

declare class AuqwExpoNative extends NativeModule<AuqwExpoEvents> {
  createHost(config: HostConfig): Promise<void>;
  setAuthToken(token: string | null): void;
  loadPlugin(wasmBase64: string, manifestJson: string): Promise<string>;
  startResolve(pluginId: string, sourceRef: string): Promise<string>;
  startRequest(pluginId: string, capability: string, payloadJson: string): Promise<string>;
  cancel(requestId: string): void;
  runSpin(wasmBase64: string, manifestJson: string): Promise<SpinReport>;
  prepare(provider: string, sourceRef: string, attemptId: string, queueRev: number): Promise<string>;
  prepareLocal(path: string, mime?: string | null): Promise<string>;
  play(handle: string, attemptId: string, queueRev: number, positionMs?: number): Promise<void>;
  pause(): Promise<void>;
  seekTo(positionMs: number): Promise<void>;
  stop(): Promise<void>;
  cancelPrepare(requestId: string): Promise<void>;
  releaseStream(handle: string): Promise<void>;
  phaseMarks(handle: string): Promise<StreamPhaseMarks>;
  setQueueProjection(projection: QueueProjection): Promise<void>;
  tagPickFolder(): Promise<{ treeUri: string; label: string }>;
  tagEnumerate(
    treeUri: string,
  ): Promise<readonly TagReaderEntry[]>;
  tagFingerprint(
    treeUri: string,
    docIds: readonly string[],
  ): Promise<readonly (TagReaderFingerprint | null)[]>;
  tagRead(
    treeUri: string,
    docIds: readonly string[],
  ): Promise<readonly (TagReaderTags | null)[]>;
  docUri(treeUri: string, docId: string): string;
  devAttachFile(path: string): Promise<string>;
  devPrepareUrl(url: string, mime: string, contentLength?: number, remintable?: boolean): Promise<string>;
}

const native = requireNativeModule<AuqwExpoNative>('AuqwExpo');

export function createHost(config: HostConfig): Promise<void> {
  return native.createHost(config);
}

/**
 * Set or clear the OAuth access token merged as `access_token` into
 * every session-trust payload (`playback.resolve`,
 * `playback.candidates`, `radio.seed`) — the `Authorization: Bearer`
 * source on InnerTube calls. Prepared sessions read the same slot at
 * re-mint, so a refreshed token reaches mid-stream recovery.
 */
export function setAuthToken(token: string | null): void {
  native.setAuthToken(token);
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

/**
 * provider:'local' attach — registers an `lf-*` handle for a
 * device-owned file path or content URI. No stream session is
 * created: `play`/`releaseStream`/`cancelPrepare` resolve the handle
 * locally (release/cancel are bookkeeping no-ops).
 */
export function prepareLocal(
  path: string,
  mime?: string | null,
): Promise<string> {
  return native.prepareLocal(path, mime ?? null);
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

/** Rust-side seam marks for a handle (flat record: epochs + durations). */
export function phaseMarks(handle: string): Promise<StreamPhaseMarks> {
  return native.phaseMarks(handle);
}

/**
 * Install one immutable identified queue revision for background
 * execution; the service moves only a cursor inside it and reports
 * `onQueueTransition` events.
 */
export function setQueueProjection(projection: QueueProjection): Promise<void> {
  return native.setQueueProjection(projection);
}

/**
 * Gate-0 file leg: attach a pushed local file through the SAME warm
 * player so the attach→rendered-first-frame floor is measured without
 * the seam. Dev instrumentation; resolves with the dev handle.
 */
export function devAttachFile(path: string): Promise<string> {
  return native.devAttachFile(path);
}

/**
 * Dev-gate URL leg: prepare a real seam session for a bare URL —
 * skips only the guest resolve, so prepare→attach→render still runs
 * through the sparse store, pump, and fetch-through. Resolves with
 * the stream handle for `play`. Dev instrumentation.
 */
export function devPrepareUrl(
  url: string,
  mime: string,
  contentLength?: number,
  remintable?: boolean,
): Promise<string> {
  return native.devPrepareUrl(url, mime, contentLength, remintable);
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

export function addQueueTransitionListener(
  listener: (event: QueueTransitionEvent) => void,
): EventSubscription {
  return native.addListener('onQueueTransition', listener);
}

// ---- TagReader wrappers ----

/**
 * SAF folder pick → persistable grant + label. Rejects `no-result`
 * when the user cancels.
 */
export function tagPickFolder(): Promise<{ treeUri: string; label: string }> {
  return native.tagPickFolder();
}

export function tagEnumerate(
  treeUri: string,
): Promise<readonly TagReaderEntry[]> {
  return native.tagEnumerate(treeUri);
}

export function tagFingerprint(
  treeUri: string,
  docIds: readonly string[],
): Promise<readonly (TagReaderFingerprint | null)[]> {
  return native.tagFingerprint(treeUri, docIds);
}

export function tagRead(
  treeUri: string,
  docIds: readonly string[],
): Promise<readonly (TagReaderTags | null)[]> {
  return native.tagRead(treeUri, docIds);
}

export function docUri(treeUri: string, docId: string): string {
  return native.docUri(treeUri, docId);
}
