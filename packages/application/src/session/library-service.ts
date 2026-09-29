import { CancellationSource } from '../cancellation.ts';
import type {
  CancellationSignal,
  OperationContext,
} from '../cancellation.ts';
import type { Result } from '../errors.ts';
import { appError, err, ok } from '../errors.ts';
import type {
  EntityKind,
  Like,
  Recording,
  SourceRef,
} from '../domain.ts';
import {
  isString,
  isTrackRef,
} from '../domain.ts';
import { isPersistedState } from '../library/library.ts';
import type { MatchReview } from '../library/library.ts';
import type {
  Corrections,
  ReviewFilter,
} from '../library/corrections.ts';
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
import type { ClockPort } from '../ports/clock.ts';
import type { IdPort } from '../ports/runtime.ts';
import type {
  PersistedState,
  StoragePort,
} from '../ports/storage.ts';
import type { LocalWrite } from '../sync/sync-engine.ts';
import {
  importEmissionWrites,
  recordingUpsertWrites,
  reviewSyncWrites,
} from '../sync/sync-projection.ts';
import type { Ready, SessionHostCore } from './ready.ts';
import { syncEmitInput } from './ready.ts';
import { Serializer } from './serializer.ts';
import { boundedLoad, internalError, supersededError } from './util.ts';

export type LibraryHost = SessionHostCore & {
  /**
   * A gated play attempt parked this review and left playback
   * failed — the confirm IS the retry, so resume the blocked
   * occurrence when it is the one that gated.
   */
  readonly resumeGatedPlayback: (recordingId: string) => Promise<void>;
  /**
   * Import prelude: release the active attempt (its recording rows
   * are about to be replaced), cancel pending successor mapping, and
   * disarm the radio tail before the swap.
   */
  readonly prepareImport: () => Promise<void>;
  /**
   * Flip the generation inside the import segment: drop the mirror
   * and mark the session unhydrated so a queued writer supersedes
   * instead of committing old-generation sections.
   */
  readonly swapReady: () => void;
  /** Rehydrate from the replaced rows — always a fresh load. */
  readonly restore: () => Promise<Result<void>>;
};

export type LibraryServiceDeps = {
  readonly storage: StoragePort;
  readonly ids: IdPort;
  readonly clock: ClockPort;
  readonly corrections: Corrections;
  readonly host: LibraryHost;
};

function playlistSections(r: Ready): PlaylistState {
  return { playlists: r.playlists, entries: r.playlistEntries };
}

/**
 * The library-owned writes: playlist CRUD, track/entity likes,
 * match-review ops, and library export/import. Each op keeps its own
 * serialization lane (like Serializers share the storage lane through
 * `host.enqueueStorage`/`host.persist`); Session stays the facade and
 * keeps every other domain.
 */
export class LibraryService {
  readonly #storage: StoragePort;
  readonly #ids: IdPort;
  readonly #clock: ClockPort;
  readonly #corrections: Corrections;
  readonly #host: LibraryHost;
  readonly #likeSerial = new Serializer();
  readonly #playlistSerial = new Serializer();

  constructor(deps: LibraryServiceDeps) {
    this.#storage = deps.storage;
    this.#ids = deps.ids;
    this.#clock = deps.clock;
    this.#corrections = deps.corrections;
    this.#host = deps.host;
  }

  toggleLike(recordingId: string): Promise<Result<void>> {
    // Compute each replacement from the previous committed like set.
    const work = this.#likeSerial.run(() => this.#toggleLike(recordingId));
    this.#host.own(work);
    return work;
  }

