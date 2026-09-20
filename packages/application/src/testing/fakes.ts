import type { CancellationSignal } from '../cancellation.ts';
import type { OperationContext } from '../cancellation.ts';
import type { AppError, Result } from '../errors.ts';
import { appError, ok } from '../errors.ts';
import type { SourceRef, TrackMetadata } from '../domain.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { IdPort } from '../ports/runtime.ts';
import type { LogPort } from '../ports/log.ts';
import type {
  AttemptTrace,
  PlayerEvent,
  PlayerPort,
  QueueProjection,
} from '../ports/player.ts';
import type {
  PlayableResource,
  ProviderPort,
  RecordingQuery,
  SearchPage,
} from '../ports/provider.ts';
import type {
  PersistedState,
  StorageBatch,
  StoragePort,
} from '../ports/storage.ts';

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export class SequenceIds implements IdPort {
  #next = 0;
  next(prefix: string): string {
    this.#next += 1;
    return `${prefix}-${this.#next}`;
  }
}

type Sleeper = {
  readonly wakeAtMs: number;
  unsubscribe: () => void;
  done: (result: Result<void>) => void;
  settled: boolean;
};

export class FakeClock implements ClockPort {
  #now: number;
  #sleepers: Sleeper[] = [];

  constructor(now = 0) {
    if (!isSafeNonNegative(now)) {
      throw new TypeError('initial time must be a safe nonnegative integer');
    }
    this.#now = now;
  }

  nowMs(): number {
    return this.#now;
  }

  sleep(ms: number, signal: CancellationSignal): Promise<Result<void>> {
    if (!isSafeNonNegative(ms)) {
      throw new TypeError('ms must be a safe nonnegative integer');
    }
    if (signal.cancelled) {
      return Promise.resolve({
        ok: false,
        error: appError('cancelled', 'cancelled'),
      });
    }
    const wakeAtMs = Math.min(this.#now + ms, Number.MAX_SAFE_INTEGER);
    return new Promise<Result<void>>((resolve) => {
      const sleeper: Sleeper = {
        wakeAtMs,
        unsubscribe: () => { },
        done: resolve,
        settled: false,
      };
      const finish = (result: Result<void>) => {
        if (sleeper.settled) {
          return;
        }
        sleeper.settled = true;
        this.#sleepers = this.#sleepers.filter((s) => s !== sleeper);
        sleeper.unsubscribe();
        resolve(result);
      };
      sleeper.done = finish;
      sleeper.unsubscribe = signal.subscribe(() => {
        finish({ ok: false, error: appError('cancelled', 'cancelled') });
      });
      this.#sleepers.push(sleeper);
    });
  }

  /** Advances the manual clock and wakes due sleepers. */
  advance(ms: number): void {
    if (!isSafeNonNegative(ms)) {
      throw new TypeError('ms must be a safe nonnegative integer');
    }
    this.#now = Math.min(this.#now + ms, Number.MAX_SAFE_INTEGER);
    const due = this.#sleepers.filter((s) => s.wakeAtMs <= this.#now);
    for (const sleeper of due) {
      sleeper.done({ ok: true, value: undefined });
    }
  }

  get pendingSleepers(): number {
    return this.#sleepers.length;
  }
}

export class FakeLog implements LogPort {
  readonly entries: {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    atMs: number;
  }[] = [];

  write(entry: {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    atMs: number;
  }): Promise<Result<void>> {
    this.entries.push({ ...entry });
    return Promise.resolve(ok(undefined));
  }
}

export class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve: (value: T) => void = () => { };
  #reject: (error: unknown) => void = () => { };
  #settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  get settled(): boolean {
    return this.#settled;
  }

  /** Idempotent: only the first settlement takes effect. */
  resolve(value: T): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.#resolve(value);
  }

  reject(error: unknown): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.#reject(error);
  }
}

