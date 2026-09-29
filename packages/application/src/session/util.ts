import type {
  CancellationSignal,
  CancellationSource,
  OperationContext,
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

type BoundedHost = Pick<
  SessionHostCore,
  'deadline' | 'newContext' | 'withDeadline'
>;

/**
 * One deadline-bounded port call under the op's own source: mints a
 * context at the (possibly overridden) deadline and runs the op
 * inside `withDeadline`.
 */
export function boundedOp<T>(
  host: BoundedHost,
  source: CancellationSource,
  prefix: string,
  op: (context: OperationContext) => Promise<Result<T>>,
  signal?: CancellationSignal,
  deadlineMs?: number,
): Promise<Result<T>> {
  const at = deadlineMs ?? host.deadline();
  return host.withDeadline(
    () => op(host.newContext(prefix, at, signal ?? source.signal)),
    at,
    source,
  );
}

/** A deadline-bounded storage load under the op's own source. */
export function boundedLoad(
  host: BoundedHost,
  storage: StoragePort,
  source: CancellationSource,
  prefix: string,
  signal?: CancellationSignal,
  deadlineMs?: number,
): Promise<Result<PersistedState>> {
  return boundedOp(
    host,
    source,
    prefix,
    (ctx) => storage.load(ctx),
    signal,
    deadlineMs,
  );
}

/** A deadline-bounded storage commit under the op's own source. */
export function boundedCommit(
  host: BoundedHost,
  storage: StoragePort,
  batch: StorageBatch,
  source: CancellationSource,
  deadlineMs?: number,
): Promise<Result<void>> {
  return boundedOp(
    host,
    source,
    'persist',
    (ctx) => storage.commit(batch, ctx),
    undefined,
    deadlineMs,
  );
}
