import { CancellationSource } from '../cancellation.ts';
import type { CancellationSignal } from '../cancellation.ts';
import type { Recording } from '../domain.ts';
import type { Result } from '../errors.ts';
import { appError, err, ok } from '../errors.ts';
import { isPersistedState } from '../library/library.ts';
import { QueueEngine } from '../queue/queue-engine.ts';
import type {
  LocalWrite,
  MaterializedRecord,
  MergeOutcome,
} from '../sync/sync-engine.ts';
import {
  projectAppliedEntries,
  projectMaterialized,
  unsyncedWrites,
} from '../sync/sync-projection.ts';
import { utf8ByteLength } from '../sync/sync-wire.ts';
import type { ProviderCapability } from '../ports/provider.ts';
import type { StorageBatch, StoragePort } from '../ports/storage.ts';
import { Serializer } from './serializer.ts';
import type { Ready, SessionHostCore } from './ready.ts';
import { syncEmitInput } from './ready.ts';
import {
  boundedCommit,
  boundedLoad,
  supersededError,
} from './util.ts';
import type {
  SyncApplyReport,
  SyncApplySections,
  SyncEmitPort,
} from './session.ts';

/** Desktop's sync:localChanges channel caps one batch at 256 writes. */
const SYNC_EMIT_CHUNK = 256;
/**
 * Emit chunks also bound by encoded size: the channel's result is a
 * small ack, but the REQUEST itself must stay well under the wire
 * doc cap — a count-only bound let ~16 MiB of writes ride one call
 * (Review #46 round-9). One write can never exceed the field cap,
 * so every write fits a fresh chunk alone; the head-drop branch is
 * only a belt for a value that slips past its own field bound.
 */
const SYNC_EMIT_BYTES = 768 * 1024;
/** Retained emit backlog bound — drop-oldest past it. */
const SYNC_EMIT_PENDING_MAX = 2_048;
/** Post-projection pending bound — unresolved inserts waiting on
 *  parent rows; drop-newest past it. Never bounds a fresh drain. */
const SYNC_APPLY_PENDING_MAX = 2_048;

const SYNC_APPLY_STABLE: SyncApplyReport = { rehydrateMedia: false };

function appliedOutcomeKey(outcome: MergeOutcome): string {
  if (outcome.type !== 'applied') {
    return '';
  }
  const entry = outcome.entry;
  return `${entry.deviceId}${entry.hlc.l}${entry.hlc.c}`;
}

/**
 * Only 'applied' outcomes feed the fold; dedupe by entry key so a
 * redelivered outcome can't double-apply, and bound the hold so a
 * permanently unmaterializable record can't grow memory.
 */
function boundSyncPending(
  outcomes: readonly MergeOutcome[],
): MergeOutcome[] {
  const seen = new Set<string>();
  const out: MergeOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.type !== 'applied') {
      continue;
    }
    const key = appliedOutcomeKey(outcome);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(outcome);
    if (out.length >= SYNC_APPLY_PENDING_MAX) {
      break;
    }
  }
  return out;
}

/**
 * Failure-path retention: the union still feeds the next drain, but
 * bounded and deduped like the success path — a growing failure loop
 * can't grow memory unboundedly (Review #46). Evicted outcomes are
 * recoverable via `applyMaterializedEntries` — the engine's durable
 * log still holds them; the typed warn marks the loss window.
 */
function retainSyncPending(
  union: readonly MergeOutcome[],
  warn: (message: string) => void,
): MergeOutcome[] {
  const retained = boundSyncPending(union);
  const eligible = union.reduce(
    (n, o) => n + (o.type === 'applied' ? 1 : 0),
    0,
  );
  if (retained.length < eligible) {
    warn('sync pending bound evicted applied outcomes');
  }
  return retained;
}

/**
 * Bound + dedupe materialized pending: same (kind, recordId) re-served
 * is a newer snapshot — last wins; evictions drop the OLDEST pending
 * record and warn, matching the outcome-side bound.
 */
