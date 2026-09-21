import { isString, isSafeNonNegative } from '../domain.ts';
import type { Recording } from '../domain.ts';
import type { PlayCount, PlayEvent } from './library.ts';

/**
 * A play counts once position crosses half the duration or two
 * minutes, whichever the listener reaches first (data.md).
 */
export const PLAY_COUNT_MIN_LISTENED_MS = 120_000;
export const PLAY_COUNT_DURATION_FRACTION = 0.5;

/**
 * `play_history` retention bound in ms (~180 days, pruned on write);
 * `play_counts` aggregates are owned data and never pruned.
 */
export const PLAY_HISTORY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export const TOP_PLAYED_LIMIT = 50;

export function countsAsPlay(
  listenedMs: number,
  durationMs: number | null,
): boolean {
  if (!isSafeNonNegative(listenedMs)) {
    throw new TypeError('listenedMs must be a safe nonnegative integer');
  }
  if (durationMs !== null && !isSafeNonNegative(durationMs)) {
    throw new TypeError('durationMs must be a safe nonnegative integer or null');
  }
  if (listenedMs >= PLAY_COUNT_MIN_LISTENED_MS) {
    return true;
  }
  return (
    durationMs !== null &&
    durationMs > 0 &&
    listenedMs >= durationMs * PLAY_COUNT_DURATION_FRACTION
  );
}

export type PlaySections = {
  readonly playHistory: readonly PlayEvent[];
  readonly playCounts: readonly PlayCount[];
};

export type PlayRecord = PlaySections & {
  /** Whether this call appended an event and bumped the count. */
  readonly recorded: boolean;
};

/**
 * Records one counted play: appends the PlayEvent, upserts the
 * PlayCount (count + 1, lastMs), and prunes history past the
 * retention bound — all in the same returned sections. One play per
 * occurrenceId, ever: a repeat is a no-op, as is a listen under the
 * threshold. A null occurrenceId dedupes nothing.
 */
export function recordPlay(
  sections: PlaySections,
  input: {
    readonly eventId: string;
    readonly recordingId: string;
    readonly occurrenceId: string | null;
    readonly listenedMs: number;
    readonly durationMs: number | null;
    readonly nowMs: number;
  },
): PlayRecord {
  if (!isString(input.eventId, 64)) {
    throw new TypeError('eventId must be a nonempty id');
  }
  if (!isString(input.recordingId, 64)) {
    throw new TypeError('recordingId must be a nonempty id');
  }
  if (input.occurrenceId !== null && !isString(input.occurrenceId, 64)) {
    throw new TypeError('occurrenceId must be a nonempty id or null');
  }
  if (!isSafeNonNegative(input.nowMs)) {
    throw new TypeError('nowMs must be a safe nonnegative integer');
  }
  if (sections.playHistory.some((e) => e.eventId === input.eventId)) {
    throw new TypeError('duplicate eventId');
  }
  if (!countsAsPlay(input.listenedMs, input.durationMs)) {
    return { ...sections, recorded: false };
  }
  if (
    input.occurrenceId !== null &&
    sections.playHistory.some((e) => e.occurrenceId === input.occurrenceId)
  ) {
    return { ...sections, recorded: false };
  }
  // The observed horizon is the newest stamped event: wall-clock
  // regressions can never move it backward, so stamps and the
  // retention window both stay monotonic.
  const horizon = sections.playHistory.reduce(
    (max, e) => Math.max(max, e.playedMs),
    input.nowMs,
  );
  const event: PlayEvent = {
    eventId: input.eventId,
    recordingId: input.recordingId,
    occurrenceId: input.occurrenceId,
    playedMs: horizon,
    listenedMs: input.listenedMs,
  };
  const cutoff = horizon - PLAY_HISTORY_RETENTION_MS;
  const playHistory = [
    ...sections.playHistory.filter((e) => e.playedMs >= cutoff),
    event,
  ];
  const existing = sections.playCounts.find(
    (c) => c.recordingId === input.recordingId,
  );
  const count: PlayCount = {
    recordingId: input.recordingId,
    count: (existing?.count ?? 0) + 1,
    lastMs: Math.max(horizon, existing?.lastMs ?? 0),
  };
  const playCounts =
    existing === undefined
      ? [...sections.playCounts, count]
      : sections.playCounts.map((c) =>
        c.recordingId === input.recordingId ? count : c,
      );
  return { playHistory, playCounts, recorded: true };
}

export type TopPlayed = {
  readonly recording: Recording;
  readonly count: number;
  readonly lastMs: number;
};

/**
 * The Top 50 view: `play_counts` ranked by count desc, ties broken by
 * lastMs desc then recordingId asc, joined to their recordings.
 * Unresolvable ids are dropped rather than ranked.
 */
export function topPlayed(
  playCounts: readonly PlayCount[],
  recordings: readonly Recording[],
  limit: number = TOP_PLAYED_LIMIT,
): readonly TopPlayed[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('limit must be a positive safe integer');
  }
  const byId = new Map(recordings.map((r) => [r.id, r]));
  const ranked = [...playCounts].sort(
    (a, b) =>
      b.count - a.count ||
      b.lastMs - a.lastMs ||
      (a.recordingId < b.recordingId
        ? -1
        : a.recordingId > b.recordingId
          ? 1
          : 0),
  );
  const rows: TopPlayed[] = [];
  for (const entry of ranked) {
    if (rows.length >= limit) {
      break;
    }
    const recording = byId.get(entry.recordingId);
    if (recording !== undefined) {
      rows.push({
        recording,
        count: entry.count,
        lastMs: entry.lastMs,
      });
    }
  }
  return rows;
}
