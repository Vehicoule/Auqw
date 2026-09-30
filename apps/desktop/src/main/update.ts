/**
 * Release update check — the desktop leg. The renderer's CSP admits
 * only 'self', so the GitHub egress lives here in main: the shared
 * `createUpdateService` runs against `net.fetch`, and the renderer
 * sees validated snapshots + verbs over `update:*` channels. The open
 * affordance takes no URL argument — no renderer input can steer it —
 * main opens the release URL its own snapshot recorded, allowlisted
 * to this repo's releases tree. No updater infra ships in the alpha
 * packaging (`.blockmap` assets are excluded), so the install level
 * reached here is open-the-release-page; the decision row records it.
 */
import {
  UPDATE_RELEASES_PAGE,
  createUpdateService,
} from '@auqw/application';
import type {
  UpdateCheckKind,
  UpdateFetchJson,
  UpdateSnapshot,
  UpdateTarget,
} from '@auqw/application';
import { shellError } from '../shared/errors.ts';

/** What `update:*` handlers + the push wiring consume. */
export interface DesktopUpdate {
  snapshot(): UpdateSnapshot;
  check(kind: UpdateCheckKind): Promise<UpdateSnapshot>;
  /** Publishes fan out on `update:state` — one notify per settled
      status transition. */
  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void;
  /** Opens the available release's page (or the releases index). */
  open(): Promise<void>;
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

const OPEN_HOST = 'github.com';
const OPEN_PATH = '/Vehicoule/Auqw/releases';

export function createDesktopUpdate(deps: {
  readonly currentVersion: string;
  readonly target: UpdateTarget;
  readonly fetchJson: UpdateFetchJson;
  readonly openExternal: (url: string) => Promise<void>;
}): DesktopUpdate {
  const service = createUpdateService({
    currentVersion: deps.currentVersion,
    target: deps.target,
    fetchJson: deps.fetchJson,
  });

  return {
    snapshot: () => service.snapshot(),
    check: (kind) => service.check(kind),
    subscribe: (listener) =>
      service.subscribe(() => listener(service.snapshot())),
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
  };
}
