// Desktop renderer entry — boot, shell chrome, and the platform seams.
//
// The shared shell composition (models, overlay/sheet state machines,
// search, queue/playback ops, downloads UI, transfer, settings
// surfaces, toasts) lives in @auqw/app-shell's useAppShell; Main wires
// it up through `ports` and renders what it returns. What stays here
// is what is genuinely desktop:
//
//   - boot + the session restore gate (createSessionController over
//     window.auqw IPC, dispose-on-retry)
//   - theme + titlebar chrome (ThemeSource from the main process,
//     caption-button geometry, titlebar overlay re-measure)
//   - the sync panel: status/devices polling, pairing mint/remint,
//     mDNS nearby browse, clipboard delta import/export — all IPC
//   - connectivity (controller.subscribeOnline) and the
//     local-playback capability probe (localPlaybackFor), passed to
//     the hook as ports
//   - browser file pickers: showOpenFilePicker + hidden input for
//     library import, Blob-anchor download for export
//   - navigator.clipboard for sync payloads
//   - the screen JSX itself and the desktop stage column layout
//
// Everything behavioral above the platform boundary is shared — a fix
// in the hook fixes both shells.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  appError,
  collectSyncDeltaDocs,
  err,
  isSyncDelta,
  ok,
  parseSyncDeltaDocs,
  serializeSyncDeltaDocs,
} from '@auqw/application';
import type {
  EntityRef,
  ReadySession,
  SessionState,
  TrackMetadata,
} from '@auqw/application';
import {
  AddToPlaylistSheet,
  AppStack,
  AuthSheet,
  CollectionScreen,
  CorrectionsScreen,
  DesktopChrome,
  EntityScreen,
  ErrorState,
  HomeScreen,
  IconButton,
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
  StageIdlePane,
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
  toSyncPanel,
  useTheme,
} from '@auqw/ui-web';
import type { TrackRowModel } from '@auqw/ui-web';
import {
  entityRefKey,
  errorText,
  navItems,
  qualityOptions,
  reportResult,
  themeOptions,
  toAuthSheetModel,
} from '@auqw/ui-shared';
import type { Boot, OverlayEntry } from '@auqw/ui-shared';
import type {
  SyncDeviceInfo,
  SyncNearbyPeer,
  SyncPairingResult,
  SyncStatusResult,
} from '../shared/contract.ts';
import type { ThemeSource } from '@auqw/design-tokens/adaptive';
import { useAppShell } from '@auqw/app-shell';
import type { AppShellPorts } from '@auqw/app-shell';
import { createDesktopAuth } from './auth.ts';
import { createDesktopUpdate } from './update.ts';
import { createSessionController } from './controller.ts';
import type { SessionController } from './controller.ts';
import { shellToAppError } from './ipc-errors.ts';
import { createPeaksCacheStore } from '@auqw/storage-sqlite';
import { createSqliteDriver } from './sqlite-driver.ts';
import { createWebPeaksPort } from './web-peaks.ts';

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
          // Log the typed kind only — a bridge exception can embed a
          // signed URL or token that has no business in renderer logs.
          console.warn('[ui] boot failed:', shellToAppError(thrown).kind);
          setBoot({
            type: 'failed',
            message:
              errorText(shellToAppError(thrown)) ??
              t('boot.failedMessage'),
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

/** Full-screen centered gate frame shared by boot/restore/locale gates. */
const gateStyle: CSSProperties = {
  height: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'var(--canvas)',
};

/** Conditional SheetScreen — `body` renders only while the sheet is up. */
const sheet = (
  key: string,
  onDismissed: () => void,
  open: boolean,
  body: () => ReactNode,
): ReactNode =>
  open ? (
    <SheetScreen stackKey={key} onDismissed={onDismissed}>
      {body()}
    </SheetScreen>
  ) : null;

function BootGate({
  boot,
  onRetry,
}: {
  readonly boot: Boot<SessionController>;
  readonly onRetry: () => void;
}) {
  return (
    <div style={gateStyle}>
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
    <div style={gateStyle}>
      {state.type === 'restore-failed' ? (
        <ErrorState
          title={t('boot.restoreFailed')}
          hint={errorText(state.error)}
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
  const importInput = useRef<HTMLInputElement | null>(null);
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
  // Sheet-open generation — a mint resolving after dismissal must not
  // resurrect an offer the remint effect would keep refreshing forever.
  const pairSheetGen = useRef(0);
  // Last-mint-wins + in-flight serialization: pairing() isn't instant,
  // and a slow mint must not let an EARLIER reply overwrite a newer
  // offer or stack concurrent mints behind the tick.
  const pairMintRef = useRef(0);
  const pairMintInFlight = useRef(false);
  /** Mint a pairing offer — every mint path (sheet open, consumed-offer
   * remint, expiry remint) lands its result only while it is still the
   * newest attempt of a still-open sheet generation. */
  const mintOffer = useCallback(
    (
      gen: number,
      opts?: {
        readonly inFlight?: boolean;
        readonly onOk?: () => void;
        readonly onFail?: (thrown: unknown) => void;
      },
    ): void => {
      const attempt = ++pairMintRef.current;
      if (opts?.inFlight === true) {
        pairMintInFlight.current = true;
      }
      const alive = () =>
        gen === pairSheetGen.current && attempt === pairMintRef.current;
      void window.auqw.sync
        .pairing()
        .then((offer) => {
          if (alive()) {
            setPairing(offer);
            opts?.onOk?.();
          }
        })
        .catch((thrown: unknown) => {
          if (alive()) {
            opts?.onFail?.(thrown);
            setPairing(null);
          }
        })
        .finally(() => {
          if (opts?.inFlight === true) {
            pairMintInFlight.current = false;
          }
        });
    },
    [],
  );
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
        // the sheet never displays a dead code.
        mintOffer(pairSheetGen.current);
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
  }, [pairSheetOpen, mintOffer]);
  const onPairDevice = useCallback(() => {
    setPairSheetOpen(true);
    const gen = ++pairSheetGen.current;
    mintOffer(gen, {
      onOk: () => setPairingError(null),
      // A mint failure (listener down, no LAN address) must surface —
      // a silent reject leaves the row looking dead-clicked.
      onFail: (thrown) => {
        if (gen === pairSheetGen.current) {
          setPairing(null);
          setPairingError(errorText(shellToAppError(thrown)));
        }
      },
    });
  }, [mintOffer]);
  const syncRefresh = useCallback(() => {
    const { sync } = window.auqw;
    void sync.status().then(setSyncStatus, () => setSyncStatus(null));
    void sync
      .devices()
      .then((result) => setSyncDevices(result.devices), () =>
        setSyncDevices([]),
      );
  }, []);
  const onUnpairDevice = useCallback(
    (deviceId: string) => {
      void window.auqw.sync.unpair({ id: deviceId }).then(syncRefresh);
    },
    [syncRefresh],
  );
  const onSyncNow = useCallback(() => {
    void window.auqw.sync
      .trigger()
      .then(syncRefresh)
      // A rejected kick resolved nothing — surface it on the toast
      // like every other session op instead of clicking dead.
      .catch((thrown: unknown) => {
        reportResult('sync.syncNow', err(shellToAppError(thrown)));
      });
  }, [syncRefresh]);
  const closePairSheet = useCallback(() => {
    pairSheetGen.current += 1;
    setPairing(null);
    setPairSheetOpen(false);
  }, []);
  // Every dial path settles the same: success retires the sheet like
  // a dismiss (generation bump so an in-flight offer mint can't land
  // a stale offer into `pairing` after close); failure surfaces the
  // typed message under the form.
  const finishDial = useCallback(() => {
    setDialing(false);
    closePairSheet();
    syncRefresh();
  }, [closePairSheet, syncRefresh]);
  const failDial = useCallback((thrown: unknown) => {
    setDialing(false);
    setDialError(errorText(shellToAppError(thrown)));
  }, []);
  const runDial = useCallback(
    (attempt: () => Promise<unknown>) => {
      if (dialing) {
        return;
      }
      setDialing(true);
      setDialError(null);
      void attempt().then(finishDial).catch(failDial);
    },
    [dialing, finishDial, failDial],
  );
  const onDialNearby = useCallback(
    (key: string, code: string) => {
      const peer = nearbyPeers.find((entry) => entry.key === key);
      if (peer !== undefined) {
        runDial(() =>
          window.auqw.sync.dial({
            host: peer.host,
            port: peer.port,
            code,
            hosts: peer.addresses,
            ...(peer.fp !== null ? { fp: peer.fp } : {}),
          }),
        );
      }
    },
    [nearbyPeers, runDial],
  );
  // The typed join — desktop's counterpart to the mobile PairForm:
  // code + host + port dial, no camera anywhere in the path.
  const onPairCode = useCallback(
    (input: { code: string; host: string; port: number | null }) => {
      const { code, host, port } = input;
      if (port !== null) {
        runDial(() => window.auqw.sync.dial({ host, port, code }));
      }
    },
    [runDial],
  );
  const onPastePayload = useCallback(
    (payload: string) =>
      runDial(() => window.auqw.sync.dialPayload({ payload })),
    [runDial],
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
    mintOffer(pairSheetGen.current, { inFlight: true });
    // pairingTick drives the re-check; pairing.expiresAt is the gate.
  }, [pairSheetOpen, pairing, pairingTick, mintOffer]);

  // Real waveform peaks for the Stage seek — the port borrows the
  // live stream handle; it never owns or closes it.
  const peaksPort = useMemo(
    () =>
      createWebPeaksPort({
        stream: window.auqw.stream,
        // `lf-*` handles carry no seam session — local bytes come from
        // the utility's grant-gated ranged read instead.
        localUriFor: controller.localUriFor,
        localRead: window.auqw.local.read,
      }),
    [controller],
  );

  // Persisted peaks — one device-local `peaks_cache` table; repeat
  // plays render the stored profile instantly without re-extraction.
  const peaksStore = useMemo(
    () => createPeaksCacheStore(createSqliteDriver(window.auqw.storage)),
    [],
  );

  // The shared shell composition — every state/callback surface the
  // mobile shell builds identically lives in useAppShell; this file
  // keeps only the platform seams (connectivity, the local-playback
  // capability probe, the sync IPC surface, browser file pickers /
  // clipboard, the artwork-cache row omission) wired through ports.
  const authPort = useMemo(
    () => createDesktopAuth(window.auqw),
    [],
  );
  // Release update check — the IPC-backed snapshot cache; stable for
  // the same one-listener reason as authPort. Desktop's install
  // level is 'open': the banner's action opens the release page.
  const updatePort = useMemo(
    () => createDesktopUpdate(window.auqw),
    [],
  );
  const ports = useMemo<AppShellPorts<Overlay>>(
    () => ({
      subscribeOnline: controller.subscribeOnline,
      // Foreground edges drive the shell's appActive gate — a hidden
      // window's lyrics clock stops ticking (Chromium throttles the
      // timer anyway; this skips the reconciler work it would wake).
      subscribeAppActive: (listener) => {
        listener(!document.hidden);
        const onVisibility = () => listener(!document.hidden);
        document.addEventListener('visibilitychange', onVisibility);
        return () =>
          document.removeEventListener('visibilitychange', onVisibility);
      },
      // OAuth session trust — the IPC-backed auth surface; token
      // material never crosses into this renderer. The adapter is
      // hoisted to a stable memo: each instance wires one `auth:state`
      // ipcRenderer listener, so rebuilding it per ports-memo churn
      // would leak listeners (the preload helper caps at 10 before
      // warning).
      auth: authPort,
      update: updatePort,
      localPlayable: (id) => controller.localPlaybackFor(id) !== null,
      trackAttemptActions: true,
      gateAdvanceAlways: true,
      entityPlayRequiresCanPlay: true,
      // Desktop's home suggestion lookup only reached the first 12
      // results (the rail's depth); mobile searched the whole page.
      homeSuggestionLimit: 12,
      stageInitiallyOpen: true,
      openSync: () => setSyncFocusTick((n) => n + 1),
      afterLocalMutation: (_mutated, refreshLocal) => {
        // Re-read the live source — a mid-flight rehydrate swaps the
        // instance, and committing the captured one's stale snapshot
        // would clobber rows it never saw.
        const source = controller.local();
        if (source !== null) {
          session.syncLocalRecordings(source.recordings());
          refreshLocal();
        }
      },
      peaksPort,
      peaksStore,
      settingsExtras: () => ({
        // The probe surface only exists once rehydrateMedia ran —
        // gate the rows on it instead of dead-pressing behind a null
        // local().
        localSupported: controller.local() !== null,
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
      }),
      // The artwork cache budget row stays off the desktop list: the
      // renderer has no application artwork cache — Chromium's image
      // cache owns artwork memory — so the row would dead-end.
      omitSettingsRows: ['artworkCacheBytes'],
      // Sandboxed renderers have no filesystem — the browser's
      // download path is the honest destination.
      exportJson: async (json, name) => {
        try {
          const url = URL.createObjectURL(
            new Blob([json], { type: 'application/json' }),
          );
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = name;
          anchor.click();
          URL.revokeObjectURL(url);
          return {
            kind: 'done',
            detail: () => t('transfer.savedToDownloads', { name }),
          };
        } catch {
          return { kind: 'error' };
        }
      },
    }),
    [controller, session, peaksPort, syncStatus],
  );

  const shell = useAppShell<Overlay>({ controller, state, ports });
  const {
    localeApplied,
    localeTick,
    online,
    toast,
    tab,
    selectTab,
    focusSearch,
    searchFocusTick,
    overlayStack,
    pushOverlay,
    closeOverlay,
    dismissOverlay,
    stageOpen,
    setStageOpenFor,
    stageMode,
    setStageMode,
    reordering,
    toggleReordering,
    player,
    queueModel,
    peaks,
    onPlayPause,
    onToggleLike,
    advance,
    playQueueOccurrence,
    rowIntent,
    onMoveQueueItem,
    onMoveQueueItemTo,
    removeQueueOccurrence,
    seekToPosition,
    playRecording,
    onResultPress,
    onHomeCardPress,
    playCollectionRows,
    playPlaylist,
    playPlaylistEntry,
    playRefFor,
    entityPlayAll,
    onEntityRowPress,
    entityRowMeta,
    query,
    setQuery,
    submitSearch,
    retrySearch,
    cancelSearch,
    applySearchText,
    searchRecents,
    suggestions,
    resultMetaFor,
    libraryModel,
    playlistModelFor,
    entityModelFor,
    entityFetches,
    homeModel,
    searchModel,
    settingsModel,
    correctionsModel,
    radioModel,
    lyricsModel,
    transfer,
    pickerItems,
    updateBanner,
    onUpdateBannerAct,
    onUpdateBannerDismiss,
    setActionsFor,
    closeRowActions,
    rowActions,
    onRowAction,
    pickerFor,
    setPickerFor,
    closePlaylistPicker,
    onPickPlaylist,
    onCreateAndPick,
    providerPicker,
    onPickProvider,
    closeProviderPicker,
    themePickerOpen,
    onPickTheme,
    closeThemePicker,
    languagePickerOpen,
    onPickLanguage,
    closeLanguagePicker,
    storefrontSheetOpen,
    storefrontDraft,
    onSubmitStorefront,
    onClearStorefront,
    closeStorefront,
    authSnapshot,
    authSheetOpen,
    onAuthRecovery,
    closeAuthSheet,
    retryAuthFlow,
    onAuthSignOut,
    authClientSheetOpen,
    authClientDraft,
    onSubmitAuthClient,
    onClearAuthClient,
    closeAuthClient,
    qualityPickerOpen,
    onPickQuality,
    closeQualityPicker,
    onSettingsSelect,
    onSettingsToggle,
    stageDownload,
    onStageDownload,
    onStageAddToPlaylist,
    playlistDownloadFor,
    onPlaylistDownloadAll,
    onStartRadioGated,
    onStopRadio,
    onRetryLyrics,
    setReviewFilter,
    loadReviews,
    reviewOp,
    loadEntityPage,
    openEntity,
    onLoadMore,
    onExport,
    beginImportRead,
    onImportText,
    cancelImportRead,
    failImportRead,
    onApplyImport,
    onResetImport,
    renamePlaylist,
    deletePlaylist,
    removePlaylistEntry,
    movePlaylistEntry,
    onOpenCard,
    onCreatePlaylist,
  } = shell;

  // Metadata-targeted sheet openers — search rows and entity rows
  // share the {kind:'metadata'} target shape.
  const metaPick = (meta: TrackMetadata | undefined) => {
    if (meta !== undefined) {
      setPickerFor({ kind: 'metadata', meta });
    }
  };
  const metaActions = (meta: TrackMetadata | undefined) => {
    if (meta !== undefined) {
      setActionsFor({ kind: 'metadata', meta });
    }
  };

  useEffect(() => {
    if (tab !== 'settings') {
      // Reset the anchor tick: leaving the tab unmounts the section
      // ref, and a stale tick would re-scroll on the next mount.
      setSyncFocusTick(0);
      return;
    }
    syncRefresh();
    const timer = window.setInterval(() => {
      // A hidden window can't read the panel — skip the IPC fan-out
      // and re-sync once on becoming visible.
      if (!document.hidden) {
        syncRefresh();
      }
    }, 5_000);
    const onVisible = () => {
      if (!document.hidden) {
        syncRefresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tab, syncRefresh]);

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

  const onImportFileChosen = useCallback(
    (file: globalThis.File | null) => {
      if (file === null) {
        cancelImportRead();
        return;
      }
      void file.text().then(
        (text) => onImportText(text, file.name),
        () => failImportRead(),
      );
    },
    [cancelImportRead, onImportText, failImportRead],
  );

  // The fallback file dialog emits no `change` on dismiss — `cancel`
  // (not in this React's typings) is the only recovery hook; without it
  // a cancelled pick latches the button on 'working…' forever.
  useEffect(() => {
    const input = importInput.current;
    const onCancel = () => cancelImportRead();
    input?.addEventListener('cancel', onCancel);
    return () => input?.removeEventListener('cancel', onCancel);
  }, [cancelImportRead]);

  const onPickImportFile = useCallback(() => {
    beginImportRead();
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
          cancelImportRead();
          return;
        }
        // Picker rejected for a real reason — fall back to the input.
        importInput.current?.click();
      });
  }, [beginImportRead, onImportFileChosen, cancelImportRead]);

  const renderTabScreen = (key: string) => {
    switch (key) {
      case 'explore':
        return (
          <SearchScreen
            key={searchFocusTick}
            state={searchModel}
            query={query}
            onQueryChange={setQuery}
            onSubmit={submitSearch}
            onCancel={cancelSearch}
            onRetry={retrySearch}
            onResultPress={onResultPress}
            onRowIntent={(row) => {
              const meta = resultMetaFor(row.key);
              if (meta !== undefined) {
                rowIntent({ kind: 'track', track: meta });
              }
            }}
            onAddToPlaylist={(row) => metaPick(resultMetaFor(row.key))}
            onContext={(row) => metaActions(resultMetaFor(row.key))}
            recents={searchRecents}
            onRecentPress={applySearchText}
            suggestions={suggestions}
            onSuggestionPress={applySearchText}
            autoFocus
          />
        );
      case 'library':
        return (
          <LibraryScreen
            model={libraryModel}
            onPressItem={(id) => void playRecording(id)}
            onRowIntent={(id) => rowIntent({ kind: 'recording', id })}
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
            onPressCard={onHomeCardPress}
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
            onRowIntent={(row) =>
              rowIntent({ kind: 'recording', id: row.recordingId })
            }
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
        const downloadAll = playlistDownloadFor(playlistModel);
        return (
          <PlaylistScreen
            model={playlistModel}
            onBack={closeOverlay}
            onPlayAll={() => playPlaylist(playlistModel)}
            onDownloadAll={() => onPlaylistDownloadAll(downloadAll.requests)}
            downloadAllState={downloadAll.state}
            onRename={(name) => renamePlaylist(current.playlistId, name)}
            onDelete={() => {
              deletePlaylist(current.playlistId);
              dismissOverlay(entry.key);
            }}
            onPressEntry={playPlaylistEntry}
            onRowIntent={(entry) =>
              rowIntent({
                kind: 'recording',
                id: entry.recordingId,
                ref: playRefFor(entry.recordingId, entry.selectedRef),
              })
            }
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
            onRemoveEntry={(entry) => removePlaylistEntry(entry.entryId)}
            onMoveEntry={(move, direction) =>
              movePlaylistEntry(playlistModel, move, direction)
            }
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
          entityRowMeta(entry.key, row);
        return (
          <EntityScreen
            model={entityModelFor(fetch)}
            onBack={closeOverlay}
            onPlayAll={() => entityPlayAll(fetch, entry.key, false)}
            onShuffleAll={() => entityPlayAll(fetch, entry.key, true)}
            onToggleLike={
              entityId === null
                ? undefined
                : () =>
                    void session.toggleEntityLike(current.ref.kind, entityId)
            }
            onPressItem={(row) => onEntityRowPress(entry.key, row)}
            onRowIntent={(row) => {
              const meta = metaFor(row);
              if (meta !== undefined) {
                rowIntent({ kind: 'track', track: meta });
              }
            }}
            onAddToPlaylist={(row) => metaPick(metaFor(row))}
            onContext={(row) => metaActions(metaFor(row))}
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
      <div style={gateStyle}>
        <LoadingState title={t('boot.restoring')} />
      </div>
    );
  }

  return (
    <div
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
            onSelect={selectTab}
            onOpenSettings={() => selectTab('settings')}
            onFocusSearch={focusSearch}
            stageOpen={stageOpen}
            onStageOpenChange={setStageOpenFor}
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
                  shuffle={state.shuffle}
                  onToggleShuffle={() => void session.toggleShuffle()}
                  repeat={state.repeat}
                  onCycleRepeat={() => void session.cycleRepeat()}
                  download={stageDownload}
                  onDownload={onStageDownload}
                  onAddToPlaylist={onStageAddToPlaylist}
                  onStopPlayback={() => void session.stop()}
                  onRecovery={onAuthRecovery}
                  onSeek={seekToPosition}
                  peaks={peaks}
                  onRetryLyrics={onRetryLyrics}
                  onStartRadio={onStartRadioGated}
                  onStopRadio={onStopRadio}
                  onPressQueueItem={playQueueOccurrence}
                  onQueueRowIntent={(id) =>
                    rowIntent({ kind: 'occurrence', id })
                  }
                  onRemoveQueueItem={removeQueueOccurrence}
                  onToggleQueueReorder={toggleReordering}
                  onMoveQueueItem={onMoveQueueItem}
                  onMoveQueueItemTo={onMoveQueueItemTo}
                />
              ) : (
                // An ended queue keeps its surface: queue mode shows it
                // (a row press replays through playOccurrence); other
                // modes get the empty pane. The floating segment stays
                // mounted either way.
                <StageIdlePane
                  mode={stageMode}
                  onModeChange={setStageMode}
                  queue={queueModel.ended ? queueModel : undefined}
                  queueReordering={reordering}
                  onToggleQueueReorder={toggleReordering}
                  onPressQueueItem={playQueueOccurrence}
                  onQueueRowIntent={(id) =>
                    rowIntent({ kind: 'occurrence', id })
                  }
                  onRemoveQueueItem={removeQueueOccurrence}
                  onMoveQueueItem={onMoveQueueItem}
                  onMoveQueueItemTo={onMoveQueueItemTo}
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
          {updateBanner !== null && (
            <div
              style={{
                position: 'fixed',
                // Stacks under the offline pill when both are up.
                top: online === false ? 36 : 8,
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 8px 5px 12px',
                borderRadius: 999,
                backgroundColor: 'var(--raised)',
                border: 'var(--stroke-hairline) solid var(--hairline)',
                zIndex: 40,
              }}
            >
              <Text variant="metadata" color="secondary">
                {updateBanner.label}
              </Text>
              <button
                type="button"
                className="uw-pressable"
                style={{ padding: '2px 8px', borderRadius: 999 }}
                onClick={onUpdateBannerAct}
              >
                <Text variant="metadata" color="accent">
                  {updateBanner.actionLabel}
                </Text>
              </button>
              <IconButton
                icon="close"
                size={20}
                iconSize={10}
                ariaLabel={t('update.dismiss')}
                onPress={onUpdateBannerDismiss}
              />
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
        {sheet('sheet-actions', closeRowActions, rowActions !== null, () =>
          rowActions === null ? null : (
            <RowActionsSheet
              title={rowActions.title}
              actions={rowActions.actions}
              onAction={onRowAction}
              onDismiss={closeRowActions}
            />
          ),
        )}
        {sheet(
          'sheet-add-playlist',
          closePlaylistPicker,
          pickerFor !== null,
          () => (
            <AddToPlaylistSheet
              playlists={pickerItems}
              onPick={onPickPlaylist}
              onCreate={onCreateAndPick}
              onDismiss={closePlaylistPicker}
            />
          ),
        )}
        {sheet(
          'sheet-provider',
          closeProviderPicker,
          providerPicker !== null,
          () =>
            providerPicker === null ? null : (
              <ProviderPickerSheet
                title={providerPicker.title}
                options={providerPicker.options}
                selectedKey={providerPicker.selectedKey}
                onPick={onPickProvider}
                onDismiss={closeProviderPicker}
              />
            ),
        )}
        {sheet('sheet-storefront', closeStorefront, storefrontSheetOpen, () => (
          <ValueFieldSheet
            title={t('settings.storefront')}
            initial={storefrontDraft}
            placeholder={t('sheets.countryCodePlaceholder')}
            submitLabel={t('common.save')}
            clearLabel={t('sheets.autoClear')}
            onSubmit={onSubmitStorefront}
            onClear={onClearStorefront}
            onDismiss={closeStorefront}
          />
        ))}
        {sheet('sheet-quality', closeQualityPicker, qualityPickerOpen, () => (
          <ProviderPickerSheet
            title={t('settings.quality')}
            options={qualityOptions()}
            selectedKey={`${state.settings.qualityKbps}`}
            onPick={onPickQuality}
            onDismiss={closeQualityPicker}
          />
        ))}
        {sheet('sheet-pairing', closePairSheet, pairSheetOpen, () => (
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
                : () => void navigator.clipboard.writeText(pairing.payload)
            }
            onDismiss={closePairSheet}
          />
        ))}
        {sheet('sheet-theme', closeThemePicker, themePickerOpen, () => (
          <ProviderPickerSheet
            title={t('settings.theme')}
            options={themeOptions()}
            selectedKey={state.settings.theme}
            onPick={onPickTheme}
            onDismiss={closeThemePicker}
          />
        ))}
        {sheet('sheet-language', closeLanguagePicker, languagePickerOpen, () => (
          <ProviderPickerSheet
            title={t('sheets.languageTitle')}
            options={languageOptions()}
            selectedKey={languageOptionKey(state.settings.language)}
            onPick={onPickLanguage}
            onDismiss={closeLanguagePicker}
          />
        ))}
        {sheet('sheet-auth', closeAuthSheet, authSheetOpen, () => (
          <AuthSheet
            model={toAuthSheetModel(
              authSnapshot?.status ?? { state: 'signed-out' },
            )}
            onCopyCode={ports.auth?.copyText}
            onOpenLink={ports.auth?.openUrl}
            onRetry={retryAuthFlow}
            onSignOut={onAuthSignOut}
            onDismiss={closeAuthSheet}
          />
        ))}
        {sheet(
          'sheet-auth-client',
          closeAuthClient,
          authClientSheetOpen,
          () => (
            <ValueFieldSheet
              title={t('auth.clientId.title')}
              initial={authClientDraft}
              placeholder={t('auth.clientId.placeholder')}
              submitLabel={t('common.save')}
              clearLabel={t('auth.clientId.clear')}
              onSubmit={onSubmitAuthClient}
              onClear={onClearAuthClient}
              onDismiss={closeAuthClient}
            />
          ),
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
