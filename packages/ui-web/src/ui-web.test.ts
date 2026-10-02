import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { readdirSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import { toQueueModel } from '@auqw/ui-shared';
import {
  fixtureCollectionModels,
  fixtureCorrectionsModel,
  fixtureEntityModel,
  fixtureEntityModelError,
  fixtureHomeModel,
  fixtureLibraryModel,
  fixtureLikes,
  fixtureLyrics,
  fixtureLyricsPlain,
  fixtureNavItems,
  fixturePlayerFailed,
  fixturePlayerPlaying,
  fixturePlaylistModel,
  fixtureQueue,
  fixtureQueueModel,
  fixtureRadioModels,
  fixtureRecordings,
  fixtureUnavailableIds,
  fixtureRowStates,
  fixtureSearchStates,
  fixtureSettingsModel,
  fixtureTransferModelPreview,
} from '@auqw/ui-shared/fixtures';

// Strip-types covers .ts; .tsx goes through the local typescript
// loader registered here — the dynamic import below resolves after it.
register('./tsx-loader.mjs', import.meta.url);

import { downloadButtonView } from '@auqw/ui-shared/controllers';
import { downloadIconState } from '@auqw/ui-shared';

const {
  Artwork,
  AuthSheet,
  CollectionScreen,
  CorrectionsScreen,
  DesktopChrome,
  DownloadIcon,
  DownloadIconButton,
  EntityScreen,
  HomeScreen,
  Icon,
  LibraryScreen,
  MiniPlayer,
  NameField,
  NowPlayingScreen,
  PairingSheet,
  PlaylistScreen,
  PushScreen,
  QueueScreen,
  RowActionsSheet,
  SearchScreen,
  SettingsScreen,
  Sheet,
  StageSheet,
  StageIdlePane,
  StatusMark,
  ThemeProvider,
  TrackRow,
  TransferScreen,
  WorldPanes,
  WorldSearch,
  applyPendingMove,
  globalKeyAction,
  toSyncPanel,
  idsEqual,
  initialRovingIndex,
  isEditableTarget,
  progressPathState,
  quadPath,
  reconcileFocusIndex,
  reconcilePendingOps,
  rowKeyAction,
  seekStepMs,
  sheetKeyAction,
  PLAY_LEFT,
  PAUSE_LEFT,
} = await import('./index.ts');

let passed = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    console.error(`  FAIL ${name}`);
    process.exitCode = 1;
    return;
  }
  passed++;
}
function assertIncludes(name: string, markup: string, needle: string) {
  check(name, markup.includes(needle));
}

function fixtureField() {
  return {
    icon: 'search' as const,
    label: 'search',
    value: 'neon',
    readOnly: false,
    loading: false,
    onChange: (_q: string) => {},
    onSubmit: () => {},
    cancel: null,
    clear: {
      icon: 'close' as const,
      a11yLabel: 'clear search',
      onPress: () => {},
    },
  };
}

/** Deterministic SSR tree — ThemeProvider fixes the scheme. */
function render(node: ReactNode): string {
  return renderToStaticMarkup(
    h(ThemeProvider, { theme: 'dark', children: node }),
  );
}

// ---- pure interaction logic ----------------------------------------

