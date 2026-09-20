import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { Session } from '@auqw/application';
import type {
  PlayerPort,
  ProviderPort,
  Settings,
} from '@auqw/application';
import { SqliteStorage } from '@auqw/storage-sqlite';
import type { AuqwExpoLike } from '../adapters/auqw-expo-surface.ts';
import { createAuqwExpoPlayer } from '../adapters/auqw-expo-player.ts';
import type { PluginProvider } from '../adapters/plugin-provider.ts';
import { createPluginProvider } from '../adapters/plugin-provider.ts';
import { createExpoSqliteDriver } from '../adapters/expo-sqlite-driver.ts';
import { createClock, createIds, createLog } from '../adapters/runtime.ts';

// Metro asset requires must be static literals. Both pairs are
// produced by tooling/sync-plugins.mjs per providers.lock.json.
const ITUNES_WASM: number = require('../../assets/plugins/itunes.wasm');
const ITUNES_MANIFEST: unknown = require('../../assets/plugins/itunes.manifest.json');
const YOUTUBE_MUSIC_WASM: number = require('../../assets/plugins/youtube-music.wasm');
const YOUTUBE_MUSIC_MANIFEST: unknown = require('../../assets/plugins/youtube-music.manifest.json');

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
  module: AuqwExpoLike,
  wasmRef: number,
  manifest: unknown,
): Promise<string> {
  const wasmBase64 = await wasmAssetBase64(wasmRef);
  return module.loadPlugin(wasmBase64, JSON.stringify(manifest));
}

/**
 * Wires the auqw-expo native module to an application `Session`:
 * host config, both bundled plugins, the two ProviderPorts,
 * expo-sqlite storage, and the seam player. `module` is injected —
 * this file never imports 'auqw-expo'.
 *
 * The caller still drives `session.restore()` and subscribes for
 * state; construction only assembles the dependency graph.
 */
export async function createSessionController(
  module: AuqwExpoLike,
  options: { potProviderUrl?: string; databasePath?: string } = {},
): Promise<SessionController> {
  // Fuel config matches the Slice-0 gate values in App.tsx.
  await module.createHost({
    fuelPerEntry: 200_000_000,
    fuelTotal: 2_000_000_000,
    potProviderUrl: options.potProviderUrl,
  });
  const [itunesPluginId, youtubeMusicPluginId] = await Promise.all([
    loadBundledPlugin(module, ITUNES_WASM, ITUNES_MANIFEST),
    loadBundledPlugin(module, YOUTUBE_MUSIC_WASM, YOUTUBE_MUSIC_MANIFEST),
  ]);
  const providers: PluginProvider[] = [
    createPluginProvider(module, itunesPluginId, 'itunes'),
    createPluginProvider(module, youtubeMusicPluginId, 'youtube-music'),
  ];
  const storage = new SqliteStorage(
    await createExpoSqliteDriver(options.databasePath),
    DEFAULT_SETTINGS,
  );
  const player = createAuqwExpoPlayer(module);
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
