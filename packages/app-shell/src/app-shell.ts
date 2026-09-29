/**
 * `useAppShell` — the shared shell composition both apps mount: one
 * hook call returns the whole state/callback surface (nav, overlays,
 * toasts, locale, settings writes, downloads, playability gates,
 * search, models, play funnel, sheets, transfer). Every platform
 * divergence is a documented `ports` flag in types.ts — the hook
 * never probes a platform API itself.
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
  LocalFileSource,
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
  suggestionMetaMap,
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

/** Narrows an app-extended overlay to the shell's own routes —
    a platform extra (mobile's `{ type: 'sync' }`) never is. */
function shellOverlayOf<E extends { readonly type: string }>(
  overlay: ShellOverlay | E | null | undefined,
): ShellOverlay | null {
  return overlay != null && SHELL_OVERLAY_TYPES.has(overlay.type)
    ? (overlay as ShellOverlay)
    : null;
}

const freshSignal = () => new CancellationSource().signal;

const refKey = (r: {
  readonly provider: string;
  readonly kind: string;
  readonly id: string;
}) => `${r.provider}:${r.kind}:${r.id}`;

const opContext = (
  tag: string,
  deadlineInMs: number,
  source: CancellationSource,
): OperationContext => ({
  requestId: createIds().next(tag),
  deadlineMs: Date.now() + deadlineInMs,
  signal: source.signal,
});

const reporter =
  (action: MessageId) =>
  (result: Result<unknown>) =>
    reportResult(action, result);

// ~1 Hz trailing throttle — a statfs/list probe per progress chunk
// would be hundreds of scans per download; a burst settles into one
// trailing read.
type ThrottleState = {
  last: number;
  timer: ReturnType<typeof setTimeout> | null;
};
function trailing(s: ThrottleState, run: () => void): void {
  const exec = () => {
    s.last = Date.now();
    run();
  };
  const gap = Date.now() - s.last;
  if (gap >= 1_000) {
    exec();
    return;
  }
  s.timer ??= setTimeout(() => {
    s.timer = null;
    exec();
  }, 1_000 - gap);
}

// Epoch-tagged sheet saves (theme/language): each pick claims a fresh
// epoch — a save resolving after a newer pick or a dismissal reports
// nothing, applies nothing, and closes nothing.
function pickSetting(
  epoch: { current: number },
  patch: (key: string) => Partial<Settings>,
  write: (p: Partial<Settings>) => Promise<Result<unknown>>,
  label: MessageId,
  close: () => void,
  onApplied?: (p: Partial<Settings>) => void,
): (key: string) => void {
  return (key) => {
    epoch.current += 1;
    const opening = epoch.current;
    const p = patch(key);
    void write(p).then((saved) => {
      if (opening !== epoch.current) {
        return;
      }
      reportResult(label, saved);
      if (saved.ok) {
        onApplied?.(p);
        close();
      }
    });
  };
}

const dismissSheet =
  (epoch: { current: number }, set: (v: boolean) => void) => () => {
    epoch.current += 1;
    set(false);
  };

// The storefront/quality flavor: the save reports even when stale —
// only the sheet close waits on the epoch.
function commitSetting(
  epoch: { current: number },
  patch: Partial<Settings>,
  write: (p: Partial<Settings>) => Promise<Result<unknown>>,
  label: MessageId,
  close: () => void,
): void {
  const opening = epoch.current;
  void write(patch).then((saved) => {
    reportResult(label, saved);
    if (saved.ok && opening === epoch.current) {
      close();
    }
  });
}

