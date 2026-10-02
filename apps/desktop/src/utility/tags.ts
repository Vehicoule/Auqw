import { createHash } from 'node:crypto';
import {
  open,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { parseFile } from 'music-metadata';
import type { LocalGrants } from './local-grants.ts';
import { CHANNELS } from '../shared/channels.ts';
import type {
  TagreadBatchArgs,
  TagreadEnumerateArgs,
} from '../shared/contract.ts';
import {
  isTagreadBatchArgs,
  isTagreadEnumerateArgs,
  MAX_ENUM_ENTRIES,
  MAX_TAG_FIELD,
} from '../shared/contract.ts';
import { mimeForPath } from '../shared/audio-mime.ts';
import { errorCode } from '../shared/check.ts';
import {
  isShellError,
  shellError,
} from '../shared/errors.ts';
import type { ShellError } from '../shared/errors.ts';
import {
  docIdConfined,
  parseTree,
  pathConfined,
} from '../shared/local-paths.ts';
import { guarded, type UtilityHandler } from './router.ts';

/**
 * `tagread:*` — the `TagReaderPort` read plane for the desktop. The
 * application engine (`LocalFileSource`) runs renderer-side exactly as
 * on mobile; this service exposes only the file-touching halves of the
 * port: recursive enumeration, content fingerprinting, and tag reads.
 *
 * Every call is grant-checked: `treeUri` must be live in the
 * utility-owned grant store (see `local-grants.ts`) — never the
 * renderer-writable `local_sources` table — so a compromised renderer
 * can never read outside a tree the pick path actually minted.
 */

type TagServiceOptions = {
  /** Authoritative grant check — the utility-owned store. */
  readonly grants: LocalGrants;
};

type TagService = {
  readonly handlers: Readonly<Record<string, UtilityHandler>>;
  readonly close: () => void;
};

const FINGERPRINT_SAMPLE = 4096;

/**
 * Enumeration fs outcome: a genuinely-gone path enumerates empty (or
 * skips itself when it vanished mid-scan), but a permission or I/O
 * failure must not answer a partial listing — LocalFileSource diffs a
 * "successful" scan against the index, so every silently-omitted file
 * reads as deleted. There is no partial-scan marker in the port, so
 * any unreadable entry fails the whole enumeration typed.
 */
function scanFailure(thrown: unknown): 'gone' | ShellError {
  const code = errorCode(thrown);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return 'gone';
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return shellError('permission-denied', 'path is not readable');
  }
  return shellError('io-error', 'path could not be read');
}

/** Rethrows ShellErrors, wraps everything else as `io-error`. */
function asIo(message: string, thrown: unknown): never {
  if (isShellError(thrown)) {
    throw thrown;
  }
  throw shellError('io-error', message);
}

/**
 * Resolve `(tree, docId)` to a real filesystem path, or null when the
 * doc is gone. Malformed docIds (escapes, wrong direction) and
 * non-grant treeUris throw `invalid-request`; a doc whose realpath
 * leaves a dir root resolves null rather than following the escape.
 */
async function resolveDocAbs(
  treeUri: string,
  docId: string,
): Promise<string | null> {
  const tree = parseTree(treeUri);
  if (tree === null) {
    throw shellError('invalid-request', 'not a desktop treeUri');
  }
  if (tree.kind === 'file') {
    // Single-doc tree: the docId is the basename of the picked file.
    if (docId !== basename(tree.absPath)) {
      throw shellError(
        'invalid-request',
        'docId outside picked-file tree',
      );
    }
    return (await stat(tree.absPath).catch(() => null))?.isFile()
      ? tree.absPath
      : null;
  }
  if (!docIdConfined(docId)) {
    throw shellError('invalid-request', 'docId escapes the tree root');
  }
  const rootReal = await realpath(tree.absPath).catch(() => null);
  if (rootReal === null) {
    return null;
  }
  const joined = join(rootReal, ...docId.split('/'));
  const docReal = await realpath(joined).catch(() => null);
  if (docReal === null) {
    return null;
  }
  if (!pathConfined(rootReal, docReal)) {
    return null;
  }
  return docReal;
}

