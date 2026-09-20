import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { File, Paths } from 'expo-file-system';
import {
  useFonts,
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';
import * as AuqwExpo from 'auqw-expo';
import {
  CancellationSource,
  SearchSession,
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
  SearchState,
  SessionState,
  SourceRef,
  TrackMetadata,
} from '@auqw/application';
import {
  AddToPlaylistSheet,
  AppNavbar,
  CollectionScreen,
  CorrectionsScreen,
  EmptyState,
  EntityScreen,
  ErrorState,
  GalleryScreen,
  HomeScreen,
  LibraryScreen,
  LoadingState,
  MiniPlayer,
  PlaylistScreen,
  ProviderPickerSheet,
  RowActionsSheet,
  SearchScreen,
  SettingsScreen,
  StageSheet,
  ThemeProvider,
  TransferScreen,
  entityIdForRef,
  formatClock,
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
  useTheme,
} from '@auqw/ui-native';
import type {
  CollectionRowModel,
  CorrectionsFilter,
  DiagnosticsModel,
  LyricsModel,
  NavItemModel,
  SearchStateModel,
  StageMode,
  TrackRowModel,
  TransferModel,
} from '@auqw/ui-native';
import { createSessionController } from './src/session/controller.ts';
import type { SessionController } from './src/session/controller.ts';
import { createAuqwExpoPlayer } from './src/adapters/auqw-expo-player.ts';
import { createClock, createIds } from './src/adapters/runtime.ts';
import { devRoute } from './src/dev-routes.ts';
import { runSeamLink } from './seam-dev.ts';

// PO-token service (bgutil /get_pot contract). Off unless configured —
// set EXPO_PUBLIC_POT_PROVIDER_URL at bundle time (from the Android
// emulator, http://10.0.2.2:4416 reaches a provider on the host
// machine). Unset: resolves stay on the anonymous ladder.
const POT_PROVIDER_URL = process.env.EXPO_PUBLIC_POT_PROVIDER_URL || undefined;

const SEARCH_LIMIT = 25;
const DIAGNOSTICS_LIMIT = 20;

const NAV_ITEMS: readonly NavItemModel[] = [
  { key: 'home', label: 'home' },
  { key: 'explore', label: 'explore' },
  { key: 'library', label: 'library' },
  { key: 'settings', label: 'settings' },
];

const THEME_ORDER = ['system', 'dark', 'light', 'oled'] as const;

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
    setBoot({ type: 'loading' });
    void (async () => {
      try {
        const created = await createSessionController(AuqwExpo, {
          potProviderUrl: POT_PROVIDER_URL,
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
          await created.dispose();
          return;
        }
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
          title="couldn't start"
          hint={boot.message}
          onRetry={onRetry}
        />
      ) : (
        <LoadingState
          title={fontsLoaded ? 'loading plugins' : 'loading'}
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
  const theme = state.type === 'ready' ? state.settings.theme : 'system';
  return (
    <ThemeProvider theme={theme}>
      {state.type === 'ready' ? (
        <Main controller={controller} state={state} />
      ) : (
        <SessionGate state={state} controller={controller} />
      )}
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
          title="couldn't restore your library"
          hint={state.error.message}
          onRetry={() => void controller.session.restore()}
        />
      ) : (
        <LoadingState title="restoring" />
      )}
    </View>
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
  | { readonly type: 'collection'; readonly key: 'liked' | 'top50' | 'history' }
  | { readonly type: 'playlist'; readonly playlistId: string }
  | { readonly type: 'entity'; readonly ref: EntityRef }
  | { readonly type: 'corrections' }
  | { readonly type: 'transfer' };

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
  const [attempts, setAttempts] = useState<readonly AttemptTrace[]>([]);
  const resultMeta = useRef(new Map<string, TrackMetadata>());
  // Library-world overlay stack: one route deep — collection list,
  // playlist editor, or provider entity page above the tab screen.
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [entityFetch, setEntityFetch] = useState<EntityFetch | null>(null);
  const entityMeta = useRef(new Map<string, TrackMetadata>());
  const [actionsFor, setActionsFor] = useState<ActionTarget | null>(null);
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
  const [providerSlot, setProviderSlot] = useState<ProviderSlot | null>(null);

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
      }),
    [state],
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
    });
    const playingId =
      state.playback.type === 'idle' ? null : state.playback.recordingId;
    if (playingId === null) {
      return model;
    }
    const mark = (row: CollectionRowModel): CollectionRowModel =>
      row.recordingId === playingId
        ? { ...row, row: { ...row.row, playing: true } }
        : row;
    return {
      ...model,
      items: model.items.map((row) =>
        row.key === playingId ? { ...row, playing: true } : row,
      ),
      recentlyAdded: model.recentlyAdded.map((row) =>
        row.key === playingId ? { ...row, playing: true } : row,
      ),
      collectionRows: {
        liked: model.collectionRows.liked.map(mark),
        top50: model.collectionRows.top50.map(mark),
        history: model.collectionRows.history.map(mark),
      },
    };
  }, [state]);
  const collectionModel = useMemo(
    () =>
      overlay?.type === 'collection'
        ? toCollectionModel(libraryModel, overlay.key)
        : null,
    [libraryModel, overlay],
  );
  const playlistModel = useMemo(() => {
    if (overlay?.type !== 'playlist') {
      return null;
    }
    const model = toPlaylistModel({
      playlistId: overlay.playlistId,
      playlists: state.playlists,
      playlistEntries: state.playlistEntries,
      recordings: state.recordings,
      likes: state.likes,
    });
    const playingId =
      state.playback.type === 'idle' ? null : state.playback.recordingId;
    if (model === null || playingId === null) {
      return model;
    }
    return {
      ...model,
      entries: model.entries.map((entry) =>
        entry.recordingId === playingId
          ? { ...entry, row: { ...entry.row, playing: true } }
          : entry,
      ),
    };
  }, [overlay, state]);
  const entityModel = useMemo(
    () =>
      toEntityModel({
        page: entityFetch?.page ?? null,
        error: entityFetch?.error ?? null,
        likes: state.likes,
        entitySourceRefs: state.entitySourceRefs,
        loadingMore: entityFetch?.loadingMore ?? false,
      }),
    [entityFetch, state.likes, state.entitySourceRefs],
  );
  // Row-key → TrackMetadata map for entity items, same contract as
  // resultMeta for search results.
  useEffect(() => {
    const map = entityMeta.current;
    map.clear();
    entityFetch?.page?.items.forEach((meta, index) => {
      map.set(toSearchRowModel(meta, index).key, meta);
    });
  }, [entityFetch?.page]);
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
  const homeModel = useMemo(() => {
    return toHomeModel({
      recordings: state.recordings,
      likes: state.likes,
      suggestions:
        searchState.type === 'content' ? searchState.page.items : [],

      greeting: greeting(new Date()),
      subline:
        state.likes.length === 0
          ? 'search to start your library'
          : `${state.likes.length} liked`,
    });
  }, [state, searchState]);
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
    () => toSettingsModel(state.settings, diagnostics),
    [state, diagnostics],
  );

  const playRecording = useCallback(
    async (recordingId: string) => {
      const enqueued = await session.enqueueRecording(recordingId);
      if (enqueued.ok) {
        await session.playOccurrence(enqueued.value);
      }
    },
    [session],
  );

  const onResultPress = useCallback(
    (row: TrackRowModel) => {
      const meta = resultMeta.current.get(row.key);
      if (meta !== undefined) {
        void session.addAndPlay(meta);
      }
    },
    [session],
  );

  const onSettingsSelect = useCallback(
    (key: string) => {
      if (key === 'theme') {
        const i = THEME_ORDER.indexOf(state.settings.theme);
        const theme = THEME_ORDER[(i + 1) % THEME_ORDER.length] ?? 'system';
        void session.updateSettings({ ...state.settings, theme });
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
        setOverlay({ type: 'transfer' });
        return;
      }
      // storefront and quality rows are display-only.
    },
    [session, state.settings],
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
    void (playing ? session.pause() : session.resume());
  }, [session, playing]);
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
  }, [lyricsFetch, currentRecordingId, player]);

  const onRetryLyrics = useCallback(() => {
    if (currentRecordingId !== null) {
      fetchLyrics(currentRecordingId);
    }
  }, [fetchLyrics, currentRecordingId]);

  // ---- radio (session.radio tail — start from the playing ref) ---

  const radioModel = useMemo(() => toRadioModel(state.radio), [state.radio]);
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
      void session.startRadio(ref);
    }
  }, [session, state, currentRecordingId]);

  const onStopRadio = useCallback(() => {
    session.stopRadio();
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
            thrown instanceof Error ? thrown.message : 'export write failed',
        }));
      }
    });
  }, [session]);

  const onPickImportFile = useCallback(() => {
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
          preview: toImportPreviewModel(
            preview.value,
            file.uri.split('/').pop() ?? file.uri,
          ),
        }));
      } catch (thrown) {
        setTransfer((prev) => ({
          ...prev,
          importPhase: 'error',
          importDetail:
            thrown instanceof Error
              ? thrown.message
              : 'could not read the picked file',
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
    // session.importLibrary revalidates and commits atomically; the
    // returned preview doubles as the applied-summary counts.
    void session.importLibrary(text).then((result) => {
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
  }, [session]);

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

  const closeOverlay = useCallback(() => {
    setOverlay(null);
    setEntityFetch(null);
  }, []);

  const openEntity = useCallback(
    (ref: EntityRef) => {
      setOverlay({ type: 'entity', ref });
      setEntityFetch({
        ref,
        page: null,
        error: null,
        loading: true,
        loadingMore: false,
      });
      void session.getEntityPage(ref).then((result) => {
        setEntityFetch((prev) =>
          prev === null || prev.ref !== ref
            ? prev
            : result.ok
              ? { ...prev, page: result.value, error: null, loading: false }
              : { ...prev, page: null, error: result.error, loading: false },
        );
      });
    },
    [session],
  );

  const onLoadMore = useCallback(() => {
    const cur = entityFetch;
    const continuation = cur?.page?.continuation;
    if (
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
    setEntityFetch({ ...cur, loadingMore: true });
    void session.getEntityPage(more).then((result) => {
      setEntityFetch((latest) => {
        if (latest === null || latest.ref !== cur.ref || latest.page === null) {
          return latest;
        }
        if (!result.ok) {
          return { ...latest, error: result.error, loadingMore: false };
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
          ...latest,
          page: {
            ...result.value,
            items: [...latest.page.items, ...fresh],
          },
          error: null,
          loadingMore: false,
        };
      });
    });
  }, [session, entityFetch]);

  const playCollectionRows = useCallback(
    (rows: readonly { recordingId: string }[]) => {
      void session.playRecordings(
        rows.map((row) => ({
          recordingId: row.recordingId,
          selectedRef: null,
        })),
      );
    },
    [session],
  );

  const playPlaylist = useCallback(() => {
    if (playlistModel === null) {
      return;
    }
    void session.playRecordings(
      playlistModel.entries.map((entry) => ({
        recordingId: entry.recordingId,
        selectedRef: entry.selectedRef,
      })),
    );
  }, [session, playlistModel]);

  const addToPlaylist = useCallback(
    async (playlistId: string, target: ActionTarget) => {
      const recordingId =
        target.kind === 'recording'
          ? target.recordingId
          : await session
            .ensureRecording(target.meta)
            .then((r) => (r.ok ? r.value : null));
      if (recordingId === null) {
        return;
      }
      await session.addPlaylistEntry(
        playlistId,
        recordingId,
        target.kind === 'metadata' ? target.meta.sourceRef : null,
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
        if (created.ok && target !== null) {
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
        case 'enqueue':
          void (target.kind === 'recording'
            ? session.enqueueRecording(target.recordingId)
            : session.enqueueMetadata(target.meta));
          break;
        case 'add':
          setPickerFor(target);
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
            void session.startRadio(ref);
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
    [actionsFor, session, openEntity, state.recordings],
  );

  const onOpenCard = useCallback(
    (card: { playlistId: string | null; entityRef: EntityRef | null }) => {
      if (card.playlistId !== null) {
        setOverlay({ type: 'playlist', playlistId: card.playlistId });
      } else if (card.entityRef !== null) {
        openEntity(card.entityRef);
      }
    },
    [openEntity],
  );

  const onCreatePlaylist = useCallback(
    (name: string) => {
      void session.createPlaylist(name).then((created) => {
        if (created.ok) {
          setOverlay({ type: 'playlist', playlistId: created.value });
        }
      });
    },
    [session],
  );

  // __DEV__-only gate instrumentation: `auqw://` links drive the real
  // session methods so emulator/simulator journeys are scriptable.
  // Verbs: open?tab=&playlist=&collection=, entity?provider=&kind=&id=,
  // search?q=, play-result?i=N, next, previous, pause, resume,
  // like-current, seek?ms=, lyrics, radio?provider=&id=, corrections,
  // transfer. Never ships in release bundles.
  const journeyDeps = useRef({ session, search, state });
  journeyDeps.current = { session, search, state };
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
      const { session: s, search: se, state: st } = journeyDeps.current;
      const body = url.slice('auqw://'.length);
      const [verb, qs] = body.split('?');
      const params = new URLSearchParams(qs ?? '');
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
            setOverlay({ type: 'playlist', playlistId });
          } else if (
            collection === 'liked' ||
            collection === 'top50' ||
            collection === 'history'
          ) {
            setOverlay({ type: 'collection', key: collection });
          } else {
            setOverlay(null);
            setEntityFetch(null);
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
            setOverlay({ type: 'entity', ref });
            setEntityFetch({
              ref,
              page: null,
              error: null,
              loading: true,
              loadingMore: false,
            });
            void s.getEntityPage(ref).then((result) => {
              setEntityFetch((prev) =>
                prev === null || prev.ref !== ref
                  ? prev
                  : result.ok
                    ? {
                      ...prev,
                      page: result.value,
                      error: null,
                      loading: false,
                    }
                    : {
                      ...prev,
                      page: null,
                      error: result.error,
                      loading: false,
                    },
              );
            });
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
            void s.addAndPlay(meta);
          }
          break;
        }
        case 'next':
          void s.next();
          break;
        case 'previous':
          void s.previous();
          break;
        case 'pause':
          void s.pause();
          break;
        case 'resume':
          void s.resume();
          break;
        case 'like-current':
          if (st.type === 'ready' && st.playback.type !== 'idle') {
            const id = st.playback.recordingId;
            if (id !== null) {
              void s.toggleLike(id);
            }
          }
          break;
        case 'seek': {
          const ms = Number(params.get('ms') ?? '0');
          if (Number.isSafeInteger(ms) && ms >= 0) {
            void s.seekTo(ms);
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
          void s.updateSettings(next);
          break;
        }
        case 'corrections':
          // auqw://corrections — the review queue rides the settings
          // tab's overlay stack like a pushed settings detail.
          setTab('settings');
          setOverlay({ type: 'corrections' });
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
            void s.confirmReview(confirmId, candidate);
          } else if (rejectId !== null) {
            void s.rejectReview(rejectId);
          } else if (undoId !== null) {
            void s.undoReview(undoId);
          }
          break;
        }
        case 'transfer': {
          // auqw://transfer — export/import surface, import state reset.
          // ?import=<path> reads the file directly (no picker) into the
          // preview stage; ?apply-import applies the staged document —
          // the two legs mirror the interactive preview→confirm flow.
          setTab('settings');
          setOverlay({ type: 'transfer' });
          const importPath = params.get('import');
          if (importPath !== null) {
            importText.current = null;
            setTransfer({ ...IDLE_TRANSFER, importPhase: 'reading' });
            void (async () => {
              try {
                const uri = importPath.startsWith('file://')
                  ? importPath
                  : `file://${importPath}`;
                const text = await new File(uri).text();
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
                  preview: toImportPreviewModel(
                    preview.value,
                    importPath.split('/').pop() ?? importPath,
                  ),
                }));
              } catch (thrown) {
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
            setTransfer(IDLE_TRANSFER);
            onExport();
          } else {
            importText.current = null;
            setTransfer(IDLE_TRANSFER);
          }
          break;
        }
        case 'stop-radio':
          void s.stopRadio();
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
        <GalleryScreen />
      </View>
    );
  }
  const screen = (() => {
    switch (tab) {
      case 'explore':
        return (
          <SearchScreen
            state={searchModel}
            query={query}
            topInset={topInset}
            onQueryChange={setQuery}
            onSubmit={() =>
              void search?.search({
                query,
                limit: SEARCH_LIMIT,
                storefront: state.settings.storefront,
              })
            }
            onCancel={() => {
              setQuery('');
              search?.cancel();
            }}
            onRetry={() =>
              void search?.search({
                query: searchModel.query,
                limit: SEARCH_LIMIT,
                storefront: state.settings.storefront,
              })
            }
            onResultPress={onResultPress}
            onContext={(row) => {
              const meta = resultMeta.current.get(row.key);
              if (meta !== undefined) {
                setActionsFor({ kind: 'metadata', meta });
              }
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
              setOverlay({ type: 'collection', key })
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
              setOverlay({ type: 'corrections' })
            }
          />
        );
      default:
        return (
          <HomeScreen
            model={homeModel}
            topInset={topInset}
            onPressCard={(card) => void playRecording(card.key)}
          />
        );
    }
  })();

  const overlayScreen = (() => {
    if (overlay === null) {
      return null;
    }
    switch (overlay.type) {
      case 'collection':
        return collectionModel === null ? null : (
          <CollectionScreen
            model={collectionModel}
            topInset={topInset}
            onBack={closeOverlay}
            onPlayAll={() => playCollectionRows(collectionModel.rows)}
            onPressItem={(row) => void playRecording(row.recordingId)}
            onToggleLike={(row) => void session.toggleLike(row.recordingId)}
            onContext={(row) =>
              setActionsFor({ kind: 'recording', recordingId: row.recordingId })
            }
          />
        );
      case 'playlist':
        return (
          <PlaylistScreen
            model={playlistModel}
            topInset={topInset}
            onBack={closeOverlay}
            onPlayAll={playPlaylist}
            onRename={(name) => {
              if (overlay.type === 'playlist') {
                void session.renamePlaylist(overlay.playlistId, name);
              }
            }}
            onDelete={() => {
              if (overlay.type === 'playlist') {
                void session.deletePlaylist(overlay.playlistId);
                closeOverlay();
              }
            }}
            onPressEntry={(entry) =>
              void session.playRecordings([
                {
                  recordingId: entry.recordingId,
                  selectedRef: entry.selectedRef,
                },
              ])
            }
            onToggleLike={(entry) => void session.toggleLike(entry.recordingId)}
            onContext={(entry) =>
              setActionsFor({
                kind: 'recording',
                recordingId: entry.recordingId,
              })
            }
            onRemoveEntry={(entry) =>
              void session.removePlaylistEntry(entry.entryId)
            }
            onMoveEntry={(entry, direction) => {
              if (playlistModel === null) {
                return;
              }
              const index = playlistModel.entries.findIndex(
                (e) => e.entryId === entry.entryId,
              );
              const sibling = playlistModel.entries[index + direction];
              if (sibling === undefined) {
                return;
              }
              void session.reorderPlaylistEntry(
                entry.entryId,
                direction === -1
                  ? { before: sibling.entryId }
                  : { after: sibling.entryId },
              );
            }}
          />
        );
      case 'entity': {
        const entityId = entityIdForRef(state.entitySourceRefs, overlay.ref);
        return (
          <EntityScreen
            model={entityModel}
            topInset={topInset}
            onBack={closeOverlay}
            onToggleLike={
              entityId === null
                ? undefined
                : () =>
                  void session.toggleEntityLike(overlay.ref.kind, entityId)
            }
            onPressItem={(row) => {
              const meta = entityMeta.current.get(row.key);
              if (meta !== undefined) {
                void session.addAndPlay(meta);
              }
            }}
            onContext={(row) => {
              const meta = entityMeta.current.get(row.key);
              if (meta !== undefined) {
                setActionsFor({ kind: 'metadata', meta });
              }
            }}
            onLoadMore={onLoadMore}
            onRetry={() => openEntity(overlay.ref)}
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
      default:
        return null;
    }
  })();

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
      <StatusBar style={theme.scheme === 'light' ? 'dark' : 'light'} />
      <View style={{ flex: 1 }}>{overlayScreen ?? screen}</View>
      {player !== null && !expanded ? (
        <MiniPlayer
          player={player}
          onPress={() => setExpanded(true)}
          onPlayPause={onPlayPause}
          onNext={() => void session.next()}
          onPrevious={() => void session.previous()}
          onToggleLike={onToggleLike}
        />
      ) : null}
      <AppNavbar
        items={NAV_ITEMS}
        activeKey={tab}
        onSelect={(key) => {
          setTab(key);
          closeOverlay();
        }}
        gestureHandle={Platform.OS === 'android'}
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
          onNext={() => void session.next()}
          onPrevious={() => void session.previous()}
          onToggleLike={onToggleLike}
          onSeek={(ms) => void session.seekTo(ms)}
          onRetryLyrics={onRetryLyrics}
          onStartRadio={radioCapable ? onStartRadio : undefined}
          onStopRadio={onStopRadio}
          onPressQueueItem={(id) => void session.playOccurrence(id)}
          onRemoveQueueItem={(id) => void session.removeOccurrence(id)}
          onToggleQueueReorder={() => setReordering((v) => !v)}
          onMoveQueueItem={onMoveQueueItem}
        />
      ) : null}
      {actionsFor !== null && (
        <RowActionsSheet
          title={
            actionsFor.kind === 'recording'
              ? (state.recordings.find(
                (r) => r.id === actionsFor.recordingId,
              )?.title ?? 'track')
              : actionsFor.meta.title
          }
          actions={[
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
            // Only offer the seed affordance when a bundled provider
            // declares radio.seed — an unsupported start is a dead end.
            ...(radioCapable
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
      )}
      {pickerFor !== null && (
        <AddToPlaylistSheet
          playlists={pickerItems}
          onPick={onPickPlaylist}
          onCreate={onCreateAndPick}
          onDismiss={() => setPickerFor(null)}
        />
      )}
      {providerPicker !== null && (
        <ProviderPickerSheet
          title={providerPicker.title}
          options={providerPicker.options}
          selectedKey={providerPicker.selectedKey}
          onPick={onPickProvider}
          onDismiss={() => setProviderSlot(null)}
        />
      )}
    </View>
  );
}
