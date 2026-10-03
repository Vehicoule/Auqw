import {
  collectionTiles,
  dedupeRecordings,
  downloadIconState,
  entityIdForRef,
  formatClock,
  formatRemaining,
  toCollectionModel,
  toCorrectionsModel,
  toEntityModel,
  toHomeModel,
  toLibraryModel,
  pickArtworkUrl,
  toLyricsModel,
  toPlayerModel,
  toPlaylistModel,
  toQueueModel,
  toRadioModel,
  toRailCard,
  toSearchModel,
  toSearchRowModel,
  toSettingsModel,
  toTrackRowModel,
  skipPeekFor,
} from '@auqw/ui-shared';
import type {
  DownloadProgress,
  LyricsSheet,
  PlaylistEntry,
  Recording,
  SearchPage,
  SourceRef,
  TrackMetadata,
} from '@auqw/application';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import type {
  QueueModel,
  TrackRowModel,
} from '@auqw/ui-shared';
import {
  fixtureDiagnostics,
  fixtureEntities,
  fixtureEntityModel,
  fixtureEntityModelError,
  fixtureEntityModelLoading,
  fixtureEntityModelPartial,
  fixtureEntityPage,
  fixtureEntityPagePartial,
  fixtureEntitySourceRefs,
  fixtureHomeModel,
  fixtureImportPreview,
  fixtureImportPreviewModel,
  fixtureLibraryModel,
  fixtureLibraryModelEmpty,
  fixtureLikes,
  fixtureLyricsStates,
  fixtureMatchReviews,
  fixtureCorrectionsModel,
  fixtureCorrectionsModelEmpty,
  fixtureCorrectionsModelError,
  fixtureCorrectionsModelLoading,
  fixtureCorrectionsModelPending,
  fixtureNavItems,
  fixtureRadioModels,
  fixtureRadioTailFailed,
  fixtureRadioTailGrowing,
  fixtureTransferModelDone,
  fixtureTransferModelError,
  fixtureTransferModelPreview,
  fixturePlayCounts,
  fixturePlayHistory,
  fixturePlaybackBuffering,
  fixturePlaybackFailed,
  fixturePlaybackPaused,
  fixturePlaybackPlaying,
  fixturePlaylistEntries,
  fixturePlaylistModel,
  fixturePlaylistModelEmpty,
  fixturePlaylists,
  fixtureIdentity,
  fixtureQueue,
  fixtureQueueModel,
  fixtureRecordings,
  fixtureRowStates,
  fixtureSearchResults,
  fixtureSearchStates,
  fixtureSettings,
  fixtureSettingsModel,
  galleryCoverage,
} from '@auqw/ui-shared/fixtures';
import {
  DOWNLOAD_TARGETS,
  markDotProgress,
  markStrokeProgress,
  quadPath,
  morphPlayPause,
  PAUSE_LEFT,
  PAUSE_RIGHT,
  PLAY_LEFT,
  PLAY_RIGHT,
  progressPathState,
} from './motion.ts';

const VALID_ROW_STATES = new Set(['available', 'unavailable', 'error']);
const VALID_PHASES = new Set([
  'idle',
  'loading',
  'ready',
  'empty',
  'error',
  'unavailable',
]);
const VALID_MODES = new Set(['stopped', 'paused', 'playing']);

function checkTrackRowModel(row: TrackRowModel, label: string): void {
  assert(row.key.length > 0, `${label}: empty row key`);
  assert(row.title.length > 0, `${label}: empty title`);
  assert(VALID_ROW_STATES.has(row.state), `${label}: bad state ${row.state}`);
  assert(
    row.durationMs === null || (Number.isInteger(row.durationMs) && row.durationMs >= 0),
    `${label}: bad durationMs`,
  );
  assert(
    row.artworkUrl === null ||
    row.artworkUrl.startsWith('https://') ||
    row.artworkUrl.startsWith('data:image/'),
    `${label}: artwork must be https or an embedded data URI`,
  );
  if (row.state !== 'available') {
    assert(row.note !== null, `${label}: ${row.state} row must carry a note`);
  }
}

function checkQueueModel(queue: QueueModel, label: string): void {
  const ids = new Set(queue.items.map((i) => i.occurrenceId));
  assert(ids.size === queue.items.length, `${label}: duplicate occurrenceIds`);
  assert(VALID_MODES.has(queue.mode), `${label}: bad mode`);
  if (queue.currentOccurrenceId !== null) {
    assert(
      ids.has(queue.currentOccurrenceId),
      `${label}: currentOccurrenceId not in items`,
    );
  }
  const currents = queue.items.filter((i) => i.current);
  if (queue.currentOccurrenceId === null) {
    assert(currents.length === 0, `${label}: current flags without currentId`);
  } else {
    assert(currents.length === 1, `${label}: expected exactly one current`);
  }
  // Sections partition every item, non-empty, in display order
  // nowPlaying → upNext → autoplay → history; item.index is the
  // canonical slot.
  const rank = { nowPlaying: 0, upNext: 1, autoplay: 2, history: 3 };
  let prevRank = -1;
  const sectioned: string[] = [];
  for (const section of queue.sections) {
    assert(section.items.length > 0, `${label}: empty ${section.key} section`);
    assert(
      rank[section.key] > prevRank,
      `${label}: section order broke at ${section.key}`,
    );
    prevRank = rank[section.key];
    for (const item of section.items) {
      assertEqual(item.section, section.key, `${label}: section mismatch`);
      sectioned.push(item.occurrenceId);
    }
  }
  assertEqual(
    new Set(sectioned).size,
    queue.items.length,
    `${label}: sections must cover every item once`,
  );
  for (const item of queue.items) {
    checkTrackRowModel(item.row, `${label} item ${item.occurrenceId}`);
    assert(
      item.row.key === item.occurrenceId,
      `${label}: row key must be occurrenceId for stable list keys`,
    );
    assertEqual(
      queue.items[item.index]?.occurrenceId,
      item.occurrenceId,
      `${label}: item.index must be its canonical slot`,
    );
  }
}

function testFormatClock(): void {
  assertEqual(formatClock(null), '—');
  assertEqual(formatClock(-5), '—');
  assertEqual(formatClock(0), '0:00');
  assertEqual(formatClock(59_999), '0:59');
  assertEqual(formatClock(60_000), '1:00');
  assertEqual(formatClock(180_000), '3:00');
  assertEqual(formatClock(221_400), '3:41');
  assertEqual(formatClock(3_599_999), '59:59');
  assertEqual(formatClock(3_600_000), '60:00');
  assertEqual(formatRemaining(90_000, 180_000), '-1:30');
  assertEqual(formatRemaining(180_000, 180_000), '-0:00');
  assertEqual(formatRemaining(0, null), '—');
}

function testPlayPauseMorph(): void {
  const start = morphPlayPause(0);
  const end = morphPlayPause(1);
  const middle = morphPlayPause(0.5);
  assertEqual(
    quadPath(start.left),
    quadPath(PLAY_LEFT),
    'morph start must be the play triangle',
  );
  assertEqual(
    quadPath(start.right),
    quadPath(PLAY_RIGHT),
    'morph start must be the play triangle',
  );
  assertEqual(quadPath(end.left), quadPath(PAUSE_LEFT), 'morph end must be pause bars');
  assertEqual(
    quadPath(end.right),
    quadPath(PAUSE_RIGHT),
    'morph end must be pause bars',
  );
  assert(
    middle.left.xs.every((x, i) => x !== PLAY_LEFT.xs[i] && x !== PAUSE_LEFT.xs[i]),
    'morph midpoint must interpolate between play and pause',
  );
  assertEqual(
    quadPath(morphPlayPause(-1).left),
    quadPath(morphPlayPause(0).left),
    'morph input is clamped low',
  );
  assertEqual(
    quadPath(morphPlayPause(2).right),
    quadPath(morphPlayPause(1).right),
    'morph input is clamped high',
  );
}

function testProgressPathState(): void {
  const state = progressPathState(0.25, 200);
  assertEqual(state.dashLength, 200, 'the complete ring stays in the dash pattern');
  assertEqual(state.dashOffset, 150, 'offset reveals the first quarter of the path');
  assertEqual(state.opacity, 1, 'positive progress is visible');
  assertEqual(progressPathState(0, 200).opacity, 0, 'zero progress hides the arc');
  assertEqual(progressPathState(-1, 200).dashOffset, 200, 'progress is clamped low');
  assertEqual(progressPathState(2, 200).dashOffset, 0, 'progress is clamped high');
}

function testPickArtworkUrl(): void {
  assertEqual(pickArtworkUrl([]), null);
  const refs = [
    { url: 'https://a.example/60.jpg', width: 60, height: 60 },
    { url: 'https://a.example/300.jpg', width: 300, height: 300 },
    { url: 'https://a.example/1200.jpg', width: 1200, height: 1200 },
  ];
  assertEqual(pickArtworkUrl(refs, 128), 'https://a.example/300.jpg');
  assertEqual(pickArtworkUrl(refs, 60), 'https://a.example/60.jpg');
  assertEqual(pickArtworkUrl(refs, 4000), 'https://a.example/1200.jpg');
  assertEqual(
    pickArtworkUrl([{ url: 'https://a.example/x.jpg', width: null, height: null }]),
    'https://a.example/x.jpg',
  );
}

function testFixtureRecordings(): void {
  assert(fixtureRecordings.length >= 8, 'need ≥8 fixture recordings');
  const ids = new Set(fixtureRecordings.map((r) => r.id));
  assert(ids.size === fixtureRecordings.length, 'duplicate recording ids');
  for (const r of fixtureRecordings) {
    assert(r.title.length > 0, `${r.id}: empty title`);
    assert(r.sourceRefs.length >= 1, `${r.id}: needs ≥1 sourceRef`);
    const refKeys = new Set(
      r.sourceRefs.map((s) => `${s.provider} ${s.kind} ${s.id}`),
    );
    assert(refKeys.size === r.sourceRefs.length, `${r.id}: dup sourceRefs`);
    for (const a of r.artwork) {
      assert(
        a.url.startsWith('https://') || a.url.startsWith('data:image/'),
        `${r.id}: artwork must be https or an embedded data URI`,
      );
    }
  }
  assert(
    fixtureRecordings.some((r) => /[぀-ヿ一-鿿]/.test(r.title)),
    'fixtures need a CJK title',
  );
  assert(
    fixtureRecordings.some((r) => r.title.length > 60),
    'fixtures need a long title',
  );
  assert(
    fixtureRecordings.some((r) => r.artwork.length === 0),
    'fixtures need a missing-artwork track',
  );
}

function testQueueFixture(): void {
  assert(fixtureQueue.occurrences.length >= 6, 'need ≥6 occurrences');
  const ids = new Set(fixtureQueue.occurrences.map((o) => o.occurrenceId));
  assert(ids.size === fixtureQueue.occurrences.length, 'dup occurrenceIds');
  assert(
    ids.has(fixtureQueue.currentOccurrenceId ?? ''),
    'currentOccurrenceId missing',
  );
  const recIds = fixtureQueue.occurrences.map((o) => o.recordingId);
  assert(
    new Set(recIds).size < recIds.length,
    'queue fixture needs a duplicate recording occurrence',
  );
  const recIdSet = new Set(fixtureRecordings.map((r) => r.id));
  for (const o of fixtureQueue.occurrences) {
    assert(recIdSet.has(o.recordingId), `unknown recording ${o.recordingId}`);
  }
}

