import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, View } from 'react-native';
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
import * as PluginHostExpo from 'auqw-plugin-host-expo';
import { CancellationSource, SearchSession } from '@auqw/application';
import type {
  AppError,
  AttemptTrace,
  OperationContext,
  ReadySession,
  SearchState,
  SessionState,
  TrackMetadata,
} from '@auqw/application';
import {
  AppNavbar,
  EmptyState,
  ErrorState,
  HomeScreen,
  LibraryScreen,
  LoadingState,
  MiniPlayer,
  QueueScreen,
  SearchScreen,
  SettingsScreen,
  StageSheet,
  ThemeProvider,
  formatClock,
  toLibraryModel,
  toPlayerModel,
  toQueueModel,
  toRailCard,
  toSearchRowModel,
  toSettingsModel,
  useTheme,
} from '@auqw/ui-native';
import type {
  DiagnosticsModel,
  NavItemModel,
  SearchStateModel,
  StageMode,
  TrackRowModel,
} from '@auqw/ui-native';
import { createSessionController } from './src/session/controller.ts';
import type { SessionController } from './src/session/controller.ts';
import { createClock, createIds } from './src/adapters/runtime.ts';

// PO-token service (bgutil /get_pot contract). Off unless configured —
// set EXPO_PUBLIC_POT_PROVIDER_URL at bundle time (from the Android
// emulator, http://10.0.2.2:4416 reaches a provider on the host
// machine). Unset: resolves stay on the anonymous ladder.
const POT_PROVIDER_URL = process.env.EXPO_PUBLIC_POT_PROVIDER_URL || undefined;

const SEARCH_LIMIT = 25;
const DIAGNOSTICS_LIMIT = 20;

const NAV_ITEMS: readonly NavItemModel[] = [
  { key: 'home', label: 'home' },
  { key: 'search', label: 'search' },
  { key: 'library', label: 'library' },
  { key: 'queue', label: 'queue' },
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
        const created = await createSessionController(PluginHostExpo, {
          potProviderUrl: POT_PROVIDER_URL,
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
  const [stageMode, setStageMode] = useState<StageMode>('player');
  const [query, setQuery] = useState('');
  const [attempts, setAttempts] = useState<readonly AttemptTrace[]>([]);
  const resultMeta = useRef(new Map<string, TrackMetadata>());

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
    });
    const playingId =
      state.playback.type === 'idle' ? null : state.playback.recordingId;
    if (playingId === null) {
      return model;
    }
    return {
      ...model,
      items: model.items.map((row) =>
        row.key === playingId ? { ...row, playing: true } : row,
      ),
    };
  }, [state]);
  const searchModel = useMemo(() => toSearchModel(searchState), [searchState]);
  const homeModel = useMemo(() => {
    const byId = new Map(state.recordings.map((r) => [r.id, r]));
    const recents = [...state.likes]
      .sort((a, b) => b.likedAtMs - a.likedAtMs)
      .map((like) => byId.get(like.recordingId))
      .filter((r) => r !== undefined)
      .slice(0, 12)
      .map(toRailCard);
    return {
      greeting: greeting(new Date()),
      subline:
        state.likes.length === 0
          ? 'search to start your library'
          : `${state.likes.length} liked`,
      recents,
      suggestions: [],
    };
  }, [state]);
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

  // __DEV__-only gate instrumentation: `auqw://` links drive the real
  // session methods so emulator/simulator journeys are scriptable.
  // Verbs: search?q=, play-result?i=N, next, previous, pause, resume,
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
      const { session: s, search: se, state: st } = journeyDeps.current;
      const body = url.slice('auqw://'.length);
      const [verb, qs] = body.split('?');
      const params = new URLSearchParams(qs ?? '');
      switch (verb) {
        case 'open':
          setTab(params.get('tab') ?? 'home');
          break;
        case 'search':
          setTab('search');
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
  const screen = (() => {
    switch (tab) {
      case 'search':
        return (
          <SearchScreen
            state={searchModel}
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
          />
        );
      case 'library':
        return (
          <LibraryScreen
            model={libraryModel}
            topInset={topInset}
            onPressItem={(row) => void playRecording(row.key)}
            onToggleLike={(row) => void session.toggleLike(row.key)}
          />
        );
      case 'queue':
        return (
          <QueueScreen
            queue={queueModel}
            player={player}
            topInset={topInset}
            onPressItem={(id) => void session.playOccurrence(id)}
            onRemoveItem={(id) => void session.removeOccurrence(id)}
            onMoveItem={onMoveQueueItem}
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

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
      <StatusBar style={theme.scheme === 'light' ? 'dark' : 'light'} />
      <View style={{ flex: 1 }}>{screen}</View>
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
      <AppNavbar items={NAV_ITEMS} activeKey={tab} onSelect={setTab} />
      {player !== null ? (
        <StageSheet
          player={player}
          expanded={expanded}
          onExpandChange={setExpanded}
          mode={stageMode}
          onModeChange={setStageMode}
          queue={queueModel}
          topInset={topInset}
          onPlayPause={onPlayPause}
          onNext={() => void session.next()}
          onPrevious={() => void session.previous()}
          onToggleLike={onToggleLike}
          onSeek={(ms) => void session.seekTo(ms)}
          onPressQueueItem={(id) => void session.playOccurrence(id)}
          onRemoveQueueItem={(id) => void session.removeOccurrence(id)}
          onMoveQueueItem={onMoveQueueItem}
        />
      ) : null}
    </View>
  );
}
