// Coverage for the pure helpers the hook wires: the advance walk
// target, the row-actions sheet list, the stage download affordance,
// the playlist download plan, and the stored-error retry toast. The
// hook itself is thin wiring — the app-level journeys keep behavior
// identical evidence.
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import {
  setLocale,
  setToastSink,
  t,
} from '@auqw/ui-shared';
import {
  fixtureEntityItems,
  fixtureQueue,
} from '@auqw/ui-shared/fixtures';
import type {
  AppError,
  DownloadRecord,
  EntityRef,
  TrackMetadata,
} from '@auqw/application';
import {
  advanceTargetId,
  failedSkipIds,
  navRouteKey,
  overlayRouteIndex,
  playlistDownloadPlan,
  queueOriginRoute,
  reportStoredDownloadError,
  rowActionsModel,
  sameNavLocation,
  sameOverlayRoute,
  searchRowTarget,
  skipTargetIds,
  stageDownloadChip,
  stageReopenMode,
  suggestionMetaMap,
} from './types.ts';
import type { SourceRef } from '@auqw/application';
import type { ShellOverlay } from './types.ts';

setLocale('en');

// ---- advanceTargetId ------------------------------------------------
// The gate sees the walk target the engine would land on: next skips
// failed occurrences, previous restarts past 3 s / steps back
// otherwise, and repeat=all wraps both edges.

const occ = (id: string) => ({ occurrenceId: id, recordingId: `r-${id}` });
const occurrences = fixtureQueue.occurrences.map((o) => ({
  occurrenceId: o.occurrenceId,
  recordingId: o.recordingId,
}));

assertEqual(
  advanceTargetId({
    method: 'next',
    occurrences,
    currentOccurrenceId: 'occ-1',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 0,
  }),
  'occ-2',
  'next walks the canonical order',
);

assertEqual(
  advanceTargetId({
    method: 'next',
    occurrences,
    currentOccurrenceId: 'occ-1',
    dealtOrder: null,
    failedIds: new Set(['occ-2']),
    repeat: 'off',
    positionMs: 0,
  }),
  'occ-3',
  'next skips a marked-failed target like the engine does',
);

assertEqual(
  advanceTargetId({
    method: 'next',
    occurrences,
    currentOccurrenceId: 'occ-8',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'all',
    positionMs: 0,
  }),
  'occ-1',
  'repeat=all wraps the tail back to the walk head',
);

assertEqual(
  advanceTargetId({
    method: 'next',
    occurrences,
    currentOccurrenceId: 'occ-8',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 0,
  }),
  null,
  'no wrap under repeat=off',
);

assertEqual(
  advanceTargetId({
    method: 'previous',
    occurrences,
    currentOccurrenceId: 'occ-4',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 97_200,
  }),
  'occ-4',
  'previous past 3 s restarts the current track',
);

assertEqual(
  advanceTargetId({
    method: 'previous',
    occurrences,
    currentOccurrenceId: 'occ-4',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 1_000,
  }),
  'occ-3',
  'previous early in the track steps back one',
);

assertEqual(
  advanceTargetId({
    method: 'previous',
    occurrences,
    currentOccurrenceId: 'occ-1',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'all',
    positionMs: 1_000,
  }),
  'occ-8',
  'repeat=all wraps the head back to the tail',
);

// Dealt (shuffle) walk: positions follow the dealt order, not the
// canonical one.
assertEqual(
  advanceTargetId({
    method: 'next',
    occurrences,
    currentOccurrenceId: 'occ-1',
    dealtOrder: ['occ-1', 'occ-5', 'occ-2'],
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 0,
  }),
  'occ-5',
  'shuffle walks the dealt order',
);

assertEqual(
  advanceTargetId({
    method: 'next',
    occurrences,
    currentOccurrenceId: null,
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 0,
  }),
  null,
  'no cursor → no next target',
);

assertEqual(
  advanceTargetId({
    method: 'previous',
    occurrences,
    currentOccurrenceId: null,
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 0,
  }),
  null,
  'no cursor → previous stays put',
);

// ---- skipTargetIds ---------------------------------------------------
// The conveyor's pure target resolution: the blocked row's retained
// position reads as 0 (the engine's own restart-window rule), and a
// landing-less forward walk with a live cursor is the drain edge —
// advance() stops the queue there — not a dead edge.

assertEqual(
  skipTargetIds({
    occurrences,
    currentOccurrenceId: 'occ-4',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 12_000,
    blocked: true,
  }).previous,
  'occ-3',
  'a blocked current row steps previous back, never restarts itself',
);

assertEqual(
  skipTargetIds({
    occurrences,
    currentOccurrenceId: 'occ-4',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 12_000,
    blocked: false,
  }).previous,
  'occ-4',
  'the same position unblocked previews the restart the commit runs',
);

