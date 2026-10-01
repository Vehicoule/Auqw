import type { AppError } from '../errors.ts';
import {
  isQueueOrigin,
  isSafeNonNegative,
  isSourceRef,
} from '../domain.ts';
import type {
  QueueOccurrence,
  QueueOrigin,
  SourceRef,
} from '../domain.ts';
import { sameRef } from '../session/util.ts';

export type QueueMode = 'stopped' | 'paused' | 'playing';

export type QueueSnapshot = {
  readonly revision: number;
  readonly occurrences: readonly QueueOccurrence[];
  readonly currentOccurrenceId: string | null;
  readonly positionMs: number;
  readonly mode: QueueMode;
  readonly blockedError?: AppError;
  /**
   * Which surface minted this queue — set on the context-switching
   * play verbs, cleared by `clear()`, kept through `clearExceptCurrent`
   * (the surviving row still belongs to that source). Absent on
   * pre-v3 snapshots and contextless plays.
   */
  readonly origin?: QueueOrigin;
};

function cloneRef(ref: SourceRef | null): SourceRef | null {
  return ref === null ? null : Object.freeze({ ...ref });
}

function cloneOccurrence(occurrence: QueueOccurrence): QueueOccurrence {
  return Object.freeze({
    occurrenceId: occurrence.occurrenceId,
    recordingId: occurrence.recordingId,
    selectedRef: cloneRef(occurrence.selectedRef),
  });
}

/**
 * `AppError` is readonly-typed but not frozen at creation; the engine
 * stores its own frozen copy so a caller mutating the object it passed
 * (or a snapshot's `blockedError`) can't reach engine state.
 */
function cloneError(error: AppError | undefined): AppError | undefined {
  return error === undefined ? undefined : Object.freeze({ ...error });
}

function cloneOrigin(
  origin: QueueOrigin | undefined,
): QueueOrigin | undefined {
  return origin === undefined ? undefined : Object.freeze({ ...origin });
}

function sameOrigin(
  a: QueueOrigin | undefined,
  b: QueueOrigin | undefined,
): boolean {
  if (a === undefined || b === undefined || a.kind !== b.kind) {
    return a === b;
  }
  switch (a.kind) {
    case 'collection':
      return a.collection === (b as typeof a).collection;
    case 'playlist':
      return (
        a.playlistId === (b as typeof a).playlistId &&
        a.name === (b as typeof a).name
      );
    case 'entity':
      return a.name === (b as typeof a).name && sameRef(a.ref, (b as typeof a).ref);
    case 'search':
      return a.query === (b as typeof a).query;
    case 'library':
      return true;
  }
}

function requireStr(value: unknown, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
}

function requirePosition(ms: number): void {
  if (!isSafeNonNegative(ms)) {
    throw new TypeError('positionMs must be a safe nonnegative integer');
  }
}

function validateOccurrence(occurrence: QueueOccurrence): void {
  requireStr(occurrence.occurrenceId, 'occurrenceId');
  requireStr(occurrence.recordingId, 'recordingId');
  if (
    occurrence.selectedRef !== null &&
    !isSourceRef(occurrence.selectedRef)
  ) {
    throw new TypeError('selectedRef must be null or a valid SourceRef');
  }
}

export function sameError(
  a: AppError | undefined,
  b: AppError | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.kind === b.kind &&
    a.message === b.message &&
    a.retryable === b.retryable &&
    a.retryAfterMs === b.retryAfterMs
  );
}

/**
 * Owns the playback queue. Snapshots are immutable; `revision`
 * identifies intent — every intent-changing command ticks exactly
 * once, true no-ops and observed positions do not tick. Ticks are
 * atomic: revision capacity is checked before any mutation. Duplicate
 * recordingIds are occurrence-based; `occurrenceId` is unique.
 */
export class QueueEngine {
  #revision: number;
  #occurrences: QueueOccurrence[];
  #currentId: string | null;
  #positionMs: number;
  #mode: QueueMode;
  #blockedError: AppError | undefined;
  #origin: QueueOrigin | undefined;
  /**
   * Occurrences that failed playback this engine lifetime —
   * `markUnplayable` flags the failed current; a fresh play intent
   * (autoplaying `select`, `play`, a playing reconcile) clears it so
   * a retry's verdict decides again; `remove` prunes it. `next()`
   * steps over flagged rows instead of parking the walk on a
   * known-dead entry; `previous()` keeps honoring backward intent.
   * Internal only — availability is a session-scoped observation.
   */
  #unplayable = new Set<string>();
  /** Frozen occurrence clones keyed to the revision they were taken at. */
  #occurrenceCache:
    | {
        readonly revision: number;
        readonly occurrences: readonly QueueOccurrence[];
      }
    | undefined;
  /** Last snapshot — (revision, positionMs) fully determines it. */
  #snapshotCache: QueueSnapshot | undefined;

