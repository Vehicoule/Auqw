import type { Recording } from '../domain.ts';
import type { PersistedState } from '../ports/storage.ts';
import {
  countsAsPlay,
  PLAY_COUNT_DURATION_FRACTION,
  PLAY_COUNT_MIN_LISTENED_MS,
  PLAY_HISTORY_RETENTION_MS,
  recordPlay,
  topPlayed,
} from './history.ts';
import type { PlaySections } from './history.ts';
import { isPersistedState } from './library.ts';
import { assert, assertEqual } from '../testing/assert.ts';

function recording(id: string): Recording {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    durationMs: 300_000,
    releaseYear: 2020,
    artwork: [],
    explicit: null,
    genre: null,
    isrc: null,
    versionLabels: [],
    sourceRefs: [{ provider: 'itunes', kind: 'track', id: `it-${id}` }],
    mappings: [],
  };
}

function empty(): PlaySections {
  return { playHistory: [], playCounts: [] };
}

function input(
  eventId: string,
  recordingId: string,
  occurrenceId: string | null,
  listenedMs: number,
  durationMs: number | null,
  nowMs: number,
) {
  return { eventId, recordingId, occurrenceId, listenedMs, durationMs, nowMs };
}

function assertThrows(fn: () => unknown, label: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, `${label} must throw`);
}

function assertPersistable(
  sections: PlaySections,
  recordings: readonly Recording[],
): void {
  const merged: PersistedState = {
    recordings,
    likes: [],
    entities: [],
    entitySourceRefs: [],
    playlists: [],
    playlistEntries: [],
    playHistory: sections.playHistory,
    playCounts: sections.playCounts,
    matchReviews: [],
    lyricsCache: [],
    artworkCache: [],
    queue: {
      revision: 0,
      occurrences: [],
      currentOccurrenceId: null,
      positionMs: 0,
      mode: 'stopped',
    },
    settings: {
      catalogProvider: 'itunes',
      playbackProvider: 'youtube-music',
      storefront: 'US',
      qualityKbps: 256,
      theme: 'system',
      prefetch: true,
    },
  };
  assert(isPersistedState(merged), 'history sections must persist');
}

