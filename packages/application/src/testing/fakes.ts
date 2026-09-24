import type { CancellationSignal } from '../cancellation.ts';
import type { OperationContext } from '../cancellation.ts';
import type { AppError, Result } from '../errors.ts';
import { appError, err, ok } from '../errors.ts';
import type {
  ArtworkRef,
  EntityRef,
  SourceRef,
  TrackMetadata,
} from '../domain.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { IdPort, RandomPort } from '../ports/runtime.ts';
import type { LogPort } from '../ports/log.ts';
import type {
  ConnectivityPort,
  ConnectivitySnapshot,
} from '../ports/connectivity.ts';
import type {
  MediaTransferPort,
  TransferSink,
} from '../ports/media-transfer.ts';
import type {
  FileFingerprint,
  LocalEntry,
  LocalTags,
  PickedFolder,
  TagReaderPort,
} from '../ports/tag-reader.ts';
import type {
  AttemptTrace,
  PlayerEvent,
  PlayerPort,
  QueueProjection,
} from '../ports/player.ts';
import type {
  EntityPage,
  LyricsPreference,
  LyricsQuery,
  LyricsResult,
  PlayableResource,
  ProviderCapability,
  ProviderPort,
  RadioPage,
  RadioSeed,
  RecordingQuery,
  SearchPage,
} from '../ports/provider.ts';
import type {
  PersistedState,
  StorageBatch,
  StoragePort,
} from '../ports/storage.ts';
import type {
  ChangeEntry,
  DivergenceEntry,
  SyncLogSnapshot,
  SyncLogStore,
  SyncLogWrite,
} from '../sync/sync-engine.ts';
import {
  isChangeEntry,
  isDivergenceEntry,
  isSyncCursor,
} from '../sync/sync-engine.ts';

import { isExportDocument, isPersistedState } from '../library/library.ts';
import type { ExportDocument } from '../library/library.ts';

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

/** Deterministic RandomPort: cycles the given [0, 1) draws. */
export class SequenceRandom implements RandomPort {
  readonly #values: readonly number[];
  #next = 0;

  constructor(values: readonly number[] = [0]) {
    if (values.length === 0 || values.some((v) => !(v >= 0 && v < 1))) {
      throw new TypeError('random values must be in [0, 1)');
    }
    this.#values = Object.freeze([...values]);
  }

