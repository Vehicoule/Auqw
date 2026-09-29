import { constants, type Stats } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CHANNELS } from '../shared/channels.ts';
import { errorCode } from '../shared/check.ts';
import type {
  LocalAddArgs,
  LocalProbeArgs,
  LocalReadArgs,
  LocalResolveArgs,
} from '../shared/contract.ts';
import {
  isLocalAddArgs,
  isLocalProbeArgs,
  isLocalReadArgs,
  isLocalResolveArgs,
} from '../shared/contract.ts';
import { isShellError, shellError } from '../shared/errors.ts';
import {
  dirTreeUri,
  docIdConfined,
  docUriFor,
  fileUrlPath,
  parseTree,
  pathConfined,
  pickedFileTreeUri,
  toFileUri,
} from '../shared/local-paths.ts';
import type { UtilityHandler } from './router.ts';
import { mimeForPath } from '../shared/audio-mime.ts';
import { isBareName } from './transfer.ts';

/**
 * `local:*` — the desktop local-files surface the renderer's engines
 * and the `localPlaybackFor` seam sit on.
 *
 * The domain index (`local_sources`/`local_files`/`downloads`) is
 * owned by the renderer-side `LocalFileSource`/`DownloadManager`
 * engines — scans and removals are their transactions, carried over
 * the existing `storage:*` channels. This service owns the pieces that
 * are inherently utility-side: validating renderer-picked paths into
 * `treeUri`/`label` descriptors (`local:add`, the half of addFolder
 * that needs a real filesystem), probing the index for a playable
 * `file://` URI (`local:probe`/`local:playback`), and the startup
 * integrity sweep (`local:sweep` — index rows whose files vanished).
 */

export type LocalServiceOptions = {
  /** Shared read accessor over the domain database file. */
  readonly database: () => DatabaseSync | null;
  /** Managed media dir — for probing `downloads.file_path` rows. */
  readonly mediaDir: string | undefined;
};

export type LocalService = {
  readonly handlers: Readonly<Record<string, UtilityHandler>>;
  readonly close: () => void;
};

type PickedTree = {
  readonly treeUri: string;
  readonly label: string;
  readonly kind: 'dir' | 'file';
};

/** Rethrows ShellErrors, wraps everything else as `io-error`. */
function asIo(message: string, thrown: unknown): never {
  if (isShellError(thrown)) {
    throw thrown;
  }
  throw shellError('io-error', message);
}

/**
 * A name that does not resolve is absent; a name that resolves but
 * refuses is typed. 'missing' is reserved for genuinely-gone files —
 * the sweep prunes index rows on it, so a permission fault must never
 * read as missing. Same split as `scanFailure` in the tag plane.
 */
function statError(thrown: unknown): null {
  const code = errorCode(thrown);
  // ELOOP joins the absent family: a symlink loop (or a leaf refused
  // under O_NOFOLLOW) means the name never reaches a real file, and
  // 'missing' beats a retryable io-error for a fault that won't heal.
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    return null;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    throw shellError('permission-denied', 'path is not readable');
  }
  throw shellError('io-error', 'path could not be statted');
}

// `local:read` opens with O_NOFOLLOW so a leaf swapped for a symlink
// after the gate's realpath is refused (ELOOP) rather than followed,
// and O_NONBLOCK so an owned-name FIFO can never park the worker
// thread on a blocking open. Both are best-effort hints outside
// POSIX — absent constants degrade to a plain read-only open.
const READ_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

async function statChecked(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (thrown) {
    return statError(thrown);
  }
}

async function realpathChecked(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (thrown) {
    return statError(thrown);
  }
}

/** True for the typed faults a probe/sweep row tolerates: the file
 * exists but can't be served — skipped, never counted missing. */
function unreadable(thrown: unknown): boolean {
  return isShellError(thrown) && thrown.kind === 'permission-denied';
}

