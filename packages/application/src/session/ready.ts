import type {
  Like,
  Recording,
  Settings,
} from '../domain.ts';
import type {
  Entity,
  EntitySourceRef,
  LyricsCacheEntry,
  PlayCount,
  PlayEvent,
  Playlist,
  PlaylistEntry,
} from '../library/library.ts';
import type { RepeatMode } from '../ports/player.ts';
import type { QueueEngine } from '../queue/queue-engine.ts';
import type { RadioTailRecord } from '../queue/radio-tail.ts';
import type { AppError } from '../errors.ts';
import type {
  MaterializedRecord,
  MergeOutcome,
} from '../sync/sync-engine.ts';
import type { SyncEmitInput } from '../sync/sync-projection.ts';
import type { SessionPlayback } from './session.ts';

/**
 * The mutable session mirror every domain service works against —
 * the in-memory copy of the persisted sections plus the runtime-only
 * lanes (queue engine, deal, listen cycles, radio, pending sync
 * folds). Session owns the instance; mutations land behind the
 * storage serializer and publish through it.
 */
export type Ready = {
  recordings: Recording[];
  likes: Like[];
  entities: Entity[];
  entitySourceRefs: EntitySourceRef[];
  playlists: Playlist[];
  playlistEntries: PlaylistEntry[];
  playHistory: PlayEvent[];
  playCounts: PlayCount[];
  /**
   * Disposable lyrics cache (data.md): held for `getLyrics` reads but
   * deliberately not published — caches are not session state, and
   * `getLyrics` is the per-recording accessor, same class as the
   * storage-only artwork cache.
   */
  lyricsCache: LyricsCacheEntry[];
  queue: QueueEngine;
  /**
   * Queue-write generation: bumped inside a storage segment when a
   * queue commit fails and rolls the engine back. Writes enqueued
   * with the old epoch captured the engine after that mutation — the
   * rollback erased them — so they report the boundary failure
   * instead of committing a state their own mutation never landed in.
   */
  queueEpoch: number;
  /**
   * Revision of the last durably committed queue snapshot. A queue
   * command commits its own post-mutation snapshot, never the live
   * engine — without this, a segment-fresh draft (mapping adoption)
   * could land first and an earlier-captured stale snapshot would
   * regress the store. A queued write whose revision is already
   * covered is durable through the covering commit, so it skips.
   */
  queueCommittedRev: number;
  settings: Settings;
  playback: SessionPlayback;
  repeat: RepeatMode;
  /**
   * The dealt play order under shuffle — occurrence ids the cursor
   * walks; `null` when off. `#dealtOrder` reconciles it against the
   * live queue on every read: removals drop out, enqueues insert at
   * uniform random positions behind the cursor's dealt position.
   * Runtime-only, never persisted.
   */
  shuffleOrder: string[] | null;
  /**
   * Shuffle-intent generation: `setShuffle` bumps it, `#dealtOrder`
   * reconciles do not. `#persistQueue` captures it beside the deal so a
   * rollback restores the pre-edit deal only when the user's shuffle
   * choice hasn't moved since the mutation captured it.
   */
  shuffleEpoch: number;
  /**
   * Replay cycles per queue occurrence: a repeat-driven replay or wrap
   * bumps the target's cycle, and a recorded play stamps
   * `${occurrenceId}#${cycle}` so each loop of one occurrence counts
   * while same-loop status echoes still dedupe. Runtime-only.
   */
  listenCycles: Record<string, number>;
  radio: RadioTailRecord | null;
  persistenceError: AppError | undefined;
  /**
   * Remote merge outcomes whose records still can't materialize
   * (a field or a parent row hasn't arrived) — refolded on every
   * drain, dropped when the record lands or its fold is superseded
   * by a durable state change (import resets it with the library).
   */
  syncPending: MergeOutcome[];
  /**
   * Materialized rebuild records that could not materialize yet (a
   * dependent whose parent has not arrived — paged rebuilds can order
   * dependents first). Retained and unioned into the next
   * `applyMaterializedEntries` call — memory stays page-bounded
   * without dropping cross-page dependents (Review #46).
   */
  materializedPending: MaterializedRecord[];
};

/** The committed sections emission diffs a batch against. */
export function syncEmitInput(r: Ready): SyncEmitInput {
  return {
    recordings: r.recordings,
    likes: r.likes,
    entities: r.entities,
    entitySourceRefs: r.entitySourceRefs,
    playlists: r.playlists,
    playlistEntries: r.playlistEntries,
    playHistory: r.playHistory,
    playCounts: r.playCounts,
    settings: r.settings,
  };
}