{
  check('rowKeyAction ArrowDown moves', rowKeyAction('ArrowDown', 0, 5)?.type === 'move');
  const down = rowKeyAction('ArrowDown', 0, 5);
  check('rowKeyAction ArrowDown index', down !== null && down.type === 'move' && down.index === 1);
  const upTop = rowKeyAction('ArrowUp', 0, 5);
  check('rowKeyAction clamps at top (no wrap)', upTop !== null && upTop.type === 'move' && upTop.index === 0);
  const end = rowKeyAction('End', 0, 5);
  check('rowKeyAction End', end !== null && end.type === 'move' && end.index === 4);
  check('rowKeyAction Enter activates', rowKeyAction('Enter', 2, 5)?.type === 'activate');
  check('rowKeyAction Space activates', rowKeyAction(' ', 2, 5)?.type === 'activate');
  check('rowKeyAction ContextMenu opens context', rowKeyAction('ContextMenu', 1, 5)?.type === 'context');
  check('rowKeyAction ignores others (Escape bubbles)', rowKeyAction('Escape', 0, 5) === null);
  check('rowKeyAction empty list Enter is inert', rowKeyAction('Enter', 0, 0) === null);
}
{
  check('initialRovingIndex starts at 0', initialRovingIndex(-1, 4) === 0);
  check('initialRovingIndex empty', initialRovingIndex(-1, 0) === -1);
  check('initialRovingIndex clamps', initialRovingIndex(99, 4) === 3);
  check('reconcileFocusIndex keeps valid index', reconcileFocusIndex(2, 5) === 2);
  check('reconcileFocusIndex clamps shrunk list', reconcileFocusIndex(4, 3) === 2);
  check('reconcileFocusIndex empties at 0', reconcileFocusIndex(4, 0) === -1);
}
{
  const ops = [
    { id: 'A', dir: 1 as const },
    { id: 'A', dir: 1 as const },
  ];
  const partial = reconcilePendingOps(['A', 'B', 'C'], ops, ['B', 'A', 'C']);
  check(
    'reconcilePendingOps partial ack keeps tail',
    partial !== null &&
      partial.ops.length === 1 &&
      idsEqual(partial.ids, ['B', 'C', 'A']),
  );
  const full = reconcilePendingOps(['A', 'B', 'C'], ops, ['B', 'C', 'A']);
  check(
    'reconcilePendingOps full ack clears',
    full !== null && full.ops.length === 0 && idsEqual(full.ids, ['B', 'C', 'A']),
  );
  check(
    'reconcilePendingOps divergent rebases',
    reconcilePendingOps(['A', 'B', 'C'], ops, ['C', 'B', 'A']) === null,
  );
  check(
    'reconcilePendingOps membership change rebases',
    reconcilePendingOps(['A', 'B', 'C'], ops, ['A', 'B']) === null,
  );
  check(
    'applyPendingMove swaps neighbors',
    idsEqual(applyPendingMove(['A', 'B', 'C'], { id: 'A', dir: 1 }), ['B', 'A', 'C']),
  );
  check(
    'applyPendingMove bounds-checks',
    idsEqual(applyPendingMove(['A', 'B'], { id: 'A', dir: -1 }), ['A', 'B']),
  );
}
{
  check('sheetKeyAction Escape closes', sheetKeyAction('Escape') === 'close');
  check('sheetKeyAction ignores others', sheetKeyAction('Enter') === null);
  check('globalKeyAction / focuses search', globalKeyAction('/', null) === 'focus-search');
  check('globalKeyAction ignores other keys', globalKeyAction('a', null) === null);
  check('isEditableTarget SSR-safe (no DOM)', isEditableTarget(null) === false);
}
{
  check('seekStepMs left steps 10s', seekStepMs('ArrowLeft', 30_000, 180_000) === 20_000);
  check('seekStepMs right clamps at duration', seekStepMs('ArrowRight', 175_000, 180_000) === 180_000);
  check('seekStepMs clamps at 0', seekStepMs('ArrowLeft', 5_000, 180_000) === 0);
  check('seekStepMs null duration is inert', seekStepMs('ArrowLeft', 0, null) === null);
}
{
  const path = quadPath(PLAY_LEFT);
  check('quadPath emits closed path', path.startsWith('M') && path.endsWith('Z'));
  check('quadPath morph endpoints differ', quadPath(PLAY_LEFT) !== quadPath(PAUSE_LEFT));
  const atStart = progressPathState(0, 100);
  const atHalf = progressPathState(0.5, 100);
  check('progressPathState 0 hides arc', atStart.opacity === 0 && atStart.dashOffset === 100);
  check('progressPathState halves offset', atHalf.dashOffset === 50);
}

// ---- markup: track row ----------------------------------------------

