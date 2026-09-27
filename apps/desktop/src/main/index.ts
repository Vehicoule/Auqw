import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  nativeTheme,
  net,
  safeStorage,
  screen,
  systemPreferences,
  utilityProcess,
} from 'electron';
import type {
  BrowserWindowConstructorOptions,
  TitleBarOverlay,
  WebContents,
} from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemes } from '@auqw/design-tokens';
import { CHANNELS } from '../shared/channels.ts';
import type { ShellError } from '../shared/errors.ts';
import { fromUnknown, isShellError, shellError } from '../shared/errors.ts';
import { redactSensitive } from '../shared/redact.ts';
import {
  isChromeSchemePayload,
  isSyncAppliedEvent,
  isSyncNearbyEvent,
} from '../shared/contract.ts';
import type { ChromeSchemePayload } from '../shared/contract.ts';
import { registerChannels } from './ipc.ts';
import { createNetService } from './net-monitor.ts';
import { createThemeMonitor } from './theme-monitor.ts';
import { createSecureStore } from './secure-store.ts';
import { createSupervisor } from './supervisor.ts';
import {
  createAppliedPushService,
  createNearbyPushService,
} from './sync-events.ts';
import {
  createSyncKeysHandler,
  migrateSyncCustody,
  syncHasPairedDevices,
} from './sync-keys.ts';
import type { WindowState } from './window-state.ts';
import {
  loadWindowState,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  saveWindowState,
  saveWindowStateSync,
} from './window-state.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(here, '../preload/index.cjs');
const UTILITY = join(here, '../utility/index.cjs');
// Dev-mode window/taskbar icon. Packaged builds take theirs from the
// binary/icon resources electron-builder generates out of build/;
// build/ itself is not shipped in the packaged files.
const WINDOW_ICON = join(here, '../../build/icon.png');
// The product UI is the default window; the Phase-2 dev harness stays
// reachable byte-for-byte for the E2E skills behind AUQW_DEV_HARNESS=1
// (read here in main only — the sandboxed renderer never sees env).
const RENDERER =
  process.env['AUQW_DEV_HARNESS'] === '1'
    ? join(here, '../renderer/index.html')
    : join(here, '../renderer/app.html');

/** Latest persisted window state — recreated windows reopen where the user left them. */
type StateRef = { current: WindowState };

/** Env passed to the utility child: platform essentials + the exact
 * AUQW_* knobs the utility reads — an `AUQW_`-prefixed credential in
 * the launch env must NOT cross the process boundary. */
function utilityEnv(userDataPath: string): Record<string, string> {
  const passthrough = [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'USERPROFILE',
    'APPDATA',
    'SYSTEMROOT',
    'COMSPEC',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    // Proxy + custom-CA family — the POT minter child forwards these
    // for hosts whose egress needs them.
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
  ];
  const auqwAllowlist = [
    'AUQW_NODE_BINDINGS',
    'AUQW_PLUGIN_DIR',
    'AUQW_STREAM_DIR',
    'AUQW_USER_DATA',
    'AUQW_REPO_ROOT',
    'AUQW_DB_PATH',
    'AUQW_SYNC_HOST',
    'AUQW_SYNC_PORT',
    'AUQW_SYNC_DISABLED',
    'AUQW_SYNC_NAME',
    'AUQW_SYNC_NO_MDNS',
    'AUQW_POT_PROVIDER_URL',
  ];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (passthrough.includes(key) ||
        auqwAllowlist.includes(key) ||
        key.startsWith('LC_'))
    ) {
      env[key] = value;
    }
  }
  env['AUQW_USER_DATA'] = userDataPath;
  // The dev gate is armed by this process alone — an inherited
  // AUQW_DEV_GATE in a packaged launch env must never reach the child
  // (it is not in the allowlist, so this also strips any set upstream).
  delete env['AUQW_DEV_GATE'];
  // The database lives in the utility child; its path is fork env
  // because the child owns no app.getPath('userData').
  env['AUQW_DB_PATH'] ??= join(userDataPath, 'auqw.db');
  // Paired-device records mark an install that actually synced — an
  // identity alone doesn't (the utility mints one on any sync start,
  // including a passive settings visit). Armed installs keep an
  // eager listener so paired devices still find it; fresh installs
  // stay dormant — binding requires custody, and on macOS the
  // safeStorage read is what fires the Keychain ACL prompt.
  env['AUQW_SYNC_ARMED'] = syncHasPairedDevices(
    join(userDataPath, 'sync-secure'),
  )
    ? '1'
    : '0';
  if (!app.isPackaged) {
    // Dev checkouts resolve the bindings artifact from the repo and
    // may arm the dev-gate channel; packaged runs use resourcesPath.
    env['AUQW_REPO_ROOT'] = join(here, '../../../..');
    env['AUQW_DEV_GATE'] = '1';
    // The sync tool stages released providers in apps/desktop/plugins —
    // without it AUQW_PLUGIN_DIR is unset and boot fails with 'no
    // plugin providers available'.
    env['AUQW_PLUGIN_DIR'] ??= join(here, '../../plugins');
  } else {
    // Packaged installs carry the locked provider set under
    // resources/plugins (electron-builder.yml extraResources). An
    // explicit AUQW_PLUGIN_DIR still wins — dev loops and harnesses
    // point at their own sets.
    env['AUQW_PLUGIN_DIR'] ??= join(process.resourcesPath, 'plugins');
  }
  return env;
}

