import {
  formatClock,
  formatRemaining,
  pickArtworkUrl,
  toLibraryModel,
  toPlayerModel,
  toQueueModel,
  toRailCard,
  toSearchRowModel,
  toSettingsModel,
  toTrackRowModel,
} from './view-models.ts';
import type {
  QueueModel,
  TrackRowModel,
} from './view-models.ts';
import {
  fixtureDiagnostics,
  fixtureHomeModel,
  fixtureLikes,
  fixtureLibraryModel,
  fixtureNavItems,
  fixturePlaybackBuffering,
  fixturePlaybackFailed,
  fixturePlaybackPaused,
  fixturePlaybackPlaying,
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
  assertEqual(fixtureLibraryModel.likedCount, fixtureLikes.length);
  const keys = new Set(fixtureLibraryModel.items.map((i) => i.key));
  assert(keys.size === fixtureLibraryModel.items.length, 'dup library keys');
  for (const item of fixtureLibraryModel.items) {
    assert(item.liked, 'library item not liked');
  }
  const lib = toLibraryModel({ recordings: [], likes: [] });
  assertEqual(lib.likedCount, 0);
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
}

testFormatClock();
testPickArtworkUrl();
testFixtureRecordings();
testQueueFixture();
testTrackRowMapper();
testSearchRowMapper();
testPlayerMapper();
testQueueMapper();
testLibraryAndSettings();
testHomeAndNav();
testSearchStates();
testCoverageMatrix();

console.log('ui-native tests passed');
