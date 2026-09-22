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
import type { DatabaseSync } from 'node:sqlite';
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
import type { UtilityHandler } from './router.ts';

/**
 * `tagread:*` — the `TagReaderPort` read plane for the desktop. The
 * application engine (`LocalFileSource`) runs renderer-side exactly as
 * on mobile; this service exposes only the file-touching halves of the
 * port: recursive enumeration, content fingerprinting, and tag reads.
 *
 * Every call is grant-checked: `treeUri` must be a live row in
 * `local_sources` (the only table that records a granted tree), so a
 * renderer can never read outside a tree the user actually picked. The
 * check reads through the shared index accessor — the same database
 * file the storage service writes, second connection, never a second
 * file.
 */

export type TagServiceOptions = {
  readonly database: () => DatabaseSync | null;
};

export type TagService = {
  readonly handlers: Readonly<Record<string, UtilityHandler>>;
  readonly close: () => void;
};

const FINGERPRINT_SAMPLE = 4096;

/**
 * Root-level fs outcome: a genuinely-gone path enumerates empty, but a
 * permission or I/O failure at the tree root must not answer
 * `entries: []` — LocalFileSource diffs a "successful" empty scan into
 * removing every indexed document under the tree. Nested dirs still
 * skip-and-continue; only the root is typed.
 */
function rootFailure(thrown: unknown): 'gone' | ShellError {
  const code = errorCode(thrown);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return 'gone';
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return shellError('permission-denied', 'path is not readable');
  }
  return shellError('io-error', 'path could not be read');
}

/** Extension → mime for the formats `music-metadata` covers. */
const AUDIO_MIME: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  mp2: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  wv: 'audio/wavpack',
  ape: 'audio/ape',
  mpc: 'audio/x-musepack',
  dsf: 'audio/dsf',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
};

export function mimeForPath(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) {
    return null;
  }
  return AUDIO_MIME[path.slice(dot + 1).toLowerCase()] ?? null;
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
 * The grant check: `treeUri` must name a row in `local_sources`. A
 * missing database or a missing table means no grants exist yet —
 * `permission-denied` either way, matching the port's revoked-grant
 * semantics the engine already maps.
 */
function requireGrant(
  database: () => DatabaseSync | null,
  treeUri: string,
): void {
  const db = database();
  if (db === null) {
    throw shellError(
      'permission-denied',
      'no local grants — the tree is not registered',
    );
  }
  let row: unknown;
  try {
    row = db
      .prepare('SELECT 1 FROM local_sources WHERE tree_uri = ?')
      .get(treeUri);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : '';
    if (message.includes('no such table')) {
      throw shellError(
        'permission-denied',
        'no local grants — the tree is not registered',
      );
    }
    asIo('grant check failed', thrown);
  }
  if (row === undefined) {
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
        meta.format.duration === undefined
          ? null
          : Math.round(meta.format.duration * 1000),
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
    requireGrant(options.database, args.treeUri);
    const tree = parseTree(args.treeUri);
    if (tree === null) {
      throw shellError('invalid-request', 'not a desktop treeUri');
    }
    if (tree.kind === 'file') {
      const info = await stat(tree.absPath).catch((thrown) => {
        const outcome = rootFailure(thrown);
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
            modifiedMs: Number.isSafeInteger(info.mtimeMs)
              ? Math.floor(info.mtimeMs)
              : null,
          },
        ],
      };
    }
    const rootReal = await realpath(tree.absPath).catch((thrown) => {
      const outcome = rootFailure(thrown);
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
    // Iterative walk — one unreadable subdirectory skips itself rather
    // than failing the whole scan, and depth never risks the stack.
    const stack: string[] = [rootReal];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) {
        break;
      }
      const dirents = await readdir(current, {
        withFileTypes: true,
      }).catch((thrown) => {
        // A nested unreadable dir skips itself; a failed ROOT means
        // the scan is suspect — "empty" would read as mass-removal.
        if (current === rootReal) {
          const outcome = rootFailure(thrown);
          if (outcome !== 'gone') {
            throw outcome;
          }
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
        const info = await stat(abs).catch(() => null);
        if (info === null || !info.isFile()) {
          continue;
        }
        entries.push({
          docId,
          name: entry.name,
          size: info.size,
          mime,
          modifiedMs: Number.isSafeInteger(info.mtimeMs)
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
    requireGrant(options.database, args.treeUri);
    const fingerprints: unknown[] = [];
    for (const docId of args.docIds) {
      const abs = await resolveDocAbs(args.treeUri, docId);
      const fp = abs === null ? null : await fingerprintFile(abs);
      fingerprints.push(fp === null ? null : { docId, fingerprint: fp });
    }
    return { fingerprints };
  }

  async function read(args: TagreadBatchArgs): Promise<unknown> {
    requireGrant(options.database, args.treeUri);
    const tags: unknown[] = [];
    for (const docId of args.docIds) {
      const abs = await resolveDocAbs(args.treeUri, docId);
      tags.push(abs === null ? null : await readTags(abs, docId));
    }
    return { tags };
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
