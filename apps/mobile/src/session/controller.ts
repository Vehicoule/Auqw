import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import {
  appError,
  CancellationSource,
  DownloadManager,
  err,
  LocalFileSource,
  previewImport,
  Session,
  syncedRecordKey,
} from '@auqw/application';
import type {
  ArtworkCache,
  CancellationSignal,
  ConnectivityPort,
  ImportPreview,
  LocalWrite,
  PlayerPort,
  ProviderPort,
  QueueSnapshot,
  Result,
  Settings,
} from '@auqw/application';
import { SqliteStorage, SqliteSyncLogStore } from '@auqw/storage-sqlite';
import type {
  AuqwConnectivityNative,
  AuqwDownloadsNative,
  AuqwExpoHostModuleLike,
  AuqwSyncNative,
  AuqwTagReaderNative,
} from '../adapters/auqw-expo-surface.ts';
import { createExpoArtwork } from '../adapters/expo-artwork.ts';
import { createExpoAudioPlayer } from '../adapters/expo-audio-player.ts';
import type { PluginProvider } from '../adapters/plugin-provider.ts';
import {
  createPluginProvider,
  manifestCapabilities,
} from '../adapters/plugin-provider.ts';
import {
  createExpoConnectivity,
  createUnwatchedConnectivity,
} from '../adapters/expo-connectivity.ts';
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
} from '../adapters/runtime.ts';
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
  rehydrateMedia(signal: CancellationSignal): Promise<void>;
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
  const sqliteDriver = await createExpoSqliteDriver(options.databasePath);
  const storage = new SqliteStorage(
    sqliteDriver,
    DEFAULT_SETTINGS,
  );
  // Sync-log tables ride the same file + driver — the shared
  // transaction tail serializes sync writes with library writes.
  const syncLogStore = new SqliteSyncLogStore(sqliteDriver);
  // Assembled in start() after restore: custody → engine → client.
  let syncSurface: ExpoSyncSurface | null = null;
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
  const player = (options.player ?? ((map) => {
    return createExpoAudioPlayer({
      providers: map,
      ids: createIds(),
      qualityKbps: DEFAULT_SETTINGS.qualityKbps,
    });
  }))(providerMap);
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
  const log = createLog();
  const session = new Session({
    storage,
    player,
    providers,
    clock,
    ids,
    random: createRandom(),
    log,
    defaults: DEFAULT_SETTINGS,
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
        emitWrites(writes, signal),
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
    resolvePlayback: (ref, input, context) => {
      // Mint + re-mint route through the row's own sourceRef provider —
      // it alone can serve the same encoding at the durable offset.
      const provider = providerMap.get(ref.provider);
      if (provider === undefined) {
        return Promise.resolve({
          ok: false as const,
          error: appError('unavailable', 'download provider not loaded'),
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
  // Media-owner subscriptions made in start() — dispose() detaches
  // them so a second boot or an unmounted app can't double-fire.
  const mediaUnsubs: Array<() => void> = [];
  /**
   * A whole-library replace (import) swaps the persisted sections
   * out from under the media owners — re-init the download ledger
   * and rebuild the local source from the post-import snapshot
   * before the UI calls back in.
   */
  const rehydrateMedia = async (
    signal: CancellationSignal,
  ): Promise<void> => {
    const loaded = await storage.load({
      requestId: ids.next('media-rehydrate'),
      deadlineMs: clock.nowMs() + 30_000,
      signal,
    });
    if (!loaded.ok || signal.cancelled) {
      void log.write({
        level: 'warn',
        message: 'media rehydrate skipped: storage load failed',
        atMs: clock.nowMs(),
      });
      return;
    }
    localSource = new LocalFileSource(
      { storage, tagReader: createExpoTagReader(host), ids, clock, log },
      {
        localSources: loaded.value.localSources,
        localFiles: loaded.value.localFiles,
        recordings: loaded.value.recordings,
      },
    );
    const inited = await downloads.init(loaded.value.downloads, signal);
    if (!inited.ok) {
      void log.write({
        level: 'warn',
        message: `download re-init failed: ${inited.error.kind}`,
        atMs: clock.nowMs(),
      });
    }
    // Imported recordings replace prior local rows — the session
    // re-merges provenance-local rows through this hook.
    session.syncLocalRecordings(localSource.recordings());
  };
  return {
    session,
    storage,
    providers,
    player,
    artworkCache,
    downloads,
    local: () => localSource,
    connectivity,
    sync: () => syncSurface,
    setPotProvider: (url) => {
      // A stale native module predating the pot seam has no such
      // function — the provider keeps its boot value rather than
      // crashing the sync-status effect that calls this.
      if (typeof host.setPotProvider === 'function') {
        host.setPotProvider(url);
      }
    },
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
      if (signal.cancelled) {
        // Cleanup raced the load — do not un-stop the manager.
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
          void downloads.updatePriorities(new CancellationSource().signal);
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
            if (snap.online === lastOnline) {
              return;
            }
            // Update the gate's read BEFORE the session re-derives —
            // connectivityChanged() reads isOnline() synchronously.
            lastOnline = snap.online;
            session.connectivityChanged();
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
            void (async () => {
              let result = await session.applySyncedEntries(
                applied.outcomes,
              );
              for (
                let attempt = 0;
                !result.ok && attempt < 3 && !signal.cancelled;
                attempt += 1
              ) {
                await new Promise<void>((resolve) =>
                  setTimeout(resolve, 400 * (attempt + 1)),
                );
                if (signal.cancelled) {
                  return;
                }
                result = await session.applySyncedEntries([]);
              }
              if (!result.ok) {
                void log.write({
                  level: 'warn',
                  message: `sync apply failed: ${result.error.kind}`,
                  atMs: clock.nowMs(),
                });
                return;
              }
              if (result.value.rehydrateMedia) {
                void rehydrateMedia(signal);
              }
            })().catch(() => undefined);
          },
        });
        if (built.ok) {
          syncSurface = built.value;
          // Reconcile from the engine's materialized view ONCE at
          // bring-up — pending outcomes are in-memory only, so a kill
          // mid-apply loses them; the durable sync log keeps the
          // truth and this rebuild restores anything lost (Review
          // #46). Idempotent — outcomes that already projected just
          // re-fold to the same rows.
          void (async () => {
            const materialized = syncSurface.engine.materialize();
            let applied = await session.applyMaterializedEntries(
              materialized,
            );
            // A failed apply keeps the whole union in the session's
            // retained pending — refold with bounded retries rather
            // than drop the recovery page until restart (Review #46).
            for (
              let attempt = 0;
              !applied.ok && attempt < 3 && !signal.cancelled;
              attempt += 1
            ) {
              await new Promise<void>((resolve) =>
                setTimeout(resolve, 400 * (attempt + 1)),
              );
              if (signal.cancelled) {
                return;
              }
              applied = await session.applyMaterializedEntries([]);
            }
            if (!applied.ok) {
              void log.write({
                level: 'warn',
                message: `sync reconcile failed: ${applied.error.kind}`,
                atMs: clock.nowMs(),
              });
              return;
            }
            if (applied.value.rehydrateMedia) {
              void rehydrateMedia(signal);
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
          // Flush buffered pre-surface writes NOW — the next edit
          // may never come, and the buffer only rides emit calls.
          void emitWrites([]).then((flushed) => {
            if (!flushed.ok) {
              void log.write({
                level: 'warn',
                message: `sync pre-surface flush failed: ${flushed.error.kind}`,
                atMs: clock.nowMs(),
              });
            }
          });
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
      try {
        const imported = await session.importLibrary(text);
        if (imported.ok) {
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
        await rehydrateMedia(signal);
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
      // Sync goes down next — bye frames flush while the sockets
      // still answer; a live session must never outlive its client.
      if (syncSurface !== null) {
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
      // missed — the dataSync service must come down regardless.
      try {
        await host.downloadsActiveChanged(0);
      } catch {
        // Method absent on this platform.
      }
      for (const provider of providers) {
        provider.dispose();
      }
    },
  };
}
