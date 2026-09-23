import { Session } from '@auqw/application';
import type {
  ClockPort,
  IdPort,
  LogPort,
  PlayerPort,
  ProviderCapability,
  Settings,
  StoragePort,
} from '@auqw/application';
import { SqliteStorage } from '@auqw/storage-sqlite';
import type { AuqwApi } from '../shared/contract.ts';
import type { MediaSourceLike } from './mse-source.ts';
import type { MseFactories } from './mse-source.ts';
import {
  createPluginProvider,
  manifestCapabilities,
} from './provider.ts';
import type { PluginProvider } from './provider.ts';
import { createSqliteDriver } from './sqlite-driver.ts';
import { createClock, createIds, createLog } from './runtime.ts';
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
  /** The session's synchronous connectivity read — kept by net events. */
  readonly isOnline: () => boolean;
  /**
   * UI-side edges for the same value — the session snapshot does not
   * carry connectivity, so the offline banner and play gates read
   * this stream instead of the session's subscribe.
   */
  readonly subscribeOnline: (listener: (online: boolean) => void) => () => void;
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
 * plugin manifest, and connectivity feeding the session's zero-
 * resolution gate. `localPlaybackFor` stays unset until Phase 4.
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

  // Optimistic-online baseline; the net subscribe path pushes the live
  // state immediately on platforms that report it, and the snapshot is
  // the fallback seed. Every transition re-runs the session's
  // connectivity reconciliation.
  let lastOnline = true;
  const session = new Session({
    storage,
    player,
    providers,
    clock: options?.clock ?? createClock(),
    ids: options?.ids ?? createIds(),
    log: options?.log ?? createLog(),
    defaults,
    isOnline: () => lastOnline,
  });
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

  return {
    session,
    storage,
    providers,
    player,
    isOnline: () => lastOnline,
    subscribeOnline,
    async dispose() {
      unsubscribeNet();
      await session.dispose();
      for (const provider of providers) {
        provider.dispose();
      }
    },
  };
}
