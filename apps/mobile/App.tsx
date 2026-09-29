import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  Clipboard,
  Keyboard,
  Linking,
  Platform,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { requireOptionalNativeModule } from 'expo';
import { Directory, File, Paths } from 'expo-file-system';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import * as AuqwExpo from 'auqw-expo';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  ARTWORK_CACHE_BUDGET_DEFAULT_BYTES,
  CancellationSource,
  ProviderRouter,
  SearchSession,
  appError,
  appErrorKind,
  collectSyncDeltaDocs,
  effectiveMapping,
  err,
  exportFittedDeltaDoc,
  formatEndpoint,
  fromUnknown,
  isMatchGate,
  isRefRejected,
  parseSyncDeltaDocs,
  previewImport,
  queuedOccurrenceFor,
  queuedOccurrenceForRef,
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
  SyncClientStatus,
  TrackMetadata,
} from '@auqw/application';
import {
  AddToPlaylistSheet,
  AppStack,
  ArtworkResolverProvider,
  CollectionScreen,
  CorrectionsScreen,
  EntityScreen,
  ErrorState,
  GalleryScreen,
  HomeScreen,
  LanguagePickerSheet,
  LibraryScreen,
  LoadingState,
  MiniPlayer,
  PlatformTabs,
  PlaylistScreen,
  Pressable,
  ProviderPickerSheet,
  PushScreen,
  RowActionsSheet,
  SearchScreen,
  SettingsScreen,
  SheetScreen,
  StackItem,
  StageSheet,
  SyncScreen,
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
  toImportPreviewModel,
  toLibraryModel,
  toHomeModel,
  toLyricsModel,
  toPlayerModel,
  toPlaylistModel,
  toQueueModel,
  toRadioModel,
  toSearchRowModel,
  toSettingsModel,
  formatExpiry,
  toSyncModel,
  toTrackRowModel,
  useTheme,
} from '@auqw/ui-native';
import type {
  ArtworkResolver,
  CollectionRowModel,
  CorrectionsFilter,
  DownloadChip,
  DiagnosticsModel,
  LyricsModel,
  MessageId,
  PlayerModel,
  ProviderPickerOption,
  StageMode,
  ThemeSource,
  TrackRowModel,
  TransferModel,
} from '@auqw/ui-native';
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
  navItems,
  nextQueueDestination,
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
  OverlayEntry,
  ProviderSlot,
  ReviewFetch,
} from '@auqw/ui-shared';
import { createSessionController } from './src/session/controller.ts';
import type { SessionController } from './src/session/controller.ts';
import { activateHomeCard } from './src/session/home-card.ts';
import { createAuqwExpoPlayer } from './src/adapters/auqw-expo-player.ts';
import { createExpoPeaksPort } from './src/adapters/expo-peaks.ts';
import { useWaveformPeaks } from '@auqw/ui-shared';
import type { PeaksTarget } from '@auqw/ui-shared';
import { discoveredPotProviderUrl } from './src/adapters/pot-provider-discovery.ts';
import { potProviderUrlFromPeers } from './src/adapters/pot-provider.ts';
import { createClock, createIds } from '@auqw/application';
import { devRoute } from './src/dev-routes.ts';
import { appFilePath, runSeamLink } from './seam-dev.ts';

// Boot and gate strings render before the ready settings arrive —
// seed the UI language from the system tag so those first screens
// translate too; Main still pins the persisted language afterwards.
setLocale(resolveLocale(undefined, systemLocaleTag()));

// PO-token service (bgutil /get_pot contract). Source order: the
// paired desktop's discovered endpoint (persisted SyncPeer.pot) >
// EXPO_PUBLIC_POT_PROVIDER_URL dev override (from the Android
// emulator, http://10.0.2.2:4416 reaches a provider on the host
// machine) > none — unset peers resolve on the anonymous ladder.
const POT_PROVIDER_URL = process.env.EXPO_PUBLIC_POT_PROVIDER_URL || undefined;

/**
 * expo-navigation-bar's <NavigationBar> component calls the native
 * setHidden/setStyle through an unawaited stack helper — a call
 * landing while the activity is gone (relaunch) rejects 'no longer
 * available' and toasts a LogBox. The app's only writes are style
 * flips, so the native module is driven directly here with the
 * rejection swallowed at the seam.
 */
const expoNavigationBar =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<{
        setStyle: (style: 'light' | 'dark') => Promise<void>;
      }>('ExpoNavigationBar')
    : null;

// Bounds the held-sheet release: long enough for the settle spring
// (stage-sheet STAGE_SETTLE_SPRING, critically damped at 200/28) to
// land before unmount.
const STAGE_RELEASE_MS = 450;

/**
 * The sync screen's QR scanner — expo-camera lives in the app (not
 * ui-native), so the camera mounts here and the screen receives it
 * through its renderScanner seam. Permission is requested lazily on
 * first open; denied/restricted renders an honest prompt, never a
 * dead black frame.
 */
