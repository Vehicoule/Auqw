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
  | {
      readonly os: 'android';
      /** The device's `Build.SUPPORTED_ABIS`, preference-ordered.
       *  APK assets carry their ABI in the name ('…-android-<abi>.apk',
       *  tooling/release.yml), and a foreign-ABI APK downloads in full
       *  only to die at the system installer
       *  (INSTALL_FAILED_NO_MATCHING_ABIS). */
      readonly supportedAbis: readonly string[];
    }
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

/** The snapshot contract's bound on every version field
 *  (apps/desktop shared/contract.ts `v.boundedString(64)`): a tag
 *  that normalizes past it ships an 'available' snapshot no
 *  delivery path accepts, so it reads like an unparseable tag. */
const VERSION_MAX_LENGTH = 64;

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
  const version =
    match[4] === undefined
      ? `${match[1]}.${match[2]}.${match[3]}`
      : `${match[1]}.${match[2]}.${match[3]}-${match[4]}`;
  return version.length <= VERSION_MAX_LENGTH ? version : null;
}

type ParsedVersion = {
  readonly numbers: readonly [number, number, number];
  readonly prerelease: readonly (number | string)[];
};

function parse(version: string): ParsedVersion | null {
  // The tail starts at the FIRST '-' — a hyphen inside it is a legal
  // identifier char ('1.0.0-alpha-1'), not a second split point.
  const hyphen = version.indexOf('-');
  const core = hyphen < 0 ? version : version.slice(0, hyphen);
  const pre = hyphen < 0 ? undefined : version.slice(hyphen + 1);
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

/** Every platform's staging joins the asset name into a directory —
 *  only a bare basename is safe to join; a separator or dot-escape
 *  would write outside the staging dir. */
function isBareName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..'
  );
}

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
    // The name becomes a path component on every platform's staging
    // — it must arrive already a basename.
    return typeof name === 'string' &&
      isBareName(name) &&
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

/** The per-platform SHA256SUMS asset name the release workflow
 *  publishes (`tooling/checksums.mjs` — "<hex>  <name>" lines). The
 *  Android file takes a platform name because its job runs on an
 *  ubuntu runner (`runner.os` would collide with desktop Linux). */
export function checksumsNameFor(target: UpdateTarget): string | null {
  switch (target.os) {
    case 'android':
      return 'SHA256SUMS-Android.txt';
    case 'linux':
      return 'SHA256SUMS-Linux.txt';
    case 'mac':
      return 'SHA256SUMS-macOS.txt';
    case 'win':
      return 'SHA256SUMS-Windows.txt';
    case 'other':
      return null;
  }
}

/** The checksums asset covering this target's artifact, if shipped. */
export function pickChecksums(
  assets: readonly UpdateArtifact[],
  target: UpdateTarget,
): UpdateArtifact | null {
  const name = checksumsNameFor(target);
  return name === null
    ? null
    : (assets.find((asset) => asset.name === name) ?? null);
}

/**
 * `SHA256SUMS-*.txt` body → name → hex. Lines are `<hex>  <name>`
 * (sha256sum -c compatible); anything else — comment, blank, odd
 * width — is skipped rather than poisoning the whole map.
 */
export function parseSha256Sums(text: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    // "<hex>  <name>" (text mode) or "<hex> *<name>" (binary mode).
    // Trailing space trims in code: a lazy tail in the pattern would
    // backtrack over every interior space run — quadratic on repeats.
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    const name = match?.[2]?.trimEnd();
    if (name === undefined || name === '') {
      continue;
    }
    map.set(name, match![1]!.toLowerCase());
  }
  return map;
}

/** '<…>-android-<abi>.apk' → '<abi>' — the release workflow names
 *  per-ABI splits 'auqw-<version>-android-<abi>.apk'. */
function apkAbi(name: string): string | null {
  return /-android-([0-9A-Za-z_-]+)\.apk$/.exec(name)?.[1] ?? null;
}

