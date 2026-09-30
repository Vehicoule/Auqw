import { CancellationSource } from '../cancellation.ts';
import type {
  CancellationSignal,
  OperationContext,
} from '../cancellation.ts';
import type { AppError, Result } from '../errors.ts';
import { appError, err, fromUnknown, ok } from '../errors.ts';
import type {
  DownloadRecord,
  EntityKind,
  EntityRef,
  Like,
  LocalFile,
  QueueOccurrence,
  Recording,
  Settings,
  SourceRef,
  TrackMetadata,
} from '../domain.ts';
import {
  isEntityRef,
  isSafeNonNegative,
  isSettings,
  isString,

  isTrackMetadata,
  isTrackRef,
  mergeRecordingMetadata,
  recordingFromMetadata,
} from '../domain.ts';
import { retryBounded } from '../retry.ts';
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
  isMatchGate,
  isRefRejected,
  MATCH_GATE_MESSAGE,
} from '../library/corrections.ts';
import type {
  Corrections,
  ReviewFilter,
} from '../library/corrections.ts';
import { localTrackRef } from '../domain.ts';
import {
  applyAcceptance,
  lyricsCacheEntry,
  lyricsFromCache,
  lyricsSheet,
} from '../library/lyrics.ts';
import type { LyricsSheet } from '../library/lyrics.ts';
import type {
  ExportResult,
  ImportPreview,
} from '../library/export-import.ts';
import type { EntryMove } from '../library/playlists.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { IdPort, RandomPort } from '../ports/runtime.ts';
import type { LogPort } from '../ports/log.ts';
import type {
  AttemptTrace,
  PlaybackIdentity,
  PlayerPort,
  RepeatMode,
} from '../ports/player.ts';
import type {
  EntityPage,
  LyricsQuery,
  ProviderPort,
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
  emissionWrites,
  recordingDeleteWrites,
  recordingUpsertWrites,
} from '../sync/sync-projection.ts';
import type {
  LocalWrite,
  MaterializedRecord,
  MergeOutcome,
} from '../sync/sync-engine.ts';
import { publishRadio, samePublishedRadio } from '../queue/radio-tail.ts';
import type { RadioTail } from '../queue/radio-tail.ts';

import { Serializer } from './serializer.ts';
import { LibraryService } from './library-service.ts';
import { RadioCoordinator } from './radio-coordinator.ts';
import { SyncIngress } from './sync-ingress.ts';
import { PlaybackEngine } from './playback-engine.ts';
import type { PrewarmInput } from './playback-engine.ts';
export type { PrewarmFocus, PrewarmInput } from './playback-engine.ts';
import {
  boundedCommit,
  boundedLoad,
  boundedOp,
  internalError,
  sameRef,
  saturatingAdd,
  supersededError,
  timeoutError,
} from './util.ts';
import { syncEmitInput } from './ready.ts';
import type { Ready, SessionHostCore } from './ready.ts';

export type SessionPlayback =
  | { readonly type: 'idle' }
  | {
    readonly type: 'preparing';
    readonly recordingId: string;
    readonly occurrenceId: string;
    readonly identity: PlaybackIdentity;
    /** The resolved source once the pick finalizes — undefined until then. */
    readonly ref?: SourceRef;
    readonly requestId?: string;
  }
  | {
    readonly type: 'buffering' | 'playing' | 'paused';
    readonly recordingId: string;
    readonly occurrenceId: string;
    readonly identity: PlaybackIdentity;
    /** The source ref this attempt resolved and is actually playing. */
    readonly ref?: SourceRef;
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
   * The queue's repeat rule — runtime-only this slice (like `radio`):
   * it rides the queue projection so adapters never see a separate
   * channel, and is published for the transport UI.
   */
  readonly repeat: RepeatMode;
  /**
   * Shuffle deals a play order, it doesn't reorder the queue:
   * `shuffleOrder` carries the dealt occurrence ids the cursor walks
   * (`null` when off — the canonical walk). Runtime-only, rides the
   * queue projection like `repeat` so adapters never see a separate
   * channel (decisions.md → Playback).
   */
  readonly shuffle: boolean;
  readonly shuffleOrder: readonly string[] | null;
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

/**
 * The sync emission seam: after a successful syncable commit the
 * session hands the mapped `LocalWrite`s here — the desktop wraps
 * `auqw.sync.localChanges` through preload, mobile wraps the
 * in-process engine's `localChangeBatch`. Best-effort by contract:
 * the domain write is already durable, so a failed emit only leaves
 * the change log behind — it catches up on the next drain, never a
 * domain rollback.
 */
export type SyncEmitPort = {
  localChanges(
    writes: readonly LocalWrite[],
    signal?: CancellationSignal,
  ): Promise<Result<unknown>>;
};

/**
 * What `applySyncedEntries` hands back on success: which non-Ready
 * sections the projection rewrote so the owning controllers can
 * rehydrate their media plane (`rehydrateMedia`) — DownloadManager
 * and LocalFileSource hold their own snapshots and must not keep
 * rows a remote tombstone just deleted.
 */
export type SyncApplyReport = {
  readonly rehydrateMedia: boolean;
};

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
   * Optional: when present, every successful syncable commit emits
   * its writes through this port and `applySyncedEntries` projects
   * remote merge outcomes into the domain. Platforms without a sync
   * surface omit it — emission is then a no-op.
   */
  readonly sync?: SyncEmitPort;
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
  /**
   * Synchronous "is this connection metered" read (cellular /
   * data-saver). Speculative work — the visible-row mapping pass and
   * the advisory stream warm — skips while it reports true: it would
   * spend bytes the user may be paying for. Playback-intent calls
   * never consult it. Omitted = never metered (platforms without the
   * signal keep prior behavior).
   */
  readonly isMetered?: () => boolean;
};

const OP_DEADLINE_MS = 15_000;
/**
 * The projection input the Ready mirror does not carry: match
 * reviews, the disposable lyrics cache, and device-local download /
 * local-file rows. A drain's consecutive apply segments share one
 * snapshot instead of re-reading all sections per page.
 */
export type SyncApplySections = {
  -readonly [K in
    | 'matchReviews'
    | 'lyricsCache'
    | 'downloads'
    | 'localFiles']: PersistedState[K];
};

/**
 * The source refs the last published snapshot was built from. A
 * publish whose inputs still point at the same objects reuses the
 * frozen output sections instead of re-cloning the whole library —
 * sections here are copy-on-write (mutation paths always reassign
 * the array), so an identical ref proves an identical section.
 */
