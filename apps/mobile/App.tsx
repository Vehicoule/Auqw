import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Linking,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { NavigationBar } from 'expo-navigation-bar';
import { File, Paths } from 'expo-file-system';
import {
  useFonts,
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';
import * as AuqwExpo from 'auqw-expo';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  ARTWORK_CACHE_BUDGET_DEFAULT_BYTES,
  CancellationSource,
  SearchSession,
  effectiveMapping,
  isMatchGate,
  isRefRejected,
  previewImport,
} from '@auqw/application';
import type {
  AppError,
  AttemptTrace,
  EntityPage,
  EntityRef,
  ImportPreview,
  LyricsSheet,
  MatchReview,
  OperationContext,
  ProviderCapability,
  ReadySession,
  Result,
  SearchState,
  SessionState,
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
  EmptyState,
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
  formatClock,
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
  NavItemModel,
  ProviderPickerOption,
  SearchStateModel,
  StageMode,
  TrackRowModel,
  TransferModel,
} from '@auqw/ui-native';
import { createSessionController } from './src/session/controller.ts';
import type { SessionController } from './src/session/controller.ts';
import { createAuqwExpoPlayer } from './src/adapters/auqw-expo-player.ts';
import { discoveredPotProviderUrl } from './src/adapters/pot-provider-discovery.ts';
import { potProviderUrlFromPeers } from './src/adapters/pot-provider.ts';
import { createClock, createIds } from './src/adapters/runtime.ts';
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

const SEARCH_LIMIT = 25;
const DIAGNOSTICS_LIMIT = 20;

function navItems(): readonly NavItemModel[] {
  return [
    { key: 'home', label: t('nav.home') },
    { key: 'explore', label: t('nav.explore') },
    { key: 'library', label: t('nav.library') },
    { key: 'settings', label: t('nav.settings') },
  ];
}

/**
 * The sync screen's QR scanner — expo-camera lives in the app (not
 * ui-native), so the camera mounts here and the screen receives it
 * through its renderScanner seam. Permission is requested lazily on
 * first open; denied/restricted renders an honest prompt, never a
 * dead black frame.
 */
function SyncScanner({ onScan }: { readonly onScan: (data: string) => void }) {
  const theme = useTheme();
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

const THEME_ORDER = ['system', 'dark', 'light', 'oled'] as const;

// Stream-quality tiers, kbps — inside the domain's 1–512 qualityKbps
// bound; 128 is the spec default (providers.md).
function qualityOptions(): readonly ProviderPickerOption[] {
  return [
    { key: '64', label: '64 kbps' },
    { key: '96', label: '96 kbps' },
    { key: '128', label: '128 kbps', detail: t('optionDetail.default') },
    { key: '192', label: '192 kbps' },
    { key: '256', label: '256 kbps' },
    { key: '320', label: '320 kbps', detail: t('optionDetail.maximum') },
  ];
}

function themeOptions(): readonly ProviderPickerOption[] {
  return [
    {
      key: 'system',
      label: t('settings.themeValue.system'),
      detail: t('optionDetail.themeSystem'),
    },
    // 'tokyo night' is the color scheme's name, not UI copy.
    {
      key: 'dark',
      label: t('settings.themeValue.dark'),
      detail: 'tokyo night',
    },
    {
      key: 'light',
      label: t('settings.themeValue.light'),
      detail: t('optionDetail.themeLight'),
    },
    {
      key: 'oled',
      label: t('settings.themeValue.oled'),
      detail: t('optionDetail.themeOled'),
    },
  ];
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

type Boot =
  | { readonly type: 'loading' }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'ready'; readonly controller: SessionController };

export function App() {
  const [fontsLoaded] = useFonts({
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  });
  const [attempt, setAttempt] = useState(0);
  const [boot, setBoot] = useState<Boot>({ type: 'loading' });

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
  readonly boot: Boot;
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
  // OS font scale feeds textScale — accessibility sizing isn't opt-in.
  const { fontScale } = useWindowDimensions();
  return (
    <ThemeProvider theme={theme} textScale={fontScale}>
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
          hint={state.error.message}
          onRetry={() => void controller.session.restore()}
        />
      ) : (
        <LoadingState title={t('boot.restoring')} />
      )}
    </View>
  );
}

