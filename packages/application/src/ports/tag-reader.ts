import type { CancellationSignal } from '../cancellation.ts';
import type { Result } from '../errors.ts';

/** One folder grant picked by the user (SAF tree on Android). */
export type PickedFolder = {
  /** The persistable tree/document URI to enumerate later. */
  treeUri: string;
  /** Display label for the row. */
  label: string;
};

/** One entry inside an enumerated tree — a candidate media file. */
export type LocalEntry = {
  /** SAF document id — the locator inside the tree (path component). */
  docId: string;
  name: string;
  size: number;
  mime: string;
  /**
   * Provider modification stamp (ms) when the source reports one —
   * SAF's `COLUMN_LAST_MODIFIED` on Android. `null` where the
   * provider can't supply one: a same-size in-place replacement is
   * then only detectable by fingerprint, which the scan falls back
   * to.
   */
  modifiedMs: number | null;
};

/**
 * One file's identity fingerprint: a content sample (head+tail) plus
 * size — cheap and stable across moves/renames. Used to derive
 * `LocalFile.fileId`, so a moved file keeps its identity.
 */
export type FileFingerprint = {
  docId: string;
  fingerprint: string;
};

/** Parsed tags for one file; every field nullable (untagged files). */
export type LocalTags = {
  docId: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  genre: string | null;
};

/**
 * Local-files read port (slice 3): folder picking, tree enumeration,
 * fingerprinting, and tag reads. The Kotlin implementation lives in
 * auqw-expo (DocumentsContract + MediaMetadataRetriever + pread) — no
 * new dependency. Batched entry points keep the bridge overhead flat
 * at library scale (a 200-file scan must not round-trip per file).
 *
 * `pickFolder` is shell-driven: the implementation owns the SAF
 * picker flow and takes the persistable URI grant before returning.
 */
export interface TagReaderPort {
  /**
   * Run the folder-picker flow and take a persistable read grant on
   * the chosen tree. `no-result` when the user cancels.
   */
  pickFolder(signal: CancellationSignal): Promise<Result<PickedFolder>>;
  /**
   * List candidate media files inside the granted tree.
   * `permission-denied` when the grant is gone (row stays, honest).
   * The listing is authoritative — the engine diffs it against the
   * index, so an adapter must fail typed on any unreadable entry
   * rather than return a partial scan that reads as deletion. Only
   * entries that vanished mid-scan may be omitted.
   */
  enumerate(
    treeUri: string,
    signal: CancellationSignal,
  ): Promise<Result<readonly LocalEntry[]>>;
  /**
   * Fingerprint a batch of documents: head+tail content sample + size.
   * Results arrive in request order — a failed entry yields null at
   * its index rather than failing the batch.
   */
  fingerprint(
    treeUri: string,
    docIds: readonly string[],
    signal: CancellationSignal,
  ): Promise<Result<readonly (FileFingerprint | null)[]>>;
  /**
   * Read tags for a batch of documents. Same contract: per-entry null
   * on failure, batch survives.
   */
  readTags(
    treeUri: string,
    docIds: readonly string[],
    signal: CancellationSignal,
  ): Promise<Result<readonly (LocalTags | null)[]>>;
  /**
   * The playable document URI for one entry — platform URI math
   * (`DocumentsContract.buildDocumentUriUsingTree` on Android) stays
   * behind the port; domain records carry only the `fileId`.
   */
  docUri(treeUri: string, docId: string): string;
}
