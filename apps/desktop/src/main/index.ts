import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  net,
  safeStorage,
  screen,
  utilityProcess,
} from 'electron';
import type { BrowserWindowConstructorOptions, WebContents } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ShellError } from '../shared/errors.ts';
import { registerChannels } from './ipc.ts';
import { createNetService } from './net-monitor.ts';
import { createSecureStore } from './secure-store.ts';
import { createSupervisor } from './supervisor.ts';
import type { WindowState } from './window-state.ts';
import {
  loadWindowState,
  saveWindowState,
  saveWindowStateSync,
} from './window-state.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(here, '../preload/index.cjs');
const UTILITY = join(here, '../utility/index.cjs');
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
  ];
  const auqwAllowlist = [
    'AUQW_NODE_BINDINGS',
    'AUQW_PLUGIN_DIR',
    'AUQW_STREAM_DIR',
    'AUQW_USER_DATA',
    'AUQW_REPO_ROOT',
    'AUQW_DEV_GATE',
    'AUQW_DB_PATH',
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
  // The database lives in the utility child; its path is fork env
  // because the child owns no app.getPath('userData').
  env['AUQW_DB_PATH'] ??= join(userDataPath, 'auqw.db');
  if (!app.isPackaged) {
    // Dev checkouts resolve the bindings artifact from the repo and
    // may arm the dev-gate channel; packaged runs use resourcesPath.
    env['AUQW_REPO_ROOT'] = join(here, '../../../..');
    env['AUQW_DEV_GATE'] = '1';
  } else {
    // Packaged installs carry the locked provider set under
    // resources/plugins (electron-builder.yml extraResources). An
    // explicit AUQW_PLUGIN_DIR still wins — dev loops and harnesses
    // point at their own sets.
    env['AUQW_PLUGIN_DIR'] ??= join(process.resourcesPath, 'plugins');
  }
  return env;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  main().catch((thrown: unknown) => {
    console.error('fatal startup failure:', thrown);
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
  const netService = createNetService({
    readOnline: () => net.isOnline(),
  });
  const supervisor = createSupervisor({
    fork: () =>
      utilityProcess.fork(UTILITY, [], {
        // The utility needs only platform essentials plus the AUQW_*
        // knobs — never the parent's full env (credentials would leak
        // into a process that loads native artifacts).
        env: utilityEnv(userDataPath),
      }),
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
    secure,
    utility: supervisor,
    // Brokers the stream pump channel — the utility child gets one end
    // with the attach message, the renderer the other via postMessage.
    messageChannel: () => new MessageChannelMain(),
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
    supervisor.shutdown();
  });
}

function createWindow(stateRef: StateRef, statePath: string): BrowserWindow {
  const state = stateRef.current;
  const options: BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    title: 'auqw',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1a1b20',
      symbolColor: '#e8e8ea',
      height: 56,
    },
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
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
