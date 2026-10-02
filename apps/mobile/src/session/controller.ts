import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import {
  appError,
  CancellationSource,
  createSyncScheduler,
  DownloadManager,
  err,
  LocalFileSource,
  previewImport,
  retryBounded,
  Session,
  syncedRecordKey,
} from '@auqw/application';
import type {
  ArtworkCache,
  CancellationSignal,
  ConnectivityPort,
  ImportPreview,
  LocalWrite,
  PeaksStore,
  PersistedState,
  PlayerPort,
  ProviderPort,
  QueueSnapshot,
  Result,
  SearchHistoryStore,
  SyncApplyReport,
  SyncScheduler,
} from '@auqw/application';
import {
  SqliteStorage,
  SqliteSyncLogStore,
  createPeaksCacheStore,
  createSearchHistoryStore,
} from '@auqw/storage-sqlite';
import { defaultSettings, repairedSettings } from '@auqw/app-shell';
import type {
  AuqwConnectivityNative,
  AuqwDownloadsNative,
  AuqwExpoHostModuleLike,
  AuqwSyncNative,
  AuqwTagReaderNative,
} from '../adapters/auqw-expo-surface.ts';
import { createExpoArtwork } from '../adapters/expo-artwork.ts';
import { mediaDownloadsActive } from '../adapters/download-foreground.ts';
import { createExpoAudioPlayer } from '../adapters/expo-audio-player.ts';
import type { PluginProvider } from '../adapters/plugin-provider.ts';
import {
  createPluginProvider,
  manifestCapabilities,
  manifestVersion,
} from '../adapters/plugin-provider.ts';
import {
  createExpoConnectivity,
  createUnwatchedConnectivity,
} from '../adapters/expo-connectivity.ts';
import { openDatabaseAsync } from 'expo-sqlite';
import { createExpoSqliteDriver } from '../adapters/expo-sqlite-driver.ts';
import { createExpoTagReader } from '../adapters/expo-tag-reader.ts';
import { createExpoTransfer } from '../adapters/expo-transfer.ts';
import {
  createExpoSync,
  type ExpoSyncSurface,
} from '../adapters/expo-sync.ts';
import {
  createClock,
  createIds,
  createLog,
  createRandom,
} from '@auqw/application';
import { createSyncEmit } from './sync-emit.ts';

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

const BUNDLED_PLUGINS = [
  ['itunes', ITUNES_WASM, ITUNES_MANIFEST],
  ['youtube-music', YOUTUBE_MUSIC_WASM, YOUTUBE_MUSIC_MANIFEST],
  ['deezer', DEEZER_WASM, DEEZER_MANIFEST],
  ['lyrics-lrclib', LYRICS_LRCLIB_WASM, LYRICS_LRCLIB_MANIFEST],
] as const;

// The decided per-surface container pick: webm-first on Android
// (higher bitrate, Matroska Cues seek verified on-device); iOS is
// mp4-required — AVPlayer has no WebM/Opus.
const PREFERRED_CONTAINERS: readonly ('audio/webm' | 'audio/mp4')[] =
  Platform.OS === 'ios' ? ['audio/mp4'] : ['audio/webm', 'audio/mp4'];

