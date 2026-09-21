import {
  entityIdForRef,
  formatClock,
  formatRemaining,
  toCollectionModel,
  toCorrectionsModel,
  toEntityModel,
  toHomeModel,
  pickArtworkUrl,
  toImportPreviewModel,
  toLibraryModel,
  toLyricsModel,
  toPlayerModel,
  toPlaylistModel,
  toQueueModel,
  toRadioModel,
  toRailCard,
  toSearchRowModel,
  toSettingsModel,
  toTrackRowModel,
} from './view-models.ts';
import type { LyricsSheet } from '@auqw/application';
import type {
  QueueModel,
  TrackRowModel,
} from './view-models.ts';
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
  fixtureQueue,
  fixtureQueueModel,
  fixtureRecordings,
  fixtureRowStates,
  fixtureSearchResults,
  fixtureSearchStates,
  fixtureSettings,
  fixtureSettingsModel,
  galleryCoverage,
} from './fixtures.ts';
import {
  quadPath,
  morphPlayPause,
  PAUSE_LEFT,
  PAUSE_RIGHT,
  PLAY_LEFT,
  PLAY_RIGHT,
  progressPathState,
} from './motion.ts';

function assert(
  condition: unknown,
  message = 'assertion failed',
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      message ??
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDeepEqual(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(message ?? `expected ${e}, got ${a}`);
  }
}

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
  for (const item of queue.items) {
    checkTrackRowModel(item.row, `${label} item ${item.occurrenceId}`);
    assert(
      item.row.key === item.occurrenceId,
      `${label}: row key must be occurrenceId for stable list keys`,
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
  assertEqual(state.dashOffset, -150, 'offset reveals the first quarter clockwise');
  assertEqual(state.opacity, 1, 'positive progress is visible');
  assertEqual(progressPathState(0, 200).opacity, 0, 'zero progress hides the arc');
  assertEqual(progressPathState(-1, 200).dashOffset, -200, 'progress is clamped low');
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
  const paused = toPlayerModel({ ...base, playback: fixturePlaybackPaused });
  assert(paused !== null && paused.status === 'paused', 'paused mapping');
  const failed = toPlayerModel({ ...base, playback: fixturePlaybackFailed });
  assert(failed !== null, 'failed model null');
  assertEqual(failed.status, 'failed');
  assert(
    failed.errorMessage !== null && failed.errorMessage.length > 0,
    'failed carries error message',
  );
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
  assertEqual(
    history.rows.length,
    fixturePlayHistory.length,
    'one row per counted play',
  );
  const sorted = [...fixturePlayHistory].sort(
    (a, b) => b.playedMs - a.playedMs,
  );
  assertDeepEqual(
    history.rows.map((r) => r.key),
    sorted.map((e) => `hist-${e.eventId}`),
    'history rows must be newest-first and event-keyed',
  );
  const dracula = history.rows.filter((r) => r.recordingId === 'rec-dracula');
  assertEqual(
    dracula.length,
    2,
    'repeated plays keep separate history rows',
  );
  assert(
    new Set(dracula.map((r) => r.key)).size === 2,
    'repeat history rows keep distinct keys',
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
  assertEqual(errored.message, 'rate limited');
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
    failed.detail !== null && failed.detail.includes('timed out'),
    'failed tail carries the typed error message',
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
      !/(padding|margin)Horizontal: 14/.test(file.source),
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
    source.includes('minWidth: 34 * theme.textScale'),
    'the duration column must stay on one line at 200% text',
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
testLibraryAndSettings();
testLibraryCards();
testCollections();
testPlaylistModel();
testEntityModel();
testHomeAndNav();
testSearchStates();
testLyricsModel();
testRadioModel();
testCorrectionsModel();
testTransferModel();
testCoverageMatrix();
testDesignTokenAuthority();
testGalleryNestingSafety();
testTrackRowTextScale();
testNavbarTextScale();
testGallerySafeArea();

console.log('ui-native tests passed');
import { readdirSync, readFileSync } from 'node:fs';