function testTrackRowMapper(): void {
  const rec = fixtureRecordings[0];
  assert(rec !== undefined, 'missing fixture recording');
  const row = toTrackRowModel(rec);
  assertEqual(row.key, rec.id);
  assertEqual(row.title, rec.title);
  assertEqual(row.versionLabel, rec.versionLabels.join(' · '));
  assertEqual(row.state, 'available');
  assertEqual(row.liked, false);
  const unavailable = toTrackRowModel(rec, {
    state: 'unavailable',
    note: 'unavailable',
  });
  assertEqual(unavailable.state, 'unavailable');
  assertEqual(unavailable.note, 'unavailable');
  for (const row2 of fixtureRowStates) {
    checkTrackRowModel(row2, 'fixtureRowStates');
  }
  assert(
    fixtureRowStates.some((r) => r.playing),
    'row states need a playing row',
  );
  assert(
    fixtureRowStates.some((r) => r.state === 'unavailable'),
    'row states need an unavailable row',
  );
  assert(
    fixtureRowStates.some((r) => r.state === 'error'),
    'row states need an error row',
  );
}

function testSearchRowMapper(): void {
  const first = fixtureSearchResults[0];
  assert(first !== undefined, 'missing search fixture');
  const row = toSearchRowModel(first, 0);
  assertEqual(row.title, first.title);
  assert(row.key.includes(first.sourceRef.provider), 'key carries provider');
  const keys = new Set(
    fixtureSearchResults.map((m, i) => toSearchRowModel(m, i).key),
  );
  assert(keys.size === fixtureSearchResults.length, 'search keys not unique');
}

function testPlayerMapper(): void {
  const base = {
    queue: fixtureQueue,
    recordings: fixtureRecordings,
    likes: fixtureLikes,
    repeat: 'off' as const,
    shuffleOrder: null,
  };
  assertEqual(toPlayerModel({ ...base, playback: { type: 'idle' } }), null);
  const playing = toPlayerModel({ ...base, playback: fixturePlaybackPlaying });
  assert(playing !== null, 'playing model null');
  assertEqual(playing.status, 'playing');
  assertEqual(playing.title, 'Self Aware');
  assertEqual(playing.positionMs, 97_200);
  assertEqual(playing.durationMs, 180_000);
  assertEqual(playing.liked, true);
  assertEqual(playing.canNext, true);
  assertEqual(playing.canPrevious, false);
  // repeat=all keeps both controls live at the queue boundaries —
  // the wrap edges are real moves.
  const atTail = toPlayerModel({
    ...base,
    repeat: 'all',
    playback: {
      type: 'paused' as const,
      recordingId: 'rec-noart',
      occurrenceId: 'occ-8',
      identity: fixtureIdentity,
      handle: 'handle-8',
      positionMs: 0,
      durationMs: 200_000,
    },
  });
  assert(
    atTail !== null && atTail.canNext,
    'repeat=all keeps next live at the tail',
  );
  const atHead = toPlayerModel({
    ...base,
    repeat: 'all',
    playback: fixturePlaybackPaused,
  });
  assert(
    atHead !== null && atHead.canPrevious,
    'repeat=all keeps previous live at the head',
  );
  // A lone queue item under repeat=all self-wraps — next stays live
  // as an in-place restart, matching the cursor.
  const first = fixtureQueue.occurrences[0];
  assert(first !== undefined);
  const soloQueue = {
    ...fixtureQueue,
    occurrences: [first],
    currentOccurrenceId: 'occ-1',
  };
  const solo = toPlayerModel({
    ...base,
    queue: soloQueue,
    repeat: 'all',
    playback: fixturePlaybackPaused,
  });
  assert(
    solo !== null && solo.canNext,
    'repeat=all keeps next live on a lone queue item',
  );
  const paused = toPlayerModel({ ...base, playback: fixturePlaybackPaused });
  assert(paused !== null && paused.status === 'paused', 'paused mapping');
  assertEqual(
    playing.intentPlaying,
    true,
    'playing intent follows queue mode',
  );
  // A transport pause that arrived natively (queue still 'playing')
  // must read as resumable — the tap resumes, not re-pauses.
  assertEqual(
    paused.intentPlaying,
    false,
    'transport-paused under playing queue resumes',
  );
  // Retry backoff publishes 'preparing' while queue intent stays
  // playing — the tap must still pause.
  const preparing = toPlayerModel({
    ...base,
    playback: {
      type: 'preparing',
      recordingId: 'rec-self-aware',
      occurrenceId: 'occ-1',
      identity: fixtureIdentity,
    },
  });
  assert(
    preparing !== null && preparing.intentPlaying === true,
    'backoff keeps pause intent',
  );
  const failed = toPlayerModel({ ...base, playback: fixturePlaybackFailed });
  assert(failed !== null, 'failed model null');
  assertEqual(failed.status, 'failed');
  // A failed attempt keeps the queue's 'playing' intent but has
  // nothing to pause — the affordance is a retry, not Pause.
  assertEqual(
    failed.intentPlaying,
    false,
    'failed under playing queue retries',
  );
  assert(
    failed.errorMessage !== null && failed.errorMessage.length > 0,
    'failed carries error message',
  );
  // Provider-wall recovery — the 'sign-in' CTA exists only on a
  // bot-check verdict AND a signed-out auth seam; a signed-in user or
  // a platform with no auth surface gets the plain error line.
  const wall = {
    type: 'failed' as const,
    recordingId: 'rec-roads',
    occurrenceId: 'occ-5',
    identity: fixtureIdentity,
    error: {
      kind: 'transient' as const,
      message: 'innertube: bot-check',
      retryable: true,
    },
  };
  assertEqual(
    toPlayerModel({ ...base, playback: wall, authSignedIn: false })
      ?.recovery,
    'sign-in',
  );
  assertEqual(
    toPlayerModel({ ...base, playback: wall, authSignedIn: true })
      ?.recovery,
    null,
    'signed-in must not offer sign-in',
  );
  assertEqual(
    toPlayerModel({ ...base, playback: wall })?.recovery,
    null,
    'no auth seam must not offer sign-in',
  );
  assertEqual(
    toPlayerModel({
      ...base,
      playback: {
        ...wall,
        error: {
          kind: 'transient' as const,
          message: 'socket timeout',
          retryable: true,
        },
      },
      authSignedIn: false,
    })?.recovery,
    null,
    'non-wall failures never offer sign-in',
  );
  // Bookkeeping verdicts never paint the player line: 'cancelled' is
  // a torn-down intent, 'superseded' an overtaken play — the row
  // still reads failed, but never wears interruption copy.
  for (const kind of ['cancelled', 'superseded'] as const) {
    const silent = toPlayerModel({
      ...base,
      playback: {
        type: 'failed' as const,
        recordingId: 'rec-roads',
        occurrenceId: 'occ-5',
        identity: fixtureIdentity,
        error: { kind, message: kind, retryable: false },
      },
    });
    assert(silent !== null && silent.status === 'failed');
    assertEqual(
      silent.errorMessage,
      null,
      `${kind} verdict stays off the player line`,
    );
  }
  const buffering = toPlayerModel({
    ...base,
    playback: fixturePlaybackBuffering,
  });
  assert(buffering !== null && buffering.status === 'buffering', 'buffering');
}

function testQueueMapper(): void {
  checkQueueModel(fixtureQueueModel, 'fixtureQueueModel');
  const current = fixtureQueueModel.items.find((i) => i.current);
  assert(current !== undefined, 'no current item');
  assertEqual(current.recordingId, 'rec-self-aware');
  assertEqual(current.row.playing, true);
  const unavailable = fixtureQueueModel.items.filter(
    (i) => i.row.state === 'unavailable',
  );
  assert(
    unavailable.some((i) => i.recordingId === 'rec-roads'),
    'roads must render unavailable',
  );
  const dup = fixtureQueueModel.items.filter(
    (i) => i.recordingId === 'rec-self-aware',
  );
  assertEqual(dup.length, 2, 'duplicate occurrence not preserved');
  assert(
    dup.every((i) => i.duplicate),
    'repeat occurrences must be explicit in the row model',
  );
  const sparse = toQueueModel({
    queue: {
      revision: 0,
      occurrences: [
        { occurrenceId: 'x1', recordingId: 'ghost', selectedRef: null },
      ],
      currentOccurrenceId: 'x1',
      positionMs: 0,
      mode: 'paused',
    },
    recordings: fixtureRecordings,
  });
  const ghost = sparse.items[0];
  assert(ghost !== undefined && ghost.row.state === 'unavailable');
  // Sections: current leads, pending follows, earlier entries trail.
  assertEqual(
    fixtureQueueModel.sections.map((s) => s.key).join(','),
    'nowPlaying,upNext',
    'fixture queue sections',
  );
  const mid = toQueueModel({
    queue: {
      ...fixtureQueue,
      currentOccurrenceId: 'occ-4',
      mode: 'paused',
      positionMs: 0,
    },
    recordings: fixtureRecordings,
  });
  assertEqual(
    mid.sections.map((s) => s.key).join(','),
    'nowPlaying,upNext,history',
    'a mid-queue cursor gains a history section',
  );
  assertEqual(
    mid.sections.flatMap((s) => s.items.map((i) => i.occurrenceId)).join(','),
    'occ-4,occ-5,occ-6,occ-7,occ-8,occ-1,occ-2,occ-3',
    'display order is current → pending → earlier',
  );
  const ended = toQueueModel({
    queue: {
      ...fixtureQueue,
      currentOccurrenceId: null,
      mode: 'stopped',
      positionMs: 0,
    },
    recordings: fixtureRecordings,
  });
  assert(ended.ended, 'items with no cursor is an ended queue');
  assert(
    ended.sections.every((s) => s.key === 'upNext'),
    'an ended queue lists everything as up next',
  );
  const failed = toQueueModel({
    queue: fixtureQueue,
    recordings: fixtureRecordings,
    failedOccurrenceIds: new Set(['occ-5']),
  });
  assertEqual(
    failed.items.find((i) => i.occurrenceId === 'occ-5')?.row.state,
    'error',
    'a failed occurrence marks its row',
  );
}

