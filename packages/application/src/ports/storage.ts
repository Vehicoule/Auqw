import type { OperationContext } from '../cancellation.ts';
import type { Result } from '../errors.ts';
import type {
  DownloadRecord,
  LocalFile,
  LocalSource,
  Recording,
  Settings,
  Like,
} from '../domain.ts';
import type {
  ArtworkCacheEntry,
  Entity,
  EntitySourceRef,
  ExportDocument,
  LyricsCacheEntry,
  MatchReview,
  PlayCount,
  PlayEvent,
  Playlist,
  PlaylistEntry,
} from '../library/library.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import type { AttemptTrace } from './player.ts';

export type PersistedState = {
  readonly recordings: readonly Recording[];
  readonly likes: readonly Like[];
  readonly entities: readonly Entity[];
  readonly entitySourceRefs: readonly EntitySourceRef[];
  readonly playlists: readonly Playlist[];
  readonly playlistEntries: readonly PlaylistEntry[];
  readonly playHistory: readonly PlayEvent[];
  readonly playCounts: readonly PlayCount[];
  readonly matchReviews: readonly MatchReview[];
  readonly lyricsCache: readonly LyricsCacheEntry[];
  readonly artworkCache: readonly ArtworkCacheEntry[];
  /**
   * Download rows and the local-file index persist in the owned
   * database but are device-local detail — export/import excludes
   * them (recordings keep `provenance` + stable local file ids).
   */
  readonly downloads: readonly DownloadRecord[];
  readonly localSources: readonly LocalSource[];
  readonly localFiles: readonly LocalFile[];
  readonly queue: QueueSnapshot;
  readonly settings: Settings;
};

/**
 * Sections are independently rewritable; a section that names a
 * recording cascades its dependents along in the same transaction
 * (foreign keys are immediate, not deferred).
 */
export type StorageBatch = {
  readonly recordings?: readonly Recording[];
  /**
   * Read-modify-write for `recordings`: the implementation applies
   * this to the rows it just read INSIDE the commit transaction, so
   * a session write landing between a caller's own load and this
   * commit is preserved instead of clobbered by a stale array.
   * Mutually exclusive with `recordings` — passing both is an
   * 'internal' error.
   */
  readonly recordingsMerge?: (
    current: readonly Recording[],
  ) => readonly Recording[];
  readonly likes?: readonly Like[];
  readonly entities?: readonly Entity[];
  readonly entitySourceRefs?: readonly EntitySourceRef[];
  readonly playlists?: readonly Playlist[];
  readonly playlistEntries?: readonly PlaylistEntry[];
  readonly playHistory?: readonly PlayEvent[];
  readonly playCounts?: readonly PlayCount[];
  readonly matchReviews?: readonly MatchReview[];
  readonly lyricsCache?: readonly LyricsCacheEntry[];
  readonly artworkCache?: readonly ArtworkCacheEntry[];
  readonly downloads?: readonly DownloadRecord[];
  readonly localSources?: readonly LocalSource[];
  readonly localFiles?: readonly LocalFile[];
  readonly queue?: QueueSnapshot;
  readonly settings?: Settings;
  readonly attempts?: readonly AttemptTrace[];
};

/** Commits are atomic; the port never throws by contract. */
export interface StoragePort {
  load(context: OperationContext): Promise<Result<PersistedState>>;
  commit(
    batch: StorageBatch,
    context: OperationContext,
  ): Promise<Result<void>>;
  /**
   * Diagnostics only: newest-first attempt traces, capped server-side.
   * Traces are excluded from PersistedState. `limit` must be a safe
   * integer in 1..500.
   */
  loadAttempts(
    limit: number,
    context: OperationContext,
  ): Promise<Result<readonly AttemptTrace[]>>;
  /**
   * The versioned owned-data document: owned classes only — no
   * queue/session, caches, or attempt traces. `exportedAtMs` is a
   * safe nonnegative integer supplied by the caller's clock.
   */
  exportOwned(
    exportedAtMs: number,
    context: OperationContext,
  ): Promise<Result<ExportDocument>>;
  /**
   * Atomically replaces the owned classes with the document's. The
   * whole document validates before any write; on any failure nothing
   * changes. Session state (queue) and disposable caches are reset —
   * their rows foreign-key into the recordings being replaced.
   */
  importOwned(
    doc: ExportDocument,
    context: OperationContext,
  ): Promise<Result<void>>;
}
