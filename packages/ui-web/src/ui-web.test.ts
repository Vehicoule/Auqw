import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { readdirSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import {
  fixtureCollectionModels,
  fixtureCorrectionsModel,
  fixtureEntityModel,
  fixtureEntityModelError,
  fixtureHomeModel,
  fixtureLibraryModel,
  fixtureLyrics,
  fixtureLyricsPlain,
  fixtureNavItems,
  fixturePlayerFailed,
  fixturePlayerPlaying,
  fixturePlaylistModel,
  fixtureQueueModel,
  fixtureRadioModels,
  fixtureRowStates,
  fixtureSearchStates,
  fixtureSettingsModel,
  fixtureTransferModelPreview,
} from '@auqw/ui-shared/fixtures';

// Strip-types covers .ts; .tsx goes through the local typescript
// loader registered here — the dynamic import below resolves after it.
register('./tsx-loader.mjs', import.meta.url);

const {
  Artwork,
  CollectionScreen,
  CorrectionsScreen,
  DesktopSidebar,
  EntityScreen,
  HomeScreen,
  Icon,
  LibraryScreen,
  MiniPlayer,
  NameField,
  NowPlayingScreen,
  PairingSheet,
  PlaylistScreen,
  QueueScreen,
  RowActionsSheet,
  SearchScreen,
  SettingsScreen,
  Sheet,
  StageSheet,
  ThemeProvider,
  TrackRow,
  TransferScreen,
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

// ---- markup: now playing / lyrics -----------------------------------------

{
  const markup = render(
    h(NowPlayingScreen, {
      player: fixturePlayerPlaying,
      mode: 'lyrics',
      lyrics: fixtureLyrics,
    }),
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
  const collapsed = render(
    h(StageSheet, {
      player: fixturePlayerPlaying,
      expanded: false,
      onExpandChange: () => {},
    }),
  );
  check('collapsed stage sheet unmounts', !collapsed.includes('role="dialog"'));
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
  check('search field is an input', markup.includes('type="search"'));
  assertIncludes('search results header', markup, 'matches');
  check('search result rows render as listitems', markup.includes('role="listitem"'));
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
    h(DesktopSidebar, {
      items: fixtureNavItems,
      activeKey: 'home',
      onSelect: () => {},
    }),
  );
  check('sidebar is a nav landmark', markup.includes('<nav'));
  check('sidebar marks the active item', markup.includes('aria-selected="true"'));
  for (const item of fixtureNavItems) {
    assertIncludes('sidebar renders item', markup, item.label);
  }
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
}

console.log(`ui-web tests passed (${passed} assertions)`);