  unit(): number {
    const value = this.#values[this.#next % this.#values.length] ?? 0;
    this.#next += 1;
    return value;
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

type ProviderMethod =
  | 'search'
  | 'candidates'
  | 'resolve'
  | 'details'
  | 'entity'
  | 'artwork'
  | 'lyrics'
  | 'radio';

const ALL_CAPABILITIES: readonly ProviderCapability[] = [
  'catalog.search',
  'catalog.metadata',
  'catalog.artwork',
  'catalog.entity',
  'playback.candidates',
  'playback.resolve',
  'lyrics.plain',
  'lyrics.synced',
  'radio.seed',
];

function unsupportedCall(capability: ProviderCapability) {
  return {
    ok: false as const,
    error: appError(
      'unsupported',
      `provider does not declare ${capability}`,
    ),
  };
}

export class FakeProvider implements ProviderPort {
  readonly id: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly calls: RecordedCall[] = [];
  readonly cancelledSignals: CancellationSignal[] = [];
  #queues: Record<ProviderMethod, Deferred<Result<unknown>>[]> = {
    search: [],
    candidates: [],
    resolve: [],
    details: [],
    entity: [],
    artwork: [],
    lyrics: [],
    radio: [],
  };

  constructor(
    id = 'fake-provider',
    capabilities: readonly ProviderCapability[] = ALL_CAPABILITIES,
  ) {
    this.id = id;
    this.capabilities = capabilities;
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
    if (!this.capabilities.includes('catalog.search')) {
      return Promise.resolve(unsupportedCall('catalog.search'));
    }
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
    if (!this.capabilities.includes('playback.candidates')) {
      return Promise.resolve(unsupportedCall('playback.candidates'));
    }
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
    if (!this.capabilities.includes('playback.resolve')) {
      return Promise.resolve(unsupportedCall('playback.resolve'));
    }
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
    if (!this.capabilities.includes('catalog.metadata')) {
      return Promise.resolve(unsupportedCall('catalog.metadata'));
    }
    return this.#defer('details', context);
  }

  getEntity(
    ref: EntityRef,
    context: OperationContext,
  ): Promise<Result<EntityPage>> {
    this.calls.push({ method: 'getEntity', input: ref, context });
    if (!this.capabilities.includes('catalog.entity')) {
      return Promise.resolve(unsupportedCall('catalog.entity'));
    }
    return this.#defer('entity', context);
  }

  settleEntity(result: Result<EntityPage>): boolean {
    return this.#settle('entity', 0, result);
  }

  settleEntityAt(index: number, result: Result<EntityPage>): boolean {
    return this.#settle('entity', index, result);
  }

  artwork(
    ref: SourceRef,
    input: { size: 600 | 1200 },
    context: OperationContext,
  ): Promise<Result<readonly ArtworkRef[]>> {
    this.calls.push({ method: 'artwork', input: { ref, input }, context });
    if (!this.capabilities.includes('catalog.artwork')) {
      return Promise.resolve(unsupportedCall('catalog.artwork'));
    }
    return this.#defer('artwork', context);
  }

  settleArtwork(result: Result<readonly ArtworkRef[]>): boolean {
    return this.#settle('artwork', 0, result);
  }

  settleArtworkAt(
    index: number,
    result: Result<readonly ArtworkRef[]>,
  ): boolean {
    return this.#settle('artwork', index, result);
  }

  /** The wire capability the prefer hint maps to under declared caps. */
  #lyricsCapability(prefer: LyricsPreference): ProviderCapability | null {
    if (prefer === 'plain') {
      return this.capabilities.includes('lyrics.plain')
        ? 'lyrics.plain'
        : null;
    }
    if (this.capabilities.includes('lyrics.synced')) {
      return 'lyrics.synced';
    }
    return this.capabilities.includes('lyrics.plain')
      ? 'lyrics.plain'
      : null;
  }

  getLyrics(
    input: { query: LyricsQuery; prefer: LyricsPreference },
    context: OperationContext,
  ): Promise<Result<LyricsResult>> {
    this.calls.push({ method: 'getLyrics', input, context });
    const capability = this.#lyricsCapability(input.prefer);
    if (capability === null) {
      return Promise.resolve(
        unsupportedCall(
          input.prefer === 'plain' ? 'lyrics.plain' : 'lyrics.synced',
        ),
      );
    }
    return this.#defer('lyrics', context);
  }

  settleLyrics(result: Result<LyricsResult>): boolean {
    return this.#settle('lyrics', 0, result);
  }

  settleLyricsAt(index: number, result: Result<LyricsResult>): boolean {
    return this.#settle('lyrics', index, result);
  }

  radioSeed(
    input: RadioSeed,
    context: OperationContext,
  ): Promise<Result<RadioPage>> {
    this.calls.push({ method: 'radioSeed', input, context });
    if (!this.capabilities.includes('radio.seed')) {
      return Promise.resolve(unsupportedCall('radio.seed'));
    }
    return this.#defer('radio', context);
  }

  settleRadio(result: Result<RadioPage>): boolean {
    return this.#settle('radio', 0, result);
  }

