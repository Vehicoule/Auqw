import { CHANNELS } from '../shared/channels.ts';
import type { ThemeSource } from '@auqw/design-tokens/adaptive';
import type { ThemeSourceEvent } from '../shared/contract.ts';
import type { NetSender } from './net-monitor.ts';

type Palette = NonNullable<ThemeSource['palette']>;

/**
 * Platform specifics are injected so the service stays electron-free and
 * testable: `readFileSync`/`execFileSync` return null on any failure
 * (missing file, timed-out gdbus), `watch` returns a stop function or
 * null when the path can't be watched, `darkFlag` is the OS dark-mode
 * boolean, `systemAccent` the win32/darwin accent read, and
 * `onSystemChange` hooks the native 'updated'/'color-changed' events.
 */
export interface ThemeSourceEnv {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly readFileSync: (path: string) => string | null;
  readonly execFileSync: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => string | null;
  readonly watch: (path: string, onChange: () => void) => (() => void) | null;
  readonly darkFlag: () => boolean;
  readonly systemAccent: () => string | null;
  readonly onSystemChange: (cb: () => void) => () => void;
}

/**
 * Subscriptions key off the WebContents, so a renderer restart inside a
 * surviving WebContents (navigation, crash) must release them — the
 * replacement document subscribes afresh and needs the snapshot. The
 * lifecycle mirror is `ipc.ts`'s tx watcher.
 */
export interface ThemeSender extends NetSender {
  on?(
    event: 'destroyed' | 'render-process-gone' | 'did-navigate',
    listener: () => void,
  ): void;
  off?(
    event: 'destroyed' | 'render-process-gone' | 'did-navigate',
    listener: () => void,
  ): void;
}

export interface ThemeMonitor {
  /** Subscribes a sender to `theme:events`; the current source is pushed
      immediately. Refcounted like `net`: the first attach starts the
      platform watchers, the last detach stops them. */
  attach(sender: ThemeSender): void;
  detach(sender: ThemeSender): void;
  stop(): void;
}

const PALETTE_RE = /([A-Za-z_0-9]+)\s*=\s*"([^"\n]+)"/g;

/** Flat `key = "value"` TOML read — Omarchy `colors.toml` carries
    `background`/`foreground`/`accent`/`selection`/`red` (warn) keys. */
export function parseOmarchyColors(text: string): Palette | null {
  const keys = new Map<string, string>();
  for (const match of text.matchAll(PALETTE_RE)) {
    keys.set(match[1]!, match[2]!);
  }
  const bg = keys.get('background');
  const fg = keys.get('foreground');
  const accent = keys.get('accent');
  if (bg === undefined || fg === undefined) {
    return null;
  }
  const palette: { -readonly [K in keyof Palette]?: string } = {
    bg,
    fg,
  };
  if (accent !== undefined) {
    palette.accent = accent;
  }
  const warn = keys.get('red');
  if (warn !== undefined) {
    palette.warn = warn;
  }
  const sel = keys.get('selection');
  if (sel !== undefined) {
    palette.sel = sel;
  }
  return palette;
}

/** INI `[Group]`/`Key=r,g,b` read for `~/.config/kdeglobals`. */
export function parseKdeGlobals(text: string): Palette | null {
  let group = '';
  const window: { bg: string | undefined; fg: string | undefined } = {
    bg: undefined,
    fg: undefined,
  };
  let sel: string | undefined;
  let accent: string | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const header = /^\[(.+)\]$/.exec(trimmed);
    if (header !== null) {
      group = header[1]!;
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq);
    const rgb = kdeRgb(trimmed.slice(eq + 1));
    if (group === 'Colors:Window' && key === 'BackgroundNormal') {
      window.bg = rgb;
    } else if (group === 'Colors:Window' && key === 'ForegroundNormal') {
      window.fg = rgb;
    } else if (group === 'Colors:Selection' && key === 'BackgroundNormal') {
      sel = rgb;
    } else if (group === 'General' && key === 'AccentColor') {
      accent = rgb;
    }
  }
  if (window.bg === undefined || window.fg === undefined) {
    return accent !== null && accent !== undefined
      ? { accent }
      : null;
  }
  const palette: { -readonly [K in keyof Palette]?: string } = {
    bg: window.bg,
    fg: window.fg,
  };
  if (sel !== undefined) {
    palette.sel = sel;
    // KDE selection doubles as the accent when AccentColor is unset or
    // follows the color scheme.
    if (accent === undefined) {
      palette.accent = sel;
    }
  }
  if (accent !== undefined) {
    palette.accent = accent;
  }
  return palette;
}

