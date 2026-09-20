import type { OperationContext } from '../cancellation.ts';
import type { Result } from '../errors.ts';
import type {
  SourceRef,
  TrackMetadata,
  VersionLabel,
} from '../domain.ts';

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
 * Async ports never throw by contract: every failure is a typed
 * `AppError` inside `Result`.
 */
export interface ProviderPort {
  readonly id: string;
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
}
