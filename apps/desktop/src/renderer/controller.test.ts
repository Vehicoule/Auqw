import type {
  OperationContext,
  PersistedState,
  QueueSnapshot,
  Settings,
} from '@auqw/application';
import { appError, CancellationSource, err } from '@auqw/application';
import {
  assert,
  assertDeepEqual,
  assertEqual,
  FakePlayer,
  FakeStorage,
} from '@auqw/application/testing';
import type {
  AuqwApi,
  HostPluginsResult,
  HostRequestArgs,
  HostCancelArgs,
  NetEvent,
  PluginManifestPayload,
  RequestOutcomePayload,
} from '../shared/contract.ts';
import type { PluginProvider } from './provider.ts';
import { createSessionController } from './controller.ts';

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: null,
  qualityKbps: 128,
  theme: 'system',
  prefetch: true,
};

function emptyQueue(): QueueSnapshot {
  return {
    revision: 0,
    occurrences: [],
    currentOccurrenceId: null,
    positionMs: 0,
    mode: 'stopped',
  };
}

function persisted(partial: Partial<PersistedState> = {}): PersistedState {
  return {
    recordings: partial.recordings ?? [],
    likes: partial.likes ?? [],
    entities: partial.entities ?? [],
    entitySourceRefs: partial.entitySourceRefs ?? [],
    playlists: partial.playlists ?? [],
    playlistEntries: partial.playlistEntries ?? [],
    playHistory: partial.playHistory ?? [],
    playCounts: partial.playCounts ?? [],
    matchReviews: partial.matchReviews ?? [],
    lyricsCache: partial.lyricsCache ?? [],
    artworkCache: partial.artworkCache ?? [],
    downloads: partial.downloads ?? [],
    localSources: partial.localSources ?? [],
    localFiles: partial.localFiles ?? [],
    queue: partial.queue ?? emptyQueue(),
    settings: partial.settings ?? SETTINGS,
  };
}

function ctx(): OperationContext {
  const source = new CancellationSource();
  return {
    requestId: 't-1',
    deadlineMs: Number.MAX_SAFE_INTEGER,
    signal: source.signal,
  };
}

type Rig = {
  readonly api: AuqwApi;
  readonly hostCalls: HostRequestArgs[];
  readonly cancelled: string[];
  readonly netListeners: ((event: NetEvent) => void)[];
  netUnsubscribes: number;
  pluginsResult: HostPluginsResult;
  requestOutcome: RequestOutcomePayload;
  snapshotResult: { readonly online: boolean };
};