function testCollectionTiles(): void {
  // Tile counts mirror the collection row lists on every surface —
  // home and library can never disagree, and unresolvable ids drop
  // honestly on both.
  const downloads: DownloadProgress[] = [
    {
      downloadId: 'dl-1',
      recordingId: 'rec-dracula',
      state: 'available',
      transferredBytes: 10,
      totalBytes: 10,
    },
    {
      downloadId: 'dl-2',
      recordingId: 'rec-petit',
      state: 'requested',
      transferredBytes: 0,
      totalBytes: null,
    },
    // Unresolvable recording — dropped honestly.
    {
      downloadId: 'dl-3',
      recordingId: 'rec-ghost',
      state: 'available',
      transferredBytes: 4,
      totalBytes: 4,
    },
    // Already leaving — counts nowhere.
    {
      downloadId: 'dl-4',
      recordingId: 'rec-self-aware',
      state: 'removing',
      transferredBytes: 1,
      totalBytes: 1,
    },
  ];
  const input = {
    recordings: fixtureRecordings,
    likes: fixtureLikes,
    playlists: fixturePlaylists,
    playlistEntries: fixturePlaylistEntries,
    playHistory: fixturePlayHistory,
    playCounts: fixturePlayCounts,
    entities: fixtureEntities,
    entitySourceRefs: fixtureEntitySourceRefs,
    downloads,
  };
  const tiles = new Map(collectionTiles(input).map((c) => [c.key, c]));
  const library = toLibraryModel(input);
  const libraryTiles = new Map(library.collections.map((c) => [c.key, c]));
  for (const key of ['liked', 'downloads', 'top50', 'history'] as const) {
    assertEqual(
      tiles.get(key)?.count,
      libraryTiles.get(key)?.count,
      `${key} tile count disagrees between surfaces`,
    );
    assertEqual(
      tiles.get(key)?.count,
      library.collectionRows[key].length,
      `${key} tile count must match its row list`,
    );
  }
  assertEqual(
    tiles.get('downloads')?.count,
    2,
    'downloads tile counts kept rows only — ghost + removing dropped',
  );
  assertEqual(
    tiles.get('top50')?.count,
    fixturePlayCounts.length - 1,
    'pc-ghost counts a deleted recording — topPlayed drops it',
  );
  // An unresolvable like or play event never counts.
  const haunted = new Map(
    collectionTiles({
      ...input,
      likes: [
        ...fixtureLikes,
        { entityKind: 'track', targetId: 'rec-ghost', likedAtMs: 1 },
      ],
      playHistory: [
        ...fixturePlayHistory,
        {
          eventId: 'pev-ghost',
          recordingId: 'rec-ghost',
          occurrenceId: null,
          playedMs: 2_000_000_000_000,
          listenedMs: 60_000,
        },
      ],
    }).map((c) => [c.key, c]),
  );
  assertEqual(
    haunted.get('liked')?.count,
    tiles.get('liked')?.count,
    'a like on a missing recording counts nowhere',
  );
  assertEqual(
    haunted.get('history')?.count,
    tiles.get('history')?.count,
    'a play on a missing recording counts nowhere',
  );
}

function testLibraryAndSettings(): void {
  const trackLikes = fixtureLikes.filter((l) => l.entityKind === 'track');
  assertEqual(fixtureLibraryModel.likedCount, trackLikes.length);
  assertEqual(
    fixtureLibraryModel.collections.map((c) => c.key).join(','),
    'liked,downloads,top50,history',
    'library must keep the approved 2×2 collection anatomy',
  );
  const byKey = new Map(
    fixtureLibraryModel.collections.map((c) => [c.key, c]),
  );
  assertEqual(byKey.get('liked')?.enabled, true, 'liked tile live');
  assertEqual(
    byKey.get('downloads')?.enabled,
    true,
    'downloads tile is live in Slice 3',
  );
  assertEqual(
    byKey.get('downloads')?.count,
    0,
    'downloads tile counts stored rows, not pending',
  );
  assertEqual(byKey.get('top50')?.enabled, true, 'top 50 tile live');
  assertEqual(byKey.get('history')?.enabled, true, 'history tile live');
  assertEqual(
    byKey.get('top50')?.count,
    fixtureLibraryModel.collectionRows.top50.length,
    'top 50 tile count matches its rows',
  );
  assertEqual(
    byKey.get('history')?.count,
    fixtureLibraryModel.collectionRows.history.length,
    'history tile count matches its rows',
  );
  assertEqual(
    fixtureLibraryModel.canCreatePlaylist,
    true,
    'playlist creation is part of Slice 2',
  );
  assert(
    fixtureLibraryModel.artists.length >= 2,
    'library artists rail needs multiple artists',
  );
  assert(
    fixtureLibraryModel.recentlyAdded.length >= 2,
    'library needs recent rows',
  );
  const keys = new Set(fixtureLibraryModel.items.map((i) => i.key));
  assert(keys.size === fixtureLibraryModel.items.length, 'dup library keys');
  for (const item of fixtureLibraryModel.items) {
    assert(item.liked, 'library item not liked');
  }
  assertEqual(fixtureLibraryModelEmpty.likedCount, 0);
  assertEqual(fixtureLibraryModelEmpty.items.length, 0);
  assertEqual(fixtureLibraryModelEmpty.artists.length, 0);
  assertEqual(fixtureLibraryModelEmpty.cards.length, 0);
  assertEqual(fixtureLibraryModelEmpty.collectionRows.top50.length, 0);
  assertEqual(fixtureSettingsModel.theme, fixtureSettings.theme);
  assert(fixtureSettingsModel.rows.length >= 5, 'settings rows missing');
  const keys2 = new Set(fixtureSettingsModel.rows.map((r) => r.key));
  assert(keys2.size === fixtureSettingsModel.rows.length, 'dup settings keys');
  assertEqual(
    fixtureSettingsModel.diagnostics.attemptCount,
    fixtureDiagnostics.attemptCount,
  );
  const model = toSettingsModel(fixtureSettings, fixtureDiagnostics);
  const prefetch = model.rows.find((r) => r.key === 'prefetch');
  assert(prefetch !== undefined && prefetch.kind === 'toggle');
  const cacheRow = model.rows.find((r) => r.key === 'artworkCacheBytes');
  assert(
    cacheRow !== undefined && cacheRow.kind === 'navigation',
    'artwork cache row navigates to a budget picker',
  );
  assertEqual(cacheRow?.value, '200 mb');
  const capped = toSettingsModel(
    { ...fixtureSettings, artworkCacheBytes: 64 * 1024 * 1024 },
    fixtureDiagnostics,
  );
  assertEqual(
    capped.rows.find((r) => r.key === 'artworkCacheBytes')?.value,
    '64 mb',
  );
  // Platforms without a tag-reader surface (iOS) disable the
  // local-folder actions — they stay visible, never dead-tappable.
  const unsupported = toSettingsModel(fixtureSettings, fixtureDiagnostics, {
    localSupported: false,
    localFolderCount: 2,
    localSources: [{ sourceId: 's1', label: 'Music' }],
  });
  for (const key of ['addLocalFolder', 'rescanLocal', 'localSourceRemove:s1']) {
    const row = unsupported.rows.find((r) => r.key === key);
    assert(row !== undefined && row.enabled === false, `${key} disabled`);
  }
  assertEqual(
    unsupported.rows.find((r) => r.key === 'localSources')?.value,
    'unsupported',
  );
  const supported = toSettingsModel(fixtureSettings, fixtureDiagnostics, {
    localSupported: true,
  });
  assert(
    supported.rows.find((r) => r.key === 'addLocalFolder')?.enabled === true,
    'supported platform keeps actions live',
  );
}

function testLibraryCards(): void {
  const cards = fixtureLibraryModel.cards;
  const playlistCards = cards.filter((c) => c.kind === 'playlist');
  assertEqual(
    playlistCards.length,
    fixturePlaylists.length,
    'every playlist is a card',
  );
  const lateNight = playlistCards.find((c) => c.title === 'late night drives');
  assert(lateNight !== undefined, 'missing late night card');
  assertEqual(lateNight.playlistId, 'pl-late-night');
  assertEqual(
    lateNight.count,
    fixturePlaylistEntries.filter((e) => e.playlistId === 'pl-late-night')
      .length,
    'playlist card count = entry count',
  );
  assert(
    lateNight.artworkUrl !== null,
    'playlist card artwork comes from its first entry',
  );
  const entityCards = cards.filter((c) => c.kind !== 'playlist');
  const likedEntities = new Set(
    fixtureLikes.filter((l) => l.entityKind !== 'track').map((l) => l.targetId),
  );
  assertEqual(
    entityCards.length,
    likedEntities.size,
    'only liked entities become cards',
  );
  for (const card of entityCards) {
    assert(
      likedEntities.has(card.entityId ?? ''),
      `unliked entity surfaced as a card: ${card.title}`,
    );
  }
  const orphan = entityCards.find((c) => c.entityId === 'entity-orphan');
  assert(orphan !== undefined, 'liked orphan entity should still be a card');
  assertEqual(
    orphan.entityRef,
    null,
    'entity without a source ref must not fake an openable ref',
  );
  const deadbeat = entityCards.find((c) => c.title === 'Deadbeat');
  assert(deadbeat !== undefined && deadbeat.entityRef !== null);
  assertEqual(deadbeat.entityRef?.id, 'dz-album-deadbeat');
  const rail = fixtureLibraryModel.artists;
  const portishead = rail.find((a) => a.name === 'Portishead');
  assert(
    portishead !== undefined && portishead.entityRef !== null,
    'liked artist entity is openable in the rail',
  );
  assert(
    rail.some((a) => a.entityRef === null),
    'rail also carries derived (unopenable) artists from liked tracks',
  );
  const railNames = new Set(rail.map((a) => a.name));
  assertEqual(railNames.size, rail.length, 'dup artist rail entries');
}

function testCollections(): void {
  const top50 = toCollectionModel(fixtureLibraryModel, 'top50');
  assertEqual(top50.title, 'top 50');
  assert(top50.rows.length > 0, 'top 50 must not be empty');
  // count desc ordering, ghost count dropped.
  const counts = top50.rows.map((r) => r.badge ?? '');
  assert(
    counts.every((b) => /plays?$/.test(b)),
    'top 50 rows carry a play-count badge',
  );
  assertEqual(top50.rows[0]?.recordingId, 'rec-dracula', 'top ranked first');
  assert(
    !top50.rows.some((r) => r.recordingId === 'rec-ghost'),
    'unresolvable play counts drop honestly',
  );
  const expected = fixturePlayCounts
    .filter((c) => c.recordingId !== 'rec-ghost')
    .sort((a, b) => b.count - a.count || b.lastMs - a.lastMs)
    .map((c) => c.recordingId);
  assertDeepEqual(
    top50.rows.map((r) => r.recordingId),
    expected,
    'top 50 must follow the playCounts ranking',
  );
  const history = toCollectionModel(fixtureLibraryModel, 'history');
  const resolvableRecordingIds = new Set(
    fixtureRecordings.map((recording) => recording.id),
  );
  const distinctResolvableRecordingIds = new Set(
    fixturePlayHistory
      .filter((event) => resolvableRecordingIds.has(event.recordingId))
      .map((event) => event.recordingId),
  );
  assertEqual(
    history.rows.length,
    distinctResolvableRecordingIds.size,
    'one row per distinct resolvable recording',
  );
  const seenHistoryRecordings = new Set<string>();
  const expectedHistoryEvents = [...fixturePlayHistory]
    .sort((a, b) => b.playedMs - a.playedMs)
    .filter((event) => {
      if (
        !resolvableRecordingIds.has(event.recordingId) ||
        seenHistoryRecordings.has(event.recordingId)
      ) {
        return false;
      }
      seenHistoryRecordings.add(event.recordingId);
      return true;
    });
  assertDeepEqual(
    history.rows.map((r) => r.key),
    expectedHistoryEvents.map((event) => `hist-${event.recordingId}`),
    'history rows must be newest-first and deduplicated by recording',
  );
  const dracula = history.rows.filter((r) => r.recordingId === 'rec-dracula');
  assertEqual(
    dracula.length,
    1,
    'repeated plays collapse to one history row',
  );
  assert(
    history.rows.findIndex((row) => row.recordingId === 'rec-dracula') ===
      expectedHistoryEvents.findIndex(
        (event) => event.recordingId === 'rec-dracula',
      ),
    'repeated plays keep the position of their latest play',
  );
  assert(
    history.rows.every((row) => resolvableRecordingIds.has(row.recordingId)),
    'unresolvable play-history recordings drop',
  );
  const liked = toCollectionModel(fixtureLibraryModel, 'liked');
  assertEqual(
    liked.rows.length,
    fixtureLibraryModel.items.length,
    'liked collection mirrors the liked items',
  );
  const likedKeys = new Set(liked.rows.map((r) => r.key));
  assertEqual(likedKeys.size, liked.rows.length, 'dup liked collection keys');
  for (const row of [...top50.rows, ...history.rows, ...liked.rows]) {
    checkTrackRowModel(row.row, `collection row ${row.key}`);
  }
}

