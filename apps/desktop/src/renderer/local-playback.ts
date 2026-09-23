import { toFileUri } from '../shared/local-paths.ts';

/**
 * `SessionDeps.localPlaybackFor` — the sync playable-URI hook. Mobile
 * answers it by delegating to two already-sync lookups, and the desktop
 * seam mirrors that exactly: no snapshot map, no refresh step, nothing
 * preloaded.
 *
 * - `fileFor` is `DownloadManager.fileFor` — an in-memory ledger read
 *   returning the bare managed name; the URI is `file://` +
 *   `${mediaDir}/${name}` (the same math the utility's `local:probe`
 *   applies, shared via `shared/local-paths.ts` so they can never
 *   disagree).
 * - `uriFor` is `LocalFileSource.uriFor` — the engine's in-memory row
 *   → `docUri` string math (also shared), so it stays sync too.
 *
 * Integration point for the mount leg (`renderer/controller.ts` on
 * `s4/ui-web-mount`): after constructing `DownloadManager` and
 * `LocalFileSource`, wire
 *
 * ```ts
 * localPlaybackFor: createLocalPlayback({
 *   mediaDir: `${meta.userDataPath}/media`,
 *   fileFor: (id) => downloads.fileFor(id),
 *   uriFor: (id) => localSource.uriFor(id),
 * }),
 * ```
 *
 * into the `Session` deps. No refresh call is needed after `local:*`
 * mutations — the hook reads live engine state on every probe.
 */
export type LocalPlaybackDeps = {
  /** Managed media dir — `${userDataPath}/media`. */
  readonly mediaDir: string;
  /** `DownloadManager.fileFor` — bare ledger name or null. */
  readonly fileFor: (recordingId: string) => string | null;
  /** `LocalFileSource.uriFor` — playable URI or null. */
  readonly uriFor: (recordingId: string) => string | null;
};

export function createLocalPlayback(
  deps: LocalPlaybackDeps,
): (recordingId: string) => string | null {
  const dir = deps.mediaDir.endsWith('/')
    ? deps.mediaDir.slice(0, -1)
    : deps.mediaDir;
  return (recordingId: string): string | null => {
    // Owned bytes first — a stored download wins; a local file whose
    // download row was removed still plays from its docUri.
    const file = deps.fileFor(recordingId);
    if (file !== null) {
      return toFileUri(`${dir}/${file}`);
    }
    return deps.uriFor(recordingId);
  };
}
