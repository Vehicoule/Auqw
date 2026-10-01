import { randomUUID, createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookupAll } from 'node:dns/promises';
import { createReadStream } from 'node:fs';
import {
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
import { Agent, Dispatcher, interceptors } from 'undici';
import { CHANNELS } from '../shared/channels.ts';
import type {
  TransferAbortArgs,
  TransferBeginArgs,
  TransferFetchArgs,
  TransferFetchIdArgs,
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
  isTransferFetchArgs,
  isTransferFetchIdArgs,
  isTransferFinalizeArgs,
  isTransferNameArgs,
  isTransferSinkArgs,
  isTransferSweepArgs,
  isTransferWriteArgs,
  isUndefinedResult,
} from '../shared/contract.ts';
import { errorCode } from '../shared/check.ts';
import { isShellError, shellError } from '../shared/errors.ts';
import { guarded, type UtilityHandler } from './router.ts';

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

type TransferServiceOptions = {
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
  /** Parked-fetch cap; beyond it `transfer:fetch` fails `unavailable`. */
  readonly maxFetches?: number | undefined;
  /** Wire fetch for `transfer:fetch*` — Node fetch in production. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Host resolver for the private-address verdict — node:dns in production. */
  readonly lookupImpl?:
    | ((hostname: string) => Promise<LookupAddress[]>)
    | undefined;
};

type TransferService = {
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
/** Parked fetches each hold an AbortController, a backstop timer,
 * and — once answered — a live socket plus up to `FETCH_MAX_BODY`
 * buffered on read; bound them like the sink side bounds opens. */
const DEFAULT_MAX_FETCHES = 32;
const PART_SUFFIX = '.part';
/** Manual-hop cap + backstop for a fetch whose cancel never arrives
 * (renderer gone). The policy's own chunk timeout stays the real
 * stall bound; this only bounds the socket's lease. */
const FETCH_MAX_REDIRECTS = 3;
const FETCH_HARD_TIMEOUT_MS = 120_000;
/** Body cap — a 206 chunk is ≤1MiB; the belt sits well above it. */
const FETCH_MAX_BODY = 8 * 1024 * 1024;

/** A `transfer:fetch` whose response is parked awaiting `fetchBody`/`fetchAbort`. */
type LiveFetch = {
  readonly controller: AbortController;
  readonly timer: NodeJS.Timeout;
  response: Response | null;
  /** `fetchBody` has been issued — no second read, but the entry stays
   * registered so abort/backstop still reach the in-flight read. */
  consumed: boolean;
  timedOut: boolean;
};
/** RequestInit plus undici's dispatcher pin — a non-undici fetchImpl
 * simply ignores it. */
type FetchInit = RequestInit & { dispatcher?: Dispatcher };
/** Reserved finalize-internal namespace: the parked incumbent of an
 * in-flight destination replace. */
const REPLACE_SUFFIX = '.replace';
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
    !name.endsWith(REPLACE_SUFFIX) &&
    name !== '.' &&
    name !== '..'
  );
}

/**
 * `FileHandle.write` reports `bytesWritten` — it does not promise to
 * consume the whole requested range. Loop until the buffer lands or
 * the handle stops making progress, so a short write can never
 * inflate the committed offset a later resume trusts.
 */
async function writeAll(
  handle: FileHandle,
  buf: Buffer,
  offset: number,
  length: number,
): Promise<void> {
  let done = 0;
  while (done < length) {
    const { bytesWritten } = await handle.write(
      buf,
      offset + done,
      length - done,
    );
    if (bytesWritten === 0) {
      throw shellError('io-error', 'file write made no progress');
    }
    done += bytesWritten;
  }
}

/**
 * fs probe outcome: `null` only when the path is provably absent
 * (ENOENT/ENOTDIR). Anything else is typed — a transient failure
 * must never masquerade as absence: callers read a missing answer as
 * "delete the ledger row" or "resume from zero", both destructive.
 */