assertEqual(
  skipTargetIds({
    occurrences,
    currentOccurrenceId: 'occ-8',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 0,
    blocked: false,
  }).nextEndsQueue,
  true,
  'tail + live cursor drains the queue on commit — an actionable edge',
);

assertEqual(
  skipTargetIds({
    occurrences,
    currentOccurrenceId: null,
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 0,
    blocked: false,
  }).nextEndsQueue,
  false,
  'no cursor → advance fails outright; the edge is genuinely dead',
);

assertEqual(
  skipTargetIds({
    occurrences,
    currentOccurrenceId: 'occ-7',
    dealtOrder: null,
    failedIds: new Set(['occ-8']),
    repeat: 'off',
    positionMs: 0,
    blocked: false,
  }).nextEndsQueue,
  true,
  'a forward walk that finds only failed rows still drains on commit',
);

// ---- failedSkipIds ---------------------------------------------------
// The advance gate's skip set is only the permanent subset of the
// hook's failed-row map — a transient mark displays 'error' but the
// engine still walks to the row.
{
  const failed = new Map<string, AppError>([
    ['occ-a', { kind: 'transient', message: 'hiccup', retryable: true }],
    ['occ-b', { kind: 'not-found', message: 'gone', retryable: false }],
    ['occ-c', { kind: 'auth-required', message: 'gate', retryable: false }],
    ['occ-d', { kind: 'cancelled', message: 'book', retryable: false }],
  ]);
  const skip = failedSkipIds(failed);
  assertEqual(
    [...skip].sort().join(','),
    'occ-b,occ-c',
    'only permanent verdicts skip forward',
  );
}

// ---- rowActionsModel -------------------------------------------------
const ref: SourceRef = { provider: 'ytm', kind: 'track', id: 'x1' };
const rec = (state: DownloadRecord['state']) =>
  ({
    state,
    error:
      state === 'failed_with_retry'
        ? { kind: 'offline', message: 'no link' }
        : null,
  }) as Pick<DownloadRecord, 'state' | 'error'>;

// Entity fixtures carry albumRef+artistRef so the metadata branch
// exercises the entity-hop actions too.
const meta = fixtureEntityItems[0]!;

const baseKeys = rowActionsModel({
  target: { kind: 'recording', recordingId: 'r-1' },
  liked: false,
  title: 'T',
  recordFor: () => null,
  downloadRefFor: () => ref,
  radioSeedable: false,
}).actions.map((a) => a.key);
assertEqual(
  baseKeys.join(','),
  'like,playNext,enqueue,add,download',
  'recording rows carry like/playNext/enqueue/add/download',
);

assert(
  rowActionsModel({
    target: { kind: 'recording', recordingId: 'r-1' },
    liked: true,
    title: 'T',
    recordFor: () => null,
    downloadRefFor: () => ref,
    radioSeedable: false,
  }).actions[0]!.label === t('common.unlike'),
  'a liked target offers Unlike',
);

{
  const actions = rowActionsModel({
    target: { kind: 'recording', recordingId: 'r-1' },
    liked: false,
    title: 'T',
    recordFor: () => rec('failed_with_retry'),
    downloadRefFor: () => null,
    radioSeedable: false,
  }).actions.map((a) => a.key);
  assertEqual(
    actions.join(','),
    'like,playNext,enqueue,add,download,removeDownload',
    'a failed ledger row offers retry AND an explicit remove out',
  );
}

{
  const actions = rowActionsModel({
    target: { kind: 'metadata', meta },
    liked: false,
    title: 'T',
    recordFor: () => null,
    downloadRefFor: () => null,
    radioSeedable: true,
  }).actions.map((a) => a.key);
  assertEqual(
    actions.join(','),
    'playNext,enqueue,add,radio,album,artist',
    'metadata rows carry playNext/enqueue/add + seedable radio + entity hops',
  );
}

assertEqual(
  rowActionsModel({
    target: { kind: 'metadata', meta },
    liked: false,
    title: 'T',
    recordFor: () => null,
    downloadRefFor: () => null,
    radioSeedable: false,
  }).actions.some((a) => a.key === 'radio'),
  false,
  'the radio affordance hides when the seed provider cannot seed',
);

// ---- stageDownloadChip ----------------------------------------------
assertEqual(
  stageDownloadChip({
    recordingId: null,
    recordFor: () => rec('available'),
    downloadRefFor: () => ref,
    chipFor: () => 'idle',
  }),
  null,
  'no playing track → no affordance',
);

assertEqual(
  stageDownloadChip({
    recordingId: 'r-1',
    recordFor: () => null,
    downloadRefFor: () => null,
    chipFor: () => 'idle',
  }),
  null,
  'unowned + undownloadable → hidden',
);

