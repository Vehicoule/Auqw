import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import {
  appError,
  CancellationSource,
  DownloadManager,
  LocalFileSource,
  Session,
} from '@auqw/application';
import type {
  ArtworkCache,
  CancellationSignal,
  ConnectivityPort,
  PlayerPort,
  ProviderPort,
  QueueSnapshot,
  Settings,
} from '@auqw/application';
import { SqliteStorage } from '@auqw/storage-sqlite';
import type {
  AuqwConnectivityNative,
  AuqwDownloadsNative,
  AuqwExpoHostModuleLike,
  AuqwTagReaderNative,
} from '../adapters/auqw-expo-surface.ts';
import { createExpoArtwork } from '../adapters/expo-artwork.ts';
import { createExpoAudioPlayer } from '../adapters/expo-audio-player.ts';
import type { PluginProvider } from '../adapters/plugin-provider.ts';
import {
  createPluginProvider,
  manifestCapabilities,
} from '../adapters/plugin-provider.ts';
import { createExpoConnectivity } from '../adapters/expo-connectivity.ts';
import { createExpoSqliteDriver } from '../adapters/expo-sqlite-driver.ts';
import { createExpoTagReader } from '../adapters/expo-tag-reader.ts';
import { createExpoTransfer } from '../adapters/expo-transfer.ts';
import { createClock, createIds, createLog } from '../adapters/runtime.ts';

// Metro asset requires must be static literals. All pairs are
// produced by tooling/sync-plugins.mjs per providers.lock.json.
const ITUNES_WASM: number = require('../../assets/plugins/itunes.wasm');
const ITUNES_MANIFEST: unknown = require('../../assets/plugins/itunes.manifest.json');
const YOUTUBE_MUSIC_WASM: number = require('../../assets/plugins/youtube-music.wasm');
const YOUTUBE_MUSIC_MANIFEST: unknown = require('../../assets/plugins/youtube-music.manifest.json');
const DEEZER_WASM: number = require('../../assets/plugins/deezer.wasm');
const DEEZER_MANIFEST: unknown = require('../../assets/plugins/deezer.manifest.json');
const LYRICS_LRCLIB_WASM: number = require('../../assets/plugins/lyrics-lrclib.wasm');
const LYRICS_LRCLIB_MANIFEST: unknown = require('../../assets/plugins/lyrics-lrclib.manifest.json');

/**
 * Defaults for a fresh install. `qualityKbps: 128` is the spec's
 * target-bitrate default (docs/specs/providers.md "default ≈ 128
 * kbps") and inside isSettings' 1–512 bound; `storefront: null`
 * defers to the spec's system-locale → API-default resolution order
 * (docs/specs/providers.md); `theme: 'system'` and `prefetch: true`
 * match the domain Settings contract.
 */
function nativeMessage(thrown: unknown): string {
  return thrown instanceof Error && thrown.message.length > 0
    ? thrown.message
    : 'native call failed';
}

const DEFAULT_SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: null,
  qualityKbps: 128,
  theme: 'system',
  prefetch: true,
};

export type SessionController = {
  readonly session: Session;
  readonly storage: SqliteStorage;
  readonly providers: readonly ProviderPort[];
  readonly player: PlayerPort;
  /**
   * The bounded LRU artwork cache (spec: ~200 MB, settings-managed).
   * Image components resolve artwork through `cache.get`; the
   * settings surface calls `sweep` after shrinking the budget.
   */
  readonly artworkCache: ArtworkCache;
  /** Slice-3 download ledger — `init`d in `start()`, after restore. */
  readonly downloads: DownloadManager;
  /**
   * Local-files index — null until `start()` loads persisted state
   * (its constructor takes the committed rows). UI must render a
   * null-local state honestly (folders list empty, not '0 scanned').
   */
  readonly local: () => LocalFileSource | null;
  readonly connectivity: ConnectivityPort;
  /**
   * Post-restore bring-up: loads persisted state once more, builds
   * the local source over it, and inits the download ledger. Call
   * after `session.restore()` — storage commits must not interleave
   * with restore's own writes.
   */
  start(signal: CancellationSignal): Promise<void>;
  dispose(): Promise<void>;
};

async function wasmAssetBase64(moduleRef: number): Promise<string> {
  const asset = Asset.fromModule(moduleRef);
  await asset.downloadAsync();
  if (!asset.localUri) {
    throw new Error('asset has no localUri after download');
  }
  return new File(asset.localUri).base64();
}