function nativeMessage(thrown: unknown): string {
  return thrown instanceof Error && thrown.message.length > 0
    ? thrown.message
    : 'native call failed';
}

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
   * Device-local search recents (schema v12 `search_history`) — the
   * rail's durable backing list; hydrated on shell mount, committed
   * on each submitted/tapped query. Lives outside PersistedState,
   * so import and sync never touch it.
   */
  readonly searchHistory: SearchHistoryStore;
  /**
   * Device-local waveform peaks (schema v11 `peaks_cache`) — repeat
   * plays render the stored profile instantly; content-keyed like
   * searchHistory, outside PersistedState.
   */
  readonly peaksStore: PeaksStore;
  /**
   * Slice-4 LAN sync client — null when the platform lacks the seam
   * (iOS) or custody/engine bring-up failed; the UI must render an
   * honest 'sync unavailable' state, never a dead control.
   */
  readonly sync: () => ExpoSyncSurface | null;
  /**
   * Live PO-token provider update on the running plugin host —
   * resolves read the slot at invocation spawn, so a pairing or
   * unpairing landing after construction applies without a host
   * recreate. `null` restores the anonymous resolve ladder.
   */
  setPotProvider(url: string | null): void;
  /**
   * Live OAuth access-token update — the host merges it into every
   * session-trust payload; `null` clears the slot and restores the
   * anonymous ladder. Sync (UniFFI binding) — never awaited.
   * Returns false when the native slot is absent (a stale module
   * predating the auth seam) so the caller can fail the apply
   * honestly rather than claiming a live bearer on an empty slot.
   */
  setAuthToken(token: string | null): boolean;
  /**
   * Post-restore bring-up: loads persisted state once more, builds
   * the local source over it, and inits the download ledger. Call
   * after `session.restore()` — storage commits must not interleave
   * with restore's own writes.
   */
  start(signal: CancellationSignal): Promise<void>;
  /**
   * Re-loads persisted state into the media owners after a
   * whole-library replace (import): rebuilds the local source and
   * re-inits the download ledger so their rows can't go stale.
   */
  rehydrateMedia(
    signal: CancellationSignal,
    rescanEmptyIndex?: boolean,
  ): Promise<void>;
  /**
   * Local-source-only variant: rebuilds `localSource` from persisted
   * rows and projects them into the session WITHOUT touching the
   * download ledger — safe while transfers are live (rehydrateMedia's
   * downloads.init would sweep their partial files).
   */
  rehydrateLocal(signal: CancellationSignal): Promise<void>;
  /**
   * Whole-library replace with the ordering the media owners need:
   * the download manager stops and clears its files BEFORE the
   * section swap commits — a live runner or a finalized file must
   * not outlive the ledger. Then the import runs and the owners
   * rehydrate off the new snapshot.
   */
  replaceLibrary(
    text: string,
    signal: CancellationSignal,
  ): Promise<Result<ImportPreview>>;
  dispose(): Promise<void>;
};