assertEqual(
  stageDownloadChip({
    recordingId: 'r-1',
    recordFor: () => null,
    downloadRefFor: () => ref,
    chipFor: () => null,
  }),
  'idle',
  'downloadable but not started shows the idle chip',
);

assertEqual(
  stageDownloadChip({
    recordingId: 'r-1',
    recordFor: () => rec('available'),
    downloadRefFor: () => null,
    chipFor: () => 'stored',
  }),
  'stored',
  'a ledger row surfaces its chip even with no provider ref',
);

// ---- stageReopenMode -------------------------------------------------
assertEqual(
  stageReopenMode({ playbackIdle: false, queueEnded: false }),
  'player',
  'live playback lands on the player pane',
);

assertEqual(
  stageReopenMode({ playbackIdle: true, queueEnded: false }),
  'player',
  'an idle stage with live queue rows still lands on the player',
);

assertEqual(
  stageReopenMode({ playbackIdle: true, queueEnded: true }),
  'queue',
  'the ended queue keeps the reopen on its replayable rows',
);

assertEqual(
  stageReopenMode({ playbackIdle: false, queueEnded: true }),
  'player',
  'playback resuming off an ended queue lands on the player',
);

// ---- playlistDownloadPlan -------------------------------------------
const entry = (recordingId: string) => ({ recordingId, selectedRef: null });

{
  const plan = playlistDownloadPlan({
    entries: [entry('a'), entry('b')],
    isOwned: () => false,
    downloadRefFor: () => ref,
    recordFor: () => null,
  });
  assertEqual(plan.state, 'none');
  assertEqual(plan.requests.length, 2);
}

{
  const plan = playlistDownloadPlan({
    entries: [entry('a'), entry('b'), entry('c')],
    isOwned: (id) => id === 'a',
    downloadRefFor: (id) => (id === 'c' ? null : ref),
    recordFor: () => null,
  });
  assertEqual(plan.state, 'partial');
  assertEqual(
    plan.requests.map((r) => r.recordingId).join(','),
    'b',
    'requests skip owned rows and unresolvable refs',
  );
}

{
  const plan = playlistDownloadPlan({
    entries: [entry('a')],
    isOwned: () => true,
    downloadRefFor: () => ref,
    recordFor: () => rec('available'),
  });
  assertEqual(plan.state, 'all');
  assertEqual(plan.requests.length, 0);
}

// ---- suggestionMetaMap ----------------------------------------------
// A provider page may repeat a sourceRef under different titles.
// Mobile's old activateHomeCard used page-order find() (first wins);
// desktop's Map.set overwrote (last wins) — both stay parameterized.
{
  const meta = (title: string, id: string): TrackMetadata => ({
    sourceRef: { provider: 'ytm', kind: 'track', id },
    title,
    artist: 'a',
    album: null,
    durationMs: 60_000,
    releaseYear: null,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: null,
  });
  const page: readonly TrackMetadata[] = [
    meta('live', 'dup'),
    meta('only', 'solo'),
    meta('studio', 'dup'),
  ];
  const first = suggestionMetaMap(page, 'firstWins');
  assertEqual(
    first.get('ytm:dup')?.title,
    'live',
    'firstWins keeps the page-order card mobile would find',
  );
  const last = suggestionMetaMap(page, 'lastWins');
  assertEqual(
    last.get('ytm:dup')?.title,
    'studio',
    'lastWins keeps the overwrite desktop always had',
  );
  assertEqual(first.get('ytm:solo')?.title, 'only');
  assertEqual(first.size, 2);
}

// ---- reportStoredDownloadError --------------------------------------
const toasts: string[] = [];
setToastSink((text) => {
  toasts.push(text);
});
reportStoredDownloadError(null);
assertEqual(toasts.length, 0, 'no stored error → no toast');
reportStoredDownloadError({ kind: 'offline', message: 'no link' });
assertEqual(toasts.length, 1, 'stored error toasts');

// ---- queue provenance navigation ------------------------------------
// "playing from …" routes to overlays when the source is a paged
// surface, null for world tabs; a source already in the stack is
// unwound to (topmost match), never duplicated.

const albumRef: EntityRef = {
  provider: 'ytm',
  kind: 'album',
  id: 'a1',
};
const artistRef: EntityRef = {
  provider: 'ytm',
  kind: 'artist',
  id: 'ar1',
};

assertDeepEqual(
  queueOriginRoute({ kind: 'collection', collection: 'liked' }),
  { type: 'collection', key: 'liked' },
  'collection origin routes to its collection overlay',
);
assertEqual(
  queueOriginRoute({ kind: 'search', query: 'q' }),
  null,
  'search origin has no overlay route',
);
assert(
  sameOverlayRoute(
    { type: 'entity', ref: albumRef },
    { type: 'entity', ref: { ...albumRef } },
  ),
  'entity routes match by ref identity, not object identity',
);
assert(
  !sameOverlayRoute(
    { type: 'entity', ref: albumRef },
    { type: 'entity', ref: artistRef },
  ),
  'different entity refs are different routes',
);
assert(
  sameOverlayRoute(
    { type: 'collection', key: 'liked' },
    { type: 'collection', key: 'liked' },
  ) &&
    !sameOverlayRoute(
      { type: 'collection', key: 'liked' },
      { type: 'playlist', playlistId: 'liked' },
    ),
  'collection matches on key; overlay type is part of the route',
);

