/**
 * `useAppShell` — the shared shell composition both apps used to
 * build inline. One hook call returns the whole state/callback
 * surface: navigation + overlay stack, toast bus, locale apply,
 * serialized settings writes, sheet epochs, downloads ledger/usage,
 * offline playability gates, search flow, entity fetches, all
 * view-model derivations, the play/report funnel, queue/playlist/
 * lyrics/radio ops, row-action + playlist-picker sheets, and the
 * transfer state machine.
 *
 * Every genuine platform divergence is a documented `ports` flag —
 * see types.ts. The hook never probes a platform API itself; the
 * apps wire `subscribeOnline`, `localPlayable`, `exportJson`, the
 * peaks port, the post-mutation local-source sync, and the sync-row
 * destination.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  CancellationSource,
  ProviderRouter,
  SearchSession,
  appError,
  appErrorKind,
  createClock,
  createIds,
  effectiveMapping,
  err,
  isMatchGate,
  isRefRejected,
  previewImport,
  queuedOccurrenceFor,
  queuedOccurrenceForRef,
  selectionFromSettings,
} from '@auqw/application';
import type {
  AppError,
  AttemptTrace,
  EntityRef,
  ImportPreview,
  OperationContext,
  Result,
  SearchState,
  Settings,
  SourceRef,
  TrackMetadata,
} from '@auqw/application';
import {
  DIAGNOSTICS_LIMIT,
  IDLE_TRANSFER,
  SEARCH_LIMIT,
  THEME_ORDER,
  attemptLabel,
  downloadChipsByRecording,
  downloadLedgerCount,
  entityRefKey,
  errorText,
  formatBytes,
  greeting,
  providerPickerModel,
  reportResult,
  resolveLocale,
  setLocale,
  setToastSink,
  systemLocaleTag,
  t,
  toCorrectionsModel,
  toEntityModel,
  toHomeModel,
  toImportPreviewModel,
  toLibraryModel,
  toLyricsModel,
  toPlayerModel,
  toPlaylistModel,
  toQueueModel,
  toRadioModel,
  toSearchModel,
  toSearchRowModel,
  toSettingsModel,
  toTrackRowModel,
  useOverlayStack,
  useSerializedWrite,
  useSmoothedPosition,
  useWaveformPeaks,
} from '@auqw/ui-shared';
import type {
  ActionTarget,
  CollectionRowModel,
  CorrectionsFilter,
  DiagnosticsModel,
  DownloadChip,
  EntityFetch,
  LyricsFetch,
  LyricsModel,
  MessageId,
  PeaksTarget,
  PlayerModel,
  ProviderSlot,
  ReviewFetch,
  StageMode,
  TrackRowModel,
  TransferModel,
} from '@auqw/ui-shared';
import {
  advanceTargetId,
  playlistDownloadPlan,
  reportStoredDownloadError,
  rowActionsModel,
  stageDownloadChip,
} from './types.ts';
import type {
  AppShellDeps,
  ExportWrite,
  ShellOverlay,
} from './types.ts';

const SHELL_OVERLAY_TYPES: ReadonlySet<string> = new Set([
  'collection',
  'playlist',
  'entity',
  'corrections',
  'transfer',
]);

/** Narrows an app-extended overlay to the factory's own routes — a
    platform extra (mobile's `{ type: 'sync' }`) is never a shell
    route, so `type` membership is the whole check. */
function shellOverlayOf<E extends { readonly type: string }>(
  overlay: ShellOverlay | E | null | undefined,
): ShellOverlay | null {
  return overlay != null && SHELL_OVERLAY_TYPES.has(overlay.type)
    ? (overlay as ShellOverlay)
    : null;
}

