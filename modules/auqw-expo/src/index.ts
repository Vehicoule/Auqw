import { requireNativeModule } from 'expo';
import type { EventSubscription, NativeModule } from 'expo-modules-core';
import { CodedError } from 'expo-modules-core';

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

export type GuestLogSummary = { level: string; message: string };

export type AttemptSummary = {
  requestId: string;
  steps: number;
  httpCalls: number;
  bytes: number;
  fuelUsed: number;
  elapsedMs: number;
  httpTrace: readonly HttpTraceSummary[];
  guestLog: readonly GuestLogSummary[];
};

/** Outcome of a generic capability request: the raw result JSON plus attempt. */
export type RequestOutcome =
  | { type: 'succeeded'; resultJson: string; attempt: AttemptSummary }
  | { type: 'failed'; kind: string; message: string; attempt: AttemptSummary };

export type RequestOutcomeEvent = { requestId: string; outcome: RequestOutcome };

// ---------------------------------------------------------------------------
// Player surface — the transport side of PlayerPort (docs/specs/playback.md
// "Streaming seam"). Event payloads never carry the signed URL.
// ---------------------------------------------------------------------------

/** ABI error taxonomy plus the seam's terminal-transition kinds —
 * mirrors `packages/application/src/errors.ts` (wire kinds surface
 * verbatim from the host, so the union must cover the whole set). */
export type ErrorKind =
  | 'no-result' | 'not-applicable' | 'unsupported' | 'auth-required'
  | 'auth-expired' | 'rate-limit' | 'transient' | 'provider-wall'
  | 'expired-resource'
  | 'permission-denied' | 'invalid-response' | 'timeout' | 'cancelled'
  | 'budget-exceeded' | 'guest-trap' | 'invalid-message' | 'artifact-rejected'
  | 'streams-capped' | 'released' | 'superseded' | 'evicted'
  | 'expired' | 'not-found' | 'unavailable' | 'storage-full' | 'internal';

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
  'idle' | 'buffering' | 'ready' | 'playing' | 'paused' | 'ended' | 'failed';

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

export type PhaseMarkEvent = PhaseMark & { handle: string; attemptId: string; queueRev: number };

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
  /** Session failed-mark — forward moves skip this row, backward
   * moves still reach it. Absent means unmarked. */
  skipsForward?: boolean | undefined;
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
  /**
   * Cursor repeat rule — `all` wraps tail→head (and head
   * remote-previous→tail), `one` replays the cursor item on `ended`.
   */
  repeat: 'off' | 'all' | 'one';
  /**
   * The dealt walk order: a permutation of `items` indices the cursor
   * steps through — the identity when shuffle is off. Canonical item
   * order never changes; only the walk does (decisions.md).
   */
  order: readonly number[];
  items: readonly QueueProjectionItem[];
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
  /**
   * DocumentsContract COLUMN_LAST_MODIFIED (ms); null when the
   * provider reports none. Older native builds may omit the key.
   */
  modifiedMs?: number | null;
};

export type TagReaderFingerprint = { docId: string; fingerprint: string };

export type TagReaderTags = {
  docId: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  genre: string | null;
};

type AuqwExpoEvents = {
  onRequestOutcome: (event: RequestOutcomeEvent) => void;
  onPrepareOutcome: (event: PrepareOutcomeEvent) => void;
  onPlaybackStatus: (event: PlaybackStatusEvent) => void;
  onPhaseMark: (event: PhaseMarkEvent) => void;
  onQueueTransition: (event: QueueTransitionEvent) => void;
  onConnectivityChanged: (event: ConnectivityChangedEvent) => void;
  onSyncSocketData: (event: SyncSocketDataEvent) => void;
  onSyncSocketClosed: (event: SyncSocketClosedEvent) => void;
  onWaveformPeaksCoarse: (event: WaveformPeaksCoarseEvent) => void;
};

