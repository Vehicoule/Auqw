import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  statfs,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CHANNELS } from '../shared/channels.ts';
import type {
  TransferAbortArgs,
  TransferBeginArgs,
  TransferFinalizeArgs,
  TransferNameArgs,
  TransferSinkArgs,
  TransferSinkInfo,
  TransferSweepArgs,
  TransferWriteArgs,
} from '../shared/contract.ts';
import {
  isTransferAbortArgs,
  isTransferBeginArgs,
  isTransferFinalizeArgs,
  isTransferNameArgs,
  isTransferSinkArgs,
  isTransferSweepArgs,
  isTransferWriteArgs,
} from '../shared/contract.ts';
import { isShellError, shellError } from '../shared/errors.ts';
import type { UtilityHandler } from './router.ts';

/**
 * `transfer:*` — the `MediaTransferPort` file plane over node:fs.
 *
 * The application engine (`DownloadManager` + `runTransfer`) owns fetch,
 * Range requests, and checksum policy in the renderer — mirroring the
 * mobile split exactly. This service owns only what the port contract
 * requires: a managed directory of byte sinks with atomic
 * `.part` → rename finalize, resume-aware `begin`, `commit` durability
 * marks, and the sweep/stat surface the cache UI and startup integrity
 * pass need.
 *
 * Destination names are bare filenames inside `AUQW_USER_DATA/media`;
 * separators and `.part` suffixes are refused so a name can never
 * escape the managed dir or collide with another sink's partial.
 */

export type TransferServiceOptions = {
  /**
   * Managed media dir (`AUQW_USER_DATA/media`). Undefined degrades
   * every channel to `unavailable` instead of a crash.
   */
  readonly mediaDir: string | undefined;
  /**
   * Read accessor for the domain database — used by the startup orphan
   * sweep to keep `.part` files a resumable ledger row still wants.
   * Absent → the sweep keeps nothing.
   */
  readonly database?: (() => DatabaseSync | null) | undefined;
  /** In-flight sink cap; begins beyond it queue on `waiters`. */
  readonly maxSinks?: number | undefined;
  /** Wait-queue cap; beyond it `begin` fails `unavailable`. */
  readonly maxWaiters?: number | undefined;
};

export type TransferService = {
  readonly handlers: Readonly<Record<string, UtilityHandler>>;
  /** Startup orphan sweep — bounded, ledger-aware, best-effort. */
  readonly sweepOrphans: () => Promise<number>;
  /** Closes all sinks; queued begins reject `released`. */
  readonly close: () => void;
};

type Sink = {
  readonly id: string;
  readonly destPath: string;
  readonly partAbs: string;
  readonly destAbs: string;
  handle: FileHandle | null;
  committed: number;
  readonly openedMs: number;
  closed: boolean;
};

const DEFAULT_MAX_SINKS = 4;
const DEFAULT_MAX_WAITERS = 32;
const PART_SUFFIX = '.part';
const RECONCILE_SUFFIX = '.reconcile.part';
const CHUNK = 1024 * 1024;
/** Orphans must be older than this to sweep — a just-minted `.part` is not an orphan. */
const ORPHAN_MIN_AGE_MS = 60_000;
const RESUMABLE_STATES =
  "('requested','transferring','failed_with_retry')";

/**
 * A bare managed name: no separators, no NUL, no partial/reconcile
 * suffix, not a dot-dir — the name form `downloads.file_path` and
 * `destPath` must both take so nothing escapes the managed dir.
 */
export function isBareName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !name.endsWith(PART_SUFFIX) &&
    !name.endsWith('.reconcile') &&
    name !== '.' &&
    name !== '..'
  );
}

/** Maps a thrown fs failure to a typed shell error — ENOSPC preserves its storage-full semantics. */
function asIo(message: string, thrown: unknown): never {
  if (isShellError(thrown)) {
    throw thrown;
  }
  const code =
    thrown instanceof Error && 'code' in thrown
      ? String((thrown as { code?: unknown }).code)
      : '';
  if (code === 'ENOSPC') {
    throw shellError('storage-full', 'out of storage on media volume');
  }
  throw shellError('io-error', message);
}