export function useAppShell<E extends { readonly type: string } = never>(
  deps: AppShellDeps<E>,
) {
  const { controller, state, ports } = deps;
  const { session } = controller;

  // ---- position channel ------------------------------------------
  // Position ticks ride the session's light channel — position-only
  // ticks skip the state publish, so the read subscribes here.
  const positionMs = useSyncExternalStore(
    useCallback((l: () => void) => session.subscribePosition(l), [session]),
    () => session.positionMs(),
  );

  // ---- shell chrome state ----------------------------------------
  const [tab, setTab] = useState('home');
  // `stageOpen` is the desktop Stage column collapse flag AND the
  // mobile sheet's expanded flag — ports.stageInitiallyOpen picks
  // the mount-time pose.
  const [stageOpen, setStageOpen] = useState(
    ports.stageInitiallyOpen === true,
  );
  const [stageMode, setStageMode] = useState<StageMode>('player');
  const [reordering, setReordering] = useState(false);
  const [query, setQuery] = useState('');
  // Bumped when '/' routes to explore — remounts SearchScreen so its
  // autoFocus refocuses even when the tab was already active.
  const [searchFocusTick, setSearchFocusTick] = useState(0);
  // Session-scoped, newest first — persisting them would be a
  // storage-schema decision, so they die with the app.
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
  // Sheet openings are epoch-tagged — a save resolving after dismiss+
  // reopen must not close the new sheet. Theme/language also bump on
  // dismiss and each pick, so a late save can neither close nor apply
  // a stale locale over a newer pick.
  const storefrontEpoch = useRef(0);
  const qualityEpoch = useRef(0);
  const themeEpoch = useRef(0);
  const languageEpoch = useRef(0);

  // ---- locale -----------------------------------------------------
  // setLocale mutates module state and never notifies React — every
  // apply bumps localeTick so the localized model memos rebuild their
  // t() strings (they carry it as a dep).
  const [localeTick, setLocaleTick] = useState(0);
  const applyLocale = useCallback(
    (setting: string | null | undefined) => {
      setLocale(resolveLocale(setting, systemLocaleTag()));
      setLocaleTick((tick) => tick + 1);
    },
    [],
  );
  // Every settings write serializes through the shared chain — each
  // patch merges onto the latest committed settings at execution
  // time (snapshot() is the merge base, never the React state).
  const queueSettingsWrite = useSerializedWrite(
    (next: Settings) => session.updateSettings(next),
    () => {
      const snap = session.snapshot();
      return snap.type === 'ready' ? snap.settings : null;
    },
    state.settings,
  );
  // The persisted language applies once the ready settings arrive —
  // the ready UI stays gated until that apply has landed, otherwise
  // one frame commits in the system language before flipping.
  const [localeApplied, setLocaleApplied] = useState(false);
  useEffect(() => {
    applyLocale(state.settings.language);
    setLocaleApplied(true);
  }, [applyLocale, state.settings.language]);

  // ---- diagnostics + overlay stack --------------------------------
  const [attempts, setAttempts] = useState<readonly AttemptTrace[]>([]);
  const resultMeta = useRef(new Map<string, TrackMetadata>());
  // Entity pages keep a fetch per ref so popping back to a deeper
  // screen restores its loaded content.
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
  // null = unknown (no baseline yet) — the offline banner renders
  // only on an explicit false.
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(
    () => ports.subscribeOnline(setOnline),
    [ports.subscribeOnline],
  );

  // ---- toast bus ---------------------------------------------------
  // reportResult routes its text through the module sink; the pill
  // self-clears.
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
  // Live ledger — chips, the downloads collection, and the stage
  // action all read it.
  const [downloads, setDownloads] = useState(
    () => controller.downloads.list(),
  );
  const downloadsThrottle = useRef<ThrottleState>({
    last: 0,
    timer: null,
  });
  const refreshDownloads = useCallback(() => {
    trailing(downloadsThrottle.current, () =>
      setDownloads(controller.downloads.list()),
    );
  }, [controller]);
  // Bumped after a local-folder mutation so the models re-read
  // `local()` — the source is storage-backed, not evented.
  const [localTick, setLocalTick] = useState(0);

  // Raw usage — formatted per render so the storage line follows the
  // UI language.
  const [storageUsage, setStorageUsage] = useState<{
    readonly bytes: number;
    readonly free: number;
  } | null>(null);
  // Transfer events can outpace the statfs probe — each read stamps a
  // sequence and only a success newer than the last applied one
  // lands, so a stale in-flight success can't knock out a newer one.
  const usageSeq = useRef(0);
  const usageApplied = useRef(0);
  const usageThrottle = useRef<ThrottleState>({
    last: 0,
    timer: null,
  });
  const refreshUsage = useCallback(() => {
    trailing(usageThrottle.current, () => {
      const seq = (usageSeq.current += 1);
      void controller.downloads.usage(freshSignal()).then((u) => {
        if (u.ok && seq > usageApplied.current) {
          usageApplied.current = seq;
          setStorageUsage({ bytes: u.value.bytes, free: u.value.free });
        }
      });
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
      for (const s of [usageThrottle.current, downloadsThrottle.current]) {
        if (s.timer !== null) {
          clearTimeout(s.timer);
          s.timer = null;
        }
      }
    };
  }, [controller, refreshUsage, refreshDownloads]);

  const refreshLocal = useCallback(() => {
    setLocalTick((t) => t + 1);
  }, []);

  // ---- playability gates -------------------------------------------
  // Bytes on disk — a stored download or a scanned local file.
  // Ownership is NOT the local-playback probe (ports.localPlayable /
  // canPlay): the probe answers whether the player can attach the
  // bytes, ownership answers whether 'download missing' may skip the
  // row — conflating them re-requests stored tracks and deletes their
  // files on a changed mapping.
  const isOwned = useCallback(
    (recordingId: string): boolean =>
      controller.downloads.fileFor(recordingId) !== null ||
      (controller.local()?.uriMap().has(recordingId) ?? false),
    [controller],
  );
  // The capability probe is the platform's: desktop asks the
  // controller's localPlaybackFor — gated to ledger+index-owned bytes
  // with a verdict cache; mobile's owned-bytes check IS its
  // attachable set, so it defaults to isOwned.
  const localPlayable = useCallback(
    (recordingId: string): boolean =>
      ports.localPlayable !== undefined
        ? ports.localPlayable(recordingId)
        : isOwned(recordingId),
    [ports.localPlayable, isOwned],
  );
  // Offline honesty: with connectivity explicitly down only
  // attachable owned bytes still play — remote rows wait instead of
  // firing dead attempts.
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
      const provider = state.settings.playbackProvider;
      const mapped = effectiveMapping(recording, provider);
      return (
        mapped?.ref ??
        recording.sourceRefs.find(
          (r) =>
            r.provider === provider &&
            r.kind === 'track' &&
            !isRefRejected(recording.mappings, r),
        ) ??
        null
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
      const existing = controller.downloads.recordFor(recordingId);
      if (existing === null) {
        const sourceRef = downloadRefFor(recordingId);
        if (sourceRef === null) {
          return;
        }
        void controller.downloads
          .request({ recordingId, sourceRef }, freshSignal())
          .then(reporter('action.download'));
        return;
      }
      switch (existing.state) {
        case 'requested':
        case 'transferring':
          void controller.downloads
            .cancel(existing.downloadId, freshSignal())
            .then(reporter('action.cancelDownload'));
          return;
        case 'failed_with_retry':
          // The row kept why it failed — toast that kind before the
          // retry so the tap is never a silent ↓→⚠→↓ loop.
          reportStoredDownloadError(existing.error);
          void controller.downloads
            .retry(existing.downloadId)
            .then(reporter('action.retryDownload'));
          return;
        case 'available':
          // The 'removing' transition fires before the file is gone —
          // refresh usage again once removal settles so Settings
          // doesn't display the freed bytes until the next event.
          void controller.downloads
            .remove(existing.downloadId, freshSignal())
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
  // Live reads off their surfaces, not session state — each fetch is
  // keyed to its target and canceled when superseded.
  const [lyricsFetch, setLyricsFetch] = useState<LyricsFetch | null>(
    null,
  );
  const lyricsSource = useRef<CancellationSource | null>(null);
  const [reviewFetch, setReviewFetch] = useState<ReviewFetch>({
    reviews: null,
    error: null,
  });
  const [reviewFilter, setReviewFilter] =
    useState<CorrectionsFilter>('pending');
  const [transfer, setTransfer] = useState<TransferModel>(IDLE_TRANSFER);
  const importText = useRef<string | null>(null);
  // Localized transfer strings freeze into state at write time —
  // keep the raw pieces beside them so the localeTick effect below
  // can re-derive the model in the new language (exportDetail is a
  // closure for the same reason; error details are typed, not
  // localized).
  const importPreviewRaw = useRef<{
    preview: ImportPreview;
    sourceLabel: string;
  } | null>(null);
  const importSummaryCounts = useRef<{
    tracks: number;
    likes: number;
    playlists: number;
  } | null>(null);
  const exportDoneDetail = useRef<(() => string) | null>(null);
  const patchTransfer = useCallback((patch: Partial<TransferModel>) => {
    setTransfer((prev) => ({ ...prev, ...patch }));
  }, []);
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

  // ---- search -------------------------------------------------------
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
  const suggest = useRef<{
    source: CancellationSource | null;
    seq: number;
  }>({ source: null, seq: 0 });

  const runSearch = useCallback(
    (q: string) => {
      // The platform gets the first move on commit (mobile dismisses
      // the IME). A commit also supersedes the suggest stream — the
      // draft pane closes and in-flight completions are dropped.
      ports.onSearchCommit?.();
      const trimmed = q.trim();
      suggest.current.source?.cancel();
      suggest.current = { source: null, seq: suggest.current.seq + 1 };
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
    if (trimmed !== '') {
      setSearchRecents((prev) =>
        [trimmed, ...prev.filter((r) => r !== trimmed)].slice(0, 8),
      );
    }
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

  // The deps below key on derived values, not object identities:
  // `state` republishes a fresh `settings` on every tick and
  // `searchState` swaps identity on every revision — either would
  // re-fire the debounce effect without an actual change underneath.
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
  // Keystrokes debounce into `catalog.suggest` completions — only a
  // commit (Enter or a row tap) runs catalog.search.
  useEffect(() => {
    const trimmed = query.trim();
    // An edit invalidates the prior burst at once — a completion that
    // lands mid-debounce belongs to old text and must never paint.
    suggest.current.source?.cancel();
    suggest.current = { source: null, seq: suggest.current.seq + 1 };
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
      const seq = suggest.current.seq;
      suggest.current = { source, seq };
      void providerRouter
        .suggest(
          suggestSelection,
          { input: trimmed },
          opContext('suggest', 10_000, source),
        )
        .then((result) => {
          if (suggest.current.seq === seq && !source.signal.cancelled) {
            setSuggestions(result.ok ? result.value : []);
          }
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [query, committedQuery, search, providerRouter, suggestSelection]);

  // Keep the row→metadata map in sync so a tap can recover the
  // TrackMetadata the session needs for addAndPlay; the first rows
  // also feed the session's advisory warm.
  useEffect(() => {
    const map = resultMeta.current;
    map.clear();
    if (searchState.type === 'content') {
      searchState.page.items.forEach((meta, index) => {
        map.set(toSearchRowModel(meta, index).key, meta);
      });
      const head = searchState.page.items.slice(0, 9);
      session.prewarm({
        sourceRefs: head.map((meta) => meta.sourceRef),
        tracks: head,
      });
    }
  }, [searchState, session]);

  const [pendingReviews, setPendingReviews] = useState<number | null>(
    null,
  );

  // Diagnostics + pending-review count load on each settings-tab
  // visit — persisted traces and live rows, never session snapshots.
  useEffect(() => {
    if (tab !== 'settings') {
      return;
    }
    const source = new CancellationSource();
    void controller.storage
      .loadAttempts(DIAGNOSTICS_LIMIT, opContext('diag', 15_000, source))
      .then((result) => {
        if (!source.signal.cancelled && result.ok) {
          setAttempts(result.value);
        }
      });
    void session.listMatchReviews().then((result) => {
      if (!source.signal.cancelled) {
        setPendingReviews(result.ok ? result.value.length : null);
      }
    });
    return () => source.cancel();
  }, [tab, controller, session]);

  // ---- models ------------------------------------------------------
  // Model memos key on the slices they read — published snapshots
  // keep stable refs for unchanged sections, and position-only ticks
  // (which skip the state channel) flow through positionMs.
  // activeRecordingId is the "playing" row mark — an engaged attempt
  // (preparing/buffering/playing); idle/paused/failed mark none.
  const activeRecordingId =
    state.playback.type === 'idle' ||
    state.playback.type === 'paused' ||
    state.playback.type === 'failed'
      ? null
      : state.playback.recordingId;
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
  // lands before unmount. The snapshot sits in a ref — mirroring the
  // live model into state would double the per-tick render.
  // ports.holdEndedPlayer gates the whole mount — desktop's stage
  // column simply unmounts.
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

  // playback.type names only the latest failure — the hook carries
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
    return toQueueModel({
      queue: state.queue,
      recordings: state.recordings,
      likes: state.likes,
      // Same honesty rule as the library rows: offline + unattachable
      // marks 'unavailable' so a dead press isn't a surprise.
      unavailableRecordingIds:
        online === false
          ? new Set(
              state.queue.occurrences
                .map((o) => o.recordingId)
                .filter((id) => !localPlayable(id)),
            )
          : undefined,
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
    // ports.localCatalog: local index rows (provenance 'local')
    // shadow the session's in-memory copies — a scan commits fresher
    // tags than restore loaded. Without the port the session rows
    // render as-is.
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
        download: chipsByRecording.get(recordingId) ?? row.download,
        playing: recordingId === activeRecordingId ? true : row.playing,
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
    activeRecordingId,
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
      if (model === null) {
        return model;
      }
      const offline = online === false;
      return {
        ...model,
        entries: model.entries.map((entry) => {
          const download =
            downloadChipFor(entry.recordingId) ?? entry.row.download;
          const owned =
            download === 'stored' || localPlayable(entry.recordingId);
          return {
            ...entry,
            row: {
              ...entry.row,
              playing:
                entry.recordingId === activeRecordingId
                  ? true
                  : entry.row.playing,
              download,
              ...(offline && !owned
                ? { state: 'unavailable' as const, note: t('note.offline') }
                : {}),
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
      activeRecordingId,
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
  // Row-key → TrackMetadata for entity items (resultMeta's contract)
  // — namespaced per stack entry so two entity screens never collide.
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
    const localUris = controller.local()?.uriMap();
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
            playing: activeRecordingId === rec.id,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    searchState,
    state.recordings,
    state.likes,
    activeRecordingId,
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
  const suggestionMeta = useMemo((): Map<string, TrackMetadata> => {
    if (searchState.type === 'content') {
      // ports.homeSuggestionLimit: desktop bounded the card lookup to
      // the first 12 results; mobile searched the whole page (unset).
      const items =
        ports.homeSuggestionLimit === undefined
          ? searchState.page.items
          : searchState.page.items.slice(0, ports.homeSuggestionLimit);
      // Mobile's lookup used page-order find() — first duplicate wins;
      // desktop's map overwrote — last wins.
      return suggestionMetaMap(
        items,
        ports.strictHomeCardKeys === true ? 'firstWins' : 'lastWins',
      );
    }
    return new Map();
  }, [searchState, ports.homeSuggestionLimit, ports.strictHomeCardKeys]);

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
    const local = controller.local();
    const model = toSettingsModel(state.settings, diagnostics, {
      storageText:
        storageUsage === null
          ? null
          : formatBytes(storageUsage.bytes, storageUsage.free),
      // `localSupported` itself is the app's call: desktop probes the
      // live source, mobile asks its tag-reader module.
      localSupported: extras.localSupported,
      localFolderCount: local?.list().length,
      localSources: local
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
    storageUsage,
    controller,
    downloads,
    ports.settingsExtras,
    ports.omitSettingsRows,
    localTick,
    localeTick,
  ]);

  // ---- play funnel -------------------------------------------------
  // The ambiguous-match gate parks candidates in a review the user
  // must resolve — a play that hits it opens the corrections surface
  // instead of dying on a dead queue item.
  //
  // reportPlayError is the single error funnel: the play promise and
  // the published `playback.failed` carry the SAME error object, so
  // identity-dedupe reports each failure once regardless of channel.
  // The dedupe engages only under ports.trackAttemptActions — the
  // watcher is desktop's (mobile has no late-verdict channel).
  const lastPlayErrorRef = useRef<AppError | null>(null);
  // Action labels travel with the ATTEMPT, not the button: a pause
  // during an in-flight prepare must not steal the play attempt's
  // name. dispatchPlay records the pending action with a seq; the
  // watcher binds it to the attemptId at publish and clears on settle
  // so engine-advanced attempts fall back to the neutral label.
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
  // A failure that lands after the play promise resolved reaches the
  // UI only through `playback.failed` — the watcher reports it through
  // the same deduped funnel, with the attempt's recorded action.
  // ports.trackAttemptActions mounts it — mobile's op promises cover
  // its verdicts themselves.
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
      const queued =
        queuedOccurrenceFor(state.queue, recordingId) ??
        (await session.enqueueRecording(recordingId).then((r) => {
          if (!r.ok) {
            reportResult('action.enqueueTrack', r);
          }
          return r.ok ? r.value : null;
        }));
      if (queued !== null) {
        await dispatchPlay('common.play', session.playOccurrence(queued));
      }
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

  // The gate tests the same target the engine would land on in walk
  // space (dealt order under shuffle, canonical otherwise) — an
  // attachable target still advances offline.
  // ports.gateAdvanceAlways: desktop tests on EVERY advance (a
  // missing walk target no-ops even online); mobile tests only while
  // connectivity is explicitly down.
  const advance = useCallback(
    (method: 'next' | 'previous') => {
      const { occurrences, currentOccurrenceId } = state.queue;
      if (ports.gateAdvanceAlways === true || online === false) {
        // Position ticks ride the light channel — read it live, not
        // the (possibly position-stale) published snapshot.
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
  // the materialized recording is playable only when the player can
  // attach its bytes — a provider ref alone would start a remote
  // attempt the UI says waits for connectivity.
  const canPlayMeta = useCallback(
    (meta: TrackMetadata): boolean => {
      if (online !== false) {
        return true;
      }
      const recording = state.recordings.find((r) =>
        r.sourceRefs.some((s) => refKey(s) === refKey(meta.sourceRef)),
      );
      return recording !== undefined && localPlayable(recording.id);
    },
    [online, state.recordings, localPlayable],
  );

  // The playRecording dedupe for metadata taps: a tap's source ref
  // can match a queued occurrence (or its recording's refs) before
  // the metadata materializes into one.
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

  // The shared result-tap funnel: the gate fires inside so callers'
  // side effects (recordRecentSearch) run only on a playable tap.
  const playCheckedMeta = useCallback(
    (meta: TrackMetadata) => {
      if (canPlayMeta(meta)) {
        void dispatchPlay('action.playResult', playMeta(meta));
      }
    },
    [canPlayMeta, dispatchPlay, playMeta],
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
        playCheckedMeta(meta);
      }
    },
    [
      canPlayMeta,
      playCheckedMeta,
      playRecording,
      query,
      recordRecentSearch,
      ports.localCatalog,
    ],
  );

  // A home card carries either a materialized recording id (recents /
  // resume rails) or a suggestion's `${provider}:${id}` key; the meta
  // map covers every rendered suggestion card — a miss means a
  // recording-keyed card. ports.strictHomeCardKeys: mobile resolves a
  // recording only when the key sits in the recents rail — an
  // unrecognized suggestion key no-ops instead of enqueueing a
  // provider-keyed 'recordingId' that can only fail; desktop presses
  // any unmatched key through the recording path.
  const onHomeCardPress = useCallback(
    (card: { readonly key: string }) => {
      // strictHomeCardKeys (mobile): a recents-rail card is a
      // recording first — a key collision still plays the recording.
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
        playCheckedMeta(meta);
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
      playCheckedMeta,
      playRecording,
      searchState,
      recordRecentSearch,
      homeModel,
      ports.strictHomeCardKeys,
    ],
  );

  // ---- settings handlers -------------------------------------------
  const onSettingsSelect = useCallback(
    (key: string) => {
      // A committed mutation lands on the instance the op ran on —
      // ports.afterLocalMutation owns the post-commit projection
      // (the apps disagree on the mid-flight rehydrate swap).
      const open = (epoch: { current: number }, set: (v: boolean) => void) => {
        epoch.current += 1;
        set(true);
      };
      const localMutate = (
        label: MessageId,
        op: (local: LocalFileSource) => Promise<Result<unknown>>,
      ) => {
        const local = controller.local();
        if (local === null) {
          return;
        }
        void op(local).then((r) => {
          reportResult(label, r);
          if (r.ok) {
            ports.afterLocalMutation(local, refreshLocal);
          }
        });
      };
      switch (key) {
        case 'theme':
          open(themeEpoch, setThemePickerOpen);
          return;
        case 'language':
          open(languageEpoch, setLanguagePickerOpen);
          return;
        case 'catalogProvider':
        case 'playbackProvider':
        case 'lyricsProvider':
        case 'radioProvider':
          setProviderSlot(key);
          return;
        case 'exportLibrary':
        case 'importLibrary':
          importText.current = null;
          importPreviewRaw.current = null;
          setTransfer(IDLE_TRANSFER);
          pushOverlay({ type: 'transfer' });
          return;
        case 'storefront':
          open(storefrontEpoch, setStorefrontSheetOpen);
          setStorefrontDraft(state.settings.storefront ?? '');
          return;
        case 'qualityKbps':
          open(qualityEpoch, setQualityPickerOpen);
          return;
        case 'removeAllDownloads':
          void controller.downloads.removeAll(freshSignal()).then((r) => {
            reportResult('settings.removeAllDownloads', r);
            refreshUsage();
          });
          return;
        case 'sync':
          // The row's destination is the platform's — mobile pushes
          // its sync overlay; desktop scrolls+focuses the inline one.
          if (ports.openSyncOverlay !== undefined) {
            pushOverlay(ports.openSyncOverlay);
          } else {
            ports.openSync?.();
          }
          return;
        case 'artworkCacheBytes':
          setArtworkCachePickerOpen(true);
          return;
        case 'addLocalFolder':
          localMutate('settings.addLocalFolder', (l) =>
            l.addFolder(freshSignal()),
          );
          return;
        case 'rescanLocal':
        case 'localSources':
          localMutate('settings.rescanLocal', (l) =>
            l.rescan(undefined, freshSignal()),
          );
          return;
        default:
          if (key.startsWith('localSourceRemove:')) {
            localMutate('action.removeLocalFolder', (l) =>
              l.removeSource(
                key.slice('localSourceRemove:'.length),
                freshSignal(),
              ),
            );
          }
          // downloadStorage is display-only.
      }
    },
    [
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
  // recordingId|attemptId. The port borrows the live stream handle,
  // never owns it; null where the platform has no decode path (iOS).
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
    // queue's mode, not the transport: during a retry backoff playback
    // publishes 'preparing' with no handle and the tap must still
    // pause; a natively-arrived transport 'paused' (queue still
    // 'playing') means the tap resumes.
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
    // pause/resume keep the SAME attempt identity — never a
    // pendingAttempt claim; their promise reports under their own
    // action.
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
    (occurrenceId: string, toIndex: number) =>
      void session.moveOccurrence(occurrenceId, toIndex),
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
      void session
        .getLyrics(recordingId, opContext('lyrics', 15_000, source))
        .then((result) => {
          setLyricsFetch((prev) =>
            prev === null ||
            prev.recordingId !== recordingId ||
            source.signal.cancelled
              ? prev
              : {
                  recordingId,
                  sheet: result.ok ? result.value : null,
                  error: result.ok ? null : result.error,
                  loading: false,
                },
          );
        });
    },
    [session],
  );

  // Lyrics load lazily — while the Stage shows lyrics mode — and
  // refetch on track change. ports.lyricsWhileOpen widens the
  // trigger to any open stage (mobile prefetches so the tab switch
  // is instant). Leaving lyrics mode keeps the last sheet cached.
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
  // it to player mode. Explicit opens set the mode before expanding,
  // so this listens only for the track change, not the open flip.
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

  // Lyrics highlight rides a smoothed clock between the engine's
  // sparse position ticks; it ticks only while the pane is on screen.
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
  // Seeds route by the ref's own provider — a track is seedable only
  // when THAT provider declares radio.seed.
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
  // the same derivation the seed op uses so the gate mirrors it.
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
  // row seeds its first source ref.
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
      void session.startRadio(ref).then(reporter('stage.radio.start'));
    }
  }, [session, radioSeedRef, radioSeedable]);

  const onStopRadio = useCallback(() => {
    reportResult('action.stopRadio', session.stopRadio());
  }, [session]);

  // ---- corrections (live read + serialized review ops) -----------

  // The queue reloads on every corrections-overlay open — live
  // reads, never stale session state.
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

  // A landed verdict reloads the queue; a failed op surfaces its
  // typed error as the screen's error state.
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
    [loadReviews],
  );

  // ---- library transfer (export write · import preview) -----------

  const onExport = useCallback(() => {
    patchTransfer({ exportPhase: 'working', exportDetail: null });
    void session.exportLibrary().then(async (result) => {
      if (!result.ok) {
        patchTransfer({
          exportPhase: 'error',
          exportDetail: errorText(result.error),
        });
        return;
      }
      const name = `auqw-library-${new Date().toISOString().slice(0, 10)}.json`;
      const outcome = await ports
        .exportJson(result.value.json, name)
        .catch((): ExportWrite => ({ kind: 'error' }));
      if (outcome.kind === 'done') {
        exportDoneDetail.current = outcome.detail;
        patchTransfer({
          exportPhase: 'done',
          exportDetail: outcome.detail(),
        });
        return;
      }
      patchTransfer(
        outcome.kind === 'cancelled'
          ? { exportPhase: 'idle' }
          : {
              exportPhase: 'error',
              exportDetail: t('transfer.exportWriteFailed'),
            },
      );
    });
  }, [session, ports.exportJson, patchTransfer]);

  // The shared side of an import read: beginImportRead arms the
  // 'reading' phase, the platform's pick hands text + display name
  // to onImportText; cancelImportRead covers every backed-out shape
  // (dismissed picker, AbortError, canceled pick) and failImportRead
  // an unreadable file.
  const beginImportRead = useCallback(() => {
    importPreviewRaw.current = null;
    patchTransfer({
      importPhase: 'reading',
      importDetail: null,
      preview: null,
    });
  }, [patchTransfer]);

  const onImportText = useCallback(
    (text: string, sourceLabel: string) => {
      // Preview validates without mutating — a typed error here is
      // the honest reject; nothing was applied.
      const preview = previewImport(text);
      if (!preview.ok) {
        importPreviewRaw.current = null;
        patchTransfer({
          importPhase: 'error',
          importDetail: t('error.importInvalid'),
          preview: null,
        });
        return;
      }
      importText.current = text;
      importPreviewRaw.current = { preview: preview.value, sourceLabel };
      patchTransfer({
        importPhase: 'preview',
        preview: toImportPreviewModel(preview.value, sourceLabel),
      });
    },
    [patchTransfer],
  );

  const cancelImportRead = useCallback(() => {
    patchTransfer({ importPhase: 'idle' });
  }, [patchTransfer]);

  const failImportRead = useCallback(() => {
    importPreviewRaw.current = null;
    patchTransfer({
      importPhase: 'error',
      importDetail: t('transfer.readFailed'),
      preview: null,
    });
  }, [patchTransfer]);

  const onApplyImport = useCallback(() => {
    const text = importText.current;
    if (text === null) {
      return;
    }
    patchTransfer({ importPhase: 'applying' });
    // replaceLibrary drains the download manager before the import
    // swaps sections, then rehydrates the media owners; the returned
    // preview doubles as the applied-summary counts.
    void controller.replaceLibrary(text, freshSignal()).then((result) => {
      if (!result.ok) {
        patchTransfer({
          importPhase: 'error',
          importDetail: errorText(result.error),
        });
        return;
      }
      importText.current = null;
      const counts = result.value.counts;
      importSummaryCounts.current = {
        tracks: counts.recordings,
        likes: counts.likes,
        playlists: counts.playlists,
      };
      patchTransfer({
        importPhase: 'done',
        importDetail: t('transfer.importSummary', {
          tracks: counts.recordings,
          likes: counts.likes,
          playlists: counts.playlists,
        }),
      });
    });
  }, [controller, patchTransfer]);

  const onResetImport = useCallback(() => {
    importText.current = null;
    importPreviewRaw.current = null;
    patchTransfer({ importPhase: 'idle', importDetail: null, preview: null });
  }, [patchTransfer]);

  // Full reset — unlike onResetImport (import stage only), the
  // deep-link shell wipes both phases before driving a fresh leg.
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
            [key]: {
              ...cur,
              page: result.ok ? result.value : null,
              error: result.ok ? null : result.error,
              loading: false,
            },
          };
        });
      });
    },
    [session],
  );

  const openEntity = useCallback(
    (ref: EntityRef) => {
      // Re-opening the entity already on top just reloads it.
      const top = shellOverlayOf(overlay);
      if (
        top?.type !== 'entity' ||
        entityRefKey(top.ref) !== entityRefKey(ref)
      ) {
        pushOverlay({ type: 'entity', ref });
      }
      loadEntityPage(ref);
    },
    [overlay, pushOverlay, loadEntityPage],
  );

  const onLoadMore = useCallback(() => {
    const route = shellOverlayOf(overlay);
    const cur =
      route?.type === 'entity'
        ? entityFetches[entityRefKey(route.ref)]
        : undefined;
    const continuation = cur?.page?.continuation;
    if (
      cur === undefined ||
      cur.page === null ||
      continuation == null ||
      cur.loadingMore
    ) {
      return;
    }
    const key = entityRefKey(cur.ref);
    // The wire has no continuation payload — the token is carried
    // back as the ref id so ref-scoped routing returns it to the
    // provider that minted it (the only honest interpretation the
    // port supports).
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
          latest.page.items.map((m) => refKey(m.sourceRef)),
        );
        const fresh = result.value.items.filter(
          (m) => !seen.has(refKey(m.sourceRef)),
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
  const playRefFor = useCallback(
    (recordingId: string, selectedRef: SourceRef | null): SourceRef | null =>
      ports.preferOwnedRef === true && isOwned(recordingId)
        ? null
        : selectedRef,
    [isOwned, ports.preferOwnedRef],
  );

  const playPlaylist = useCallback(
    (model: ReturnType<typeof playlistModelFor>) => {
      const playable =
        model === null
          ? []
          : model.entries.filter((entry) => canPlay(entry.recordingId));
      if (playable.length === 0) {
        return;
      }
      void dispatchPlay(
        'action.playPlaylist',
        session.playRecordings(
          playable.map((entry) => ({
            recordingId: entry.recordingId,
            selectedRef: playRefFor(entry.recordingId, entry.selectedRef),
          })),
        ),
      );
    },
    [session, canPlay, dispatchPlay, playRefFor],
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
            selectedRef: playRefFor(entry.recordingId, entry.selectedRef),
          },
        ]),
      );
    },
    [session, canPlay, playRefFor, dispatchPlay],
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
        .requestAll(requests, freshSignal())
        .then(reporter('action.download'));
    },
    [controller],
  );

  // ---- playlist adds + row actions ---------------------------------

  const addToPlaylist = useCallback(
    async (playlistId: string, target: ActionTarget) => {
      const recordingId =
        target.kind === 'recording'
          ? target.recordingId
          : await session.ensureRecording(target.meta).then((r) => {
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
        if (created.ok) {
          if (target !== null) {
            void addToPlaylist(created.value, target);
          }
        } else {
          reportResult('action.createPlaylist', created);
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
              .then(reporter('action.toggleLike'));
          }
          break;
        case 'enqueue':
          void (target.kind === 'recording'
            ? session.enqueueRecording(target.recordingId)
            : session.enqueueMetadata(target.meta)
          ).then(reporter('action.addToQueue'));
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
                .remove(row.downloadId, freshSignal())
                .then((r) => {
                  reportResult('action.removeDownload', r);
                  refreshUsage();
                });
            }
          }
          break;
        case 'radio':
          // Track-seeded at this release: a metadata row seeds its own
          // ref; a library row seeds its first source ref. The action
          // only renders when the seed's provider declares radio.seed,
          // but guard the op too — state may shift between the two.
          if (actionRadioRef !== null && radioSeedable(actionRadioRef)) {
            void session
              .startRadio(actionRadioRef)
              .then(reporter('stage.radio.start'));
          }
          break;
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
      actionRadioRef,
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
        if (created.ok) {
          pushOverlay({ type: 'playlist', playlistId: created.value });
        } else {
          reportResult('action.createPlaylist', created);
        }
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
        .then(reporter('action.renamePlaylist'));
    },
    [session],
  );
  const deletePlaylist = useCallback(
    (playlistId: string) => {
      ports.haptic?.('warning');
      void session
        .deletePlaylist(playlistId)
        .then(reporter('action.deletePlaylist'));
    },
    [session, ports.haptic],
  );
  const removePlaylistEntry = useCallback(
    (entryId: string) => {
      void session
        .removePlaylistEntry(entryId)
        .then(reporter('action.removeTrack'));
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
        .then(reporter('action.reorderPlaylist'));
    },
    [session],
  );

  // Entity-screen play — ports.entityPlayRequiresCanPlay gates the
  // desktop canPlayMeta filter + empty early-return; mobile plays
  // every fetched row.
  const entityPlayAll = useCallback(
    (fetch: EntityFetch | null, entryKey: string, shuffle: boolean) => {
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
        session.playMetadata(
          metas,
          shuffle ? { shuffle: true } : undefined,
        ),
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
      if (meta !== undefined) {
        playCheckedMeta(meta);
      }
    },
    [playCheckedMeta],
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

  // ---- picker sheets (epoch-gated serialized writes) ---------------
  // These handlers feed dep arrays (mobile's BackHandler chain) — they
  // must be referentially stable, not per-render closures.
  const openRowActions = setActionsFor;
  const openPlaylistPicker = setPickerFor;
  const closeRowActions = useCallback(() => setActionsFor(null), []);
  const closePlaylistPicker = useCallback(() => setPickerFor(null), []);
  const closeProviderPicker = useCallback(() => setProviderSlot(null), []);

  // A failed save keeps the sheet open so an unapplied pick still
  // reads unselected.
  const onPickTheme = useMemo(
    () =>
      pickSetting(
        themeEpoch,
        (key) => ({
          theme: THEME_ORDER.find((tag) => tag === key) ?? 'system',
        }),
        queueSettingsWrite,
        'settings.theme',
        () => setThemePickerOpen(false),
      ),
    [queueSettingsWrite],
  );
  const closeThemePicker = useMemo(
    () => dismissSheet(themeEpoch, setThemePickerOpen),
    [],
  );
  // The locale applies only once the save landed — a failed save
  // must not leave the UI on a selection storage never recorded.
  const onPickLanguage = useMemo(
    () =>
      pickSetting(
        languageEpoch,
        (key) => ({ language: key === 'system' ? null : key }),
        queueSettingsWrite,
        'settings.language',
        () => setLanguagePickerOpen(false),
        (p) => applyLocale(p.language),
      ),
    [applyLocale, queueSettingsWrite],
  );
  const closeLanguagePicker = useMemo(
    () => dismissSheet(languageEpoch, setLanguagePickerOpen),
    [],
  );
  // The domain bound: ISO-3166 alpha-2, or null for system-locale
  // resolution. Dismiss only on commit — a failed save shows the
  // toast, not a closed sheet over an unchanged row.
  const onSubmitStorefront = useCallback(
    (value: string) => {
      const code = value.toUpperCase();
      if (!/^[A-Z]{2}$/.test(code)) {
        setToast(t('toast.storefrontCode'));
        return;
      }
      commitSetting(
        storefrontEpoch,
        { storefront: code },
        queueSettingsWrite,
        'action.saveStorefront',
        () => setStorefrontSheetOpen(false),
      );
    },
    [queueSettingsWrite],
  );
  const onClearStorefront = useCallback(
    () =>
      commitSetting(
        storefrontEpoch,
        { storefront: null },
        queueSettingsWrite,
        'action.clearStorefront',
        () => setStorefrontSheetOpen(false),
      ),
    [queueSettingsWrite],
  );
  const closeStorefront = useCallback(
    () => setStorefrontSheetOpen(false),
    [],
  );
  const onPickQuality = useCallback(
    (key: string) => {
      const qualityKbps = Number(key);
      if (Number.isSafeInteger(qualityKbps)) {
        commitSetting(
          qualityEpoch,
          { qualityKbps },
          queueSettingsWrite,
          'action.saveQuality',
          () => setQualityPickerOpen(false),
        );
      }
    },
    [queueSettingsWrite],
  );
  const closeQualityPicker = useCallback(
    () => setQualityPickerOpen(false),
    [],
  );
  const onPickArtworkCache = useCallback(
    (key: string) => {
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
          (latest.artworkCacheBytes ?? ARTWORK_CACHE_BUDGET_DEFAULT_BYTES);
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
    [ports.sweepArtworkCache, queueSettingsWrite],
  );
  const closeArtworkCache = useCallback(
    () => setArtworkCachePickerOpen(false),
    [],
  );

  return {
    // gate
    localeApplied,
    localeTick,
    // channels
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
    searchModel,
    settingsModel,
    correctionsModel,
    radioModel,
    lyricsModel,
    transfer,
    pickerItems,
    // transport / playback ops
    peaks,
    onPlayPause,
    onToggleLike,
    advance,
    playQueueOccurrence,
    onMoveQueueItem,
    onMoveQueueItemTo,
    seekToPosition,
    canPlay,
    playRecording,
    onResultPress,
    onHomeCardPress,
    playCollectionRows,
    playPlaylist,
    playPlaylistEntry,
    entityPlayAll,
    onEntityRowPress,
    reportPlay,
    // search
    query,
    setQuery,
    searchState,
    submitSearch,
    retrySearch,
    cancelSearch,
    applySearchText,
    searchRecents,
    suggestions,
    searchSession: search,
    resultMetaFor,
    // sheets
    actionsFor,
    setActionsFor,
    openRowActions,
    closeRowActions,
    rowActions,
    onRowAction,
    pickerFor,
    setPickerFor,
    openPlaylistPicker,
    closePlaylistPicker,
    onPickPlaylist,
    onCreateAndPick,
    providerSlot,
    providerPicker,
    onPickProvider,
    closeProviderPicker,
    themePickerOpen,
    // A failed save keeps the sheet open so an unapplied pick still
    // reads unselected.
    onPickTheme,
    closeThemePicker,
    languagePickerOpen,
    // The locale applies only once the save landed — a failed save
    // must not leave the UI on a selection storage never recorded.
    onPickLanguage,
    closeLanguagePicker,
    storefrontSheetOpen,
    storefrontDraft,
    // The domain bound: ISO-3166 alpha-2, or null for system-locale
    // resolution. Dismiss only on commit — a failed save shows the
    // toast, not a closed sheet over an unchanged row.
    onSubmitStorefront,
    onClearStorefront,
    closeStorefront,
    qualityPickerOpen,
    onPickQuality,
    closeQualityPicker,
    artworkCachePickerOpen,
    onPickArtworkCache,
    closeArtworkCache,
    // settings + misc ops
    onSettingsSelect,
    onSettingsToggle,
    queueSettingsWrite,
    // lyrics/radio/corrections
    onRetryLyrics,
    onStartRadioGated,
    onStopRadio,
    setReviewFilter,
    loadReviews,
    reviewOp,
    // downloads
    downloadRefFor,
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
  };
}

// Bounds the held-sheet release: long enough for the settle spring
// (stage-sheet STAGE_SETTLE_SPRING, critically damped at 200/28) to
// land before unmount.
const STAGE_RELEASE_MS = 450;

// On-disk artwork LRU sizes, MiB — inside the domain's 16 MiB–1 GiB
// artworkCacheBytes bounds; 200 is the spec default (data.md).
const ARTWORK_CACHE_BUDGET_DEFAULT_BYTES = 200 * 1024 * 1024;
