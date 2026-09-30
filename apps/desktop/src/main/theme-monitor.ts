import { CHANNELS } from '../shared/channels.ts';
import type { ThemeSource } from '@auqw/design-tokens/adaptive';
import type { ThemeSourceEvent } from '../shared/contract.ts';
import type { NetSender } from './net-monitor.ts';

type Palette = NonNullable<ThemeSource['palette']>;

/**
 * Platform specifics are injected so the service stays electron-free and
 * testable: `readFileSync`/`execFile` return null on any failure
 * (missing file, timed-out gdbus — async so a hanging portal can never
 * stall the Electron main process), `watch` returns a stop function or
 * null when the path can't be watched, `darkFlag` is the OS dark-mode
 * boolean, `systemAccent` the win32/darwin accent read, and
 * `onSystemChange` hooks the native 'updated'/'color-changed' events.
 */
export interface ThemeSourceEnv {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly readFileSync: (path: string) => string | null;
  readonly execFile: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string | null>;
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
interface ThemeSender extends NetSender {
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
      as soon as the first read resolves (immediately for senders that
      re-subscribe while a snapshot is already known). Refcounted like
      `net`: the first attach starts the platform watchers, the last
      detach stops them. */
  attach(sender: ThemeSender): void;
  detach(sender: ThemeSender): void;
  stop(): void;
}

// Double-quoted basic strings and single-quoted literal strings are
// both legal TOML values; either may carry the palette keys.
const ASSIGN_RE = /([A-Za-z_0-9]+)\s*=\s*(?:"([^"\n]+)"|'([^'\n]+)')/;

