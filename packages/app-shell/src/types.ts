/**
 * `useAppShell` owns the shared shell composition; the platform seams
 * stay in the apps, wired through `AppShellPorts`: connectivity,
 * local-playback capability, file pickers / SAF writes, sync
 * surfaces, artwork cache, gesture morph values, and every screen's
 * JSX. Genuine platform differences are parameterized, not unified —
 * `ports` carries a flag for each real divergence (see each field).
 */
import {
  appError,
  appErrorKind,
  err,
  isPermanentFailure,
} from '@auqw/application';
import type {
  AppError,
  AuthSnapshot,
  CancellationSignal,
  DownloadManager,
  DownloadRecord,
  EntityRef,
  ImportPreview,
  LocalFileSource,
  PeaksPort,
  PeaksStore,
  ProviderPort,
  SearchHistoryStore,
  ReadySession,
  Result,
  Session,
  SourceRef,
  StoragePort,
  TrackMetadata,
  UpdateCheckKind,
  UpdateSnapshot,
} from '@auqw/application';
import {
  nextQueueDestination,
  reportResult,
  t,
} from '@auqw/ui-shared';
import type {
  ActionTarget,
  DownloadChip,
  StageMode,
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

/** The slice of each app's SessionController the shell reads — both
    satisfy this structurally; platform-only members stay app-side. */
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
    CLOSURE — the transfer overlay re-derives its labels on locale
    change, so the write reports how to rebuild the detail. */
export type ExportWrite =
  | { readonly kind: 'done'; readonly detail: () => string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error' };

/** Platform seams + the genuine behavior divergences. Every member is
    optional unless noted; an absent flag takes the documented
    default. */
/**
 * OAuth session trust — the platform's custody/exchange seam exposed
 * to the shell as status snapshots + verbs. Token material never
 * crosses it: the sign-in sheet renders `userCode`/`verificationUrl`
 * (the user-facing pair) and nothing else leaves the platform side.
 * `copyText`/`openUrl` ride this port rather than a generic platform
 * seam because the sheet is their only consumer.
 */
export interface AuthShellPort {
  /** The latest snapshot — stable ref between publishes. */
  snapshot(): AuthSnapshot;
  /** Change feed — drives the sheet + the signed-in settings row. */
  subscribe(listener: () => void): () => void;
  /** Start a device flow — duplicate calls while live are no-ops. */
  beginSignIn(): void;
  /** Sheet dismissal — cancels an in-flight poll, resets 'failed'. */
  cancelSignIn(): void;
  /** Drops the grant: custody, host slot, memory. */
  signOut(): Promise<Result<void>>;
  /** Forces an immediate renewal attempt — the linked-but-dead
   *  recovery affordance a wall CTA can offer without a sign-out. */
  retryNow(): void;
  /** The advanced client_id override — null restores the default. */
  setClientOverride(clientId: string | null): Promise<Result<void>>;
  copyText(text: string): void;
  openUrl(url: string): void;
}

/**
 * Release update check — the platform owns the transport (the
 * renderer's CSP forbids the egress, so desktop runs the service in
 * main and feeds it over `update:*` IPC; mobile fetches directly).
 * Only the snapshot + verbs cross the port. `action` advertises the
 * install affordance this platform reached so the banner labels
 * itself honestly: 'open' opens the release page, 'download' fetches
 * and verifies the artifact then hands it to the OS (dmg in Finder),
 * 'install' runs the platform's install path (Android APK intent,
 * NSIS setup launch, AppImage replace).
 */
export interface UpdateShellPort {
  /** The latest snapshot — stable ref between publishes. */
  snapshot(): UpdateSnapshot;
  /** Change feed — drives the banner + the settings row value. */
  subscribe(listener: () => void): () => void;
  /** 'boot' is once-per-process inside the port; 'manual' refetches. */
  check(kind: UpdateCheckKind): void;
  /** What `act()` does while the apply pipeline is idle — the banner
      action label reads this. */
  readonly action: 'open' | 'download' | 'install';
  /**
   * Run the affordance on the currently-available release: while the
   * apply pipeline is idle it opens/downloads/installs per `action`;
   * in 'ready-to-restart' it relaunches; mid-pipeline it is a no-op;
   * 'failed' retries.
   */
  act(): void;
  /** Abort an in-flight apply — back to the install affordance. */
  cancel(): void;
}

export interface AppShellPorts<E> {
  /**
   * Connectivity edge stream — REQUIRED. Desktop:
   * `controller.subscribeOnline`. Mobile wraps its connectivity port:
   * subscribe-then-snapshot with an edge guard and a subscribe-throw
   * fallback.
   */
  readonly subscribeOnline: (set: (online: boolean) => void) => () => void;

  /**
   * App foreground/active stream — optional. Mobile wires
   * `AppState` (`status === 'active'`); desktop wires
   * `document.visibilitychange` (`!document.hidden`). The listener
   * must get the CURRENT state pushed on subscribe. While inactive
   * the shell freezes the interpolated-position clock that drives the
   * lyrics surface — an off-screen tick only burns battery. Absent =
   * always active (reduced harnesses, tests).
   */
  readonly subscribeAppActive?: (set: (active: boolean) => void) => () => void;

  /**
   * "Owned bytes the player can attach" probe — desktop:
   * `controller.localPlaybackFor(id) !== null`. Mobile's owned set IS
   * the attachable set, so it leaves this unset (the factory's
   * `isOwned`). Also drives the offline 'unavailable' row marks.
   */
  readonly localPlayable?: ((recordingId: string) => boolean) | undefined;

  /**
   * The attempt-action funnel: pending action labels ride
   * `attemptActionsRef` and a `playback.failed` watcher reports
   * verdicts that land after the op promise settled — engine-advanced
   * failures on desktop, late native `failed` statuses on mobile.
   * Both shells set it. Default false.
   */
  readonly trackAttemptActions?: boolean | undefined;

  /**
   * Desktop gates next/previous on a resolvable target ALWAYS; mobile
   * gates only while connectivity is explicitly down. Default false.
   */
  readonly gateAdvanceAlways?: boolean | undefined;

  /**
   * Mobile drops a selectedRef pin when bytes are owned so downloads
   * actually play (a provider pin beats owned bytes in #pickRef);
   * desktop always forwards the entry pin. Default false.
   */
  readonly preferOwnedRef?: boolean | undefined;

  /**
   * Desktop's entity play-all/shuffle filter requires `canPlayMeta`;
   * mobile plays every fetched row. Default false.
   */
  readonly entityPlayRequiresCanPlay?: boolean | undefined;

  /**
   * Mobile marks catalog/entity rows whose sourceRef is the ref the
   * player resolved; desktop does not mark. Default false.
   */
  readonly markPlayingRef?: boolean | undefined;

  /**
   * Mobile's local catalog: provenance-local recordings overlay the
   * session's copies, and folder-owned rows fold into search results
   * as `local:` rows. Default false.
   */
  readonly localCatalog?: boolean | undefined;

  /**
   * Mobile treats a home card as a recording only when its key sits
   * in the recents rail — an unrecognized suggestion key no-ops
   * instead of enqueueing a provider-keyed 'recordingId' that can
   * only fail. Desktop presses any unmatched key through the
   * recording path. Default false.
   */
  readonly strictHomeCardKeys?: boolean | undefined;

  /**
   * Download affordances (create-side) — mobile hides them on iOS
   * (stored bytes could never play there). Default true.
   */
  readonly downloadsEnabled?: boolean | undefined;

  /**
   * Stage-open initial state — desktop's column mounts open,
   * mobile's sheet starts collapsed. Default false.
   */
  readonly stageInitiallyOpen?: boolean | undefined;

  /**
   * Mobile holds the ended player model mounted through the collapse
   * settle; desktop unmounts immediately. Default false.
   */
  readonly holdEndedPlayer?: boolean | undefined;

  /**
   * Mobile's "playing from …" queue chrome folds the covering sheet
   * after navigating to the source surface; desktop's stage column
   * sits beside the world and stays open. Default false.
   */
  readonly closeStageOnContextNav?: boolean | undefined;
  /**
   * Runs inside the held-player release timer — mobile re-seeds its
   * morph shared values to rest so a fresh player starts collapsed.
   */
  readonly resetStageMorph?: (() => void) | undefined;

  /**
   * Mobile prefetches lyrics whenever the sheet is open (any mode);
   * desktop only while lyrics mode shows. Default false.
   */
  readonly lyricsWhileOpen?: boolean | undefined;

  /**
   * Mobile returns an open sheet to player mode when the track under
   * it changes. Default false.
   */
  readonly resetModeOnTrack?: boolean | undefined;

  /**
   * The 'sync' settings row. Mobile pushes its sync overlay
   * (`openSyncOverlay: { type: 'sync' }`); desktop scrolls+focuses the
   * inline sync section (`openSync`). Exactly one should be set.
   */
  readonly openSyncOverlay?: E | undefined;
  readonly openSync?: (() => void) | undefined;

  /**
   * Bound on how many search results feed the home suggestion-card
   * lookup — desktop capped it at 12 (the rail's depth); mobile
   * searched the whole page. Unset = unbounded (mobile).
   */
  readonly homeSuggestionLimit?: number | undefined;

  /**
   * The mobile-only 'artworkCacheBytes' settings row opens a budget
   * picker; a shrunken cap runs `sweepArtworkCache` after the write
   * commits. `openArtworkCacheRow` is what turns the row live.
   */
  readonly openArtworkCacheRow?: (() => void) | undefined;
  readonly sweepArtworkCache?: (() => void) | undefined;

  /**
   * After a committed local-source mutation the mutated instance's
   * rows must reach the session and the local-read models re-derive.
   * The apps disagree on the mid-flight rehydrate swap — desktop
   * re-reads the live source and syncs its snapshot; mobile
   * rehydrates when the instance swapped.
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
   * Persisted waveform peaks keyed by recording id — repeat plays
   * render instantly and skip re-extraction entirely. `undefined`
   * keeps peaks memory-only (fresh pull per session).
   */
  readonly peaksStore?: PeaksStore | null | undefined;

  /**
   * Persisted search recents — the rail's durable backing list,
   * hydrated on mount and committed on the same events the in-memory
   * list records (submit, suggestion tap, result tap). `undefined`
   * keeps recents session-scoped (memory-only).
   */
  readonly searchHistory?: SearchHistoryStore | null | undefined;

  /**
   * Settings-model platform inputs the factory cannot derive:
   * `localSupported` (desktop probes `local() !== null`; mobile asks
   * the tag-reader module) and the sync row's availability + label.
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
   * Library export write — desktop triggers a browser download;
   * mobile writes through SAF/documents. 'cancelled' = the user
   * backed out of the destination pick.
   */
  readonly exportJson: (
    json: string,
    name: string,
  ) => Promise<ExportWrite>;

  /**
   * OAuth session trust — present on both apps; absent only in
   * reduced/test harnesses, where the sign-in row and the wall CTA
   * omit themselves.
   */
  readonly auth?: AuthShellPort | undefined;

  /**
   * Release update check — present on both apps; absent in
   * reduced/test harnesses, where the banner and the version +
   * check-for-updates rows omit themselves.
   */
  readonly update?: UpdateShellPort | undefined;
}

export interface AppShellDeps<E = never> {
  readonly controller: AppShellController;
  readonly state: ReadySession;
  readonly ports: AppShellPorts<E>;
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
  const target =
    input.positionMs > 3_000
      ? pos
      : pos === 0
        ? input.repeat === 'all'
          ? walk.length - 1
          : 0
        : pos - 1;
  return walk[target] ?? null;
}

/**
 * The advance gate's skip set: only permanent verdicts flag the row —
 * a transient failure keeps the 'error' display mark but stays in the
 * walk, matching the queue engine's mark policy (`isPermanentFailure`).
 * The gate walks the same set `next()` does or it preflights a target
 * the engine would never land on.
 */
export function failedSkipIds(
  failed: ReadonlyMap<string, AppError>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [id, error] of failed) {
    if (isPermanentFailure(error)) {
      out.add(id);
    }
  }
  return out;
}

/**
 * The mini-player's conveyor targets in both directions, plus whether
 * a landing-less forward swipe still drains the queue — `advance()`
 * stops at the tail (or when a wrap finds only failed rows), which is
 * an actionable edge, not a dead one. Only a null cursor makes the
 * direction genuinely unavailable (advance fails 'no-result').
 *
 * `blocked` marks the current row unresumable: the engine reads a
 * blocked row's retained position as 0 for the restart-window rules,
 * so this walk substitutes the same or the previous target diverges
 * from where the commit actually lands.
 */
export function skipTargetIds(input: {
  readonly occurrences: readonly {
    readonly occurrenceId: string;
    readonly recordingId: string;
  }[];
  readonly currentOccurrenceId: string | null;
  readonly dealtOrder: readonly string[] | null;
  readonly failedIds: ReadonlySet<string>;
  readonly repeat: 'off' | 'all' | 'one';
  readonly positionMs: number;
  /** `queue.blockedError !== undefined` — a blocked row's retained
      position reads as 0 for the restart window, matching the
      engine's own previous() walk. */
  readonly blocked: boolean;
}): {
  readonly next: string | null;
  readonly previous: string | null;
  readonly nextEndsQueue: boolean;
} {
  const walkPosMs = input.blocked ? 0 : input.positionMs;
  const target = (method: 'next' | 'previous'): string | null =>
    advanceTargetId({
      method,
      occurrences: input.occurrences,
      currentOccurrenceId: input.currentOccurrenceId,
      dealtOrder: input.dealtOrder,
      failedIds: input.failedIds,
      repeat: input.repeat,
      positionMs: walkPosMs,
    });
  const next = target('next');
  return {
    next,
    previous: target('previous'),
    nextEndsQueue: input.currentOccurrenceId !== null && next === null,
  };
}

/** A row-actions sheet entry — `icon` is the subset of both
    platforms' IconName unions the action list uses. */
export type ShellSheetAction = {
  readonly key: string;
  readonly label: string;
  readonly icon:
    | 'heart'
    | 'next'
    | 'queue'
    | 'list-plus'
    | 'download'
    | 'close'
    | 'radio'
    | 'note'
    | 'library';
};

export type ActionTargetLike = ActionTarget;

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
  const actions: ShellSheetAction[] = [];
  // Like lives in the sheet for recording targets — the row itself
  // keeps the heart icon only as an indicator.
  if (target.kind === 'recording') {
    actions.push({
      key: 'like',
      label: input.liked ? t('common.unlike') : t('common.like'),
      icon: 'heart',
    });
  }
  actions.push(
    { key: 'playNext', label: t('action.playNext'), icon: 'next' },
    { key: 'enqueue', label: t('action.addToQueue'), icon: 'queue' },
    { key: 'add', label: t('sheets.addToPlaylist'), icon: 'list-plus' },
  );
  // Download affordance where a provider ref can mint a stream — OR
  // a ledger row already exists (cancel/retry/remove don't need a
  // resolvable ref).
  if (target.kind === 'recording') {
    const row = input.recordFor(target.recordingId);
    if (row !== null || input.downloadRefFor(target.recordingId) !== null) {
      actions.push({
        key: 'download',
        label:
          row === null
            ? t('action.download')
            : row.state === 'available'
              ? t('action.removeDownload')
              : row.state === 'failed_with_retry'
                ? t('action.retryDownload')
                : t('action.cancelDownload'),
        icon: 'download',
      });
      // A failed row needs an out that isn't retry — keep vs. delete
      // are both honest offers.
      if (row?.state === 'failed_with_retry') {
        actions.push({
          key: 'removeDownload',
          label: t('action.removeDownload'),
          icon: 'close',
        });
      }
    }
  }
  // Only offer the seed affordance when the seed's own provider
  // declares radio.seed — routing is ref-scoped, so another
  // provider's support is a dead end.
  if (input.radioSeedable) {
    actions.push({
      key: 'radio',
      label: t('stage.radio.start'),
      icon: 'radio',
    });
  }
  if (target.kind === 'metadata') {
    if (target.meta.albumRef != null) {
      actions.push({
        key: 'album',
        label: t('action.openAlbum'),
        icon: 'note',
      });
    }
    if (target.meta.artistRef != null) {
      actions.push({
        key: 'artist',
        label: t('action.openArtist'),
        icon: 'library',
      });
    }
  }
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
  readonly chipFor: (recordingId: string) => DownloadChip | null;
}): DownloadChip | null {
  const id = input.recordingId;
  return id !== null &&
    (input.recordFor(id) !== null || input.downloadRefFor(id) !== null)
    ? (input.chipFor(id) ?? 'idle')
    : null;
}

