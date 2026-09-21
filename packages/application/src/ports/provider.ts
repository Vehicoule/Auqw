import type { OperationContext } from '../cancellation.ts';
import type { Result } from '../errors.ts';
import type {
  ArtworkRef,
  EntityKind,
  EntityRef,
  SourceRef,
  TrackMetadata,
  VersionLabel,
} from '../domain.ts';

/**
 * The manifest-declared capabilities of ABI 0.3.0 — the union of
 * wire capability names a provider may serve. The port carries the
 * union of operations; a provider declares the subset it implements
 * and an operation routed to a provider that never declared it is a
 * typed `unsupported`, never a guest invocation.
 */
export type ProviderCapability =
  | 'catalog.search'
  | 'catalog.metadata'
  | 'catalog.artwork'
  | 'catalog.entity'
  | 'playback.candidates'
  | 'playback.resolve'
  | 'lyrics.plain'
  | 'lyrics.synced'
  | 'radio.seed';

const PROVIDER_CAPABILITIES: ReadonlySet<string> = new Set([
  'catalog.search',
  'catalog.metadata',
  'catalog.artwork',
  'catalog.entity',
  'playback.candidates',
  'playback.resolve',
  'lyrics.plain',
  'lyrics.synced',
  'radio.seed',
]);

export function isProviderCapability(
  value: unknown,
): value is ProviderCapability {
  return typeof value === 'string' && PROVIDER_CAPABILITIES.has(value);
}

export type SearchPage = {
  readonly items: readonly TrackMetadata[];
  readonly storefront: string | null;
};

export type RecordingQuery = {
  readonly title: string;
  readonly artist: string | null;
  readonly album: string | null;
  readonly durationMs: number | null;
  readonly versionLabels: readonly VersionLabel[];
  readonly isrc: string | null;
};

export type PlayableResource = {
  readonly url: string;
  readonly mime: string;
  readonly bitrateKbps: number | null;
  readonly expiresAtMs: number | null;
  readonly contentLength: number | null;
  readonly client: string;
  readonly itag: number | null;
};

/**
 * The provider's own descriptor for an album/artist page — the
 * `entityMetadata` of `catalog.entity`. `kind` duplicates
 * `sourceRef.kind`; the wire carries both and adapters reject a
 * mismatch.
 */
export type EntityMetadata = {
  readonly sourceRef: EntityRef;
  readonly kind: EntityKind;
  readonly title: string;
  readonly subtitle: string | null;
  readonly artwork: readonly ArtworkRef[];
};

/**
 * A `catalog.entity` composite page: the entity plus the track
 * listing that belongs to it (an album's tracks, an artist's top
 * tracks). `continuation` pages a truncated listing; `complete` is
 * the honesty flag — a `complete: false` page is partially degraded
 * upstream, renders flagged, and is never cached (providers.md).
 */
export type EntityPage = {
  readonly entity: EntityMetadata;
  readonly items: readonly TrackMetadata[];
  readonly continuation: string | null;
  readonly complete: boolean;
};

/** Recording identity for a lyrics lookup — the wire `lyricsQuery`. */
export type LyricsQuery = {
  readonly title: string;
  readonly artist: string | null;
  readonly album: string | null;
  readonly durationMs: number | null;
  readonly isrc: string | null;
};

/**
 * The upstream record a lyrics provider matched against. The plugin
 * reports it verbatim; the application scores it for acceptance —
 * match honesty is never the plugin's call (providers.md).
 */
export type LyricsMatch = {
  readonly title: string;
  readonly artist: string | null;
  readonly album: string | null;
  readonly durationMs: number | null;
};

export type LyricsLine = {
  readonly tMs: number;
  readonly text: string;
};

/**
 * What a lyrics lookup honestly found. `synced` carries timed lines;
 * `plain` carries untimed text and is never upgraded to `synced`;
 * `instrumental` asserts the track has no lyrics; `unavailable` is
 * the honest absence (the wire `absent`), still carrying the matched
 * evidence the caller may distrust.
 */
export type LyricsResult =
  | {
    readonly kind: 'synced';
    readonly lines: readonly LyricsLine[];
    readonly matched: LyricsMatch | null;
  }
  | {
    readonly kind: 'plain';
    readonly text: string;
    readonly matched: LyricsMatch | null;
  }
  | { readonly kind: 'instrumental'; readonly matched: LyricsMatch | null }
  | { readonly kind: 'unavailable'; readonly matched: LyricsMatch | null };

/**
 * Which lyric form the caller wants. `synced` degrades to the
 * provider's `lyrics.plain` capability when it declares only that —
 * the result then honestly says `plain`; `plain` never degrades to
 * synced (an untimed consumer cannot render timed lines).
 */
export type LyricsPreference = 'synced' | 'plain';

/**
 * `radio.seed` dual payload: `{sourceRef}` seeds the first page of a
 * track-seeded mix, `{continuation}` fetches the next page. The seed
 * ref addresses the provider that minted it; a continuation is
 * opaque and routes to the active radio provider.
 */
export type RadioSeed =
  | { readonly sourceRef: SourceRef }
  | { readonly continuation: string };

export type RadioPage = {
  readonly candidates: readonly TrackMetadata[];
  /** `null` is the honest end-of-continuation signal. */
  readonly continuation: string | null;
};

/**
 * Async ports never throw by contract: every failure is a typed
 * `AppError` inside `Result`.
 */
export interface ProviderPort {
  readonly id: string;
  /**
   * The capability subset this provider declares (manifest-derived).
   * Operations routed outside the declared set return `unsupported`
   * without reaching the guest.
   */
  readonly capabilities: readonly ProviderCapability[];
  search(
    input: { query: string; limit: number; storefront: string | null },
    context: OperationContext,
  ): Promise<Result<SearchPage>>;
  candidates(
    input: { query: RecordingQuery; limit: number },
    context: OperationContext,
  ): Promise<Result<readonly TrackMetadata[]>>;
  resolvePlayback(
    ref: SourceRef,
    input: {
      targetBitrateKbps: number;
      prefer: readonly ('audio/webm' | 'audio/mp4')[];
      pinItag: number | null;
      resumeOffset: number | null;
    },
    context: OperationContext,
  ): Promise<Result<PlayableResource>>;
  getDetails(
    refs: readonly SourceRef[],
    context: OperationContext,
  ): Promise<Result<readonly TrackMetadata[]>>;
  getEntity(
    ref: EntityRef,
    context: OperationContext,
  ): Promise<Result<EntityPage>>;
  /**
   * `catalog.artwork`: sized artwork candidates for a track ref the
   * provider minted. `size` is the wire enum — providers render at
   * fixed tiers, not arbitrary px.
   */
  artwork(
    ref: SourceRef,
    input: { size: 600 | 1200 },
    context: OperationContext,
  ): Promise<Result<readonly ArtworkRef[]>>;
  getLyrics(
    input: { query: LyricsQuery; prefer: LyricsPreference },
    context: OperationContext,
  ): Promise<Result<LyricsResult>>;
  radioSeed(
    input: RadioSeed,
    context: OperationContext,
  ): Promise<Result<RadioPage>>;
}
