import type { CancellationSource } from '../cancellation.ts';
import type {
  MatchEvidence,
  QueueOccurrence,
  Recording,
  SourceMapping,
  SourceRef,
  TrackMetadata,
} from '../domain.ts';
import {
  hasExactKeys,
  isRecord,
  isTrackMetadata,
  mergeRecordingMetadata,
  recordingFromMetadata,
} from '../domain.ts';
import type { AppError } from '../errors.ts';
import { MatchingEngine } from '../matching/matching-engine.ts';
import type { RadioPage } from '../ports/provider.ts';
import type { IdPort } from '../ports/runtime.ts';
import type { QueueSnapshot } from './queue-engine.ts';

/**
 * Lazy radio growth (playback.md): the tail keeps about this many
 * occurrences buffered after the playhead; dropping below the window
 * fires the next continuation fetch. Triggers come from queue
 * transitions, never timers.
 */
export const RADIO_FETCH_AHEAD = 3;

/**
 * Defensive bound on one provider page. Real radio pages are tens of
 * items; a larger payload is a malformed response, not a queue edit.
 */
export const RADIO_PAGE_MAX_ITEMS = 128;

/**
 * Drain-chase bound: when playback runs out before an armed tail's
 * page lands and that page appended nothing (all duplicates), the
 * next continuation gets chased — but only this many hops. A provider
 * answering with an endless run of duplicate-only pages is broken; the
 * tail then sits armed and the queue stays ended.
 */
export const RADIO_DRAIN_CHASE_PAGES = 4;

/**
 * `growing` — a continuation is armed (or a fetch is in flight) and
 * more items may append. `ended` — the provider returned
 * `continuation: null`; the queue simply finishes. `failed` — a
 * continuation fetch failed; the tail stops honestly and carries the
 * typed error. There is no retry loop: a terminal tail stays
 * terminal until a new seed replaces it.
 */
export type RadioTailStatus = 'growing' | 'ended' | 'failed';

/**
 * The published radio tail; `null` in session state means no radio
 * is armed. `fetching` marks an in-flight continuation so the UI's
 * "loading more" affordance is bounded by a real request — never an
 * infinite spinner.
 */
export type RadioTail = {
  readonly seedRef: SourceRef;
  readonly providerId: string;
  readonly status: RadioTailStatus;
  readonly fetching: boolean;
  readonly error?: AppError;
};

/**
 * The session's mutable tail record. `continuation` is the armed
 * page token (`null` once the provider ends the mix); `source`
 * carries the in-flight fetch's cancellation.
 */
export type RadioTailRecord = {
  readonly seedRef: SourceRef;
  readonly providerId: string;
  continuation: string | null;
  status: RadioTailStatus;
  error: AppError | undefined;
  fetching: boolean;
  source: CancellationSource | null;
  /**
   * Playback ran out while this tail was armed: a page landing on a
   * drained (stopped, no current) queue resumes playback at the first
   * appended item — a finite queue rolls into the mix instead of
   * ending. Set at seed time when the queue is playing, and again on
   * any transport drain while the tail is armed — a seed issued
   * paused but played through earns the resume. A tail seeded on an
   * idle queue appends for later.
   */
  resumeOnDrain: boolean;
  /**
   * Consecutive pages that appended nothing while chasing a drained
   * queue — the bound for {@link RADIO_DRAIN_CHASE_PAGES}.
   */
  dupPages: number;
};

/** Projects the internal record into the published tail shape. */
export function publishRadio(record: RadioTailRecord | null): RadioTail | null {
  if (record === null) {
    return null;
  }
  const base = {
    seedRef: Object.freeze({ ...record.seedRef }),
    providerId: record.providerId,
    status: record.status,
    fetching: record.fetching,
  };
  const tail: RadioTail =
    record.error === undefined
      ? base
      : { ...base, error: Object.freeze({ ...record.error }) };
  return Object.freeze(tail);
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

/**
 * Field equality over two published tails. The source record mutates
 * in place, so reference equality can never prove an unchanged
 * projection — publish paths compare fields to reuse the last
 * published object instead.
 */
export function samePublishedRadio(
  a: RadioTail | null,
  b: RadioTail | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.providerId === b.providerId &&
    a.status === b.status &&
    a.fetching === b.fetching &&
    sameRef(a.seedRef, b.seedRef) &&
    sameError(a.error, b.error)
  );
}