/**
 * One picked path → a grant descriptor. The "allowed root" on desktop
 * is whatever the user picked in the OS dialog — the honest checks are
 * that the path is absolute, resolves to something real, is readable,
 * and is either a directory or a known audio file.
 */
async function describePick(path: string): Promise<PickedTree> {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw shellError(
      'invalid-request',
      'picked path must be an absolute path',
    );
  }
  const real = await realpathChecked(path);
  if (real === null) {
    throw shellError('invalid-request', 'picked path does not resolve');
  }
  const info = await statChecked(real);
  if (info === null) {
    throw shellError('invalid-request', 'picked path is not statable');
  }
  if (info.isDirectory()) {
    return {
      treeUri: dirTreeUri(real),
      label: basename(real) || real,
      kind: 'dir',
    };
  }
  if (!info.isFile() || mimeForPath(real) === null) {
    throw shellError(
      'invalid-request',
      'picked path is not a directory or a readable audio file',
    );
  }
  await access(real).catch(() => {
    throw shellError('permission-denied', 'picked file is not readable');
  });
  return {
    treeUri: pickedFileTreeUri(real),
    label: basename(real),
    kind: 'file',
  };
}

/**
 * Resolve a (treeUri, docId) index row to a real filesystem path —
 * the same confinement the tagread plane applies, duplicated here so
 * probing never opens a file outside its grant.
 */
async function probeDocAbs(
  treeUri: string,
  docId: string,
): Promise<string | null> {
  const tree = parseTree(treeUri);
  if (tree === null) {
    return null;
  }
  if (tree.kind === 'file') {
    const info = await statChecked(tree.absPath);
    return info !== null && info.isFile() ? tree.absPath : null;
  }
  if (!docIdConfined(docId)) {
    return null;
  }
  const rootReal = await realpathChecked(tree.absPath);
  if (rootReal === null) {
    return null;
  }
  const joined = join(rootReal, ...docId.split('/'));
  const real = await realpathChecked(joined);
  if (real === null || !pathConfined(rootReal, real)) {
    return null;
  }
  const info = await statChecked(real);
  return info !== null && info.isFile() ? real : null;
}

/** One local_files row joined to its source, for probe/playback/sweep. */
type LocalRow = {
  readonly fileId: string;
  readonly sourceId: string;
  readonly docId: string;
  readonly treeUri: string;
  readonly recordingId: string;
};

