import { CancellationSource } from '../cancellation.ts';
import type { CancellationSignal, OperationContext } from '../cancellation.ts';
import type { AppError, Result } from '../errors.ts';
import { appError, err, fromUnknown, ok } from '../errors.ts';
import type {
  MappingStatus,
  Recording,
  SourceMapping,
  SourceRef,
} from '../domain.ts';
import { MatchingEngine } from '../matching/matching-engine.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { LogPort } from '../ports/log.ts';
import type { IdPort } from '../ports/runtime.ts';
import type { StoragePort } from '../ports/storage.ts';
import { isCandidateSnapshot } from './library.ts';
import type {
  CandidateSnapshot,
  MatchReview,
  MatchReviewStatus,
} from './library.ts';

/**
 * The match-review queue: ambiguous matches parked for user
 * resolution. A confirmed or rejected review writes a mapping whose
 * verdict outranks auto-matching; undo removes exactly the mappings
 * the resolution wrote and returns the review to the queue.
 *
 * Mappings are append-only claims: a resolution never rewrites or
 * deletes a prior mapping, so the resolution record `{ref}` plus the
 * review's `resolvedMs` stamp is sufficient to undo — the mapping a
 * resolution wrote is identified by (ref, verdict status,
 * matchedAtMs === resolvedMs), and the prior claim resurfaces on
 * removal. `effectiveMapping` encodes the precedence that makes a
 * retained automatic mapping inert while a user verdict stands.
 */

export type CorrectionsDeps = {
  readonly storage: StoragePort;
  readonly ids: IdPort;
  readonly clock: ClockPort;
  readonly log: LogPort;
};

export type ReviewFilter = {
  /** Queue status to list; 'all' returns every review. Default 'pending'. */
  readonly status?: MatchReviewStatus | 'all';
};

export interface Corrections {
  /**
   * Parks a recording's ambiguous candidates for user resolution.
   * One pending review per recording: a second enqueue while one is
   * pending returns the existing review unchanged.
   */
  enqueueReview(
    recordingId: string,
    candidates: readonly CandidateSnapshot[],
    signal?: CancellationSignal,
  ): Promise<Result<MatchReview>>;
  /** The review queue for Diagnostics; pending-only by default. */
  listReviews(
    filter?: ReviewFilter,
    signal?: CancellationSignal,
  ): Promise<Result<readonly MatchReview[]>>;
  /**
   * Confirms the candidate at `candidateIndex`: appends a
   * 'user-confirmed' mapping for its ref and resolves the review.
   * Recordings and reviews commit in one batch. Source refs are
   * deliberately untouched — the verdict lives on the mapping alone,
   * so undo is an exact inverse of the resolution.
   */
  confirm(
    reviewId: string,
    candidateIndex: number,
    signal?: CancellationSignal,
  ): Promise<Result<MatchReview>>;
  /**
   * Rejects every candidate: appends a 'rejected' mapping per
   * candidate ref so auto-matching cannot silently re-pick one, and
   * resolves the review. Rejected refs are not attached as source
   * refs — the veto must not become a playable attachment.
   */
  reject(
    reviewId: string,
    signal?: CancellationSignal,
  ): Promise<Result<MatchReview>>;
  /**
   * Removes exactly the mappings the resolution wrote and returns the
   * review to 'pending': the ambiguity was never actually resolved,
   * so the review re-enters the queue rather than disappearing.
   */
  undo(
    reviewId: string,
    signal?: CancellationSignal,
  ): Promise<Result<MatchReview>>;
}

const OP_DEADLINE_MS = 15_000;
const MAX_CANDIDATES = 64;

/**
 * The ambiguous-match gate message — the typed error a play attempt
 * returns when candidates are parked for user confirmation. One
 * shared string keeps the producer and the resolve surface on the
 * same contract.
 */
export const MATCH_GATE_MESSAGE = 'match requires confirmation';

/**
 * True when an error is the match-confirmation gate — the only
 * 'unavailable' failure the review surface can resolve. Retry
 * without a verdict just fails the same way, so callers route the
 * press to the review instead of retrying.
 */