type PublishSource = {
  readonly ready: Ready;
  readonly recordings: readonly Recording[];
  readonly likes: readonly Like[];
  readonly entities: readonly Entity[];
  readonly entitySourceRefs: readonly EntitySourceRef[];
  readonly playlists: readonly Playlist[];
  readonly playlistEntries: readonly PlaylistEntry[];
  readonly playHistory: readonly PlayEvent[];
  readonly playCounts: readonly PlayCount[];
  readonly queue: QueueEngine;
  readonly queueRevision: number;
  readonly settings: Settings;
  /** `ready.shuffleOrder` at resolve time — the dealt-order input. */
  readonly shuffleInput: readonly string[] | null;
  /** The resolved dealt order `prev.shuffleOrder` was built from. */
  readonly dealt: readonly string[] | null;
  readonly persistenceError: AppError | undefined;
};

/**
 * Seeds replay cycles from restored play history: the in-flight listen
 * resumes at the highest recorded `#cycle` for its occurrence so it
 * re-keys under the same play (dedup-safe), and post-restart loops
 * count past it rather than collide.
 */
function listenCycleBaseline(
  occurrences: readonly QueueOccurrence[],
  history: readonly PlayEvent[],
): Record<string, number> {
  const live = new Set(occurrences.map((o) => o.occurrenceId));
  const counts: Record<string, number> = {};
  for (const e of history) {
    const id = e.occurrenceId;
    // Exact ids are cycle-0 records — including ids that legitimately
    // contain '#'. Only a numeric `#cycle` suffix on a live prefix is
    // a replay marker.
    if (id === null || live.has(id)) {
      continue;
    }
    const hash = id.lastIndexOf('#');
    if (hash <= 0) {
      continue;
    }
    const suffix = Number(id.slice(hash + 1));
    if (!Number.isInteger(suffix) || suffix < 0) {
      continue;
    }
    const base = id.slice(0, hash);
    // A stored replay key is `base#cycle` where the base is the
    // occurrence id (possibly truncated) — an exact hit wins before
    // the ambiguous prefix fallback.
    const owner =
      (live.has(base) ? base : undefined) ??
      [...live].find((occ) => occ.startsWith(base));
    if (owner !== undefined) {
      counts[owner] = Math.max(counts[owner] ?? 0, suffix);
    }
  }
  return counts;
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
 * A published snapshot must never alias mutable session state:
 * section elements freeze recursively so a listener that mutates a
 * row cannot corrupt the mirror. `Object.isFrozen` short-circuits
 * already-frozen subtrees, so repeat publishes stay cheap.
 */
function deepFreeze<T>(value: T): T {
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (
      typeof node !== 'object' ||
      node === null ||
      seen.has(node) ||
      Object.isFrozen(node)
    ) {
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
  #timers = new Set<CancellationSource>();
  #opSources = new Set<CancellationSource>();
  #ownedWork = new Set<Promise<unknown>>();
  #deadlineWork = new Set<Promise<unknown>>();
  readonly #lyricsSerial = new Serializer();
  /**
   * The one storage lane: every commit — session writes, review ops,
   * the import swap — serializes through it, so a read-modify-write
   * corrections op can never interleave with a session section write
   * (corrections load→commit races session recordings writers).
   */
  readonly #storageSerial = new Serializer();
  readonly #corrections: Corrections;
  readonly #library: LibraryService;
  readonly #syncIngress: SyncIngress;
  readonly #radio: RadioCoordinator;
  readonly #playback: PlaybackEngine;
  readonly #entitySerial = new Serializer();
  #listeners = new Set<(state: SessionState) => void>();
  /**
   * The light channel for playback position: status ticks whose only
   * delta is `positionMs` refresh the snapshot but notify here, so a
   * ~4 Hz tick never wakes whole-model subscribers.
   */
  #positionListeners = new Set<(positionMs: number) => void>();
  /** The value position listeners were last fired with. */
  #emittedPositionMs = 0;
  #publishSource: PublishSource | undefined;
  #playerUnsub: () => void;
  #disposed = false;
  readonly #localPlaybackFor: (recordingId: string) => string | null;
  readonly #isOnline: () => boolean;
  readonly #isMetered: () => boolean;
  readonly #sync: SyncEmitPort | undefined;
  #restorePromise: Promise<Result<void>> | null = null;
  /**
   * The shared half of every service host — thin delegations into
   * Session's own machinery (the storage lane, the op bookkeeping,
   * the publish/derived hooks). Each service's host literal spreads
   * this and adds its per-service seams.
   */
  readonly #hostCore: SessionHostCore = {
    ready: () => this.#ready,
    requireReady: () => this.#requireReady(),
    publish: () => this.#publish(),
    derived: () => this.#derived(),
    own: (work, deadline) => this.#own(work, deadline),
    disposed: () => this.#disposed,
    logWarn: (message) => this.#logWarn(message),
    enqueueStorage: (fn, options) => this.#enqueueStorage(fn, options),
    persist: (batch) => this.#persist(batch),
    emitSync: (writes) => this.#syncIngress.emit(writes),
    trackSource: (source) => {
      this.#opSources.add(source);
      return () => {
        this.#opSources.delete(source);
      };
    },
    safeNow: () => this.#safeNow(),
    deadline: () => this.#deadline(),
    newContext: (prefix, deadlineMs, signal) =>
      this.#newContext(prefix, deadlineMs, signal),
    withDeadline: (operation, absoluteDeadlineMs, operationSource) =>
      this.#withDeadline(
        operation,
        absoluteDeadlineMs,
        operationSource,
      ),
  };

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
    this.#isMetered = deps.isMetered ?? (() => false);
    this.#sync = deps.sync;
    this.#corrections = createCorrections({
      storage: deps.storage,
      ids: deps.ids,
      clock: deps.clock,
      log: deps.log,
    });
    this.#library = new LibraryService({
      storage: deps.storage,
      ids: deps.ids,
      clock: deps.clock,
      corrections: this.#corrections,
      host: {
        ...this.#hostCore,
        resumeGatedPlayback: (recordingId) =>
          this.#resumeGatedPlayback(recordingId),
        prepareImport: () => this.#prepareImport(),
        swapReady: () => {
          this.#ready = null;
          this.#state = { type: 'unhydrated' };
        },
        restore: () => {
          // A fresh load, never a shared in-flight restore: the memo
          // may still point at a pre-import load.
          this.#restorePromise = null;
          return this.restore();
        },
      },
    });
    this.#syncIngress = new SyncIngress({
      storage: deps.storage,
      sync: deps.sync,
      host: {
        ...this.#hostCore,
        hasProvider: (id) => this.#providers.has(id),
        providerDeclares: (id, capabilities) => {
          const provider = this.#providers.get(id);
          return (
            provider !== undefined &&
            capabilities.some((capability) =>
              provider.capabilities.includes(capability),
            )
          );
        },
      },
    });
    this.#radio = new RadioCoordinator({
      storage: deps.storage,
      ids: deps.ids,
      router: this.#router,
      host: {
        ...this.#hostCore,
        dealtOrder: (r) => this.#dealtOrder(r),
        isOnline: () => this.#isOnline(),
        localPlaybackFor: (recordingId) =>
          this.#localPlaybackFor(recordingId),
        activeAttempt: () => this.#playback.activeAttempt(),
        playOccurrence: (occurrenceId) =>
          this.playOccurrence(occurrenceId),
      },
    });
    this.#playback = new PlaybackEngine({
      player: deps.player,
      clock: deps.clock,
      ids: deps.ids,
      router: this.#router,
      corrections: this.#corrections,
      host: {
        ...this.#hostCore,
        publishPosition: () => this.#publishPosition(),
        pickRef: (recording, occurrenceSelected) =>
          this.#pickRef(recording, occurrenceSelected),
        dealtOrder: (r) => this.#dealtOrder(r),
        isOnline: () => this.#isOnline(),
        isMetered: () => this.#isMetered(),
        commitStaged: (stage) => this.#commitStaged(stage),
        persistQueue: (r, before, beforeMarks) =>
          this.#persistQueue(r, before, beforeMarks),
        mutateQueue: (r, mutate) => this.#mutateQueue(r, mutate),
        call: (fn) => this.#call(fn),
        bounded: (fn) => this.#bounded(fn),
        trackTimer: (timer) => {
          this.#timers.add(timer);
          return () => {
            this.#timers.delete(timer);
          };
        },
        maybeGrowRadio: () => this.#radio.maybeGrowRadio(),
        maybeArmRadio: () => this.#radio.maybeArmRadio(),
        resumeDrainedQueue: (r, record, firstAppended) =>
          this.#radio.resumeDrainedQueue(r, record, firstAppended),
      },
    });
    this.#playerUnsub = deps.player.subscribe((event) => {
      this.#playback.onPlayerEvent(event);
    });
  }

  snapshot(): SessionState {
    return this.#state;
  }

  /**
   * The live playback position — the playing/paused playback's last
   * observed position, else the queue's. Status ticks that move only
   * the position publish on the light channel; `subscribe` listeners
   * aren't woken for them, so position readers live here.
   */
  positionMs(): number {
    const ready = this.#ready;
    if (ready === null) {
      return 0;
    }
    const playback = ready.playback;
    return playback.type === 'buffering' ||
      playback.type === 'playing' ||
      playback.type === 'paused'
      ? playback.positionMs
      : ready.queue.positionMs;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Fires only when `positionMs()` actually moves — on full publishes
   * and on coalesced position-only status ticks alike.
   */
  subscribePosition(listener: (positionMs: number) => void): () => void {
    this.#positionListeners.add(listener);
    return () => {
      this.#positionListeners.delete(listener);
    };
  }

  #emitPosition(): void {
    const positionMs = this.positionMs();
    if (positionMs === this.#emittedPositionMs) {
      return;
    }
    this.#emittedPositionMs = positionMs;
    for (const listener of [...this.#positionListeners]) {
      try {
        listener(positionMs);
      } catch {
        // Subscriber exceptions are isolated.
      }
    }
  }

  /**
   * Rebuilds `#state` from `ready`, sharing last publish's frozen
   * sections whose source refs are unchanged. Sections are
   * copy-on-write so an identical array ref is proof of an identical
   * section; `radio` is the exception — its record mutates in place,
   * so the projection compares field-wise instead.
   */
  #syncState(ready: Ready): boolean {
    const prev = this.#state.type === 'ready' ? this.#state : undefined;
    const src = this.#publishSource;
    const shared =
      prev !== undefined && src !== undefined && src.ready === ready;
    const queueSnap = ready.queue.snapshot();
    // Reconcile on emit: mutation paths publish inside the storage
    // segment, before #derived would re-key the deal. The resolved
    // order is a function of the queue's occurrence set and the dealt
    // input — an unchanged engine revision and input resolve to it.
    const dealt =
      shared &&
      ready.queue === src.queue &&
      queueSnap.revision === src.queueRevision &&
      ready.shuffleOrder === src.shuffleInput
        ? src.dealt
        : this.#dealtOrder(ready);
    const radio = publishRadio(ready.radio);
    /** A shared section reuses the prior frozen array; changed data refreezes. */
    const section = <T>(
      live: readonly T[],
      priorLive: readonly T[] | undefined,
      priorPublished: readonly T[] | undefined,
    ): readonly T[] =>
      shared && live === priorLive && priorPublished !== undefined
        ? priorPublished
        : deepFreeze([...live]);
    const base: ReadySession = {
      type: 'ready',
      recordings: section(ready.recordings, src?.recordings, prev?.recordings),
      likes: section(ready.likes, src?.likes, prev?.likes),
      entities: section(ready.entities, src?.entities, prev?.entities),
      entitySourceRefs: section(
        ready.entitySourceRefs,
        src?.entitySourceRefs,
        prev?.entitySourceRefs,
      ),
      playlists: section(ready.playlists, src?.playlists, prev?.playlists),
      playlistEntries: section(
        ready.playlistEntries,
        src?.playlistEntries,
        prev?.playlistEntries,
      ),
      playHistory: section(
        ready.playHistory,
        src?.playHistory,
        prev?.playHistory,
      ),
      playCounts: section(ready.playCounts, src?.playCounts, prev?.playCounts),
      queue: queueSnap,
      settings:
        shared && ready.settings === src.settings
          ? prev.settings
          : deepFreeze({ ...ready.settings }),
      playback: ready.playback,
      repeat: ready.repeat,
      shuffle: dealt !== null,
      shuffleOrder:
        shared && dealt === src.dealt
          ? prev.shuffleOrder
          : dealt === null
            ? null
            : deepFreeze([...dealt]),
      radio:
        prev !== undefined && samePublishedRadio(radio, prev.radio)
          ? prev.radio
          : radio,
      // The published error is a clone sealed by the same freeze —
      // a subscriber must never mutate the mirror's own error.
      ...(ready.persistenceError === undefined
        ? {}
        : {
          persistenceError:
            shared && ready.persistenceError === src.persistenceError
              ? prev.persistenceError
              : { ...ready.persistenceError },
        }),
    };
    // An identical publish resolves every field to the last
    // snapshot's own refs — nothing moved, so nobody gets woken.
    if (
      prev !== undefined &&
      base.recordings === prev.recordings &&
      base.likes === prev.likes &&
      base.entities === prev.entities &&
      base.entitySourceRefs === prev.entitySourceRefs &&
      base.playlists === prev.playlists &&
      base.playlistEntries === prev.playlistEntries &&
      base.playHistory === prev.playHistory &&
      base.playCounts === prev.playCounts &&
      base.queue === prev.queue &&
      base.settings === prev.settings &&
      base.playback === prev.playback &&
      base.repeat === prev.repeat &&
      base.shuffle === prev.shuffle &&
      base.shuffleOrder === prev.shuffleOrder &&
      base.radio === prev.radio &&
      base.persistenceError === prev.persistenceError
    ) {
      return false;
    }
    this.#state = deepFreeze(base);
    this.#publishSource = {
      ready,
      recordings: ready.recordings,
      likes: ready.likes,
      entities: ready.entities,
      entitySourceRefs: ready.entitySourceRefs,
      playlists: ready.playlists,
      playlistEntries: ready.playlistEntries,
      playHistory: ready.playHistory,
      playCounts: ready.playCounts,
      queue: ready.queue,
      queueRevision: queueSnap.revision,
      settings: ready.settings,
      shuffleInput: ready.shuffleOrder,
      dealt,
      persistenceError: ready.persistenceError,
    };
    return true;
  }

  #publish(): void {
    if (this.#ready !== null && !this.#syncState(this.#ready)) {
      return;
    }
    this.#emitPosition();
    const state = this.#state;
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch {
        // Subscriber exceptions are isolated.
      }
    }
  }

  /**
   * A status tick whose only delta is the playback position: the
   * snapshot still refreshes so pull readers stay current, but the
   * whole-state channel is not woken — position listeners get the
   * move instead.
   */
  #publishPosition(): void {
    if (this.#ready !== null) {
      this.#syncState(this.#ready);
    }
    this.#emitPosition();
  }

  #requireReady(): Result<Ready> {
    const ready = this.#ready;
    if (ready === null || this.#disposed) {
      return err(appError('unavailable', 'session is not ready'));
    }
    return ok(ready);
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
   * Serializes one storage segment on the storage lane. Review ops run
   * whole read-modify-write cycles inside a segment, so they are
   * atomic against every session commit — and a commit queued behind
   * them evaluates its batch against the freshest mirror.
   *
   * `syncApply` segments keep the Ready projection cache across a
   * drain's pages; every other segment drops it first — a write
   * landing between applies must never feed a stale section into the
   * next projection.
   */
  #enqueueStorage<T>(
    fn: () => Promise<Result<T>>,
    options?: { readonly syncApply?: boolean },
  ): Promise<Result<T>> {
    return this.#storageSerial.run(() => {
      if (options?.syncApply !== true && this.#ready !== null) {
        this.#ready.syncApplyCache = null;
      }
      return fn();
    });
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
          return err(supersededError());
        }
        // A thunk batch evaluates inside the segment so it commits
        // the freshest mirror, not the state captured at call time.
        const evaluated = typeof batch === 'function' ? batch() : batch;
        const committed = await boundedCommit(
          this.#hostCore,
          this.#storage,
          evaluated,
          source,
        );
        if (committed.ok && evaluated.queue !== undefined) {
          generation.queueCommittedRev = Math.max(
            generation.queueCommittedRev,
            evaluated.queue.revision,
          );
        }
        if (committed.ok) {
          // Post-commit and best-effort: emission never rolls the
          // domain write back — it only feeds the change log.
          this.#syncIngress.emit(emissionWrites(syncEmitInput(generation), evaluated));
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
          return err(supersededError());
        }
        const staged = stage(r);
        if (!staged.ok) {
          return err(staged.error);
        }
        const { batch, apply } = staged.value;
        if (batch !== undefined) {
          const committed = await boundedCommit(
            this.#hostCore,
            this.#storage,
            batch,
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
          // Same post-commit seam as #persist — `r` still holds the
          // pre-apply sections the batch diffs against.
          this.#syncIngress.emit(emissionWrites(syncEmitInput(r), batch));
        }
        const outcome = apply(r);
        this.#publish();
        return ok(outcome);
      });
    } finally {
      this.#opSources.delete(source);
    }
  }

  /** `#commitStaged` plus the post-commit derive every caller ticks. */
  async #commitAndDerive<T>(
    stage: (r: Ready) => Result<CommitStage<T>>,
  ): Promise<Result<T>> {
    const staged = await this.#commitStaged(stage);
    this.#derived();
    return staged;
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
  /** The shared tail of a queue mutation command: capture the
   * pre-edit snapshot + marks, run the mutation, then commit with
   * rollback. The caller ticks `#derived` itself — it must run in the
   * caller's continuation, ahead of whatever follows the commit. */
  async #mutateQueue(
    r: Ready,
    mutate: (queue: QueueEngine) => void,
  ): Promise<Result<void>> {
    const before = r.queue.snapshot();
    const beforeMarks = r.queue.unplayableIds;
    try {
      mutate(r.queue);
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    return this.#persistQueue(r, before, beforeMarks);
  }

  async #persistQueue(
    r: Ready,
    before: QueueSnapshot,
    beforeMarks: ReadonlySet<string>,
  ): Promise<Result<void>> {
    const epoch = r.queueEpoch;
    // This command's own post-mutation state — captured at call time,
    // never the live engine at segment time. Committing `after` keeps
    // each command's durable batch to what it itself produced: a later
    // command's mutation can neither ride this commit nor survive in
    // storage after its own commit rolls memory back.
    const after = r.queue.snapshot();
    // The dealt order is a derivation of this same queue state — an
    // interleaved publish can already reconcile it (a removed id drops
    // out), so the rollback restores it alongside the engine snapshot:
    // otherwise the undone removal's id would re-enter the deal at a
    // random slot.
    const dealtBefore = r.shuffleOrder === null ? null : [...r.shuffleOrder];
    const dealtEpoch = r.shuffleEpoch;
    const generation = this.#ready;
    const source = new CancellationSource();
    this.#opSources.add(source);
    try {
      return await this.#enqueueStorage(async () => {
        const ready = this.#ready;
        if (generation === null || ready !== generation) {
          return err(supersededError());
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
        const committed = await boundedCommit(
          this.#hostCore,
          this.#storage,
          { queue: after },
          source,
        );
        if (!committed.ok) {
          r.queueEpoch += 1;
          r.queue = new QueueEngine(
            before,
            new Set([...beforeMarks, ...r.queue.unplayableIds]),
          );
          // Restore the pre-edit deal only when shuffle intent hasn't
          // moved — a toggle during this pending commit already dealt
          // against the (then-current) queue and must survive; the
          // reconcile that follows inserts any revived ids itself.
          if (r.shuffleEpoch === dealtEpoch) {
            r.shuffleOrder = dealtBefore;
          }
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
    this.#logWrite('warn', message);
  }

  #logDebug(message: string): void {
    this.#logWrite('debug', message);
  }

  #logWrite(level: 'debug' | 'warn', message: string): void {
    const atMs = this.#safeNow();
    if (atMs === null) {
      return;
    }
    const work = this.#bounded(() =>
      this.#log.write({ level, message, atMs }),
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
    this.#playback.cancelSuccessorMapping();
    this.#own(this.#playback.projectQueue());
    this.#playback.maybeMapSuccessor();
    this.#playback.maybeWarm();
    this.#radio.maybeGrowRadio();
    this.#radio.maybeArmRadio();
    // A drained queue with an armed tail may be mid-chase or waiting
    // on a reconnect — re-evaluate so offline-stranded chases resume.
    const cur = this.#ready;
    const rec = cur?.radio ?? null;
    if (
      cur !== null &&
      rec !== null &&
      cur.queue.snapshot().currentOccurrenceId === null
    ) {
      this.#radio.resumeDrainedQueue(cur, rec, undefined);
    }
  }

  // ---- sync ---------------------------------------------------------

  /**
   * The inbound half: fold remote merge outcomes onto the domain.
   * Runs a storage segment (the same serialization a review op gets):
   * load → project → commit → mirror → publish. The commit is atomic,
   * so a failure re-pends the whole folded union for the next drain
   * — refolding is idempotent. Never emits: remote writes are not
   * local writes.
   */
  applySyncedEntries(
    outcomes: readonly MergeOutcome[],
    signal?: CancellationSignal,
  ): Promise<Result<SyncApplyReport>> {
    return this.#syncIngress.applySyncedEntries(outcomes, signal);
  }

  /**
   * Durable recovery: rebuild the synced sections from the engine's
   * materialized record view. Use it when an outcome stream may have
   * been lost (drain-then-crash, bound eviction) — the engine's sync
   * log is durable, so its materialized truth is always rebuildable.
   * Records absent from `records` keep their rows (they were never
   * synced); rows whose records materialize empty are deleted.
   */
  applyMaterializedEntries(
    records: readonly MaterializedRecord[],
    signal?: CancellationSignal,
  ): Promise<Result<SyncApplyReport>> {
    return this.#syncIngress.applyMaterializedEntries(records, signal);
  }

  /**
   * Boot-time recovery for emissions that never reached the log —
   * the emit backlog is memory-only, so a shutdown or dead emit
   * port can strand committed writes (Review #46). `synced` maps the
   * engine's materialized `syncedRecordKey` to each live record's
   * fields — the same source `applyMaterializedEntries` consumes —
   * and every domain field the log never saw re-emits (absent
   * records AND stale field values). Upserts only: a record the
   * remote never saw can only be created, never re-deleted.
   */
  emitUnsynced(
    synced: ReadonlyMap<string, Record<string, unknown>>,
  ): Promise<void> {
    return this.#syncIngress.emitUnsynced(synced);
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
      loaded = await boundedLoad(
        this.#hostCore,
        this.#storage,
        source,
        'load',
      );
    } finally {
      this.#opSources.delete(source);
    }
    if (!loaded.ok) {
      return this.#restoreFailed(loaded.error);
    }
    if (!isPersistedState(loaded.value)) {
      return this.#restoreFailed(
        appError('invalid-response', 'persisted state failed validation'),
      );
    }
    const data = loaded.value;
    let queue: QueueEngine;
    try {
      queue = new QueueEngine(data.queue);
    } catch {
      return this.#restoreFailed(
        appError('invalid-response', 'persisted queue failed validation'),
      );
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
      repeat: 'off',
      shuffleOrder: null,
      shuffleEpoch: 0,
      listenCycles: listenCycleBaseline(
        queue.snapshot().occurrences,
        data.playHistory,
      ),
      radio: null,
      persistenceError: undefined,
      syncApplyCache: null,
      syncPending: [],
      materializedPending: [],
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

  #restoreFailed(error: AppError): Result<never> {
    this.#state = { type: 'restore-failed', error };
    this.#publish();
    return err(error);
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
    return this.#commitAndDerive((r) => {
      const up = upsertRecordingIn(
        r.recordings,
        metadata,
        this.#ids.next('rec'),
      );
      const occurrenceId = this.#ids.next('occ');
      const draft = r.queue.fork();
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
    const prevRows = r.recordings;
    // Only local rows are adopted — a foreign row would overwrite a
    // catalog mutation a racing op just made in memory.
    const committed = localRows.filter((rec) => rec.provenance === 'local');
    const committedIds = new Set(committed.map((rec) => rec.id));
    const byId = new Map(committed.map((rec) => [rec.id, rec]));
    const known = new Set<string>();
    const merged: Recording[] = [];
    for (const rec of prevRows) {
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
    // The domain's only recording-delete path: file removals must
    // tombstone remotely, adopted rows upsert.
    if (this.#sync !== undefined) {
      const prevById = new Map(prevRows.map((rec) => [rec.id, rec]));
      const writes: LocalWrite[] = [];
      const deleted: Recording[] = [];
      for (const rec of committed) {
        if (prevById.get(rec.id) !== rec) {
          writes.push(...recordingUpsertWrites(rec, prevById.get(rec.id)));
        }
      }
      for (const rec of prevRows) {
        if (rec.provenance === 'local' && !committedIds.has(rec.id)) {
          writes.push(
            ...recordingDeleteWrites(rec, {
              playlistEntries: r.playlistEntries,
              playHistory: r.playHistory,
            }),
          );
          deleted.push(rec);
        }
      }
      this.#syncIngress.emit(writes);
      if (deleted.length > 0) {
        this.#own(this.#syncIngress.emitMatchReviewTombstones(deleted));
      }
    }
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

  /**
   * Advisory warm for rows a surface is showing — never playback
   * intent, never an error channel. All hands are bounded and gated
   * by `settings.prefetch` + the connectivity reads:
   *
   * - `recordingIds`: candidates-resolve + automatic-mapping for the
   *   row's missing ref — up to `PREWARM_INPUT_LIMIT` ids drain into
   *   the same dealt-window pass; an 'ambiguous' match is a typed
   *   skip, never a review enqueue.
   * - `occurrenceIds`: queue rows the surface is showing (the
   *   viewport hand). A resolved row's ref queues into the stream
   *   backlog and mints in display order; an unresolved row is
   *   candidates-resolved, pinned, then minted — its tap adopts the
   *   already-spent session.
   * - `sourceRefs`: the FIRST playable ref for the active playback
   *   provider becomes the idle-time advisory stream warm — a real
   *   `player.prewarm` resolve+prepare whose minted session a later
   *   same-ref `prepare` adopts without re-resolving. Extra refs
   *   queue behind it in the backlog in rank order.
   * - `tracks`: catalog rows the visible page carries — those
   *   without a playback-provider ref candidates-resolve into the
   *   backlog (`q:` namespace, replaced wholesale on each hand).
   * - `focus`: the single row under the user's finger — hover,
   *   long-press, keyboard focus. Outranks every other hand; a
   *   resolved ref mints straight away, an unresolved one jumps the
   *   window pass's queue. The next focus replaces it — scroll
   *   churn cancels stale intent.
   *
   * Everything is cancellable and idempotent — repeated calls for
   * the same rows dedupe through `#warmSeen`/`#streamWarm`.
   */
  prewarm(input: PrewarmInput): void {
    this.#playback.prewarm(input);
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
    const staged = await this.#commitAndDerive((cur) => {
      const live = cur.recordings.find((rec) => rec.id === recordingId);
      if (live === undefined) {
        return err(appError('not-found', 'unknown recording'));
      }
      const occurrenceId = this.#ids.next('occ');
      const draft = cur.queue.fork();
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
    if (staged.ok) {
      // A just-enqueued row is the likeliest next tap — the viewport
      // hand resolves+pins+mint-warms it before any surface reports
      // it visible.
      this.#playback.prewarm({ occurrenceIds: [staged.value] });
    }
    return staged;
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
    return this.#commitAndDerive((r) => {
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
      const draft = r.queue.fork();
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
      const draft = r.queue.fork();
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
    return this.#library.toggleLike(recordingId);
  }

  toggleEntityLike(
    kind: EntityKind,
    entityId: string,
  ): Promise<Result<void>> {
    return this.#library.toggleEntityLike(kind, entityId);
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
    const work = this.#entitySerial.run(() => this.#getEntityPage(ref));
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
      page = await retryBounded({
        deadlineMs,
        signal: source.signal,
        clock: this.#clock,
        call: (signal) =>
          boundedOp(
            this.#hostCore,
            source,
            'entity',
            (ctx) => this.#router.getEntity(ref, ctx),
            signal,
            deadlineMs,
          ),
      });
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

  createPlaylist(name: string): Promise<Result<string>> {
    return this.#library.createPlaylist(name);
  }

  renamePlaylist(playlistId: string, name: string): Promise<Result<void>> {
    return this.#library.renamePlaylist(playlistId, name);
  }

  deletePlaylist(playlistId: string): Promise<Result<void>> {
    return this.#library.deletePlaylist(playlistId);
  }

  addPlaylistEntry(
    playlistId: string,
    recordingId: string,
    selectedRef: SourceRef | null = null,
  ): Promise<Result<string>> {
    return this.#library.addPlaylistEntry(
      playlistId,
      recordingId,
      selectedRef,
    );
  }

  removePlaylistEntry(entryId: string): Promise<Result<void>> {
    return this.#library.removePlaylistEntry(entryId);
  }

  reorderPlaylistEntry(
    entryId: string,
    move: EntryMove | null,
  ): Promise<Result<void>> {
    return this.#library.reorderPlaylistEntry(entryId, move);
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
    const work = this.#lyricsSerial.run(() =>
      this.#getLyrics(recordingId, context),
    );
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
    return this.#library.listMatchReviews(filter, context);
  }

  confirmReview(
    reviewId: string,
    candidateIndex: number,
    context?: OperationContext,
  ): Promise<Result<MatchReview>> {
    return this.#library.confirmReview(reviewId, candidateIndex, context);
  }

  /**
   * The verdict lands in the reloaded recording, so a gated play
   * attempt parked on the review resumes straight to it: the
   * confirm IS the retry. A retry failure lands as the new playback
   * error; the confirm itself stays a success.
   */
  async #resumeGatedPlayback(recordingId: string): Promise<void> {
    const playback = this.#ready?.playback;
    if (
      playback !== undefined &&
      playback.type === 'failed' &&
      playback.occurrenceId !== null &&
      playback.recordingId === recordingId &&
      isMatchGate(playback.error)
    ) {
      await this.playOccurrence(playback.occurrenceId);
    }
  }

  rejectReview(
    reviewId: string,
    context?: OperationContext,
  ): Promise<Result<MatchReview>> {
    return this.#library.rejectReview(reviewId, context);
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
    return this.#library.undoReview(reviewId, context);
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
    // Synced is always preferred: the sheet renders timed lines
    // whenever a provider can honestly produce them; the router
    // degrades to a lyrics.plain declarer otherwise.
    const routed = this.#router.lyricsProviderFor(
      selectionFromSettings(r.settings),
      'synced',
    );
    // A cached row is fresh only while the same provider version
    // stands behind it — an upgrade re-fetches so better ranking or
    // coverage replaces the stale pick. Rows written before version
    // tracking carry no providerVersion at all; requiring the field to
    // be present (not merely equal) keeps those legacy rows stale
    // under a null-version provider too. When no provider routes, the
    // cache still serves whatever it holds.
    const fresh =
      cached !== undefined &&
      (!routed.ok ||
        (cached.provider === routed.value.id &&
          cached.providerVersion !== undefined &&
          cached.providerVersion === routed.value.version));
    if (cached !== undefined && fresh) {
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
      const fetched = await retryBounded({
        deadlineMs,
        signal: source.signal,
        clock: this.#clock,
        call: (signal) =>
          boundedOp(
            this.#hostCore,
            source,
            'lyrics',
            (ctx) => provider.getLyrics({ query, prefer: 'synced' }, ctx),
            signal,
            deadlineMs,
          ),
      });
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
          : lyricsCacheEntry(
            recording.id,
            provider.id,
            provider.version,
            accepted,
            fetchedMs,
          );
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
      this.#own(this.#playback.startAttempt(snap.currentOccurrenceId));
    }
    return ok(undefined);
  }

  // ---- export / import ------------------------------------------------

  /** Serialize the owned library to export-document JSON text. */
  async exportLibrary(): Promise<Result<ExportResult>> {
    return this.#library.exportLibrary();
  }

  /**
   * Replace the owned library with a validated import document.
   * The document validates before anything changes; the commit is a
   * single all-or-nothing transaction; then the session rehydrates
   * from the replaced rows. Returns the confirm-screen summary.
   */
  async importLibrary(text: string): Promise<Result<ImportPreview>> {
    return this.#library.importLibrary(text);
  }

  /**
   * Import prelude, run before the storage-lane swap: release active
   * playback first (its recording rows are about to be replaced — a
   * clean release, the recording did not fail), cancel successor
   * mapping still resolving against the old rows, and disarm the
   * radio tail — an armed tail cannot survive the queue replace.
   */
  async #prepareImport(): Promise<void> {
    await this.#playback.releaseActiveAttempt();
    this.#playback.cancelSuccessorMapping();
    const replaced = this.#ready;
    if (replaced !== null) {
      this.#radio.clearRadio(replaced);
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
    return this.#radio.startRadio(ref);
  }

  /**
   * Disarm the radio tail. Queued occurrences are untouched — the
   * queue simply stops growing.
   */
  stopRadio(): Result<void> {
    return this.#radio.stopRadio();
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
    const persisted = await this.#mutateQueue(r, (q) =>
      q.select(occurrenceId, true),
    );
    if (!persisted.ok) {
      return persisted;
    }
    this.#derived();
    return this.#playback.startAttempt(occurrenceId);
  }

  async next(): Promise<Result<void>> {
    return this.#playback.advance('next');
  }

  async previous(): Promise<Result<void>> {
    return this.#playback.advance('previous');
  }

  async skipCurrent(): Promise<Result<void>> {
    return this.#playback.advance('next');
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
    const beforeMarks = r.queue.unplayableIds;
    if (before.currentOccurrenceId === null) {
      return err(appError('no-result', 'queue has no current occurrence'));
    }
    try {
      r.queue.stop();
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    // Stop means stop: an armed tail drops BEFORE the persist await —
    // a page landing during it must find `r.radio` empty, or its
    // drain-resume would start a fresh attempt mid-teardown.
    const radioRecord = r.radio;
    this.#radio.clearRadio(r);
    // Commit the stopped queue before the irreversible transport
    // teardown: a failed commit rolls the engine back to playing and
    // leaves the live attempt untouched — the caller's error is
    // honest and playback genuinely continues.
    const persisted = await this.#persistQueue(r, before, beforeMarks);
    if (!persisted.ok) {
      // The queue stays live, so a tail whose fetch already landed
      // can ride on; a cancelled mid-flight fetch can't be
      // resurrected and stays dropped.
      if (
        radioRecord !== null &&
        !radioRecord.fetching &&
        r.radio === null
      ) {
        r.radio = radioRecord;
      }
      return persisted;
    }
    await this.#playback.supersede();
    const ready2 = this.#ready;
    if (ready2 !== null) {
      ready2.playback = { type: 'idle' };
    }
    this.#derived();
    this.#publish();
    return ok(undefined);
  }

  /**
   * The queue's repeat rule. It travels inside the queue projection —
   * a toggle re-installs the current revision so the service's next
   * cursor move follows the new rule; with no projection installed it
   * only changes the published state (and the JS-side fallback rules).
   */
  async setRepeatMode(mode: RepeatMode): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (r.repeat === mode) {
      return ok(undefined);
    }
    r.repeat = mode;
    this.#publish();
    await this.#playback.projectQueue();
    return ok(undefined);
  }

  /** Transport cycle: off → all → one → off. */
  async cycleRepeat(): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    return this.setRepeatMode(
      r.repeat === 'off' ? 'all' : r.repeat === 'all' ? 'one' : 'off',
    );
  }

  /**
   * The queue's shuffle rule. Like `repeat` it travels inside the
   * queue projection: toggling on deals a fresh `order` — the
   * canonical prefix through the cursor stays (real `previous`
   * history), successors shuffle uniformly — and re-installs the
   * current revision so service and JS fallback walk the same deal
   * (decisions.md → Playback).
   */
  async setShuffle(enabled: boolean): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if ((r.shuffleOrder !== null) === enabled) {
      return ok(undefined);
    }
    if (enabled) {
      const snap = r.queue.snapshot();
      const ids = snap.occurrences.map((o) => o.occurrenceId);
      const cursorIndex =
        snap.currentOccurrenceId === null
          ? -1
          : ids.indexOf(snap.currentOccurrenceId);
      const upcoming = ids
        .slice(cursorIndex + 1)
        // Random-key sort — uniform over permutations, same deal as
        // playMetadata's enqueue shuffle.
        .map((id) => ({ id, rank: this.#random.unit() }))
        .sort((a, b) => a.rank - b.rank)
        .map(({ id }) => id);
      r.shuffleOrder = [...ids.slice(0, cursorIndex + 1), ...upcoming];
    } else {
      r.shuffleOrder = null;
    }
    r.shuffleEpoch += 1;
    this.#publish();
    await this.#playback.projectQueue();
    // The deal re-targets the cursor's successor — re-run the lazy
    // derivations (speculative map, radio growth, tail arm) under
    // the new walk, same as a queue edit would.
    this.#playback.cancelSuccessorMapping();
    this.#playback.maybeMapSuccessor();
    this.#playback.maybeWarm();
    this.#radio.maybeGrowRadio();
    this.#radio.maybeArmRadio();
    return ok(undefined);
  }

  /** Transport toggle: dealt order on, canonical order off. */
  async toggleShuffle(): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    return this.setShuffle(ready.value.shuffleOrder === null);
  }

  /**
   * The dealt play order under shuffle — occurrence ids the cursor
   * walks, `null` when off. Reconciles against the live queue on every
   * call: removed occurrences drop out; newly enqueued ones insert at
   * uniform random positions behind the cursor's dealt position (at
   * the dealt tail when the walk has no cursor), so a mutation never
   * reshuffles dealt successors or rewrites history.
   */
  #dealtOrder(r: Ready): readonly string[] | null {
    const dealt = r.shuffleOrder;
    if (dealt === null) {
      return null;
    }
    const snap = r.queue.snapshot();
    const live = new Set(snap.occurrences.map((o) => o.occurrenceId));
    const order = dealt.filter((id) => live.has(id));
    const dealtSet = new Set(order);
    const cursorPos =
      snap.currentOccurrenceId === null
        ? -1
        : order.indexOf(snap.currentOccurrenceId);
    let changed = order.length !== dealt.length;
    for (const occurrence of snap.occurrences) {
      if (dealtSet.has(occurrence.occurrenceId)) {
        continue;
      }
      dealtSet.add(occurrence.occurrenceId);
      // No cursor means the walk is all history (drained) or all
      // future (never started) — new items append in order rather
      // than landing mid-walk, which also keeps a drained queue's
      // resume pointed at the first appended item. With a cursor,
      // insert at a uniform slot behind it.
      const slot =
        snap.currentOccurrenceId === null
          ? order.length
          : cursorPos +
          1 +
          Math.floor(
            this.#random.unit() * (order.length - cursorPos),
          );
      order.splice(slot, 0, occurrence.occurrenceId);
      changed = true;
    }
    if (changed) {
      r.shuffleOrder = order;
    }
    return r.shuffleOrder;
  }

  async pause(): Promise<Result<void>> {
    return this.#playback.pause();
  }

  async resume(): Promise<Result<void>> {
    return this.#playback.resume();
  }

  async seekTo(
    positionMs: number,
    expectedOccurrenceId?: string,
  ): Promise<Result<void>> {
    return this.#playback.seekTo(positionMs, expectedOccurrenceId);
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
    const persisted = await this.#mutateQueue(r, (q) => q.play());
    if (!persisted.ok) {
      return persisted;
    }
    this.#derived();
    return this.#playback.startAttempt(current);
  }

  async removeOccurrence(id: string): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const before = r.queue.snapshot();
    const beforeMarks = r.queue.unplayableIds;
    const wasCurrent = before.currentOccurrenceId === id;
    const radioBefore = r.radio;
    // Under shuffle the item after a removed current is the dealt
    // successor — the engine's canonical pick would replay an item
    // the walk already passed or stop short of the deal's real
    // continuation. Captured pre-remove: the reconcile drops the id.
    const dealt = wasCurrent ? this.#dealtOrder(r) : null;
    const dealtPos = dealt === null ? -1 : dealt.indexOf(id);
    const dealtNext =
      dealtPos < 0 ? undefined : (dealt?.[dealtPos + 1] ?? null);
    try {
      r.queue.remove(id);
      if (dealtNext !== undefined) {
        if (dealtNext === null) {
          // Dealt tail: nothing walks next.
          r.queue.stop();
        } else {
          r.queue.select(dealtNext, before.mode === 'playing');
        }
      }
    } catch {
      return err(appError('not-found', 'unknown occurrence'));
    }
    // Commit the removal before superseding the removed occurrence's
    // attempt: on a failed commit the engine rollback restores the
    // item and the still-live attempt keeps it playing honestly.
    const persisted = await this.#persistQueue(r, before, beforeMarks);
    if (!persisted.ok) {
      return persisted;
    }
    {
      // Same drain authorization as advance: removing the last item
      // while playing earns the armed tail a resume; any other
      // removal revokes a stale grant — a paused drain must never
      // resurrect playback it was granted under.
      const rec = r.radio;
      if (
        rec !== null &&
        rec === radioBefore &&
        rec.status === 'growing'
      ) {
        const after = r.queue.snapshot();
        rec.resumeOnDrain =
          after.currentOccurrenceId === null && before.mode === 'playing';
      }
    }
    if (wasCurrent) {
      await this.#playback.supersede();
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
      return this.#playback.startAttempt(snap.currentOccurrenceId);
    }
    this.#publish();
    return ok(undefined);
  }

  /**
   * Reorder by display slot — the index inside the sectioned queue
   * model (now-playing row first, then up-next, then history). UI
   * reorder stays confined to up-next, so the destination lands in
   * the walk right behind the cursor: canonical index `cursor + slot`
   * when shuffle is off, dealt position `cursor + slot` when on —
   * where the dealt move also re-writes the playback walk itself.
   */
  async moveOccurrence(id: string, toIndex: number): Promise<Result<void>> {
    const ready = this.#requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const before = r.queue.snapshot();
    const beforeMarks = r.queue.unplayableIds;
    const dealt = this.#dealtOrder(r);
    // The deal this move writes — remembered so a commit failure can
    // roll it back only while no later mutation owns the field.
    let movedDeal: string[] | null = null;
    try {
      if (dealt === null) {
        const cursor =
          before.currentOccurrenceId === null
            ? -1
            : before.occurrences.findIndex(
                (o) => o.occurrenceId === before.currentOccurrenceId,
              );
        r.queue.move(id, cursor === -1 ? toIndex : cursor + toIndex);
      } else {
        // The rendered order under shuffle IS the deal: move the row
        // inside it so playback follows, and write the same sequence
        // into the canonical order — a later shuffle-off keeps the
        // user's layout instead of partially reverting it.
        const cursor =
          before.currentOccurrenceId === null
            ? -1
            : dealt.indexOf(before.currentOccurrenceId);
        const order = dealt.filter((x) => x !== id);
        const dest = Math.min(
          Math.max(cursor === -1 ? toIndex : cursor + toIndex, 0),
          order.length,
        );
        order.splice(dest, 0, id);
        r.queue.reorder(order);
        r.shuffleOrder = order;
        movedDeal = order;
      }
    } catch (thrown) {
      return err(
        thrown instanceof TypeError
          ? appError('not-found', 'invalid move')
          : fromUnknown(thrown),
      );
    }
    const persisted = await this.#persistQueue(r, before, beforeMarks);
    if (!persisted.ok) {
      // The queue snapshot rolled back; the session-side deal must
      // too — but only while it still IS this move's write (a shuffle
      // toggle that raced the commit owns the field now). The restored
      // deal is pruned to the rolled-back membership, same reconcile
      // rule #dealtOrder applies.
      if (dealt !== null && r.shuffleOrder === movedDeal) {
        const snap = r.queue.snapshot();
        const live = new Set(
          snap.occurrences.map((o) => o.occurrenceId),
        );
        r.shuffleOrder = dealt.filter((x) => live.has(x));
      }
      return persisted;
    }
    this.#derived();
    this.#publish();
    if (dealt !== null) {
      // A deal-only edit may leave the queue revision untouched — the
      // player still needs the re-walked order.
      await this.#playback.projectQueue();
    }
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

  // ---- lifecycle ----------------------------------------------------

  async drain(): Promise<void> {
    return this.#drainAll(false);
  }

  /** Full drain including armed deadline work; used by dispose. */
  async #drainAll(includeDeadlineWork = true): Promise<void> {
    for (; ;) {
      await this.#playback.eventsIdle();
      const pending = [
        ...this.#ownedWork,
        ...this.#playback.releaseWork(),
        ...(includeDeadlineWork ? this.#deadlineWork : []),
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
    this.#playback.cancelSuccessorMapping();
    for (const timer of [...this.#timers]) {
      timer.cancel();
    }
    for (const source of [...this.#opSources]) {
      source.cancel();
    }
    await this.#playback.teardownForDispose();
    this.#playerUnsub();
    await this.#drainAll();
    // Graceful emit finish AFTER owned work settles: the cancel loop
    // above kills the in-flight drain mid-send, leaving its chunk
    // queued — one final drain with a fresh, uncancelled source gives
    // committed writes their stamp instead of dying with the queue
    // (Review #46). A failure just keeps the queue; boot-diff is the
    // net for whatever the port could not take.
    await this.#syncIngress.drainEmissions().catch(() => undefined);
  }
}
