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
  LOCAL_PROVIDER,
  SearchSession,
  isSyncDelta,
  previewImport,
} from '@auqw/application';
import type {
  AppError,
  AttemptTrace,
  EntityPage,
  EntityRef,
  LyricsSheet,
  MatchReview,
  OperationContext,
  ProviderCapability,
  ReadySession,
  Result,
  SearchState,
  SessionState,
  SourceRef,
  SyncDelta,
  TrackMetadata,
} from '@auqw/application';
import {
  AddToPlaylistSheet,
  AppStack,
  CollectionScreen,
  CorrectionsScreen,
  EntityScreen,
  ErrorState,
  HomeScreen,
  LibraryScreen,
  LoadingState,
  MiniPlayer,
  PairingSheet,
  PlaylistScreen,
  ProviderPickerSheet,
  PushScreen,
  RowActionsSheet,
  SearchScreen,
  SettingsScreen,
  SheetScreen,
  StackItem,
  StageColumn,
  Text,
  ThemeProvider,
  TransferScreen,
  WorldChrome,
  entityIdForRef,
  formatClock,
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
  LyricsModel,
  NavItemModel,
  ProviderPickerOption,
  SearchStateModel,
  StageMode,
  TrackRowModel,
  TransferModel,
} from '@auqw/ui-web';
import type {
  SyncDeviceInfo,
  SyncPairingResult,
  SyncStatusResult,
} from '../shared/contract.ts';
import { isSyncDeltaDoc } from '../shared/contract.ts';
import { isShellError } from '../shared/errors.ts';
import { createSessionController } from './controller.ts';
import type { SessionController } from './controller.ts';
import { createClock, createIds } from './runtime.ts';

const SEARCH_LIMIT = 25;
const DIAGNOSTICS_LIMIT = 20;

const NAV_ITEMS: readonly NavItemModel[] = [
  { key: 'home', label: 'home' },
  { key: 'explore', label: 'explore' },
  { key: 'library', label: 'library' },
];

// The world's centered tabs — settings stays reachable through the
// toolbar menu instead of a fourth tab (the contract's nav is
// home|explore|library only).

const THEME_ORDER = ['system', 'dark', 'light', 'oled'] as const;

const THEME_OPTIONS: readonly ProviderPickerOption[] = [
  { key: 'system', label: 'system', detail: 'follow the OS' },
  { key: 'dark', label: 'dark', detail: 'tokyo night' },
  { key: 'light', label: 'light', detail: 'daylight' },
  { key: 'oled', label: 'oled', detail: 'true black' },
];

type Boot =
  | { readonly type: 'loading' }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'ready'; readonly controller: SessionController };

function App() {
  const [attempt, setAttempt] = useState(0);
  const [boot, setBoot] = useState<Boot>({ type: 'loading' });

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
              thrown instanceof Error ? thrown.message : 'boot failed',
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
  readonly boot: Boot;
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
          title="couldn't start"
          hint={boot.message}
          onRetry={onRetry}
        />
      ) : (
        <LoadingState title="loading plugins" />
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
  return (
    <ThemeProvider theme={theme}>
      <ChromeSchemeReporter />
      {state.type === 'ready' ? (
        <Main controller={controller} state={state} />
      ) : (
        <SessionGate state={state} controller={controller} />
      )}
    </ThemeProvider>
  );
}

/** Pushes the resolved scheme to main so the titlebar overlay
    matches the canvas even when the user picked an explicit scheme. */
function ChromeSchemeReporter(): null {
  const { scheme } = useTheme();
  useEffect(() => {
    window.auqw.chrome.setScheme(scheme);
  }, [scheme]);
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
          title="couldn't restore your library"
          hint={state.error.message}
          onRetry={() => void controller.session.restore()}
        />
      ) : (
        <LoadingState title="restoring" />
      )}
    </div>
  );
}

