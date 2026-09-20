import { CancellationSource } from '../cancellation.ts';
import type { OperationContext } from '../cancellation.ts';
import type { AppError, Result } from '../errors.ts';
import { appError, err, fromUnknown, ok } from '../errors.ts';
import type {
  EntityKind,
  EntityRef,
  Like,
  Recording,
  Settings,
  SourceMapping,
  SourceRef,
  TrackMetadata,
} from '../domain.ts';
import {
  isEntityRef,
  isSettings,
  isString,
  isTrackMetadata,
  isTrackRef,
  recordingFromMetadata,
} from '../domain.ts';
import { countsAsPlay, recordPlay } from '../library/history.ts';
import { isPersistedState } from '../library/library.ts';
import type {
  Entity,
  EntitySourceRef,
  PlayCount,
  PlayEvent,
  Playlist,
  PlaylistEntry,
} from '../library/library.ts';
import {
  applyImport,
  exportLibrary,
  previewImport,
} from '../library/export-import.ts';
import type {
  ExportResult,
  ImportPreview,
} from '../library/export-import.ts';
import { toggleEntityLike, toggleTrackLike } from '../library/likes.ts';
import {
  addPlaylistEntry,
  createPlaylist,
  deletePlaylist,
  removePlaylistEntry,
  renamePlaylist,
  reorderPlaylistEntry,
} from '../library/playlists.ts';
import type { EntryMove, PlaylistState } from '../library/playlists.ts';
import {
  extractVersionLabels,
  MatchingEngine,
} from '../matching/matching-engine.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { IdPort } from '../ports/runtime.ts';
import type { LogPort } from '../ports/log.ts';
import type {
  PlaybackIdentity,
  PlayerEvent,
  PlayerPort,
  QueueProjection,
  QueueProjectionItem,
} from '../ports/player.ts';
import type {
  EntityPage,
  ProviderPort,
  RecordingQuery,
} from '../ports/provider.ts';
import {
  ProviderRouter,
  selectionFromSettings,
} from '../providers/provider-router.ts';
import type {
  PersistedState,
  StorageBatch,
  StoragePort,
} from '../ports/storage.ts';
import { QueueEngine } from '../queue/queue-engine.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';

export type SessionPlayback =
  | { readonly type: 'idle' }
  | {
    readonly type: 'preparing';
    readonly recordingId: string;
    readonly occurrenceId: string;
    readonly identity: PlaybackIdentity;
    readonly requestId?: string;
  }
  | {
    readonly type: 'buffering' | 'playing' | 'paused';
    readonly recordingId: string;
    readonly occurrenceId: string;
    readonly identity: PlaybackIdentity;
    readonly handle: string;
    readonly positionMs: number;
    readonly durationMs?: number;
  }
  | {
    readonly type: 'failed';
    readonly recordingId: string | null;
    readonly occurrenceId: string | null;
    readonly identity?: PlaybackIdentity;
    readonly error: AppError;
  };

export type ReadySession = {
  readonly type: 'ready';
  readonly recordings: readonly Recording[];
  readonly likes: readonly Like[];
  readonly entities: readonly Entity[];
  readonly entitySourceRefs: readonly EntitySourceRef[];
  readonly playlists: readonly Playlist[];
  readonly playlistEntries: readonly PlaylistEntry[];
  readonly playHistory: readonly PlayEvent[];
  readonly playCounts: readonly PlayCount[];
  readonly queue: QueueSnapshot;
  readonly settings: Settings;
  readonly playback: SessionPlayback;
  readonly persistenceError?: AppError;
};

export type SessionState =
  | { readonly type: 'unhydrated' }
  | { readonly type: 'restore-failed'; readonly error: AppError }
  | ReadySession;

export type SessionDeps = {
  readonly storage: StoragePort;
  readonly player: PlayerPort;
  readonly providers: readonly ProviderPort[];
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly log: LogPort;
  readonly defaults: Settings;
};

const OP_DEADLINE_MS = 15_000;
const CANDIDATE_LIMIT = 25;

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function saturatingAdd(a: number, b: number): number {
  const sum = a + b;
  return sum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : sum;
}

function sameRef(a: SourceRef | null, b: SourceRef | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.provider === b.provider && a.kind === b.kind && a.id === b.id;
}

function attemptEq(a: PlaybackIdentity, b: PlaybackIdentity): boolean {
  return a.attemptId === b.attemptId;
}

function internalError(): AppError {
  return appError('internal', 'an internal error occurred');
}

function timeoutError(): AppError {
  return appError('timeout', 'operation deadline exceeded');
}

/** Mapping precedence identical to MatchingEngine's conflict rule. */
function mappingRank(status: SourceMapping['status']): number {
  return status === 'user-confirmed' ? 2 : status === 'rejected' ? 1 : 0;
}

function winningMapping(
  mappings: readonly SourceMapping[],
): SourceMapping | undefined {
  let best: SourceMapping | undefined;
  for (const mapping of mappings) {
    if (
      best === undefined ||
      mapping.matchedAtMs > best.matchedAtMs ||
      (mapping.matchedAtMs === best.matchedAtMs &&
        mappingRank(mapping.status) > mappingRank(best.status))
    ) {
      best = mapping;
    }
  }
  return best;
}

type ActiveAttempt = {
  identity: PlaybackIdentity;
  readonly recordingId: string;
  readonly occurrenceId: string;
  readonly source: CancellationSource;
  readonly deadlineMs: number;
  requestId?: string;
  handle?: string;
  preparedHandled: boolean;
  endedHandled: boolean;
  terminalError?: AppError;
  timer?: CancellationSource;
};

type Ready = {
  recordings: Recording[];
  likes: Like[];
  entities: Entity[];
  entitySourceRefs: EntitySourceRef[];
  playlists: Playlist[];
  playlistEntries: PlaylistEntry[];
  playHistory: PlayEvent[];
  playCounts: PlayCount[];
  queue: QueueEngine;
  settings: Settings;
  playback: SessionPlayback;
  persistenceError: AppError | undefined;
};

function playlistSections(r: Ready): PlaylistState {
  return { playlists: r.playlists, entries: r.playlistEntries };
}

/** Latest sent projection plus its install status at the service. */
type ProjectionMarker = {
  readonly projection: QueueProjection;
  currentOccurrenceId: string | null;
  reconciledQueueRev: number;
  status: 'pending' | 'installed' | 'failed';
  done: Promise<void>;
};

export class Session {
  readonly #storage: StoragePort;
  readonly #player: PlayerPort;
  readonly #providers: Map<string, ProviderPort>;
  readonly #router: ProviderRouter;
  readonly #clock: ClockPort;
  readonly #ids: IdPort;
  readonly #log: LogPort;

  #state: SessionState = { type: 'unhydrated' };
  #ready: Ready | null = null;
  #active: ActiveAttempt | null = null;
  #releasedHandles = new Set<string>();
  #releaseWork = new Map<string, Promise<Result<void>>>();
  #timers = new Set<CancellationSource>();
  #opSources = new Set<CancellationSource>();
  #ownedWork = new Set<Promise<unknown>>();
  #deadlineWork = new Set<Promise<unknown>>();
  #eventTail: Promise<void> = Promise.resolve();
  #likeTail: Promise<void> = Promise.resolve();
  #playlistTail: Promise<void> = Promise.resolve();
  #entityTail: Promise<void> = Promise.resolve();
  #listeners = new Set<(state: SessionState) => void>();
  #playerUnsub: () => void;
  #disposed = false;
  #projection: ProjectionMarker | null = null;
  #mappingSource: CancellationSource | null = null;

