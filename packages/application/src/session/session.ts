import { CancellationSource } from '../cancellation.ts';
import type {
  CancellationSignal,
  OperationContext,
} from '../cancellation.ts';
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
  isSourceRef,
  isString,
  isTrackMetadata,
  isTrackRef,
  mergeRecordingMetadata,
  recordingFromMetadata,
} from '../domain.ts';
import { countsAsPlay, recordPlay } from '../library/history.ts';
import { isPersistedState } from '../library/library.ts';
import type {
  Entity,
  EntitySourceRef,
  LyricsCacheEntry,
  MatchReview,
  PlayCount,
  PlayEvent,
  Playlist,
  PlaylistEntry,
} from '../library/library.ts';
import {
  createCorrections,
  effectiveMapping,
  isRefRejected,
} from '../library/corrections.ts';
import type {
  Corrections,
  ReviewFilter,
} from '../library/corrections.ts';
import { LOCAL_PROVIDER, localTrackRef } from '../domain.ts';
import {
  applyAcceptance,
  lyricsCacheEntry,
  lyricsFromCache,
  lyricsSheet,
} from '../library/lyrics.ts';
import type { LyricsSheet } from '../library/lyrics.ts';
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
import { MatchingEngine } from '../matching/matching-engine.ts';
import type { MatchOutcome } from '../matching/matching-engine.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { IdPort, RandomPort } from '../ports/runtime.ts';
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
  LyricsQuery,
  ProviderPort,
  RadioPage,
  RadioSeed,
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
import {
  isRadioPage,
  planRadioPage,
  publishRadio,
  remainingAfterCurrent,
  shouldGrowRadio,
  RADIO_FETCH_AHEAD,
} from '../queue/radio-tail.ts';
import type { RadioTail, RadioTailRecord } from '../queue/radio-tail.ts';

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
  /**
   * The lazy radio tail (queue/radio-tail.ts): `null` unless a radio
   * was seeded this session — runtime-only, never persisted; the
   * queue occurrences it appended are ordinary persisted rows.
   */
  readonly radio: RadioTail | null;
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
  readonly random: RandomPort;
  readonly log: LogPort;
  readonly defaults: Settings;
  /**
   * Slice-3 offline hook: returns a playable local URI (file:// or
   * content://) when the recording has `available` bytes on disk or
   * is a provenance:'local' file, else null. A hit makes pickRef
   * synthesize `provider:'local'` with the URI as the ref id — owned
   * bytes, never the network. A pin for the active playback provider
   * still wins; a foreign pin can't resolve under it anyway.
   */
  readonly localPlaybackFor?: (recordingId: string) => string | null;
  /**
   * Slice-3 zero-resolution gate: synchronous "is the network usable"
   * read. When it reports false, a play attempt whose pick isn't
   * `provider:'local'` fails `unavailable` BEFORE any candidates/
   * resolve/prepare call, and unowned projection items carry
   * provider:null/sourceRef:null. Omitted = optimistically online
   * (platforms without a connectivity surface keep prior behavior).
   */
  readonly isOnline?: () => boolean;
};

const OP_DEADLINE_MS = 15_000;
const CANDIDATE_LIMIT = 25;
// Status ticks fire ~1 s; a position delta above this between ticks
// is a seek/jump, not played time.
const MAX_TICK_DELTA_MS = 2_500;

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
  /** Last accepted status position — deltas feed `listenedMs`. */
  lastStatusPositionMs?: number;
  /** Actual played span summed from tick deltas (seeks don't count). */
  listenedMsAccum: number;
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
  /**
   * Disposable lyrics cache (data.md): held for `getLyrics` reads but
   * deliberately not published — caches are not session state, and
   * `getLyrics` is the per-recording accessor, same class as the
   * storage-only artwork cache.
   */
  lyricsCache: LyricsCacheEntry[];
  queue: QueueEngine;
  /**
   * Queue-write generation: bumped inside a storage segment when a
   * queue commit fails and rolls the engine back. Writes enqueued
   * with the old epoch captured the engine after that mutation — the
   * rollback erased them — so they report the boundary failure
   * instead of committing a state their own mutation never landed in.
   */
  queueEpoch: number;
  /**
   * Revision of the last durably committed queue snapshot. A queue
   * command commits its own post-mutation snapshot, never the live
   * engine — without this, a segment-fresh draft (mapping adoption)
   * could land first and an earlier-captured stale snapshot would
   * regress the store. A queued write whose revision is already
   * covered is durable through the covering commit, so it skips.
   */
  queueCommittedRev: number;
  settings: Settings;
  playback: SessionPlayback;
  radio: RadioTailRecord | null;
  persistenceError: AppError | undefined;
};

function playlistSections(r: Ready): PlaylistState {
  return { playlists: r.playlists, entries: r.playlistEntries };
}

/**
 * What a staged write produces: the section batch to commit plus the
 * in-memory apply. An omitted `batch` means nothing durable changed
 * — the apply still runs and publishes.
 */
type CommitStage<T> = {
  readonly batch?: StorageBatch;
  readonly apply: (r: Ready) => T;
};

/**
 * Find-or-create the recording a provider result describes, purely:
 * an existing recording carrying the same source ref is refreshed in
 * place, otherwise a new row appends. The caller stages the result
 * through a commit before mirroring it — commit-first owned writes.
 */
function upsertRecordingIn(
  recordings: readonly Recording[],
  metadata: TrackMetadata,
  newId: string,
): { readonly recordings: Recording[]; readonly recording: Recording } {
  const ref = metadata.sourceRef;
  const existing = recordings.find((rec) =>
    rec.sourceRefs.some((s) => sameRef(s, ref)),
  );
  if (existing === undefined) {
    const recording = recordingFromMetadata(metadata, newId);
    return { recordings: [...recordings, recording], recording };
  }
  const hasRef = existing.sourceRefs.some((s) => sameRef(s, ref));
  const updated: Recording = {
    ...mergeRecordingMetadata(existing, metadata),
    sourceRefs: hasRef
      ? existing.sourceRefs
      : [...existing.sourceRefs, ref],
  };
  return {
    recordings: recordings.map((rec) =>
      rec.id === updated.id ? updated : rec,
    ),
    recording: updated,
  };
}

/**
 * Merge an automatic mapping into a recording row — same-ref
 * conflicts resolve through the shared precedence rule: an automatic
 * mapping never replaces or shadows a user-confirmed/rejected
 * winner, and an older automatic winner is refreshed in place.
 */
function adoptAutomaticMapping(
  rec: Recording,
  ref: SourceRef,
  mapping: SourceMapping,
): Recording {
  const winner = winningMapping(
    rec.mappings.filter((m) => sameRef(m.ref, ref)),
  );
  let mappings = rec.mappings;
  if (winner === undefined) {
    mappings = [...rec.mappings, mapping];
  } else if (
    winner.status === 'automatic' &&
    winner.matchedAtMs < mapping.matchedAtMs
  ) {
    mappings = rec.mappings.map((m) => (sameRef(m.ref, ref) ? mapping : m));
  }
  return {
    ...rec,
    mappings,
    sourceRefs: rec.sourceRefs.some((s) => sameRef(s, ref))
      ? rec.sourceRefs
      : [...rec.sourceRefs, ref],
  };
}

/**
 * A published snapshot must never alias mutable session state:
 * section elements freeze recursively so a listener that mutates a
 * row cannot corrupt the mirror. `Object.isFrozen` short-circuits
 * already-frozen subtrees, so repeat publishes stay cheap.
 */
function deepFreeze<T>(value: T): T {
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || seen.has(node)) {
      return;
    }
    seen.add(node);
    for (const child of Object.values(node)) {
      visit(child);
    }
    Object.freeze(node);
  };
  visit(value);
  return value;
}

/** Latest sent projection plus its install status at the service. */
type ProjectionMarker = {
  readonly projection: QueueProjection;
  currentOccurrenceId: string | null;
  reconciledQueueRev: number;
  status: 'pending' | 'installed' | 'failed' | 'superseded';
  done: Promise<void>;
};

