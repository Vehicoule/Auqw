import type { OperationContext } from '../cancellation.ts';
import type { Result } from '../errors.ts';
import type { Recording, Settings, TrackLike } from '../domain.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import type { AttemptTrace } from './player.ts';

export type PersistedState = {
  readonly recordings: readonly Recording[];
  readonly likes: readonly TrackLike[];
  readonly queue: QueueSnapshot;
  readonly settings: Settings;
};

export type StorageBatch = {
  readonly recordings?: readonly Recording[];
  readonly likes?: readonly TrackLike[];
  readonly queue?: QueueSnapshot;
  readonly settings?: Settings;
  readonly attempts?: readonly AttemptTrace[];
};

/** Commits are atomic; the port never throws by contract. */
export interface StoragePort {
  load(context: OperationContext): Promise<Result<PersistedState>>;
  commit(
    batch: StorageBatch,
    context: OperationContext,
  ): Promise<Result<void>>;
  /**
   * Diagnostics only: newest-first attempt traces, capped server-side.
   * Traces are excluded from PersistedState. `limit` must be a safe
   * integer in 1..500.
   */
  loadAttempts(
    limit: number,
    context: OperationContext,
  ): Promise<Result<readonly AttemptTrace[]>>;
}
