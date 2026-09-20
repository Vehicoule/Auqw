import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  useFonts,
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';
import * as AuqwExpo from 'auqw-expo';
import { CancellationSource, SearchSession } from '@auqw/application';
import type {
  AppError,
  AttemptTrace,
  EntityPage,
  EntityRef,
  OperationContext,
  ReadySession,
  SearchState,
  SessionState,
  TrackMetadata,
} from '@auqw/application';
import {
  AddToPlaylistSheet,
  AppNavbar,
  CollectionScreen,
  EmptyState,
  EntityScreen,
  ErrorState,
  GalleryScreen,
  HomeScreen,
  LibraryScreen,
  LoadingState,
  MiniPlayer,
  PlaylistScreen,
  RowActionsSheet,
  SearchScreen,
  SettingsScreen,
  StageSheet,
  ThemeProvider,
  entityIdForRef,
  formatClock,
  toCollectionModel,
  toEntityModel,
  toLibraryModel,
  toHomeModel,
  toPlayerModel,
  toPlaylistModel,
  toQueueModel,
  toSearchRowModel,
  toSettingsModel,
  useTheme,
} from '@auqw/ui-native';
import type {
  CollectionRowModel,
  DiagnosticsModel,
  NavItemModel,
  SearchStateModel,
  StageMode,
  TrackRowModel,
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
  | { readonly type: 'entity'; readonly ref: EntityRef };

type EntityFetch = {
  readonly ref: EntityRef;
  readonly page: EntityPage | null;
  readonly error: AppError | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
};

type ActionTarget =
  | { readonly kind: 'recording'; readonly recordingId: string }
  | { readonly kind: 'metadata'; readonly meta: TrackMetadata };

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

  // Diagnostics: attempt traces are persisted by the session; load a
  // page whenever the settings tab becomes active.
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
    return () => source.cancel();
  }, [tab, controller]);

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
    }),
    [state, controller, attempts],
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
      }
      // catalog/playback provider, storefront, and quality rows are
      // display-only until a second provider exists.
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
    [actionsFor, session, openEntity],
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
  // like-current, seek?ms=. Never ships in release bundles.
  const journeyDeps = useRef({ session, search, state });
  journeyDeps.current = { session, search, state };
  useEffect(() => {
    if (!__DEV__) {
      return undefined;
    }
    const handle = (url: string | null): void => {
      console.log(`[journey] url=${url ?? 'null'}`);
      if (url === null || !url.startsWith('auqw://')) {
        return;
      }
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
          onPlayPause={onPlayPause}
          onNext={() => void session.next()}
          onPrevious={() => void session.previous()}
          onToggleLike={onToggleLike}
          onSeek={(ms) => void session.seekTo(ms)}
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
    </View>
  );
}