/** The artifact this target installs, if the release ships one. */
export function pickArtifact(
  assets: readonly UpdateArtifact[],
  target: UpdateTarget,
): UpdateArtifact | null {
  // Android selects by the device's ABI preference order, never by
  // asset order — a release shipping several splits must land the
  // one this CPU runs. 'universal' is the fallback when no split
  // matches, and no match at all advertises 'open'.
  if (target.os === 'android') {
    const byAbi = (abi: string): UpdateArtifact | null =>
      assets.find(
        (asset) => isBareName(asset.name) && apkAbi(asset.name) === abi,
      ) ?? null;
    for (const abi of target.supportedAbis) {
      const artifact = byAbi(abi);
      if (artifact !== null) {
        return artifact;
      }
    }
    return byAbi('universal');
  }
  const wants = (name: string): boolean => {
    switch (target.os) {
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
  // The basename gate repeats the parse-side check: an artifact
  // built outside parseRelease stages into the same dirs.
  return (
    assets.find((asset) => isBareName(asset.name) && wants(asset.name)) ??
    null
  );
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
      /** This platform's SHA256SUMS asset — the integrity check every
       *  self-install path verifies before the install hand-off. Null
       *  when the release predates checksum publishing or ships no
       *  file for this platform: an unverifiable artifact must not
       *  self-install. */
      readonly checksums: UpdateArtifact | null;
    }
  | { readonly state: 'failed'; readonly error: AppError };

/**
 * The apply pipeline — what happens after 'available' once the
 * platform's install affordance runs. Shared vocabulary: every
 * self-install leg is download (byte progress) → verify (the
 * SHA256SUMS line for this artifact) → apply (the platform's own
 * install mechanic). 'ready-to-restart' is the terminal pre-quit
 * state for formats that self-apply on relaunch (AppImage);
 * 'applied' means an OS surface took over (APK sheet, NSIS
 * installer, Finder-revealed dmg); 'failed' is retryable by the
 * same affordance that started it.
 */
export type UpdateApplyStatus =
  | { readonly state: 'idle' }
  | {
      readonly state: 'downloading';
      readonly version: string;
      readonly receivedBytes: number;
      /** null when the server sends no Content-Length. */
      readonly totalBytes: number | null;
    }
  | { readonly state: 'verifying'; readonly version: string }
  | { readonly state: 'applying'; readonly version: string }
  | { readonly state: 'ready-to-restart'; readonly version: string }
  | { readonly state: 'applied'; readonly version: string }
  | {
      readonly state: 'failed';
      readonly version: string;
      readonly error: AppError;
    };

export type UpdateSnapshot = {
  readonly status: UpdateStatus;
  readonly currentVersion: string;
  readonly apply: UpdateApplyStatus;
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
  /**
   * Begin the apply pipeline for the currently-'available' release —
   * no-op while the status is anything else, the release ships no
   * artifact, or no applier is wired (open-page platforms never
   * reach here).
   */
  apply(): void;
  /** Abort an in-flight apply — back to 'idle'; no-op otherwise. */
  cancelApply(): void;
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
  /** The platform's apply leg — absent on open-page platforms. */
  readonly applier?: UpdateApplier;
}): UpdateService {
  const url = deps.releasesUrl ?? UPDATE_RELEASES_URL;
  let snapshot: UpdateSnapshot = {
    status: { state: 'idle' },
    currentVersion: deps.currentVersion,
    apply: { state: 'idle' },
  };
  let booted = false;
  let inflight: Promise<UpdateSnapshot> | null = null;
  const listeners = new Set<() => void>();

  function publish(status: UpdateStatus): void {
    snapshot = {
      status,
      currentVersion: deps.currentVersion,
      apply: deps.applier?.snapshot() ?? { state: 'idle' },
    };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a throwing subscriber must not wedge the publisher
      }
    }
  }

  // Apply progress republishes under the unchanged check status —
  // one feed carries both halves of the seam.
  deps.applier?.subscribe(() => publish(snapshot.status));

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
      // A 200 whose body isn't the list is a failed check, not
      // 'current' — malformed payloads must not read as "up to date".
      if (!Array.isArray(reply.body)) {
        throw appError('invalid-response', 'releases payload was not a list');
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
          checksums: pickChecksums(latest.assets, deps.target),
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
    apply() {
      const status = snapshot.status;
      if (
        status.state !== 'available' ||
        status.artifact === null ||
        deps.applier === undefined
      ) {
        return;
      }
      deps.applier.begin({
        version: status.version,
        artifact: status.artifact,
        checksums: status.checksums,
      });
    },
    cancelApply() {
      deps.applier?.cancel();
    },
  };
}

// ---- the apply pipeline ----------------------------------------------

/** What `begin` needs out of the settled 'available' payload. */
export type UpdateApplyTarget = {
  readonly version: string;
  readonly artifact: UpdateArtifact;
  readonly checksums: UpdateArtifact | null;
};