export class Session {
  readonly #storage: StoragePort;
  readonly #player: PlayerPort;
  readonly #providers: Map<string, ProviderPort>;
  readonly #router: ProviderRouter;
  readonly #clock: ClockPort;
  readonly #ids: IdPort;
  readonly #random: RandomPort;
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
  #lyricsTail: Promise<void> = Promise.resolve();
  /**
   * The one storage tail: every commit — session writes, review ops,
   * the import swap — serializes through it, so a read-modify-write
   * corrections op can never interleave with a session section write
   * (corrections load→commit races session recordings writers).
   */
  #storageTail: Promise<void> = Promise.resolve();
  readonly #corrections: Corrections;
  #radioTail: Promise<void> = Promise.resolve();
  #entityTail: Promise<void> = Promise.resolve();
  #listeners = new Set<(state: SessionState) => void>();
  #playerUnsub: () => void;
  #disposed = false;
  #projection: ProjectionMarker | null = null;
  #mappingSource: CancellationSource | null = null;
  readonly #localPlaybackFor: (recordingId: string) => string | null;
  readonly #isOnline: () => boolean;
  #restorePromise: Promise<Result<void>> | null = null;

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
    this.#random = deps.random;
    this.#log = deps.log;
    this.#localPlaybackFor = deps.localPlaybackFor ?? (() => null);
    this.#isOnline = deps.isOnline ?? (() => true);
    this.#corrections = createCorrections({
      storage: deps.storage,
      ids: deps.ids,
      clock: deps.clock,
      log: deps.log,
    });
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
      const base = deepFreeze({
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
        radio: publishRadio(ready.radio),
        // The published error is a clone sealed by the same freeze —
        // a subscriber must never mutate the mirror's own error.
        ...(ready.persistenceError === undefined
          ? {}
          : { persistenceError: { ...ready.persistenceError } }),
      });
      this.#state = base;
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

  /**
   * Serializes one storage segment on `#storageTail`. Review ops run
   * whole read-modify-write cycles inside a segment, so they are
   * atomic against every session commit — and a commit queued behind
   * them evaluates its batch against the freshest mirror.
   */
  #enqueueStorage<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    const work = this.#storageTail.then(fn);
    this.#storageTail = work.then(() => undefined, () => undefined);
    return work;
  }

  /** Bounded, nonfatal persistence. Failures publish persistenceError. */
  async #persist(
    batch: StorageBatch | (() => StorageBatch),
  ): Promise<Result<void>> {
    // The Ready the caller staged against — a commit queued behind an
    // import's ready-swap carries sections from a discarded library
    // and must never land.
    const generation = this.#ready;
    const source = new CancellationSource();
    this.#opSources.add(source);
    let result: Result<void>;
    try {
      result = await this.#enqueueStorage(async () => {
        if (generation === null || generation !== this.#ready) {
          return err(
            appError('superseded', 'session state was replaced'),
          );
        }
        const deadlineMs = this.#deadline();
        const context = this.#newContext('persist', deadlineMs, source.signal);
        // A thunk batch evaluates inside the segment so it commits
        // the freshest mirror, not the state captured at call time.
        const evaluated = typeof batch === 'function' ? batch() : batch;
        const committed = await this.#withDeadline(
          () => this.#storage.commit(evaluated, context),
          deadlineMs,
          source,
        );
        if (committed.ok && evaluated.queue !== undefined) {
          generation.queueCommittedRev = Math.max(
            generation.queueCommittedRev,
            evaluated.queue.revision,
          );
        }
        return committed;
      });
    } finally {
      this.#opSources.delete(source);
    }
    const ready = this.#ready;
    if (ready !== null && ready === generation) {
      ready.persistenceError = result.ok ? undefined : result.error;
      this.#publish();
    }
    return result.ok ? ok(undefined) : result;
  }

  /**
   * Commit-first mutation: `stage` computes its batch inside the
   * storage segment — against the freshest committed mirror — and
   * the apply lands in the same segment right after a successful
   * commit. A failed commit changes nothing, so `err()` is honest
   * and no stale captured batch can ride a later unrelated commit.
   */
  async #commitStaged<T>(
    stage: (r: Ready) => Result<CommitStage<T>>,
  ): Promise<Result<T>> {
    const generation = this.#ready;
    const source = new CancellationSource();
    this.#opSources.add(source);
    try {
      return await this.#enqueueStorage(async () => {
        const r = this.#ready;
        if (generation === null || r !== generation) {
          return err(
            appError('superseded', 'session state was replaced'),
          );
        }
        const staged = stage(r);
        if (!staged.ok) {
          return err(staged.error);
        }
        const { batch, apply } = staged.value;
        if (batch !== undefined) {
          const deadlineMs = this.#deadline();
          const context = this.#newContext(
            'persist',
            deadlineMs,
            source.signal,
          );
          const committed = await this.#withDeadline(
            () => this.#storage.commit(batch, context),
            deadlineMs,
            source,
          );
          if (!committed.ok) {
            r.persistenceError = committed.error;
            this.#publish();
            return err(committed.error);
          }
          if (batch.queue !== undefined) {
            r.queueCommittedRev = Math.max(
              r.queueCommittedRev,
              batch.queue.revision,
            );
          }
          r.persistenceError = undefined;
        }
        const outcome = apply(r);
        this.#publish();
        return ok(outcome);
      });
    } finally {
      this.#opSources.delete(source);
    }
  }

  /**
   * Queue commit with a caller-visible failure contract. `before` is
   * the pre-mutation snapshot; the mutation itself stays synchronous
   * at call time — a pending 'prepared' outcome reads `r.queue`
   * directly, outside the storage tail.
   *
   * Rollback and the `queueEpoch` bump run inside the segment so a
   * write queued behind a failed one observes the new epoch before
   * its own commit and aborts honestly: the rollback already erased
   * its queue mutation, so committing would claim a state it did not
   * produce. (Writes that touch the queue plus another section —
   * mapping adoptions — stage through `#commitStaged` instead, where
   * the mutation is derived inside the segment and the engine swaps
   * in only after a successful commit.)
   */
  async #persistQueue(r: Ready, before: QueueSnapshot): Promise<Result<void>> {
    const epoch = r.queueEpoch;
    // This command's own post-mutation state — captured at call time,
    // never the live engine at segment time. Committing `after` keeps
    // each command's durable batch to what it itself produced: a later
    // command's mutation can neither ride this commit nor survive in
    // storage after its own commit rolls memory back.
    const after = r.queue.snapshot();
    const generation = this.#ready;
    const source = new CancellationSource();
    this.#opSources.add(source);
    try {
      return await this.#enqueueStorage(async () => {
        const ready = this.#ready;
        if (generation === null || ready !== generation) {
          return err(
            appError('superseded', 'session state was replaced'),
          );
        }
        if (epoch !== r.queueEpoch) {
          // An earlier queue commit failed and rolled the engine back
          // over this write's mutation — nothing is left for this
          // write to commit, so report the boundary failure instead.
          return err(
            appError('superseded', 'queue state was rolled back'),
          );
        }
        if (after.revision <= r.queueCommittedRev) {
          // A later-enqueued segment (e.g. a staged mapping adoption)
          // already committed a snapshot that contains this mutation —
          // re-committing the earlier revision would regress the store.
          return ok(undefined);
        }
        const deadlineMs = this.#deadline();
        const context = this.#newContext('persist', deadlineMs, source.signal);
        const committed = await this.#withDeadline(
          () => this.#storage.commit({ queue: after }, context),
          deadlineMs,
          source,
        );
        if (!committed.ok) {
          r.queueEpoch += 1;
          r.queue = new QueueEngine(before);
          r.persistenceError = committed.error;
          this.#derived();
          this.#publish();
          return err(committed.error);
        }
        r.queueCommittedRev = after.revision;
        r.persistenceError = undefined;
        return committed;
      });
    } finally {
      this.#opSources.delete(source);
    }
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
    this.#maybeGrowRadio();
  }

  // ---- restore ----------------------------------------------------

  async restore(): Promise<Result<void>> {
    if (this.#ready !== null) {
      return ok(undefined);
    }
    // Concurrent restore callers share the in-flight load — a
    // second parallel restore would double the storage round-trip
    // for nothing. The memo only holds while a load is in flight:
    // a settled failure must NOT stick — retry has to reload.
    if (this.#restorePromise === null) {
      const p = this.#doRestore().finally(() => {
        // Only clear the promise this closure belongs to — a rehydrate
        // may have already replaced it with a newer in-flight restore.
        if (this.#ready === null && this.#restorePromise === p) {
          this.#restorePromise = null;
        }
      });
      this.#restorePromise = p;
    }
    return this.#restorePromise;
  }

  async #doRestore(): Promise<Result<void>> {
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
      lyricsCache: [...data.lyricsCache],
      queue,
      queueEpoch: 0,
      queueCommittedRev: data.queue.revision,
      settings: { ...data.settings },
      playback: { type: 'idle' },
      radio: null,
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

  async enqueueMetadata(metadata: TrackMetadata): Promise<Result<string>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    if (!isTrackMetadata(metadata)) {
      return err(appError('invalid-response', 'metadata failed validation'));
    }
    const staged = await this.#commitStaged((r) => {
      const up = upsertRecordingIn(
        r.recordings,
        metadata,
        this.#ids.next('rec'),
      );
      const occurrenceId = this.#ids.next('occ');
      const draft = new QueueEngine(r.queue.snapshot());
      draft.enqueue({
        occurrenceId,
        recordingId: up.recording.id,
        selectedRef:
          metadata.sourceRef.provider === r.settings.playbackProvider
            ? metadata.sourceRef
            : null,
      });
      return ok({
        batch: { recordings: up.recordings, queue: draft.snapshot() },
        apply: (rr) => {
          rr.recordings = [...up.recordings];
          rr.queue = draft;
          return occurrenceId;
        },
      });
    });
    this.#derived();
    if (!staged.ok) {
      return err(staged.error);
    }
    return ok(staged.value);
  }

  /**
   * Reconcile in-memory recordings with a LocalFileSource scan commit.
   * The source owns provenance:'local' rows — it persists them itself —
   * so after a scan the session adopts the source's snapshot for those
   * ids: upsert every row it reports and drop in-memory local rows it
   * no longer reports (file removed). Non-local rows pass through.
   * No persist: the source already committed the same rows.
   */
  syncLocalRecordings(localRows: readonly Recording[]): Result<void> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    // Only local rows are adopted — a foreign row would overwrite a
    // catalog mutation a racing op just made in memory.
    const committed = localRows.filter((rec) => rec.provenance === 'local');
    const committedIds = new Set(committed.map((rec) => rec.id));
    const byId = new Map(committed.map((rec) => [rec.id, rec]));
    const known = new Set<string>();
    const merged: Recording[] = [];
    for (const rec of r.recordings) {
      known.add(rec.id);
      if (rec.provenance === 'local' && !committedIds.has(rec.id)) {
        continue;
      }
      merged.push(byId.get(rec.id) ?? rec);
    }
    for (const rec of committed) {
      if (!known.has(rec.id)) {
        merged.push(rec);
      }
    }
    r.recordings = merged;
    this.#publish();
    this.#derived();
    return ok(undefined);
  }

  /**
   * Connectivity edge from the platform monitor — invoked AFTER the
   * `isOnline` dep already reads the new value. Re-projects the
   * native queue so offline items lose their remote refs (and regain
   * them on reconnect), cancels in-flight speculative mapping, and
   * re-evaluates the successor/radio triggers under the new truth.
   */
  connectivityChanged(): void {
    if (!this.#requireReady().ok) {
      return;
    }
    this.#derived();
  }

  async enqueueRecording(recordingId: string): Promise<Result<string>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (!r.recordings.some((rec) => rec.id === recordingId)) {
      return err(appError('not-found', 'unknown recording'));
    }
    const staged = await this.#commitStaged((cur) => {
      const live = cur.recordings.find((rec) => rec.id === recordingId);
      if (live === undefined) {
        return err(appError('not-found', 'unknown recording'));
      }
      const occurrenceId = this.#ids.next('occ');
      const draft = new QueueEngine(cur.queue.snapshot());
      draft.enqueue({
        occurrenceId,
        recordingId,
        selectedRef: this.#pickRef(live, null),
      });
      return ok({
        batch: { queue: draft.snapshot() },
        apply: (rr) => {
          rr.queue = draft;
          return occurrenceId;
        },
      });
    });
    this.#derived();
    if (!staged.ok) {
      return err(staged.error);
    }
    return ok(staged.value);
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
    const staged = await this.#commitStaged((r) => {
      const up = upsertRecordingIn(
        r.recordings,
        metadata,
        this.#ids.next('rec'),
      );
      return ok({
        batch: { recordings: up.recordings },
        apply: (rr) => {
          rr.recordings = [...up.recordings];
          return up.recording.id;
        },
      });
    });
    this.#derived();
    if (!staged.ok) {
      return err(staged.error);
    }
    return ok(staged.value);
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
    const staged = await this.#commitStaged((r) => {
      const draft = new QueueEngine(r.queue.snapshot());
      const occurrenceIds: string[] = [];
      for (const item of resolved) {
        const occurrenceId = this.#ids.next('occ');
        occurrenceIds.push(occurrenceId);
        draft.enqueue({
          occurrenceId,
          recordingId: item.recordingId,
          selectedRef: item.ref,
        });
      }
      return ok({
        batch: { queue: draft.snapshot() },
        apply: (rr) => {
          rr.queue = draft;
          return occurrenceIds[0] ?? '';
        },
      });
    });
    this.#derived();
    if (!staged.ok) {
      return err(staged.error);
    }
    return this.playOccurrence(staged.value);
  }

  /**
   * Play provider items that may not be recordings yet: the whole list
   * validates first, each item materializes via `upsertRecordingIn`,
   * one enqueue + one commit covers the batch, then the first new
   * occurrence plays. `shuffle` draws a uniform random order for the
   * enqueued occurrences — a play-order shuffle, not a queue mode.
   */
  async playMetadata(
    items: readonly TrackMetadata[],
    options?: { readonly shuffle?: boolean | undefined },
  ): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    if (items.length === 0) {
      return err(appError('invalid-response', 'empty play list'));
    }
    for (const item of items) {
      if (!isTrackMetadata(item)) {
        return err(appError('invalid-response', 'metadata failed validation'));
      }
    }
    const ordered =
      options?.shuffle === true
        ? items
          // Random-key sort — uniform over permutations, no index
          // access under noUncheckedIndexedAccess.
          .map((item) => ({ item, rank: this.#random.unit() }))
          .sort((a, b) => a.rank - b.rank)
          .map(({ item }) => item)
        : items;
    const staged = await this.#commitStaged((r) => {
      let recordings = r.recordings;
      const draft = new QueueEngine(r.queue.snapshot());
      const occurrenceIds: string[] = [];
      for (const metadata of ordered) {
        const up = upsertRecordingIn(
          recordings,
          metadata,
          this.#ids.next('rec'),
        );
        recordings = up.recordings;
        const occurrenceId = this.#ids.next('occ');
        occurrenceIds.push(occurrenceId);
        draft.enqueue({
          occurrenceId,
          recordingId: up.recording.id,
          selectedRef:
            metadata.sourceRef.provider === r.settings.playbackProvider
              ? metadata.sourceRef
              : null,
        });
      }
      return ok({
        batch: { recordings, queue: draft.snapshot() },
        apply: (rr) => {
          rr.recordings = [...recordings];
          rr.queue = draft;
          return occurrenceIds[0] ?? '';
        },
      });
    });
    this.#derived();
    if (!staged.ok) {
      return err(staged.error);
    }
    return this.playOccurrence(staged.value);
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

  // ---- lyrics ---------------------------------------------------------

  /**
   * Serves the lyrics sheet for a recording. Serialized like every
   * owned-write op; the caller's context (if any) links its
   * cancellation and tightens — never loosens — the op deadline.
   * A cache hit re-runs the same acceptance rules as a live fetch:
   * a cached plain stays plain and never presents as synced.
   */
  getLyrics(
    recordingId: string,
    context?: OperationContext,
  ): Promise<Result<LyricsSheet>> {
    const work = this.#lyricsTail.then(() =>
      this.#getLyrics(recordingId, context),
    );
    this.#lyricsTail = work.then(() => undefined, () => undefined);
    this.#own(work);
    return work;
  }

  // ---- corrections ----------------------------------------------------

  /**
   * The match-review queue for Diagnostics — pending reviews by
   * default; `{status:'all'}` lists resolved ones too. Live reads,
   * not session state: corrections are user actions, rare by design.
   */
  listMatchReviews(
    filter?: ReviewFilter,
    context?: OperationContext,
  ): Promise<Result<readonly MatchReview[]>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return Promise.resolve(err(ready.error));
    }
    return this.#corrections.listReviews(filter, context?.signal);
  }

  confirmReview(
    reviewId: string,
    candidateIndex: number,
    context?: OperationContext,
  ): Promise<Result<MatchReview>> {
    return this.#reviewOp(
      (signal) => this.#corrections.confirm(reviewId, candidateIndex, signal),
      context,
    );
  }

  rejectReview(
    reviewId: string,
    context?: OperationContext,
  ): Promise<Result<MatchReview>> {
    return this.#reviewOp(
      (signal) => this.#corrections.reject(reviewId, signal),
      context,
    );
  }

  /**
   * Reverts a resolution: the written verdict mappings are removed
   * and the review re-enters the pending queue — the ambiguity was
   * never actually resolved.
   */
  undoReview(
    reviewId: string,
    context?: OperationContext,
  ): Promise<Result<MatchReview>> {
    return this.#reviewOp(
      (signal) => this.#corrections.undo(reviewId, signal),
      context,
    );
  }

  /**
   * Serialized review mutation: the module commits recordings +
   * matchReviews atomically, then the session reads the affected
   * recording back so `#pickRef` (via `effectiveMapping`) and the
   * projected queue follow the verdict. The read-back merges into
   * in-memory recordings rather than replacing them — a concurrent
   * mutation on another tail can be newer than the reload. A
   * read-back failure flags persistenceError like `#persist` does —
   * the verdict still landed.
   */
  #reviewOp(
    op: (signal?: CancellationSignal) => Promise<Result<MatchReview>>,
    context?: OperationContext,
  ): Promise<Result<MatchReview>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return Promise.resolve(err(ready.error));
    }
    const r = ready.value;
    // The whole review op — corrections' load->mutate->commit, the
    // reload, and the mirror merge — is a single segment on the
    // storage tail: it serializes against every session commit, so a
    // verdict can never be clobbered by an interleaved recordings
    // write (and vice versa).
    const work = this.#enqueueStorage(async () => {
      // Queued behind an import's ready-swap, a staged review would
      // otherwise apply an old-generation verdict to the imported
      // database — same guard as #persist/#commitStaged.
      if (this.#ready !== r) {
        return err(
          appError('superseded', 'session state was replaced'),
        );
      }
      const result = await op(context?.signal);
      if (!result.ok) {
        return result;
      }
      // The reload is bounded like every storage call — a hanging
      // load fails the segment instead of wedging the tail — and the
      // bound and the operation context share a single deadline.
      const reloadSource = new CancellationSource();
      this.#opSources.add(reloadSource);
      let reloaded: Result<PersistedState>;
      try {
        const deadlineMs = this.#deadline();
        reloaded = await this.#withDeadline(
          () =>
            this.#storage.load(
              this.#newContext(
                'reload',
                deadlineMs,
                context?.signal ?? reloadSource.signal,
              ),
            ),
          deadlineMs,
          reloadSource,
        );
      } finally {
        this.#opSources.delete(reloadSource);
      }
      if (reloaded.ok && isPersistedState(reloaded.value)) {
        // Merge, never replace: a concurrent recording mutation on
        // another tail may sit between its in-memory mirror and its
        // persist, so the reload can be older than memory for any
        // recording but the reviewed one. The reviewed recording
        // takes the committed version — the reload post-dates the
        // op's own commit, so it carries the verdict. Every other
        // in-memory entry wins; committed rows memory doesn't know
        // (committed by a racing op just before this load) join at
        // the tail.
        const committed = reloaded.value.recordings;
        const byId = new Map(committed.map((rec) => [rec.id, rec]));
        const affectedId = result.value.recordingId;
        const seen = new Set<string>();
        const merged: Recording[] = [];
        for (const rec of r.recordings) {
          seen.add(rec.id);
          merged.push(
            rec.id === affectedId ? (byId.get(rec.id) ?? rec) : rec,
          );
        }
        for (const rec of committed) {
          if (!seen.has(rec.id)) {
            merged.push(rec);
          }
        }
        r.recordings = merged;
      } else {
        r.persistenceError = reloaded.ok
          ? appError('invalid-response', 'reload after review failed validation')
          : reloaded.error;
      }
      this.#publish();
      this.#derived();
      return result;
    });
    this.#own(work);
    return work;
  }

  async #getLyrics(
    recordingId: string,
    context: OperationContext | undefined,
  ): Promise<Result<LyricsSheet>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    if (context !== undefined && context.signal.cancelled) {
      return err(appError('cancelled', 'cancelled'));
    }
    const r = ready.value;
    const recording = r.recordings.find((rec) => rec.id === recordingId);
    if (recording === undefined) {
      return err(appError('not-found', 'unknown recording'));
    }
    const cached = r.lyricsCache.find((e) => e.recordingId === recordingId);
    if (cached !== undefined) {
      const accepted = lyricsFromCache(cached, {
        durationMs: recording.durationMs,
      });
      return ok(
        lyricsSheet(accepted, {
          provider: cached.provider,
          fetchedMs: cached.fetchedMs,
          cached: true,
        }),
      );
    }
    // Synced is always preferred: the sheet renders timed lines
    // whenever a provider can honestly produce them; the router
    // degrades to a lyrics.plain declarer otherwise.
    const routed = this.#router.lyricsProviderFor(
      selectionFromSettings(r.settings),
      'synced',
    );
    if (!routed.ok) {
      return err(routed.error);
    }
    const provider = routed.value;
    const source = new CancellationSource();
    const unlink = context?.signal.subscribe(() => {
      source.cancel();
    });
    this.#opSources.add(source);
    try {
      const ownDeadline = this.#deadline();
      const deadlineMs =
        context !== undefined && isSafeNonNegative(context.deadlineMs)
          ? Math.min(ownDeadline, context.deadlineMs)
          : ownDeadline;
      const query: LyricsQuery = {
        title: recording.title,
        artist: recording.artist,
        album: recording.album,
        durationMs: recording.durationMs,
        isrc: recording.isrc,
      };
      const opContext = this.#newContext('lyrics', deadlineMs, source.signal);
      const fetched = await this.#withDeadline(
        () => provider.getLyrics({ query, prefer: 'synced' }, opContext),
        deadlineMs,
        source,
      );
      if (!fetched.ok) {
        return err(fetched.error);
      }
      const accepted = applyAcceptance(fetched.value, {
        durationMs: recording.durationMs,
      });
      const fetchedMs = this.#safeNow();
      const entry =
        fetchedMs === null
          ? null
          : lyricsCacheEntry(recording.id, provider.id, accepted, fetchedMs);
      if (entry !== null) {
        const next = [
          ...r.lyricsCache.filter((e) => e.recordingId !== recording.id),
          entry,
        ];
        // The cache is disposable: a failed commit is surfaced as
        // persistenceError but never withholds the lyrics result —
        // and per commit-first semantics the in-memory section is
        // untouched, so the next call simply refetches.
        const persisted = await this.#persist({ lyricsCache: next });
        if (persisted.ok) {
          r.lyricsCache = next;
        }
      }
      return ok(
        lyricsSheet(accepted, {
          provider: provider.id,
          fetchedMs,
          cached: false,
        }),
      );
    } finally {
      unlink?.();
      this.#opSources.delete(source);
    }
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
      // An armed radio tail cannot survive the queue replace:
      // cancel any in-flight continuation and drop the record.
      const replaced = this.#ready;
      if (replaced !== null) {
        this.#clearRadio(replaced);
      }
      const deadlineMs = this.#deadline();
      const context = this.#newContext('import', deadlineMs, source.signal);
      // The swap runs as a segment on the storage tail: every writer
      // queued ahead commits first and is rolled forward, and a
      // writer that staged against the old Ready and commits behind
      // the swap is superseded by the generation check in #persist —
      // never stale-applied over the imported sections.
      const applied = await this.#enqueueStorage(async () => {
        const result = await this.#withDeadline(
          () => applyImport(this.#storage, preview.value.doc, context),
          deadlineMs,
          source,
        );
        // The generation flips inside the segment: the next queued
        // writer observes #ready === null and supersedes instead of
        // committing old-generation sections over the imported rows.
        if (result.ok) {
          this.#ready = null;
          this.#state = { type: 'unhydrated' };
        }
        return result;
      });
      if (!applied.ok) {
        return applied;
      }
      // Rehydrate from the replaced document: restore() performs the
      // load path whenever #ready is null.
      this.#restorePromise = null;
      const restored = await this.restore();
      if (!restored.ok) {
        return restored;
      }
      return ok(preview.value);
    } finally {
      this.#opSources.delete(source);
    }
  }

  // ---- radio tail -----------------------------------------------------

  /**
   * Seed a lazy radio tail from a track ref (`radio.seed`'s dual
   * payload). The seed routes to the provider that minted the ref —
   * provenance is the only honest route. The page mints recordings +
   * occurrences in one atomic write, then the tail keeps the returned
   * continuation armed. Ops serialize on the radio tail; a new seed
   * replaces the armed one.
   */
  startRadio(ref: SourceRef): Promise<Result<void>> {
    const work = this.#radioTail.then(() => this.#startRadio(ref));
    this.#radioTail = work.then(() => undefined, () => undefined);
    this.#own(work);
    return work;
  }

  /**
   * Disarm the radio tail. Queued occurrences are untouched — the
   * queue simply stops growing.
   */
  stopRadio(): Result<void> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    this.#clearRadio(ready.value);
    this.#publish();
    return ok(undefined);
  }

  /**
   * Drops the tail record and cancels any in-flight continuation;
   * stale fetch results are rejected by record identity, never
   * applied.
   */
  #clearRadio(r: Ready): void {
    const record = r.radio;
    if (record === null) {
      return;
    }
    record.source?.cancel();
    r.radio = null;
  }

  async #startRadio(ref: SourceRef): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (!isSourceRef(ref)) {
      return err(appError('invalid-response', 'invalid radio seed'));
    }
    if (ref.kind !== 'track') {
      // Track-seeded at first release (providers.md).
      return err(
        appError('not-applicable', 'radio seeds are track refs'),
      );
    }
    const routed = this.#router.providerForRef(ref, 'radio.seed');
    if (!routed.ok) {
      return err(routed.error);
    }
    this.#clearRadio(r);
    const record: RadioTailRecord = {
      seedRef: ref,
      providerId: routed.value.id,
      continuation: null,
      status: 'growing',
      error: undefined,
      fetching: true,
      source: null,
    };
    r.radio = record;
    this.#publish();
    const seeded = await this.#radioCall(
      routed.value,
      { sourceRef: ref },
      record,
    );
    record.fetching = false;
    if (r.radio !== record) {
      // Superseded or cleared while the seed was in flight — same
      // honesty rule as superseded playback attempts.
      return err(appError('superseded', 'radio seed superseded'));
    }
    if (!seeded.ok) {
      // A failed seed never armed a radio: the state stays absent
      // and the typed error is the caller's.
      r.radio = null;
      this.#publish();
      return err(seeded.error);
    }
    const staged = await this.#commitStaged((cur) =>
      this.#stageRadioPage(cur, seeded.value),
    );
    if (!staged.ok) {
      r.radio = null;
      this.#publish();
      return err(staged.error);
    }
    record.continuation = seeded.value.continuation;
    if (record.continuation === null) {
      record.status = 'ended';
    }
    this.#publish();
    if (staged.value.changed) {
      this.#derived();
    }
    return ok(undefined);
  }

  /**
   * Lazy fetch-ahead: called from #derived (every queue transition)
   * and the native transition reconcile — never from a timer. The
   * predicate lives in queue/radio-tail.ts; the fetch serializes on
   * the radio tail so at most one continuation is in flight.
   */
  #maybeGrowRadio(): void {
    const r = this.#ready;
    if (r === null || this.#disposed) {
      return;
    }
    const record = r.radio;
    if (record === null || !shouldGrowRadio(record, r.queue.snapshot())) {
      return;
    }
    // Radio growth spends the network — skip when offline.
    if (!this.#isOnline()) {
      return;
    }
    record.fetching = true;
    this.#publish();
    const work = this.#radioTail.then(() => this.#growRadio(record));
    this.#radioTail = work.then(() => undefined, () => undefined);
    this.#own(work);
  }

  async #growRadio(record: RadioTailRecord): Promise<void> {
    const r = this.#ready;
    if (r === null || r.radio !== record) {
      return;
    }
    // Re-check the trigger's predicate: queued behind other radio
    // ops the window may already be filled — a stale trigger is a
    // no-op, not a wasted fetch. The trigger published `fetching`;
    // clearing it needs a publish so the flag never reads as a
    // stuck spinner.
    const snap = r.queue.snapshot();
    if (
      record.status !== 'growing' ||
      record.continuation === null ||
      snap.currentOccurrenceId === null ||
      remainingAfterCurrent(snap) >= RADIO_FETCH_AHEAD
    ) {
      record.fetching = false;
      this.#publish();
      return;
    }
    // The continuation token's issuer is the only honest target —
    // route by the seed's provenance, not the settings slot.
    const routed = this.#router.providerForRef(record.seedRef, 'radio.seed');
    if (!routed.ok) {
      record.fetching = false;
      record.status = 'failed';
      record.error = routed.error;
      this.#publish();
      return;
    }
    const result = await this.#radioCall(
      routed.value,
      { continuation: record.continuation },
      record,
    );
    record.fetching = false;
    if (r.radio !== record || this.#disposed) {
      return;
    }
    if (!result.ok) {
      if (result.error.kind === 'cancelled') {
        return;
      }
      // Honest stop: the tail fails terminal — no retry loop, the
      // queue simply plays out what it has.
      record.status = 'failed';
      record.error = result.error;
      this.#publish();
      return;
    }
    const staged = await this.#commitStaged((cur) =>
      this.#stageRadioPage(cur, result.value),
    );
    if (!staged.ok) {
      record.status = 'failed';
      record.error = staged.error;
      this.#publish();
      return;
    }
    record.continuation = result.value.continuation;
    if (record.continuation === null) {
      record.status = 'ended';
    }
    this.#publish();
    if (staged.value.changed) {
      // derived() re-evaluates the window: a page that still leaves
      // the tail short chains the next continuation immediately.
      this.#derived();
    }
    // A page that appended nothing does not chain — the next real
    // queue transition re-evaluates, so all-dupe pages cannot spin.
  }

  /**
   * One bounded provider call for the tail. The cancellation source
   * lives on the record so clears can cancel it, and is tracked in
   * #opSources so dispose cancels it too.
   */
  async #radioCall(
    provider: ProviderPort,
    input: RadioSeed,
    record: RadioTailRecord,
  ): Promise<Result<RadioPage>> {
    const source = new CancellationSource();
    record.source = source;
    this.#opSources.add(source);
    try {
      const deadlineMs = this.#deadline();
      const context = this.#newContext('radio', deadlineMs, source.signal);
      return await this.#withDeadline(
        () => provider.radioSeed(input, context),
        deadlineMs,
        source,
      );
    } finally {
      this.#opSources.delete(source);
      if (record.source === source) {
        record.source = null;
      }
    }
  }

  /**
   * Stages a fetched page against library + queue: validates the wire
   * shape (one corrupt item fails the whole page), dedupes and
   * mints/merges via `planRadioPage`, then enqueues the survivors on
   * a draft engine. Pure — the recordings write and the queue move
   * commit together, all items or none, before the mirror updates.
   */
  #stageRadioPage(
    r: Ready,
    page: RadioPage,
  ): Result<CommitStage<{ changed: boolean }>> {
    if (!isRadioPage(page)) {
      return err(
        appError('invalid-response', 'radio page failed validation'),
      );
    }
    const now = this.#safeNow();
    if (now === null) {
      return err(internalError());
    }
    const plan = planRadioPage(
      r.recordings,
      r.queue.snapshot().occurrences,
      page.candidates,
      this.#ids,
      r.settings.playbackProvider,
      now,
    );
    const recordingsChanged = plan.recordings !== r.recordings;
    const draft = new QueueEngine(r.queue.snapshot());
    try {
      for (const occurrence of plan.occurrences) {
        draft.enqueue(occurrence);
      }
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    if (!recordingsChanged && plan.occurrences.length === 0) {
      return ok({ apply: () => ({ changed: false }) });
    }
    const recordings = plan.recordings;
    const queue = draft.snapshot();
    return ok({
      batch: { recordings, queue },
      apply: (rr) => {
        rr.recordings = [...recordings];
        rr.queue = draft;
        return { changed: true };
      },
    });
  }

  // ---- transport ----------------------------------------------------

  async playOccurrence(occurrenceId: string): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const before = r.queue.snapshot();
    if (!before.occurrences.some((o) => o.occurrenceId === occurrenceId)) {
      return err(appError('not-found', 'unknown occurrence'));
    }
    try {
      r.queue.select(occurrenceId, true);
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    const persisted = await this.#persistQueue(r, before);
    if (!persisted.ok) {
      return persisted;
    }
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

  /**
   * Stop playback and clear the current occurrence — the queue keeps
   * its items. This is the mini-player dismiss path: playback goes
   * idle, so the chrome unmounts itself on the next publish.
   */
  async stop(): Promise<Result<void>> {
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
      r.queue.stop();
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    // Commit the stopped queue before the irreversible transport
    // teardown: a failed commit rolls the engine back to playing and
    // leaves the live attempt untouched — the caller's error is
    // honest and playback genuinely continues.
    const persisted = await this.#persistQueue(r, before);
    if (!persisted.ok) {
      return persisted;
    }
    await this.#supersede();
    const ready2 = this.#ready;
    if (ready2 !== null) {
      ready2.playback = { type: 'idle' };
    }
    this.#derived();
    this.#publish();
    return ok(undefined);
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
      const restarted = await this.#persistQueue(r, before);
      if (!restarted.ok) {
        return restarted;
      }
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
        // Publish the re-keyed identity before the transport call: if
        // a supersede lands during the await the post-call publish is
        // skipped, and an unpublished identity must never reach the
        // player.
        this.#setPlaybackFromStatus(
          active,
          r.queue.snapshot().mode === 'paused' ? 'paused' : 'playing',
        );
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
    const moved = await this.#persistQueue(r, before);
    if (!moved.ok) {
      // A rolled-back move must not leave playback on a cursor the
      // store no longer holds — converge onto the durable tip (this
      // command's own `before`, or whatever a later commit landed).
      const durable = r.queue.snapshot();
      if (
        durable.revision === r.queueCommittedRev &&
        durable.mode === 'playing' &&
        durable.currentOccurrenceId !== null &&
        durable.currentOccurrenceId !== this.#active?.occurrenceId
      ) {
        this.#own(this.#startAttempt(durable.currentOccurrenceId));
      }
      return moved;
    }
    this.#derived();
    // Transport ops are not serialized — a concurrent next/previous
    // may have moved the cursor again while the persist was in
    // flight. Serve the DURABLE cursor: when the live snapshot carries
    // a newer mutation whose own commit is still in flight, defer to
    // that command's continuation — starting an uncommitted cursor now
    // would keep playing it if its commit later rolls back.
    const latest = r.queue.snapshot();
    if (latest.revision !== r.queueCommittedRev) {
      return ok(undefined);
    }
    if (latest.mode === 'playing' && latest.currentOccurrenceId !== null) {
      return this.#startAttempt(latest.currentOccurrenceId);
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
    if (active === null) {
      return err(appError('unavailable', 'no active playback to pause'));
    }
    const before = r.queue.snapshot();
    try {
      r.queue.pause();
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    // Commit the intent before touching transport: a failed commit
    // rolls the engine back and the native pause is never issued.
    const persisted = await this.#persistQueue(r, before);
    if (!persisted.ok) {
      return persisted;
    }
    this.#derived();
    if (active.handle === undefined) {
      // Prepare still in flight: pause intent landed on the queue and
      // the pending 'prepared' outcome will not autostart it.
      this.#publish();
      return ok(undefined);
    }
    if (this.#isStale(active)) {
      // Superseded while committing — the pause intent landed anyway.
      this.#publish();
      return ok(undefined);
    }
    const identity = {
      attemptId: active.identity.attemptId,
      queueRev: r.queue.snapshot().revision,
    };
    active.identity = identity;
    // Same ordering rule as play/seek: the re-keyed identity must be
    // published before the transport call carries it.
    this.#setPlaybackFromStatus(active, 'paused');
    const result = await this.#bounded(() => this.#player.pause(identity));
    if (!result.ok) {
      await this.#failAttempt(active, result.error);
      return result;
    }
    if (!this.#isStale(active)) {
      this.#setPlaybackFromStatus(active, 'paused');
      this.#publish();
    }
    return ok(undefined);
  }

  async resume(): Promise<Result<void>> {
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
      r.queue.play();
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    const persisted = await this.#persistQueue(r, before);
    if (!persisted.ok) {
      return persisted;
    }
    this.#derived();
    const active = this.#active;
    if (active !== null && active.handle === undefined) {
      // A prepare is already in flight: the ticked 'playing' intent
      // means the pending 'prepared' outcome autostarts it.
      this.#publish();
      return ok(undefined);
    }
    if (active !== null && active.handle !== undefined) {
      if (this.#isStale(active)) {
        this.#publish();
        return ok(undefined);
      }
      const identity = {
        attemptId: active.identity.attemptId,
        queueRev: r.queue.snapshot().revision,
      };
      active.identity = identity;
      // Same ordering rule: the identity the transport call carries
      // must already be observable in the published record, in case a
      // supersede during the await skips the post-call publish.
      this.#setPlaybackFromStatus(active, 'paused');
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
        this.#publish();
      }
      return ok(undefined);
    }
    // No live handle (e.g. after restore): prepare fresh.
    return this.#startAttempt(before.currentOccurrenceId);
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
    if (active === null) {
      return err(appError('unavailable', 'no active playback to seek'));
    }
    const before = r.queue.snapshot();
    try {
      r.queue.seekTo(positionMs);
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    const persisted = await this.#persistQueue(r, before);
    if (!persisted.ok) {
      return persisted;
    }
    this.#derived();
    if (active.handle === undefined) {
      // Seek intent rides on the queue snapshot; the pending
      // 'prepared' outcome plays from it.
      this.#publish();
      return ok(undefined);
    }
    if (this.#isStale(active)) {
      this.#publish();
      return ok(undefined);
    }
    const identity = {
      attemptId: active.identity.attemptId,
      queueRev: r.queue.snapshot().revision,
    };
    active.identity = identity;
    // Publish the re-keyed identity before the transport call so a
    // supersede during the await can't leave a play/seek carrying an
    // identity no snapshot ever showed.
    this.#setPlaybackFromStatus(
      active,
      r.queue.snapshot().mode === 'paused' ? 'paused' : 'playing',
    );
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
      this.#publish();
    }
    return ok(undefined);
  }

  async retryCurrent(): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const before = r.queue.snapshot();
    const current = before.currentOccurrenceId;
    if (current === null) {
      return err(appError('no-result', 'queue has no current occurrence'));
    }
    try {
      r.queue.play();
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    const persisted = await this.#persistQueue(r, before);
    if (!persisted.ok) {
      return persisted;
    }
    this.#derived();
    return this.#startAttempt(current);
  }

  async removeOccurrence(id: string): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const before = r.queue.snapshot();
    const wasCurrent = before.currentOccurrenceId === id;
    try {
      r.queue.remove(id);
    } catch {
      return err(appError('not-found', 'unknown occurrence'));
    }
    // Commit the removal before superseding the removed occurrence's
    // attempt: on a failed commit the engine rollback restores the
    // item and the still-live attempt keeps it playing honestly.
    const persisted = await this.#persistQueue(r, before);
    if (!persisted.ok) {
      return persisted;
    }
    if (wasCurrent) {
      await this.#supersede();
      const ready2 = this.#ready;
      if (ready2 !== null) {
        ready2.playback = { type: 'idle' };
      }
    }
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
    const before = r.queue.snapshot();
    try {
      r.queue.move(id, toIndex);
    } catch (thrown) {
      return err(
        thrown instanceof TypeError
          ? appError('not-found', 'invalid move')
          : fromUnknown(thrown),
      );
    }
    const persisted = await this.#persistQueue(r, before);
    if (!persisted.ok) {
      return persisted;
    }
    this.#derived();
    this.#publish();
    return ok(undefined);
  }

  // ---- play pipeline ------------------------------------------------

  // Selection order: an occurrence pin for the active playback
  // provider wins verbatim (a pin for another provider falls
  // through); then the effective mapping — a user verdict outranks
  // every automatic claim — then any unvetoed source ref for the
  // provider. Corrections therefore move the queue on the next
  // projection for unpinned occurrences, and a stale automatic
  // resolution can never overwrite a valid pin.
  #pickRef(
    recording: Recording,
    occurrenceSelected: SourceRef | null,
  ): SourceRef | null {
    const provider = this.#ready?.settings.playbackProvider ?? '';
    // Offline: only owned bytes can attach — a provider pin would
    // fire a network call it can't satisfy, so even an active-
    // provider pin loses to a download or local file here.
    if (!this.#isOnline()) {
      const owned = this.#localPlaybackFor(recording.id);
      return owned === null ? null : localTrackRef(owned);
    }
    if (
      occurrenceSelected !== null &&
      occurrenceSelected.provider === provider
    ) {
      return occurrenceSelected;
    }
    // Owned bytes beat any auto-pick: a download or local file plays
    // offline-honest. A pin for the active provider won above; a
    // foreign pin can't resolve under it anyway, so the owned file
    // still wins.
    const local = this.#localPlaybackFor(recording.id);
    if (
      local !== null &&
      (occurrenceSelected === null ||
        occurrenceSelected.provider !== provider)
    ) {
      return localTrackRef(local);
    }
    const verdict = effectiveMapping(recording, provider);
    if (verdict !== null) {
      return verdict.ref;
    }
    return (
      recording.sourceRefs.find(
        (s) =>
          s.provider === provider &&
          !isRefRejected(recording.mappings, s),
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
      listenedMsAccum: 0,
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
    // Offline zero-resolution gate: only owned bytes play. A null ref
    // would fire playback.candidates and a provider ref would start a
    // stream attach — both spend the network it doesn't have.
    const online = this.#isOnline();
    if (!online && (ref === null || ref.provider !== LOCAL_PROVIDER)) {
      const error = appError(
        'unavailable',
        'offline — no local bytes for this recording',
      );
      await this.#failAttempt(attempt, error);
      return err(error);
    }
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

    // A provider:'local' pick bypasses the plugin router — the adapter
    // attaches the URI directly (no resolve capability on a file).
    if (ref.provider !== LOCAL_PROVIDER) {
      const routed = this.#router.providerFor(
        'playback.resolve',
        selectionFromSettings(r.settings),
      );
      if (!routed.ok) {
        await this.#failAttempt(attempt, routed.error);
        return err(routed.error);
      }
    }
    const prepared = await this.#withDeadline(
      () =>
        this.#player.prepare({
          provider: ref.provider,
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
    // Malformed provider candidates can throw inside match — that
    // must fail the attempt honestly, not wedge it unwound.
    let outcome: MatchOutcome;
    try {
      outcome = MatchingEngine.match(
        recording,
        result.value,
        recording.mappings,
      );
    } catch (thrown) {
      const error = fromUnknown(thrown);
      await this.#failAttempt(attempt, error);
      return err(error);
    }
    if (outcome.type === 'ambiguous') {
      // Park the candidates for user resolution; the attempt still
      // fails honestly. The enqueue is best-effort — a review-write
      // failure must not mask the match outcome.
      const enqueued = await this.#enqueueStorage(() =>
        this.#corrections.enqueueReview(
          recording.id,
          outcome.candidates.map((c) => ({
            metadata: c.candidate,
            ref: c.candidate.sourceRef,
          })),
          attempt.source.signal,
        ),
      );
      if (!enqueued.ok) {
        this.#logWarn(`match review enqueue failed: ${enqueued.error.kind}`);
      }
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
    // The adoption stages inside the storage segment: recordings and
    // the queue pin are re-derived against the freshest mirror and the
    // queue engine is swapped in only after a successful commit, so a
    // rolled-back queue write can never resurrect an uncommitted
    // mapping from a stale capture.
    const staged = await this.#commitStaged((ready) => {
      const current = ready.recordings.find((rec) => rec.id === recording.id);
      if (current === undefined) {
        return err(appError('not-found', 'recording was removed'));
      }
      const hasMapping = current.mappings.some((m) => sameRef(m.ref, ref));
      const updated: Recording = {
        ...current,
        mappings: hasMapping
          ? current.mappings.map((m) => (sameRef(m.ref, ref) ? mapping : m))
          : [...current.mappings, mapping],
        sourceRefs: current.sourceRefs.some((s) => sameRef(s, ref))
          ? current.sourceRefs
          : [...current.sourceRefs, ref],
      };
      const draft = new QueueEngine(ready.queue.snapshot());
      try {
        draft.setSelectedRef(occurrenceId, ref);
      } catch (thrown) {
        return err(fromUnknown(thrown));
      }
      const recordings = ready.recordings.map((rec) =>
        rec.id === updated.id ? updated : rec,
      );
      return ok<CommitStage<SourceRef>>({
        batch: { recordings, queue: draft.snapshot() },
        apply: (rr) => {
          rr.recordings = recordings;
          rr.queue = draft;
          return ref;
        },
      });
    });
    this.#derived();
    if (!staged.ok) {
      // The adoption never committed — memory stayed on storage's
      // truth, but the ref resolved fine: the resolve contract is
      // met and playback proceeds unpinned.
      this.#logWarn('mapping adoption commit failed');
    }
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
    const before = r.queue.snapshot();
    if (before.currentOccurrenceId === attempt.occurrenceId) {
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
    await this.#persistQueue(r, before);
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
    // Listened time accumulates real deltas between status ticks —
    // a seek forward must not mint a play for a span that never
    // played, and a position regression must not subtract. Anything
    // above the cap is a jump, not playback: no credit, just a new
    // baseline. 'ended' joins the same accumulator — its absolute
    // end position after a tail seek would otherwise mint unplayed
    // time through the threshold.
    if (event.state === 'playing' || event.state === 'ended') {
      const lastPos = active.lastStatusPositionMs;
      if (lastPos !== undefined && event.positionMs > lastPos) {
        const delta = event.positionMs - lastPos;
        if (delta <= MAX_TICK_DELTA_MS) {
          active.listenedMsAccum += delta;
        }
      }
      active.lastStatusPositionMs = event.positionMs;
    }
    await this.#maybeRecordPlay(
      active.occurrenceId,
      active.recordingId,
      active.listenedMsAccum,
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
      const before = r.queue.snapshot();
      try {
        r.queue.next();
      } catch {
        return;
      }
      const advanced = await this.#persistQueue(r, before);
      this.#derived();
      const snap = r.queue.snapshot();
      // A failed advance rolls the queue back onto the ended item —
      // never replay it; go idle instead.
      if (
        !advanced.ok ||
        snap.currentOccurrenceId === null ||
        snap.mode !== 'playing'
      ) {
        r.playback = { type: 'idle' };
        this.#publish();
        return;
      }
      await this.#startAttempt(snap.currentOccurrenceId);
      return;
    }
    // Remote pause/play reconciles queue intent with the service.
    if (event.state === 'paused' && r.queue.snapshot().mode === 'playing') {
      const before = r.queue.snapshot();
      try {
        r.queue.pause();
      } catch {
        return;
      }
      const priorIdentity = active.identity;
      active.identity = {
        attemptId: active.identity.attemptId,
        queueRev: r.queue.snapshot().revision,
      };
      const synced = await this.#persistQueue(r, before);
      if (!synced.ok && this.#active === active) {
        // Rolled back — the live engine is at `before`'s revision.
        active.identity = priorIdentity;
      }
      this.#derived();
    } else if (
      event.state === 'playing' &&
      r.queue.snapshot().mode === 'paused'
    ) {
      const before = r.queue.snapshot();
      try {
        r.queue.play();
      } catch {
        return;
      }
      const priorIdentity = active.identity;
      active.identity = {
        attemptId: active.identity.attemptId,
        queueRev: r.queue.snapshot().revision,
      };
      const synced = await this.#persistQueue(r, before);
      if (!synced.ok && this.#active === active) {
        active.identity = priorIdentity;
      }
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
    if (r.queue.snapshot().mode === 'paused') {
      // Paused while the prepare was in flight — user intent wins:
      // hold the handle and report paused, never autostart.
      this.#setPlaybackFromStatus(active, 'paused');
      await this.#persist({ attempts: [event.outcome.attempt] });
      this.#maybeMapSuccessor();
      return;
    }
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
      // The trace survives the transport failure, same contract as
      // the prepare-failure branch above.
      await this.#persist({ attempts: [event.outcome.attempt] });
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
    // Offline honesty: items without local bytes project null refs so
    // the native cursor can't attempt a network attach for them.
    const online = this.#isOnline();
    const items: QueueProjectionItem[] = snap.occurrences.map(
      (occurrence) => {
        const recording = r.recordings.find(
          (rec) => rec.id === occurrence.recordingId,
        );
        const picked =
          recording === undefined
            ? null
            : this.#pickRef(recording, occurrence.selectedRef);
        const selected =
          !online && picked !== null && picked.provider !== LOCAL_PROVIDER
            ? null
            : picked;
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
    const displaced = this.#projection;
    if (displaced !== null && displaced.status === 'pending') {
      // The awaited `done` still resolves, but the marker stops
      // pretending to be the latest word — readers checking
      // `status` after the wait see 'superseded', not 'installed'.
      displaced.status = 'superseded';
    }
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
    // A service move emits the projection it captured at move-start,
    // which can lag one JS install. Its identity echoes that captured
    // rev (a fresh attach keys to proj.queueRev) while a same-item
    // restart echoes the live re-keyed attach rev — either proves the
    // event; only a revision newer than the install is impossible.
    const currentProjection =
      projection !== null &&
      event.projectionId === projection.projectionId &&
      event.projectedQueueRev === projection.queueRev;
    const staleReconcilable =
      !currentProjection &&
      projection !== null &&
      event.projectedQueueRev <= projection.queueRev;
    const identityOk =
      event.toOccurrenceId === null
        ? event.identity === null && event.handle === null
        : event.identity !== null &&
        event.handle !== null &&
        event.handle.length > 0 &&
        event.identity.attemptId.length > 0 &&
        (event.identity.queueRev === projection?.queueRev ||
          event.identity.queueRev === event.projectedQueueRev);
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
      event.fromOccurrenceId !== marker.currentOccurrenceId ||
      !legal ||
      !identityOk ||
      !isSafeNonNegative(event.positionMs) ||
      (!currentProjection && !staleReconcilable)
    ) {
      this.#logWarn('queue transition rejected');
      return;
    }
    if (!currentProjection) {
      // The event's edge was already proven legal against the
      // INSTALLED projection above, so a stale-but-past revision is
      // safe to reconcile.
      this.#logWarn('queue transition on superseded projection — reconciled');
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
        // The adopted attempt's prior play span is unknown — count
        // from the adopted position so threshold math stays honest.
        listenedMsAccum: event.positionMs,
        lastStatusPositionMs: event.positionMs,
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
    // Capture and enqueue the transition's own snapshot before any
    // cleanup await can admit a later queue command: its segment then
    // precedes theirs, so a later command's rollback cannot invalidate
    // the transition its `before` retained. The epoch guard still drops
    // the write when an earlier pending commit rolls the lineage back
    // over it, and the committed-revision guard keeps a staler capture
    // from regressing a staged commit.
    const queueSnap = r.queue.snapshot();
    const queueEpoch = r.queueEpoch;
    const queueWrite = this.#persist(() =>
      r.queueEpoch === queueEpoch &&
      queueSnap.revision > r.queueCommittedRev
        ? { queue: queueSnap }
        : {},
    );
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
    await queueWrite;
    // Native may already be several moves ahead. Re-projecting this
    // intermediate cursor would stop its live stream and reject queued moves.
    this.#mappingSource?.cancel();
    this.#mappingSource = null;
    this.#maybeMapSuccessor();
    // The cursor moved inside the projection — the radio tail's
    // fetch-ahead window may have opened.
    this.#maybeGrowRadio();
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
    // A resolved ref — occurrence pin, user-confirmed mapping, or
    // unvetoed source ref — is already projected; no mapping task is
    // needed.
    if (this.#pickRef(recording, successor.selectedRef) !== null) {
      return;
    }
    // Speculative work spends the network too — skip when offline.
    if (!this.#isOnline()) {
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
      let outcome: MatchOutcome;
      try {
        outcome = MatchingEngine.match(rec, result.value, rec.mappings);
      } catch {
        this.#logWarn('successor mapping threw on malformed candidates');
        return;
      }
      if (outcome.type !== 'matched') {
        this.#logWarn('successor mapping unresolved');
        return;
      }
      const ref = outcome.candidate.sourceRef;
      const matchedAt = this.#safeNow();
      if (matchedAt === null) {
        return;
      }
      const automatic: SourceMapping = {
        ref,
        status: 'automatic',
        matchedAtMs: matchedAt,
        evidence: outcome.evidence,
      };
      const updated = adoptAutomaticMapping(rec, ref, automatic);
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
      // Stage the adoption inside the storage segment against the
      // freshest mirror — the queue engine swaps in only after a
      // successful commit, so a rolled-back write can never leave a
      // resurrected pin in memory.
      const staged = await this.#commitStaged((ready3) => {
        const current = ready3.recordings.find((x) => x.id === recordingId);
        if (current === undefined) {
          return err(internalError());
        }
        const adopted = adoptAutomaticMapping(current, ref, automatic);
        const draft = new QueueEngine(ready3.queue.snapshot());
        try {
          draft.setSelectedRef(occurrenceId, ref);
        } catch {
          return err(internalError());
        }
        const recordings = ready3.recordings.map((x) =>
          x.id === adopted.id ? adopted : x,
        );
        return ok<CommitStage<SourceRef>>({
          batch: { recordings, queue: draft.snapshot() },
          apply: (rr) => {
            rr.recordings = recordings;
            rr.queue = draft;
            return ref;
          },
        });
      });
      if (!staged.ok) {
        return;
      }
      this.#derived();
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
