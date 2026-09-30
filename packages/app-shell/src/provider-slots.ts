import { SLOT_META } from '@auqw/ui-shared';
import type {
  ProviderCapability,
  ProviderPort,
  Settings,
} from '@auqw/application';

/**
 * The provider-slot bootstrap both session controllers ran inline:
 * `defaultSettings` derives a fresh install's Settings (the storage
 * constructor requires them to name injected providers), and
 * `repairedSettings` reconciles restored slots against the provider
 * set this boot actually loaded.
 */

/** First provider declaring the slot's capability — the shipped id
 *  preferred, then any declarer; null when nothing can serve it. */
function pickProvider(
  providers: readonly ProviderPort[],
  capabilities: readonly ProviderCapability[],
  preferred: string,
): string | null {
  const declares = (p: ProviderPort) =>
    capabilities.some((capability) => p.capabilities.includes(capability));
  return (
    providers.find((p) => p.id === preferred && declares(p))?.id ??
    providers.find(declares)?.id ??
    null
  );
}

/**
 * Defaults for a fresh install (docs/specs/providers.md: quality
 * ≈ 128 kbps inside the 1–512 bound, storefront null defers to
 * system-locale → API-default resolution, theme 'system' and
 * prefetch true match the domain Settings contract). The provider
 * slots are derived per boot rather than hardcoded: a runtime plugin
 * dir may lack the bundled ids, and a manifest that drops the slot's
 * capability would strand a named id into `unsupported` routing —
 * prefer the shipped ids, else the first provider declaring the
 * slot's capability. A set with no declarer for a required slot
 * cannot boot — an id alone would only route every search/playback
 * into `unsupported`.
 */
export function defaultSettings(
  providers: readonly ProviderPort[],
): Settings {
  const catalog = pickProvider(
    providers,
    SLOT_META.catalogProvider.capabilities,
    'deezer',
  );
  const playback = pickProvider(
    providers,
    SLOT_META.playbackProvider.capabilities,
    'youtube-music',
  );
  const missing = [
    ...(catalog === null ? ['catalog.search'] : []),
    ...(playback === null ? ['playback.resolve'] : []),
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
 * Reconciles restored settings against the providers this boot
 * loaded: persisted slots name ids picked under an earlier bundle (or
 * synced from a peer whose plugin set differs), and a missing
 * capability strands every op routed to it. Required slots are
 * repicked through the capability map (a declarer is guaranteed by
 * the boot gate); optional overrides drop to `null` (auto routing)
 * rather than resurrecting a provider that cannot serve them.
 * Returns null when nothing needed repair.
 */
export function repairedSettings(
  settings: Settings,
  providers: readonly ProviderPort[],
): Settings | null {
  const declares = (
    id: string | null | undefined,
    capabilities: readonly ProviderCapability[],
  ): boolean => {
    const provider =
      id === null || id === undefined
        ? undefined
        : providers.find((p) => p.id === id);
    return (
      provider !== undefined &&
      capabilities.some((capability) =>
        provider.capabilities.includes(capability),
      )
    );
  };
  const next = { ...settings };
  let changed = false;
  for (const [slot, preferred] of [
    ['catalogProvider', 'deezer'],
    ['playbackProvider', 'youtube-music'],
  ] as const) {
    if (!declares(settings[slot], SLOT_META[slot].capabilities)) {
      const repaired = pickProvider(
        providers,
        SLOT_META[slot].capabilities,
        preferred,
      );
      if (repaired !== null) {
        next[slot] = repaired;
        changed = true;
      }
    }
  }
  for (const slot of ['lyricsProvider', 'radioProvider'] as const) {
    if (
      settings[slot] != null &&
      !declares(settings[slot], SLOT_META[slot].capabilities)
    ) {
      next[slot] = null;
      changed = true;
    }
  }
  return changed ? next : null;
}