export type RecordedCall = {
  readonly method: string;
  readonly input: unknown;
  readonly context?: OperationContext;
};

type ProviderMethod = 'search' | 'candidates' | 'resolve' | 'details';

export class FakeProvider implements ProviderPort {
  readonly id: string;
  readonly calls: RecordedCall[] = [];
  readonly cancelledSignals: CancellationSignal[] = [];
  #queues: Record<ProviderMethod, Deferred<Result<unknown>>[]> = {
    search: [],
    candidates: [],
    resolve: [],
    details: [],
  };

  constructor(id = 'fake-provider') {
    this.id = id;
  }

  #defer<T>(
    method: ProviderMethod,
    context: OperationContext,
  ): Promise<Result<T>> {
    const deferred = new Deferred<Result<unknown>>();
    this.#queues[method].push(deferred);
    context.signal.subscribe(() => {
      this.cancelledSignals.push(context.signal);
      deferred.resolve({
        ok: false,
        error: appError('cancelled', 'cancelled'),
      });
    });
    return deferred.promise as Promise<Result<T>>;
  }

  #settle<T>(
    method: ProviderMethod,
    index: number,
    result: Result<T>,
  ): boolean {
    const queue = this.#queues[method];
    const deferred = queue[index];
    if (deferred === undefined) {
      return false;
    }
    queue.splice(index, 1);
    deferred.resolve(result);
    return true;
  }

  search(
    input: { query: string; limit: number; storefront: string | null },
    context: OperationContext,
  ): Promise<Result<SearchPage>> {
    this.calls.push({ method: 'search', input, context });
    return this.#defer('search', context);
  }

  /** Settles the oldest pending search; false when none pending. */
  settleSearch(result: Result<SearchPage>): boolean {
    return this.#settle('search', 0, result);
  }

  /** Settles the pending search at queue index, for out-of-order tests. */
  settleSearchAt(index: number, result: Result<SearchPage>): boolean {
    return this.#settle('search', index, result);
  }

  candidates(
    input: { query: RecordingQuery; limit: number },
    context: OperationContext,
  ): Promise<Result<readonly TrackMetadata[]>> {
    this.calls.push({ method: 'candidates', input, context });
    return this.#defer('candidates', context);
  }

  settleCandidates(result: Result<readonly TrackMetadata[]>): boolean {
    return this.#settle('candidates', 0, result);
  }

  settleCandidatesAt(
    index: number,
    result: Result<readonly TrackMetadata[]>,
  ): boolean {
    return this.#settle('candidates', index, result);
  }

  resolvePlayback(
    ref: SourceRef,
    input: {
      targetBitrateKbps: number;
      prefer: readonly ('audio/webm' | 'audio/mp4')[];
      pinItag: number | null;
      resumeOffset: number | null;
    },
    context: OperationContext,
  ): Promise<Result<PlayableResource>> {
    this.calls.push({
      method: 'resolvePlayback',
      input: { ref, input },
      context,
    });
    return this.#defer('resolve', context);
  }

  settleResolve(result: Result<PlayableResource>): boolean {
    return this.#settle('resolve', 0, result);
  }

  settleResolveAt(index: number, result: Result<PlayableResource>): boolean {
    return this.#settle('resolve', index, result);
  }

  getDetails(
    refs: readonly SourceRef[],
    context: OperationContext,
  ): Promise<Result<readonly TrackMetadata[]>> {
    this.calls.push({ method: 'getDetails', input: refs, context });
    return this.#defer('details', context);
  }

  settleDetails(result: Result<readonly TrackMetadata[]>): boolean {
    return this.#settle('details', 0, result);
  }

  settleDetailsAt(
    index: number,
    result: Result<readonly TrackMetadata[]>,
  ): boolean {
    return this.#settle('details', index, result);
  }

  pendingCount(method: ProviderMethod): number {
    return this.#queues[method].length;
  }
}