function testPlaylistModel(): void {
  const model = fixturePlaylistModel;
  assert(model !== null, 'playlist model missing');
  assertEqual(model.name, 'late night drives');
  const entries = fixturePlaylistEntries
    .filter((e) => e.playlistId === 'pl-late-night')
    .sort((a, b) => a.position - b.position);
  assertEqual(model.count, entries.length);
  assertDeepEqual(
    model.entries.map((e) => e.entryId),
    entries.map((e) => e.entryId),
    'entries must follow position order',
  );
  const keys = new Set(model.entries.map((e) => e.row.key));
  assertEqual(
    keys.size,
    model.entries.length,
    'duplicate occurrences keep entryId row keys',
  );
  const dups = model.entries.filter((e) => e.recordingId === 'rec-dracula');
  assertEqual(dups.length, 2, 'expected a duplicated recording');
  assert(
    dups.every((e) => e.duplicate),
    'duplicate occurrences must be flagged for the repeat badge',
  );
  const pinned = model.entries.find((e) => e.entryId === 'pe-3');
  assert(
    pinned !== undefined &&
    pinned.selectedRef !== null &&
    pinned.selectedRef.id === 'ytm-dracula-pinned',
    'pinned selectedRef must survive into the row model',
  );
  assert(
    model.artworkUrl !== null,
    'playlist artwork comes from its first entry',
  );
  const empty = fixturePlaylistModelEmpty;
  assert(empty !== null && empty.count === 0 && empty.entries.length === 0);
  const missing = toPlaylistModel({
    playlistId: 'pl-missing',
    playlists: fixturePlaylists,
    playlistEntries: fixturePlaylistEntries,
    recordings: fixtureRecordings,
    likes: fixtureLikes,
  });
  assertEqual(missing, null, 'unknown playlist must map to null');
  const ghosted = toPlaylistModel({
    playlistId: 'pl-late-night',
    playlists: fixturePlaylists,
    playlistEntries: [
      {
        entryId: 'pe-ghost',
        playlistId: 'pl-late-night',
        recordingId: 'rec-deleted',
        position: 0.5,
        selectedRef: null,
        addedMs: 0,
      },
      ...fixturePlaylistEntries,
    ],
    recordings: fixtureRecordings,
    likes: fixtureLikes,
  });
  const ghost = ghosted?.entries.find((e) => e.entryId === 'pe-ghost');
  assert(
    ghost !== undefined && ghost.row.state === 'unavailable',
    'dangling entries render unavailable, never fabricated',
  );
}

function testEntityModel(): void {
  const model = fixtureEntityModel;
  assertEqual(model.phase, 'ready');
  assertEqual(model.kind, 'album');
  assertEqual(model.title, 'Deadbeat');
  assertEqual(model.subtitle, 'Tame Impala');
  assertEqual(model.complete, true);
  assertEqual(model.liked, true, 'liked album shows liked state');
  assertEqual(model.canLike, true);
  assertEqual(model.hasMore, false);
  assertEqual(model.items.length, fixtureEntityPage.items.length);
  const itemKeys = new Set(model.items.map((i) => i.key));
  assertEqual(itemKeys.size, model.items.length, 'dup entity item keys');
  const partial = fixtureEntityModelPartial;
  assertEqual(partial.phase, 'ready');
  assertEqual(
    partial.complete,
    false,
    'partial pages must stay visibly flagged',
  );
  assertEqual(partial.hasMore, true, 'continuation exposes load-more');
  assertEqual(partial.liked, true, 'liked artist shows liked state');
  assertEqual(
    entityIdForRef(
      fixtureEntitySourceRefs,
      fixtureEntityPage.entity.sourceRef,
    ),
    'entity-deadbeat',
    'entity refs resolve to their materialized entity',
  );
  assertEqual(
    entityIdForRef(fixtureEntitySourceRefs, {
      provider: 'deezer',
      kind: 'album',
      id: 'unknown',
    }),
    null,
    'unknown refs resolve to null, never guessed',
  );
  const loading = fixtureEntityModelLoading;
  assertEqual(loading.phase, 'loading');
  const errored = fixtureEntityModelError;
  assertEqual(errored.phase, 'error');
  assert(errored.message !== null, 'error phase carries the typed message');
  const unlinked = toEntityModel({
    page: fixtureEntityPage,
    error: null,
    likes: fixtureLikes,
    entitySourceRefs: [],
  });
  assertEqual(unlinked.liked, false);
  assertEqual(
    unlinked.canLike,
    false,
    'a page with no materialized entity cannot fake a like target',
  );
  const refreshError = toEntityModel({
    page: fixtureEntityPagePartial,
    error: {
      kind: 'rate-limit',
      message: 'rate limited',
      retryable: true,
    },
    likes: fixtureLikes,
    entitySourceRefs: fixtureEntitySourceRefs,
  });
  assertEqual(refreshError.phase, 'ready');
  assert(
    refreshError.message !== null,
    'refresh errors surface as a flag while content stays',
  );
  assert(fixtureEntities.length >= 2, 'need entity fixtures');
}

function testPlaylistMembership(): void {
  // Catalog membership joins entry selected_refs AND the sourceRefs of
  // recordings entries hold — a catalog track saved as a recording
  // (selectedRef null) still marks its search/entity rows.
  const baseRec = fixtureRecordings[0];
  assert(baseRec !== undefined, 'need a fixture recording to spread');
  const savedRec: Recording = {
    ...baseRec,
    id: 'rec-saved',
    sourceRefs: [
      { provider: 'deezer', kind: 'track', id: 'dz-t-dracula' },
      { provider: 'deezer', kind: 'track', id: 'dz-t-nope' },
    ],
  };
  const entries: PlaylistEntry[] = [
    {
      entryId: 'pe-saved',
      playlistId: 'pl-x',
      recordingId: 'rec-saved',
      position: 1,
      selectedRef: null,
      addedMs: 0,
    },
    {
      entryId: 'pe-parked',
      playlistId: 'pl-x',
      recordingId: 'rec-parked',
      position: 2,
      selectedRef: {
        provider: 'deezer',
        kind: 'track',
        id: 'dz-t-loser',
      },
      addedMs: 0,
    },
  ];
  const model = toEntityModel({
    page: fixtureEntityPage,
    error: null,
    likes: fixtureLikes,
    playlistEntries: entries,
    recordings: [savedRec],
    entitySourceRefs: fixtureEntitySourceRefs,
  });
  const byRef = (refId: string) =>
    model.items.find((i) => i.key.startsWith(`deezer:${refId}:`));
  assert(byRef('dz-t-dracula')?.inPlaylist === true,
    'member via recording sourceRef marks the check');
  assert(byRef('dz-t-nope')?.inPlaylist === true,
    'every ref of a multi-ref member counts');
  assert(byRef('dz-t-loser')?.inPlaylist === true,
    'member via parked selectedRef marks the check');
  const empty = toEntityModel({
    page: fixtureEntityPage,
    error: null,
    likes: fixtureLikes,
    playlistEntries: [],
    recordings: [savedRec],
    entitySourceRefs: fixtureEntitySourceRefs,
  });
  assert(
    empty.items.every((i) => i.inPlaylist === false),
    'no entries — no membership',
  );
  const roadsRec: Recording = {
    ...baseRec,
    id: 'rec-roads',
    sourceRefs: [
      { provider: 'youtube-music', kind: 'track', id: 'ytm-roads' },
    ],
  };
  const search = toSearchModel(
    {
      type: 'content',
      revision: 1,
      query: 'roads',
      page: {
        items: fixtureSearchResults,
        entities: [],
        topHit: null,
        continuation: null,
        storefront: null,
      },
    },
    null,
    [
      {
        entryId: 'pe-roads',
        playlistId: 'pl-x',
        recordingId: 'rec-roads',
        position: 1,
        selectedRef: null,
        addedMs: 0,
      },
    ],
    [roadsRec],
  );
  const rowFor = (refId: string) =>
    search.results.find((r) => r.key.startsWith(`youtube-music:${refId}:`));
  assert(rowFor('ytm-roads')?.inPlaylist === true,
    'search rows join membership through recording sourceRefs');
  assert(rowFor('ytm-glory')?.inPlaylist === false,
    'non-members keep the plus');
}

function testHomeAndNav(): void {
  assert(fixtureHomeModel.recents.length >= 4, 'recents too thin');
  assert(fixtureHomeModel.suggestions.length >= 3, 'suggestions too thin');
  const cardKeys = new Set(
    [...fixtureHomeModel.recents, ...fixtureHomeModel.suggestions].map(
      (c) => c.key,
    ),
  );
  assert(
    cardKeys.size ===
    fixtureHomeModel.recents.length + fixtureHomeModel.suggestions.length,
    'dup rail card keys',
  );
  const first = fixtureRecordings[0];
  assert(first !== undefined);
  const card = toRailCard(first);
  assertEqual(card.title, first.title);
  const home = toHomeModel({
    recordings: fixtureRecordings,
    likes: fixtureLikes,
    playHistory: fixturePlayHistory,
    playback: { type: 'idle' },
    suggestions: fixtureSearchResults,
    greeting: 'good evening',
    subline: '3 liked',
  });
  assertEqual(home.greeting, 'good evening');
  assertEqual(home.subline, '3 liked');
  assertEqual(
    home.suggestions.length,
    fixtureSearchResults.length,
    'home should turn real provider results into suggestion cards',
  );
  assertEqual(
    home.suggestions[0]?.title,
    fixtureSearchResults[0]?.title,
    'suggestion card title must survive mapping',
  );
  assertEqual(fixtureNavItems.length, 4, 'nav must have 4 destinations');
  assertEqual(
    fixtureNavItems.map((i) => i.key).join(','),
    'home,explore,library,settings',
    'nav fixture must match the mobile shell contract',
  );
  assert(
    !fixtureNavItems.some((i) => i.key === 'queue'),
    'queue belongs to the Stage sheet, not the World navbar',
  );
}