export function isMatchGate(error: AppError): boolean {
  return (
    error.kind === 'unavailable' && error.message === MATCH_GATE_MESSAGE
  );
}

/** Same conflict order as MatchingEngine's per-ref collapse. */
function statusRank(status: MappingStatus): number {
  return status === 'user-confirmed' ? 2 : status === 'rejected' ? 1 : 0;
}

function refKey(ref: SourceRef): string {
  return `${ref.provider}\u001f${ref.kind}\u001f${ref.id}`;
}

function isSafeNonNegative(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}

function saturatingAdd(a: number, b: number): number {
  const sum = a + b;
  return sum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : sum;
}

/**
 * The effective claim per ref: latest matchedAtMs wins; equal
 * timestamps rank user-confirmed > rejected > automatic.
 */
function collapseByRef(
  mappings: readonly SourceMapping[],
): Map<string, SourceMapping> {
  const byRef = new Map<string, SourceMapping>();
  for (const mapping of mappings) {
    const key = refKey(mapping.ref);
    const existing = byRef.get(key);
    if (
      existing === undefined ||
      mapping.matchedAtMs > existing.matchedAtMs ||
      (mapping.matchedAtMs === existing.matchedAtMs &&
        statusRank(mapping.status) > statusRank(existing.status))
    ) {
      byRef.set(key, mapping);
    }
  }
  return byRef;
}

/**
 * A ref stays vetoed while its effective claim is 'rejected': no
 * newer automatic mapping can surface for it because the engine
 * excludes vetoed refs from candidacy before scoring.
 */
export function isRefRejected(
  mappings: readonly SourceMapping[],
  ref: SourceRef,
): boolean {
  return collapseByRef(mappings).get(refKey(ref))?.status === 'rejected';
}

/**
 * Corrections precedence for one provider — the rule "corrections
 * outrank auto-matching" made concrete:
 *
 * 1. The latest user-confirmed mapping wins outright, however old —
 *    a newer automatic mapping never shadows a correction.
 * 2. Otherwise the latest automatic mapping whose ref is not vetoed.
 * 3. Otherwise null — the caller falls back to source refs, skipping
 *    any ref where `isRefRejected` holds.
 *
 * Refs are collapsed per-ref first, so a later rejection vetoes an
 * earlier confirmation of the same ref (the latest user verdict
 * stands).
 */
export function effectiveMapping(
  recording: Recording,
  provider: string,
): SourceMapping | null {
  let confirmed: SourceMapping | null = null;
  let automatic: SourceMapping | null = null;
  for (const mapping of collapseByRef(recording.mappings).values()) {
    if (mapping.ref.provider !== provider) {
      continue;
    }
    if (mapping.status === 'user-confirmed') {
      if (confirmed === null || mapping.matchedAtMs > confirmed.matchedAtMs) {
        confirmed = mapping;
      }
    } else if (mapping.status === 'automatic') {
      if (automatic === null || mapping.matchedAtMs > automatic.matchedAtMs) {
        automatic = mapping;
      }
    }
  }
  return confirmed ?? automatic;
}