/** Minimal abort surface — lib-free like oauth's declaration. A real
    `AbortSignal`/`AbortController` assigns to these on both runtimes. */
type AbortSignalLike = { readonly aborted: boolean };
type AbortControllerLike = {
  readonly signal: AbortSignalLike;
  abort(): void;
};
declare const AbortController: { new (): AbortControllerLike };

/**
 * What the platform supplies for a self-install. Each port is a thin
 * platform call — the applier owns ordering, progress publishes,
 * checksum gating, and the taxonomy so every leg (Electron net.fetch
 * → fs, RN File.downloadFileAsync → FileHandle) stays a three-line
 * transport exactly like `UpdateFetchJson`.
 */
export interface UpdateApplyPorts {
  /** Absolute staging path the artifact downloads to. */
  stagePath(artifact: UpdateArtifact): string;
  /** Fetch a small text asset — the per-platform SHA256SUMS file. */
  fetchText(url: string, signal: AbortSignalLike): Promise<string>;
  /** Stream-download to the staged path; reports byte progress and
      rejects on abort. A retry may overwrite a leftover file. */
  download(
    url: string,
    path: string,
    onProgress: (receivedBytes: number, totalBytes: number | null) => void,
    signal: AbortSignalLike,
  ): Promise<void>;
  /** Lowercase hex SHA-256 of the file at path. */
  sha256Hex(path: string): Promise<string>;
  /** The platform's own install mechanic over a verified file —
   *  resolves 'relaunch' when the on-disk binary was replaced and a
   *  restart applies it (AppImage), 'installed' when an OS surface
   *  took over (APK installer sheet, NSIS setup, Finder-revealed dmg). */
  apply(path: string, artifact: UpdateArtifact): Promise<'relaunch' | 'installed'>;
  /** Best-effort staged-file removal — a rejected artifact never
      stays behind for a later verify to trip on. */
  remove(path: string): Promise<void>;
}

export interface UpdateApplier {
  /** Latest apply state — stable reference between publishes. */
  snapshot(): UpdateApplyStatus;
  /** Change feed — fires once per state transition (and per progress
      tick while 'downloading'). */
  subscribe(listener: () => void): () => void;
  /** Start the pipeline; no-op while a run is live or already
      terminal ('ready-to-restart', 'applied'). */
  begin(target: UpdateApplyTarget): void;
  /** Abort the live run — publishes 'idle' so the affordance returns
      to its install label. */
  cancel(): void;
}

function applyError(thrown: unknown): AppError {
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
          : 'update apply failed';
      return appError(kind, message);
    }
  }
  return appError('transient', 'update apply failed');
}

/** AbortError (DOMException name or coded) — a cancel is user intent,
    never a failure. */
function isAbort(thrown: unknown): boolean {
  return (
    thrown !== null &&
    typeof thrown === 'object' &&
    (('name' in thrown && (thrown as { name: unknown }).name === 'AbortError') ||
      ('kind' in thrown && (thrown as { kind: unknown }).kind === 'cancelled'))
  );
}

/**
 * download → verify → apply, as a published state machine. The
 * checksum file is fetched FIRST — a release that can't prove the
 * artifact fails before any bytes land. Verification failure removes
 * the staged file and reports 'artifact-rejected', never 'transient':
 * a checksum mismatch is tamper/corruption evidence, not a blip.
 */