function localRows(db: DatabaseSync): LocalRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT f.file_id AS fileId, f.source_id AS sourceId,
                f.doc_id AS docId, s.tree_uri AS treeUri,
                f.recording_id AS recordingId
         FROM local_files f
         JOIN local_sources s ON s.source_id = f.source_id`,
      )
      .all() as Record<string, unknown>[];
    return rows.filter(
      (row): row is LocalRow =>
        typeof row['fileId'] === 'string' &&
        typeof row['sourceId'] === 'string' &&
        typeof row['docId'] === 'string' &&
        typeof row['treeUri'] === 'string' &&
        typeof row['recordingId'] === 'string',
    );
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : '';
    if (message.includes('no such table')) {
      return [];
    }
    asIo('local index read failed', thrown);
  }
}

export function createLocalService(options: LocalServiceOptions): LocalService {
  async function add(args: LocalAddArgs): Promise<unknown> {
    const picks: PickedTree[] = [];
    for (const path of args.paths) {
      picks.push(await describePick(path));
    }
    return { picks };
  }

  /**
   * `local:probe` — the playback lookup `localPlaybackFor` semantics
   * need: downloads first (an `available` row whose bytes exist), then
   * provenance-local rows (a scanned file that still exists).
   */
  async function probe(args: LocalProbeArgs): Promise<unknown> {
    const db = options.database();
    if (db === null) {
      return { uri: null };
    }
    try {
      const downloads = db
        .prepare(
          `SELECT file_path AS filePath FROM downloads
           WHERE recording_id = ? AND state = 'available'`,
        )
        .all(args.recordingId) as { filePath?: unknown }[];
      // file_path is a managed-dir name by the port convention — a
      // row carrying separators would escape the media dir, so a
      // non-bare value is treated as no playable bytes (never joined).
      for (const download of downloads) {
        if (
          typeof download.filePath !== 'string' ||
          options.mediaDir === undefined ||
          !isBareName(download.filePath)
        ) {
          continue;
        }
        const abs = join(options.mediaDir, download.filePath);
        try {
          const info = await statChecked(abs);
          if (info !== null && info.isFile()) {
            return { uri: toFileUri(abs) };
          }
        } catch (thrown) {
          if (!unreadable(thrown)) {
            throw thrown;
          }
        }
      }
      const rows = db
        .prepare(
          `SELECT f.doc_id AS docId, s.tree_uri AS treeUri
           FROM local_files f
           JOIN local_sources s ON s.source_id = f.source_id
           WHERE f.recording_id = ?`,
        )
        .all(args.recordingId) as { docId?: unknown; treeUri?: unknown }[];
      for (const row of rows) {
        if (
          typeof row.docId !== 'string' ||
          typeof row.treeUri !== 'string'
        ) {
          continue;
        }
        let abs: string | null;
        try {
          abs = await probeDocAbs(row.treeUri, row.docId);
        } catch (thrown) {
          if (unreadable(thrown)) {
            continue;
          }
          throw thrown;
        }
        if (abs !== null) {
          return { uri: docUriFor(row.treeUri, row.docId) };
        }
      }
      return { uri: null };
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : '';
      if (message.includes('no such table')) {
        return { uri: null };
      }
      asIo('local probe failed', thrown);
      return { uri: null };
    }
  }

  // Verdicts memoized per URI — waveform reads hit the same URI per
  // 1 MiB chunk, and a full index scan per chunk multiplies realpaths
  // by library size. Freshness is `PRAGMA data_version`: the index db
  // is a read-only accessor — every write arrives via the storage
  // service's connection, and data_version bumps on exactly those
  // commits (inserts, deletes, AND updates — a file's doc move or a
  // download leaving 'available' re-opens the scan). O(1) per call.
  // If the pragma is unavailable the stamp falls back to a content
  // hash over the gate-relevant columns (string work, still no fs).
  // The verdict belongs to the PATH the URI resolved to, not the URI
  // string — a re-pointed symlink keeps its URI while moving the
  // target, so a hit must match the realpath computed this call. `real`
  // is re-derived fresh above on every call; only the index scan is
  // memoized.
  const gateCache = new Map<
    string,
    { readonly real: string; readonly allowed: string | null }
  >();
  let gateStamp = '';
  function indexStamp(db: DatabaseSync): string {
    try {
      const row = db
        .prepare('PRAGMA data_version')
        .get() as { data_version?: unknown };
      if (typeof row.data_version === 'number') {
        return `v${row.data_version}`;
      }
    } catch {
      // fall through to the content-hash stamp
    }
    let hash = 0x811c9dc5;
    const mix = (table: string, columns: string): void => {
      try {
        const rows = db
          .prepare(`SELECT ${columns} AS c FROM ${table} ORDER BY rowid`)
          .all() as { c?: unknown }[];
        for (const row of rows) {
          if (typeof row.c !== 'string') {
            continue;
          }
          for (let i = 0; i < row.c.length; i++) {
            hash = Math.imul(hash ^ row.c.charCodeAt(i), 0x01000193);
          }
          hash = Math.imul(hash ^ 0xff, 0x01000193);
        }
      } catch {
        hash = Math.imul(hash ^ table.length, 0x01000193);
      }
    };
    mix('local_files', "COALESCE(file_id,'') || char(31) || COALESCE(doc_id,'')");
    mix('local_sources', "COALESCE(source_id,'') || char(31) || COALESCE(tree_uri,'')");
    mix('downloads', "COALESCE(file_path,'') || char(31) || COALESCE(state,'')");
    return `h${hash >>> 0}`;
  }

  /**
   * A `file://` URI the renderer is allowed to touch — the lexical
   * path is realpath'd (a symlink swap can't smuggle an escape through
   * the gap between index-time resolution and playback-time open),
   * then the resolved path must be OWNED bytes: an `available`
   * downloads-ledger row under the media dir, or an indexed
   * `local_files` row still confined under its tree root. Confinement
   * alone is not enough — a granted folder or the media dir can hold
   * files the index never imported, and those stay unreadable.
   */
  async function allowedLocalPath(uri: string): Promise<string | null> {
    const abs = fileUrlPath(uri);
    if (abs === null) {
      return null;
    }
    const real = await realpathChecked(abs);
    if (real === null) {
      return null;
    }
    const db = options.database();
    if (db === null) {
      return null;
    }
    const stamp = indexStamp(db);
    if (stamp !== gateStamp) {
      gateCache.clear();
      gateStamp = stamp;
    }
    const cached = gateCache.get(uri);
    if (cached !== undefined && cached.real === real) {
      return cached.allowed;
    }
    const allowed = await gateLocalPath(db, abs, real);
    // An index write mid-evaluation voids the verdict — only cache
    // when the stamp still matches, so an in-flight scan can never
    // repopulate the table with pre-mutation answers.
    if (indexStamp(db) === stamp) {
      gateCache.set(uri, { real, allowed });
    }
    return allowed;
  }

  async function gateLocalPath(
    db: DatabaseSync,
    abs: string,
    real: string,
  ): Promise<string | null> {
    if (options.mediaDir !== undefined) {
      // Managed downloads only — mediaDir can hold arbitrary files
      // beside the ledger's own, so confinement is not the gate.
      let rows: Record<string, unknown>[];
      try {
        rows = db
          .prepare(
            `SELECT file_path AS filePath FROM downloads
             WHERE state = 'available'`,
          )
          .all() as Record<string, unknown>[];
      } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : '';
        if (message.includes('no such table')) {
          rows = [];
        } else {
          asIo('local resolve failed', thrown);
          return null;
        }
      }
      const mediaReal = await realpathChecked(options.mediaDir);
      for (const row of rows) {
        if (typeof row['filePath'] !== 'string') {
          continue;
        }
        const nameReal = await realpathChecked(
          join(options.mediaDir, row['filePath']),
        );
        // A ledger name carrying separators must not resolve outside
        // the media dir — same guard the probe leg applies.
        if (
          nameReal !== null &&
          nameReal === real &&
          mediaReal !== null &&
          pathConfined(mediaReal, nameReal)
        ) {
          return real;
        }
      }
    }
    for (const row of localRows(db)) {
      // The file must BE an indexed row — compare realpath'd paths, not
      // lexical URIs, so both the lexical docUri (resolve) and the
      // minted realpath'd URI (read) answer the same.
      const docUri = docUriFor(row.treeUri, row.docId);
      if (docUri === null) {
        continue;
      }
      const docAbs = fileUrlPath(docUri);
      if (docAbs === null) {
        continue;
      }
      // The lexical fast path skips the fs call for the common
      // resolve input; realpath'd inputs still verify per row.
      if (docAbs !== abs) {
        const docReal = await realpathChecked(docAbs);
        if (docReal === null || docReal !== real) {
          continue;
        }
      }
      // …and still confine under its own tree root realpath — an
      // indexed file swapped for a symlink pointing out stays denied.
      const tree = parseTree(row.treeUri);
      if (tree === null) {
        continue;
      }
      const rootReal = await realpathChecked(tree.absPath);
      if (rootReal === null) {
        continue;
      }
      if (
        tree.kind === 'file'
          ? real === rootReal
          : pathConfined(rootReal, real)
      ) {
        return real;
      }
    }
    return null;
  }

  /**
   * `local:resolve` — the renderer's attach-time confinement check: a
   * `file://` URI returns its realpath'd, grant-checked URI, or null
   * when the path escapes every root. Consumed async at attach so a
   * lexical-URI-minted `lf-*` handle can never resolve into bytes
   * outside the granted set.
   */
  async function resolve(args: LocalResolveArgs): Promise<unknown> {
    const real = await allowedLocalPath(args.uri);
    return { uri: real === null ? null : toFileUri(real) };
  }

  /**
   * `local:read` — ranged byte reads on a `file://` URI for features
   * that need bytes, not an element attach (waveform peaks). The same
   * `allowedLocalPath` gate as `resolve`; empty data reads as EOF.
   */
  async function read(args: LocalReadArgs): Promise<unknown> {
    const real = await allowedLocalPath(args.uri);
    if (real === null) {
      throw shellError('permission-denied', 'path is not readable');
    }
    let file;
    try {
      file = await open(real, READ_FLAGS);
    } catch (thrown) {
      // A vanished file is a typed failure, not a null result — the
      // contract result shape is `{data}` only; null would surface to
      // the renderer as a malformed `invalid-response`.
      statError(thrown);
      throw shellError('unavailable', 'local file is gone');
    }
    try {
      // The verdict belongs to the canonical path — prove the opened
      // descriptor is still bound to the file that path resolves to:
      // realpath-equality refuses a swapped directory component and
      // the inode match refuses a leaf that changed since the gate,
      // so a post-gate symlink swap can never serve bytes outside the
      // granted set. A directory/FIFO/device at an owned name is a
      // typed 'unavailable', not an element-facing read error.
      const opened = await file.stat();
      const live = await statChecked(real);
      if (
        !opened.isFile() ||
        live === null ||
        live.dev !== opened.dev ||
        live.ino !== opened.ino ||
        (await realpathChecked(real)) !== real
      ) {
        throw shellError('unavailable', 'local file is gone');
      }
      const buffer = Buffer.alloc(args.maxLen);
      const { bytesRead } = await file.read(
        buffer,
        0,
        args.maxLen,
        args.position,
      );
      return { data: buffer.subarray(0, bytesRead).toString('base64') };
    } catch (thrown) {
      asIo('local read failed', thrown);
      throw shellError('io-error', 'unreachable');
    } finally {
      await file.close();
    }
  }

  async function list(): Promise<unknown> {
    const db = options.database();
    if (db === null) {
      return { sources: [] };
    }
    try {
      const rows = db
        .prepare(
          `SELECT s.source_id AS sourceId, s.tree_uri AS treeUri,
                  s.label AS label, s.added_ms AS addedMs,
                  s.last_scan_ms AS lastScanMs,
                  (SELECT COUNT(*) FROM local_files f
                    WHERE f.source_id = s.source_id) AS fileCount
           FROM local_sources s`,
        )
        .all() as Record<string, unknown>[];
      const sources = rows.map((row) => ({
        sourceId: String(row['sourceId']),
        treeUri: String(row['treeUri']),
        label: String(row['label']),
        addedMs: Number(row['addedMs']),
        lastScanMs:
          row['lastScanMs'] === null || row['lastScanMs'] === undefined
            ? null
            : Number(row['lastScanMs']),
        fileCount: Number(row['fileCount']),
      }));
      return { sources };
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : '';
      if (message.includes('no such table')) {
        return { sources: [] };
      }
      asIo('local list failed', thrown);
      return { sources: [] };
    }
  }

  /**
   * `local:playback` — every currently-playable `file://` URI keyed by
   * recording. The renderer's `localPlaybackFor` answers synchronously
   * from engine state; this channel is the consistency cross-check the
   * settings/transfer UI can call.
   */
  async function playback(): Promise<unknown> {
    const db = options.database();
    if (db === null) {
      return { entries: [] };
    }
    const entries: { recordingId: string; uri: string }[] = [];
    const seen = new Set<string>();
    try {
      if (options.mediaDir !== undefined) {
        const downloads = db
          .prepare(
            `SELECT recording_id AS recordingId, file_path AS filePath
             FROM downloads WHERE state = 'available'`,
          )
          .all() as Record<string, unknown>[];
        for (const row of downloads) {
          if (
            typeof row['recordingId'] !== 'string' ||
            typeof row['filePath'] !== 'string' ||
            !isBareName(row['filePath'])
          ) {
            continue;
          }
          const abs = join(options.mediaDir, row['filePath']);
          try {
            const info = await statChecked(abs);
            if (info !== null && info.isFile()) {
              entries.push({
                recordingId: row['recordingId'],
                uri: toFileUri(abs),
              });
              seen.add(row['recordingId']);
            }
          } catch (thrown) {
            if (!unreadable(thrown)) {
              throw thrown;
            }
          }
        }
      }
      for (const row of localRows(db)) {
        if (seen.has(row.recordingId)) {
          continue;
        }
        let abs: string | null;
        try {
          abs = await probeDocAbs(row.treeUri, row.docId);
        } catch (thrown) {
          if (unreadable(thrown)) {
            continue;
          }
          throw thrown;
        }
        if (abs !== null) {
          entries.push({
            recordingId: row.recordingId,
            uri: docUriFor(row.treeUri, row.docId) ?? toFileUri(abs),
          });
          seen.add(row.recordingId);
        }
      }
      return { entries };
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : '';
      if (message.includes('no such table')) {
        return { entries: [] };
      }
      asIo('local playback failed', thrown);
      return { entries: [] };
    }
  }

  /**
   * `local:sweep` — the startup integrity report: index rows whose
   * files vanished, grouped by source. Marking those rows is the
   * engine's rescan job; this channel reports what vanished so the
   * renderer can trigger a rescan or surface the count.
   */
  async function sweep(): Promise<unknown> {
    const db = options.database();
    if (db === null) {
      return { missing: 0, sources: [] };
    }
    const missingBySource = new Map<string, number>();
    let missing = 0;
    for (const row of localRows(db)) {
      let abs: string | null;
      try {
        abs = await probeDocAbs(row.treeUri, row.docId);
      } catch (thrown) {
        // An unreadable file is not missing — the row stays.
        if (unreadable(thrown)) {
          continue;
        }
        throw thrown;
      }
      if (abs === null) {
        missing += 1;
        missingBySource.set(
          row.sourceId,
          (missingBySource.get(row.sourceId) ?? 0) + 1,
        );
      }
    }
    const sources = [...missingBySource.entries()].map(
      ([sourceId, count]) => ({ sourceId, missing: count }),
    );
    return { missing, sources };
  }

  function guarded<A>(
    name: string,
    validate: (value: unknown) => value is A,
    run: (args: A) => Promise<unknown>,
  ): UtilityHandler {
    return async (args) => {
      if (!validate(args)) {
        throw shellError(
          'invalid-request',
          `invalid arguments for ${name}`,
        );
      }
      return run(args);
    };
  }

  const noArgs = (value: unknown) => value === undefined;

  return {
    handlers: {
      [CHANNELS.localAdd]: guarded(
        CHANNELS.localAdd,
        isLocalAddArgs,
        add,
      ),
      [CHANNELS.localProbe]: guarded(
        CHANNELS.localProbe,
        isLocalProbeArgs,
        probe,
      ),
      [CHANNELS.localResolve]: guarded(
        CHANNELS.localResolve,
        isLocalResolveArgs,
        resolve,
      ),
      [CHANNELS.localRead]: guarded(
        CHANNELS.localRead,
        isLocalReadArgs,
        read,
      ),
      [CHANNELS.localList]: guarded(CHANNELS.localList, noArgs, list),
      [CHANNELS.localPlayback]: guarded(
        CHANNELS.localPlayback,
        noArgs,
        playback,
      ),
      [CHANNELS.localSweep]: guarded(CHANNELS.localSweep, noArgs, sweep),
    },
    close() {
      // Stateless — the shared index db is owned by its creator.
    },
  };
}