// A fatal startup failure logs locally, so the cause has to stay
// diagnosable — but only as a redacted, bounded rendering. The raw value
// is never logged whole (it may be circular or unbounded) and never
// crosses a port boundary: only fields that are already strings are
// read, so this renderer cannot throw from inside a failure handler.
// `redactSensitive` is pattern masking rather than a proof — see its
// comment for the shape a credential can still hide behind.
function boundedCause(thrown: unknown): string {
  let raw: string;
  // `name`/`message` are property reads — an exotic error (a Symbol
  // name, a throwing getter) must degrade to a label, not propagate
  // out of the failure handler and skip the exit below.
  try {
    if (thrown instanceof Error) {
      raw = `${String(thrown.name)}: ${String(thrown.message)}`;
    } else if (typeof thrown === 'string') {
      raw = thrown;
    } else {
      raw = 'non-error thrown';
    }
  } catch {
    raw = 'unrenderable error';
  }
  const safe = redactSensitive(raw);
  return safe.length > 512 ? `${safe.slice(0, 512)}…` : safe;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  main().catch((thrown: unknown) => {
    // A typed failure keeps its kind — `fromUnknown` is only for the
    // raw throws. `boundedCause` keeps the cause debuggable without
    // echoing a raw value into the log.
    const error = isShellError(thrown) ? thrown : fromUnknown(thrown);
    console.error(
      `fatal startup failure: ${error.kind}: ${boundedCause(thrown)}`,
    );
    app.exit(1);
  });
}