export class FakePlayer implements PlayerPort {
  readonly calls: { method: string; input: unknown }[] = [];
  readonly emitted: PlayerEvent[] = [];
  #listeners = new Set<(event: PlayerEvent) => void>();
  #nextResult: Result<unknown> = ok(undefined);
  #prepareHandle = 'handle-1';
  #prepareDeferreds: Deferred<Result<string>>[] = [];

  /** Configures the Result returned by the next control call. */
  setNextResult(result: Result<unknown>): void {
    this.#nextResult = result;
  }

  setPrepareHandle(handle: string): void {
    this.#prepareHandle = handle;
  }

  /** Settles the oldest pending prepare; false when none pending. */
  settlePrepare(result: Result<string>): boolean {
    const deferred = this.#prepareDeferreds.shift();
    if (deferred === undefined) {
      return false;
    }
    deferred.resolve(result);
    return true;
  }

  /** Settles the pending prepare at queue index. */
  settlePrepareAt(index: number, result: Result<string>): boolean {
    const deferred = this.#prepareDeferreds[index];
    if (deferred === undefined) {
      return false;
    }
    this.#prepareDeferreds.splice(index, 1);
    deferred.resolve(result);
    return true;
  }

  get pendingPrepares(): number {
    return this.#prepareDeferreds.length;
  }

  /** Resolves every pending prepare as cancelled. */
  cancelPendingPrepares(): void {
    for (const deferred of this.#prepareDeferreds.splice(0)) {
      deferred.resolve({ ok: false, error: appError('cancelled', 'cancelled') });
    }
  }

  emit(event: PlayerEvent): void {
    this.emitted.push(event);
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Listener exceptions are isolated like the real boundary.
      }
    }
  }

  subscribe(listener: (event: PlayerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #take<T>(method: string, input: unknown, value: T): Promise<Result<T>> {
    this.calls.push({ method, input });
    const result = this.#nextResult;
    this.#nextResult = ok(undefined);
    if (result.ok) {
      return Promise.resolve(ok(value));
    }
    return Promise.resolve({ ok: false, error: result.error });
  }

  prepare(input: {
    provider: string;
    sourceRef: string;
    identity: { attemptId: string; queueRev: number };
  }): Promise<Result<string>> {
    this.calls.push({ method: 'prepare', input });
    const deferred = new Deferred<Result<string>>();
    this.#prepareDeferreds.push(deferred);
    return deferred.promise;
  }

  play(input: {
    handle: string;
    identity: { attemptId: string; queueRev: number };
    positionMs?: number;
  }): Promise<Result<void>> {
    return this.#take('play', input, undefined);
  }

  pause(identity: {
    attemptId: string;
    queueRev: number;
  }): Promise<Result<void>> {
    return this.#take('pause', identity, undefined);
  }

  seekTo(input: {
    positionMs: number;
    identity: { attemptId: string; queueRev: number };
  }): Promise<Result<void>> {
    return this.#take('seekTo', input, undefined);
  }

  stop(identity: {
    attemptId: string;
    queueRev: number;
  }): Promise<Result<void>> {
    return this.#take('stop', identity, undefined);
  }

  cancelPrepare(input: {
    requestId: string;
    identity: { attemptId: string; queueRev: number };
  }): Promise<Result<void>> {
    this.cancelPendingPrepares();
    return this.#take('cancelPrepare', input, undefined);
  }

  release(input: {
    handle: string;
    identity: { attemptId: string; queueRev: number };
  }): Promise<Result<void>> {
    return this.#take('release', input, undefined);
  }

  readonly projections: QueueProjection[] = [];
  #projectionDeferreds: Deferred<Result<void>>[] = [];
  #deferProjections = false;
  #nextProjectionError: AppError | null = null;

  /** Subsequent setQueueProjection calls stay pending until settled. */
  deferProjections(): void {
    this.#deferProjections = true;
  }

  /** The next setQueueProjection call resolves with this error. */
  failNextProjection(error: AppError): void {
    this.#nextProjectionError = error;
  }

  settleProjection(result: Result<void>): boolean {
    const deferred = this.#projectionDeferreds.shift();
    if (deferred === undefined) {
      return false;
    }
    deferred.resolve(result);
    return true;
  }

  get pendingProjections(): number {
    return this.#projectionDeferreds.length;
  }

  setQueueProjection(projection: QueueProjection): Promise<Result<void>> {
    this.calls.push({ method: 'setQueueProjection', input: projection });
    this.projections.push(projection);
    if (this.#nextProjectionError !== null) {
      const error = this.#nextProjectionError;
      this.#nextProjectionError = null;
      return Promise.resolve({ ok: false, error });
    }
    if (this.#deferProjections) {
      const deferred = new Deferred<Result<void>>();
      this.#projectionDeferreds.push(deferred);
      return deferred.promise;
    }
    return Promise.resolve(ok(undefined));
  }
}