export function useAppShell<E extends { readonly type: string } = never>(
  deps: AppShellDeps<E>,
) {
  const { controller, state, ports } = deps;
  const { session } = controller;

  // ---- position channel ------------------------------------------
  // Position ticks ride the session's light channel — status ticks
  // that only move position skip the state publish, so the position
  // read subscribes here instead of through `state`.
  const subscribePosition = useCallback(
    (listener: () => void) => session.subscribePosition(listener),
    [session],
  );
  const positionMs = useSyncExternalStore(subscribePosition, () =>
    session.positionMs(),
  );

  // ---- shell chrome state ----------------------------------------
  const [tab, setTab] = useState('home');
  // `stageOpen` is the desktop Stage column collapse flag AND the
  // mobile sheet's expanded flag — ports.stageInitiallyOpen picks
  // the mount-time pose per platform.
  const [stageOpen, setStageOpen] = useState(
    ports.stageInitiallyOpen === true,
  );
  const [stageMode, setStageMode] = useState<StageMode>('player');
  const [reordering, setReordering] = useState(false);
  const [query, setQuery] = useState('');
  // Bumped when '/' routes to explore — remounts SearchScreen so its
  // autoFocus refocuses the box even when the tab was already active.
  const [searchFocusTick, setSearchFocusTick] = useState(0);
  // Recent searches: session-scoped, newest first — persisting them
  // would be a storage-schema decision, so they die with the app.
  const [searchRecents, setSearchRecents] = useState<readonly string[]>(
    [],
  );
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [artworkCachePickerOpen, setArtworkCachePickerOpen] =
    useState(false);
  const [storefrontSheetOpen, setStorefrontSheetOpen] = useState(false);
  const [qualityPickerOpen, setQualityPickerOpen] = useState(false);
  const [storefrontDraft, setStorefrontDraft] = useState('');
  // Sheet openings are epoch-tagged — a save that resolves after the
  // user dismissed and reopened the sheet must not close the new one.
  const storefrontEpoch = useRef(0);
  const qualityEpoch = useRef(0);
  // Theme and language also bump on dismiss and on each pick, so a
  // late save from an earlier pick can neither close the sheet nor
  // apply a stale locale over a newer pick.
  const themeEpoch = useRef(0);
  const languageEpoch = useRef(0);

  // ---- locale -----------------------------------------------------
  // setLocale mutates module state and never notifies React — every
  // apply bumps localeTick so the localized model memos below rebuild
  // their t() strings in the new language (they carry it as a dep).
  const [localeTick, setLocaleTick] = useState(0);
  const applyLocale = useCallback(
    (setting: string | null | undefined) => {
      setLocale(resolveLocale(setting, systemLocaleTag()));
      setLocaleTick((tick) => tick + 1);
    },
    [],
  );
  // Every settings write serializes through the shared chain —
  // updateSettings persists a complete snapshot, so each patch merges
  // onto the session's latest committed settings at execution time
  // (snapshot(), not React state, is the merge base; the live
  // settings are the fallback while it isn't ready).
  const queueSettingsWrite = useSerializedWrite(
    (next: Settings) => session.updateSettings(next),
    () => {
      const snap = session.snapshot();
      return snap.type === 'ready' ? snap.settings : null;
    },
    state.settings,
  );
  // A persisted language (or 'system' resolution) applies once the
  // ready settings arrive — never during render. The ready UI stays
  // gated until that apply has landed: an ungated effect commits one
  // ready frame in the system language and only flips afterwards.
  const [localeApplied, setLocaleApplied] = useState(false);
  useEffect(() => {
    applyLocale(state.settings.language);
    setLocaleApplied(true);
  }, [applyLocale, state.settings.language]);

  // ---- diagnostics + overlay stack --------------------------------
  const [attempts, setAttempts] = useState<readonly AttemptTrace[]>([]);
  const resultMeta = useRef(new Map<string, TrackMetadata>());
  // Library-world overlay stack: pushed routes — collection list,
  // playlist editor, provider entity page — rendered as push screens
  // above the nav shell. Entity pages keep a fetch per ref so popping
  // back to a deeper screen restores its loaded content.
  const {
    stack: overlayStack,
    top: overlay,
    push: pushOverlay,
    reset: resetOverlay,
    close: closeOverlay,
    dismiss: dismissOverlay,
    clear: clearOverlayStack,
  } = useOverlayStack<ShellOverlay | E>();
  const [entityFetches, setEntityFetches] = useState<
    Readonly<Record<string, EntityFetch>>
  >({});
  const clearOverlays = useCallback(() => {
    clearOverlayStack();
    setEntityFetches({});
  }, [clearOverlayStack]);
  const entityMeta = useRef(new Map<string, TrackMetadata>());
  const [actionsFor, setActionsFor] = useState<ActionTarget | null>(
    null,
  );
  const [pickerFor, setPickerFor] = useState<ActionTarget | null>(null);
  const [providerSlot, setProviderSlot] = useState<ProviderSlot | null>(
    null,
  );

  // ---- connectivity -----------------------------------------------
  // null = connectivity unknown (no baseline yet) — the offline
  // banner renders only on an explicit false. The subscribe seam is
  // the app's: desktop forwards its webContents subscription, mobile
  // wraps its connectivity port (subscribe-then-snapshot, edge guard).
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(
    () => ports.subscribeOnline(setOnline),
    [ports.subscribeOnline],
  );

  // ---- toast bus ---------------------------------------------------
  // Transient failure pill: reportResult routes its text here through
  // the module-level sink (installed on mount), and it self-clears.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    setToastSink(setToast);
    return () => {
      setToastSink(null);
    };
  }, []);
  useEffect(() => {
    if (toast === null) {
      return undefined;
    }
    const timer = setTimeout(() => setToast(null), 4_000);
    return () => clearTimeout(timer);
  }, [toast]);

  // ---- downloads ledger + usage probes -----------------------------
  // Live download ledger — subscribed once; chips + the downloads
  // collection + the stage action all read it.
  const [downloads, setDownloads] = useState(
    () => controller.downloads.list(),
  );
  // Progress events stream per chunk — trailing-throttle the
  // list() pull to ~1Hz so a large queue doesn't re-list on every
  // chunk tick.
  const downloadsLast = useRef(0);
  const downloadsTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const refreshDownloads = useCallback(() => {
    const now = Date.now();
    const gap = now - downloadsLast.current;
    if (gap < 1_000) {
      if (downloadsTimer.current === null) {
        downloadsTimer.current = setTimeout(() => {
          downloadsTimer.current = null;
          refreshDownloads();
        }, 1_000 - gap);
      }
      return;
    }
    downloadsLast.current = now;
    setDownloads(controller.downloads.list());
  }, [controller]);
  // Bumped after a local-folder mutation so the models re-read
  // `local()` — the source is storage-backed, not evented, and scans
  // here are user-initiated only.
  const [localTick, setLocalTick] = useState(0);

  // Raw usage — formatted per render so the storage line follows the
  // UI language instead of freezing the phrasing at probe time.
  const [storageUsage, setStorageUsage] = useState<{
    readonly bytes: number;
    readonly free: number;
  } | null>(null);
  const storageText =
    storageUsage === null
      ? null
      : formatBytes(storageUsage.bytes, storageUsage.free);
  // Transfer events can outpace the statfs probe — each read stamps a
  // sequence, and only a success newer than the last applied success
  // lands. A failed probe advances nothing, so it can't knock out an
  // older success still in flight.
  const usageSeq = useRef(0);
  const usageApplied = useRef(0);
  const usageLastProbe = useRef(0);
  const usageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshUsage = useCallback(() => {
    // The subscribe path fires per progress chunk — a statfs probe on
    // each one is hundreds of scans per download. Throttle to ~1 Hz
    // with a trailing call so the settled value still lands.
    const now = Date.now();
    const gap = now - usageLastProbe.current;
    if (gap < 1_000) {
      if (usageTimer.current === null) {
        usageTimer.current = setTimeout(() => {
          usageTimer.current = null;
          refreshUsage();
        }, 1_000 - gap);
      }
      return;
    }
    usageLastProbe.current = now;
    usageSeq.current += 1;
    const seq = usageSeq.current;
    void controller.downloads
      .usage(new CancellationSource().signal)
      .then((u) => {
        if (u.ok && seq > usageApplied.current) {
          usageApplied.current = seq;
          setStorageUsage({ bytes: u.value.bytes, free: u.value.free });
        }
      });
  }, [controller]);
  useEffect(() => {
    setDownloads(controller.downloads.list());
    refreshUsage();
    const unsubscribe = controller.downloads.subscribe(() => {
      refreshDownloads();
      refreshUsage();
    });
    return () => {
      unsubscribe();
      if (usageTimer.current !== null) {
        clearTimeout(usageTimer.current);
        usageTimer.current = null;
      }
      if (downloadsTimer.current !== null) {
        clearTimeout(downloadsTimer.current);
        downloadsTimer.current = null;
      }
    };
  }, [controller, refreshUsage, refreshDownloads]);

  const refreshLocal = useCallback(() => {
    setLocalTick((t) => t + 1);
  }, []);

  // ---- playability gates -------------------------------------------
  // Bytes on disk — a stored download or a scanned local file.
  // Ownership is NOT the local-playback probe: the probe answers
  // whether the player can attach the bytes, while ownership answers
  // whether 'download missing' may skip the row — asking the first
  // question with the second probe would re-request stored tracks
  // and delete their files on a changed mapping.
  const isOwned = useCallback(
    (recordingId: string): boolean =>
      controller.downloads.fileFor(recordingId) !== null ||
      (controller.local()?.uriMap().has(recordingId) ?? false),
    [controller],
  );
  // The capability probe is the platform's: desktop asks the
  // controller's (gated) localPlaybackFor — always null until the
  // web player gains a `provider:'local'` route; mobile's owned-bytes
  // check IS its attachable set, so it defaults to isOwned.
  const localPlayable = useCallback(
    (recordingId: string): boolean =>
      ports.localPlayable !== undefined
        ? ports.localPlayable(recordingId)
        : isOwned(recordingId),
    [ports.localPlayable, isOwned],
  );
  // Offline honesty for remote paths: with connectivity explicitly
  // down nothing streams — every row's play affordance waits instead
  // of firing a remote attempt. Attachable owned bytes are the
  // exception.
  const canPlay = useCallback(
    (recordingId: string): boolean =>
      online !== false || localPlayable(recordingId),
    [online, localPlayable],
  );

  // ---- download chips + affordance ---------------------------------
  // One chip map for every row surface — off `list()` so a
  // mid-delete 'removing' row reads busy, not failed-or-hidden.
  const chipsByRecording = useMemo(
    () => downloadChipsByRecording(downloads),
    [downloads],
  );
  const downloadChipFor = useCallback(
    (recordingId: string): DownloadChip | null =>
      chipsByRecording.get(recordingId) ?? null,
    [chipsByRecording],
  );

  // A download needs a playable provider ref — recordings carrying
  // only a `local` ref are already owned bytes; the action hides.
  // ports.downloadsEnabled gates the create-side affordances (iOS:
  // the provisional player has no local-attach path, so stored bytes
  // could never play — removal still surfaces through recordFor).
  const downloadRefFor = useCallback(
    (recordingId: string): SourceRef | null => {
      if (ports.downloadsEnabled === false) {
        return null;
      }
      const recording = state.recordings.find(
        (r) => r.id === recordingId,
      );
      if (recording === undefined) {
        return null;
      }
      // Mirrors Session.#pickRef's provider path — a download is
      // resolved by the active playback provider, so only a mapping
      // verdict or a non-rejected ref it owns can produce a stream.
      // Other providers' refs would fail resolvePlayback: hide them.
      const provider = state.settings.playbackProvider;
      const mapped = effectiveMapping(recording, provider);
      if (mapped !== null) {
        return mapped.ref;
      }
      return (
        recording.sourceRefs.find(
          (r) =>
            r.provider === provider &&
            r.kind === 'track' &&
            !isRefRejected(recording.mappings, r),
        ) ?? null
      );
    },
    [
      state.recordings,
      state.settings.playbackProvider,
      ports.downloadsEnabled,
    ],
  );

  // Single download affordance: absent → request; queued/downloading
  // → cancel; failed → retry; stored → remove.
  const onDownloadAction = useCallback(
    (recordingId: string) => {
      const signal = new CancellationSource().signal;
      const existing = controller.downloads.recordFor(recordingId);
      if (existing === null) {
        const sourceRef = downloadRefFor(recordingId);
        if (sourceRef === null) {
          return;
        }
        void controller.downloads
          .request({ recordingId, sourceRef }, signal)
          .then((r) => reportResult('action.download', r));
        return;
      }
      switch (existing.state) {
        case 'requested':
        case 'transferring':
          void controller.downloads
            .cancel(existing.downloadId, signal)
            .then((r) => reportResult('action.cancelDownload', r));
          return;
        case 'failed_with_retry':
          // The row kept why it failed — toast that kind before the
          // retry so the tap is never a silent ↓→⚠→↓ loop.
          reportStoredDownloadError(existing.error);
          void controller.downloads
            .retry(existing.downloadId)
            .then((r) => reportResult('action.retryDownload', r));
          return;
        case 'available':
          // The 'removing' transition fires before the file is gone —
          // refresh usage again once removal settles so Settings
          // doesn't display the freed bytes until the next event.
          void controller.downloads
            .remove(existing.downloadId, signal)
            .then((r) => {
              reportResult('action.removeDownload', r);
              refreshUsage();
            });
          return;
        default:
          return;
      }
    },
    [controller, downloadRefFor, refreshUsage],
  );

  // ---- lyrics / reviews / transfer bookkeeping ---------------------
  // Lyrics are a live read off the Stage's lyrics mode, not session
  // state — the fetch is keyed to the playing recording and canceled
  // when superseded.
  const [lyricsFetch, setLyricsFetch] = useState<LyricsFetch | null>(
    null,
  );
  const lyricsSource = useRef<CancellationSource | null>(null);
  // Corrections are live reads too (session.listMatchReviews); the
  // queue reloads after every op so a verdict renders immediately.
  const [reviewFetch, setReviewFetch] = useState<ReviewFetch>({
    reviews: null,
    error: null,
  });
  const [reviewFilter, setReviewFilter] =
    useState<CorrectionsFilter>('pending');
  // Export/import state lives in the transfer overlay; the picked
  // file's text is stashed between preview and confirm.
  const [transfer, setTransfer] = useState<TransferModel>(IDLE_TRANSFER);
  const importText = useRef<string | null>(null);
  // The staged import preview is a localized snapshot — its row
  // labels freeze at file-choice time. The raw document is kept
  // beside it so the model can be rebuilt in the current language
  // whenever the locale changes (localeTick effect below).
  const importPreviewRaw = useRef<{
    preview: ImportPreview;
    sourceLabel: string;
  } | null>(null);
  // The applied-import summary and the saved-export notice are also
  // localized strings frozen into transfer state — keep their raw
  // pieces beside the preview so the localeTick effect can re-derive
  // them. Only read while the matching phase is 'done'; error details
  // carry typed messages, which are not localized. The export detail
  // is a CLOSURE the platform's exportJson returns — re-running it
  // re-derives the label (desktop's download-name template).
  const importSummaryCounts = useRef<{
    tracks: number;
    likes: number;
    playlists: number;
  } | null>(null);
  const exportDoneDetail = useRef<(() => string) | null>(null);
  useEffect(() => {
    const raw = importPreviewRaw.current;
    const counts = importSummaryCounts.current;
    const exportDetail = exportDoneDetail.current;
    if (raw === null && counts === null && exportDetail === null) {
      return;
    }
    setTransfer((prev) => ({
      ...prev,
      exportDetail:
        prev.exportPhase === 'done' && exportDetail !== null
          ? exportDetail()
          : prev.exportDetail,
      importDetail:
        prev.importPhase === 'done' && counts !== null
          ? t('transfer.importSummary', {
              tracks: counts.tracks,
              likes: counts.likes,
              playlists: counts.playlists,
            })
          : prev.importDetail,
      preview:
        raw === null
          ? prev.preview
          : toImportPreviewModel(raw.preview, raw.sourceLabel),
    }));
  }, [localeTick]);

  const loadReviews = useCallback(() => {
    setReviewFetch({ reviews: null, error: null });
    void session.listMatchReviews({ status: 'all' }).then((result) => {
      setReviewFetch(
        result.ok
          ? { reviews: result.value, error: null }
          : { reviews: null, error: result.error },
      );
    });
  }, [session]);

  // ---- search ------------------------------------------------------
  const catalogProvider =
    controller.providers.find(
      (p) => p.id === state.settings.catalogProvider,
    ) ?? controller.providers[0];

  const search = useMemo(
    () =>
      catalogProvider === undefined
        ? null
        : new SearchSession(catalogProvider, createClock(), createIds()),
    [catalogProvider],
  );
  const [searchState, setSearchState] = useState<SearchState>(() =>
    search === null
      ? { type: 'idle', revision: 0 }
      : search.snapshot(),
  );
  useEffect(() => {
    if (search === null) {
      setSearchState({ type: 'idle', revision: 0 });
      return undefined;
    }
    setSearchState(search.snapshot());
    return search.subscribe(setSearchState);
  }, [search]);

  // Suggestions are capability-routed, not catalog-routed: any loaded
  // provider declaring `catalog.suggest` serves the draft pane, so the
  // typing experience is identical whatever catalog provider is set.
  const providerRouter = useMemo(
    () => new ProviderRouter(controller.providers),
    [controller.providers],
  );
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const suggestSource = useRef<CancellationSource | null>(null);
  const suggestSeq = useRef(0);

  const runSearch = useCallback(
    (q: string) => {
      // A committed search replaces the draft surface with results —
      // the platform gets the first move (mobile dismisses the IME;
      // it would just cover the list otherwise).
      ports.onSearchCommit?.();
      const trimmed = q.trim();
      // A committed search supersedes the suggest stream — the draft
      // pane closes and in-flight completions are dropped.
      suggestSource.current?.cancel();
      suggestSource.current = null;
      suggestSeq.current += 1;
      setSuggestions([]);
      if (trimmed === '') {
        search?.cancel();
        return;
      }
      void search?.search({
        query: trimmed,
        limit: SEARCH_LIMIT,
        storefront: state.settings.storefront,
      });
    },
    [search, state.settings.storefront, ports.onSearchCommit],
  );

  const recordRecentSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (trimmed === '') {
      return;
    }
    setSearchRecents((prev) =>
      [trimmed, ...prev.filter((r) => r !== trimmed)].slice(0, 8),
    );
  }, []);

  const cancelSearch = useCallback(() => {
    setQuery('');
    search?.cancel();
  }, [search]);

  const submitSearch = useCallback(() => {
    recordRecentSearch(query);
    runSearch(query);
  }, [query, recordRecentSearch, runSearch]);

  const applySearchText = useCallback(
    (text: string) => {
      setQuery(text);
      recordRecentSearch(text);
      runSearch(text);
    },
    [recordRecentSearch, runSearch],
  );

  // `state` republishes a fresh `settings` object on every tick, and
  // `searchState` swaps identity on every revision — both would
  // re-fire this effect (and cancel the debounce) without an actual
  // change underneath. Depend on the derived values instead: the
  // provider selection is stable across publishes, and the committed
  // query is the only searchState field the gate reads.
  const suggestSelection = useMemo(
    () => selectionFromSettings(state.settings),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.settings.catalogProvider,
      state.settings.playbackProvider,
      state.settings.lyricsProvider,
      state.settings.radioProvider,
    ],
  );
  const committedQuery =
    searchState.type === 'idle' ? '' : searchState.query;
  const retrySearch = useCallback(() => {
    runSearch(committedQuery);
  }, [runSearch, committedQuery]);
  // Keystrokes debounce into `catalog.suggest` completions routed over
  // declaring providers — the typing surface is suggestions, not live
  // result pages, so the debounce runs tighter than a catalog search
  // ever could. Only a commit (Enter or a row tap) runs catalog.search.
  useEffect(() => {
    const trimmed = query.trim();
    // An edit invalidates the prior burst at once — a completion that
    // lands mid-debounce belongs to old text and must never paint.
    suggestSource.current?.cancel();
    suggestSource.current = null;
    suggestSeq.current += 1;
    if (trimmed === '') {
      setSuggestions([]);
      search?.cancel();
      return undefined;
    }
    // Committed text is no draft, and inputs past the payload cap
    // (256) can't be served — neither earns a fetch.
    if (trimmed === committedQuery || [...trimmed].length > 256) {
      setSuggestions([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      const source = new CancellationSource();
      suggestSource.current = source;
      const seq = suggestSeq.current;
      const context: OperationContext = {
        requestId: createIds().next('suggest'),
        deadlineMs: Date.now() + 10_000,
        signal: source.signal,
      };
      void providerRouter
        .suggest(suggestSelection, { input: trimmed }, context)
        .then((result) => {
          if (suggestSeq.current === seq && !source.signal.cancelled) {
            setSuggestions(result.ok ? result.value : []);
          }
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [query, committedQuery, search, providerRouter, suggestSelection]);

  // Keep the row→metadata map in sync so a tap can recover the
  // TrackMetadata the session needs for addAndPlay.
  useEffect(() => {
    const map = resultMeta.current;
    map.clear();
    if (searchState.type === 'content') {
      searchState.page.items.forEach((meta, index) => {
        map.set(toSearchRowModel(meta, index).key, meta);
      });
      // Visible rows are the ones the user can tap — hand the refs to
      // the session's advisory warm; prefetch/connectivity gates own
      // the honesty policy inside the session.
      session.prewarm({
        sourceRefs: searchState.page.items
          .slice(0, 9)
          .map((meta) => meta.sourceRef),
        tracks: searchState.page.items.slice(0, 9),
      });
    }
  }, [searchState, session]);

  const [pendingReviews, setPendingReviews] = useState<number | null>(
    null,
  );

  // Diagnostics: attempt traces are persisted by the session; load a
  // page whenever the settings tab becomes active. The pending-review
  // count is a live read on the same visit.
  useEffect(() => {
    if (tab !== 'settings') {
      return;
    }
    const source = new CancellationSource();
    const context: OperationContext = {
      requestId: createIds().next('diag'),
      deadlineMs: Date.now() + 15_000,
      signal: source.signal,
    };
    void controller.storage.loadAttempts(DIAGNOSTICS_LIMIT, context).then(
      (result) => {
        if (!source.signal.cancelled && result.ok) {
          setAttempts(result.value);
        }
      },
    );
    void session.listMatchReviews().then((result) => {
      if (!source.signal.cancelled) {
        setPendingReviews(result.ok ? result.value.length : null);
      }
    });
    return () => source.cancel();
  }, [tab, controller, session]);

  // ---- models ------------------------------------------------------
  // Published snapshots keep stable refs for unchanged sections, so
  // model memos key on the slices they read — a queue-only publish
  // no longer rebuilds the library model, and position-only ticks
  // (which skip the state channel entirely) flow through positionMs.
  const player = useMemo(() => {
    const model = toPlayerModel({
      playback: state.playback,
      queue: state.queue,
      recordings: state.recordings,
      likes: state.likes,
      repeat: state.repeat,
      shuffleOrder: state.shuffleOrder,
    });
    // The model's position is a publish-time read — overlay the live
    // tick value so the transport position moves between publishes.
    if (
      model !== null &&
      (model.status === 'buffering' ||
        model.status === 'playing' ||
        model.status === 'paused') &&
      model.positionMs !== positionMs
    ) {
      return { ...model, positionMs };
    }
    return model;
  }, [
    state.playback,
    state.queue,
    state.recordings,
    state.likes,
    state.repeat,
    state.shuffleOrder,
    positionMs,
    localeTick,
  ]);

  // Queue end drops `player` to null (playback → idle) — ripping the
  // mount out from under an expanded sheet would vanish it mid-view.
  // While expanded the mount is held on the last model until the user
  // collapses; release then waits out the settle spring so the slide
  // lands before unmount, and the morph re-seed happens at rest so a
  // fresh player starts collapsed, not mid-morph. The snapshot sits
  // in a ref — mirroring the live model into state would double the
  // per-tick render. ports.holdEndedPlayer gates the whole mount —
  // desktop's stage column simply unmounts.
  const lastPlayerRef = useRef<PlayerModel | null>(null);
  const [endHold, setEndHold] = useState(false);
  const resetStageMorph = ports.resetStageMorph;
  const holdEndedPlayer = ports.holdEndedPlayer === true;
  useEffect(() => {
    if (!holdEndedPlayer) {
      return;
    }
    if (player !== null) {
      lastPlayerRef.current = player;
      setEndHold(false);
      return;
    }
    if (stageOpen && lastPlayerRef.current !== null) {
      setEndHold(true);
      return;
    }
    const release = setTimeout(() => {
      resetStageMorph?.();
      lastPlayerRef.current = null;
      setEndHold(false);
    }, STAGE_RELEASE_MS);
    return () => clearTimeout(release);
  }, [player, stageOpen, holdEndedPlayer, resetStageMorph]);
  // A held mount renders the ended pose — paused at the last
  // published position — not a frozen 'playing' snapshot. `stageOpen`
  // covers the transition render itself (endHold lands an effect
  // later); `endHold` then carries the mount through the collapse
  // slide's settle window.
  const stagePlayer =
    player ??
    (holdEndedPlayer &&
    (stageOpen || endHold) &&
    lastPlayerRef.current !== null
      ? {
          ...lastPlayerRef.current,
          status: 'paused' as const,
          intentPlaying: false,
        }
      : null);
  // Held pose (queue ended): live transport ops have no current
  // occurrence — play/seek taps replay the held track instead.
  const heldOccurrenceId =
    player === null ? (stagePlayer?.occurrenceId ?? null) : null;

  // playback.type names only the latest failure — the app carries
  // the set so a row the cursor moved past keeps its 'error' mark;
  // a fresh attempt for the occurrence clears it, removals prune.
  const failedQueueIds = useRef(new Set<string>());
  const queueModel = useMemo(() => {
    const playback = state.playback;
    if (playback.type === 'failed') {
      if (playback.occurrenceId !== null) {
        failedQueueIds.current.add(playback.occurrenceId);
      }
    } else if (playback.type !== 'idle') {
      failedQueueIds.current.delete(playback.occurrenceId);
    }
    const live = new Set(
      state.queue.occurrences.map((o) => o.occurrenceId),
    );
    for (const id of failedQueueIds.current) {
      if (!live.has(id)) {
        failedQueueIds.current.delete(id);
      }
    }
    // Same honesty rule as the library rows: offline + unattachable
    // marks 'unavailable' so a dead press isn't a surprise.
    const unavailable =
      online === false
        ? new Set(
            state.queue.occurrences
              .map((o) => o.recordingId)
              .filter((id) => !localPlayable(id)),
          )
        : undefined;
    return toQueueModel({
      queue: state.queue,
      recordings: state.recordings,
      likes: state.likes,
      unavailableRecordingIds: unavailable,
      failedOccurrenceIds:
        failedQueueIds.current.size === 0
          ? undefined
          : failedQueueIds.current,
      dealtOrder: state.shuffleOrder ?? undefined,
    });
    // localPlayable re-reads downloads/local after their mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.queue,
    state.recordings,
    state.likes,
    state.playback,
    state.shuffleOrder,
    online,
    localPlayable,
    downloads,
    localTick,
    localeTick,
  ]);

  const libraryModel = useMemo(() => {
    // ports.localCatalog: local index rows (provenance 'local') are
    // authoritative over the session's in-memory copies — a scan
    // commits fresher tags than restore loaded. Session stays
    // authoritative for every other row. Off flag (desktop) the
    // session's rows are read alone.
    const local = controller.local();
    const recordings = (() => {
      if (ports.localCatalog !== true || local === null) {
        return state.recordings;
      }
      const byId = new Map(state.recordings.map((r) => [r.id, r]));
      for (const r of local.recordings()) {
        if (r.provenance === 'local') {
          byId.set(r.id, r);
        }
      }
      return [...byId.values()];
    })();
    const model = toLibraryModel({
      recordings,
      likes: state.likes,
      playlists: state.playlists,
      playlistEntries: state.playlistEntries,
      playHistory: state.playHistory,
      playCounts: state.playCounts,
      entities: state.entities,
      entitySourceRefs: state.entitySourceRefs,
      downloads,
    });
    const playingId =
      state.playback.type === 'idle' ||
      state.playback.type === 'paused' ||
      state.playback.type === 'failed'
        ? null
        : state.playback.recordingId;
    const chipByRecording = chipsByRecording;
    // Honest-offline: with connectivity explicitly down, a row plays
    // only from bytes the player can attach — remote streams degrade
    // to 'unavailable' instead of spinning.
    const offline = online === false;
    const decorate = (
      row: TrackRowModel,
      recordingId: string,
    ): TrackRowModel => {
      const base: TrackRowModel = {
        ...row,
        download: chipByRecording.get(recordingId) ?? row.download,
        playing: recordingId === playingId ? true : row.playing,
      };
      return offline && !localPlayable(recordingId)
        ? { ...base, state: 'unavailable', note: t('note.offline') }
        : base;
    };
    const mark = (
      row: CollectionRowModel,
    ): CollectionRowModel => ({
      ...row,
      row: decorate(row.row, row.recordingId),
    });
    return {
      ...model,
      items: model.items.map((row) => decorate(row, row.key)),
      recentlyAdded: model.recentlyAdded.map((row) =>
        decorate(row, row.key),
      ),
      collectionRows: {
        liked: model.collectionRows.liked.map(mark),
        top50: model.collectionRows.top50.map(mark),
        history: model.collectionRows.history.map(mark),
        downloads: model.collectionRows.downloads.map(mark),
      },
    };
    // localTick re-reads local() after a folder mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.recordings,
    state.likes,
    state.playlists,
    state.playlistEntries,
    state.playHistory,
    state.playCounts,
    state.entities,
    state.entitySourceRefs,
    state.playback,
    online,
    downloads,
    chipsByRecording,
    controller,
    localPlayable,
    ports.localCatalog,
    localTick,
    localeTick,
  ]);

  const playlistModelFor = useCallback(
    (playlistId: string) => {
      const model = toPlaylistModel({
        playlistId,
        playlists: state.playlists,
        playlistEntries: state.playlistEntries,
        recordings: state.recordings,
        likes: state.likes,
      });
      const playingId =
        state.playback.type === 'idle' ||
        state.playback.type === 'paused' ||
        state.playback.type === 'failed'
          ? null
          : state.playback.recordingId;
      if (model === null) {
        return model;
      }
      const offline = online === false;
      return {
        ...model,
        entries: model.entries.map((entry) => {
          const chip =
            downloadChipFor(entry.recordingId) ?? entry.row.download;
          const owned =
            chip === 'stored' || localPlayable(entry.recordingId);
          const offlineRow =
            offline && !owned
              ? { state: 'unavailable' as const, note: t('note.offline') }
              : {};
          return {
            ...entry,
            row: {
              ...entry.row,
              playing:
                entry.recordingId === playingId
                  ? true
                  : entry.row.playing,
              download: chip,
              ...offlineRow,
            },
          };
        }),
      };
      // localTick re-reads local.uriMap after a folder mutation.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [
      state.playlists,
      state.playlistEntries,
      state.recordings,
      state.likes,
      state.playback,
      downloads,
      downloadChipFor,
      online,
      localPlayable,
      localTick,
      localeTick,
    ],
  );

  // The ref the player actually resolved for the live attempt —
  // published on the playback snapshot, so a pin, a verdict, or
  // owned bytes each mark exactly the row they resolved to (local
  // picks match no catalog row). A failed gate is not 'playing'.
  // ports.markPlayingRef gates the whole mark — desktop's surfaces
  // don't paint it.
  const playingRef = useMemo((): SourceRef | null => {
    if (ports.markPlayingRef !== true) {
      return null;
    }
    const playback = state.playback;
    // Only an engaged attempt marks — paused keeps its loaded ref but
    // is not 'playing' (the queue surface drops its mark on the same
    // moment); a failed gate never marked at all.
    if (
      playback.type === 'idle' ||
      playback.type === 'paused' ||
      playback.type === 'failed'
    ) {
      return null;
    }
    return playback.ref ?? null;
  }, [state.playback, ports.markPlayingRef]);

  const entityModelFor = useCallback(
    (fetch: EntityFetch | null) =>
      toEntityModel({
        page: fetch?.page ?? null,
        error: fetch?.error ?? null,
        likes: state.likes,
        entitySourceRefs: state.entitySourceRefs,
        loadingMore: fetch?.loadingMore ?? false,
        playingRef,
      }),
    [state.likes, state.entitySourceRefs, playingRef, localeTick],
  );
  // Row-key → TrackMetadata map for entity items, same contract as
  // resultMeta for search results — namespaced per stack entry so two
  // entity screens in the stack never collide.
  useEffect(() => {
    const map = entityMeta.current;
    map.clear();
    for (const entry of overlayStack) {
      const route = shellOverlayOf(entry.overlay);
      if (route?.type !== 'entity') {
        continue;
      }
      const fetch = entityFetches[entityRefKey(route.ref)];
      fetch?.page?.items.forEach((meta, index) => {
        map.set(`${entry.key}:${toSearchRowModel(meta, index).key}`, meta);
      });
    }
  }, [overlayStack, entityFetches]);

  const pickerItems = useMemo(
    () =>
      libraryModel.cards
        .filter(
          (card): card is typeof card & { playlistId: string } =>
            card.playlistId !== null,
        )
        .map((card) => ({
          playlistId: card.playlistId,
          name: card.title,
          count: card.count ?? 0,
          artworkUrl: card.artworkUrl,
        })),
    [libraryModel],
  );

  // Local recordings join search results application-side (never
  // provider routing): match the submitted query against
  // provenance-local rows. Keys are `local:<recordingId>` so a press
  // routes to the owned-bytes path, not addAndPlay. ports.localCatalog
  // gates the merge — desktop surfaces no local rows in search.
  const localResults = useMemo(() => {
    if (ports.localCatalog !== true) {
      return [];
    }
    const query = searchState.type === 'idle' ? '' : searchState.query;
    const terms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);
    if (terms.length === 0) {
      return [];
    }
    const liked = new Set(
      state.likes
        .filter((l) => l.entityKind === 'track')
        .map((l) => l.targetId),
    );
    const local = controller.local();
    const localUris = local?.uriMap();
    const rows: TrackRowModel[] = [];
    for (const rec of state.recordings) {
      // Folder removal keeps the recording but drops its file row —
      // the uri index is the owned-bytes truth; orphans never surface.
      if (
        rec.provenance !== 'local' ||
        localUris?.has(rec.id) !== true
      ) {
        continue;
      }
      const haystack =
        `${rec.title} ${rec.artist ?? ''} ${rec.album ?? ''}`.toLowerCase();
      if (terms.every((term) => haystack.includes(term))) {
        rows.push(
          toTrackRowModel(rec, {
            key: `local:${rec.id}`,
            liked: liked.has(rec.id),
            note: t('note.local'),
            playing:
              state.playback.type !== 'idle' &&
              state.playback.type !== 'paused' &&
              state.playback.type !== 'failed' &&
              state.playback.recordingId === rec.id,
          }),
        );
        if (rows.length >= 25) {
          break;
        }
      }
    }
    return rows;
    // localTick re-reads local.uriMap after a folder mutation — a
    // removed folder's recordings persist but must stop matching.
    // state.playback is read for the per-row playing mark.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    searchState,
    state.recordings,
    state.likes,
    state.playback,
    controller,
    ports.localCatalog,
    localTick,
    localeTick,
  ]);

  const searchModel = useMemo(() => {
    const base = toSearchModel(searchState, playingRef);
    if (localResults.length === 0 || base.phase === 'idle') {
      return base;
    }
    const results = [...localResults, ...base.results];
    if (base.phase === 'ready' || base.phase === 'loading') {
      return { ...base, results };
    }
    // Provider empty/error/unavailable but local files matched — the
    // rows still play (owned bytes), so surface them instead of the
    // bare failure.
    return { ...base, phase: 'ready' as const, results };
  }, [searchState, localResults, playingRef, localeTick]);

  const homeModel = useMemo(
    () =>
      toHomeModel({
        recordings: state.recordings,
        likes: state.likes,
        playback: state.playback,
        suggestions:
          searchState.type === 'content' ? searchState.page.items : [],
        greeting: greeting(new Date()),
        subline:
          state.likes.length === 0
            ? t('home.subline.empty')
            : t('home.subline.likes', { count: state.likes.length }),
      }),
    [
      state.recordings,
      state.likes,
      state.playback,
      searchState,
      localeTick,
    ],
  );

  // Suggestion cards key by `${provider}:${id}` — provider refs, not
  // materialized recording ids — so a press needs the TrackMetadata
  // back (same contract as the search-result and entity maps).
  const suggestionMeta = useMemo(() => {
    const map = new Map<string, TrackMetadata>();
    if (searchState.type === 'content') {
      // Divergence: desktop bounded the card-activation lookup to the
      // first 12 results; mobile searched the whole page. Parameterized
      // via ports.homeSuggestionLimit (desktop: 12, mobile: unset).
      const items =
        ports.homeSuggestionLimit === undefined
          ? searchState.page.items
          : searchState.page.items.slice(0, ports.homeSuggestionLimit);
      for (const meta of items) {
        map.set(`${meta.sourceRef.provider}:${meta.sourceRef.id}`, meta);
      }
    }
    return map;
  }, [searchState, ports.homeSuggestionLimit]);

  const diagnostics: DiagnosticsModel = useMemo(
    () => ({
      providerIds: controller.providers.map((p) => p.id),
      attemptCount: attempts.length,
      lastAttemptLabel:
        attempts[0] === undefined ? null : attemptLabel(attempts[0]),
      persistence:
        state.persistenceError === undefined
          ? 'ok'
          : state.persistenceError.kind === 'internal'
            ? 'failed'
            : 'degraded',
      persistenceDetail: state.persistenceError?.message ?? null,
      pendingReviews,
    }),
    [
      state.persistenceError,
      controller,
      attempts,
      pendingReviews,
      localeTick,
    ],
  );

  const settingsModel = useMemo(() => {
    const extras = ports.settingsExtras();
    const model = toSettingsModel(state.settings, diagnostics, {
      storageText,
      // The probe surface only exists once rehydrateMedia ran — gate
      // the rows on it instead of dead-pressing behind a null local().
      // `localSupported` itself is the app's call: desktop probes the
      // live source, mobile asks its tag-reader module.
      localSupported: extras.localSupported,
      localFolderCount: controller.local()?.list().length,
      localSources: controller
        .local()
        ?.list()
        .map((s) => ({ sourceId: s.sourceId, label: s.label })),
      // Kept ledger rows — same rule as the downloads collection:
      // failed-but-kept counts, mid-delete 'removing' doesn't.
      downloadCount: downloadLedgerCount(downloads),
      syncSupported: extras.syncSupported,
      syncLabel: extras.syncLabel,
    });
    // Row omits are the platform's — desktop drops the artwork-cache
    // budget row: the renderer has no application artwork cache
    // (Chromium's image cache owns artwork memory), so it dead-ends.
    const omit = ports.omitSettingsRows;
    return omit === undefined || omit.length === 0
      ? model
      : {
          ...model,
          rows: model.rows.filter((row) => !omit.includes(row.key)),
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.settings,
    diagnostics,
    storageText,
    controller,
    downloads,
    ports.settingsExtras,
    ports.omitSettingsRows,
    localTick,
    localeTick,
  ]);

  // ---- play funnel -------------------------------------------------
  // The ambiguous-match gate parks candidates in a review the user
  // must resolve — retrying the press only fails the same way, so a
  // play that hits the gate opens the review surface instead of
  // dying quietly on a dead queue item.
  //
  // reportPlayError is the single error funnel: the play promise and
  // the published `playback.failed` state carry the SAME error object,
  // so identity-dedupe via lastPlayErrorRef reports each failure once
  // regardless of which channel delivers it first. The dedupe engages
  // only under ports.trackAttemptActions — the watcher below is
  // desktop's (mobile has no late-verdict channel to dedupe against).
  const lastPlayErrorRef = useRef<AppError | null>(null);
  // Action labels travel with the ATTEMPT, not the button: a pause
  // during an in-flight prepare must not steal the play attempt's
  // name. dispatchPlay records the pending action with a seq; the
  // playback watcher binds it to the attemptId the moment the new
  // attempt publishes, and clears it on settle so engine-advanced
  // attempts (auto-next, queue drain) fall back to the neutral label.
  const attemptActionsRef = useRef(new Map<string, MessageId>());
  const pendingAttemptRef = useRef<{
    seq: number;
    action: MessageId;
  } | null>(null);
  const attemptSeqRef = useRef(0);
  // The funnel reports whatever the engine published as the attempt's
  // terminal verdict — superseded attempts never reach playback.failed
  // (#failAttempt only fires for the live attempt), and a deadline-
  // cancelled verdict IS the failed state the user needs surfaced.
  const reportPlayError = useCallback(
    (action: MessageId, error: AppError) => {
      if (ports.trackAttemptActions === true) {
        if (lastPlayErrorRef.current === error) {
          return;
        }
        lastPlayErrorRef.current = error;
      }
      reportResult(action, { ok: false, error });
      if (isMatchGate(error)) {
        // Land the user on the fresh pending row: a stale 'resolved'
        // filter or an already-open screen would hide it, so the
        // route always selects pending and reloads.
        setReviewFilter('pending');
        loadReviews();
        if (shellOverlayOf(overlay)?.type !== 'corrections') {
          pushOverlay({ type: 'corrections' });
        }
      }
    },
    [pushOverlay, overlay, loadReviews, ports.trackAttemptActions],
  );
  const reportPlay = useCallback(
    (action: MessageId, result: Result<unknown>) => {
      if (result.ok) {
        reportResult(action, result);
        return;
      }
      // The promise's 'superseded'/'cancelled' is queue bookkeeping —
      // superseded attempts never publish a failed state, and a
      // cancelled terminal verdict arrives through the watcher.
      // 'released' is NOT silent: a live prepare can resolve it when
      // the host drops the request, stranding playback silently.
      if (
        result.error.kind === 'superseded' ||
        result.error.kind === 'cancelled'
      ) {
        return;
      }
      reportPlayError(action, result.error);
    },
    [reportPlayError],
  );
  const dispatchPlay = useCallback(
    (action: MessageId, run: Promise<Result<unknown>>): Promise<void> => {
      const seq = ++attemptSeqRef.current;
      pendingAttemptRef.current = { seq, action };
      return run.then((r) => {
        if (pendingAttemptRef.current?.seq === seq) {
          pendingAttemptRef.current = null;
        }
        reportPlay(action, r);
      });
    },
    [reportPlay],
  );
  // A prepare/stream failure that lands after the play promise already
  // resolved reaches the UI only through `playback.failed` — the
  // watcher reports it through the same deduped funnel as the promise
  // path so the failure can't pass silently. Its action comes from
  // attemptActionsRef: whichever op created the attempt owns its name.
  // ports.trackAttemptActions mounts it — mobile's op promises cover
  // its verdicts itself and it runs no watcher.
  useEffect(() => {
    if (ports.trackAttemptActions !== true) {
      return;
    }
    const playback = state.playback;
    const attemptId =
      'identity' in playback ? playback.identity?.attemptId : undefined;
    if (
      attemptId !== undefined &&
      !attemptActionsRef.current.has(attemptId)
    ) {
      const actions = attemptActionsRef.current;
      actions.set(
        attemptId,
        pendingAttemptRef.current?.action ?? 'common.play',
      );
      // Bound the registry — attempts accumulate for the session's life.
      if (actions.size > 64) {
        const oldest = actions.keys().next().value;
        if (oldest !== undefined) {
          actions.delete(oldest);
        }
      }
    }
    if (playback.type === 'failed') {
      reportPlayError(
        (attemptId !== undefined &&
          attemptActionsRef.current.get(attemptId)) ||
          'common.play',
        playback.error,
      );
    }
  }, [state.playback, reportPlayError, ports.trackAttemptActions]);

  // ---- play ops ----------------------------------------------------
  const playRecording = useCallback(
    async (recordingId: string) => {
      if (!canPlay(recordingId)) {
        return;
      }
      // Tap-to-play dedupe: a queued track jumps to its occurrence
      // instead of minting a repeat — 'add to queue' stays additive.
      const queued = queuedOccurrenceFor(state.queue, recordingId);
      if (queued !== null) {
        await dispatchPlay('common.play', session.playOccurrence(queued));
        return;
      }
      const enqueued = await session.enqueueRecording(recordingId);
      if (!enqueued.ok) {
        reportResult('action.enqueueTrack', enqueued);
        return;
      }
      await dispatchPlay(
        'common.play',
        session.playOccurrence(enqueued.value),
      );
    },
    [session, state.queue, canPlay, dispatchPlay],
  );

  // Queue presses and transport follow the same offline rule as
  // library rows: a remote target must not start a dead attempt.
  const playQueueOccurrence = useCallback(
    (occurrenceId: string) => {
      const occurrence = state.queue.occurrences.find(
        (o) => o.occurrenceId === occurrenceId,
      );
      if (occurrence !== undefined && !canPlay(occurrence.recordingId)) {
        return;
      }
      void dispatchPlay('common.play', session.playOccurrence(occurrenceId));
    },
    [session, state.queue, canPlay, dispatchPlay],
  );

  // Mirrors the cursor's targeting in walk space — the dealt order
  // under shuffle, canonical otherwise: next → the engine's
  // mark-skipping destination; previous → restart current when
  // positionMs>3s or at the walk's head, else position−1 — and under
  // repeat=all both edges wrap (tail→head, head→tail). The gate sees
  // the same target the engine would land on — an attachable target
  // still advances offline.
  // ports.gateAdvanceAlways: desktop tests the target on EVERY
  // advance (a missing walk target no-ops even online); mobile tests
  // only while connectivity is explicitly down.
  const advance = useCallback(
    (method: 'next' | 'previous') => {
      const { occurrences, currentOccurrenceId } = state.queue;
      const gate =
        ports.gateAdvanceAlways === true || online === false;
      if (gate) {
        // Position ticks ride the light channel now — read it live,
        // not the (possibly position-stale) published snapshot.
        const targetId = advanceTargetId({
          method,
          occurrences,
          currentOccurrenceId,
          dealtOrder: state.shuffleOrder,
          failedIds: failedQueueIds.current,
          repeat: state.repeat,
          positionMs: session.positionMs(),
        });
        const target = occurrences.find(
          (o) => o.occurrenceId === targetId,
        );
        if (ports.gateAdvanceAlways === true) {
          if (target === undefined || !canPlay(target.recordingId)) {
            return;
          }
        } else if (
          target !== undefined &&
          !localPlayable(target.recordingId)
        ) {
          return;
        }
      }
      void dispatchPlay(
        method === 'next' ? 'common.next' : 'common.previous',
        method === 'next' ? session.next() : session.previous(),
      );
    },
    [
      session,
      state.queue,
      state.shuffleOrder,
      state.repeat,
      online,
      canPlay,
      localPlayable,
      ports.gateAdvanceAlways,
      dispatchPlay,
    ],
  );

  // Offline honesty for metadata paths (cached search/entity rows):
  // the materialized recording is playable offline only when the
  // player can attach its bytes — a provider ref alone would start a
  // remote attempt the UI says waits for connectivity.
  const canPlayMeta = useCallback(
    (meta: TrackMetadata): boolean => {
      if (online !== false) {
        return true;
      }
      const ref = meta.sourceRef;
      const recording = state.recordings.find((r) =>
        r.sourceRefs.some(
          (s) =>
            s.provider === ref.provider &&
            s.kind === ref.kind &&
            s.id === ref.id,
        ),
      );
      return (
        recording !== undefined && localPlayable(recording.id)
      );
    },
    [online, state.recordings, localPlayable],
  );

  // Same dedupe as playRecording for metadata taps (search results,
  // entity rows, home cards): the tap's source ref can match a queued
  // occurrence or one of its recording's refs before it materializes.
  const playMeta = useCallback(
    (meta: TrackMetadata) => {
      const queued = queuedOccurrenceForRef(
        state.queue,
        state.recordings,
        meta.sourceRef,
      );
      return queued === null
        ? session.addAndPlay(meta)
        : session.playOccurrence(queued);
    },
    [session, state.queue, state.recordings],
  );

  const onResultPress = useCallback(
    (row: TrackRowModel) => {
      // Local merged rows are existing recordings — play through the
      // owned-bytes path rather than re-ingesting provider metadata.
      // `local:` keys exist only under ports.localCatalog, so the
      // branch can never shadow a catalog row on desktop.
      if (
        ports.localCatalog === true &&
        row.key.startsWith('local:')
      ) {
        void playRecording(row.key.slice('local:'.length));
        return;
      }
      const meta = resultMeta.current.get(row.key);
      if (meta !== undefined && canPlayMeta(meta)) {
        recordRecentSearch(query);
        void dispatchPlay('action.playResult', playMeta(meta));
      }
    },
    [
      canPlayMeta,
      playMeta,
      playRecording,
      dispatchPlay,
      query,
      recordRecentSearch,
      ports.localCatalog,
    ],
  );

  // A home card carries either a materialized recording id (recents /
  // resume rails) or a suggestion's `${provider}:${id}` key. The meta
  // map covers every rendered suggestion card — a miss means a
  // recording-keyed card. ports.strictHomeCardKeys: mobile only treats
  // the card as a recording when it sits in the recents rail — an
  // unrecognized suggestion key no-ops instead of enqueueing a
  // provider-keyed 'recordingId' that can only fail; desktop presses
  // any unmatched key through the recording path.
  const onHomeCardPress = useCallback(
    (card: { readonly key: string }) => {
      // strictHomeCardKeys (mobile): a recents-rail card is a recording
      // first — a key collision with a suggestion still plays the
      // recording, matching the pre-extraction activateHomeCard order.
      if (
        ports.strictHomeCardKeys === true &&
        homeModel.recents.some((liked) => liked.key === card.key)
      ) {
        void playRecording(card.key);
        return;
      }
      const meta = suggestionMeta.get(card.key);
      if (meta !== undefined) {
        if (!canPlayMeta(meta)) {
          return;
        }
        if (searchState.type === 'content') {
          recordRecentSearch(searchState.query);
        }
        void dispatchPlay('action.playResult', playMeta(meta));
        return;
      }
      if (ports.strictHomeCardKeys === true) {
        return;
      }
      void playRecording(card.key);
    },
    [
      suggestionMeta,
      canPlayMeta,
      playMeta,
      playRecording,
      dispatchPlay,
      searchState,
      recordRecentSearch,
      homeModel,
      ports.strictHomeCardKeys,
    ],
  );

  // ---- settings handlers -------------------------------------------
  const onSettingsSelect = useCallback(
    (key: string) => {
      if (key === 'theme') {
        themeEpoch.current += 1;
        setThemePickerOpen(true);
        return;
      }
      if (key === 'language') {
        languageEpoch.current += 1;
        setLanguagePickerOpen(true);
        return;
      }
      if (
        key === 'catalogProvider' ||
        key === 'playbackProvider' ||
        key === 'lyricsProvider' ||
        key === 'radioProvider'
      ) {
        setProviderSlot(key);
        return;
      }
      if (key === 'exportLibrary' || key === 'importLibrary') {
        importText.current = null;
        importPreviewRaw.current = null;
        setTransfer(IDLE_TRANSFER);
        pushOverlay({ type: 'transfer' });
        return;
      }
      if (key === 'storefront') {
        storefrontEpoch.current += 1;
        setStorefrontDraft(state.settings.storefront ?? '');
        setStorefrontSheetOpen(true);
        return;
      }
      if (key === 'qualityKbps') {
        qualityEpoch.current += 1;
        setQualityPickerOpen(true);
        return;
      }
      if (key === 'removeAllDownloads') {
        void controller.downloads
          .removeAll(new CancellationSource().signal)
          .then((removed) => {
            reportResult('settings.removeAllDownloads', removed);
            refreshUsage();
          });
        return;
      }
      if (key === 'sync') {
        // The row's destination is the platform's — mobile pushes its
        // sync overlay; desktop scrolls+focuses the inline section.
        if (ports.openSyncOverlay !== undefined) {
          pushOverlay(ports.openSyncOverlay);
        } else {
          ports.openSync?.();
        }
        return;
      }
      if (key === 'artworkCacheBytes') {
        setArtworkCachePickerOpen(true);
        return;
      }
      // A committed mutation lands on the instance the op ran on —
      // ports.afterLocalMutation owns the post-commit projection
      // (the apps disagree on the mid-flight rehydrate swap).
      if (key === 'addLocalFolder') {
        const local = controller.local();
        if (local === null) {
          return;
        }
        void local
          .addFolder(new CancellationSource().signal)
          .then((added) => {
            reportResult('settings.addLocalFolder', added);
            if (added.ok) {
              ports.afterLocalMutation(local, refreshLocal);
            }
          });
        return;
      }
      if (key.startsWith('localSourceRemove:')) {
        const local = controller.local();
        if (local === null) {
          return;
        }
        const sourceId = key.slice('localSourceRemove:'.length);
        void local
          .removeSource(sourceId, new CancellationSource().signal)
          .then((removed) => {
            reportResult('action.removeLocalFolder', removed);
            if (removed.ok) {
              ports.afterLocalMutation(local, refreshLocal);
            }
          });
        return;
      }
      if (key === 'rescanLocal' || key === 'localSources') {
        const local = controller.local();
        if (local === null) {
          return;
        }
        void local
          .rescan(undefined, new CancellationSource().signal)
          .then((scanned) => {
            reportResult('settings.rescanLocal', scanned);
            if (scanned.ok) {
              ports.afterLocalMutation(local, refreshLocal);
            }
          });
        return;
      }
      // downloadStorage is display-only.
    },
    [
      session,
      state.settings,
      controller,
      refreshLocal,
      refreshUsage,
      pushOverlay,
      ports,
    ],
  );

  const onSettingsToggle = useCallback(
    (key: string) => {
      // Function patches: the flip reads the committed value at
      // execution time, so rapid successive clicks toggle per click.
      if (key === 'prefetch') {
        void queueSettingsWrite((latest) => ({
          prefetch: !latest.prefetch,
        }));
      }
      if (key === 'downloadMetered') {
        void queueSettingsWrite((latest) => ({
          downloadMetered: latest.downloadMetered !== true,
        })).then((updated) => {
          // Re-derive only after the setting commits — toggling ON
          // unblocks waiting rows, toggling OFF pauses an active
          // cellular transfer; kick() can't demote mid-flight work.
          if (updated.ok) {
            void controller.downloads.reevaluateEligibility();
          }
        });
      }
    },
    [queueSettingsWrite, controller],
  );

  // ---- transport ---------------------------------------------------
  const playback = state.playback;
  const playing = playback.type === 'playing';
  const currentRecordingId =
    playback.type === 'idle' ? null : playback.recordingId;
  // Real waveform peaks for the Stage seek — lazy, cached per
  // recordingId|attemptId (a re-prepared stream never inherits the
  // attempt it replaced). The port borrows the live stream handle;
  // it never owns or closes it. null where the platform has no
  // decode path (iOS) — the seeded pattern stays while pending or
  // on failure.
  const peaksTarget: PeaksTarget | null =
    playback.type === 'buffering' ||
    playback.type === 'playing' ||
    playback.type === 'paused'
      ? {
          id: `${playback.recordingId}|${playback.identity.attemptId}`,
          handle: playback.handle,
          durationMs: playback.durationMs ?? null,
        }
      : null;
  const peaks = useWaveformPeaks(ports.peaksPort ?? null, peaksTarget);

  const onPlayPause = useCallback(() => {
    // Pause is always allowed; resuming a remote track while offline
    // would start a prepare that cannot finish. The intent is the
    // queue's mode, not transport: during a retry backoff playback
    // publishes 'preparing' with no handle, and the tap must still
    // pause. A transport 'paused' that arrived natively (queue still
    // 'playing') means the tap resumes, not re-pauses.
    const intentPlaying =
      state.queue.mode === 'playing' && state.playback.type !== 'paused';
    if (
      !intentPlaying &&
      currentRecordingId !== null &&
      !canPlay(currentRecordingId)
    ) {
      return;
    }
    ports.haptic?.('light');
    // pause/resume keep the SAME attempt identity — they never own a
    // new one, so no pendingAttempt claim; their own promise still
    // reports with their own action.
    void (intentPlaying ? session.pause() : session.resume()).then((r) =>
      reportPlay(intentPlaying ? 'common.pause' : 'action.resume', r),
    );
  }, [
    session,
    state.queue.mode,
    state.playback.type,
    currentRecordingId,
    canPlay,
    reportPlay,
    ports.haptic,
  ]);

  const onToggleLike = useCallback(() => {
    if (currentRecordingId !== null) {
      ports.haptic?.('light');
      void session.toggleLike(currentRecordingId);
    }
  }, [session, currentRecordingId, ports.haptic]);

  const onMoveQueueItem = useCallback(
    (occurrenceId: string, direction: -1 | 1) => {
      // Move slots are display slots — the session translates them to
      // canonical/dealt positions itself.
      const index = queueModel.sections
        .flatMap((s) => s.items)
        .findIndex((i) => i.occurrenceId === occurrenceId);
      if (index >= 0) {
        void session.moveOccurrence(occurrenceId, index + direction);
      }
    },
    [session, queueModel],
  );

  const onMoveQueueItemTo = useCallback(
    (occurrenceId: string, toIndex: number) => {
      void session.moveOccurrence(occurrenceId, toIndex);
    },
    [session],
  );

  // ---- lyrics (Stage lyrics mode — live read, cancel superseded) --

  const fetchLyrics = useCallback(
    (recordingId: string) => {
      lyricsSource.current?.cancel();
      const source = new CancellationSource();
      lyricsSource.current = source;
      setLyricsFetch({
        recordingId,
        sheet: null,
        error: null,
        loading: true,
      });
      const context: OperationContext = {
        requestId: createIds().next('lyrics'),
        deadlineMs: Date.now() + 15_000,
        signal: source.signal,
      };
      void session.getLyrics(recordingId, context).then((result) => {
        setLyricsFetch((prev) =>
          prev === null ||
          prev.recordingId !== recordingId ||
          source.signal.cancelled
            ? prev
            : result.ok
              ? {
                  recordingId,
                  sheet: result.value,
                  error: null,
                  loading: false,
                }
              : {
                  recordingId,
                  sheet: null,
                  error: result.error,
                  loading: false,
                },
        );
      });
    },
    [session],
  );

  // Lyrics load lazily — while the Stage is showing in lyrics mode —
  // and refetch whenever the track under it changes. Leaving lyrics
  // mode keeps the last sheet cached. ports.lyricsWhileOpen widens
  // the trigger to any open stage (mobile prefetches so the lyrics
  // tab switch is instant).
  useEffect(() => {
    const openForLyrics =
      ports.lyricsWhileOpen === true
        ? stageOpen
        : stageOpen && stageMode === 'lyrics';
    if (!openForLyrics || currentRecordingId === null) {
      return;
    }
    if (lyricsFetch?.recordingId === currentRecordingId) {
      return;
    }
    fetchLyrics(currentRecordingId);
  }, [
    stageOpen,
    stageMode,
    currentRecordingId,
    lyricsFetch,
    fetchLyrics,
    ports.lyricsWhileOpen,
  ]);

  // ports.resetModeOnTrack: a new track under an open sheet returns
  // it to player mode — the playing item is what the sheet exists to
  // show. Explicit opens (deep links, menus) set the mode before
  // expanding, so this listens only for the track change, not the
  // open flip.
  const openForMode = useRef(stageOpen);
  useEffect(() => {
    openForMode.current = stageOpen;
  }, [stageOpen]);
  useEffect(() => {
    if (
      ports.resetModeOnTrack === true &&
      currentRecordingId !== null &&
      openForMode.current
    ) {
      setStageMode('player');
    }
  }, [currentRecordingId, ports.resetModeOnTrack]);

  // Lyrics highlight rides a smoothed clock so the active line tracks
  // playback between the engine's sparse position ticks; it only ticks
  // while the lyrics pane is actually on screen.
  const [seekGeneration, bumpSeekGeneration] = useState(0);
  const seekToPosition = useCallback(
    (ms: number, expectedOccurrenceId?: string): Promise<Result<void>> => {
      bumpSeekGeneration((n) => n + 1);
      return session.seekTo(ms, expectedOccurrenceId);
    },
    [session],
  );
  const lyricsPositionMs = useSmoothedPosition(
    stagePlayer?.positionMs ?? 0,
    playing,
    stageOpen && stageMode === 'lyrics',
    seekGeneration,
  );
  const lyricsModel: LyricsModel | undefined = useMemo(() => {
    if (currentRecordingId === null) {
      return undefined;
    }
    const fetch =
      lyricsFetch !== null && lyricsFetch.recordingId === currentRecordingId
        ? lyricsFetch
        : null;
    return toLyricsModel({
      sheet: fetch?.sheet ?? null,
      error: fetch?.error ?? null,
      loading: fetch === null ? true : fetch.loading,
      positionMs: lyricsPositionMs,
    });
  }, [lyricsFetch, currentRecordingId, lyricsPositionMs, localeTick]);

  const onRetryLyrics = useCallback(() => {
    if (currentRecordingId !== null) {
      fetchLyrics(currentRecordingId);
    }
  }, [fetchLyrics, currentRecordingId]);

  // ---- radio (session.radio tail — start from the playing ref) ---

  const radioModel = useMemo(() => toRadioModel(state.radio), [
    state.radio,
    localeTick,
  ]);
  // Radio seeds route by the seed reference's own provider — a track
  // is only seedable when THAT provider declares radio.seed, not just
  // any loaded one.
  const radioSeedable = useCallback(
    (ref: SourceRef | null): boolean =>
      ref !== null &&
      controller.providers.some(
        (p) =>
          p.id === ref.provider && p.capabilities.includes('radio.seed'),
      ),
    [controller],
  );

  // The stage radio control seeds from the playing occurrence's
  // selected ref, falling back to the recording's first source ref —
  // the same derivation the seed op uses, kept shared so the gate
  // mirrors the action exactly.
  const radioSeedRef = useMemo((): SourceRef | null => {
    const current = state.queue.occurrences.find(
      (o) => o.occurrenceId === state.queue.currentOccurrenceId,
    );
    const recording =
      currentRecordingId === null
        ? undefined
        : state.recordings.find((r) => r.id === currentRecordingId);
    return current?.selectedRef ?? recording?.sourceRefs[0] ?? null;
  }, [state.queue, state.recordings, currentRecordingId]);

  // The row-action seed: a metadata row seeds its own ref; a library
  // row seeds its first source ref. Gate matches the op's target.
  const actionRadioRef = useMemo((): SourceRef | null => {
    if (actionsFor === null) {
      return null;
    }
    return actionsFor.kind === 'metadata'
      ? actionsFor.meta.sourceRef
      : (state.recordings.find((r) => r.id === actionsFor.recordingId)
          ?.sourceRefs[0] ?? null);
  }, [actionsFor, state.recordings]);

  const onStartRadio = useCallback(() => {
    const ref = radioSeedRef;
    if (ref !== null && radioSeedable(ref)) {
      void session
        .startRadio(ref)
        .then((r) => reportResult('stage.radio.start', r));
    }
  }, [session, radioSeedRef, radioSeedable]);

  const onStopRadio = useCallback(() => {
    reportResult('action.stopRadio', session.stopRadio());
  }, [session]);

  // ---- corrections (live read + serialized review ops) -----------

  // The queue reloads whenever the corrections overlay opens — the
  // rows are live reads, never stale session state.
  useEffect(() => {
    if (shellOverlayOf(overlay)?.type === 'corrections') {
      loadReviews();
    }
  }, [overlay, loadReviews]);

  const correctionsModel = useMemo(
    () =>
      toCorrectionsModel({
        reviews: reviewFetch.reviews,
        error: reviewFetch.error,
        recordings: state.recordings,
        filter: reviewFilter,
      }),
    [reviewFetch, state.recordings, reviewFilter, localeTick],
  );

  // A failed op surfaces its typed error as the screen's error state;
  // a landed verdict reloads the queue so the row resolves in place.
  const reviewOp = useCallback(
    (op: () => Promise<Result<unknown>>) => {
      void op().then((result) => {
        if (result.ok) {
          loadReviews();
        } else {
          setReviewFetch({ reviews: null, error: result.error });
        }
      });
    },
    [session, loadReviews],
  );

  // ---- library transfer (export write · import preview) -----------

  const onExport = useCallback(() => {
    setTransfer((prev) => ({
      ...prev,
      exportPhase: 'working',
      exportDetail: null,
    }));
    void session.exportLibrary().then(async (result) => {
      if (!result.ok) {
        setTransfer((prev) => ({
          ...prev,
          exportPhase: 'error',
          exportDetail: errorText(result.error),
        }));
        return;
      }
      const name = `auqw-library-${new Date().toISOString().slice(0, 10)}.json`;
      let outcome: ExportWrite;
      try {
        outcome = await ports.exportJson(result.value.json, name);
      } catch {
        setTransfer((prev) => ({
          ...prev,
          exportPhase: 'error',
          exportDetail: t('transfer.exportWriteFailed'),
        }));
        return;
      }
      if (outcome.kind === 'cancelled') {
        setTransfer((prev) => ({ ...prev, exportPhase: 'idle' }));
        return;
      }
      if (outcome.kind === 'error') {
        setTransfer((prev) => ({
          ...prev,
          exportPhase: 'error',
          exportDetail: t('transfer.exportWriteFailed'),
        }));
        return;
      }
      exportDoneDetail.current = outcome.detail;
      setTransfer((prev) => ({
        ...prev,
        exportPhase: 'done',
        exportDetail: outcome.detail(),
      }));
    });
  }, [session, ports.exportJson]);

  // The shared side of an import read: beginImportRead arms the
  // 'reading' phase, then the platform's pick hands the file's text +
  // display name to onImportText. cancelImportRead covers every
  // "user backed out" shape (dismissed picker, AbortError, canceled
  // pick result); failImportRead covers an unreadable file.
  const beginImportRead = useCallback(() => {
    importPreviewRaw.current = null;
    setTransfer((prev) => ({
      ...prev,
      importPhase: 'reading',
      importDetail: null,
      preview: null,
    }));
  }, []);

  const onImportText = useCallback(
    (text: string, sourceLabel: string) => {
      // Preview validates without mutating — a typed error here is
      // the honest reject; nothing was applied.
      const preview = previewImport(text);
      if (!preview.ok) {
        importPreviewRaw.current = null;
        setTransfer((prev) => ({
          ...prev,
          importPhase: 'error',
          importDetail: t('error.importInvalid'),
          preview: null,
        }));
        return;
      }
      importText.current = text;
      importPreviewRaw.current = { preview: preview.value, sourceLabel };
      setTransfer((prev) => ({
        ...prev,
        importPhase: 'preview',
        preview: toImportPreviewModel(preview.value, sourceLabel),
      }));
    },
    [],
  );

  const cancelImportRead = useCallback(() => {
    setTransfer((prev) => ({ ...prev, importPhase: 'idle' }));
  }, []);

  const failImportRead = useCallback(() => {
    importPreviewRaw.current = null;
    setTransfer((prev) => ({
      ...prev,
      importPhase: 'error',
      importDetail: t('transfer.readFailed'),
      preview: null,
    }));
  }, []);

  const onApplyImport = useCallback(() => {
    const text = importText.current;
    if (text === null) {
      return;
    }
    setTransfer((prev) => ({ ...prev, importPhase: 'applying' }));
    // replaceLibrary drains the download manager (live runners and
    // finalized files) before session.importLibrary swaps sections,
    // then rehydrates the media owners off the new snapshot. The
    // returned preview doubles as the applied-summary counts.
    void controller
      .replaceLibrary(text, new CancellationSource().signal)
      .then((result) => {
        if (!result.ok) {
          setTransfer((prev) => ({
            ...prev,
            importPhase: 'error',
            importDetail: errorText(result.error),
          }));
          return;
        }
        importText.current = null;
        const counts = result.value.counts;
        importSummaryCounts.current = {
          tracks: counts.recordings,
          likes: counts.likes,
          playlists: counts.playlists,
        };
        setTransfer((prev) => ({
          ...prev,
          importPhase: 'done',
          importDetail: t('transfer.importSummary', {
            tracks: counts.recordings,
            likes: counts.likes,
            playlists: counts.playlists,
          }),
        }));
      });
  }, [controller]);

  const onResetImport = useCallback(() => {
    importText.current = null;
    importPreviewRaw.current = null;
    setTransfer((prev) => ({
      ...prev,
      importPhase: 'idle',
      importDetail: null,
      preview: null,
    }));
  }, []);

  // Full transfer-surface reset — the deep-link shell wipes the whole
  // phase pair (export AND import) before driving a fresh leg, unlike
  // onResetImport which only unwinds the import stage.
  const resetTransfer = useCallback(() => {
    importText.current = null;
    importPreviewRaw.current = null;
    setTransfer(IDLE_TRANSFER);
  }, []);

  // ---- provider pickers (capability-gated manifest options) -------

  const providerPicker = useMemo(
    () =>
      providerPickerModel(
        providerSlot,
        controller.providers,
        state.settings,
      ),
    [providerSlot, controller, state.settings, localeTick],
  );

  const onPickProvider = useCallback(
    (key: string) => {
      const slot = providerSlot;
      setProviderSlot(null);
      if (slot === null) {
        return;
      }
      const patch: Partial<Settings> = {};
      if (slot === 'lyricsProvider' || slot === 'radioProvider') {
        patch[slot] = key === 'auto' ? null : key;
      } else {
        patch[slot] = key;
      }
      void queueSettingsWrite(patch);
    },
    [providerSlot, queueSettingsWrite],
  );

  // ---- library world: entity fetch ----------------------------------

  const loadEntityPage = useCallback(
    (ref: EntityRef) => {
      const key = entityRefKey(ref);
      setEntityFetches((prev) => ({
        ...prev,
        [key]: {
          ref,
          page: null,
          error: null,
          loading: true,
          loadingMore: false,
        },
      }));
      void session.getEntityPage(ref).then((result) => {
        setEntityFetches((prev) => {
          const cur = prev[key];
          if (cur === undefined || cur.ref !== ref) {
            return prev;
          }
          return {
            ...prev,
            [key]: result.ok
              ? { ...cur, page: result.value, error: null, loading: false }
              : { ...cur, page: null, error: result.error, loading: false },
          };
        });
      });
    },
    [session],
  );

  const openEntity = useCallback(
    (ref: EntityRef) => {
      // Re-opening the entity already on top just reloads it.
      const top = shellOverlayOf(overlayStack[overlayStack.length - 1]?.overlay);
      if (
        top?.type === 'entity' &&
        entityRefKey(top.ref) === entityRefKey(ref)
      ) {
        loadEntityPage(ref);
        return;
      }
      pushOverlay({ type: 'entity', ref });
      loadEntityPage(ref);
    },
    [overlayStack, pushOverlay, loadEntityPage],
  );

  const onLoadMore = useCallback(() => {
    const current = shellOverlayOf(overlay);
    const top = current?.type === 'entity' ? current.ref : null;
    const key = top === null ? null : entityRefKey(top);
    const cur = key === null ? null : entityFetches[key] ?? null;
    const continuation = cur?.page?.continuation;
    if (
      key === null ||
      cur === null ||
      cur.page === null ||
      continuation == null ||
      cur.loadingMore
    ) {
      return;
    }
    /*
     * The port's only entity request is an EntityRef — there is no
     * continuation payload on the catalog.entity wire (ABI 0.3.0),
     * and shipped providers never mint one. The token is carried
     * back as the ref id: ref-scoped routing returns it to the
     * provider that minted it, which is the only honest
     * interpretation the port supports.
     */
    const more: EntityRef = {
      provider: cur.ref.provider,
      kind: cur.ref.kind,
      id: continuation,
    };
    setEntityFetches((prev) => ({
      ...prev,
      [key]: { ...cur, loadingMore: true },
    }));
    void session.getEntityPage(more).then((result) => {
      setEntityFetches((prev) => {
        const latest = prev[key];
        if (
          latest === undefined ||
          latest.ref !== cur.ref ||
          latest.page === null
        ) {
          return prev;
        }
        if (!result.ok) {
          return {
            ...prev,
            [key]: { ...latest, error: result.error, loadingMore: false },
          };
        }
        const seen = new Set(
          latest.page.items.map(
            (m) =>
              `${m.sourceRef.provider} ${m.sourceRef.kind} ${m.sourceRef.id}`,
          ),
        );
        const fresh = result.value.items.filter(
          (m) =>
            !seen.has(
              `${m.sourceRef.provider} ${m.sourceRef.kind} ${m.sourceRef.id}`,
            ),
        );
        return {
          ...prev,
          [key]: {
            ...latest,
            page: {
              ...result.value,
              items: [...latest.page.items, ...fresh],
            },
            error: null,
            loadingMore: false,
          },
        };
      });
    });
  }, [session, overlay, entityFetches]);

  // ---- collection / playlist play + download -----------------------

  const playCollectionRows = useCallback(
    (rows: readonly { recordingId: string }[]) => {
      const playable = rows.filter((row) => canPlay(row.recordingId));
      if (playable.length === 0) {
        return;
      }
      void dispatchPlay(
        'action.playCollection',
        session.playRecordings(
          playable.map((row) => ({
            recordingId: row.recordingId,
            selectedRef: null,
          })),
        ),
      );
    },
    [session, canPlay, dispatchPlay],
  );

  // ports.preferOwnedRef: a provider pin beats owned bytes in
  // #pickRef — mobile drops it when bytes exist so downloads
  // actually get played; desktop always forwards the entry pin.
  const playPlaylist = useCallback(
    (model: ReturnType<typeof playlistModelFor>) => {
      if (model === null) {
        return;
      }
      const playable = model.entries.filter((entry) =>
        canPlay(entry.recordingId),
      );
      if (playable.length === 0) {
        return;
      }
      void dispatchPlay(
        'action.playPlaylist',
        session.playRecordings(
          playable.map((entry) => ({
            recordingId: entry.recordingId,
            selectedRef:
              ports.preferOwnedRef === true &&
              isOwned(entry.recordingId)
                ? null
                : entry.selectedRef,
          })),
        ),
      );
    },
    [session, isOwned, canPlay, dispatchPlay, ports.preferOwnedRef],
  );

  const playPlaylistEntry = useCallback(
    (entry: {
      readonly recordingId: string;
      readonly selectedRef: SourceRef | null;
    }) => {
      if (!canPlay(entry.recordingId)) {
        return;
      }
      void dispatchPlay(
        'action.playPlaylistEntry',
        session.playRecordings([
          {
            recordingId: entry.recordingId,
            selectedRef:
              ports.preferOwnedRef === true &&
              isOwned(entry.recordingId)
                ? null
                : entry.selectedRef,
          },
        ]),
      );
    },
    [session, canPlay, isOwned, dispatchPlay, ports.preferOwnedRef],
  );

  const playlistDownloadFor = useCallback(
    (model: ReturnType<typeof playlistModelFor>) => {
      if (model === null) {
        return { state: 'none' as const, requests: [] };
      }
      return playlistDownloadPlan({
        entries: model.entries,
        isOwned,
        downloadRefFor,
        recordFor: (id) => controller.downloads.recordFor(id),
      });
      // downloads/localTick bump re-derives ownership; downloadRefFor
      // and isOwned already capture the pieces they read.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [downloads, localTick, controller, downloadRefFor, isOwned],
  );

  const onPlaylistDownloadAll = useCallback(
    (
      requests: readonly { recordingId: string; sourceRef: SourceRef }[],
    ) => {
      if (requests.length === 0) {
        return;
      }
      void controller.downloads
        .requestAll(requests, new CancellationSource().signal)
        .then((r) => reportResult('action.download', r));
    },
    [controller],
  );

  // ---- playlist adds + row actions ---------------------------------

  const addToPlaylist = useCallback(
    async (playlistId: string, target: ActionTarget) => {
      const recordingId =
        target.kind === 'recording'
          ? target.recordingId
          : await session
              .ensureRecording(target.meta)
              .then((r) => {
                if (!r.ok) {
                  reportResult('action.prepareTrack', r);
                }
                return r.ok ? r.value : null;
              });
      if (recordingId === null) {
        return;
      }
      reportResult(
        'sheets.addToPlaylist',
        await session.addPlaylistEntry(
          playlistId,
          recordingId,
          target.kind === 'metadata' ? target.meta.sourceRef : null,
        ),
      );
    },
    [session],
  );

  const onPickPlaylist = useCallback(
    (playlistId: string) => {
      const target = pickerFor;
      setPickerFor(null);
      if (target !== null) {
        void addToPlaylist(playlistId, target);
      }
    },
    [pickerFor, addToPlaylist],
  );

  const onCreateAndPick = useCallback(
    (name: string) => {
      const target = pickerFor;
      void session.createPlaylist(name).then((created) => {
        if (!created.ok) {
          reportResult('action.createPlaylist', created);
          return;
        }
        if (target !== null) {
          void addToPlaylist(created.value, target);
        }
      });
      setPickerFor(null);
    },
    [session, pickerFor, addToPlaylist],
  );

  const onRowAction = useCallback(
    (key: string) => {
      const target = actionsFor;
      setActionsFor(null);
      if (target === null) {
        return;
      }
      switch (key) {
        case 'like':
          if (target.kind === 'recording') {
            void session
              .toggleLike(target.recordingId)
              .then((r) => reportResult('action.toggleLike', r));
          }
          break;
        case 'enqueue':
          void (target.kind === 'recording'
            ? session.enqueueRecording(target.recordingId)
            : session.enqueueMetadata(target.meta)
          ).then((r) => reportResult('action.addToQueue', r));
          break;
        case 'add':
          setPickerFor(target);
          break;
        case 'download':
          if (target.kind === 'recording') {
            onDownloadAction(target.recordingId);
          }
          break;
        case 'removeDownload':
          if (target.kind === 'recording') {
            const row = controller.downloads.recordFor(
              target.recordingId,
            );
            if (row !== null) {
              void controller.downloads
                .remove(row.downloadId, new CancellationSource().signal)
                .then((r) => {
                  reportResult('action.removeDownload', r);
                  refreshUsage();
                });
            }
          }
          break;
        case 'radio': {
          // Track-seeded at this release: a metadata row seeds its own
          // ref; a library row seeds its first source ref. The action
          // only renders when the seed's provider declares radio.seed,
          // but guard the op too — state may shift between the two.
          const ref =
            target.kind === 'metadata'
              ? target.meta.sourceRef
              : (state.recordings.find(
                  (r) => r.id === target.recordingId,
                )?.sourceRefs[0] ?? null);
          if (ref !== null && radioSeedable(ref)) {
            void session
              .startRadio(ref)
              .then((r) => reportResult('stage.radio.start', r));
          }
          break;
        }
        case 'album':
          if (target.kind === 'metadata' && target.meta.albumRef) {
            openEntity(target.meta.albumRef);
          }
          break;
        case 'artist':
          if (target.kind === 'metadata' && target.meta.artistRef) {
            openEntity(target.meta.artistRef);
          }
          break;
        default:
          break;
      }
    },
    [
      actionsFor,
      session,
      openEntity,
      state.recordings,
      radioSeedable,
      onDownloadAction,
      controller,
      refreshUsage,
    ],
  );

  // The sheet model — same list on both platforms.
  const rowActions = useMemo(() => {
    if (actionsFor === null) {
      return null;
    }
    const model = rowActionsModel({
      target: actionsFor,
      title:
        actionsFor.kind === 'recording'
          ? (state.recordings.find((r) => r.id === actionsFor.recordingId)
              ?.title ?? t('track.fallbackTitle'))
          : actionsFor.meta.title,
      liked:
        actionsFor.kind === 'recording' &&
        state.likes.some(
          (l) =>
            l.entityKind === 'track' &&
            l.targetId === actionsFor.recordingId,
        ),
      recordFor: (id) => controller.downloads.recordFor(id),
      downloadRefFor,
      radioSeedable: radioSeedable(actionRadioRef),
    });
    return { target: actionsFor, ...model };
    // downloads refresh rebuilds the ledger read inside recordFor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    actionsFor,
    state.recordings,
    state.likes,
    controller,
    downloadRefFor,
    radioSeedable,
    actionRadioRef,
    downloads,
    localeTick,
  ]);

  // ---- cards / playlist ops ----------------------------------------

  const onOpenCard = useCallback(
    (card: {
      playlistId: string | null;
      entityRef: EntityRef | null;
    }) => {
      if (card.playlistId !== null) {
        pushOverlay({ type: 'playlist', playlistId: card.playlistId });
      } else if (card.entityRef !== null) {
        openEntity(card.entityRef);
      }
    },
    [pushOverlay, openEntity],
  );

  const onCreatePlaylist = useCallback(
    (name: string) => {
      void session.createPlaylist(name).then((created) => {
        if (!created.ok) {
          reportResult('action.createPlaylist', created);
          return;
        }
        pushOverlay({ type: 'playlist', playlistId: created.value });
      });
    },
    [session, pushOverlay],
  );

  // Playlist overlay mutations — identical session calls modulo the
  // platform's haptic on delete (ports.haptic 'warning' pre-fires).
  const renamePlaylist = useCallback(
    (playlistId: string, name: string) => {
      void session
        .renamePlaylist(playlistId, name)
        .then((r) => reportResult('action.renamePlaylist', r));
    },
    [session],
  );
  const deletePlaylist = useCallback(
    (playlistId: string) => {
      ports.haptic?.('warning');
      void session
        .deletePlaylist(playlistId)
        .then((r) => reportResult('action.deletePlaylist', r));
    },
    [session, ports.haptic],
  );
  const removePlaylistEntry = useCallback(
    (entryId: string) => {
      void session
        .removePlaylistEntry(entryId)
        .then((r) => reportResult('action.removeTrack', r));
    },
    [session],
  );
  const movePlaylistEntry = useCallback(
    (
      model: ReturnType<typeof playlistModelFor>,
      move: { readonly entryId: string },
      direction: -1 | 1,
    ) => {
      if (model === null) {
        return;
      }
      const index = model.entries.findIndex(
        (e) => e.entryId === move.entryId,
      );
      const sibling = model.entries[index + direction];
      if (sibling === undefined) {
        return;
      }
      void session
        .reorderPlaylistEntry(
          move.entryId,
          direction === -1
            ? { before: sibling.entryId }
            : { after: sibling.entryId },
        )
        .then((r) => reportResult('action.reorderPlaylist', r));
    },
    [session],
  );

  // Entity-screen play surfaces — ports.entityPlayRequiresCanPlay
  // gates the desktop's canPlayMeta filter + empty early-return;
  // mobile plays every fetched row.
  const entityPlayAll = useCallback(
    (
      fetch: EntityFetch | null,
      entryKey: string,
      shuffle: boolean,
    ) => {
      const metas = entityModelFor(fetch)
        .items.map((row) =>
          entityMeta.current.get(`${entryKey}:${row.key}`),
        )
        .filter(
          (m): m is TrackMetadata =>
            m !== undefined &&
            (ports.entityPlayRequiresCanPlay !== true ||
              canPlayMeta(m)),
        );
      if (
        ports.entityPlayRequiresCanPlay === true &&
        metas.length === 0
      ) {
        return;
      }
      void dispatchPlay(
        shuffle ? 'action.shuffleAll' : 'collection.playAll',
        shuffle
          ? session.playMetadata(metas, { shuffle: true })
          : session.playMetadata(metas),
      );
    },
    [
      session,
      entityModelFor,
      canPlayMeta,
      dispatchPlay,
      ports.entityPlayRequiresCanPlay,
    ],
  );

  const entityRowMeta = useCallback(
    (entryKey: string, row: TrackRowModel) =>
      entityMeta.current.get(`${entryKey}:${row.key}`),
    [],
  );

  const onEntityRowPress = useCallback(
    (entryKey: string, row: TrackRowModel) => {
      const meta = entityMeta.current.get(`${entryKey}:${row.key}`);
      if (meta !== undefined && canPlayMeta(meta)) {
        void dispatchPlay('action.playResult', playMeta(meta));
      }
    },
    [canPlayMeta, playMeta, dispatchPlay],
  );

  // ---- shell chrome helpers ----------------------------------------

  // Nav select: switching tabs clears the overlay stack — pushed
  // routes belong to the tab they were opened under.
  const selectTab = useCallback(
    (key: string) => {
      setTab(key);
      clearOverlays();
    },
    [clearOverlays],
  );
  // '/' — focus the explore search box (a remount tick refocuses even
  // when the tab was already active).
  const focusSearch = useCallback(() => {
    setTab('explore');
    clearOverlays();
    setSearchFocusTick((n) => n + 1);
  }, [clearOverlays]);
  // Every open lands on the player pane — a hidden stage that reopens
  // must not revive the last mode.
  const openStage = useCallback(() => {
    setStageMode('player');
    setStageOpen(true);
  }, []);
  const setStageOpenFor = useCallback(
    (open: boolean) => {
      if (open) {
        setStageMode('player');
      }
      setStageOpen(open);
    },
    [],
  );

  const toggleReordering = useCallback(() => {
    setReordering((v) => !v);
  }, []);

  const stageDownload = stageDownloadChip({
    recordingId: currentRecordingId,
    recordFor: (id) => controller.downloads.recordFor(id),
    downloadRefFor,
    chipFor: downloadChipFor,
  });
  const onStageDownload =
    currentRecordingId !== null
      ? () => onDownloadAction(currentRecordingId)
      : undefined;
  const onStageAddToPlaylist =
    currentRecordingId !== null
      ? () =>
          setPickerFor({
            kind: 'recording',
            recordingId: currentRecordingId,
          })
      : undefined;
  const onStartRadioGated = radioSeedable(radioSeedRef)
    ? onStartRadio
    : undefined;

  const resultMetaFor = useCallback(
    (key: string) => resultMeta.current.get(key),
    [],
  );
  const openRowActions = setActionsFor;
  const openPlaylistPicker = setPickerFor;

  return {
    // passthroughs the app's seams still read
    session,
    controller,
    state,
    // gate
    localeApplied,
    localeTick,
    // channels
    positionMs,
    online,
    toast,
    // nav
    tab,
    setTab,
    selectTab,
    focusSearch,
    searchFocusTick,
    // overlays
    overlayStack,
    overlay,
    pushOverlay,
    resetOverlay,
    closeOverlay,
    dismissOverlay,
    clearOverlays,
    // stage
    stageOpen,
    setStageOpen,
    setStageOpenFor,
    openStage,
    stageMode,
    setStageMode,
    reordering,
    toggleReordering,
    // models
    player,
    stagePlayer,
    heldOccurrenceId,
    queueModel,
    libraryModel,
    playlistModelFor,
    entityModelFor,
    entityFetches,
    entityRowMeta,
    homeModel,
    suggestionMeta,
    searchModel,
    settingsModel,
    correctionsModel,
    radioModel,
    lyricsModel,
    diagnostics,
    transfer,
    pickerItems,
    // transport / playback ops
    playing,
    currentRecordingId,
    peaks,
    onPlayPause,
    onToggleLike,
    advance,
    playQueueOccurrence,
    onMoveQueueItem,
    onMoveQueueItemTo,
    seekToPosition,
    canPlay,
    canPlayMeta,
    isOwned,
    localPlayable,
    playRecording,
    playMeta,
    onResultPress,
    onHomeCardPress,
    playCollectionRows,
    playPlaylist,
    playPlaylistEntry,
    entityPlayAll,
    onEntityRowPress,
    dispatchPlay,
    reportPlay,
    // search
    query,
    setQuery,
    searchState,
    runSearch,
    submitSearch,
    retrySearch,
    cancelSearch,
    applySearchText,
    recordRecentSearch,
    searchRecents,
    suggestions,
    searchSession: search,
    resultMetaFor,
    // sheets
    actionsFor,
    openRowActions,
    setActionsFor,
    closeRowActions: () => setActionsFor(null),
    rowActions,
    onRowAction,
    pickerFor,
    openPlaylistPicker,
    setPickerFor,
    closePlaylistPicker: () => setPickerFor(null),
    onPickPlaylist,
    onCreateAndPick,
    providerSlot,
    providerPicker,
    onPickProvider,
    closeProviderPicker: () => setProviderSlot(null),
    themePickerOpen,
    openThemePicker: () => {
      themeEpoch.current += 1;
      setThemePickerOpen(true);
    },
    onPickTheme: (key: string) => {
      // Each pick claims a fresh epoch — a save from an earlier pick
      // must not close this sheet.
      themeEpoch.current += 1;
      const opening = themeEpoch.current;
      const theme = THEME_ORDER.find((tag) => tag === key) ?? 'system';
      // Report a failed save and keep the sheet open so an unapplied
      // pick still reads unselected.
      void queueSettingsWrite({ theme }).then((saved) => {
        if (opening !== themeEpoch.current) {
          // A newer pick or a dismissal superseded this save — reject
          // the stale result outright: it must not close the sheet nor
          // report an outcome over the newer pick.
          return;
        }
        reportResult('settings.theme', saved);
        if (saved.ok) {
          setThemePickerOpen(false);
        }
      });
    },
    closeThemePicker: () => {
      themeEpoch.current += 1;
      setThemePickerOpen(false);
    },
    languagePickerOpen,
    openLanguagePicker: () => {
      languageEpoch.current += 1;
      setLanguagePickerOpen(true);
    },
    onPickLanguage: (key: string) => {
      const language = key === 'system' ? null : key;
      // Each pick claims a fresh epoch — a save from an earlier pick
      // must neither apply its locale nor close this sheet.
      languageEpoch.current += 1;
      const opening = languageEpoch.current;
      // Apply the locale only once the save landed — a failed save
      // must not leave the UI on a selection storage never recorded.
      // On failure the sheet stays open: the pick still reads
      // unselected, so the failure is visible without the toast.
      void queueSettingsWrite({ language }).then((saved) => {
        if (opening !== languageEpoch.current) {
          // A newer pick or a dismissal superseded this save — reject
          // the stale result outright: it must not apply a stale
          // locale, close the sheet, nor report over the newer pick.
          return;
        }
        reportResult('settings.language', saved);
        if (saved.ok) {
          applyLocale(language);
          setLanguagePickerOpen(false);
        }
      });
    },
    closeLanguagePicker: () => {
      languageEpoch.current += 1;
      setLanguagePickerOpen(false);
    },
    storefrontSheetOpen,
    storefrontDraft,
    openStorefront: () => {
      storefrontEpoch.current += 1;
      setStorefrontDraft(state.settings.storefront ?? '');
      setStorefrontSheetOpen(true);
    },
    onSubmitStorefront: (value: string) => {
      const code = value.toUpperCase();
      // The domain bound: ISO-3166 alpha-2, or null for
      // system-locale resolution.
      if (!/^[A-Z]{2}$/.test(code)) {
        setToast(t('toast.storefrontCode'));
        return;
      }
      // Dismiss only on commit — a failed save shows the toast, not
      // a closed sheet over an unchanged row.
      const opening = storefrontEpoch.current;
      void queueSettingsWrite({ storefront: code }).then((saved) => {
        reportResult('action.saveStorefront', saved);
        if (saved.ok && opening === storefrontEpoch.current) {
          setStorefrontSheetOpen(false);
        }
      });
    },
    onClearStorefront: () => {
      const opening = storefrontEpoch.current;
      void queueSettingsWrite({ storefront: null }).then((saved) => {
        reportResult('action.clearStorefront', saved);
        if (saved.ok && opening === storefrontEpoch.current) {
          setStorefrontSheetOpen(false);
        }
      });
    },
    closeStorefront: () => setStorefrontSheetOpen(false),
    qualityPickerOpen,
    openQualityPicker: () => {
      qualityEpoch.current += 1;
      setQualityPickerOpen(true);
    },
    onPickQuality: (key: string) => {
      const qualityKbps = Number(key);
      if (!Number.isSafeInteger(qualityKbps)) {
        return;
      }
      const opening = qualityEpoch.current;
      void queueSettingsWrite({ qualityKbps }).then((saved) => {
        reportResult('action.saveQuality', saved);
        if (saved.ok && opening === qualityEpoch.current) {
          setQualityPickerOpen(false);
        }
      });
    },
    closeQualityPicker: () => setQualityPickerOpen(false),
    artworkCachePickerOpen,
    onPickArtworkCache: (key: string) => {
      setArtworkCachePickerOpen(false);
      const mib = Number(key);
      if (!Number.isSafeInteger(mib)) {
        return;
      }
      const artworkCacheBytes = mib * 1024 * 1024;
      let shrinking = false;
      void queueSettingsWrite((latest) => {
        shrinking =
          artworkCacheBytes <
          (latest.artworkCacheBytes ??
            ARTWORK_CACHE_BUDGET_DEFAULT_BYTES);
        return { artworkCacheBytes };
      }).then((updated) => {
        // A shrunken cap takes effect only once rows over it are
        // evicted — sweep after the commit lands. The cache itself
        // is the app's (desktop has no artwork-cache surface).
        if (updated.ok && shrinking) {
          ports.sweepArtworkCache?.();
        }
      });
    },
    closeArtworkCache: () => setArtworkCachePickerOpen(false),
    // settings + misc ops
    onSettingsSelect,
    onSettingsToggle,
    queueSettingsWrite,
    applyLocale,
    storageText,
    refreshLocal,
    refreshUsage,
    // lyrics/radio/corrections
    fetchLyrics,
    onRetryLyrics,
    radioSeedable,
    radioSeedRef,
    actionRadioRef,
    onStartRadio,
    onStartRadioGated,
    onStopRadio,
    reviewFilter,
    setReviewFilter,
    loadReviews,
    reviewOp,
    // downloads
    downloads,
    downloadChipFor,
    downloadRefFor,
    onDownloadAction,
    stageDownload,
    onStageDownload,
    onStageAddToPlaylist,
    playlistDownloadFor,
    onPlaylistDownloadAll,
    // playlist ops
    renamePlaylist,
    deletePlaylist,
    removePlaylistEntry,
    movePlaylistEntry,
    addToPlaylist,
    onOpenCard,
    onCreatePlaylist,
    // entity fetches
    loadEntityPage,
    openEntity,
    onLoadMore,
    // transfer
    onExport,
    beginImportRead,
    onImportText,
    cancelImportRead,
    failImportRead,
    onApplyImport,
    onResetImport,
    resetTransfer,
    // diagnostics reads
    attempts,
    pendingReviews,
  };
}

// Bounds the held-sheet release: long enough for the settle spring
// (stage-sheet STAGE_SETTLE_SPRING, critically damped at 200/28) to
// land before unmount.
const STAGE_RELEASE_MS = 450;

// On-disk artwork LRU sizes, MiB — inside the domain's 16 MiB–1 GiB
// artworkCacheBytes bounds; 200 is the spec default (data.md).
const ARTWORK_CACHE_BUDGET_DEFAULT_BYTES = 200 * 1024 * 1024;
