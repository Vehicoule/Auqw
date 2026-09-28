/**
 * WaveformSeek against a real DOM. The pre-fix control committed a
 * session seek on every `input` event: each move serialized a queue
 * persist plus a transport re-anchor, the publish snapped the thumb
 * back to the last position, and the bar could never actually be
 * dragged. The fix previews while dragging and commits once on
 * release; a disabled flip landing mid-drag (the duration-dropping
 * regression the session seek fix pins at its root) cancels the
 * gesture instead of stranding the fill.
 *
 * jsdom has no layout engine, so `getBoundingClientRect` stays zero —
 * the hover band is untested here and the cases below drive the
 * range input's event surface directly, which is the contract the
 * transport depends on. The DOM globals install inside `run()` and
 * restore on exit so the rest of the suite still runs node-native.
 */
import { assert, assertEqual } from '@auqw/application/testing';
import { JSDOM } from 'jsdom';
import { register } from 'node:module';

// Strip-types covers .ts; the WaveformSeek import chain hits .tsx
// components, which only resolve through the loader ui-web's own
// test entry registers.
register(
  new URL('../../../../packages/ui-web/src/tsx-loader.mjs', import.meta.url),
);

// `navigator` is getter-only on Node's globalThis — leave it; React
// never reads the jsdom UA string anyway.
const GLOBALS = [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'SVGElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

export async function run(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  // The package-local jsdom declaration types `window` as an opaque
  // record — re-view it through the DOM lib types for this test.
  const win = dom.window as unknown as {
    document: Document;
    navigator: Navigator;
    HTMLElement: typeof HTMLElement;
    HTMLInputElement: typeof HTMLInputElement;
    SVGElement: typeof SVGElement;
    Element: typeof Element;
    Node: typeof Node;
    Event: typeof Event;
    MouseEvent: typeof MouseEvent;
    KeyboardEvent: typeof KeyboardEvent;
  };
  const env = globalThis as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const key of GLOBALS) {
    saved.set(key, env[key]);
  }
  env['window'] = win;
  env['document'] = win.document;
  env['HTMLElement'] = win.HTMLElement;
  env['HTMLInputElement'] = win.HTMLInputElement;
  env['SVGElement'] = win.SVGElement;
  env['Element'] = win.Element;
  env['Node'] = win.Node;
  env['Event'] = win.Event;
  env['MouseEvent'] = win.MouseEvent;
  env['KeyboardEvent'] = win.KeyboardEvent;
  env['IS_REACT_ACT_ENVIRONMENT'] = true;
  try {
    // react-dom binds its event system to these globals at import
    // time — the imports stay deferred behind the install.
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { WaveformSeek } = await import('@auqw/ui-web');
    type InputEl = HTMLInputElement;

    /** Drive the controlled input the way React tests must: the
     *  prototype setter moves the DOM value under React's value
     *  tracker, then an `input` event surfaces it through `onChange`. */
    const slide = (input: InputEl, ms: number): void => {
      const proto = win.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      assert(setter !== undefined, 'the input value setter exists');
      setter.call(input, String(ms));
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    };
    const pointer = (input: InputEl, type: string): void => {
      input.dispatchEvent(new win.MouseEvent(type, { bubbles: true }));
    };

    // Drag right then left: moves only preview; each release commits
    // exactly one seek at the released position.
    {
      const container = win.document.createElement('div');
      win.document.body.appendChild(container);
      const root = createRoot(container);
      const seeks: number[] = [];
      const render = (positionMs: number) =>
        createElement(WaveformSeek, {
          positionMs,
          durationMs: 180_000,
          labels: false,
          onSeek: (ms) => seeks.push(ms),
        });
      await act(async () => {
        root.render(render(0));
      });
      const input = container.querySelector('input');
      assert(input !== null, 'the range input rendered');

      await act(async () => {
        pointer(input, 'pointerdown');
      });
      await act(async () => {
        slide(input, 60_000);
      });
      assertEqual(
        input.value,
        '60000',
        'an unkeyed control still previews the live drag',
      );
      await act(async () => {
        slide(input, 120_000);
      });
      assertEqual(
        seeks.length,
        0,
        'dragging only previews — no seeks yet',
      );
      await act(async () => {
        pointer(input, 'pointerup');
      });
      assertEqual(seeks.length, 1, 'release commits once');
      assertEqual(
        seeks[0],
        120_000,
        'the commit lands at the release point',
      );
      // The committed position holds as the shown value until the
      // session publish lands.
      assertEqual(input.value, '120000', 'the fill holds the committed ms');

      // The publish arrives — the hold releases and a backward drag
      // is a fresh gesture.
      await act(async () => {
        root.render(render(120_000));
      });
      await act(async () => {
        pointer(input, 'pointerdown');
      });
      await act(async () => {
        slide(input, 30_000);
      });
      await act(async () => {
        pointer(input, 'pointerup');
      });
      assertEqual(seeks.length, 2, 'a second drag commits once more');
      assertEqual(seeks[1], 30_000, 'backward seeks commit too');
      await act(async () => {
        root.unmount();
      });
    }

    // A duration dropping to null mid-drag — the old session seek
    // publication — disables the input and cancels the gesture; the
    // straggler pointerup commits nothing.
    {
      const container = win.document.createElement('div');
      win.document.body.appendChild(container);
      const root = createRoot(container);
      const seeks: number[] = [];
      await act(async () => {
        root.render(
          createElement(WaveformSeek, {
            positionMs: 10_000,
            durationMs: 180_000,
            labels: false,
            onSeek: (ms) => seeks.push(ms),
          }),
        );
      });
      const input = container.querySelector('input');
      assert(input !== null, 'the range input rendered');
      await act(async () => {
        pointer(input, 'pointerdown');
      });
      await act(async () => {
        slide(input, 90_000);
      });
      await act(async () => {
        root.render(
          createElement(WaveformSeek, {
            positionMs: 10_000,
            durationMs: null,
            labels: false,
            onSeek: (ms) => seeks.push(ms),
          }),
        );
      });
      assert(input.disabled, 'a null duration disables the control');
      await act(async () => {
        pointer(input, 'pointerup');
      });
      assertEqual(
        seeks.length,
        0,
        'a cancelled mid-drag commits nothing — the fill snaps back',
      );
      await act(async () => {
        root.unmount();
      });
    }

    // A pointercancel mid-drag — the gesture the browser aborts on
    // touch OS gestures, ESC, or lost capture — abandons the scrub
    // entirely: the preview must not be consulted as a commit
    // fallback and the fill restores the real position.
    {
      const container = win.document.createElement('div');
      win.document.body.appendChild(container);
      const root = createRoot(container);
      const seeks: number[] = [];
      await act(async () => {
        root.render(
          createElement(WaveformSeek, {
            positionMs: 10_000,
            durationMs: 180_000,
            labels: false,
            onSeek: (ms) => seeks.push(ms),
          }),
        );
      });
      const input = container.querySelector('input');
      assert(input !== null, 'the range input rendered');
      await act(async () => {
        pointer(input, 'pointerdown');
      });
      await act(async () => {
        slide(input, 90_000);
      });
      await act(async () => {
        pointer(input, 'pointercancel');
      });
      assertEqual(
        seeks.length,
        0,
        'a pointercancelled drag commits nothing',
      );
      assertEqual(
        input.value,
        '10000',
        'the fill snaps back to the session position',
      );
      // The gesture is over — a straggler pointerup stays inert.
      await act(async () => {
        pointer(input, 'pointerup');
      });
      assertEqual(seeks.length, 0, 'no straggler commit after cancel');
      await act(async () => {
        root.unmount();
      });
    }

    // Keyboard commits stay immediate — no pointer drag is in flight
    // when ArrowRight steps +10s.
    {
      const container = win.document.createElement('div');
      win.document.body.appendChild(container);
      const root = createRoot(container);
      const seeks: number[] = [];
      await act(async () => {
        root.render(
          createElement(WaveformSeek, {
            positionMs: 5_000,
            durationMs: 180_000,
            labels: false,
            onSeek: (ms) => seeks.push(ms),
          }),
        );
      });
      const input = container.querySelector('input');
      assert(input !== null, 'the range input rendered');
      await act(async () => {
        input.dispatchEvent(
          new win.KeyboardEvent('keydown', {
            bubbles: true,
            key: 'ArrowRight',
          }),
        );
      });
      assertEqual(seeks.length, 1, 'an arrow step commits immediately');
      assertEqual(seeks[0], 15_000, 'ArrowRight steps forward ten seconds');
      await act(async () => {
        root.unmount();
      });
    }

    // The optimistic hold is scoped to the track it was committed on:
    // a track change while the hold is live renders the new track's
    // real position, never the previous track's committed ms.
    {
      const container = win.document.createElement('div');
      win.document.body.appendChild(container);
      const root = createRoot(container);
      const seeks: number[] = [];
      const render = (trackKey: string, positionMs: number, durationMs: number) =>
        createElement(WaveformSeek, {
          positionMs,
          durationMs,
          trackKey,
          labels: false,
          onSeek: (ms) => seeks.push(ms),
        });
      await act(async () => {
        root.render(render('occ-a', 0, 180_000));
      });
      const input = container.querySelector('input');
      assert(input !== null, 'the range input rendered');
      await act(async () => {
        pointer(input, 'pointerdown');
      });
      await act(async () => {
        slide(input, 120_000);
      });
      await act(async () => {
        pointer(input, 'pointerup');
      });
      assertEqual(seeks.length, 1, 'the commit fired');
      assertEqual(input.value, '120000', 'the fill holds the committed ms');
      // The track changes under a live hold: the new track shows its
      // own position at once — no stale seek range, no old fill.
      await act(async () => {
        root.render(render('occ-b', 0, 90_000));
      });
      assertEqual(
        input.value,
        '0',
        'the new track renders its own position, not the held ms',
      );
      await act(async () => {
        root.unmount();
      });
    }

    // A track change mid-drag abandons the gesture: the release must
    // not seek the new track to a position previewed on the old one.
    {
      const container = win.document.createElement('div');
      win.document.body.appendChild(container);
      const root = createRoot(container);
      const seeks: number[] = [];
      const render = (trackKey: string, positionMs: number, durationMs: number) =>
        createElement(WaveformSeek, {
          positionMs,
          durationMs,
          trackKey,
          labels: false,
          onSeek: (ms) => seeks.push(ms),
        });
      await act(async () => {
        root.render(render('occ-a', 10_000, 180_000));
      });
      const input = container.querySelector('input');
      assert(input !== null, 'the range input rendered');
      await act(async () => {
        pointer(input, 'pointerdown');
      });
      await act(async () => {
        slide(input, 120_000);
      });
      // Playback advances to a different track before pointer-up.
      await act(async () => {
        root.render(render('occ-b', 0, 90_000));
      });
      // The still-pressed pointer keeps generating input — a dead
      // gesture must ignore it, not commit it as a keyboard seek.
      await act(async () => {
        slide(input, 30_000);
      });
      assertEqual(
        seeks.length,
        0,
        'a dead pointer’s stray input commits nothing',
      );
      assertEqual(input.value, '0', 'the dead pointer previews nothing');
      await act(async () => {
        pointer(input, 'pointerup');
      });
      assertEqual(
        seeks.length,
        0,
        'a release after a mid-drag track change seeks nothing',
      );
      assertEqual(
        input.value,
        '0',
        'the abandoned gesture restores the new track’s position',
      );
      await act(async () => {
        root.unmount();
      });
    }
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