/** `r,g,b` (or a bare `default`/`followsColorScheme`) → `#rrggbb`. */
function kdeRgb(value: string): string | undefined {
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (
    parts.length < 3 ||
    parts.slice(0, 3).some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return undefined;
  }
  return (
    '#' +
    parts
      .slice(0, 3)
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * `gdbus ... Settings.ReadOne org.freedesktop.appearance accent-color`
 * prints a variant tuple of three 0–1 floats, e.g.
 * `(<<<(0.81176470588235293, 0.44313725490196076, 0.090196078431372548)>>>)`.
 * Returns the accent hex or null when the portal is absent (pre-47,
 * no portal service).
 */
export function parsePortalAccent(stdout: string): string | null {
  const floats = [
    ...stdout.matchAll(/([0-9]*\.[0-9]+)/g),
  ].map((m) => Number(m[1]));
  if (floats.length < 3 || floats.slice(0, 3).some((n) => n < 0 || n > 1)) {
    return null;
  }
  return (
    '#' +
    floats
      .slice(0, 3)
      .map((n) => Math.round(n * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}

const OMARCHY_STATE = '.local/state/omarchy/current/theme/colors.toml';
const OMARCHY_CONFIG = '.config/omarchy/current/theme/colors.toml';
const KDE_GLOBALS = '.config/kdeglobals';
const PORTAL_CMD = 'gdbus';
const PORTAL_ARGS = [
  'call',
  '--session',
  '--dest',
  'org.freedesktop.portal.Desktop',
  '--object-path',
  '/org/freedesktop/portal/desktop',
  '--method',
  'org.freedesktop.portal.Settings.ReadOne',
  'org.freedesktop.appearance',
  'accent-color',
] as const;

/** Reads the best available OS palette for this platform; null when no
    source exposes one (the renderer then falls back to the flag). */
export function readPlatformPalette(env: ThemeSourceEnv): Palette | null {
  if (env.platform === 'win32' || env.platform === 'darwin') {
    const accent = env.systemAccent();
    return accent !== null ? { accent } : null;
  }
  if (env.platform !== 'linux') {
    return null;
  }
  for (const rel of [OMARCHY_STATE, OMARCHY_CONFIG]) {
    const text = env.readFileSync(`${env.home}/${rel}`);
    if (text === null) {
      continue;
    }
    const palette = parseOmarchyColors(text);
    if (palette !== null) {
      return palette;
    }
  }
  const desktop = env.env['XDG_CURRENT_DESKTOP'] ?? '';
  if (/kde/i.test(desktop)) {
    const text = env.readFileSync(`${env.home}/${KDE_GLOBALS}`);
    if (text !== null) {
      const palette = parseKdeGlobals(text);
      if (palette !== null) {
        return palette;
      }
    }
    return null;
  }
  const stdout = env.execFileSync(PORTAL_CMD, PORTAL_ARGS, 800);
  const accent =
    stdout === null ? null : parsePortalAccent(stdout);
  return accent !== null ? { accent } : null;
}

/** Paths worth watching while a subscriber is attached — the poll loop
    covers everything else (symlink retargets, portal accents). */
function watchedPaths(env: ThemeSourceEnv): readonly string[] {
  if (env.platform !== 'linux') {
    return [];
  }
  const paths = [
    `${env.home}/${OMARCHY_STATE}`,
    `${env.home}/${OMARCHY_CONFIG}`,
  ];
  if (/kde/i.test(env.env['XDG_CURRENT_DESKTOP'] ?? '')) {
    paths.push(`${env.home}/${KDE_GLOBALS}`);
  }
  return paths;
}

/**
 * Refcounted `theme:events` service mirroring `net-monitor`: watchers +
 * a source poll start on the first subscriber and stop on the last
 * unsubscribe, so platforms only pay the read cost while `adaptive` is
 * actually selected.
 */
export function createThemeMonitor(opts: {
  env: ThemeSourceEnv;
  pollMs?: number;
}): ThemeMonitor {
  const pollMs = opts.pollMs ?? 4_000;
  const env = opts.env;
  const senders = new Map<ThemeSender, number>();
  const destroyedHooked = new WeakSet<ThemeSender>();
  let stops: (() => void)[] | null = null;
  let last: ThemeSource | null = null;

  function collect(): ThemeSource {
    const source: { -readonly [K in keyof ThemeSource]?: ThemeSource[K] } =
      { scheme: env.darkFlag() ? 'dark' : 'light' };
    try {
      const palette = readPlatformPalette(env);
      if (palette !== null) {
        source.palette = palette;
      }
    } catch {
      // A source read must never kill the monitor — flag-only survives.
    }
    return source as ThemeSource;
  }

  function drop(sender: ThemeSender): void {
    senders.delete(sender);
    if (senders.size === 0) {
      teardown();
    }
  }

  /** Releases every subscription of a sender whose document died. */
  function hookLifecycle(sender: ThemeSender): void {
    if (sender.on === undefined || destroyedHooked.has(sender)) {
      return;
    }
    destroyedHooked.add(sender);
    const release = (): void => drop(sender);
    const onDestroyed = (): void => {
      drop(sender);
      sender.off?.('render-process-gone', release);
      sender.off?.('did-navigate', release);
    };
    sender.on('destroyed', onDestroyed);
    sender.on('render-process-gone', release);
    sender.on('did-navigate', release);
  }

  function sendTo(sender: ThemeSender, source: ThemeSource): void {
    try {
      const event: ThemeSourceEvent = { source };
      sender.send(CHANNELS.themeEvents, event);
    } catch {
      drop(sender);
    }
  }

  function refresh(): void {
    const next = collect();
    if (JSON.stringify(next) === JSON.stringify(last)) {
      return;
    }
    last = next;
    for (const sender of senders.keys()) {
      sendTo(sender, next);
    }
  }

  function setup(): void {
    stops = [];
    last = collect();
    for (const path of watchedPaths(env)) {
      try {
        const unwatch = env.watch(path, refresh);
        if (unwatch !== null) {
          stops.push(unwatch);
        }
      } catch {
        // unwatched file — the poll still catches changes
      }
    }
    try {
      stops.push(env.onSystemChange(refresh));
    } catch {
      // system change hook unavailable — poll covers it
    }
    const timer = setInterval(refresh, pollMs);
    timer.unref();
    stops.push(() => clearInterval(timer));
  }

  function teardown(): void {
    if (stops === null) {
      return;
    }
    for (const stop of stops) {
      stop();
    }
    stops = null;
    last = null;
  }

  return {
    attach(sender) {
      const count = senders.get(sender) ?? 0;
      senders.set(sender, count + 1);
      if (count === 0) {
        hookLifecycle(sender);
        if (stops === null) {
          setup();
        }
        if (last !== null) {
          sendTo(sender, last);
        }
      }
    },
    detach(sender) {
      const count = senders.get(sender) ?? 0;
      if (count <= 1) {
        drop(sender);
      } else {
        senders.set(sender, count - 1);
      }
    },
    stop() {
      teardown();
      senders.clear();
    },
  };
}