function toSearchModel(
  state: SearchState,
  playingRef: SourceRef | null = null,
): SearchStateModel {
  switch (state.type) {
    case 'idle':
      return {
        phase: 'idle',
        query: '',
        results: [],
        providerId: null,
        message: null,
        retryable: false,
      };
    case 'loading':
      return {
        phase: 'loading',
        query: state.query,
        results: [],
        providerId: null,
        message: null,
        retryable: false,
      };
    case 'empty':
      return {
        phase: 'empty',
        query: state.query,
        results: [],
        providerId: null,
        message: null,
        retryable: false,
      };
    case 'content':
      return {
        phase: state.page.items.length === 0 ? 'empty' : 'ready',
        query: state.query,
        results: state.page.items.map((meta, index) =>
          toSearchRowModel(meta, index, playingRef),
        ),
        providerId: null,
        message: state.refreshError?.message ?? null,
        retryable: false,
      };
    case 'error': {
      const unavailable =
        state.error.kind === 'unavailable' ||
        state.error.kind === 'auth-required';
      return {
        phase: unavailable ? 'unavailable' : 'error',
        query: state.query,
        results: [],
        providerId: null,
        message: state.error.message,
        retryable: true,
      };
    }
  }
}

function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return t('home.greeting.night');
  if (h < 12) return t('home.greeting.morning');
  if (h < 18) return t('home.greeting.afternoon');
  return t('home.greeting.evening');
}

function attemptLabel(trace: AttemptTrace): string {
  return t('settings.diag.attemptLabel', {
    requestId: trace.requestId,
    steps: trace.steps,
    httpCalls: trace.httpCalls,
    elapsed: formatClock(trace.elapsedMs),
  });
}

type Overlay =
  | { readonly type: 'collection'; readonly key: 'liked' | 'top50' | 'history' | 'downloads' }
  | { readonly type: 'playlist'; readonly playlistId: string }
  | { readonly type: 'entity'; readonly ref: EntityRef }
  | { readonly type: 'corrections' }
  | { readonly type: 'transfer' }
  | { readonly type: 'sync' };

/** A pushed route on the native screen stack. */
type OverlayEntry = { readonly key: string; readonly overlay: Overlay };

const entityRefKey = (ref: EntityRef): string =>
  `${ref.provider}:${ref.kind}:${ref.id}`;

type EntityFetch = {
  readonly ref: EntityRef;
  readonly page: EntityPage | null;
  readonly error: AppError | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
};

type LyricsFetch = {
  readonly recordingId: string;
  readonly sheet: LyricsSheet | null;
  readonly error: AppError | null;
  readonly loading: boolean;
};

type ReviewFetch = {
  readonly reviews: readonly MatchReview[] | null;
  readonly error: AppError | null;
};

type ActionTarget =
  | { readonly kind: 'recording'; readonly recordingId: string }
  | { readonly kind: 'metadata'; readonly meta: TrackMetadata };

// The settings provider slots and the capabilities each one routes
// by — a picker only ever lists providers that declared the slot's
// capability (manifest-derived, via ProviderPort.capabilities).
type ProviderSlot =
  | 'catalogProvider'
  | 'playbackProvider'
  | 'lyricsProvider'
  | 'radioProvider';

const SLOT_CAPABILITIES: Record<
  ProviderSlot,
  readonly ProviderCapability[]
> = {
  catalogProvider: ['catalog.search'],
  playbackProvider: ['playback.resolve'],
  lyricsProvider: ['lyrics.synced', 'lyrics.plain'],
  radioProvider: ['radio.seed'],
};

const SLOT_LABEL_IDS: Record<ProviderSlot, MessageId> = {
  catalogProvider: 'settings.catalogProvider',
  playbackProvider: 'settings.playbackProvider',
  lyricsProvider: 'settings.lyricsProvider',
  radioProvider: 'settings.radioProvider',
};

// Lyrics and radio are nullable overrides — 'auto' returns routing
// to capability declaration; the required slots never offer it.
const OPTIONAL_SLOTS: ReadonlySet<ProviderSlot> = new Set([
  'lyricsProvider',
  'radioProvider',
]);

