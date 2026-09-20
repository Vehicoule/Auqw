import { requireNativeModule } from 'expo';
import type { EventSubscription, NativeModule } from 'expo-modules-core';

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

type PluginHostExpoEvents = {
  onResolveOutcome: (event: OutcomeEvent) => void;
  onRequestOutcome: (event: RequestOutcomeEvent) => void;
};

declare class PluginHostExpoNative extends NativeModule<PluginHostExpoEvents> {
  createHost(config: HostConfig): Promise<void>;
  loadPlugin(wasmBase64: string, manifestJson: string): Promise<string>;
  startResolve(pluginId: string, sourceRef: string): Promise<string>;
  startRequest(pluginId: string, capability: string, payloadJson: string): Promise<string>;
  cancel(requestId: string): void;
  runSpin(wasmBase64: string, manifestJson: string): Promise<SpinReport>;
}

const native = requireNativeModule<PluginHostExpoNative>('PluginHostExpo');

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
