import type { OperationContext } from '../cancellation.ts';
import type { Result } from '../errors.ts';
import type { AttemptTrace } from './player.ts';

/** Sandboxed plugin execution; never throws by contract. */
export interface PluginRuntime {
  execute(
    request: {
      pluginId: string;
      capability: string;
      payload: Record<string, unknown>;
    },
    context: OperationContext,
  ): Promise<Result<{ result: unknown; attempt: AttemptTrace }>>;
  cancel(requestId: string): void;
}

export interface IdPort {
  next(prefix: string): string;
}
