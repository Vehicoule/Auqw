import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  CancellationSource,
  ProviderRouter,
  SearchSession,
  appError,
  collectSyncDeltaDocs,
  effectiveMapping,
  err,
  isMatchGate,
  isRefRejected,
  isSyncDelta,
  ok,
  parseSyncDeltaDocs,
  previewImport,
  selectionFromSettings,
  serializeSyncDeltaDocs,
} from '@auqw/application';
import type {
  AppError,
  AttemptTrace,
  EntityRef,
  ImportPreview,
  OperationContext,
  ReadySession,
  Result,
  SearchState,
  SessionState,
  Settings,
  SourceRef,
  TrackMetadata,
} from '@auqw/application';
import {
  AddToPlaylistSheet,
  AppStack,
  CollectionScreen,
  CorrectionsScreen,
  DesktopChrome,
  EmptyState,
  EntityScreen,
  ErrorState,
  HomeScreen,
  LibraryScreen,
  LoadingState,
  NowPlayingScreen,
  PairingSheet,
  PlaylistScreen,
  ProviderPickerSheet,
  PushScreen,
  RowActionsSheet,
  SearchScreen,
  SettingsScreen,
  SheetScreen,
  StackItem,
  Text,
  ThemeProvider,
  TransferScreen,
  ValueFieldSheet,
  entityIdForRef,
  languageOptionKey,
  languageOptions,
  resolveLocale,
  setLocale,
  systemLocaleTag,
  t,
  toCollectionModel,
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
  toSearchRowModel,
  toSettingsModel,
  toSyncPanel,
  useTheme,
} from '@auqw/ui-web';
import type {
  CollectionRowModel,
  CorrectionsFilter,
  DiagnosticsModel,
  DownloadChip,
  LyricsModel,
  StageMode,
  TrackRowModel,
  TransferModel,
} from '@auqw/ui-web';
import {
  DIAGNOSTICS_LIMIT,
  IDLE_TRANSFER,
  SEARCH_LIMIT,
  THEME_ORDER,
  attemptLabel,
  entityRefKey,
  formatBytes,
  greeting,
  navItems,
  providerPickerModel,
  qualityOptions,
  reportResult,
  setToastSink,
  themeOptions,
  toSearchModel,
  useOverlayStack,
  useSerializedWrite,
  useSmoothedPosition,
} from '@auqw/ui-shared';
import type {
  ActionTarget,
  Boot,
  EntityFetch,
  LyricsFetch,
  MessageId,
  OverlayEntry,
  ProviderSlot,
  ReviewFetch,
} from '@auqw/ui-shared';
import type {
  SyncDeviceInfo,
  SyncNearbyPeer,
  SyncPairingResult,
  SyncStatusResult,
} from '../shared/contract.ts';
import type { ThemeSource } from '@auqw/design-tokens/adaptive';
import { isShellError } from '../shared/errors.ts';
import { createSessionController } from './controller.ts';
import type { SessionController } from './controller.ts';
import { createClock, createIds } from '@auqw/application';
import { shellToAppError } from './ipc-errors.ts';
import { createWebPeaksPort } from './web-peaks.ts';
import { useWaveformPeaks } from '@auqw/ui-shared';
import type { PeaksTarget } from '@auqw/ui-shared';

// Boot and gate strings render before the ready settings arrive —
// seed the UI language from the system tag so those first screens
// translate too; Main still pins the persisted language afterwards.
setLocale(resolveLocale(undefined, systemLocaleTag()));

function App() {
  const [attempt, setAttempt] = useState(0);
  const [boot, setBoot] = useState<Boot<SessionController>>({
    type: 'loading',
  });

  useEffect(() => {
    let disposed = false;
    let controller: SessionController | null = null;
    setBoot({ type: 'loading' });
    void (async () => {
      try {
        // createSessionController runs session.restore() itself —
        // restore never throws; its Result surfaces through session
        // state as 'restore-failed'.
        const created = await createSessionController(window.auqw);
        if (disposed) {
          await created.dispose();
          return;
        }
        controller = created;
        setBoot({ type: 'ready', controller: created });
      } catch (thrown) {
        if (!disposed) {
          setBoot({
            type: 'failed',
            message:
              thrown instanceof Error
                ? thrown.message
                : t('boot.failedMessage'),
          });
        }
      }
    })();
    return () => {
      disposed = true;
      const c = controller;
      controller = null;
      if (c !== null) {
        void c.dispose();
      }
    };
  }, [attempt]);

  return boot.type === 'ready' ? (
    <Shell controller={boot.controller} />
  ) : (
    <ThemeProvider theme="system">
      <BootGate boot={boot} onRetry={() => setAttempt((n) => n + 1)} />
    </ThemeProvider>
  );
}

function BootGate({
  boot,
  onRetry,
}: {
  readonly boot: Boot<SessionController>;
  readonly onRetry: () => void;
}) {
  return (
    <div
      className="uw-boot"
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--canvas)',
      }}
    >
      {boot.type === 'failed' ? (
        <ErrorState
          title={t('boot.startFailed')}
          hint={boot.message}
          onRetry={onRetry}
        />
      ) : (
        <LoadingState title={t('boot.loadingPlugins')} />
      )}
    </div>
  );
}

function Shell({ controller }: { readonly controller: SessionController }) {
  // `Session.subscribe` uses instance state — pass a bound wrapper,
  // not the unbound method (an unbound `this.#listeners` throws and
  // React unmounts the tree, leaving a blank window on boot).
  const subscribe = useCallback(
    (listener: () => void) => controller.session.subscribe(listener),
    [controller.session],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => controller.session.snapshot(),
  );
  const theme = state.type === 'ready' ? state.settings.theme : 'system';
  // The OS source is only worth watching while 'adaptive' is picked —
  // subscribing is what powers up main's palette watchers.
  const [themeSource, setThemeSource] = useState<ThemeSource | null>(null);
  useEffect(() => {
    if (theme !== 'adaptive') {
      setThemeSource(null);
      return undefined;
    }
    return window.auqw.theme.subscribe((event) => {
      setThemeSource(event.source);
    });
  }, [theme]);
  return (
    <ThemeProvider theme={theme} source={themeSource}>
      <ChromeSchemeReporter />
      {state.type === 'ready' ? (
        <Main controller={controller} state={state} />
      ) : (
        <SessionGate state={state} controller={controller} />
      )}
    </ThemeProvider>
  );
}

/** Chrome integration: pushes the resolved scheme to main so the
    titlebar overlay matches the canvas even when the user picked an
    explicit scheme, stamps the platform so CSS can clear the macOS
    traffic lights, and measures the caption-button zone so toolbar
    controls keep clear of it on win32/linux. */
function ChromeSchemeReporter(): null {
  const { scheme, canvas, textBright } = useTheme();
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.platform = window.auqw.chrome.platform;
    // getTitlebarAreaRect covers the free title area — the caption
    // buttons occupy what's left of the window's top-right.
    const wco = (
      navigator as Navigator & {
        windowControlsOverlay?: {
          readonly visible: boolean;
          getTitlebarAreaRect(): DOMRect;
          addEventListener(type: 'geometrychange', listener: () => void): void;
          removeEventListener(type: 'geometrychange', listener: () => void): void;
        };
      }
    ).windowControlsOverlay;
    const measureCaptions = () => {
      // No overlay API at all → keep the CSS fallback rather than
      // forcing 0 and losing the clearance guess on hosts without it.
      if (wco === undefined) {
        return;
      }
      const captionW = wco.visible
        ? Math.max(0, window.innerWidth - wco.getTitlebarAreaRect().right)
        : 0;
      root.style.setProperty('--uw-caption-w', `${captionW}px`);
    };
    measureCaptions();
    // The caption zone can change without a theme change (resize,
    // overlay visibility) — re-measure on geometrychange.
    wco?.addEventListener('geometrychange', measureCaptions);
    // canvas/symbol ride along so an adaptive palette re-tints the
    // overlay too, not just the built-ins.
    window.auqw.chrome.setScheme({
      scheme,
      canvas,
      symbol: textBright,
    });
    return () => wco?.removeEventListener('geometrychange', measureCaptions);
  }, [scheme, canvas, textBright]);
  return null;
}

