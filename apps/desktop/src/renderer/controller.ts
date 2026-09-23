import {
  appError,
  CancellationSource,
  DownloadManager,
  err,
  LocalFileSource,
  ok,
  previewImport,
  Session,
} from '@auqw/application';
import type {
  CancellationSignal,
  ClockPort,
  ConnectivityPort,
  IdPort,
  LocalWrite,
  LogPort,
  MergeOutcome,
  PlayerPort,
  ProviderCapability,
  QueueSnapshot,
  Settings,
  StoragePort,
} from '@auqw/application';
import { SqliteStorage } from '@auqw/storage-sqlite';
import type { AuqwApi } from '../shared/contract.ts';
import { createDesktopConnectivity } from './connectivity.ts';
import { createLocalPlayback } from './local-playback.ts';
import { createDesktopTagReader } from './tag-reader.ts';
import { createDesktopTransfer } from './transfer-port.ts';
import type { MediaSourceLike } from './mse-source.ts';
import type { MseFactories } from './mse-source.ts';
import {
  createPluginProvider,
  manifestCapabilities,
} from './provider.ts';
import type { PluginProvider } from './provider.ts';
import { createSqliteDriver } from './sqlite-driver.ts';
import { createClock, createIds, createLog } from './runtime.ts';
import { shellToAppError } from './ipc-errors.ts';
import { createWebPlayerPort } from './web-player.ts';
import type { MediaSessionLike } from './web-player.ts';

/**
 * The provider-slot → routing-capability map mirrored from the app's
 * settings pickers: a slot value is only meaningful while a provider
 * with that id declares one of the slot's capabilities.
 */
const SLOT_CAPABILITIES = {
  catalogProvider: ['catalog.search'],
  playbackProvider: ['playback.resolve'],
  lyricsProvider: ['lyrics.synced', 'lyrics.plain'],
  radioProvider: ['radio.seed'],
} as const;

/** First provider declaring the slot's capability — the shipped id
 *  preferred, then any declarer; null when nothing can serve it. */
function pickProvider(
  providers: readonly PluginProvider[],
  capabilities: readonly ProviderCapability[],
  preferred: string,
): string | null {
  const declares = (p: PluginProvider) =>
    capabilities.some((capability) => p.capabilities.includes(capability));
  return (
    providers.find((p) => p.id === preferred && declares(p))?.id ??
    providers.find(declares)?.id ??
    null
  );
}

/**
 * Defaults for a fresh install — identical to the mobile controller's
 * (docs/specs/providers.md: quality ≈ 128 kbps inside the 1–512 bound,
 * storefront null defers to system-locale → API-default resolution,
 * theme 'system' and prefetch true match the domain Settings contract).
 * The provider slots are derived per boot: the constructor requires
 * the defaults to name injected providers, and a runtime plugin dir
 * may lack the mobile bundle's exact ids — prefer the shipped ids,
 * else the first provider declaring the slot's capability. A set with
 * no declarer for a required slot cannot boot — an id alone would
 * only route every search/playback into `unsupported`.
 */
function defaultSettings(
  providers: readonly PluginProvider[],
): Settings {
  const catalog = pickProvider(
    providers,
    SLOT_CAPABILITIES.catalogProvider,
    'itunes',
  );
  const playback = pickProvider(
    providers,
    SLOT_CAPABILITIES.playbackProvider,
    'youtube-music',
  );
  const missing = [
    ...(catalog === null ? (['catalog.search'] as const) : []),
    ...(playback === null ? (['playback.resolve'] as const) : []),
  ];
  if (catalog === null || playback === null) {
    throw new Error(
      `no provider declares ${missing.join(' / ')} — the plugin set cannot serve a session`,
    );
  }
  return {
    catalogProvider: catalog,
    playbackProvider: playback,
    storefront: null,
    qualityKbps: 128,
    theme: 'system',
    prefetch: true,
  };
}

/**
 * Reconciles restored settings against the providers this boot loaded:
 * persisted slots name ids picked under an earlier plugin dir, and a
 * removed plugin strands every op routed to it. Required slots are
 * repicked through the capability map (a declarer is guaranteed by the
 * boot gate); optional overrides drop to `null` (auto routing) rather
 * than resurrecting a provider that cannot serve them. Returns null
 * when nothing needed repair.
 */