export function createUpdateApplier(ports: UpdateApplyPorts): UpdateApplier {
  let state: UpdateApplyStatus = { state: 'idle' };
  const listeners = new Set<() => void>();
  let controller: AbortControllerLike | null = null;
  // Generation guard: a stale run (post-cancel, post-begin) must
  // never publish over a newer state.
  let generation = 0;
  // In-flight latch, set synchronously in begin: live() only sees
  // the published states, but a run between begin and its first
  // publish would otherwise admit a second begin — two downloads
  // racing one staging path.
  let running = false;
  // Which generation last claimed EACH staging path — a stale run
  // deletes its own leftover but never a successor's download, even
  // when successive releases stage under different names.
  const claims = new Map<string, number>();

  function publish(next: UpdateApplyStatus): void {
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a throwing subscriber must not wedge the publisher
      }
    }
  }

  const live = (): boolean =>
    state.state === 'downloading' ||
    state.state === 'verifying' ||
    state.state === 'applying';

  async function run(
    target: UpdateApplyTarget,
    gen: number,
    signal: AbortSignalLike,
  ): Promise<void> {
    const publishIfCurrent = (next: UpdateApplyStatus): void => {
      if (gen === generation) {
        publish(next);
      }
    };
    // A cancelled/superseded run must not only stop publishing — it
    // must stop ACTING (a later stage like apply or remove writes
    // the same staging path its successor may have just claimed).
    const stale = (): boolean => gen !== generation || signal.aborted;
    const { version, artifact, checksums } = target;
    // The staged file — removed whenever this run dies before the
    // apply leg consumed it (failed download, rejected checksum,
    // apply throw, or a cancel between stages): an unconsumed
    // artifact never stays behind.
    let path: string | null = null;
    // A stale run still drops its OWN staged file — a cancel mid-
    // verify must not strand a download — but never the path a
    // newer run just claimed (claims marks each path's claimant).
    const dropOwned = (): void => {
      if (path !== null && claims.get(path) === gen) {
        const staged = path;
        path = null;
        claims.delete(staged);
        void ports.remove(staged).catch(() => undefined);
      }
    };
    try {
      // Integrity metadata rides first: no sums asset → the artifact
      // is unverifiable and the honest answer is refusal (the open-page
      // path still serves this release).
      if (checksums === null) {
        throw appError('unavailable', 'release ships no checksums for this platform');
      }
      const body = await ports.fetchText(checksums.url, signal);
      if (stale()) {
        return;
      }
      const expected = parseSha256Sums(body).get(artifact.name);
      if (expected === undefined) {
        throw appError(
          'invalid-response',
          'artifact absent from the release checksums',
        );
      }
      path = ports.stagePath(artifact);
      claims.set(path, gen);
      publishIfCurrent({
        state: 'downloading',
        version,
        receivedBytes: 0,
        totalBytes: null,
      });
      await ports.download(
        artifact.url,
        path,
        (receivedBytes, totalBytes) =>
          publishIfCurrent({ state: 'downloading', version, receivedBytes, totalBytes }),
        signal,
      );
      if (stale()) {
        dropOwned();
        return;
      }
      publishIfCurrent({ state: 'verifying', version });
      const actual = await ports.sha256Hex(path);
      if (stale()) {
        dropOwned();
        return;
      }
      if (actual.toLowerCase() !== expected) {
        // The catch's sweep removes the staged file — the verdict
        // itself is the important part: 'artifact-rejected', never
        // 'transient' — a mismatch is tamper/corruption evidence.
        throw appError(
          'artifact-rejected',
          'downloaded artifact fails its published checksum',
        );
      }
      publishIfCurrent({ state: 'applying', version });
      const outcome = await ports.apply(path, artifact);
      if (stale()) {
        dropOwned();
        return;
      }
      // The apply leg consumed the file (renamed into place, spawned
      // as the installer, revealed in Finder) — cleanup is its
      // responsibility now, not the sweep's.
      claims.delete(path);
      path = null;
      publishIfCurrent(
        outcome === 'relaunch'
          ? { state: 'ready-to-restart', version }
          : { state: 'applied', version },
      );
    } catch (thrown) {
      // Cleanup before the generation gate: a stale run's own
      // leftover still goes (cancel-then-retry leaves no partial),
      // but a successor's claimed path is untouched.
      dropOwned();
      if (gen !== generation) {
        return;
      }
      if (isAbort(thrown)) {
        publish({ state: 'idle' });
      } else {
        publish({ state: 'failed', version, error: applyError(thrown) });
      }
    } finally {
      if (gen === generation) {
        controller = null;
        running = false;
      }
    }
  }

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(target) {
      if (
        running ||
        live() ||
        state.state === 'ready-to-restart' ||
        state.state === 'applied'
      ) {
        return;
      }
      running = true;
      generation += 1;
      const gen = generation;
      controller = new AbortController();
      const signal = controller.signal;
      // The publish happens inside run's try so the state lands
      // before any synchronous port throw could misorder events.
      void run(target, gen, signal);
    },
    cancel() {
      generation += 1;
      controller?.abort();
      controller = null;
      // The latch releases with the abort — the dying run can no
      // longer publish, remove, or apply (stale checks), so a fresh
      // begin is safe to claim the staging path.
      running = false;
      if (live()) {
        publish({ state: 'idle' });
      }
    },
  };
}