function testSearchStates(): void {
  const phases: ReadonlySet<string> = new Set(
    fixtureSearchStates.map((s) => s.phase),
  );
  for (const phase of VALID_PHASES) {
    assert(phases.has(phase), `missing search phase ${phase}`);
  }
  for (const s of fixtureSearchStates) {
    if (s.phase === 'ready') {
      assert(s.results.length > 0, 'ready phase needs results');
    } else {
      assertEqual(s.results.length, 0, `${s.phase} must not carry results`);
    }
    if (s.phase === 'error' || s.phase === 'unavailable') {
      assert(s.message !== null, `${s.phase} needs a message`);
    }
  }
}

/**
 * Listings a user cannot tell apart — same song under several ids —
 * render once per surface while keeping their original page index
 * so row keys still resolve back to the pressed item's metadata.
 */
function testListingDedupe(): void {
  const meta = (id: string, title: string): TrackMetadata => ({
    sourceRef: { provider: 'youtube-music', kind: 'track', id },
    title,
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 302_000,
    releaseYear: 1994,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: 'AU',
  });
  const items: TrackMetadata[] = [
    meta('ytm-a', 'Roads'),
    meta('ytm-b', 'Roads - Topic'),
    meta('ytm-c', 'Roads (Official Video)'),
    meta('ytm-d', 'Glory Box'),
  ];
  const search = toSearchModel(
    {
      type: 'content',
      revision: 1,
      query: 'roads',
      page: {
        items,
        entities: [],
        topHit: null,
        continuation: null,
        storefront: null,
      },
    },
    null,
  );
  assertEqual(
    search.results.length,
    2,
    'three indistinguishable listings render as one row',
  );
  assertEqual(search.results[0]?.key, 'youtube-music:ytm-a:0');
  assertEqual(search.results[1]?.key, 'youtube-music:ytm-d:3');
  const entity = toEntityModel({
    page: {
      entity: {
        sourceRef: { provider: 'youtube-music', kind: 'album', id: 'dummy' },
        kind: 'album',
        title: 'Dummy',
        subtitle: 'Portishead',
        artwork: [],
        group: null,
      },
      items,
      related: [],
      complete: true,
      continuation: null,
    },
    error: null,
    likes: fixtureLikes,
    entitySourceRefs: [],
  });
  assertEqual(
    entity.items.length,
    2,
    'entity pages drop look-alike rows the same way',
  );
  // Genuinely different rows — a distinct artist — always survive.
  const searchTwo = toSearchModel(
    {
      type: 'content',
      revision: 2,
      query: 'intro',
      page: {
        items: [
          { ...meta('ytm-e', 'Intro'), artist: 'Band A' },
          { ...meta('ytm-f', 'Intro'), artist: 'Band B' },
        ],
        entities: [],
        topHit: null,
        continuation: null,
        storefront: null,
      },
    },
    null,
  );
  assertEqual(
    searchTwo.results.length,
    2,
    'same-name rows by different artists stay distinct',
  );
  // A distinct version keeps its own row — 'Roads (Live)' is not a
  // look-alike of 'Roads'.
  const searchVersions = toSearchModel(
    {
      type: 'content',
      revision: 3,
      query: 'roads',
      page: {
        items: [meta('ytm-g', 'Roads'), meta('ytm-h', 'Roads (Live)')],
        entities: [],
        topHit: null,
        continuation: null,
        storefront: null,
      },
    },
    null,
  );
  assertEqual(
    searchVersions.results.length,
    2,
    'a live cut keeps its own row next to the studio take',
  );
  // Different ISRCs are different recordings even under look-alike
  // metadata — each keeps its own row.
  const searchIsrcs = toSearchModel(
    {
      type: 'content',
      revision: 5,
      query: 'roads',
      page: {
        items: [
          { ...meta('ytm-i', 'Roads'), isrc: 'GBAAA0000001' },
          { ...meta('ytm-j', 'Roads'), isrc: 'GBAAA0000002' },
          { ...meta('ytm-k', 'Roads - Topic'), isrc: 'GBAAA0000001' },
        ],
        entities: [],
        topHit: null,
        continuation: null,
        storefront: null,
      },
    },
    null,
  );
  assertEqual(
    searchIsrcs.results.length,
    2,
    'conflicting ISRCs hold rows apart',
  );
  assertEqual(searchIsrcs.results[0]?.key, 'youtube-music:ytm-i:0');
  assertEqual(searchIsrcs.results[1]?.key, 'youtube-music:ytm-j:1');
  // Identity isn't transitive — an uncoded first listing must not
  // absorb two coded listings whose ISRCs conflict.
  const searchUncoded = toSearchModel(
    {
      type: 'content',
      revision: 6,
      query: 'roads',
      page: {
        items: [
          meta('ytm-l', 'Roads'),
          { ...meta('ytm-m', 'Roads'), isrc: 'GBAAA0000001' },
          { ...meta('ytm-n', 'Roads'), isrc: 'GBAAA0000002' },
        ],
        entities: [],
        topHit: null,
        continuation: null,
        storefront: null,
      },
    },
    null,
  );
  assertEqual(
    searchUncoded.results.length,
    2,
    'an uncoded row absorbs one coded twin, never two conflicting ones',
  );
  assertEqual(searchUncoded.results[0]?.key, 'youtube-music:ytm-l:0');
  assertEqual(searchUncoded.results[1]?.key, 'youtube-music:ytm-n:2');
  // A hidden look-alike's ref still lights the kept row — playing a
  // deduped member marks the surviving row as playing.
  const searchPlaying = toSearchModel(
    {
      type: 'content',
      revision: 4,
      query: 'roads',
      page: {
        items,
        entities: [],
        topHit: null,
        continuation: null,
        storefront: null,
      },
    },
    { provider: 'youtube-music', kind: 'track', id: 'ytm-b' },
  );
  assertEqual(
    searchPlaying.results[0]?.playing,
    true,
    "the hidden member's ref marks the kept row playing",
  );
}

/**
 * Local-search rows dedupe like provider listings: two recordings
 * the user cannot tell apart (the double-ingested same song, or two
 * copies that differ only sub-second) render once in library order,
 * the hidden row riding in `group` so its flags still light the
 * survivor. Rows that genuinely differ keep their own row.
 */
function testLocalRecordingDedupe(): void {
  const roads = fixtureRecordings.find((r) => r.id === 'rec-roads');
  const dracula = fixtureRecordings.find((r) => r.id === 'rec-dracula');
  assert(roads !== undefined && dracula !== undefined, 'need fixtures');
  const twin: Recording = { ...roads, id: 'rec-roads-copy' };
  // Sub-second duration drift still keys the same whole-second row.
  const drifted: Recording = {
    ...roads,
    id: 'rec-roads-drift',
    durationMs: (roads.durationMs ?? 0) + 400,
  };
  const groups = dedupeRecordings([roads, twin, drifted, dracula]);
  assertEqual(
    groups.length,
    2,
    'three indistinguishable local recordings collapse to one row',
  );
  assertEqual(groups[0]?.rec.id, 'rec-roads', 'first in order survives');
  assertEqual(
    groups[0]?.group.length,
    3,
    'the hidden copies ride in the group for flag merging',
  );
  assertEqual(groups[1]?.rec.id, 'rec-dracula');
  // A different artist, album, or whole-second duration splits —
  // the row displays all three, so copies that differ keep their rows.
  const longer: Recording = { ...roads, id: 'rec-roads-long', durationMs: 298_000 };
  const split = dedupeRecordings([
    roads,
    { ...roads, id: 'rec-x', artist: 'Someone Else' },
    { ...roads, id: 'rec-y', album: 'Live at Roseland' },
    longer,
  ]);
  assertEqual(split.length, 4, 'distinct identity always keeps a row');
  // The album segment is a separate field — digit albums can't fuse
  // with the trailing duration into a colliding suffix.
  const boundary = dedupeRecordings([
    { ...roads, id: 'rec-b1', durationMs: 240_000, album: '1' },
    { ...roads, id: 'rec-b2', durationMs: 24_000, album: '01' },
  ]);
  assertEqual(
    boundary.length,
    2,
    'duration/album boundary keeps distinct recordings apart',
  );
}

/**
 * The explore filter set — 'all' and 'songs' are the whole deduped
 * list today (every result is a track), 'library' keeps only rows
 * whose deduped group carries a ref the library owns. The hero is
 * always the provider's #1 result after filtering.
 */
function testSearchFilters(): void {
  const meta = (
    id: string,
    title: string,
    extra?: Partial<TrackMetadata>,
  ): TrackMetadata => ({
    sourceRef: { provider: 'youtube-music', kind: 'track', id },
    title,
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 302_000,
    releaseYear: 1994,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: null,
    ...extra,
  });
  const items: TrackMetadata[] = [
    meta('ytm-lib', 'Roads'),
    meta('ytm-lib2', 'Roads - Topic'), // deduped twin of the library row
    meta('ytm-out', 'Glory Box'),
  ];
  const baseRec = fixtureRecordings[0];
  assert(baseRec !== undefined, 'need a fixture recording to spread');
  const libraryRec: Recording = {
    ...baseRec,
    id: 'rec-lib',
    sourceRefs: [{ provider: 'youtube-music', kind: 'track', id: 'ytm-lib2' }],
  };
  const state = {
    type: 'content' as const,
    revision: 1,
    query: 'roads',
    page: {
        items,
        entities: [],
        topHit: null,
        continuation: null,
        storefront: null,
      },
  };
  // 'all' — every deduped row, hero on the first.
  const all = toSearchModel(state, null, [], [libraryRec], 'all');
  assertEqual(all.results.length, 2, 'all filter keeps the deduped list');
  assertEqual(all.filter, 'all');
  assert(all.hero !== null, 'ready-with-results earns a hero');
  assertEqual(
    all.hero?.type === 'track' ? all.hero.row.key : undefined,
    all.results[0]?.key,
    'the hero is the provider #1 result',
  );
  assert(
    all.hero?.metaLabel.includes('Portishead') === true &&
      all.hero.metaLabel.includes('1994'),
    `hero meta should read kind · artist · year — got '${all.hero?.metaLabel ?? ''}'`,
  );
  // 'songs' — the whole set too; the chip names the reserved subset.
  const songs = toSearchModel(state, null, [], [libraryRec], 'songs');
  assertEqual(songs.results.length, 2, 'songs filter keeps every track');
  // The play context mirrors the visible list — deduped reps only,
  // post-filter; the raw page's hidden twins never get materialized.
  assertEqual(all.playItems.length, 2, 'playItems follows the rows');
  assertEqual(all.playItems[0]?.sourceRef.id, 'ytm-lib');
  assertEqual(all.playItems[1]?.sourceRef.id, 'ytm-out');
  // 'library' — membership is evaluated across the deduped group: the
  // kept rep ref 'ytm-lib' is unowned but its twin 'ytm-lib2' is, so
  // the row still counts as in-library.
  const library = toSearchModel(state, null, [], [libraryRec], 'library');
  assertEqual(library.results.length, 1, 'library filter drops unowned rows');
  assertEqual(
    library.results[0]?.key,
    'youtube-music:ytm-lib:0',
    "a hidden group member's owned ref keeps the deduped row",
  );
  assert(
    library.hero?.type === 'track' &&
      library.hero.row.key === 'youtube-music:ytm-lib:0',
    'the hero re-centers on the filtered #1',
  );
  assertEqual(
    library.playItems.length,
    1,
    'the play context is the filtered list — filtered-out tracks never import',
  );
  // No library-owned matches → an honest empty result list.
  const none = toSearchModel(
    {
        ...state,
        page: {
          items: [meta('ytm-x', 'Nils Frahm')],
          entities: [],
          topHit: null,
          continuation: null,
          storefront: null,
        },
      },
    null,
    [],
    [libraryRec],
    'library',
  );
  assertEqual(none.results.length, 0, 'unowned-only results filter out');
  assert(none.hero === null, 'no results — no hero');
  // Rows carry their album for the results-table column.
  assertEqual(
    all.results[0]?.album,
    'Dummy',
    'search rows surface the album column',
  );
}

