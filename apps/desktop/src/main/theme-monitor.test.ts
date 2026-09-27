import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assert, assertDeepEqual, assertEqual } from '@auqw/application/testing';
import { CHANNELS } from '../shared/channels.ts';
import { isThemeSourceEvent } from '../shared/contract.ts';
import {
  createThemeMonitor,
  parseKdeGlobals,
  parseOmarchyColors,
  parsePortalAccent,
} from './theme-monitor.ts';
import type { ThemeSourceEnv } from './theme-monitor.ts';
import type { NetSender } from './net-monitor.ts';

class CollectingSender implements NetSender {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
}

/** Sender with the WebContents lifecycle events — destroyed/navigate. */
class NavigableSender extends CollectingSender {
  private listeners = new Map<string, (() => void)[]>();
  on(event: string, listener: () => void): void {
    const cbs = this.listeners.get(event) ?? [];
    cbs.push(listener);
    this.listeners.set(event, cbs);
  }
  off(event: string, listener: () => void): void {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((cb) => cb !== listener),
    );
  }
  navigate(): void {
    for (const cb of this.listeners.get('did-navigate') ?? []) {
      cb();
    }
  }
  crash(): void {
    for (const cb of this.listeners.get('render-process-gone') ?? []) {
      cb();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const OMARCHY_STATE = '.local/state/omarchy/current/theme/colors.toml';
const OMARCHY_CONFIG = '.config/omarchy/current/theme/colors.toml';
const KDE_GLOBALS = '.config/kdeglobals';

/** In-memory env: files is a mutable map so tests can edit "on disk". */
function env(overrides: Partial<ThemeSourceEnv> = {}): {
  env: ThemeSourceEnv;
  files: Map<string, string>;
  fireWatch: (path: string) => void;
  fireSystem: () => void;
} {
  const files = new Map<string, string>();
  const watchers = new Map<string, (() => void)[]>();
  const systemCbs: (() => void)[] = [];
  const base: ThemeSourceEnv = {
    platform: 'linux',
    home: '/home/test',
    env: {},
    readFileSync: (path) => files.get(path) ?? null,
    execFile: async () => null,
    watch: (path, onChange) => {
      const cbs = watchers.get(path) ?? [];
      cbs.push(onChange);
      watchers.set(path, cbs);
      return () =>
        watchers.set(
          path,
          (watchers.get(path) ?? []).filter((cb) => cb !== onChange),
        );
    },
    darkFlag: () => true,
    systemAccent: () => null,
    onSystemChange: (cb) => {
      systemCbs.push(cb);
      return () => systemCbs.splice(systemCbs.indexOf(cb), 1);
    },
    ...overrides,
  };
  return {
    env: base,
    files,
    fireWatch: (path) => {
      for (const cb of watchers.get(path) ?? []) {
        cb();
      }
    },
    fireSystem: () => {
      for (const cb of [...systemCbs]) {
        cb();
      }
    },
  };
}

const OMARCHY_TOML = `mode = "dark"
background = "#1a1b26"
foreground = "#c0caf5"
accent = "#7aa2f7"
selection = "#283457"
red = "#f7768e"
`;

const KDE_GLOBALS_TEXT = `[General]
Name=Breeze
AccentColor=61,174,233

[Colors:Window]
BackgroundNormal=35,38,41
ForegroundNormal=239,240,241

[Colors:Selection]
BackgroundNormal=61,174,233
`;

export async function run(): Promise<void> {
  // --- parsers -------------------------------------------------------
  const omarchy = parseOmarchyColors(OMARCHY_TOML);
  assertDeepEqual(
    omarchy,
    {
      bg: '#1a1b26',
      fg: '#c0caf5',
      accent: '#7aa2f7',
      warn: '#f7768e',
      sel: '#283457',
    },
    'omarchy colors.toml maps onto the palette',
  );
  assertEqual(parseOmarchyColors('mode = "dark"'), null, 'bg/fg required');
  assertDeepEqual(
    parseOmarchyColors('background = "#000000"\nforeground = "#ffffff"\n'),
    { bg: '#000000', fg: '#ffffff' },
    'sparse omarchy still parses',
  );

  const kde = parseKdeGlobals(KDE_GLOBALS_TEXT);
  assertDeepEqual(
    kde,
    {
      bg: '#232629',
      fg: '#eff0f1',
      accent: '#3daee9',
      sel: '#3daee9',
    },
    'kdeglobals colors map onto the palette',
  );
  // AccentColor=followsColorScheme → falls back to the selection color.
  const follow = parseKdeGlobals(
    KDE_GLOBALS_TEXT.replace('AccentColor=61,174,233', 'AccentColor='),
  );
  assertDeepEqual(
    follow,
    { bg: '#232629', fg: '#eff0f1', accent: '#3daee9', sel: '#3daee9' },
    'followsColorScheme resolves accent from selection',
  );
  assertEqual(
    parseKdeGlobals('[Colors:Window]\nBackgroundNormal=1,2,3\n'),
    null,
    'missing fg rejects the palette',
  );

  const gdbus =
    '(<<<(0.81176470588235293, 0.44313725490196076, 0.090196078431372548)>>>)';
  assertEqual(
    parsePortalAccent(gdbus),
    '#cf7117',
    'portal accent parses from gdbus output',
  );
  assertEqual(parsePortalAccent('Error: no such'), null);

  // --- service lifecycle --------------------------------------------
  {
    // No source → flag-only source pushed on attach.
    const rig = env();
    const monitor = createThemeMonitor({ env: rig.env, pollMs: 10 });
    const sender = new CollectingSender();
    monitor.attach(sender);
    await sleep(0); // the first read resolves off the microtask queue
    assertEqual(sender.sent.length, 1);
    const event = sender.sent[0];
    assertEqual(event?.channel, CHANNELS.themeEvents);
    assert(isThemeSourceEvent(event?.payload), 'payload validates');
    assertDeepEqual(
      event?.payload,
      { source: { scheme: 'dark' } },
      'empty env reports the flag only',
    );
    monitor.detach(sender);
    monitor.stop();
  }

  {
    // Omarchy state dir wins; a file change pushes the new source.
    const rig = env();
    rig.files.set(`/home/test/${OMARCHY_STATE}`, OMARCHY_TOML);
    const monitor = createThemeMonitor({ env: rig.env, pollMs: 10 });
    const sender = new CollectingSender();
    monitor.attach(sender);
    await sleep(0);
    assertEqual(sender.sent.length, 1);
    assertDeepEqual(sender.sent[0]?.payload, {
      source: {
        scheme: 'dark',
        palette: {
          bg: '#1a1b26',
          fg: '#c0caf5',
          accent: '#7aa2f7',
          warn: '#f7768e',
          sel: '#283457',
        },
      },
    });
    rig.files.set(
      `/home/test/${OMARCHY_STATE}`,
      OMARCHY_TOML.replace('#7aa2f7', '#bb9af7'),
    );
    rig.fireWatch(`/home/test/${OMARCHY_STATE}`);
    await sleep(0);
    assertEqual(sender.sent.length, 2, 'watched file change pushes');
    const event = sender.sent[1];
    assert(isThemeSourceEvent(event?.payload), 'update validates');
    assertDeepEqual(
      (event?.payload as { source: { palette: { accent: string } } })
        .source.palette.accent,
      '#bb9af7',
    );
    monitor.stop();
  }

  {
    // Poll catches changes a watcher misses (symlink retarget, accent).
    const rig = env();
    rig.files.set(`/home/test/${OMARCHY_CONFIG}`, OMARCHY_TOML);
    const monitor = createThemeMonitor({ env: rig.env, pollMs: 10 });
    const sender = new CollectingSender();
    monitor.attach(sender);
    await sleep(0);
    rig.files.set(
      `/home/test/${OMARCHY_CONFIG}`,
      OMARCHY_TOML.replace('#1a1b26', '#24283b'),
    );
    await sleep(40);
    assertEqual(sender.sent.length, 2, 'poll picks up the change');
    monitor.stop();
  }

  {
    // Same source re-delivered is deduped; last detach stops polling.
    const rig = env();
    rig.files.set(`/home/test/${OMARCHY_CONFIG}`, OMARCHY_TOML);
    const monitor = createThemeMonitor({ env: rig.env, pollMs: 10 });
    const a = new CollectingSender();
    const b = new CollectingSender();
    monitor.attach(a);
    monitor.attach(b);
    await sleep(0);
    rig.fireSystem();
    await sleep(0);
    assertEqual(a.sent.length, 1, 'unchanged source not re-pushed');
    assertEqual(b.sent.length, 1);
    monitor.detach(a);
    rig.files.set(
      `/home/test/${OMARCHY_CONFIG}`,
      OMARCHY_TOML.replace('#7aa2f7', '#9ece6a'),
    );
    await sleep(40);
    assertEqual(a.sent.length, 1, 'detached sender stops hearing pushes');
    assertEqual(b.sent.length, 2, 'second subscriber still hears it');
    monitor.detach(b);
    rig.files.set(
      `/home/test/${OMARCHY_CONFIG}`,
      OMARCHY_TOML.replace('#7aa2f7', '#e0af68'),
    );
    await sleep(40);
    assertEqual(a.sent.length, 1, 'zero subscribers stops the poll');
    assertEqual(b.sent.length, 2);
    monitor.stop();
  }

  {
    // KDE host: kdeglobals is read, portal gdbus is not consulted.
    const rig = env({ env: { XDG_CURRENT_DESKTOP: 'KDE' } });
    rig.files.set(`/home/test/${KDE_GLOBALS}`, KDE_GLOBALS_TEXT);
    const gdbusCalls: string[] = [];
    rig.env = {
      ...rig.env,
      execFile: async (file) => {
        gdbusCalls.push(file);
        return null;
      },
    };
    const monitor = createThemeMonitor({ env: rig.env, pollMs: 10 });
    const sender = new CollectingSender();
    monitor.attach(sender);
    await sleep(0);
    assertDeepEqual(sender.sent[0]?.payload, {
      source: {
        scheme: 'dark',
        palette: {
          bg: '#232629',
          fg: '#eff0f1',
          accent: '#3daee9',
          sel: '#3daee9',
        },
      },
    });
    assertEqual(gdbusCalls.length, 0, 'kde path skips the portal call');
    monitor.stop();
  }

  {
    // GNOME: portal accent read via gdbus → accent-only palette.
    const rig = env();
    rig.env = {
      ...rig.env,
      execFile: async (file, args) =>
        file === 'gdbus' && args.includes('accent-color')
          ? '(<<<(0.20784313725490197, 0.5176470588235295, 0.8941176470588236)>>>)'
          : null,
    };
    const monitor = createThemeMonitor({ env: rig.env, pollMs: 10 });
    const sender = new CollectingSender();
    monitor.attach(sender);
    await sleep(0);
    assertDeepEqual(sender.sent[0]?.payload, {
      source: { scheme: 'dark', palette: { accent: '#3584e4' } },
    });
    monitor.stop();
  }

  {
    // win32: systemPreferences accent only.
    const rig = env({
      platform: 'win32',
      systemAccent: () => '#0078d4',
    });
    const monitor = createThemeMonitor({ env: rig.env, pollMs: 10 });
    const sender = new CollectingSender();
    monitor.attach(sender);
    await sleep(0);
    assertDeepEqual(sender.sent[0]?.payload, {
      source: { scheme: 'dark', palette: { accent: '#0078d4' } },
    });
    monitor.stop();
  }

  {
    // Light flag survives palette-only sources; send-failure drops the
    // sender so later pushes can't throw.
    const rig = env({ darkFlag: () => false });
    rig.files.set(`/home/test/${OMARCHY_CONFIG}`, OMARCHY_TOML);
    const monitor = createThemeMonitor({ env: rig.env, pollMs: 10 });
    const sender = new CollectingSender();
    monitor.attach(sender);
    await sleep(0);
    assertDeepEqual(sender.sent[0]?.payload, {
      source: {
        scheme: 'light',
        palette: {
          bg: '#1a1b26',
          fg: '#c0caf5',
          accent: '#7aa2f7',
          warn: '#f7768e',
          sel: '#283457',
        },
      },
    });
    monitor.stop();
  }

  {
    // Renderer navigation/crash inside a live WebContents releases its
    // subscriptions — the replacement document's subscribe pushes the
    // snapshot again.
    const rig = env();
    rig.files.set(`/home/test/${OMARCHY_CONFIG}`, OMARCHY_TOML);
    const monitor = createThemeMonitor({ env: rig.env, pollMs: 10 });
    const sender = new NavigableSender();
    monitor.attach(sender);
    monitor.attach(sender); // refcounted: two logical subscriptions
    await sleep(0);
    assertEqual(sender.sent.length, 1);
    sender.navigate();
    monitor.attach(sender); // replacement document subscribes
    await sleep(0);
    assertEqual(
      sender.sent.length,
      2,
      'a fresh subscribe after navigation gets the snapshot',
    );
    monitor.stop();
  }

  {
    // Triggers during an in-flight source read coalesce into a single
    // trailing run — a hanging portal must not stack gdbus processes.
    const rig = env();
    const resolvers: Array<(v: string | null) => void> = [];
    rig.env = {
      ...rig.env,
      execFile: () =>
        new Promise<string | null>((resolve) => resolvers.push(resolve)),
    };
    const monitor = createThemeMonitor({ env: rig.env, pollMs: 10 });
    const sender = new CollectingSender();
    monitor.attach(sender);
    rig.fireSystem();
    rig.fireSystem();
    rig.fireSystem();
    resolvers[0]?.(
      '(<<<(0.20784313725490197, 0.5176470588235295, 0.8941176470588236)>>>)',
    );
    await sleep(0);
    assertEqual(resolvers.length, 2, 'three triggers fold to one rerun');
    resolvers[1]?.(
      '(<<<(0.20784313725490197, 0.5176470588235295, 0.8941176470588236)>>>)',
    );
    await sleep(0);
    assertEqual(sender.sent.length, 1, 'identical rerun stays deduped');
    monitor.stop();
  }

  {
    // A real writable HOME exercises the injected fs seams end to end.
    const dir = mkdtempSync(join(tmpdir(), 'auqw-theme-'));
    try {
      const path = join(dir, OMARCHY_CONFIG);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, OMARCHY_TOML);
      const rig = env({
        home: dir,
        readFileSync: (p) => {
          try {
            return readFileSync(p, 'utf8');
          } catch {
            return null;
          }
        },
        watch: (p, onChange) => {
          try {
            const watcher = watch(p, { persistent: false }, onChange);
            return () => watcher.close();
          } catch {
            return null;
          }
        },
      });
      const monitor = createThemeMonitor({ env: rig.env, pollMs: 10 });
      const sender = new CollectingSender();
      monitor.attach(sender);
      await sleep(0);
      assertEqual(sender.sent.length, 1);
      writeFileSync(path, OMARCHY_TOML.replace('#7aa2f7', '#7dcfff'));
      await sleep(80);
      assertEqual(sender.sent.length, 2, 'fs.watch pushes a real change');
      monitor.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
