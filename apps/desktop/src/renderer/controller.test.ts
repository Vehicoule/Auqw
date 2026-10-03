import type {
  DownloadRecord,
  LocalEntry,
  LocalFile,
  LocalSource,
  LocalTags,
  OperationContext,
  PersistedState,
  QueueSnapshot,
  Recording,
  Settings,
} from '@auqw/application';
import {
  appError,
  CancellationSource,
  err,
  localTrackRef,
  ok,
} from '@auqw/application';
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
  transferStat: { readonly exists: boolean; readonly bytes: number | null };
  transferSwept: number;
  transferRemoved: string[];
  tagreadEnumerated: string[];
  tagreadEntries: LocalEntry[] | null;
  tagreadFingerprints: Map<string, string> | null;
  tagreadTags: Map<string, LocalTags> | null;
  tagreadHoldEnumerate: boolean;
  tagreadEnumerateResolvers: (() => void)[];
  transferStats: {
    readonly bytes: number;
    readonly files: number;
    readonly partials: number;
    readonly freeBytes: number | null;
  };
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
    transferStat: { exists: true, bytes: null },
    transferSwept: 0,
    transferRemoved: [],
    tagreadEnumerated: [],
    tagreadEntries: null,
    tagreadFingerprints: null,
    tagreadTags: null,
    tagreadHoldEnumerate: false,
    tagreadEnumerateResolvers: [],
    transferStats: { bytes: 0, files: 0, partials: 0, freeBytes: null },
    api: {
      app: {
        meta: () =>
          Promise.resolve({
            version: '0.0.0',
            platform: 'test',
            // OS-shaped abs path — minted file: URIs are platform-
            // dependent (file:///… POSIX, file:///C:/… Windows).
            userDataPath:
              process.platform === 'win32' ? 'C:/tmp/auqw-test' : '/tmp/auqw-test',
          }),
      },
      chrome: {
        platform: 'linux',
        control: () => {},
        onState: () => () => {},
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
      theme: {
        subscribe: () => () => undefined,
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
        execMany: () => Promise.reject(new Error('seam: inject storage')),
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
        localChanges: () =>
          Promise.reject(new Error('seam: inject sync')),
        drainApplied: () =>
          Promise.reject(new Error('seam: inject sync')),
        ackApplied: () =>
          Promise.reject(new Error('seam: inject sync')),
        materialized: () =>
          Promise.reject(new Error('seam: inject sync')),
        onApplied: () => () => {},
        nearbyStart: () => Promise.reject(new Error('seam: inject sync')),
        nearbyStop: () => Promise.reject(new Error('seam: inject sync')),
        onNearby: () => () => {},
        dial: () => Promise.reject(new Error('seam: inject sync')),
        dialPayload: () =>
          Promise.reject(new Error('seam: inject sync')),
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
        probe: () => Promise.reject(new Error('seam: inject player')),
        close: () => Promise.reject(new Error('seam: inject player')),
        release: () => Promise.reject(new Error('seam: inject player')),
        marks: () => Promise.reject(new Error('seam: inject player')),
        cancel: () => Promise.reject(new Error('seam: inject player')),
        channel: () => Promise.reject(new Error('seam: inject player')),
      },
      transfer: {
        ensureDir: () => Promise.resolve(),
        begin: () => Promise.reject(new Error('seam: inject transfer')),
        write: () => Promise.reject(new Error('seam: inject transfer')),
        commit: () => Promise.reject(new Error('seam: inject transfer')),
        finalize: () => Promise.reject(new Error('seam: inject transfer')),
        abort: () => Promise.resolve(),
        stat: () => Promise.resolve(rig.transferStat),
        remove: (args: { readonly name: string }) => {
          rig.transferRemoved.push(args.name);
          return Promise.resolve();
        },
        sweepPartials: () =>
          Promise.resolve({ swept: rig.transferSwept }),
        sweepFinalized: () =>
          Promise.resolve({ swept: 0 }),
        list: () => Promise.resolve({ sinks: [], files: [] }),
        status: () => Promise.reject(new Error('seam: inject transfer')),
        stats: () => Promise.resolve(rig.transferStats),
        fetch: () => Promise.reject(new Error('seam: inject transfer')),
        fetchBody: () =>
          Promise.reject(new Error('seam: inject transfer')),
        fetchAbort: () => Promise.resolve(),
      },
      tagread: {
        enumerate: (args: { readonly treeUri: string }) => {
          rig.tagreadEnumerated.push(args.treeUri);
          if (rig.tagreadHoldEnumerate) {
            return new Promise((resolve) => {
              rig.tagreadEnumerateResolvers.push(() =>
                resolve({ entries: rig.tagreadEntries ?? [] }),
              );
            });
          }
          if (rig.tagreadEntries === null) {
            return Promise.resolve({ entries: [] });
          }
          return Promise.resolve({ entries: rig.tagreadEntries });
        },
        fingerprint: (args: { readonly docIds: readonly string[] }) => {
          if (rig.tagreadFingerprints === null) {
            return Promise.reject(new Error('seam: inject tagread'));
          }
          return Promise.resolve({
            fingerprints: args.docIds.map((docId) => {
              const fp = rig.tagreadFingerprints!.get(docId);
              return fp === undefined ? null : { docId, fingerprint: fp };
            }),
          });
        },
        read: (args: { readonly docIds: readonly string[] }) => {
          if (rig.tagreadTags === null) {
            return Promise.reject(new Error('seam: inject tagread'));
          }
          return Promise.resolve({
            tags: args.docIds.map(
              (docId) => rig.tagreadTags!.get(docId) ?? null,
            ),
          });
        },
      },
      local: {
        add: () => Promise.reject(new Error('seam: inject local')),
        probe: () => Promise.reject(new Error('seam: inject local')),
        resolve: () => Promise.reject(new Error('seam: inject local')),
        read: () => Promise.reject(new Error('seam: inject local')),
        list: () => Promise.reject(new Error('seam: inject local')),
        playback: () => Promise.reject(new Error('seam: inject local')),
        sweep: () => Promise.reject(new Error('seam: inject local')),
      },
      auth: {
        status: () =>
          Promise.resolve({
            status: { state: 'signed-out' },
            clientId: null,
            bearerLive: false,
          }),
        begin: () => Promise.resolve(),
        cancel: () => Promise.resolve(),
        signOut: () => Promise.resolve(),
        setClient: () => Promise.resolve(),
        retry: () => Promise.resolve(),
        openUrl: () => Promise.resolve(),
        onState: () => () => {},
      },
      update: {
        status: () =>
          Promise.resolve({
            status: { state: 'idle' },
            currentVersion: '0.1.0',
            apply: { state: 'idle' },
            capability: 'open' as const,
          }),
        check: () =>
          Promise.resolve({
            status: { state: 'idle' },
            currentVersion: '0.1.0',
            apply: { state: 'idle' },
            capability: 'open' as const,
          }),
        open: () => Promise.resolve(),
        apply: () => Promise.resolve(),
        reapply: () => Promise.resolve(),
        cancel: () => Promise.resolve(),
        restart: () => Promise.resolve(),
        onState: () => () => {},
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
    version: '0.0.0-stub',
    search: unavailable,
    candidates: unavailable,
    resolvePlayback: unavailable,
    getDetails: unavailable,
    getEntity: unavailable,
    artwork: unavailable,
    getLyrics: unavailable,
    radioSeed: unavailable,
    suggest: unavailable,
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
    version: '1.0.0',
    permissions: ['network:itunes.apple.com'],
  },
  {
    pluginId: 'plugin-ytm',
    providerId: 'youtube-music',
    capabilities: ['playback.candidates', 'playback.resolve'],
    version: null,
    permissions: ['network:music.youtube.com', 'kv'],
  },
];

function boot(
  api: AuqwApi,
  deps: {
    storage?: FakeStorage;
    player?: FakePlayer;
    providers?: readonly PluginProvider[];
  } = {},
): ReturnType<typeof createSessionController> {
  return createSessionController(api, {
    storage: deps.storage ?? new FakeStorage(persisted()),
    player: deps.player ?? new FakePlayer(),
    ...(deps.providers === undefined ? {} : { providers: deps.providers }),
  });
}

// 1. Loaded manifests become providers — capabilities filtered to the
// ABI set (a bogus manifest capability never reaches ProviderPort).
async function providersFromManifests(): Promise<void> {
  const rig = fakeApi();
  rig.pluginsResult = {
    bindings: 'loaded',
    plugins: ['plugin-itunes', 'plugin-ytm'],
    manifests: MANIFESTS,
  };
  const controller = await boot(rig.api);
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
    await boot(rig.api);
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
    await boot(rig.api);
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
  const controller = await boot(rig.api, {
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
  const booting = boot(rig.api, {
    storage,
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
  const controller = await boot(rig.api, {
    providers: defaultProviders(),
  });
  await Promise.resolve();
  // The session's edge subscription plus the download ledger's
  // connectivity watch both hang off api.net.
  assert(
    rig.netListeners.length >= 1,
    'at least the session net subscription',
  );
  assertEqual(controller.isOnline(), false);
  for (const listener of rig.netListeners) {
    listener({ online: true });
  }
  assertEqual(controller.isOnline(), true);
  await controller.dispose();
  assert(
    rig.netUnsubscribes >= 1,
    'dispose releases every net subscription',
  );
}

// 6. dispose unsubscribes net, disposes providers (ops settle
// unavailable), and lets the session wind down.
async function disposeSeam(): Promise<void> {
  const rig = fakeApi();
  const disposed: string[] = [];
  const controller = await boot(rig.api, {
    providers: defaultProviders(disposed),
  });
  await controller.dispose();
  assertDeepEqual(disposed, ['itunes', 'youtube-music']);
  assert(
    rig.netUnsubscribes >= 1,
    'dispose releases every net subscription',
  );
}

// 7. A plugin set with no declarer for a required capability cannot
// serve a session — an arbitrary id would only route ops into
// unsupported. The boot throws before Session construction.
async function incompleteProviderSet(): Promise<void> {
  const rig = fakeApi();
  let thrown: unknown = null;
  try {
    await boot(rig.api, {
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
    await boot(rig.api, {
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
  const controller = await boot(rig.api, {
    storage,
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
  const controller = await boot(rig.api, {
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

function rec(id: string, provenance: Recording['provenance']): Recording {
  return {
    id,
    title: `title-${id}`,
    artist: null,
    album: null,
    durationMs: 1,
    releaseYear: null,
    artwork: [],
    explicit: null,
    genre: null,
    isrc: null,
    versionLabels: [],
    sourceRefs:
      provenance === 'local'
        ? [localTrackRef(`lf-${id}`)]
        : [{ provider: 'youtube-music', kind: 'track', id: `yt-${id}` }],
    mappings: [],
    provenance,
  };
}

function downloadRow(over: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    downloadId: 'dl-1',
    recordingId: 'rec-dl',
    provider: 'youtube-music',
    sourceRef: { provider: 'youtube-music', kind: 'track', id: 'yt-1' },
    filePath: 'dl-1',
    bytes: 100,
    state: 'available',
    committedOffset: 100,
    checksum: 'a'.repeat(64),
    mime: 'audio/webm',
    itag: null,
    expiresAtMs: null,
    error: null,
    priority: 0,
    requestedMs: 1,
    downloadedMs: 1,
    ...over,
  };
}

function localSourceRow(): LocalSource {
  return {
    sourceId: 'src-1',
    treeUri:
      process.platform === 'win32'
        ? 'file:///C:/music/rips'
        : 'file:///music/rips',
    label: 'rips',
    addedMs: 1,
    lastScanMs: 1,
  };
}

function localFileRow(): LocalFile {
  return {
    fileId: 'lf-rec-lf',
    sourceId: 'src-1',
    docId: 'sub/rip.flac',
    size: 5,
    fingerprint: 'fp-1',
    modifiedMs: 1,
    title: 'rip',
    artist: null,
    album: null,
    durationMs: null,
    genre: null,
    recordingId: 'rec-lf',
  };
}

async function pump(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
}

function settleTagreadEnumerate(rig: Rig): void {
  const resolvers = rig.tagreadEnumerateResolvers.splice(0);
  for (const resolve of resolvers) {
    resolve();
  }
}

/** The prepare calls the player saw, newest last. */
function prepareCalls(player: FakePlayer) {
  return player.calls.filter((c) => c.method === 'prepare');
}

// 10. An 'available' download row resolves `provider:'local'` — the
// probe answers the media-dir `file://` URI and the session prepares
// on the local route instead of the provider ref.
async function downloadResolvesLocal(): Promise<void> {
  const rig = fakeApi();
  const player = new FakePlayer();
  rig.transferStat = { exists: true, bytes: 100 };
  const controller = await boot(rig.api, {
    storage: new FakeStorage(
      persisted({
        recordings: [rec('rec-dl', 'provider')],
        downloads: [downloadRow()],
      }),
    ),
    player,
    providers: defaultProviders(),
  });
  // The ledger verified the row through the scripted transfer port.
  assertEqual(controller.downloads.fileFor('rec-dl'), 'dl-1');
  await pump(); // let the meta probe land
  const pending = controller.session.playRecordings([
    { recordingId: 'rec-dl', selectedRef: null },
  ]);
  await pump();
  const calls = prepareCalls(player);
  assertEqual(calls.length, 1, 'one prepare');
  const input = calls[0]?.input as {
    provider?: string;
    sourceRef?: string;
  };
  assertEqual(input.provider, 'local');
  assertEqual(
    input.sourceRef,
    process.platform === 'win32'
      ? 'file:///C:/tmp/auqw-test/media/dl-1'
      : 'file:///tmp/auqw-test/media/dl-1',
    'owned download resolves the media-dir file uri',
  );
  player.settlePrepare(ok('h-1'));
  const played = await pending;
  assert(played.ok, `playRecordings: ${JSON.stringify(played)}`);
  await controller.dispose();
}

// 11. A scanned local file resolves `provider:'local'` through the
// source's docUri math — the session prepares the `file://` URI the
// player attaches directly.
async function localFileResolvesUri(): Promise<void> {
  const rig = fakeApi();
  const player = new FakePlayer();
  const controller = await boot(rig.api, {
    storage: new FakeStorage(
      persisted({
        recordings: [rec('rec-lf', 'local')],
        localSources: [localSourceRow()],
        localFiles: [localFileRow()],
      }),
    ),
    player,
    providers: defaultProviders(),
  });
  assert(
    controller.local() !== null,
    'local source built off the restored rows',
  );
  const pending = controller.session.playRecordings([
    { recordingId: 'rec-lf', selectedRef: null },
  ]);
  await pump();
  const calls = prepareCalls(player);
  assertEqual(calls.length, 1, 'one prepare — the local ref resolves');
  const input = calls[0]?.input as {
    provider?: string;
    sourceRef?: string;
  };
  assertEqual(input.provider, 'local');
  assertEqual(
    input.sourceRef,
    process.platform === 'win32'
      ? 'file:///C:/music/rips/sub/rip.flac'
      : 'file:///music/rips/sub/rip.flac',
    'local file resolves the source docUri',
  );
  player.settlePrepare(ok('h-1'));
  const played = await pending;
  assert(played.ok, `playRecordings: ${JSON.stringify(played)}`);
  await controller.dispose();
}

// 12. `rehydrateMedia` reloads the media owners after an import-shaped
// commit — the rebuilt local source serves the swapped rows.
async function rehydrateAfterImport(): Promise<void> {
  const rig = fakeApi();
  const player = new FakePlayer();
  const storage = new FakeStorage(persisted());
  const controller = await boot(rig.api, {
    storage,
    player,
    providers: defaultProviders(),
  });
  assertEqual(
    controller.local()?.uriFor('rec-lf') ?? null,
    null,
    'no local rows at boot',
  );
  // A committed swap — what importLibrary leaves behind — is what a
  // rehydrate must pick up.
  const committed = await storage.commit(
    {
      recordings: [rec('rec-lf', 'local')],
      localSources: [localSourceRow()],
      localFiles: [localFileRow()],
    },
    ctx(),
  );
  assert(committed.ok);
  await controller.rehydrateMedia(new CancellationSource().signal);
  const local = controller.local();
  assert(local !== null, 'local source rebuilt off the new rows');
  assertEqual(
    local?.uriFor('rec-lf'),
    process.platform === 'win32'
      ? 'file:///C:/music/rips/sub/rip.flac'
      : 'file:///music/rips/sub/rip.flac',
  );
  player.cancelPendingPrepares();
  await controller.dispose();
}

// 13. A vanished owned file drops the row at init — the ledger is
// honest empty, playback falls back to provider resolution.
async function vanishedDownloadHonest(): Promise<void> {
  const rig = fakeApi();
  const player = new FakePlayer();
  rig.transferStat = { exists: false, bytes: null };
  const controller = await boot(rig.api, {
    storage: new FakeStorage(
      persisted({
        recordings: [rec('rec-dl', 'provider')],
        downloads: [downloadRow()],
      }),
    ),
    player,
    providers: defaultProviders(),
  });
  assertEqual(
    controller.downloads.fileFor('rec-dl'),
    null,
    'vanished file never answers fileFor',
  );
  player.cancelPendingPrepares();
  await controller.dispose();
}

// 14. `localPlaybackFor` is the same probe the session resolves
// through — the offline play gate reads it directly. Now that the
// web player serves `provider:'local'`, the probe answers the media-
// dir URI for owned bytes and stays null for remote-only rows.
async function localPlaybackProbe(): Promise<void> {
  const rig = fakeApi();
  const player = new FakePlayer();
  rig.transferStat = { exists: true, bytes: 100 };
  const controller = await boot(rig.api, {
    storage: new FakeStorage(
      persisted({
        recordings: [
          rec('rec-dl', 'provider'),
          rec('rec-remote', 'provider'),
        ],
        downloads: [downloadRow()],
      }),
    ),
    player,
    providers: defaultProviders(),
  });
  await pump(); // let the meta probe land
  assertEqual(
    controller.localPlaybackFor('rec-dl'),
    process.platform === 'win32'
      ? 'file:///C:/tmp/auqw-test/media/dl-1'
      : 'file:///tmp/auqw-test/media/dl-1',
    'owned download resolves the media-dir file uri',
  );
  assertEqual(
    controller.localPlaybackFor('rec-remote'),
    null,
    'a provider-only recording stays remote',
  );
  player.cancelPendingPrepares();
  await controller.dispose();
}

// 15. `replaceLibrary` drains downloads before the swap and deletes
// the captured files — a live ledger can't resurrect removed rows.
async function replaceLibraryDrainsDownloads(): Promise<void> {
  const rig = fakeApi();
  const player = new FakePlayer();
  rig.transferStat = { exists: true, bytes: 100 };
  const controller = await boot(rig.api, {
    storage: new FakeStorage(
      persisted({
        recordings: [rec('rec-dl', 'provider')],
        downloads: [downloadRow()],
      }),
    ),
    player,
    providers: defaultProviders(),
  });
  assertEqual(controller.downloads.fileFor('rec-dl'), 'dl-1');
  // An import doc minted off an empty library — no downloads section.
  const rigEmpty = fakeApi();
  const empty = await boot(rigEmpty.api, {
    storage: new FakeStorage(
      persisted({ recordings: [rec('rec-dl', 'provider')] }),
    ),
    providers: defaultProviders(),
  });
  const exported = await empty.session.exportLibrary();
  assert(exported.ok, 'export failed');
  await empty.dispose();

  const replaced = await controller.replaceLibrary(
    exported.value.json,
    new CancellationSource().signal,
  );
  assert(replaced.ok, `replaceLibrary: ${JSON.stringify(replaced)}`);
  assertEqual(rig.transferRemoved.length, 1, 'old ledger file deletes');
  assertEqual(rig.transferRemoved[0], 'dl-1');
  assertEqual(
    controller.downloads.fileFor('rec-dl'),
    null,
    'the imported doc has no downloads — the row is gone',
  );
  player.cancelPendingPrepares();
  await controller.dispose();
}

// 16. Import keeps the folder grants but wipes the file index —
// replaceLibrary's rehydrate must schedule the rescan that rejoins
// the rows (and re-extracts embedded covers), or imported recordings
// sit blank until a manual rescan.
async function replaceLibraryRescansSources(): Promise<void> {
  const rig = fakeApi();
  const player = new FakePlayer();
  const storage = new FakeStorage(
    persisted({
      recordings: [rec('rec-lf', 'local')],
      localSources: [localSourceRow()],
      localFiles: [localFileRow()],
    }),
  );
  // The survived folder's tree carries one document — the rescan
  // must rejoin it as a file row and mint its recording cover.
  const entry: LocalEntry = {
    docId: 'sub/rip.flac',
    name: 'rip.flac',
    size: 5,
    mime: 'audio/flac',
    modifiedMs: 2,
  };
  rig.tagreadEntries = [entry];
  rig.tagreadFingerprints = new Map([[entry.docId, 'fp-rejoin']]);
  rig.tagreadTags = new Map([
    [
      entry.docId,
      {
        docId: entry.docId,
        title: 'Rejoined Rip',
        artist: 'Ripper',
        album: null,
        durationMs: 3210,
        genre: null,
        artworkUri: 'file:///u/art/cover.png',
      },
    ],
  ]);
  const controller = await boot(rig.api, {
    storage,
    player,
    providers: defaultProviders(),
  });
  // An import doc minted off an empty library — owned sections only,
  // so the device-local file index does not round-trip.
  const rigEmpty = fakeApi();
  const empty = await boot(rigEmpty.api, {
    storage: new FakeStorage(
      persisted({ recordings: [rec('rec-dl', 'provider')] }),
    ),
    providers: defaultProviders(),
  });
  const exported = await empty.session.exportLibrary();
  assert(exported.ok, 'export failed');
  await empty.dispose();

  const replaced = await controller.replaceLibrary(
    exported.value.json,
    new CancellationSource().signal,
  );
  assert(replaced.ok, `replaceLibrary: ${JSON.stringify(replaced)}`);
  await pump(); // settle the fire-and-forget rescan
  assertDeepEqual(
    rig.tagreadEnumerated,
    [localSourceRow().treeUri],
    'the survived folder grant rescans after import',
  );
  assertEqual(
    rigEmpty.tagreadEnumerated.length,
    0,
    'a failed or no-source import never scans',
  );
  // The rescan actually rejoins rows: the file index is rebuilt and
  // the re-minted recording carries its extracted embedded cover.
  const state = await storage.load(ctx());
  assert(state.ok, 'post-rescan load failed');
  assertEqual(state.value.localFiles.length, 1, 'file row not rejoined');
  assertEqual(
    state.value.localFiles[0]?.fingerprint,
    'fp-rejoin',
    'file row fingerprint',
  );
  const rejoined = state.value.recordings.find(
    (r) => r.title === 'Rejoined Rip',
  );
  assert(rejoined !== undefined, 'rescan did not mint the recording');
  assertDeepEqual(
    rejoined.artwork,
    [{ url: 'file:///u/art/cover.png', width: null, height: null }],
    'embedded cover not applied to the re-minted recording',
  );
  player.cancelPendingPrepares();
  await controller.dispose();
}

// 17. A second rehydrate (the applied-sync path) landing while the
// post-import rescan is in flight retires the scanning instance —
// the replacement must re-derive the scan need from the empty file
// index itself, or the session keeps artless imported rows forever.
async function rehydrateDuringRescanReArms(): Promise<void> {
  const rig = fakeApi();
  const player = new FakePlayer();
  const storage = new FakeStorage(
    persisted({
      recordings: [rec('rec-lf', 'local')],
      localSources: [localSourceRow()],
      localFiles: [localFileRow()],
    }),
  );
  const entry: LocalEntry = {
    docId: 'sub/rip.flac',
    name: 'rip.flac',
    size: 5,
    mime: 'audio/flac',
    modifiedMs: 2,
  };
  rig.tagreadEntries = [entry];
  rig.tagreadFingerprints = new Map([[entry.docId, 'fp-rejoin']]);
  rig.tagreadTags = new Map([
    [
      entry.docId,
      {
        docId: entry.docId,
        title: 'Rejoined Rip',
        artist: 'Ripper',
        album: null,
        durationMs: 3210,
        genre: null,
        artworkUri: 'file:///u/art/cover.png',
      },
    ],
  ]);
  const controller = await boot(rig.api, {
    storage,
    player,
    providers: defaultProviders(),
  });
  const rigEmpty = fakeApi();
  const empty = await boot(rigEmpty.api, {
    storage: new FakeStorage(
      persisted({ recordings: [rec('rec-dl', 'provider')] }),
    ),
    providers: defaultProviders(),
  });
  const exported = await empty.session.exportLibrary();
  assert(exported.ok, 'export failed');
  await empty.dispose();

  // Hold the post-import rescan's enumerate open so the applied-sync
  // rehydrate lands mid-flight and retires the scanning instance.
  rig.tagreadHoldEnumerate = true;
  const replaced = controller.replaceLibrary(
    exported.value.json,
    new CancellationSource().signal,
  );
  // replaceLibrary's finally awaits the rehydrate run — resolving it
  // guarantees the rescan was scheduled (its enumerate is held open).
  assert((await replaced).ok, 'replaceLibrary failed');
  await pump();
  assertEqual(
    rig.tagreadEnumerated.length,
    1,
    'post-import rescan did not start',
  );
  const second = controller.rehydrateMedia(new CancellationSource().signal);
  await pump();
  // Retire cancels the in-flight scan through the linked lifecycle
  // signal — the cancel wins over the held IPC, so the replacement
  // rebuild proceeds, lands on the still-empty file index, and must
  // re-arm the rescan itself (its enumerate is held open too).
  assertEqual(
    rig.tagreadEnumerated.length,
    2,
    'the replacement instance did not re-arm the rescan',
  );
  rig.tagreadHoldEnumerate = false;
  settleTagreadEnumerate(rig);
  await second;
  await pump(); // the re-armed rescan commits + merges into the session
  const snap = controller.session.snapshot();
  assertEqual(snap.type, 'ready');
  if (snap.type !== 'ready') {
    return;
  }
  const rejoined = snap.recordings.find((r) => r.title === 'Rejoined Rip');
  assert(
    rejoined !== undefined,
    're-armed rescan did not mint the recording into the session',
  );
  assertDeepEqual(
    rejoined.artwork,
    [{ url: 'file:///u/art/cover.png', width: null, height: null }],
    'session recording lost the re-extracted cover',
  );
  player.cancelPendingPrepares();
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
  ['downloadResolvesLocal', downloadResolvesLocal],
  ['localFileResolvesUri', localFileResolvesUri],
  ['rehydrateAfterImport', rehydrateAfterImport],
  ['vanishedDownloadHonest', vanishedDownloadHonest],
  ['localPlaybackProbe', localPlaybackProbe],
  ['replaceLibraryDrainsDownloads', replaceLibraryDrainsDownloads],
  ['replaceLibraryRescansSources', replaceLibraryRescansSources],
  ['rehydrateDuringRescanReArms', rehydrateDuringRescanReArms],
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
