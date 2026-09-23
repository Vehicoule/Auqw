import {
  appError,
  createSyncEngine,
  err,
  isSyncCursor,
  ok,
} from '@auqw/application';
import type {
  CancellationSignal,
  LocalWrite,
  Result,
  SyncCursor,
  SyncEngineDeps,
  SyncEnginePort,
} from '@auqw/application';
import { MAX_SYNC_DOC_BYTES } from '../shared/contract.ts';

/**
 * Starting page for `exportDelta` — the engine's own `MAX_DELTA_ENTRIES`
 * cap; the byte-refit loop below shrinks it as needed.
 */
const MAX_EXPORT_PAGE = 10_000;

/**
 * The utility-side engine adapter — `createSyncEngine` returns a
 * `SyncEngine` (typed cursors, typed deltas), while the transport
 * consumes a `SyncEnginePort` (opaque string cursor, untyped docs).
 * This file is the only place the two shapes meet: the string cursor
 * is the JSON-serialized `SyncCursor`, `''` asks for the full
 * snapshot, and results ride the same JSON reparse the transport's
 * `isSyncDeltaDoc` backstop applies.
 *
 * `localChanges` is the engine's emission seam for renderer writes —
 * the `sync:localChanges` channel calls it. Each write re-validates
 * inside the engine (`validLocalWrite`: kind whitelist, field rule,
 * value check), so the channel only owes the bounded-shape check the
 * contract already runs.
 */
export type UtilitySyncEngine = {
  /** The transport-facing seam (string cursor ⇄ typed engine). */
  readonly port: SyncEnginePort;
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

  const port: SyncEnginePort = {
    async exportDelta(since: string, signal?: CancellationSignal) {
      let cursor: SyncCursor | undefined;
      if (since !== '') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(since);
        } catch {
          return err(
            appError('invalid-response', 'sync cursor is not JSON'),
          );
        }
        if (!isSyncCursor(parsed)) {
          return err(
            appError('invalid-response', 'sync cursor malformed'),
          );
        }
        cursor = parsed;
      }
      // The engine pages by entry count but the wire caps a doc at
      // MAX_SYNC_DOC_BYTES — refit by halving the entry limit until the
      // serialized doc ships, so a large log can never emit a page the
      // receiver rejects (which would strand the cursor forever).
      // 'more' stays honest: the engine sets it against the same limit
      // it just applied.
      let limit = MAX_EXPORT_PAGE;
      for (;;) {
        const delta = await engine.exportDelta(cursor, limit, signal);
        if (!delta.ok) {
          return delta;
        }
        const doc: unknown = JSON.parse(JSON.stringify(delta.value));
        if (
          Buffer.byteLength(JSON.stringify(doc), 'utf8') <=
          MAX_SYNC_DOC_BYTES
        ) {
          return ok(doc);
        }
        if (limit === 1) {
          return err(
            appError(
              'invalid-response',
              'single sync entry exceeds the wire bound',
            ),
          );
        }
        limit = Math.max(1, Math.floor(limit / 2));
      }
    },
    async applyDelta(
      delta: unknown,
      _deviceId: string,
      signal?: CancellationSignal,
    ) {
      // Entries carry their own device stamps — the transport's
      // deviceId is session metadata, not merge input.
      const applied = await engine.applyDelta(delta, signal);
      if (!applied.ok) {
        return applied;
      }
      return ok(JSON.parse(JSON.stringify(applied.value)));
    },
  };

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

  return ok({ port, localChanges });
}
