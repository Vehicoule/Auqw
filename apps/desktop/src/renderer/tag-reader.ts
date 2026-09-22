import type {
  CancellationSignal,
  FileFingerprint,
  LocalEntry,
  LocalTags,
  PickedFolder,
  Result,
  TagReaderPort,
} from '@auqw/application';
import { appError, err, ok } from '@auqw/application';
import type { AuqwApi, LocalPickPayload } from '../shared/contract.ts';
import { MAX_TAGREAD_BATCH } from '../shared/contract.ts';
import { docUriFor } from '../shared/local-paths.ts';
import { shellToAppError } from './ipc-errors.ts';

/**
 * `TagReaderPort` over the `tagread:*` + `local:add` + `dialog` IPC
 * surfaces — the desktop half of the local-files read plane.
 *
 * `pickFolder` is the grant mint: for directories it runs the OS
 * dialog then validates the path through `local:add` (which mints the
 * `treeUri`/`label` descriptor `LocalFileSource.addFolder` commits as
 * the `local_sources` row). Picked FILES use `pickLocalFiles`: each
 * validated path stages one descriptor, then `addFolder` consumes a
 * staged pick instead of opening the dialog — one staged pick per
 * `addFolder` call.
 *
 * `docUri` is pure string math (`shared/local-paths.ts`) so
 * `LocalFileSource.uriFor` — and therefore `Session`'s synchronous
 * `localPlaybackFor` hook — never crosses IPC.
 */
export type DesktopTagReader = TagReaderPort & {
  /**
   * Queue a validated pick for the NEXT `pickFolder` call (i.e. the
   * next `localSource.addFolder`). Used by `pickLocalFiles` for
   * picked-file grants.
   */
  readonly stagePick: (pick: PickedFolder) => void;
  /**
   * Picked-file grant flow: opens the OS file dialog, validates every
   * path through `local:add`, and stages each resulting descriptor.
   * Returns the staged picks — the caller then invokes
   * `localSource.addFolder(signal)` once per pick.
   */
  readonly pickLocalFiles: (
    signal: CancellationSignal,
  ) => Promise<Result<readonly PickedFolder[]>>;
};

export function createDesktopTagReader(api: AuqwApi): DesktopTagReader {
  const staged: PickedFolder[] = [];

  const ifCancelled = (signal: CancellationSignal): Result<never> | null =>
    signal.cancelled ? err(appError('cancelled', 'cancelled')) : null;

  const toPick = (payload: LocalPickPayload): PickedFolder => ({
    treeUri: payload.treeUri,
    label: payload.label,
  });

  async function pickFolder(
    signal: CancellationSignal,
  ): Promise<Result<PickedFolder>> {
    const cancelled = ifCancelled(signal);
    if (cancelled !== null) {
      return cancelled;
    }
    const next = staged.shift();
    if (next !== undefined) {
      return ok(next);
    }
    try {
      const picked = await api.dialog.pickFolder('Add a local folder');
      if (picked === null) {
        return err(appError('no-result', 'picker cancelled'));
      }
      // `local:add` validates + realpaths the pick and mints the
      // grant descriptor — the engine commits it on addFolder.
      const { picks } = await api.local.add({ paths: [picked] });
      const first = picks[0];
      if (first === undefined || first.kind !== 'dir') {
        return err(
          appError('invalid-response', 'local:add returned no dir pick'),
        );
      }
      return ok(toPick(first));
    } catch (thrown) {
      return err(shellToAppError(thrown));
    }
  }

  async function pickLocalFiles(
    signal: CancellationSignal,
  ): Promise<Result<readonly PickedFolder[]>> {
    const cancelled = ifCancelled(signal);
    if (cancelled !== null) {
      return cancelled;
    }
    try {
      const paths = await api.dialog.pickFiles('Add local files', true);
      if (paths.length === 0) {
        return err(appError('no-result', 'picker cancelled'));
      }
      const { picks } = await api.local.add({ paths: [...paths] });
      const folders = picks.map(toPick);
      for (const pick of folders) {
        staged.push(pick);
      }
      return ok(folders);
    } catch (thrown) {
      return err(shellToAppError(thrown));
    }
  }

  return {
    pickFolder,
    pickLocalFiles,
    stagePick: (pick) => {
      staged.push(pick);
    },

    async enumerate(treeUri, signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      try {
        const { entries } = await api.tagread.enumerate({ treeUri });
        const mapped: LocalEntry[] = entries.map((entry) => ({
          docId: entry.docId,
          name: entry.name,
          size: entry.size,
          mime: entry.mime,
          modifiedMs: entry.modifiedMs,
        }));
        return ok(mapped);
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    },

    // The engine sends every changed docId in one call — the channel
    // bound is MAX_TAGREAD_BATCH, so larger sets ride sequential
    // chunks, in request order, checking cancellation between them.
    async fingerprint(treeUri, docIds, signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      try {
        const mapped: (FileFingerprint | null)[] = [];
        for (let at = 0; at < docIds.length; at += MAX_TAGREAD_BATCH) {
          const between = ifCancelled(signal);
          if (between !== null) {
            return between;
          }
          const { fingerprints } = await api.tagread.fingerprint({
            treeUri,
            docIds: docIds.slice(at, at + MAX_TAGREAD_BATCH),
          });
          for (const fp of fingerprints) {
            mapped.push(
              fp === null
                ? null
                : { docId: fp.docId, fingerprint: fp.fingerprint },
            );
          }
        }
        return ok(mapped);
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    },

    async readTags(treeUri, docIds, signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      try {
        const mapped: (LocalTags | null)[] = [];
        for (let at = 0; at < docIds.length; at += MAX_TAGREAD_BATCH) {
          const between = ifCancelled(signal);
          if (between !== null) {
            return between;
          }
          const { tags } = await api.tagread.read({
            treeUri,
            docIds: docIds.slice(at, at + MAX_TAGREAD_BATCH),
          });
          for (const tag of tags) {
            mapped.push(
              tag === null
                ? null
                : {
                    docId: tag.docId,
                    title: tag.title,
                    artist: tag.artist,
                    album: tag.album,
                    durationMs: tag.durationMs,
                    genre: tag.genre,
                  },
            );
          }
        }
        return ok(mapped);
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    },

    docUri(treeUri, docId) {
      // Foreign treeUris can't produce a file URI — the raw value
      // carries the corrupt state through for the diagnostics log.
      return docUriFor(treeUri, docId) ?? treeUri;
    },
  };
}
