import type { OperationContext } from '../cancellation.ts';
import type { Settings } from '../domain.ts';
import type { EntityRef, SourceRef } from '../domain.ts';
import type { Result } from '../errors.ts';
import { appError, err, ok } from '../errors.ts';
import type {
  EntityPage,
  LyricsPreference,
  LyricsQuery,
  LyricsResult,
  ProviderCapability,
  ProviderPort,
  RadioPage,
  RadioSeed,
} from '../ports/provider.ts';

/**
 * The settings-side input to routing: one configured provider per
 * capability family. `lyricsProvider`/`radioProvider` may be `null`,
 * which leaves the capability to automatic resolution — the sole
 * declaring provider serves it, and for `radio.seed` the playback
 * provider is preferred among declarers.
 */
export type ProviderSelection = {
  readonly catalogProvider: string;
  readonly playbackProvider: string;
  readonly lyricsProvider: string | null;
  readonly radioProvider: string | null;
};

export function selectionFromSettings(settings: Settings): ProviderSelection {
  return {
    catalogProvider: settings.catalogProvider,
    playbackProvider: settings.playbackProvider,
    lyricsProvider: settings.lyricsProvider ?? null,
    radioProvider: settings.radioProvider ?? null,
  };
}

function unsupported(capability: ProviderCapability) {
  return appError('unsupported', `no active provider for ${capability}`);
}

/** The settings slot a capability resolves through, or null for auto. */
function configuredId(
  capability: ProviderCapability,
  selection: ProviderSelection,
): string | null {
  switch (capability) {
    case 'catalog.search':
    case 'catalog.metadata':
    case 'catalog.artwork':
    case 'catalog.entity':
      return selection.catalogProvider;
    case 'playback.candidates':
    case 'playback.resolve':
      return selection.playbackProvider;
    case 'lyrics.plain':
    case 'lyrics.synced':
      return selection.lyricsProvider;
    case 'radio.seed':
      return selection.radioProvider;
  }
}

/**
 * Capability routing (providers.md): exactly one active provider per
 * capability, resolved from settings plus declared capabilities —
 * never name routing, never aggregation. A capability nothing
 * declares is a typed `unsupported`, and a routed provider's failure
 * is never masked by trying another provider: failover is a
 * decision-log event, not a default.
 */
export class ProviderRouter {
  readonly #providers: ReadonlyMap<string, ProviderPort>;
  /** Capability → declaring providers, registration order. */
  readonly #byCapability: ReadonlyMap<ProviderCapability, ProviderPort[]>;

  constructor(providers: readonly ProviderPort[]) {
    const byId = new Map<string, ProviderPort>();
    const byCapability = new Map<ProviderCapability, ProviderPort[]>();
    for (const provider of providers) {
      if (
        typeof provider.id !== 'string' ||
        provider.id.length === 0 ||
        byId.has(provider.id)
      ) {
        throw new TypeError('provider ids must be unique and nonempty');
      }
      byId.set(provider.id, provider);
      for (const capability of provider.capabilities) {
        const list = byCapability.get(capability) ?? [];
        list.push(provider);
        byCapability.set(capability, list);
      }
    }
    this.#providers = byId;
    this.#byCapability = byCapability;
  }

  /** A provider serves a capability only when it declared it. */
  #serve(providerId: string, capability: ProviderCapability) {
    const provider = this.#providers.get(providerId);
    if (provider === undefined || !provider.capabilities.includes(capability)) {
      return err(unsupported(capability));
    }
    return ok(provider);
  }

  /**
   * The single active provider for a capability. Configured slots
   * (`catalog.*` → `catalogProvider`, `playback.*` → `playbackProvider`,
   * `lyrics.*`/`radio.seed` → their overrides) are authoritative: a
   * configured provider that does not declare the capability is
   * `unsupported`, not silently rerouted. Unset lyrics/radio slots
   * resolve automatically over declared capabilities.
   */
  providerFor(
    capability: ProviderCapability,
    selection: ProviderSelection,
  ): Result<ProviderPort> {
    const configured = configuredId(capability, selection);
    if (configured !== null) {
      return this.#serve(configured, capability);
    }
    const declarers = this.#byCapability.get(capability) ?? [];
    if (capability === 'radio.seed') {
      // Radio grows the queue with candidates that must resolve —
      // the playback provider's own seeds stay directly playable.
      const preferred = declarers.find(
        (p) => p.id === selection.playbackProvider,
      );
      if (preferred !== undefined) {
        return ok(preferred);
      }
    }
    const first = declarers[0];
    return first === undefined ? err(unsupported(capability)) : ok(first);
  }

  /**
   * Ref-scoped resolution: a provider-issued ref addresses the
   * provider that minted it — a foreign id is uninterpretable
   * upstream, so provenance is the only honest route. Gated on the
   * capability the op needs; an unregistered or undeclaring ref
   * provider is `unsupported`, never rerouted.
   */
  providerForRef(
    ref: SourceRef | EntityRef,
    capability: ProviderCapability,
  ): Result<ProviderPort> {
    return this.#serve(ref.provider, capability);
  }

  /** `catalog.entity` dispatches to the ref's own provider. */
  getEntity(
    ref: EntityRef,
    context: OperationContext,
  ): Promise<Result<EntityPage>> {
    const resolved = this.providerForRef(ref, 'catalog.entity');
    if (!resolved.ok) {
      return Promise.resolve(err(resolved.error));
    }
    return resolved.value.getEntity(ref, context);
  }

  /**
   * The provider a lyrics call routes to under `prefer`: the
   * preferred form picks the capability (`lyrics.synced`, or
   * `lyrics.plain` when the caller asked plain), with `synced`
   * degrading to a `lyrics.plain` declarer when nothing declares
   * synced. Exposed so callers can name the routed provider —
   * cache provenance — alongside the call itself.
   */
  lyricsProviderFor(
    selection: ProviderSelection,
    prefer: LyricsPreference,
  ): Result<ProviderPort> {
    const primary = prefer === 'plain' ? 'lyrics.plain' : 'lyrics.synced';
    let resolved = this.providerFor(primary, selection);
    if (!resolved.ok && prefer === 'synced') {
      resolved = this.providerFor('lyrics.plain', selection);
    }
    return resolved;
  }

  /**
   * Lyrics dispatch: the preferred form picks the capability used to
   * resolve the provider (`lyrics.synced`, or `lyrics.plain` when the
   * caller asked plain). A `synced` preference on a plain-only
   * provider degrades to an honest `plain` result.
   */
  getLyrics(
    selection: ProviderSelection,
    input: { query: LyricsQuery; prefer: LyricsPreference },
    context: OperationContext,
  ): Promise<Result<LyricsResult>> {
    const resolved = this.lyricsProviderFor(selection, input.prefer);
    if (!resolved.ok) {
      return Promise.resolve(err(resolved.error));
    }
    return resolved.value.getLyrics(input, context);
  }

  /**
   * `radio.seed` dispatch: `{sourceRef}` routes to the provider that
   * minted the seed; `{continuation}` routes to the active radio
   * provider, the token's only possible issuer.
   */
  radioSeed(
    selection: ProviderSelection,
    input: RadioSeed,
    context: OperationContext,
  ): Promise<Result<RadioPage>> {
    const resolved =
      'sourceRef' in input
        ? this.providerForRef(input.sourceRef, 'radio.seed')
        : this.providerFor('radio.seed', selection);
    if (!resolved.ok) {
      return Promise.resolve(err(resolved.error));
    }
    return resolved.value.radioSeed(input, context);
  }
}