function SessionGate({
  state,
  controller,
}: {
  readonly state: SessionState;
  readonly controller: SessionController;
}) {
  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--canvas)',
      }}
    >
      {state.type === 'restore-failed' ? (
        <ErrorState
          title={t('boot.restoreFailed')}
          hint={state.error.message}
          onRetry={() => void controller.session.restore()}
        />
      ) : (
        <LoadingState title={t('boot.restoring')} />
      )}
    </div>
  );
}

type Overlay =
  | {
      readonly type: 'collection';
      readonly key: 'liked' | 'top50' | 'history' | 'downloads';
    }
  | { readonly type: 'playlist'; readonly playlistId: string }
  | { readonly type: 'entity'; readonly ref: EntityRef }
  | { readonly type: 'corrections' }
  | { readonly type: 'transfer' };

function Main({
  controller,
  state,
}: {
  readonly controller: SessionController;
  readonly state: ReadySession;
}) {
  const { session } = controller;
  // Playback position rides the session's light channel — status
  // ticks that only move position no longer publish whole state, so
  // the position read subscribes here instead of through `state`.
  const subscribePosition = useCallback(
    (listener: () => void) => session.subscribePosition(listener),
    [session],
  );
  const positionMs = useSyncExternalStore(subscribePosition, () =>
    session.positionMs(),
  );
  const [tab, setTab] = useState('home');
  // Desktop keeps the player in the Stage column — always mounted,
  // collapsible from the world toolbar. Replaces the sheet's expanded
  // flag (the sheet is mobile-only now).
  const [stageOpen, setStageOpen] = useState(true);
  const [stageMode, setStageMode] = useState<StageMode>('player');
  const [reordering, setReordering] = useState(false);
  const [query, setQuery] = useState('');
  // Bumped when '/' routes to explore — remounts SearchScreen so its
  // autoFocus refocuses the box even when the tab was already active.
  const [searchFocusTick, setSearchFocusTick] = useState(0);
  // Recent searches: session-scoped, newest first — persisting them
  // would be a storage-schema decision, so they die with the app.
  const [searchRecents, setSearchRecents] = useState<readonly string[]>([]);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
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
    close: closeOverlay,
    dismiss: dismissOverlay,
    clear: clearOverlayStack,
  } = useOverlayStack<Overlay>();
  const [entityFetches, setEntityFetches] = useState<
    Readonly<Record<string, EntityFetch>>
  >({});
  const clearOverlays = useCallback(() => {
    clearOverlayStack();
    setEntityFetches({});
  }, [clearOverlayStack]);
  const entityMeta = useRef(new Map<string, TrackMetadata>());
  const [actionsFor, setActionsFor] = useState<ActionTarget | null>(null);
  // null = connectivity unknown (no baseline yet) — the offline
  // banner renders only on an explicit false.
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => controller.subscribeOnline(setOnline), [controller]);

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
    const timer = window.setTimeout(() => setToast(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Live download ledger — subscribed once; chips + the downloads
  // collection + the stage action all read it.
  const [downloads, setDownloads] = useState(
    () => controller.downloads.list(),
  );
  // Bumped after a local-folder mutation so the model re-reads
  // `local().list()` — the source is storage-backed, not evented, and
  // scans here are user-initiated only.
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
  const downloadsLast = useRef(0);
  const downloadsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshDownloads = useCallback(() => {
    // Progress events fire per transferred chunk — the list snapshot
    // gets the same ~1 Hz trailing throttle as the statfs probe below.
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

  // Offline honesty for remote paths: with connectivity explicitly
  // down nothing streams — every row's play affordance waits instead
  // of firing a remote attempt. Owned bytes are the exception: a row
  // the local playback probe resolves (download ledger or local
  // files) stays playable offline.
  const canPlay = useCallback(
    (recordingId: string): boolean =>
      online !== false ||
      controller.localPlaybackFor(recordingId) !== null,
    [online, controller],
  );

  const downloadChipFor = useCallback(
    (recordingId: string): DownloadChip | null => {
      const row = controller.downloads.recordFor(recordingId);
      if (row === null) {
        return null;
      }
      return row.state === 'requested'
        ? 'queued'
        : row.state === 'transferring'
          ? 'downloading'
          : row.state === 'available'
            ? 'stored'
            : 'failed';
    },
    [controller],
  );

  // A download needs a playable provider ref — recordings carrying
  // only a `local` ref are already owned bytes; the action hides.
  const downloadRefFor = useCallback(
    (recordingId: string): SourceRef | null => {
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
    [state.recordings, state.settings.playbackProvider],
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
        void controller.downloads.request(
          { recordingId, sourceRef },
          signal,
        );
        return;
      }
      switch (existing.state) {
        case 'requested':
        case 'transferring':
          void controller.downloads.cancel(existing.downloadId, signal);
          return;
        case 'failed_with_retry':
          void controller.downloads.retry(existing.downloadId);
          return;
        case 'available':
          // The 'removing' transition fires before the file is gone —
          // refresh usage again once removal settles so Settings
          // doesn't display the freed bytes until the next event.
          void controller.downloads
            .remove(existing.downloadId, signal)
            .then(refreshUsage);
          return;
        default:
          return;
      }
    },
    [controller, downloadRefFor, refreshUsage],
  );

  const [pickerFor, setPickerFor] = useState<ActionTarget | null>(null);
  // Lyrics are a live read off the Stage's lyrics mode, not session
  // state — the fetch is keyed to the playing recording and canceled
  // when superseded.
  const [lyricsFetch, setLyricsFetch] = useState<LyricsFetch | null>(null);
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
  // carry typed messages, which are not localized.
  const importSummaryCounts = useRef<{
    tracks: number;
    likes: number;
    playlists: number;
  } | null>(null);
  const exportDoneName = useRef<string | null>(null);
  useEffect(() => {
    const raw = importPreviewRaw.current;
    const counts = importSummaryCounts.current;
    const exportName = exportDoneName.current;
    if (raw === null && counts === null && exportName === null) {
      return;
    }
    setTransfer((prev) => ({
      ...prev,
      exportDetail:
        prev.exportPhase === 'done' && exportName !== null
          ? t('transfer.savedToDownloads', { name: exportName })
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
  const importInput = useRef<HTMLInputElement | null>(null);
  const [providerSlot, setProviderSlot] = useState<ProviderSlot | null>(null);
  // Bumping scrolls the inline sync section into view + focuses it —
  // the 'sync' settings row's navigation target.
  const [syncFocusTick, setSyncFocusTick] = useState(0);

  // LAN sync panel — polled status/devices plus the minted pairing
  // offer while its sheet is open. No push channel exists, so the
  // panel refreshes on actions and on a slow interval while the
  // settings tab is visible.
  const [syncStatus, setSyncStatus] = useState<SyncStatusResult | null>(
    null,
  );
  const [syncDevices, setSyncDevices] = useState<
    readonly SyncDeviceInfo[]
  >([]);
  const [pairing, setPairing] = useState<SyncPairingResult | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  // The sheet opens on the user's tap, not on a successful mint — a
  // failed listener mint must still show the nearby/paste half.
  const [pairSheetOpen, setPairSheetOpen] = useState(false);
  // The accept half of symmetric pairing: mDNS-found pair hosts the
  // sheet can dial into (tap → type the code that device shows), plus
  // the payload-paste fallback. Browse lives only while the sheet is
  // open — it needs no custody, so it starts immediately.
  const [nearbyPeers, setNearbyPeers] = useState<
    readonly (SyncNearbyPeer & { readonly key: string })[]
  >([]);
  const [dialing, setDialing] = useState(false);
  const [dialError, setDialError] = useState<string | null>(null);
  useEffect(() => {
    if (!pairSheetOpen) {
      setNearbyPeers([]);
      setDialing(false);
      setDialError(null);
      return;
    }
    // Subscribe BEFORE starting the browse — early `found` events for
    // already-advertised peers would otherwise fire with no receiver.
    const unsubscribe = window.auqw.sync.onNearby((event) => {
      if (event.type === 'paired') {
        // Our minted offer was just consumed — remint immediately so
        // the sheet never displays a dead code (gen-gated like every
        // other mint path).
        const gen = pairSheetGen.current;
        const attempt = ++pairMintRef.current;
        void window.auqw.sync
          .pairing()
          .then((offer) => {
            if (
              gen === pairSheetGen.current &&
              attempt === pairMintRef.current
            ) {
              setPairing(offer);
            }
          })
          .catch(() => {
            // The code we displayed was just consumed — a failed
            // remint must not leave the dead QR on screen.
            if (
              gen === pairSheetGen.current &&
              attempt === pairMintRef.current
            ) {
              setPairing(null);
            }
          });
        return;
      }
      setNearbyPeers((prev) => {
        if (event.type === 'lost') {
          return prev.filter((peer) => peer.key !== event.key);
        }
        // Service identity (name|host|port) is the row key — a
        // re-advertised peer on a new port replaces its row, a
        // same-named neighbor keeps its own.
        const next = prev.filter((peer) => peer.key !== event.peer.key);
        return [...next, event.peer];
      });
    });
    void window.auqw.sync.nearbyStart().catch(() => undefined);
    return () => {
      void window.auqw.sync.nearbyStop().catch(() => undefined);
      unsubscribe();
    };
  }, [pairSheetOpen]);
  // Sheet-open generation — a mint resolving after dismissal must not
  // resurrect an offer the remint effect would keep refreshing forever.
  const pairSheetGen = useRef(0);
  // Last-mint-wins + in-flight serialization: pairing() isn't instant,
  // and a slow mint must not let an EARLIER reply overwrite a newer
  // offer or stack concurrent mints behind the tick.
  const pairMintRef = useRef(0);
  const pairMintInFlight = useRef(false);
  const onPairDevice = useCallback(() => {
    setPairSheetOpen(true);
    const gen = ++pairSheetGen.current;
    const attempt = ++pairMintRef.current;
    void window.auqw.sync
      .pairing()
      .then((offer) => {
        if (
          gen !== pairSheetGen.current ||
          attempt !== pairMintRef.current
        ) {
          return;
        }
        setPairing(offer);
        setPairingError(null);
      })
      // A mint failure (listener down, no LAN address) must surface —
      // a silent reject leaves the row looking dead-clicked.
      .catch((thrown: unknown) => {
        if (gen !== pairSheetGen.current) {
          return;
        }
        setPairing(null);
        setPairingError(
          isShellError(thrown)
            ? thrown.message
            : thrown instanceof Error
              ? thrown.message
              : 'could not mint a pairing offer',
        );
      });
  }, []);
  const syncRefresh = useCallback(() => {
    const { sync } = window.auqw;
    void sync
      .status()
      .then((status) => setSyncStatus(status))
      .catch(() => setSyncStatus(null));
    void sync
      .devices()
      .then((result) => setSyncDevices(result.devices))
      .catch(() => setSyncDevices([]));
  }, []);
  const onUnpairDevice = useCallback(
    (deviceId: string) => {
      void window.auqw.sync.unpair({ id: deviceId }).then(syncRefresh);
    },
    [syncRefresh],
  );
  const onSyncNow = useCallback(() => {
    void window.auqw.sync.trigger().then(syncRefresh);
  }, [syncRefresh]);
  // Every dial path settles the same: success retires the sheet like
  // a dismiss (generation bump so an in-flight offer mint can't land
  // a stale offer into `pairing` after close); failure surfaces the
  // typed message under the form.
  const finishDial = useCallback(() => {
    setDialing(false);
    pairSheetGen.current += 1;
    setPairing(null);
    setPairSheetOpen(false);
    syncRefresh();
  }, [syncRefresh]);
  const failDial = useCallback((thrown: unknown) => {
    setDialing(false);
    setDialError(
      isShellError(thrown)
        ? thrown.message
        : thrown instanceof Error
          ? thrown.message
          : 'pairing failed',
    );
  }, []);
  const onDialNearby = useCallback(
    (key: string, code: string) => {
      const peer = nearbyPeers.find((entry) => entry.key === key);
      if (peer === undefined || dialing) {
        return;
      }
      setDialing(true);
      setDialError(null);
      void window.auqw.sync
        .dial({
          host: peer.host,
          port: peer.port,
          code,
          hosts: peer.addresses,
          ...(peer.fp !== null ? { fp: peer.fp } : {}),
        })
        .then(finishDial)
        .catch(failDial);
    },
    [nearbyPeers, dialing, finishDial, failDial],
          );
  // The typed join — desktop's counterpart to the mobile PairForm:
  // code + host + port dial, no camera anywhere in the path.
  const onPairCode = useCallback(
    (input: { code: string; host: string; port: number | null }) => {
      if (input.port === null || dialing) {
        return;
      }
      setDialing(true);
      setDialError(null);
      void window.auqw.sync
        .dial({ host: input.host, port: input.port, code: input.code })
        .then(finishDial)
        .catch(failDial);
    },
    [dialing, finishDial, failDial],
  );
  const onPastePayload = useCallback(
    (payload: string) => {
      if (dialing) {
        return;
      }
      setDialing(true);
      setDialError(null);
      void window.auqw.sync
        .dialPayload({ payload })
        .then(finishDial)
        .catch(failDial);
    },
    [dialing, finishDial, failDial],
  );
  // The sheet's 'expires in Nm' label is a render-time read — tick
  // while an offer is open so the countdown doesn't freeze between
  // sync polls.
  const [pairingTick, setPairingTick] = useState(0);
  useEffect(() => {
    if (pairing === null) {
      return;
    }
    const timer = window.setInterval(
      () => setPairingTick((n) => n + 1),
      15_000,
    );
    return () => window.clearInterval(timer);
  }, [pairing]);
  // Offers die at expiresAt — remint quietly while the sheet stays
  // open so a displayed QR never outlives what the host accepts.
  useEffect(() => {
    if (
      !pairSheetOpen ||
      pairing === null ||
      Date.now() < pairing.expiresAt ||
      pairMintInFlight.current
    ) {
      return;
    }
    const gen = pairSheetGen.current;
    const attempt = ++pairMintRef.current;
    pairMintInFlight.current = true;
    void window.auqw.sync
      .pairing()
      .then((offer) => {
        pairMintInFlight.current = false;
        if (
          gen === pairSheetGen.current &&
          attempt === pairMintRef.current
        ) {
          setPairing(offer);
        }
      })
      .catch(() => {
        pairMintInFlight.current = false;
        if (
          gen === pairSheetGen.current &&
          attempt === pairMintRef.current
        ) {
          setPairing(null);
        }
      });
    // pairingTick drives the re-check; pairing.expiresAt is the gate.
  }, [pairSheetOpen, pairing, pairingTick]);
  useEffect(() => {
    if (tab !== 'settings') {
      // Reset the anchor tick: leaving the tab unmounts the section
      // ref, and a stale tick would re-scroll on the next mount.
      setSyncFocusTick(0);
      return;
    }
    syncRefresh();
    const timer = window.setInterval(syncRefresh, 5_000);
    return () => window.clearInterval(timer);
  }, [tab, syncRefresh]);

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
    [search, state.settings.storefront],
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

  const [pendingReviews, setPendingReviews] = useState<number | null>(null);

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
  const queueModel = useMemo(
    () =>
      toQueueModel({
        queue: state.queue,
        recordings: state.recordings,
        likes: state.likes,
        // Same honesty rule as the library rows: offline + unowned
        // marks 'unavailable' so a dead press isn't a surprise. The
        // probe is gated in the controller until web-player gains a
        // `provider:'local'` route — owned rows flip to playable with
        // it automatically.
        unavailableRecordingIds:
          online === false
            ? new Set(
                state.queue.occurrences
                  .map((o) => o.recordingId)
                  .filter(
                    (id) => controller.localPlaybackFor(id) === null,
                  ),
              )
            : undefined,
      }),
    [
      state.queue,
      state.recordings,
      state.likes,
      online,
      controller,
      downloads,
      localTick,
      localeTick,
    ],
  );
  const libraryModel = useMemo(() => {
    const model = toLibraryModel({
      recordings: state.recordings,
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
    const chipByRecording = new Map<string, DownloadChip>(
      downloads.map((d) => [
        d.recordingId,
        d.state === 'requested'
          ? ('queued' as const)
          : d.state === 'transferring'
            ? ('downloading' as const)
            : d.state === 'available'
              ? ('stored' as const)
              : ('failed' as const),
      ]),
    );
    // Honest-offline: with connectivity explicitly down, remote rows
    // degrade to 'unavailable' instead of spinning on a dead attempt.
    // Owned bytes are the exception — rows the local probe resolves
    // (download ledger or local files) stay playable.
    const offline = online === false;
    const decorate = (row: TrackRowModel, recordingId: string): TrackRowModel => {
      const base: TrackRowModel = {
        ...row,
        download: chipByRecording.get(recordingId) ?? row.download,
        playing: recordingId === playingId ? true : row.playing,
      };
      return offline && controller.localPlaybackFor(recordingId) === null
        ? { ...base, state: 'unavailable', note: t('note.offline') }
        : base;
    };
    const mark = (row: CollectionRowModel): CollectionRowModel => ({
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
    controller,
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
        entries: model.entries.map((entry) => ({
          ...entry,
          row: {
            ...entry.row,
            playing:
              entry.recordingId === playingId ? true : entry.row.playing,
            ...(offline
              ? { state: 'unavailable' as const, note: t('note.offline') }
              : {}),
          },
        })),
      };
    },
    [
      state.playlists,
      state.playlistEntries,
      state.recordings,
      state.likes,
      state.playback,
      online,
      controller,
      localeTick,
    ],
  );
  const entityModelFor = useCallback(
    (fetch: EntityFetch | null) =>
      toEntityModel({
        page: fetch?.page ?? null,
        error: fetch?.error ?? null,
        likes: state.likes,
        entitySourceRefs: state.entitySourceRefs,
        loadingMore: fetch?.loadingMore ?? false,
      }),
    [state.likes, state.entitySourceRefs],
  );
  // Row-key → TrackMetadata map for entity items, same contract as
  // resultMeta for search results — namespaced per stack entry so two
  // entity screens in the stack never collide.
  useEffect(() => {
    const map = entityMeta.current;
    map.clear();
    for (const entry of overlayStack) {
      if (entry.overlay.type !== 'entity') {
        continue;
      }
      const fetch = entityFetches[entityRefKey(entry.overlay.ref)];
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
  const searchModel = useMemo(() => toSearchModel(searchState), [searchState]);
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
      for (const meta of searchState.page.items.slice(0, 12)) {
        map.set(`${meta.sourceRef.provider}:${meta.sourceRef.id}`, meta);
      }
    }
    return map;
  }, [searchState]);
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
    const model = toSettingsModel(state.settings, diagnostics, {
      storageText,
      // The probe surface only exists once rehydrateMedia ran — gate
      // the rows on it instead of dead-pressing behind a null local().
      localSupported: controller.local() !== null,
      localFolderCount: controller.local()?.list().length,
      localSources: controller
        .local()
        ?.list()
        .map((s) => ({ sourceId: s.sourceId, label: s.label })),
      downloadCount: downloads.length,
      // The sync seam is always present on desktop (IPC contract) —
      // the row navigates to the inline sync section and carries the
      // same status vocabulary the mobile row does.
      syncSupported: true,
      syncLabel:
        syncStatus === null
          ? t('sync.status.unavailable')
          : syncStatus.sessions > 0
            ? t('sync.status.connectedCount', {
              count: syncStatus.sessions,
            })
            : syncStatus.pairedDevices > 0
              ? t('sync.status.pairedCount', {
                count: syncStatus.pairedDevices,
              })
              : null,
    });
    // The artwork cache budget row stays off the desktop list: the
    // renderer has no application artwork cache — Chromium's image
    // cache owns artwork memory — so the row would dead-end. The
    // 'sync' row now navigates to the inline sync section below.
    return {
      ...model,
      rows: model.rows.filter(
        (row) => row.key !== 'artworkCacheBytes',
      ),
    };
  }, [
    state.settings,
    diagnostics,
    storageText,
    controller,
    downloads,
    localTick,
    syncStatus,
    localeTick,
  ]);
  const syncModel = useMemo(
    () =>
      toSyncPanel(
        syncStatus,
        syncDevices,
        pairing,
        Date.now(),
        pairingError,
      ),
    [syncStatus, syncDevices, pairing, pairingTick, pairingError, localeTick],
  );

  const onExportDelta = useCallback(() => {
    void (async () => {
      // Shared paging walk (collectSyncDeltaDocs): `more` pages follow
      // up with a coverage cursor; the clipboard carries one doc or,
      // past the envelope caps, an array the importer applies in order.
      const collected = await collectSyncDeltaDocs(async (cursor) => {
        const page = await window.auqw.sync.deltas({
          since: JSON.stringify(cursor),
        });
        if (!isSyncDelta(page.delta)) {
          return err(
            appError('invalid-response', 'sync delta page malformed'),
          );
        }
        return ok(page.delta);
      });
      if (!collected.ok) {
        reportResult('sync.panel.copyDelta', collected);
        return;
      }
      await navigator.clipboard.writeText(
        serializeSyncDeltaDocs(collected.value),
      );
    })().catch(() => undefined);
  }, []);
  const onImportDelta = useCallback(() => {
    void navigator.clipboard
      .readText()
      .then(async (text) => {
        // Shared parse: single doc or ordered array; the whole batch
        // validates BEFORE any apply so a malformed element can't
        // strand a partially imported array.
        const docs = parseSyncDeltaDocs(text);
        if (docs === null) {
          reportResult(
            'sync.panel.pasteDelta',
            err(appError('invalid-message', 'clipboard has no delta')),
          );
          return;
        }
        for (const delta of docs) {
          await window.auqw.sync.importDelta({ delta });
        }
      })
      .then(syncRefresh)
      .catch((thrown: unknown) => {
        reportResult(
          'sync.panel.pasteDelta',
          err(shellToAppError(thrown)),
        );
      });
  }, [syncRefresh]);

  // ---- play actions ------------------------------------------------

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

  // The ambiguous-match gate parks candidates in a review the user
  // must resolve — retrying the press only fails the same way, so a
  // play that hits the gate opens the review surface instead of
  // dying quietly on a dead queue item.
  //
  // reportPlayError is the single error funnel: the play promise and
  // the published `playback.failed` state carry the SAME error object,
  // so identity-dedupe via lastPlayErrorRef reports each failure once
  // regardless of which channel delivers it first.
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
      if (lastPlayErrorRef.current === error) {
        return;
      }
      lastPlayErrorRef.current = error;
      reportResult(action, { ok: false, error });
      if (isMatchGate(error)) {
        // Land the user on the fresh pending row: a stale 'resolved'
        // filter or an already-open screen would hide it, so the
        // route always selects pending and reloads.
        setReviewFilter('pending');
        loadReviews();
        if (overlay?.type !== 'corrections') {
          pushOverlay({ type: 'corrections' });
        }
      }
    },
    [pushOverlay, overlay, loadReviews],
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
  useEffect(() => {
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
  }, [state.playback, reportPlayError]);

  const playRecording = useCallback(
    async (recordingId: string) => {
      if (!canPlay(recordingId)) {
        return;
      }
      const enqueued = await session.enqueueRecording(recordingId);
      if (!enqueued.ok) {
        reportResult('action.enqueueTrack', enqueued);
        return;
      }
      await dispatchPlay('common.play', session.playOccurrence(enqueued.value));
    },
    [session, canPlay, reportPlay],
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
    [session, state.queue, canPlay, reportPlay],
  );

  // Mirrors the cursor's targeting in walk space — the dealt order
  // under shuffle, canonical otherwise: next → walk position+1;
  // previous → restart current when positionMs>3s or at the walk's
  // head, else position−1 — and under repeat=all both edges wrap
  // (tail→head, head→tail). The gate sees the same target the engine
  // would land on — an owned target still advances offline.
  const advance = useCallback(
    (method: 'next' | 'previous') => {
      const { occurrences, currentOccurrenceId } = state.queue;
      // Position ticks ride the light channel now — read it live,
      // not from the (possibly position-stale) published snapshot.
      const positionMs = session.positionMs();
      const walk =
        state.shuffleOrder !== null
          ? state.shuffleOrder
          : occurrences.map((o) => o.occurrenceId);
      const pos =
        currentOccurrenceId === null ? -1 : walk.indexOf(currentOccurrenceId);
      if (pos < 0) {
        return;
      }
      const wraps = state.repeat === 'all' && walk.length > 0;
      const targetId =
        method === 'next'
          ? pos + 1 < walk.length
            ? walk[pos + 1]
            : wraps
              ? walk[0]
              : undefined
          : positionMs > 3_000
            ? walk[pos]
            : pos === 0
              ? wraps
                ? walk[walk.length - 1]
                : walk[pos]
              : walk[pos - 1];
      const target = occurrences.find(
        (o) => o.occurrenceId === targetId,
      );
      if (target === undefined || !canPlay(target.recordingId)) {
        return;
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
      canPlay,
      reportPlay,
    ],
  );

  // Offline honesty for metadata paths (cached search/entity rows):
  // the materialized recording is playable offline only when owned —
  // a provider ref alone would start a remote attempt the UI says
  // waits for connectivity.
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
      return recording !== undefined && canPlay(recording.id);
    },
    [online, state.recordings, canPlay],
  );

  const onResultPress = useCallback(
    (row: TrackRowModel) => {
      const meta = resultMeta.current.get(row.key);
      if (meta !== undefined && canPlayMeta(meta)) {
        recordRecentSearch(query);
        void dispatchPlay('action.playResult', session.addAndPlay(meta));
      }
    },
    [session, canPlayMeta, query, recordRecentSearch, reportPlay],
  );

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
      if (key === 'addLocalFolder') {
        const local = controller.local();
        if (local === null) {
          return;
        }
        void local
          .addFolder(new CancellationSource().signal)
          .then((added) => {
            reportResult('settings.addLocalFolder', added);
            // Re-read the live source — a mid-flight rehydrate swaps
            // the instance, and committing the captured one's stale
            // snapshot would clobber rows it never saw.
            const source = controller.local();
            if (added.ok && source !== null) {
              session.syncLocalRecordings(source.recordings());
              refreshLocal();
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
            const source = controller.local();
            if (removed.ok && source !== null) {
              session.syncLocalRecordings(source.recordings());
              refreshLocal();
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
            const source = controller.local();
            if (scanned.ok && source !== null) {
              session.syncLocalRecordings(source.recordings());
              refreshLocal();
            }
          });
        return;
      }
      if (key === 'sync') {
        // The row's destination is the inline sync section — scroll +
        // focus it rather than opening a separate screen.
        setSyncFocusTick((n) => n + 1);
        return;
      }
    },
    [session, state.settings, controller, refreshLocal, refreshUsage],
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

  const playback = state.playback;
  const playing = playback.type === 'playing';
  const currentRecordingId =
    playback.type === 'idle' ? null : playback.recordingId;
  // Real waveform peaks for the Stage seek — lazy, cached per
  // recordingId, and null until resolved (the renderer keeps the
  // seeded pattern while pending and on failure). The port borrows
  // the live stream handle; it never owns or closes it.
  const peaksPort = useMemo(
    () => createWebPeaksPort({ stream: window.auqw.stream }),
    [],
  );
  const peaksTarget: PeaksTarget | null =
    playback.type === 'buffering' ||
    playback.type === 'playing' ||
    playback.type === 'paused'
      ? {
          // recordingId alone would reuse a waveform across
          // re-prepared streams — attemptId keys the resolved source.
          id: `${playback.recordingId}|${playback.identity.attemptId}`,
          handle: playback.handle,
          durationMs: playback.durationMs ?? null,
        }
      : null;
  const peaks = useWaveformPeaks(peaksPort, peaksTarget);
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
    // pause/resume keep the SAME attempt identity — they never own a
    // new one, so no pendingAttempt claim; their own promise still
    // reports with their own action.
    void (intentPlaying ? session.pause() : session.resume()).then((r) =>
      reportPlay(intentPlaying ? 'common.pause' : 'action.resume', r),
    );
  }, [session, state.queue.mode, state.playback.type, currentRecordingId, canPlay, reportPlay]);
  const onToggleLike = useCallback(() => {
    if (currentRecordingId !== null) {
      void session.toggleLike(currentRecordingId);
    }
  }, [session, currentRecordingId]);
  const onMoveQueueItem = useCallback(
    (occurrenceId: string, direction: -1 | 1) => {
      const index = state.queue.occurrences.findIndex(
        (o) => o.occurrenceId === occurrenceId,
      );
      if (index >= 0) {
        void session.moveOccurrence(occurrenceId, index + direction);
      }
    },
    [session, state.queue],
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

  // Lyrics load lazily — only while the Stage's lyrics mode is
  // actually showing — and refetch whenever the track under it
  // changes. Leaving lyrics mode keeps the last sheet cached.
  useEffect(() => {
    if (!stageOpen || stageMode !== 'lyrics' || currentRecordingId === null) {
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
  ]);

  // Lyrics highlight rides a smoothed clock so the active line tracks
  // playback between the engine's sparse position ticks; it only ticks
  // while the lyrics pane is actually on screen.
  const [seekGeneration, bumpSeekGeneration] = useState(0);
  const seekToPosition = useCallback(
    (ms: number): Promise<Result<void>> => {
      bumpSeekGeneration((n) => n + 1);
      return session.seekTo(ms);
    },
    [session],
  );
  const lyricsPositionMs = useSmoothedPosition(
    player?.positionMs ?? 0,
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
        (p) => p.id === ref.provider && p.capabilities.includes('radio.seed'),
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
    if (overlay?.type === 'corrections') {
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
    (op: () => ReturnType<typeof session.confirmReview>) => {
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

  // ---- library transfer (export download · import file pick) -----

  const onExport = useCallback(() => {
    setTransfer((prev) => ({
      ...prev,
      exportPhase: 'working',
      exportDetail: null,
    }));
    void session.exportLibrary().then((result) => {
      if (!result.ok) {
        setTransfer((prev) => ({
          ...prev,
          exportPhase: 'error',
          exportDetail: result.error.message,
        }));
        return;
      }
      try {
        // Sandboxed renderers have no filesystem — the browser's
        // download path is the honest destination.
        const name = `auqw-library-${new Date().toISOString().slice(0, 10)}.json`;
        const url = URL.createObjectURL(
          new Blob([result.value.json], { type: 'application/json' }),
        );
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        URL.revokeObjectURL(url);
        exportDoneName.current = name;
        setTransfer((prev) => ({
          ...prev,
          exportPhase: 'done',
          exportDetail: t('transfer.savedToDownloads', { name }),
        }));
      } catch (thrown) {
        setTransfer((prev) => ({
          ...prev,
          exportPhase: 'error',
          exportDetail:
            thrown instanceof Error
              ? thrown.message
              : t('transfer.exportWriteFailed'),
        }));
      }
    });
  }, [session]);

  const onImportFileChosen = useCallback(
    (file: globalThis.File | null) => {
      if (file === null) {
        setTransfer((prev) => ({ ...prev, importPhase: 'idle' }));
        return;
      }
      void file.text().then(
        (text) => {
          // Preview validates without mutating — a typed error here is
          // the honest reject; nothing was applied.
          const preview = previewImport(text);
          if (!preview.ok) {
            importPreviewRaw.current = null;
            setTransfer((prev) => ({
              ...prev,
              importPhase: 'error',
              importDetail: preview.error.message,
              preview: null,
            }));
            return;
          }
          importText.current = text;
          importPreviewRaw.current = {
            preview: preview.value,
            sourceLabel: file.name,
          };
          setTransfer((prev) => ({
            ...prev,
            importPhase: 'preview',
            preview: toImportPreviewModel(preview.value, file.name),
          }));
        },
        (thrown) => {
          importPreviewRaw.current = null;
          setTransfer((prev) => ({
            ...prev,
            importPhase: 'error',
            importDetail:
              thrown instanceof Error
                ? thrown.message
                : t('transfer.readFailed'),
            preview: null,
          }));
        },
      );
    },
    [],
  );

  // The fallback file dialog emits no `change` on dismiss — `cancel`
  // (not in this React's typings) is the only recovery hook; without it
  // a cancelled pick latches the button on 'working…' forever.
  useEffect(() => {
    const input = importInput.current;
    const onCancel = () =>
      setTransfer((prev) => ({ ...prev, importPhase: 'idle' }));
    input?.addEventListener('cancel', onCancel);
    return () => input?.removeEventListener('cancel', onCancel);
  }, []);

  const onPickImportFile = useCallback(() => {
    importPreviewRaw.current = null;
    setTransfer((prev) => ({
      ...prev,
      importPhase: 'reading',
      importDetail: null,
      preview: null,
    }));
    // showOpenFilePicker resolves a cancel as AbortError; the hidden
    // input fallback (webviews without the picker API) observes it via
    // its `cancel` event — both paths reset to idle.
    const picker = (
      window as unknown as {
        showOpenFilePicker?: (options: {
          multiple?: boolean;
          types?: readonly {
            description?: string;
            accept: Record<string, readonly string[]>;
          }[];
        }) => Promise<readonly { getFile(): Promise<globalThis.File> }[]>;
      }
    ).showOpenFilePicker;
    if (picker === undefined) {
      importInput.current?.click();
      return;
    }
    void picker
      .call(window, {
        types: [
          {
            description: 'auqw library export',
            accept: { 'application/json': ['.json'] },
          },
        ],
        multiple: false,
      })
      .then(async (handles) => {
        const handle = handles[0];
        return handle === undefined ? null : handle.getFile();
      })
      .then((file) => onImportFileChosen(file))
      .catch((thrown: unknown) => {
        if (thrown instanceof DOMException && thrown.name === 'AbortError') {
          setTransfer((prev) => ({ ...prev, importPhase: 'idle' }));
          return;
        }
        // Picker rejected for a real reason — fall back to the input.
        importInput.current?.click();
      });
  }, [onImportFileChosen]);

  const onApplyImport = useCallback(() => {
    const text = importText.current;
    if (text === null) {
      return;
    }
    setTransfer((prev) => ({ ...prev, importPhase: 'applying' }));
    // replaceLibrary drains downloads before the swap and rehydrates
    // the media owners after — a live runner could otherwise
    // repersist a ledger row the import removed.
    void controller
      .replaceLibrary(text, new CancellationSource().signal)
      .then((result) => {
        if (!result.ok) {
          setTransfer((prev) => ({
            ...prev,
            importPhase: 'error',
            importDetail: result.error.message,
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
      const top = overlayStack[overlayStack.length - 1]?.overlay;
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
    const top = overlay?.type === 'entity' ? overlay.ref : null;
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
    [session, canPlay, reportPlay],
  );

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
            selectedRef: entry.selectedRef,
          })),
        ),
      );
    },
    [session, canPlay, reportPlay],
  );

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
        case 'radio': {
          // Track-seeded at this release: a metadata row seeds its own
          // ref; a library row seeds its first source ref. The action
          // only renders when the seed's provider declares radio.seed,
          // but guard the op too — state may shift between the two.
          const ref =
            target.kind === 'metadata'
              ? target.meta.sourceRef
              : (state.recordings.find((r) => r.id === target.recordingId)
                  ?.sourceRefs[0] ?? null);
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
    ],
  );

  const onOpenCard = useCallback(
    (card: { playlistId: string | null; entityRef: EntityRef | null }) => {
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

  const renderTabScreen = (key: string) => {
    switch (key) {
      case 'explore':
        return (
          <SearchScreen
            key={searchFocusTick}
            state={searchModel}
            query={query}
            onQueryChange={setQuery}
            onSubmit={() => {
              recordRecentSearch(query);
              runSearch(query);
            }}
            onCancel={() => {
              setQuery('');
              search?.cancel();
            }}
            onRetry={() => runSearch(searchModel.query)}
            onResultPress={onResultPress}
            onAddToPlaylist={(row) => {
              const meta = resultMeta.current.get(row.key);
              if (meta !== undefined) {
                setPickerFor({ kind: 'metadata', meta });
              }
            }}
            onContext={(row) => {
              const meta = resultMeta.current.get(row.key);
              if (meta !== undefined) {
                setActionsFor({ kind: 'metadata', meta });
              }
            }}
            recents={searchRecents}
            onRecentPress={(recent) => {
              setQuery(recent);
              recordRecentSearch(recent);
              runSearch(recent);
            }}
            suggestions={suggestions}
            onSuggestionPress={(suggestion) => {
              setQuery(suggestion);
              recordRecentSearch(suggestion);
              runSearch(suggestion);
            }}
            autoFocus
          />
        );
      case 'library':
        return (
          <LibraryScreen
            model={libraryModel}
            onPressItem={(id) => void playRecording(id)}
            onToggleLike={(id) => void session.toggleLike(id)}
            onAddToPlaylist={(id) =>
              setPickerFor({ kind: 'recording', recordingId: id })
            }
            onContext={(id) =>
              setActionsFor({ kind: 'recording', recordingId: id })
            }
            onOpenCollection={(key) =>
              pushOverlay({ type: 'collection', key })
            }
            onOpenCard={onOpenCard}
            onOpenArtist={(artist) => {
              if (artist.entityRef !== null) {
                openEntity(artist.entityRef);
              }
            }}
            onCreatePlaylist={onCreatePlaylist}
          />
        );
      case 'settings':
        return (
          <SettingsScreen
            model={settingsModel}
            onSelectRow={onSettingsSelect}
            onToggleRow={onSettingsToggle}
            onOpenCorrections={() =>
              pushOverlay({ type: 'corrections' })
            }
            sync={syncModel}
            syncFocusTick={syncFocusTick}
            onPairDevice={onPairDevice}
            onUnpairDevice={onUnpairDevice}
            onSyncNow={onSyncNow}
            onExportDelta={onExportDelta}
            onImportDelta={onImportDelta}
          />
        );
      default:
        return (
          <HomeScreen
            model={homeModel}
            onPressCard={(card) => {
              const meta = suggestionMeta.get(card.key);
              if (meta !== undefined) {
                if (canPlayMeta(meta)) {
                  if (searchState.type === 'content') {
                    recordRecentSearch(searchState.query);
                  }
                  void dispatchPlay(
                    'action.playResult',
                    session.addAndPlay(meta),
                  );
                }
                return;
              }
              void playRecording(card.key);
            }}
            onResume={onPlayPause}
          />
        );
    }
  };

  const renderOverlayEntry = (entry: OverlayEntry<Overlay>) => {
    const current = entry.overlay;
    switch (current.type) {
      case 'collection': {
        const model = toCollectionModel(libraryModel, current.key);
        return model === null ? null : (
          <CollectionScreen
            model={model}
            onBack={closeOverlay}
            onPlayAll={() => playCollectionRows(model.rows)}
            onPressItem={(row) => void playRecording(row.recordingId)}
            onToggleLike={(row) => void session.toggleLike(row.recordingId)}
            onAddToPlaylist={(row) =>
              setPickerFor({ kind: 'recording', recordingId: row.recordingId })
            }
            onContext={(row) =>
              setActionsFor({ kind: 'recording', recordingId: row.recordingId })
            }
          />
        );
      }
      case 'playlist': {
        const playlistModel = playlistModelFor(current.playlistId);
        return (
          <PlaylistScreen
            model={playlistModel}
            onBack={closeOverlay}
            onPlayAll={() => playPlaylist(playlistModel)}
            onRename={(name) =>
              void session
                .renamePlaylist(current.playlistId, name)
                .then((r) => reportResult('action.renamePlaylist', r))
            }
            onDelete={() => {
              void session
                .deletePlaylist(current.playlistId)
                .then((r) => reportResult('action.deletePlaylist', r));
              dismissOverlay(entry.key);
            }}
            onPressEntry={(entry) => {
              if (!canPlay(entry.recordingId)) {
                return;
              }
              void dispatchPlay(
                'action.playPlaylistEntry',
                session.playRecordings([
                  {
                    recordingId: entry.recordingId,
                    selectedRef: entry.selectedRef,
                  },
                ]),
              );
            }}
            onToggleLike={(entry) => void session.toggleLike(entry.recordingId)}
            onAddToPlaylist={(entry) =>
              setPickerFor({
                kind: 'recording',
                recordingId: entry.recordingId,
              })
            }
            onContext={(entry) =>
              setActionsFor({
                kind: 'recording',
                recordingId: entry.recordingId,
              })
            }
            onRemoveEntry={(entry) =>
              void session
                .removePlaylistEntry(entry.entryId)
                .then((r) => reportResult('action.removeTrack', r))
            }
            onMoveEntry={(move, direction) => {
              if (playlistModel === null) {
                return;
              }
              const index = playlistModel.entries.findIndex(
                (e) => e.entryId === move.entryId,
              );
              const sibling = playlistModel.entries[index + direction];
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
            }}
          />
        );
      }
      case 'entity': {
        const fetch = entityFetches[entityRefKey(current.ref)] ?? null;
        const entityId = entityIdForRef(
          state.entitySourceRefs,
          current.ref,
        );
        const metaFor = (row: TrackRowModel) =>
          entityMeta.current.get(`${entry.key}:${row.key}`);
        return (
          <EntityScreen
            model={entityModelFor(fetch)}
            onBack={closeOverlay}
            onPlayAll={() => {
              const metas = entityModelFor(fetch)
                .items.map((row) => metaFor(row))
                .filter(
                  (m): m is TrackMetadata =>
                    m !== undefined && canPlayMeta(m),
                );
              if (metas.length === 0) {
                return;
              }
              void dispatchPlay(
                'collection.playAll',
                session.playMetadata(metas),
              );
            }}
            onShuffleAll={() => {
              const metas = entityModelFor(fetch)
                .items.map((row) => metaFor(row))
                .filter(
                  (m): m is TrackMetadata =>
                    m !== undefined && canPlayMeta(m),
                );
              if (metas.length === 0) {
                return;
              }
              void dispatchPlay(
                'action.shuffleAll',
                session.playMetadata(metas, { shuffle: true }),
              );
            }}
            onToggleLike={
              entityId === null
                ? undefined
                : () =>
                    void session.toggleEntityLike(current.ref.kind, entityId)
            }
            onPressItem={(row) => {
              const meta = metaFor(row);
              if (meta !== undefined && canPlayMeta(meta)) {
                void dispatchPlay(
                  'action.playResult',
                  session.addAndPlay(meta),
                );
              }
            }}
            onAddToPlaylist={(row) => {
              const meta = metaFor(row);
              if (meta !== undefined) {
                setPickerFor({ kind: 'metadata', meta });
              }
            }}
            onContext={(row) => {
              const meta = metaFor(row);
              if (meta !== undefined) {
                setActionsFor({ kind: 'metadata', meta });
              }
            }}
            onLoadMore={onLoadMore}
            onRetry={() => loadEntityPage(current.ref)}
          />
        );
      }
      case 'corrections':
        return (
          <CorrectionsScreen
            model={correctionsModel}
            onBack={closeOverlay}
            onFilter={setReviewFilter}
            onRetry={loadReviews}
            onConfirm={(reviewId, candidateIndex) =>
              reviewOp(() => session.confirmReview(reviewId, candidateIndex))
            }
            onReject={(reviewId) =>
              reviewOp(() => session.rejectReview(reviewId))
            }
            onUndo={(reviewId) =>
              reviewOp(() => session.undoReview(reviewId))
            }
          />
        );
      case 'transfer':
        return (
          <TransferScreen
            model={transfer}
            onBack={closeOverlay}
            onExport={onExport}
            onPickImportFile={onPickImportFile}
            onApplyImport={onApplyImport}
            onResetImport={onResetImport}
          />
        );
      default:
        return null;
    }
  };

  // Gate frame: the ready UI must not render before the persisted
  // language has been applied — only gate copy (whose system-language
  // rendering is correct) shows until the effect above has landed.
  if (!localeApplied) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--canvas)',
        }}
      >
        <LoadingState title={t('boot.restoring')} />
      </div>
    );
  }

  return (
    <div
      className="uw-app"
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--canvas)',
      }}
    >
      {/* The sandboxed file input that powers library import — the
          browser picker is the only fs path a renderer gets. */}
      <input
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          // Clear the input so re-picking the same file refires.
          event.target.value = '';
          onImportFileChosen(file);
        }}
        ref={importInput}
      />
      <AppStack>
        <StackItem stackKey="root">
          <DesktopChrome
            tabs={navItems().filter((item) => item.key !== 'settings')}
            activeKey={tab}
            onSelect={(key) => {
              setTab(key);
              clearOverlays();
            }}
            onOpenSettings={() => {
              setTab('settings');
              clearOverlays();
            }}
            onFocusSearch={() => {
              setTab('explore');
              clearOverlays();
              setSearchFocusTick((n) => n + 1);
            }}
            stageOpen={stageOpen}
            onStageOpenChange={setStageOpen}
            stage={
              player !== null ? (
                <NowPlayingScreen
                  player={player}
                  mode={stageMode}
                  onModeChange={setStageMode}
                  queue={queueModel}
                  queueReordering={reordering}
                  lyrics={lyricsModel}
                  radio={radioModel}
                  onPlayPause={onPlayPause}
                  onNext={() => advance('next')}
                  onPrevious={() => advance('previous')}
                  onToggleLike={onToggleLike}
                  shuffle={state.type === 'ready' ? state.shuffle : false}
                  onToggleShuffle={() => void session.toggleShuffle()}
                  repeat={state.type === 'ready' ? state.repeat : 'off'}
                  onCycleRepeat={() => void session.cycleRepeat()}
                  download={
                    currentRecordingId !== null &&
                    (controller.downloads.recordFor(currentRecordingId) !==
                      null ||
                      downloadRefFor(currentRecordingId) !== null)
                      ? (downloadChipFor(currentRecordingId) ?? 'idle')
                      : null
                  }
                  onDownload={
                    currentRecordingId !== null
                      ? () => onDownloadAction(currentRecordingId)
                      : undefined
                  }
                  onAddToPlaylist={
                    currentRecordingId !== null
                      ? () =>
                        setPickerFor({
                          kind: 'recording',
                          recordingId: currentRecordingId,
                        })
                      : undefined
                  }
                  onStopPlayback={() => void session.stop()}
                  onSeek={seekToPosition}
                  peaks={peaks}
                  onRetryLyrics={onRetryLyrics}
                  onStartRadio={
                    radioSeedable(radioSeedRef) ? onStartRadio : undefined
                  }
                  onStopRadio={onStopRadio}
                  onPressQueueItem={playQueueOccurrence}
                  onRemoveQueueItem={(id) => void session.removeOccurrence(id)}
                  onToggleQueueReorder={() => setReordering((v) => !v)}
                  onMoveQueueItem={onMoveQueueItem}
                  onMoveQueueItemTo={onMoveQueueItemTo}
                />
              ) : (
                <EmptyState
                  title={t('stage.empty')}
                  hint={t('stage.emptyHint')}
                  icon="note"
                />
              )
            }
          >
            {renderTabScreen(tab)}
            {/* Pushed pages scope to the world column so the stage's
                playback controls stay reachable while they're up. */}
            {overlayStack.map((entry) => {
              const content = renderOverlayEntry(entry);
              return content === null ? null : (
                <PushScreen
                  key={entry.key}
                  stackKey={entry.key}
                  onDismissed={() => dismissOverlay(entry.key)}
                >
                  {content}
                </PushScreen>
              );
            })}
          </DesktopChrome>
          {online === false && (
            <div
              style={{
                position: 'fixed',
                top: 8,
                left: '50%',
                transform: 'translateX(-50%)',
                padding: '5px 12px',
                borderRadius: 999,
                backgroundColor: 'var(--raised)',
                border: 'var(--stroke-hairline) solid var(--hairline)',
                zIndex: 40,
              }}
            >
              <Text variant="metadata" color="secondary">
                {t('offline.bannerStreams')}
              </Text>
            </div>
          )}
          {toast !== null && (
            <div className="uw-toast" role="status">
              <Text variant="metadata" color="primary">
                {toast}
              </Text>
            </div>
          )}
        </StackItem>
        {actionsFor !== null && (
          <SheetScreen
            stackKey="sheet-actions"
            onDismissed={() => setActionsFor(null)}
          >
            <RowActionsSheet
              title={
                actionsFor.kind === 'recording'
                  ? (state.recordings.find(
                      (r) => r.id === actionsFor.recordingId,
                    )?.title ?? t('track.fallbackTitle'))
                  : actionsFor.meta.title
              }
              actions={[
                // Like lives in the sheet for recording targets — the
                // row itself keeps the heart icon only as an indicator.
                ...(actionsFor.kind === 'recording'
                  ? [
                      {
                        key: 'like',
                        label: state.likes.some(
                          (l) =>
                            l.entityKind === 'track' &&
                            l.targetId === actionsFor.recordingId,
                        )
                          ? t('common.unlike')
                          : t('common.like'),
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
                // Download affordance where a provider ref can mint a
                // stream — OR a ledger row already exists (cancel/retry/
                // remove don't need a resolvable ref).
                ...(actionsFor.kind === 'recording' &&
                (controller.downloads.recordFor(actionsFor.recordingId) !==
                  null ||
                  downloadRefFor(actionsFor.recordingId) !== null)
                  ? [
                      {
                        key: 'download',
                        label: (() => {
                          const row = controller.downloads.recordFor(
                            actionsFor.recordingId,
                          );
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
                    ]
                  : []),
                // Only offer the seed affordance when the seed's own
                // provider declares radio.seed — routing is ref-scoped,
                // so another provider's support is a dead end.
                ...(radioSeedable(actionRadioRef)
                  ? [
                      {
                        key: 'radio',
                        label: t('stage.radio.start'),
                        icon: 'radio' as const,
                      },
                    ]
                  : []),
                ...(actionsFor.kind === 'metadata' &&
                actionsFor.meta.albumRef != null
                  ? [
                      {
                        key: 'album',
                        label: t('action.openAlbum'),
                        icon: 'note' as const,
                      },
                    ]
                  : []),
                ...(actionsFor.kind === 'metadata' &&
                actionsFor.meta.artistRef != null
                  ? [
                      {
                        key: 'artist',
                        label: t('action.openArtist'),
                        icon: 'library' as const,
                      },
                    ]
                  : []),
              ]}
              onAction={onRowAction}
              onDismiss={() => setActionsFor(null)}
            />
          </SheetScreen>
        )}
        {pickerFor !== null && (
          <SheetScreen
            stackKey="sheet-add-playlist"
            onDismissed={() => setPickerFor(null)}
          >
            <AddToPlaylistSheet
              playlists={pickerItems}
              onPick={onPickPlaylist}
              onCreate={onCreateAndPick}
              onDismiss={() => setPickerFor(null)}
            />
          </SheetScreen>
        )}
        {providerPicker !== null && (
          <SheetScreen
            stackKey="sheet-provider"
            onDismissed={() => setProviderSlot(null)}
          >
            <ProviderPickerSheet
              title={providerPicker.title}
              options={providerPicker.options}
              selectedKey={providerPicker.selectedKey}
              onPick={onPickProvider}
              onDismiss={() => setProviderSlot(null)}
            />
          </SheetScreen>
        )}
        {storefrontSheetOpen && (
          <SheetScreen
            stackKey="sheet-storefront"
            onDismissed={() => setStorefrontSheetOpen(false)}
          >
            <ValueFieldSheet
              title={t('settings.storefront')}
              initial={storefrontDraft}
              placeholder={t('sheets.countryCodePlaceholder')}
              submitLabel={t('common.save')}
              clearLabel={t('sheets.autoClear')}
              onSubmit={(value) => {
                const code = value.toUpperCase();
                // The domain bound: ISO-3166 alpha-2, or null for
                // system-locale resolution.
                if (!/^[A-Z]{2}$/.test(code)) {
                  setToast(t('toast.storefrontCode'));
                  return;
                }
                // Dismiss only on commit — a failed save shows the
                // toast, not a closed sheet over an unchanged row.
                const opening = storefrontEpoch.current;
                void queueSettingsWrite({ storefront: code }).then(
                  (saved) => {
                    reportResult('action.saveStorefront', saved);
                    if (saved.ok && opening === storefrontEpoch.current) {
                      setStorefrontSheetOpen(false);
                    }
                  },
                );
              }}
              onClear={() => {
                const opening = storefrontEpoch.current;
                void queueSettingsWrite({ storefront: null }).then(
                  (saved) => {
                    reportResult('action.clearStorefront', saved);
                    if (saved.ok && opening === storefrontEpoch.current) {
                      setStorefrontSheetOpen(false);
                    }
                  },
                );
              }}
              onDismiss={() => setStorefrontSheetOpen(false)}
            />
          </SheetScreen>
        )}
        {qualityPickerOpen && (
          <SheetScreen
            stackKey="sheet-quality"
            onDismissed={() => setQualityPickerOpen(false)}
          >
            <ProviderPickerSheet
              title={t('settings.quality')}
              options={qualityOptions()}
              selectedKey={`${state.settings.qualityKbps}`}
              onPick={(key) => {
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
              }}
              onDismiss={() => setQualityPickerOpen(false)}
            />
          </SheetScreen>
        )}
        {pairSheetOpen && (
          <SheetScreen
            stackKey="sheet-pairing"
            onDismissed={() => {
              pairSheetGen.current += 1;
              setPairing(null);
              setPairSheetOpen(false);
            }}
          >
            <PairingSheet
              pairing={syncModel.pairing}
              nearbyPeers={nearbyPeers.map((peer) => ({
                key: peer.key,
                name: peer.name,
                address: `${peer.host}:${peer.port}`,
                pinned: peer.fp !== null,
              }))}
              onPairNearby={onDialNearby}
              onPairCode={onPairCode}
              onPastePayload={onPastePayload}
              dialing={dialing}
              dialError={dialError ?? pairingError}
              onCopyPayload={
                pairing === null
                  ? undefined
                  : () => {
                      void navigator.clipboard.writeText(pairing.payload);
                    }
              }
              onDismiss={() => {
                pairSheetGen.current += 1;
                setPairing(null);
                setPairSheetOpen(false);
              }}
            />
          </SheetScreen>
        )}
        {themePickerOpen && (
          <SheetScreen
            stackKey="sheet-theme"
            onDismissed={() => {
              themeEpoch.current += 1;
              setThemePickerOpen(false);
            }}
          >
            <ProviderPickerSheet
              title={t('settings.theme')}
              options={themeOptions()}
              selectedKey={state.settings.theme}
              onPick={(key) => {
                // Each pick claims a fresh epoch — a save from an
                // earlier pick must not close this sheet.
                themeEpoch.current += 1;
                const opening = themeEpoch.current;
                const theme =
                  THEME_ORDER.find((tag) => tag === key) ?? 'system';
                // Same contract as the language picker: report a
                // failed save and keep the sheet open so an unapplied
                // pick still reads unselected.
                void queueSettingsWrite({ theme })
                  .then((saved) => {
                    if (opening !== themeEpoch.current) {
                      // A newer pick or a dismissal superseded this
                      // save — reject the stale result outright: it
                      // must not close the sheet nor report an outcome
                      // over the newer pick.
                      return;
                    }
                    reportResult('settings.theme', saved);
                    if (saved.ok) {
                      setThemePickerOpen(false);
                    }
                  });
              }}
              onDismiss={() => {
                themeEpoch.current += 1;
                setThemePickerOpen(false);
              }}
            />
          </SheetScreen>
        )}
        {languagePickerOpen && (
          <SheetScreen
            stackKey="sheet-language"
            onDismissed={() => {
              languageEpoch.current += 1;
              setLanguagePickerOpen(false);
            }}
          >
            <ProviderPickerSheet
              title={t('sheets.languageTitle')}
              options={languageOptions()}
              selectedKey={languageOptionKey(state.settings.language)}
              onPick={(key) => {
                const language = key === 'system' ? null : key;
                // Each pick claims a fresh epoch — a save from an
                // earlier pick must neither apply its locale nor
                // close this sheet.
                languageEpoch.current += 1;
                const opening = languageEpoch.current;
                // Apply the locale only once the save landed — a
                // failed save must not leave the UI on a selection
                // storage never recorded. On failure the sheet stays
                // open: the pick still reads unselected, so the
                // failure is visible without relying on the toast.
                void queueSettingsWrite({ language })
                  .then((saved) => {
                    if (opening !== languageEpoch.current) {
                      // A newer pick or a dismissal superseded this
                      // save — reject the stale result outright: it
                      // must not apply a stale locale, close the sheet,
                      // nor report an outcome over the newer pick.
                      return;
                    }
                    reportResult('settings.language', saved);
                    if (saved.ok) {
                      applyLocale(language);
                      setLanguagePickerOpen(false);
                    }
                  });
              }}
              onDismiss={() => {
                languageEpoch.current += 1;
                setLanguagePickerOpen(false);
              }}
            />
          </SheetScreen>
        )}
      </AppStack>
    </div>
  );
}

const host = document.getElementById('root');
if (host === null) {
  throw new Error('app.html is missing the #root mount node');
}
createRoot(host).render(<App />);