  constructor(deps: SessionDeps) {
    if (!isSettings(deps.defaults)) {
      throw new TypeError('defaults must be a valid Settings');
    }
    const providers = new Map<string, ProviderPort>();
    for (const provider of deps.providers) {
      if (
        typeof provider.id !== 'string' ||
        provider.id.length === 0 ||
        providers.has(provider.id)
      ) {
        throw new TypeError('provider ids must be unique and nonempty');
      }
      providers.set(provider.id, provider);
    }
    if (
      !providers.has(deps.defaults.catalogProvider) ||
      !providers.has(deps.defaults.playbackProvider) ||
      (deps.defaults.lyricsProvider != null &&
        !providers.has(deps.defaults.lyricsProvider)) ||
      (deps.defaults.radioProvider != null &&
        !providers.has(deps.defaults.radioProvider))
    ) {
      throw new TypeError('default providers must be injected');
    }
    this.#storage = deps.storage;
    this.#player = deps.player;
    this.#providers = providers;
    this.#router = new ProviderRouter(deps.providers);
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#log = deps.log;
    this.#playerUnsub = deps.player.subscribe((event) => {
      this.#onPlayerEvent(event);
    });
  }

  snapshot(): SessionState {
    return this.#state;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #publish(): void {
    if (this.#ready !== null) {
      const ready = this.#ready;
      const base = {
        type: 'ready' as const,
        recordings: Object.freeze([...ready.recordings]),
        likes: Object.freeze([...ready.likes]),
        entities: Object.freeze([...ready.entities]),
        entitySourceRefs: Object.freeze([...ready.entitySourceRefs]),
        playlists: Object.freeze([...ready.playlists]),
        playlistEntries: Object.freeze([...ready.playlistEntries]),
        playHistory: Object.freeze([...ready.playHistory]),
        playCounts: Object.freeze([...ready.playCounts]),
        queue: ready.queue.snapshot(),
        settings: { ...ready.settings },
        playback: ready.playback,
      };
      this.#state =
        ready.persistenceError === undefined
          ? base
          : { ...base, persistenceError: ready.persistenceError };
    }
    const state = this.#state;
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch {
        // Subscriber exceptions are isolated.
      }
    }
  }

  #requireReady(): Result<Ready> {
    const ready = this.#ready;
    if (ready === null || this.#disposed) {
      return err(appError('unavailable', 'session is not ready'));
    }
    return ok(ready);
  }

  #isStale(attempt: ActiveAttempt): boolean {
    return this.#active !== attempt;
  }

  /** Defensive clock read: unsafe values never reach downstream math. */
  #safeNow(): number | null {
    let now: number;
    try {
      now = this.#clock.nowMs();
    } catch {
      return null;
    }
    return isSafeNonNegative(now) ? now : null;
  }

  /** Absolute deadline for one bounded operation; 0 marks a dead clock. */
  #deadline(): number {
    const now = this.#safeNow();
    return now === null ? 0 : saturatingAdd(now, OP_DEADLINE_MS);
  }

  /** Port calls never throw by contract; throws map to internal. */
  async #call<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await fn();
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
  }

  /**
   * Races an operation thunk against an absolute deadline. The clock
   * and remaining budget are validated before the thunk is invoked,
   * so an invalid clock/deadline never starts the port call. An
   * independent timer source bounds ClockPort.sleep; an operation win
   * cancels the timer, a timer win cancels the operation and reports
   * timeout.
   */
  async #withDeadline<T>(
    operation: () => Promise<Result<T>>,
    absoluteDeadlineMs: number,
    operationSource: CancellationSource,
  ): Promise<Result<T>> {
    const now = this.#safeNow();
    if (now === null || !isSafeNonNegative(absoluteDeadlineMs)) {
      operationSource.cancel();
      return err(internalError());
    }
    const remaining = absoluteDeadlineMs - now;
    if (remaining <= 0) {
      operationSource.cancel();
      return err(timeoutError());
    }
    const timer = new CancellationSource();
    this.#timers.add(timer);
    try {
      const outcome = await Promise.race([
        this.#call(operation).then((r) => ({ side: 'op' as const, r })),
        this.#call(() => this.#clock.sleep(remaining, timer.signal)).then(
          (r) => ({ side: 'timer' as const, r }),
        ),
      ]);
      if (outcome.side === 'op') {
        return outcome.r;
      }
      operationSource.cancel();
      const slept = outcome.r;
      if (!slept.ok && slept.error.kind === 'internal') {
        return err(slept.error);
      }
      return err(timeoutError());
    } finally {
      this.#timers.delete(timer);
      timer.cancel();
    }
  }

  /** Every player/storage port call is bounded and cancellable. */
  async #bounded<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    const source = new CancellationSource();
    this.#opSources.add(source);
    try {
      return await this.#withDeadline(fn, this.#deadline(), source);
    } finally {
      this.#opSources.delete(source);
    }
  }

  #newContext(
    prefix: string,
    deadlineMs: number,
    signal: OperationContext['signal'],
  ): OperationContext {
    return { requestId: this.#ids.next(prefix), deadlineMs, signal };
  }

  /** Bounded, nonfatal persistence. Failures publish persistenceError. */
  async #persist(batch: StorageBatch): Promise<Result<void>> {
    const source = new CancellationSource();
    this.#opSources.add(source);
    let result: Result<void>;
    try {
      const deadlineMs = this.#deadline();
      const context = this.#newContext('persist', deadlineMs, source.signal);
      result = await this.#withDeadline(
        () => this.#storage.commit(batch, context),
        deadlineMs,
        source,
      );
    } finally {
      this.#opSources.delete(source);
    }
    const ready = this.#ready;
    if (ready !== null) {
      ready.persistenceError = result.ok ? undefined : result.error;
      this.#publish();
    }
    return result.ok ? ok(undefined) : result;
  }

  /** Bounded, nonfatal, sanitized internal logging. */
  #logWarn(message: string): void {
    const atMs = this.#safeNow();
    if (atMs === null) {
      return;
    }
    const work = this.#bounded(() =>
      this.#log.write({ level: 'warn', message, atMs }),
    ).then(() => undefined);
    this.#own(work);
  }

  #own(work: Promise<unknown>, deadline = false): void {
    const set = deadline ? this.#deadlineWork : this.#ownedWork;
    set.add(work);
    void work
      .catch(() => undefined)
      .finally(() => {
        set.delete(work);
      });
  }

  /** Queue/settings changed: re-project and re-evaluate the successor. */
  #derived(): void {
    this.#mappingSource?.cancel();
    this.#mappingSource = null;
    this.#own(this.#projectQueue());
    this.#maybeMapSuccessor();
  }

  // ---- restore ----------------------------------------------------

  async restore(): Promise<Result<void>> {
    if (this.#ready !== null) {
      return ok(undefined);
    }
    const source = new CancellationSource();
    this.#opSources.add(source);
    let loaded: Result<PersistedState>;
    try {
      const deadlineMs = this.#deadline();
      const context = this.#newContext('load', deadlineMs, source.signal);
      loaded = await this.#withDeadline(
        () => this.#storage.load(context),
        deadlineMs,
        source,
      );
    } finally {
      this.#opSources.delete(source);
    }
    if (!loaded.ok) {
      this.#state = { type: 'restore-failed', error: loaded.error };
      this.#publish();
      return err(loaded.error);
    }
    if (!isPersistedState(loaded.value)) {
      const error = appError(
        'invalid-response',
        'persisted state failed validation',
      );
      this.#state = { type: 'restore-failed', error };
      this.#publish();
      return err(error);
    }
    const data = loaded.value;
    let queue: QueueEngine;
    try {
      queue = new QueueEngine(data.queue);
    } catch {
      const error = appError(
        'invalid-response',
        'persisted queue failed validation',
      );
      this.#state = { type: 'restore-failed', error };
      this.#publish();
      return err(error);
    }
    this.#ready = {
      recordings: [...data.recordings],
      likes: [...data.likes],
      entities: [...data.entities],
      entitySourceRefs: [...data.entitySourceRefs],
      playlists: [...data.playlists],
      playlistEntries: [...data.playlistEntries],
      playHistory: [...data.playHistory],
      playCounts: [...data.playCounts],
      queue,
      settings: { ...data.settings },
      playback: { type: 'idle' },
      persistenceError: undefined,
    };
    // Restore never starts the player; it always restores paused.
    queue.restorePaused();
    this.#publish();
    if (queue.snapshot().revision !== data.queue.revision) {
      await this.#persist({ queue: queue.snapshot() });
    }
    this.#derived();
    return ok(undefined);
  }

  // ---- library ----------------------------------------------------

  /**
   * Find-or-create the recording a provider result describes: an
   * existing recording carrying the same source ref is refreshed in
   * place, otherwise a new row is appended. In-memory only — the
   * caller owns the persist.
   */
  #upsertRecording(r: Ready, metadata: TrackMetadata): Recording {
    const ref = metadata.sourceRef;
    const existing = r.recordings.find((rec) =>
      rec.sourceRefs.some((s) => sameRef(s, ref)),
    );
    if (existing === undefined) {
      const recording = recordingFromMetadata(
        metadata,
        this.#ids.next('rec'),
      );
      r.recordings = [...r.recordings, recording];
      return recording;
    }
    const hasRef = existing.sourceRefs.some((s) => sameRef(s, ref));
    const updated: Recording = {
      ...existing,
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      durationMs: metadata.durationMs,
      releaseYear: metadata.releaseYear,
      artwork: metadata.artwork,
      explicit: metadata.explicit,
      genre: metadata.genre,
      isrc: metadata.isrc ?? existing.isrc,
      versionLabels: extractVersionLabels(
        metadata.title,
        metadata.explicit,
      ),
      sourceRefs: hasRef
        ? existing.sourceRefs
        : [...existing.sourceRefs, ref],
    };
    r.recordings = r.recordings.map((rec) =>
      rec.id === updated.id ? updated : rec,
    );
    return updated;
  }

  async enqueueMetadata(metadata: TrackMetadata): Promise<Result<string>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    if (!isTrackMetadata(metadata)) {
      return err(appError('invalid-response', 'metadata failed validation'));
    }
    const r = ready.value;
    const ref = metadata.sourceRef;
    const recording = this.#upsertRecording(r, metadata);
    const occurrenceId = this.#ids.next('occ');
    r.queue.enqueue({
      occurrenceId,
      recordingId: recording.id,
      selectedRef:
        ref.provider === r.settings.playbackProvider ? ref : null,
    });
    this.#publish();
    const persisted = await this.#persist({
      recordings: r.recordings,
      queue: r.queue.snapshot(),
    });
    this.#derived();
    if (!persisted.ok) {
      return err(persisted.error);
    }
    return ok(occurrenceId);
  }

  async enqueueRecording(recordingId: string): Promise<Result<string>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const recording = r.recordings.find((rec) => rec.id === recordingId);
    if (recording === undefined) {
      return err(appError('not-found', 'unknown recording'));
    }
    const occurrenceId = this.#ids.next('occ');
    r.queue.enqueue({
      occurrenceId,
      recordingId,
      selectedRef: this.#pickRef(recording, null),
    });
    this.#publish();
    const persisted = await this.#persist({ queue: r.queue.snapshot() });
    this.#derived();
    if (!persisted.ok) {
      return err(persisted.error);
    }
    return ok(occurrenceId);
  }

  async addAndPlay(metadata: TrackMetadata): Promise<Result<void>> {
    const enqueued = await this.enqueueMetadata(metadata);
    if (!enqueued.ok) {
      return enqueued;
    }
    return this.playOccurrence(enqueued.value);
  }

  /**
   * Materialize the recording a provider result describes without
   * touching the queue — the add-to-playlist path needs a recordingId
   * for `addPlaylistEntry`.
   */
  async ensureRecording(
    metadata: TrackMetadata,
  ): Promise<Result<string>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    if (!isTrackMetadata(metadata)) {
      return err(appError('invalid-response', 'metadata failed validation'));
    }
    const r = ready.value;
    const recording = this.#upsertRecording(r, metadata);
    this.#publish();
    const persisted = await this.#persist({ recordings: r.recordings });
    this.#derived();
    if (!persisted.ok) {
      return err(persisted.error);
    }
    return ok(recording.id);
  }

  /**
   * Play a list in order: every item is enqueued under its own
   * occurrence (duplicates keep row identity, entries may pin a
   * selectedRef), one commit covers the batch, then the first new
   * occurrence plays. Validates the whole list before any enqueue.
   */
  async playRecordings(
    items: readonly {
      recordingId: string;
      selectedRef: SourceRef | null;
    }[],
  ): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (items.length === 0) {
      return err(appError('invalid-response', 'empty play list'));
    }
    const resolved: { recordingId: string; ref: SourceRef | null }[] = [];
    for (const item of items) {
      const recording = r.recordings.find(
        (rec) => rec.id === item.recordingId,
      );
      if (recording === undefined) {
        return err(appError('not-found', 'unknown recording'));
      }
      if (item.selectedRef !== null && !isTrackRef(item.selectedRef)) {
        return err(appError('invalid-response', 'invalid selected ref'));
      }
      // The pin rides on the occurrence verbatim — `#pickRef` applies
      // it at attempt time, so a pin for a different playback provider
      // falls back to mappings exactly like a playlist-entry pin.
      resolved.push({ recordingId: recording.id, ref: item.selectedRef });
    }
    let first = '';
    for (const item of resolved) {
      const occurrenceId = this.#ids.next('occ');
      if (first === '') {
        first = occurrenceId;
      }
      r.queue.enqueue({
        occurrenceId,
        recordingId: item.recordingId,
        selectedRef: item.ref,
      });
    }
    this.#publish();
    const persisted = await this.#persist({ queue: r.queue.snapshot() });
    this.#derived();
    if (!persisted.ok) {
      return err(persisted.error);
    }
    return this.playOccurrence(first);
  }

  toggleLike(recordingId: string): Promise<Result<void>> {
    // Compute each replacement from the previous committed like set.
    const work = this.#likeTail.then(() => this.#toggleLike(recordingId));
    this.#likeTail = work.then(() => undefined, () => undefined);
    this.#own(work);
    return work;
  }

  async #toggleLike(recordingId: string): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (!r.recordings.some((rec) => rec.id === recordingId)) {
      return err(appError('not-found', 'unknown recording'));
    }
    const now = this.#safeNow();
    if (now === null) {
      return err(internalError());
    }
    const next = toggleTrackLike(r.likes, recordingId, now);
    const persisted = await this.#persist({ likes: next });
    if (!persisted.ok) {
      // Commit-first semantics: the in-memory like set is unchanged.
      return err(persisted.error);
    }
    r.likes = [...next];
    this.#publish();
    return ok(undefined);
  }

  toggleEntityLike(
    kind: EntityKind,
    entityId: string,
  ): Promise<Result<void>> {
    const work = this.#likeTail.then(() =>
      this.#toggleEntityLike(kind, entityId),
    );
    this.#likeTail = work.then(() => undefined, () => undefined);
    this.#own(work);
    return work;
  }

  async #toggleEntityLike(
    kind: EntityKind,
    entityId: string,
  ): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (
      !r.entities.some((e) => e.entityId === entityId && e.kind === kind)
    ) {
      return err(appError('not-found', 'unknown entity'));
    }
    const now = this.#safeNow();
    if (now === null) {
      return err(internalError());
    }
    const next = toggleEntityLike(r.likes, kind, entityId, now);
    const persisted = await this.#persist({ likes: next });
    if (!persisted.ok) {
      return err(persisted.error);
    }
    r.likes = [...next];
    this.#publish();
    return ok(undefined);
  }

  /**
   * `catalog.entity` pages route by provenance — the ref's minting
   * provider serves it (router `providerForRef`). Serialized on the
   * entity tail so concurrent page loads can't double-materialize an
   * entity. On success the provider-independent `Entity` and its
   * minted ref are attached (find-or-create) so entity likes have a
   * referential target — the entity row is identity, not page cache,
   * so a `complete:false` page still materializes it.
   */
  getEntityPage(ref: EntityRef): Promise<Result<EntityPage>> {
    const work = this.#entityTail.then(() => this.#getEntityPage(ref));
    this.#entityTail = work.then(() => undefined, () => undefined);
    this.#own(work);
    return work;
  }

  async #getEntityPage(ref: EntityRef): Promise<Result<EntityPage>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    if (!isEntityRef(ref)) {
      return err(appError('invalid-response', 'invalid entity ref'));
    }
    const r = ready.value;
    const source = new CancellationSource();
    this.#opSources.add(source);
    let page: Result<EntityPage>;
    try {
      const deadlineMs = this.#deadline();
      const context = this.#newContext('entity', deadlineMs, source.signal);
      page = await this.#withDeadline(
        () => this.#router.getEntity(ref, context),
        deadlineMs,
        source,
      );
    } finally {
      this.#opSources.delete(source);
    }
    if (!page.ok) {
      return page;
    }
    // Attach by the page's own descriptor — a continuation call may
    // carry an opaque request ref while `entity.source_ref` always
    // names the real entity.
    const descriptor = page.value.entity.sourceRef;
    if (
      isEntityRef(descriptor) &&
      !r.entitySourceRefs.some(
        (s) =>
          s.provider === descriptor.provider &&
          s.ref.kind === descriptor.kind &&
          s.ref.id === descriptor.id,
      )
    ) {
      const now = this.#safeNow();
      if (now === null) {
        return err(internalError());
      }
      const entity = page.value.entity;
      const entityId = this.#ids.next('entity');
      const nextEntities: readonly Entity[] = [
        ...r.entities,
        {
          entityId,
          kind: entity.kind,
          title: entity.title,
          artistName: entity.kind === 'album' ? entity.subtitle : null,
          artwork: entity.artwork,
          createdMs: now,
        },
      ];
      const nextRefs: readonly EntitySourceRef[] = [
        ...r.entitySourceRefs,
        { entityId, provider: descriptor.provider, ref: descriptor },
      ];
      const persisted = await this.#persist({
        entities: nextEntities,
        entitySourceRefs: nextRefs,
      });
      if (!persisted.ok) {
        return err(persisted.error);
      }
      r.entities = [...nextEntities];
      r.entitySourceRefs = [...nextRefs];
      this.#publish();
    }
    return page;
  }

  /** Commits both playlist sections atomically, then mirrors them. */
  async #commitPlaylists(
    r: Ready,
    next: PlaylistState,
  ): Promise<Result<void>> {
    const persisted = await this.#persist({
      playlists: next.playlists,
      playlistEntries: next.entries,
    });
    if (!persisted.ok) {
      return err(persisted.error);
    }
    r.playlists = [...next.playlists];
    r.playlistEntries = [...next.entries];
    this.#publish();
    return ok(undefined);
  }

  #enqueuePlaylistOp<T>(
    fn: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const work = this.#playlistTail.then(fn);
    this.#playlistTail = work.then(() => undefined, () => undefined);
    this.#own(work);
    return work;
  }

  createPlaylist(name: string): Promise<Result<string>> {
    return this.#enqueuePlaylistOp(() => this.#createPlaylist(name));
  }

  async #createPlaylist(name: string): Promise<Result<string>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (!isString(name, 512) || name.trim().length === 0) {
      return err(appError('invalid-response', 'invalid playlist name'));
    }
    const now = this.#safeNow();
    if (now === null) {
      return err(internalError());
    }
    const playlistId = this.#ids.next('playlist');
    const next = createPlaylist(
      playlistSections(r),
      playlistId,
      name,
      now,
    );
    const committed = await this.#commitPlaylists(r, next);
    if (!committed.ok) {
      return err(committed.error);
    }
    return ok(playlistId);
  }

  renamePlaylist(playlistId: string, name: string): Promise<Result<void>> {
    return this.#enqueuePlaylistOp(() =>
      this.#renamePlaylist(playlistId, name),
    );
  }

  async #renamePlaylist(
    playlistId: string,
    name: string,
  ): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (!r.playlists.some((p) => p.playlistId === playlistId)) {
      return err(appError('not-found', 'unknown playlist'));
    }
    if (!isString(name, 512) || name.trim().length === 0) {
      return err(appError('invalid-response', 'invalid playlist name'));
    }
    const now = this.#safeNow();
    if (now === null) {
      return err(internalError());
    }
    const next = renamePlaylist(playlistSections(r), playlistId, name, now);
    return this.#commitPlaylists(r, next);
  }

  deletePlaylist(playlistId: string): Promise<Result<void>> {
    return this.#enqueuePlaylistOp(() => this.#deletePlaylist(playlistId));
  }

  async #deletePlaylist(playlistId: string): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (!r.playlists.some((p) => p.playlistId === playlistId)) {
      return err(appError('not-found', 'unknown playlist'));
    }
    const next = deletePlaylist(playlistSections(r), playlistId);
    return this.#commitPlaylists(r, next);
  }

  addPlaylistEntry(
    playlistId: string,
    recordingId: string,
    selectedRef: SourceRef | null = null,
  ): Promise<Result<string>> {
    return this.#enqueuePlaylistOp(() =>
      this.#addPlaylistEntry(playlistId, recordingId, selectedRef),
    );
  }

  async #addPlaylistEntry(
    playlistId: string,
    recordingId: string,
    selectedRef: SourceRef | null,
  ): Promise<Result<string>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (!r.playlists.some((p) => p.playlistId === playlistId)) {
      return err(appError('not-found', 'unknown playlist'));
    }
    if (!r.recordings.some((rec) => rec.id === recordingId)) {
      return err(appError('not-found', 'unknown recording'));
    }
    if (selectedRef !== null && !isTrackRef(selectedRef)) {
      return err(appError('invalid-response', 'invalid selected ref'));
    }
    const now = this.#safeNow();
    if (now === null) {
      return err(internalError());
    }
    const entryId = this.#ids.next('entry');
    const next = addPlaylistEntry(playlistSections(r), {
      entryId,
      playlistId,
      recordingId,
      selectedRef,
      addedMs: now,
    });
    const committed = await this.#commitPlaylists(r, next);
    if (!committed.ok) {
      return err(committed.error);
    }
    return ok(entryId);
  }

  removePlaylistEntry(entryId: string): Promise<Result<void>> {
    return this.#enqueuePlaylistOp(() => this.#removePlaylistEntry(entryId));
  }

  async #removePlaylistEntry(entryId: string): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (!r.playlistEntries.some((e) => e.entryId === entryId)) {
      return err(appError('not-found', 'unknown entry'));
    }
    const now = this.#safeNow();
    if (now === null) {
      return err(internalError());
    }
    const next = removePlaylistEntry(playlistSections(r), entryId, now);
    return this.#commitPlaylists(r, next);
  }

  reorderPlaylistEntry(
    entryId: string,
    move: EntryMove | null,
  ): Promise<Result<void>> {
    return this.#enqueuePlaylistOp(() =>
      this.#reorderPlaylistEntry(entryId, move),
    );
  }

  async #reorderPlaylistEntry(
    entryId: string,
    move: EntryMove | null,
  ): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const entry = r.playlistEntries.find((e) => e.entryId === entryId);
    if (entry === undefined) {
      return err(appError('not-found', 'unknown entry'));
    }
    if (move !== null) {
      const targetId = 'before' in move ? move.before : move.after;
      const target = r.playlistEntries.find((e) => e.entryId === targetId);
      if (
        target === undefined ||
        target.playlistId !== entry.playlistId ||
        targetId === entryId
      ) {
        return err(appError('not-found', 'unknown move target'));
      }
    }
    const now = this.#safeNow();
    if (now === null) {
      return err(internalError());
    }
    const next = reorderPlaylistEntry(
      playlistSections(r),
      entryId,
      move,
      now,
    );
    return this.#commitPlaylists(r, next);
  }

  /**
   * One counted play per occurrence: 50% of duration or 120 s,
   * committed first like every owned write. A no-op below the
   * threshold, on repeat, or when the clock is dead.
   */
  async #maybeRecordPlay(
    occurrenceId: string,
    recordingId: string,
    listenedMs: number,
    durationMs: number | null,
  ): Promise<void> {
    const r = this.#ready;
    if (r === null) {
      return;
    }
    if (
      !isSafeNonNegative(listenedMs) ||
      (durationMs !== null && !isSafeNonNegative(durationMs)) ||
      !countsAsPlay(listenedMs, durationMs) ||
      r.playHistory.some((e) => e.occurrenceId === occurrenceId)
    ) {
      return;
    }
    const now = this.#safeNow();
    if (now === null) {
      return;
    }
    const next = recordPlay(
      { playHistory: r.playHistory, playCounts: r.playCounts },
      {
        eventId: this.#ids.next('play'),
        recordingId,
        occurrenceId,
        listenedMs,
        durationMs,
        nowMs: now,
      },
    );
    if (!next.recorded) {
      return;
    }
    const persisted = await this.#persist({
      playHistory: next.playHistory,
      playCounts: next.playCounts,
    });
    if (!persisted.ok) {
      return;
    }
    r.playHistory = [...next.playHistory];
    r.playCounts = [...next.playCounts];
    this.#publish();
  }

  async updateSettings(settings: Settings): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    if (
      !isSettings(settings) ||
      !this.#providers.has(settings.catalogProvider) ||
      !this.#providers.has(settings.playbackProvider) ||
      (settings.lyricsProvider != null &&
        !this.#providers.has(settings.lyricsProvider)) ||
      (settings.radioProvider != null &&
        !this.#providers.has(settings.radioProvider))
    ) {
      return err(appError('invalid-response', 'invalid settings'));
    }
    const r = ready.value;
    const persisted = await this.#persist({ settings });
    if (!persisted.ok) {
      return err(persisted.error);
    }
    const providerChanged =
      settings.playbackProvider !== r.settings.playbackProvider;
    r.settings = { ...settings };
    this.#publish();
    this.#derived();
    const snap = r.queue.snapshot();
    if (
      providerChanged &&
      snap.mode === 'playing' &&
      snap.currentOccurrenceId !== null
    ) {
      // The settings command must not block on the pipeline; the
      // restart is owned work superseded attempts drain into.
      this.#own(this.#startAttempt(snap.currentOccurrenceId));
    }
    return ok(undefined);
  }

  // ---- export / import ------------------------------------------------

  /** Serialize the owned library to export-document JSON text. */
  async exportLibrary(): Promise<Result<ExportResult>> {
    const source = new CancellationSource();
    this.#opSources.add(source);
    try {
      const deadlineMs = this.#deadline();
      const context = this.#newContext('export', deadlineMs, source.signal);
      return await this.#withDeadline(
        () => exportLibrary(this.#storage, this.#clock, context),
        deadlineMs,
        source,
      );
    } finally {
      this.#opSources.delete(source);
    }
  }

  /**
   * Replace the owned library with a validated import document.
   * The document validates before anything changes; the commit is a
   * single all-or-nothing transaction; then the session rehydrates
   * from the replaced rows. Returns the confirm-screen summary.
   */
  async importLibrary(text: string): Promise<Result<ImportPreview>> {
    const preview = previewImport(text);
    if (!preview.ok) {
      return preview;
    }
    const source = new CancellationSource();
    this.#opSources.add(source);
    try {
      // Release active playback first: its recording rows are about
      // to be replaced. A clean release — the recording did not fail.
      const active = this.#active;
      if (active !== null) {
        active.source.cancel();
        active.timer?.cancel();
        if (active.handle !== undefined) {
          await this.#releaseHandle(active.handle, active.identity);
        }
        this.#active = null;
        const r = this.#ready;
        if (r !== null) {
          r.playback = { type: 'idle' };
        }
      }
      // Successor mapping may be resolving against the old rows.
      this.#mappingSource?.cancel();
      this.#mappingSource = null;
      const deadlineMs = this.#deadline();
      const context = this.#newContext('import', deadlineMs, source.signal);
      const applied = await this.#withDeadline(
        () => applyImport(this.#storage, preview.value.doc, context),
        deadlineMs,
        source,
      );
      if (!applied.ok) {
        return applied;
      }
      // Rehydrate from the replaced document: restore() performs the
      // load path whenever #ready is null.
      this.#ready = null;
      this.#state = { type: 'unhydrated' };
      const restored = await this.restore();
      if (!restored.ok) {
        return restored;
      }
      return ok(preview.value);
    } finally {
      this.#opSources.delete(source);
    }
  }

  // ---- transport ----------------------------------------------------

  async playOccurrence(occurrenceId: string): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (
      !r.queue
        .snapshot()
        .occurrences.some((o) => o.occurrenceId === occurrenceId)
    ) {
      return err(appError('not-found', 'unknown occurrence'));
    }
    try {
      r.queue.select(occurrenceId, true);
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    await this.#persist({ queue: r.queue.snapshot() });
    this.#derived();
    return this.#startAttempt(occurrenceId);
  }

  async next(): Promise<Result<void>> {
    return this.#advance('next');
  }

  async previous(): Promise<Result<void>> {
    return this.#advance('previous');
  }

  async skipCurrent(): Promise<Result<void>> {
    return this.#advance('next');
  }

  async #advance(method: 'next' | 'previous'): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const before = r.queue.snapshot();
    if (before.currentOccurrenceId === null) {
      return err(appError('no-result', 'queue has no current occurrence'));
    }
    try {
      if (method === 'next') {
        r.queue.next();
      } else {
        r.queue.previous();
      }
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    const after = r.queue.snapshot();
    if (after.revision === before.revision) {
      // First occurrence at position 0: a complete no-op.
      return ok(undefined);
    }
    if (
      method === 'previous' &&
      after.currentOccurrenceId === before.currentOccurrenceId
    ) {
      // Restart the same item: seek natively, keep the attempt.
      await this.#persist({ queue: after });
      this.#derived();
      const active = this.#active;
      if (
        active !== null &&
        active.handle !== undefined &&
        active.occurrenceId === after.currentOccurrenceId
      ) {
        const identity = {
          attemptId: active.identity.attemptId,
          queueRev: after.revision,
        };
        active.identity = identity;
        const result = await this.#bounded(() =>
          this.#player.seekTo({ positionMs: 0, identity }),
        );
        if (!result.ok) {
          await this.#failAttempt(active, result.error);
          return result;
        }
      }
      this.#publish();
      return ok(undefined);
    }
    await this.#persist({ queue: after });
    this.#derived();
    if (after.mode === 'playing' && after.currentOccurrenceId !== null) {
      return this.#startAttempt(after.currentOccurrenceId);
    }
    await this.#supersede();
    const ready2 = this.#ready;
    if (ready2 !== null) {
      ready2.playback = { type: 'idle' };
      this.#publish();
    }
    return ok(undefined);
  }

  async pause(): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const active = this.#active;
    if (active === null || active.handle === undefined) {
      return err(appError('unavailable', 'no active playback to pause'));
    }
    try {
      r.queue.pause();
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    const identity = {
      attemptId: active.identity.attemptId,
      queueRev: r.queue.snapshot().revision,
    };
    active.identity = identity;
    const result = await this.#bounded(() => this.#player.pause(identity));
    if (!result.ok) {
      await this.#failAttempt(active, result.error);
      return result;
    }
    if (!this.#isStale(active)) {
      this.#setPlaybackFromStatus(active, 'paused');
    }
    await this.#persist({ queue: r.queue.snapshot() });
    this.#derived();
    return ok(undefined);
  }

  async resume(): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const snap = r.queue.snapshot();
    if (snap.currentOccurrenceId === null) {
      return err(appError('no-result', 'queue has no current occurrence'));
    }
    try {
      r.queue.play();
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    const active = this.#active;
    if (active !== null && active.handle !== undefined) {
      const identity = {
        attemptId: active.identity.attemptId,
        queueRev: r.queue.snapshot().revision,
      };
      active.identity = identity;
      const result = await this.#bounded(() =>
        this.#player.play({
          handle: active.handle ?? '',
          identity,
          positionMs: r.queue.snapshot().positionMs,
        }),
      );
      if (!result.ok) {
        await this.#failAttempt(active, result.error);
        return result;
      }
      if (!this.#isStale(active)) {
        this.#setPlaybackFromStatus(active, 'playing');
      }
      await this.#persist({ queue: r.queue.snapshot() });
      this.#derived();
      return ok(undefined);
    }
    // No live handle (e.g. after restore): prepare fresh.
    await this.#persist({ queue: r.queue.snapshot() });
    this.#derived();
    return this.#startAttempt(snap.currentOccurrenceId);
  }

  async seekTo(positionMs: number): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const active = this.#active;
    if (!isSafeNonNegative(positionMs)) {
      return err(
        appError('invalid-response', 'position must be safe nonnegative'),
      );
    }
    if (active === null || active.handle === undefined) {
      return err(appError('unavailable', 'no active playback to seek'));
    }
    try {
      r.queue.seekTo(positionMs);
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    const identity = {
      attemptId: active.identity.attemptId,
      queueRev: r.queue.snapshot().revision,
    };
    active.identity = identity;
    const result = await this.#bounded(() =>
      this.#player.seekTo({ positionMs, identity }),
    );
    if (!result.ok) {
      await this.#failAttempt(active, result.error);
      return result;
    }
    if (!this.#isStale(active)) {
      const mode = r.queue.snapshot().mode === 'paused' ? 'paused' : 'playing';
      this.#setPlaybackFromStatus(active, mode);
    }
    await this.#persist({ queue: r.queue.snapshot() });
    this.#derived();
    return ok(undefined);
  }

  async retryCurrent(): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const current = r.queue.snapshot().currentOccurrenceId;
    if (current === null) {
      return err(appError('no-result', 'queue has no current occurrence'));
    }
    try {
      r.queue.play();
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    await this.#persist({ queue: r.queue.snapshot() });
    this.#derived();
    return this.#startAttempt(current);
  }

  async removeOccurrence(id: string): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const wasCurrent = r.queue.snapshot().currentOccurrenceId === id;
    try {
      r.queue.remove(id);
    } catch {
      return err(appError('not-found', 'unknown occurrence'));
    }
    if (wasCurrent) {
      await this.#supersede();
      const ready2 = this.#ready;
      if (ready2 !== null) {
        ready2.playback = { type: 'idle' };
      }
    }
    await this.#persist({ queue: r.queue.snapshot() });
    this.#derived();
    const snap = r.queue.snapshot();
    if (
      wasCurrent &&
      snap.mode === 'playing' &&
      snap.currentOccurrenceId !== null
    ) {
      return this.#startAttempt(snap.currentOccurrenceId);
    }
    this.#publish();
    return ok(undefined);
  }

  async moveOccurrence(id: string, toIndex: number): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    try {
      r.queue.move(id, toIndex);
    } catch (thrown) {
      return err(
        thrown instanceof TypeError
          ? appError('not-found', 'invalid move')
          : fromUnknown(thrown),
      );
    }
    await this.#persist({ queue: r.queue.snapshot() });
    this.#derived();
    this.#publish();
    return ok(undefined);
  }

  // ---- play pipeline ------------------------------------------------

  #pickRef(
    recording: Recording,
    occurrenceSelected: SourceRef | null,
  ): SourceRef | null {
    const provider = this.#ready?.settings.playbackProvider ?? '';
    if (
      occurrenceSelected !== null &&
      occurrenceSelected.provider === provider
    ) {
      return occurrenceSelected;
    }
    const mappings = recording.mappings.filter(
      (m) => m.ref.provider === provider,
    );
    const best = winningMapping(mappings);
    if (best !== undefined && best.status !== 'rejected') {
      return best.ref;
    }
    const vetoed = best?.status === 'rejected' ? best.ref : null;
    return (
      recording.sourceRefs.find(
        (s) => s.provider === provider && !sameRef(s, vetoed),
      ) ?? null
    );
  }

  async #startAttempt(occurrenceId: string): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const occurrence = r.queue
      .snapshot()
      .occurrences.find((o) => o.occurrenceId === occurrenceId);
    const recording = r.recordings.find(
      (rec) => rec.id === occurrence?.recordingId,
    );
    if (occurrence === undefined || recording === undefined) {
      return err(appError('not-found', 'occurrence or recording missing'));
    }

    // Synchronously supersede the previous attempt, then create the
    // new identity and publish preparing before any await.
    const prev = this.#active;
    this.#active = null;
    if (prev !== null) {
      prev.source.cancel();
      prev.timer?.cancel();
    }
    const deadlineMs = this.#deadline();
    const attempt: ActiveAttempt = {
      identity: {
        attemptId: this.#ids.next('attempt'),
        queueRev: r.queue.snapshot().revision,
      },
      recordingId: recording.id,
      occurrenceId,
      source: new CancellationSource(),
      deadlineMs,
      preparedHandled: false,
      endedHandled: false,
    };
    this.#active = attempt;
    r.playback = {
      type: 'preparing',
      recordingId: recording.id,
      occurrenceId,
      identity: attempt.identity,
    };
    this.#publish();
    if (prev !== null) {
      await this.#teardownAttempt(prev);
    }

    let ref = this.#pickRef(recording, occurrence.selectedRef);
    if (ref === null) {
      const resolved = await this.#resolveViaCandidates(
        attempt,
        recording,
        occurrenceId,
        deadlineMs,
      );
      if (!resolved.ok) {
        return resolved;
      }
      ref = resolved.value;
    }
    if (ref === null) {
      const error = appError('no-result', 'no playable source for recording');
      await this.#failAttempt(attempt, error);
      return err(error);
    }
    if (this.#isStale(attempt)) {
      return err(
        attempt.terminalError ?? appError('superseded', 'play superseded'),
      );
    }

    const routed = this.#router.providerFor(
      'playback.resolve',
      selectionFromSettings(r.settings),
    );
    if (!routed.ok) {
      await this.#failAttempt(attempt, routed.error);
      return err(routed.error);
    }
    const prepared = await this.#withDeadline(
      () =>
        this.#player.prepare({
          provider: r.settings.playbackProvider,
          sourceRef: ref.id,
          identity: attempt.identity,
        }),
      deadlineMs,
      attempt.source,
    );
    if (this.#isStale(attempt)) {
      return err(
        attempt.terminalError ?? appError('superseded', 'play superseded'),
      );
    }
    if (!prepared.ok) {
      await this.#failAttempt(attempt, prepared.error);
      return prepared;
    }
    attempt.requestId = prepared.value;
    const ready2 = this.#ready;
    if (
      ready2 !== null &&
      ready2.playback.type === 'preparing' &&
      attemptEq(ready2.playback.identity, attempt.identity)
    ) {
      ready2.playback = { ...ready2.playback, requestId: prepared.value };
      this.#publish();
    }
    if (!attempt.preparedHandled) {
      this.#armPrepareTimeout(attempt);
    }
    return ok(undefined);
  }

  async #resolveViaCandidates(
    attempt: ActiveAttempt,
    recording: Recording,
    occurrenceId: string,
    deadlineMs: number,
  ): Promise<Result<SourceRef>> {
    const r = this.#ready;
    if (r === null) {
      return err(internalError());
    }
    const routed = this.#router.providerFor(
      'playback.candidates',
      selectionFromSettings(r.settings),
    );
    if (!routed.ok) {
      return err(routed.error);
    }
    const provider = routed.value;
    const query: RecordingQuery = {
      title: recording.title,
      artist: recording.artist,
      album: recording.album,
      durationMs: recording.durationMs,
      versionLabels: recording.versionLabels,
      isrc: recording.isrc,
    };
    const context = this.#newContext('cand', deadlineMs, attempt.source.signal);
    const result = await this.#withDeadline(
      () => provider.candidates({ query, limit: CANDIDATE_LIMIT }, context),
      deadlineMs,
      attempt.source,
    );
    if (this.#isStale(attempt)) {
      return err(
        attempt.terminalError ?? appError('superseded', 'play superseded'),
      );
    }
    if (!result.ok) {
      await this.#failAttempt(attempt, result.error);
      return result;
    }
    const outcome = MatchingEngine.match(
      recording,
      result.value,
      recording.mappings,
    );
    if (outcome.type === 'ambiguous') {
      const error = appError('unavailable', 'match requires confirmation');
      await this.#failAttempt(attempt, error);
      return err(error);
    }
    if (outcome.type === 'unavailable') {
      const error = appError('no-result', outcome.reason);
      await this.#failAttempt(attempt, error);
      return err(error);
    }
    const ref = outcome.candidate.sourceRef;
    const matchedAt = this.#safeNow();
    if (matchedAt === null) {
      const error = internalError();
      await this.#failAttempt(attempt, error);
      return err(error);
    }
    const mapping: SourceMapping = {
      ref,
      status: 'automatic',
      matchedAtMs: matchedAt,
      evidence: outcome.evidence,
    };
    const hasMapping = recording.mappings.some((m) => sameRef(m.ref, ref));
    const updated: Recording = {
      ...recording,
      mappings: hasMapping
        ? recording.mappings.map((m) => (sameRef(m.ref, ref) ? mapping : m))
        : [...recording.mappings, mapping],
      sourceRefs: recording.sourceRefs.some((s) => sameRef(s, ref))
        ? recording.sourceRefs
        : [...recording.sourceRefs, ref],
    };
    r.recordings = r.recordings.map((rec) =>
      rec.id === updated.id ? updated : rec,
    );
    try {
      r.queue.setSelectedRef(occurrenceId, ref);
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    this.#publish();
    await this.#persist({
      recordings: r.recordings,
      queue: r.queue.snapshot(),
    });
    this.#derived();
    return ok(ref);
  }

  /** Arms the remainder of the absolute deadline for a prepared outcome. */
  #armPrepareTimeout(attempt: ActiveAttempt): void {
    const timer = new CancellationSource();
    attempt.timer = timer;
    this.#timers.add(timer);
    const work = (async () => {
      const now = this.#safeNow();
      const remaining = now === null ? 0 : attempt.deadlineMs - now;
      const slept =
        remaining > 0
          ? await this.#call(() =>
            this.#clock.sleep(remaining, timer.signal),
          )
          : ok(undefined);
      this.#timers.delete(timer);
      if (
        this.#isStale(attempt) ||
        attempt.preparedHandled ||
        this.#disposed
      ) {
        return;
      }
      if (!slept.ok) {
        // A cancelled timer (supersede/dispose) is a no-op; an
        // internal clock failure must not leave the attempt
        // preparing forever.
        if (slept.error.kind !== 'internal') {
          return;
        }
        attempt.source.cancel();
        if (attempt.requestId !== undefined) {
          await this.#bounded(() =>
            this.#player.cancelPrepare({
              requestId: attempt.requestId ?? '',
              identity: attempt.identity,
            }),
          );
        }
        await this.#failAttempt(attempt, internalError());
        return;
      }
      attempt.source.cancel();
      if (attempt.requestId !== undefined) {
        await this.#bounded(() =>
          this.#player.cancelPrepare({
            requestId: attempt.requestId ?? '',
            identity: attempt.identity,
          }),
        );
      }
      await this.#failAttempt(attempt, timeoutError());
    })();
    this.#own(work, true);
  }

  async #teardownAttempt(attempt: ActiveAttempt): Promise<void> {
    attempt.source.cancel();
    attempt.timer?.cancel();
    if (attempt.requestId !== undefined && !attempt.preparedHandled) {
      await this.#bounded(() =>
        this.#player.cancelPrepare({
          requestId: attempt.requestId ?? '',
          identity: attempt.identity,
        }),
      );
    }
    if (attempt.handle !== undefined) {
      await this.#releaseHandle(attempt.handle, attempt.identity);
    }
  }

  /** Supersede and tear down the current active attempt, if any. */
  async #supersede(): Promise<void> {
    const prev = this.#active;
    this.#active = null;
    if (prev !== null) {
      await this.#teardownAttempt(prev);
    }
  }

  /**
   * Releases a handle through the bounded port call, coalescing
   * concurrent releases per handle. Only a successful result marks
   * the handle released; failures leave it retryable.
   */
  #releaseHandle(
    handle: string,
    identity: PlaybackIdentity,
  ): Promise<Result<void>> {
    if (this.#releasedHandles.has(handle)) {
      return Promise.resolve(ok(undefined));
    }
    const existing = this.#releaseWork.get(handle);
    if (existing !== undefined) {
      return existing;
    }
    const work = (async () => {
      const result = await this.#bounded(() =>
        this.#player.release({ handle, identity }),
      );
      this.#releaseWork.delete(handle);
      if (result.ok) {
        this.#releasedHandles.add(handle);
      }
      return result;
    })();
    this.#releaseWork.set(handle, work);
    return work;
  }

  async #failAttempt(
    attempt: ActiveAttempt,
    error: AppError,
  ): Promise<void> {
    attempt.terminalError ??= error;
    attempt.source.cancel();
    attempt.timer?.cancel();
    if (attempt.handle !== undefined) {
      await this.#releaseHandle(attempt.handle, attempt.identity);
    }
    if (this.#active !== attempt) {
      // A stale failure only releases its own handle; it must never
      // overwrite a newer attempt's playback or queue state.
      return;
    }
    this.#active = null;
    const r = this.#ready;
    if (r === null) {
      return;
    }
    if (r.queue.snapshot().currentOccurrenceId === attempt.occurrenceId) {
      try {
        r.queue.markUnplayable(error);
      } catch {
        // Revision overflow: still publish the failure.
      }
    }
    r.playback = {
      type: 'failed',
      recordingId: attempt.recordingId,
      occurrenceId: attempt.occurrenceId,
      identity: attempt.identity,
      error,
    };
    this.#publish();
    await this.#persist({ queue: r.queue.snapshot() });
    this.#derived();
  }

  #setPlaybackFromStatus(
    attempt: ActiveAttempt,
    state: 'buffering' | 'playing' | 'paused',
    durationMs?: number,
  ): void {
    const r = this.#ready;
    if (r === null || attempt.handle === undefined) {
      return;
    }
    r.playback = {
      type: state,
      recordingId: attempt.recordingId,
      occurrenceId: attempt.occurrenceId,
      identity: attempt.identity,
      handle: attempt.handle,
      positionMs: r.queue.snapshot().positionMs,
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    this.#publish();
  }

  // ---- player events ------------------------------------------------

  #onPlayerEvent(event: PlayerEvent): void {
    // Serialized chain: no fire-and-forget, drainable, errors mapped.
    this.#eventTail = this.#eventTail
      .then(() => this.#handleEvent(event))
      .catch(() => {
        this.#logWarn('player event handling failed');
      });
  }

  async #handleEvent(event: PlayerEvent): Promise<void> {
    const r = this.#ready;
    if (r === null || this.#disposed) {
      return;
    }
    if (event.type === 'phase') {
      // Diagnostics only: fixed sanitized message, never raw payload.
      this.#logWarn('player phase observed');
      return;
    }
    if (event.type === 'prepare') {
      await this.#handlePrepareEvent(event);
      return;
    }
    if (event.type === 'queue-transition') {
      await this.#handleTransition(event);
      return;
    }
    // status events
    const active = this.#active;
    if (
      active === null ||
      !attemptEq(event.identity, active.identity) ||
      active.handle === undefined ||
      event.handle !== active.handle ||
      !isSafeNonNegative(event.positionMs) ||
      (event.durationMs !== undefined &&
        !isSafeNonNegative(event.durationMs))
    ) {
      if (event.state !== 'idle') {
        this.#logWarn('player status rejected');
      }
      return;
    }
    await this.#maybeRecordPlay(
      active.occurrenceId,
      active.recordingId,
      event.positionMs,
      event.durationMs ??
      r.recordings.find((rec) => rec.id === active.recordingId)
        ?.durationMs ??
      null,
    );
    if (event.state === 'failed') {
      await this.#failAttempt(
        active,
        event.error ?? appError('transient', 'player failed'),
      );
      return;
    }
    if (event.state === 'ended') {
      if (active.endedHandled) {
        return;
      }
      let marker = this.#projection;
      while (marker !== null && marker.status === 'pending') {
        await marker.done;
        marker = this.#projection;
      }
      if (
        marker !== null &&
        marker.status === 'installed' &&
        marker.currentOccurrenceId === active.occurrenceId
      ) {
        // The service owns the advance inside the installed
        // projection; the queue-transition event reconciles it. JS
        // must not advance a second time.
        active.endedHandled = true;
        return;
      }
      active.endedHandled = true;
      if (active.handle !== undefined) {
        await this.#releaseHandle(active.handle, event.identity);
      }
      if (this.#isStale(active)) {
        return;
      }
      active.source.cancel();
      active.timer?.cancel();
      this.#active = null;
      try {
        r.queue.next();
      } catch {
        return;
      }
      await this.#persist({ queue: r.queue.snapshot() });
      this.#derived();
      const snap = r.queue.snapshot();
      if (snap.currentOccurrenceId !== null && snap.mode === 'playing') {
        await this.#startAttempt(snap.currentOccurrenceId);
      } else {
        r.playback = { type: 'idle' };
        this.#publish();
      }
      return;
    }
    // Remote pause/play reconciles queue intent with the service.
    if (event.state === 'paused' && r.queue.snapshot().mode === 'playing') {
      try {
        r.queue.pause();
      } catch {
        return;
      }
      active.identity = {
        attemptId: active.identity.attemptId,
        queueRev: r.queue.snapshot().revision,
      };
      await this.#persist({ queue: r.queue.snapshot() });
      this.#derived();
    } else if (
      event.state === 'playing' &&
      r.queue.snapshot().mode === 'paused'
    ) {
      try {
        r.queue.play();
      } catch {
        return;
      }
      active.identity = {
        attemptId: active.identity.attemptId,
        queueRev: r.queue.snapshot().revision,
      };
      await this.#persist({ queue: r.queue.snapshot() });
      this.#derived();
    }
    if (this.#isStale(active)) {
      return;
    }
    r.queue.observePosition(event.positionMs);
    const mapped =
      event.state === 'idle' ||
        event.state === 'buffering' ||
        event.state === 'ready'
        ? 'buffering'
        : event.state;
    if (mapped === 'buffering' || mapped === 'playing' || mapped === 'paused') {
      const playback: SessionPlayback = {
        type: mapped,
        recordingId: active.recordingId,
        occurrenceId: active.occurrenceId,
        identity: active.identity,
        handle: active.handle,
        positionMs: event.positionMs,
        ...(event.durationMs === undefined
          ? {}
          : { durationMs: event.durationMs }),
      };
      r.playback = playback;
      this.#publish();
    }
  }

  async #handlePrepareEvent(
    event: Extract<PlayerEvent, { type: 'prepare' }>,
  ): Promise<void> {
    const active = this.#active;
    const r = this.#ready;
    if (
      active === null ||
      r === null ||
      !attemptEq(event.identity, active.identity) ||
      this.#isStale(active)
    ) {
      // Stale identity: release the handle idempotently, never play —
      // unless it is the live handle of the current active attempt.
      if (event.outcome.type === 'prepared') {
        const handle = event.outcome.stream.handle;
        if (this.#active?.handle !== handle) {
          await this.#releaseHandle(handle, event.identity);
        }
      }
      return;
    }
    if (active.preparedHandled) {
      // A duplicate prepared carrying the adopted handle is ignored;
      // only a different duplicate handle is released.
      if (
        event.outcome.type === 'prepared' &&
        event.outcome.stream.handle !== active.handle
      ) {
        await this.#releaseHandle(
          event.outcome.stream.handle,
          event.identity,
        );
      }
      return;
    }
    active.preparedHandled = true;
    active.timer?.cancel();
    if (event.outcome.type === 'failed') {
      const attempts = [event.outcome.attempt];
      await this.#failAttempt(active, event.outcome.error);
      await this.#persist({ attempts });
      return;
    }
    active.handle = event.outcome.stream.handle;
    const playResult = await this.#bounded(() =>
      this.#player.play({
        handle:
          event.outcome.type === 'prepared'
            ? event.outcome.stream.handle
            : '',
        identity: active.identity,
        positionMs: r.queue.snapshot().positionMs,
      }),
    );
    if (this.#isStale(active)) {
      return;
    }
    if (!playResult.ok) {
      await this.#failAttempt(active, playResult.error);
      return;
    }
    this.#setPlaybackFromStatus(active, 'buffering');
    await this.#persist({ attempts: [event.outcome.attempt] });
    this.#maybeMapSuccessor();
  }

  // ---- queue projection ----------------------------------------------

  #buildProjection(): QueueProjection | null {
    const r = this.#ready;
    if (r === null) {
      return null;
    }
    const snap = r.queue.snapshot();
    const items: QueueProjectionItem[] = snap.occurrences.map(
      (occurrence) => {
        const recording = r.recordings.find(
          (rec) => rec.id === occurrence.recordingId,
        );
        const selected =
          recording === undefined
            ? null
            : this.#pickRef(recording, occurrence.selectedRef);
        const artwork = recording?.artwork.find(
          (a) => typeof a.url === 'string' && a.url.startsWith('https://'),
        );
        return {
          occurrenceId: occurrence.occurrenceId,
          provider: selected?.provider ?? null,
          sourceRef: selected?.id ?? null,
          title: recording?.title ?? 'Unknown',
          artist: recording?.artist ?? null,
          artworkUrl: artwork?.url ?? null,
        };
      },
    );
    return {
      projectionId: this.#ids.next('projection'),
      queueRev: snap.revision,
      currentOccurrenceId: snap.currentOccurrenceId,
      positionMs: snap.positionMs,
      mode: snap.mode,
      items,
    };
  }

  /** Sends the latest projection; failures never undo queue intent. */
  async #projectQueue(): Promise<void> {
    const projection = this.#buildProjection();
    if (projection === null) {
      return;
    }
    const active = this.#active;
    if (active !== null && active.occurrenceId === projection.currentOccurrenceId) {
      active.identity = { ...active.identity, queueRev: projection.queueRev };
    }
    const marker: ProjectionMarker = {
      projection,
      currentOccurrenceId: projection.currentOccurrenceId,
      reconciledQueueRev: projection.queueRev,
      status: 'pending',
      done: Promise.resolve(),
    };
    this.#projection = marker;
    marker.done = (async () => {
      const result = await this.#bounded(() =>
        this.#player.setQueueProjection(projection),
      );
      // A newer projection already superseded this call's marker.
      if (this.#projection !== marker) {
        return;
      }
      marker.status = result.ok ? 'installed' : 'failed';
      if (!result.ok) {
        const r = this.#ready;
        if (r !== null) {
          // Fixed shell error: port details never surface raw.
          r.persistenceError = internalError();
          this.#publish();
        }
        this.#logWarn('queue projection failed');
      }
    })();
    await marker.done;
  }

  /**
   * Reconciles a native cursor transition inside the projected queue.
   * The service executes a cursor, not arbitrary queue edits: `from`
   * must be the last reconciled current, `ended`/`remote-next` may only
   * reach the immediate successor (or null at the tail), and
   * `remote-previous` may only restart the current or step to the
   * immediate predecessor.
   */
  async #handleTransition(
    event: Extract<PlayerEvent, { type: 'queue-transition' }>,
  ): Promise<void> {
    const r = this.#ready;
    if (r === null) {
      return;
    }
    let marker = this.#projection;
    while (marker !== null && marker.status === 'pending') {
      await marker.done;
      marker = this.#projection;
    }
    const projection =
      marker !== null && marker.status === 'installed'
        ? marker.projection
        : null;
    const items = projection?.items ?? [];
    const cursorIndex =
      projection === null
        ? -1
        : items.findIndex(
          (i) => i.occurrenceId === marker?.currentOccurrenceId,
        );
    const identityOk =
      event.toOccurrenceId === null
        ? event.identity === null && event.handle === null
        : event.identity !== null &&
        event.handle !== null &&
        event.handle.length > 0 &&
        event.identity.attemptId.length > 0 &&
        event.identity.queueRev === projection?.queueRev;
    let legal = false;
    if (event.reason === 'ended' || event.reason === 'remote-next') {
      const successor =
        cursorIndex >= 0
          ? items[cursorIndex + 1]?.occurrenceId ?? null
          : null;
      legal = event.toOccurrenceId === successor;
    } else if (event.reason === 'remote-previous') {
      const predecessor =
        cursorIndex > 0
          ? items[cursorIndex - 1]?.occurrenceId ?? null
          : null;
      legal =
        (event.toOccurrenceId !== null &&
          event.toOccurrenceId === event.fromOccurrenceId) ||
        (predecessor !== null &&
          event.toOccurrenceId === predecessor);
    }
    if (
      projection === null ||
      marker === null ||
      cursorIndex < 0 ||
      r.queue.snapshot().revision !== marker.reconciledQueueRev ||
      event.projectionId !== projection.projectionId ||
      event.projectedQueueRev !== projection.queueRev ||
      event.fromOccurrenceId !== marker.currentOccurrenceId ||
      !legal ||
      !identityOk ||
      !isSafeNonNegative(event.positionMs)
    ) {
      this.#logWarn('queue transition rejected');
      return;
    }
    if (event.reason === 'ended' && event.fromOccurrenceId !== null) {
      // The service completed the occurrence without a JS 'ended':
      // it crossed the threshold by definition. Duration is the
      // recording's own; otherwise the last observed position
      // decides under the 120 s rule.
      const from = r.queue
        .snapshot()
        .occurrences.find((o) => o.occurrenceId === event.fromOccurrenceId);
      const rec = r.recordings.find((x) => x.id === from?.recordingId);
      if (from !== undefined) {
        await this.#maybeRecordPlay(
          event.fromOccurrenceId,
          from.recordingId,
          rec?.durationMs ?? r.queue.snapshot().positionMs,
          rec?.durationMs ?? null,
        );
      }
    }
    const toId = event.toOccurrenceId;
    try {
      // A null target means the cursor ran off the end: stopped.
      r.queue.reconcileNativeCurrent(
        toId,
        toId === null ? 0 : event.positionMs,
        toId !== null,
      );
    } catch {
      this.#logWarn('queue transition rejected');
      return;
    }
    marker.currentOccurrenceId = toId;
    marker.reconciledQueueRev = r.queue.snapshot().revision;
    // Adopt the service-reported attempt, superseding the current one.
    const prev = this.#active;
    this.#active = null;
    if (prev !== null) {
      prev.source.cancel();
      prev.timer?.cancel();
    }
    if (event.identity !== null && event.handle !== null && toId !== null) {
      const snap2 = r.queue.snapshot();
      const occurrence = snap2.occurrences.find(
        (o) => o.occurrenceId === toId,
      );
      // Statuses continue to echo the immutable service projection until
      // app intent installs a new one; reconciliation alone must not re-key it.
      const identity = event.identity;
      const attempt: ActiveAttempt = {
        identity,
        recordingId: occurrence?.recordingId ?? '',
        occurrenceId: toId,
        source: new CancellationSource(),
        deadlineMs: this.#deadline(),
        handle: event.handle,
        preparedHandled: true,
        endedHandled: false,
      };
      this.#active = attempt;
      r.playback = {
        type: 'buffering',
        recordingId: attempt.recordingId,
        occurrenceId: toId,
        identity,
        handle: event.handle,
        positionMs: event.positionMs,
      };
    } else {
      r.playback = { type: 'idle' };
    }
    this.#publish();
    if (prev !== null) {
      prev.source.cancel();
      prev.timer?.cancel();
      // The service may reuse the same handle for the new cursor
      // position — releasing it would kill the live stream.
      if (prev.handle !== undefined && prev.handle !== event.handle) {
        await this.#releaseHandle(prev.handle, prev.identity);
      }
      if (prev.requestId !== undefined && !prev.preparedHandled) {
        await this.#bounded(() =>
          this.#player.cancelPrepare({
            requestId: prev.requestId ?? '',
            identity: prev.identity,
          }),
        );
      }
    }
    await this.#persist({ queue: r.queue.snapshot() });
    // Native may already be several moves ahead. Re-projecting this
    // intermediate cursor would stop its live stream and reject queued moves.
    this.#mappingSource?.cancel();
    this.#mappingSource = null;
    this.#maybeMapSuccessor();
  }

  // ---- successor mapping ----------------------------------------------

  /**
   * At most one mapping-only task: after a successful prepare with
   * prefetch enabled, resolves the immediate successor's ref so the
   * service can freshly attach it while JS is constrained. Never
   * touches current playback; failures leave a null ref (honest
   * unavailable) and a fixed diagnostic.
   */
  #maybeMapSuccessor(): void {
    const r = this.#ready;
    if (
      r === null ||
      !r.settings.prefetch ||
      this.#disposed ||
      // Only when the current prepare has succeeded — the service
      // needs refs it can freshly attach for the immediate successor.
      this.#active?.preparedHandled !== true
    ) {
      return;
    }
    const snap = r.queue.snapshot();
    const index = snap.occurrences.findIndex(
      (o) => o.occurrenceId === snap.currentOccurrenceId,
    );
    const successor =
      index >= 0 ? snap.occurrences[index + 1] : undefined;
    if (successor === undefined) {
      return;
    }
    const recording = r.recordings.find(
      (rec) => rec.id === successor.recordingId,
    );
    if (recording === undefined) {
      return;
    }
    // A resolved ref — selected, user-confirmed, or unvetoed source
    // ref — is already projected; no mapping task is needed.
    if (this.#pickRef(recording, successor.selectedRef) !== null) {
      return;
    }
    const routed = this.#router.providerFor(
      'playback.candidates',
      selectionFromSettings(r.settings),
    );
    if (!routed.ok) {
      return;
    }
    const provider = routed.value;
    const source = new CancellationSource();
    this.#mappingSource = source;
    const occurrenceId = successor.occurrenceId;
    const recordingId = recording.id;
    const work = (async () => {
      const deadlineMs = this.#deadline();
      const query: RecordingQuery = {
        title: recording.title,
        artist: recording.artist,
        album: recording.album,
        durationMs: recording.durationMs,
        versionLabels: recording.versionLabels,
        isrc: recording.isrc,
      };
      const context = this.#newContext('map', deadlineMs, source.signal);
      const result = await this.#withDeadline(
        () => provider.candidates({ query, limit: CANDIDATE_LIMIT }, context),
        deadlineMs,
        source,
      );
      if (
        source.signal.cancelled ||
        this.#mappingSource !== source ||
        !result.ok
      ) {
        if (!source.signal.cancelled && result.ok === false) {
          this.#logWarn('successor mapping failed');
        }
        return;
      }
      const ready2 = this.#ready;
      if (ready2 === null) {
        return;
      }
      const rec = ready2.recordings.find((x) => x.id === recordingId);
      if (rec === undefined) {
        return;
      }
      const outcome = MatchingEngine.match(rec, result.value, rec.mappings);
      if (outcome.type !== 'matched') {
        this.#logWarn('successor mapping unresolved');
        return;
      }
      const ref = outcome.candidate.sourceRef;
      const matchedAt = this.#safeNow();
      if (matchedAt === null) {
        return;
      }
      // Same-ref conflicts resolve through the shared precedence
      // rule; an automatic mapping never replaces or shadows a
      // user-confirmed/rejected winner, and an older automatic
      // winner is refreshed in place.
      const winner = winningMapping(
        rec.mappings.filter((m) => sameRef(m.ref, ref)),
      );
      const automatic: SourceMapping = {
        ref,
        status: 'automatic',
        matchedAtMs: matchedAt,
        evidence: outcome.evidence,
      };
      let mappings = rec.mappings;
      if (winner === undefined) {
        mappings = [...rec.mappings, automatic];
      } else if (
        winner.status === 'automatic' &&
        winner.matchedAtMs < matchedAt
      ) {
        mappings = rec.mappings.map((m) =>
          sameRef(m.ref, ref) ? automatic : m,
        );
      }
      const updated: Recording = {
        ...rec,
        mappings,
        sourceRefs: rec.sourceRefs.some((s) => sameRef(s, ref))
          ? rec.sourceRefs
          : [...rec.sourceRefs, ref],
      };
      // Recheck it is still the immediate successor of the same
      // current under the same playback provider, and that the
      // resolved ref actually wins selection precedence.
      const snapNow = ready2.queue.snapshot();
      const currentIndex = snapNow.occurrences.findIndex(
        (o) => o.occurrenceId === snapNow.currentOccurrenceId,
      );
      const immediate =
        currentIndex >= 0 ? snapNow.occurrences[currentIndex + 1] : undefined;
      if (
        immediate === undefined ||
        immediate.occurrenceId !== occurrenceId ||
        ready2.settings.playbackProvider !== provider.id ||
        !sameRef(this.#pickRef(updated, immediate.selectedRef), ref)
      ) {
        return;
      }
      ready2.recordings = ready2.recordings.map((x) =>
        x.id === updated.id ? updated : x,
      );
      try {
        ready2.queue.setSelectedRef(occurrenceId, ref);
      } catch {
        return;
      }
      this.#publish();
      await this.#persist({
        recordings: ready2.recordings,
        queue: ready2.queue.snapshot(),
      });
      this.#own(this.#projectQueue());
    })();
    this.#own(work);
  }

  // ---- lifecycle ----------------------------------------------------

  async drain(): Promise<void> {
    for (; ;) {
      await this.#eventTail;
      const pending = [
        ...this.#ownedWork,
        ...this.#releaseWork.values(),
      ];
      if (pending.length === 0) {
        return;
      }
      await Promise.allSettled(pending);
    }
  }

  /** Full drain including armed deadline work; used by dispose. */
  async #drainAll(): Promise<void> {
    for (; ;) {
      await this.#eventTail;
      const pending = [
        ...this.#ownedWork,
        ...this.#releaseWork.values(),
        ...this.#deadlineWork,
      ];
      if (pending.length === 0) {
        return;
      }
      await Promise.allSettled(pending);
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#mappingSource?.cancel();
    this.#mappingSource = null;
    for (const timer of [...this.#timers]) {
      timer.cancel();
    }
    for (const source of [...this.#opSources]) {
      source.cancel();
    }
    const active = this.#active;
    this.#active = null;
    if (active !== null) {
      await this.#teardownAttempt(active);
    }
    this.#playerUnsub();
    await this.#drainAll();
  }
}