function boundMaterializedPending(
  records: readonly MaterializedRecord[],
): MaterializedRecord[] {
  const seen = new Set<string>();
  const out: MaterializedRecord[] = [];
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i];
    if (rec === undefined) {
      continue;
    }
    const key = `${rec.kind}\u001f${rec.recordId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.unshift(rec);
    if (out.length >= SYNC_APPLY_PENDING_MAX) {
      break;
    }
  }
  return out;
}

function retainMaterializedPending(
  union: readonly MaterializedRecord[],
  warn: (message: string) => void,
): MaterializedRecord[] {
  const retained = boundMaterializedPending(union);
  const eligible = new Set(
    union.map((rec) => `${rec.kind}\u001f${rec.recordId}`),
  ).size;
  if (retained.length < eligible) {
    warn('sync materialized pending bound evicted records');
  }
  return retained;
}

export type SyncHost = SessionHostCore & {
  /** Whether an injected provider is installed under this id. */
  readonly hasProvider: (id: string) => boolean;
  /** Whether an injected provider DECLARES one of the capabilities —
   *  presence alone does not route a slot into a usable op. */
  readonly providerDeclares: (
    id: string,
    capabilities: readonly ProviderCapability[],
  ) => boolean;
};

export type SyncIngressDeps = {
  readonly storage: StoragePort;
  readonly sync: SyncEmitPort | undefined;
  readonly host: SyncHost;
};

/**
 * The sync boundary, both directions. Emission is post-commit and
 * best-effort: the domain write is already durable, so a failed emit
 * leaves the change log behind — never a rollback. Writes queue onto
 * `#syncEmitPending` and a single tail drains them to the emit port
 * in channel-sized chunks. Ingress folds remote merge outcomes onto
 * the domain inside a storage segment and retains whatever could not
 * land for the next drain.
 */
export class SyncIngress {
  readonly #storage: StoragePort;
  readonly #sync: SyncEmitPort | undefined;
  readonly #host: SyncHost;
  readonly #syncSerial = new Serializer();
  /**
   * Emitted writes waiting on the emit port — session-scoped so an
   * import's Ready swap can't strand them. Drained FIFO, chunked to
   * the desktop channel's write cap; a failed drain keeps the chunk
   * for the next emission. Drop-oldest bound: a permanently dead
   * port degrades to the newest writes, never unbounded memory.
   */
  #syncEmitPending: LocalWrite[] = [];
  /**
   * Recording ids owed a matchReview tombstone emission. The review
   * ids live only in the persisted section — a load that fails after
   * the delete committed would otherwise drop the tombstones forever
   * and a peer re-upserting its orphan review would wedge sync on the
   * referential check. Retained until an emission's load succeeds;
   * `emitUnsynced` re-kicks the drain for survivors of a ready swap.
   */
  #reviewTombstoneIds = new Set<string>();

  constructor(deps: SyncIngressDeps) {
    this.#storage = deps.storage;
    this.#sync = deps.sync;
    this.#host = deps.host;
  }

  /**
   * Queue the mapped writes and kick the drain. Called inside the
   * storage segment right after a successful syncable commit — the
   * drain itself is async port work, so it never holds the tail.
   * A fresh commit's writes are NEVER truncated — the bound below
   * applies only to a backlog that keeps failing to send.
   */
  emit(writes: readonly LocalWrite[]): void {
    // Queue even during dispose — dispose runs one final graceful
    // drain after owned work settles, and a commit landing inside it
    // still deserves its emission (Review #46).
    if (this.#sync === undefined || writes.length === 0) {
      return;
    }
    this.#syncEmitPending.push(...writes);
    this.#host.own(this.drainEmissions());
  }

  drainEmissions(): Promise<void> {
    return this.#syncSerial.run(() => this.#drainEmitPending());
  }

