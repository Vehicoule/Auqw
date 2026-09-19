import { requireNativeModule } from 'expo';
import type { EventSubscription, NativeModule } from 'expo-modules-core';

export type HostConfig = {
  fuelPerEntry: number;
  fuelTotal: number;
};

export type AttemptSummary = {
  requestId: string;
  steps: number;
  httpCalls: number;
  bytes: number;
  fuelUsed: number;
  elapsedMs: number;
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

export type SpinReport = {
  elapsedMs: number;
  fuelUsed: number;
  kind: string;
};

export type OutcomeEvent = {
  requestId: string;
  outcome: ResolveOutcome;
};

type PluginHostExpoEvents = {
  onResolveOutcome: (event: OutcomeEvent) => void;
};

declare class PluginHostExpoNative extends NativeModule<PluginHostExpoEvents> {
  createHost(config: HostConfig): Promise<void>;
  loadPlugin(wasmBase64: string, manifestJson: string): Promise<string>;
  startResolve(pluginId: string, sourceRef: string): Promise<string>;
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
