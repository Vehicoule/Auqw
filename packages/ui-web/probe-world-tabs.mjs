// Evidence probe: what does a WORLD tab switch actually re-render?
// Mounts the desktop world column's tab-switch contract on jsdom —
// MODE=cond replicates the old `{renderTabScreen(tab)}` conditional
// mount, MODE=alive drives the shipped WorldPanes keep-alive — with a
// realistically sized library, then drives tab changes through the
// same prop the app's `selectTab` → `tab` state feeds it. Per commit
// it records React Profiler durations and DOM mutation counts
// (add/remove = real mounts/unmounts, not reconciles).
// Run from apps/desktop (which owns the jsdom devDep):
//   cd apps/desktop && node ../../packages/ui-web/probe-world-tabs.mjs
import { register } from 'node:module';
register('./src/tsx-loader.mjs', import.meta.url);

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
});
globalThis.MutationObserver = dom.window.MutationObserver;
if (dom.window.Element.prototype.scrollIntoView === undefined) {
  dom.window.Element.prototype.scrollIntoView = () => {};
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act, Profiler } = React;
const h = React.createElement;

const { ThemeProvider } = await import('./src/theme.tsx');
const { HomeScreen } = await import('./src/home-screen.tsx');
const { SearchScreen } = await import('./src/search-screen.tsx');
const { LibraryScreen } = await import('./src/library-screen.tsx');
const { SettingsScreen } = await import('./src/settings-screen.tsx');
// MODE=cond doesn't need the shipped host — import lazily so a
// baseline probe still runs on a checkout without it.
const MODE = process.env.MODE ?? 'cond';
const { WorldPanes } =
  MODE === 'alive'
    ? await import('./src/world-panes.tsx')
    : { WorldPanes: null };
const {
  fixtureRecordings,
  fixtureLikes,
  fixtureEntities,
  fixtureEntitySourceRefs,
  fixturePlaylists,
  fixturePlaylistEntries,
  fixturePlayHistory,
  fixturePlayCounts,
  fixtureSearchResults,
  fixtureSettings,
  fixtureDiagnostics,
} = await import('@auqw/ui-shared/fixtures');
const {
  toLibraryModel,
  toHomeModel,
  toSettingsModel,
  toSearchRowModel,
} = await import('@auqw/ui-shared');

// ---- realistic world -------------------------------------------------
// A grown library: 240 recordings, ~180 track likes, 28 playlists,
// ~24 liked artist/album entities, play history + counts, a few
// downloads — the shape a real 'switch to library' mounts.
const recordings = Array.from({ length: 240 }, (_, i) => ({
  ...fixtureRecordings[i % fixtureRecordings.length],
  id: `rec-${i}`,
  title: `Song ${i}`,
}));
const likes = [
  ...Array.from({ length: 180 }, (_, i) => ({
    entityKind: 'track',
    targetId: `rec-${i}`,
    likedAtMs: 1_700_000_000_000 - i * 60_000,
  })),
  ...fixtureEntities.slice(0, 24).map((entity, i) => ({
    entityKind: entity.kind,
    targetId: entity.entityId,
    likedAtMs: 1_700_000_100_000 - i * 60_000,
  })),
];
const playlists = Array.from({ length: 28 }, (_, i) => ({
  playlistId: `pl-${i}`,
  name: `Playlist ${i}`,
  createdMs: 1_690_000_000_000 - i * 86_400_000,
  updatedMs: 1_700_000_000_000 - i * 86_400_000,
}));
const playlistEntries = playlists.flatMap((pl, i) =>
  Array.from({ length: 12 }, (_, j) => ({
    playlistId: pl.playlistId,
    entryId: `pl-${i}-e${j}`,
    recordingId: `rec-${(i * 12 + j) % recordings.length}`,
    position: j,
    selectedRef: null,
  })),
);
const playHistory = Array.from({ length: 120 }, (_, i) => ({
  eventId: `ev-${i}`,
  recordingId: `rec-${i % recordings.length}`,
  playedMs: 1_700_000_000_000 - i * 3_600_000,
  durationListenedMs: 120_000,
}));
const playCounts = Array.from({ length: 120 }, (_, i) => ({
  recordingId: `rec-${i}`,
  count: 50 - (i % 40),
  lastPlayedMs: 1_700_000_000_000 - i * 3_600_000,
}));

const libraryModel = toLibraryModel({
  recordings,
  likes,
  playlists,
  playlistEntries,
  playHistory,
  playCounts,
  entities: fixtureEntities,
  entitySourceRefs: fixtureEntitySourceRefs,
});
const homeModel = toHomeModel({
  recordings,
  likes,
  suggestions: fixtureSearchResults,
  playback: { type: 'idle' },
  greeting: 'Good evening',
  subline: 'Pick up where you left off',
});
const settingsModel = toSettingsModel(fixtureSettings, fixtureDiagnostics, {
  storageText: '1.2 GB',
  downloadCount: 12,
  localSupported: true,
  syncSupported: true,
  syncLabel: '2 paired',
});
const searchModel = {
  phase: 'ready',
  query: 'roads portishead',
  results: Array.from({ length: 25 }, (_, i) =>
    toSearchRowModel(
      {
        ...fixtureSearchResults[i % fixtureSearchResults.length],
        sourceRef: {
          provider: 'youtube-music',
          kind: 'track',
          id: `ytm-${i}`,
        },
      },
      i,
    ),
  ),
  providerId: 'youtube-music',
  message: null,
  retryable: false,
};