function fakeApi(): Rig {
  const rig: Rig = {
    hostCalls: [],
    cancelled: [],
    netListeners: [],
    netUnsubscribes: 0,
    pluginsResult: { bindings: 'loaded', plugins: [], manifests: [] },
    requestOutcome: {
      type: 'failed',
      kind: 'unavailable',
      message: 'unscripted',
      attempt: {
        requestId: 'x',
        steps: 0,
        httpCalls: 0,
        bytes: 0,
        fuelUsed: 0,
        elapsedMs: 0,
        httpTrace: [],
        guestLog: [],
      },
    },
    snapshotResult: { online: true },
    api: {
      app: {
        meta: () =>
          Promise.resolve({
            version: '0.0.0',
            platform: 'test',
            userDataPath: '/tmp/auqw-test',
          }),
      },
      dialog: {
        pickFolder: () => Promise.resolve(null),
        pickFiles: () => Promise.resolve([]),
      },
      net: {
        snapshot: () => Promise.resolve(rig.snapshotResult),
        subscribe: (listener) => {
          rig.netListeners.push(listener);
          return () => {
            rig.netUnsubscribes += 1;
          };
        },
      },
      secure: {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
      storage: {
        begin: () => Promise.reject(new Error('seam: inject storage')),
        commit: () => Promise.reject(new Error('seam: inject storage')),
        rollback: () => Promise.reject(new Error('seam: inject storage')),
        cancel: () => Promise.reject(new Error('seam: inject storage')),
        execute: () => Promise.reject(new Error('seam: inject storage')),
        query: () => Promise.reject(new Error('seam: inject storage')),
        backup: () => Promise.reject(new Error('seam: inject storage')),
        dropBackup: () => Promise.reject(new Error('seam: inject storage')),
      },
      sync: {
        status: () => Promise.reject(new Error('seam: inject sync')),
        pairing: () => Promise.reject(new Error('seam: inject sync')),
        devices: () => Promise.reject(new Error('seam: inject sync')),
        unpair: () => Promise.reject(new Error('seam: inject sync')),
        deltas: () => Promise.reject(new Error('seam: inject sync')),
        importDelta: () => Promise.reject(new Error('seam: inject sync')),
        trigger: () => Promise.reject(new Error('seam: inject sync')),
      },
      utility: {
        ping: () => Promise.reject(new Error('unused')),
      },
      host: {
        plugins: () => Promise.resolve(rig.pluginsResult),
        request: (args: HostRequestArgs) => {
          rig.hostCalls.push(args);
          return Promise.resolve(rig.requestOutcome);
        },
        cancelRequest: (args: HostCancelArgs) => {
          rig.cancelled.push(args.requestId);
          return Promise.resolve();
        },
      },
      stream: {
        prepare: () => Promise.reject(new Error('seam: inject player')),
        devPrepare: () => Promise.reject(new Error('seam: inject player')),
        serveUrl: () => Promise.reject(new Error('seam: inject player')),
        open: () => Promise.reject(new Error('seam: inject player')),
        read: () => Promise.reject(new Error('seam: inject player')),
        close: () => Promise.reject(new Error('seam: inject player')),
        release: () => Promise.reject(new Error('seam: inject player')),
        marks: () => Promise.reject(new Error('seam: inject player')),
        cancel: () => Promise.reject(new Error('seam: inject player')),
        channel: () => Promise.reject(new Error('seam: inject player')),
      },
    },
  };
  return rig;
}

/**
 * Minimal injected providers — the Session constructor requires the
 * defaults to name injected provider ids, so the two slots must exist.
 */
function stubProvider(
  id: string,
  capabilities: PluginProvider['capabilities'],
  disposed?: string[],
): PluginProvider {
  const unavailable = () =>
    Promise.resolve(err(appError('unavailable', 'stub provider')));
  return {
    id,
    capabilities,
    search: unavailable,
    candidates: unavailable,
    resolvePlayback: unavailable,
    getDetails: unavailable,
    getEntity: unavailable,
    artwork: unavailable,
    getLyrics: unavailable,
    radioSeed: unavailable,
    dispose() {
      disposed?.push(id);
    },
  };
}

function defaultProviders(disposed?: string[]): PluginProvider[] {
  return [
    stubProvider('itunes', ['catalog.search'], disposed),
    stubProvider('youtube-music', ['playback.resolve'], disposed),
  ];
}

const MANIFESTS: readonly PluginManifestPayload[] = [
  {
    pluginId: 'plugin-itunes',
    providerId: 'itunes',
    capabilities: ['catalog.search', 'catalog.metadata', 'bogus-cap'],
  },
  {
    pluginId: 'plugin-ytm',
    providerId: 'youtube-music',
    capabilities: ['playback.candidates', 'playback.resolve'],
  },
];

// 1. Loaded manifests become providers — capabilities filtered to the
// ABI set (a bogus manifest capability never reaches ProviderPort).
async function providersFromManifests(): Promise<void> {
  const rig = fakeApi();
  rig.pluginsResult = {
    bindings: 'loaded',
    plugins: ['plugin-itunes', 'plugin-ytm'],
    manifests: MANIFESTS,
  };
  const controller = await createSessionController(rig.api, {
    storage: new FakeStorage(persisted()),
    player: new FakePlayer(),
  });
  assertEqual(controller.providers.length, 2);
  assertEqual(controller.providers[0]?.id, 'itunes');
  assertDeepEqual(controller.providers[0]?.capabilities, [
    'catalog.search',
    'catalog.metadata',
  ]);
  assertEqual(controller.providers[1]?.id, 'youtube-music');

  // Ops ride the same host seam: pluginId routes to the manifest's
  // plugin, capability names the wire op, payloadJson is the ABI body.
  const result = await controller.providers[0]!.search(
    { query: 'roads', limit: 5, storefront: 'US' },
    ctx(),
  );
  assertEqual(rig.hostCalls.length, 1);
  assertEqual(rig.hostCalls[0]?.pluginId, 'plugin-itunes');
  assertEqual(rig.hostCalls[0]?.capability, 'catalog.search');
  assertDeepEqual(JSON.parse(rig.hostCalls[0]?.payloadJson ?? ''), {
    query: 'roads',
    limit: 5,
    storefront: 'US',
  });
  assert(!result.ok && result.error.kind === 'unavailable');
  await controller.dispose();
}

// 2. No providers — unavailable bindings or an empty plugin dir — is
// an honest boot failure: the Session cannot name a default provider.
async function unavailableBindings(): Promise<void> {
  const rig = fakeApi();
  rig.pluginsResult = {
    bindings: 'unavailable',
    bindingsError: 'bindings missing',
    plugins: [],
    manifests: [],
  };
  let thrown: unknown = null;
  try {
    await createSessionController(rig.api, {
      storage: new FakeStorage(persisted()),
      player: new FakePlayer(),
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error);
  assert(
    (thrown as Error).message.includes('no plugin providers'),
    'unavailable bindings fail the boot as no plugin providers',
  );

  rig.pluginsResult = { bindings: 'loaded', plugins: [], manifests: [] };
  thrown = null;
  try {
    await createSessionController(rig.api, {
      storage: new FakeStorage(persisted()),
      player: new FakePlayer(),
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error);
  assert(
    (thrown as Error).message.includes('no plugin providers'),
    'empty plugin dir fails the boot as no plugin providers',
  );
}

// 3. session.restore() drives the snapshot to a ready state over the
// injected storage seam, with the desktop defaults as the baseline.
async function restoreReady(): Promise<void> {
  const rig = fakeApi();
  const controller = await createSessionController(rig.api, {
    storage: new FakeStorage(persisted()),
    player: new FakePlayer(),
    providers: defaultProviders(),
  });
  const state = controller.session.snapshot();
  assertEqual(state.type, 'ready');
  if (state.type !== 'ready') {
    return;
  }
  assertDeepEqual(state.settings, SETTINGS);
  await controller.dispose();
}

// 4. A storage load failure surfaces as a typed restore-failed state,
// not a thrown boot.
async function restoreFailed(): Promise<void> {
  const rig = fakeApi();
  const storage = new FakeStorage(persisted());
  storage.holdNextLoad();
  const booting = createSessionController(rig.api, {
    storage,
    player: new FakePlayer(),
    providers: defaultProviders(),
  });
  storage.settleLoad(err(appError('internal', 'disk gone')));
  const controller = await booting;
  const state = controller.session.snapshot();
  assertEqual(state.type, 'restore-failed');
  if (state.type !== 'restore-failed') {
    return;
  }
  assertEqual(state.error.kind, 'internal');
  await controller.dispose();
}

// 5. Net edges drive isOnline + connectivityChanged; the snapshot
// seeds the baseline only when no edge has landed yet.
async function connectivity(): Promise<void> {
  const rig = fakeApi();
  rig.snapshotResult = { online: false };
  const controller = await createSessionController(rig.api, {
    storage: new FakeStorage(persisted()),
    player: new FakePlayer(),
    providers: defaultProviders(),
  });
  await Promise.resolve();
  assertEqual(rig.netListeners.length, 1);
  assertEqual(controller.isOnline(), false);
  rig.netListeners[0]?.({ online: true });
  assertEqual(controller.isOnline(), true);
  await controller.dispose();
  assertEqual(rig.netUnsubscribes, 1);
}

// 6. dispose unsubscribes net, disposes providers (ops settle
// unavailable), and lets the session wind down.
async function disposeSeam(): Promise<void> {
  const rig = fakeApi();
  const disposed: string[] = [];
  const controller = await createSessionController(rig.api, {
    storage: new FakeStorage(persisted()),
    player: new FakePlayer(),
    providers: defaultProviders(disposed),
  });
  await controller.dispose();
  assertDeepEqual(disposed, ['itunes', 'youtube-music']);
  assertEqual(rig.netUnsubscribes, 1);
}

// 7. A plugin set with no declarer for a required capability cannot
// serve a session — an arbitrary id would only route ops into
// unsupported. The boot throws before Session construction.
async function incompleteProviderSet(): Promise<void> {
  const rig = fakeApi();
  let thrown: unknown = null;
  try {
    await createSessionController(rig.api, {
      storage: new FakeStorage(persisted()),
      player: new FakePlayer(),
      providers: [stubProvider('lyrics-lib', ['lyrics.plain'])],
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error);
  assert(
    (thrown as Error).message.includes('catalog.search'),
    'missing catalog.search declarer fails the boot',
  );

  thrown = null;
  try {
    await createSessionController(rig.api, {
      storage: new FakeStorage(persisted()),
      player: new FakePlayer(),
      providers: [stubProvider('itunes', ['catalog.search'])],
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error);
  assert(
    (thrown as Error).message.includes('playback.resolve'),
    'missing playback.resolve declarer fails the boot',
  );
}

// 8. Restored settings naming providers this plugin dir no longer
// ships are reconciled and persisted: required slots repick a
// capability-valid id; optional overrides drop to auto routing rather
// than resurrecting a provider that cannot serve them.
async function restoreRepairsSettings(): Promise<void> {
  const rig = fakeApi();
  const storage = new FakeStorage(
    persisted({
      settings: {
        ...SETTINGS,
        playbackProvider: 'removed-playback',
        lyricsProvider: 'removed-lyrics',
        radioProvider: 'removed-radio',
      },
    }),
  );
  const controller = await createSessionController(rig.api, {
    storage,
    player: new FakePlayer(),
    providers: [
      stubProvider('itunes', ['catalog.search']),
      stubProvider('deezer', ['playback.resolve', 'lyrics.synced']),
    ],
  });
  const state = controller.session.snapshot();
  assertEqual(state.type, 'ready');
  if (state.type !== 'ready') {
    return;
  }
  assertEqual(state.settings.catalogProvider, 'itunes');
  assertEqual(state.settings.playbackProvider, 'deezer');
  assertEqual(state.settings.lyricsProvider, null);
  assertEqual(state.settings.radioProvider, null);
  const settled = storage.commits.find(
    (commit) => commit.batch.settings !== undefined,
  );
  assert(
    settled !== undefined,
    'the reconciliation is persisted through the storage seam',
  );
  assertEqual(settled.batch.settings?.playbackProvider, 'deezer');
  await controller.dispose();
}

// 9. subscribeOnline replays the settled baseline to a subscriber
// that mounts after the edge — the UI never waits for the next
// transition to learn it is offline.
async function onlineBaselineReplay(): Promise<void> {
  const rig = fakeApi();
  rig.snapshotResult = { online: false };
  const controller = await createSessionController(rig.api, {
    storage: new FakeStorage(persisted()),
    player: new FakePlayer(),
    providers: defaultProviders(),
  });
  await Promise.resolve();
  const seen: boolean[] = [];
  const unsubscribe = controller.subscribeOnline((online) => {
    seen.push(online);
  });
  assertDeepEqual(seen, [false]);
  unsubscribe();
  rig.netListeners[0]?.({ online: true });
  assertDeepEqual(seen, [false]);
  await controller.dispose();
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['providersFromManifests', providersFromManifests],
  ['unavailableBindings', unavailableBindings],
  ['restoreReady', restoreReady],
  ['restoreFailed', restoreFailed],
  ['connectivity', connectivity],
  ['disposeSeam', disposeSeam],
  ['incompleteProviderSet', incompleteProviderSet],
  ['restoreRepairsSettings', restoreRepairsSettings],
  ['onlineBaselineReplay', onlineBaselineReplay],
];

export async function run(): Promise<void> {
  for (const [name, fn] of TESTS) {
    try {
      await fn();
    } catch (thrown) {
      throw new Error(`controller test failed: ${name}`, { cause: thrown });
    }
  }
}
