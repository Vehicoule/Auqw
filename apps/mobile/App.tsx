// Mobile app entry — boot, shell chrome, and the native seams.
//
// The shared shell composition (models, overlay/sheet state machines,
// search, queue/playback ops, downloads UI, transfer, settings
// surfaces, toasts) lives in @auqw/app-shell's useAppShell; Main wires
// it up through `ports` and renders what it returns. What stays here
// is what is genuinely native:
//
//   - boot + fonts + the session restore gate (createSessionController
//     over auqw-expo, retry counter)
//   - ThemeSource from the system tonal palette + color scheme
//   - connectivity (edge-then-snapshot with the stale-snapshot guard),
//     haptics, IME dismissal on search commit — passed as ports
//   - SAF/document file ops: folder-pick export, pickFileAsync import
//   - the sync engine surface: pairing mint/remint, share offers,
//     mDNS nearby peers, clipboard delta import/export
//   - stage gesture state (the shared morph progress/travel/anchor
//     values the sheet and mini-player pill write during drags)
//   - the Android hardware-back chain, the artwork-cache sweep, the
//     __DEV__ auqw:// journey harness, and the screen JSX itself
//
// Everything behavioral above the platform boundary is shared — a fix
// in the hook fixes both shells.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
  appError,
  collectSyncDeltaDocs,
  err,
  exportFittedDeltaDoc,
  formatEndpoint,
  fromUnknown,
  parseSyncDeltaDocs,
  serializeSyncDeltaDocs,
} from '@auqw/application';
import type {
  AppError,
  EntityRef,
  ReadySession,
  Result,
  SessionState,
  Settings,
  SyncClientStatus,
  SyncDiscoveredPeer,
} from '@auqw/application';
import {
  AddToPlaylistSheet,
  AppStack,
  ArtworkResolverProvider,
  AuthSheet,
  CollectionScreen,
  CorrectionsScreen,
  EntityScreen,
  ErrorState,
  GalleryScreen,
  HomeScreen,
  IconButton,
  LanguagePickerSheet,
  LibraryScreen,
  LoadingState,
  PlatformTabs,
  PlaylistScreen,
  Pressable,
  ProviderPickerSheet,
  PushScreen,
  RowActionsSheet,
  SearchFab,
  SearchScreen,
  SettingsScreen,
  SheetScreen,
  StackItem,
  StageSheet,
  StatusBarFade,
  SyncScreen,
  Text,
  ThemePickerSheet,
  ThemeProvider,
  TransferScreen,
  UpdateCard,
  ValueFieldSheet,
  entityIdForRef,
  languageOptionKey,
  languageOptions,
  resolveLocale,
  setLocale,
  systemLocaleTag,
  t,
  toCollectionModel,
  toSyncModel,
  formatExpiry,
  useTheme,
} from '@auqw/ui-native';
import type {
  ArtworkResolver,
  MessageId,
  ProviderPickerOption,
  ThemeSource,
} from '@auqw/ui-native';
import {
  SEARCH_LIMIT,
  entityRefKey,
  errorText,
  navItems,
  qualityOptions,
  reportResult,
  themeCardViews,
  toAuthSheetModel,
} from '@auqw/ui-shared';
import { useSearchScreenController } from '@auqw/ui-shared/controllers';
import type { Boot, OverlayEntry } from '@auqw/ui-shared';
import { createSessionController } from './src/session/controller.ts';
import type { SessionController } from './src/session/controller.ts';
import { useAppShell } from '@auqw/app-shell';
import type { AppShellPorts } from '@auqw/app-shell';
import { createMobileAuth } from './src/adapters/auth.ts';
import { createAuqwExpoPlayer } from './src/adapters/auqw-expo-player.ts';
import { createExpoPeaksPort } from './src/adapters/expo-peaks.ts';
import { createExpoUpdate } from './src/adapters/expo-update.ts';
import { discoveredPotProviderUrl } from './src/adapters/pot-provider-discovery.ts';
import { potProviderUrlFromPeers } from './src/adapters/pot-provider.ts';
import { createClock, createIds } from '@auqw/application';
import { devRoute } from './src/dev-routes.ts';
import { appFilePath, runSeamLink } from './seam-dev.ts';
import appConfig from './app.config.ts';

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
// than a provider-internal tree id. A badly-escaped docId still
// exported fine — label it raw rather than surface a write failure
// for what is only a label-formatting problem.
function exportDestinationLabel(uri: string): string {
  if (!uri.startsWith('content://')) {
    return uri;
  }
  const raw = uri.split('/document/').pop() ?? uri;
  try {
    return decodeURIComponent(raw).replace(/^[a-zA-Z0-9_-]+:/, '');
  } catch {
    return raw.replace(/^[a-zA-Z0-9_-]+:/, '');
  }
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

function GateFrame({ children }: { readonly children: ReactNode }) {
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
      {children}
    </View>
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
  return (
    <GateFrame>
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
    </GateFrame>
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
      const setIfLatest = (
        next: AuqwExpo.SystemTonalPalette | null,
      ): void => {
        if (live && mine === generation) {
          setTones(next);
        }
      };
      void AuqwExpo.systemTonalPalette().then(setIfLatest, () =>
        setIfLatest(null),
      );
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
    const dark = scheme === 'dark';
    return {
      scheme,
      palette: {
        bg: dark ? tones.neutral1_900 : tones.neutral1_50,
        fg: dark ? tones.neutral1_50 : tones.neutral1_900,
        accent: dark ? tones.accent1_200 : tones.accent1_600,
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
  return (
    <GateFrame>
      {state.type === 'restore-failed' ? (
        <ErrorState
          title={t('boot.restoreFailed')}
          hint={errorText(state.error)}
          onRetry={() => void controller.session.restore()}
        />
      ) : (
        <LoadingState title={t('boot.restoring')} />
      )}
    </GateFrame>
  );
}

type Overlay =
  | { readonly type: 'collection'; readonly key: 'liked' | 'top50' | 'history' | 'downloads' }
  | { readonly type: 'playlist'; readonly playlistId: string }
  | { readonly type: 'entity'; readonly ref: EntityRef }
  | { readonly type: 'corrections' }
  | { readonly type: 'transfer' }
  | { readonly type: 'sync' };

type ShareState = {
  readonly active: boolean;
  readonly busy: boolean;
  readonly code: string | null;
  readonly payload: string | null;
  /** Primary `host:port` the offer advertises — typed-join display. */
  readonly endpoint: string | null;
  readonly expiresAt: number | null;
};

const SHARE_CLOSED: ShareState = {
  active: false,
  busy: false,
  code: null,
  payload: null,
  endpoint: null,
  expiresAt: null,
};

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
  // The OS light/dark read drives the 'system'/'adaptive' theme-card
  // previews — the resolved theme.scheme can't see the OS value once a
  // scheme is forced.
  const osScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
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
  // Shared 0..1 dismiss slide — drags below the collapsed anchor
  // slide the whole surface offscreen on it (OpenTune's dismissed
  // bound below collapsed).
  const stageGone = useSharedValue(0);
  // The collapsed strip the sheet's pill parks on (OpenTune's
  // collapsedBound): measured tab-bar height + the pill's gap +
  // its height. PlatformTabs reports the bar height upward — kept
  // in JS state too so the update card can anchor above the pill.
  const stageCollapsedHeight = useSharedValue(0);
  const [tabBarHeight, setTabBarHeight] = useState(0);
  const { width: paneWidth } = useWindowDimensions();
  // The floating search loupe — the single search field on mobile.
  const [searchFabOpen, setSearchFabOpen] = useState(false);
  const reportStageCollapsed = useCallback(
    (barHeight: number) => {
      setTabBarHeight(barHeight);
      stageCollapsedHeight.value =
        barHeight + theme.spacing.md + theme.sizes.miniPlayer;
    },
    [theme, stageCollapsedHeight],
  );

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
  const [share, setShare] = useState<ShareState>(SHARE_CLOSED);
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
    readonly SyncDiscoveredPeer[]
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
  // OAuth session trust — secure-store custody + the host's in-memory
  // token slot; construction kicks the memoized boot restore, so a
  // stored grant refreshes before the first sign-in UI ever reads.
  const authPort = useMemo(() => createMobileAuth(controller), [controller]);
  // The session owns renewal timers + custody writes — it must not
  // outlive Main: an orphan keeps renewing the grant and can re-arm
  // the host bearer after a remounted session signs out.
  useEffect(() => () => authPort.dispose(), [authPort]);
  // Release-update seam — the shared check over RN fetch; on Android
  // the act leg downloads the APK and fires the system installer,
  // everywhere else it opens the release page.
  const updatePort = useMemo(
    () => createExpoUpdate(appConfig.version ?? ''),
    [],
  );
  const ports = useMemo<AppShellPorts<Overlay>>(
    () => ({
      // Mobile's connectivity port is edge+snapshot: subscribe first
      // — a delayed snapshot resolving after an edge is stale and
      // must not overwrite it; a failed watch degrades to
      // snapshot-only honesty (Android's callback quota can refuse
      // registration outright).
      subscribeOnline: (listener) => {
        let dead = false;
        let edged = false;
        let unsub: () => void = () => {};
        try {
          unsub = controller.connectivity.subscribe((snap) => {
            edged = true;
            listener(snap.online);
          });
        } catch {
          // Edge-less mode: snapshot-only honesty.
        }
        void controller.connectivity.snapshot().then((snap) => {
          if (!dead && !edged && snap.ok) {
            listener(snap.value.online);
          }
        });
        return () => {
          dead = true;
          unsub();
        };
      },
      // Foreground edges drive the shell's appActive gate: the
      // interpolated-position clock feeding lyrics keeps ticking under
      // background audio (JS timers still run) but renders nothing —
      // off-screen ticks only burn battery.
      subscribeAppActive: (listener) => {
        listener(AppState.currentState === 'active');
        const sub = AppState.addEventListener('change', (next) => {
          listener(next === 'active');
        });
        return () => sub.remove();
      },
      // localPlayable stays unset: on native the owned-bytes check IS
      // the attachable set — the player plays downloads and scanned
      // local files directly. (Desktop passes its capability probe
      // instead — the web player has no provider:'local' route yet.)
      // The iOS provisional player has no local-attach path, so a
      // stored download there could never play — hide every create
      // affordance; existing rows still surface for removal.
      downloadsEnabled: Platform.OS !== 'ios',
      // OAuth session trust — refresh custody lives in secure storage;
      // only status + the device pair cross this surface.
      auth: authPort,
      // Release check — GitHub only, once per boot + manual from
      // settings; the install affordance is per-platform.
      update: updatePort,
      // Mobile's playlist-entry play resolves owned bytes first —
      // selectedRef drops to null so the session picks the local
      // file over the pinned provider ref.
      preferOwnedRef: true,
      // Home-card keys: only the recents surface may carry a
      // recording id — a suggestion miss must not try playing the
      // key as one.
      strictHomeCardKeys: true,
      // Local index rows merge into the catalog search surface —
      // provenance 'local' hits rank ahead of provider results.
      localCatalog: true,
      // Entity + search rows mark the actually-resolved playing ref.
      markPlayingRef: true,
      // Same late-verdict funnel as desktop: a native `failed` status
      // landing after the op promise settled surfaces through the
      // playback.failed watcher, not just the op's own Result.
      trackAttemptActions: true,
      // The stage sheet morph owns the mount lifecycle — a queue end
      // holds the last player until the sheet settles collapsed.
      holdEndedPlayer: true,
      // The "playing from …" origin tap navigates inside an overlay —
      // the expanded sheet would cover it, so it closes on mobile.
      closeStageOnContextNav: true,
      resetStageMorph: () => {
        stageProgress.value = 0;
        stageTravel.value = 0;
        stageGone.value = 0;
      },
      // Lyrics prefetch while the Stage is open in any mode — one
      // provider call per track — so switching to the lyrics tab is
      // instant.
      lyricsWhileOpen: true,
      // A new track under an open sheet returns it to player mode —
      // the playing item is what the sheet exists to show.
      resetModeOnTrack: true,
      openSyncOverlay: { type: 'sync' },
      haptic: (style) => {
        if (style === 'warning') {
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Warning,
          );
        } else {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
      },
      // A committed search replaces the draft surface with results —
      // the IME has no work left and would just cover the list.
      onSearchCommit: () => Keyboard.dismiss(),
      afterLocalMutation: (mutated, refreshLocal) => {
        // A committed mutation lands on the instance the op ran on —
        // a mid-flight rehydrate swaps the local source, and
        // projecting the live replacement's pre-commit snapshot hides
        // the committed rows. When the instance swapped, persisted
        // storage holds the commit: rehydrate rebuilds the live source
        // from it (and projects itself). Same instance → its rows ARE
        // post-commit — project them directly.
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
      },
      sweepArtworkCache: () => {
        void controller.artworkCache.sweep({
          requestId: createIds().next('artwork-sweep'),
          deadlineMs: createClock().nowMs() + 60_000,
          signal: new CancellationSource().signal,
        });
      },
      settingsExtras: () => ({
        // The tag-reader surface is Android-only — iOS's auqw-expo
        // build has no tag* functions, so those rows must not act
        // live.
        localSupported: AuqwExpo.hasTagReader?.() === true,
        syncSupported: syncSurface !== null,
        // toSyncModel is pure — derive the label inside the thunk so
        // the hook's settings memo can run before syncModel exists
        // below (both localize through localeTick deps).
        syncLabel: toSyncModel({
          available: syncSurface !== null,
          status: syncStatus,
        }).statusLabel,
      }),
      peaksPort,
      // Finished profiles persist content-keyed — a replay renders
      // stored bars instead of re-extracting every cold track.
      peaksStore: controller.peaksStore,
      // Durable recents rail — the device-local `search_history`
      // table hydrates on mount; a committed query persists through
      // the same store on both apps.
      searchHistory: controller.searchHistory,
      // SAF folder pick on Android — the export lands where the user
      // can reach it (Downloads and friends), not app-private storage;
      // iOS writes into the documents root.
      exportJson: async (json, name) => {
        try {
          let file: File;
          if (Platform.OS === 'android') {
            const dir = await Directory.pickDirectoryAsync();
            file = dir.createFile(name, 'application/json');
          } else {
            file = new File(Paths.document, name);
            if (file.exists) {
              file.delete();
            }
            file.create();
          }
          file.write(json);
          return {
            kind: 'done' as const,
            detail: () => exportDestinationLabel(file.uri),
          };
        } catch (thrown) {
          if (
            thrown instanceof Error &&
            'code' in thrown &&
            thrown.code === 'ERR_PICKER_CANCELLED'
          ) {
            return { kind: 'cancelled' as const };
          }
          return { kind: 'error' as const };
        }
      },
    }),
    [
      controller,
      session,
      peaksPort,
      authPort,
      updatePort,
      syncSurface,
      syncStatus,
    ],
  );

  // The shared shell composition — every state/callback surface the
  // desktop shell builds identically lives in useAppShell; this file
  // keeps only the platform seams (connectivity edge+snapshot, SAF
  // folder/file ops, the artwork cache, haptics, the sync engine
  // surface, gesture morph values, IME dismissal, deep links) wired
  // through ports.
  const shell = useAppShell<Overlay>({ controller, state, ports });
  const {
    localeApplied,
    localeTick,
    online,
    toast,
    updateCard,
    onUpdateBannerAct,
    onUpdateBannerDismiss,
    tab,
    setTab,
    selectTab,
    overlay,
    overlayStack,
    pushOverlay,
    resetOverlay,
    closeOverlay,
    dismissOverlay,
    clearOverlays,
    stageOpen: expanded,
    setStageOpen: setExpanded,
    focusSearch,
    searchFocusTick,
    setStageOpenFor,
    stageMode,
    setStageMode,
    stageReopenMode,
    reordering,
    toggleReordering,
    player,
    stagePlayer: sheetPlayer,
    heldOccurrenceId,
    queueModel,
    skipPreview,
    peaks,
    onPlayPause,
    onToggleLike,
    advance,
    playQueueOccurrence,
    rowIntent,
    onQueueViewport,
    onMoveQueueItem,
    onMoveQueueItemTo,
    removeQueueOccurrence,
    clearUpcoming,
    openQueueContext,
    seekToPosition,
    canPlay,
    playRecording,
    onResultPress,
    onHomeCardPress,
    playCollectionRows,
    playLibraryItem,
    playPlaylistEntry,
    playRefFor,
    entityShuffleAll,
    onEntityRowPress,
    entityRowMeta,
    reportPlay,
    queueSettingsWrite,
    downloadRefFor,
    searchState,
    searchSession: search,
    query,
    setQuery,
    setSearchFilter,
    submitSearch,
    retrySearch,
    cancelSearch,
    applySearchText,
    searchRecents,
    suggestions,
    resultMetaFor,
    resultTargetFor,
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
    actionsFor,
    setActionsFor,
    closeRowActions,
    rowActions,
    onRowAction,
    pickerFor,
    closePlaylistPicker,
    onPickPlaylist,
    onCreateAndPick,
    providerSlot,
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
    artworkCachePickerOpen,
    onPickArtworkCache,
    closeArtworkCache,
    onSettingsSelect,
    onSettingsToggle,
    stageDownload,
    onStageDownload,
    onStageAddToPlaylist,
    playlistDownloadFor,
    onPlaylistDownloadAll,
    onStartRadioGated,
    radioSeedProvider,
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
    resetTransfer,
    renamePlaylist,
    deletePlaylist,
    removePlaylistEntry,
    movePlaylistEntry,
    onOpenCard,
    onCreatePlaylist,
  } = shell;

  // The tonal source powers the adaptive card's real palette — live
  // while adaptive is picked (the provider's own read) and while the
  // theme sheet is open so the preview matches what picking applies.
  const themeSource = useAdaptiveSource(
    state.settings.theme === 'adaptive' || themePickerOpen,
  );

  // A swipe-dismissed sheet parks `stageGone` at 1 until the held
  // mount releases; a player taking over inside that window must not
  // inherit a pill translated offscreen. Only the dismiss axis resets
  // — an expanded gesture keeps its progress.
  const hadPlayerRef = useRef(false);
  useEffect(() => {
    const hasPlayer = player !== null;
    if (hasPlayer && !hadPlayerRef.current) {
      stageGone.value = 0;
    }
    hadPlayerRef.current = hasPlayer;
  }, [player, stageGone]);
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

  const [showGallery, setShowGallery] = useState(false);
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
      if (client == null || pairing) {
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
    if (!syncOpen || discovery == null) {
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
            peer,
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
    setShare(SHARE_CLOSED);
    setAdvertNotice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncOpen]);

  // Mint + apply a fresh offer — gated on a share still owning the
  // host (shareGenRef) and share still active inside the set.
  const remintShareOffer = useCallback(() => {
    const host = syncSurface?.host;
    if (host == null || shareGenRef.current === 0) {
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
    if (!share.active || host == null) {
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
    if (host == null || share.busy) {
      return;
    }
    if (share.active) {
      shareGenRef.current = 0;
      void host.stop();
      setShare(SHARE_CLOSED);
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
    // A failed start/mint unwinds the same way: release the host,
    // clear the share surface, surface the error.
    const abortShare = async (error: AppError): Promise<void> => {
      shareGenRef.current = 0;
      await host.stop();
      setShare(SHARE_CLOSED);
      setPairError(error);
    };
    void (async () => {
      const started = await host.start();
      if (shareGenRef.current !== gen) {
        return; // cleanup stopped the host, or a newer share owns it
      }
      if (!started.ok) {
        await abortShare(started.error);
        return;
      }
      const offer = await host.mintOffer();
      if (shareGenRef.current !== gen) {
        return;
      }
      if (!offer.ok) {
        await abortShare(offer.error);
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
      setShare(SHARE_CLOSED);
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
      void syncSurface?.client.syncNow(fp, new CancellationSource().signal);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller],
  );
  const onUnpair = useCallback(
    (fp: string) => {
      void syncSurface?.client.unpair(fp, new CancellationSource().signal);
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
            undefined,
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

  const onPickImportFile = useCallback(() => {
    beginImportRead();
    void (async () => {
      try {
        const picked = await File.pickFileAsync({
          mimeTypes: ['application/json', 'text/*'],
        });
        if (picked.canceled) {
          cancelImportRead();
          return;
        }
        const file = picked.result;
        const text = await file.text();
        onImportText(text, file.uri.split('/').pop() ?? file.uri);
      } catch {
        failImportRead();
      }
    })();
  }, [beginImportRead, cancelImportRead, onImportText, failImportRead]);

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
        closeRowActions();
        return true;
      }
      if (pickerFor !== null) {
        closePlaylistPicker();
        return true;
      }
      if (providerSlot !== null) {
        closeProviderPicker();
        return true;
      }
      if (overlayStack.length > 0) {
        closeOverlay();
        return true;
      }
      if (expanded) {
        // Clear a pending commit token too — an expand commit queued
        // just before this press would otherwise land after the close
        // and reopen the sheet. -1 is the idle marker: writing the
        // collapse target (0) would make the expanded effect read the
        // close as gesture-owned and skip its collapse spring.
        stageAnchor.value = -1;
        setExpanded(false);
        return true;
      }
      // A gesture-committed sheet expand sets `stageAnchor` before the
      // `expanded` state lands — a back press inside that window would
      // navigate away and the in-flight commit would reopen the sheet
      // over it. Cancel the pending commit and swallow the press.
      // The unwind callback re-checks `stageAnchor` before expanding,
      // and queued commits gate on it in `commitAnchor` — writing 0
      // cancels both rather than just moving the shared value. A
      // release from rest has its expand spring already in flight, so
      // the surface retreats to the pill in the same breath. A queued
      // commit that ran just before this press is overridden by the
      // close — the last write wins on the same JS run queue.
      if (stageAnchor.value === 1) {
        stageAnchor.value = 0;
        stageProgress.value = 0;
        setExpanded(false);
        return true;
      }
      // A sheet drag still in flight mints a fresh commit token at
      // release — writing -2 marks it cancelled so the finalize
      // worklet retreats without committing over the navigation this
      // press just ran.
      if (stageAnchor.value === 2) {
        stageAnchor.value = -2;
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
    stageAnchor,
    stageProgress,
    tab,
    closeOverlay,
    closeRowActions,
    closePlaylistPicker,
    closeProviderPicker,
  ]);

  // __DEV__-only gate instrumentation: `auqw://` links drive the real
  // session methods so emulator/simulator journeys are scriptable.
  // Verbs: open?tab=&playlist=&collection=, entity?provider=&kind=&id=,
  // search?q=, play-result?i=N, next, previous, pause, resume,
  // like-current, seek?ms=, lyrics, radio?provider=&id=, stop-radio,
  // provider?catalog=&playback=&lyrics=&radio=, corrections,
  // review?list|confirm=&candidate=|reject=|undo=, transfer?export|
  // import=<path>|apply-import, download?i=N|downloads, local-add|
  // local-rescan|local-list, airplane. Never ships in release bundles.
  const journeyDeps = useRef({ session, search, state, controller, downloadRefFor, reportPlay, queueSettingsWrite, seekToPosition });
  journeyDeps.current = { session, search, state, controller, downloadRefFor, reportPlay, queueSettingsWrite, seekToPosition };
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
      // The local-files journeys share the "source started" gate.
      const localOr = (verb: string) => {
        const local = ctl.local();
        if (local === null) {
          console.log(`[journey] ${verb}: source not started`);
        }
        return local;
      };
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
          const items =
            searchStateRef.current.type === 'content'
              ? searchStateRef.current.page.items
              : [];
          if (items[i] !== undefined) {
            void s
              .playMetadata(items, { startAt: i })
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
                  : `[journey] radio seed failed: ${res.error.kind}`,
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
                console.log(
                  `[journey] review list failed: ${listed.error.kind}`,
                );
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
          const local = localOr('local-add');
          if (local === null) {
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
          const local = localOr('local-rescan');
          if (local === null) {
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
          const local = localOr('local-list');
          if (local === null) {
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
            resetTransfer();
            beginImportRead();
            void (async () => {
              try {
                const uri = importPath.startsWith('file://')
                  ? importPath
                  : `file://${importPath}`;
                const text = await new File(uri).text();
                onImportText(
                  text,
                  importPath.split('/').pop() ?? importPath,
                );
              } catch {
                failImportRead();
              }
            })();
          } else if (params.has('apply-import')) {
            onApplyImport();
          } else if (params.has('export')) {
            resetTransfer();
            onExport();
          } else {
            resetTransfer();
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
  // The floating loupe's field shares the explore pane's field view —
  // same draft text, same submit/cancel, one query.
  const fabFieldView = useSearchScreenController({
    state: searchModel,
    query,
    onQueryChange: setQuery,
    onSubmit: submitSearch,
    onCancel: cancelSearch,
  }).field;
  // Floating overlays (offline banner, toast) share the chrome.
  const floatStyle = {
    position: 'absolute' as const,
    alignSelf: 'center' as const,
    borderRadius: theme.radius.float,
    backgroundColor: theme.colors.raised,
    borderWidth: theme.strokes.hairline,
    borderColor: theme.colors.hairline,
  };
  // Toasts report failures from sheets and pushed screens too, so a
  // copy mounts inside every screen layer — whichever is topmost
  // shows it AND announces (a presenting screen's live region can be
  // hidden from a11y while its sheet is up). iOS formSheets/pushes
  // are native VCs above the whole React tree: a sibling outside the
  // stack can never float over them. Every covered copy stays
  // a11y-hidden; only the topmost one is a live region.
  const toastPill = (live: boolean, bottom: number) =>
    toast === null ? null : (
      <View
        {...(live
          ? { accessibilityLiveRegion: 'polite' as const }
          : { importantForAccessibility: 'no-hide-descendants' as const })}
        pointerEvents="none"
        style={{
          ...floatStyle,
          bottom,
          maxWidth: '92%',
          paddingHorizontal: 14,
          paddingVertical: 6,
        }}
      >
        <Text variant="metadata" color="primary">
          {toast}
        </Text>
      </View>
    );
  // In-sheet copies take a real slot under the sheet's rows instead
  // of floating — the sheet's wrapper is fit-to-contents, so an
  // absolute pill would land on the last action row. Canvas bg keeps
  // it legible on the raised sheet.
  const toastPillInSheet = (live: boolean) =>
    toast === null ? null : (
      <View
        {...(live
          ? { accessibilityLiveRegion: 'polite' as const }
          : { importantForAccessibility: 'no-hide-descendants' as const })}
        pointerEvents="none"
        style={{
          alignSelf: 'center',
          borderRadius: theme.radius.float,
          backgroundColor: theme.colors.canvas,
          borderWidth: theme.strokes.hairline,
          borderColor: theme.colors.hairline,
          marginTop: theme.spacing.sm,
          marginBottom: theme.spacing.sm,
          maxWidth: '92%',
          paddingHorizontal: 14,
          paddingVertical: 6,
        }}
      >
        <Text variant="metadata" color="primary">
          {toast}
        </Text>
      </View>
    );
  // Presentation order is JSX order: the last open layer is topmost
  // and owns the live region.
  const toastLayer = authClientSheetOpen
    ? 'authClient'
    : authSheetOpen
      ? 'auth'
      : artworkCachePickerOpen
        ? 'artworkCache'
        : qualityPickerOpen
          ? 'quality'
          : storefrontSheetOpen
            ? 'storefront'
            : languagePickerOpen
              ? 'language'
              : themePickerOpen
                ? 'theme'
                : providerPicker !== null
                  ? 'provider'
                  : pickerFor !== null
                    ? 'playlist'
                    : rowActions !== null
                      ? 'rowActions'
                      : overlayStack.length > 0
                        ? 'push'
                        : 'root';
  // World-pane elements memoized per tab: the tab host keeps every
  // visited pane mounted (the switch hides/shows instead of remounting),
  // and identical inputs hand back the identical element so React bails
  // out of reconciling the pane entirely — a switch with no data change
  // costs no screen render at all. Deps enumerate every input the
  // element closes over; keep the list exhaustive with the JSX below.
  const exploreEl = useMemo(
    () => (
      <SearchScreen
        state={searchModel}
        query={query}
        // The floating loupe occupies a 44px slot under the inset —
        // reserve it so it never covers the recents/results heading.
        topInset={topInset + 52}
        onQueryChange={setQuery}
        onSubmit={submitSearch}
        onCancel={cancelSearch}
        onRetry={retrySearch}
        onResultPress={onResultPress}
        onRowIntent={(row) => {
          const target = resultTargetFor(row.key);
          if (target?.kind === 'recording') {
            rowIntent({ kind: 'recording', id: target.recordingId });
          } else if (target?.kind === 'metadata') {
            rowIntent({ kind: 'track', track: target.meta });
          }
        }}
        onContext={(row) => {
          const target = resultTargetFor(row.key);
          if (target !== null) {
            setActionsFor(target);
          }
        }}
        recents={searchRecents}
        onRecentPress={applySearchText}
        suggestions={suggestions}
        onSuggestionPress={applySearchText}
        onFilterPress={setSearchFilter}
      />
    ),
    [
      searchModel,
      query,
      topInset,
      submitSearch,
      cancelSearch,
      retrySearch,
      onResultPress,
      rowIntent,
      resultTargetFor,
      setActionsFor,
      searchRecents,
      applySearchText,
      suggestions,
      setSearchFilter,
    ],
  );
  const libraryEl = useMemo(
    () => (
      <LibraryScreen
        model={libraryModel}
        topInset={topInset}
        onPressItem={(id) => playLibraryItem(libraryModel.items, id)}
        onRowIntent={(id) => rowIntent({ kind: 'recording', id })}
        onToggleLike={(id) => void session.toggleLike(id)}
        onContext={(id) =>
          setActionsFor({ kind: 'recording', recordingId: id })
        }
        onOpenCollection={(key) =>
          pushOverlay({ type: 'collection', key })
        }
        onPlayCollection={(key) =>
          playCollectionRows(key, libraryModel.collectionRows[key])
        }
        onOpenCard={onOpenCard}
        onOpenArtist={(artist) => {
          if (artist.entityRef !== null) {
            openEntity(artist.entityRef);
          }
        }}
        onCreatePlaylist={onCreatePlaylist}
      />
    ),
    [
      libraryModel,
      topInset,
      playRecording,
      rowIntent,
      session,
      pushOverlay,
      playCollectionRows,
      onOpenCard,
      openEntity,
      onCreatePlaylist,
    ],
  );
  const settingsEl = useMemo(
    () => (
      <SettingsScreen
        model={settingsModel}
        topInset={topInset}
        onSelectRow={onSettingsSelect}
        onToggleRow={onSettingsToggle}
        onOpenCorrections={() => pushOverlay({ type: 'corrections' })}
      />
    ),
    [
      settingsModel,
      topInset,
      onSettingsSelect,
      onSettingsToggle,
      pushOverlay,
    ],
  );
  const homeEl = useMemo(
    () => (
      <HomeScreen
        model={homeModel}
        topInset={topInset}
        onPressCard={onHomeCardPress}
        onOpenCollection={(key) =>
          pushOverlay({ type: 'collection', key })
        }
        onPlayCollection={(key) =>
          playCollectionRows(key, libraryModel.collectionRows[key])
        }
        onResume={() =>
          void session.resume().then((r) => reportPlay('action.resume', r))
        }
      />
    ),
    [
      homeModel,
      topInset,
      onHomeCardPress,
      session,
      reportPlay,
      pushOverlay,
      playCollectionRows,
      libraryModel,
    ],
  );
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
        return exploreEl;
      case 'library':
        return libraryEl;
      case 'settings':
        return settingsEl;
      default:
        return homeEl;
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
            onPressItem={(row) =>
              playCollectionRows(current.key, model.rows, row)
            }
            onRowIntent={(row) =>
              rowIntent({ kind: 'recording', id: row.recordingId })
            }
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

            onDownloadAll={() =>
              onPlaylistDownloadAll(playlistDownloadFor(playlistModel).requests)
            }
            downloadAllState={playlistDownloadFor(playlistModel).state}
            onRename={(name) => renamePlaylist(current.playlistId, name)}
            onDelete={() => {
              deletePlaylist(current.playlistId);
              dismissOverlay(entry.key);
            }}
            onPressEntry={(entry) =>
              playPlaylistEntry(playlistModel, entry)
            }
            onRowIntent={(entry) =>
              rowIntent({
                kind: 'recording',
                id: entry.recordingId,
                ref: playRefFor(entry.recordingId, entry.selectedRef),
              })
            }
            onToggleLike={(entry) => void session.toggleLike(entry.recordingId)}
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
        return (
          <EntityScreen
            model={entityModelFor(fetch)}
            topInset={topInset}
            onBack={closeOverlay}
            onShuffleAll={() => entityShuffleAll(fetch, entry.key)}
            onToggleLike={
              entityId === null
                ? undefined
                : () =>
                  void session.toggleEntityLike(current.ref.kind, entityId)
            }
            onPressItem={(row) => onEntityRowPress(entry.key, fetch, row)}
            onRowIntent={(row) => {
              const meta = entityRowMeta(entry.key, row);
              if (meta !== undefined) {
                rowIntent({ kind: 'track', track: meta });
              }
            }}
            onContext={(row) => {
              const meta = entityRowMeta(entry.key, row);
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
      case 'sync': {
        const hasHost = syncSurface?.host != null;
        const hasDiscovery = syncSurface?.discovery != null;
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
              hasHost
                ? {
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
                : undefined
            }
            onShareToggle={hasHost ? onShareToggle : undefined}
            onCopyPayload={hasHost ? onCopyPayload : undefined}
            nearbyPeers={
              hasDiscovery
                ? nearbyPeers.map((peer) => ({
                    key: peer.key,
                    name: peer.name,
                    address: `${peer.host}:${peer.port}`,
                    pinned: peer.fp !== null,
                  }))
                : undefined
            }
            onPairNearby={hasDiscovery ? onPairNearby : undefined}
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
      }
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
          {/* No accessory slot and no dead reserve: the stage sheet
              IS the miniplayer — its collapsed geometry floats the
              pill over the tab bar while content scrolls beneath,
              exactly like OpenTune's single bottom sheet. */}
          <PlatformTabs
            items={navItems()}
            activeKey={tab}
            onSelect={selectTab}
            renderTab={renderTabScreen}
            onTabBarHeight={reportStageCollapsed}
          />
          {/* The one search field — floats top-right over every tab
              (the panes own no second input); renders before the
              sheets so the player covers it when open. */}
          <SearchFab
            field={fabFieldView}
            live={query !== ''}
            open={searchFabOpen}
            onOpenChange={setSearchFabOpen}
            focusSignal={searchFocusTick}
            onNavigateToSearch={
              tab === 'explore' ? undefined : focusSearch
            }
            topInset={topInset}
            width={paneWidth}
          />
          {sheetPlayer !== null ? (
            <StageSheet
              player={sheetPlayer}
              expanded={expanded}
              progress={stageProgress}
              travel={stageTravel}
              anchor={stageAnchor}
              gone={stageGone}
              collapsedHeight={stageCollapsedHeight}
              onExpandChange={setStageOpenFor}
              onDismiss={() => void session.stop()}
              skipNext={skipPreview.next}
              skipPrevious={skipPreview.previous}
              nextEndsQueue={skipPreview.nextEndsQueue}
              mode={stageMode}
              onModeChange={setStageMode}
              restMode={stageReopenMode}
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
              download={stageDownload}
              onDownload={onStageDownload}
              onAddToPlaylist={onStageAddToPlaylist}
              onTrackMenu={
                sheetPlayer.recordingId === null
                  ? undefined
                  : () => {
                      const recordingId = sheetPlayer.recordingId;
                      if (recordingId !== null) {
                        setActionsFor({ kind: 'recording', recordingId });
                      }
                    }
              }
              onRecovery={onAuthRecovery}
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
              onStartRadio={onStartRadioGated}
              radioSeedProvider={radioSeedProvider}
              onStopRadio={onStopRadio}
              onPressQueueItem={playQueueOccurrence}
              onQueueRowIntent={(id) =>
                rowIntent({ kind: 'occurrence', id })
              }
              onQueueViewport={onQueueViewport}
              onRemoveQueueItem={removeQueueOccurrence}
              onClearUpcoming={clearUpcoming}
              onOpenQueueContext={openQueueContext}
              onToggleQueueReorder={toggleReordering}
              onMoveQueueItem={onMoveQueueItem}
              onMoveQueueItemTo={onMoveQueueItemTo}
            />
          ) : null}
          {online === false && (
            <View
              style={{
                ...floatStyle,
                top: topInset + 4,
                paddingHorizontal: 12,
                paddingVertical: 5,
              }}
            >
              <Text variant="metadata" color="secondary">
                {t('offline.bannerDownloads')}
              </Text>
            </View>
          )}
          {/* Update card — the snack's replacement: a determinate
              surface parked above the dock (or above the collapsed
              miniplayer pill when one is up). Hidden while the stage
              sheet owns the screen; the toast owns this slot only
              transiently. */}
          {updateCard !== null && !(expanded && sheetPlayer !== null) && (
            <View
              pointerEvents="box-none"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom:
                  tabBarHeight > 0
                    ? tabBarHeight +
                      theme.spacing.md +
                      (sheetPlayer !== null
                        ? theme.sizes.miniPlayer + theme.spacing.xs
                        : 0)
                    : insets.bottom + 88,
              }}
            >
              <UpdateCard
                model={updateCard}
                onAct={onUpdateBannerAct}
                onDismiss={onUpdateBannerDismiss}
              />
            </View>
          )}
          {toastPill(toastLayer === 'root', insets.bottom + 88)}
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
              {/* Same edge-to-edge veil as the tab scenes — pushed
                  overlays scroll under the status bar behind the
                  soft ramp too. */}
              <StatusBarFade height={topInset + 14} />
              {toastPill(
                toastLayer === 'push' &&
                  entry === overlayStack[overlayStack.length - 1],
                insets.bottom + 88,
              )}
            </PushScreen>
          );
        })}
        {rowActions !== null && (
          <SheetScreen
            stackKey="sheet-actions"
            onDismissed={closeRowActions}
          >
            <RowActionsSheet
              title={rowActions.title}
              actions={rowActions.actions}
              onAction={onRowAction}
              onDismiss={closeRowActions}
            />
            {toastPillInSheet(toastLayer === 'rowActions')}
          </SheetScreen>
        )}
        {pickerFor !== null && (
          <SheetScreen
            stackKey="sheet-add-playlist"
            onDismissed={closePlaylistPicker}
          >
            <AddToPlaylistSheet
              playlists={pickerItems}
              onPick={onPickPlaylist}
              onCreate={onCreateAndPick}
              onDismiss={closePlaylistPicker}
            />
            {toastPillInSheet(toastLayer === 'playlist')}
          </SheetScreen>
        )}
        {providerPicker !== null && (
          <SheetScreen
            stackKey="sheet-provider"
            onDismissed={closeProviderPicker}
          >
            <ProviderPickerSheet
              title={providerPicker.title}
              options={providerPicker.options}
              selectedKey={providerPicker.selectedKey}
              onPick={onPickProvider}
              onDismiss={closeProviderPicker}
            />
            {toastPillInSheet(toastLayer === 'provider')}
          </SheetScreen>
        )}
        {themePickerOpen && (
          <SheetScreen
            stackKey="sheet-theme"
            onDismissed={closeThemePicker}
          >
            <ThemePickerSheet
              title={t('settings.theme')}
              cards={themeCardViews(osScheme, themeSource)}
              selectedKey={state.settings.theme}
              onPick={onPickTheme}
              onDismiss={closeThemePicker}
            />
            {toastPillInSheet(toastLayer === 'theme')}
          </SheetScreen>
        )}
        {languagePickerOpen && (
          <SheetScreen
            stackKey="sheet-language"
            onDismissed={closeLanguagePicker}
          >
            <LanguagePickerSheet
              options={languageOptions()}
              selectedKey={languageOptionKey(state.settings.language)}
              onPick={onPickLanguage}
              onDismiss={closeLanguagePicker}
            />
            {toastPillInSheet(toastLayer === 'language')}
          </SheetScreen>
        )}
        {storefrontSheetOpen && (
          <SheetScreen
            stackKey="sheet-storefront"
            onDismissed={closeStorefront}
          >
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
            {toastPillInSheet(toastLayer === 'storefront')}
          </SheetScreen>
        )}
        {qualityPickerOpen && (
          <SheetScreen
            stackKey="sheet-quality"
            onDismissed={closeQualityPicker}
          >
            <ProviderPickerSheet
              title={t('settings.quality')}
              options={qualityOptions()}
              selectedKey={`${state.settings.qualityKbps}`}
              onPick={onPickQuality}
              onDismiss={closeQualityPicker}
            />
            {toastPillInSheet(toastLayer === 'quality')}
          </SheetScreen>
        )}
        {artworkCachePickerOpen && (
          <SheetScreen
            stackKey="sheet-artwork-cache"
            onDismissed={closeArtworkCache}
          >
            <ProviderPickerSheet
              title={t('settings.artworkCache')}
              options={artworkCacheOptions()}
              selectedKey={`${Math.round(
                (state.settings.artworkCacheBytes ??
                  ARTWORK_CACHE_BUDGET_DEFAULT_BYTES) /
                  (1024 * 1024),
              )}`}
              onPick={onPickArtworkCache}
              onDismiss={closeArtworkCache}
            />
            {toastPillInSheet(toastLayer === 'artworkCache')}
          </SheetScreen>
        )}
        {authSheetOpen && (
          <SheetScreen
            stackKey="sheet-auth"
            onDismissed={closeAuthSheet}
          >
            <AuthSheet
              model={toAuthSheetModel(
                authSnapshot?.status ?? { state: 'signed-out' },
              )}
              onCopyCode={authPort.copyText}
              onOpenLink={authPort.openUrl}
              onRetry={retryAuthFlow}
              onSignOut={onAuthSignOut}
              onDismiss={closeAuthSheet}
            />
            {toastPillInSheet(toastLayer === 'auth')}
          </SheetScreen>
        )}
        {authClientSheetOpen && (
          <SheetScreen
            stackKey="sheet-auth-client"
            onDismissed={closeAuthClient}
          >
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
            {toastPillInSheet(toastLayer === 'authClient')}
          </SheetScreen>
        )}
      </AppStack>
    </View>
  );
}