/**
 * Boundary validation for a provider's `radio.seed` result: every
 * item must be well-formed track metadata and `continuation` must be
 * `null` or a nonempty string. One corrupt item fails the whole page
 * — the recordings write is atomic, all items or none.
 */
export function isRadioPage(value: unknown): value is RadioPage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['candidates', 'continuation']) &&
    Array.isArray(value['candidates']) &&
    value['candidates'].length <= RADIO_PAGE_MAX_ITEMS &&
    (value['candidates'] as unknown[]).every(isTrackMetadata) &&
    (value['continuation'] === null ||
      (typeof value['continuation'] === 'string' &&
        value['continuation'].length > 0))
  );
}

/**
 * Queue occurrences after the current one — the buffered tail the
 * fetch-ahead window measures. A stopped queue (no current) has no
 * playhead to buffer ahead of: 0. `walk` is the cursor's play order
 * — the dealt order under shuffle; omitted = canonical.
 */
export function remainingAfterCurrent(
  queue: QueueSnapshot,
  walk?: readonly string[],
): number {
  if (queue.currentOccurrenceId === null) {
    return 0;
  }
  const path = walk ?? queue.occurrences.map((o) => o.occurrenceId);
  const index = path.indexOf(queue.currentOccurrenceId);
  return index < 0 ? 0 : path.length - index - 1;
}

/**
 * The lazy-growth predicate. A fetch fires only while the tail is
 * growing, a continuation is armed, no fetch is in flight, and the
 * playhead sits inside the window. No current occurrence means no
 * consumption — a stopped queue never grows.
 */
export function shouldGrowRadio(
  record: RadioTailRecord | null,
  queue: QueueSnapshot,
  walk?: readonly string[],
): boolean {
  return (
    record !== null &&
    record.status === 'growing' &&
    record.continuation !== null &&
    !record.fetching &&
    queue.currentOccurrenceId !== null &&
    remainingAfterCurrent(queue, walk) < RADIO_FETCH_AHEAD
  );
}

function refKey(ref: SourceRef): string {
  return `${ref.provider}${ref.kind}${ref.id}`;
}

