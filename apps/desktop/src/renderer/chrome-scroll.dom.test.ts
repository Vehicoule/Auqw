/**
 * World-toolbar scroll-fold regression. The bar's search field
 * collapses to its loupe once the world body scrolls — and the
 * capture on `.uw-world__content` sees EVERY descendant scroller
 * (scroll doesn't bubble). The horizontal rails inside a screen
 * report scrollTop 0, which the unguarded handler read as "back at
 * the top" — a rail flick mid-page reopened the field and clobbered
 * the remembered scroll position. This mounts DesktopChrome under
 * jsdom, scrolls the pane then a rail, and asserts the fold only
 * answers the pane's own vertical scroller.
 *
 * jsdom/react-dom are desktop devDeps already, so the test lives
 * beside the other DOM tests rather than adding the pair to
 * packages/ui-web. The globals install inside run() and restore on
 * exit so the rest of the suite still runs node-native.
 */
import { assert } from '@auqw/application/testing';
import { JSDOM } from 'jsdom';
import { register } from 'node:module';
import { setLocale } from '@auqw/ui-shared';
import { fixtureNavItems } from '@auqw/ui-shared/fixtures';

// Strip-types covers .ts; the DesktopChrome import chain hits .tsx
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
  'Event',
  'MutationObserver',
  'ResizeObserver',
  'getComputedStyle',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

export async function run(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const win = dom.window as unknown as {
    document: Document;
    HTMLElement: typeof HTMLElement;
    Element: typeof Element;
    Node: typeof Node;
    Event: typeof Event;
    MutationObserver: typeof MutationObserver;
    getComputedStyle: typeof getComputedStyle;
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
  env['Event'] = win.Event;
  env['MutationObserver'] = win.MutationObserver;
  // jsdom ships no ResizeObserver — the bar-tightness probe stays
  // silent; the scroll fold is what this test exercises.
  env['ResizeObserver'] = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  env['getComputedStyle'] = win.getComputedStyle.bind(win);
  env['IS_REACT_ACT_ENVIRONMENT'] = true;
  try {
    setLocale('en');
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { DesktopChrome } = await import('@auqw/ui-web');
    const h = createElement;

    const field = {
      icon: 'search' as const,
      label: 'search',
      value: '',
      readOnly: false,
      loading: false,
      onChange: (_q: string) => {},
      onSubmit: () => {},
      cancel: null,
      clear: null,
    };

    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        h(
          DesktopChrome,
          {
            tabs: fixtureNavItems,
            activeKey: 'home',
            onSelect: () => {},
            stage: null,
            search: { field, live: false },
          },
          h(
            'div',
            { className: 'uw-screen' },
            h('div', { className: 'uw-rail__cards' }),
          ),
        ),
      );
    });

    const screen = container.querySelector('.uw-screen');
    const rail = container.querySelector('.uw-rail__cards');
    assert(screen !== null && rail !== null, 'the pane tree mounted');
    const loupe = () => container.querySelector('.uw-wsearch--loupe');
    const expanded = () => container.querySelector('.uw-wsearch input');
    assert(
      loupe() === null && expanded() !== null,
      'the field starts expanded at the top',
    );

    // A scroll event reports the target's CURRENT offsets; jsdom
    // elements don't lay out, so the values land by hand.
    const scroll = async (el: Element, top: number, left: number) => {
      Object.defineProperty(el, 'scrollTop', {
        value: top,
        configurable: true,
      });
      Object.defineProperty(el, 'scrollLeft', {
        value: left,
        configurable: true,
      });
      await act(async () => {
        el.dispatchEvent(new win.Event('scroll'));
      });
    };

    await scroll(screen as Element, 100, 0);
    assert(
      loupe() !== null,
      'a pane scroll past the fold collapses the field to its loupe',
    );
    await scroll(rail as Element, 0, 50);
    assert(
      loupe() !== null && expanded() === null,
      'a horizontal rail scroll leaves the fold collapsed',
    );
    await scroll(screen as Element, 0, 0);
    assert(
      expanded() !== null,
      'scrolling the pane back to the top expands the field again',
    );

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
