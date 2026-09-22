/**
 * Local-files URI math shared by renderer and utility: how a picked
 * path becomes a `treeUri`, how `(treeUri, docId)` becomes a playable
 * `file://` URI, and how a `file://` URI or managed media name maps
 * back to an absolute path.
 *
 * treeUri is opaque to the application engines — these schemes are a
 * shell-local convention:
 * - a bare absolute directory path (`/music/rips`) — a picked folder;
 *   docIds are '/'-joined relative paths inside it.
 * - `picked-file:` + absolute file path — a single picked file granted
 *   without its folder; the tree enumerates exactly one doc whose
 *   docId is the file's basename.
 */

export const PICKED_FILE_PREFIX = 'picked-file:';

export type ParsedTree =
  | { readonly kind: 'dir'; readonly absPath: string }
  | { readonly kind: 'file'; readonly absPath: string };

/** Absolute POSIX path inside a picked-file treeUri, else null. */
export function pickedFilePath(treeUri: string): string | null {
  if (!treeUri.startsWith(PICKED_FILE_PREFIX)) {
    return null;
  }
  const path = treeUri.slice(PICKED_FILE_PREFIX.length);
  return path.startsWith('/') ? path : null;
}

/**
 * Parse a stored treeUri back into its filesystem shape. Bare
 * absolute paths are folders; `picked-file:` prefixes are files.
 * Anything else is not a desktop grant and resolves to null.
 */
export function parseTree(treeUri: string): ParsedTree | null {
  const picked = pickedFilePath(treeUri);
  if (picked !== null) {
    return { kind: 'file', absPath: picked };
  }
  if (treeUri.startsWith('/')) {
    return { kind: 'dir', absPath: treeUri };
  }
  return null;
}

/**
 * RFC-8089 file URI for an absolute path — the same encoding on both
 * sides of IPC so a URI minted by `local:probe` matches one the
 * renderer computes from a `docUri` call. Segments are
 * percent-encoded individually so `/`, `?`, and `#` inside a name
 * can never corrupt the URL structure.
 */
export function toFileUri(absPath: string): string {
  const posix = absPath.replace(/\\/g, '/');
  const rooted = posix.startsWith('/') ? posix : `/${posix}`;
  return `file://${rooted
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

/**
 * The playable URI for one enumerated doc — the port's `docUri`
 * contract realized as pure string math so the renderer's
 * `localPlaybackFor` stays synchronous. A picked-file tree ignores
 * docId (its only doc is the file itself).
 */
export function docUriFor(treeUri: string, docId: string): string | null {
  const tree = parseTree(treeUri);
  if (tree === null) {
    return null;
  }
  if (tree.kind === 'file') {
    return toFileUri(tree.absPath);
  }
  const root = tree.absPath.endsWith('/')
    ? tree.absPath.slice(0, -1)
    : tree.absPath;
  return toFileUri(`${root}/${docId}`);
}

/**
 * Lexical confinement check for a docId inside a dir tree — rejects
 * absolute ids, wrong-direction separators, NULs, and `..` escapes.
 * The caller still resolves symlinks against the real filesystem;
 * this rejects the shapes that could never be honest.
 */
export function docIdConfined(docId: string): boolean {
  return (
    docId.length > 0 &&
    !docId.startsWith('/') &&
    !docId.includes('\\') &&
    !docId.includes('\0') &&
    docId !== '..' &&
    !docId.startsWith('../') &&
    !docId.endsWith('/..') &&
    !docId.includes('/../')
  );
}
