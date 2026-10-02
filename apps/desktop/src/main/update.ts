/**
 * Release update check — the desktop leg. The renderer's CSP admits
 * only 'self', so the GitHub egress lives here in main: the shared
 * `createUpdateService` + `createUpdateApplier` run against
 * `net.fetch`/fs, and the renderer sees validated snapshots + verbs
 * over `update:*` channels. The open affordance takes no URL argument
 * — no renderer input can steer it — main opens the release URL its
 * own snapshot recorded, allowlisted to this repo's releases tree.
 * What `apply` reaches depends on the shipped format (see
 * `updateCapabilityFor`): NSIS and AppImage self-install, the dmg
 * verified-downloads + reveals, flatpak stays on the release page —
 * no updater infra ships in the alpha packaging (`.blockmap` assets
 * are excluded), so electron-updater is not an option and the manual
 * download→verify→apply pipeline is the honest mechanism.
 */
import {
  UPDATE_RELEASES_PAGE,
  createUpdateApplier,
  createUpdateService,
} from '@auqw/application';
import type {
  UpdateApplyPorts,
  UpdateCheckKind,
  UpdateFetchJson,
  UpdateSnapshot,
  UpdateTarget,
} from '@auqw/application';
import { accessSync, constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { shellError } from '../shared/errors.ts';

/** How far `update:apply` can honestly take this build. */
export type UpdateCapability =
  /** Release page only (flatpak bundle, unknown platforms, and any
      build with no installable artifact target). */
  | 'open'
  /** Verified download handed to the OS — dmg reveals in Finder and
      mounts; the replace is the user's drag-to-Applications. */
  | 'download'
  /** Real in-app install — NSIS setup spawns over the current install,
      AppImage replaces itself and restarts, parity with the APK leg. */
  | 'install';

/** The wire snapshot — the service's plus this build's capability. */
export type DesktopUpdateSnapshot = UpdateSnapshot & {
  readonly capability: UpdateCapability;
};

/** What `update:*` handlers + the push wiring consume. */
export interface DesktopUpdate {
  snapshot(): DesktopUpdateSnapshot;
  check(kind: UpdateCheckKind): Promise<DesktopUpdateSnapshot>;
  /** Publishes fan out on `update:state` — one notify per settled
      status transition (progress ticks included). */
  subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void;
  /** Opens the available release's page (or the releases index). */
  open(): Promise<void>;
  /** Begins the download→verify→apply pipeline for the advertised
      artifact — a no-op on 'open' builds or while a run is live. */
  apply(): Promise<void>;
  /** Refires the install handoff on the retained stage — a no-op
      outside 'applied'. The dmg leg re-opens the mounted image so
      a user who closed the installer window isn't dead-ended. */
  reapply(): Promise<void>;
  /** Aborts the live apply. */
  cancel(): Promise<void>;
  /** Relaunches into the replaced build — only honest inside
      'ready-to-restart' (AppImage rename, packaged dmg install). */
  restart(): Promise<void>;
}

/** The artifact a packaged build would fetch — flatpak bundles only
 *  inside the flatpak sandbox, AppImage everywhere else on Linux. */
export function updateTargetFor(
  platform: NodeJS.Platform,
  env: { readonly FLATPAK_ID?: string | undefined },
): UpdateTarget {
  switch (platform) {
    case 'linux':
      return {
        os: 'linux',
        prefer: env.FLATPAK_ID !== undefined ? 'flatpak' : 'appimage',
      };
    case 'darwin':
      return { os: 'mac' };
    case 'win32':
      return { os: 'win' };
    default:
      return { os: 'other' };
  }
}

/**
 * The format's honest self-install level:
 *
 * - **AppImage** (linux, `APPIMAGE` set to an absolute path inside a
 *   writable dir): the running image's path is writable — a verified
 *   `.new` sibling renames over it and the next launch is the update.
 *   `install`. An empty or relative `APPIMAGE` can't stage, and a
 *   root-owned image dir stages but can never swap — both stay `open`.
 * - **flatpak**: the sandbox's filesystem is invisible to the host
 *   (and `org.freedesktop.Flatpak` is not in finish-args, so no
 *   `flatpak-spawn --host flatpak install` either) — a staged bundle
 *   can't reach the host installer. `open`.
 * - **dmg** (mac): a dmg can't self-apply in place — verified
 *   download + Finder reveal is the honest floor. `download`.
 * - **nsis** (win): the assisted setup installs over the running
 *   install dir. `install`.
 */
export function updateCapabilityFor(
  target: UpdateTarget,
  env: { readonly APPIMAGE?: string | undefined },
  imageDirWritable: (appimage: string) => boolean = appImageDirWritable,
): UpdateCapability {
  switch (target.os) {
    case 'linux':
      return target.prefer === 'appimage' &&
        env.APPIMAGE !== undefined &&
        isAbsolute(env.APPIMAGE) &&
        imageDirWritable(env.APPIMAGE)
        ? 'install'
        : 'open';
    case 'mac':
      return 'download';
    case 'win':
      return 'install';
    default:
      return 'open';
  }
}

/** The 'install' verdict's probe: the image's own directory must
    admit the `.new` sibling + the swap rename — a root-owned path
    (a distro-managed /opt, /usr/local/bin) downloads fine but can
    never apply, which reads on the card as a retry loop that can
    only fail. Injectable so tests don't depend on this machine's
    mounts. */
function appImageDirWritable(appimage: string): boolean {
  try {
    accessSync(dirname(appimage), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const OPEN_HOST = 'github.com';
const OPEN_PATH = '/Vehicoule/Auqw/releases';

/** The restart options for the AppImage self-apply leg — kept pure
    (no electron import) so the handoff is testable. `execPath` is the
    image the apply renamed over: a bare `app.relaunch()` re-execs
    `process.execPath`, the binary inside the dying FUSE mount, and
    the "updated" app comes back as the old version. `args` carries
    the launch argv because relaunch() defaults it to [] — the new
    image would drop the user's launch flags without it. */
export function appImageRelaunchOptions(
  argv: readonly string[],
  appimagePath: string | undefined,
): { readonly args: string[]; readonly execPath?: string } {
  return {
    args: argv.slice(1),
    ...(appimagePath !== undefined ? { execPath: appimagePath } : {}),
  };
}

export function createDesktopUpdate(deps: {
  readonly currentVersion: string;
  readonly target: UpdateTarget;
  readonly fetchJson: UpdateFetchJson;
  readonly openExternal: (url: string) => Promise<void>;
  readonly capability: UpdateCapability;
  /** Override for the releases list endpoint — dev/test seam, same
      role as mobile's EXPO_PUBLIC_UPDATE_RELEASES_URL. */
  readonly releasesUrl?: string;
  /** True once THIS process has handed an installer to the OS — a
      same-version 'applied' after that is the pending-quit window,
      not a retriable offer; reapply would spawn a second wizard. */
  readonly installerSpawnedInProcess?: () => boolean;
  /** Apply transport + format installer — required past 'open'. */
  readonly applyPorts?: UpdateApplyPorts;
  /** Relaunch hook — required on formats that self-apply on restart
      (AppImage rename, packaged dmg install); absent elsewhere
      because 'ready-to-restart' can't be reached. */
  readonly relaunch?: () => void;
}): DesktopUpdate {
  const applier =
    deps.capability !== 'open' && deps.applyPorts !== undefined
      ? createUpdateApplier(deps.applyPorts)
      : undefined;
  const service = createUpdateService({
    currentVersion: deps.currentVersion,
    target: deps.target,
    fetchJson: deps.fetchJson,
    ...(deps.releasesUrl !== undefined && deps.releasesUrl !== ''
      ? { releasesUrl: deps.releasesUrl }
      : {}),
    ...(applier !== undefined ? { applier } : {}),
  });
  const snapshot = (): DesktopUpdateSnapshot => ({
    ...service.snapshot(),
    capability: deps.capability,
  });

  return {
    snapshot,
    check: (kind) => service.check(kind).then(() => snapshot()),
    subscribe: (listener) => service.subscribe(() => listener(snapshot())),
    open: () => {
      const status = service.snapshot().status;
      const url =
        status.state === 'available' ? status.url : UPDATE_RELEASES_PAGE;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return Promise.reject(
          shellError('invalid-request', 'update:open bad url'),
        );
      }
      if (
        parsed.protocol !== 'https:' ||
        parsed.hostname !== OPEN_HOST ||
        !parsed.pathname.startsWith(OPEN_PATH)
      ) {
        return Promise.reject(
          shellError('invalid-request', 'update:open refused url'),
        );
      }
      return deps.openExternal(url);
    },
    // The capability is main's own verdict — a renderer asking for
    // apply on an 'open' build gets a silent no-op, not a download.
    apply: () => {
      if (applier === undefined) {
        return Promise.reject(
          shellError('invalid-request', 'update:apply on an open build'),
        );
      }
      service.apply();
      return Promise.resolve();
    },
    reapply: () => {
      // 'applied' inside the pre-quit window is the spawn having
      // fired, not a retriable offer — re-tapping there would stack
      // a second wizard while the first installs.
      if (deps.installerSpawnedInProcess?.() === true) {
        return Promise.resolve();
      }
      service.reapply();
      return Promise.resolve();
    },
    cancel: () => {
      service.cancelApply();
      return Promise.resolve();
    },
    restart: () => {
      if (
        service.snapshot().apply.state !== 'ready-to-restart' ||
        deps.relaunch === undefined
      ) {
        return Promise.reject(
          shellError('invalid-request', 'update:restart out of phase'),
        );
      }
      deps.relaunch();
      return Promise.resolve();
    },
  };
}
