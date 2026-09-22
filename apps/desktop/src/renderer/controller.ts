import { Session } from '@auqw/application';
import type {
  ClockPort,
  IdPort,
  LogPort,
  PlayerPort,
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
 * Defaults for a fresh install — identical to the mobile controller's
 * (docs/specs/providers.md: quality ≈ 128 kbps inside the 1–512 bound,
 * storefront null defers to system-locale → API-default resolution,
 * theme 'system' and prefetch true match the domain Settings contract).
 * The provider slots are derived per boot: the constructor requires
 * the defaults to name injected providers, and a runtime plugin dir
 * may lack the mobile bundle's exact ids — prefer the shipped ids,
 * else the first provider declaring the slot's capability.
 */
function defaultSettings(
  providers: readonly PluginProvider[],
): Settings {
  const pick = (
    capability: 'catalog.search' | 'playback.resolve',
    preferred: string,
  ): string =>
    providers.find(
      (p) => p.id === preferred && p.capabilities.includes(capability),
    )?.id ??
    providers.find((p) => p.capabilities.includes(capability))?.id ??
    providers[0]?.id ??
    '';
  return {
    catalogProvider: pick('catalog.search', 'itunes'),
    playbackProvider: pick('playback.resolve', 'youtube-music'),
    storefront: null,
    qualityKbps: 128,
    theme: 'system',
    prefetch: true,
  };
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