function sameRef(a: SourceRef, b: SourceRef): boolean {
  return a.provider === b.provider && a.kind === b.kind && a.id === b.id;
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

/**
 * Records the provider's own assertion that `ref` serves `recording`
 * as an `automatic` mapping, with the real scored evidence. A
 * user-confirmed same-ref winner settles the pairing and returns the
 * recording as-is; a rejected winner or a hard label conflict returns
 * null — the item is then not this recording and the caller must not
 * merge it in or enqueue under it. A similarity-floor miss without a
 * hard conflict is ordinary metadata drift: the shared ref still
 * identifies this recording, so the caller merges and enqueues but no
 * automatic mapping is written without real evidence.
 */
function withProviderMapping(
  recording: Recording,
  item: TrackMetadata,
  matchedAtMs: number,
): Recording | null {
  const ref = item.sourceRef;
  const winner = winningMapping(
    recording.mappings.filter((m) => sameRef(m.ref, ref)),
  );
  // A settled verdict decides the pairing without scoring.
  if (winner?.status === 'user-confirmed') {
    return recording;
  }
  if (winner?.status === 'rejected') {
    return null;
  }
  const scored = MatchingEngine.evidence(recording, item);
  if (scored === null) {
    return MatchingEngine.hardConflict(recording, item)
      ? null
      : recording;
  }
  const evidence: MatchEvidence = scored.evidence;
  const mapping: SourceMapping = {
    ref,
    status: 'automatic',
    matchedAtMs,
    evidence,
  };
  return {
    ...recording,
    mappings:
      winner === undefined
        ? [...recording.mappings, mapping]
        : recording.mappings.map((m) => (sameRef(m.ref, ref) ? mapping : m)),
  };
}

export type RadioPagePlan = {
  /**
   * The recordings array to persist — identical reference when no
   * item minted or touched a recording.
   */
  readonly recordings: readonly Recording[];
  /** New occurrences to enqueue at the tail, in page order. */
  readonly occurrences: readonly QueueOccurrence[];
};

/**
 * Plans one radio page against the library and queue. Cross-page
 * dedupe is the application's job (the plugin dedupes within its own
 * page): an item is skipped when its provider ref is already in the
 * queue — among queued recordings' source refs or a selected ref —
 * or when the recording it resolves to is already queued. New items
 * mint recordings via `recordingFromMetadata`; items resolving to an
 * existing recording refresh its metadata. Either way the item's ref
 * is recorded as an `automatic` mapping. Pure: the caller enqueues
 * the occurrences and persists `recordings` + `queue` in one batch.
 */
export function planRadioPage(
  recordings: readonly Recording[],
  occurrences: readonly QueueOccurrence[],
  items: readonly TrackMetadata[],
  ids: IdPort,
  playbackProvider: string,
  matchedAtMs: number,
): RadioPagePlan {
  const working = new Map<string, Recording>(
    recordings.map((rec) => [rec.id, rec]),
  );
  const recByRef = new Map<string, Recording>();
  for (const rec of recordings) {
    for (const ref of rec.sourceRefs) {
      if (!recByRef.has(refKey(ref))) {
        recByRef.set(refKey(ref), rec);
      }
    }
  }
  const queuedRefs = new Set<string>();
  const queuedRecordingIds = new Set<string>();
  for (const occurrence of occurrences) {
    if (occurrence.selectedRef !== null) {
      queuedRefs.add(refKey(occurrence.selectedRef));
    }
    queuedRecordingIds.add(occurrence.recordingId);
    const rec = working.get(occurrence.recordingId);
    if (rec !== undefined) {
      for (const ref of rec.sourceRefs) {
        queuedRefs.add(refKey(ref));
      }
    }
  }

  const appended: QueueOccurrence[] = [];
  let changed = false;
  for (const item of items) {
    const key = refKey(item.sourceRef);
    if (queuedRefs.has(key)) {
      continue;
    }
    const found = recByRef.get(key);
    if (found !== undefined && queuedRecordingIds.has(found.id)) {
      continue;
    }
    let rec: Recording;
    if (found !== undefined) {
      const current = working.get(found.id) ?? found;
      // Evidence scores against the pre-merge recording — scoring the
      // post-merge copy is tautologically perfect — and a hard-reject
      // skips the item entirely: its metadata must not overwrite the
      // stored recording nor enqueue an occurrence under it.
      const mapped = withProviderMapping(current, item, matchedAtMs);
      if (mapped === null) {
        continue;
      }
      rec = mergeRecordingMetadata(mapped, item);
    } else {
      const minted = withProviderMapping(
        recordingFromMetadata(item, ids.next('rec')),
        item,
        matchedAtMs,
      );
      if (minted === null) {
        continue;
      }
      rec = minted;
    }
    working.set(rec.id, rec);
    recByRef.set(key, rec);
    changed = true;
    appended.push({
      occurrenceId: ids.next('occ'),
      recordingId: rec.id,
      // A radio item carries its own ref; it stays directly playable
      // when the radio provider is the playback provider.
      selectedRef:
        item.sourceRef.provider === playbackProvider ? item.sourceRef : null,
    });
    queuedRecordingIds.add(rec.id);
    for (const ref of rec.sourceRefs) {
      queuedRefs.add(refKey(ref));
    }
    queuedRefs.add(key);
  }
  return {
    recordings: changed ? [...working.values()] : recordings,
    occurrences: appended,
  };
}
