import type {
  CancellationSignal,
  CancellationSource,
} from '../cancellation.ts';
import type { AppError } from '../errors.ts';
import { appError } from '../errors.ts';
import type { Result } from '../errors.ts';
import type { SourceRef } from '../domain.ts';
import type {
  PersistedState,
  StorageBatch,
  StoragePort,
} from '../ports/storage.ts';
import type { SessionHostCore } from './ready.ts';

/** The shared op failure shapes every session lane reports. */
export function internalError(): AppError {
  return appError('internal', 'an internal error occurred');
}

export function timeoutError(): AppError {
  return appError('timeout', 'operation deadline exceeded');
}

/** The generation guard every queued storage segment runs. */
export function supersededError(): AppError {
  return appError('superseded', 'session state was replaced');
}

export function sameRef(a: SourceRef | null, b: SourceRef | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.provider === b.provider && a.kind === b.kind && a.id === b.id;
}

export function saturatingAdd(a: number, b: number): number {
  const sum = a + b;
  return sum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : sum;
}

/** A deadline-bounded storage load under the op's own source. */
export function boundedLoad(
  host: Pick<SessionHostCore, 'deadline' | 'newContext' | 'withDeadline'>,
  storage: StoragePort,
  source: CancellationSource,
  prefix: string,
  signal?: CancellationSignal,
  deadlineMs?: number,
): Promise<Result<PersistedState>> {
  const at = deadlineMs ?? host.deadline();
  return host.withDeadline(
    () => storage.load(host.newContext(prefix, at, signal ?? source.signal)),
    at,
    source,
  );
}

/** A deadline-bounded storage commit under the op's own source. */
export function boundedCommit(
  host: Pick<SessionHostCore, 'deadline' | 'newContext' | 'withDeadline'>,
  storage: StoragePort,
  batch: StorageBatch,
  source: CancellationSource,
  deadlineMs?: number,
): Promise<Result<void>> {
  const at = deadlineMs ?? host.deadline();
  return host.withDeadline(
    () => storage.commit(batch, host.newContext('persist', at, source.signal)),
    at,
    source,
  );
}