{
  const row = fixtureRowStates[0];
  check('fixture row exists', row !== undefined);
  const markup = render(
    h(TrackRow, { row: row!, onPress: () => {}, onToggleLike: () => {} }),
  );
  assertIncludes('track row renders title', markup, row!.title);
  check('track row is a listitem', markup.includes('role="listitem"'));
  check('track row main is a button', markup.includes('<button') && markup.includes('uw-track-row__main'));
  check('track row carries state attr', markup.includes(`data-state="${row!.state}"`));
}
{
  const playing = fixtureRowStates.find((r) => r.playing);
  check('fixture has a playing row', playing !== undefined);
  const markup = render(h(TrackRow, { row: playing! }));
  check('playing row flagged', markup.includes('data-playing="true"'));
  check('playing row shows eq overlay', markup.includes('uw-track-row__eq'));
  check('playing row aria-selected', markup.includes('aria-selected="true"'));
}
{
  const base = fixtureRowStates[2]!;
  const stored = { ...base, download: 'stored' as const };
  const markup = render(h(TrackRow, { row: stored }));
  check('download chip state renders', markup.includes('data-chip="stored"'));
  check('download chip reads as downloaded', markup.includes('downloaded'));
}
{
  const liked = fixtureRowStates.find((r) => r.liked);
  check('fixture has a liked row', liked !== undefined);
  const markup = render(h(TrackRow, { row: liked!, onToggleLike: () => {} }));
  check('liked row aria-label mentions liked', markup.includes('unlike'));
}
{
  const row = fixtureRowStates[0]!;
  const markup = render(
    h(TrackRow, {
      row,
      onPress: () => { },
      onAddToPlaylist: () => { },
      onContext: () => { },
    }),
  );
  assertIncludes(
    'row add-to-playlist affordance renders',
    markup,
    'aria-label="add to playlist"',
  );
  assertIncludes('row menu button still renders', markup, 'row actions');
}

// ---- markup: queue ----------------------------------------------------

{
  const markup = render(
    h(QueueScreen, {
      queue: fixtureQueueModel,
      player: fixturePlayerPlaying,
      onPressItem: () => {},
      onRemoveItem: () => {},
    }),
  );
  const titles = fixtureQueueModel.items.map((i) => i.row.title);
  let cursor = -1;
  let ordered = true;
  for (const title of titles) {
    const at = markup.indexOf(title, cursor + 1);
    if (at === -1) {
      ordered = false;
      break;
    }
    cursor = at;
  }
  check('queue renders items in order', ordered);
  check('queue marks current item', markup.includes('now playing'));
  assertIncludes('queue count renders', markup, `${fixtureQueueModel.items.length} tracks`);
  assertIncludes('queue labels the pending section', markup, 'up next');
  check(
    'sections render now-playing then up-next',
    markup.indexOf('now playing') < markup.indexOf('up next'),
  );
  // Repeat occurrences read as a pill, not inline catalog metadata.
  assertIncludes('repeat renders as a pill', markup, 'repeat');
  const subline = markup.indexOf('repeat ·');
  check('repeat stays out of the subtitle', subline === -1);
}
{
  // A mid-queue cursor lists history after the pending entries.
  const mid = toQueueModel({
    queue: {
      ...fixtureQueue,
      currentOccurrenceId: 'occ-4',
      mode: 'paused',
      positionMs: 0,
    },
    recordings: fixtureRecordings,
    likes: fixtureLikes,
    unavailableRecordingIds: fixtureUnavailableIds,
  });
  const markup = render(h(QueueScreen, { queue: mid }));
  assertIncludes('history section renders', markup, 'history');
  const displayTitles = mid.sections.flatMap((section) =>
    section.items.map((item) => item.row.title),
  );
  const nowPlayingAt = markup.indexOf('now playing');
  const upNextAt = markup.indexOf('up next');
  const historyAt = markup.indexOf('history');
  check(
    'section headers order now-playing → up-next → history',
    nowPlayingAt !== -1 &&
      upNextAt !== -1 &&
      historyAt !== -1 &&
      nowPlayingAt < upNextAt &&
      upNextAt < historyAt,
  );
  let cursor = nowPlayingAt;
  let sectioned = cursor !== -1;
  for (const title of displayTitles) {
    const at = markup.indexOf(title, cursor + 1);
    if (at === -1) {
      sectioned = false;
      break;
    }
    cursor = at;
  }
  check('queue renders current → pending → history', sectioned);
}
{
  const markup = render(
    h(QueueScreen, {
      queue: fixtureQueueModel,
      reordering: true,
      onToggleReorder: () => {},
      onMoveItem: () => {},
    }),
  );
  check('reorder mode shows chevron controls', markup.includes('move up'));
}

// ---- markup: settings / diagnostics ------------------------------------