  settleRadioAt(index: number, result: Result<RadioPage>): boolean {
    return this.#settle('radio', index, result);
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

  #releaseDeferreds: Deferred<Result<void>>[] = [];
  #deferNextRelease = false;

  /** The next release call stays pending until settleRelease. */
  holdNextRelease(): void {
    this.#deferNextRelease = true;
  }

  /** Settles the oldest pending release; false when none pending. */
  settleRelease(result: Result<void>): boolean {
    const deferred = this.#releaseDeferreds.shift();
    if (deferred === undefined) {
      return false;
    }
    deferred.resolve(result);
    return true;
  }

  release(input: {
    handle: string;
    identity: { attemptId: string; queueRev: number };
  }): Promise<Result<void>> {
    if (this.#deferNextRelease) {
      this.#deferNextRelease = false;
      const deferred = new Deferred<Result<void>>();
      this.#releaseDeferreds.push(deferred);
      this.calls.push({ method: 'release', input });
      return deferred.promise;
    }
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
  #commitDeferreds: Deferred<Result<void>>[] = [];
  #deferNextCommit = false;

  /** The next load stays pending until settleLoad. */
  holdNextLoad(): void {
    this.#deferNextLoad = true;
  }

  /** The next commit stays pending until settleCommit. */
  holdNextCommit(): void {
    this.#deferNextCommit = true;
  }

  /** Settles the oldest pending commit; false when none pending. */
  settleCommit(result: Result<void>): boolean {
    const deferred = this.#commitDeferreds.shift();
    if (deferred === undefined) {
      return false;
    }
    deferred.resolve(result);
    return true;
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
    if (
      batch.recordings !== undefined &&
      batch.recordingsMerge !== undefined
    ) {
      return Promise.resolve(
        err(
          appError(
            'internal',
            'commit: recordings and recordingsMerge are exclusive',
          ),
        ),
      );
    }
    if (this.#deferNextCommit) {
      // A held commit is not durable yet — neither the stored state nor
      // the commits log observe it until settleCommit resolves it.
      this.#deferNextCommit = false;
      const deferred = new Deferred<Result<void>>();
      this.#commitDeferreds.push(deferred);
      return deferred.promise.then((settled) => {
        if (!settled.ok) {
          return settled;
        }
        return this.#applyCommit(batch, context);
      });
    }
    return Promise.resolve(this.#applyCommit(batch, context));
  }

  #applyCommit(
    batch: StorageBatch,
    context: OperationContext,
  ): Result<void> {
    // The recorded batch is JSON-cloned; a function field survives
    // only as its applied result, so the merge runs on live state.
    this.commits.push({ batch: this.#clone(batch), context });
    // Clone-on-write: later caller mutation cannot alter stored state.
    const staged = this.#clone(batch);
    const merged: PersistedState = {
      recordings:
        batch.recordingsMerge !== undefined
          ? batch.recordingsMerge(this.#state.recordings)
          : (staged.recordings ?? this.#state.recordings),
      likes: staged.likes ?? this.#state.likes,
      entities: staged.entities ?? this.#state.entities,
      entitySourceRefs:
        staged.entitySourceRefs ?? this.#state.entitySourceRefs,
      playlists: staged.playlists ?? this.#state.playlists,
      playlistEntries:
        staged.playlistEntries ?? this.#state.playlistEntries,
      playHistory: staged.playHistory ?? this.#state.playHistory,
      playCounts: staged.playCounts ?? this.#state.playCounts,
      matchReviews: staged.matchReviews ?? this.#state.matchReviews,
      lyricsCache: staged.lyricsCache ?? this.#state.lyricsCache,
      artworkCache: staged.artworkCache ?? this.#state.artworkCache,
      downloads: staged.downloads ?? this.#state.downloads,
      localSources: staged.localSources ?? this.#state.localSources,
      localFiles: staged.localFiles ?? this.#state.localFiles,
      queue: staged.queue ?? this.#state.queue,
      settings: staged.settings ?? this.#state.settings,
    };
    // Mirror sqlite: validate the merged document before any mutation
    // so tests can't commit states the real backend would reject.
    if (!isPersistedState(merged)) {
      return err(
        appError('invalid-response', 'commit batch failed validation'),
      );
    }
    this.#state = merged;
    if (staged.attempts !== undefined) {
      this.#attempts = [...this.#attempts, ...staged.attempts].slice(
        -FakeStorage.MAX_ATTEMPTS,
      );
    }
    return ok(undefined);
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

  /** Owned classes only; session state and caches stay out. */
  exportOwned(
    exportedAtMs: number,
    context: OperationContext,
  ): Promise<Result<ExportDocument>> {
    if (!Number.isSafeInteger(exportedAtMs) || exportedAtMs < 0) {
      throw new TypeError('exportedAtMs must be a safe nonnegative integer');
    }
    if (context.signal.cancelled) {
      return Promise.resolve({
        ok: false,
        error: appError('cancelled', 'cancelled'),
      });
    }
    const state = this.#clone(this.#state);
    const doc: ExportDocument = {
      formatVersion: 1,
      exportedAtMs,
      recordings: state.recordings.map(
        ({ sourceRefs: _refs, mappings: _mappings, ...core }) => core,
      ),
      sourceRefs: state.recordings.flatMap((recording) =>
        recording.sourceRefs.map((ref) => ({
          recordingId: recording.id,
          ref,
        })),
      ),
      mappings: state.recordings.flatMap((recording) =>
        recording.mappings.map((mapping) => ({
          recordingId: recording.id,
          mapping,
        })),
      ),
      likes: state.likes,
      entities: state.entities,
      entitySourceRefs: state.entitySourceRefs,
      playlists: state.playlists,
      playlistEntries: state.playlistEntries,
      playHistory: state.playHistory,
      playCounts: state.playCounts,
      matchReviews: state.matchReviews,
      settings: state.settings,
    };
    return Promise.resolve(ok(doc));
  }

  /**
   * Mirrors the real port: owned sections replace wholesale, the
   * session queue resets (its rows referenced replaced recordings),
   * and the disposable lyrics cache is cleared.
   */
  importOwned(
    doc: ExportDocument,
    context: OperationContext,
  ): Promise<Result<void>> {
    if (this.#failWith !== null) {
      const error = this.#failWith;
      this.#failWith = null;
      return Promise.resolve({ ok: false, error });
    }
    if (context.signal.cancelled) {
      return Promise.resolve({
        ok: false,
        error: appError('cancelled', 'cancelled'),
      });
    }
    if (!isExportDocument(doc)) {
      return Promise.resolve({
        ok: false,
        error: appError(
          'invalid-response',
          'import document failed validation',
        ),
      });
    }
    const staged = this.#clone(doc);
    this.#state = {
      ...this.#state,
      recordings: staged.recordings.map((rec) => ({
        ...rec,
        // Pre-slice-3 exports carry no provenance — 'provider'.
        provenance: rec.provenance ?? 'provider',
        sourceRefs: staged.sourceRefs
          .filter((row) => row.recordingId === rec.id)
          .map((row) => row.ref),
        mappings: staged.mappings
          .filter((row) => row.recordingId === rec.id)
          .map((row) => row.mapping),
      })),
      likes: staged.likes,
      entities: staged.entities,
      entitySourceRefs: staged.entitySourceRefs,
      playlists: staged.playlists,
      playlistEntries: staged.playlistEntries,
      playHistory: staged.playHistory,
      playCounts: staged.playCounts,
      matchReviews: staged.matchReviews,
      lyricsCache: [],
      downloads: [],
      localFiles: [],
      queue: {
        revision: this.#state.queue.revision + 1,
        occurrences: [],
        currentOccurrenceId: null,
        positionMs: 0,
        mode: 'stopped',
      },
      settings: staged.settings,
    };
    return Promise.resolve(ok(undefined));
  }

  /** The next commit fails with the given typed error once. */
  failNext(error: AppError): void {
    this.#failWith = error;
  }
}

// ---- slice 3 ports --------------------------------------------------------

/** One fake sink's scripted outcome, consumed in begin order. */
export type FakeSinkScript = {
  /** Bytes the sink "has" pre-resume (the .part prefix length). */
  partialBytes?: number;
  /** Fail `write` calls after this many successful writes. */
  failWritesAfter?: number;
  writeError?: AppError;
  /** Fail `commit` with this error once. */
  commitError?: AppError;
  /** Fail `finalize` with this error once (checksum mismatch etc.). */
  finalizeError?: AppError;
  /** Digest `finalize` reports as the real file hash. */
  digest?: string;
};

export class FakeTransferSink implements TransferSink {
  #script: Omit<Required<FakeSinkScript>, 'commitError' | 'finalizeError'> & {
    commitError: AppError | null;
    finalizeError: AppError | null;
  };
  #bytes = 0;
  #writes = 0;
  #committed = 0;
  #closed = false;
  readonly writesLog: number[] = [];
  readonly commitsLog: number[] = [];
  finalizedWith: string | null = null;
  abortedKeep: boolean | null = null;

  constructor(script: FakeSinkScript = {}, resumeAtBytes = 0) {
    const partial = script.partialBytes ?? resumeAtBytes;
    this.#script = {
      partialBytes: partial,
      failWritesAfter: script.failWritesAfter ?? Number.MAX_SAFE_INTEGER,
      writeError:
        script.writeError ?? appError('transient', 'write failed'),
      // Errors default to null — a plain script succeeds end to end.
      commitError: script.commitError ?? null,
      finalizeError: script.finalizeError ?? null,
      digest: script.digest ?? 'f'.repeat(64),
    };
    this.#bytes = partial;
    this.#committed = partial;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get committed(): number {
    return this.#committed;
  }

  async write(bytes: Uint8Array): Promise<Result<void>> {
    if (this.#closed) {
      return err(appError('invalid-response', 'sink is closed'));
    }
    this.#writes += 1;
    if (this.#writes > this.#script.failWritesAfter) {
      return err(this.#script.writeError);
    }
    this.#bytes += bytes.length;
    this.writesLog.push(bytes.length);
    return ok(undefined);
  }

  async commit(): Promise<Result<number>> {
    if (this.#closed) {
      return err(appError('invalid-response', 'sink is closed'));
    }
    if (this.#script.commitError !== null) {
      const error = this.#script.commitError;
      this.#script.commitError = null;
      return err(error);
    }
    this.#committed = this.#bytes;
    this.commitsLog.push(this.#committed);
    return ok(this.#committed);
  }

  async finalize(expected: string | null): Promise<Result<string>> {
    if (this.#closed) {
      return err(appError('invalid-response', 'sink is closed'));
    }
    if (this.#script.finalizeError !== null) {
      const error = this.#script.finalizeError;
      this.#script.finalizeError = null;
      return err(error);
    }
    this.finalizedWith = expected;
    this.#closed = true;
    return ok(this.#script.digest);
  }

  async abort(keep: boolean): Promise<Result<void>> {
    this.abortedKeep = keep;
    this.#closed = true;
    return ok(undefined);
  }
}

export class FakeTransfer implements MediaTransferPort {
  /** begin() scripts, consumed in order. */
  #scripts: FakeSinkScript[] = [];
  #beginError: AppError | null = null;
  readonly sinks: FakeTransferSink[] = [];
  readonly beginCalls: { destPath: string; resumeAtBytes: number }[] = [];
  readonly removedFiles: string[] = [];
  dirReady = false;
  usageBytes = 0;
  free = Number.MAX_SAFE_INTEGER;
  /** stat() overrides keyed by file name. */
  readonly statResults = new Map<
    string,
    { exists: boolean; bytes: number | null }
  >();
  sweptPartials = 0;
  sweepCalls: string[][] = [];

  /** Queue a sink script for the next begin(). */
  enqueueSink(script: FakeSinkScript = {}): void {
    this.#scripts.push(script);
  }

  failNextBegin(error: AppError): void {
    this.#beginError = error;
  }

  async ensureDir(_signal: CancellationSignal): Promise<Result<void>> {
    this.dirReady = true;
    return ok(undefined);
  }

  async begin(
    input: { destPath: string; resumeAtBytes: number },
    _signal: CancellationSignal,
  ): Promise<Result<TransferSink>> {
    this.beginCalls.push({ ...input });
    if (this.#beginError !== null) {
      const error = this.#beginError;
      this.#beginError = null;
      return err(error);
    }
    const sink = new FakeTransferSink(
      this.#scripts.shift() ?? {},
      input.resumeAtBytes,
    );
    this.sinks.push(sink);
    return ok(sink);
  }

  async sweepPartials(
    keepPaths: readonly string[],
    _signal: CancellationSignal,
  ): Promise<Result<number>> {
    this.sweepCalls.push([...keepPaths]);
    return ok(this.sweptPartials);
  }

  async usage(_signal: CancellationSignal): Promise<Result<number>> {
    return ok(this.usageBytes);
  }

  async freeBytes(_signal: CancellationSignal): Promise<Result<number>> {
    return ok(this.free);
  }

  async removeFile(
    name: string,
    _signal: CancellationSignal,
  ): Promise<Result<void>> {
    this.removedFiles.push(name);
    return ok(undefined);
  }

  async stat(
    name: string,
    _signal: CancellationSignal,
  ): Promise<Result<{ exists: boolean; bytes: number | null }>> {
    return ok(this.statResults.get(name) ?? { exists: false, bytes: null });
  }
}

export class FakeTagReader implements TagReaderPort {
  readonly entries = new Map<string, LocalEntry[]>();
  readonly tags = new Map<string, LocalTags>();
  readonly fingerprints = new Map<string, FileFingerprint>();
  pickResult: Result<PickedFolder> = err(
    appError('no-result', 'folder pick cancelled'),
  );
  pickCalls = 0;
  enumerateCalls: string[] = [];
  fingerprintCalls: string[][] = [];
  readTagsCalls: string[][] = [];

  async pickFolder(
    _signal: CancellationSignal,
  ): Promise<Result<PickedFolder>> {
    this.pickCalls += 1;
    return this.pickResult;
  }

  async enumerate(
    treeUri: string,
    _signal: CancellationSignal,
  ): Promise<Result<readonly LocalEntry[]>> {
    this.enumerateCalls.push(treeUri);
    return ok(this.entries.get(treeUri) ?? []);
  }

  async fingerprint(
    _treeUri: string,
    docIds: readonly string[],
    _signal: CancellationSignal,
  ): Promise<Result<readonly (FileFingerprint | null)[]>> {
    this.fingerprintCalls.push([...docIds]);
    return ok(docIds.map((id) => this.fingerprints.get(id) ?? null));
  }

  async readTags(
    _treeUri: string,
    docIds: readonly string[],
    _signal: CancellationSignal,
  ): Promise<Result<readonly (LocalTags | null)[]>> {
    this.readTagsCalls.push([...docIds]);
    return ok(docIds.map((id) => this.tags.get(id) ?? null));
  }

  docUri(treeUri: string, docId: string): string {
    return `${treeUri}/document/${docId}`;
  }
}

export class FakeConnectivity implements ConnectivityPort {
  state: ConnectivitySnapshot = { online: true, metered: false };
  snapshotCalls = 0;
  readonly listeners = new Set<
    (snapshot: ConnectivitySnapshot) => void
  >();

  async snapshot(): Promise<Result<ConnectivitySnapshot>> {
    this.snapshotCalls += 1;
    return ok({ ...this.state });
  }

  subscribe(
    listener: (snapshot: ConnectivitySnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Push a new state to all subscribers (edge-only, like the port). */
  set(state: ConnectivitySnapshot): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener({ ...state });
    }
  }
}

/**
 * In-memory SyncLogStore: clone-on-read/write like FakeStorage so a
 * test can't mutate the durable log behind the engine's back.
 */
export class FakeSyncLogStore implements SyncLogStore {
  #entries: ChangeEntry[] = [];
  #divergence: DivergenceEntry[] = [];
  #watermarks: Record<string, number> = {};
  /** Cumulative prune frontier — the largest seq ever capped away. */
  #divergenceFloor = 0;
  #failNextAppend: AppError | null = null;
  #deferNextAppend = false;
  #appendDeferreds: Deferred<Result<void>>[] = [];
  readonly writes: { write: SyncLogWrite; context: OperationContext }[] = [];
  readonly loads: OperationContext[] = [];

  constructor(initial?: SyncLogSnapshot) {
    if (initial !== undefined) {
      this.#entries = [...initial.entries];
      this.#divergence = [...initial.divergence];
      this.#watermarks = { ...initial.watermarks };
      this.#divergenceFloor = initial.divergenceFloor ?? 0;
    }
  }

  #clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  /** The next append resolves with this error instead of writing. */
  failNextAppend(error: AppError): void {
    this.#failNextAppend = error;
  }

  /** The next append stays pending until settleAppend. */
  holdNextAppend(): void {
    this.#deferNextAppend = true;
  }

  /** Settles the oldest held append; false when none pending. */
  settleAppend(result: Result<void>): boolean {
    const deferred = this.#appendDeferreds.shift();
    if (deferred === undefined) {
      return false;
    }
    deferred.resolve(result);
    return true;
  }

  get pendingAppends(): number {
    return this.#appendDeferreds.length;
  }

  get entries(): readonly ChangeEntry[] {
    return this.#clone(this.#entries);
  }

  get divergenceRows(): readonly DivergenceEntry[] {
    return this.#clone(this.#divergence);
  }

  get storedWatermarks(): Readonly<Record<string, number>> {
    return this.#clone(this.#watermarks);
  }

  get storedDivergenceFloor(): number {
    return this.#divergenceFloor;
  }

  load(context: OperationContext): Promise<Result<SyncLogSnapshot>> {
    this.loads.push(context);
    if (context.signal.cancelled) {
      return Promise.resolve({
        ok: false,
        error: appError('cancelled', 'cancelled'),
      });
    }
    return Promise.resolve(
      ok(
        this.#clone({
          entries: this.#entries,
          divergence: this.#divergence,
          watermarks: this.#watermarks,
          divergenceFloor: this.#divergenceFloor,
        }),
      ),
    );
  }

  append(
    write: SyncLogWrite,
    context: OperationContext,
  ): Promise<Result<void>> {
    if (context.signal.cancelled) {
      return Promise.resolve({
        ok: false,
        error: appError('cancelled', 'cancelled'),
      });
    }
    if (this.#failNextAppend !== null) {
      const error = this.#failNextAppend;
      this.#failNextAppend = null;
      return Promise.resolve({ ok: false, error });
    }
    if (this.#deferNextAppend) {
      this.#deferNextAppend = false;
      const deferred = new Deferred<Result<void>>();
      this.#appendDeferreds.push(deferred);
      return deferred.promise.then((settled) => {
        if (!settled.ok) {
          return settled;
        }
        return this.#applyWrite(write, context);
      });
    }
    return Promise.resolve(this.#applyWrite(write, context));
  }

  #applyWrite(
    write: SyncLogWrite,
    context: OperationContext,
  ): Result<void> {
    if (
      (write.entries !== undefined &&
        !write.entries.every(isChangeEntry)) ||
      (write.divergence !== undefined &&
        !write.divergence.every(isDivergenceEntry)) ||
      (write.watermarks !== undefined &&
        !isSyncCursor(write.watermarks)) ||
      (write.dropDivergenceBefore !== undefined &&
        !isSafeNonNegative(write.dropDivergenceBefore))
    ) {
      return err(
        appError('invalid-response', 'append batch failed validation'),
      );
    }
    this.writes.push({ write: this.#clone(write), context });
    if (write.entries !== undefined) {
      this.#entries.push(...this.#clone(write.entries));
    }
    if (write.divergence !== undefined) {
      this.#divergence.push(...this.#clone(write.divergence));
    }
    if (write.watermarks !== undefined) {
      for (const [device, mark] of Object.entries(write.watermarks)) {
        const current = this.#watermarks[device];
        if (current === undefined || mark > current) {
          this.#watermarks[device] = mark;
        }
      }
    }
    if (write.dropDivergenceBefore !== undefined) {
      const floor = write.dropDivergenceBefore;
      this.#divergence = this.#divergence.filter(
        (row) => row.seq >= floor,
      );
      if (floor > this.#divergenceFloor) {
        this.#divergenceFloor = floor;
      }
    }
    return ok(undefined);
  }
}
