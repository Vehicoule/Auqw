import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * Local-files URI math shared by renderer and utility: how a picked
 * path becomes a `treeUri`, how `(treeUri, docId)` becomes a playable
 * `file://` URI, and how confinement back to a grant is checked.
 *
 * treeUri is opaque to the application engines — these schemes are a
 * shell-local convention, and both are RFC 8089 `file:` URLs so the
 * stored grant is platform-independent (drive letters and UNC paths
 * survive the round trip):
 * - `pathToFileURL(dir).href` (`file:///music/rips`, `file:///C:/Music`)
 *   — a picked folder; docIds are '/'-joined relative paths inside it.
 * - `picked-file:` + `pathToFileURL(file).href` — a single picked file
 *   granted without its folder; the tree enumerates exactly one doc
 *   whose docId is the file's basename.
 *
 * docIds stay POSIX-style ('/'-joined) identifiers inside a tree —
 * they are abstract doc names, not OS paths.
 */

export const PICKED_FILE_PREFIX = 'picked-file:';

export type ParsedTree =
  | { readonly kind: 'dir'; readonly absPath: string }
  | { readonly kind: 'file'; readonly absPath: string };

/** OS path inside a `file:`-URL treeUri, else null. */
function fileUrlPath(uri: string): string | null {
  if (!uri.startsWith('file:')) {
    return null;
  }
  try {
    const path = fileURLToPath(uri);
    return isAbsolute(path) ? path : null;
  } catch {
    return null;
  }
}

/** OS path inside a picked-file treeUri, else null. */
export function pickedFilePath(treeUri: string): string | null {
  if (!treeUri.startsWith(PICKED_FILE_PREFIX)) {
    return null;
  }
  return fileUrlPath(treeUri.slice(PICKED_FILE_PREFIX.length));
}

/** Mint the dir-tree grant URI for a real OS path. */
export function dirTreeUri(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/** Mint the picked-file grant URI for a real OS path. */
export function pickedFileTreeUri(absPath: string): string {
  return `${PICKED_FILE_PREFIX}${pathToFileURL(absPath).href}`;
}

/** Parse a stored treeUri into its OS path + kind. */
export function parseTree(treeUri: string): ParsedTree | null {
  const file = pickedFilePath(treeUri);
  if (file !== null) {
    return { kind: 'file', absPath: file };
  }
  const dir = fileUrlPath(treeUri);
  if (dir !== null) {
    return { kind: 'dir', absPath: dir };
  }
  return null;
}

/** OS path → playable `file://` URI (Windows-aware via node:url). */
export function toFileUri(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/**
 * (treeUri, docId) → the playable `file://` URI `LocalFileSource.uriFor`
 * returns. Sync + pure: the renderer computes it with zero IPC.
 */
export function docUriFor(treeUri: string, docId: string): string | null {
  if (treeUri.startsWith(PICKED_FILE_PREFIX)) {
    return treeUri.slice(PICKED_FILE_PREFIX.length);
  }
  const tree = parseTree(treeUri);
  if (tree === null || tree.kind !== 'dir' || !docIdConfined(docId)) {
    return null;
  }
  return toFileUri(join(tree.absPath, ...docId.split('/')));
}

/**
 * A docId must be a non-empty '/'-joined relative path with no parent
 * traversal, no absolute-root trickery, and no NUL — the same shape
 * `tagread:enumerate` produces.
 */
export function docIdConfined(docId: string): boolean {
  if (
    docId.length === 0 ||
    docId.includes('\0') ||
    docId.includes('\\') ||
    docId.startsWith('/')
  ) {
    return false;
  }
  return !docId.split('/').some((seg) => seg === '..' || seg === '.');
}

/**
 * Is `child` a real path strictly inside `root` (platform-aware —
 * `relative` handles separators and drive letters)?
 */
export function pathConfined(rootAbs: string, childAbs: string): boolean {
  const rel = relative(rootAbs, childAbs);
  // `..` only escapes as a leading path *segment* — an ordinary name
  // like `..hidden` inside the tree must stay confined.
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}