/**
 * The grant check: `treeUri` must be present in the utility-owned
 * grant store — minted by `local:add` (or the one-shot bootstrap
 * import), revoked by the storage-commit diff of `local_sources`.
 * A miss is `permission-denied`, matching the port's revoked-grant
 * semantics the engine already maps.
 */
function requireGrant(grants: LocalGrants, treeUri: string): void {
  if (!grants.has(treeUri)) {
    throw shellError(
      'permission-denied',
      'treeUri is not a granted local source',
    );
  }
}

/** Reads at most `buf.length` bytes from `position`; returns bytes landed. */
async function readInto(
  handle: FileHandle,
  buf: Buffer,
  position: number,
): Promise<number> {
  let read = 0;
  while (read < buf.length) {
    const { bytesRead } = await handle.read(
      buf,
      read,
      buf.length - read,
      position + read,
    );
    if (bytesRead === 0) {
      break;
    }
    read += bytesRead;
  }
  return read;
}

/**
 * sha256(head ≤4KiB ‖ tail ≤4KiB ‖ size as 8-byte LE) — byte-for-byte
 * the Android recipe so a file's fingerprint is stable across
 * platforms. A short read hashes only what landed, same as the Kotlin
 * `digest.update(buf, 0, position)` loop.
 */
async function fingerprintFile(abs: string): Promise<string | null> {
  const handle = await open(abs, 'r').catch(() => null);
  if (handle === null) {
    return null;
  }
  try {
    const size = (await handle.stat()).size;
    const head = Buffer.alloc(Math.min(FINGERPRINT_SAMPLE, size));
    const tail = Buffer.alloc(
      Math.min(Math.max(0, size - head.length), FINGERPRINT_SAMPLE),
    );
    const digest = createHash('sha256');
    const headRead = await readInto(handle, head, 0);
    digest.update(head.subarray(0, headRead));
    if (tail.length > 0) {
      const tailRead = await readInto(handle, tail, size - tail.length);
      digest.update(tail.subarray(0, tailRead));
    }
    const sizeBuf = Buffer.alloc(8);
    sizeBuf.writeBigUInt64LE(BigInt(size));
    digest.update(sizeBuf);
    return digest.digest('hex');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function boundedField(value: string | undefined | null): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return value.length > MAX_TAG_FIELD ? value.slice(0, MAX_TAG_FIELD) : value;
}

async function readTags(
  abs: string,
  docId: string,
): Promise<unknown> {
  try {
    const meta = await parseFile(abs, {
      duration: true,
      skipCovers: true,
    });
    return {
      docId,
      title: boundedField(meta.common.title),
      artist: boundedField(meta.common.artist ?? meta.common.artists?.[0]),
      album: boundedField(meta.common.album),
      durationMs:
        // A garbage duration (NaN, negative, or one that outgrows the
        // schema's safe-int bound) can't survive the response schema —
        // a bare round poisons the whole batch.
        meta.format.duration !== undefined &&
          Number.isFinite(meta.format.duration) &&
          meta.format.duration >= 0 &&
          Number.isSafeInteger(Math.round(meta.format.duration * 1000))
          ? Math.round(meta.format.duration * 1000)
          : null,
      genre: boundedField(meta.common.genre?.[0]),
    };
  } catch {
    // Unparseable or vanished — per-doc null, never fatal to the batch.
    return null;
  }
}

export function createTagService(options: TagServiceOptions): TagService {
  async function enumerate(
    args: TagreadEnumerateArgs,
  ): Promise<unknown> {
    requireGrant(options.grants, args.treeUri);
    const tree = parseTree(args.treeUri);
    if (tree === null) {
      throw shellError('invalid-request', 'not a desktop treeUri');
    }
    if (tree.kind === 'file') {
      const info = await stat(tree.absPath).catch((thrown) => {
        const outcome = scanFailure(thrown);
        if (outcome !== 'gone') {
          throw outcome;
        }
        return null;
      });
      if (info === null || !info.isFile()) {
        return { entries: [] };
      }
      const name = basename(tree.absPath);
      return {
        entries: [
          {
            docId: name,
            name,
            size: info.size,
            mime: mimeForPath(name) ?? 'application/octet-stream',
            // mtimeMs is fractional; floor to the contract's integer.
            // Pre-epoch timestamps emit null — the wire type only
            // accepts nonnegative values.
            modifiedMs:
              Number.isFinite(info.mtimeMs) && info.mtimeMs >= 0
                ? Math.floor(info.mtimeMs)
                : null,
          },
        ],
      };
    }
    const rootReal = await realpath(tree.absPath).catch((thrown) => {
      const outcome = scanFailure(thrown);
      if (outcome !== 'gone') {
        throw outcome;
      }
      return null;
    });
    if (rootReal === null) {
      return { entries: [] };
    }
    const entries: {
      docId: string;
      name: string;
      size: number;
      mime: string;
      modifiedMs: number | null;
    }[] = [];
    // Iterative walk — depth never risks the stack, and any failed
    // dir fails the scan typed rather than returning a partial list
    // that diffs into index removals. Only a dir that vanished
    // mid-scan (ENOENT/ENOTDIR) skips itself.
    const stack: string[] = [rootReal];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) {
        break;
      }
      const dirents = await readdir(current, {
        withFileTypes: true,
      }).catch((thrown) => {
        const outcome = scanFailure(thrown);
        if (outcome !== 'gone') {
          throw outcome;
        }
        return null;
      });
      if (dirents === null) {
        continue;
      }
      for (const entry of dirents) {
        if (entry.isDirectory()) {
          stack.push(join(current, entry.name));
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const abs = join(current, entry.name);
        const mime = mimeForPath(entry.name);
        if (mime === null) {
          continue;
        }
        const docId = relative(rootReal, abs).split(sep).join('/');
        const info = await stat(abs).catch((thrown) => {
          const outcome = scanFailure(thrown);
          if (outcome !== 'gone') {
            throw outcome;
          }
          return null;
        });
        if (info === null || !info.isFile()) {
          continue;
        }
        entries.push({
          docId,
          name: entry.name,
          size: info.size,
          mime,
          modifiedMs:
            Number.isFinite(info.mtimeMs) && info.mtimeMs >= 0
              ? Math.floor(info.mtimeMs)
              : null,
        });
        if (entries.length > MAX_ENUM_ENTRIES) {
          throw shellError(
            'invalid-request',
            'folder exceeds the enumerate bound',
          );
        }
      }
    }
    entries.sort((a, b) => a.docId.localeCompare(b.docId));
    return { entries };
  }

  async function fingerprint(
    args: TagreadBatchArgs,
  ): Promise<unknown> {
    requireGrant(options.grants, args.treeUri);
    const fingerprints: unknown[] = [];
    for (const docId of args.docIds) {
      const abs = await resolveDocAbs(args.treeUri, docId);
      const fp = abs === null ? null : await fingerprintFile(abs);
      fingerprints.push(fp === null ? null : { docId, fingerprint: fp });
    }
    return { fingerprints };
  }

  async function read(args: TagreadBatchArgs): Promise<unknown> {
    requireGrant(options.grants, args.treeUri);
    const tags: unknown[] = [];
    for (const docId of args.docIds) {
      const abs = await resolveDocAbs(args.treeUri, docId);
      tags.push(abs === null ? null : await readTags(abs, docId));
    }
    return { tags };
  }

  return {
    handlers: {
      [CHANNELS.tagreadEnumerate]: guarded(
        CHANNELS.tagreadEnumerate,
        isTagreadEnumerateArgs,
        enumerate,
      ),
      [CHANNELS.tagreadFingerprint]: guarded(
        CHANNELS.tagreadFingerprint,
        isTagreadBatchArgs,
        fingerprint,
      ),
      [CHANNELS.tagreadRead]: guarded(
        CHANNELS.tagreadRead,
        isTagreadBatchArgs,
        read,
      ),
    },
    close() {
      // Stateless — the shared index db is owned by its creator.
    },
  };
}