async function loadBundledPlugin(
  host: AuqwExpoHostModuleLike,
  wasmRef: number,
  manifest: unknown,
): Promise<string> {
  const asset = Asset.fromModule(wasmRef);
  await asset.downloadAsync();
  if (!asset.localUri) {
    throw new Error('asset has no localUri after download');
  }
  return host.loadPlugin(
    await new File(asset.localUri).base64(),
    JSON.stringify(manifest),
  );
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
    AuqwDownloadsNative &
    AuqwSyncNative & {
      /** Module-exported presence check — false on iOS builds that
       * lack the socket surface entirely. */
      hasSyncSocket?: () => boolean;
    },
  options: SessionControllerOptions = {},
): Promise<SessionController> {
  // Fuel config matches the Slice-0 gate values.
  await host.createHost({
    fuelPerEntry: 200_000_000,
    fuelTotal: 2_000_000_000,
    potProviderUrl: options.potProviderUrl,
    prefer: PREFERRED_CONTAINERS,
  });
  // Two phases, not one interleave: a rejected load must leave zero
  // providers constructed — each adapter registers a native listener at
  // construction and a half-built set has no controller to dispose it.
  const loaded = await Promise.all(
    BUNDLED_PLUGINS.map(([providerId, wasm, manifest]) =>
      loadBundledPlugin(host, wasm, manifest).then((pluginId) => ({
        providerId,
        manifest,
        pluginId,
      })),
    ),
  );
  const providers: PluginProvider[] = loaded.map(
    ({ providerId, manifest, pluginId }) =>
      createPluginProvider(
        host,
        pluginId,
        providerId,
        manifestCapabilities(manifest),
        manifestVersion(manifest),
      ),
  );
  const defaults = defaultSettings(providers);
  const sqliteDriver = await createExpoSqliteDriver(options.databasePath, {
    openDb: openDatabaseAsync,
    deleteIfExists: async (filePath) => {
      const file = new File(`file://${filePath}`);
      if (file.exists) {
        file.delete();
      }
    },
  });
  const storage = new SqliteStorage(sqliteDriver, defaults);
  // Sync-log tables ride the same file + driver — the shared
  // transaction tail serializes sync writes with library writes.
  const syncLogStore = new SqliteSyncLogStore(sqliteDriver);
  // Device-local recents ride it too — the table exists once
  // restore's migrations ran, and the shell only mounts in 'ready'.
  const searchHistory = createSearchHistoryStore(sqliteDriver);
  // Same device-local file backs finished waveform profiles — a
  // repeat play of a known recording renders stored bars instead of
  // re-extracting.
  const peaksStore = createPeaksCacheStore(sqliteDriver);
  // Assembled in start() after restore: custody → engine → client.
  let syncSurface: ExpoSyncSurface | null = null;
  // The spec's trigger layer (on-launch, on-change debounced,
  // reconnect backoff, connectivity edge) — created with the client.
  let syncScheduler: SyncScheduler | null = null;
  // Pre-surface emission buffer: domain edits made before the engine
  // exists (or while its bring-up is still in flight) queue here and
  // flush through one localChangeBatch once the surface lands — a
  // drop-oldest bound keeps a never-syncable platform (iOS, web
  // build) from growing memory forever.
  // Serializes every localChangeBatch call — emission order IS the
  // log order, so a racing flush can't reorder writes on one record.
  const emitWrites = createSyncEmit({
    surface: () => syncSurface?.engine ?? null,
  });
  const providerMap = new Map(providers.map((p) => [p.id, p]));
  const player =
    options.player === undefined
      ? createExpoAudioPlayer({
          providers: providerMap,
          ids: createIds(),
          qualityKbps: defaults.qualityKbps,
        })
      : options.player(providerMap);
  const ids = createIds();
  const clock = createClock();
  // The Kotlin NetworkCallback monitor is Android-only; iOS gets the
  // unwatched fallback — no native methods exist there to call.
  const connectivity =
    Platform.OS === 'android'
      ? createExpoConnectivity(host)
      : createUnwatchedConnectivity();
  const { transfer, uriFor: downloadUriFor } = createExpoTransfer();
  // `local` is constructed in start(); the playback hook reads the
  // box so a URI resolves the moment a source exists.
  let localSource: LocalFileSource | null = null;
  // Cached connectivity read for the session's zero-resolution gate.
  // Optimistic true until start() seeds it — matches the unwatched
  // (iOS) port's convention; a failed read drops to offline, never
  // silently online.
  let lastOnline = true;
  // Metered gate for the session's speculative work (visible-row
  // mapping + the advisory stream warm) — same seed-then-edge feed as
  // `lastOnline`; iOS's unwatched port reports false.
  let lastMetered = false;
  const log = createLog();
  const session = new Session({
    storage,
    player,
    providers,
    clock,
    ids,
    random: createRandom(),
    log,
    defaults,
    // Android-only: the auqw-expo player attaches local files; the
    // iOS provisional player has no local-provider path, so owned
    // bytes there fall back to remote playback instead of failing.
    ...(Platform.OS === 'android'
      ? {
        localPlaybackFor: (recordingId: string) => {
          // Owned bytes first: a stored download wins; a local
          // file whose download was removed still plays from its
          // document URI. fileFor returns a bare ledger name —
          // resolve it to the transfer directory's file URI.
          const file = downloads.fileFor(recordingId);
          if (file !== null) {
            return downloadUriFor(file);
          }
          return localSource?.uriFor(recordingId) ?? null;
        },
        isOnline: () => lastOnline,
        isMetered: () => lastMetered,
      }
      : {}),
    // Commit-then-log over the in-process engine: every syncable
    // domain write emits mapped LocalWrites here post-commit. While
    // the surface is absent the writes buffer (drop-oldest) so
    // pre-bring-up edits still reach the log once it lands — the
    // surface assignment itself triggers the flush, no edit needed;
    // a failed flush re-pends the buffer.
    sync: {
      localChanges: (writes: readonly LocalWrite[], signal) =>
        emitWrites(writes, signal).then((result) => {
          // Committed writes trigger the spec's on-change sync —
          // the scheduler debounces the burst into one round.
          if (result.ok && writes.length > 0) {
            syncScheduler?.notifyLocalWrites();
          }
          return result;
        }),
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
      // Detach on settle — a long transfer must not accumulate one
      // controller per completed chunk on the shared signal.
      const abort = new AbortController();
      const unsub = signal.subscribe(() => abort.abort());
      return fetch(url, { headers: init.headers, signal: abort.signal }).finally(
        () => unsub(),
      );
    },
    resolvePlayback: async (ref, input, context) => {
      // Mint + re-mint route through the row's own sourceRef provider —
      // it alone can serve the same encoding at the durable offset.
      const provider = providerMap.get(ref.provider);
      if (provider === undefined) {
        return err(appError('unavailable', 'download provider not loaded'));
      }
      return provider.resolvePlayback(
        ref,
        {
          targetBitrateKbps: readyOr(
            (s) => s.settings.qualityKbps,
            defaults.qualityKbps,
          ),
          prefer: PREFERRED_CONTAINERS,
          pinItag: input.pinItag,
          resumeOffset: input.resumeOffset,
        },
        context,
      );
    },
    queue: () => readyOr((s) => s.queue, emptyQueue),
    settings: () => readyOr((s) => s.settings, defaults),
  });
  const { cache: artworkCache } = createExpoArtwork({
    storage,
    clock,
    ids,
    log: createLog(),
  });
  // Media-owner subscriptions made in start() — dispose() detaches
  // them so a second boot or an unmounted app can't double-fire.
  const mediaUnsubs: Array<() => void> = [];
  const buildLocalSource = (loaded: PersistedState) =>
    new LocalFileSource(
      { storage, tagReader: createExpoTagReader(host), ids, clock, log },
      {
        localSources: loaded.localSources,
        localFiles: loaded.localFiles,
        recordings: loaded.recordings,
      },
    );
  /**
   * A whole-library replace (import) swaps the persisted sections
   * out from under the media owners — re-init the download ledger
   * and rebuild the local source from the post-import snapshot
   * before the UI calls back in.
   */
  const reloadLocalSource = async (signal: CancellationSignal) => {
    // Retire BEFORE the load: a scan committing between the snapshot
    // and the swap would land its files in storage but never in the
    // new instance's index — drained first, every old commit lands in
    // the snapshot we actually read. `null` the slot up front so
    // `local()` never hands out a zombie while we rebuild.
    const superseded = localSource;
    localSource = null;
    await superseded?.retire();
    let loaded = await storage.load({
      requestId: ids.next('media-rehydrate'),
      deadlineMs: clock.nowMs() + 30_000,
      signal,
    });
    if (!loaded.ok && !signal.cancelled) {
      // A transient load failure must not strand intact rows — the
      // superseded source is gone, so retry the snapshot once on a
      // fresh signal. A cancelled caller bails without retrying:
      // teardown owns that signal.
      loaded = await storage.load({
        requestId: ids.next('media-rehydrate'),
        deadlineMs: clock.nowMs() + 30_000,
        signal: new CancellationSource().signal,
      });
    }
    if (!loaded.ok || signal.cancelled) {
      void log.write({
        level: 'warn',
        message: 'media rehydrate skipped: storage load failed',
        atMs: clock.nowMs(),
      });
      return null;
    }
    localSource = buildLocalSource(loaded.value);
    return loaded.value;
  };
  /**
   * Rehydrates serialize on a tail: overlapping callers (import
   * finally, applied-sync, boot) each rebuild in order, so an older
   * load can never overwrite a newer replacement instance.
   */
  let rehydrateTail: Promise<unknown> = Promise.resolve();
  const serializeRehydrate = <T>(run: () => Promise<T>): Promise<T> => {
    const next = rehydrateTail.then(run);
    // A throwing run must not poison the tail — the next queued
    // rehydrate still rebuilds in order.
    rehydrateTail = next.catch(() => undefined);
    return next;
  };
  const rehydrateMedia = (
    signal: CancellationSignal,
    rescanEmptyIndex = false,
  ): Promise<void> =>
    serializeRehydrate(() => doRehydrateMedia(signal, rescanEmptyIndex));
  const doRehydrateMedia = async (
    signal: CancellationSignal,
    rescanEmptyIndex: boolean,
  ): Promise<void> => {
    const loaded = await reloadLocalSource(signal);
    if (loaded === null) {
      return;
    }
    const inited = await downloads.init(loaded.downloads, signal);
    if (!inited.ok) {
      void log.write({
        level: 'warn',
        message: `download re-init failed: ${inited.error.kind}`,
        atMs: clock.nowMs(),
      });
    }
    // Imported recordings replace prior local rows — the session
    // re-merges provenance-local rows through this hook.
    session.syncLocalRecordings(localSource?.recordings() ?? []);
    const source = localSource;
    if (
      rescanEmptyIndex &&
      source !== null &&
      loaded.localSources.length > 0
    ) {
      // The import wiped the file index while the folder grants
      // survived — rescan rejoins the rows and re-extracts embedded
      // covers; without it imported recordings keep blank art until
      // a manual rescan.
      void source.rescan(undefined, signal).then((scanned) => {
        if (!scanned.ok) {
          void log.write({
            level: 'warn',
            message: `local: post-import rescan failed: ${scanned.error.kind}`,
            atMs: clock.nowMs(),
          });
          return;
        }
        // A later rehydrate may have swapped the instance mid-flight
        // — committing the captured one's snapshot would clobber rows
        // it never saw (same guard as afterLocalMutation).
        if (localSource === source) {
          session.syncLocalRecordings(source.recordings());
        }
      });
    }
  };
  const rehydrateLocal = (signal: CancellationSignal): Promise<void> =>
    serializeRehydrate(async () => {
      // NO downloads.init — a folder commit that lands on a superseded
      // source must not clear live transfer rows or sweep .part files.
      if ((await reloadLocalSource(signal)) !== null) {
        session.syncLocalRecordings(localSource?.recordings() ?? []);
      }
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
    searchHistory,
    peaksStore,
    sync: () => syncSurface,
    // A stale native module predating the pot seam has no such
    // function — the provider keeps its boot value rather than
    // crashing the sync-status effect that calls this.
    setPotProvider: (url) => host.setPotProvider?.(url),
    // A stale native module predating the auth seam has no such
    // function — report the miss so applyToken can fail the apply
    // rather than claiming a live bearer on the empty slot.
    setAuthToken: (token) => {
      if (typeof host.setAuthToken !== 'function') {
        return false;
      }
      host.setAuthToken(token);
      return true;
    },
    async start(signal) {
      // Post-restore reconcile: persisted slots name ids picked under
      // an earlier bundle or synced from a peer — repick any slot whose
      // provider no longer declares the slot's capability.
      const restored = session.snapshot();
      if (restored.type === 'ready') {
        const repaired = repairedSettings(restored.settings, providers);
        if (repaired !== null) {
          // Persist the reconciliation so the next boot restores clean.
          await session.updateSettings(repaired);
        }
      }
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
      if (signal.cancelled) {
        // Cleanup raced the load — do not un-stop the manager.
        return;
      }
      localSource = buildLocalSource(loaded.value);
      // Re-band pending downloads when the queue moves: a track that
      // becomes now-playing jumps the line.
      let queueRevision = readyOr((s) => s.queue.revision, 0);
      mediaUnsubs.push(
        session.subscribe((next) => {
          if (
            next.type !== 'ready' ||
            next.queue.revision === queueRevision
          ) {
            return;
          }
          queueRevision = next.queue.revision;
          void downloads.updatePriorities();
        }),
      );
      // dataSync FGS keep-alive: drive the service off the ledger —
      // 'transferring' rows only (queued/metered-waiting rows hold no
      // network and must not keep a foreground service posted). The
      // native surface is Android-only; iOS lacks the method — its
      // absence resolves to a warn, not a crash. Subscribed BEFORE
      // init so a restored transfer's first edge can't be missed.
      let lastActive = -1;
      // The same subscription watches the OWNED set: the session
      // projection resolves queued items through the ledger, so a
      // download completing (or a removal/integrity drop) must
      // re-derive or native Next keeps streaming a now-owned remote
      // ref — or attaches a file that no longer exists.
      let ownedIds = new Set<string>();
      mediaUnsubs.push(
        downloads.subscribe(() => {
          const rows = downloads.list();
          const active = rows.filter(
            (d) => d.state === 'transferring',
          ).length;
          if (active !== lastActive) {
            lastActive = active;
            // The foreground service counts EVERY download — this is
            // the media side of the aggregate (the update APK holds
            // its own ref through download-foreground), so reporting
            // can't zero another writer's protection.
            try {
              void mediaDownloadsActive(
                // Log the native failure, then rethrow — the
                // aggregate only marks an edge delivered on resolve,
                // so a swallowed rejection would suppress its retry.
                (count) =>
                  host.downloadsActiveChanged(count).catch((thrown) => {
                    void log.write({
                      level: 'warn',
                      message: `fgs update failed: ${nativeMessage(thrown)}`,
                      atMs: clock.nowMs(),
                    });
                    throw thrown;
                  }),
                active,
              );
            } catch {
              // Method absent on this platform — downloads still work;
              // only Doze-protected long transfers are degraded.
            }
          }
          const nowOwned = new Set(
            rows
              .filter((d) => d.state === 'available')
              .map((d) => d.recordingId),
          );
          const ownershipChanged =
            nowOwned.size !== ownedIds.size ||
            [...nowOwned].some((id) => !ownedIds.has(id));
          if (ownershipChanged) {
            ownedIds = nowOwned;
            session.connectivityChanged();
          }
        }),
      );
      // Offline gate feed: seed the cached read, then keep it live on
      // connectivity edges. Installed before downloads.init so the
      // monitor's baseline edge can't be missed.
      try {
        const seeded = await connectivity.snapshot();
        if (seeded.ok) {
          lastMetered = seeded.value.metered;
        }
        const online = seeded.ok ? seeded.value.online : false;
        if (online !== lastOnline) {
          // Seeding flipped the optimistic default — if restore
          // already projected remote refs, re-derive them now; the
          // monitor's identical baseline edge gets deduped below.
          lastOnline = online;
          session.connectivityChanged();
        }
      } catch {
        lastOnline = false;
        session.connectivityChanged();
      }
      try {
        mediaUnsubs.push(
          connectivity.subscribe((snap) => {
            const meteredChanged = snap.metered !== lastMetered;
            if (snap.online === lastOnline && !meteredChanged) {
              return;
            }
            // Update the gates' reads BEFORE the session re-derives —
            // connectivityChanged() consults them synchronously. A
            // metered flip with `online` steady still swings the
            // speculative-warm gate.
            lastOnline = snap.online;
            lastMetered = snap.metered;
            session.connectivityChanged();
            // Same edge drives the sync scheduler: offline cancels
            // pending rounds, recovery reschedules them.
            syncScheduler?.notifyConnectivity(snap.online);
          }),
        );
      } catch {
        // No monitor on this platform — the session stays optimistic.
      }
      const inited = await downloads.init(loaded.value.downloads, signal);
      if (!inited.ok) {
        log.write({
          level: 'warn',
          message: `download init failed: ${inited.error.kind}`,
          atMs: clock.nowMs(),
        });
      }
      // Final re-derive: a connectivity seed/edge during boot may
      // have projected while the download ledger was still empty —
      // replay the current truth now that owned files resolve. A
      // failed init leaves rows unverified — don't project them.
      if (inited.ok) {
        session.connectivityChanged();
      }
      // Startup sweep: reap anything the OS already reclaimed and
      // honor a budget shrunk last launch. Launched after the boot
      // loads AND download-ledger init — a populated cache would
      // otherwise queue a full-state read plus a stat per file on
      // the serialized storage tail ahead of boot-critical writes.
      // Fire-and-forget — the cache serializes it behind any early
      // `get` calls itself.
      void artworkCache.sweep({
        requestId: ids.next('artwork-sweep'),
        deadlineMs: clock.nowMs() + 60_000,
        signal: new CancellationSource().signal,
      });
      // Bounded refold shared by inbound merges and the bring-up
      // reconcile: attempt 1 folds the fresh batch, retries refold
      // the session's retained pending with [] — the backstop is
      // sized past the call's own internal op deadline so it abandons
      // only a wedged commit, never a healthy in-flight one.
      const refold = async <E>(
        first: readonly E[],
        fold: (
          entries: readonly E[],
          signal: CancellationSignal,
        ) => Promise<Result<SyncApplyReport>>,
        label: string,
      ): Promise<boolean> => {
        const result = await retryBounded({
          deadlineMs: clock.nowMs() + 300_000,
          signal,
          clock,
          maxAttempts: 4,
          baseBackoffMs: 400,
          call: (attemptSignal, attempt) =>
            fold(attempt === 1 ? first : [], attemptSignal),
        });
        if (signal.cancelled) {
          return false;
        }
        if (!result.ok) {
          void log.write({
            level: 'warn',
            message: `${label} failed: ${result.error.kind}`,
            atMs: clock.nowMs(),
          });
          return false;
        }
        if (result.value.rehydrateMedia) {
          void rehydrateMedia(signal);
        }
        return true;
      };
      // Slice-4 LAN sync: Android-only — iOS carries no socket seam.
      // Built last so the sync tables exist (restore ran migrations)
      // and the media owners are live before deltas can land. A
      // failed bring-up stays null — the settings row reports
      // 'unavailable' honestly instead of shipping a dead control.
      if (
        Platform.OS === 'android' &&
        host.hasSyncSocket?.() === true &&
        !signal.cancelled
      ) {
        const built = await createExpoSync({
          host,
          logStore: syncLogStore,
          ids,
          clock,
          log,
          // Every inbound merge — syncNow pages and any other
          // applyDelta path — projects onto the domain here. A
          // failed projection stays in the session's pending, so
          // refold with bounded retries rather than wait for an
          // inbound delta that may never come.
          onApplied: (applied) => {
            void refold(
              applied.outcomes,
              (entries, s) => session.applySyncedEntries(entries, s),
              'sync apply',
            ).catch(() => undefined);
          },
        });
        if (built.ok) {
          syncSurface = built.value;
          // Flush buffered pre-surface writes BEFORE the scheduler's
          // on-launch round — a round that exports first carries a
          // page missing them, and a flush landing after notifies
          // nobody, so they'd sit unsynced until the next trigger.
          // A failed flush re-pends the buffer with no other wake
          // until the next edit, so retry bounded here; a still-
          // failing prefix stays buffered for the next emitWrites
          // (and the boot reconcile's emitUnsynced re-stamps it).
          const flushed = await retryBounded({
            // Boot-critical: start() awaits this before the
            // scheduler's launch round, so a wedged batch must
            // time out promptly — a late commit still stamps the
            // log and a failure leaves the prefix re-pended.
            deadlineMs: clock.nowMs() + 30_000,
            signal,
            clock,
            maxAttempts: 4,
            baseBackoffMs: 400,
            call: (attemptSignal) => emitWrites([], attemptSignal),
          });
          if (!flushed.ok) {
            void log.write({
              level: 'warn',
              message: `sync pre-surface flush failed: ${flushed.error.kind}`,
              atMs: clock.nowMs(),
            });
          }
          // Trigger layer lives with the client: on-launch round per
          // peer now, debounced rounds on committed writes, reconnect
          // backoff on session drops, and rounds on the connectivity
          // recovery edge (wired into the monitor below).
          syncScheduler = createSyncScheduler({
            client: built.value.client,
            clock,
            log,
            isOnline: () => lastOnline,
          });
          syncScheduler.start();
          // Reconcile from the engine's materialized view ONCE at
          // bring-up — pending outcomes are in-memory only, so a kill
          // mid-apply loses them; the durable sync log keeps the
          // truth and this rebuild restores anything lost (Review
          // #46). Idempotent — outcomes that already projected just
          // re-fold to the same rows.
          void (async () => {
            const materialized = syncSurface.engine.materialize();
            const ok_ = await refold(
              materialized,
              (entries, s) => session.applyMaterializedEntries(entries, s),
              'sync reconcile',
            );
            if (!ok_) {
              return;
            }
            // The session's emit queue is memory-only — committed
            // writes a past kill stranded re-emit against the
            // materialized (kind, recordId)→fields map the same
            // view just walked: absent records AND stale field
            // values, upserts only (Review #46).
            const synced = new Map<string, Record<string, unknown>>();
            for (const rec of materialized) {
              synced.set(syncedRecordKey(rec.kind, rec.recordId), rec.fields);
            }
            await session.emitUnsynced(synced).catch(() => undefined);
          })().catch(() => undefined);
        } else {
          void log.write({
            level: 'warn',
            message: `sync bring-up failed: ${built.error.kind} — ${built.error.message}`,
            atMs: clock.nowMs(),
          });
        }
      }
    },
    rehydrateMedia,
    rehydrateLocal,
    async replaceLibrary(text, signal) {
      // Validate BEFORE the drain: a malformed document must not
      // destroy existing downloads. Session.importLibrary revalidates
      // for the atomic commit regardless.
      const previewed = previewImport(text);
      if (!previewed.ok) {
        return previewed;
      }
      // Drain first: a live runner could repersist a row the import
      // is about to swap out from under it. Capture the ledger NOW —
      // on success its rows are gone from storage, so the captured
      // file paths are the only reference to the old bytes.
      const priorRows = downloads.records();
      const stopped = await downloads.stop(signal);
      if (!stopped.ok) {
        void log.write({
          level: 'warn',
          message: `pre-import stop failed: ${stopped.error.kind}`,
          atMs: clock.nowMs(),
        });
        return err(stopped.error);
      }
      // An older import's post-swap rescan can still be in flight —
      // drain it before this swap lands or its commit resurrects
      // rows the previous import already replaced. `null` the slot so
      // `local()` never exposes the retired instance during the swap.
      const superseded = localSource;
      localSource = null;
      const hadSource = superseded !== null;
      await superseded?.retire();
      let importedOk = false;
      try {
        const imported = await session.importLibrary(text);
        importedOk = imported.ok;
        if (imported.ok) {
          // Imported settings may name providers this bundle lacks or
          // ids whose manifests no longer declare the slot — reconcile
          // through the same repair the boot path runs so playback
          // does not strand until the next restart.
          const snap = session.snapshot();
          if (snap.type === 'ready') {
            const repaired = repairedSettings(snap.settings, providers);
            if (repaired !== null) {
              await session.updateSettings(repaired);
            }
          }
          // The swap landed — delete the old ledger's files by their
          // captured paths. A failed import instead leaves the ledger
          // untouched; the finally's rehydrate resumes its rows.
          for (const row of priorRows) {
            const removed = await transfer.removeFile(row.filePath, signal);
            if (!removed.ok) {
              void log.write({
                level: 'warn',
                message: `post-import file delete failed for ${row.filePath}: ${removed.error.kind}`,
                atMs: clock.nowMs(),
              });
            }
          }
        }
        return imported;
      } finally {
        // Whatever landed — success, or a storage failure — the
        // manager re-inits off the persisted ledger so it can never
        // sit stopped with a stale row map.
        await rehydrateMedia(signal, importedOk);
        // A failed import plus a failed load (dead caller signal or a
        // transient error) must not strand the source slot null while
        // folder grants persist — retry the rebuild on a fresh signal.
        if (hadSource && localSource === null) {
          await rehydrateMedia(
            new CancellationSource().signal,
            importedOk,
          );
        }
      }
    },
    async dispose() {
      // Session FIRST: its graceful emit drain must run while the
      // sync surface is still live — after close() the emit port
      // would buffer the retained writes into a pre-surface queue
      // the dead controller discards, losing committed tombstones
      // (Review #46). dispose() also bars new session work, so the
      // client can't be re-entered once it goes down.
      await session.dispose();
      void localSource?.retire();
      // Scheduler before the client: its timers die here so no round
      // can fire against a closing socket surface.
      syncScheduler?.stop();
      syncScheduler = null;
      // Sync goes down next — bye frames flush while the sockets
      // still answer; a live session must never outlive its client.
      // A live share (listener + advert) dies with the session —
      // close is terminal; the UI-level stop is the reversible one.
      if (syncSurface !== null) {
        await syncSurface.host?.close();
        await syncSurface.client.close();
        syncSurface = null;
      }
      // Stop while the FGS subscriber is still attached — it emits the
      // zero-active update as stop demotes the last transferring row.
      await downloads.stop(new CancellationSource().signal);
      for (const unsub of mediaUnsubs.splice(0)) {
        unsub();
      }
      // Belt: start() may never have run, or an edge may have been
      // missed — report media zero through the same aggregate so an
      // in-flight non-media hold (the update APK) still counts.
      try {
        await mediaDownloadsActive(
          (count) => host.downloadsActiveChanged(count),
          0,
        );
      } catch {
        // Method absent on this platform.
      }
      for (const provider of providers) {
        provider.dispose();
      }
    },
  };
}