{
  const markup = render(
    h(SettingsScreen, {
      model: fixtureSettingsModel,
      onSelectRow: () => {},
      onToggleRow: () => {},
      onOpenCorrections: () => {},
      sync: toSyncPanel(null, [], null, 1_800_000_000_000),
    }),
  );
  assertIncludes('settings diagnostics lists providers', markup, 'providers');
  assertIncludes('settings diagnostics lists persistence', markup, 'persistence');
  assertIncludes('settings paired-devices placeholder renders', markup, 'paired devices');
  check('settings toggle rows are switches', markup.includes('role="switch"'));
  assertIncludes('settings corrections entry', markup, 'match reviews');
}

{
  const NOW = 1_800_000_000_000;
  const sync = toSyncPanel(
    {
      listener: 'listening',
      endpoint: '192.168.1.20:44100',
      boundPort: 44100,
      advertise: 'announcing',
      pairedDevices: 1,
      sessions: 1,
      lastSyncAt: NOW - 5 * 60_000,
      engine: 'ready',
      name: 'desk',
      fingerprint: 'ab:cd:ef',
    },
    [
      {
        id: 'dev-phone',
        name: 'pixel',
        pairedAt: NOW - 3 * 3_600_000,
        lastSeenAt: NOW - 5_000,
      },
    ],
    null,
    NOW,
  );
  const markup = render(
    h(SettingsScreen, {
      model: fixtureSettingsModel,
      onSelectRow: () => {},
      onToggleRow: () => {},
      onOpenCorrections: () => {},
      sync,
      onPairDevice: () => {},
      onUnpairDevice: () => {},
      onSyncNow: () => {},
      onExportDelta: () => {},
      onImportDelta: () => {},
    }),
  );
  assertIncludes('sync listener state renders', markup, 'listening');
  assertIncludes('sync endpoint renders', markup, '192.168.1.20:44100');
  assertIncludes('sync lastSync renders', markup, '5m ago');
  assertIncludes('sync fingerprint renders', markup, 'ab:cd:ef');
  assertIncludes('sync device row renders', markup, 'pixel');
  assertIncludes('sync pair affordance', markup, 'pair a device');
  assertIncludes('sync trigger affordance', markup, 'sync now');
  assertIncludes('delta exchange renders', markup, 'delta exchange');
  check(
    'unpair press carries the device name',
    markup.includes('aria-label="unpair pixel"'),
  );
}

{
  const markup = render(
    h(SettingsScreen, {
      model: fixtureSettingsModel,
      onSelectRow: () => {},
      onToggleRow: () => {},
      onOpenCorrections: () => {},
      sync: toSyncPanel(null, [], null, 1_800_000_000_000),
    }),
  );
  assertIncludes(
    'a dead sync channel renders its honest state',
    markup,
    'unavailable',
  );
  assertIncludes('paired-devices row still renders', markup, 'paired devices');
}

{
  const markup = render(
    h(PairingSheet, {
      pairing: {
        code: '123456',
        payload: '{"v":1}',
        endpointLabel: '192.168.1.20:48715',
        expiresLabel: 'expires in 4m',
      },
      onCopyPayload: () => {},
      onDismiss: () => {},
    }),
  );
  assertIncludes('pairing code renders', markup, '123456');
  assertIncludes('pairing endpoint renders', markup, '192.168.1.20:48715');
  check('pairing QR renders as svg', markup.includes('<svg'));
  assertIncludes('pairing expiry renders', markup, 'expires in 4m');
  assertIncludes('pairing copy affordance', markup, 'copy payload');
}
{
  const markup = render(
    h(PairingSheet, {
      pairing: null,
      onPairCode: () => { },
      onDismiss: () => { },
    }),
  );
  assertIncludes(
    'typed join renders the host field',
    markup,
    'device address',
  );
  assertIncludes(
    'typed join renders the code field',
    markup,
    '123456',
  );
  assertIncludes('typed join renders the pair button', markup, '>pair<');
}

// ---- markup: now playing / lyrics -----------------------------------------