export function run(): void {
  // ---- threshold: 50% of duration or 120 s, whichever first ----
  assertEqual(
    PLAY_COUNT_MIN_LISTENED_MS,
    120_000,
    'documented 120 s bound',
  );
  assertEqual(PLAY_COUNT_DURATION_FRACTION, 0.5);
  // Short track: 50% rule binds before 120 s.
  assert(countsAsPlay(100_000, 200_000), '50% of 200 s counts');
  assert(!countsAsPlay(99_999, 200_000), 'just under 50% does not');
  // Long track: 120 s binds before 50%.
  assert(countsAsPlay(120_000, 1_000_000), '120 s counts');
  assert(!countsAsPlay(119_999, 1_000_000), '119 s does not');
  // Unknown duration: only the 120 s rule remains.
  assert(countsAsPlay(120_000, null));
  assert(!countsAsPlay(119_999, null));
  // Zero duration is not a free play.
  assert(!countsAsPlay(0, 0));
  assert(countsAsPlay(120_000, 0));
  assertThrows(() => countsAsPlay(-1, 100), 'negative listened');
  assertThrows(() => countsAsPlay(1, -1), 'negative duration');

  // ---- recordPlay: event + upsert, once per occurrence ----
  let s = recordPlay(
    empty(),
    input('ev-1', 'rA', 'occ-1', 150_000, 300_000, 1_000),
  );
  assert(s.recorded);
  assertEqual(s.playHistory.length, 1);
  assertEqual(s.playHistory[0]?.playedMs, 1_000);
  assertEqual(s.playHistory[0]?.listenedMs, 150_000);
  assertEqual(s.playCounts.length, 1);
  assertEqual(s.playCounts[0]?.count, 1);
  assertEqual(s.playCounts[0]?.lastMs, 1_000);
  assertPersistable(s, [recording('rA')]);

  // A different occurrence of the same recording counts again.
  s = recordPlay(
    s,
    input('ev-2', 'rA', 'occ-2', 150_000, 300_000, 2_000),
  );
  assert(s.recorded);
  assertEqual(s.playCounts[0]?.count, 2);
  assertEqual(s.playCounts[0]?.lastMs, 2_000);

  // The same occurrence never counts twice.
  const dup = recordPlay(
    s,
    input('ev-3', 'rA', 'occ-2', 150_000, 300_000, 3_000),
  );
  assert(!dup.recorded, 'occurrence dedupe');
  assertEqual(dup.playHistory.length, 2);
  assertEqual(dup.playCounts[0]?.count, 2);

  // Under the threshold nothing is written.
  const short = recordPlay(
    s,
    input('ev-4', 'rB', 'occ-9', 10_000, 300_000, 4_000),
  );
  assert(!short.recorded);
  assertEqual(short.playHistory.length, 2);
  assertEqual(short.playCounts.length, 1);

  // A null occurrenceId dedupes nothing.
  let n = recordPlay(
    empty(),
    input('n-1', 'rA', null, 200_000, 300_000, 10),
  );
  n = recordPlay(n, input('n-2', 'rA', null, 200_000, 300_000, 20));
  assert(n.recorded);
  assertEqual(n.playHistory.length, 2);
  assertEqual(n.playCounts[0]?.count, 2);

  assertThrows(
    () => recordPlay(s, input('ev-1', 'rA', 'occ-7', 1, null, 5)),
    'duplicate eventId',
  );

  // ---- prune on write: history bounded, counts never pruned ----
  const now = PLAY_HISTORY_RETENTION_MS + 10_000;
  const seeded: PlaySections = {
    playHistory: [
      {
        eventId: 'old-1',
        recordingId: 'rA',
        occurrenceId: 'occ-old',
        playedMs: 5_000,
        listenedMs: 200_000,
      },
    ],
    playCounts: [{ recordingId: 'rA', count: 7, lastMs: 5_000 }],
  };
  const pruned = recordPlay(
    seeded,
    input('ev-new', 'rB', 'occ-new', 200_000, 300_000, now),
  );
  assert(pruned.recorded);
  assertEqual(
    pruned.playHistory.length,
    1,
    'event older than 180 days dropped on write',
  );
  assertEqual(pruned.playHistory[0]?.eventId, 'ev-new');
  assertEqual(
    pruned.playCounts.length,
    2,
    'play_counts are never pruned',
  );
  assertEqual(
    pruned.playCounts.find((c) => c.recordingId === 'rA')?.count,
    7,
    'stale count preserved',
  );

  // ---- topPlayed: count desc, lastMs desc, recordingId asc ----
  const counts = [
    { recordingId: 'r-b', count: 5, lastMs: 100 },
    { recordingId: 'r-a', count: 5, lastMs: 100 },
    { recordingId: 'r-c', count: 5, lastMs: 200 },
    { recordingId: 'r-d', count: 9, lastMs: 1 },
    { recordingId: 'r-gone', count: 99, lastMs: 1 },
  ];
  const top = topPlayed(counts, [
    recording('r-a'),
    recording('r-b'),
    recording('r-c'),
    recording('r-d'),
  ]);
  assertDeep(
    top.map((t) => t.recording.id),
    ['r-d', 'r-c', 'r-a', 'r-b'],
    'count desc, lastMs desc, id asc; unresolved dropped',
  );
  assertEqual(top[0]?.count, 9);

  // The 50-row cap.
  const many = Array.from({ length: 60 }, (_, i) => ({
    recordingId: `r-${i}`,
    count: 1,
    lastMs: i,
  }));
  const capped = topPlayed(
    many,
    many.map((c) => recording(c.recordingId)),
  );
  assertEqual(capped.length, 50, 'top 50 bound');
  assertEqual(
    capped[0]?.recording.id,
    'r-59',
    'highest lastMs wins the count tie',
  );
  assertThrows(() => topPlayed(counts, [], 0), 'zero limit');
}

function assertDeep(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  assertEqual(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < actual.length; i += 1) {
    assertEqual(actual[i], expected[i], `${label}: index ${i}`);
  }
}