export function createCorrections(deps: CorrectionsDeps): Corrections {
  const storage = deps.storage;
  const ids = deps.ids;
  const clock = deps.clock;
  const log = deps.log;

  // Read-modify-write over whole sections serializes: a later op
  // always observes the previous op's committed state.
  let tail: Promise<void> = Promise.resolve();
  function serialized<T>(op: () => Promise<Result<T>>): Promise<Result<T>> {
    const work = tail.then(op);
    tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  /** Defensive clock read: unsafe values never reach a context. */
  function now(): number | null {
    let value: number;
    try {
      value = clock.nowMs();
    } catch {
      return null;
    }
    return isSafeNonNegative(value) ? value : null;
  }

  function context(
    prefix: string,
    deadlineMs: number,
    signal: CancellationSignal,
  ): OperationContext {
    return { requestId: ids.next(prefix), deadlineMs, signal };
  }

  /** Port calls never throw by contract; throws map to internal. */
  async function call<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await fn();
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
  }

  /** Bounded, nonfatal, sanitized internal logging. */
  function warn(message: string): void {
    const atMs = now();
    if (atMs === null) {
      return;
    }
    void call(() => log.write({ level: 'warn', message, atMs })).then(
      () => undefined,
    );
  }

  function resolveSignal(signal: CancellationSignal | undefined): {
    signal: CancellationSignal;
    cancelled: boolean;
  } {
    if (signal !== undefined) {
      return { signal, cancelled: signal.cancelled };
    }
    const source = new CancellationSource();
    return { signal: source.signal, cancelled: false };
  }

  async function confirm(
    reviewId: string,
    candidateIndex: number,
    signal?: CancellationSignal,
  ): Promise<Result<MatchReview>> {
    if (
      typeof reviewId !== 'string' ||
      reviewId.length === 0 ||
      reviewId.length > 64 ||
      !Number.isSafeInteger(candidateIndex) ||
      candidateIndex < 0
    ) {
      return err(appError('invalid-response', 'invalid confirm arguments'));
    }
    return serialized(async () => {
      const { signal: sig, cancelled } = resolveSignal(signal);
      if (cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const at = now();
      if (at === null) {
        return err(appError('internal', 'clock returned an unsafe timestamp'));
      }
      const deadlineMs = saturatingAdd(at, OP_DEADLINE_MS);
      const loaded = await call(() =>
        storage.load(context('cor-load', deadlineMs, sig)),
      );
      if (!loaded.ok) {
        return err(loaded.error);
      }
      if (sig.cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const state = loaded.value;
      const review = state.matchReviews.find((r) => r.reviewId === reviewId);
      if (review === undefined) {
        return err(appError('not-found', 'unknown review'));
      }
      if (review.status !== 'pending') {
        return err(appError('not-applicable', 'review already resolved'));
      }
      const candidate = review.candidates[candidateIndex];
      if (candidate === undefined) {
        return err(
          appError('invalid-response', 'candidate index out of range'),
        );
      }
      const recording = state.recordings.find(
        (r) => r.id === review.recordingId,
      );
      if (recording === undefined) {
        return err(appError('not-found', 'review recording missing'));
      }
      const mapping: SourceMapping = {
        ref: candidate.ref,
        status: 'user-confirmed',
        matchedAtMs: at,
        evidence: MatchingEngine.userEvidence(recording, candidate.metadata),
      };
      const updatedRecording: Recording = {
        ...recording,
        mappings: [...recording.mappings, mapping],
      };
      const updatedReview: MatchReview = {
        ...review,
        status: 'confirmed',
        resolution: { ref: candidate.ref },
        resolvedMs: at,
      };
      const committed = await call(() =>
        storage.commit(
          {
            recordings: state.recordings.map((r) =>
              r.id === updatedRecording.id ? updatedRecording : r,
            ),
            matchReviews: state.matchReviews.map((r) =>
              r.reviewId === updatedReview.reviewId ? updatedReview : r,
            ),
          },
          context('cor-commit', deadlineMs, sig),
        ),
      );
      if (!committed.ok) {
        warn('review confirm failed to persist');
        return err(committed.error);
      }
      return ok(updatedReview);
    });
  }

  async function reject(
    reviewId: string,
    signal?: CancellationSignal,
  ): Promise<Result<MatchReview>> {
    if (
      typeof reviewId !== 'string' ||
      reviewId.length === 0 ||
      reviewId.length > 64
    ) {
      return err(appError('invalid-response', 'invalid reject arguments'));
    }
    return serialized(async () => {
      const { signal: sig, cancelled } = resolveSignal(signal);
      if (cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const at = now();
      if (at === null) {
        return err(appError('internal', 'clock returned an unsafe timestamp'));
      }
      const deadlineMs = saturatingAdd(at, OP_DEADLINE_MS);
      const loaded = await call(() =>
        storage.load(context('cor-load', deadlineMs, sig)),
      );
      if (!loaded.ok) {
        return err(loaded.error);
      }
      if (sig.cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const state = loaded.value;
      const review = state.matchReviews.find((r) => r.reviewId === reviewId);
      if (review === undefined) {
        return err(appError('not-found', 'unknown review'));
      }
      if (review.status !== 'pending') {
        return err(appError('not-applicable', 'review already resolved'));
      }
      const recording = state.recordings.find(
        (r) => r.id === review.recordingId,
      );
      if (recording === undefined) {
        return err(appError('not-found', 'review recording missing'));
      }
      // One veto per distinct candidate ref: auto-matching cannot
      // silently re-pick any of the presented options. Duplicated
      // candidates would write duplicate vetoes while undo removes
      // one per ref — dedupe keeps resolution and undo symmetric.
      const seen = new Set<string>();
      const vetoes: SourceMapping[] = [];
      for (const candidate of review.candidates) {
        const key = refKey(candidate.ref);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        vetoes.push({
          ref: candidate.ref,
          status: 'rejected' as const,
          matchedAtMs: at,
          evidence: MatchingEngine.userEvidence(recording, candidate.metadata),
        });
      }
      const updatedRecording: Recording = {
        ...recording,
        mappings: [...recording.mappings, ...vetoes],
      };
      const updatedReview: MatchReview = {
        ...review,
        status: 'rejected',
        resolution: { ref: null },
        resolvedMs: at,
      };
      const committed = await call(() =>
        storage.commit(
          {
            recordings: state.recordings.map((r) =>
              r.id === updatedRecording.id ? updatedRecording : r,
            ),
            matchReviews: state.matchReviews.map((r) =>
              r.reviewId === updatedReview.reviewId ? updatedReview : r,
            ),
          },
          context('cor-commit', deadlineMs, sig),
        ),
      );
      if (!committed.ok) {
        warn('review reject failed to persist');
        return err(committed.error);
      }
      return ok(updatedReview);
    });
  }

  async function undo(
    reviewId: string,
    signal?: CancellationSignal,
  ): Promise<Result<MatchReview>> {
    if (
      typeof reviewId !== 'string' ||
      reviewId.length === 0 ||
      reviewId.length > 64
    ) {
      return err(appError('invalid-response', 'invalid undo arguments'));
    }
    return serialized(async () => {
      const { signal: sig, cancelled } = resolveSignal(signal);
      if (cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const at = now();
      if (at === null) {
        return err(appError('internal', 'clock returned an unsafe timestamp'));
      }
      const deadlineMs = saturatingAdd(at, OP_DEADLINE_MS);
      const loaded = await call(() =>
        storage.load(context('cor-load', deadlineMs, sig)),
      );
      if (!loaded.ok) {
        return err(loaded.error);
      }
      if (sig.cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const state = loaded.value;
      const review = state.matchReviews.find((r) => r.reviewId === reviewId);
      if (review === undefined) {
        return err(appError('not-found', 'unknown review'));
      }
      if (review.status !== 'confirmed' && review.status !== 'rejected') {
        return err(
          appError('not-applicable', 'only a resolved review can undo'),
        );
      }
      const resolvedMs = review.resolvedMs;
      if (resolvedMs === null) {
        return err(
          appError('invalid-response', 'resolved review missing stamp'),
        );
      }
      const recording = state.recordings.find(
        (r) => r.id === review.recordingId,
      );
      if (recording === undefined) {
        return err(appError('not-found', 'review recording missing'));
      }
      // The mappings this resolution wrote carry (verdict status,
      // matchedAtMs === resolvedMs); a confirm's also matches
      // resolution.ref. Removing exactly one per affected ref keeps
      // an identical verdict another review wrote intact.
      const verdictStatus: MappingStatus =
        review.status === 'confirmed' ? 'user-confirmed' : 'rejected';
      const touchedRefs = new Set<string>();
      if (review.status === 'confirmed') {
        const ref = review.resolution?.ref;
        if (ref === null || ref === undefined) {
          return err(
            appError(
              'invalid-response',
              'confirmed review missing resolution record',
            ),
          );
        }
        touchedRefs.add(refKey(ref));
      } else {
        for (const candidate of review.candidates) {
          touchedRefs.add(refKey(candidate.ref));
        }
      }
      const mappings = [...recording.mappings];
      for (const key of touchedRefs) {
        const index = mappings.findIndex(
          (m) =>
            refKey(m.ref) === key &&
            m.status === verdictStatus &&
            m.matchedAtMs === resolvedMs,
        );
        if (index >= 0) {
          mappings.splice(index, 1);
        }
      }
      const updatedRecording: Recording = { ...recording, mappings };
      const updatedReview: MatchReview = {
        ...review,
        status: 'pending',
        resolution: null,
        resolvedMs: null,
      };
      const committed = await call(() =>
        storage.commit(
          {
            recordings: state.recordings.map((r) =>
              r.id === updatedRecording.id ? updatedRecording : r,
            ),
            matchReviews: state.matchReviews.map((r) =>
              r.reviewId === updatedReview.reviewId ? updatedReview : r,
            ),
          },
          context('cor-commit', deadlineMs, sig),
        ),
      );
      if (!committed.ok) {
        warn('review undo failed to persist');
        return err(committed.error);
      }
      return ok(updatedReview);
    });
  }

  async function enqueueReview(
    recordingId: string,
    candidates: readonly CandidateSnapshot[],
    signal?: CancellationSignal,
  ): Promise<Result<MatchReview>> {
    if (
      typeof recordingId !== 'string' ||
      recordingId.length === 0 ||
      recordingId.length > 64 ||
      candidates.length < 1 ||
      candidates.length > MAX_CANDIDATES ||
      !candidates.every(isCandidateSnapshot)
    ) {
      return err(appError('invalid-response', 'invalid review candidates'));
    }
    return serialized(async () => {
      const { signal: sig, cancelled } = resolveSignal(signal);
      if (cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const at = now();
      if (at === null) {
        return err(appError('internal', 'clock returned an unsafe timestamp'));
      }
      const deadlineMs = saturatingAdd(at, OP_DEADLINE_MS);
      const loaded = await call(() =>
        storage.load(context('cor-load', deadlineMs, sig)),
      );
      if (!loaded.ok) {
        return err(loaded.error);
      }
      if (sig.cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const state = loaded.value;
      if (!state.recordings.some((r) => r.id === recordingId)) {
        return err(appError('not-found', 'unknown recording'));
      }
      const existing = state.matchReviews.find(
        (r) => r.recordingId === recordingId && r.status === 'pending',
      );
      if (existing !== undefined) {
        return ok(existing);
      }
      const review: MatchReview = {
        reviewId: ids.next('review'),
        recordingId,
        candidates,
        status: 'pending',
        resolution: null,
        createdMs: at,
        resolvedMs: null,
      };
      const committed = await call(() =>
        storage.commit(
          { matchReviews: [...state.matchReviews, review] },
          context('cor-commit', deadlineMs, sig),
        ),
      );
      if (!committed.ok) {
        warn('review enqueue failed to persist');
        return err(committed.error);
      }
      return ok(review);
    });
  }

  async function listReviews(
    filter?: ReviewFilter,
    signal?: CancellationSignal,
  ): Promise<Result<readonly MatchReview[]>> {
    const status = filter?.status ?? 'pending';
    return serialized(async () => {
      const { signal: sig, cancelled } = resolveSignal(signal);
      if (cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const at = now();
      if (at === null) {
        return err(appError('internal', 'clock returned an unsafe timestamp'));
      }
      const loaded = await call(() =>
        storage.load(
          context('cor-load', saturatingAdd(at, OP_DEADLINE_MS), sig),
        ),
      );
      if (!loaded.ok) {
        return err(loaded.error);
      }
      // Oldest first: the queue drains in enqueue order.
      const reviews = loaded.value.matchReviews
        .filter((r) => status === 'all' || r.status === status)
        .sort(
          (a, b) =>
            a.createdMs - b.createdMs || a.reviewId.localeCompare(b.reviewId),
        );
      return ok(reviews);
    });
  }

  return { enqueueReview, listReviews, confirm, reject, undo };
}
