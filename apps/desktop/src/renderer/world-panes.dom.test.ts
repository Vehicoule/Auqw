/**
 * WorldPanes keep-alive regression. The world-tab switch used to be a
 * conditional mount — every navigation paid a full screen inflation
 * (measured 8–48ms per switch on a grown library; see
 * packages/ui-web/probe-world-tabs.mjs). The keep-alive host must hold
 * every visited pane mounted: a switch is a display flip, never a
 * DOM remove. This mounts it under jsdom, drives tab changes, and
 * asserts mount counts, freeze semantics, and the hidden-state
 * accessibility contract.
 *
 * jsdom/react-dom are desktop devDeps already, so the test lives beside
 * the other DOM test rather than adding the pair to packages/ui-web.
 * The globals install inside run() and restore on exit so the rest of
 * the suite still runs node-native.
 */
import { assert, assertEqual } from '@auqw/application/testing';
import { JSDOM } from 'jsdom';
import { register } from 'node:module';

// Strip-types covers .ts; the WorldPanes import chain hits .tsx
// components, which only resolve through the loader ui-web's own
// test entry registers.
register(
  new URL('../../../../packages/ui-web/src/tsx-loader.mjs', import.meta.url),
);

const GLOBALS = [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'Node',
  'MutationObserver',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

export async function run(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const win = dom.window as unknown as {
    document: Document;
    HTMLElement: typeof HTMLElement;
    Element: typeof Element;
    Node: typeof Node;
    MutationObserver: typeof MutationObserver;
  };
  const env = globalThis as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const key of GLOBALS) {
    saved.set(key, env[key]);
  }
  env['window'] = win;
  env['document'] = win.document;
  env['HTMLElement'] = win.HTMLElement;
  env['Element'] = win.Element;
  env['Node'] = win.Node;
  env['MutationObserver'] = win.MutationObserver;
  env['IS_REACT_ACT_ENVIRONMENT'] = true;
  try {
    const { act, createElement, useEffect } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { WorldPanes } = await import('@auqw/ui-web');
    const h = createElement;

    const KEYS = ['home', 'explore', 'library', 'settings'] as const;
    // Per-pane call counts: renderPane invocations prove the element
    // cache froze (hidden panes don't rebuild); mounts prove the DOM
    // survived (a remount would run the effect again).
    const renderCalls = new Map<string, number>();
    const mounts = new Map<string, number>();
    const Pane = ({ paneKey }: { paneKey: string }) => {
      useEffect(() => {
        mounts.set(paneKey, (mounts.get(paneKey) ?? 0) + 1);
      }, [paneKey]);
      return h('div', { 'data-pane': paneKey }, `pane-${paneKey}`);
    };
    const renderPane = (key: string) => {
      renderCalls.set(key, (renderCalls.get(key) ?? 0) + 1);
      return h(Pane, { paneKey: key });
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    let removed = 0;
    const observer = new win.MutationObserver((records) => {
      for (const record of records) {
        removed += record.removedNodes.length;
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    const root = createRoot(container);
    const el = (tab: string) =>
      h(WorldPanes, { keys: KEYS, activeKey: tab, renderPane });

    await act(async () => {
      root.render(el('home'));
    });
    // Mount + the post-commit warm both flush inside act: every pane
    // must have mounted exactly once. The ACTIVE pane rebuilds on
    // every commit (it's live), so only mounts — not build counts —
    // are asserted to be exactly one here.
    for (const key of KEYS) {
      assertEqual(mounts.get(key), 1, `${key} mounted once`);
      assert(
        (renderCalls.get(key) ?? 0) >= 1,
        `${key} built at least once`,
      );
    }
    const wrappers = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>('[data-pane]'),
      ).map((node) => node.parentElement as HTMLElement);
    const hiddenOf = (key: string) =>
      container
        .querySelector<HTMLElement>(`[data-pane="${key}"]`)
        ?.parentElement;
    assertEqual(
      hiddenOf('explore')?.style.display,
      'none',
      'a hidden pane stays display:none',
    );
    assert(
      hiddenOf('explore')?.hasAttribute('inert') === true,
      'a hidden pane is inert — it cannot take focus',
    );
    assertEqual(
      hiddenOf('explore')?.getAttribute('aria-hidden'),
      'true',
      'a hidden pane leaves the a11y tree',
    );
    assert(
      wrappers().length === KEYS.length,
      'every pane keeps its own wrapper',
    );

    // Every switch: zero DOM removes, zero remounts, zero rebuilds of
    // either hidden panes (frozen) or the revealed one (same element
    // handed back when inputs are unchanged is the app's memo layer —
    // here renderPane IS consulted on reveal: assert only the active
    // rebuild happens).
    for (const [from, to] of [
      ['home', 'explore'],
      ['explore', 'library'],
      ['library', 'settings'],
      ['settings', 'home'],
      ['home', 'explore'],
    ] as const) {
      const beforeCalls = new Map(renderCalls);
      await act(async () => {
        root.render(el(to));
      });
      for (const key of KEYS) {
        assertEqual(
          mounts.get(key),
          1,
          `${from} -> ${to}: ${key} must not remount`,
        );
      }
      assertEqual(
        removed,
        0,
        `${from} -> ${to}: a tab switch must not remove DOM`,
      );
      const frozen = KEYS.filter((k) => k !== to);
      for (const key of frozen) {
        assertEqual(
          renderCalls.get(key),
          beforeCalls.get(key),
          `${from} -> ${to}: hidden pane ${key} must stay frozen`,
        );
      }
      assertEqual(
        hiddenOf(to)?.style.display,
        'contents',
        `${to} revealed through display, not a remount`,
      );
    }

    // An activeKey outside the pane list still renders — the column
    // can never blank.
    await act(async () => {
      root.render(el('mystery'));
    });
    assert(
      container.querySelector('[data-pane="mystery"]') !== null,
      'an unknown tab renders through the uncached fallback',
    );

    observer.disconnect();
    await act(async () => {
      root.unmount();
    });
  } finally {
    for (const key of GLOBALS) {
      const prior = saved.get(key);
      if (prior === undefined) {
        delete env[key];
      } else {
        env[key] = prior;
      }
    }
  }
}