function SyncScanner({ onScan }: { readonly onScan: (data: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const consumed = useRef(false);
  useEffect(() => {
    if (permission !== null && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);
  if (permission === null || !permission.granted) {
    return (
      <Pressable
        onPress={() => void requestPermission()}
        accessibilityLabel={t('sync.cameraGrantA11y')}
        accessibilityRole="button"
        style={{ padding: 14 }}
      >
        <Text variant="metadata" color="secondary">
          {t('sync.cameraNeeded')}
        </Text>
      </Pressable>
    );
  }
  return (
    <CameraView
      style={{ flex: 1 }}
      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
      onBarcodeScanned={(result) => {
        if (!consumed.current && typeof result.data === 'string') {
          consumed.current = true;
          onScan(result.data);
        }
      }}
    />
  );
}

// On-disk artwork LRU sizes, MiB — inside the domain's 16 MiB–1 GiB
// artworkCacheBytes bounds; 200 is the spec default (data.md).
function artworkCacheOptions(): readonly ProviderPickerOption[] {
  return [
    { key: '16', label: '16 mb', detail: t('optionDetail.minimum') },
    { key: '64', label: '64 mb' },
    { key: '128', label: '128 mb' },
    { key: '200', label: '200 mb', detail: t('optionDetail.default') },
    { key: '256', label: '256 mb' },
    { key: '512', label: '512 mb' },
    { key: '1024', label: '1024 mb', detail: t('optionDetail.maximum') },
  ];
}

// A SAF file URI (content://…/document/<encoded docId>) reads as a
// path the user can find — "Download/auqw-library-….json" — rather
// than a provider-internal tree id.
function exportDestinationLabel(uri: string): string {
  if (!uri.startsWith('content://')) {
    return uri;
  }
  const raw = uri.split('/document/').pop() ?? uri;
  let docId = raw;
  try {
    docId = decodeURIComponent(raw);
  } catch {
    // A provider that escapes its docId badly still exported fine —
    // fall back to the raw id instead of surfacing a write failure
    // for what is only a label-formatting problem.
  }
  return docId.replace(/^[a-zA-Z0-9_-]+:/, '');
}

export function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_700Bold,
  });
  const [attempt, setAttempt] = useState(0);
  const [boot, setBoot] = useState<Boot<SessionController>>({
    type: 'loading',
  });

  useEffect(() => {
    let disposed = false;
    let controller: SessionController | null = null;
    let startSource: CancellationSource | null = null;
    setBoot({ type: 'loading' });
    void (async () => {
      try {
        // potProviderUrl is a one-shot createHost input — the
        // persisted peer endpoint must be read before the controller
        // exists, and a corrupt/missing record degrades to the env
        // override, then the bare ladder.
        const created = await createSessionController(AuqwExpo, {
          potProviderUrl:
            (await discoveredPotProviderUrl()) ?? POT_PROVIDER_URL,
          // Android plays through the native Media3 seam (background
          // queue projection + lock-screen controls); iOS keeps the
          // provisional expo-audio path until the seam's iOS player
          // lands — auqw-expo is host-only there.
          ...(Platform.OS === 'android'
            ? { player: () => createAuqwExpoPlayer(AuqwExpo) }
            : {}),
        });
        if (disposed) {
          await created.dispose();
          return;
        }
        controller = created;
        // restore() never throws — its Result surfaces through
        // session state as 'restore-failed'.
        await created.session.restore();
        if (disposed) {
          // Unmounted mid-restore — init/stop must not run after
          // dispose.
          await created.dispose();
          return;
        }
        // Slice-3 bring-up: local index + download ledger. Ran after
        // restore so its storage reads can't interleave. The source
        // is retained so unmount cancels a still-running start —
        // DownloadManager.init must never run after dispose.
        startSource = new CancellationSource();
        await created.start(startSource.signal);
        if (disposed) {
          await created.dispose();
          return;
        }
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
      startSource?.cancel();
      const c = controller;
      controller = null;
      if (c !== null) {
        void c.dispose();
      }
    };
  }, [attempt]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {boot.type === 'ready' ? (
          <Shell controller={boot.controller} />
        ) : (
          <ThemeProvider theme="system">
            <BootGate
              boot={boot}
              fontsLoaded={fontsLoaded}
              onRetry={() => setAttempt((n) => n + 1)}
            />
          </ThemeProvider>
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function BootGate({
  boot,
  fontsLoaded,
  onRetry,
}: {
  readonly boot: Boot<SessionController>;
  readonly fontsLoaded: boolean;
  readonly onRetry: () => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.canvas,
        justifyContent: 'center',
      }}
    >
      <StatusBar style={theme.scheme === 'light' ? 'dark' : 'light'} />
      {boot.type === 'failed' ? (
        <ErrorState
          title={t('boot.startFailed')}
          hint={boot.message}
          onRetry={onRetry}
        />
      ) : (
        <LoadingState
          title={fontsLoaded ? t('boot.loadingPlugins') : t('state.loading')}
        />
      )}
    </View>
  );
}

/**
 * 'adaptive' asks the OS for its palette: Android 12+ reads the
 * Material You system_accent / system_neutral tonal stops — the flag
 * chooses which tone serves bg vs fg and accent1_200 vs _600 — while
 * iOS exposes no palette and resolves flag-only (same as 'system').
 * There's no push channel for wallpaper-driven changes, so the read
 * repeats when the app returns to the foreground.
 */
function useAdaptiveSource(enabled: boolean): ThemeSource | null {
  // useColorScheme() can return null — match ThemeProvider's light
  // fallback rather than guessing dark.
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const [tones, setTones] = useState<AuqwExpo.SystemTonalPalette | null>(
    null,
  );
  useEffect(() => {
    if (!enabled || Platform.OS !== 'android') {
      setTones(null);
      return undefined;
    }
    let live = true;
    // A reselection must not flash the previous read's palette — start
    // flag-only until the fresh read lands.
    setTones(null);
    // Overlapping reads can resolve out of order (a stalled first read
    // landing after a foreground refresh); only the newest generation
    // may write.
    let generation = 0;
    const read = () => {
      const mine = ++generation;
      void AuqwExpo.systemTonalPalette()
        .then((next) => {
          if (live && mine === generation) {
            setTones(next);
          }
        })
        .catch(() => {
          if (live && mine === generation) {
            setTones(null);
          }
        });
    };
    read();
    const sub = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        read();
      }
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [enabled]);
  return useMemo<ThemeSource | null>(() => {
    if (!enabled) {
      return null;
    }
    if (tones === null) {
      return { scheme };
    }
    return {
      scheme,
      palette: {
        bg: scheme === 'dark' ? tones.neutral1_900 : tones.neutral1_50,
        fg: scheme === 'dark' ? tones.neutral1_50 : tones.neutral1_900,
        accent:
          scheme === 'dark' ? tones.accent1_200 : tones.accent1_600,
      },
    };
  }, [enabled, tones, scheme]);
}

function Shell({ controller }: { readonly controller: SessionController }) {
  const [state, setState] = useState<SessionState>(() =>
    controller.session.snapshot(),
  );
  useEffect(
    () => controller.session.subscribe(setState),
    [controller],
  );
  // Every Artwork in the tree resolves remote urls through the
  // bounded on-disk cache; a failed lookup resolves to null and the
  // component renders the remote url instead.
  const resolveArtwork = useCallback<ArtworkResolver>(
    (url, signal) =>
      controller.artworkCache
        .get(url, {
          requestId: createIds().next('artwork'),
          deadlineMs: createClock().nowMs() + 30_000,
          signal,
        })
        .then((result) => (result.ok ? result.value.filePath : null)),
    [controller],
  );
  const theme = state.type === 'ready' ? state.settings.theme : 'system';
  const source = useAdaptiveSource(theme === 'adaptive');
  // OS font scale feeds textScale — accessibility sizing isn't opt-in.
  const { fontScale } = useWindowDimensions();
  return (
    <ThemeProvider theme={theme} textScale={fontScale} source={source}>
      <ArtworkResolverProvider resolve={resolveArtwork}>
        {state.type === 'ready' ? (
          <Main controller={controller} state={state} />
        ) : (
          <SessionGate state={state} controller={controller} />
        )}
      </ArtworkResolverProvider>
    </ThemeProvider>
  );
}

function SessionGate({
  state,
  controller,
}: {
  readonly state: SessionState;
  readonly controller: SessionController;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.canvas,
        justifyContent: 'center',
      }}
    >
      <StatusBar style={theme.scheme === 'light' ? 'dark' : 'light'} />
      {state.type === 'restore-failed' ? (
        <ErrorState
          title={t('boot.restoreFailed')}
          hint={errorText(state.error)}
          onRetry={() => void controller.session.restore()}
        />
      ) : (
        <LoadingState title={t('boot.restoring')} />
      )}
    </View>
  );
}

type Overlay =
  | { readonly type: 'collection'; readonly key: 'liked' | 'top50' | 'history' | 'downloads' }
  | { readonly type: 'playlist'; readonly playlistId: string }
  | { readonly type: 'entity'; readonly ref: EntityRef }
  | { readonly type: 'corrections' }
  | { readonly type: 'transfer' }
  | { readonly type: 'sync' };

function Main({
  controller,
  state,
}: {
  readonly controller: SessionController;
  readonly state: ReadySession;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { session } = controller;
  // Playback position rides the session's light channel — status
  // ticks that only move position no longer publish whole state, so
  // the position read subscribes here instead of through `state`.
  const [positionMs, setPositionMs] = useState(() =>
    session.positionMs(),
  );
  useEffect(() => {
    const unsubscribe = session.subscribePosition(setPositionMs);
    // Re-read after subscribing — the channel doesn't replay, so a
    // tick landing between the render-time read and this effect
    // would otherwise be missed.
    setPositionMs(session.positionMs());
    return unsubscribe;
  }, [session]);
  const [tab, setTab] = useState('home');
  const [expanded, setExpanded] = useState(false);
  // Shared 0..1 morph progress between the mini-player pill and the
  // stage sheet — drags write it directly so the sheet tracks the
  // finger; `expanded` only flips once a gesture commits.
  const stageProgress = useSharedValue(0);
  // The sheet publishes its measured pixel travel here so the pill's
  // drag converts finger distance to progress over the same distance
  // the sheet physically translates.
  const stageTravel = useSharedValue(0);
  // Which gesture owns the in-flight settle (-1 = none): a release
  // writes its committed anchor here so the sheet's `expanded`-flip
  // effect doesn't restart the spring and drop the flick velocity.
  const stageAnchor = useSharedValue(-1);
  const [showGallery, setShowGallery] = useState(false);
  const [stageMode, setStageMode] = useState<StageMode>('player');
  const [reordering, setReordering] = useState(false);
  const [query, setQuery] = useState('');
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
  const [artworkCachePickerOpen, setArtworkCachePickerOpen] =
    useState(false);
  const [storefrontSheetOpen, setStorefrontSheetOpen] = useState(false);
  const [storefrontDraft, setStorefrontDraft] = useState('');
  const [qualityPickerOpen, setQualityPickerOpen] = useState(false);
  // Sheet openings are epoch-tagged — a save that resolves after the
  // user dismissed and reopened the sheet must not close the new one.
  const storefrontEpoch = useRef(0);
  const qualityEpoch = useRef(0);
  // Theme and language also bump on dismiss and on each pick, so a
  // late save from an earlier pick can neither close the sheet nor
  // apply a stale locale over a newer pick.
  const themeEpoch = useRef(0);
  const languageEpoch = useRef(0);
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
  const [attempts, setAttempts] = useState<readonly AttemptTrace[]>([]);
  const resultMeta = useRef(new Map<string, TrackMetadata>());
  // Library-world overlay stack: pushed routes — collection list,
  // playlist editor, provider entity page — rendered as native push
  // screens above the tab shell. Entity pages keep a fetch per ref so
  // popping back to a deeper screen restores its loaded content.
  const {
    stack: overlayStack,
    top: overlay,
    push: pushOverlay,
    reset: resetOverlay,
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
          downloadsLast.current = Date.now();
          setDownloads(controller.downloads.list());
        }, 1_000 - gap);
      }
      return;
    }
    downloadsLast.current = now;
    setDownloads(controller.downloads.list());
  }, [controller]);
  // null = connectivity unknown (no baseline yet) — the offline
  // banner renders only on an explicit false.
  const [online, setOnline] = useState<boolean | null>(null);
  // Bumped after a local-folder mutation so the model re-reads
  // `local.recordings()` — the source is storage-backed, not
  // evented, and scans here are user-initiated only.
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
  }, [controller, refreshDownloads, refreshUsage]);

  const refreshLocal = useCallback(() => {
    setLocalTick((t) => t + 1);
  }, []);

  useEffect(() => {
    let disposed = false;
    // Subscribe BEFORE the snapshot request: once any callback edge
    // has landed, a delayed snapshot resolving later is stale and
    // must not overwrite it.
    let edged = false;
    // Registration itself can throw (e.g. Android's callback quota) —
    // a failed watch must not take the mounted shell down; the
    // snapshot path below still seeds `online`.
    let unsub: () => void = () => {};
    try {
      unsub = controller.connectivity.subscribe((snap) => {
        edged = true;
        setOnline(snap.online);
      });
    } catch {
      // Edge-less mode: snapshot-only honesty.
    }
    void controller.connectivity.snapshot().then((snap) => {
      if (!disposed && !edged && snap.ok) {
        setOnline(snap.value.online);
      }
    });
    return () => {
      disposed = true;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

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
  const downloadRefFor = useCallback(
    (recordingId: string): SourceRef | null => {
      // The session resolves owned bytes through `localPlaybackFor`
      // only where the player can attach them — the iOS provisional
      // player has no local path, so a downloaded file there could
      // never play. Hide every creation affordance rather than
      // promise unplayable bytes; existing rows still surface in
      // Settings (removal works).
      if (Platform.OS === 'ios') {
        return null;
      }
      const recording = state.recordings.find((r) => r.id === recordingId);
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
    [state.recordings, state.settings.playbackProvider],
  );

  // Bytes on disk — a stored download or a scanned local file. Used
  // to drop provider pins (owned wins) and to roll download state up.
  const isOwned = useCallback(
    (recordingId: string): boolean =>
      controller.downloads.fileFor(recordingId) !== null ||
      (controller.local()?.uriMap().has(recordingId) ?? false),
    [controller],
  );

  // Offline honesty: rows render 'unavailable' when offline and
  // unowned — their play affordances must not fire a remote attempt.
  const canPlay = useCallback(
    (recordingId: string): boolean =>
      online !== false || isOwned(recordingId),
    [online, isOwned],
  );

  // Single download affordance: absent → request; queued/downloading
  // → cancel; failed → retry; stored → remove. The sheet label says
  // which it is.
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
          if (existing.error !== null) {
            reportResult(
              'action.download',
              err(
                appError(
                  appErrorKind(existing.error.kind),
                  existing.error.message,
                ),
              ),
            );
          }
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
  // The applied-import summary is also a localized string frozen into
  // transfer state — keep its counts beside the preview so the
  // localeTick effect can re-derive it too. Only read while
  // importPhase is 'done'; error details carry typed messages, which
  // are not localized.
  const importSummaryCounts = useRef<{
    tracks: number;
    likes: number;
    playlists: number;
  } | null>(null);
  useEffect(() => {
    const raw = importPreviewRaw.current;
    const counts = importSummaryCounts.current;
    if (raw === null && counts === null) {
      return;
    }
    setTransfer((prev) => ({
      ...prev,
      preview:
        raw === null
          ? prev.preview
          : toImportPreviewModel(raw.preview, raw.sourceLabel),
      importDetail:
        prev.importPhase === 'done' && counts !== null
          ? t('transfer.importSummary', {
              tracks: counts.tracks,
              likes: counts.likes,
              playlists: counts.playlists,
            })
          : prev.importDetail,
    }));
  }, [localeTick]);
  const [providerSlot, setProviderSlot] = useState<ProviderSlot | null>(null);

  // Slice-4 sync surface — null on iOS or when bring-up failed. The
  // client's own subscription feeds status; a failed bring-up leaves
  // the settings row disabled with 'unavailable', never a dead link.
  const syncSurface = controller.sync();
  const [syncStatus, setSyncStatus] = useState<SyncClientStatus | null>(
    () => syncSurface?.client.status() ?? null,
  );
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<AppError | null>(null);
  // Informational pair-surface notices that aren't errors: localized
  // message ids rendered in the same banner slot as pairError.
  // pairNotice = one-shot share-attempt messages; advertNotice = the
  // ongoing condition flag from onAdvertiseError — cleared only when
  // sharing stops or a fresh share retries the advert, never by a
  // pair attempt (the dead advert stays dead through pairing).
  const [pairNotice, setPairNotice] = useState<MessageId | null>(null);
  const [advertNotice, setAdvertNotice] = useState<MessageId | null>(null);
  // Symmetric pairing: `share` = this device hosting a QR/code offer;
  // `nearbyPeers` = mDNS-discovered devices we can dial into. Both
  // live only while the sync screen is open — the listener is
  // pairing-only (rounds still dial out via the client).
  const [share, setShare] = useState<{
    readonly active: boolean;
    readonly busy: boolean;
    readonly code: string | null;
    readonly payload: string | null;
    /** Primary `host:port` the offer advertises — typed-join display. */
    readonly endpoint: string | null;
    readonly expiresAt: number | null;
  }>({
    active: false,
    busy: false,
    code: null,
    payload: null,
    endpoint: null,
    expiresAt: null,
  });
  // Share generations, not a bool: a stale start()/stop() from a
  // dismissed share must not resolve into — or tear down — a NEWER
  // share's listener. Nonzero means "a share attempt owns the host".
  const shareGenRef = useRef(0);
  // Bounded remint retries — a failed mint clears the dead offer and
  // retries a few times rather than leaving an expired code on screen.
  const shareRetryRef = useRef(0);
  // Last-mint-wins: overlapping remints (expiry + inbound pair) apply
  // only their newest result — a stale mint finishing last must not
  // display a code the host no longer honors.
  const shareMintRef = useRef(0);
  const [nearbyPeers, setNearbyPeers] = useState<
    readonly {
      key: string;
      name: string;
      host: string;
      port: number;
      addresses: readonly string[];
      fp: string | null;
    }[]
  >([]);
  useEffect(() => {
    if (syncSurface === null) {
      return;
    }
    const applyStatus = (status: SyncClientStatus) => {
      setSyncStatus(status);
      // Live provider update: createHost's potProviderUrl is
      // boot-time, but peers keep changing — a mid-session pair
      // brings the desktop's endpoint, an unpair or a
      // welcome-carried refresh clears/replaces it. Same source
      // order as boot: discovered peer > env override > none.
      controller.setPotProvider(
        potProviderUrlFromPeers(status.peers.map((view) => view.peer)) ??
          POT_PROVIDER_URL ??
          null,
      );
    };
    applyStatus(syncSurface.client.status());
    return syncSurface.client.subscribe(applyStatus);
    // The surface is stable for the controller's life — subscribe once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

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
      // the IME has no work left and would just cover the list.
      Keyboard.dismiss();
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
  // Real waveform peaks for the Stage seek — lazy, cached per
  // recordingId|attemptId (a re-prepared stream never inherits the
  // attempt it replaced). The port borrows the live stream handle;
  // Android decodes natively, iOS surfaces 'unavailable' and the
  // seeded pattern stays either way while pending or on failure.
  const peaksPort = useMemo(
    () =>
      Platform.OS === 'android' ? createExpoPeaksPort(AuqwExpo) : null,
    [],
  );
  // Queue end drops `player` to null (playback → idle) — ripping the
  // mount out from under an expanded sheet would vanish it mid-view.
  // While expanded the mount is held on the last model until the user
  // collapses; release then waits out the settle spring so the slide
  // lands before unmount, and the morph re-seed happens at rest so a
  // fresh player starts collapsed, not mid-morph. The snapshot sits
  // in a ref — mirroring the live model into state would double the
  // per-tick render.
  const lastPlayerRef = useRef<PlayerModel | null>(null);
  const [endHold, setEndHold] = useState(false);
  useEffect(() => {
    if (player !== null) {
      lastPlayerRef.current = player;
      setEndHold(false);
      return;
    }
    if (expanded && lastPlayerRef.current !== null) {
      setEndHold(true);
      return;
    }
    const release = setTimeout(() => {
      stageProgress.value = 0;
      stageTravel.value = 0;
      lastPlayerRef.current = null;
      setEndHold(false);
    }, STAGE_RELEASE_MS);
    return () => clearTimeout(release);
  }, [player, expanded, stageProgress, stageTravel]);
  // A held mount renders the ended pose — paused at the last
  // published position — not a frozen 'playing' snapshot. `expanded`
  // covers the transition render itself (endHold lands an effect
  // later); `endHold` then carries the mount through the collapse
  // slide's settle window.
  const sheetPlayer =
    player ??
    ((expanded || endHold) && lastPlayerRef.current !== null
      ? {
          ...lastPlayerRef.current,
          status: 'paused' as const,
          intentPlaying: false,
        }
      : null);
  // Held pose (queue ended): live transport ops have no current
  // occurrence — play/seek taps replay the held track instead.
  const heldOccurrenceId =
    player === null ? (sheetPlayer?.occurrenceId ?? null) : null;
  // playback.type names only the latest failure — the app carries the
  // set so a row the cursor moved past keeps its 'error' mark; a
  // fresh attempt for the occurrence clears it, removals prune.
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
    const live = new Set(state.queue.occurrences.map((o) => o.occurrenceId));
    for (const id of failedQueueIds.current) {
      if (!live.has(id)) {
        failedQueueIds.current.delete(id);
      }
    }
    // Same honesty rule as the library rows: offline + unowned marks
    // 'unavailable' so a dead press isn't a surprise.
    const unavailable =
      online === false
        ? new Set(
            state.queue.occurrences
              .map((o) => o.recordingId)
              .filter((id) => !isOwned(id)),
          )
        : undefined;
    return toQueueModel({
      queue: state.queue,
      recordings: state.recordings,
      likes: state.likes,
      unavailableRecordingIds: unavailable,
      failedOccurrenceIds:
        failedQueueIds.current.size === 0 ? undefined : failedQueueIds.current,
      dealtOrder: state.shuffleOrder ?? undefined,
    });
    // isOwned re-reads downloads/local after their mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.queue,
    state.recordings,
    state.likes,
    state.playback,
    state.shuffleOrder,
    online,
    isOwned,
    downloads,
    localTick,
    localeTick,
  ]);
  const libraryModel = useMemo(() => {
    // Local index rows (provenance 'local') are authoritative over
    // the session's in-memory copies — a scan commits fresher tags
    // than restore loaded. Session stays authoritative for every
    // other row.
    const local = controller.local();
    const recordings = (() => {
      if (local === null) {
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
    const localUris = local?.uriMap();
    // Honest-offline: with connectivity explicitly down, a row plays
    // only from owned bytes (stored download or local file) — remote
    // streams degrade to 'unavailable' instead of spinning.
    const offline = online === false;
    const decorate = (
      row: TrackRowModel,
      recordingId: string,
    ): TrackRowModel => {
      const chip = chipByRecording.get(recordingId) ?? row.download;
      const owned =
        chip === 'stored' || localUris?.has(recordingId) === true;
      const offlineRow =
        offline && !owned
          ? { state: 'unavailable' as const, note: t('note.offline') }
          : {};
      return {
        ...row,
        playing: recordingId === playingId ? true : row.playing,
        download: chip ?? null,
        ...offlineRow,
      };
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
    // localTick re-reads local.recordings() after a folder mutation.
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
    downloads,
    chipsByRecording,
    online,
    controller,
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
      const local = controller.local();
      const localUris = local?.uriMap();
      const offline = online === false;
      return {
        ...model,
        entries: model.entries.map((entry) => {
          const chip =
            downloadChipFor(entry.recordingId) ?? entry.row.download;
          const owned =
            chip === 'stored' ||
            localUris?.has(entry.recordingId) === true;
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
    },
    // localTick re-reads local.uriMap after a folder mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.playlists,
      state.playlistEntries,
      state.recordings,
      state.likes,
      state.playback,
      downloads,
      downloadChipFor,
      online,
      controller,
      localTick,
      localeTick,
    ],
  );
  // The ref the player actually resolved for the live attempt —
  // published on the playback snapshot, so a pin, a verdict, or
  // owned bytes each mark exactly the row they resolved to (local
  // picks match no catalog row). A failed gate is not 'playing'.
  const playingRef = useMemo((): SourceRef | null => {
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
  }, [state.playback]);

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
  // Local recordings join search results application-side (never
  // provider routing): match the submitted query against
  // provenance-local rows. Keys are `local:<recordingId>` so a press
  // routes to the owned-bytes path, not addAndPlay.
  const localResults = useMemo(() => {
    const query = searchState.type === 'idle' ? '' : searchState.query;
    const terms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
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
      if (rec.provenance !== 'local' || localUris?.has(rec.id) !== true) {
        continue;
      }
      const haystack =
        `${rec.title} ${rec.artist ?? ''} ${rec.album ?? ''}`.toLowerCase();
      if (terms.every((t) => haystack.includes(t))) {
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
  }, [
    searchState,
    state.recordings,
    state.likes,
    state.playback,
    controller,
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
  const homeModel = useMemo(() => {
    return toHomeModel({
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
    });
  }, [
    state.recordings,
    state.likes,
    state.playback,
    searchState,
    localeTick,
  ]);
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
  const syncModel = useMemo(
    () =>
      toSyncModel({
        available: syncSurface !== null,
        status: syncStatus,
      }),
    // syncSurface is stable per controller — syncStatus carries the
    // updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [syncStatus, controller, localeTick],
  );
  const settingsModel = useMemo(
    () =>
      toSettingsModel(state.settings, diagnostics, {
        storageText,
        // The tag-reader surface is Android-only — iOS's auqw-expo
        // build has no tag* functions, so those rows must not act live.
        localSupported: AuqwExpo.hasTagReader?.() === true,
        localFolderCount: controller.local()?.list().length,
        localSources: controller
          .local()
          ?.list()
          .map((s) => ({ sourceId: s.sourceId, label: s.label })),
        // Kept ledger rows — same rule as the downloads collection:
        // failed-but-kept counts, mid-delete 'removing' doesn't.
        downloadCount: downloadLedgerCount(downloads),
        syncSupported: syncSurface !== null,
        syncLabel: syncModel.statusLabel,
      }),
    [
      state.settings,
      diagnostics,
      storageText,
      localTick,
      controller,
      downloads,
      syncModel,
      localeTick,
    ],
  );

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
  const reportPlay = useCallback(
    (action: MessageId, result: Result<unknown>) => {
      reportResult(action, result);
      if (!result.ok && isMatchGate(result.error)) {
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

  const playRecording = useCallback(
    async (recordingId: string) => {
      if (!canPlay(recordingId)) {
        return;
      }
      // Tap-to-play dedupe: a queued track jumps to its occurrence
      // instead of minting a repeat — 'add to queue' stays additive.
      const queued = queuedOccurrenceFor(state.queue, recordingId);
      if (queued !== null) {
        reportPlay('common.play', await session.playOccurrence(queued));
        return;
      }
      const enqueued = await session.enqueueRecording(recordingId);
      if (!enqueued.ok) {
        reportResult('action.enqueueTrack', enqueued);
        return;
      }
      reportPlay('common.play', await session.playOccurrence(enqueued.value));
    },
    [session, state.queue, canPlay, reportPlay],
  );

  // Queue presses and transport follow the same offline rule as
  // library rows: an unowned target must not start a remote attempt.
  const playQueueOccurrence = useCallback(
    (occurrenceId: string) => {
      const occurrence = state.queue.occurrences.find(
        (o) => o.occurrenceId === occurrenceId,
      );
      if (occurrence !== undefined && !canPlay(occurrence.recordingId)) {
        return;
      }
      void session
        .playOccurrence(occurrenceId)
        .then((r) => reportPlay('common.play', r));
    },
    [session, state.queue, canPlay, reportPlay],
  );

  // Mirrors the cursor's targeting in walk space — the dealt order
  // under shuffle, canonical otherwise: next → walk position+1,
  // wrapping to walk[0] under repeat=all at the tail; previous →
  // restart current when positionMs>3s, wrap to the walk's tail at
  // its head under repeat=all (len>1), restart at the head, else
  // position−1. The gate sees the same target the engine would land
  // on — a wrap to an unowned item must not slip through offline.
  const advance = useCallback(
    (method: 'next' | 'previous') => {
      if (online === false) {
        const { occurrences, currentOccurrenceId } = state.queue;
        // Position ticks ride the light channel now — read it live,
        // not the (possibly position-stale) published snapshot.
        const positionMs = session.positionMs();
        const walk =
          state.shuffleOrder ?? occurrences.map((o) => o.occurrenceId);
        const pos =
          currentOccurrenceId === null
            ? -1
            : walk.indexOf(currentOccurrenceId);
        const wrapAll = state.repeat === 'all';
        const targetId =
          method === 'next'
            ? // The same mark-skipping destination the engine
              // computes — a gate one walk slot ahead would test the
              // failed row the cursor is about to skip.
              nextQueueDestination({
                queue: { occurrences, currentOccurrenceId },
                dealtOrder: state.shuffleOrder,
                failedIds: failedQueueIds.current,
                repeat: state.repeat,
              })
            : positionMs > 3000
              ? walk[pos]
              : pos === 0 && wrapAll && walk.length > 1
                ? walk[walk.length - 1]
                : pos <= 0
                  ? walk[pos]
                  : walk[pos - 1];
        const target = occurrences.find(
          (o) => o.occurrenceId === targetId,
        );
        if (target !== undefined && !isOwned(target.recordingId)) {
          return;
        }
      }
      void (method === 'next' ? session.next() : session.previous()).then(
        (r) =>
          reportPlay(
            method === 'next' ? 'common.next' : 'common.previous',
            r,
          ),
      );
    },
    [
      online,
      state.queue,
      state.shuffleOrder,
      state.repeat,
      isOwned,
      session,
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
            s.provider === ref.provider && s.kind === ref.kind && s.id === ref.id,
        ),
      );
      return recording !== undefined && isOwned(recording.id);
    },
    [online, state.recordings, isOwned],
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
      if (row.key.startsWith('local:')) {
        void playRecording(row.key.slice('local:'.length));
        return;
      }
      const meta = resultMeta.current.get(row.key);
      if (meta !== undefined && canPlayMeta(meta)) {
        recordRecentSearch(query);
        void playMeta(meta).then((r) => reportPlay('action.playResult', r));
      }
    },
    [canPlayMeta, playMeta, playRecording, query, recordRecentSearch, reportPlay],
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
      if (key === 'sync') {
        pushOverlay({ type: 'sync' });
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
      // A committed mutation lands on the instance the op ran on —
      // a mid-flight rehydrate swaps `localSource`, and projecting the
      // live replacement's pre-commit snapshot hides the committed
      // rows. When the instance swapped, persisted storage holds the
      // commit: rehydrate rebuilds the live source from it (and
      // projects itself). When it is the same instance, its rows ARE
      // post-commit — project them directly.
      const syncCommittedLocal = (mutated: NonNullable<ReturnType<typeof controller.local>>): void => {
        const live = controller.local();
        if (live === null) {
          return;
        }
        if (live !== mutated) {
          // rehydrateLocal only — rehydrateMedia's downloads.init
          // would clear live transfer rows and sweep .part files.
          void controller
            .rehydrateLocal(new CancellationSource().signal)
            .then(refreshLocal);
          return;
        }
        session.syncLocalRecordings(live.recordings());
        refreshLocal();
      };
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
              syncCommittedLocal(local);
            }
          });
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
              syncCommittedLocal(local);
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
              syncCommittedLocal(local);
            }
          });
        return;
      }
      if (key === 'artworkCacheBytes') {
        setArtworkCachePickerOpen(true);
        return;
      }
      // downloadStorage is display-only.
    },
    [session, state.settings, controller, refreshLocal, refreshUsage],
  );

  const onSettingsToggle = useCallback(
    (key: string) => {
      // Function patches: the flip reads the committed value at
      // execution time, so rapid successive taps toggle per tap.
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

  // ---- slice-4 LAN sync ------------------------------------------------
  // Both pair paths and every peer op guard on the live client — the
  // surface can be null (iOS / failed bring-up) behind an enabled row.
  const runPair = useCallback(
    (
      request:
        | { readonly payload: string }
        | {
            readonly code: string;
            readonly endpoints: readonly string[];
            readonly fp?: string;
          },
    ) => {
      const client = syncSurface?.client;
      if (client === undefined || pairing) {
        return;
      }
      setPairing(true);
      setPairError(null);
      setPairNotice(null);
      void client
        .pair(request, new CancellationSource().signal)
        .then((result) => {
          setPairing(false);
          setPairError(result.ok ? null : result.error);
        })
        // A thrown pair (adapter crash) must still clear the latch —
        // otherwise `pairing` stays true and every later attempt is
        // dropped on the guard above.
        .catch((thrown: unknown) => {
          setPairing(false);
          setPairError(fromUnknown(thrown));
        });
    },
    // syncSurface is stable per controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller, pairing],
  );
  const onPairCode = useCallback(
    (input: { code: string; host: string; port: number | null }) => {
      if (input.port === null) {
        return;
      }
      runPair({
        code: input.code,
        endpoints: [formatEndpoint(input.host, input.port)],
      });
    },
    [runPair],
  );
  const onPairPayload = useCallback(
    (payload: string) => {
      runPair({ payload });
    },
    [runPair],
  );
  // Browse for nearby pair hosts while the sync screen is open —
  // discovery is advisory (a dead browse just yields an empty list).
  const syncOpen = overlay?.type === 'sync';
  useEffect(() => {
    const discovery = syncSurface?.discovery;
    if (!syncOpen || discovery === undefined || discovery === null) {
      return;
    }
    let session: { close(): void } | null = null;
    let gone = false;
    void discovery
      .browse({
        onFound: (peer) => {
          // A late event after close must not repopulate the list the
          // cleanup just cleared — the new browse owns the next open.
          if (gone) {
            return;
          }
          // Service identity (name|host) is the row key — a
          // re-advertised peer on a new port replaces its row, a
          // same-named neighbor keeps its own.
          setNearbyPeers((prev) => [
            ...prev.filter((p) => p.key !== peer.key),
            {
              key: peer.key,
              name: peer.name,
              host: peer.host,
              port: peer.port,
              addresses: peer.addresses,
              fp: peer.fp,
            },
          ]);
        },
        onLost: (key) => {
          if (gone) {
            return;
          }
          setNearbyPeers((prev) =>
            prev.filter((p) => p.key !== key),
          );
        },
      })
      .then((opened) => {
        if (gone) {
          opened.ok && opened.value.close();
          return;
        }
        if (opened.ok) {
          session = opened.value;
        }
      });
    return () => {
      gone = true;
      session?.close();
      setNearbyPeers([]);
    };
    // syncSurface is stable per controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncOpen, controller]);

  // Share (this device as the pair host): stop whenever the sync
  // screen isn't open — the listener is pairing-only and its minted
  // code dies with the sheet.
  useEffect(() => {
    if (syncOpen) {
      return;
    }
    if (shareGenRef.current !== 0) {
      shareGenRef.current = 0;
      shareRetryRef.current = 0;
      void syncSurface?.host?.stop();
    }
    setShare({
      active: false,
      busy: false,
      code: null,
      payload: null,
      endpoint: null,
      expiresAt: null,
    });
    setAdvertNotice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncOpen]);

  // Mint + apply a fresh offer — gated on a share still owning the
  // host (shareGenRef) and share still active inside the set.
  const remintShareOffer = useCallback(() => {
    const host = syncSurface?.host;
    if (host === undefined || host === null || shareGenRef.current === 0) {
      return;
    }
    const attempt = ++shareMintRef.current;
    // A failed mint while sharing stays on: the host has nothing left
    // to honor, so the dead offer must come OFF screen — then a
    // bounded retry tries to get a live code back.
    const mintFailed = () => {
      if (shareGenRef.current === 0 || attempt !== shareMintRef.current) {
        return;
      }
      setShare((prev) =>
        prev.active
          ? { ...prev, code: null, payload: null, endpoint: null, expiresAt: null }
          : prev,
      );
      shareRetryRef.current += 1;
      if (shareRetryRef.current <= 3) {
        setTimeout(remintShareOffer, 10_000);
      }
    };
    void host
      .mintOffer()
      .then((offer) => {
        if (
          shareGenRef.current === 0 ||
          attempt !== shareMintRef.current
        ) {
          return;
        }
        if (!offer.ok) {
          setPairError(offer.error);
          mintFailed();
          return;
        }
        shareRetryRef.current = 0;
        setShare((prev) =>
          prev.active
            ? {
                ...prev,
                code: offer.value.code,
                payload: offer.value.payload,
              endpoint: offer.value.endpoint,
                expiresAt: offer.value.expiresAt,
              }
            : prev,
        );
      })
      .catch(mintFailed);
    // syncSurface is stable per controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  // Offers expire after ~2m — remint while sharing stays on so the
  // displayed code/QR never outlives what the host will accept.
  useEffect(() => {
    if (!share.active || share.expiresAt === null) {
      return;
    }
    const timer = setTimeout(
      remintShareOffer,
      Math.max(0, share.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [share.active, share.expiresAt, remintShareOffer]);

  // An accepted inbound pair CONSUMES the displayed code — remint so
  // the UI never shows a dead offer the next caller can't redeem.
  useEffect(() => {
    const host = syncSurface?.host;
    if (!share.active || host === undefined || host === null) {
      return;
    }
    const unPair = host.onPaired(remintShareOffer);
    // A dead advert leaves the offer code-valid but undiscoverable —
    // tell the user rather than imply nearby visibility.
    const unAdvert = host.onAdvertiseError(() => {
      setAdvertNotice('sync.advertiseUnavailable');
      // The advert condition is live NOW — it displaces the retained
      // (stale) pair-attempt surfaces; a pair attempt that fails
      // AFTER this still sets pairError fresh and trumps the notice
      // until the next attempt clears it.
      setPairError(null);
      setPairNotice(null);
    });
    return () => {
      unPair();
      unAdvert();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share.active, controller, remintShareOffer]);

  // The 'expires in Nm' label is a render-time read — tick while an
  // offer is live so the countdown doesn't freeze between mints.
  const [shareTick, setShareTick] = useState(() => Date.now());
  useEffect(() => {
    if (!share.active || share.expiresAt === null) {
      return;
    }
    setShareTick(Date.now());
    const timer = setInterval(() => setShareTick(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [share.active, share.expiresAt]);

  const onShareToggle = useCallback(() => {
    const host = syncSurface?.host;
    if (host === undefined || host === null || share.busy) {
      return;
    }
    if (share.active) {
      shareGenRef.current = 0;
      void host.stop();
      setShare({
        active: false,
        busy: false,
        code: null,
        payload: null,
        endpoint: null,
        expiresAt: null,
      });
      // Sharing stopped — advertise/pair notices are moot while
      // nothing is advertised.
      setPairNotice(null);
      setAdvertNotice(null);
      return;
    }
    setShare((prev) => ({ ...prev, busy: true }));
    // A fresh share re-subscribes onAdvertiseError — drop the last
    // share's notices AND the retained pair error so they can't
    // linger under the new code or mask a start failure.
    setPairError(null);
    setPairNotice(null);
    setAdvertNotice(null);
    // Mark wanted BEFORE the async work: the screen-close cleanup reads
    // shareGenRef to decide whether a stop is owed — a start() that
    // lands after dismissal would otherwise leave a live listener. The
    // generation also distinguishes THIS share from any newer one, so a
    // stale start() resolution can't stop a successor's listener.
    const gen = ++shareGenRef.current;
    shareRetryRef.current = 0;
    void (async () => {
      const started = await host.start();
      if (shareGenRef.current !== gen) {
        return; // cleanup stopped the host, or a newer share owns it
      }
      if (!started.ok) {
        shareGenRef.current = 0;
        await host.stop();
        setShare({
          active: false,
          busy: false,
          code: null,
          payload: null,
          endpoint: null,
          expiresAt: null,
        });
        setPairError(started.error);
        return;
      }
      const offer = await host.mintOffer();
      if (shareGenRef.current !== gen) {
        return;
      }
      if (!offer.ok) {
        shareGenRef.current = 0;
        await host.stop();
        setShare({
          active: false,
          busy: false,
          code: null,
          payload: null,
          endpoint: null,
          expiresAt: null,
        });
        setPairError(offer.error);
        return;
      }
      setShare({
        active: true,
        busy: false,
        code: offer.value.code,
        payload: offer.value.payload,
        endpoint: offer.value.endpoint,
        expiresAt: offer.value.expiresAt,
      });
      setPairError(null);
    })().catch(() => {
      // Gate the whole unwind on our generation — a stale start's
      // rejection must not clear a NEWER share's code or stop control.
      if (shareGenRef.current !== gen) {
        return;
      }
      shareGenRef.current = 0;
      void host.stop();
      setShare({
        active: false,
        busy: false,
        code: null,
        payload: null,
        endpoint: null,
        expiresAt: null,
      });
      setPairNotice('sync.pairFailed');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, share.active, share.busy]);

  const onPairNearby = useCallback(
    (key: string, code: string) => {
      const peer = nearbyPeers.find((p) => p.key === key);
      if (peer === undefined) {
        return;
      }
      // Every resolved candidate goes to the dial — the ranked pick
      // can sit behind a dead route while a sibling address answers.
      const endpoints =
        peer.addresses.length > 0 ? peer.addresses : [peer.host];
      runPair({
        code,
        endpoints: endpoints.map((host) =>
          formatEndpoint(host, peer.port),
        ),
        ...(peer.fp !== null ? { fp: peer.fp } : {}),
      });
    },
    [nearbyPeers, runPair],
  );

  const onSyncNow = useCallback(
    (fp: string) => {
      const client = syncSurface?.client;
      if (client === undefined) {
        return;
      }
      void client.syncNow(fp, new CancellationSource().signal);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller],
  );
  const onUnpair = useCallback(
    (fp: string) => {
      const client = syncSurface?.client;
      if (client === undefined) {
        return;
      }
      void client.unpair(fp, new CancellationSource().signal);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller],
  );

  // Clipboard exchange — RN's core Clipboard covers get/setString on
  // Android (deprecated upstream but present in 0.86, zero added deps;
  // see docs/decisions.md). The engine's exportDelta/applyDelta run the
  // same paging + validation as the desktop IPC path —
  // exportFittedDeltaDoc adds the byte refit the desktop adapter does,
  // halving the entry limit until each page fits the wire doc cap.
  // The export walk is owned: a second tap supersedes the in-flight
  // one and unmount cancels it — its only output is a late clipboard
  // write nobody is waiting on.
  const exportDeltaSource = useRef<CancellationSource | null>(null);
  useEffect(() => () => exportDeltaSource.current?.cancel(), []);
  const onCopyPayload = useCallback(() => {
    if (share.payload !== null) {
      Clipboard.setString(share.payload);
    }
  }, [share.payload]);
  const onExportDelta = useCallback(() => {
    const engine = syncSurface?.engine;
    if (engine === undefined) {
      return;
    }
    exportDeltaSource.current?.cancel();
    const source = new CancellationSource();
    exportDeltaSource.current = source;
    void collectSyncDeltaDocs((cursor) =>
      exportFittedDeltaDoc(engine.exportDelta, cursor, source.signal),
    )
      .then((collected) => {
        if (exportDeltaSource.current === source) {
          exportDeltaSource.current = null;
        }
        if (!collected.ok) {
          // A superseded/unmounted walk ends 'cancelled' — that is a
          // disposal, not a failure worth a toast.
          if (collected.error.kind !== 'cancelled') {
            reportResult('sync.panel.copyDelta', collected);
          }
          return;
        }
        Clipboard.setString(serializeSyncDeltaDocs(collected.value));
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);
  const onImportDelta = useCallback(() => {
    const engine = syncSurface?.engine;
    if (engine === undefined) {
      return;
    }
    void Clipboard.getString()
      .then(async (text) => {
        // Validate the whole batch BEFORE any apply — a malformed
        // element must not strand a partially imported array.
        const docs = parseSyncDeltaDocs(text);
        if (docs === null) {
          reportResult(
            'sync.panel.pasteDelta',
            err(appError('invalid-message', 'clipboard has no delta')),
          );
          return;
        }
        for (const doc of docs) {
          const applied = await engine.applyDelta(
            doc,
            new CancellationSource().signal,
          );
          if (!applied.ok) {
            reportResult('sync.panel.pasteDelta', applied);
            return;
          }
        }
      })
      .catch(() => {
        reportResult(
          'sync.panel.pasteDelta',
          err(appError('unavailable', 'clipboard read failed')),
        );
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  const playback = state.playback;
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
  const peaks = useWaveformPeaks(peaksPort, peaksTarget);
  const playing = playback.type === 'playing';
  const currentRecordingId =
    playback.type === 'idle' ? null : playback.recordingId;
  const onPlayPause = useCallback(() => {
    // Pause is always allowed; resuming an unowned remote track while
    // offline would start a prepare that cannot finish. The intent
    // is the queue's mode, not transport: during a retry backoff
    // playback publishes 'preparing' with no handle, and the tap
    // must still pause. A transport 'paused' that arrived natively
    // (queue still 'playing') means the tap resumes, not re-pauses.
    const intentPlaying =
      state.queue.mode === 'playing' && state.playback.type !== 'paused';
    if (
      !intentPlaying &&
      currentRecordingId !== null &&
      !canPlay(currentRecordingId)
    ) {
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void (intentPlaying ? session.pause() : session.resume()).then((r) =>
      reportPlay(intentPlaying ? 'common.pause' : 'action.resume', r),
    );
  }, [session, state.queue.mode, state.playback.type, currentRecordingId, canPlay, reportPlay]);
  const onToggleLike = useCallback(() => {
    if (currentRecordingId !== null) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      void session.toggleLike(currentRecordingId);
    }
  }, [session, currentRecordingId]);
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

  // Lyrics prefetch while the Stage is open in any mode — one provider
  // call per track — so switching to the lyrics tab is instant. Leaving
  // lyrics mode (or the sheet) keeps the last sheet cached.
  useEffect(() => {
    if (!expanded || currentRecordingId === null) {
      return;
    }
    if (lyricsFetch?.recordingId === currentRecordingId) {
      return;
    }
    fetchLyrics(currentRecordingId);
  }, [expanded, currentRecordingId, lyricsFetch, fetchLyrics]);

  // A new track under an open sheet returns it to player mode — the
  // playing item is what the sheet exists to show. Explicit opens
  // (deep links, menus) set the mode before expanding, so this only
  // listens for the track change, not the expand flip.
  const expandedForMode = useRef(expanded);
  useEffect(() => {
    expandedForMode.current = expanded;
  }, [expanded]);
  useEffect(() => {
    if (currentRecordingId !== null && expandedForMode.current) {
      setStageMode('player');
    }
  }, [currentRecordingId]);

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
    sheetPlayer?.positionMs ?? 0,
    playing,
    expanded && stageMode === 'lyrics',
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

  // ---- library transfer (export file write · import preview) -----

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
      try {
        const name = `auqw-library-${new Date().toISOString().slice(0, 10)}.json`;
        let file: File;
        if (Platform.OS === 'android') {
          // SAF folder pick — the export lands where the user can
          // reach it (Downloads and friends), not app-private storage.
          const dir = await Directory.pickDirectoryAsync();
          file = dir.createFile(name, 'application/json');
        } else {
          file = new File(Paths.document, name);
          if (file.exists) {
            file.delete();
          }
          file.create();
        }
        file.write(result.value.json);
        setTransfer((prev) => ({
          ...prev,
          exportPhase: 'done',
          exportDetail: exportDestinationLabel(file.uri),
        }));
      } catch (thrown) {
        if (
          thrown instanceof Error &&
          'code' in thrown &&
          thrown.code === 'ERR_PICKER_CANCELLED'
        ) {
          setTransfer((prev) => ({ ...prev, exportPhase: 'idle' }));
          return;
        }
        setTransfer((prev) => ({
          ...prev,
          exportPhase: 'error',
          exportDetail: t('transfer.exportWriteFailed'),
        }));
      }
    });
  }, [session]);

  const onPickImportFile = useCallback(() => {
    importPreviewRaw.current = null;
    setTransfer((prev) => ({
      ...prev,
      importPhase: 'reading',
      importDetail: null,
      preview: null,
    }));
    void (async () => {
      try {
        const picked = await File.pickFileAsync({
          mimeTypes: ['application/json', 'text/*'],
        });
        if (picked.canceled) {
          setTransfer((prev) => ({ ...prev, importPhase: 'idle' }));
          return;
        }
        const file = picked.result;
        const text = await file.text();
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
        const sourceLabel = file.uri.split('/').pop() ?? file.uri;
        importText.current = text;
        importPreviewRaw.current = { preview: preview.value, sourceLabel };
        setTransfer((prev) => ({
          ...prev,
          importPhase: 'preview',
          preview: toImportPreviewModel(preview.value, sourceLabel),
        }));
      } catch {
        importPreviewRaw.current = null;
        setTransfer((prev) => ({
          ...prev,
          importPhase: 'error',
          importDetail: t('transfer.readFailed'),
          preview: null,
        }));
      }
    })();
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
  }, [session, controller]);

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

  // Android hardware back: native stack items dismiss themselves
  // (nativeBackButtonDismissalEnabled) and sync state via onDismissed;
  // this chain is the fallback ordering for anything the native side
  // didn't consume — sheet → overlay → stage → tab → exit.
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (actionsFor !== null) {
        setActionsFor(null);
        return true;
      }
      if (pickerFor !== null) {
        setPickerFor(null);
        return true;
      }
      if (providerSlot !== null) {
        setProviderSlot(null);
        return true;
      }
      if (overlayStack.length > 0) {
        closeOverlay();
        return true;
      }
      if (expanded) {
        setExpanded(false);
        return true;
      }
      if (tab !== 'home') {
        setTab('home');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [
    actionsFor,
    pickerFor,
    providerSlot,
    overlayStack,
    expanded,
    tab,
    closeOverlay,
  ]);

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
      void session
        .playRecordings(
          playable.map((row) => ({
            recordingId: row.recordingId,
            selectedRef: null,
          })),
        )
        .then((r) => reportPlay('action.playCollection', r));
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
      void session
        .playRecordings(
          playable.map((entry) => ({
            recordingId: entry.recordingId,
            // A provider pin beats owned bytes in #pickRef — drop it
            // when bytes exist so downloads actually get played.
            selectedRef: isOwned(entry.recordingId)
              ? null
              : entry.selectedRef,
          })),
        )
        .then((r) => reportPlay('action.playPlaylist', r));
    },
    [session, isOwned, canPlay, reportPlay],
  );

  const playlistDownloadFor = useCallback(
    (model: ReturnType<typeof playlistModelFor>) => {
      if (model === null) {
        return { state: 'none' as const, requests: [] };
      }
      // Only MISSING entries: requesting an already-owned recording
      // with a changed mapping would delete its stored file first —
      // 'download missing' must never cost offline playback.
      const requests = model.entries
        .filter((entry) => !isOwned(entry.recordingId))
        .flatMap((entry) => {
          const sourceRef = downloadRefFor(entry.recordingId);
          return sourceRef === null
            ? []
            : [{ recordingId: entry.recordingId, sourceRef }];
        });
      // 'all' means every entry is owned — a stored download or a
      // local file both count; only-downloadable entries gate it.
      const allStored =
        model.entries.length > 0 &&
        model.entries.every((entry) => isOwned(entry.recordingId));
      const anyTracked = model.entries.some(
        (entry) =>
          controller.downloads.recordFor(entry.recordingId) !== null ||
          isOwned(entry.recordingId),
      );
      return {
        state: allStored
          ? ('all' as const)
          : anyTracked
            ? ('partial' as const)
            : ('none' as const),
        requests,
      };
    },
    // downloads/localTick bump re-derives ownership; downloadRefFor and
    // isOwned already capture the pieces they read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [downloads, localTick, controller, downloadRefFor, isOwned],
  );

  const onPlaylistDownloadAll = useCallback(
    (requests: readonly { recordingId: string; sourceRef: SourceRef }[]) => {
      if (requests.length === 0) {
        return;
      }
      void controller.downloads
        .requestAll(requests, new CancellationSource().signal)
        .then((r) => reportResult('action.download', r));
    },
    [controller],
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
        case 'removeDownload':
          if (target.kind === 'recording') {
            const row = controller.downloads.recordFor(target.recordingId);
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
    [actionsFor, session, openEntity, state.recordings, downloadRefFor, onDownloadAction, radioSeedable, controller, refreshUsage],
  );

  const onOpenCard = useCallback(
    (card: { playlistId: string | null; entityRef: EntityRef | null }) => {
      if (card.playlistId !== null) {
        pushOverlay({ type: 'playlist', playlistId: card.playlistId });
      } else if (card.entityRef !== null) {
        openEntity(card.entityRef);
      }
    },
    [openEntity],
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
    [session],
  );

  // __DEV__-only gate instrumentation: `auqw://` links drive the real
  // session methods so emulator/simulator journeys are scriptable.
  // Verbs: open?tab=&playlist=&collection=, entity?provider=&kind=&id=,
  // search?q=, play-result?i=N, next, previous, pause, resume,
  // like-current, seek?ms=, lyrics, radio?provider=&id=, stop-radio,
  // provider?catalog=&playback=&lyrics=&radio=, corrections,
  // review?list|confirm=&candidate=|reject=|undo=, transfer?export|
  // import=<path>|apply-import, download?i=N|downloads, local-add|
  // local-rescan|local-list, airplane. Never ships in release bundles.
  const journeyDeps = useRef({
    session,
    search,
    state,
    controller,
    downloadRefFor,
    reportPlay,
    queueSettingsWrite,
    seekToPosition,
  });
  journeyDeps.current = {
    session,
    search,
    state,
    controller,
    downloadRefFor,
    reportPlay,
    queueSettingsWrite,
    seekToPosition,
  };
  useEffect(() => {
    if (!__DEV__) {
      return undefined;
    }
    const handle = (url: string | null): void => {
      if (url === null || !url.startsWith('auqw://')) {
        return;
      }
      // Log the verb only — seam links carry client credentials in the
      // query and journey params can embed paths; neither belongs in
      // logcat (redaction rule).
      console.log(`[journey] ${url.slice('auqw://'.length).split('?')[0]}`);
      const route = devRoute(url);
      // The fixture gallery is a dev route; a normal journey link exits it.
      if (route === 'gallery') {
        setShowGallery(true);
        return;
      }
      setShowGallery(false);
      // Slice 1.5 seam dev links (seam-file/seam-prepare/seam-attach/
      // seam-metrics) — isolated in seam-dev.ts; drop with the harness.
      if (route === 'seam') {
        void runSeamLink(url);
        return;
      }
      const {
        session: s,
        search: se,
        state: st,
        controller: ctl,
        downloadRefFor: refFor,
        reportPlay,
        queueSettingsWrite: queueWrite,
        seekToPosition: seekTo,
      } = journeyDeps.current;
      const body = url.slice('auqw://'.length);
      // Split on the first '?' only — param values may embed '?' of
      // their own (import paths, pasted URLs), and `split('?')` would
      // truncate them.
      const queryIndex = body.indexOf('?');
      const verb = queryIndex === -1 ? body : body.slice(0, queryIndex);
      const params = new URLSearchParams(
        queryIndex === -1 ? '' : body.slice(queryIndex + 1),
      );
      switch (verb) {
        case 'open': {
          const target = params.get('tab') ?? 'home';
          if (target === 'queue') {
            setStageMode('queue');
            setExpanded(true);
          } else {
            setTab(target === 'search' ? 'explore' : target);
          }
          const playlistId = params.get('playlist');
          const collection = params.get('collection');
          if (playlistId !== null) {
            resetOverlay({ type: 'playlist', playlistId });
          } else if (
            collection === 'liked' ||
            collection === 'top50' ||
            collection === 'history' ||
            collection === 'downloads'
          ) {
            resetOverlay({ type: 'collection', key: collection });
          } else {
            clearOverlays();
          }
          break;
        }
        case 'entity': {
          // auqw://entity?provider=<p>&kind=<album|artist>&id=<id>
          const provider = params.get('provider');
          const kind = params.get('kind');
          const id = params.get('id');
          if (
            provider !== null &&
            id !== null &&
            (kind === 'album' || kind === 'artist')
          ) {
            const ref: EntityRef = { provider, kind, id };
            setTab('library');
            resetOverlay({ type: 'entity', ref });
            loadEntityPage(ref);
          }
          break;
        }
        case 'search':
          setTab('explore');
          setQuery(params.get('q') ?? '');
          void se?.search({
            query: params.get('q') ?? '',
            limit: SEARCH_LIMIT,
            storefront:
              st.type === 'ready' ? st.settings.storefront : null,
          });
          break;
        case 'play-result': {
          const i = Number(params.get('i') ?? '0');
          const meta =
            searchStateRef.current.type === 'content'
              ? searchStateRef.current.page.items[i]
              : undefined;
          if (meta !== undefined) {
            const queued =
              st.type === 'ready'
                ? queuedOccurrenceForRef(
                    st.queue,
                    st.recordings,
                    meta.sourceRef,
                  )
                : null;
            void (queued === null
              ? s.addAndPlay(meta)
              : s.playOccurrence(queued)
            ).then((r) => reportPlay('action.playResult', r));
          }
          break;
        }
        case 'next':
          void s.next().then((r) => reportPlay('common.next', r));
          break;
        case 'previous':
          void s.previous().then((r) => reportPlay('common.previous', r));
          break;
        case 'pause':
          void s.pause().then((r) => reportResult('common.pause', r));
          break;
        case 'resume':
          void s.resume().then((r) => reportPlay('action.resume', r));
          break;
        case 'like-current':
          if (st.type === 'ready' && st.playback.type !== 'idle') {
            const id = st.playback.recordingId;
            if (id !== null) {
              void s
                .toggleLike(id)
                .then((r) => reportResult('action.toggleLike', r));
            }
          }
          break;
        case 'seek': {
          const ms = Number(params.get('ms') ?? '0');
          if (Number.isSafeInteger(ms) && ms >= 0) {
            void seekTo(ms).then((r) => reportResult('action.seek', r));
          }
          break;
        }
        case 'lyrics':
          // auqw://lyrics — open the Stage straight into lyrics mode.
          setStageMode('lyrics');
          setExpanded(true);
          break;
        case 'radio': {
          // auqw://radio?provider=<p>&id=<track id> — seed the lazy
          // tail; the session owns validation and routing.
          const provider = params.get('provider');
          const id = params.get('id');
          if (provider !== null && id !== null) {
            void s.startRadio({ provider, kind: 'track', id }).then((res) => {
              console.log(
                res.ok
                  ? '[journey] radio seeded'
                  : `[journey] radio seed failed: ${res.error.kind} — ${res.error.message}`,
              );
            });
          }
          break;
        }
        case 'provider': {
          // auqw://provider?catalog=<id>&playback=<id>&lyrics=<id|auto>
          //   &radio=<id|auto> — provider-parity journeys switch slots
          //   without driving the picker sheet.
          if (st.type !== 'ready') {
            break;
          }
          const patch: Partial<Settings> = {};
          const catalog = params.get('catalog');
          const playbackP = params.get('playback');
          const lyricsP = params.get('lyrics');
          const radioP = params.get('radio');
          if (catalog !== null) {
            patch.catalogProvider = catalog;
          }
          if (playbackP !== null) {
            patch.playbackProvider = playbackP;
          }
          if (lyricsP !== null) {
            patch.lyricsProvider = lyricsP === 'auto' ? null : lyricsP;
          }
          if (radioP !== null) {
            patch.radioProvider = radioP === 'auto' ? null : radioP;
          }
          void queueWrite(patch).then((r) =>
            reportResult('action.provider', r),
          );
          break;
        }
        case 'corrections':
          // auqw://corrections — the review queue rides the settings
          // tab's overlay stack like a pushed settings detail.
          setTab('settings');
          resetOverlay({ type: 'corrections' });
          break;
        case 'review': {
          // auqw://review?list — dumps the pending queue to logcat.
          // auqw://review?confirm=<id>&candidate=<n> / ?reject=<id> /
          // ?undo=<id> — drive the real session delegates so the
          // corrections gate can run unattended on-device.
          if (params.has('list')) {
            void s.listMatchReviews({ status: 'all' }).then((listed) => {
              if (!listed.ok) {
                console.log('[journey] review list failed:', listed.error);
                return;
              }
              for (const review of listed.value) {
                console.log(
                  `[journey] review ${review.reviewId} status=${review.status}` +
                  ` candidates=${review.candidates.length}` +
                  ` recording=${review.recordingId}`,
                );
              }
              console.log(`[journey] ${listed.value.length} review(s)`);
            });
            break;
          }
          const confirmId = params.get('confirm');
          const rejectId = params.get('reject');
          const undoId = params.get('undo');
          if (confirmId !== null) {
            const candidate = Number(params.get('candidate') ?? '0');
            void s
              .confirmReview(confirmId, candidate)
              .then((r) => reportResult('action.confirmReview', r));
          } else if (rejectId !== null) {
            void s
              .rejectReview(rejectId)
              .then((r) => reportResult('action.rejectReview', r));
          } else if (undoId !== null) {
            void s
              .undoReview(undoId)
              .then((r) => reportResult('action.undoReview', r));
          }
          break;
        }
        case 'download': {
          // auqw://download?i=N — request a download for the Nth
          // library recording (play-result indexing convention).
          const i = Number(params.get('i') ?? '0');
          const recording = st.recordings[i];
          if (recording === undefined) {
            console.log(`[journey] download index ${i} out of range`);
            break;
          }
          const sourceRef = refFor(recording.id);
          if (sourceRef === null) {
            console.log('[journey] download: no playable ref (local-only?)');
            break;
          }
          void ctl.downloads
            .request(
              { recordingId: recording.id, sourceRef },
              new CancellationSource().signal,
            )
            .then((res) =>
              console.log(
                res.ok
                  ? `[journey] download ${res.value.downloadId} state=${res.value.state}`
                  : `[journey] download failed: ${res.error.kind}`,
              ),
            );
          break;
        }
        case 'downloads':
          // auqw://downloads — open the downloads collection.
          setTab('library');
          resetOverlay({ type: 'collection', key: 'downloads' });
          console.log(
            `[journey] downloads=${ctl.downloads.list().length} rows`,
          );
          break;
        case 'local-add': {
          // auqw://local-add — drives the real SAF folder picker.
          const local = ctl.local();
          if (local === null) {
            console.log('[journey] local-add: source not started');
            break;
          }
          void local
            .addFolder(new CancellationSource().signal)
            .then((added) => {
              if (added.ok) {
                s.syncLocalRecordings(local.recordings());
              }
              console.log(
                added.ok
                  ? `[journey] local-add source=${added.value.sourceId}`
                  : `[journey] local-add failed: ${added.error.kind}`,
              );
            });
          break;
        }
        case 'local-rescan': {
          const local = ctl.local();
          if (local === null) {
            console.log('[journey] local-rescan: source not started');
            break;
          }
          void local
            .rescan(undefined, new CancellationSource().signal)
            .then((scanned) => {
              if (!scanned.ok) {
                console.log(
                  `[journey] local-rescan failed: ${scanned.error.kind}`,
                );
                return;
              }
              s.syncLocalRecordings(local.recordings());
              for (const report of scanned.value) {
                console.log(
                  `[journey] rescan ${report.sourceId}: +${report.added}` +
                    ` ~${report.updated} -${report.removed}`,
                );
              }
            });
          break;
        }
        case 'local-list': {
          const local = ctl.local();
          if (local === null) {
            console.log('[journey] local-list: source not started');
            break;
          }
          for (const source of local.list()) {
            console.log(
              `[journey] local ${source.sourceId} label=${source.label}` +
                ` files=${local.filesFor(source.sourceId).length}`,
            );
          }
          console.log(
            `[journey] local sources=${local.list().length} recordings=${local.recordings().length}`,
          );
          break;
        }
        case 'airplane': {
          // auqw://airplane — the airplane-mode gate probe: logs the
          // connectivity snapshot and how many rows own bytes, so the
          // physical journey asserts honest offline behaviour.
          void ctl.connectivity.snapshot().then((snap) => {
            if (!snap.ok) {
              console.log(`[journey] airplane probe failed: ${snap.error.kind}`);
              return;
            }
            const owned = ctl.downloads
              .list()
              .filter((d) => d.state === 'available').length;
            console.log(
              `[journey] airplane online=${snap.value.online} metered=${snap.value.metered} owned=${owned} pending=${ctl.downloads.list().length}`,
            );
          });
          break;
        }
        case 'transfer': {
          // auqw://transfer — export/import surface, import state reset.
          // ?import=<path> reads the file directly (no picker) into the
          // preview stage; ?apply-import applies the staged document —
          // the two legs mirror the interactive preview→confirm flow.
          setTab('settings');
          resetOverlay({ type: 'transfer' });
          const importPath = params.get('import');
          if (importPath !== null) {
            importText.current = null;
            importPreviewRaw.current = null;
            // A deep link must not read outside the app's own
            // document/cache roots — anywhere else is a file-read
            // primitive reachable by any intent sender. The fence
            // (alias roots, dot-segment normalization, separator
            // boundary) lives in seam-dev.ts.
            const allowed = appFilePath(importPath) !== null;
            if (!allowed) {
              console.log('[journey] transfer import refused: outside app dirs');
              break;
            }
            setTransfer({ ...IDLE_TRANSFER, importPhase: 'reading' });
            void (async () => {
              try {
                const uri = importPath.startsWith('file://')
                  ? importPath
                  : `file://${importPath}`;
                const text = await new File(uri).text();
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
                const sourceLabel = importPath.split('/').pop() ?? importPath;
                importText.current = text;
                importPreviewRaw.current = { preview: preview.value, sourceLabel };
                setTransfer((prev) => ({
                  ...prev,
                  importPhase: 'preview',
                  preview: toImportPreviewModel(preview.value, sourceLabel),
                }));
              } catch {
                importPreviewRaw.current = null;
                setTransfer((prev) => ({
                  ...prev,
                  importPhase: 'error',
                  importDetail: t('transfer.readFailed'),
                  preview: null,
                }));
              }
            })();
          } else if (params.has('apply-import')) {
            onApplyImport();
          } else if (params.has('export')) {
            importText.current = null;
            importPreviewRaw.current = null;
            setTransfer(IDLE_TRANSFER);
            onExport();
          } else {
            importText.current = null;
            importPreviewRaw.current = null;
            setTransfer(IDLE_TRANSFER);
          }
          break;
        }
        case 'stop-radio':
          reportResult('action.stopRadio', s.stopRadio());
          break;
        default:
          break;
      }
    };
    const sub = Linking.addEventListener('url', ({ url }) =>
      handle(url),
    );
    void Linking.getInitialURL().then(handle);
    return () => sub.remove();
  }, []);

  // Mirror of searchState for the journey handler (which is stable
  // across renders via journeyDeps but reads items from the map).
  const searchStateRef = useRef(searchState);
  searchStateRef.current = searchState;

  // The immersive player (open sheet, player mode, artwork present)
  // renders dark regardless of scheme — its system-bar styles flip.
  // A pushed overlay is an opaque screen over the player, so it owns
  // the bars while it is the visible surface; action sheets only dim
  // it and keep the light treatment.
  const galleryActive = __DEV__ && showGallery;
  const immersiveStage =
    !galleryActive &&
    expanded &&
    stageMode === 'player' &&
    sheetPlayer !== null &&
    sheetPlayer.artworkUrl !== null &&
    overlay === null;
  const navBarStyle =
    theme.scheme === 'light' && !immersiveStage ? 'dark' : 'light';
  useEffect(() => {
    // setStyle rejects while the activity is gone — cosmetic and
    // unactionable, so it never reaches a rejection toast.
    void expoNavigationBar?.setStyle(navBarStyle)?.catch(() => {});
  }, [navBarStyle]);

  const topInset = insets.top;
  if (galleryActive) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
        <StatusBar style={theme.scheme === 'light' ? 'dark' : 'light'} />
        <GalleryScreen />
      </View>
    );
  }
  const renderTabScreen = (key: string) => {
    switch (key) {
      case 'explore':
        return (
          <SearchScreen
            state={searchModel}
            query={query}
            topInset={topInset}
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
          />
        );
      case 'library':
        return (
          <LibraryScreen
            model={libraryModel}
            topInset={topInset}
            onPressItem={(id) => void playRecording(id)}
            onToggleLike={(id) => void session.toggleLike(id)}
            onContext={(id) =>
              setActionsFor({ kind: 'recording', recordingId: id })
            }
            onOpenCollection={(key) =>
              pushOverlay({ type: 'collection', key })
            }
            onPlayCollection={(key) =>
              playCollectionRows(libraryModel.collectionRows[key])
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
            topInset={topInset}
            onSelectRow={onSettingsSelect}
            onToggleRow={onSettingsToggle}
            onOpenCorrections={() =>
              pushOverlay({ type: 'corrections' })
            }
          />
        );
      default:
        return (
          <HomeScreen
            model={homeModel}
            topInset={topInset}
            onPressCard={(card) =>
              activateHomeCard(
                card,
                homeModel.recents,
                searchState.type === 'content' ? searchState.page.items : [],
                {
                  canPlayMetadata: canPlayMeta,
                  playMetadata: (meta) => {
                    if (searchState.type === 'content') {
                      recordRecentSearch(searchState.query);
                    }
                    void playMeta(meta).then((result) =>
                      reportPlay('action.playResult', result),
                    );
                  },
                  playRecording: (id) => {
                    void playRecording(id);
                  },
                },
              )
            }
            onResume={() =>
              void session.resume().then((r) => reportPlay('action.resume', r))
            }
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
            topInset={topInset}
            onBack={closeOverlay}
            onPlayAll={() => playCollectionRows(model.rows)}
            onPressItem={(row) => void playRecording(row.recordingId)}
            onToggleLike={(row) => void session.toggleLike(row.recordingId)}
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
            topInset={topInset}
            onBack={closeOverlay}
            onPlayAll={() => playPlaylist(playlistModel)}
            onDownloadAll={() =>
              onPlaylistDownloadAll(playlistDownloadFor(playlistModel).requests)
            }
            downloadAllState={playlistDownloadFor(playlistModel).state}
            onRename={(name) =>
              void session
                .renamePlaylist(current.playlistId, name)
                .then((r) => reportResult('action.renamePlaylist', r))
            }
            onDelete={() => {
              void Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Warning,
              );
              void session
                .deletePlaylist(current.playlistId)
                .then((r) => reportResult('action.deletePlaylist', r));
              dismissOverlay(entry.key);
            }}
            onPressEntry={(entry) => {
              if (!canPlay(entry.recordingId)) {
                return;
              }
              void session
                .playRecordings([
                  {
                    recordingId: entry.recordingId,
                    selectedRef: isOwned(entry.recordingId)
                      ? null
                      : entry.selectedRef,
                  },
                ])
                .then((r) => reportPlay('action.playPlaylistEntry', r));
            }}
            onToggleLike={(entry) => void session.toggleLike(entry.recordingId)}
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
            topInset={topInset}
            onBack={closeOverlay}
            onPlayAll={() => {
              const metas = entityModelFor(fetch)
                .items.map((row) => metaFor(row))
                .filter(
                  (m): m is TrackMetadata => m !== undefined,
                );
              void session
                .playMetadata(metas)
                .then((r) => reportPlay('collection.playAll', r));
            }}
            onShuffleAll={() => {
              const metas = entityModelFor(fetch)
                .items.map((row) => metaFor(row))
                .filter(
                  (m): m is TrackMetadata => m !== undefined,
                );
              void session
                .playMetadata(metas, { shuffle: true })
                .then((r) => reportPlay('action.shuffleAll', r));
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
                void playMeta(meta).then((r) =>
                  reportPlay('action.playResult', r),
                );
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
            topInset={topInset}
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
            topInset={topInset}
            onBack={closeOverlay}
            onExport={onExport}
            onPickImportFile={onPickImportFile}
            onApplyImport={onApplyImport}
            onResetImport={onResetImport}
          />
        );
      case 'sync':
        return (
          <SyncScreen
            model={syncModel}
            topInset={topInset}
            onBack={closeOverlay}
            onPairCode={onPairCode}
            onPairPayload={onPairPayload}
            onSyncNow={onSyncNow}
            onUnpair={onUnpair}
            pairing={pairing}
            pairError={
              errorText(pairError) ??
              (advertNotice === null ? null : t(advertNotice)) ??
              (pairNotice === null ? null : t(pairNotice))
            }
            share={
              syncSurface?.host === undefined || syncSurface?.host === null
                ? undefined
                : {
                    supported: true,
                    active: share.active,
                    busy: share.busy,
                    code: share.code,
                    payload: share.payload,
                    endpoint: share.endpoint,
                    expiresLabel:
                      share.expiresAt === null
                        ? null
                        : formatExpiry(share.expiresAt, shareTick),
                  }
            }
            onShareToggle={
              syncSurface?.host === undefined || syncSurface?.host === null
                ? undefined
                : onShareToggle
            }
            onCopyPayload={
              syncSurface?.host === undefined || syncSurface?.host === null
                ? undefined
                : onCopyPayload
            }
            nearbyPeers={
              syncSurface?.discovery === undefined ||
              syncSurface?.discovery === null
                ? undefined
                : nearbyPeers.map((peer) => ({
                    key: peer.key,
                    name: peer.name,
                    address: `${peer.host}:${peer.port}`,
                    pinned: peer.fp !== null,
                  }))
            }
            onPairNearby={
              syncSurface?.discovery === undefined ||
              syncSurface?.discovery === null
                ? undefined
                : onPairNearby
            }
            renderScanner={
              Platform.OS === 'android'
                ? (onScan) => <SyncScanner onScan={onScan} />
                : undefined
            }
            onExportDelta={
              syncSurface === null ? undefined : onExportDelta
            }
            onImportDelta={
              syncSurface === null ? undefined : onImportDelta
            }
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
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.canvas,
          justifyContent: 'center',
        }}
      >
        <StatusBar style={theme.scheme === 'light' ? 'dark' : 'light'} />
        <LoadingState title={t('boot.restoring')} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
      {/* Immersive player (art-backed sheet in player mode) is dark
          under any scheme — system bars must read light over it. */}
      <StatusBar
        style={theme.scheme === 'light' && !immersiveStage ? 'dark' : 'light'}
      />
      <AppStack>
        <StackItem stackKey="root">
          <PlatformTabs
            items={navItems()}
            activeKey={tab}
            tabBarHidden={expanded}
            onSelect={(key) => {
              setTab(key);
              clearOverlays();
            }}
            renderTab={renderTabScreen}
            accessory={
              // The pill stays mounted through the morph — its own
              // alpha rides stageProgress; `interactive` keeps the
              // invisible rest state out of touch and a11y reach.
              player !== null ? (
                <MiniPlayer
                  player={player}
                  progress={stageProgress}
                  travel={stageTravel}
                  anchor={stageAnchor}
                  interactive={!expanded}
                  onPress={() => {
                    setStageMode('player');
                    setExpanded(true);
                  }}
                  onCollapse={() => setExpanded(false)}
                  onPlayPause={onPlayPause}
                  onNext={() => advance('next')}
                  onPrevious={() => advance('previous')}
                  onToggleLike={onToggleLike}
                  onDismiss={() => void session.stop()}
                />
              ) : undefined
            }
          />
          {sheetPlayer !== null ? (
            <StageSheet
              player={sheetPlayer}
              expanded={expanded}
              progress={stageProgress}
              travel={stageTravel}
              anchor={stageAnchor}
              onExpandChange={(value) => {
                if (value) setStageMode('player');
                setExpanded(value);
              }}
              mode={stageMode}
              onModeChange={setStageMode}
              queue={queueModel}
              queueReordering={reordering}
              topInset={topInset}
              bottomInset={insets.bottom}
              lyrics={lyricsModel}
              radio={radioModel}
              onPlayPause={
                heldOccurrenceId !== null
                  ? () => {
                      // Same offline rule as queue rows — an unowned
                      // remote target must not start a dead attempt.
                      const held = state.queue.occurrences.find(
                        (o) => o.occurrenceId === heldOccurrenceId,
                      );
                      if (held !== undefined && !canPlay(held.recordingId)) {
                        return;
                      }
                      void Haptics.impactAsync(
                        Haptics.ImpactFeedbackStyle.Light,
                      );
                      void session
                        .playOccurrence(heldOccurrenceId)
                        .then((r) => reportPlay('common.play', r));
                    }
                  : onPlayPause
              }
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
              onSeek={
                heldOccurrenceId !== null
                  ? (ms) => {
                      const held = state.queue.occurrences.find(
                        (o) => o.occurrenceId === heldOccurrenceId,
                      );
                      if (held !== undefined && !canPlay(held.recordingId)) {
                        return;
                      }
                      void session
                        .playOccurrence(heldOccurrenceId)
                        .then((r) => {
                          if (!r.ok) {
                            reportPlay('common.play', r);
                            return;
                          }
                          // The await can outlive a re-cursor — a
                          // queue tap during prepare would otherwise
                          // have this seek land on the new song.
                          const snap = session.snapshot();
                          if (
                            snap.type === 'ready' &&
                            snap.queue.currentOccurrenceId ===
                              heldOccurrenceId
                          ) {
                            seekToPosition(ms);
                          }
                        });
                    }
                  : seekToPosition
              }
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
          ) : null}
          {online === false && (
            <View
              style={{
                position: 'absolute',
                top: topInset + 4,
                alignSelf: 'center',
                paddingHorizontal: 12,
                paddingVertical: 5,
                borderRadius: 999,
                backgroundColor: theme.colors.raised,
                borderWidth: theme.strokes.hairline,
                borderColor: theme.colors.hairline,
              }}
            >
              <Text variant="metadata" color="secondary">
                {t('offline.bannerDownloads')}
              </Text>
            </View>
          )}
          {toast !== null && (
            <View
              accessibilityLiveRegion="polite"
              style={{
                position: 'absolute',
                bottom: insets.bottom + 88,
                alignSelf: 'center',
                maxWidth: '92%',
                paddingHorizontal: 14,
                paddingVertical: 6,
                borderRadius: 999,
                backgroundColor: theme.colors.raised,
                borderWidth: theme.strokes.hairline,
                borderColor: theme.colors.hairline,
                zIndex: 70,
              }}
            >
              <Text variant="metadata" color="primary">
                {toast}
              </Text>
            </View>
          )}
        </StackItem>
        {overlayStack.map((entry) => {
          const content = renderOverlayEntry(entry);
          return content === null ? null : (
            <PushScreen
              key={entry.key}
              stackKey={entry.key}
              onDismissed={() => dismissOverlay(entry.key)}
            >
              {content}
              {/* Same solid-inset band as the tab scenes — pushed
                  overlays scroll edge-to-edge under the status bar
                  too. */}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: topInset,
                  backgroundColor: theme.colors.canvas,
                }}
              />
            </PushScreen>
          );
        })}
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
                      // A failed row needs an out that isn't retry —
                      // keep vs. delete are both honest offers.
                      ...(controller.downloads.recordFor(
                        actionsFor.recordingId,
                      )?.state === 'failed_with_retry'
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
            <LanguagePickerSheet
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
        {artworkCachePickerOpen && (
          <SheetScreen
            stackKey="sheet-artwork-cache"
            onDismissed={() => setArtworkCachePickerOpen(false)}
          >
            <ProviderPickerSheet
              title={t('settings.artworkCache')}
              options={artworkCacheOptions()}
              selectedKey={`${Math.round(
                (state.settings.artworkCacheBytes ??
                  ARTWORK_CACHE_BUDGET_DEFAULT_BYTES) /
                  (1024 * 1024),
              )}`}
              onPick={(key) => {
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
                  // A shrunken cap takes effect only once rows over
                  // it are evicted — sweep after the commit lands.
                  if (updated.ok && shrinking) {
                    void controller.artworkCache.sweep({
                      requestId: createIds().next('artwork-sweep'),
                      deadlineMs: createClock().nowMs() + 60_000,
                      signal: new CancellationSource().signal,
                    });
                  }
                });
              }}
              onDismiss={() => setArtworkCachePickerOpen(false)}
            />
          </SheetScreen>
        )}
      </AppStack>
    </View>
  );
}