  constructor(initial?: QueueSnapshot, unplayable?: ReadonlySet<string>) {
    const occurrences = initial?.occurrences ?? [];
    const revision = initial?.revision ?? 0;
    const currentId = initial?.currentOccurrenceId ?? null;
    const positionMs = initial?.positionMs ?? 0;
    const mode = initial?.mode ?? 'stopped';
    const blockedError = initial?.blockedError;
    const origin = initial?.origin;

    if (!isSafeNonNegative(revision)) {
      throw new TypeError('revision must be a safe nonnegative integer');
    }
    requirePosition(positionMs);
    if (mode !== 'stopped' && mode !== 'paused' && mode !== 'playing') {
      throw new TypeError('mode must be stopped, paused, or playing');
    }
    const ids = new Set<string>();
    for (const occurrence of occurrences) {
      validateOccurrence(occurrence);
      if (ids.has(occurrence.occurrenceId)) {
        throw new TypeError('occurrenceId values must be unique');
      }
      ids.add(occurrence.occurrenceId);
    }
    if (currentId !== null && !ids.has(currentId)) {
      throw new TypeError('currentOccurrenceId must be a member or null');
    }
    // Legal-state invariants.
    if (currentId === null) {
      if (positionMs !== 0) {
        throw new TypeError('position must be 0 without a current occurrence');
      }
      if (mode !== 'stopped') {
        throw new TypeError('mode must be stopped without a current occurrence');
      }
      if (blockedError !== undefined) {
        throw new TypeError('blockedError requires a current occurrence');
      }
    } else {
      if (mode === 'stopped') {
        throw new TypeError('a selected occurrence cannot be stopped');
      }
      if (blockedError !== undefined && mode !== 'paused') {
        throw new TypeError('blockedError requires the paused mode');
      }
    }
    if (origin !== undefined && !isQueueOrigin(origin)) {
      throw new TypeError('origin must be a valid QueueOrigin');
    }

    this.#revision = revision;
    this.#occurrences = occurrences.map(cloneOccurrence);
    this.#currentId = currentId;
    this.#positionMs = positionMs;
    this.#mode = mode;
    this.#blockedError = cloneError(blockedError);
    this.#origin = cloneOrigin(origin);
    // Carried marks are pruned to live members — a mark for an id the
    // snapshot doesn't hold would never get removed() to clean it up.
    for (const id of unplayable ?? []) {
      if (ids.has(id)) {
        this.#unplayable.add(id);
      }
    }
  }

  /**
   * Session-scoped failed marks — queue edits draft on `fork()` (or
   * pass the ids through) so a snapshot rebuild can't erase them;
   * a restore intentionally constructs without them.
   */
  get unplayableIds(): ReadonlySet<string> {
    // A snapshot — callers bank it next to `snapshot()` for rollback
    // and must not alias the live set into a stale reference.
    return new Set(this.#unplayable);
  }

  isUnplayable(occurrenceId: string): boolean {
    return this.#unplayable.has(occurrenceId);
  }

  /**
   * A mutable copy carrying the transient failed set — the snapshot
   * round-trip drops it, so draft-replacing queue edits go through
   * here rather than `new QueueEngine(snapshot())`.
   */
  fork(): QueueEngine {
    return new QueueEngine(this.snapshot(), this.#unplayable);
  }

  /** Observed playback position — the snapshot field without a clone. */
  get positionMs(): number {
    return this.#positionMs;
  }

  snapshot(): QueueSnapshot {
    const cached = this.#snapshotCache;
    if (
      cached !== undefined &&
      cached.revision === this.#revision &&
      cached.positionMs === this.#positionMs
    ) {
      return cached;
    }
    // Occurrence clones key on revision alone — position ticks rebuild
    // only the small wrapper, not the array.
    let occurrences =
      this.#occurrenceCache?.revision === this.#revision
        ? this.#occurrenceCache.occurrences
        : undefined;
    if (occurrences === undefined) {
      occurrences = Object.freeze(
        this.#occurrences.map(cloneOccurrence),
      );
      this.#occurrenceCache = {
        revision: this.#revision,
        occurrences,
      };
    }
    const snap: QueueSnapshot = {
      revision: this.#revision,
      occurrences,
      currentOccurrenceId: this.#currentId,
      positionMs: this.#positionMs,
      mode: this.#mode,
      ...(this.#blockedError === undefined
        ? {}
        : { blockedError: this.#blockedError }),
      ...(this.#origin === undefined ? {} : { origin: this.#origin }),
    };
    this.#snapshotCache = Object.freeze(snap);
    return this.#snapshotCache;
  }

  /** Atomic capacity check: must run before any mutation. */
  #requireTick(): void {
    if (this.#revision >= Number.MAX_SAFE_INTEGER) {
      throw new TypeError('revision would exceed MAX_SAFE_INTEGER');
    }
  }

  /** Increments after a mutation; #requireTick() guaranteed capacity. */
  #tick(): void {
    this.#revision += 1;
  }

  /** Cursor+mode assignment every mutating command converges on. */
  #apply(
    currentId: string | null,
    positionMs: number,
    mode: QueueMode,
  ): void {
    this.#currentId = currentId;
    this.#positionMs = positionMs;
    this.#mode = mode;
    this.#blockedError = undefined;
    this.#tick();
  }

  #indexOf(id: string): number {
    return this.#occurrences.findIndex((o) => o.occurrenceId === id);
  }

