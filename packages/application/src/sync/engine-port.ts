import type { CancellationSignal } from '../cancellation.ts';
import { appError, err, ok, type Result } from '../errors.ts';
import type { SyncEnginePort } from '../ports/sync-engine.ts';
import { exportFittedDeltaDoc } from './delta-docs.ts';
import {
  isSyncCursor,
  isSyncDelta,
  type SyncCursor,
  type SyncEngine,
} from './sync-engine.ts';

/**
 * SyncEngine → SyncEnginePort: the adapter a sync transport plugs in
 * (desktop utility/index.ts, and the loopback tests). The port's
 * `since` is the wire's opaque string — decoded here through the same
 * cursor shape both ends speak (without the LAN transport's own 256
 * char bound — see below).
 *
 * The wire caps a document at MAX_SYNC_DOC_BYTES while the engine
 * pages by entry count — `exportFittedDeltaDoc` refits by halving the
 * entry limit until the serialized doc ships, so a large log can never
 * emit a page the receiver rejects (which would strand the cursor
 * forever). `more` stays honest: the engine sets it against the same
 * limit it just applied.
 */

function jsonCursor(since: string): SyncCursor | null {
  if (since === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(since);
    return isSyncCursor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createSyncEnginePort(engine: SyncEngine): SyncEnginePort {
  return {
    deviceId: engine.deviceId,
    async exportDelta(
      since: string,
      signal?: CancellationSignal,
    ): Promise<Result<unknown>> {
      // LAN's 256-char `since` bound does not apply here — the desktop
      // clipboard exporter admits coverage cursors up to its own IPC
      // limit (~80k chars, multi-device paginations outgrow 256 fast).
      // Decode with the cursor shape guard directly; `sinceToCursor`
      // stays the transport-side bound where LAN requests validate.
      const cursor = jsonCursor(since);
      if (cursor === null) {
        // The desktop's shipped kind — the wire echoes it verbatim to
        // the peer, so the adapter keeps it rather than reclassifying.
        return err(
          appError('invalid-response', 'sync cursor malformed'),
        );
      }
      const fitted = await exportFittedDeltaDoc(
        engine.exportDelta,
        cursor,
        signal,
        'sync: single sync entry exceeds the wire bound',
      );
      if (!fitted.ok) {
        return fitted;
      }
      // The fitted doc is freshly built per call — the JSON round-trip
      // clone added a full serialize+parse per page for nothing.
      return ok(fitted.value);
    },
    async applyDelta(
      delta: unknown,
      deviceId?: string,
      signal?: CancellationSignal,
    ): Promise<Result<unknown>> {
      if (!isSyncDelta(delta)) {
        return err(appError('invalid-message', 'sync: malformed delta'));
      }
      const applied = await engine.applyDelta(delta, deviceId, signal);
      if (!applied.ok) {
        return applied;
      }
      // Outcomes and per-record snapshots are rebuilt per apply —
      // skipping the clone halves the allocation on every round.
      return ok(applied.value);
    },
    materialize(): readonly unknown[] {
      // Fresh array of freshly built records per call; consumers
      // treat it read-only.
      return engine.materialize();
    },
  };
}