/**
 * Typed discovery: entity hits group into kind rails in canonical
 * order, the tagged top-hit picks the hero variant, kind-scoped chips
 * isolate their rail, and the entity page groups `related` into
 * shelf rails while never re-listing itself.
 */
function testDiscoveryModel(): void {
  const meta = (id: string, title: string): TrackMetadata => ({
    sourceRef: { provider: 'deezer', kind: 'track', id },
    title,
    artist: 'Portishead',
    album: 'Dummy',
    durationMs: 302_000,
    releaseYear: 1994,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: null,
  });
  const ent = (
    kind: 'artist' | 'album' | 'playlist',
    id: string,
    title: string,
    subtitle: string | null = null,
    group: 'discography' | 'related' | 'featured' | 'appears-on' | null = null,
  ) => ({
    sourceRef: { provider: 'deezer', kind, id },
    kind,
    title,
    subtitle,
    artwork: [],
    group,
  });
  const page = (
    entities: ReturnType<typeof ent>[],
    topHit: SearchPage['topHit'],
    items: TrackMetadata[] = [],
    continuation: string | null = null,
  ) => ({
    type: 'content' as const,
    revision: 1,
    query: 'portishead',
    page: { items, entities, topHit, continuation, storefront: null },
  });

  // 'all' — rails group by kind in canonical order; the entity top
  // hit is the hero; tracks list below.
  const mixed = toSearchModel(
    page(
      [
        ent('playlist', 'dz-p-1', 'Trip Hop Essentials'),
        ent('artist', 'dz-artist-portishead', 'Portishead'),
        ent('album', 'dz-album-deadbeat', 'Deadbeat', 'Tame Impala'),
      ],
      { type: 'entity', item: ent('artist', 'dz-artist-portishead', 'Portishead') },
      [meta('dz-t-1', 'Roads')],
      'tok-2',
    ),
    null,
    [],
    [],
    'all',
    fixtureLikes,
    fixtureEntitySourceRefs,
    true,
  );
  assertEqual(
    mixed.rails.map((r) => r.key).join(','),
    'artist,album,playlist',
    'rails follow the canonical kind order',
  );
  assertEqual(mixed.rails[0]?.cards[0]?.kind, 'artist');
  assert(
    mixed.hero?.type === 'entity' &&
      mixed.hero.card.ref.id === 'dz-artist-portishead',
    'entity top hit is the hero card',
  );
  assert(
    mixed.hero?.type === 'entity' && mixed.hero.card.liked === true,
    'a liked entity carries its state into the hero',
  );
  assertEqual(mixed.hasMore, true, 'pending token exposes load-more');
  assertEqual(mixed.loadingMore, true, 'busy flag carries through');

  // A scoped chip shows only its kind's rail — tracks stay hidden.
  const scoped = toSearchModel(
    page(
      [ent('artist', 'dz-a-1', 'Portishead'), ent('artist', 'dz-a-2', 'Massive Attack')],
      null,
      [meta('dz-t-1', 'Roads')],
    ),
    null,
    [],
    [],
    'artists',
  );
  assertEqual(scoped.results.length, 0, 'entity chips hide tracks');
  assertEqual(scoped.rails.length, 1);
  assertEqual(scoped.rails[0]?.cards.length, 2);

  // 'songs' scope hides every entity rail.
  const songs = toSearchModel(
    page([ent('artist', 'dz-a-1', 'Portishead')], null, [meta('dz-t-1', 'Roads')]),
    null,
    [],
    [],
    'songs',
  );
  assertEqual(songs.rails.length, 0, 'songs chip drops entity rails');
  assertEqual(songs.results.length, 1);

  // 'library' narrows entities to liked ones — unliked cards drop.
  const library = toSearchModel(
    page(
      [
        ent('album', 'dz-album-deadbeat', 'Deadbeat'),
        ent('artist', 'dz-a-9', 'Unrelated Act'),
      ],
      null,
    ),
    null,
    [],
    [],
    'library',
    fixtureLikes,
    fixtureEntitySourceRefs,
  );
  assertEqual(
    library.rails.map((r) => r.key).join(','),
    'album',
    'library keeps only liked entity cards',
  );
  assertEqual(library.rails[0]?.cards[0]?.liked, true);

  // A track top hit outside the page listing still hero-fies — and
  // rides the play context first so pressing it plays it then the
  // rest of the list.
  const hero = toSearchModel(
    page(
      [],
      { type: 'track', item: meta('dz-t-hero', 'SOS') },
      [meta('dz-t-1', 'Roads')],
    ),
    null,
    [],
    [],
    'all',
  );
  assert(
    hero.hero?.type === 'track' && hero.hero.row.key.endsWith(':-1'),
    'an unlisted track top hit keys at index -1',
  );
  assertEqual(hero.playItems[0]?.sourceRef.id, 'dz-t-hero');
  assertEqual(hero.results.length, 1, 'hero does not double-list');

  // Entity page: `related` groups into shelf rails; the page's own
  // entity never recurs; untagged entries ride 'related'.
  const artistPage = toEntityModel({
    page: {
      entity: ent('artist', 'dz-artist-tame', 'Tame Impala'),
      items: [],
      related: [
        ent('album', 'dz-album-deadbeat', 'Deadbeat', null, 'discography'),
        ent('album', 'dz-album-deadbeat', 'Deadbeat', null, 'discography'),
        ent('artist', 'dz-artist-tame', 'Tame Impala', null, 'related'),
        ent('playlist', 'dz-p-1', 'Psych Mix', null, 'appears-on'),
        ent('artist', 'dz-a-pond', 'Pond'),
      ],
      continuation: null,
      complete: true,
    },
    error: null,
    likes: fixtureLikes,
    entitySourceRefs: fixtureEntitySourceRefs,
  });
  assertEqual(
    artistPage.rails.map((r) => r.key).join(','),
    'discography,related,appears-on',
    'related groups into shelf rails in canonical order',
  );
  assertEqual(
    artistPage.rails[0]?.cards.length,
    1,
    'duplicate related refs dedupe',
  );
  assertEqual(
    artistPage.rails[1]?.cards.map((c) => c.title).join(','),
    'Pond',
    'the page entity never recurs in its own rails',
  );
}

function sheetOf(kind: LyricsSheet['kind']): LyricsSheet {
  const base = {
    provider: 'lyrics-lrclib',
    fetchedMs: 1_700_000_000_000,
    cached: false,
    matched: null,
  };
  switch (kind) {
    case 'synced':
      return {
        ...base,
        kind,
        lines: [
          { tMs: 0, text: 'first' },
          { tMs: 10_000, text: 'second' },
          { tMs: 20_000, text: 'third' },
        ],
      };
    case 'plain':
      return { ...base, kind, text: 'first\nsecond\nthird' };
    case 'instrumental':
      return { ...base, kind };
    case 'unavailable':
      return { ...base, kind };
  }
}

function testLyricsModel(): void {
  // Synced earns the active line; the index tracks positionMs.
  const synced = toLyricsModel({
    sheet: sheetOf('synced'),
    error: null,
    loading: false,
    positionMs: 15_000,
  });
  assertEqual(synced.state, 'synced');
  assertEqual(synced.activeIndex, 1, 'active line follows position');
  assertEqual(synced.lines.length, 3);
  assert(
    synced.syncLabel !== null && synced.syncLabel.startsWith('synced'),
    'synced label must name the form',
  );
  const before = toLyricsModel({
    sheet: sheetOf('synced'),
    error: null,
    loading: false,
    positionMs: 5_000,
  });
  assertEqual(before.activeIndex, 0);
  const ahead = toLyricsModel({
    sheet: sheetOf('synced'),
    error: null,
    loading: false,
    positionMs: 0,
  });
  // tMs:0 line is active at position 0 — the first timed line is the
  // earliest honest highlight, never a phantom earlier line.
  assertEqual(ahead.activeIndex, 0);
  // Before the first timestamp the intro holds line 0 highlighted —
  // no-gap highlighting beats a blanked first seconds.
  const introSheet: LyricsSheet = {
    provider: 'lyrics-lrclib',
    fetchedMs: 1_700_000_000_000,
    cached: false,
    matched: null,
    kind: 'synced',
    lines: [
      { tMs: 5_000, text: 'first' },
      { tMs: 15_000, text: 'second' },
    ],
  };
  const intro = toLyricsModel({
    sheet: introSheet,
    error: null,
    loading: false,
    positionMs: 0,
  });
  assertEqual(intro.activeIndex, 0, 'intro holds line 0 pre-first-timestamp');
  // Plain is plain — untimed text never receives a highlight.
  const plain = toLyricsModel({
    sheet: sheetOf('plain'),
    error: null,
    loading: false,
    positionMs: 99_000,
  });
  assertEqual(plain.state, 'plain');
  assertEqual(plain.activeIndex, null, 'plain must never mark a line');
  assertEqual(plain.lines.length, 3);
  assert(
    plain.syncLabel !== null && plain.syncLabel.startsWith('unsynced'),
    'plain label must say unsynced',
  );
  // Instrumental / unavailable / error / loading are explicit states.
  const instrumental = toLyricsModel({
    sheet: sheetOf('instrumental'),
    error: null,
    loading: false,
    positionMs: 0,
  });
  assertEqual(instrumental.state, 'instrumental');
  assertEqual(instrumental.lines.length, 0);
  assert(instrumental.message !== null, 'instrumental explains itself');
  const unavailable = toLyricsModel({
    sheet: sheetOf('unavailable'),
    error: null,
    loading: false,
    positionMs: 0,
  });
  assertEqual(unavailable.state, 'unavailable');
  const loading = toLyricsModel({
    sheet: null,
    error: null,
    loading: true,
    positionMs: 0,
  });
  assertEqual(loading.state, 'loading');
  const errored = toLyricsModel({
    sheet: null,
    error: { kind: 'rate-limit', message: 'rate limited', retryable: true },
    loading: false,
    positionMs: 0,
  });
  assertEqual(errored.state, 'error');
  assertEqual(errored.message, 'the provider is rate-limiting right now');
  // No sheet and no error is the honest absence, not an error.
  const absent = toLyricsModel({
    sheet: null,
    error: null,
    loading: false,
    positionMs: 0,
  });
  assertEqual(absent.state, 'unavailable');
  // Fixtures: every state appears, only synced carries an index.
  const states = new Set(fixtureLyricsStates.map((l) => l.state));
  for (const s of ['synced', 'plain', 'instrumental', 'unavailable', 'error', 'loading']) {
    assert(states.has(s as never), `missing lyrics fixture ${s}`);
  }
  for (const model of fixtureLyricsStates) {
    if (model.state === 'synced') {
      assert(model.activeIndex !== null, 'synced needs an active line');
    } else {
      assertEqual(
        model.activeIndex,
        null,
        `${model.state} must never carry an active line`,
      );
    }
  }
}