function toSearchModel(state: SearchState): SearchStateModel {
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
        results: state.page.items.map(toSearchRowModel),
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
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function attemptLabel(trace: AttemptTrace): string {
  return `${trace.requestId} · ${trace.steps} steps · ${trace.httpCalls} http · ${formatClock(trace.elapsedMs)}`;
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

/** A pushed route on the desktop screen stack. */
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

const SLOT_LABELS: Record<ProviderSlot, string> = {
  catalogProvider: 'catalog provider',
  playbackProvider: 'playback provider',
  lyricsProvider: 'lyrics provider',
  radioProvider: 'radio provider',
};

// Lyrics and radio are nullable overrides — 'auto' returns routing
// to capability declaration; the required slots never offer it.
const OPTIONAL_SLOTS: ReadonlySet<ProviderSlot> = new Set([
  'lyricsProvider',
  'radioProvider',
]);

const IDLE_TRANSFER: TransferModel = {
  exportPhase: 'idle',
  exportDetail: null,
  importPhase: 'idle',
  importDetail: null,
  preview: null,
};

/**
 * Session ops resolve typed errors rather than throwing — a dropped
 * Result is a silent no-op. Keep failures observable: the `kind —
 * message` shape is taxonomy text and carries no secrets.
 */
function reportResult(action: string, result: Result<unknown>): void {
  if (!result.ok) {
    console.warn(
      `[ui] ${action} failed: ${result.error.kind} — ${result.error.message}`,
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
  const { session } = controller;
  const [tab, setTab] = useState('home');
  const [stageCollapsed, setStageCollapsed] = useState(false);
  const [stageMode, setStageMode] = useState<StageMode>('player');
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [query, setQuery] = useState('');
  // Bumped when '/' or Ctrl-K routes to the toolbar search — the
  // field focuses on the signal even when it was already open.
  const [searchFocusTick, setSearchFocusTick] = useState(0);
  // Playback volume — the stage column writes it straight to the
  // element; nothing else needs to observe it.
  const [volume, setVolume] = useState(() => controller.audio?.volume ?? 1);
  // Recent searches: session-scoped, newest first — persisting them
  // would be a storage-schema decision, so they die with the app.
  const [searchRecents, setSearchRecents] = useState<readonly string[]>([]);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [attempts, setAttempts] = useState<readonly AttemptTrace[]>([]);
  const resultMeta = useRef(new Map<string, TrackMetadata>());
  // Library-world overlay stack: pushed routes — collection list,
  // playlist editor, provider entity page — rendered as push screens
  // above the nav shell. Entity pages keep a fetch per ref so popping
  // back to a deeper screen restores its loaded content.
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
  // null = connectivity unknown (no baseline yet) — the offline
  // banner renders only on an explicit false.
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => controller.subscribeOnline(setOnline), [controller]);

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
  const importInput = useRef<HTMLInputElement | null>(null);
  const [providerSlot, setProviderSlot] = useState<ProviderSlot | null>(null);

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
  useEffect(() => {
    if (tab !== 'settings') {
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
    [state],
  );
  const queueModel = useMemo(
    () =>
      toQueueModel({
        queue: state.queue,
        recordings: state.recordings,
        likes: state.likes,
        unavailableRecordingIds:
          online === false
            ? new Set(state.queue.occurrences.map((o) => o.recordingId))
            : undefined,
      }),
    [state, online],
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
      downloads: [],
    });
    const playingId =
      state.playback.type === 'idle' ? null : state.playback.recordingId;
    // Honest-offline: with connectivity explicitly down, remote rows
    // degrade to 'unavailable' instead of spinning on a dead attempt.
    const offline = online === false;
    const decorate = (row: TrackRowModel, recordingId: string): TrackRowModel =>
      offline
        ? {
            ...row,
            playing: recordingId === playingId ? true : row.playing,
            state: 'unavailable',
            note: 'offline',
          }
        : recordingId === playingId
          ? { ...row, playing: true }
          : row;
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
  }, [state, online]);
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
        state.playback.type === 'idle' ? null : state.playback.recordingId;
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
              ? { state: 'unavailable' as const, note: 'offline' }
              : {}),
          },
        })),
      };
    },
    [state, online],
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
            ? 'search to start your library'
            : `${state.likes.length} liked`,
      }),
    [state, searchState],
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
    [state, controller, attempts, pendingReviews],
  );
  const settingsModel = useMemo(
    () =>
      toSettingsModel(state.settings, diagnostics, {
        // No download ledger or local folder surface on desktop yet
        // (Phase 4) — those rows hide rather than dead-press.
        localSupported: false,
        downloadCount: 0,
      }),
    [state.settings, diagnostics],
  );
  const syncModel = useMemo(
    () =>
      toSyncPanel(
        syncStatus,
        syncDevices,
        pairing,
        Date.now(),
        pairingError,
      ),
    [syncStatus, syncDevices, pairing, pairingTick, pairingError],
  );

  const onPairDevice = useCallback(() => {
    void window.auqw.sync
      .pairing()
      .then((offer) => {
        setPairing(offer);
        setPairingError(null);
      })
      // A mint failure (listener down, no LAN address) must surface —
      // a silent reject leaves the row looking dead-clicked.
      .catch((thrown: unknown) => {
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
  const onUnpairDevice = useCallback(
    (deviceId: string) => {
      void window.auqw.sync.unpair({ id: deviceId }).then(syncRefresh);
    },
    [syncRefresh],
  );
  const onSyncNow = useCallback(() => {
    void window.auqw.sync.trigger().then(syncRefresh);
  }, [syncRefresh]);
  const onExportDelta = useCallback(() => {
    void (async () => {
      // Large logs page over the wire — `more` means follow up with a
      // cursor covering what the page shipped (exported seqs plus the
      // exporter's known-absent claims). Every page is itself a valid
      // SyncDelta, so the clipboard carries one doc or, past the
      // envelope caps, an array of docs the importer applies in order.
      const docs: SyncDelta[] = [];
      const covered: Record<string, number> = {};
      for (;;) {
        const page = await window.auqw.sync.deltas({
          since: JSON.stringify(covered),
        });
        if (!isSyncDelta(page.delta)) {
          return; // a malformed page ships nothing honest
        }
        const doc = page.delta;
        docs.push(doc);
        let advanced = false;
        for (const entry of doc.entries) {
          if (typeof entry.seq !== 'number' || entry.seq < 0) {
            return;
          }
          if (entry.seq > (covered[entry.deviceId] ?? -1)) {
            covered[entry.deviceId] = entry.seq;
            advanced = true;
          }
        }
        for (const [dev, seqs] of Object.entries(doc.skipped)) {
          for (const seq of seqs) {
            if (seq > (covered[dev] ?? -1)) {
              covered[dev] = seq;
              advanced = true;
            }
          }
        }
        // `more` with no new coverage would re-ask the same window —
        // ship what the pages gave rather than spin.
        if (!doc.more || !advanced) {
          break;
        }
      }
      await navigator.clipboard.writeText(
        JSON.stringify(docs.length === 1 ? docs[0] : docs),
      );
    })().catch(() => undefined);
  }, []);
  const onImportDelta = useCallback(() => {
    void navigator.clipboard
      .readText()
      .then(async (text) => {
        const parsed: unknown = JSON.parse(text);
        // Multi-page exports land as an array — apply each doc in
        // order; a single-doc payload applies as before. Validate the
        // whole batch first: a malformed element must not strand a
        // partially imported array.
        const docs: readonly unknown[] = Array.isArray(parsed)
          ? parsed
          : [parsed];
        if (
          !docs.every((d) => isSyncDelta(d) && isSyncDeltaDoc(d))
        ) {
          return;
        }
        for (const delta of docs) {
          await window.auqw.sync.importDelta({ delta });
        }
      })
      .then(syncRefresh)
      .catch(() => {
        // A non-JSON or invalid clipboard payload lands nowhere — the
        // panel just re-reads status.
      });
  }, [syncRefresh]);

  const playRecording = useCallback(
    async (recordingId: string) => {
      if (!canPlay(recordingId)) {
        return;
      }
      const enqueued = await session.enqueueRecording(recordingId);
      if (enqueued.ok) {
        await session.playOccurrence(enqueued.value);
      }
    },
    [session, canPlay],
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
      void session.playOccurrence(occurrenceId);
    },
    [session, state.queue, canPlay],
  );

  // Mirrors QueueEngine.next()/previous() targeting: next → index+1
  // (never wraps); previous → restart current when positionMs>3s or
  // at index 0, else index−1. The gate sees the same target the
  // engine would land on — an owned target still advances offline.
  const advance = useCallback(
    (method: 'next' | 'previous') => {
      const { occurrences, currentOccurrenceId, positionMs } =
        state.queue;
      const index = occurrences.findIndex(
        (o) => o.occurrenceId === currentOccurrenceId,
      );
      if (index < 0) {
        return;
      }
      const target =
        occurrences[
          method === 'next'
            ? index + 1
            : positionMs > 3_000 || index === 0
              ? index
              : index - 1
        ];
      if (target === undefined || !canPlay(target.recordingId)) {
        return;
      }
      void (method === 'next' ? session.next() : session.previous());
    },
    [session, state.queue, canPlay],
  );

  // Offline honesty for metadata paths (cached search/entity rows):
  // the materialized recording plays only when a stream can resolve —
  // the exception is a meta already file-backed by the 'local'
  // provider.
  const canPlayMeta = useCallback(
    (meta: TrackMetadata): boolean =>
      online !== false || meta.sourceRef.provider === LOCAL_PROVIDER,
    [online],
  );

  const onResultPress = useCallback(
    (row: TrackRowModel) => {
      const meta = resultMeta.current.get(row.key);
      if (meta !== undefined && canPlayMeta(meta)) {
        recordRecentSearch(query);
        void session.addAndPlay(meta);
      }
    },
    [session, canPlayMeta, query, recordRecentSearch],
  );

  const onSettingsSelect = useCallback(
    (key: string) => {
      if (key === 'theme') {
        setThemePickerOpen(true);
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
        setTransfer(IDLE_TRANSFER);
        pushOverlay({ type: 'transfer' });
        return;
      }
      // storefront, quality rows are display-only.
    },
    [],
  );

  const onSettingsToggle = useCallback(
    (key: string) => {
      if (key === 'prefetch') {
        void session.updateSettings({
          ...state.settings,
          prefetch: !state.settings.prefetch,
        });
      }
    },
    [session, state.settings],
  );

  const playback = state.playback;
  const playing = playback.type === 'playing';
  const currentRecordingId =
    playback.type === 'idle' ? null : playback.recordingId;
  const onPlayPause = useCallback(() => {
    // Pause is always allowed; resuming a remote track while offline
    // would start a prepare that cannot finish.
    if (
      !playing &&
      currentRecordingId !== null &&
      !canPlay(currentRecordingId)
    ) {
      return;
    }
    void (playing ? session.pause() : session.resume());
  }, [session, playing, currentRecordingId, canPlay]);
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
    if (
      stageCollapsed ||
      stageMode !== 'lyrics' ||
      currentRecordingId === null
    ) {
      return;
    }
    if (lyricsFetch?.recordingId === currentRecordingId) {
      return;
    }
    fetchLyrics(currentRecordingId);
  }, [
    stageCollapsed,
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
  }, [lyricsFetch, currentRecordingId, player]);

  const onRetryLyrics = useCallback(() => {
    if (currentRecordingId !== null) {
      fetchLyrics(currentRecordingId);
    }
  }, [fetchLyrics, currentRecordingId]);

  // ---- radio (session.radio tail — start from the playing ref) ---

  const radioModel = useMemo(() => toRadioModel(state.radio), [state.radio]);
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
  }, [state, currentRecordingId]);

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
        .then((r) => reportResult('start radio', r));
    }
  }, [session, radioSeedRef, radioSeedable]);

  const onStopRadio = useCallback(() => {
    reportResult('stop radio', session.stopRadio());
  }, [session]);

  // ---- corrections (live read + serialized review ops) -----------

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
    [reviewFetch, state.recordings, reviewFilter],
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
        setTransfer((prev) => ({
          ...prev,
          exportPhase: 'done',
          exportDetail: `saved ${name} to downloads`,
        }));
      } catch (thrown) {
        setTransfer((prev) => ({
          ...prev,
          exportPhase: 'error',
          exportDetail:
            thrown instanceof Error ? thrown.message : 'export write failed',
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
            setTransfer((prev) => ({
              ...prev,
              importPhase: 'error',
              importDetail: preview.error.message,
              preview: null,
            }));
            return;
          }
          importText.current = text;
          setTransfer((prev) => ({
            ...prev,
            importPhase: 'preview',
            preview: toImportPreviewModel(preview.value, file.name),
          }));
        },
        (thrown) => {
          setTransfer((prev) => ({
            ...prev,
            importPhase: 'error',
            importDetail:
              thrown instanceof Error
                ? thrown.message
                : 'could not read the picked file',
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
        setTransfer((prev) => ({
          ...prev,
          importPhase: 'done',
          importDetail: `imported ${counts.recordings} tracks · ${counts.likes} likes · ${counts.playlists} playlists`,
        }));
      });
  }, [controller]);

  const onResetImport = useCallback(() => {
    importText.current = null;
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
      title: SLOT_LABELS[providerSlot],
      options: OPTIONAL_SLOTS.has(providerSlot)
        ? [
            {
              key: 'auto',
              label: 'auto',
              detail: 'route by declared capability',
            },
            ...options,
          ]
        : options,
      selectedKey: selected ?? 'auto',
    };
  }, [providerSlot, controller, state.settings]);

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

  // ---- library world: overlay routes + entity fetch --------------

  const pushOverlay = useCallback((next: Overlay) => {
    overlayCounter.current += 1;
    setOverlayStack((stack) => [
      ...stack,
      { key: `ov-${overlayCounter.current}`, overlay: next },
    ]);
  }, []);

  /** Pop the top route — every screen's own back affordance. */
  const closeOverlay = useCallback(() => {
    setOverlayStack((stack) => stack.slice(0, -1));
  }, []);

  /** Sheet/stack dismissal removes a screen and all above it. */
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
      void session.playRecordings(
        playable.map((row) => ({
          recordingId: row.recordingId,
          selectedRef: null,
        })),
      );
    },
    [session, canPlay],
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
      void session.playRecordings(
        playable.map((entry) => ({
          recordingId: entry.recordingId,
          selectedRef: entry.selectedRef,
        })),
      );
    },
    [session, canPlay],
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
                  reportResult('prepare track', r);
                }
                return r.ok ? r.value : null;
              });
      if (recordingId === null) {
        return;
      }
      reportResult(
        'add to playlist',
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
          reportResult('create playlist', created);
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
              .then((r) => reportResult('toggle like', r));
          }
          break;
        case 'enqueue':
          void (target.kind === 'recording'
            ? session.enqueueRecording(target.recordingId)
            : session.enqueueMetadata(target.meta)
          ).then((r) => reportResult('add to queue', r));
          break;
        case 'add':
          setPickerFor(target);
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
              .then((r) => reportResult('start radio', r));
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
    [actionsFor, session, openEntity, state.recordings, radioSeedable],
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
          reportResult('create playlist', created);
          return;
        }
        pushOverlay({ type: 'playlist', playlistId: created.value });
      });
    },
    [session, pushOverlay],
  );

  const onCancelSearch = useCallback(() => {
    setQuery('');
    search?.cancel();
  }, [search]);

  const onVolumeChange = useCallback(
    (value: number) => {
      const audio = controller.audio;
      if (audio === null) {
        return;
      }
      audio.volume = Math.min(1, Math.max(0, value));
      setVolume(audio.volume);
    },
    [controller],
  );

  const onMenuAction = useCallback(
    (key: string) => {
      setMenuOpen(false);
      switch (key) {
        case 'settings':
          setTab('settings');
          clearOverlays();
          break;
        case 'theme':
          setThemePickerOpen(true);
          break;
        case 'queue':
          setStageCollapsed(false);
          setStageMode('queue');
          break;
        case 'corrections':
          pushOverlay({ type: 'corrections' });
          break;
        case 'transfer':
          pushOverlay({ type: 'transfer' });
          break;
        default:
          break;
      }
    },
    [pushOverlay, clearOverlays],
  );

  // The toolbar search and the explore tab share one body: while the
  // field is open (from '/' / Ctrl-K / the icon) the world shows
  // results regardless of the active tab — the GTK pattern.
  const showSearch = searchOpen || tab === 'explore';

  const renderTabScreen = (key: string) => {
    switch (key) {
      case 'explore':
        return (
          <SearchScreen
            state={searchModel}
            query={query}
            hideField
            onQueryChange={setQuery}
            onSubmit={() => {
              recordRecentSearch(query);
              runSearch(query);
            }}
            onCancel={onCancelSearch}
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
              setSearchOpen(true);
            }}
          />
        );
      case 'library':
        return (
          <LibraryScreen
            model={libraryModel}
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
            onSelectRow={onSettingsSelect}
            onToggleRow={onSettingsToggle}
            onOpenCorrections={() =>
              pushOverlay({ type: 'corrections' })
            }
            sync={syncModel}
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
                  recordRecentSearch(query);
                  void session.addAndPlay(meta);
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

  const renderOverlayEntry = (entry: OverlayEntry) => {
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
                .then((r) => reportResult('rename playlist', r))
            }
            onDelete={() => {
              void session
                .deletePlaylist(current.playlistId)
                .then((r) => reportResult('delete playlist', r));
              dismissOverlay(entry.key);
            }}
            onPressEntry={(entry) => {
              if (!canPlay(entry.recordingId)) {
                return;
              }
              void session.playRecordings([
                {
                  recordingId: entry.recordingId,
                  selectedRef: entry.selectedRef,
                },
              ]);
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
                .then((r) => reportResult('remove track', r))
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
                .then((r) => reportResult('reorder playlist', r));
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
              void session.playMetadata(metas);
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
              void session.playMetadata(metas, { shuffle: true });
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
                void session.addAndPlay(meta);
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
          <div className="uw-shell">
            {!stageCollapsed && (
              <StageColumn
                player={player}
                mode={stageMode}
                onModeChange={setStageMode}
                queue={queueModel}
                queueReordering={reordering}
                lyrics={lyricsModel}
                radio={radioModel}
                download={
                  queueModel.items.find((item) => item.current)?.row
                    .download ?? null
                }
                onPlayPause={onPlayPause}
                onNext={() => advance('next')}
                onPrevious={() => advance('previous')}
                onToggleLike={onToggleLike}
                onSeek={(ms) => void session.seekTo(ms)}
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
                onAddToPlaylist={
                  currentRecordingId === null
                    ? undefined
                    : () =>
                        setPickerFor({
                          kind: 'recording',
                          recordingId: currentRecordingId,
                        })
                }
                onCollapse={() => setStageCollapsed(true)}
                volume={volume}
                onVolumeChange={
                  controller.audio === null ? undefined : onVolumeChange
                }
              />
            )}
            <WorldChrome
              items={NAV_ITEMS}
              activeKey={tab}
              onSelect={(key) => {
                setTab(key);
                clearOverlays();
                if (key === 'explore') {
                  setSearchOpen(true);
                }
              }}
              search={{
                open: searchOpen,
                query,
                loading: searchModel.phase === 'loading',
                onOpenChange: setSearchOpen,
                onQueryChange: setQuery,
                onSubmit: () => {
                  recordRecentSearch(query);
                  runSearch(query);
                },
                onCancel: onCancelSearch,
              }}
              focusSignal={searchFocusTick}
              onMenu={() => setMenuOpen(true)}
              stageCollapsed={stageCollapsed}
              onRestoreStage={() => setStageCollapsed(false)}
              onFocusSearch={() => {
                setSearchOpen(true);
                setSearchFocusTick((n) => n + 1);
              }}
              miniPlayer={
                player !== null && stageCollapsed ? (
                  <MiniPlayer
                    player={player}
                    onPress={() => setStageCollapsed(false)}
                    onPlayPause={onPlayPause}
                    onNext={() => advance('next')}
                    onPrevious={() => advance('previous')}
                    onToggleLike={onToggleLike}
                    onDismiss={() => void session.stop()}
                  />
                ) : undefined
              }
            >
              {showSearch
                ? renderTabScreen('explore')
                : renderTabScreen(tab)}
            </WorldChrome>
          </div>
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
                offline — streams wait for connectivity
              </Text>
            </div>
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
                    )?.title ?? 'track')
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
                          ? 'unlike'
                          : 'like',
                        icon: 'heart' as const,
                      },
                    ]
                  : []),
                {
                  key: 'enqueue',
                  label: 'add to queue',
                  icon: 'queue' as const,
                },
                {
                  key: 'add',
                  label: 'add to playlist',
                  icon: 'list-plus' as const,
                },
                // Only offer the seed affordance when the seed's own
                // provider declares radio.seed — routing is ref-scoped,
                // so another provider's support is a dead end.
                ...(radioSeedable(actionRadioRef)
                  ? [
                      {
                        key: 'radio',
                        label: 'start radio',
                        icon: 'radio' as const,
                      },
                    ]
                  : []),
                ...(actionsFor.kind === 'metadata' &&
                actionsFor.meta.albumRef != null
                  ? [
                      {
                        key: 'album',
                        label: 'open album',
                        icon: 'note' as const,
                      },
                    ]
                  : []),
                ...(actionsFor.kind === 'metadata' &&
                actionsFor.meta.artistRef != null
                  ? [
                      {
                        key: 'artist',
                        label: 'open artist',
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
        {pairing !== null && syncModel.pairing !== null && (
          <SheetScreen
            stackKey="sheet-pairing"
            onDismissed={() => setPairing(null)}
          >
            <PairingSheet
              pairing={syncModel.pairing}
              onCopyPayload={() => {
                void navigator.clipboard.writeText(pairing.payload);
              }}
              onDismiss={() => setPairing(null)}
            />
          </SheetScreen>
        )}
        {themePickerOpen && (
          <SheetScreen
            stackKey="sheet-theme"
            onDismissed={() => setThemePickerOpen(false)}
          >
            <ProviderPickerSheet
              title="theme"
              options={THEME_OPTIONS}
              selectedKey={state.settings.theme}
              onPick={(key) => {
                const theme =
                  THEME_ORDER.find((t) => t === key) ?? 'system';
                void session.updateSettings({ ...state.settings, theme });
                setThemePickerOpen(false);
              }}
              onDismiss={() => setThemePickerOpen(false)}
            />
          </SheetScreen>
        )}
        {menuOpen && (
          <SheetScreen
            stackKey="sheet-menu"
            onDismissed={() => setMenuOpen(false)}
          >
            <RowActionsSheet
              title="menu"
              actions={[
                { key: 'settings', label: 'settings', icon: 'settings' },
                { key: 'theme', label: 'theme', icon: 'monitor' },
                { key: 'queue', label: 'queue', icon: 'queue' },
                {
                  key: 'corrections',
                  label: 'match reviews',
                  icon: 'check',
                },
                {
                  key: 'transfer',
                  label: 'import / export',
                  icon: 'download',
                },
              ]}
              onAction={onMenuAction}
              onDismiss={() => setMenuOpen(false)}
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
