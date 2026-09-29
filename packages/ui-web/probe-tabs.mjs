// Evidence probe: what does a stage-mode switch actually re-render?
// Mounts NowPlayingScreen on jsdom with a large queue + synced lyrics,
// then drives mode switches via the `mode` prop (same path as
// onModeChange → setStageMode). Per commit it records React Profiler
// durations and DOM mutation counts (add/remove = real mounts).
// Run from apps/desktop (which owns the jsdom devDep):
//   cd apps/desktop && node ../../packages/ui-web/probe-tabs.mjs
// or let the repo-root node_modules resolve it — ui-web itself does
// not declare jsdom, so an isolated per-package install can't run it.
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

const {
  NowPlayingScreen,
} = await import('./src/now-playing-screen.tsx');
const { ThemeProvider } = await import('./src/theme.tsx');
const {
  fixturePlayerPlaying,
  fixtureRecordings,
  fixtureLikes,
} = await import('@auqw/ui-shared/fixtures');
const { toQueueModel } = await import('@auqw/ui-shared');

// A 160-occurrence queue — realistic for an album+playlist session.
const occurrences = Array.from({ length: 160 }, (_, i) => ({
  occurrenceId: `occ-${i}`,
  recordingId: fixtureRecordings[i % fixtureRecordings.length].id,
  selectedRef: null,
}));
const queue = toQueueModel({
  queue: {
    revision: 1,
    occurrences,
    currentOccurrenceId: 'occ-1',
    positionMs: 90_000,
    mode: 'playing',
  },
  recordings: fixtureRecordings,
  likes: fixtureLikes,
});
const lyrics = {
  state: 'synced',
  lines: Array.from({ length: 80 }, (_, i) => `line ${i} of the song`),
  activeIndex: 12,
  syncLabel: 'synced · probe',
  message: null,
};

const container = document.createElement('div');
document.body.appendChild(container);

// ---- instrumentation ------------------------------------------------
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
const noop = () => {};
const props = {
  player: fixturePlayerPlaying,
  queue,
  lyrics,
  onModeChange: noop,
  onPressQueueItem: noop,
  onRemoveQueueItem: noop,
  onMoveQueueItem: noop,
  onMoveQueueItemTo: noop,
};

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
    `${label.padEnd(28)} ${ms.toFixed(1).padStart(6)}ms wall` +
    ` | commits ${commits.length} | render ${actual.toFixed(1)}ms` +
    ` (unmemoized total ${base.toFixed(1)}ms)` +
    ` | dom +${mutations.added} -${mutations.removed}`,
  );
}

const el = (mode) =>
  h(Profiler, { id: 'stage', onRender },
    h(ThemeProvider, { theme: 'dark' },
      h(NowPlayingScreen, { ...props, mode })));

await step('mount mode=player', () => root.render(el('player')));
await step('player -> lyrics (1st)', () => root.render(el('lyrics')));
await step('lyrics -> queue (1st)', () => root.render(el('queue')));
await step('queue -> player', () => root.render(el('player')));
await step('player -> lyrics (2nd)', () => root.render(el('lyrics')));
await step('lyrics -> queue (2nd)', () => root.render(el('queue')));
await step('queue -> queue (no-op)', () => root.render(el('queue')));
// Same-mode re-render at a new positionMs (a position tick while in
// queue mode — happens every engine tick in the real app).
await step('tick in queue mode', () =>
  root.render(
    h(Profiler, { id: 'stage', onRender },
      h(ThemeProvider, { theme: 'dark' },
        h(NowPlayingScreen, {
          ...props,
          mode: 'queue',
          player: { ...fixturePlayerPlaying, positionMs: 100_000 },
        }))),
  ));
console.log('done');
process.exit(0);