async function loadBundledPlugin(
  host: AuqwExpoHostModuleLike,
  wasmRef: number,
  manifest: unknown,
): Promise<string> {
  const wasmBase64 = await wasmAssetBase64(wasmRef);
  return host.loadPlugin(wasmBase64, JSON.stringify(manifest));
}

export type SessionControllerOptions = {
  readonly potProviderUrl?: string | undefined;
  readonly databasePath?: string;
  /**
   * Player factory over the built providers. Defaults to the
   * provisional expo-audio download path (works on both platforms);
   * Android swaps to `createAuqwExpoPlayer(auqwExpo)` when the seam
   * module lands.
   */
  readonly player?: (
    providers: ReadonlyMap<string, ProviderPort>,
  ) => PlayerPort;
};

/**
 * Wires a plugin-host module to an application `Session`: host
 * config, all four bundled plugins, their ProviderPorts, expo-sqlite
 * storage, and the chosen player. `host` is injected — satisfied by
 * `auqw-plugin-host-expo` today and `auqw-expo` at the seam merge.
 *
 * The caller still drives `session.restore()` and subscribes for
 * state; construction only assembles the dependency graph.
 */
export async function createSessionController(
  host: AuqwExpoHostModuleLike &
    AuqwConnectivityNative &
    AuqwTagReaderNative &
    AuqwDownloadsNative,
  options: SessionControllerOptions = {},
): Promise<SessionController> {
  // Fuel config matches the Slice-0 gate values.
  await host.createHost({
    fuelPerEntry: 200_000_000,
    fuelTotal: 2_000_000_000,
    potProviderUrl: options.potProviderUrl,
    // The decided per-surface container pick: webm-first on Android
    // (higher bitrate, Matroska Cues seek verified on-device); iOS is
    // mp4-required — AVPlayer has no WebM/Opus.
    prefer:
      Platform.OS === 'ios' ? ['audio/mp4'] : ['audio/webm', 'audio/mp4'],
  });
  const [itunesPluginId, youtubeMusicPluginId, deezerPluginId, lyricsLrclibPluginId] =
    await Promise.all([
      loadBundledPlugin(host, ITUNES_WASM, ITUNES_MANIFEST),
      loadBundledPlugin(host, YOUTUBE_MUSIC_WASM, YOUTUBE_MUSIC_MANIFEST),
      loadBundledPlugin(host, DEEZER_WASM, DEEZER_MANIFEST),
      loadBundledPlugin(host, LYRICS_LRCLIB_WASM, LYRICS_LRCLIB_MANIFEST),
    ]);
  const providers: PluginProvider[] = [
    createPluginProvider(
      host,
      itunesPluginId,
      'itunes',
      manifestCapabilities(ITUNES_MANIFEST),
    ),
    createPluginProvider(
      host,
      youtubeMusicPluginId,
      'youtube-music',
      manifestCapabilities(YOUTUBE_MUSIC_MANIFEST),
    ),
    createPluginProvider(
      host,
      deezerPluginId,
      'deezer',
      manifestCapabilities(DEEZER_MANIFEST),
    ),
    createPluginProvider(
      host,
      lyricsLrclibPluginId,
      'lyrics-lrclib',
      manifestCapabilities(LYRICS_LRCLIB_MANIFEST),
    ),
  ];
  const storage = new SqliteStorage(
    await createExpoSqliteDriver(options.databasePath),
    DEFAULT_SETTINGS,
  );
  const providerMap = new Map(providers.map((p) => [p.id, p]));
  const player = (options.player ?? ((map) => {
    return createExpoAudioPlayer({
      providers: map,
      ids: createIds(),
      qualityKbps: DEFAULT_SETTINGS.qualityKbps,
    });
  }))(providerMap);
  const ids = createIds();
  const clock = createClock();
  const connectivity = createExpoConnectivity(host);
  const { transfer } = createExpoTransfer();
  // `local` is constructed in start(); the playback hook reads the
  // box so a URI resolves the moment a source exists.
  let localSource: LocalFileSource | null = null;
  const log = createLog();
  const session = new Session({
    storage,
    player,
    providers,
    clock,
    ids,
    log,
    defaults: DEFAULT_SETTINGS,
    localPlaybackFor: (recordingId) => {
      // Owned bytes first: a stored download wins; a local file whose
      // download was removed still plays from its document URI.
      const file = downloads.fileFor(recordingId);
      if (file !== null) {
        return file;
      }
      return localSource?.uriFor(recordingId) ?? null;
    },
  });
  type ReadyState = Extract<
    ReturnType<Session['snapshot']>,
    { type: 'ready' }
  >;
  const readyOr = <T>(
    pick: (state: ReadyState) => T,
    fallback: T,
  ): T => {
    const state = session.snapshot();
    return state.type === 'ready' ? pick(state) : fallback;
  };
  const emptyQueue: QueueSnapshot = {
    revision: 0,
    occurrences: [],
    currentOccurrenceId: null,
    positionMs: 0,
    mode: 'paused',
  };
  const downloads = new DownloadManager({
    storage,
    transfer,
    connectivity,
    clock,
    ids,
    log,
    fetchImpl: (url, init, signal) => {
      // Bridge the port's CancellationSignal onto fetch's AbortSignal.
      const abort = new AbortController();
      signal.subscribe(() => abort.abort());
      return fetch(url, { headers: init.headers, signal: abort.signal });
    },
    resolvePlayback: (ref, input, context) => {
      const provider = providerMap.get(
        readyOr((s) => s.settings.playbackProvider, DEFAULT_SETTINGS.playbackProvider),
      );
      if (provider === undefined) {
        return Promise.resolve({
          ok: false as const,
          error: appError('unavailable', 'playback provider not loaded'),
        });
      }
      return provider.resolvePlayback(
        ref,
        {
          targetBitrateKbps: readyOr(
            (s) => s.settings.qualityKbps,
            DEFAULT_SETTINGS.qualityKbps,
          ),
          prefer:
            Platform.OS === 'ios'
              ? ['audio/mp4']
              : ['audio/webm', 'audio/mp4'],
          pinItag: input.pinItag,
          resumeOffset: input.resumeOffset,
        },
        context,
      );
    },
    queue: () => readyOr((s) => s.queue, emptyQueue),
    settings: () => readyOr((s) => s.settings, DEFAULT_SETTINGS),
  });
  const { cache: artworkCache } = createExpoArtwork({
    storage,
    clock,
    ids,
    log: createLog(),
  });
  // Startup sweep: reap anything the OS already reclaimed and honor
  // a budget shrunk last launch. Fire-and-forget — the cache
  // serializes it behind any early `get` calls itself.
  void artworkCache.sweep({
    requestId: ids.next('artwork-sweep'),
    deadlineMs: clock.nowMs() + 60_000,
    signal: new CancellationSource().signal,
  });
  return {
    session,
    storage,
    providers,
    player,
    artworkCache,
    downloads,
    local: () => localSource,
    connectivity,
    async start(signal) {
      const loaded = await storage.load({
        requestId: ids.next('local-boot'),
        deadlineMs: clock.nowMs() + 30_000,
        signal,
      });
      if (!loaded.ok) {
        // Persisted downloads stay un-initialized — the ledger is
        // honest empty rather than half-loaded.
        log.write({
          level: 'warn',
          message: `local boot load failed: ${loaded.error.kind}`,
          atMs: clock.nowMs(),
        });
        return;
      }
      const tagReader = createExpoTagReader(host);
      localSource = new LocalFileSource(
        { storage, tagReader, ids, clock, log },
        {
          localSources: loaded.value.localSources,
          localFiles: loaded.value.localFiles,
          recordings: loaded.value.recordings,
        },
      );
      await downloads.init(loaded.value.downloads, signal);
      // dataSync FGS keep-alive: drive the service off the ledger —
      // 'transferring' rows only (queued/metered-waiting rows hold no
      // network and must not keep a foreground service posted). The
      // native surface is Android-only; iOS lacks the method — its
      // absence resolves to a warn, not a crash.
      let lastActive = -1;
      downloads.subscribe(() => {
        const active = downloads
          .list()
          .filter((d) => d.state === 'transferring').length;
        if (active === lastActive) {
          return;
        }
        lastActive = active;
        try {
          void host.downloadsActiveChanged(active).catch((thrown) => {
            void log.write({
              level: 'warn',
              message: `fgs update failed: ${nativeMessage(thrown)}`,
              atMs: clock.nowMs(),
            });
          });
        } catch {
          // Method absent on this platform — downloads still work;
          // only Doze-protected long transfers are degraded.
        }
      });
    },
    async dispose() {
      await downloads.stop(new CancellationSource().signal);
      await session.dispose();
      for (const provider of providers) {
        provider.dispose();
      }
    },
  };
}
