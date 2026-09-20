import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { Session } from '@auqw/application';
import type {
  PlayerPort,
  ProviderPort,
  Settings,
} from '@auqw/application';
import { SqliteStorage } from '@auqw/storage-sqlite';
import type { AuqwExpoHostModuleLike } from '../adapters/auqw-expo-surface.ts';
import { createExpoAudioPlayer } from '../adapters/expo-audio-player.ts';
import type { PluginProvider } from '../adapters/plugin-provider.ts';
import {
  createPluginProvider,
  manifestCapabilities,
} from '../adapters/plugin-provider.ts';
import { createExpoSqliteDriver } from '../adapters/expo-sqlite-driver.ts';
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
  host: AuqwExpoHostModuleLike,
  options: SessionControllerOptions = {},
): Promise<SessionController> {
  // Fuel config matches the Slice-0 gate values.
  await host.createHost({
    fuelPerEntry: 200_000_000,
    fuelTotal: 2_000_000_000,
    potProviderUrl: options.potProviderUrl,
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
  const session = new Session({
    storage,
    player,
    providers,
    clock: createClock(),
    ids: createIds(),
    log: createLog(),
    defaults: DEFAULT_SETTINGS,
  });
  return {
    session,
    storage,
    providers,
    player,
    async dispose() {
      await session.dispose();
      for (const provider of providers) {
        provider.dispose();
      }
    },
  };
}