{
  const markup = render(
    h(NowPlayingScreen, {
      player: fixturePlayerPlaying,
      onStopPlayback: () => {},
    }),
  );
  check(
    'player mode is artwork-led (immersive scope)',
    markup.includes('uw-stage--immersive'),
  );
  check(
    'player mode mounts the backdrop layers',
    markup.includes('uw-stage__backdrop'),
  );
  check(
    'player mode floats the mode segment',
    markup.includes('uw-stage__segment'),
  );
  check(
    'stage carries the stop/dismiss control',
    markup.includes('uw-stage__stop'),
  );
  assertIncludes('stop control has a11y label', markup, 'stop and dismiss');
}
{
  const markup = render(
    h(NowPlayingScreen, {
      player: fixturePlayerPlaying,
      mode: 'lyrics',
      lyrics: fixtureLyrics,
    }),
  );
  check(
    'lyrics mode stays flat (no artwork backdrop)',
    !markup.includes('uw-stage--immersive'),
  );
  for (const line of fixtureLyrics.lines.slice(0, 3)) {
    assertIncludes('lyrics line renders', markup, line.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
  }
  check('synced lyrics mark active line', markup.includes('uw-lyrics__line--active'));
}
{
  const markup = render(
    h(NowPlayingScreen, {
      player: fixturePlayerPlaying,
      mode: 'lyrics',
      lyrics: fixtureLyricsPlain,
    }),
  );
  check('plain lyrics never get the active class', !markup.includes('uw-lyrics__line--active'));
}
{
  const markup = render(
    h(NowPlayingScreen, {
      player: fixturePlayerFailed,
      radio: fixtureRadioModels[4]!,
    }),
  );
  check('failed radio renders its label', markup.includes('radio'));
}

// ---- markup: sheets ---------------------------------------------------------

{
  const open = render(
    h(
      Sheet,
      {
        open: true,
        label: 'actions',
        onDismiss: () => {},
        children: h(RowActionsSheet, {
          title: 'Dracula',
          actions: [{ key: 'add', label: 'add to playlist', icon: 'list-plus' }],
        }),
      },
    ),
  );
  check('open sheet mounts a dialog', open.includes('role="dialog"'));
  assertIncludes('sheet row renders action', open, 'add to playlist');
  const closed = render(
    h(Sheet, {
      open: false,
      label: 'actions',
      onDismiss: () => {},
      children: h(RowActionsSheet, { title: 'x', actions: [] }),
    }),
  );
  check('closed sheet unmounts content', !closed.includes('role="dialog"'));
}
{
  const expanded = render(
    h(StageSheet, {
      player: fixturePlayerPlaying,
      expanded: true,
      onExpandChange: () => {},
      lyrics: fixtureLyrics,
    }),
  );
  check('expanded stage sheet mounts', expanded.includes('role="dialog"'));
  check(
    'expanded stage sheet takes focus on mount',
    expanded.includes('tabindex="-1"'),
  );
  const collapsed = render(
    h(StageSheet, {
      player: fixturePlayerPlaying,
      expanded: false,
      onExpandChange: () => {},
    }),
  );
  check('collapsed stage sheet unmounts', !collapsed.includes('role="dialog"'));
}
{
  const markup = render(
    h(PushScreen, {
      stackKey: 'entity',
      onDismissed: () => {},
      children: h('div'),
    }),
  );
  check('push host renders', markup.includes('uw-push'));
  check(
    'push host takes focus on mount',
    markup.includes('tabindex="-1"'),
  );
}
{
  const emptyQueue = toQueueModel({
    queue: { ...fixtureQueue, occurrences: [], currentOccurrenceId: null },
    recordings: fixtureRecordings,
    likes: fixtureLikes,
    unavailableRecordingIds: fixtureUnavailableIds,
  });
  const markup = render(h(QueueScreen, { queue: emptyQueue }));
  assertIncludes('empty queue state renders', markup, 'queue is empty');
  assertIncludes(
    'empty queue points at the next action',
    markup,
    'add-to-queue action',
  );
}

// ---- markup: search ------------------------------------------------------------

{
  const ready = fixtureSearchStates.find((s) => s.phase === 'ready');
  check('fixture has a ready search state', ready !== undefined);
  const markup = render(
    h(SearchScreen, {
      state: ready!,
      onQueryChange: () => {},
      onResultPress: () => {},
    }),
  );
  assertIncludes('search results header', markup, 'all results');
  check(
    'results table head renders the column labels',
    markup.includes('uw-search__thead'),
  );
  check('search result rows render as listitems', markup.includes('role="listitem"'));
  // The one search field lives in the toolbar — the pane carries no
  // second input (single-search rule).
  check('search pane carries no in-body field', !markup.includes('type="search"'));
}
{
  const collapsed = render(
    h(WorldSearch, {
      field: fixtureField(),
      live: true,
      collapsed: true,
      onExpand: () => {},
    }),
  );
  check('collapsed search renders the loupe', collapsed.includes('uw-wsearch--loupe'));
  check('live query tints the loupe', collapsed.includes('data-live'));
  const expanded = render(
    h(WorldSearch, {
      field: fixtureField(),
      live: false,
      collapsed: false,
      onExpand: () => {},
    }),
  );
  check('expanded search renders the input', expanded.includes('uw-wsearch__input'));
  check('expanded search draws the comet ring', expanded.includes('uw-wsearch__ring'));
}

// ---- markup: world panes (keep-alive tab host) --------------------------------

{
  const pane = (key: string) => h('div', null, `pane-${key}`);
  const markup = render(
    h(WorldPanes, {
      keys: ['home', 'explore', 'library', 'settings'],
      activeKey: 'explore',
      renderPane: pane,
    }),
  );
  check(
    'world panes: the active pane renders its content',
    markup.includes('pane-explore'),
  );
  check(
    'world panes: hidden panes mount their wrappers only (content warms post-commit)',
    !markup.includes('pane-home') && !markup.includes('pane-library'),
  );
  check(
    'world panes: hidden wrappers are display:none + inert + aria-hidden',
    markup.includes('display:none') &&
      markup.includes('inert') &&
      markup.includes('aria-hidden="true"'),
  );
}
{
  const markup = render(
    h(WorldPanes, {
      keys: ['home', 'explore'],
      activeKey: 'mystery',
      renderPane: (key: string) => h('div', null, `pane-${key}`),
    }),
  );
  check(
    'world panes: an unknown active key renders through the fallback',
    markup.includes('pane-mystery'),
  );
}

// ---- markup: every screen under one provider (smoke) ----------------------------

{
  const screens: readonly [string, ReactNode][] = [
    ['home', h(HomeScreen, { model: fixtureHomeModel })],
    ['library', h(LibraryScreen, { model: fixtureLibraryModel })],
    [
      'collection',
      h(CollectionScreen, { model: fixtureCollectionModels[0]! }),
    ],
    [
      'playlist',
      h(PlaylistScreen, { model: fixturePlaylistModel }),
    ],
    ['entity', h(EntityScreen, { model: fixtureEntityModel })],
    ['entity error', h(EntityScreen, { model: fixtureEntityModelError, onRetry: () => {} })],
    ['corrections', h(CorrectionsScreen, { model: fixtureCorrectionsModel })],
    ['transfer', h(TransferScreen, { model: fixtureTransferModelPreview })],
    [
      'queue',
      h(QueueScreen, { queue: fixtureQueueModel }),
    ],
    [
      'search',
      h(SearchScreen, { state: fixtureSearchStates[0]! }),
    ],
    [
      'settings',
      h(SettingsScreen, { model: fixtureSettingsModel }),
    ],
    [
      'now playing',
      h(NowPlayingScreen, { player: fixturePlayerPlaying }),
    ],
  ];
  for (const [name, node] of screens) {
    let markup = '';
    try {
      markup = render(node);
    } catch (error) {
      console.error(`  screen ${name} threw`, error);
    }
    check(`screen renders: ${name}`, markup.includes('ui-web'));
  }
}

// ---- markup: chrome / mini player ----------------------------------------------

{
  const markup = render(
    h(DesktopChrome, {
      tabs: fixtureNavItems,
      activeKey: 'home',
      onSelect: () => {},
      onFocusSearch: () => {},
      onOpenSettings: () => {},
      stage: h(NowPlayingScreen, { player: fixturePlayerPlaying }),
      children: h('div'),
    }),
  );
  check('chrome tabs are a nav landmark', markup.includes('<nav'));
  check('chrome marks the active tab', markup.includes('aria-selected="true"'));
  check('chrome renders the stage column', markup.includes('uw-stage-col'));
  check(
    'stage column carries no head strip — chromeless to the top edge',
    !markup.includes('uw-stage-head'),
  );
  check(
    'world toolbar offers the collapse control',
    markup.includes('hide player'),
  );
  check('chrome renders the world toolbar', markup.includes('uw-world-bar'));
  check(
    'chrome has no separate stage stop control',
    !markup.includes('uw-stage-col__stop'),
  );
  check(
    'world tabs use the segment pill language',
    markup.includes('uw-segment--tabs'),
  );
  for (const item of fixtureNavItems) {
    assertIncludes('chrome renders tab', markup, item.label);
  }
}
{
  // Nothing loaded, ended queue on the surface: the stage keeps its
  // chrome — the floating segment stays mounted with queue active.
  const markup = render(
    h(StageIdlePane, { mode: 'queue', queue: fixtureQueueModel }),
  );
  check('idle stage keeps the floating segment', markup.includes('uw-stage__segment'));
  check('idle stage renders the ended queue', markup.includes('uw-queue'));
  check(
    'idle stage marks queue mode on',
    markup.includes('uw-segment__item--on'),
  );
}
{
  // Nothing queued at all: the empty pane, segment still mounted.
  const markup = render(h(StageIdlePane, { mode: 'player' }));
  check('idle stage without queue shows the empty pane', markup.includes('uw-state'));
  check('idle stage without queue keeps the segment', markup.includes('uw-stage__segment'));
}
{
  const markup = render(
    h(MiniPlayer, {
      player: fixturePlayerPlaying,
      onPress: () => {},
      onPlayPause: () => {},
    }),
  );
  check('mini player labels the open action', markup.includes('open player'));
  check('mini player shows progress ring', markup.includes('uw-ring'));
}
{
  const markup = render(h(Icon, { name: 'monitor' }));
  check('monitor icon renders an svg', markup.includes('<svg'));
}
{
  const markup = render(h(Artwork, { url: null, size: 40, monogram: 'TC' }));
  assertIncludes('artwork monogram renders', markup, 'TC');
}
{
  const markup = render(
    h(NameField, {
      value: '',
      placeholder: 'new playlist name',
      onChange: () => {},
      onSubmit: () => {},
    }),
  );
  check('name field renders input', markup.includes('new playlist name'));
}

// ---- provider markup ------------------------------------------------------------

{
  const dark = render(h(HomeScreen, { model: fixtureHomeModel }));
  check('provider emits .ui-web root', dark.includes('ui-web'));
  check('provider emits t-dark class', dark.includes('t-dark'));
}

// ---- destructive-row focus recovery -------------------------------------------------

{
  const { focusTargetAfterRemoval } = await import('./settings-focus.ts');
  const order = [
    'language',
    'sources.music',
    'sources.videos',
    'downloads.clear',
    'sync',
  ];
  const minusMusic = new Set(order.filter((k) => k !== 'sources.music'));
  check(
    'focus recovery: next live row after a middle removal',
    focusTargetAfterRemoval(order, minusMusic, 'sources.music') ===
      'sources.videos',
  );
  const minusTail = new Set(order.filter((k) => k !== 'sync'));
  check(
    'focus recovery: previous row when the tail is removed',
    focusTargetAfterRemoval(order, minusTail, 'sync') === 'downloads.clear',
  );
  check(
    'focus recovery: container fallback when nothing focusable survives',
    focusTargetAfterRemoval(order, new Set(), 'sources.music') === null,
  );
  check(
    'focus recovery: unknown key is a no-op',
    focusTargetAfterRemoval(order, minusMusic, 'never-existed') === null,
  );
}

// ---- animated icons ---------------------------------------------------

// The download icon is one SVG whose layer classes map every chip onto
// the four-phase state machine — SSR emits the full layer stack and the
// phase modifier; the compositor takes it from there.
{
  // Every chip lands on the phase the shared map assigns — the icon
  // can't drift from the state machine both platforms consume.
  for (const chip of [
    'idle',
    'queued',
    'downloading',
    'stored',
    'failed',
    'removing',
  ] as const) {
    const markup = render(h(DownloadIcon, { state: chip }));
    const phase = downloadIconState(chip);
    assertIncludes(`chip ${chip} mounts phase ${phase}`, markup, `uw-dlicon--${phase}`);
    assertIncludes(`chip ${chip} exposes data-phase`, markup, `data-phase="${phase}"`);
    for (const layer of [
      'uw-dlicon__arrow',
      'uw-dlicon__spin',
      'uw-dlicon__ring',
      'uw-dlicon__check',
      'uw-dlicon__warnline',
      'uw-dlicon__warndot',
    ]) {
      assertIncludes(`all morph layers render (${layer})`, markup, layer);
    }
  }
  const still = render(h(DownloadIcon, { state: 'stored', animated: false }));
  assertIncludes(
    'dense-list path carries the no-motion modifier',
    still,
    'uw-dlicon--still',
  );
}
{
  const check = render(h(StatusMark, { kind: 'check' }));
  assertIncludes('check mark mounts its kind', check, 'uw-mark--check');
  assertIncludes('check mark draws on mount', check, 'uw-mark__draw');
  const warn = render(h(StatusMark, { kind: 'warn' }));
  assertIncludes('warn mark mounts its kind', warn, 'uw-mark--warn');
  assertIncludes('warn mark draws triangle + dot', warn, 'uw-mark__dot');
}
{
  // Row chips mount the state machine on its static path — lists render
  // phase-appropriate end states without paying for transitions.
  const busy = { ...fixtureRowStates[2]!, download: 'downloading' as const };
  const markup = render(h(TrackRow, { row: busy }));
  assertIncludes('row chip mounts the icon state machine', markup, 'uw-dlicon');
  assertIncludes(
    'dense list takes the no-motion path',
    markup,
    'uw-dlicon--still',
  );
  assertIncludes('row chip keeps its data state', markup, 'data-chip="downloading"');
}
{
  const storedView = downloadButtonView('stored', () => {});
  const markup = render(h(DownloadIconButton, { view: storedView }));
  assertIncludes('download button carries the chip', markup, 'uw-dlicon--done');
  assertIncludes('stored reads as pressed', markup, 'aria-pressed="true"');
  assertIncludes(
    'button a11y label comes from the view',
    markup,
    'aria-label=',
  );
  const removingView = downloadButtonView('removing', () => {});
  const inert = render(h(DownloadIconButton, { view: removingView }));
  assertIncludes('removing button is inert', inert, 'disabled=""');
}
{
  // Auth sheet: busy rows got the real spinner, terminal states the
  // draw-on marks, retry the honest refresh glyph.
  const starting = render(
    h(AuthSheet, {
      model: {
        state: 'starting',
        userCode: null,
        verificationUrl: null,
        errorMessage: null,
      },
    }),
  );
  assertIncludes('auth starting spins for real', starting, 'uw-spinner');
  const linked = render(
    h(AuthSheet, {
      model: {
        state: 'signed-in',
        userCode: null,
        verificationUrl: null,
        errorMessage: null,
      },
    }),
  );
  assertIncludes('auth linked draws the check', linked, 'uw-mark--check');
  const failed = render(
    h(AuthSheet, {
      model: {
        state: 'failed',
        userCode: null,
        verificationUrl: null,
        errorMessage: 'denied',
      },
    }),
  );
  assertIncludes('auth failure draws the warn mark', failed, 'uw-mark--warn');
}

// ---- source-scan guards -----------------------------------------------------------

{
  const files = readdirSync(new URL('.', import.meta.url))
    .filter((name) => name.endsWith('.tsx') || name.endsWith('.ts'))
    .filter((name) => name !== 'ui-web.test.ts' && name !== 'test-node.d.ts');
  for (const name of files) {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
    check(`${name}: no react-native imports`, !source.includes('react-native'));
  }
  const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  check('styles.css: no hex colors', !/#[0-9a-fA-F]{3,8}\b/.test(styles));
  check('styles.css: no rgb() literals', !/\brgba?\(/.test(styles));
  check('styles.css: consumes token vars', styles.includes('var(--accent)'));

  // Reduced-motion contract for the animated icons: every transition /
  // keyframe sits behind the same `:not([data-reduced-motion='true'])`
  // gate the rest of the motion system uses — `--still` is the
  // opt-out twin for dense lists.
  const reduced = readFileSync(
    new URL('./styles.css', import.meta.url),
    'utf8',
  );
  check(
    'download icon transitions are reduced-motion gated',
    reduced.includes(
      ".ui-web:not([data-reduced-motion='true'])\n  .uw-dlicon:not(.uw-dlicon--still)",
    ),
  );
  check(
    'download icon spin is reduced-motion gated',
    reduced.includes(
      ".ui-web:not([data-reduced-motion='true'])\n  .uw-dlicon--busy:not(.uw-dlicon--still)",
    ),
  );
  check(
    'status marks draw only with motion allowed',
    reduced.includes(
      ".ui-web:not([data-reduced-motion='true']) .uw-mark__draw",
    ),
  );
  check(
    'icon layers scale around the view box, not their bbox',
    styles.includes('transform-box: view-box'),
  );
}

console.log(`ui-web tests passed (${passed} assertions)`);
