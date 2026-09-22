import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  safeStorage,
  utilityProcess,
} from 'electron';
import type { BrowserWindowConstructorOptions, WebContents } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const RENDERER = join(here, '../renderer/index.html');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  void main();
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
    fork: () => utilityProcess.fork(UTILITY),
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
  });

  const { state } = await loadWindowState(statePath);
  let win = createWindow(state, statePath);

  app.on('second-instance', () => {
    if (win !== null) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createWindow(state, statePath);
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

function createWindow(
  state: WindowState,
  statePath: string,
): BrowserWindow {
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
  if (state.x !== undefined && state.y !== undefined) {
    options.x = state.x;
    options.y = state.y;
  }
  const win = new BrowserWindow(options);
  if (state.maximized) {
    win.maximize();
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  trackWindowState(win, statePath);
  void win.loadFile(RENDERER);
  return win;
}

function trackWindowState(win: BrowserWindow, statePath: string): void {
  const capture = (): WindowState => {
    const bounds = win.getNormalBounds();
    return {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
    };
  };
  let timer: NodeJS.Timeout | null = null;
  const schedule = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void saveWindowState(statePath, capture());
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
    saveWindowStateSync(statePath, capture());
  });
}
