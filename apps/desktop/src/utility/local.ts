import { access, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CHANNELS } from '../shared/channels.ts';
import type {
  LocalAddArgs,
  LocalProbeArgs,
} from '../shared/contract.ts';
import { isLocalAddArgs, isLocalProbeArgs } from '../shared/contract.ts';
import { isShellError, shellError } from '../shared/errors.ts';
import {
  dirTreeUri,
  docIdConfined,
  docUriFor,
  parseTree,
  pathConfined,
  pickedFileTreeUri,
  toFileUri,
} from '../shared/local-paths.ts';
import type { UtilityHandler } from './router.ts';
import { mimeForPath } from './tags.ts';
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
  const real = await realpath(path).catch(() => null);
  if (real === null) {
    throw shellError('invalid-request', 'picked path does not resolve');
  }
  const info = await stat(real).catch(() => null);
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
    const info = await stat(tree.absPath).catch(() => null);
    return info !== null && info.isFile() ? tree.absPath : null;
  }
  if (!docIdConfined(docId)) {
    return null;
  }
  const rootReal = await realpath(tree.absPath).catch(() => null);
  if (rootReal === null) {
    return null;
  }
  const joined = join(rootReal, ...docId.split('/'));
  const real = await realpath(joined).catch(() => null);
  if (real === null || !pathConfined(rootReal, real)) {
    return null;
  }
  const info = await stat(real).catch(() => null);
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
      const download = db
        .prepare(
          `SELECT file_path AS filePath FROM downloads
           WHERE recording_id = ? AND state = 'available' LIMIT 1`,
        )
        .get(args.recordingId) as { filePath?: unknown } | undefined;
      // file_path is a managed-dir name by the port convention — a
      // row carrying separators would escape the media dir, so a
      // non-bare value is treated as no playable bytes (never joined).
      if (
        download !== undefined &&
        typeof download.filePath === 'string' &&
        options.mediaDir !== undefined &&
        isBareName(download.filePath)
      ) {
        const abs = join(options.mediaDir, download.filePath);
        const info = await stat(abs).catch(() => null);
        if (info !== null && info.isFile()) {
          return { uri: toFileUri(abs) };
        }
      }
      const rows = db
        .prepare(
          `SELECT f.doc_id AS docId, s.tree_uri AS treeUri
           FROM local_files f
           JOIN local_sources s ON s.source_id = f.source_id
           WHERE f.recording_id = ? LIMIT 1`,
        )
        .all(args.recordingId) as { docId?: unknown; treeUri?: unknown }[];
      for (const row of rows) {
        if (
          typeof row.docId !== 'string' ||
          typeof row.treeUri !== 'string'
        ) {
          continue;
        }
        const abs = await probeDocAbs(row.treeUri, row.docId);
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
          const info = await stat(abs).catch(() => null);
          if (info !== null && info.isFile()) {
            entries.push({
              recordingId: row['recordingId'],
              uri: toFileUri(abs),
            });
            seen.add(row['recordingId']);
          }
        }
      }
      for (const row of localRows(db)) {
        if (seen.has(row.recordingId)) {
          continue;
        }
        const abs = await probeDocAbs(row.treeUri, row.docId);
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
      const abs = await probeDocAbs(row.treeUri, row.docId);
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