function repairedSettings(
  settings: Settings,
  providers: readonly PluginProvider[],
): Settings | null {
  const declares = (
    id: string | null | undefined,
    capabilities: readonly ProviderCapability[],
  ): boolean => {
    if (id === null || id === undefined) {
      return false;
    }
    const provider = providers.find((p) => p.id === id);
    return (
      provider !== undefined &&
      capabilities.some((capability) =>
        provider.capabilities.includes(capability),
      )
    );
  };
  const next = { ...settings };
  let changed = false;
  if (!declares(settings.catalogProvider, SLOT_CAPABILITIES.catalogProvider)) {
    const repaired = pickProvider(
      providers,
      SLOT_CAPABILITIES.catalogProvider,
      'itunes',
    );
    if (repaired !== null) {
      next.catalogProvider = repaired;
      changed = true;
    }
  }
  if (
    !declares(settings.playbackProvider, SLOT_CAPABILITIES.playbackProvider)
  ) {
    const repaired = pickProvider(
      providers,
      SLOT_CAPABILITIES.playbackProvider,
      'youtube-music',
    );
    if (repaired !== null) {
      next.playbackProvider = repaired;
      changed = true;
    }
  }
  for (const slot of ['lyricsProvider', 'radioProvider'] as const) {
    if (
      settings[slot] != null &&
      !declares(settings[slot], SLOT_CAPABILITIES[slot])
    ) {
      next[slot] = null;
      changed = true;
    }
  }
  return changed ? next : null;
}

/**
 * The MSE factories a real browser context supplies — `MediaSource`
 * plus blob object URLs. Absent under Node/tests the web player keeps
 * only the serve-url leg.
 */
function browserMse(): MseFactories | null {
  return typeof MediaSource === 'function'
    ? {
        // The DOM types are wider than the portable interface
        // (BufferSource vs Uint8Array) — narrow them here.
        createSource: () =>
          new MediaSource() as unknown as MediaSourceLike,
        createObjectURL: (source: unknown) =>
          URL.createObjectURL(source as MediaSource),
        revokeObjectURL: (url: string) => URL.revokeObjectURL(url),
        isTypeSupported: (mime: string) => MediaSource.isTypeSupported(mime),
      }
    : null;
}

export type SessionController = {
  readonly session: Session;
  readonly storage: StoragePort;
  readonly providers: readonly PluginProvider[];
  readonly player: PlayerPort;
  /** The download ledger — `init`d post-restore inside the controller. */
  readonly downloads: DownloadManager;
  /**
   * Local-files index — null until the media owners come up post-
   * restore (its constructor takes the committed rows). UI must
   * render a null-local state honestly.
   */
  readonly local: () => LocalFileSource | null;
  readonly connectivity: ConnectivityPort;
  /** The session's synchronous connectivity read — kept by net events. */
  readonly isOnline: () => boolean;
  /**
   * UI-side edges for the same value — the session snapshot does not
   * carry connectivity, so the offline banner and play gates read
   * this stream instead of the session's subscribe.
   */
  readonly subscribeOnline: (listener: (online: boolean) => void) => () => void;
  /**
   * The same probe the session resolves offline playback through —
   * UI gates read it so an owned local row stays playable without
   * connectivity (a remote ref still honestly refuses).
   */
  readonly localPlaybackFor: (recordingId: string) => string | null;
  /**
   * Re-loads persisted state into the media owners after a
   * whole-library replace (import): rebuilds the local source and
   * re-inits the download ledger so their rows can't go stale.
   */
  rehydrateMedia(signal: CancellationSignal): Promise<void>;
  /**
   * Whole-library replace with the file plane drained first — a live
   * transfer runner would otherwise repersist a ledger row the import
   * just swapped out. Mirrors the mobile replaceLibrary flow.
   */
  replaceLibrary(
    text: string,
    signal: CancellationSignal,
  ): ReturnType<Session['importLibrary']>;
  dispose(): Promise<void>;
};

export type SessionControllerOptions = {
  /** Storage seam — tests inject an in-memory port; real boot builds
   *  SqliteStorage over the IPC driver. */
  readonly storage?: StoragePort | undefined;
  /** Player seam — real boot builds the web player over `api.stream`. */
  readonly player?: PlayerPort | undefined;
  /** Provider seam — real boot builds per-manifest providers over
   *  `api.host`; injection skips the plugins() call entirely. */
  readonly providers?: readonly PluginProvider[] | undefined;
  readonly clock?: ClockPort | undefined;
  readonly ids?: IdPort | undefined;
  readonly log?: LogPort | undefined;
};

/**
 * Boots the application Session inside the renderer: SqliteStorage
 * over the txId-pinned IPC driver, the web player over `api.stream`
 * (MSE primary + serve-url fallback), providers built per loaded
 * plugin manifest, connectivity feeding the session's zero-
 * resolution gate, and the file plane — DownloadManager over
 * `api.transfer` plus LocalFileSource over `api.tagread` — feeding
 * `localPlaybackFor` so owned bytes resolve to `provider:'local'`.
 */