function absentOrThrow(thrown: unknown): null {
  const code = errorCode(thrown);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return null;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    throw shellError('permission-denied', 'path is not readable');
  }
  throw shellError('io-error', 'path could not be read');
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
  // Names mid-removal — the synchronous counterpart to `reserved` on
  // the delete side; `begin` refuses them so a new `.part` can't be
  // unlinked out from under it.
  const removals = new Set<string>();
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

  /**
   * Exactly-once close+release: whichever terminal path reaches the
   * sink first frees its slot — a finalize-then-abort pair (or any
   * later terminal op) can never release it twice.
   */
  function closeSink(sink: Sink): void {
    if (sink.closed) {
      return;
    }
    sink.closed = true;
    sinks.delete(sink.id);
    releaseSlot();
  }

  /**
   * Per-sink op chain — every stateful handler on a sinkId queues
   * behind the one in flight. A cancel-fired abort therefore lands at
   * a defined boundary (after the current op), never mid-write or
   * mid-publish: no finalize-after-abort publishes, no deleted
   * partial resurrects under a stale handle, and the sink lookup runs
   * inside the turn so an op dequeued behind a close fails typed.
   */
  const chains = new Map<string, Promise<void>>();
  function chained<T>(sinkId: string, run: () => Promise<T>): Promise<T> {
    const prev = chains.get(sinkId) ?? Promise.resolve();
    const next = prev.then(run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    chains.set(sinkId, settled);
    // Chains stop growing once the sink is gone — drop the drained
    // tail so the map is bounded by live sinks, not history.
    void settled.then(() => {
      if (chains.get(sinkId) === settled) {
        chains.delete(sinkId);
      }
    });
    return next;
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
   * resume point is truncated in place through a fresh `r+` handle —
   * atomic, keeps the prefix, and sidesteps rename-over-existing, which
   * Windows refuses; shorter or missing is an invalid-response per the
   * port contract.
   */
  async function reconcilePart(
    partAbs: string,
    resumeAtBytes: number,
  ): Promise<void> {
    const part = await stat(partAbs).catch(absentOrThrow);
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
      const trunc = await open(partAbs, 'r+');
      try {
        await trunc.truncate(resumeAtBytes);
      } finally {
        await trunc.close();
      }
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
    if (removals.has(destPath)) {
      throw shellError(
        'unavailable',
        'destination removal is in flight',
      );
    }
    reserved.add(destPath);
    let acquired = false;
    try {
      await acquireSlot();
      acquired = true;
      await ensureDir();
      const partAbs = join(dir(), `${destPath}${PART_SUFFIX}`);
      await reconcilePart(partAbs, resumeAtBytes);
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
      await writeAll(sink.handle, bytes, 0, bytes.length);
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
        // existing destination. Park the incumbent under the reserved
        // `.replace` name, publish the partial, then drop the backup;
        // a failed publish restores it, so a completed download is
        // never deleted before its replacement lands. The suffix is
        // refused by `isBareName`, so no public destination can
        // collide with it.
        const backupAbs = join(dir(), `${sink.destPath}${REPLACE_SUFFIX}`);
        const incumbent = await stat(sink.destAbs).catch(absentOrThrow);
        try {
          if (incumbent === null) {
            // No live destination — a stranded backup is whatever a
            // crashed publish parked, and the verified `.part` outranks
            // it. Publish directly; no incumbent needs preserving.
            await rm(backupAbs, { force: true });
            await rename(sink.partAbs, sink.destAbs);
          } else {
            // A leftover backup beside a live destination can only be
            // the stale half of a crashed publish — drop it, then swap.
            await rm(backupAbs, { force: true });
            await rename(sink.destAbs, backupAbs);
            try {
              await rename(sink.partAbs, sink.destAbs);
            } catch (thrown) {
              await rename(backupAbs, sink.destAbs).catch(() => undefined);
              throw thrown;
            }
            await rm(backupAbs, { force: true });
          }
        } catch (thrown) {
          asIo('transfer finalize rename failed', thrown);
        }
      }
      return { digest };
    } finally {
      closeSink(sink);
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
      closeSink(sink);
    }
  }

  async function statName(args: TransferNameArgs): Promise<unknown> {
    if (!isBareName(args.name)) {
      throw shellError('invalid-request', 'not a managed file name');
    }
    const abs = join(dir(), args.name);
    // Only a genuinely-absent name reports exists:false — any other
    // stat failure would let DownloadManager read a live file as
    // missing and remove it with its ledger row.
    const info = await stat(abs).catch(absentOrThrow);
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
    // A live sink's `.part` is `name + '.part'` — unlinking either
    // file out from under an open (or pending) sink deletes the bytes
    // it is mid-write on and strands its finalize. In-flight transfers
    // end through `transfer:abort`, not here.
    if (
      reserved.has(args.name) ||
      [...sinks.values()].some((sink) => sink.destPath === args.name)
    ) {
      throw shellError(
        'unavailable',
        'destination has an in-flight transfer',
      );
    }
    // A duplicate removal refuses outright: the entry is shared, so
    // the first completion would clear it while the second unlink is
    // still queued — reopening the name to `begin` mid-delete.
    if (removals.has(args.name)) {
      throw shellError(
        'unavailable',
        'destination removal is in flight',
      );
    }
    // Claim before the first await — a `begin` starting mid-removal
    // refuses the name rather than writing a `.part` the unlink below
    // would delete out from under it.
    removals.add(args.name);
    try {
      await rm(join(dir(), args.name), { force: true });
      await rm(join(dir(), `${args.name}${PART_SUFFIX}`), { force: true });
      return undefined;
    } catch (thrown) {
      asIo('transfer remove failed', thrown);
    } finally {
      removals.delete(args.name);
    }
  }

  async function sweep(args: TransferSweepArgs): Promise<unknown> {
    const keep = new Set<string>([...args.keepPaths, ...livePartNames()]);
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
    let entries;
    try {
      entries = await readdir(dir());
    } catch {
      return 0;
    }
    // Resolve `.replace` backups before any publish work this boot —
    // and before ANY ledger access: a live destination means the
    // crashed publish landed and the backup is stale; a missing one
    // means the incumbent was parked and never restored — put it
    // back. Recovery depends only on the media dir, so an index
    // outage must not leave recoverable bytes invisible as a missing
    // destination (integrity init would then discard the row).
    for (const name of entries) {
      if (!name.endsWith(REPLACE_SUFFIX)) {
        continue;
      }
      const backupAbs = join(dir(), name);
      const baseAbs = join(dir(), name.slice(0, -REPLACE_SUFFIX.length));
      try {
        const base = await stat(baseAbs).catch(() => null);
        if (base === null) {
          await rename(backupAbs, baseAbs);
        } else {
          await rm(backupAbs, { force: true });
        }
      } catch {
        // Best-effort — a stuck backup is retried next boot.
      }
    }
    // `.part` orphans need the ledger: a transient index failure
    // skips only deletion — the backup restore above already ran.
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
        if (name.endsWith(PART_SUFFIX) || name.endsWith(REPLACE_SUFFIX)) {
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

  /* ----------------------------------------------------------------
   * `transfer:fetch*` — the download wire leg over Node fetch. The
   * renderer can't reach minted https urls (its CSP allows only the
   * loopback pump) and browser fetch won't send a minted User-Agent,
   * so the range fetch lives beside the sinks it feeds. `fetch`
   * performs the request and answers with the status + headers;
   * `fetchBody` streams a bounded body — the policy only ever reads
   * 206 bodies; `fetchAbort` cancels a request at any phase.
   * ---------------------------------------------------------------- */
  const fetches = new Map<string, LiveFetch>();
  const maxFetches = options.maxFetches ?? DEFAULT_MAX_FETCHES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupImpl =
    options.lookupImpl ??
    ((hostname: string) =>
      dnsLookupAll(hostname, { all: true, verbatim: true }));
  /**
   * The private-host verdict applied at connect time, not just to
   * the URL string: every dial through this dispatcher re-runs the
   * resolution and is pinned to the verified-public records, so a
   * hostile name can't re-resolve to a private target between the
   * check and the dial (DNS rebinding). The interceptor rewrites
   * only the connect origin — SNI and the Host header keep the
   * original hostname.
   */
  const fetchDispatcher: Dispatcher = new Agent().compose(
    interceptors.dns({
      lookup: (origin, _options, callback) => {
        dnsLookup(
          origin.hostname,
          { all: true, verbatim: true },
          (err, addresses) => {
            if (err !== null) {
              callback(err, []);
              return;
            }
            if (
              addresses.some(({ address }) => isPrivateFetchHost(address))
            ) {
              callback(
                Object.assign(
                  new Error('fetch host resolves to a private address'),
                  { code: 'ENOTPUBLIC' },
                ),
                [],
              );
              return;
            }
            callback(
              null,
              addresses.map(({ address, family }) => ({
                address,
                ttl: 0,
                family: family === 6 ? (6 as const) : (4 as const),
              })),
            );
          },
        );
      },
    }),
  );

  /**
   * Minted urls are public CDN endpoints — a fetch that names a
   * private or loopback target is either a bug or a renderer trying
   * to ride the bridge past its own CSP. Refuse literal private
   * hosts here; a public NAME still has to resolve public, which
   * `resolvesPublic` and the pinned dispatcher enforce per hop.
   */
  function isPrivateFetchHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost')) {
      return true;
    }
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4 !== null) {
      const octets = v4.slice(1).map(Number);
      const [a, b] = [octets[0] ?? 0, octets[1] ?? 0];
      return (
        octets.every((o) => o <= 255) &&
        (a === 0 ||
          a === 10 ||
          a === 127 ||
          (a === 100 && b >= 64 && b <= 127) ||
          (a === 169 && b === 254) ||
          (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168) ||
          (a === 198 && (b === 18 || b === 19)) ||
          a >= 224)
      );
    }
    // `new URL` returns IPv6 literals bracketed.
    const inner = host.startsWith('[') ? host.slice(1, -1) : host;
    if (inner === '::1' || inner === '::') {
      return true;
    }
    // fe80::/10 link-local — first hextet fe80–febf.
    const firstHextet = parseInt(inner.split(':')[0] ?? '', 16);
    if (
      !Number.isNaN(firstHextet) &&
      firstHextet >= 0xfe80 &&
      firstHextet <= 0xfebf
    ) {
      return true;
    }
    if (
      !Number.isNaN(firstHextet) &&
      firstHextet >= 0xfc00 &&
      firstHextet <= 0xfdff
    ) {
      return true; // ULA fc00::/7
    }
    if (inner.startsWith('::ffff:')) {
      // IPv4-mapped — last 32 bits decide.
      const tail = inner.slice('::ffff:'.length);
      const mappedV4 =
        /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail);
      if (mappedV4 !== null) {
        return isPrivateFetchHost(tail);
      }
      const groups = tail.split(':');
      const hex = groups
        .map((g) => parseInt(g, 16))
        .filter((n) => !Number.isNaN(n));
      if (hex.length >= 2) {
        const hi = hex[hex.length - 2] ?? 0;
        const lo = hex[hex.length - 1] ?? 0;
        return isPrivateFetchHost(
          `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`,
        );
      }
    }
    return false;
  }

  function parseFetchUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw shellError('invalid-request', 'unparseable fetch url');
    }
    // Same belt as the policy's fetch site: minted urls are https only.
    if (url.protocol !== 'https:') {
      throw shellError('invalid-request', 'fetch url must be https');
    }
    // Credentials can't cross undici's Request construction — refuse
    // non-retryably instead of TypeError → 'transient'.
    if (url.username !== '' || url.password !== '') {
      throw shellError('invalid-request', 'fetch url carries credentials');
    }
    if (isPrivateFetchHost(url.hostname)) {
      throw shellError('invalid-request', 'fetch url is not public');
    }
    return url;
  }

  /**
   * The hostname string check can't see a public name whose records
   * point at loopback/RFC1918/link-local (nip.io-style, split-horizon,
   * rebinding) — resolve it and apply the same private verdict to
   * every answer. Lookup failures propagate as transport-class
   * 'transient'; a private answer is a refusal.
   */
  async function resolvesPublic(hostname: string): Promise<boolean> {
    const addresses = await lookupImpl(hostname);
    return (
      addresses.length > 0 &&
      addresses.every(({ address }) => !isPrivateFetchHost(address))
    );
  }

  /** Drop a response's body so its socket frees — required before
   * every refusal throw, same as the follow path does. */
  function discard(response: Response): void {
    void response.body?.cancel().catch(() => undefined);
  }

  /** Transport failures → retryable; the caller's abort → cancelled; the
   * backstop timer → transient (a stall, not a cancel). */
  function asFetchError(live: LiveFetch, thrown: unknown): never {
    if (isShellError(thrown)) {
      throw thrown;
    }
    if (live.timedOut) {
      throw shellError('transient', 'fetch timed out');
    }
    if (
      thrown instanceof Error &&
      (thrown.name === 'AbortError' || thrown.name === 'TimeoutError')
    ) {
      throw shellError('cancelled', 'fetch aborted');
    }
    // Node fetch rejects TypeError on every transport failure — DNS,
    // reset, TLS, body drop — all retryable.
    throw shellError('transient', 'fetch failed');
  }

  async function fetchRemote(args: TransferFetchArgs): Promise<unknown> {
    if (shutdown) {
      throw shellError('released', 'transfer service is closed');
    }
    if (fetches.has(args.requestId)) {
      throw shellError('invalid-request', 'duplicate fetch requestId');
    }
    if (fetches.size >= maxFetches) {
      throw shellError('unavailable', 'too many fetches in flight');
    }
    const live: LiveFetch = {
      controller: new AbortController(),
      timer: setTimeout(() => {
        live.timedOut = true;
        live.controller.abort();
      }, FETCH_HARD_TIMEOUT_MS),
      response: null,
      consumed: false,
      timedOut: false,
    };
    fetches.set(args.requestId, live);
    try {
      let target = parseFetchUrl(args.url);
      if (!(await resolvesPublic(target.hostname))) {
        throw shellError('invalid-request', 'fetch url is not public');
      }
      // Node fetch demands ByteString header values — undici throws
      // TypeError on a control char (<0x20, 0x7f) or a ≥0x100
      // codepoint a native-valid mint admits (UTF-8 obs-text), the
      // same byte rule toMintHeaders enforces. Refuse them
      // non-retryably rather than letting the TypeError surface as
      // a 'transient' that retries forever.
      for (const [name, value] of Object.entries(args.headers)) {
        for (const ch of value) {
          const code = ch.codePointAt(0) ?? 0;
          if (code < 0x20 || code === 0x7f || code > 0xff) {
            throw shellError(
              'invalid-request',
              `fetch header '${name}' is not byte-encodable`,
            );
          }
        }
      }
      // Manual hops like the pump's: the scheme is re-validated each
      // hop (a downgrade or a loop never passes) and the minted
      // headers ride verbatim.
      const init: FetchInit = {
        method: 'GET',
        headers: args.headers,
        redirect: 'manual',
        signal: live.controller.signal,
        dispatcher: fetchDispatcher,
      };
      let response = await fetchImpl(target, init);
      for (let hops = 0; hops < FETCH_MAX_REDIRECTS; hops += 1) {
        const location = response.headers.get('location');
        if (
          response.status < 300 ||
          response.status >= 400 ||
          location === null
        ) {
          break;
        }
        let next: URL;
        try {
          next = new URL(location, target);
        } catch {
          discard(response);
          throw shellError(
            'invalid-response',
            'fetch redirect location unparseable',
          );
        }
        if (next.protocol !== 'https:') {
          discard(response);
          throw shellError(
            'invalid-response',
            'fetch redirected off https',
          );
        }
        if (next.username !== '' || next.password !== '') {
          discard(response);
          throw shellError(
            'invalid-response',
            'fetch redirected to a credentialed url',
          );
        }
        if (
          isPrivateFetchHost(next.hostname) ||
          !(await resolvesPublic(next.hostname))
        ) {
          discard(response);
          throw shellError(
            'invalid-response',
            'fetch redirected to a non-public host',
          );
        }
        target = next;
        // Drop the hop's body before following so its socket frees.
        discard(response);
        response = await fetchImpl(target, init);
      }
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get('location') !== null
      ) {
        discard(response);
        throw shellError(
          'invalid-response',
          'fetch redirect chain too long',
        );
      }
      live.response = response;
      return {
        status: response.status,
        headers: [...response.headers.entries()],
      };
    } catch (thrown) {
      // Delete only our own entry — an abort may already have freed
      // the id and a new fetch may now own it.
      if (fetches.get(args.requestId) === live) {
        fetches.delete(args.requestId);
      }
      clearTimeout(live.timer);
      asFetchError(live, thrown);
    }
  }

  async function fetchBody(args: TransferFetchIdArgs): Promise<unknown> {
    const live = fetches.get(args.requestId);
    if (
      live === undefined ||
      live.response === null ||
      live.consumed
    ) {
      throw shellError('invalid-request', 'unknown or consumed fetch');
    }
    // Single-use by flag, not by deletion: the entry and its backstop
    // stay registered for the whole read — a mid-read stall keeps a
    // socket `fetchAbort` (or the timeout) can still cancel.
    live.consumed = true;
    const response = live.response;
    try {
      const reader = response.body?.getReader();
      const parts: Buffer[] = [];
      let total = 0;
      if (reader !== undefined) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          total += value.byteLength;
          if (total > FETCH_MAX_BODY) {
            await reader.cancel().catch(() => undefined);
            throw shellError(
              'invalid-response',
              'fetch body exceeds the cap',
            );
          }
          parts.push(Buffer.from(value));
        }
      }
      return { data: Buffer.concat(parts).toString('base64') };
    } catch (thrown) {
      return asFetchError(live, thrown);
    } finally {
      // Same guard — a same-id fetch registered after an abort is
      // not ours to remove.
      if (fetches.get(args.requestId) === live) {
        fetches.delete(args.requestId);
      }
      clearTimeout(live.timer);
    }
  }

  function fetchAbort(args: TransferFetchIdArgs): unknown {
    const live = fetches.get(args.requestId);
    if (live === undefined) {
      // Consumed or never existed — abort is idempotent.
      return undefined;
    }
    fetches.delete(args.requestId);
    clearTimeout(live.timer);
    live.controller.abort();
    return undefined;
  }

  async function stats(): Promise<unknown> {
    let bytes = 0;
    let files = 0;
    let partials = 0;
    let names: readonly string[];
    try {
      names = await readdir(dir());
    } catch (thrown) {
      const code = errorCode(thrown);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // No dir yet — zeroed stats are the honest answer.
        names = [];
      } else if (code === 'EACCES' || code === 'EPERM') {
        throw shellError(
          'permission-denied',
          'media dir is not readable',
        );
      } else {
        throw shellError('io-error', 'media dir could not be read');
      }
    }
    for (const name of names) {
      const info = await stat(join(dir(), name)).catch(absentOrThrow);
      if (info === null || !info.isFile()) {
        continue;
      }
      bytes += info.size;
      if (name.endsWith(PART_SUFFIX) || name.endsWith(REPLACE_SUFFIX)) {
        partials += 1;
      } else {
        files += 1;
      }
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

  return {
    handlers: {
      [CHANNELS.transferEnsureDir]: guarded(
        CHANNELS.transferEnsureDir,
        isUndefinedResult,
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
        (args) => chained(args.sinkId, () => write(args)),
      ),
      [CHANNELS.transferCommit]: guarded(
        CHANNELS.transferCommit,
        isTransferSinkArgs,
        (args) => chained(args.sinkId, () => commit(args)),
      ),
      [CHANNELS.transferFinalize]: guarded(
        CHANNELS.transferFinalize,
        isTransferFinalizeArgs,
        (args) => chained(args.sinkId, () => finalize(args)),
      ),
      [CHANNELS.transferAbort]: guarded(
        CHANNELS.transferAbort,
        isTransferAbortArgs,
        (args) => chained(args.sinkId, () => abort(args)),
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
        sweep,
      ),
      [CHANNELS.transferList]: guarded(
        CHANNELS.transferList,
        isUndefinedResult,
        list,
      ),
      [CHANNELS.transferStatus]: guarded(
        CHANNELS.transferStatus,
        isTransferSinkArgs,
        status,
      ),
      [CHANNELS.transferStats]: guarded(
        CHANNELS.transferStats,
        isUndefinedResult,
        stats,
      ),
      [CHANNELS.transferFetch]: guarded(
        CHANNELS.transferFetch,
        isTransferFetchArgs,
        fetchRemote,
      ),
      [CHANNELS.transferFetchBody]: guarded(
        CHANNELS.transferFetchBody,
        isTransferFetchIdArgs,
        fetchBody,
      ),
      [CHANNELS.transferFetchAbort]: guarded(
        CHANNELS.transferFetchAbort,
        isTransferFetchIdArgs,
        fetchAbort,
      ),
    },
    sweepOrphans,
    close() {
      shutdown = true;
      for (const live of fetches.values()) {
        clearTimeout(live.timer);
        live.controller.abort();
      }
      fetches.clear();
      void fetchDispatcher.close().catch(() => undefined);
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