const mixedRoutes: readonly (ShellOverlay | null)[] = [
  { type: 'playlist', playlistId: 'mix' },
  { type: 'entity', ref: albumRef },
  { type: 'playlist', playlistId: 'mix' },
];
assertEqual(
  overlayRouteIndex(mixedRoutes, { type: 'playlist', playlistId: 'mix' }),
  2,
  'unwind lands on the topmost matching copy',
);
assertEqual(
  overlayRouteIndex(mixedRoutes, { type: 'entity', ref: albumRef }),
  1,
  'entity match unwinds to its stack position',
);
assertEqual(
  overlayRouteIndex(mixedRoutes, {
    type: 'collection',
    key: 'history',
  }),
  -1,
  'absent source pushes fresh',
);
assertEqual(
  overlayRouteIndex(
    [null, { type: 'collection', key: 'top50' }],
    { type: 'collection', key: 'top50' },
  ),
  1,
  'app-specific overlay entries (null after narrowing) are skipped',
);

// ---- navRouteKey / sameNavLocation ------------------------------------
// The world-bar history dedupes locations by route identity: same
// surface commits collapse, same-type routes with different payload
// keys stay distinct, and app-extended overlays keep their own shape.

const likedRoute: ShellOverlay = { type: 'collection', key: 'liked' };
const top50Route: ShellOverlay = { type: 'collection', key: 'top50' };
const albumRoute: ShellOverlay = { type: 'entity', ref: albumRef };
const artistRoute: ShellOverlay = { type: 'entity', ref: artistRef };

assertEqual(
  navRouteKey(likedRoute),
  'collection:liked',
  'collection key = type + collection key',
);
const albumRouteCopy: ShellOverlay = {
  type: 'entity',
  ref: { ...albumRef },
};
assertEqual(
  navRouteKey(albumRoute),
  navRouteKey(albumRouteCopy),
  'entity key follows ref identity, not object identity',
);
assert(
  navRouteKey(albumRoute) !== navRouteKey(artistRoute),
  'different entity refs keep different keys',
);
assert(
  navRouteKey({ type: 'corrections' }) !== navRouteKey({ type: 'transfer' }),
  'payload-less shell routes key on their type',
);
const syncA = { type: 'sync', extra: 1 };
const syncB = { type: 'sync', extra: 2 };
assert(
  navRouteKey(syncA) !== navRouteKey(syncB),
  'extension overlays keep their serialized shape',
);

assert(
  sameNavLocation(
    { tab: 'library', routes: [likedRoute, albumRoute] },
    {
      tab: 'library',
      routes: [likedRoute, albumRouteCopy],
    },
  ),
  'a restored stack names the same location',
);
assert(
  !sameNavLocation(
    { tab: 'home', routes: [] },
    { tab: 'home', routes: [likedRoute] },
  ) &&
    !sameNavLocation(
      { tab: 'library', routes: [likedRoute] },
      { tab: 'library', routes: [top50Route] },
    ),
  'different stacks or payloads are different locations',
);
assert(
  !sameNavLocation(
    { tab: 'home', routes: [] },
    { tab: 'library', routes: [] },
  ),
  'the tab is part of the location',
);

// ---- searchRowTarget ------------------------------------------------
// Merged local rows key by `local:<recordingId>` — their actions need
// a recording target, not the provider meta the catalog map holds.
{
  const meta: TrackMetadata = {
    sourceRef: { provider: 'ytm', kind: 'track', id: 's1' },
    title: 'provider hit',
    artist: 'a',
    album: null,
    durationMs: 60_000,
    releaseYear: null,
    artwork: [],
    explicit: null,
    genre: null,
    storefront: null,
  };
  const metaFor = (key: string): TrackMetadata | undefined =>
    key === 'ytm:track:s1:0' ? meta : undefined;

  assertDeepEqual(
    searchRowTarget('local:rec-9', metaFor),
    { kind: 'recording', recordingId: 'rec-9' },
    'a local row targets its recording',
  );
  assertDeepEqual(
    searchRowTarget('ytm:track:s1:0', metaFor),
    { kind: 'metadata', meta },
    'a provider row targets its metadata',
  );
  assertEqual(
    searchRowTarget('deezer:track:missing:0', metaFor),
    null,
    'a key with no meta resolves to null — actions stay inert',
  );
}

console.log('app-shell tests passed');