function testRadioModel(): void {
  const unarmed = toRadioModel(null);
  assertEqual(unarmed.armed, false);
  assertEqual(unarmed.status, null);
  const growing = toRadioModel(fixtureRadioTailGrowing);
  assertEqual(growing.armed, true);
  assertEqual(growing.status, 'growing');
  assertEqual(growing.detail, 'deezer', 'detail names the tail provider');
  const failed = toRadioModel(fixtureRadioTailFailed);
  assertEqual(failed.status, 'failed');
  assert(
    failed.detail !== null && !failed.detail.includes('timed out'),
    'failed tail carries the humanized reason, not the raw message',
  );
  const statuses = new Set(
    fixtureRadioModels.filter((m) => m.armed).map((m) => m.status),
  );
  for (const s of ['growing', 'ended', 'failed']) {
    assert(statuses.has(s as never), `missing radio fixture ${s}`);
  }
}

function testCorrectionsModel(): void {
  const model = fixtureCorrectionsModel;
  assertEqual(model.state, 'ready');
  assertEqual(model.filter, 'all');
  assertEqual(model.rows.length, fixtureMatchReviews.length);
  assertEqual(model.pendingCount, 1);
  assertEqual(model.resolvedCount, 2);
  // Pending sorts first — the actionable queue leads.
  assertEqual(model.rows[0]?.status, 'pending');
  // Candidates keep their wire index for confirmReview.
  const pending = model.rows[0];
  assert(pending !== undefined && pending.candidates.length === 2);
  assertDeepEqual(
    pending.candidates.map((c) => c.index),
    [0, 1],
  );
  assert(
    pending.candidates.every((c) => c.subtitle.includes('·')),
    'candidate subtitle carries artist + provider',
  );
  // Display-identical parked members collapse to one row; the shown
  // index stays the representative's stored index for confirmReview.
  const collapsed = toCorrectionsModel({
    reviews: [
      {
        reviewId: 'rev-dup',
        recordingId: fixtureRecordings[0]!.id,
        candidates: [200_000, 200_000, 300_000].map((durationMs, i) => {
          const ref: SourceRef = {
            provider: 'youtube-music',
            kind: 'track',
            id: `y${i}`,
          };
          return {
            ref,
            metadata: {
              sourceRef: ref,
              title: 'Song',
              artist: 'Artist',
              album: null,
              durationMs,
              releaseYear: null,
              artwork: [],
              explicit: null,
              genre: null,
              storefront: null,
            },
          };
        }),
        status: 'pending',
        resolution: null,
        createdMs: 1,
        resolvedMs: null,
      },
    ],
    error: null,
    recordings: fixtureRecordings,
    filter: 'all',
  });
  assertDeepEqual(
    collapsed.rows[0]?.candidates.map((c) => c.index),
    [0, 2],
    'identical rows collapse; a different shown duration stays',
  );
  assert(
    collapsed.rows[0]?.candidates[1]?.subtitle.includes('5:00') === true,
    'distinct row shows its duration',
  );
  // Confirmed rows name their resolution provider.
  const confirmed = model.rows.find((r) => r.status === 'confirmed');
  assert(
    confirmed !== undefined && confirmed.statusLabel.includes('deezer'),
    'confirmed label names the resolved provider',
  );
  const rejected = model.rows.find((r) => r.status === 'rejected');
  assert(rejected !== undefined && rejected.statusLabel.includes('reject'));
  // Filters: pending shows only pending; counts are unfiltered.
  const pendingOnly = fixtureCorrectionsModelPending;
  assertEqual(pendingOnly.rows.length, 1);
  assertEqual(pendingOnly.pendingCount, 1);
  assertEqual(pendingOnly.resolvedCount, 2);
  const resolvedOnly = toCorrectionsModel({
    reviews: fixtureMatchReviews,
    error: null,
    recordings: fixtureRecordings,
    filter: 'resolved',
  });
  assertEqual(resolvedOnly.rows.length, 2);
  assert(
    resolvedOnly.rows.every((r) => r.status !== 'pending'),
    'resolved filter must drop pending rows',
  );
  // Lifecycle states.
  assertEqual(fixtureCorrectionsModelLoading.state, 'loading');
  assertEqual(fixtureCorrectionsModelError.state, 'error');
  assert(
    fixtureCorrectionsModelError.message !== null,
    'error state carries the typed message',
  );
  assertEqual(fixtureCorrectionsModelEmpty.rows.length, 0);
  // Unknown recordings title honestly.
  const orphaned = toCorrectionsModel({
    reviews: [
      {
        reviewId: 'rev-ghost',
        recordingId: 'rec-deleted',
        candidates: [],
        status: 'pending',
        resolution: null,
        createdMs: 1,
        resolvedMs: null,
      },
    ],
    error: null,
    recordings: fixtureRecordings,
    filter: 'all',
  });
  assertEqual(orphaned.rows[0]?.title, 'unknown recording');
}

function testTransferModel(): void {
  const preview = fixtureImportPreviewModel;
  assertEqual(preview.formatVersion, fixtureImportPreview.doc.formatVersion);
  assert(preview.rows.length >= 8, 'preview covers every owned section');
  const recordings = preview.rows.find((r) => r.key === 'recordings');
  assertEqual(
    recordings?.count,
    fixtureImportPreview.counts.recordings,
    'preview counts survive mapping',
  );
  assert(
    preview.exportedLabel !== null && /\d{4}-\d{2}-\d{2}/.test(preview.exportedLabel),
    'exported date renders as ISO',
  );
  assertEqual(
    fixtureTransferModelPreview.preview?.formatVersion,
    1,
    'preview fixture carries the doc version',
  );
  assertEqual(fixtureTransferModelPreview.importPhase, 'preview');
  assertEqual(fixtureTransferModelDone.importPhase, 'done');
  assert(
    fixtureTransferModelDone.importDetail !== null,
    'done carries the applied summary',
  );
  assertEqual(fixtureTransferModelError.importPhase, 'error');
  assert(
    fixtureTransferModelError.importDetail !== null,
    'error carries the typed message',
  );
}

function testCoverageMatrix(): void {
  assert(galleryCoverage.sections.length >= 10, 'coverage sections too thin');
  assertEqual(galleryCoverage.schemes.length, 3, 'need all three schemes');
  assertEqual(galleryCoverage.platforms.length, 2, 'need both platforms');
  assertEqual(galleryCoverage.reducedMotion.length, 2, 'need both motion modes');
  assert(
    galleryCoverage.reducedMotion.includes(true) &&
    galleryCoverage.reducedMotion.includes(false),
    'motion modes must cover on+off',
  );
  const phases = new Set(galleryCoverage.searchPhases);
  assertEqual(phases.size, VALID_PHASES.size, 'search coverage incomplete');
  assertEqual(
    galleryCoverage.textScales.join(','),
    '1,2',
    'gallery must review normal and 200% text',
  );
  assertEqual(
    galleryCoverage.artworkConditions.join(','),
    'missing,slow,extreme',
    'gallery must cover the artwork failure matrix',
  );
  assertEqual(
    galleryCoverage.gestureStates.join(','),
    'rest,mid-drag,dismissed',
    'gallery must cover the Stage sheet gesture states',
  );
}

function testDesignTokenAuthority(): void {
  const files = readdirSync(new URL('.', import.meta.url))
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => ({
      name,
      source: readFileSync(new URL(name, import.meta.url), 'utf8'),
    }));
  for (const file of files) {
    assert(
      !/(#[0-9a-f]{3,8}|rgba\()/i.test(file.source),
      `${file.name}: raw colors must come from design tokens`,
    );
    assert(
      !file.source.includes('fontSize: ') ||
      file.name === 'primitives.tsx',
      `${file.name}: literal font sizes must come from typography tokens`,
    );
    assert(
      !/\b(?:padding|margin)\w*: 14\b/.test(file.source),
      `${file.name}: screen gutters must use the spacing token`,
    );
  }
}

function testGalleryNestingSafety(): void {
  const source = readFileSync(new URL('./gallery.tsx', import.meta.url), 'utf8');
  assert(
    source.includes('height * theme.textScale'),
    'fixture frames must grow with the accessibility text scale',
  );
  assert(
    source.includes('queueScrollEnabled={false}'),
    'embedded Stage queue must not add a second vertical scroller',
  );
  assert(
    /<QueueScreen[\s\S]*?scrollEnabled={false}/.test(source),
    'embedded queue screens must disable their inner list scrolling',
  );
}

function testTrackRowTextScale(): void {
  const source = readFileSync(new URL('./track-row.tsx', import.meta.url), 'utf8');
  assert(
    source.includes('minHeight: theme.sizes.trackRow * theme.textScale'),
    'track rows must grow to fit 200% title and metadata lines',
  );
  assert(
    source.includes('formatClock(row.durationMs)'),
    'the `artist · len` small line must carry the track duration',
  );
  assert(
    (source.match(/numberOfLines={1}/g)?.length ?? 0) >= 2,
    'title and `artist · len` lines must stay on one line at 200% text',
  );
}

function testNavbarTextScale(): void {
  const source = readFileSync(new URL('./navbar.tsx', import.meta.url), 'utf8');
  const adaptiveLabels = source.match(/adjustsFontSizeToFit/g)?.length ?? 0;
  assert(
    adaptiveLabels >= 2,
    'both navbar variants must keep destination labels on one adaptive line',
  );
}

function testGallerySafeArea(): void {
  const source = readFileSync(new URL('./gallery.tsx', import.meta.url), 'utf8');
  assert(
    source.includes('useSafeAreaInsets()'),
    'gallery must respect the platform safe-area insets',
  );
  assert(
    source.includes('insets.top + theme.spacing.lg'),
    'gallery content must clear the status bar',
  );
  assert(
    source.includes('insets.bottom + theme.spacing.display'),
    'gallery content must clear the system gesture area',
  );
}

