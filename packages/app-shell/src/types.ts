/**
 * `useAppShell` owns the composition both app shells used to build
 * inline: navigation + overlay stacks, the toast bus, locale
 * application, the settings write chain and picker epochs, downloads
 * ledger/usage reads, the offline playability gates, search flow
 * (session, suggestions, recents), entity fetch bookkeeping, every
 * view-model derivation, the play/report funnel, queue/playlist/
 * lyrics/radio ops, row action + playlist-picker sheets, and the
 * transfer state machine.
 *
 * What it does NOT own — the platform seams stay in the apps, wired
 * through `AppShellPorts`: how connectivity is probed, what 'owned'
 * bytes the player can attach, file pickers / SAF writes, the sync
 * surfaces (IPC panel vs engine client), artwork cache, gesture
 * morph values, and every screen's JSX.
 *
 * Genuine platform differences are parameterized, not unified:
 * `ports` carries a flag for each real divergence (see each field's
 * doc). Where both apps threaded the same callback under different
 * names the factory picked one name and the apps adapt.
 */
import {
  appError,
  appErrorKind,
  err,
} from '@auqw/application';
import type {
  CancellationSignal,
  DownloadManager,
  DownloadRecord,
  EntityRef,
  ImportPreview,
  LocalFileSource,
  PeaksPort,
  ProviderPort,
  ReadySession,
  Result,
  Session,
  SourceRef,
  StoragePort,
  TrackMetadata,
} from '@auqw/application';
import {
  nextQueueDestination,
  reportResult,
  t,
} from '@auqw/ui-shared';

/** The overlay variants the factory can push itself. Apps extend the
    union with their own routes (mobile adds `{ type: 'sync' }`). */
export type ShellOverlay =
  | {
      readonly type: 'collection';
      readonly key: 'liked' | 'top50' | 'history' | 'downloads';
    }
  | { readonly type: 'playlist'; readonly playlistId: string }
  | { readonly type: 'entity'; readonly ref: EntityRef }
  | { readonly type: 'corrections' }
  | { readonly type: 'transfer' };

/** The slice of each app's SessionController the shell composition
    reads. Both controllers satisfy this structurally — the factory
    never touches the platform-only members (connectivity, sync,
    artwork cache, local-playback probe). */
export interface AppShellController {
  readonly session: Session;
  readonly storage: Pick<StoragePort, 'loadAttempts'>;
  readonly providers: readonly ProviderPort[];
  readonly downloads: DownloadManager;
  readonly local: () => LocalFileSource | null;
  readonly replaceLibrary: (
    text: string,
    signal: CancellationSignal,
  ) => Promise<Result<ImportPreview>>;
}

/** Outcome of the platform's export write. `done` carries a detail
    CLOSURE, not a string — the transfer overlay re-derives its labels
    on locale change, so the write reports how to rebuild the detail
    rather than freezing one language at write time. */