  #requireIndex(id: string): number {
    const index = this.#indexOf(id);
    if (index < 0) {
      throw new TypeError(`unknown occurrenceId: ${id}`);
    }
    return index;
  }

  enqueue(occurrence: QueueOccurrence, index?: number): void {
    validateOccurrence(occurrence);
    if (this.#indexOf(occurrence.occurrenceId) >= 0) {
      throw new TypeError('occurrenceId values must be unique');
    }
    if (index !== undefined && !Number.isSafeInteger(index)) {
      throw new TypeError('index must be a safe integer when supplied');
    }
    this.#requireTick();
    const at = Math.max(
      0,
      Math.min(index ?? this.#occurrences.length, this.#occurrences.length),
    );
    this.#occurrences.splice(at, 0, cloneOccurrence(occurrence));
    this.#tick();
  }

  select(id: string, autoplay: boolean): void {
    this.#requireIndex(id);
    const mode: QueueMode = autoplay ? 'playing' : 'paused';
    if (
      this.#currentId === id &&
      this.#positionMs === 0 &&
      this.#mode === mode &&
      this.#blockedError === undefined
    ) {
      return;
    }
    this.#requireTick();
    if (autoplay) {
      // A play-intent landing clears the failed mark — the attempt's
      // own verdict decides whether it flags again. It stays below
      // the capacity check so a rejected select can't mutate marks.
      this.#unplayable.delete(id);
    }
    this.#apply(id, 0, mode);
  }

  next(): void {
    // A null current means the queue ended (or never started):
    // next() is a no-op — it never wraps.
    if (this.#currentId === null) {
      return;
    }
    this.#requireTick();
    const index = this.#indexOf(this.#currentId);
    // Step over entries already failed this session instead of
    // parking the walk on a known-dead row; an explicit select()
    // still lands on them — a flagged row is retryable, not gone.
    const next = this.#occurrences
      .slice(index + 1)
      .find((o) => !this.#unplayable.has(o.occurrenceId));
    if (next === undefined) {
      this.#apply(null, 0, 'stopped');
      return;
    }
    this.#apply(
      next.occurrenceId,
      0,
      this.#mode === 'playing' ? 'playing' : 'paused',
    );
  }

  /**
   * Stops playback without removing the current occurrence: the queue
   * keeps its items, current clears, mode lands on 'stopped'.
   */
  stop(): void {
    if (this.#currentId === null) {
      return;
    }
    this.#requireTick();
    this.#apply(null, 0, 'stopped');
  }

  /**
   * Drops every occurrence — a play-context replacement clears the
   * slate before the new content enqueues. Marks prune with the
   * members; the queue lands on the legal empty state.
   */
  clear(): void {
    if (this.#occurrences.length === 0 && this.#currentId === null) {
      return;
    }
    this.#requireTick();
    this.#occurrences = [];
    this.#unplayable.clear();
    this.#origin = undefined;
    this.#apply(null, 0, 'stopped');
  }

  /**
   * Provenance for the queue — the context-switching play verbs set
   * it after `clear()` (which resets it); every other verb leaves it
   * alone so an enqueue or a cursor jump can't rewrite where the
   * queue "came from".
   */
  setOrigin(origin: QueueOrigin | undefined): void {
    if (sameOrigin(this.#origin, origin)) {
      return;
    }
    this.#requireTick();
    this.#origin = cloneOrigin(origin);
    this.#tick();
  }

  /**
   * Drops everything except the cursor row — a user "clear queue"
   * flushes pending items and history while playback continues.
   * A queue with no cursor is all pending, so this is `clear()` with
   * nothing kept.
   */
  clearExceptCurrent(): void {
    const currentId = this.#currentId;
    if (currentId === null) {
      this.clear();
      return;
    }
    if (this.#occurrences.length === 1) {
      return;
    }
    this.#requireTick();
    const current = this.#occurrences[this.#indexOf(currentId)];
    if (current === undefined) {
      return;
    }
    this.#occurrences = [current];
    for (const id of [...this.#unplayable]) {
      if (id !== current.occurrenceId) {
        this.#unplayable.delete(id);
      }
    }
    this.#tick();
  }

  previous(): void {
    if (this.#currentId === null) {
      return;
    }
    const index = this.#indexOf(this.#currentId);
    if (index < 0) {
      return;
    }
    // Rewind instead of stepping: live playback past 3s restarts the
    // row (a blocked row's retained position isn't progress to resume
    // from — it steps), and at the head any nonzero position rewinds.
    if (
      this.#positionMs > 0 &&
      (index === 0 ||
        (this.#positionMs > 3000 && this.#blockedError === undefined))
    ) {
      this.#requireTick();
      this.#positionMs = 0;
      this.#tick();
      return;
    }
    // At the first occurrence with position 0: a true no-op.
    if (index === 0) {
      return;
    }
    this.#requireTick();
    const prev = this.#occurrences[index - 1];
    // The cursor moved: the failed item's blocked error must not
    // misattribute to the new current occurrence.
    this.#apply(prev?.occurrenceId ?? this.#currentId, 0, this.#mode);
  }

  remove(id: string): void {
    const index = this.#requireIndex(id);
    this.#requireTick();
    const wasCurrent = this.#currentId === id;
    this.#occurrences.splice(index, 1);
    this.#unplayable.delete(id);
    if (wasCurrent) {
      const successor = this.#occurrences[index];
      this.#apply(
        successor?.occurrenceId ?? null,
        0,
        successor === undefined
          ? 'stopped'
          : this.#mode === 'playing'
            ? 'playing'
            : 'paused',
      );
      return;
    }
    this.#tick();
  }

  move(id: string, toIndex: number): void {
    const index = this.#requireIndex(id);
    if (!Number.isSafeInteger(toIndex)) {
      throw new TypeError('toIndex must be a safe integer');
    }
    const target = Math.max(
      0,
      Math.min(toIndex, this.#occurrences.length - 1),
    );
    if (target === index) {
      return;
    }
    this.#requireTick();
    const moved = this.#occurrences[index];
    if (moved === undefined) {
      return;
    }
    this.#occurrences.splice(index, 1);
    this.#occurrences.splice(target, 0, moved);
    this.#tick();
  }

  /**
   * Rewrites the canonical sequence — `order` must be a permutation
   * of the live occurrence ids. Cursor, marks, and position ride on
   * ids, so a full re-layout needs nothing else; a reorder that
   * changes nothing skips the tick like `move` does.
   */
  reorder(order: readonly string[]): void {
    if (order.length !== this.#occurrences.length) {
      throw new TypeError('reorder must cover every occurrence');
    }
    if (new Set(order).size !== order.length) {
      // Same length + known ids isn't enough — a duplicate silently
      // drops the occurrence it displaced.
      throw new TypeError('reorder must not repeat an occurrence');
    }
    const byId = new Map(
      this.#occurrences.map((o) => [o.occurrenceId, o] as const),
    );
    const next = order.map((id) => {
      const occurrence = byId.get(id);
      if (occurrence === undefined) {
        throw new TypeError('reorder carries an unknown occurrence');
      }
      return occurrence;
    });
    if (next.every((o, i) => o === this.#occurrences[i])) {
      return;
    }
    this.#requireTick();
    this.#occurrences = next.map(cloneOccurrence);
    this.#tick();
  }

  /** Replaces an occurrence's selected source ref. */
  setSelectedRef(occurrenceId: string, ref: SourceRef | null): void {
    const index = this.#requireIndex(occurrenceId);
    if (ref !== null && !isSourceRef(ref)) {
      throw new TypeError('ref must be null or a valid SourceRef');
    }
    const existing = this.#occurrences[index];
    if (existing === undefined || sameRef(existing.selectedRef, ref)) {
      return;
    }
    this.#requireTick();
    this.#occurrences[index] = cloneOccurrence({
      occurrenceId: existing.occurrenceId,
      recordingId: existing.recordingId,
      selectedRef: ref,
    });
    this.#tick();
  }

  play(): void {
    if (this.#currentId === null) {
      return;
    }
    if (this.#mode === 'playing' && this.#blockedError === undefined) {
      return;
    }
    // play() on a blocked item is the explicit Retry action — the
    // same fresh-attempt intent select(id, true) carries, so the
    // failed mark clears with it.
    this.#requireTick();
    this.#unplayable.delete(this.#currentId);
    this.#apply(this.#currentId, this.#positionMs, 'playing');
  }

  pause(): void {
    if (this.#mode !== 'playing') {
      return;
    }
    this.#requireTick();
    // 'playing' implies no blockedError, so only the mode changes.
    this.#mode = 'paused';
    this.#tick();
  }

  /**
   * Observed player position: updates the snapshot without a revision
   * tick — intent revision does not move for high-frequency ticks.
   * No current or identical position is a no-op.
   */
  observePosition(ms: number): void {
    requirePosition(ms);
    if (this.#currentId === null || this.#positionMs === ms) {
      return;
    }
    this.#positionMs = ms;
  }

  /** User intent to seek: requires a current occurrence and ticks. */
  seekTo(ms: number): void {
    requirePosition(ms);
    if (this.#currentId === null || this.#positionMs === ms) {
      return;
    }
    this.#requireTick();
    this.#positionMs = ms;
    this.#tick();
  }

  /**
   * The failed current pauses the queue and records the verdict —
   * surfaces read `blockedError` for the reason and `play()` on the
   * blocked row is the explicit retry. Unlike `markUnplayable` the
   * row is NOT flagged: weather and bookkeeping verdicts are not a
   * reason to step over a playable row forever.
   */
  markFailed(error: AppError): void {
    this.#blockCurrent(error, false);
  }

  /**
   * `markFailed` plus the forward-skip flag — for verdicts that
   * condemn the row itself (gone, unplayable, gated): `next()` and
   * the dealt walk step over it; `previous()` and an explicit
   * `select` still reach it.
   */
  markUnplayable(error: AppError): void {
    this.#blockCurrent(error, true);
  }

  #blockCurrent(error: AppError, unplayable: boolean): void {
    const id = this.#currentId;
    if (id === null) {
      return;
    }
    if (
      this.#mode === 'paused' &&
      sameError(this.#blockedError, error) &&
      (!unplayable || this.#unplayable.has(id))
    ) {
      return;
    }
    this.#requireTick();
    this.#mode = 'paused';
    this.#blockedError = cloneError(error);
    if (unplayable) {
      this.#unplayable.add(id);
    }
    this.#tick();
  }

  /**
   * Explicit intent reconciliation for a native cursor transition:
   * the service moved inside the projected revision, so the engine
   * adopts the reported state without a second prepare. Validates
   * member/position, clears any blocked error, and ticks once only
   * when state actually differs (duplicate transitions are no-ops).
   */
  reconcileNativeCurrent(
    occurrenceId: string | null,
    positionMs: number,
    playing: boolean,
  ): void {
    requirePosition(positionMs);
    if (occurrenceId !== null) {
      this.#requireIndex(occurrenceId);
    }
    const mode: QueueMode =
      occurrenceId === null ? 'stopped' : playing ? 'playing' : 'paused';
    const position = occurrenceId === null ? 0 : positionMs;
    if (
      this.#currentId === occurrenceId &&
      this.#positionMs === position &&
      this.#mode === mode &&
      this.#blockedError === undefined
    ) {
      return;
    }
    this.#requireTick();
    this.#apply(occurrenceId, position, mode);
    if (playing && occurrenceId !== null) {
      // The service reports the row playing — its failed mark is stale.
      this.#unplayable.delete(occurrenceId);
    }
  }

  restorePaused(): void {
    const mode: QueueMode = this.#currentId === null ? 'stopped' : 'paused';
    if (mode === this.#mode && this.#blockedError === undefined) {
      return;
    }
    this.#requireTick();
    this.#apply(this.#currentId, this.#positionMs, mode);
  }
}
