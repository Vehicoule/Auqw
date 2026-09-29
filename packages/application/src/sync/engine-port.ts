import type { CancellationSignal } from '../cancellation.ts';
import { appError, err, ok, type Result } from '../errors.ts';
import type { SyncEnginePort } from '../ports/sync-engine.ts';
import {
  isSyncCursor,
  isSyncDelta,
  type SyncCursor,
  type SyncEngine,
} from './sync-engine.ts';
import {
  MAX_SYNC_DOC_BYTES,
  utf8ByteLength,
} from './sync-wire.ts';

/**
 * SyncEngine → SyncEnginePort: the adapter a sync transport plugs in
 * (desktop utility/index.ts, and the loopback tests). The port's
 * `since` is the wire's opaque string — decoded here through the same
 * cursor shape both ends speak (without the LAN transport's own 256
 * char bound — see below).
 *
 * The wire caps a document at MAX_SYNC_DOC_BYTES while the engine
 * pages by entry count — exportDelta refits by halving the entry
 * limit until the serialized doc ships, so a large log can never emit
 * a page the receiver rejects (which would strand the cursor
 * forever). `more` stays honest: the engine sets it against the same
 * limit it just applied.
 */

/** Starting page for `exportDelta` — the engine's own entry cap. */
const MAX_EXPORT_PAGE = 10_000;

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
      let limit = MAX_EXPORT_PAGE;
      for (;;) {
        const delta = await engine.exportDelta(cursor, limit, signal);
        if (!delta.ok) {
          return delta;
        }
        const doc: unknown = JSON.parse(JSON.stringify(delta.value));
        if (
          utf8ByteLength(JSON.stringify(doc)) <= MAX_SYNC_DOC_BYTES
        ) {
          return ok(doc);
        }
        if (limit === 1) {
          return err(
            appError(
              'invalid-response',
              'sync: single sync entry exceeds the wire bound',
            ),
          );
        }
        limit = Math.max(1, Math.floor(limit / 2));
      }
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
      return ok(JSON.parse(JSON.stringify(applied.value)));
    },
    materialize(): readonly unknown[] {
      return JSON.parse(JSON.stringify(engine.materialize()));
    },
  };
}