export type ExportWrite =
  | { readonly kind: 'done'; readonly detail: () => string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error' };

/** Platform seams + the genuine behavior divergences. Every member is
    optional unless noted; an absent flag reproduces the mobile/desktop
    default documented on it. */
export interface AppShellPorts<O extends ShellOverlay> {
  /**
   * Connectivity edge stream — REQUIRED. Desktop:
   * `controller.subscribeOnline`. Mobile wraps its connectivity port:
   * subscribe-then-snapshot with an edge guard (a delayed snapshot
   * must not overwrite a landed edge) and a subscribe-throw fallback.
   */
  readonly subscribeOnline: (set: (online: boolean) => void) => () => void;

  /**
   * "Owned bytes the player can attach" probe — desktop:
   * `controller.localPlaybackFor(id) !== null` (today always false —
   * the web player has no `provider:'local'` route yet). Mobile: the
   * ledger/local-file ownership read, which is the factory's internal
   * `isOwned` — so mobile leaves this unset. Also drives the offline
   * 'unavailable' marks on queue/library/playlist rows.
   */
  readonly localPlayable?: ((recordingId: string) => boolean) | undefined;

  /**
   * Desktop's attempt-action funnel: pending action labels ride
   * `attemptActionsRef` and the `playback.failed` watcher reports
   * engine-advanced verdicts through the deduped funnel. Mobile reports
   * each op's own Result directly. Default false (mobile shape).
   */
  readonly trackAttemptActions?: boolean | undefined;

  /**
   * Desktop gates next/previous on a resolvable target ALWAYS (a
   * missing walk target no-ops even online); mobile gates only while
   * connectivity is explicitly down. Default false (mobile shape).
   */
  readonly gateAdvanceAlways?: boolean | undefined;

  /**
   * Mobile drops a selectedRef pin when bytes are owned so downloads
   * actually play (a provider pin beats owned bytes in #pickRef);
   * desktop always passes the entry's selectedRef. Default false.
   */
  readonly preferOwnedRef?: boolean | undefined;

  /**
   * Desktop's entity play-all/shuffle filter requires `canPlayMeta`;
   * mobile plays every fetched row. Default false (mobile shape).
   */
  readonly entityPlayRequiresCanPlay?: boolean | undefined;

  /**
   * Mobile marks catalog/entity rows whose sourceRef is the ref the
   * player resolved (`playingRef` into toSearchModel/toEntityModel);
   * desktop does not mark. Default false.
   */
  readonly markPlayingRef?: boolean | undefined;

  /**
   * Mobile's local catalog: provenance-local recordings overlay the
   * session's copies in the library model, and folder-owned
   * recordings fold into search results as `local:` rows. Desktop
   * reads session recordings alone. Default false.
   */
  readonly localCatalog?: boolean | undefined;

  /**
   * Mobile treats a home card as a recording only when its key sits
   * in the recents rail — an unrecognized suggestion key no-ops
   * instead of enqueueing a provider-keyed 'recordingId' that can
   * only fail (activateHomeCard). Desktop presses any unmatched key
   * through the recording path. Default false.
   */
  readonly strictHomeCardKeys?: boolean | undefined;

  /**
   * Download affordances (create-side) — mobile hides them on iOS
   * (its provisional player has no local-attach path, so a stored
   * byte could never play); desktop always shows. Default true.
   */
  readonly downloadsEnabled?: boolean | undefined;

  /**
   * Stage-open initial state — desktop's stage column mounts open,
   * mobile's sheet starts collapsed. Default false.
   */
  readonly stageInitiallyOpen?: boolean | undefined;

  /**
   * Mobile holds the ended player model mounted through the collapse
   * settle (ripping it out mid-gesture would vanish the sheet);
   * desktop unmounts immediately. Default false.
   */
  readonly holdEndedPlayer?: boolean | undefined;
  /**
   * Runs inside the held-player release timer — mobile re-seeds its
   * morph shared values to rest so a fresh player starts collapsed.
   */
  readonly resetStageMorph?: (() => void) | undefined;

  /**
   * Mobile prefetches lyrics whenever the sheet is open (any mode) —
   * desktop only while lyrics mode is showing. Default false.
   */
  readonly lyricsWhileOpen?: boolean | undefined;

  /**
   * Mobile returns an open sheet to player mode when the track under
   * it changes (deep-link modes keep their explicit mode — the reset
   * listens only for the track change). Default false.
   */
  readonly resetModeOnTrack?: boolean | undefined;

  /**
   * The 'sync' settings row. Mobile pushes its dedicated sync overlay
   * (`openSyncOverlay: { type: 'sync' }`); desktop scrolls+focuses the
   * inline sync section instead (`openSync` callback bumping its
   * focus tick). Exactly one should be set.
   */
  readonly openSyncOverlay?: O | undefined;
  readonly openSync?: (() => void) | undefined;

  /**
   * The mobile-only 'artworkCacheBytes' settings row opens a budget
   * picker; a shrunken cap runs `sweepArtworkCache` after the write
   * commits (desktop filters the row out entirely — see
   * `omitSettingsRows`). Providing `openArtworkCacheRow` is what turns
   * the row live.
   */
  readonly openArtworkCacheRow?: (() => void) | undefined;
  readonly sweepArtworkCache?: (() => void) | undefined;

  /**
   * After a committed local-source mutation (add/remove/rescan) the
   * mutated instance's rows must reach the session, and the
   * local-read models must re-derive (`refreshLocal` bumps their
   * tick). Both apps solve the mid-flight rehydrate swap
   * differently — desktop re-reads the live source and syncs its
   * snapshot; mobile rehydrates when the instance swapped and
   * refreshes on the swap's settle instead.
   */
  readonly afterLocalMutation: (
    mutated: LocalFileSource,
    refreshLocal: () => void,
  ) => void;

  /** Mobile dismisses the IME on a committed search. */
  readonly onSearchCommit?: (() => void) | undefined;

  /** Taptic feedback on transport taps (mobile). */
  readonly haptic?: ((kind: 'light' | 'warning') => void) | undefined;

  /**
   * Waveform peaks seam — a `PeaksPort` over the desktop stream IPC /
   * Android MediaExtractor path, null where none exists (iOS).
   */
  readonly peaksPort?: PeaksPort | null | undefined;

  /**
   * Settings-model platform inputs the factory cannot derive:
   * `localSupported` (desktop probes `local() !== null`; mobile asks
   * the tag-reader module) and the sync row's availability + label
   * (each app's own sync surface owns those).
   */
  readonly settingsExtras: () => {
    readonly localSupported: boolean;
    readonly syncSupported: boolean;
    readonly syncLabel: string | null;
  };
  /** Settings rows a platform omits outright (desktop: the
      artwork-cache budget row — Chromium's image cache owns artwork
      memory, so the row would dead-end). */
  readonly omitSettingsRows?: readonly string[] | undefined;

  /**
   * Library export write — desktop triggers a browser download; mobile
   * writes through SAF/documents. Returns 'cancelled' when the user
   * backed out of the destination pick (import phase resets to idle).
   */
  readonly exportJson: (
    json: string,
    name: string,
  ) => Promise<ExportWrite>;
}

export interface AppShellDeps<O extends ShellOverlay> {
  readonly controller: AppShellController;
  readonly state: ReadySession;
  readonly ports: AppShellPorts<O>;
}

// ---- pure helpers (tested node-side; the hook is thin wiring) ----

/**
 * The walk-space target next/previous would land on — mirrors the
 * engine's cursor so the offline gate tests the row the transport is
 * about to play, not the one after it: `next` uses the same
 * mark-skipping destination the engine computes; `previous` restarts
 * the current track past 3 s, wraps tail↔head under repeat=all, and
 * returns null when the cursor sits nowhere.
 */
export function advanceTargetId(input: {
  readonly method: 'next' | 'previous';
  readonly occurrences: readonly {
    readonly occurrenceId: string;
    readonly recordingId: string;
  }[];
  readonly currentOccurrenceId: string | null;
  readonly dealtOrder: readonly string[] | null;
  readonly failedIds: ReadonlySet<string>;
  readonly repeat: 'off' | 'all' | 'one';
  readonly positionMs: number;
}): string | null {
  const { occurrences, currentOccurrenceId } = input;
  if (input.method === 'next') {
    return nextQueueDestination({
      queue: { occurrences, currentOccurrenceId },
      dealtOrder: input.dealtOrder,
      failedIds: input.failedIds,
      repeat: input.repeat,
    });
  }
  const walk =
    input.dealtOrder ?? occurrences.map((o) => o.occurrenceId);
  const pos =
    currentOccurrenceId === null ? -1 : walk.indexOf(currentOccurrenceId);
  if (pos < 0) {
    return null;
  }
  const wraps = input.repeat === 'all' && walk.length > 0;
  return input.positionMs > 3_000
    ? (walk[pos] ?? null)
    : pos === 0
      ? wraps
        ? (walk[walk.length - 1] ?? null)
        : (walk[pos] ?? null)
      : (walk[pos - 1] ?? null);
}

/** A row-actions sheet entry — `icon` is the subset of both
    platforms' IconName unions the action list uses. */
export type ShellSheetAction = {
  readonly key: string;
  readonly label: string;
  readonly icon:
    | 'heart'
    | 'queue'
    | 'list-plus'
    | 'download'
    | 'close'
    | 'radio'
    | 'note'
    | 'library';
};

export type ActionTargetLike =
  | { readonly kind: 'recording'; readonly recordingId: string }
  | { readonly kind: 'metadata'; readonly meta: TrackMetadata };

/**
 * The row-actions sheet model — identical list on both platforms.
 * `recordFor`/`downloadRefFor` are the caller's ledger/ref reads so
 * the pure builder stays module-local-testable.
 */
export function rowActionsModel(input: {
  readonly target: ActionTargetLike;
  readonly liked: boolean;
  readonly title: string;
  readonly recordFor: (
    recordingId: string,
  ) => Pick<DownloadRecord, 'state' | 'error'> | null;
  readonly downloadRefFor: (recordingId: string) => SourceRef | null;
  readonly radioSeedable: boolean;
}): { readonly title: string; readonly actions: ShellSheetAction[] } {
  const { target } = input;
  const actions: ShellSheetAction[] = [
    // Like lives in the sheet for recording targets — the row itself
    // keeps the heart icon only as an indicator.
    ...(target.kind === 'recording'
      ? [
          {
            key: 'like',
            label: input.liked ? t('common.unlike') : t('common.like'),
            icon: 'heart' as const,
          },
        ]
      : []),
    {
      key: 'enqueue',
      label: t('action.addToQueue'),
      icon: 'queue' as const,
    },
    {
      key: 'add',
      label: t('sheets.addToPlaylist'),
      icon: 'list-plus' as const,
    },
    // Download affordance where a provider ref can mint a stream — OR
    // a ledger row already exists (cancel/retry/remove don't need a
    // resolvable ref).
    ...(target.kind === 'recording' &&
    (input.recordFor(target.recordingId) !== null ||
      input.downloadRefFor(target.recordingId) !== null)
      ? [
          {
            key: 'download',
            label: (() => {
              const row = input.recordFor(target.recordingId);
              return row === null
                ? t('action.download')
                : row.state === 'available'
                  ? t('action.removeDownload')
                  : row.state === 'failed_with_retry'
                    ? t('action.retryDownload')
                    : t('action.cancelDownload');
            })(),
            icon: 'download' as const,
          },
          // A failed row needs an out that isn't retry — keep vs.
          // delete are both honest offers.
          ...(input.recordFor(target.recordingId)?.state ===
          'failed_with_retry'
            ? [
                {
                  key: 'removeDownload',
                  label: t('action.removeDownload'),
                  icon: 'close' as const,
                },
              ]
            : []),
        ]
      : []),
    // Only offer the seed affordance when the seed's own provider
    // declares radio.seed — routing is ref-scoped, so another
    // provider's support is a dead end.
    ...(input.radioSeedable
      ? [
          {
            key: 'radio',
            label: t('stage.radio.start'),
            icon: 'radio' as const,
          },
        ]
      : []),
    ...(target.kind === 'metadata' && target.meta.albumRef != null
      ? [
          {
            key: 'album',
            label: t('action.openAlbum'),
            icon: 'note' as const,
          },
        ]
      : []),
    ...(target.kind === 'metadata' && target.meta.artistRef != null
      ? [
          {
            key: 'artist',
            label: t('action.openArtist'),
            icon: 'library' as const,
          },
        ]
      : []),
  ];
  return { title: input.title, actions };
}

/** The stage's download affordance: a chip when a ledger row or a
    downloadable ref exists, else hidden. */
export function stageDownloadChip(input: {
  readonly recordingId: string | null;
  readonly recordFor: (
    recordingId: string,
  ) => Pick<DownloadRecord, 'state' | 'error'> | null;
  readonly downloadRefFor: (recordingId: string) => SourceRef | null;
  readonly chipFor: (recordingId: string) => string | null;
}): string | null {
  if (
    input.recordingId === null ||
    (input.recordFor(input.recordingId) === null &&
      input.downloadRefFor(input.recordingId) === null)
  ) {
    return null;
  }
  return input.chipFor(input.recordingId) ?? 'idle';
}

/** Report the failed-download's stored error before retrying — the
    row kept why it failed, so the tap is never a silent ↓→⚠→↓ loop. */
export function reportStoredDownloadError(
  error: { readonly kind: string; readonly message: string } | null,
): void {
  if (error === null) {
    return;
  }
  reportResult(
    'action.download',
    err(appError(appErrorKind(error.kind), error.message)),
  );
}

/**
 * Playlist download-all state + the missing-only request list.
 * Requesting an already-owned recording with a changed mapping would
 * delete its stored file first — 'download missing' must never cost
 * offline playback. Ownership (`isOwned`) is ledger/local-file truth,
 * never the playback-capability probe.
 */
export function playlistDownloadPlan(input: {
  readonly entries: readonly {
    readonly recordingId: string;
    readonly selectedRef: SourceRef | null;
  }[];
  readonly isOwned: (recordingId: string) => boolean;
  readonly downloadRefFor: (recordingId: string) => SourceRef | null;
  readonly recordFor: (recordingId: string) => unknown;
}): {
  readonly state: 'none' | 'partial' | 'all';
  readonly requests: readonly {
    readonly recordingId: string;
    readonly sourceRef: SourceRef;
  }[];
} {
  const requests = input.entries
    .filter((entry) => !input.isOwned(entry.recordingId))
    .flatMap((entry) => {
      const sourceRef = input.downloadRefFor(entry.recordingId);
      return sourceRef === null
        ? []
        : [{ recordingId: entry.recordingId, sourceRef }];
    });
  // 'all' means every entry is owned — a stored download or a local
  // file both count; only-downloadable entries gate it.
  const allStored =
    input.entries.length > 0 &&
    input.entries.every((entry) => input.isOwned(entry.recordingId));
  const anyTracked = input.entries.some(
    (entry) =>
      input.recordFor(entry.recordingId) !== null ||
      input.isOwned(entry.recordingId),
  );
  return {
    state: allStored ? 'all' : anyTracked ? 'partial' : 'none',
    requests,
  };
}