/** The pane an open stage lands on: an idle stage whose queue ended
    reopens on the queue so its rows stay replayable — the same
    surface the idle-transition effect picks while it's open; anything
    else lands on the player. A collapsed stage normalizes to this
    pane ahead of the open so a morph's first frame already renders
    it — the expand commit's pick arrives after the rise. */
export function stageReopenMode(input: {
  readonly playbackIdle: boolean;
  readonly queueEnded: boolean;
}): StageMode {
  return input.playbackIdle && input.queueEnded ? 'queue' : 'player';
}

/** Report the failed-download's stored error before retrying — the
    row kept why it failed, so the tap is never a silent ↓→⚠→↓ loop. */
export function reportStoredDownloadError(
  error: { readonly kind: string; readonly message: string } | null,
): void {
  if (error !== null) {
    reportResult(
      'action.download',
      err(appError(appErrorKind(error.kind), error.message)),
    );
  }
}

/**
 * Suggestion-card lookup. A provider page may repeat a source
 * reference under different titles — which copy a card press resolves
 * is platform behavior: mobile's activateHomeCard scanned the page in
 * order (first match wins), desktop's Map.set overwrote (last wins).
 */
export function suggestionMetaMap(
  items: readonly TrackMetadata[],
  collisionOrder: 'firstWins' | 'lastWins',
): Map<string, TrackMetadata> {
  const map = new Map<string, TrackMetadata>();
  for (const meta of items) {
    const key = `${meta.sourceRef.provider}:${meta.sourceRef.id}`;
    if (collisionOrder === 'firstWins' && map.has(key)) {
      continue;
    }
    map.set(key, meta);
  }
  return map;
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
  const requests = input.entries.flatMap((entry) => {
    const sourceRef = input.isOwned(entry.recordingId)
      ? null
      : input.downloadRefFor(entry.recordingId);
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