async function main(): Promise<void> {
  await app.whenReady();

  const userDataPath = app.getPath('userData');
  const statePath = join(userDataPath, 'window-state.json');
  const secure = createSecureStore({
    dir: join(userDataPath, 'secure'),
    safeStorage,
  });
  // Sync custody lives in its own store+dir: `secure:*` channels reach
  // only the renderer-facing store, so the pairing identity and device
  // records are never readable or writable from the sandboxed renderer.
  const syncSecureDir = join(userDataPath, 'sync-secure');
  // Pre-split builds kept sync entries in the renderer-facing dir —
  // carry them over so an upgrade doesn't orphan existing pairings.
  await migrateSyncCustody(join(userDataPath, 'secure'), syncSecureDir);
  const syncSecure = createSecureStore({
    dir: syncSecureDir,
    safeStorage,
  });
  const netService = createNetService({
    readOnline: () => net.isOnline(),
  });
  // OS theme source for the 'adaptive' setting: Linux reads Omarchy
  // colors.toml / KDE kdeglobals / the GNOME 47+ portal accent via
  // gdbus; win32/darwin take the Electron systemPreferences accent
  // (UNVERIFIED on this Linux dev box — the call shape is Electron's
  // documented one). Watchers run only while a renderer is subscribed.
  const themeMonitor = createThemeMonitor({
    env: {
      platform: process.platform,
      home: homedir(),
      env: process.env,
      readFileSync: (path) => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return null;
        }
      },
      execFile: (file, args, timeoutMs) =>
        // Async on purpose: a hanging portal must not stall the main
        // process — a sync read would freeze IPC/window events for the
        // full timeout on every poll tick.
        new Promise<string | null>((resolve) => {
          execFile(
            file,
            [...args],
            { encoding: 'utf8', timeout: timeoutMs },
            (error, stdout) => {
              resolve(error === null ? stdout : null);
            },
          );
        }),
      watch: (path, onChange) => {
        try {
          const watcher = watch(path, { persistent: false }, onChange);
          return () => watcher.close();
        } catch {
          return null;
        }
      },
      darkFlag: () => nativeTheme.shouldUseDarkColors,
      systemAccent: () => {
        try {
          if (process.platform === 'win32') {
            // 'RRGGBBAA' (unprefixed on win32 — tolerate a '#' anyway)
            // — the scheme roles only take the rgb half.
            const raw = systemPreferences
              .getAccentColor()
              .replace(/^#/, '');
            return `#${raw.slice(0, 6)}`;
          }
          if (process.platform === 'darwin') {
            // 'control-accent-color' predates the installed Electron
            // typings' color-name list — cast keeps the spec's name.
            return systemPreferences.getColor(
              'control-accent-color' as Parameters<
                typeof systemPreferences.getColor
              >[0],
            );
          }
        } catch {
          // accent unset / API absent
        }
        return null;
      },
      onSystemChange: (cb) => {
        nativeTheme.on('updated', cb);
        let offAccent: (() => void) | null = null;
        if (process.platform === 'win32') {
          systemPreferences.on('accent-color-changed', cb);
          offAccent = () =>
            systemPreferences.removeListener('accent-color-changed', cb);
        } else if (process.platform === 'darwin') {
          systemPreferences.on('color-changed', cb);
          offAccent = () =>
            systemPreferences.removeListener('color-changed', cb);
        }
        return () => {
          nativeTheme.removeListener('updated', cb);
          offAccent?.();
        };
      },
    },
  });
  const appliedPush = createAppliedPushService();
  const nearbyPush = createNearbyPushService();
  const supervisor = createSupervisor({
    fork: () =>
      utilityProcess.fork(UTILITY, [], {
        // The utility needs only platform essentials plus the AUQW_*
        // knobs — never the parent's full env (credentials would leak
        // into a process that loads native artifacts).
        env: utilityEnv(userDataPath),
      }),
    // Utility→main service calls: safeStorage lives only in main, so
    // sync identity + device key material rides `sync:keys` up to the
    // SecureStore. The child gets no other main-process reach.
    services: {
      'sync:keys': createSyncKeysHandler({
        secure: syncSecure,
        dir: syncSecureDir,
      }),
      // Utility→main→renderer push: the sync service posts after every
      // applyDelta; subscribed renderers pull sync:drainApplied on it.
      'sync:applied': async (args) => {
        if (!isSyncAppliedEvent(args)) {
          throw shellError(
            'invalid-request',
            'sync:applied expects {pending}',
          );
        }
        appliedPush.notify(args);
        return undefined;
      },
      // mDNS browse found/lost — the utility's discovery leg posts
      // here; subscribed renderers see the nearby list update.
      'sync:nearby': async (args) => {
        if (!isSyncNearbyEvent(args)) {
          throw shellError(
            'invalid-request',
            'sync:nearby expects a discovery event',
          );
        }
        nearbyPush.notify(args);
        return undefined;
      },
    },
  });

  registerChannels(ipcMain, {
    meta: () => ({
      version: app.getVersion(),
      platform: process.platform,
      userDataPath,
    }),
    pickFolder: async (args, sender) => {
      const win = BrowserWindow.fromWebContents(sender as WebContents);
      const options = {
        title: args.title ?? 'Choose a folder',
        properties: ['openDirectory' as const],
      };
      const result =
        win === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(win, options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    pickFiles: async (args, sender) => {
      const win = BrowserWindow.fromWebContents(sender as WebContents);
      const properties: Array<'openFile' | 'multiSelections'> = [
        'openFile',
        ...(args.multiple === true ? ['multiSelections' as const] : []),
      ];
      const options = { title: args.title ?? 'Choose files', properties };
      const result =
        win === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(win, options);
      return result.canceled ? [] : result.filePaths;
    },
    net: netService,
    theme: themeMonitor,
    syncApplied: appliedPush,
    syncNearby: nearbyPush,
    secure,
    utility: supervisor,
    // Brokers the stream pump channel — the utility child gets one end
    // with the attach message, the renderer the other via postMessage.
    messageChannel: () => new MessageChannelMain(),
  });

  // The renderer reports its resolved ui-web scheme (which may differ
  // from the OS theme when the user picked an explicit one) so the
  // window-control overlay can re-tint itself to match the canvas.
  ipcMain.on(CHANNELS.chromeScheme, (event, payload) => {
    if (!isChromeSchemePayload(payload) || process.platform === 'darwin') {
      return;
    }
    const sender = BrowserWindow.fromWebContents(event.sender);
    try {
      sender?.setTitleBarOverlay(titleBarOverlay(payload));
    } catch {
      // platform without a working window-control overlay — ignore
    }
  });

  const { state } = await loadWindowState(statePath);
  const stateRef: StateRef = { current: state };
  let win: BrowserWindow | null = null;
  const openWindow = (): void => {
    win = createWindow(stateRef, statePath);
    win.on('closed', () => {
      win = null;
    });
  };
  openWindow();

  app.on('second-instance', () => {
    if (win === null) {
      openWindow();
      return;
    }
    if (win.isMinimized()) {
      win.restore();
    }
    win.focus();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openWindow();
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
  app.on('will-quit', () => {
    netService.stop();
    themeMonitor.stop();
    appliedPush.stop();
    nearbyPush.stop();
    supervisor.shutdown();
  });
}

function titleBarOverlay(payload: ChromeSchemePayload): TitleBarOverlay {
  const tokens = schemes[payload.scheme];
  return {
    color: payload.canvas ?? tokens.canvas,
    symbolColor: payload.symbol ?? tokens.textBright,
    height: 40,
  };
}

function createWindow(stateRef: StateRef, statePath: string): BrowserWindow {
  const state = stateRef.current;
  const isMac = process.platform === 'darwin';
  const options: BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: 'auqw',
    // macOS draws a themed strip if a titleBarOverlay is given even under
    // hiddenInset, so it gets the bare option instead.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (isMac) {
    options.trafficLightPosition = { x: 14, y: 12 };
  } else {
    options.titleBarOverlay = titleBarOverlay({
      scheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    });
  }
  if (!app.isPackaged) {
    options.icon = WINDOW_ICON;
  }
  if (
    state.x !== undefined &&
    state.y !== undefined &&
    intersectsDisplay(state.x, state.y, state.width, state.height)
  ) {
    options.x = state.x;
    options.y = state.y;
  }
  const win = new BrowserWindow(options);
  if (state.maximized) {
    win.maximize();
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The renderer owns exactly one document — a navigation that kept
  // the `window.auqw` preload surface would carry every ipc bridge
  // into whatever page it landed on.
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  // Sandbox-first: the app requests no web permissions, so a renderer
  // that asks (media, notifications, geolocation…) is refused rather
  // than silently granted by Electron's default handler.
  win.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => {
      callback(false);
    },
  );
  win.webContents.session.setPermissionCheckHandler(() => false);
  trackWindowState(win, statePath, stateRef);
  void win.loadFile(RENDERER);
  return win;
}

/**
 * True when the saved bounds are still at least partially visible on some
 * connected display. A stale position (monitor unplugged, resolution
 * changed) drops the coordinates and lets the window manager place it.
 */
function intersectsDisplay(
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  const rect = { left: x, right: x + width, top: y, bottom: y + height };
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      rect.left < area.x + area.width &&
      rect.right > area.x &&
      rect.top < area.y + area.height &&
      rect.bottom > area.y
    );
  });
}

function trackWindowState(
  win: BrowserWindow,
  statePath: string,
  stateRef: StateRef,
): void {
  const capture = (): WindowState => {
    const bounds = win.getNormalBounds();
    stateRef.current = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
    };
    return stateRef.current;
  };
  let timer: NodeJS.Timeout | null = null;
  // In-flight debounced write — the final close write chains after it, so
  // a slower earlier snapshot can never overwrite the closing state.
  let inflight: Promise<void> | null = null;
  const report = (error: ShellError | null): void => {
    if (error !== null) {
      console.error(`window-state save failed: ${error.kind}`);
    }
  };
  const schedule = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      inflight = saveWindowState(statePath, capture())
        .then(report)
        .finally(() => {
          inflight = null;
        });
    }, 400);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    capture();
    const writeFinal = (): void => {
      report(saveWindowStateSync(statePath, stateRef.current));
    };
    const pending = inflight;
    if (pending === null) {
      writeFinal();
    } else {
      void pending.finally(writeFinal);
    }
  });
}
