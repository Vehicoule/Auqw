import type { CancellationSignal } from '../cancellation.ts';
import { appError, err, type Result } from '../errors.ts';
import type { SyncEnginePort } from '../ports/sync-engine.ts';
import {
  isSyncDelta,
  type ApplyResult,
  type SyncEngine,
  type SyncDelta,
} from './sync-engine.ts';
import { sinceToCursor } from './sync-wire.ts';

/**
 * SyncEngine → SyncEnginePort: the adapter a `createSyncService`
 * transport plugs in (desktop utility/index.ts, and the loopback
 * tests). The port's `since` is the wire's opaque string — decoded
 * here through the same `sinceToCursor` the client's own export
 * encodes with, so both ends speak one cursor format.
 */
export function createSyncEnginePort(engine: SyncEngine): SyncEnginePort {
  return {
    async exportDelta(
      since: string,
      signal?: CancellationSignal,
    ): Promise<Result<SyncDelta>> {
      const cursor = sinceToCursor(since);
      if (cursor === null) {
        return err(
          appError('invalid-message', 'sync: malformed since cursor'),
        );
      }
      return engine.exportDelta(cursor, undefined, signal);
    },
    async applyDelta(
      delta: unknown,
      _deviceId: string,
      signal?: CancellationSignal,
    ): Promise<Result<ApplyResult>> {
      if (!isSyncDelta(delta)) {
        return err(appError('invalid-message', 'sync: malformed delta'));
      }
      return engine.applyDelta(delta, signal);
    },
  };
}
