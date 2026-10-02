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
import type { AuqwApi } from '../shared/contract.ts';
import { MAX_TAGREAD_BATCH } from '../shared/contract.ts';
import { docUriFor } from '../shared/local-paths.ts';
import { ifCancelled, settleIpc, shellToAppError } from './ipc-errors.ts';

/**
 * `TagReaderPort` over the `tagread:*` + `local:add` + `dialog` IPC
 * surfaces — the desktop half of the local-files read plane.
 *
 * `pickFolder` runs the OS dialog then validates the path through
 * `local:add` (which mints the `treeUri`/`label` descriptor
 * `LocalFileSource.addFolder` commits as the `local_sources` row).
 *
 * `docUri` is pure string math (`shared/local-paths.ts`) so
 * `LocalFileSource.uriFor` — and therefore `Session`'s synchronous
 * `localPlaybackFor` hook — never crosses IPC.
 */
export function createDesktopTagReader(api: AuqwApi): TagReaderPort {
  async function pickFolder(
    signal: CancellationSignal,
  ): Promise<Result<PickedFolder>> {
    const cancelled = ifCancelled(signal);
    if (cancelled !== null) {
      return cancelled;
    }
    try {
      const picked = await api.dialog.pickFolder('Add a local folder');
      const afterDialog = ifCancelled(signal);
      if (afterDialog !== null) {
        return afterDialog;
      }
      if (picked === null) {
        return err(appError('no-result', 'picker cancelled'));
      }
      // `local:add` validates + realpaths the pick and mints the
      // grant descriptor — the engine commits it on addFolder. A
      // cancel that landed during either await must not let the pick
      // through: addFolder commits every successful result.
      const { picks } = await api.local.add({ paths: [picked] });
      const afterAdd = ifCancelled(signal);
      if (afterAdd !== null) {
        return afterAdd;
      }
      const first = picks[0];
      if (first === undefined || first.kind !== 'dir') {
        return err(
          appError('invalid-response', 'local:add returned no dir pick'),
        );
      }
      return ok({ treeUri: first.treeUri, label: first.label });
    } catch (thrown) {
      return err(shellToAppError(thrown));
    }
  }

  /**
   * One `tagread:*` batch call chunked at the channel's MAX bound —
   * the engine sends every changed docId in one call, so larger sets
   * ride sequential chunks, in request order, checking cancellation
   * between them. Payload rows are already the port's row shape.
   */
  async function batched<R>(
    docIds: readonly string[],
    signal: CancellationSignal,
    call: (docIds: readonly string[]) => Promise<readonly (R | null)[]>,
  ): Promise<Result<readonly (R | null)[]>> {
    const out: (R | null)[] = [];
    const initial = ifCancelled(signal);
    if (initial !== null) {
      return initial;
    }
    for (let at = 0; at < docIds.length; at += MAX_TAGREAD_BATCH) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      const page = await settleIpc(
        call(docIds.slice(at, at + MAX_TAGREAD_BATCH)),
        signal,
      );
      if (!page.ok) {
        return page;
      }
      out.push(...page.value);
    }
    return ok(out);
  }

  return {
    pickFolder,

    async enumerate(treeUri, signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      // Read-only: a cancel settles the caller early; the parked
      // utility enumeration's result is simply dropped. The utility
      // walk fails typed on any unlistable dir, so its unlisted
      // region is always empty.
      const res = await settleIpc(
        api.tagread.enumerate({ treeUri }),
        signal,
      );
      return res.ok
        ? ok({ entries: res.value.entries, failedTrees: [] })
        : res;
    },

    fingerprint(treeUri, docIds, signal) {
      return batched<FileFingerprint>(docIds, signal, (ids) =>
        api.tagread
          .fingerprint({ treeUri, docIds: ids })
          .then((r) => r.fingerprints),
      );
    },

    readTags(treeUri, docIds, signal) {
      return batched<LocalTags>(docIds, signal, (ids) =>
        api.tagread.read({ treeUri, docIds: ids }).then((r) => r.tags),
      );
    },

    docUri(treeUri, docId) {
      // Foreign treeUris can't produce a file URI — the raw value
      // carries the corrupt state through for the diagnostics log.
      return docUriFor(treeUri, docId) ?? treeUri;
    },
  };
}