export function createTransferService(
  options: TransferServiceOptions,
): TransferService {
  const maxSinks = options.maxSinks ?? DEFAULT_MAX_SINKS;
  const maxWaiters = options.maxWaiters ?? DEFAULT_MAX_WAITERS;
  const sinks = new Map<string, Sink>();
  /**
   * destPaths claimed between the dup check and sink registration —
   * concurrent begins can't split the check across the acquire await.
   */
  const reserved = new Set<string>();
  let openCount = 0;
  const waiters: { resolve(): void; reject(e: unknown): void }[] = [];
  let shutdown = false;

  function dir(): string {
    if (options.mediaDir === undefined) {
      throw shellError('unavailable', 'transfer dir is not configured');
    }
    return options.mediaDir;
  }

  async function ensureDir(): Promise<void> {
    try {
      await mkdir(dir(), { recursive: true });
    } catch (thrown) {
      asIo('transfer dir create failed', thrown);
    }
  }

  function livePartNames(): Set<string> {
    const names = new Set<string>();
    for (const sink of sinks.values()) {
      if (!sink.closed) {
        names.add(`${sink.destPath}${PART_SUFFIX}`);
      }
    }
    return names;
  }

  async function acquireSlot(): Promise<void> {
    if (shutdown) {
      throw shellError('released', 'transfer service is closed');
    }
    if (openCount < maxSinks) {
      openCount += 1;
      return;
    }
    if (waiters.length >= maxWaiters) {
      throw shellError('unavailable', 'transfer sink queue is full');
    }
    await new Promise<void>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
    // A released slot transfers to the waiter — openCount already holds it.
  }

  function releaseSlot(): void {
    const next = waiters.shift();
    if (next === undefined) {
      openCount -= 1;
      return;
    }
    next.resolve();
  }

  function requireSink(sinkId: string): Sink {
    const sink = sinks.get(sinkId);
    if (sink === undefined || sink.closed) {
      throw shellError('invalid-request', 'unknown or closed sink');
    }
    return sink;
  }

  function sinkInfo(sink: Sink): TransferSinkInfo {
    return {
      sinkId: sink.id,
      destPath: sink.destPath,
      committedBytes: sink.committed,
      openedMs: sink.openedMs,
    };
  }

  /**
   * Resume handling mirrors the expo adapter: a `.part` longer than the
   * resume point gets its kept prefix copied to a `.reconcile` sibling
   * and moved back over (there is no truncate on an appending handle);
   * shorter or missing is an invalid-response per the port contract.
   */
  async function reconcilePart(
    partAbs: string,
    destPath: string,
    resumeAtBytes: number,
  ): Promise<void> {
    const part = await stat(partAbs).catch(() => null);
    if (resumeAtBytes > 0) {
      if (part === null) {
        throw shellError(
          'invalid-response',
          'resume requested but no partial exists',
        );
      }
      if (part.size < resumeAtBytes) {
        throw shellError(
          'invalid-response',
          'stored partial is shorter than the resume offset',
        );
      }
      if (part.size === resumeAtBytes) {
        return;
      }
      const reconcileAbs = join(
        dir(),
        `${destPath}.reconcile${PART_SUFFIX}`,
      );
      const src = await open(partAbs, 'r');
      try {
        const dst = await open(reconcileAbs, 'w');
        try {
          let remaining = resumeAtBytes;
          let position = 0;
          const buf = Buffer.alloc(Math.min(CHUNK, remaining));
          while (remaining > 0) {
            const take = Math.min(remaining, buf.length);
            const { bytesRead } = await src.read(buf, 0, take, position);
            if (bytesRead === 0) {
              break;
            }
            await dst.write(buf, 0, bytesRead);
            remaining -= bytesRead;
            position += bytesRead;
          }
          if (remaining > 0) {
            throw shellError(
              'invalid-response',
              'stored partial shrank during reconcile',
            );
          }
        } finally {
          await dst.close();
        }
      } finally {
        await src.close();
      }
      await rename(reconcileAbs, partAbs);
      return;
    }
    await rm(partAbs, { force: true });
  }

  async function begin(args: TransferBeginArgs): Promise<unknown> {
    const { destPath, resumeAtBytes } = args;
    if (!isBareName(destPath)) {
      throw shellError(
        'invalid-request',
        'transfer destPath must be a bare filename',
      );
    }
    for (const sink of sinks.values()) {
      if (!sink.closed && sink.destPath === destPath) {
        throw shellError(
          'invalid-request',
          'destination already has an open sink',
        );
      }
    }
    // Reserve before the first await — a racing begin sees the claim
    // even while this one waits on the sink cap.
    if (reserved.has(destPath)) {
      throw shellError(
        'invalid-request',
        'destination already has a pending sink',
      );
    }
    reserved.add(destPath);
    let acquired = false;
    try {
      await acquireSlot();
      acquired = true;
      await ensureDir();
      const partAbs = join(dir(), `${destPath}${PART_SUFFIX}`);
      await reconcilePart(partAbs, destPath, resumeAtBytes);
      const sink: Sink = {
        id: randomUUID(),
        destPath,
        partAbs,
        destAbs: join(dir(), destPath),
        handle: null,
        committed: resumeAtBytes,
        openedMs: Date.now(),
        closed: false,
      };
      sinks.set(sink.id, sink);
      return { sinkId: sink.id };
    } catch (thrown) {
      if (acquired) {
        releaseSlot();
      }
      throw thrown;
    } finally {
      reserved.delete(destPath);
    }
  }

  async function write(args: TransferWriteArgs): Promise<unknown> {
    const sink = requireSink(args.sinkId);
    const bytes = Buffer.from(args.data, 'base64');
    try {
      if (sink.handle === null) {
        sink.handle = await open(sink.partAbs, 'a');
      }
      await sink.handle.write(bytes, 0, bytes.length);
      sink.committed += bytes.length;
    } catch (thrown) {
      asIo('transfer write failed', thrown);
    }
    return undefined;
  }

  async function commit(args: TransferSinkArgs): Promise<unknown> {
    const sink = requireSink(args.sinkId);
    try {
      if (sink.handle !== null) {
        await sink.handle.sync();
      }
      return { offset: sink.committed };
    } catch (thrown) {
      asIo('transfer commit failed', thrown);
    }
  }

  async function finalize(args: TransferFinalizeArgs): Promise<unknown> {
    const sink = requireSink(args.sinkId);
    try {
      if (sink.handle !== null) {
        await sink.handle.close();
        sink.handle = null;
      }
      const hash = createHash('sha256');
      try {
        for await (const chunk of createReadStream(sink.partAbs)) {
          hash.update(chunk as Buffer);
        }
      } catch (thrown) {
        asIo('transfer finalize hash failed', thrown);
      }
      const digest = hash.digest('hex');
      if (args.expected !== null && digest !== args.expected) {
        await rm(sink.partAbs, { force: true });
        throw shellError(
          'invalid-response',
          'digest mismatch on finalize — partial deleted',
        );
      }
      try {
        await rename(sink.partAbs, sink.destAbs);
      } catch {
        // POSIX rename overwrites; Windows refuses to replace an
        // existing destination. Park the incumbent under a same-dir
        // backup name, publish the partial, and restore the backup
        // if the publish fails — the completed file is never
        // deleted before its replacement is in place.
        const backupAbs = join(dir(), `${sink.destPath}.replace`);
        await rm(backupAbs, { force: true });
        await rename(sink.destAbs, backupAbs);
        try {
          await rename(sink.partAbs, sink.destAbs);
        } catch (thrown) {
          await rename(backupAbs, sink.destAbs).catch(() => undefined);
          asIo('transfer finalize rename failed', thrown);
        }
        await rm(backupAbs, { force: true });
      }
      return { digest };
    } finally {
      sink.closed = true;
      sinks.delete(sink.id);
      releaseSlot();
    }
  }

  async function abort(args: TransferAbortArgs): Promise<unknown> {
    const sink = requireSink(args.sinkId);
    try {
      if (sink.handle !== null) {
        await sink.handle.close();
        sink.handle = null;
      }
      if (!args.keep) {
        await rm(sink.partAbs, { force: true });
      }
      return undefined;
    } catch (thrown) {
      asIo('transfer abort failed', thrown);
    } finally {
      sink.closed = true;
      sinks.delete(sink.id);
      releaseSlot();
    }
  }

  async function statName(args: TransferNameArgs): Promise<unknown> {
    if (!isBareName(args.name)) {
      throw shellError('invalid-request', 'not a managed file name');
    }
    const abs = join(dir(), args.name);
    const info = await stat(abs).catch(() => null);
    if (info === null) {
      return { exists: false, bytes: null };
    }
    return info.isFile()
      ? { exists: true, bytes: info.size }
      : { exists: false, bytes: null };
  }

  async function removeName(args: TransferNameArgs): Promise<unknown> {
    if (!isBareName(args.name)) {
      throw shellError('invalid-request', 'not a managed file name');
    }
    try {
      await rm(join(dir(), args.name), { force: true });
      await rm(join(dir(), `${args.name}${PART_SUFFIX}`), { force: true });
      return undefined;
    } catch (thrown) {
      asIo('transfer remove failed', thrown);
    }
  }

  async function sweepPartials(
    args: TransferSweepArgs,
  ): Promise<unknown> {
    return sweep(args.keepPaths);
  }

  async function sweep(keepPaths: readonly string[]): Promise<unknown> {
    const keep = new Set<string>([...keepPaths, ...livePartNames()]);
    let entries;
    try {
      entries = await readdir(dir());
    } catch (thrown) {
      const code =
        thrown instanceof Error && 'code' in thrown
          ? String((thrown as { code?: unknown }).code)
          : '';
      if (code === 'ENOENT') {
        return { swept: 0 };
      }
      asIo('transfer sweep failed', thrown);
      return { swept: 0 };
    }
    let swept = 0;
    for (const name of entries) {
      if (!name.endsWith(PART_SUFFIX) || keep.has(name)) {
        continue;
      }
      try {
        await rm(join(dir(), name), { force: true });
        swept += 1;
      } catch {
        // A partial that resists deletion (e.g. held open) stays — the
        // next sweep retries it.
      }
    }
    return { swept };
  }

  /**
   * Startup pass: `.part` files older than `ORPHAN_MIN_AGE_MS` whose
   * ledger row is absent or no longer resumable get deleted. The
   * engine's own `init` sweep repeats this against live state — this
   * pass exists so orphans are bounded even when the renderer never
   * reaches a scan.
   */
  async function sweepOrphans(): Promise<number> {
    const keep = new Set<string>();
    let db: DatabaseSync | null = null;
    try {
      db = options.database?.() ?? null;
    } catch {
      // The index can't even be opened — nothing is provably
      // orphaned; delete nothing rather than destroying resumable
      // progress on a transient failure.
      return 0;
    }
    if (db !== null) {
      try {
        const rows = db
          .prepare(
            `SELECT file_path FROM downloads WHERE state IN ${RESUMABLE_STATES}`,
          )
          .all() as { file_path?: unknown }[];
        for (const row of rows) {
          if (typeof row.file_path === 'string') {
            keep.add(`${row.file_path}${PART_SUFFIX}`);
          }
        }
      } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : '';
        if (message.includes('no such table')) {
          // Pre-migration database — no resumable owners can exist.
        } else {
          // The ledger can't be read: nothing is provably orphaned,
          // so the sweep deletes nothing rather than destroying
          // resumable progress on a transient index failure.
          return 0;
        }
      }
    }
    let entries;
    try {
      entries = await readdir(dir());
    } catch {
      return 0;
    }
    const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
    let swept = 0;
    for (const name of entries) {
      if (!name.endsWith(PART_SUFFIX) || keep.has(name) || livePartNames().has(name)) {
        continue;
      }
      try {
        const info = await stat(join(dir(), name));
        if (info.mtimeMs > cutoff) {
          continue;
        }
        await rm(join(dir(), name), { force: true });
        swept += 1;
      } catch {
        // Vanished or locked between readdir and rm — next sweep.
      }
    }
    return swept;
  }

  async function list(): Promise<unknown> {
    const openSinks = [...sinks.values()]
      .filter((sink) => !sink.closed)
      .map(sinkInfo);
    let files: { name: string; bytes: number }[] = [];
    try {
      const entries = await readdir(dir());
      for (const name of entries) {
        if (name.endsWith(PART_SUFFIX)) {
          continue;
        }
        const info = await stat(join(dir(), name)).catch(() => null);
        if (info !== null && info.isFile()) {
          files.push({ name, bytes: info.size });
        }
      }
    } catch {
      files = [];
    }
    return { sinks: openSinks, files };
  }

  async function status(args: TransferSinkArgs): Promise<unknown> {
    return sinkInfo(requireSink(args.sinkId));
  }

  async function stats(): Promise<unknown> {
    let bytes = 0;
    let files = 0;
    let partials = 0;
    try {
      for (const name of await readdir(dir())) {
        const info = await stat(join(dir(), name)).catch(() => null);
        if (info === null || !info.isFile()) {
          continue;
        }
        bytes += info.size;
        if (name.endsWith(PART_SUFFIX)) {
          partials += 1;
        } else {
          files += 1;
        }
      }
    } catch {
      // No dir yet — zeroed stats are the honest answer.
    }
    let freeBytes: number | null = null;
    try {
      const info = await statfs(dir());
      freeBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        info.bsize * info.bavail,
      );
    } catch {
      freeBytes = null;
    }
    return { bytes, files, partials, freeBytes };
  }

  function guarded<A>(
    name: string,
    validate: (value: unknown) => value is A,
    run: (args: A) => Promise<unknown> | unknown,
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
      [CHANNELS.transferEnsureDir]: guarded(
        CHANNELS.transferEnsureDir,
        noArgs,
        ensureDir,
      ),
      [CHANNELS.transferBegin]: guarded(
        CHANNELS.transferBegin,
        isTransferBeginArgs,
        begin,
      ),
      [CHANNELS.transferWrite]: guarded(
        CHANNELS.transferWrite,
        isTransferWriteArgs,
        write,
      ),
      [CHANNELS.transferCommit]: guarded(
        CHANNELS.transferCommit,
        isTransferSinkArgs,
        commit,
      ),
      [CHANNELS.transferFinalize]: guarded(
        CHANNELS.transferFinalize,
        isTransferFinalizeArgs,
        finalize,
      ),
      [CHANNELS.transferAbort]: guarded(
        CHANNELS.transferAbort,
        isTransferAbortArgs,
        abort,
      ),
      [CHANNELS.transferStat]: guarded(
        CHANNELS.transferStat,
        isTransferNameArgs,
        statName,
      ),
      [CHANNELS.transferRemove]: guarded(
        CHANNELS.transferRemove,
        isTransferNameArgs,
        removeName,
      ),
      [CHANNELS.transferSweepPartials]: guarded(
        CHANNELS.transferSweepPartials,
        isTransferSweepArgs,
        sweepPartials,
      ),
      [CHANNELS.transferList]: guarded(
        CHANNELS.transferList,
        noArgs,
        list,
      ),
      [CHANNELS.transferStatus]: guarded(
        CHANNELS.transferStatus,
        isTransferSinkArgs,
        status,
      ),
      [CHANNELS.transferStats]: guarded(
        CHANNELS.transferStats,
        noArgs,
        stats,
      ),
    },
    sweepOrphans,
    close() {
      shutdown = true;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(
          shellError('released', 'transfer service is closed'),
        );
      }
      for (const sink of sinks.values()) {
        sink.closed = true;
        void sink.handle?.close().catch(() => undefined);
      }
      sinks.clear();
    },
  };
}