declare class AuqwExpoNative extends NativeModule<AuqwExpoEvents> {
  createHost(config: HostConfig): Promise<void>;
  setAuthToken(token: string | null): void;
  /**
   * Waveform-peak extraction on the borrowed stream handle — Android
   * only (iOS registers the host surface alone, so the property is
   * absent there and the seam wrapper rejects 'unavailable').
   * Resolves with `count` flat `[up, down]` raw RMS window pairs —
   * the shared `PeakWindow` shape before JS-side normalization.
   */
  waveformPeaks(
    requestId: string,
    handle: string,
    count: number,
    maxBytes: number,
    provisionalCap: boolean,
  ): Promise<number[]>;
  waveformPeaksCancel(requestId: string): void;
  /**
   * Live PO-token provider update — resolves read the host's slot
   * at invocation spawn, so a pairing or unpairing landing after
   * createHost applies without a host recreate. null restores the
   * anonymous resolve ladder.
   */
  setPotProvider(url: string | null): void;
  loadPlugin(wasmBase64: string, manifestJson: string): Promise<string>;
  startRequest(pluginId: string, capability: string, payloadJson: string): Promise<string>;
  cancel(requestId: string): void;
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
  downloadsActiveChanged(active: number): Promise<void>;
  devPrepareUrl(url: string, mime: string, contentLength?: number, remintable?: boolean): Promise<string>;
  connectivitySnapshot(): Promise<ConnectivityChangedEvent>;
  connectivityWatch(): void;
  connectivityUnwatch(): void;
  syncConnect(
    socketId: string,
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<{ remoteAddress: string | null }>;
  syncSend(socketId: string, data: string): Promise<void>;
  syncClose(socketId: string): Promise<void>;
  syncDestroy(socketId: string): Promise<void>;
  /** Synchronous — the JS crypto suite takes CSPRNG bytes inline. */
  syncRandomBytes(length: number): string;
  /** Android 12+ Material You stops — null below API 31 / absent on
      iOS (the JS wrapper resolves null there). */
  systemTonalPalette(): Promise<SystemTonalPalette | null>;
  /**
   * Sideloaded-APK update install — Android only. 'installing' = the
   * system package-installer sheet is up; 'needs-permission' = the
   * unknown-sources switch still refuses installs and the module
   * opened this app's page of that settings surface instead (the
   * caller toasts, never claims an install ran).
   */
  installApk(path: string): Promise<InstallApkResult>;
  /** `Build.SUPPORTED_ABIS`, preference order — Android only (the
      JS wrapper reads an absent seam as no ABI data). */
  supportedAbis(): string[];
}

/** The Android 12+ Material You tones an 'adaptive' theme derives from. */
export type SystemTonalPalette = {
  readonly neutral1_50: string;
  readonly neutral1_900: string;
  readonly accent1_200: string;
  readonly accent1_600: string;
};

const native = requireNativeModule<AuqwExpoNative>('AuqwExpo');

/**
 * The player + dev seam functions are Android-first: the iOS module
 * registers the host surface alone, so those properties are absent
 * there and a bare call throws a raw TypeError that escapes the error
 * taxonomy. `seam` is the honest view — absent functions reject with a
 * coded 'unavailable' error, the same channel native `CodedException`
 * rejections take (the code carries the kind).
 */
const seam = native as Partial<AuqwExpoNative>;

function seamError(name: string): CodedError {
  return new CodedError(
    'unavailable',
    `auqw-expo '${name}' is unavailable on this platform`,
  );
}

function seamUnavailable<T>(name: string): Promise<T> {
  return Promise.reject(seamError(name));
}

function seamThrow(name: string): never {
  throw seamError(name);
}

export function createHost(config: HostConfig): Promise<void> { return native.createHost(config); }

/**
 * Set or clear the OAuth access token merged as `access_token` into
 * every session-trust payload (`playback.resolve`,
 * `playback.candidates`, `radio.seed`) — the `Authorization: Bearer`
 * source on InnerTube calls. Prepared sessions read the same slot at
 * re-mint, so a refreshed token reaches mid-stream recovery.
 */
export function setAuthToken(token: string | null): void { native.setAuthToken(token); }

/**
 * Set or clear the bgutil-compatible PO-token provider URL on the
 * running host (`POST {url}/get_pot`). Resolves read the slot at
 * invocation spawn — a mid-session pairing or a welcome-carried
 * endpoint refresh reaches the host without a recreate, and `null`
 * restores the anonymous ladder. Never logged.
 */
export function setPotProvider(url: string | null): void { native.setPotProvider(url); }

export function loadPlugin(wasmBase64: string, manifestJson: string): Promise<string> {
  return native.loadPlugin(wasmBase64, manifestJson);
}

/**
 * Begin a generic capability request; resolves with its request id.
 * `payload` is serialized to the plugin's input JSON — it must be an
 * object. The outcome arrives via `onRequestOutcome`.
 */
export function startRequest(pluginId: string, capability: string, payload: Record<string, unknown>): Promise<string> {
  return native.startRequest(pluginId, capability, JSON.stringify(payload));
}

export function cancel(requestId: string): void { native.cancel(requestId); }

/**
 * Speculative prepare: resolve + mint + bounded head fill, cancelable.
 * Resolves with the request id; the outcome arrives via
 * `onPrepareOutcome` and carries the stream handle for `play`.
 */
export function prepare(provider: string, sourceRef: string, attemptId: string, queueRev: number): Promise<string> {
  return seam.prepare?.(provider, sourceRef, attemptId, queueRev) ?? seamUnavailable('prepare');
}

/**
 * provider:'local' attach — registers an `lf-*` handle for a
 * device-owned file path or content URI. No stream session is
 * created: `play`/`releaseStream`/`cancelPrepare` resolve the handle
 * locally (release/cancel are bookkeeping no-ops).
 */
export function prepareLocal(path: string, mime?: string | null): Promise<string> {
  return native.prepareLocal(path, mime ?? null);
}

/** Attach a prepared handle to the warm player and start playback. */
export function play(handle: string, attemptId: string, queueRev: number, positionMs?: number): Promise<void> {
  return seam.play?.(handle, attemptId, queueRev, positionMs) ?? seamUnavailable('play');
}

export function pause(): Promise<void> { return seam.pause?.() ?? seamUnavailable('pause'); }

/** Seek in milliseconds; may target unfetched offsets (fetch-through). */
export function seekTo(positionMs: number): Promise<void> {
  return seam.seekTo?.(positionMs) ?? seamUnavailable('seekTo');
}

export function stop(): Promise<void> { return seam.stop?.() ?? seamUnavailable('stop'); }

export function cancelPrepare(requestId: string): Promise<void> {
  return seam.cancelPrepare?.(requestId) ?? seamUnavailable('cancelPrepare');
}

/** Idempotent: prepared → attached → released; release is a no-op otherwise. */
export function releaseStream(handle: string): Promise<void> {
  return seam.releaseStream?.(handle) ?? seamUnavailable('releaseStream');
}

/** Rust-side seam marks for a handle (flat record: epochs + durations). */
export function phaseMarks(handle: string): Promise<StreamPhaseMarks> {
  return seam.phaseMarks?.(handle) ?? seamUnavailable('phaseMarks');
}

/**
 * Waveform peaks off the playing stream's own bytes — Android only;
 * iOS rejects 'unavailable' so the caller keeps the seeded pattern.
 * Resolves with `count` flat `[up, down]` raw RMS window pairs
 * (`PeakWindow` magnitudes pre-normalization); rejects with the
 * application error kinds the adapter maps. The handle is borrowed:
 * extraction only ever issues positional `streamRead`s.
 */
export function waveformPeaks(
  requestId: string, handle: string, count: number, maxBytes: number, provisionalCap: boolean,
): Promise<readonly number[]> {
  return seam.waveformPeaks?.(requestId, handle, count, maxBytes, provisionalCap) ??
    seamUnavailable('waveformPeaks');
}

/** Cancels a running `waveformPeaks` sweep — its promise rejects 'cancelled'. */
export function waveformPeaksCancel(requestId: string): void { seam.waveformPeaksCancel?.(requestId); }

/** Coarse-but-measured profile while the refinement sweep still runs —
 *  flat `[up, down]` pairs of the same length the request asked for,
 *  sent at most once per `requestId`. */
export type WaveformPeaksCoarseEvent = { requestId: string; peaks: readonly number[] };

export function addWaveformPeaksCoarseListener(listener: (event: WaveformPeaksCoarseEvent) => void): EventSubscription {
  return native.addListener('onWaveformPeaksCoarse', listener);
}

/**
 * Install one immutable identified queue revision for background
 * execution; the service moves only a cursor inside it and reports
 * `onQueueTransition` events.
 */
export function setQueueProjection(projection: QueueProjection): Promise<void> {
  return seam.setQueueProjection?.(projection) ?? seamUnavailable('setQueueProjection');
}

/** Material You stops for 'adaptive' — Android-only seam; resolves
    null on iOS (flag-only there) and below API 31. */
export function systemTonalPalette(): Promise<SystemTonalPalette | null> {
  return seam.systemTonalPalette?.() ?? Promise.resolve(null);
}

/**
 * Slice-3 keep-alive: the DownloadManager reports its live
 * active-transfer count; >0 runs the `dataSync` foreground service
 * (notification channel 'auqw-downloads'), 0 stops it. The service
 * carries no state — a process kill just means the next init resumes
 * rows from their committed offsets.
 */
export function downloadsActiveChanged(active: number): Promise<void> {
  return native.downloadsActiveChanged(active);
}

/**
 * Gate-0 file leg: attach a pushed local file through the SAME warm
 * player so the attach→rendered-first-frame floor is measured without
 * the seam. Dev instrumentation; resolves with the dev handle.
 */
export function devAttachFile(path: string): Promise<string> {
  return seam.devAttachFile?.(path) ?? seamUnavailable('devAttachFile');
}

/**
 * Dev-gate URL leg: prepare a real seam session for a bare URL —
 * skips only the guest resolve, so prepare→attach→render still runs
 * through the sparse store, pump, and fetch-through. Resolves with
 * the stream handle for `play`. Dev instrumentation.
 */
export function devPrepareUrl(url: string, mime: string, contentLength?: number, remintable?: boolean): Promise<string> {
  return seam.devPrepareUrl?.(url, mime, contentLength, remintable) ?? seamUnavailable('devPrepareUrl');
}

export function addRequestOutcomeListener(listener: (event: RequestOutcomeEvent) => void): EventSubscription {
  return native.addListener('onRequestOutcome', listener);
}

export function addPrepareOutcomeListener(listener: (event: PrepareOutcomeEvent) => void): EventSubscription {
  return native.addListener('onPrepareOutcome', listener);
}

export function addPlaybackStatusListener(listener: (event: PlaybackStatusEvent) => void): EventSubscription {
  return native.addListener('onPlaybackStatus', listener);
}

export function addPhaseMarkListener(listener: (event: PhaseMarkEvent) => void): EventSubscription {
  return native.addListener('onPhaseMark', listener);
}

export function addQueueTransitionListener(listener: (event: QueueTransitionEvent) => void): EventSubscription {
  return native.addListener('onQueueTransition', listener);
}

/** {online, metered} — snapshot read and the change-edge payload. */
export type ConnectivityChangedEvent = { online: boolean; metered: boolean };

export function connectivitySnapshot(): Promise<ConnectivityChangedEvent> {
  return native.connectivitySnapshot();
}

/** Start the NetworkCallback — emits a baseline edge immediately. */
export function connectivityWatch(): void { native.connectivityWatch(); }

export function connectivityUnwatch(): void { native.connectivityUnwatch(); }

export function addConnectivityChangedListener(listener: (event: ConnectivityChangedEvent) => void): EventSubscription {
  return native.addListener('onConnectivityChanged', listener);
}

// ---- TagReader wrappers ----

/**
 * SAF folder pick → persistable grant + label. Rejects `no-result`
 * when the user cancels.
 */
export function tagPickFolder(): Promise<{ treeUri: string; label: string }> {
  return native.tagPickFolder();
}

export function tagEnumerate(treeUri: string): Promise<readonly TagReaderEntry[]> {
  return native.tagEnumerate(treeUri);
}

export function tagFingerprint(treeUri: string, docIds: readonly string[]): Promise<readonly (TagReaderFingerprint | null)[]> {
  return native.tagFingerprint(treeUri, docIds);
}

export function tagRead(treeUri: string, docIds: readonly string[]): Promise<readonly (TagReaderTags | null)[]> {
  return native.tagRead(treeUri, docIds);
}

export function docUri(treeUri: string, docId: string): string { return native.docUri(treeUri, docId); }

/**
 * Whether the platform's native module actually exposes the tag
 * reader — the SAF picker/enumerate surface is Android-only today
 * (iOS carries the host surface), so UI must not offer local-folder
 * actions where they'd fail silently.
 */
export function hasTagReader(): boolean {
  return typeof seam.tagPickFolder === 'function' && typeof seam.tagEnumerate === 'function';
}

// ---- Sync-socket wrappers (LAN sync client, docs/specs/sync.md) ----

/** Frame bytes cross the bridge as base64 — never raw binary JSON. */
export type SyncSocketDataEvent = { socketId: string; data: string };

/** reason: 'peer' = remote FIN, 'error' = socket fault, 'local' = destroyed. */
export type SyncSocketClosedEvent = { socketId: string; reason: string };

export function syncConnect(socketId: string, host: string, port: number, timeoutMs: number): Promise<{ remoteAddress: string | null }> {
  return seam.syncConnect?.(socketId, host, port, timeoutMs) ?? seamUnavailable('syncConnect');
}

export function syncSend(socketId: string, data: string): Promise<void> {
  return seam.syncSend?.(socketId, data) ?? seamUnavailable('syncSend');
}

/** Graceful half-close — queued writes flush, then FIN. */
export function syncClose(socketId: string): Promise<void> {
  return seam.syncClose?.(socketId) ?? seamUnavailable('syncClose');
}

/** Immediate teardown — pending writes may drop. */
export function syncDestroy(socketId: string): Promise<void> {
  return seam.syncDestroy?.(socketId) ?? seamUnavailable('syncDestroy');
}

/** SecureRandom bytes as base64 — the sync crypto's CSPRNG source.
 * Synchronous like the noble calls that consume it. */
export function syncRandomBytes(length: number): string {
  return seam.syncRandomBytes?.(length) ?? seamThrow('syncRandomBytes');
}

export function addSyncSocketDataListener(listener: (event: SyncSocketDataEvent) => void): EventSubscription {
  return native.addListener('onSyncSocketData', listener);
}

export function addSyncSocketClosedListener(listener: (event: SyncSocketClosedEvent) => void): EventSubscription {
  return native.addListener('onSyncSocketClosed', listener);
}

/**
 * Whether the platform's module carries the LAN-sync socket surface —
 * Android-only today; on iOS the seam rejects 'unavailable' and the
 * UI should report sync as off rather than offering a dead dial.
 */
export function hasSyncSocket(): boolean {
  return typeof seam.syncConnect === 'function' && typeof seam.syncRandomBytes === 'function';
}

// ---- Update install (sideloaded APK, docs/decisions.md) ----

export type InstallApkResult = {
  readonly status: 'installing' | 'needs-permission';
};

/** Hand the downloaded APK to the system package installer. */
export function installApk(path: string): Promise<InstallApkResult> {
  return seam.installApk?.(path) ?? seamUnavailable('installApk');
}

/**
 * Whether the platform's module carries the APK-install leg —
 * Android only; everywhere else the update banner advertises 'open'
 * (the release page) instead of 'install'.
 */
export function hasApkInstaller(): boolean {
  return typeof seam.installApk === 'function';
}

/**
 * The device's ABI preference list (`Build.SUPPORTED_ABIS`) — the
 * update check picks its APK against it. An absent seam (iOS, web
 * harness) reports no ABIs, so the pick refuses a foreign-ABI APK
 * rather than guessing.
 */
export function supportedAbis(): readonly string[] {
  return seam.supportedAbis?.() ?? [];
}