testFormatClock();
testPlayPauseMorph();
testProgressPathState();
testPickArtworkUrl();
testFixtureRecordings();
testQueueFixture();
testTrackRowMapper();
testSearchRowMapper();
testPlayerMapper();
testQueueMapper();
testCollectionTiles();
testLibraryAndSettings();
testLibraryCards();
testCollections();
testPlaylistModel();
testEntityModel();
testPlaylistMembership();
testHomeAndNav();
testSearchStates();
testListingDedupe();
testLocalRecordingDedupe();
testSearchFilters();
testDiscoveryModel();
testLyricsModel();
testRadioModel();
testCorrectionsModel();
testTransferModel();
testCoverageMatrix();
testDesignTokenAuthority();
testGalleryNestingSafety();
testTrackRowTextScale();
testNavbarTextScale();
function testStageMotion(): void {
  // Release decision — OpenTune's performFling contract on one
  // continuous pixel axis (raw px above the rest anchor; negative
  // below it). travel = 600, collapsed = 136 throughout.
  assertEqual(
    resolveSheetTarget(60, 600, 136, -700),
    'expanded',
    'an up-fling commits regardless of distance',
  );
  assertEqual(
    resolveSheetTarget(540, 600, 136, 700),
    'collapsed',
    'a down-fling commits regardless of distance',
  );
  assertEqual(
    resolveSheetTarget(-20, 600, 136, 700),
    'dismissed',
    'a down-fling below the rest anchor dismisses',
  );
  assertEqual(
    resolveSheetTarget(30, 600, 136, 500),
    'collapsed',
    'a down-fling above rest collapses',
  );
  // Zone midpoints: below collapsed/2 dismisses, below the
  // collapsed-expanded midpoint collapses, otherwise expands.
  assertEqual(
    resolveSheetTarget(170, 600, 136, 0),
    'collapsed',
    'below half the travel the release settles home',
  );
  assertEqual(
    resolveSheetTarget(310, 600, 136, 0),
    'expanded',
    'past half the travel the release commits up',
  );
  assertEqual(
    resolveSheetTarget(-69, 600, 136, 0),
    'dismissed',
    'more than half the strip below rest dismisses',
  );
  assertEqual(
    resolveSheetTarget(-67, 600, 136, 0),
    'collapsed',
    'a short dip below rest settles back',
  );

  // The raw axis splits at the rest anchor into the two unit
  // intervals the shared values each expect.
  assertEqual(stageSheetWrite(300, 600, 136).progress, 0.5);
  assertEqual(stageSheetWrite(300, 600, 136).gone, 0);
  assertEqual(stageSheetWrite(700, 600, 136).progress, 1);
  assertEqual(stageSheetWrite(-68, 600, 136).progress, 0);
  assertEqual(stageSheetWrite(-68, 600, 136).gone, 0.5);
  assertEqual(stageSheetWrite(0, 600, 136).progress, 0);
  assertEqual(stageSheetWrite(0, 600, 136).gone, 0);

  // The coupled phase is the first 18% of the morph — geometry,
  // corners and background all key off it.
  assertEqual(stageCoupled(0), 0);
  assertEqual(stageCoupled(0.09), 0.5);
  assertEqual(stageCoupled(0.18), 1);
  assertEqual(stageCoupled(1), 1);

  // Pill fade: full at rest, gone exactly at the reveal start.
  assertEqual(stageCollapsedAlpha(0), 1);
  assertEqual(stageCollapsedAlpha(0.1), 1);
  assertEqual(stageCollapsedAlpha(0.25), 0);
  assertEqual(stageCollapsedAlpha(1), 0);

  // Content reveal: invisible through the coupled phase + pill fade,
  // fully present at the input gate.
  assertEqual(stageContentAlpha(0), 0);
  assertEqual(stageContentAlpha(0.25), 0);
  assertEqual(stageContentAlpha(0.5), 1);
  assertEqual(stageContentAlpha(1), 1);

  // Corners: rest radius, sheet radius mid-rise, square at the anchor.
  assertEqual(stageTopRadius(0, 16, 28), 16);
  assertEqual(stageTopRadius(0.18, 16, 28), 28);
  assertEqual(stageTopRadius(1, 16, 28), 0);
  assert(
    stageTopRadius(0.09, 16, 28) === 22,
    'mid-coupled corners interpolate evenly',
  );

  // Scrim rises with progress.
  assertEqual(stageScrimAlpha(0), 0);
  assertEqual(stageScrimAlpha(1), 0.5);

  // ---- sideswipe conveyor ----------------------------------------
  // Travel: an allowed drag tracks the finger 1:1 up to the row's
  // width; a dead edge rubber-bands with a hard cap.
  assertEqual(skipTravelPx(-120, 400, true), -120, 'live drag tracks');
  assertEqual(skipTravelPx(-500, 400, true), -400, 'live drag clamps');
  assertEqual(skipTravelPx(500, 400, true), 400, 'live drag clamps +');
  assert(
    skipTravelPx(-500, 400, false) > -50 &&
      skipTravelPx(-500, 400, false) < -40,
    'dead edge asymptotes toward the resist cap',
  );
  assertEqual(skipTravelPx(0, 400, false), 0, 'rest edge stays home');
  assert(
    Math.abs(skipTravelPx(10_000, 400, false)) <= 48,
    'resist never exceeds the cap',
  );
  // Commit: past 36% commits, under it springs home, a release-ward
  // fling commits regardless of distance, a backward fling does not.
  assert(resolveSkipCommit(-160, 0, 400, true), '36% commits');
  assert(!resolveSkipCommit(-140, 0, 400, true), 'under 36% releases');
  assert(resolveSkipCommit(-40, -900, 400, true), 'outward fling commits');
  assert(!resolveSkipCommit(-40, 900, 400, true), 'inward fling releases');
  assert(!resolveSkipCommit(-300, -900, 400, false), 'dead edge never commits');
  assert(!resolveSkipCommit(NaN, 0, 400, true), 'NaN translation releases');
  // The commit edge mirrors the drag direction.
  assertEqual(skipCommitEdge(-10, 400), -400);
  assertEqual(skipCommitEdge(10, 400), 400);

  // ---- dismiss→reopen race guards (source scan) -------------------
  // The slide-off's completion must check the live tokens: every
  // reopen path either cancels the spring by rewriting `gone` or
  // flips the expanded mirror — and the collapsed-row tap's JS
  // commit reclaims the dismiss axis like every other reopen.
  const sheet = readFileSync(
    new URL('./stage-sheet.tsx', import.meta.url),
    'utf8',
  );
  assert(
    sheet.includes('!expandedShared.value || anchor.value === 0'),
    'slide-off completion is gated on the live reopen tokens',
  );
  const rowTap = sheet.slice(
    sheet.indexOf('onPress={() => {'),
    sheet.indexOf('onExpandCommit={() =>'),
  );
  assert(
    rowTap.includes('gone.value'),
    'the row tap reclaims the dismiss axis on reopen',
  );
}

function testSkipPeek(): void {
  const occ2 = fixtureQueueModel.items.find((i) => i.occurrenceId === 'occ-2');
  assert(occ2 !== undefined, 'fixture occ-2 row missing');
  const peek = skipPeekFor(fixtureQueueModel, 'occ-2');
  assert(peek !== null, 'a live occurrence peeks');
  assertEqual(peek!.occurrenceId, 'occ-2');
  assertEqual(peek!.title, occ2!.row.title, 'peek mirrors the queue row');
  assertEqual(peek!.artist, occ2!.row.artist, 'peek mirrors the artist');
  assertEqual(
    skipPeekFor(fixtureQueueModel, null),
    null,
    'a dead edge has no peek',
  );
  assertEqual(
    skipPeekFor(fixtureQueueModel, 'occ-missing'),
    null,
    'a stale target has no peek',
  );
  // Identity is per-occurrence: the duplicated recording peeks its own
  // queue row, not a recording-level match.
  const dup = skipPeekFor(fixtureQueueModel, 'occ-6');
  assert(dup !== null && dup.occurrenceId === 'occ-6', 'occurrence identity');
}

function testAnimatedIcons(): void {
  // The state machine contract: every chip reaches a phase with defined
  // channel targets — busy is the only phase that spins, terminal
  // phases finish the draw sweep.
  for (const chip of [
    'idle',
    'queued',
    'downloading',
    'stored',
    'failed',
    'removing',
  ] as const) {
    const phase = downloadIconState(chip);
    const target = DOWNLOAD_TARGETS[phase];
    assert(target !== undefined, `${chip} maps to a phase without targets`);
    assertEqual(
      target.spin,
      phase === 'busy',
      `${phase} spin flag matches its busy-ness`,
    );
    assertEqual(
      target.draw,
      phase === 'done' || phase === 'error' ? 1 : 0,
      `${phase} draw channel reaches its terminal state`,
    );
    assertEqual(
      target.morph,
      phase === 'idle' ? 0 : 1,
      `${phase} morph channel reaches its ring state`,
    );
  }
  // Mark sub-progress: hidden until the ring is mostly closed, fully
  // drawn at the end of the sweep; the dot only trails the stroke.
  assertEqual(markStrokeProgress(0), 0, 'mark hidden before the sweep');
  assertEqual(markStrokeProgress(0.35), 0, 'mark waits for the ring');
  assertEqual(markStrokeProgress(1), 1, 'mark fully drawn at done');
  assertEqual(markDotProgress(0.75), 0, 'dot waits for the stroke');
  assertEqual(markDotProgress(1), 1, 'dot fully popped at done');
  assert(
    markDotProgress(0.5) < markStrokeProgress(0.5),
    'dot trails the stroke through the sweep',
  );

  // Worklet discipline: the icon layer must run entirely on the UI
  // thread — shared values + animated props, zero JS-frame drivers.
  const primitives = readFileSync(new URL('./primitives.tsx', import.meta.url), 'utf8');
  assert(
    primitives.includes('useAnimatedProps'),
    'DownloadIcon mutates SVG through animated props',
  );
  assert(
    primitives.includes('withTiming'),
    'phase transitions run as timing worklets',
  );
  const iconBlock = primitives.slice(
    primitives.indexOf('export function DownloadIcon'),
    primitives.indexOf('export function DownloadIconButton'),
  );
  assert(
    !/setInterval|requestAnimationFrame|setTimeout/.test(iconBlock),
    'no per-frame JS scheduling inside the icon layer',
  );
  assert(
    primitives.includes('theme.reducedMotion'),
    'icon paths honor the reduced-motion flag',
  );
  assert(
    primitives.includes('downloadIconState'),
    'icon phases come from the shared chip map',
  );

  // Consumers mount the state machine, not a glyph swap. Rows take the
  // static path — the densest surface doesn't pay for transitions.
  const row = readFileSync(new URL('./track-row.tsx', import.meta.url), 'utf8');
  assert(row.includes('DownloadIcon'), 'track-row mounts the icon state machine');
  assert(
    row.includes('animated={false}'),
    'track rows render icon end states without animation',
  );
  const stage = readFileSync(new URL('./stage-sheet.tsx', import.meta.url), 'utf8');
  assert(stage.includes('DownloadIconButton'), 'stage mounts the morph button');
  const nav = readFileSync(new URL('./navbar.tsx', import.meta.url), 'utf8');
  assert(
    nav.includes('useSharedValue') && nav.includes('theme.reducedMotion'),
    'nav activation is a gated shared-value transition',
  );
  const sheets = readFileSync(new URL('./sheets.tsx', import.meta.url), 'utf8');
  assert(
    sheets.includes('StatusMark') && !sheets.includes('name="spinner"'),
    'sheets draw terminal marks and use the real spinner',
  );
  const gallery = readFileSync(new URL('./gallery.tsx', import.meta.url), 'utf8');
  assert(
    gallery.includes('animated icons') && gallery.includes('DL_STATES'),
    'gallery exercises the icon state machine',
  );
}

testGallerySafeArea();
testStageMotion();
testSkipPeek();
testAnimatedIcons();

console.log('ui-native tests passed');
import { readdirSync, readFileSync } from 'node:fs';
import {
  resolveSheetTarget,
  resolveSkipCommit,
  skipCommitEdge,
  skipTravelPx,
  stageCollapsedAlpha,
  stageContentAlpha,
  stageCoupled,
  stageScrimAlpha,
  stageSheetWrite,
  stageTopRadius,
} from './stage-motion.ts';