// Opens a `key = """`/`'''` multiline string; a closer on the same
// line keeps it single-line (those still match ASSIGN_RE).
const MULTILINE_OPEN_RE = /=\s*("""|''')/;

/** Cuts a TOML `#` comment: a `#` inside a quoted span is data (colors
    are quoted hex), one outside ends the line. */
function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === null) {
      if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '#') {
        return line.slice(0, i);
      }
    } else if (c === quote) {
      quote = null;
    }
  }
  return line;
}

/** Flat `key = "value"` TOML read — Omarchy `colors.toml` carries
    `background`/`foreground`/`accent`/`selection`/`red` (warn) keys.
    Comments are stripped first so a commented-out duplicate can't
    override the live value. */
export function parseOmarchyColors(text: string): Palette | null {
  const keys = new Map<string, string>();
  // A `key = """`/`'''` value that doesn't close on its own line
  // swallows the following lines as string data — none of them may
  // contribute keys, or a stray `x = "v"` inside the block would
  // parse as a real assignment.
  let multiline: string | null = null;
  for (const line of text.split('\n')) {
    if (multiline !== null) {
      // Inside a multiline string nothing is a comment — check the
      // raw line for the closing delimiter.
      if (line.includes(multiline)) {
        multiline = null;
      }
      continue;
    }
    const stripped = stripTomlComment(line);
    const open = MULTILINE_OPEN_RE.exec(stripped);
    if (open !== null) {
      const rest = stripped.slice(open.index + open[0].length);
      if (!rest.includes(open[1]!)) {
        multiline = open[1]!;
        continue;
      }
    }
    const match = ASSIGN_RE.exec(stripped);
    if (match !== null) {
      keys.set(match[1]!, match[2] ?? match[3]!);
    }
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
  // Empty segments are not zeroes — Number('') parses as 0 and would
  // silently accept `255,,0`, so blank parts map to NaN and fail the
  // integer/range check below.
  const parts = value
    .split(',')
    .map((part) =>
      part.trim() === '' ? Number.NaN : Number(part.trim()),
    );
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

const OMARCHY_TOML_REL = 'omarchy/current/theme/colors.toml';
const KDE_GLOBALS_REL = 'kdeglobals';

/** XDG roots: unset/empty falls back to the home-relative defaults,
    per the basedir spec. */
function xdgConfig(env: ThemeSourceEnv): string {
  return env.env['XDG_CONFIG_HOME'] || `${env.home}/.config`;
}
function xdgState(env: ThemeSourceEnv): string {
  return env.env['XDG_STATE_HOME'] || `${env.home}/.local/state`;
}
function omarchyPaths(env: ThemeSourceEnv): readonly string[] {
  return [
    `${xdgState(env)}/${OMARCHY_TOML_REL}`,
    `${xdgConfig(env)}/${OMARCHY_TOML_REL}`,
  ];
}
function kdeGlobalsPath(env: ThemeSourceEnv): string {
  return `${xdgConfig(env)}/${KDE_GLOBALS_REL}`;
}
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
    source exposes one (the renderer then falls back to the flag). Async
    because the portal leg shells out to gdbus. */
async function readPlatformPalette(
  env: ThemeSourceEnv,
): Promise<Palette | null> {
  if (env.platform === 'win32' || env.platform === 'darwin') {
    const accent = env.systemAccent();
    return accent !== null ? { accent } : null;
  }
  if (env.platform !== 'linux') {
    return null;
  }
  const desktop = env.env['XDG_CURRENT_DESKTOP'] ?? '';
  // Omarchy sessions run Hyprland; on another active DE a colors.toml
  // left on disk is a stale leftover, so only read it for omarchy-ish
  // or unidentified sessions.
  if (desktop.trim() === '' || /omarchy|hyprland/i.test(desktop)) {
    for (const path of omarchyPaths(env)) {
      const text = env.readFileSync(path);
      if (text === null) {
        continue;
      }
      const palette = parseOmarchyColors(text);
      if (palette !== null) {
        return palette;
      }
    }
  }
  if (/kde/i.test(desktop)) {
    const text = env.readFileSync(kdeGlobalsPath(env));
    if (text !== null) {
      const palette = parseKdeGlobals(text);
      if (palette !== null) {
        return palette;
      }
    }
    // No usable globals — a KDE session can still expose the accent
    // through the appearance portal; fall through.
  }
  const stdout = await env.execFile(PORTAL_CMD, PORTAL_ARGS, 800);
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
  const desktop = env.env['XDG_CURRENT_DESKTOP'] ?? '';
  const paths: string[] = [];
  if (desktop.trim() === '' || /omarchy|hyprland/i.test(desktop)) {
    paths.push(...omarchyPaths(env));
  }
  if (/kde/i.test(desktop)) {
    paths.push(kdeGlobalsPath(env));
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
  maxPollMs?: number;
}): ThemeMonitor {
  const pollMs = opts.pollMs ?? 4_000;
  // Consecutive unchanged reads stretch the poll gap geometrically up
  // to this cap: the poll is the only watcher for sources like the
  // portal accent, so it can't stop outright — but a settled desktop
  // doesn't need a collect (and its gdbus spawn) every pollMs. Any
  // changed read drops the next gap back to pollMs.
  const maxPollMs = opts.maxPollMs ?? 60_000;
  const env = opts.env;
  const senders = new Map<ThemeSender, number>();
  const destroyedHooked = new WeakSet<ThemeSender>();
  let stops: (() => void)[] | null = null;
  let last: ThemeSource | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let unchangedReads = 0;

  async function collect(): Promise<ThemeSource> {
    const source: { -readonly [K in keyof ThemeSource]?: ThemeSource[K] } =
      { scheme: env.darkFlag() ? 'dark' : 'light' };
    try {
      const palette = await readPlatformPalette(env);
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

  // Source reads can await a timed-out gdbus; callers coalesce onto the
  // in-flight read (flag set → one trailing run) instead of stacking
  // processes. `epoch` bumps on teardown so a read that outlived its
  // subscribers can never push a stale palette to a fresh attach — the
  // queued rerun supplies the new subscriber's real snapshot instead.
  let inflight = false;
  let rerun = false;
  let epoch = 0;
  function refresh(): void {
    if (inflight) {
      rerun = true;
      return;
    }
    inflight = true;
    const at = epoch;
    void collect()
      .then((next) => {
        if (stops === null || at !== epoch) {
          return;
        }
        if (JSON.stringify(next) === JSON.stringify(last)) {
          unchangedReads += 1;
          return;
        }
        unchangedReads = 0;
        last = next;
        for (const sender of senders.keys()) {
          sendTo(sender, next);
        }
      })
      .catch(() => {
        // collect() isolates source failures already — keep the monitor.
      })
      .finally(() => {
        inflight = false;
        if (rerun && stops !== null) {
          rerun = false;
          refresh();
        }
        rerun = false;
        armPoll();
      });
  }

  // Every settled collect arms the next poll — the guard keeps a
  // single timer outstanding and drops post-teardown settles.
  function armPoll(): void {
    if (stops === null || pollTimer !== null) {
      return;
    }
    const delay = Math.min(
      pollMs * 2 ** Math.min(unchangedReads, 4),
      maxPollMs,
    );
    pollTimer = setTimeout(() => {
      pollTimer = null;
      refresh();
    }, delay);
    pollTimer.unref();
  }

  function setup(): void {
    stops = [];
    refresh();
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
    epoch++;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    unchangedReads = 0;
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
