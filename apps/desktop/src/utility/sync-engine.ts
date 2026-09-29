import {
  createSyncEngine,
  createSyncEnginePort,
  ok,
} from '@auqw/application';
import type {
  CancellationSignal,
  LocalWrite,
  Result,
  SyncEngine,
  SyncEngineDeps,
  SyncEnginePort,
} from '@auqw/application';

/**
 * The utility-side engine composition — `createSyncEngine` returns a
 * `SyncEngine` (typed cursors, typed deltas), while the transport
 * consumes a `SyncEnginePort` (opaque string cursor, untyped docs).
 * The port adapter itself — cursor codec + MAX_SYNC_DOC_BYTES
 * byte-refit — is the shared `createSyncEnginePort`; this file adds
 * the desktop-only `localChanges` seam for renderer writes.
 *
 * Each write re-validates inside the engine (`validLocalWrite`: kind
 * whitelist, field rule, value check), so the channel only owes the
 * bounded-shape check the contract already runs.
 */
export type UtilitySyncEngine = {
  /** The transport-facing seam (string cursor ⇄ typed engine). */
  readonly port: SyncEnginePort;
  /**
   * The full engine — the dialer's SyncClient dep needs it for
   * custody-adjacent identity work even though pair-only hosts never
   * run rounds in this direction.
   */
  readonly engine: SyncEngine;
  /**
   * One atomic local-write batch into the engine log. Returns the
   * serialized per-write results — 'rejected' outcomes ride inside
   * `ok`, not as errors.
   */
  readonly localChanges: (
    writes: readonly unknown[],
    signal?: CancellationSignal,
  ) => Promise<Result<unknown>>;
};

export async function createUtilitySyncEngine(
  deps: SyncEngineDeps,
): Promise<Result<UtilitySyncEngine>> {
  const built = await createSyncEngine(deps);
  if (!built.ok) {
    return built;
  }
  const engine = built.value;
  const port = createSyncEnginePort(engine);

  const localChanges = async (
    writes: readonly unknown[],
    signal?: CancellationSignal,
  ): Promise<Result<unknown>> => {
    const result = await engine.localChangeBatch(
      // The engine runs `validLocalWrite` per element — kind, field
      // rule, and value are all semantic-checked before stamping.
      writes as readonly LocalWrite[],
      signal,
    );
    if (!result.ok) {
      return result;
    }
    return ok(JSON.parse(JSON.stringify(result.value)));
  };

  return ok({ port, engine, localChanges });
}
