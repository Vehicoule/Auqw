/**
 * Release update check — the one shared piece both apps run: parse the
 * GitHub releases list (not `/latest`, which 404s while every release
 * is a prerelease), semver-compare against the running version, pick
 * this platform's artifact, and rate-limit to once per boot + manual.
 * The seam carries no telemetry — the only egress is this endpoint
 * plus whatever install affordance the platform's port runs.
 */
import { appError, appErrorKind } from './errors.ts';
import type { AppError } from './errors.ts';

/** The releases list — sorted newest-first by creation, drafts
 *  included only for collaborators (anonymous sees published only). */
export const UPDATE_RELEASES_URL =
  'https://api.github.com/repos/Vehicoule/Auqw/releases?per_page=12';

/** Fallback open target when the snapshot carries no release URL. */
export const UPDATE_RELEASES_PAGE =
  'https://github.com/Vehicoule/Auqw/releases';

/** One shipped artifact on a release (`name`, `browser_download_url`). */
export type UpdateArtifact = {
  readonly name: string;
  readonly url: string;
};

/** A published release row reduced to what the check consumes. */
export type UpdateRelease = {
  /** Version without the `v` prefix ('0.0.1-alpha.18'). */
  readonly version: string;
  /** Release notes page — the open-page install path's target. */
  readonly url: string;
  readonly assets: readonly UpdateArtifact[];
};

/** Which shipped artifact this build could consume, if it self-installs. */
export type UpdateTarget =
  | { readonly os: 'android' }
  | {
      readonly os: 'linux';
      /** AppImage can't self-update but rides as the informational
       *  artifact; flatpak installs prefer the flatpak bundle. */
      readonly prefer: 'appimage' | 'flatpak';
    }
  | { readonly os: 'mac' | 'win' }
  | { readonly os: 'other' };

// ---- semver ---------------------------------------------------------

const VERSION_TAG = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Strip the `v` prefix and validate the semver shape the release
 * workflow stamps (`tooling/stamp-version.mjs`): `MAJOR.MINOR.PATCH`
 * with an optional dot-separated prerelease tail. Build-metadata (`+`)
 * is not shipped, so it is not part of the grammar. Returns null for
 * anything unparseable — an unorderable tag is skipped, never guessed.
 */
export function parseVersionTag(tag: string): string | null {
  const match = VERSION_TAG.exec(tag);
  if (match === null || match[4] === '') {
    return null;
  }
  return match[4] === undefined
    ? `${match[1]}.${match[2]}.${match[3]}`
    : `${match[1]}.${match[2]}.${match[3]}-${match[4]}`;
}

type ParsedVersion = {
  readonly numbers: readonly [number, number, number];
  readonly prerelease: readonly (number | string)[];
};

function parse(version: string): ParsedVersion | null {
  const [core, pre] = version.split('-', 2);
  const parts = core?.split('.').map((p) => Number.parseInt(p, 10));
  if (
    parts === undefined ||
    parts.length !== 3 ||
    parts.some((p) => !Number.isSafeInteger(p))
  ) {
    return null;
  }
  const prerelease =
    pre === undefined || pre === ''
      ? []
      : pre
          .split('.')
          .map((ident) =>
            /^\d+$/.test(ident) ? Number.parseInt(ident, 10) : ident,
          );
  return {
    numbers: parts as unknown as readonly [number, number, number],
    prerelease,
  };
}

/**
 * Semver ordering, prerelease-aware: a release outranks the same
 * triple's prereleases; numeric identifiers sort below alphanumeric
 * and a shorter prefix sorts below its extension. Returns <0/0/>0 —
 * unparseable inputs compare as equal (callers parse first).
 */
export function compareVersions(a: string, b: string): number {
  const va = parse(a);
  const vb = parse(b);
  if (va === null || vb === null) {
    return 0;
  }
  for (let i = 0; i < 3; i += 1) {
    const d = va.numbers[i]! - vb.numbers[i]!;
    if (d !== 0) {
      return d;
    }
  }
  const pa = va.prerelease;
  const pb = vb.prerelease;
  if (pa.length === 0 && pb.length === 0) {
    return 0;
  }
  // A bare release outranks every prerelease of the same triple.
  if (pa.length === 0) {
    return 1;
  }
  if (pb.length === 0) {
    return -1;
  }
  const len = Math.min(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (x === y) {
      continue;
    }
    const xNum = typeof x === 'number';
    const yNum = typeof y === 'number';
    if (xNum && yNum) {
      return x - y;
    }
    if (xNum !== yNum) {
      // Numeric identifiers sort before alphanumeric ones.
      return xNum ? -1 : 1;
    }
    return (x as string) < (y as string) ? -1 : 1;
  }
  return pa.length - pb.length;
}

// ---- GitHub payload parsing -----------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One release row → `UpdateRelease`, or null for drafts and rows whose
 * tag isn't a shipped version. Malformed URLs/names drop the row
 * rather than the whole check — a single odd asset never blocks the
 * update verdict.
 */
export function parseRelease(value: unknown): UpdateRelease | null {
  if (!isRecord(value) || value['draft'] === true) {
    return null;
  }
  const tag = value['tag_name'];
  const url = value['html_url'];
  const rawAssets = value['assets'];
  if (
    typeof tag !== 'string' ||
    typeof url !== 'string' ||
    !url.startsWith('https://') ||
    !Array.isArray(rawAssets)
  ) {
    return null;
  }
  const version = parseVersionTag(tag);
  if (version === null) {
    return null;
  }
  const assets = rawAssets.flatMap((asset): readonly UpdateArtifact[] => {
    if (!isRecord(asset)) {
      return [];
    }
    const name = asset['name'];
    const download = asset['browser_download_url'];
    return typeof name === 'string' &&
      name.length > 0 &&
      typeof download === 'string' &&
      download.startsWith('https://')
      ? [{ name, url: download }]
      : [];
  });
  return { version, url, assets };
}