  async #toggleLike(recordingId: string): Promise<Result<void>> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (!r.recordings.some((rec) => rec.id === recordingId)) {
      return err(appError('not-found', 'unknown recording'));
    }
    const now = this.#host.safeNow();
    if (now === null) {
      return err(internalError());
    }
    return this.#persistLikes(r, toggleTrackLike(r.likes, recordingId, now));
  }

  toggleEntityLike(
    kind: EntityKind,
    entityId: string,
  ): Promise<Result<void>> {
    const work = this.#likeSerial.run(() =>
      this.#toggleEntityLike(kind, entityId),
    );
    this.#host.own(work);
    return work;
  }

  async #toggleEntityLike(
    kind: EntityKind,
    entityId: string,
  ): Promise<Result<void>> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (
      !r.entities.some((e) => e.entityId === entityId && e.kind === kind)
    ) {
      return err(appError('not-found', 'unknown entity'));
    }
    const now = this.#host.safeNow();
    if (now === null) {
      return err(internalError());
    }
    return this.#persistLikes(
      r,
      toggleEntityLike(r.likes, kind, entityId, now),
    );
  }

  /** Commit-first like write: persist, then mirror and publish. */
  async #persistLikes(
    r: Ready,
    next: readonly Like[],
  ): Promise<Result<void>> {
    const persisted = await this.#host.persist({ likes: next });
    if (!persisted.ok) {
      // Commit-first semantics: the in-memory like set is unchanged.
      return err(persisted.error);
    }
    r.likes = [...next];
    this.#host.publish();
    return ok(undefined);
  }

  /** Commits both playlist sections atomically, then mirrors them. */
  async #commitPlaylists(
    r: Ready,
    next: PlaylistState,
  ): Promise<Result<void>> {
    const persisted = await this.#host.persist({
      playlists: next.playlists,
      playlistEntries: next.entries,
    });
    if (!persisted.ok) {
      return err(persisted.error);
    }
    r.playlists = [...next.playlists];
    r.playlistEntries = [...next.entries];
    this.#host.publish();
    return ok(undefined);
  }

  #enqueuePlaylistOp<T>(
    fn: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const work = this.#playlistSerial.run(fn);
    this.#host.own(work);
    return work;
  }

  createPlaylist(name: string): Promise<Result<string>> {
    return this.#enqueuePlaylistOp(() => this.#createPlaylist(name));
  }

  async #createPlaylist(name: string): Promise<Result<string>> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (!isString(name, 512) || name.trim().length === 0) {
      return err(appError('invalid-response', 'invalid playlist name'));
    }
    const now = this.#host.safeNow();
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
    const ready = this.#host.requireReady();
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
    const now = this.#host.safeNow();
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
    const ready = this.#host.requireReady();
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
    const ready = this.#host.requireReady();
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
    const now = this.#host.safeNow();
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
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (!r.playlistEntries.some((e) => e.entryId === entryId)) {
      return err(appError('not-found', 'unknown entry'));
    }
    const now = this.#host.safeNow();
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
    const ready = this.#host.requireReady();
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
    const now = this.#host.safeNow();
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

  // ---- corrections ----------------------------------------------------

  listMatchReviews(
    filter?: ReviewFilter,
    context?: OperationContext,
  ): Promise<Result<readonly MatchReview[]>> {
    const ready = this.#host.requireReady();
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
    ).then(async (result) => {
      // A gated play attempt parked this review and left playback
      // failed — the confirm IS the retry, so resume the blocked
      // occurrence when it is the one that gated. A retry failure
      // lands as the new playback error; the confirm stays a success.
      if (result.ok) {
        await this.#host.resumeGatedPlayback(result.value.recordingId);
      }
      return result;
    });
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
   * matchReviews atomically, then the affected recording is read
   * back so the projected queue follows the verdict. The read-back
   * merges into in-memory recordings rather than replacing them — a
   * concurrent mutation on another lane can be newer than the
   * reload. A read-back failure flags persistenceError like a persist
   * does — the verdict still landed.
   */
  #reviewOp(
    op: (signal?: CancellationSignal) => Promise<Result<MatchReview>>,
    context?: OperationContext,
  ): Promise<Result<MatchReview>> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return Promise.resolve(err(ready.error));
    }
    const r = ready.value;
    // The whole review op — corrections' load->mutate->commit, the
    // reload, and the mirror merge — is a single segment on the
    // storage lane: it serializes against every session commit, so a
    // verdict can never be clobbered by an interleaved recordings
    // write (and vice versa).
    const work = this.#host.enqueueStorage(async () => {
      // Queued behind an import's ready-swap, a staged review would
      // otherwise apply an old-generation verdict to the imported
      // database — same guard as a persist/commitStaged segment.
      if (this.#host.ready() !== r) {
        return err(supersededError());
      }
      const result = await op(context?.signal);
      if (!result.ok) {
        return result;
      }
      // The reload is bounded like every storage call — a hanging
      // load fails the segment instead of wedging the lane — and the
      // bound and the operation context share a single deadline.
      const reloadSource = new CancellationSource();
      const untrack = this.#host.trackSource(reloadSource);
      let reloaded: Result<PersistedState>;
      try {
        reloaded = await boundedLoad(
          this.#host,
          this.#storage,
          reloadSource,
          'reload',
          context?.signal,
        );
      } finally {
        untrack();
      }
      const affectedId = result.value.recordingId;
      const prevRec = r.recordings.find((rec) => rec.id === affectedId);
      if (reloaded.ok && isPersistedState(reloaded.value)) {
        // Merge, never replace: a concurrent recording mutation on
        // another lane may sit between its in-memory mirror and its
        // persist, so the reload can be older than memory for any
        // recording but the reviewed one. The reviewed recording
        // takes the committed version — the reload post-dates the
        // op's own commit, so it carries the verdict. Every other
        // in-memory entry wins; committed rows memory doesn't know
        // (committed by a racing op just before this load) join at
        // the tail.
        const committed = reloaded.value.recordings;
        const byId = new Map(committed.map((rec) => [rec.id, rec]));
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
        // Emit the committed recording (it carries the verdict's
        // mapping change) plus the review row — corrections commits
        // inside `op`, outside the persist diff.
        const committedRec = byId.get(affectedId);
        if (committedRec !== undefined) {
          this.#host.emitSync(recordingUpsertWrites(committedRec, prevRec));
        }
      } else {
        r.persistenceError = reloaded.ok
          ? appError('invalid-response', 'reload after review failed validation')
          : reloaded.error;
        // No recording emit here: the op already committed but the
        // committed row is unknown — stamping `prevRec` would publish
        // a known-stale mapping with a fresh stamp that wins remotely.
        // The boot-time field diff in `emitUnsynced` recovers the
        // committed row on the next reconcile.
      }
      this.#host.emitSync(reviewSyncWrites(result.value));
      this.#host.publish();
      this.#host.derived();
      return result;
    });
    this.#host.own(work);
    return work;
  }

  // ---- export / import ------------------------------------------------

  /** Serialize the owned library to export-document JSON text. */
  async exportLibrary(): Promise<Result<ExportResult>> {
    const source = new CancellationSource();
    const untrack = this.#host.trackSource(source);
    try {
      const deadlineMs = this.#host.deadline();
      const context = this.#host.newContext(
        'export',
        deadlineMs,
        source.signal,
      );
      return await this.#host.withDeadline(
        () => exportLibrary(this.#storage, this.#clock, context),
        deadlineMs,
        source,
      );
    } finally {
      untrack();
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
    const untrack = this.#host.trackSource(source);
    try {
      await this.#host.prepareImport();
      const deadlineMs = this.#host.deadline();
      const context = this.#host.newContext(
        'import',
        deadlineMs,
        source.signal,
      );
      // The whole imported owned set goes out as one emission — the
      // writes mint inside the segment against the library being
      // replaced, then flush after the swap+restore lands.
      let importWrites: LocalWrite[] = [];
      // The swap runs as a segment on the storage lane: every writer
      // queued ahead commits first and is rolled forward, and a
      // writer that staged against the old Ready and commits behind
      // the swap is superseded by the generation check in persist —
      // never stale-applied over the imported sections.
      const applied = await this.#host.enqueueStorage(async () => {
        const result = await this.#host.withDeadline(
          () => applyImport(this.#storage, preview.value.doc, context),
          deadlineMs,
          source,
        );
        // The generation flips inside the segment: the next queued
        // writer observes ready === null and supersedes instead of
        // committing old-generation sections over the imported rows.
        if (result.ok) {
          const prevReady = this.#host.ready();
          if (prevReady !== null) {
            importWrites = importEmissionWrites(
              syncEmitInput(prevReady),
              preview.value.doc,
            );
          }
          this.#host.swapReady();
        }
        return result;
      });
      if (!applied.ok) {
        return applied;
      }
      // Rehydrate from the replaced document: restore performs the
      // load path whenever the mirror is null.
      const restored = await this.#host.restore();
      if (!restored.ok) {
        return restored;
      }
      this.#host.emitSync(importWrites);
      return ok(preview.value);
    } finally {
      untrack();
    }
  }
}