  async #drainEmitPending(): Promise<void> {
    const sync = this.#sync;
    if (sync === undefined) {
      return;
    }
    while (this.#syncEmitPending.length > 0) {
      const chunk = this.#syncEmitChunk();
      if (chunk.length === 0) {
        continue;
      }
      const source = new CancellationSource();
      const untrack = this.#host.trackSource(source);
      let sent: Result<unknown>;
      try {
        const deadlineMs = this.#host.deadline();
        sent = await this.#host.withDeadline(
          () => sync.localChanges(chunk, source.signal),
          deadlineMs,
          source,
        );
      } finally {
        untrack();
      }
      if (!sent.ok) {
        // Retained: put the chunk back at the head so the next
        // emission retries it. The backlog bound applies HERE only —
        // under a sustained send failure, drop-oldest caps memory
        // while the fresh-writes path above never truncates a
        // healthy commit.
        this.#syncEmitPending.unshift(...chunk);
        if (this.#syncEmitPending.length > SYNC_EMIT_PENDING_MAX) {
          this.#syncEmitPending.splice(
            0,
            this.#syncEmitPending.length - SYNC_EMIT_PENDING_MAX,
          );
          this.#host.logWarn(
            'sync emission backlog overflowed; oldest writes dropped',
          );
        }
        // Surface through the persist-owned channel —
        // the domain writes already landed, so this reports the
        // truth: the change log is behind, not the library.
        const r = this.#host.ready();
        if (r !== null) {
          r.persistenceError = sent.error;
          this.#host.publish();
        }
        this.#host.logWarn('sync emission failed; writes retained for retry');
        return;
      }
      // The chunk already left the queue when it was sliced — a
      // failure above is the only path that re-queues nothing, and
      // that path returns before here.
    }
  }

  /**
   * Slice the head chunk by count AND encoded bytes — a batch that
   * passes per-write field bounds can still overflow the wire doc
   * cap when summed, and an oversized send reports as a transport
   * failure while the engine append already landed, so the same
   * writes would retry into an ever-growing log (Review #46
   * round-9). A head write bigger than the whole budget can never
   * fit — drop it with a typed warn rather than wedge the queue.
   */
  #syncEmitChunk(): LocalWrite[] {
    const chunk: LocalWrite[] = [];
    let bytes = 2; // '[]'
    while (this.#syncEmitPending.length > 0) {
      const write = this.#syncEmitPending[0];
      if (write === undefined) {
        break;
      }
      const size = utf8ByteLength(JSON.stringify(write)) + 1;
      if (chunk.length === 0 && bytes + size > SYNC_EMIT_BYTES) {
        this.#syncEmitPending.shift();
        this.#host.logWarn(
          'sync emission dropped an oversized write; cannot fit the channel bound',
        );
        continue;
      }
      if (
        chunk.length >= SYNC_EMIT_CHUNK ||
        bytes + size > SYNC_EMIT_BYTES
      ) {
        break;
      }
      this.#syncEmitPending.shift();
      chunk.push(write);
      bytes += size;
    }
    return chunk;
  }

  /**
   * The projection input a sync apply needs beyond the Ready mirror —
   * loaded once per drain, then reused by the drain's remaining apply
   * segments. The cache lives on `r` so a Ready swap drops it whole.
   */
  async #syncApplySections(
    r: Ready,
    source: CancellationSource,
    deadlineMs: number,
  ): Promise<Result<SyncApplySections>> {
    if (r.syncApplyCache !== null) {
      return ok(r.syncApplyCache);
    }
    const loaded = await boundedLoad(
      this.#host,
      this.#storage,
      source,
      'load',
      undefined,
      deadlineMs,
    );
    if (!loaded.ok) {
      return err(loaded.error);
    }
    if (!isPersistedState(loaded.value)) {
      return err(
        appError('invalid-response', 'persisted state failed validation'),
      );
    }
    r.syncApplyCache = {
      matchReviews: loaded.value.matchReviews,
      lyricsCache: loaded.value.lyricsCache,
      downloads: loaded.value.downloads,
      localFiles: loaded.value.localFiles,
    };
    return ok(r.syncApplyCache);
  }

  /**
   * The inbound half: fold remote merge outcomes onto the domain.
   * Runs a storage segment (the same serialization a review op gets):
   * load → project → commit → mirror → publish. The commit is atomic,
   * so a failure re-pends the whole folded union for the next drain
   * — refolding is idempotent. Never emits: remote writes are not
   * local writes.
   */
  async applySyncedEntries(
    outcomes: readonly MergeOutcome[],
    signal?: CancellationSignal,
  ): Promise<Result<SyncApplyReport>> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const generation = ready.value;
    const source = new CancellationSource();
    const unlink = signal?.subscribe(() => {
      source.cancel();
    });
    const untrack = this.#host.trackSource(source);
    try {
      return await this.#host.enqueueStorage(async () => {
        const r = this.#host.ready();
        if (r === null || r !== generation) {
          return err(supersededError());
        }
        const deadlineMs = this.#host.deadline();
        // One load seeds the whole drain — later pages reuse the
        // cached sections. `reused` marks an input older than this
        // segment: its download/local-file rows may have moved under
        // their off-tail owners, checked again below.
        const reused = r.syncApplyCache !== null;
        const loaded = await this.#syncApplySections(
          r,
          source,
          deadlineMs,
        );
        // The transport already consumed these outcomes — every one
        // feeds projection; the bound applies only to post-projection
        // pending, never to a fresh drain (Review #46).
        const union = [...r.syncPending, ...outcomes];
        const warn = (m: string): void => this.#host.logWarn(m);
        if (!loaded.ok) {
          // Retain the union for the next drain exactly like a commit
          // failure — consumed outcomes can't be re-fetched.
          r.syncPending = retainSyncPending(union, warn);
          r.persistenceError = loaded.error;
          this.#host.publish();
          return err(loaded.error);
        }
        // Refold earlier pending outcomes with the new ones — a
        // parent row landing this drain unblocks a held insert.
        const superseded = outcomes.filter(
          (o) => o.type !== 'applied',
        ).length;
        if (superseded > 0) {
          // Losing entries keep the domain row — divergence history
          // owns them; the log notes the drop without record ids.
          this.#host.logWarn(
            `sync projection dropped ${superseded} non-applied outcomes`,
          );
        }
        const project = (input: SyncApplySections) =>
          projectAppliedEntries(union, {
            recordings: r.recordings,
            likes: r.likes,
            entities: r.entities,
            entitySourceRefs: r.entitySourceRefs,
            playlists: r.playlists,
            playlistEntries: r.playlistEntries,
            playHistory: r.playHistory,
            playCounts: r.playCounts,
            matchReviews: input.matchReviews,
            lyricsCache: input.lyricsCache,
            downloads: input.downloads,
            localFiles: input.localFiles,
            queue: r.queue.snapshot(),
            settings: r.settings,
          });
        let projection = project(loaded.value);
        // Spread lifts the readonly section map — the settings
        // reconcile below may rewrite the projected row.
        let batch = { ...projection.batch };
        if (
          reused &&
          (batch.recordings !== undefined ||
            batch.recordingsMerge !== undefined ||
            batch.downloads !== undefined ||
            batch.localFiles !== undefined ||
            batch.matchReviews !== undefined ||
            batch.lyricsCache !== undefined)
        ) {
          // DownloadManager, LocalFileSource, and the matchReview /
          // lyrics lanes commit on their own lanes — rows cached
          // from an earlier page may be stale, so a batch that
          // rewrites either section re-loads and re-projects
          // against fresh truth before committing it. A recordings
          // write must reload too even when no media section
          // projected: a fresh off-tail row referencing a deleted
          // recording is invisible to the cached projection, but
          // the commit's in-transaction merge still validates it.
          r.syncApplyCache = null;
          const fresh = await this.#syncApplySections(
            r,
            source,
            deadlineMs,
          );
          if (!fresh.ok) {
            r.syncPending = retainSyncPending(union, warn);
            r.persistenceError = fresh.error;
            this.#host.publish();
            return err(fresh.error);
          }
          projection = project(fresh.value);
          batch = { ...projection.batch };
        }
        for (const skip of projection.skipped) {
          this.#host.logWarn(`sync projection skipped ${skip.kind} record`);
        }
        if (Object.keys(batch).length === 0) {
          r.syncPending = boundSyncPending(projection.pending);
          // A clean projection clears the surface it shares with
          // persist failures — the failure that set it is resolved.
          r.persistenceError = undefined;
          this.#host.publish();
          return ok(SYNC_APPLY_STABLE);
        }
        const applied = await this.#commitSyncProjection(
          r,
          batch,
          source,
          deadlineMs,
        );
        if (!applied.ok) {
          // Nothing landed — refold the whole union next drain.
          r.syncPending = retainSyncPending(union, warn);
          return applied;
        }
        r.syncPending = boundSyncPending(projection.pending);
        return applied;
      }, { syncApply: true });
    } finally {
      unlink?.();
      untrack();
    }
  }

  /**
   * Durable recovery: rebuild the synced sections from the engine's
   * materialized record view. Use it when an outcome stream may have
   * been lost (drain-then-crash, bound eviction) — the engine's sync
   * log is durable, so its materialized truth is always rebuildable.
   * Records absent from `records` keep their rows (they were never
   * synced); rows whose records materialize empty are deleted.
   */
  async applyMaterializedEntries(
    records: readonly MaterializedRecord[],
    signal?: CancellationSignal,
  ): Promise<Result<SyncApplyReport>> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const generation = ready.value;
    const source = new CancellationSource();
    const unlink = signal?.subscribe(() => {
      source.cancel();
    });
    const untrack = this.#host.trackSource(source);
    try {
      return await this.#host.enqueueStorage(async () => {
        const r = this.#host.ready();
        if (r === null || r !== generation) {
          return err(supersededError());
        }
        const deadlineMs = this.#host.deadline();
        // Same drain reuse as applySyncedEntries — one seeded load
        // serves the whole rebuild; `reused` re-checks the off-tail
        // sections before a cached batch rewrites them.
        const reused = r.syncApplyCache !== null;
        const loaded = await this.#syncApplySections(
          r,
          source,
          deadlineMs,
        );
        const warn = (m: string): void => this.#host.logWarn(m);
        // Union retained pending with the fresh page — a dependent
        // that pended on an earlier page folds again here and lands
        // once its parent arrives (same key, fresher record wins).
        const union = [...r.materializedPending, ...records];
        if (!loaded.ok) {
          // Served-but-unprojected records are as consumed as drained
          // outcomes — retain the union for the next call exactly like
          // a commit failure (Review #46).
          r.materializedPending = retainMaterializedPending(union, warn);
          r.persistenceError = loaded.error;
          this.#host.publish();
          return err(loaded.error);
        }
        const project = (input: SyncApplySections) =>
          projectMaterialized(union, {
            recordings: r.recordings,
            likes: r.likes,
            entities: r.entities,
            entitySourceRefs: r.entitySourceRefs,
            playlists: r.playlists,
            playlistEntries: r.playlistEntries,
            playHistory: r.playHistory,
            playCounts: r.playCounts,
            matchReviews: input.matchReviews,
            lyricsCache: input.lyricsCache,
            downloads: input.downloads,
            localFiles: input.localFiles,
            queue: r.queue.snapshot(),
            settings: r.settings,
          });
        let projection = project(loaded.value);
        let batch = { ...projection.batch };
        if (
          reused &&
          (batch.recordings !== undefined ||
            batch.recordingsMerge !== undefined ||
            batch.downloads !== undefined ||
            batch.localFiles !== undefined ||
            batch.matchReviews !== undefined ||
            batch.lyricsCache !== undefined)
        ) {
          // Off-lane owners (downloads, local files, match reviews,
          // lyrics cache) may have moved the cached rows — reload
          // and re-project before a rewrite, and before a recording
          // write: the commit re-validates fresh dependent rows a
          // cached projection never saw.
          r.syncApplyCache = null;
          const fresh = await this.#syncApplySections(
            r,
            source,
            deadlineMs,
          );
          if (!fresh.ok) {
            r.materializedPending = retainMaterializedPending(
              union,
              warn,
            );
            r.persistenceError = fresh.error;
            this.#host.publish();
            return err(fresh.error);
          }
          projection = project(fresh.value);
          batch = { ...projection.batch };
        }
        for (const skip of projection.skipped) {
          this.#host.logWarn(`sync projection skipped ${skip.kind} record`);
        }
        if (Object.keys(batch).length === 0) {
          r.materializedPending = boundMaterializedPending(
            projection.pendingRecords,
          );
          r.persistenceError = undefined;
          this.#host.publish();
          return ok(SYNC_APPLY_STABLE);
        }
        const applied = await this.#commitSyncProjection(
          r,
          batch,
          source,
          deadlineMs,
        );
        if (!applied.ok) {
          // Nothing landed — the union refolds on the next call.
          r.materializedPending = retainMaterializedPending(union, warn);
          return applied;
        }
        r.materializedPending = boundMaterializedPending(
          projection.pendingRecords,
        );
        return applied;
      }, { syncApply: true });
    } finally {
      unlink?.();
      untrack();
    }
  }

  /**
   * Boot-time recovery for emissions that never reached the log —
   * `#syncEmitPending` is memory-only, so a shutdown or dead emit
   * port can strand committed writes (Review #46). `synced` maps the
   * engine's materialized `syncedRecordKey` to each live record's
   * fields — the same source `applyMaterializedEntries` consumes —
   * and every domain field the log never saw re-emits (absent
   * records AND stale field values). Upserts only: a record the
   * remote never saw can only be created, never re-deleted.
   */
  async emitUnsynced(
    synced: ReadonlyMap<string, Record<string, unknown>>,
  ): Promise<void> {
    const r = this.#host.ready();
    if (r === null || this.#sync === undefined) {
      return;
    }
    const source = new CancellationSource();
    const untrack = this.#host.trackSource(source);
    try {
      const loaded = await boundedLoad(
        this.#host,
        this.#storage,
        source,
        'load',
      );
      if (this.#host.ready() !== r) {
        return;
      }
      const matchReviews =
        loaded.ok && isPersistedState(loaded.value)
          ? loaded.value.matchReviews
          : [];
      this.emit(
        unsyncedWrites(
          { ...syncEmitInput(r), matchReviews },
          synced,
        ),
      );
      // Survivors of a ready generation swap still owe tombstones —
      // this reconcile pass is the durable retry hook.
      if (this.#reviewTombstoneIds.size > 0) {
        this.#host.own(this.emitMatchReviewTombstones([]));
      }
    } finally {
      untrack();
    }
  }

  /**
   * matchReview rows sit outside the Ready mirror — tombstoning a
   * local delete's reviews needs the persisted section, so they emit
   * off their own load like emitUnsynced. Every other dependent in
   * recordingDeleteWrites already went out with the sync emission.
   */
  async emitMatchReviewTombstones(
    deleted: readonly Recording[],
  ): Promise<void> {
    for (const rec of deleted) {
      this.#reviewTombstoneIds.add(rec.id);
    }
    const r = this.#host.ready();
    if (
      r === null ||
      this.#sync === undefined ||
      this.#reviewTombstoneIds.size === 0
    ) {
      return;
    }
    const source = new CancellationSource();
    const untrack = this.#host.trackSource(source);
    try {
      const deadlineMs = this.#host.deadline();
      // The liveness read must sit on the storage lane: a re-add whose
      // commit is still queued behind this load would otherwise slip
      // past the `live` check and get its live reviews tombstoned.
      await this.#host.enqueueStorage(async () => {
        const loaded = await boundedLoad(
          this.#host,
          this.#storage,
          source,
          'load',
          undefined,
          deadlineMs,
        );
        // A ready swap between the delete and this load would read a
        // generation's persisted view the delete wasn't staged under —
        // keep the ids queued for the next reconcile instead.
        if (this.#host.ready() !== r) {
          return ok(undefined);
        }
        if (!loaded.ok || !isPersistedState(loaded.value)) {
          this.#host.logWarn(
            'match-review tombstone load failed; ids retained for retry',
          );
          return ok(undefined);
        }
        const state = loaded.value;
        // A recording re-added between delete and load is live again —
        // its review rows belong to the live row and no longer owe a
        // tombstone.
        const live = new Set(state.recordings.map((rec) => rec.id));
        const owed = new Set<string>();
        for (const id of this.#reviewTombstoneIds) {
          if (!live.has(id)) {
            owed.add(id);
          }
        }
        this.#reviewTombstoneIds.clear();
        this.emit(
          state.matchReviews
            .filter((review) => owed.has(review.recordingId))
            .map((review) => ({
              kind: 'matchReview' as const,
              recordId: review.reviewId,
              tombstone: true as const,
            })),
        );
        return ok(undefined);
      });
    } finally {
      untrack();
    }
  }

  /**
   * Shared commit tail for the two sync-apply paths: provider
   * reconcile on remote settings, the storage commit, the section
   * mirror, and the publish. The caller owns pending-bookkeeping —
   * on failure it decides what to retain.
   */
  async #commitSyncProjection(
    r: Ready,
    batch: {
      -readonly [K in keyof StorageBatch]?: StorageBatch[K];
    },
    source: CancellationSource,
    deadlineMs: number,
  ): Promise<Result<SyncApplyReport>> {
    // Reconcile remote settings against THIS session's providers —
    // projection validates the shape only. Presence is not enough:
    // the peer's slot ids must DECLARE this build's slot capability,
    // else playback routes every op into `unsupported` (a provider
    // can exist under the id with a reduced manifest). Required slots
    // fall back to local, optional slots drop to null — mirrors
    // updateSettings.
    if (batch.settings !== undefined) {
      const s = batch.settings;
      batch.settings = {
        ...s,
        catalogProvider: this.#host.providerDeclares(s.catalogProvider, [
          'catalog.search',
        ])
          ? s.catalogProvider
          : r.settings.catalogProvider,
        playbackProvider: this.#host.providerDeclares(s.playbackProvider, [
          'playback.resolve',
        ])
          ? s.playbackProvider
          : r.settings.playbackProvider,
        lyricsProvider:
          s.lyricsProvider != null &&
            !this.#host.providerDeclares(s.lyricsProvider, [
              'lyrics.synced',
              'lyrics.plain',
            ])
            ? null
            : (s.lyricsProvider ?? null),
        radioProvider:
          s.radioProvider != null &&
            !this.#host.providerDeclares(s.radioProvider, ['radio.seed'])
            ? null
            : (s.radioProvider ?? null),
      };
    }
    const committed = await boundedCommit(
      this.#host,
      this.#storage,
      batch,
      source,
      deadlineMs,
    );
    if (!committed.ok) {
      r.persistenceError = committed.error;
      this.#host.publish();
      return err(committed.error);
    }
    if (batch.recordingsMerge !== undefined) {
      r.recordings = [...batch.recordingsMerge(r.recordings)];
    }
    if (batch.likes !== undefined) {
      r.likes = [...batch.likes];
    }
    if (batch.entities !== undefined) {
      r.entities = [...batch.entities];
    }
    if (batch.entitySourceRefs !== undefined) {
      r.entitySourceRefs = [...batch.entitySourceRefs];
    }
    if (batch.playlists !== undefined) {
      r.playlists = [...batch.playlists];
    }
    if (batch.playlistEntries !== undefined) {
      r.playlistEntries = [...batch.playlistEntries];
    }
    if (batch.playHistory !== undefined) {
      r.playHistory = [...batch.playHistory];
    }
    if (batch.playCounts !== undefined) {
      r.playCounts = [...batch.playCounts];
    }
    if (batch.lyricsCache !== undefined) {
      r.lyricsCache = [...batch.lyricsCache];
    }
    if (batch.settings !== undefined) {
      r.settings = { ...batch.settings };
    }
    if (batch.queue !== undefined) {
      r.queue = new QueueEngine(batch.queue, r.queue.unplayableIds);
      r.queueCommittedRev = Math.max(
        r.queueCommittedRev,
        batch.queue.revision,
      );
      // A queued #persistQueue holding the old engine must
      // supersede — its revision math no longer describes
      // this queue.
      r.queueEpoch += 1;
    }
    r.persistenceError = undefined;
    this.#host.derived();
    this.#host.publish();
    return ok({
      rehydrateMedia:
        batch.downloads !== undefined || batch.localFiles !== undefined,
    });
  }
}