/** `GET /repos/{owner}/{repo}/releases` body → parsed releases. */
export function parseReleases(body: unknown): readonly UpdateRelease[] {
  return Array.isArray(body)
    ? body.flatMap((row) => {
        const release = parseRelease(row);
        return release === null ? [] : [release];
      })
    : [];
}

/** The newest published version strictly above `current`, or null. */
export function latestNewer(
  releases: readonly UpdateRelease[],
  current: string,
): UpdateRelease | null {
  let best: UpdateRelease | null = null;
  for (const release of releases) {
    if (compareVersions(release.version, current) <= 0) {
      continue;
    }
    if (best === null || compareVersions(release.version, best.version) > 0) {
      best = release;
    }
  }
  return best;
}

/** The artifact this target installs, if the release ships one. */
export function pickArtifact(
  assets: readonly UpdateArtifact[],
  target: UpdateTarget,
): UpdateArtifact | null {
  const wants = (name: string): boolean => {
    switch (target.os) {
      case 'android':
        return name.includes('-android-') && name.endsWith('.apk');
      case 'linux':
        return target.prefer === 'flatpak'
          ? name.endsWith('.flatpak')
          : name.endsWith('.AppImage');
      case 'mac':
        return name.endsWith('.dmg');
      case 'win':
        return name.endsWith('-setup.exe');
      case 'other':
        return false;
    }
  };
  return assets.find((asset) => wants(asset.name)) ?? null;
}

// ---- the check -------------------------------------------------------

/** The check's outcome — the settings row + banner render this. */
export type UpdateStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'checking' }
  | { readonly state: 'current' }
  | {
      readonly state: 'available';
      readonly version: string;
      /** Release notes page (also the open-page install target). */
      readonly url: string;
      /** This platform's artifact — null when the release ships none
       *  or this platform only opens the page. */
      readonly artifact: UpdateArtifact | null;
    }
  | { readonly state: 'failed'; readonly error: AppError };

export type UpdateSnapshot = {
  readonly status: UpdateStatus;
  readonly currentVersion: string;
};

export type UpdateCheckKind = 'boot' | 'manual';

/**
 * What the platform supplies: a raw JSON GET. The service owns the
 * URL, the status→error mapping, and the payload parse so each leg
 * (Electron `net.fetch`, RN `fetch`) stays a three-line transport.
 */
export type UpdateFetchJson = (
  url: string,
) => Promise<{ readonly status: number; readonly body: unknown }>;

export interface UpdateService {
  /** Latest outcome — stable reference between publishes. */
  snapshot(): UpdateSnapshot;
  /** Change feed — fires once per settled status transition. */
  subscribe(listener: () => void): () => void;
  /**
   * `boot` runs at most once per process (later calls resolve with
   * the live snapshot); `manual` always re-fetches. A check already
   * in flight is shared, never duplicated — both callers get the
   * same settled snapshot.
   */
  check(kind: UpdateCheckKind): Promise<UpdateSnapshot>;
}

/** Normalize whatever the check threw into the taxonomy. */
function checkError(thrown: unknown): AppError {
  if (
    thrown !== null &&
    typeof thrown === 'object' &&
    'kind' in thrown &&
    typeof (thrown as { kind: unknown }).kind === 'string'
  ) {
    const kind = appErrorKind((thrown as { kind: string }).kind);
    if (kind !== 'internal') {
      const message =
        'message' in thrown &&
        typeof (thrown as { message: unknown }).message === 'string'
          ? (thrown as { message: string }).message
          : 'update check failed';
      return appError(kind, message);
    }
  }
  // Offline / DNS / TLS / aborted — all read the same to the user.
  return appError('transient', 'update check failed');
}

export function createUpdateService(deps: {
  readonly currentVersion: string;
  readonly target: UpdateTarget;
  readonly fetchJson: UpdateFetchJson;
  /** Override for tests; production default is the releases list. */
  readonly releasesUrl?: string;
}): UpdateService {
  const url = deps.releasesUrl ?? UPDATE_RELEASES_URL;
  let snapshot: UpdateSnapshot = {
    status: { state: 'idle' },
    currentVersion: deps.currentVersion,
  };
  let booted = false;
  let inflight: Promise<UpdateSnapshot> | null = null;
  const listeners = new Set<() => void>();

  function publish(status: UpdateStatus): void {
    snapshot = { status, currentVersion: deps.currentVersion };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a throwing subscriber must not wedge the publisher
      }
    }
  }

  async function run(): Promise<UpdateSnapshot> {
    publish({ state: 'checking' });
    try {
      const reply = await deps.fetchJson(url);
      if (reply.status === 403 || reply.status === 429) {
        throw appError('rate-limit', `github responded ${reply.status}`);
      }
      if (reply.status < 200 || reply.status >= 300) {
        throw appError('transient', `github responded ${reply.status}`);
      }
      const releases = parseReleases(reply.body);
      const latest = latestNewer(releases, deps.currentVersion);
      if (latest === null) {
        publish({ state: 'current' });
      } else {
        publish({
          state: 'available',
          version: latest.version,
          url: latest.url,
          artifact: pickArtifact(latest.assets, deps.target),
        });
      }
    } catch (thrown) {
      publish({ state: 'failed', error: checkError(thrown) });
    }
    return snapshot;
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check(kind) {
      if (kind === 'boot') {
        if (booted) {
          return Promise.resolve(snapshot);
        }
        booted = true;
      }
      if (inflight !== null) {
        return inflight;
      }
      inflight = run().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
