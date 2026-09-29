/**
 * useAppShell referential-stability regression. The sheet-close and
 * picker callbacks the hook returns feed dep arrays downstream —
 * mobile's hardware-back effect re-subscribes its native listener when
 * one changes identity, and every SheetScreen takes them as
 * onDismiss/onDismissed props. When the extraction returned them as
 * per-render closures the listener was torn down and re-added on EVERY
 * render. This mounts the hook under jsdom, forces a re-render through
 * the connectivity edge, and asserts every function-valued return keeps
 * identity.
 *
 * The hook reads no DOM itself — react-dom just needs `document` to
 * render into. jsdom/react-dom are desktop devDeps already, so the test
 * lives beside the other DOM test rather than adding the pair to
 * packages/app-shell. The globals install inside run() and restore on
 * exit so the rest of the suite still runs node-native.
 */
import { assert, assertEqual } from '@auqw/application/testing';
import { JSDOM } from 'jsdom';
import type {
  DownloadManager,
  ReadySession,
  Session,
  StoragePort,
} from '@auqw/application';
import { useAppShell } from '@auqw/app-shell';
import type { AppShellDeps } from '@auqw/app-shell';
import {
  fixtureEntities,
  fixtureEntitySourceRefs,
  fixtureImportPreview,
  fixtureLikes,
  fixturePlayCounts,
  fixturePlayHistory,
  fixturePlaylistEntries,
  fixturePlaylists,
  fixtureQueue,
  fixtureRecordings,
  fixtureSettings,
} from '@auqw/ui-shared/fixtures';

const GLOBALS = [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
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
  env['IS_REACT_ACT_ENVIRONMENT'] = true;
  try {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');

    const state: ReadySession = {
      type: 'ready',
      recordings: fixtureRecordings,
      likes: fixtureLikes,
      entities: fixtureEntities,
      entitySourceRefs: fixtureEntitySourceRefs,
      playlists: fixturePlaylists,
      playlistEntries: fixturePlaylistEntries,
      playHistory: fixturePlayHistory,
      playCounts: fixturePlayCounts,
      queue: fixtureQueue,
      settings: fixtureSettings,
      playback: { type: 'idle' },
      repeat: 'off',
      shuffle: false,
      shuffleOrder: null,
      radio: null,
    };
    // Only the members the hook touches while idle are real — the op
    // surface is callback-invoked and never fires in this test.
    const session = {
      subscribePosition: () => () => {},
      positionMs: () => 0,
      snapshot: () => state,
    } as unknown as Session;
    const downloads = {
      list: () => [],
      subscribe: () => () => {},
      usage: () =>
        Promise.resolve({ ok: true, value: { bytes: 0, free: 0 } }),
      recordFor: () => null,
      fileFor: () => null,
    } as unknown as DownloadManager;
    const storage = {
      loadAttempts: () => Promise.resolve({ ok: true, value: [] }),
    } as unknown as Pick<StoragePort, 'loadAttempts'>;
    const controller = {
      session,
      storage,
      providers: [],
      downloads,
      local: () => null,
      replaceLibrary: () =>
        Promise.resolve({ ok: true as const, value: fixtureImportPreview }),
    };
    let setOnline: ((online: boolean) => void) | null = null;
    const deps: AppShellDeps = {
      controller,
      state,
      ports: {
        subscribeOnline: (set) => {
          setOnline = set;
          set(true);
          return () => {};
        },
        afterLocalMutation: () => {},
        settingsExtras: () => ({
          localSupported: false,
          syncSupported: false,
          syncLabel: null,
        }),
        exportJson: () =>
          Promise.resolve({ kind: 'done', detail: () => 'file.json' }),
      },
    };

    let latest: Record<string, unknown> | null = null;
    const Probe = (props: {
      readonly deps: AppShellDeps;
      readonly tick: number;
    }) => {
      latest = useAppShell(props.deps) as unknown as Record<
        string,
        unknown
      >;
      return null;
    };

    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Probe, { deps, tick: 0 }));
    });
    const first = latest;
    assert(first !== null, 'the hook returned its surface');

    // Re-render with identical hook inputs (fresh props object — a new
    // tick prop defeats the props-identity bailout, deps is the same
    // object). No dep inside the hook changed, so every memoized
    // callback must keep identity; the pre-fix sheet closes were fresh
    // closures and churned the BackHandler subscription each render.
    await act(async () => {
      root.render(createElement(Probe, { deps, tick: 1 }));
    });
    const second = latest;
    assert(second !== null, 'the hook re-rendered');

    for (const key of Object.keys(first)) {
      const a = first[key];
      const b = second[key];
      if (typeof a !== 'function' || typeof b !== 'function') {
        continue;
      }
      assert(
        b === a,
        `${key} must keep identity across renders — consumers list it in effect deps`,
      );
    }

    // The connectivity seam still drives state: a landed edge flips
    // `online` and re-renders the surface.
    await act(async () => {
      setOnline?.(false);
    });
    assertEqual(latest?.['online'], false, 'the online edge landed');

    // And the close callbacks still work: open + close round-trips the
    // row-actions sheet through the returned surface.
    const surface = () =>
      latest as unknown as {
        actionsFor: unknown;
        openRowActions: (target: {
          kind: 'recording';
          recordingId: string;
        }) => void;
        closeRowActions: () => void;
      };
    await act(async () => {
      surface().openRowActions({
        kind: 'recording',
        recordingId: fixtureRecordings[0]?.id ?? 'rec-0',
      });
    });
    assert(surface().actionsFor !== null, 'openRowActions sets the target');
    await act(async () => {
      surface().closeRowActions();
    });
    assert(surface().actionsFor === null, 'closeRowActions clears it');

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
