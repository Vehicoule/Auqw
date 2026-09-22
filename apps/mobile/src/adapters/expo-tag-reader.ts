import { appError, err, ok } from '@auqw/application';
import type {
  CancellationSignal,
  FileFingerprint,
  LocalEntry,
  LocalTags,
  PickedFolder,
  Result,
  TagReaderPort,
} from '@auqw/application';
import { nativeError } from './auqw-expo-surface.ts';

const appCancelled = () => appError('cancelled', 'cancelled');
import type { AuqwTagReaderNative } from './auqw-expo-surface.ts';

/**
 * TagReaderPort over the auqw-expo Kotlin TagReader: SAF picker +
 * DocumentsContract enumeration + head/tail fingerprint + batched
 * MediaMetadataRetriever reads. The adapter is a pure translation —
 * cancellation is observed between awaits (the native legs are
 * interruptible only at call boundaries) and native rejections map
 * through `nativeError`'s taxonomy.
 */
export function createExpoTagReader(native: AuqwTagReaderNative): TagReaderPort {
  return {
    async pickFolder(signal: CancellationSignal) {
      if (signal.cancelled) {
        return err(appCancelled());
      }
      // Platforms without the tag-reader surface (iOS) fail honestly
      // rather than throwing a TypeError through the module wrapper.
      if (typeof native.tagPickFolder !== 'function') {
        return err(
          appError('unsupported', 'no local-files surface on this platform'),
        );
      }
      try {
        const picked = await native.tagPickFolder();
        return ok<PickedFolder>({
          treeUri: picked.treeUri,
          label: picked.label,
        });
      } catch (thrown) {
        return err(nativeError(thrown));
      }
    },

    async enumerate(treeUri: string, signal: CancellationSignal) {
      if (signal.cancelled) {
        return err(appCancelled());
      }
      try {
        const entries = await native.tagEnumerate(treeUri);
        if (signal.cancelled) {
          return err(appCancelled());
        }
        return ok<readonly LocalEntry[]>(
          entries.map((e) => ({
            docId: e.docId,
            name: e.name,
            size: e.size,
            mime: e.mime,
            // Absent on older native builds — the scan's fallback is
            // a fingerprint, not a false "unchanged".
            modifiedMs: e.modifiedMs ?? null,
          })),
        );
      } catch (thrown) {
        return err(nativeError(thrown));
      }
    },

    async fingerprint(
      treeUri: string,
      docIds: readonly string[],
      signal: CancellationSignal,
    ) {
      if (signal.cancelled) {
        return err(appCancelled());
      }
      try {
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
      } catch (thrown) {
        return err(nativeError(thrown));
      }
    },

    async readTags(
      treeUri: string,
      docIds: readonly string[],
      signal: CancellationSignal,
    ) {
      if (signal.cancelled) {
        return err(appCancelled());
      }
      try {
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
      } catch (thrown) {
        return err(nativeError(thrown));
      }
    },

    docUri(treeUri: string, docId: string): string {
      return native.docUri(treeUri, docId);
    },
  };
}