function formatBytes(bytes: number, free: number): string {
  const gb = (n: number) =>
    n >= 1e9
      ? `${(n / 1e9).toFixed(1)} gb`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(0)} mb`
        : n === 0
          ? '0 kb'
          : `${Math.max(1, Math.round(n / 1e3))} kb`;
  return t('storage.usage', { used: gb(bytes), free: gb(free) });
}

const IDLE_TRANSFER: TransferModel = {
  exportPhase: 'idle',
  exportDetail: null,
  importPhase: 'idle',
  importDetail: null,
  preview: null,
};

/**
 * Session ops resolve typed errors rather than throwing — a dropped
 * Result is a silent no-op. Keep failures observable: the console
 * keeps the `kind — message` taxonomy text (no secrets), and a
 * transient toast carries it to the operator. `toastSink` is
 * installed once by Main — reportResult is called from callbacks all
 * over this file, so a sink avoids threading the setter through
 * every dependency list.
 */
let toastSink: ((text: string) => void) | null = null;

function reportResult(action: MessageId, result: Result<unknown>): void {
  if (!result.ok) {
    console.warn(
      `[ui] ${action} failed: ${result.error.kind} — ${result.error.message}`,
    );
    toastSink?.(
      t('toast.failed', {
        action: t(action),
        message: result.error.message,
      }),
    );
  }
}

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
  const [tab, setTab] = useState('home');
  const [expanded, setExpanded] = useState(false);
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
  // Settings writes are serialized so picks land in submission order.
  // Without this a slower earlier write could resolve after a newer pick
  // and leave a superseded value persisted; the chain guarantees the
  // newest pick is always the last write. Failures stay per-call and
  // never reject the chain.
  const settingsWriteChain = useRef<Promise<unknown>>(Promise.resolve());
  const queueSettingsWrite = useCallback(
    (next: Parameters<typeof session.updateSettings>[0]) => {
      const run = settingsWriteChain.current.then(() =>
        session.updateSettings(next),
      );
      settingsWriteChain.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [session],
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
    toastSink = setToast;
    return () => {
      toastSink = null;
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
  const [overlayStack, setOverlayStack] = useState<readonly OverlayEntry[]>(
    [],
  );
  const overlayCounter = useRef(0);
  const [entityFetches, setEntityFetches] = useState<
    Readonly<Record<string, EntityFetch>>
  >({});
  const overlay = overlayStack[overlayStack.length - 1]?.overlay ?? null;
  const entityMeta = useRef(new Map<string, TrackMetadata>());
  const [actionsFor, setActionsFor] = useState<ActionTarget | null>(null);
  // Live download ledger — subscribed once; chips + the downloads
  // collection + the stage action all read it.
  const [downloads, setDownloads] = useState(
    () => controller.downloads.list(),
  );
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
  const refreshUsage = useCallback(() => {
    void controller.downloads
      .usage(new CancellationSource().signal)
      .then((u) => {
        if (u.ok) {
          setStorageUsage({ bytes: u.value.bytes, free: u.value.free });
        }
      });
  }, [controller]);
  useEffect(() => {
    setDownloads(controller.downloads.list());
    refreshUsage();
    return controller.downloads.subscribe(() => {
      setDownloads(controller.downloads.list());
      refreshUsage();
    });
  }, [controller, refreshUsage]);

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
      (controller.local()?.uriFor(recordingId) ?? null) !== null,
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
        void controller.downloads.request({ recordingId, sourceRef }, signal);
        return;
      }
      switch (existing.state) {
        case 'requested':
        case 'transferring':
          void controller.downloads.cancel(existing.downloadId, signal);
          return;
        case 'failed_with_retry':
          void controller.downloads.retry(existing.downloadId, signal);
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
  useEffect(() => {
    const raw = importPreviewRaw.current;
    if (raw === null) {
      return;
    }
    setTransfer((prev) => ({
      ...prev,
      preview: toImportPreviewModel(raw.preview, raw.sourceLabel),
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
  const [pairError, setPairError] = useState<string | null>(null);
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

  const runSearch = useCallback(
    (q: string) => {
      const trimmed = q.trim();
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

  // Live results: keystrokes debounce into a real search; an emptied
  // box cancels in-flight work and lands back on the idle/recents.
  useEffect(() => {
    if (query.trim() === '') {
      search?.cancel();
      return undefined;
    }
    const timer = setTimeout(() => runSearch(query), 350);
    return () => clearTimeout(timer);
  }, [query, search, runSearch]);

  // Keep the row→metadata map in sync so a tap can recover the
  // TrackMetadata the session needs for addAndPlay.
  useEffect(() => {
    const map = resultMeta.current;
    map.clear();
    if (searchState.type === 'content') {
      searchState.page.items.forEach((meta, index) => {
        map.set(toSearchRowModel(meta, index).key, meta);
      });
    }
  }, [searchState]);

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

  const player = useMemo(
    () =>
      toPlayerModel({
        playback: state.playback,
        queue: state.queue,
        recordings: state.recordings,
        likes: state.likes,
      }),
    [state, localeTick],
  );
  const queueModel = useMemo(() => {
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
    });
    // isOwned re-reads downloads/local after their mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, online, isOwned, downloads, localTick, localeTick]);
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
    const chipByRecording = new Map<string, DownloadChip>(
      downloads
        .filter((d) => d.state !== 'removing')
        .map((d) => [
          d.recordingId,
          d.state === 'requested'
            ? 'queued'
            : d.state === 'transferring'
              ? 'downloading'
              : d.state === 'available'
                ? 'stored'
                : 'failed',
        ]),
    );
    const localUriFor = (id: string): string | null =>
      local?.uriFor(id) ?? null;
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
        chip === 'stored' || localUriFor(recordingId) !== null;
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
  }, [state, downloads, online, controller, localTick, localeTick]);
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
      const offline = online === false;
      return {
        ...model,
        entries: model.entries.map((entry) => {
          const chip =
            downloadChipFor(entry.recordingId) ?? entry.row.download;
          const owned =
            chip === 'stored' ||
            local?.uriFor(entry.recordingId) != null;
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
    // localTick re-reads local.uriFor after a folder mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state,
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
    [state.likes, state.entitySourceRefs, playingRef],
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
    const rows: TrackRowModel[] = [];
    for (const rec of state.recordings) {
      // Folder removal keeps the recording but drops its file row —
      // uriFor is the owned-bytes truth; orphans never surface.
      if (rec.provenance !== 'local' || local?.uriFor(rec.id) == null) {
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
    // localTick re-reads local.uriFor after a folder mutation — a
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
  }, [searchState, localResults, playingRef]);
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
  }, [state, searchState, localeTick]);
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
    [state, controller, attempts, pendingReviews, localeTick],
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
        downloadCount: downloads.length,
        syncSupported: syncSurface !== null,
        syncLabel: syncModel.statusLabel,
      }),
    [
      state,
      diagnostics,
      storageText,
      localTick,
      controller,
      downloads,
      syncModel,
      localeTick,
    ],
  );

  // ---- library world: overlay routes ------------------------------

  const pushOverlay = useCallback((next: Overlay) => {
    overlayCounter.current += 1;
    setOverlayStack((stack) => [
      ...stack,
      { key: `ov-${overlayCounter.current}`, overlay: next },
    ]);
  }, []);

  const resetOverlay = useCallback((next: Overlay) => {
    overlayCounter.current += 1;
    setOverlayStack([
      { key: `ov-${overlayCounter.current}`, overlay: next },
    ]);
  }, []);

  /** Pop the top route — every screen's own back affordance. */
  const closeOverlay = useCallback(() => {
    setOverlayStack((stack) => stack.slice(0, -1));
  }, []);

  /** Native gesture/back dismissal removes a screen and all above it. */
  const dismissOverlay = useCallback((key: string) => {
    setOverlayStack((stack) => {
      const index = stack.findIndex((entry) => entry.key === key);
      return index === -1 ? stack : stack.slice(0, index);
    });
  }, []);

  const clearOverlays = useCallback(() => {
    setOverlayStack([]);
    setEntityFetches({});
  }, []);

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
      const enqueued = await session.enqueueRecording(recordingId);
      if (!enqueued.ok) {
        reportResult('action.enqueueTrack', enqueued);
        return;
      }
      reportPlay('common.play', await session.playOccurrence(enqueued.value));
    },
    [session, canPlay, reportPlay],
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

  // Mirrors QueueEngine.next()/previous() targeting: next → index+1
  // (never wraps); previous → restart current when positionMs>3s or
  // at index 0, else index−1. The gate sees the same target the
  // engine would land on.
  const advance = useCallback(
    (method: 'next' | 'previous') => {
      if (online === false) {
        const { occurrences, currentOccurrenceId, positionMs } = state.queue;
        const index = occurrences.findIndex(
          (o) => o.occurrenceId === currentOccurrenceId,
        );
        const target =
          method === 'next'
            ? occurrences[index + 1]
            : positionMs > 3000 || index <= 0
              ? occurrences[index]
              : occurrences[index - 1];
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
    [online, state.queue, isOwned, session, reportPlay],
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
        void session
          .addAndPlay(meta)
          .then((r) => reportPlay('action.playResult', r));
      }
    },
    [session, canPlayMeta, playRecording, query, recordRecentSearch, reportPlay],
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
              session.syncLocalRecordings(local.recordings());
              refreshLocal();
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
              session.syncLocalRecordings(local.recordings());
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
            if (scanned.ok) {
              session.syncLocalRecordings(local.recordings());
              refreshLocal();
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
      if (key === 'prefetch') {
        void session.updateSettings({
          ...state.settings,
          prefetch: !state.settings.prefetch,
        });
      }
      if (key === 'downloadMetered') {
        const next = state.settings.downloadMetered !== true;
        void session
          .updateSettings({
            ...state.settings,
            downloadMetered: next,
          })
          .then((updated) => {
            // Re-derive only after the setting commits — toggling ON
            // unblocks waiting rows, toggling OFF pauses an active
            // cellular transfer; kick() can't demote mid-flight work.
            if (updated.ok) {
              void controller.downloads.reevaluateEligibility();
            }
          });
      }
    },
    [session, state.settings, controller],
  );

  // ---- slice-4 LAN sync ------------------------------------------------
  // Both pair paths and every peer op guard on the live client — the
  // surface can be null (iOS / failed bring-up) behind an enabled row.
  const runPair = useCallback(
    (
      request:
        | { readonly payload: string }
        | { readonly code: string; readonly endpoints: readonly string[] },
    ) => {
      const client = syncSurface?.client;
      if (client === undefined || pairing) {
        return;
      }
      setPairing(true);
      setPairError(null);
      void client
        .pair(request, new CancellationSource().signal)
        .then((result) => {
          setPairing(false);
          setPairError(result.ok ? null : result.error.message);
        })
        // A thrown pair (adapter crash) must still clear the latch —
        // otherwise `pairing` stays true and every later attempt is
        // dropped on the guard above.
        .catch(() => {
          setPairing(false);
          setPairError('pairing failed');
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
        endpoints: [`${input.host}:${input.port}`],
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

  const playback = state.playback;
  const playing = playback.type === 'playing';
  const currentRecordingId =
    playback.type === 'idle' ? null : playback.recordingId;
  const onPlayPause = useCallback(() => {
    // Pause is always allowed; resuming an unowned remote track while
    // offline would start a prepare that cannot finish.
    if (
      !playing &&
      currentRecordingId !== null &&
      !canPlay(currentRecordingId)
    ) {
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void (playing ? session.pause() : session.resume()).then((r) =>
      reportPlay(playing ? 'common.pause' : 'action.resume', r),
    );
  }, [session, playing, currentRecordingId, canPlay, reportPlay]);
  const onToggleLike = useCallback(() => {
    if (currentRecordingId !== null) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
    if (!expanded || stageMode !== 'lyrics' || currentRecordingId === null) {
      return;
    }
    if (lyricsFetch?.recordingId === currentRecordingId) {
      return;
    }
    fetchLyrics(currentRecordingId);
  }, [
    expanded,
    stageMode,
    currentRecordingId,
    lyricsFetch,
    fetchLyrics,
  ]);

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
      positionMs: player?.positionMs ?? 0,
    });
  }, [lyricsFetch, currentRecordingId, player, localeTick]);

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
  const radioCapable = useMemo(
    () =>
      controller.providers.some((p) =>
        p.capabilities.includes('radio.seed'),
      ),
    [controller],
  );

  const onStartRadio = useCallback(() => {
    const current = state.queue.occurrences.find(
      (o) => o.occurrenceId === state.queue.currentOccurrenceId,
    );
    const recording =
      currentRecordingId === null
        ? undefined
        : state.recordings.find((r) => r.id === currentRecordingId);
    const ref: SourceRef | null =
      current?.selectedRef ?? recording?.sourceRefs[0] ?? null;
    if (ref !== null) {
      void session
        .startRadio(ref)
        .then((r) => reportResult('stage.radio.start', r));
    }
  }, [session, state, currentRecordingId]);

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
        const name = `auqw-library-${new Date().toISOString().slice(0, 10)}.json`;
        const file = new File(Paths.document, name);
        if (file.exists) {
          file.delete();
        }
        file.create();
        file.write(result.value.json);
        // expo-sharing is not a dependency: the document-directory URI
        // is the honest destination and renders as the detail line.
        setTransfer((prev) => ({
          ...prev,
          exportPhase: 'done',
          exportDetail: file.uri,
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
            importDetail: preview.error.message,
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
      } catch (thrown) {
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
            importDetail: result.error.message,
          }));
          return;
        }
        importText.current = null;
        const counts = result.value.counts;
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

  const providerPicker = useMemo(() => {
    if (providerSlot === null) {
      return null;
    }
    const required = SLOT_CAPABILITIES[providerSlot];
    const options = controller.providers
      .filter((provider) =>
        required.some((capability) =>
          provider.capabilities.includes(capability),
        ),
      )
      .map((provider) => ({
        key: provider.id,
        label: provider.id,
        detail: provider.capabilities.join(' · '),
      }));
    const selected = state.settings[providerSlot];
    return {
      title: t(SLOT_LABEL_IDS[providerSlot]),
      options: OPTIONAL_SLOTS.has(providerSlot)
        ? [
          {
            key: 'auto',
            label: t('settings.value.auto'),
            detail: t('optionDetail.autoRoute'),
          },
          ...options,
        ]
        : options,
      selectedKey: selected ?? 'auto',
    };
  }, [providerSlot, controller, state.settings, localeTick]);

  const onPickProvider = useCallback(
    (key: string) => {
      const slot = providerSlot;
      setProviderSlot(null);
      if (slot === null) {
        return;
      }
      const next = { ...state.settings };
      if (slot === 'lyricsProvider' || slot === 'radioProvider') {
        next[slot] = key === 'auto' ? null : key;
      } else {
        next[slot] = key;
      }
      void session.updateSettings(next);
    },
    [providerSlot, session, state.settings],
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
      void controller.downloads.requestAll(
        requests,
        new CancellationSource().signal,
      );
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
        case 'radio': {
          // Track-seeded at this release: a metadata row seeds its own
          // ref; a library row seeds its first source ref. No ref
          // means no seed — the row action simply doesn't fire.
          const ref =
            target.kind === 'metadata'
              ? target.meta.sourceRef
              : (state.recordings.find((r) => r.id === target.recordingId)
                ?.sourceRefs[0] ?? null);
          if (ref !== null) {
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
    [actionsFor, session, openEntity, state.recordings, downloadRefFor, onDownloadAction],
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
  });
  journeyDeps.current = {
    session,
    search,
    state,
    controller,
    downloadRefFor,
    reportPlay,
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
            void s
              .addAndPlay(meta)
              .then((r) => reportPlay('action.playResult', r));
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
            void s.seekTo(ms).then((r) => reportResult('action.seek', r));
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
          const next = { ...st.settings };
          const catalog = params.get('catalog');
          const playbackP = params.get('playback');
          const lyricsP = params.get('lyrics');
          const radioP = params.get('radio');
          if (catalog !== null) {
            next.catalogProvider = catalog;
          }
          if (playbackP !== null) {
            next.playbackProvider = playbackP;
          }
          if (lyricsP !== null) {
            next.lyricsProvider = lyricsP === 'auto' ? null : lyricsP;
          }
          if (radioP !== null) {
            next.radioProvider = radioP === 'auto' ? null : radioP;
          }
          void s
            .updateSettings(next)
            .then((r) => reportResult('action.provider', r));
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
                    importDetail: preview.error.message,
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
              } catch (thrown) {
                importPreviewRaw.current = null;
                setTransfer((prev) => ({
                  ...prev,
                  importPhase: 'error',
                  importDetail:
                    thrown instanceof Error
                      ? thrown.message
                      : 'could not read the import file',
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

  const topInset = insets.top;
  if (__DEV__ && showGallery) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
        <StatusBar style={theme.scheme === 'light' ? 'dark' : 'light'} />
        <NavigationBar
          style={theme.scheme === 'light' ? 'dark' : 'light'}
        />
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
            onPressCard={(card) => void playRecording(card.key)}
            onResume={() =>
              void session.resume().then((r) => reportPlay('action.resume', r))
            }
          />
        );
    }
  };

  const renderOverlayEntry = (entry: OverlayEntry) => {
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
                void session
                  .addAndPlay(meta)
                  .then((r) => reportPlay('action.playResult', r));
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
            pairError={pairError}
            renderScanner={
              Platform.OS === 'android'
                ? (onScan) => <SyncScanner onScan={onScan} />
                : undefined
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
      <StatusBar style={theme.scheme === 'light' ? 'dark' : 'light'} />
      {/* Android button nav: keep system buttons readable on any
          canvas — 'dark' style = dark buttons (for light canvases);
          the config plugin value is a startup default. */}
      <NavigationBar style={theme.scheme === 'light' ? 'dark' : 'light'} />
      <AppStack>
        <StackItem stackKey="root">
          <PlatformTabs
            items={navItems()}
            activeKey={tab}
            onSelect={(key) => {
              setTab(key);
              clearOverlays();
            }}
            renderTab={renderTabScreen}
            accessory={
              player !== null && !expanded ? (
                <MiniPlayer
                  player={player}
                  onPress={() => setExpanded(true)}
                  onPlayPause={onPlayPause}
                  onNext={() => advance('next')}
                  onPrevious={() => advance('previous')}
                  onToggleLike={onToggleLike}
                  onDismiss={() => void session.stop()}
                />
              ) : undefined
            }
          />
          {player !== null ? (
            <StageSheet
              player={player}
              expanded={expanded}
              onExpandChange={setExpanded}
              mode={stageMode}
              onModeChange={setStageMode}
              queue={queueModel}
              queueReordering={reordering}
              topInset={topInset}
              lyrics={lyricsModel}
              radio={radioModel}
              onPlayPause={onPlayPause}
              onNext={() => advance('next')}
              onPrevious={() => advance('previous')}
              onToggleLike={onToggleLike}
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
              onSeek={(ms) => void session.seekTo(ms)}
              onRetryLyrics={onRetryLyrics}
              onStartRadio={radioCapable ? onStartRadio : undefined}
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
                    ]
                  : []),
                // Only offer the seed affordance when a bundled
                // provider declares radio.seed — an unsupported start
                // is a dead end.
                ...(radioCapable
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
                void queueSettingsWrite({ ...state.settings, theme })
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
                void queueSettingsWrite({ ...state.settings, language })
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
                void session
                  .updateSettings({ ...state.settings, storefront: code })
                  .then((saved) => {
                    reportResult('action.saveStorefront', saved);
                    if (saved.ok && opening === storefrontEpoch.current) {
                      setStorefrontSheetOpen(false);
                    }
                  });
              }}
              onClear={() => {
                const opening = storefrontEpoch.current;
                void session
                  .updateSettings({ ...state.settings, storefront: null })
                  .then((saved) => {
                    reportResult('action.clearStorefront', saved);
                    if (saved.ok && opening === storefrontEpoch.current) {
                      setStorefrontSheetOpen(false);
                    }
                  });
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
                void session
                  .updateSettings({ ...state.settings, qualityKbps })
                  .then((saved) => {
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
                const shrinking =
                  artworkCacheBytes <
                  (state.settings.artworkCacheBytes ??
                    ARTWORK_CACHE_BUDGET_DEFAULT_BYTES);
                void session
                  .updateSettings({ ...state.settings, artworkCacheBytes })
                  .then((updated) => {
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
