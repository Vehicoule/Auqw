import { appError, err, ok } from '@auqw/application';
import type {
  CancellationSignal,
  FileFingerprint,
  LocalEntry,
  LocalTags,
  LocalTreeListing,
  PickedFolder,
  Result,
  TagReaderPort,
} from '@auqw/application';
import { nativeError } from './auqw-expo-surface.ts';
import type { AuqwTagReaderNative } from './auqw-expo-surface.ts';

const appCancelled = () => appError('cancelled', 'cancelled');

/**
 * TagReaderPort over the auqw-expo Kotlin TagReader: SAF picker +
 * DocumentsContract enumeration + head/tail fingerprint + batched
 * MediaMetadataRetriever reads. The adapter is a pure translation —
 * cancellation is observed between awaits (the native legs are
 * interruptible only at call boundaries) and native rejections map
 * through `nativeError`'s taxonomy.
 */
export function createExpoTagReader(native: AuqwTagReaderNative): TagReaderPort {
  const call = async <T>(
    signal: CancellationSignal,
    fn: () => Promise<Result<T>>,
  ): Promise<Result<T>> => {
    if (signal.cancelled) {
      return err(appCancelled());
    }
    try {
      return await fn();
    } catch (thrown) {
      return err(nativeError(thrown));
    }
  };
  return {
    pickFolder: (signal: CancellationSignal) =>
      // Platforms without the tag-reader surface (iOS) fail honestly
      // rather than throwing a TypeError through the module wrapper.
      call(signal, async () => {
        if (typeof native.tagPickFolder !== 'function') {
          return err(
            appError(
              'unsupported',
              'no local-files surface on this platform',
            ),
          );
        }
        const picked = await native.tagPickFolder();
        return ok<PickedFolder>({
          treeUri: picked.treeUri,
          label: picked.label,
        });
      }),

    enumerate: (treeUri: string, signal: CancellationSignal) =>
      call(signal, async () => {
        const listing = await native.tagEnumerate(treeUri);
        if (signal.cancelled) {
          return err(appCancelled());
        }
        // Older native builds answer the bare entry array — missing
        // failedTrees degrades to the pre-marker behavior (whole-tree
        // listing) rather than crashing on the new shape. ('entries'
        // in raw is useless: arrays carry the Array.entries METHOD.)
        const raw = listing as
          | readonly LocalEntry[]
          | {
              entries?: readonly LocalEntry[];
              failedTrees?: readonly string[];
            };
        const asListing = raw as {
          entries?: readonly LocalEntry[];
          failedTrees?: readonly string[];
        };
        const rows: readonly LocalEntry[] = Array.isArray(raw)
          ? raw
          : (asListing.entries ?? []);
        const failedTrees: readonly string[] = Array.isArray(raw)
          ? []
          : (asListing.failedTrees ?? []);
        return ok<LocalTreeListing>({
          entries: rows.map((e) => ({
            docId: e.docId,
            name: e.name,
            size: e.size,
            mime: e.mime,
            // Absent on older native builds — the scan's fallback is
            // a fingerprint, not a false "unchanged".
            modifiedMs: e.modifiedMs ?? null,
          })),
          failedTrees: failedTrees.filter(
            (t): t is string => typeof t === 'string',
          ),
        });
      }),

    fingerprint: (
      treeUri: string,
      docIds: readonly string[],
      signal: CancellationSignal,
    ) =>
      call(signal, async () => {
        const rows = await native.tagFingerprint(treeUri, docIds);
        if (signal.cancelled) {
          return err(appCancelled());
        }
        return ok<readonly (FileFingerprint | null)[]>(
          rows.map((r) =>
            r === null
              ? null
              : { docId: r.docId, fingerprint: r.fingerprint },
          ),
        );
      }),

    readTags: (
      treeUri: string,
      docIds: readonly string[],
      signal: CancellationSignal,
    ) =>
      call(signal, async () => {
        const rows = await native.tagRead(treeUri, docIds);
        if (signal.cancelled) {
          return err(appCancelled());
        }
        return ok<readonly (LocalTags | null)[]>(
          rows.map((r) =>
            r === null
              ? null
              : {
                  docId: r.docId,
                  title: r.title,
                  artist: r.artist,
                  album: r.album,
                  durationMs: r.durationMs,
                  genre: r.genre,
                },
          ),
        );
      }),

    docUri: (treeUri: string, docId: string): string =>
      native.docUri(treeUri, docId),
  };
}