export class FakeStorage implements StoragePort {
  static readonly MAX_ATTEMPTS = 500;

  #state: PersistedState;
  #attempts: AttemptTrace[] = [];
  #failWith: AppError | null = null;
  readonly commits: { batch: StorageBatch; context: OperationContext }[] = [];

  constructor(initial: PersistedState) {
    this.#state = initial;
  }

  #clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  readonly loads: OperationContext[] = [];
  #loadDeferreds: Deferred<Result<PersistedState>>[] = [];
  #deferNextLoad = false;

  /** The next load stays pending until settleLoad. */
  holdNextLoad(): void {
    this.#deferNextLoad = true;
  }

  /** Settles the oldest pending load; false when none pending. */
  settleLoad(result: Result<PersistedState>): boolean {
    const deferred = this.#loadDeferreds.shift();
    if (deferred === undefined) {
      return false;
    }
    deferred.resolve(result);
    return true;
  }

  load(context: OperationContext): Promise<Result<PersistedState>> {
    this.loads.push(context);
    const deferred = new Deferred<Result<PersistedState>>();
    this.#loadDeferreds.push(deferred);
    context.signal.subscribe(() => {
      deferred.resolve({ ok: false, error: appError('cancelled', 'cancelled') });
    });
    if (this.#deferNextLoad) {
      this.#deferNextLoad = false;
      return deferred.promise;
    }
    // Clone-on-read: callers cannot mutate the stored snapshot.
    deferred.resolve(ok(this.#clone(this.#state)));
    return deferred.promise;
  }

  commit(
    batch: StorageBatch,
    context: OperationContext,
  ): Promise<Result<void>> {
    if (this.#failWith !== null) {
      const error = this.#failWith;
      this.#failWith = null;
      return Promise.resolve({ ok: false, error });
    }
    this.commits.push({ batch: this.#clone(batch), context });
    // Clone-on-write: later caller mutation cannot alter stored state.
    const staged = this.#clone(batch);
    this.#state = {
      recordings: staged.recordings ?? this.#state.recordings,
      likes: staged.likes ?? this.#state.likes,
      queue: staged.queue ?? this.#state.queue,
      settings: staged.settings ?? this.#state.settings,
    };
    if (staged.attempts !== undefined) {
      this.#attempts = [...this.#attempts, ...staged.attempts].slice(
        -FakeStorage.MAX_ATTEMPTS,
      );
    }
    return Promise.resolve(ok(undefined));
  }

  /** Diagnostics only: newest-first, capped at 500 stored traces. */
  loadAttempts(
    limit: number,
    context: OperationContext,
  ): Promise<Result<readonly AttemptTrace[]>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError('limit must be a safe integer in 1..500');
    }
    void context;
    return Promise.resolve(
      ok(this.#clone([...this.#attempts].reverse().slice(0, limit))),
    );
  }

  /** The next commit fails with the given typed error once. */
  failNext(error: AppError): void {
    this.#failWith = error;
  }
}