// ---- the app's world column, verbatim shape -------------------------
// The app memoizes one element per tab (deps = every input the JSX
// closes over) and dispatches on key; WorldColumn mirrors that —
// every input here is constant, so each memo holds and a pure tab
// switch hands back identical elements (React bails the pane).
const noop = () => {};
const TAB_KEYS = ['home', 'explore', 'library', 'settings'];
function WorldColumn({ tab }) {
  const homeEl = React.useMemo(
    () =>
      h(HomeScreen, {
        model: homeModel,
        onPressCard: noop,
        onResume: noop,
      }),
    [],
  );
  const exploreEl = React.useMemo(
    () =>
      h(SearchScreen, {
        state: searchModel,
        query: 'roads portishead',
        onQueryChange: noop,
        onSubmit: noop,
        onCancel: noop,
        onRetry: noop,
        onResultPress: noop,
        onRowIntent: noop,
        onAddToPlaylist: noop,
        onContext: noop,
        recents: [],
        onRecentPress: noop,
        suggestions: [],
        onSuggestionPress: noop,
        autoFocus: true,
      }),
    [],
  );
  const libraryEl = React.useMemo(
    () =>
      h(LibraryScreen, {
        model: libraryModel,
        onPressItem: noop,
        onRowIntent: noop,
        onToggleLike: noop,
        onAddToPlaylist: noop,
        onContext: noop,
        onOpenCollection: noop,
        onOpenCard: noop,
        onOpenArtist: noop,
        onCreatePlaylist: noop,
      }),
    [],
  );
  const settingsEl = React.useMemo(
    () =>
      h(SettingsScreen, {
        model: settingsModel,
        onSelectRow: noop,
        onToggleRow: noop,
        onOpenCorrections: noop,
      }),
    [],
  );
  const renderPane = (key) => {
    switch (key) {
      case 'explore':
        return exploreEl;
      case 'library':
        return libraryEl;
      case 'settings':
        return settingsEl;
      default:
        return homeEl;
    }
  };
  // MODE=cond replicates the old `{renderTabScreen(tab)}` conditional
  // mount; MODE=alive drives the shipped WorldPanes keep-alive.
  return MODE === 'alive'
    ? h(WorldPanes, {
        activeKey: tab,
        renderPane,
        keys: TAB_KEYS,
      })
    : h('main', null, renderPane(tab));
}

// ---- instrumentation ------------------------------------------------
const container = document.createElement('div');
document.body.appendChild(container);
const commits = [];
const mutations = { added: 0, removed: 0 };
const mo = new MutationObserver((records) => {
  for (const r of records) {
    mutations.added += r.addedNodes.length;
    mutations.removed += r.removedNodes.length;
  }
});
mo.observe(container, { childList: true, subtree: true });
function onRender(id, phase, actualDuration, baseDuration) {
  commits.push({ phase, actual: actualDuration, base: baseDuration });
}
const root = createRoot(container);

async function step(label, fn) {
  commits.length = 0;
  mutations.added = 0;
  mutations.removed = 0;
  const t0 = performance.now();
  await act(fn);
  const ms = performance.now() - t0;
  const actual = commits.reduce((s, c) => s + c.actual, 0);
  const base = commits.reduce((s, c) => s + c.base, 0);
  console.log(
    `${label.padEnd(30)} ${ms.toFixed(1).padStart(7)}ms wall` +
      ` | commits ${commits.length} | render ${actual.toFixed(1)}ms` +
      ` (unmemoized total ${base.toFixed(1)}ms)` +
      ` | dom +${mutations.added} -${mutations.removed}`,
  );
}

const el = (tab) =>
  h(Profiler, { id: 'world', onRender },
    h(ThemeProvider, { theme: 'dark' },
      h(WorldColumn, { tab })));

console.log(`MODE=${MODE}  recordings=${recordings.length} likes=${likes.length} playlists=${playlists.length}`);
await step('mount tab=home', () => root.render(el('home')));
await step('home -> explore (1st)', () => root.render(el('explore')));
await step('explore -> library (1st)', () => root.render(el('library')));
await step('library -> settings (1st)', () => root.render(el('settings')));
await step('settings -> home (2nd)', () => root.render(el('home')));
await step('home -> explore (2nd)', () => root.render(el('explore')));
await step('explore -> library (2nd)', () => root.render(el('library')));
await step('library -> library (no-op)', () => root.render(el('library')));
await step('library -> explore (3rd)', () => root.render(el('explore')));
console.log('done');
process.exit(0);
