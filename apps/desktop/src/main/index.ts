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
  session,
  shell,
  systemPreferences,
  utilityProcess,
} from 'electron';
import type {
  BrowserWindowConstructorOptions,
  WebContents,
} from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  watch,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNELS } from '../shared/channels.ts';
import type { ShellError } from '../shared/errors.ts';
import { fromUnknown, isShellError, shellError } from '../shared/errors.ts';
import { redactSensitive } from '../shared/redact.ts';
import {
  isAuthSnapshot,
  isSyncAppliedEvent,
  isSyncNearbyEvent,
  isWindowControlPayload,
} from '../shared/contract.ts';
import type { WindowStateEvent } from '../shared/contract.ts';
import { registerChannels } from './ipc.ts';
import type { NetSender } from './net-monitor.ts';
import { createFetchProbe, createNetService } from './net-monitor.ts';
import { createThemeMonitor } from './theme-monitor.ts';
import { createSecureStore } from './secure-store.ts';
import { createSupervisor } from './supervisor.ts';
import { verifyUtilityIntegrity } from './utility-integrity.ts';
import {
  createAppliedPushService,
  createAuthStatePushService,
  createNearbyPushService,
  createPushService,
  createUpdateStatePushService,
} from './sync-events.ts';
import type { UpdateApplyPorts } from '@auqw/application';
import {
  appImageRelaunchOptions,
  createDesktopUpdate,
  updateCapabilityFor,
  updateTargetFor,
} from './update.ts';
import { applyDmg } from './darwin-apply.ts';
import {
  createSyncKeysHandler,
  migrateSyncCustody,
  syncHasPairedDevices,
} from './sync-keys.ts';
import { createAuthCustodyHandler } from './auth-custody.ts';
import { imgSrcSources, rewriteCsp } from './csp.ts';
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
    'AUQW_PLUGIN_FEED',
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
    // Opt-in wildcard bind for the POT minter — the utility still
    // refuses 0.0.0.0 without a paired device in sync custody.
    'AUQW_POT_LAN',
    // Advanced OAuth overrides — the utility owns the token exchange,
    // so an explicitly-set client credential must reach it (opt-in
    // allowlist entries, not ambient env passthrough).
    'AUQW_OAUTH_CLIENT_ID',
    'AUQW_OAUTH_CLIENT_SECRET',
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
  }
  // No plugin dir is defaulted: plugins ship OTA (decision log) — the
  // utility syncs the signed feed into <userData>/plugins. An explicit
  // AUQW_PLUGIN_DIR passed through above still wins for dev sets.
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

  // The product window's CSP meta ships static — `img-src 'self'
  // https:` would hand the sandboxed renderer unrestricted HTTPS
  // egress (every fetch-shaped side channel hides in an <img>). The
  // serve-time rewrite enumerates the installed manifests' network:
  // hosts + the proven artwork CDNs instead (src/main/csp.ts). Only
  // the loaded document is rewritten; every other file:// load passes
  // through to the default loader — and the file:// origin is kept,
  // since Chrome refuses non-file subresources into a file-less
  // parent scheme (local media playback rides media-src file:).
  session.defaultSession.protocol.handle('file', (request) => {
    let filePath: string;
    try {
      filePath = fileURLToPath(request.url);
    } catch {
      // A malformed request URL is not ours to answer for.
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    }
    if (filePath !== RENDERER) {
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    }
    // The renderer document never falls through: the static bytes carry
    // a blanket `img-src https:` — serving them unrewritten on a read
    // failure reopens the egress this rewrite exists to close. The
    // allowed origins are re-enumerated per serve so an install/update
    // of a plugin's manifest needs no app restart to take effect.
    try {
      return new Response(
        rewriteCsp(
          readFileSync(RENDERER, 'utf8'),
          imgSrcSources(
            process.env['AUQW_PLUGIN_DIR'] ??
              join(app.getPath('userData'), 'plugins'),
          ),
        ),
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    } catch {
      return new Response('renderer document unavailable', {
        status: 500,
      });
    }
  });

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
  // OAuth custody has the same property: its own sealed dir reachable
  // only through the `auth:custody` service channel — a sandboxed
  // renderer's `secure:*` keys never touch the refresh grant.
  const authSecure = createSecureStore({
    dir: join(userDataPath, 'auth-secure'),
    safeStorage,
  });
  const netService = createNetService({
    readOnline: () => net.isOnline(),
    // The NIC view can't tell "link up" from "internet works" (dead
    // upstream, captive portal) — the probe verifies against the same
    // connectivity canary the Android monitor's VALIDATED flag uses.
    probe: createFetchProbe((url, init) => net.fetch(url, init), {
      url: 'https://connectivitycheck.gstatic.com/generate_204',
      expectedStatus: 204,
    }),
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
        // Bounded and regular-file-only: a sync read in main blocks
        // the whole process (all IPC, all windows) if the candidate
        // path resolves to a FIFO/device or a stalled mount, so the
        // byte count is capped and non-regular files are refused.
        // O_NONBLOCK keeps the open() itself unblocking on a FIFO;
        // no O_NOFOLLOW — Omarchy's current/theme symlink chain is
        // the intended lookup.
        const CAP = 256 * 1024;
        let fd: number | null = null;
        try {
          fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
          if (!fstatSync(fd).isFile()) {
            return null;
          }
          const buf = Buffer.alloc(CAP);
          let read = 0;
          for (;;) {
            const n = readSync(fd, buf, read, CAP - read, null);
            read += n;
            if (n === 0 || read >= CAP) {
              break;
            }
          }
          return buf.toString('utf8', 0, read);
        } catch {
          return null;
        } finally {
          if (fd !== null) {
            try {
              closeSync(fd);
            } catch {
              // close failure on an already-dead fd is unrecoverable noise
            }
          }
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
            {
              encoding: 'utf8',
              timeout: timeoutMs,
              // The timeout's signal must be lethal by construction:
              // a portal helper that ignores SIGTERM would leave the
              // promise (and the monitor's inflight latch) unsettled
              // forever.
              killSignal: 'SIGKILL',
            },
            (error, stdout) => {
              resolve(error === null ? stdout : null);
            },
          );
        }),
      watch: (path, onChange) => {
        try {
          const watcher = watch(path, { persistent: false }, onChange);
          // An async watch error (dir removed, fd limits) must not
          // escape as an uncaught exception in main — drop the watcher;
          // the poll loop still tracks the path.
          watcher.on('error', () => watcher.close());
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
  const authStatePush = createAuthStatePushService();
  const updateStatePush = createUpdateStatePushService();
  const windowStatePush = createPushService<WindowStateEvent>(
    CHANNELS.windowStateEvents,
  );
  // Same refcounted registry as the other pushes, but attach also
  // reports the CURRENT state — a renderer that booted inside an
  // already-maximized window would otherwise wait for the next toggle
  // to learn it (the 'maximize' event fired before it subscribed).
  const windowState = {
    attach(sender: NetSender): void {
      windowStatePush.attach(sender);
      try {
        sender.send(CHANNELS.windowStateEvents, {
          maximized: win?.isMaximized() ?? false,
        });
      } catch {
        windowStatePush.detach(sender);
      }
    },
    detach(sender: NetSender): void {
      windowStatePush.detach(sender);
    },
  };
  // Release update check — lives in main because the renderer CSP
  // admits only 'self'. The egress is the GitHub releases list plus
  // (past 'open') the artifact + its SHA256SUMS row; the renderer sees
  // validated snapshots + verbs over `update:*`.
  const updateTarget = updateTargetFor(process.platform, process.env);
  const updateCapability = updateCapabilityFor(updateTarget, process.env);
  // Non-AppImage formats stage under userData/updates — swept on boot
  // so an interrupted run never accumulates stale artifacts. The
  // AppImage leg stages a `.new` sibling of the running image instead
  // so the apply rename stays atomic (same filesystem).
  const updatesStageDir = join(userDataPath, 'updates');
  const appimagePath = process.env['APPIMAGE'];
  // One installer handoff per process — 'applied' inside the ~1s
  // pre-quit window is the spawn having fired, not a retriable offer.
  let updateInstallerSpawned = false;
  if (updateCapability !== 'open') {
    mkdirSync(updatesStageDir, { recursive: true });
    for (const name of readdirSync(updatesStageDir)) {
      rmSync(join(updatesStageDir, name), { force: true, recursive: true });
    }
    // The AppImage stage sits beside the running image, outside
    // updatesStageDir — a `.new` killed mid-download strands there
    // too, so sweep it (and its `.part`) the same way.
    if (appimagePath !== undefined) {
      rmSync(`${appimagePath}.new`, { force: true });
      rmSync(`${appimagePath}.new.part`, { force: true });
    }
  }
  const CHECKSUMS_MAX_BYTES = 1024 * 1024;
  const updateApplyPorts: UpdateApplyPorts | undefined =
    updateCapability === 'open'
      ? undefined
      : {
          stagePath: (artifact) =>
            updateTarget.os === 'linux' &&
            updateTarget.prefer === 'appimage' &&
            appimagePath !== undefined
              ? `${appimagePath}.new`
              : join(updatesStageDir, artifact.name),
          fetchText: async (url, signal) => {
            const res = await net.fetch(url, {
              signal: signal as AbortSignal,
            });
            if (!res.ok) {
              throw shellError('transient', `checksums fetch ${res.status}`);
            }
            const body = res.body;
            if (body === null) {
              return '';
            }
            // Sums files are kilobytes — stream-cap the read so a
            // runaway or hostile body can't inflate main memory.
            const parts: Buffer[] = [];
            let size = 0;
            for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
              if (signal.aborted) {
                throw new DOMException('aborted', 'AbortError');
              }
              size += chunk.byteLength;
              if (size > CHECKSUMS_MAX_BYTES) {
                throw shellError(
                  'invalid-response',
                  'checksums body over 1 MiB',
                );
              }
              parts.push(Buffer.from(chunk));
            }
            return Buffer.concat(parts).toString('utf8');
          },
          download: async (url, path, onProgress, signal) => {
            const res = await net.fetch(url, {
              signal: signal as AbortSignal,
            });
            if (res.status < 200 || res.status >= 300 || res.body === null) {
              throw shellError('transient', `artifact fetch ${res.status}`);
            }
            const declared = Number(res.headers.get('content-length'));
            const total =
              Number.isFinite(declared) && declared > 0 ? declared : null;
            const part = `${path}.part`;
            let received = 0;
            const source = Readable.fromWeb(
              res.body as unknown as import('node:stream/web').ReadableStream,
            );
            source.on('data', (chunk: Uint8Array) => {
              received += chunk.byteLength;
              onProgress(received, total);
            });
            try {
              // pipeline owns the stream's whole error surface — a
              // write failure (ENOSPC, unwritable stage) rejects here
              // instead of crashing main on an unhandled 'error'.
              await pipeline(source, createWriteStream(part));
            } catch (thrown) {
              rmSync(part, { force: true });
              // An abort can surface as a generic stream error — map
              // it so the applier sees its cancel contract.
              if (signal.aborted) {
                throw new DOMException('aborted', 'AbortError');
              }
              throw thrown;
            }
            // The file lands whole or not at all — a verify never
            // hashes a half-fetched stream.
            renameSync(part, path);
            onProgress(received, total);
          },
          sha256Hex: (path) =>
            new Promise<string>((resolve, reject) => {
              const hash = createHash('sha256');
              createReadStream(path)
                .on('data', (chunk) => hash.update(chunk))
                .on('end', () => resolve(hash.digest('hex')))
                .on('error', reject);
            }),
          apply: (path, artifact) => {
            if (
              updateTarget.os === 'linux' &&
              updateTarget.prefer === 'appimage' &&
              appimagePath !== undefined
            ) {
              // Atomic same-dir rename over the running image — Linux
              // swaps the inode under the live process and the new
              // bytes take over on the next exec.
              chmodSync(path, 0o755);
              renameSync(path, appimagePath);
              return Promise.resolve('relaunch' as const);
            }
            if (process.platform === 'win32') {
              // Assisted NSIS setup installs over the running install
              // dir — spawn detached, then get out of its way. The
              // quit only schedules once 'spawn' proves the setup
              // actually launched: a refused spawn is a retryable
              // 'failed', never an app.exit with no installer.
              return new Promise<'installed'>((resolve, reject) => {
                const child = spawn(path, [], {
                  detached: true,
                  stdio: 'ignore',
                });
                child.once('error', (thrown) => {
                  reject(
                    shellError(
                      'transient',
                      `installer spawn: ${thrown.message}`,
                    ),
                  );
                });
                child.once('spawn', () => {
                  updateInstallerSpawned = true;
                  child.unref();
                  // Give the 'applying' beat ~1s to render before the
                  // window hands off — an instant quit reads as a crash
                  // mid-flow (the installer still owns the install).
                  setTimeout(() => app.quit(), 1000).unref();
                  resolve('installed');
                });
              });
            }
            if (process.platform === 'darwin') {
              // A dmg can't self-apply in place, but a packaged build
              // can do the user's drag for them: mount the verified
              // image, swap the .app, relaunch. Unpackaged dev runs
              // and refused assists get the manual leg — Finder
              // opens the image and the card names the move.
              return applyDmg({
                dmgPath: path,
                isPackaged: app.isPackaged,
                exePath: app.getPath('exe'),
                openPath: (p) => shell.openPath(p),
                showItemInFolder: (p) => shell.showItemInFolder(p),
              });
            }
            return Promise.reject(
              shellError(
                'not-implemented',
                `no apply path for ${artifact.name}`,
              ),
            );
          },
          remove: (path) => {
            rmSync(path, { force: true });
            rmSync(`${path}.part`, { force: true });
            return Promise.resolve();
          },
        };
  // Dev/test seam (mobile's EXPO_PUBLIC_UPDATE_RELEASES_URL twin):
  // point the check at a local/staging releases payload — e.g. a
  // fixture feed for deterministic update legs. Unpackaged runs only:
  // a packaged build's egress must stay on the pinned GitHub endpoint
  // (decisions.md) — an inherited env var would steer the artifact
  // AND its checksum to whatever endpoint it names.
  const updateReleasesUrl = app.isPackaged
    ? undefined
    : process.env['AUQW_UPDATE_RELEASES_URL'];
  const updateService = createDesktopUpdate({
    currentVersion: app.getVersion(),
    target: updateTarget,
    fetchJson: async (url) => {
      const res = await net.fetch(url, {
        headers: { accept: 'application/vnd.github+json' },
      });
      return {
        status: res.status,
        body: await res.json().catch(() => null),
      };
    },
    openExternal: (url) => shell.openExternal(url),
    installerSpawnedInProcess: () => updateInstallerSpawned,
    capability: updateCapability,
    ...(updateReleasesUrl !== undefined && updateReleasesUrl !== ''
      ? { releasesUrl: updateReleasesUrl }
      : {}),
    ...(updateApplyPorts !== undefined ? { applyPorts: updateApplyPorts } : {}),
    ...(updateTarget.os === 'mac' ||
    (updateCapability === 'install' && updateTarget.os === 'linux')
      ? {
          relaunch: () => {
            // The AppImage apply already renamed the new bytes over
            // $APPIMAGE — the restart must exec THAT file, not
            // process.execPath inside the dying FUSE mount. The quit
            // runs the will-quit chain — supervisor kill + service
            // stops — so the relaunched build doesn't inherit live
            // ports (mDNS, LAN sync) from the dying process.
            app.relaunch(appImageRelaunchOptions(process.argv, appimagePath));
            app.quit();
          },
        }
      : {}),
  });
  updateService.subscribe((snapshot) => updateStatePush.notify(snapshot));
  const supervisor = createSupervisor({
    fork: () => {
      if (app.isPackaged) {
        // The fork target lives outside app.asar — outside the fuse
        // integrity envelope — so after-pack's manifest verifies its
        // bytes first (and the loose napi artifact it loads). A
        // tampered file throws here; the supervisor treats it like a
        // crash: the retry re-verifies and never forks loose bytes
        // that don't match.
        verifyUtilityIntegrity(process.resourcesPath);
      }
      return utilityProcess.fork(UTILITY, [], {
        // The utility needs only platform essentials plus the AUQW_*
        // knobs — never the parent's full env (credentials would leak
        // into a process that loads native artifacts).
        env: utilityEnv(userDataPath),
      });
    },
    // Utility→main service calls: safeStorage lives only in main, so
    // sync identity + device key material rides `sync:keys` up to the
    // SecureStore. The child gets no other main-process reach.
    services: {
      'sync:keys': createSyncKeysHandler({
        secure: syncSecure,
        dir: syncSecureDir,
      }),
      // OAuth custody — the refresh grant's sealed record lives in the
      // auth-secure store, reachable only through this channel.
      'auth:custody': createAuthCustodyHandler({ secure: authSecure }),
      // Utility→main→renderer push: each published auth snapshot
      // forwards to subscribed renderers on `auth:state`.
      'auth:state': async (args) => {
        if (!isAuthSnapshot(args)) {
          throw shellError(
            'invalid-request',
            'auth:state expects a snapshot',
          );
        }
        authStatePush.notify(args);
        return undefined;
      },
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
      if (!result.canceled && result.filePaths.length > 0) {
        // Attest the dialog's output to the utility before handing the
        // path back — `local:add` only mints for picks it can match
        // here, so a renderer cannot self-grant an arbitrary path.
        await supervisor
          .request(CHANNELS.localPicks, { paths: result.filePaths })
          .catch((thrown) => {
            console.warn(
              '[dialog] local:picks attestation failed:',
              thrown instanceof Error ? thrown.message : thrown,
            );
          });
      }
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
      if (!result.canceled && result.filePaths.length > 0) {
        await supervisor
          .request(CHANNELS.localPicks, { paths: result.filePaths })
          .catch((thrown) => {
            console.warn(
              '[dialog] local:picks attestation failed:',
              thrown instanceof Error ? thrown.message : thrown,
            );
          });
      }
      return result.canceled ? [] : result.filePaths;
    },
    net: netService,
    theme: themeMonitor,
    syncApplied: appliedPush,
    syncNearby: nearbyPush,
    authState: authStatePush,
    update: updateService,
    updateState: updateStatePush,
    windowState,
    secure,
    utility: supervisor,
    // The device flow's verification URL opens in the system browser —
    // allowlisted to google.com hosts so the channel can't be a
    // generic openExternal primitive for arbitrary renderer input.
    openUrl: (url) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return Promise.reject(
          shellError('invalid-request', 'auth:openUrl bad url'),
        );
      }
      const host = parsed.hostname;
      if (
        parsed.protocol !== 'https:' ||
        (host !== 'google.com' && !host.endsWith('.google.com'))
      ) {
        return Promise.reject(
          shellError('invalid-request', 'auth:openUrl refused host'),
        );
      }
      return shell.openExternal(url);
    },
    // Brokers the stream pump channel — the utility child gets one end
    // with the attach message, the renderer the other via postMessage.
    messageChannel: () => new MessageChannelMain(),
  });

  // The renderer draws its own caption cluster — no OS-drawn overlay
  // pixels, so nothing here has to fight the bar's design. Ops arrive
  // fire-and-forget and apply to the sender's own window only.
  ipcMain.on(CHANNELS.windowControl, (event, payload) => {
    if (!isWindowControlPayload(payload)) {
      return;
    }
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (sender === null || sender.isDestroyed()) {
      return;
    }
    if (payload.op === 'minimize') {
      sender.minimize();
    } else if (payload.op === 'close') {
      sender.close();
    } else if (sender.isMaximized()) {
      sender.unmaximize();
    } else {
      sender.maximize();
    }
  });

  const { state } = await loadWindowState(statePath);
  const stateRef: StateRef = { current: state };
  let win: BrowserWindow | null = null;
  const openWindow = (): void => {
    win = createWindow(stateRef, statePath);
    win.on('maximize', () => {
      windowStatePush.notify({ maximized: true });
    });
    win.on('unmaximize', () => {
      windowStatePush.notify({ maximized: false });
    });
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
    authStatePush.stop();
    updateStatePush.stop();
    windowStatePush.stop();
    supervisor.shutdown();
  });
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
    // Frameless everywhere: the renderer's own caption cluster drives
    // win32/linux while macOS keeps its traffic lights hidden-inset.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (isMac) {
    options.trafficLightPosition = { x: 14, y: 22 };
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
  // Sandbox-first: the only web permissions granted are the clipboard
  // pair the sync panel's copy/paste rows and pairing-code copy need —
  // and only to this window's own webContents; every other request
  // (media, notifications, geolocation…) stays refused rather than
  // silently granted by Electron's default handler.
  const appPermissions = new Set([
    'clipboard-read',
    'clipboard-sanitized-write',
  ]);
  win.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      callback(
        webContents === win.webContents && appPermissions.has(permission),
      );
    },
  );
  win.webContents.session.setPermissionCheckHandler(
    (webContents, permission) =>
      webContents === win.webContents && appPermissions.has(permission),
  );
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