export async function createSessionController(
  api: AuqwApi,
  options?: SessionControllerOptions,
): Promise<SessionController> {
  let providers: readonly PluginProvider[];
  if (options?.providers !== undefined) {
    providers = options.providers;
  } else {
    const hostResult = await api.host.plugins();
    providers =
      hostResult.bindings === 'loaded'
        ? hostResult.manifests.map((manifest) =>
            createPluginProvider(
              api.host,
              manifest.pluginId,
              manifest.providerId,
              manifestCapabilities(manifest),
            ),
          )
        : [];
  }
  if (providers.length === 0) {
    // Nothing can route — the Session constructor would only fail
    // deeper on an unresolvable default-provider pick.
    throw new Error(
      'no plugin providers available (host bindings unloaded or empty plugin dir)',
    );
  }
  const defaults = defaultSettings(providers);
  const storage =
    options?.storage ??
    new SqliteStorage(createSqliteDriver(api.storage), defaults);
  const player =
    options?.player ??
    createWebPlayerPort({
      stream: api.stream,
      audio: new Audio(),
      mediaSession:
        'mediaSession' in navigator
          ? (navigator.mediaSession as MediaSessionLike)
          : null,
      mse: browserMse(),
    });

  const clock = options?.clock ?? createClock();
  const ids = options?.ids ?? createIds();
  const log = options?.log ?? createLog();

  // The file plane: the transfer port is the download sink, the tag
  // reader enumerates granted folders, and the net monitor doubles
  // as the engines' ConnectivityPort. `localSource` and `mediaDir`
  // fill in around restore — the session's playback hook reads the
  // closure boxes live so a URI resolves the moment a source exists.
  const connectivity = createDesktopConnectivity(api);
  const transfer = createDesktopTransfer(api);
  const tagReader = createDesktopTagReader(api);
  let localSource: LocalFileSource | null = null;
  // The media dir comes over IPC — fill in async. Until it lands the
  // download leg answers null honestly; the local-file leg's docUri
  // math never needed it.
  let mediaDir: string | null = null;
  const uriForHook = (id: string): string | null =>
    localSource?.uriFor(id) ?? null;
  let probe: ((id: string) => string | null) | null = null;
  void api.app
    .meta()
    .then((meta) => {
      mediaDir = `${meta.userDataPath}/media`;
      probe = createLocalPlayback({
        mediaDir,
        fileFor: (id) => downloads.fileFor(id),
        uriFor: uriForHook,
      });
    })
    .catch(() => {
      // meta() failed — owned downloads can't form file:// URIs and
      // stay inert; local files still resolve through uriForHook.
    });

  // Optimistic-online baseline; the net subscribe path pushes the live
  // state immediately on platforms that report it, and the snapshot is
  // the fallback seed. Every transition re-runs the session's
  // connectivity reconciliation.
  let lastOnline = true;
  const localPlaybackFor = (id: string): string | null =>
    probe?.(id) ?? uriForHook(id);
  const session = new Session({
    storage,
    player,
    providers,
    clock,
    ids,
    log,
    defaults,
    // `probe`/`localSource` are closure boxes — both fill in after
    // construction (probe on the meta round-trip, localSource at
    // rehydrate) and are read on every probe.
    localPlaybackFor,
    isOnline: () => lastOnline,
    // Commit-then-log: every syncable domain write emits mapped
    // LocalWrites here post-commit; the utility stamps them into the
    // change log so this device's edits reach peers. Best-effort —
    // the session surfaces a failed emit, never rolls the write back.
    sync: {
      localChanges: async (writes: readonly LocalWrite[]) => {
        try {
          const result = await api.sync.localChanges({ writes });
          return ok(result.result);
        } catch (thrown) {
          return err(shellToAppError(thrown));
        }
      },
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
  const providerMap = new Map(providers.map((p) => [p.id, p]));
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
      const provider = providerMap.get(
        readyOr(
          (s) => s.settings.playbackProvider,
          defaults.playbackProvider,
        ),
      );
      if (provider === undefined) {
        return Promise.resolve(
          err(appError('unavailable', 'playback provider not loaded')),
        );
      }
      return provider.resolvePlayback(
        ref,
        {
          targetBitrateKbps: readyOr(
            (s) => s.settings.qualityKbps,
            defaults.qualityKbps,
          ),
          prefer: ['audio/webm', 'audio/mp4'],
          pinItag: input.pinItag,
          resumeOffset: input.resumeOffset,
        },
        context,
      );
    },
    queue: () => readyOr((s) => s.queue, emptyQueue),
    settings: () => readyOr((s) => s.settings, defaults),
  });
  // Media-owner subscriptions — dispose() detaches them.
  const mediaUnsubs: Array<() => void> = [];
  // The owned set drives re-derivation: a download completing (or a
  // removal/integrity drop) must re-project or the player keeps a
  // stale remote ref — or attaches a file that no longer exists.
  let ownedIds = new Set<string>();
  mediaUnsubs.push(
    downloads.subscribe(() => {
      const nowOwned = new Set(
        downloads
          .list()
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
  /**
   * Bring-up + post-import refresh: loads persisted state into the
   * media owners — the local source rebuilds off the committed rows
   * and the download ledger re-inits. After an import the session
   * re-adopts provenance-local rows from the source's snapshot.
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
      { storage, tagReader, ids, clock, log },
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
        message: `download init failed: ${inited.error.kind}`,
        atMs: clock.nowMs(),
      });
      return;
    }
    // Imported recordings replace prior local rows — the session
    // re-merges provenance-local rows through this hook.
    void session.syncLocalRecordings(localSource.recordings());
  };
  let edged = false;
  const onlineListeners = new Set<(online: boolean) => void>();
  const applyOnline = (online: boolean): void => {
    lastOnline = online;
    session.connectivityChanged();
    for (const listener of onlineListeners) {
      listener(online);
    }
  };
  const subscribeOnline = (listener: (online: boolean) => void): (() => void) => {
    onlineListeners.add(listener);
    // Emit the settled value — a subscriber that mounts after the
    // baseline edge must not wait for the next transition.
    listener(lastOnline);
    return () => {
      onlineListeners.delete(listener);
    };
  };
  let unsubscribeNet: () => void = () => {};
  try {
    unsubscribeNet = api.net.subscribe((event) => {
      edged = true;
      applyOnline(event.online);
    });
  } catch {
    // Edge-less net: snapshot-only honesty — a subscribe failure must
    // not take the mounted session down.
  }
  void api.net
    .snapshot()
    .then((snap) => {
      if (!edged) {
        applyOnline(snap.online);
      }
    })
    .catch(() => {
      // A failed snapshot keeps the optimistic baseline — never a
      // fabricated offline.
    });

  // Remote-applied merge outcomes ride the utility's drain channel —
  // project them into the domain db once at boot and again on every
  // `sync:applied` push. The loop re-drains until the outbox empties
  // (each pull is byte-bounded); a failed projection stays queued in
  // the session's own pending buffer, so it retries on the next drain.
  // Gate drains until the session is ready: applySyncedEntries runs a
  // storage segment and keeps failed outcomes only inside `ready` — a
  // pre-restore apply would drop them, so `sync:applied` pushes that
  // arrive early simply leave the utility's outbox queued for the
  // boot drain below.
  let drainArmed = false;
  let unsubscribeApplied: () => void = () => {};
  const drainApplied = async (): Promise<void> => {
    for (;;) {
      const batch = await api.sync.drainApplied();
      if (batch.outcomes.length > 0) {
        const applied = await session.applySyncedEntries(
          batch.outcomes as readonly MergeOutcome[],
        );
        if (!applied.ok) {
          void log.write({
            level: 'warn',
            message: `sync apply failed: ${applied.error.kind}`,
            atMs: clock.nowMs(),
          });
          return;
        }
      }
      if (batch.remaining === 0) {
        return;
      }
    }
  };
  try {
    unsubscribeApplied = api.sync.onApplied(() => {
      if (drainArmed) {
        void drainApplied().catch(() => undefined);
      }
    });
  } catch {
    // Push-less sync surface — the boot drain still runs.
  }

  // restore() never throws — its Result surfaces through session state
  // as 'restore-failed'.
  await session.restore();
  const restored = session.snapshot();
  if (restored.type === 'ready') {
    const repaired = repairedSettings(restored.settings, providers);
    if (repaired !== null) {
      // Persist the reconciliation so the next boot restores clean.
      await session.updateSettings(repaired);
    }
  }
  // Media owners come up after restore — their constructors take the
  // committed rows, which only settle once restore's own writes land.
  const bootSignal = new CancellationSource().signal;
  await rehydrateMedia(bootSignal);
  // Final re-derive: the ledger's owned set was empty when restore
  // projected remote refs — replay the truth now that owned files
  // resolve.
  session.connectivityChanged();

  // Arm the drain last: the session is ready, media owners hold the
  // committed rows, and anything queued during boot folds now.
  drainArmed = true;
  void drainApplied().catch(() => undefined);

  return {
    session,
    storage,
    providers,
    player,
    downloads,
    local: () => localSource,
    connectivity,
    isOnline: () => lastOnline,
    subscribeOnline,
    localPlaybackFor,
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
      unsubscribeApplied();
      unsubscribeNet();
      await downloads.stop(new CancellationSource().signal);
      for (const unsub of mediaUnsubs.splice(0)) {
        unsub();
      }
      await session.dispose();
      for (const provider of providers) {
        provider.dispose();
      }
    },
  };
}
