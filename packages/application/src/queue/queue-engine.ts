import type { AppError } from '../errors.ts';
import { isSourceRef } from '../domain.ts';
import type { QueueOccurrence, SourceRef } from '../domain.ts';

export type QueueMode = 'stopped' | 'paused' | 'playing';

export type QueueSnapshot = {
  readonly revision: number;
  readonly occurrences: readonly QueueOccurrence[];
  readonly currentOccurrenceId: string | null;
  readonly positionMs: number;
  readonly mode: QueueMode;
  readonly blockedError?: AppError;
};

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

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

function validateOccurrence(occurrence: QueueOccurrence): void {
  if (
    typeof occurrence.occurrenceId !== 'string' ||
    occurrence.occurrenceId.length === 0
  ) {
    throw new TypeError('occurrenceId must be a nonempty string');
  }
  if (
    typeof occurrence.recordingId !== 'string' ||
    occurrence.recordingId.length === 0
  ) {
    throw new TypeError('recordingId must be a nonempty string');
  }
  if (
    occurrence.selectedRef !== null &&
    !isSourceRef(occurrence.selectedRef)
  ) {
    throw new TypeError('selectedRef must be null or a valid SourceRef');
  }
}

function sameError(a: AppError | undefined, b: AppError | undefined): boolean {
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

function sameRef(a: SourceRef | null, b: SourceRef | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.provider === b.provider && a.kind === b.kind && a.id === b.id;
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

  constructor(initial?: QueueSnapshot) {
    const occurrences = initial?.occurrences ?? [];
    const revision = initial?.revision ?? 0;
    const currentId = initial?.currentOccurrenceId ?? null;
    const positionMs = initial?.positionMs ?? 0;
    const mode = initial?.mode ?? 'stopped';
    const blockedError = initial?.blockedError;

    if (!isSafeNonNegative(revision)) {
      throw new TypeError('revision must be a safe nonnegative integer');
    }
    if (!isSafeNonNegative(positionMs)) {
      throw new TypeError('positionMs must be a safe nonnegative integer');
    }
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

    this.#revision = revision;
    this.#occurrences = occurrences.map(cloneOccurrence);
    this.#currentId = currentId;
    this.#positionMs = positionMs;
    this.#mode = mode;
    this.#blockedError = cloneError(blockedError);
  }

  snapshot(): QueueSnapshot {
    const base = {
      revision: this.#revision,
      occurrences: Object.freeze(
        this.#occurrences.map(cloneOccurrence),
      ),
      currentOccurrenceId: this.#currentId,
      positionMs: this.#positionMs,
      mode: this.#mode,
    };
    const snap: QueueSnapshot =
      this.#blockedError === undefined
        ? base
        : { ...base, blockedError: this.#blockedError };
    return Object.freeze(snap);
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
    const at =
      index === undefined
        ? this.#occurrences.length
        : Math.max(0, Math.min(index, this.#occurrences.length));
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
    this.#currentId = id;
    this.#positionMs = 0;
    this.#mode = mode;
    this.#blockedError = undefined;
    this.#tick();
  }

  next(): void {
    // A null current means the queue ended (or never started):
    // next() is a no-op — it never wraps.
    if (this.#currentId === null) {
      return;
    }
    this.#requireTick();
    const index = this.#indexOf(this.#currentId);
    const nextIndex = index + 1;
    if (nextIndex >= this.#occurrences.length) {
      this.#currentId = null;
      this.#positionMs = 0;
      this.#mode = 'stopped';
      this.#blockedError = undefined;
      this.#tick();
      return;
    }
    const next = this.#occurrences[nextIndex];
    if (next === undefined) {
      return;
    }
    this.#currentId = next.occurrenceId;
    this.#positionMs = 0;
    this.#mode = this.#mode === 'playing' ? 'playing' : 'paused';
    this.#blockedError = undefined;
    this.#tick();
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
    this.#currentId = null;
    this.#positionMs = 0;
    this.#mode = 'stopped';
    this.#blockedError = undefined;
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
    if (this.#positionMs > 3000) {
      this.#requireTick();
      this.#positionMs = 0;
      this.#tick();
      return;
    }
    if (index === 0) {
      // At the first occurrence with position 0: a true no-op.
      if (this.#positionMs === 0) {
        return;
      }
      this.#requireTick();
      this.#positionMs = 0;
      this.#tick();
      return;
    }
    this.#requireTick();
    const prev = this.#occurrences[index - 1];
    if (prev !== undefined) {
      this.#currentId = prev.occurrenceId;
    }
    this.#positionMs = 0;
    this.#tick();
  }

  remove(id: string): void {
    const index = this.#requireIndex(id);
    this.#requireTick();
    const wasCurrent = this.#currentId === id;
    this.#occurrences.splice(index, 1);
    if (wasCurrent) {
      this.#blockedError = undefined;
      const successor = this.#occurrences[index];
      if (successor === undefined) {
        this.#currentId = null;
        this.#positionMs = 0;
        this.#mode = 'stopped';
      } else {
        this.#currentId = successor.occurrenceId;
        this.#positionMs = 0;
        this.#mode = this.#mode === 'playing' ? 'playing' : 'paused';
      }
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
    // play() on a blocked item is the explicit Retry action.
    this.#requireTick();
    this.#blockedError = undefined;
    this.#mode = 'playing';
    this.#tick();
  }

  pause(): void {
    if (this.#mode !== 'playing') {
      return;
    }
    this.#requireTick();
    this.#mode = 'paused';
    this.#tick();
  }

  /**
   * Observed player position: updates the snapshot without a revision
   * tick — intent revision does not move for high-frequency ticks.
   * No current or identical position is a no-op.
   */
  observePosition(ms: number): void {
    if (!isSafeNonNegative(ms)) {
      throw new TypeError('positionMs must be a safe nonnegative integer');
    }
    if (this.#currentId === null || this.#positionMs === ms) {
      return;
    }
    this.#positionMs = ms;
  }

  /** User intent to seek: requires a current occurrence and ticks. */
  seekTo(ms: number): void {
    if (!isSafeNonNegative(ms)) {
      throw new TypeError('positionMs must be a safe nonnegative integer');
    }
    if (this.#currentId === null || this.#positionMs === ms) {
      return;
    }
    this.#requireTick();
    this.#positionMs = ms;
    this.#tick();
  }

  markUnplayable(error: AppError): void {
    if (this.#currentId === null) {
      return;
    }
    if (this.#mode === 'paused' && sameError(this.#blockedError, error)) {
      return;
    }
    this.#requireTick();
    this.#mode = 'paused';
    this.#blockedError = cloneError(error);
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
    if (!isSafeNonNegative(positionMs)) {
      throw new TypeError('positionMs must be a safe nonnegative integer');
    }
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
    this.#currentId = occurrenceId;
    this.#positionMs = position;
    this.#mode = mode;
    this.#blockedError = undefined;
    this.#tick();
  }

  restorePaused(): void {
    const mode: QueueMode = this.#currentId === null ? 'stopped' : 'paused';
    if (mode === this.#mode && this.#blockedError === undefined) {
      return;
    }
    this.#requireTick();
    this.#mode = mode;
    this.#blockedError = undefined;
    this.#tick();
  }
}
