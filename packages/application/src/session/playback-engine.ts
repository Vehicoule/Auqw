import { CancellationSource } from '../cancellation.ts';
import type { AppError, ErrorKind, Result } from '../errors.ts';
import { appError, err, fromUnknown, ok } from '../errors.ts';
import type {
  Recording,
  SourceMapping,
  SourceRef,
  TrackMetadata,
} from '../domain.ts';
import {
  isSafeNonNegative,
  isString,
  isTrackMetadata,
  isTrackRef,
  LOCAL_PROVIDER,
} from '../domain.ts';
import { countsAsPlay, recordPlay } from '../library/history.ts';
import { retryBounded } from '../retry.ts';
import type { Corrections } from '../library/corrections.ts';
import { MATCH_GATE_MESSAGE } from '../library/corrections.ts';
import { MatchingEngine } from '../matching/matching-engine.ts';
import type {
  MatchCandidate,
  MatchOutcome,
} from '../matching/matching-engine.ts';
import { extractVersionLabels } from '../matching/matching-engine.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { IdPort } from '../ports/runtime.ts';
import type {
  AttemptTrace,
  PlaybackIdentity,
  PlayerEvent,
  PlayerPort,
  PreparedStream,
  QueueProjection,
  QueueProjectionItem,
} from '../ports/player.ts';
import type { RecordingQuery } from '../ports/provider.ts';
import type { ProviderRouter } from '../providers/provider-router.ts';
import { selectionFromSettings } from '../providers/provider-router.ts';
import type { StorageBatch } from '../ports/storage.ts';
import { QueueEngine } from '../queue/queue-engine.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import type { RadioTailRecord } from '../queue/radio-tail.ts';
import { Serializer } from './serializer.ts';
import type { Ready, SessionHostCore } from './ready.ts';
import type { SessionPlayback } from './session.ts';
import {
  boundedOp,
  internalError,
  sameRef,
  saturatingAdd,
  timeoutError,
} from './util.ts';
const CANDIDATE_LIMIT = 25;
/**
 * One event-driven failure gets a single re-attempt inside the
 * original 15s budget (docs/specs/playback.md: the budget includes
 * retries). A retry only arms when this much budget is left — a
 * re-prepare with no room can only time out.
 */
const AUTO_RETRY_BACKOFF_MS = 400;
const AUTO_RETRY_MIN_BUDGET_MS = 1_000;
/**
 * `player.prepare` calls one play intent may spend across its whole
 * attempt chain — the in-attempt bounded retry and the event-level
 * re-attempt draw on the same budget instead of stacking ceilings.
 */
const PREPARE_CALL_BUDGET = 2;
// Status ticks fire ~1 s; a position delta above this between ticks
// is a seek/jump, not played time.
const MAX_TICK_DELTA_MS = 2_500;
/**
 * A stored stream handle that no longer resolves registry-side —
 * detached sessions are reaped past the prepare TTL and superseded
 * while detached, so a long pause can outlive the stream even though
 * the queue item stays playable. A transport call failing with one of
 * these kinds on a stored handle means re-prepare, not markUnplayable.
 */
const DEAD_STREAM_KINDS: ReadonlySet<ErrorKind> = new Set([
  'released',
  'evicted',
  'expired',
  'superseded',
  'not-found',
]);

/**
 * Visible-row warming bounds: a surface hands at most this many refs
 * or recording ids per `prewarm` call — the ~9-row viewport.
 */
const PREWARM_INPUT_LIMIT = 9;
/**
 * Queue rows scanned past the cursor for a speculative mapping —
 * the dealt window a service move would reach next.
 */
const WARM_WINDOW = 8;
/**
 * Recently-attempted warm rows: an LRU so a derived tick or a fresh
 * `prewarm` call can't spin the same resolve. 64 entries — the dedupe
 * bound the warm cache is required to hold.
 */
const WARM_SEEN_CAP = 64;
/** How long a no-hit warm row stays suppressed before it may retry. */
const WARM_ROW_TTL_MS = 120_000;
/** A failed stream warm stays denied this long — one slot re-firing
 *  the same dead resolve every playing-tick is a network leak. */
const STREAM_DENY_CAP = 16;
/**
 * A warm prepared session is only kept — and only adopted — while
 * its URL outlives the seam's own attach margin (the registry's
 * `expiry_margin`). A tighter bound would mint sessions the tap
 * already can't use.
 */
const WARM_EXPIRY_MARGIN_MS = 60_000;
/**
 * The newest surface-handoff ref counts as visible this long: the
 * idle stream warm keeps its target while the search results that
 * minted it are still on screen.
 */
const SURFACE_WARM_TTL_MS = 120_000;
function attemptEq(a: PlaybackIdentity, b: PlaybackIdentity): boolean {
  return a.attemptId === b.attemptId;
}

/** Mapping precedence identical to MatchingEngine's conflict rule. */
function mappingRank(status: SourceMapping['status']): number {
  return status === 'user-confirmed' ? 2 : status === 'rejected' ? 1 : 0;
}

function winningMapping(
  mappings: readonly SourceMapping[],
): SourceMapping | undefined {
  let best: SourceMapping | undefined;
  for (const mapping of mappings) {
    if (
      best === undefined ||
      mapping.matchedAtMs > best.matchedAtMs ||
      (mapping.matchedAtMs === best.matchedAtMs &&
        mappingRank(mapping.status) > mappingRank(best.status))
    ) {
      best = mapping;
    }
  }
  return best;
}

/**
 * A settled attempt reports its sealed verdict; a cancellation with
 * no seal reports superseded.
 */
function sealedOrSuperseded(terminalError: AppError | undefined): AppError {
  return terminalError ?? appError('superseded', 'play superseded');
}

/** A warm record's playback identity mints from its own ids. */
function warmIdentity(warm: {
  readonly attemptId: string;
  readonly queueRev: number;
}): PlaybackIdentity {
  return { attemptId: warm.attemptId, queueRev: warm.queueRev };
}

/** The query every candidates/resolve path builds from a recording. */
function recordingQuery(recording: Recording): RecordingQuery {
  return {
    title: recording.title,
    artist: recording.artist,
    album: recording.album,
    durationMs: recording.durationMs,
    versionLabels: recording.versionLabels,
    isrc: recording.isrc,
  };
}

/** Reinsert at the LRU tail, evicting oldest entries past cap. */
function lruSet(
  map: Map<string, number>,
  key: string,
  at: number,
  cap: number,
): void {
  map.delete(key);
  map.set(key, at);
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

/**
 * TTL check on an LRU map: `now === null` (clock unavailable) reads
 * as fresh; `touch` LRU-bumps a hit.
 */
function lruFresh(
  map: Map<string, number>,
  key: string,
  ttl: number,
  now: number | null,
  touch: boolean,
): boolean {
  const at = map.get(key);
  if (at === undefined) {
    return false;
  }
  if (now === null || now - at < ttl) {
    if (touch) {
      map.delete(key);
      map.set(key, at);
    }
    return true;
  }
  map.delete(key);
  return false;
}

type ActiveAttempt = {
  identity: PlaybackIdentity;
  readonly recordingId: string;
  readonly occurrenceId: string;
  /** The ref host.pickRef resolved — surfaces on SessionPlayback so consumers mark the row actually playing. */
  ref?: SourceRef;
  readonly source: CancellationSource;
  readonly deadlineMs: number;
  requestId?: string;
  handle?: string;
  preparedHandled: boolean;
  endedHandled: boolean;
  /** True on the single in-budget re-attempt after a retryable failure. */
  autoRetried?: boolean;
  terminalError?: AppError;
  timer?: CancellationSource;
  /** Last accepted status position — deltas feed `listenedMs`. */
  lastStatusPositionMs?: number;
  /** Actual played span summed from tick deltas (seeks don't count). */
  listenedMsAccum: number;
  /** Prepare calls spent so far across this intent's attempt chain. */
  preparesUsed: number;
};

/**
 * One advisory stream warm: a `player.prewarm` request whose minted
 * session a later real `prepare` may adopt — the registry keeps at
 * most one unattached session, so this slot is singular by
 * construction. `stream` fills when its `prepare` outcome lands;
 * until then the request is cancellable via `requestId` alone.
 */
type StreamWarm = {
  /**
   * 'queue' rides the dealt successor while a track plays; 'surface'
   * is an explicit `prewarm()` row (a search result the user may tap).
   */
  readonly origin: 'queue' | 'surface';
  readonly provider: string;
  readonly sourceRef: string;
  readonly attemptId: string;
  readonly queueRev: number;
  requestId: string | null;
  stream: PreparedStream | null;
  attempt: AttemptTrace | null;
  /**
   * The attempt that adopted this warm's session while its request id
   * was still in flight — set on transfer so a late-arriving id joins
   * the attempt's ownership bookkeeping instead of being cancelled
   * (cancel would kill the unattached session the attempt is about
   * to attach).
   */
  adoptedAttempt: ActiveAttempt | null;
  /**
   * The `#surfaceBacklog` entry this warm was issued for — consumed
   * when the mint lands so the backlog tracks only refs still owed a
   * session. `null` for queue-successor and direct-hand warms.
   */
  backlogKey: string | null;
};

/**
 * A repeat-driven replay or wrap begins a new listen for the target
 * occurrence — bump its cycle so play-history dedup counts the loop.
 */
function bumpListenCycle(r: Ready, occurrenceId: string): void {
  r.listenCycles[occurrenceId] = (r.listenCycles[occurrenceId] ?? 0) + 1;
}

/**
 * The per-listen dedupe key: cycle 0 records under the occurrence id
 * itself, replays under `${id}#${cycle}` — the base truncates into the
 * 64-char id bound so a max-length id can't fail validation mid
 * transition.
 */
function playDedupeId(occurrenceId: string, cycle: number): string {
  if (cycle === 0) {
    return occurrenceId;
  }
  const suffix = `#${cycle}`;
  const base = occurrenceId.slice(0, Math.max(0, 64 - suffix.length));
  return `${base}${suffix}`;
}

/**
 * Merge an automatic mapping into a recording row — same-ref
 * conflicts resolve through the shared precedence rule: an automatic
 * mapping never replaces or shadows a user-confirmed/rejected
 * winner, and an older automatic winner is refreshed in place.
 */
function adoptAutomaticMapping(
  rec: Recording,
  ref: SourceRef,
  mapping: SourceMapping,
): Recording {
  const winner = winningMapping(
    rec.mappings.filter((m) => sameRef(m.ref, ref)),
  );
  let mappings = rec.mappings;
  if (winner === undefined) {
    mappings = [...rec.mappings, mapping];
  } else if (
    winner.status === 'automatic' &&
    winner.matchedAtMs < mapping.matchedAtMs
  ) {
    mappings = rec.mappings.map((m) => (sameRef(m.ref, ref) ? mapping : m));
  }
  return {
    ...rec,
    mappings,
    sourceRefs: rec.sourceRefs.some((s) => sameRef(s, ref))
      ? rec.sourceRefs
      : [...rec.sourceRefs, ref],
  };
}

/** Latest sent projection plus its install status at the service. */
type ProjectionMarker = {
  readonly projection: QueueProjection;
  currentOccurrenceId: string | null;
  reconciledQueueRev: number;
  status: 'pending' | 'installed' | 'failed' | 'superseded';
  done: Promise<void>;
};
/**
 * The playback engine's per-service seams over SessionHostCore —
 * publishPosition, the pick/deal reads, the staged-commit and queue
 * lanes, the port-call wrappers, timer tracking, and the radio-tail
 * hooks the transition reconcile kicks.
 */
export type PlaybackHost = SessionHostCore & {
  /** Position-only publish — the light channel that skips
   * whole-state subscribers. */
  readonly publishPosition: () => void;
  /** Ref selection for an occurrence — the shared pick precedence. */
  readonly pickRef: (
    recording: Recording,
    occurrenceSelected: SourceRef | null,
  ) => SourceRef | null;
  /** The dealt play order under shuffle — null when off. */
  readonly dealtOrder: (r: Ready) => readonly string[] | null;
  readonly isOnline: () => boolean;
  /**
   * Speculative warm paths consult the platform's metered signal and
   * stay idle while it reports true — they would spend bytes the
   * user may be paying for. Playback-intent calls never consult it.
   */
  readonly isMetered: () => boolean;
  /** Commit-first mutation against the freshest committed mirror. */
  readonly commitStaged: <T>(
    stage: (r: Ready) => Result<PlaybackStage<T>>,
  ) => Promise<Result<T>>;
  /** Queue commit with rollback/epoch bookkeeping. */
  readonly persistQueue: (
    r: Ready,
    before: QueueSnapshot,
    beforeMarks: ReadonlySet<string>,
  ) => Promise<Result<void>>;
  /** Snapshot → mutate → commit-with-rollback; the caller ticks
   * `derived` itself so it lands in the caller's continuation. */
  readonly mutateQueue: (
    r: Ready,
    mutate: (queue: QueueEngine) => void,
  ) => Promise<Result<void>>;
  /** Port calls never throw by contract; throws map to internal. */
  readonly call: <T>(fn: () => Promise<Result<T>>) => Promise<Result<T>>;
  /** Every player/storage port call is bounded and cancellable. */
  readonly bounded: <T>(
    fn: () => Promise<Result<T>>,
  ) => Promise<Result<T>>;
  /**
   * Track a timer CancellationSource for dispose-time cancel; the
   * returned function untracks it (the session's timer set — its
   * dispose loop cancels every tracked timer).
   */
  readonly trackTimer: (timer: CancellationSource) => () => void;
  /** Radio-tail hooks the transition reconcile and derived ticks kick. */
  readonly maybeGrowRadio: () => void;
  readonly maybeArmRadio: () => void;
  readonly resumeDrainedQueue: (
    r: Ready,
    record: RadioTailRecord,
    firstAppended: string | undefined,
  ) => void;
};

export type PlaybackEngineDeps = {
  readonly player: PlayerPort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly router: ProviderRouter;
  readonly corrections: Corrections;
  readonly host: PlaybackHost;
};

/**
 * What a staged write produces: the section batch to commit plus the
 * in-memory apply. An omitted `batch` means nothing durable changed
 * — the apply still runs and publishes.
 */
type PlaybackStage<T> = {
  readonly batch?: StorageBatch;
  readonly apply: (r: Ready) => T;
};

/**
 * The playback pipeline: attempt lifecycle (start/resolve/retry/
 * teardown), transition legality (player events, native cursor
 * reconciliation), and projection install. Player events serialize on
 * the event lane; transport commands are unsynchronized and converge
 * through the attempt slot. Session stays the facade — it delegates
 * the public transport surface here and owns everything else.
 */
export class PlaybackEngine {
  readonly #player: PlayerPort;
  readonly #clock: ClockPort;
  readonly #ids: IdPort;
  readonly #router: ProviderRouter;
  readonly #corrections: Corrections;
  readonly #host: PlaybackHost;

  #active: ActiveAttempt | null = null;
  #releasedHandles = new Set<string>();
  /**
   * Streams whose release call failed — off the attempt's `handle`
   * slot so their events can't reach a newer attempt, but still
   * session-owned so teardown can re-offer the release instead of
   * stranding a native handle for the rest of the session.
   */
  #leakedHandles = new Map<string, PlaybackIdentity>();
  #releaseWork = new Map<string, Promise<Result<void>>>();
  readonly #eventSerial = new Serializer();
  #projection: ProjectionMarker | null = null;
  /**
   * Recently installed projections by id. A service move emits the
   * projection it captured at move-start — an install that lands
   * mid-flight (a shuffle toggle, an edit) must not re-judge that
   * edge under a deal it never ran, so the legality check resolves
   * the event's own projection when it's still here.
   */
  readonly #installedProjections = new Map<string, QueueProjection>();
  #mappingSource: CancellationSource | null = null;
  /**
   * The one advisory stream warm — see `StreamWarm`. Cleared only
   * through `#dropStreamWarm` (release/cancel) or the adoption paths
   * (the attempt/transition claims the session) — never released
   * while a record still owns it.
   */
  #streamWarm: StreamWarm | null = null;
  /**
   * Stream rows that just failed a warm — bounded suppression so a
   * derived tick can't re-fire the same dead resolve every second.
   */
  #streamWarmDenied = new Map<string, number>();
  /**
   * The newest visible-row ref a surface handed `prewarm()` — the
   * idle-time stream warm's target. Rows past `SURFACE_WARM_TTL_MS`
   * count as scrolled-away.
   */
  #surfaceWarm: {
    provider: string;
    sourceRef: string;
    atMs: number;
  } | null = null;
  /**
   * Track rows a surface handed `prewarm()` whose catalog provider
   * differs from the playback provider — they carry no usable ref, so
   * the window pass candidates-resolves them into a `(provider, ref)`
   * the stream warm can mint (the tap's own resolve still runs; only
   * its mint+prepare is already spent).
   */
  #warmPendingQueries: { key: string; query: RecordingQuery }[] = [];

  /**
   * Track-row keys the surface's latest `prewarm({tracks})` hand
   * showed — resolved refs and queued queries from an earlier page
   * are discarded against it, so a stale match never mints over what
   * is actually visible.
   */
  #surfaceKeys = new Set<string>();
  /**
   * Resolved track-row refs awaiting the one stream-warm slot, in
   * arrival order — `#surfaceWant` offers the newest live entry, and
   * an entry is consumed only when its warm actually mints, so a
   * resolved row's seen mark always means "offered to the player".
   */
  #surfaceBacklog: {
    key: string;
    provider: string;
    sourceRef: string;
    atMs: number;
  }[] = [];

  /**
   * Recording ids a surface handed `prewarm()` — the window loop
   * drains them into `#warmSeen` bookkeeping; bounded at add time.
   */
  #warmPending = new Set<string>();
  /**
   * Row-warm suppression: recently-attempted recording ids — the
   * 64-entry LRU the candidates warm is required to dedupe under.
   */
  #warmSeen = new Map<string, number>();
  /** Serializes the visible-window mapping pass — one at a time. */
  #warmBatchSource: CancellationSource | null = null;
  /**
   * The recording the running pass is candidates-resolving, plus the
   * promise of that row's completion — an attempt resolving the same
   * row adopts the in-flight warm instead of paying a duplicate
   * candidates call.
   */
  #warmBatchTarget: string | null = null;
  #warmBatchDone: Promise<void> | null = null;
  /** Provider the in-flight row warm routes through — adoption and
   * settings-change cancellation both key on it. */
  #warmBatchProvider: string | null = null;

  constructor(deps: PlaybackEngineDeps) {
    this.#player = deps.player;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#router = deps.router;
    this.#corrections = deps.corrections;
    this.#host = deps.host;
  }

  /**
   * The live play attempt, narrowed to what seeding reads: which
   * occurrence it serves and the ref it resolved (undefined while the
   * pick is still in flight).
   */
  activeAttempt(): {
    readonly occurrenceId: string;
    readonly ref?: SourceRef;
  } | null {
    return this.#active;
  }

  /** Cancel the speculative successor map, if one is resolving. */
  cancelSuccessorMapping(): void {
    this.#mappingSource?.cancel();
    this.#mappingSource = null;
  }

  /**
   * Import prelude's playback half: release the live attempt — its
   * recording rows are about to be replaced (a clean release, the
   * recording did not fail).
   */
  async releaseActiveAttempt(): Promise<void> {
    const active = this.#active;
    if (active !== null) {
      active.source.cancel();
      active.timer?.cancel();
      if (active.handle !== undefined) {
        await this.#releaseHandle(active.handle, active.identity);
      }
      this.#active = null;
      const r = this.#host.ready();
      if (r !== null) {
        r.playback = { type: 'idle' };
      }
    }
  }

  /** Dispose's playback half: tear down the live attempt, else drain. */
  async teardownForDispose(): Promise<void> {
    this.#warmBatchSource?.cancel();
    this.#warmBatchSource = null;
    const warm = this.#streamWarm;
    this.#streamWarm = null;
    if (warm !== null) {
      this.#dropStreamWarm(warm);
    }
    const active = this.#active;
    this.#active = null;
    if (active !== null) {
      await this.#teardownAttempt(active);
    } else {
      await this.#drainLeakedHandles();
    }
  }

  /** The player event lane's tail — drain()/dispose() wait on it. */
  eventsIdle(): Promise<void> {
    return this.#eventSerial.idle();
  }

  /** In-flight handle releases drain()/dispose() wait on. */
  releaseWork(): readonly Promise<Result<void>>[] {
    return [...this.#releaseWork.values()];
  }

  #isStale(attempt: ActiveAttempt): boolean {
    return this.#active !== attempt;
  }

  /**
   * One counted play per occurrence and listen cycle: 50% of duration
   * or 120 s, committed first like every owned write. A replay
   * (repeat-one loop, a wrap back to an already-played item) stamps
   * `${occurrenceId}#${cycle}` so the loop counts once while the
   * dedup still swallows same-loop duplicates. A no-op below the
   * threshold, on a dedupe hit, or when the clock is dead.
   */
  async #maybeRecordPlay(
    occurrenceId: string,
    recordingId: string,
    listenedMs: number,
    durationMs: number | null,
  ): Promise<void> {
    const r = this.#host.ready();
    if (r === null) {
      return;
    }
    const cycle = r.listenCycles[occurrenceId] ?? 0;
    const dedupeId = playDedupeId(occurrenceId, cycle);
    if (
      !isSafeNonNegative(listenedMs) ||
      (durationMs !== null && !isSafeNonNegative(durationMs)) ||
      !countsAsPlay(listenedMs, durationMs) ||
      r.playHistory.some((e) => e.occurrenceId === dedupeId)
    ) {
      return;
    }
    const now = this.#host.safeNow();
    if (now === null) {
      return;
    }
    const next = recordPlay(
      { playHistory: r.playHistory, playCounts: r.playCounts },
      {
        eventId: this.#ids.next('play'),
        recordingId,
        occurrenceId: dedupeId,
        listenedMs,
        durationMs,
        nowMs: now,
      },
    );
    if (!next.recorded) {
      return;
    }
    const persisted = await this.#host.persist({
      playHistory: next.playHistory,
      playCounts: next.playCounts,
    });
    if (!persisted.ok) {
      return;
    }
    r.playHistory = [...next.playHistory];
    r.playCounts = [...next.playCounts];
    this.#host.publish();
  }

  async advance(method: 'next' | 'previous'): Promise<Result<void>> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const before = r.queue.snapshot();
    const beforeMarks = r.queue.unplayableIds;
    // The drain authorization belongs to the tail armed when the move
    // started — a reseed during the persist swaps in a fresh record
    // whose own flag already reflects its queue state.
    const radioBefore = r.radio;
    if (before.currentOccurrenceId === null) {
      return err(appError('no-result', 'queue has no current occurrence'));
    }
    const dealt = this.#host.dealtOrder(r);
    try {
      if (method === 'next') {
        if (dealt === null) {
          r.queue.next();
          // repeat=all: a move that ran off the tail wraps to the first
          // unmarked head — wrapping onto a known-dead row just retries
          // it, so all-failed ends the same as the dealt branch.
          if (r.repeat === 'all') {
            const tail = r.queue.snapshot();
            const head =
              tail.currentOccurrenceId === null
                ? tail.occurrences.find(
                    (o) => !r.queue.isUnplayable(o.occurrenceId),
                  )
                : undefined;
            if (head !== undefined) {
              r.queue.select(head.occurrenceId, before.mode === 'playing');
              bumpListenCycle(r, head.occurrenceId);
            }
          }
        } else {
          // Under shuffle the walk is the dealt order: `next` steps to
          // the dealt successor, wraps dealt tail→head under repeat=all,
          // or runs off the dealt end into the same stopped state a
          // canonical tail move produces. Failed rows are skipped the
          // same way the canonical next() walks past unplayable marks.
          const pos = dealt.indexOf(before.currentOccurrenceId);
          const nextId =
            pos >= 0
              ? dealt.slice(pos + 1).find((id) => !r.queue.isUnplayable(id))
              : undefined;
          if (nextId !== undefined) {
            r.queue.select(nextId, before.mode === 'playing');
          } else if (r.repeat === 'all' && dealt.length > 0) {
            const head = dealt.find((id) => !r.queue.isUnplayable(id));
            if (head !== undefined) {
              // A lone dealt item wraps onto itself — select() no-ops on
              // a same-id zero-position pick, so run off the end first:
              // the same restart the canonical next()-then-wrap makes.
              if (head === before.currentOccurrenceId) {
                r.queue.stop();
              }
              r.queue.select(head, before.mode === 'playing');
              bumpListenCycle(r, head);
            }
          } else {
            r.queue.stop();
          }
        }
      } else if (dealt !== null) {
        const pos = dealt.indexOf(before.currentOccurrenceId);
        // A blocked row's retained position isn't resumable progress —
        // it reads as 0 for the restart-window rules the same way the
        // engine's previous() treats it.
        const prevPosMs =
          before.blockedError !== undefined ? 0 : before.positionMs;
        if (
          pos === 0 &&
          prevPosMs <= 3000 &&
          r.repeat === 'all' &&
          dealt.length > 1
        ) {
          // Dealt head inside the restart window wraps to the dealt
          // tail — the same rule the service cursor applies.
          const tail = dealt[dealt.length - 1];
          if (tail !== undefined) {
            r.queue.select(tail, before.mode === 'playing');
            bumpListenCycle(r, tail);
          }
        } else if (pos > 0 && prevPosMs <= 3000) {
          const prev = dealt[pos - 1];
          if (prev !== undefined) {
            r.queue.select(prev, before.mode === 'playing');
          }
        } else {
          // Past the restart window, or parked at the dealt head
          // without a wrap: the same in-place restart the engine's
          // previous() applies — position 0, ticking only past 0.
          r.queue.seekTo(0);
        }
      } else if (
        r.repeat === 'all' &&
        before.currentOccurrenceId === before.occurrences[0]?.occurrenceId &&
        before.occurrences.length > 1 &&
        (before.blockedError !== undefined ? 0 : before.positionMs) <= 3000
      ) {
        // repeat=all at the head, within the restart threshold: the
        // move wraps to the tail — the same rule the service cursor
        // applies. Past the threshold `previous` restarts the item.
        const last = before.occurrences[before.occurrences.length - 1];
        if (last !== undefined) {
          r.queue.select(last.occurrenceId, before.mode === 'playing');
          bumpListenCycle(r, last.occurrenceId);
        }
      } else {
        r.queue.previous();
      }
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    const after = r.queue.snapshot();
    if (after.revision === before.revision) {
      // First occurrence at position 0: a complete no-op.
      return ok(undefined);
    }
    if (
      method === 'previous' &&
      after.currentOccurrenceId === before.currentOccurrenceId
    ) {
      // Restart the same item: seek natively, keep the attempt.
      const restarted = await this.#host.persistQueue(r, before, beforeMarks);
      if (!restarted.ok) {
        return restarted;
      }
      this.#host.derived();
      const active = this.#active;
      if (
        active !== null &&
        active.handle !== undefined &&
        active.occurrenceId === after.currentOccurrenceId
      ) {
        const identity = this.#rekeyIdentity(active, after.revision);
        // Publish the re-keyed identity before the transport call: if
        // a supersede lands during the await the post-call publish is
        // skipped, and an unpublished identity must never reach the
        // player.
        this.#setPlaybackFromStatus(
          active,
          r.queue.snapshot().mode === 'paused' ? 'paused' : 'playing',
        );
        const result = await this.#host.bounded(() =>
          this.#player.seekTo({ positionMs: 0, identity }),
        );
        if (!result.ok) {
          return this.#failWith(active, result.error);
        }
      }
      this.#host.publish();
      return ok(undefined);
    }
    const moved = await this.#host.persistQueue(r, before, beforeMarks);
    if (!moved.ok) {
      // A rolled-back move must not leave playback on a cursor the
      // store no longer holds — converge onto the durable tip (this
      // command's own `before`, or whatever a later commit landed).
      const durable = r.queue.snapshot();
      if (
        durable.revision === r.queueCommittedRev &&
        durable.mode === 'playing' &&
        durable.currentOccurrenceId !== null &&
        durable.currentOccurrenceId !== this.#active?.occurrenceId
      ) {
        this.#host.own(this.startAttempt(durable.currentOccurrenceId));
      }
      return moved;
    }
    {
      // Playback consuming the queue while this tail was armed
      // authorizes the landed page to resume; any other move revokes
      // it — a paused skip-to-end never earns it, and a rolled-back
      // skip drains nothing. The flag marks only once the drain is
      // durable (moved.ok was checked above), so a failed persist
      // cannot authorize a later paused drain to resume.
      const rec = r.radio;
      if (
        rec !== null &&
        rec === radioBefore &&
        rec.status === 'growing'
      ) {
        rec.resumeOnDrain =
          after.currentOccurrenceId === null && before.mode === 'playing';
      }
    }
    this.#host.derived();
    // Transport ops are not serialized — a concurrent next/previous
    // may have moved the cursor again while the persist was in
    // flight. Serve the DURABLE cursor: when the live snapshot carries
    // a newer mutation whose own commit is still in flight, defer to
    // that command's continuation — starting an uncommitted cursor now
    // would keep playing it if its commit later rolls back.
    const latest = r.queue.snapshot();
    if (latest.revision !== r.queueCommittedRev) {
      return ok(undefined);
    }
    if (latest.mode === 'playing' && latest.currentOccurrenceId !== null) {
      return this.startAttempt(latest.currentOccurrenceId);
    }
    await this.supersede();
    const ready2 = this.#host.ready();
    if (ready2 !== null) {
      ready2.playback = { type: 'idle' };
      this.#host.publish();
    }
    return ok(undefined);
  }

  async pause(): Promise<Result<void>> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const active = this.#active;
    if (active === null) {
      return err(appError('unavailable', 'no active playback to pause'));
    }
    // Commit the intent before touching transport: a failed commit
    // rolls the engine back and the native pause is never issued.
    const persisted = await this.#host.mutateQueue(r, (q) => q.pause());
    if (!persisted.ok) {
      return persisted;
    }
    this.#host.derived();
    if (active.handle === undefined) {
      // Prepare still in flight: pause intent landed on the queue and
      // the pending 'prepared' outcome will not autostart it.
      this.#host.publish();
      return ok(undefined);
    }
    if (this.#isStale(active)) {
      // Superseded while committing — the pause intent landed anyway.
      this.#host.publish();
      return ok(undefined);
    }
    const identity = this.#rekeyIdentity(
      active,
      r.queue.snapshot().revision,
    );
    // Same ordering rule as play/seek: the re-keyed identity must be
    // published before the transport call carries it.
    this.#setPlaybackFromStatus(active, 'paused');
    const result = await this.#host.bounded(() => this.#player.pause(identity));
    if (!result.ok) {
      if (
        DEAD_STREAM_KINDS.has(result.error.kind) &&
        !this.#isStale(active)
      ) {
        // The registry already dropped the stream — 'paused' is the
        // achieved state, not a failure of this occurrence. A later
        // resume's play re-prepares via its own dead-handle path.
        this.#host.publish();
        return ok(undefined);
      }
      return this.#failWith(active, result.error);
    }
    if (!this.#isStale(active)) {
      this.#setPlaybackFromStatus(active, 'paused');
      this.#host.publish();
    }
    return ok(undefined);
  }

  async resume(): Promise<Result<void>> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const before = r.queue.snapshot();
    if (before.currentOccurrenceId === null) {
      return err(appError('no-result', 'queue has no current occurrence'));
    }
    const persisted = await this.#host.mutateQueue(r, (q) => q.play());
    if (!persisted.ok) {
      return persisted;
    }
    this.#host.derived();
    const active = this.#active;
    if (active !== null && active.handle === undefined) {
      // A prepare is already in flight: the ticked 'playing' intent
      // means the pending 'prepared' outcome autostarts it.
      this.#host.publish();
      return ok(undefined);
    }
    if (active !== null && active.handle !== undefined) {
      if (this.#isStale(active)) {
        this.#host.publish();
        return ok(undefined);
      }
      const identity = this.#rekeyIdentity(
        active,
        r.queue.snapshot().revision,
      );
      // Same ordering rule: the identity the transport call carries
      // must already be observable in the published record, in case a
      // supersede during the await skips the post-call publish.
      this.#setPlaybackFromStatus(active, 'paused');
      const result = await this.#host.bounded(() =>
        this.#player.play({
          handle: active.handle ?? '',
          identity,
          positionMs: r.queue.snapshot().positionMs,
        }),
      );
      if (!result.ok) {
        // The stored handle died registry-side while paused — the
        // stream is gone, not the occurrence. Mint a fresh prepare
        // from the queue's persisted position instead of marking the
        // item unplayable (which also surfaced as a 0:00 reset).
        if (
          DEAD_STREAM_KINDS.has(result.error.kind) &&
          !this.#isStale(active)
        ) {
          return this.startAttempt(active.occurrenceId);
        }
        return this.#failWith(active, result.error);
      }
      if (!this.#isStale(active)) {
        this.#setPlaybackFromStatus(active, 'playing');
        this.#host.publish();
      }
      return ok(undefined);
    }
    // No live handle (e.g. after restore): prepare fresh.
    return this.startAttempt(before.currentOccurrenceId);
  }

  async seekTo(
    positionMs: number,
    expectedOccurrenceId?: string,
  ): Promise<Result<void>> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const active = this.#active;
    if (!isSafeNonNegative(positionMs)) {
      return err(
        appError('invalid-response', 'position must be safe nonnegative'),
      );
    }
    const before = r.queue.snapshot();
    if (before.currentOccurrenceId === null) {
      return err(appError('unavailable', 'no active playback to seek'));
    }
    // A gesture-bound seek names the row it started on; a cursor that
    // already moved must not take a position meant for its
    // predecessor. The drop reads as success — nothing went wrong,
    // the intent simply outlived its track.
    if (
      expectedOccurrenceId !== undefined &&
      before.currentOccurrenceId !== expectedOccurrenceId
    ) {
      return ok(undefined);
    }
    const persisted = await this.#host.mutateQueue(r, (q) =>
      q.seekTo(positionMs),
    );
    if (!persisted.ok) {
      return persisted;
    }
    this.#host.derived();
    if (active === null || active.handle === undefined) {
      // Seek intent rides on the queue snapshot; the next 'prepared'
      // outcome — in flight or from a later retry — plays from it.
      this.#host.publish();
      return ok(undefined);
    }
    if (this.#isStale(active)) {
      this.#host.publish();
      return ok(undefined);
    }
    const identity = this.#rekeyIdentity(
      active,
      r.queue.snapshot().revision,
    );
    // Publish the re-keyed identity before the transport call so a
    // supersede during the await can't leave a play/seek carrying an
    // identity no snapshot ever showed.
    this.#setPlaybackFromStatus(
      active,
      r.queue.snapshot().mode === 'paused' ? 'paused' : 'playing',
    );
    const result = await this.#host.bounded(() =>
      this.#player.seekTo({ positionMs, identity }),
    );
    if (!result.ok) {
      // Same dead-handle recovery as resume(): the queue commit
      // above already holds the seeked position, so the fresh
      // prepare autostarts (or parks, when paused) on it.
      if (
        DEAD_STREAM_KINDS.has(result.error.kind) &&
        !this.#isStale(active)
      ) {
        return this.startAttempt(active.occurrenceId);
      }
      return this.#failWith(active, result.error);
    }
    if (!this.#isStale(active)) {
      const mode = r.queue.snapshot().mode === 'paused' ? 'paused' : 'playing';
      this.#setPlaybackFromStatus(active, mode);
      this.#host.publish();
    }
    return ok(undefined);
  }

  async startAttempt(
    occurrenceId: string,
    retry?: {
      deadlineMs: number;
      listenedMsAccum: number;
      preparesUsed: number;
    },
  ): Promise<Result<void>> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    const occurrence = r.queue
      .snapshot()
      .occurrences.find((o) => o.occurrenceId === occurrenceId);
    const recording = r.recordings.find(
      (rec) => rec.id === occurrence?.recordingId,
    );
    if (occurrence === undefined || recording === undefined) {
      return err(appError('not-found', 'occurrence or recording missing'));
    }

    // Synchronously supersede the previous attempt, then create the
    // new identity and publish preparing before any await.
    const prev = this.#active;
    this.#active = null;
    if (prev !== null) {
      prev.source.cancel();
      prev.timer?.cancel();
    }
    const deadlineMs =
      retry !== undefined && isSafeNonNegative(retry.deadlineMs)
        ? retry.deadlineMs
        : this.#host.deadline();
    const attempt: ActiveAttempt = {
      identity: {
        attemptId: this.#ids.next('attempt'),
        queueRev: r.queue.snapshot().revision,
      },
      recordingId: recording.id,
      occurrenceId,
      source: new CancellationSource(),
      deadlineMs,
      autoRetried: retry !== undefined,
      preparedHandled: false,
      endedHandled: false,
      // Listening validated before a retried failure still counts —
      // the fresh handle re-baselines position, not the threshold.
      listenedMsAccum:
        retry !== undefined && isSafeNonNegative(retry.listenedMsAccum)
          ? retry.listenedMsAccum
          : 0,
      preparesUsed:
        retry !== undefined && isSafeNonNegative(retry.preparesUsed)
          ? retry.preparesUsed
          : 0,
    };
    this.#active = attempt;
    r.playback = {
      type: 'preparing',
      recordingId: recording.id,
      occurrenceId,
      identity: attempt.identity,
    };
    this.#host.publish();
    if (prev !== null) {
      await this.#teardownAttempt(prev);
    }

    let ref = this.#host.pickRef(recording, occurrence.selectedRef);
    // Offline zero-resolution gate: only owned bytes play. A null ref
    // would fire playback.candidates and a provider ref would start a
    // stream attach — both spend the network it doesn't have.
    const online = this.#host.isOnline();
    if (!online && (ref === null || ref.provider !== LOCAL_PROVIDER)) {
      return this.#failWith(
        attempt,
        appError('unavailable', 'offline — no local bytes for this recording'),
      );
    }
    if (ref === null) {
      const resolved = await this.#resolveViaCandidates(
        attempt,
        recording,
        occurrenceId,
        deadlineMs,
      );
      if (!resolved.ok) {
        return resolved;
      }
      ref = resolved.value;
    }
    if (ref === null) {
      return this.#failWith(
        attempt,
        appError('no-result', 'no playable source for recording'),
      );
    }
    // The pick is final here — consumers read `playback.ref` to mark
    // the catalog row the player actually resolved (a local pick
    // matches none, an already-running stream keeps its own ref).
    attempt.ref = ref;
    const r2 = this.#host.ready();
    if (
      r2 !== null &&
      r2.playback.type === 'preparing' &&
      attemptEq(r2.playback.identity, attempt.identity)
    ) {
      r2.playback = { ...r2.playback, ref };
      this.#host.publish();
    }
    // The playing ref is now known — an auto-arm queued while this
    // attempt was still resolving can seed the real version.
    this.#host.maybeArmRadio();
    if (this.#isStale(attempt) || attempt.source.signal.cancelled) {
      return err(sealedOrSuperseded(attempt.terminalError));
    }

    // A provider:'local' pick bypasses the plugin router — the adapter
    // attaches the URI directly (no resolve capability on a file).
    if (ref.provider !== LOCAL_PROVIDER) {
      const routed = this.#router.providerFor(
        'playback.resolve',
        selectionFromSettings(r.settings),
      );
      if (!routed.ok) {
        return this.#failWith(attempt, routed.error);
      }
    }
    // A warm session issued for this exact ref may still be live in
    // the seam's unattached slot: adopting it skips `player.prepare`
    // — the resolve latency is already spent. A warm for another row
    // is stale intent — drop it (the seam would supersede it anyway).
    // A same-key warm still resolving stays: the prepare's registry
    // coalescing adopts its session when it lands.
    const warm = this.#streamWarm;
    if (
      warm !== null &&
      (warm.provider !== ref.provider || warm.sourceRef !== ref.id)
    ) {
      this.#dropStreamWarm(warm);
    }
    if (
      warm !== null &&
      warm.stream !== null &&
      warm.provider === ref.provider &&
      warm.sourceRef === ref.id &&
      ref.provider !== LOCAL_PROVIDER
    ) {
      const stream = warm.stream;
      // OWNERSHIP TRANSFER: the warm's request slot (`wreq → handle`)
      // stays registered as the attempt's `requestId` — it is the
      // session's only host-side owner, so freeing it here would run
      // `cancel_if_unattached` on the handle we're about to play.
      // `preparedHandled` guards every later cancelPrepare for this
      // request; `release` by handle remains the session's exit.
      this.#streamWarm = null;
      warm.adoptedAttempt = attempt;
      attempt.preparedHandled = true;
      if (warm.requestId !== null) {
        attempt.requestId = warm.requestId;
      }
      const readyW = this.#host.ready();
      if (
        readyW !== null &&
        readyW.playback.type === 'preparing' &&
        attemptEq(readyW.playback.identity, attempt.identity)
      ) {
        readyW.playback = {
          ...readyW.playback,
          ...(attempt.requestId === undefined
            ? {}
            : { requestId: attempt.requestId }),
          ref,
        };
        this.#host.publish();
      }
      if (this.#isStale(attempt) || attempt.source.signal.cancelled) {
        return err(sealedOrSuperseded(attempt.terminalError));
      }
      return this.#adoptPrepared(attempt, stream, warm.attempt, true);
    }
    const prepared = await retryBounded({
      deadlineMs,
      signal: attempt.source.signal,
      clock: this.#clock,
      // The prepare budget is per intent, not per attempt — a
      // retried attempt spends only what its predecessor left.
      maxAttempts: Math.max(
        1,
        PREPARE_CALL_BUDGET - attempt.preparesUsed,
      ),
      call: () => {
        attempt.preparesUsed += 1;
        return this.#host.withDeadline(
          () =>
            this.#player.prepare({
              provider: ref.provider,
              sourceRef: ref.id,
              identity: attempt.identity,
            }),
          deadlineMs,
          // Every call shares the attempt's source — a supersede
          // aborts whichever prepare is in flight.
          attempt.source,
        );
      },
    });
    if (this.#isStale(attempt)) {
      return err(sealedOrSuperseded(attempt.terminalError));
    }
    if (!prepared.ok) {
      // terminalError is set before a retry handoff or supersede
      // cancels the source — the early wake is bookkeeping, not a
      // fresh failure to publish. A bare deadline-cancelled call has
      // no seal: its own verdict stands.
      return this.#failUnlessSealed(attempt, prepared);
    }
    if (attempt.source.signal.cancelled) {
      return err(sealedOrSuperseded(attempt.terminalError));
    }
    attempt.requestId = prepared.value;
    const ready2 = this.#host.ready();
    if (
      ready2 !== null &&
      ready2.playback.type === 'preparing' &&
      attemptEq(ready2.playback.identity, attempt.identity)
    ) {
      ready2.playback = {
        ...ready2.playback,
        requestId: prepared.value,
        ref,
      };
      this.#host.publish();
    }
    if (!attempt.preparedHandled) {
      this.#armPrepareTimeout(attempt);
    }
    return ok(undefined);
  }

  async #resolveViaCandidates(
    attempt: ActiveAttempt,
    recording: Recording,
    occurrenceId: string,
    deadlineMs: number,
  ): Promise<Result<SourceRef>> {
    const r = this.#host.ready();
    if (r === null) {
      return err(internalError());
    }
    const routed = this.#router.providerFor(
      'playback.candidates',
      selectionFromSettings(r.settings),
    );
    if (!routed.ok) {
      return err(routed.error);
    }
    const provider = routed.value;
    const query = recordingQuery(recording);
    const result = await retryBounded({
      deadlineMs,
      signal: attempt.source.signal,
      clock: this.#clock,
      call: (signal) =>
        boundedOp(
          this.#host,
          attempt.source,
          'cand',
          (ctx) => provider.candidates({ query, limit: CANDIDATE_LIMIT }, ctx),
          signal,
          deadlineMs,
        ),
    });
    if (this.#isStale(attempt)) {
      // A newer intent owns playback — the loser reports
      // 'superseded' whatever its in-flight call resolved to.
      return err(sealedOrSuperseded(attempt.terminalError));
    }
    if (!result.ok) {
      // terminalError is set before a retry handoff or supersede
      // cancels the source — the early wake is bookkeeping, not a
      // fresh failure to publish. A bare deadline-cancelled call has
      // no seal: its own verdict stands.
      // A source cancelled by the deadline or a retry handoff still
      // publishes the real verdict, not a bare 'superseded'.
      return this.#failUnlessSealed(attempt, result);
    }
    if (attempt.source.signal.cancelled) {
      return err(sealedOrSuperseded(attempt.terminalError));
    }
    // Malformed provider candidates can throw inside match — that
    // must fail the attempt honestly, not wedge it unwound.
    let outcome: MatchOutcome;
    try {
      outcome = MatchingEngine.match(
        recording,
        result.value,
        recording.mappings,
      );
    } catch (thrown) {
      return this.#failWith(attempt, fromUnknown(thrown));
    }
    if (outcome.type === 'ambiguous') {
      // Park the candidates for user resolution; the attempt still
      // fails honestly. The gate is emitted only once a review
      // actually exists — reporting it on a failed write would route
      // resolve surfaces to an empty queue, so the storage error is
      // what the attempt returns instead.
      const enqueued = await this.#host.enqueueStorage(() =>
        this.#corrections.enqueueReview(
          recording.id,
          outcome.candidates.map((c) => ({
            metadata: c.candidate,
            ref: c.candidate.sourceRef,
          })),
          attempt.source.signal,
        ),
      );
      if (!enqueued.ok) {
        this.#host.logWarn(`match review enqueue failed: ${enqueued.error.kind}`);
        return this.#failWith(attempt, enqueued.error);
      }
      return this.#failWith(attempt, appError('unavailable', MATCH_GATE_MESSAGE));
    }
    if (outcome.type === 'unavailable') {
      return this.#failWith(attempt, appError('no-result', outcome.reason));
    }
    const ref = outcome.candidate.sourceRef;
    const matchedAt = this.#host.safeNow();
    if (matchedAt === null) {
      return this.#failWith(attempt, internalError());
    }
    const mapping: SourceMapping = {
      ref,
      status: 'automatic',
      matchedAtMs: matchedAt,
      evidence: outcome.evidence,
    };
    // The adoption stages inside the storage segment: recordings and
    // the queue pin are re-derived against the freshest mirror and the
    // queue engine is swapped in only after a successful commit, so a
    // rolled-back queue write can never resurrect an uncommitted
    // mapping from a stale capture.
    const staged = await this.#host.commitStaged((ready) => {
      const current = ready.recordings.find((rec) => rec.id === recording.id);
      if (current === undefined) {
        return err(appError('not-found', 'recording was removed'));
      }
      const hasMapping = current.mappings.some((m) => sameRef(m.ref, ref));
      const updated: Recording = {
        ...current,
        mappings: hasMapping
          ? current.mappings.map((m) => (sameRef(m.ref, ref) ? mapping : m))
          : [...current.mappings, mapping],
        sourceRefs: current.sourceRefs.some((s) => sameRef(s, ref))
          ? current.sourceRefs
          : [...current.sourceRefs, ref],
      };
      const draft = ready.queue.fork();
      try {
        draft.setSelectedRef(occurrenceId, ref);
      } catch (thrown) {
        return err(fromUnknown(thrown));
      }
      const recordings = ready.recordings.map((rec) =>
        rec.id === updated.id ? updated : rec,
      );
      return ok<PlaybackStage<SourceRef>>({
        batch: { recordings, queue: draft.snapshot() },
        apply: (rr) => {
          rr.recordings = recordings;
          rr.queue = draft;
          return ref;
        },
      });
    });
    this.#host.derived();
    if (!staged.ok) {
      // The adoption never committed — memory stayed on storage's
      // truth, but the ref resolved fine: the resolve contract is
      // met and playback proceeds unpinned.
      this.#host.logWarn('mapping adoption commit failed');
    }
    return ok(ref);
  }

  /** Arms the remainder of the absolute deadline for a prepared outcome. */
  #armPrepareTimeout(attempt: ActiveAttempt): void {
    const timer = new CancellationSource();
    attempt.timer = timer;
    const untrackTimer = this.#host.trackTimer(timer);
    const work = (async () => {
      const now = this.#host.safeNow();
      const remaining = now === null ? 0 : attempt.deadlineMs - now;
      const slept =
        remaining > 0
          ? await this.#host.call(() =>
            this.#clock.sleep(remaining, timer.signal),
          )
          : ok(undefined);
      untrackTimer();
      if (
        this.#isStale(attempt) ||
        attempt.preparedHandled ||
        this.#host.disposed()
      ) {
        return;
      }
      if (!slept.ok) {
        // A cancelled timer (supersede/dispose) is a no-op; an
        // internal clock failure must not leave the attempt
        // preparing forever.
        if (slept.error.kind !== 'internal') {
          return;
        }
        attempt.source.cancel();
        if (attempt.requestId !== undefined) {
          await this.#cancelPrepare(attempt.requestId, attempt.identity);
        }
        await this.#failAttempt(attempt, internalError());
        return;
      }
      attempt.source.cancel();
      if (attempt.requestId !== undefined) {
        await this.#cancelPrepare(attempt.requestId, attempt.identity);
      }
      await this.#failAttempt(attempt, timeoutError());
    })();
    this.#host.own(work, true);
  }

  async #teardownAttempt(attempt: ActiveAttempt): Promise<void> {
    attempt.source.cancel();
    attempt.timer?.cancel();
    if (!attempt.preparedHandled && attempt.requestId !== undefined) {
      await this.#cancelPrepare(attempt.requestId, attempt.identity);
    }
    if (attempt.handle !== undefined) {
      await this.#releaseHandle(attempt.handle, attempt.identity);
    }
    await this.#drainLeakedHandles();
  }

  /**
   * Handles dropped from an attempt after a failed release get a
   * fresh coalesced re-offer — once per drain, so a dead release
   * can't strand a native handle for the session's life.
   */
  async #drainLeakedHandles(): Promise<void> {
    if (this.#leakedHandles.size === 0) {
      return;
    }
    const leaked = [...this.#leakedHandles];
    this.#leakedHandles.clear();
    await Promise.allSettled(
      leaked.map(([handle, identity]) =>
        this.#releaseHandle(handle, identity),
      ),
    );
  }

  /** Supersede and tear down the current active attempt, if any. */
  async supersede(): Promise<void> {
    const prev = this.#active;
    this.#active = null;
    if (prev !== null) {
      await this.#teardownAttempt(prev);
    }
  }

  /**
   * Releases a handle through the bounded port call, coalescing
   * concurrent releases per handle. Only a successful result marks
   * the handle released; failures leave it retryable.
   */
  #releaseHandle(
    handle: string,
    identity: PlaybackIdentity,
  ): Promise<Result<void>> {
    if (this.#releasedHandles.has(handle)) {
      return Promise.resolve(ok(undefined));
    }
    const existing = this.#releaseWork.get(handle);
    if (existing !== undefined) {
      return existing;
    }
    const work = (async () => {
      const result = await this.#host.bounded(() =>
        this.#player.release({ handle, identity }),
      );
      this.#releaseWork.delete(handle);
      if (result.ok || DEAD_STREAM_KINDS.has(result.error.kind)) {
        // A dead-handle failure means the registry already dropped
        // it — there is nothing left to release, so retrying would
        // only re-offer a phantom forever.
        this.#releasedHandles.add(handle);
        this.#leakedHandles.delete(handle);
      } else {
        // Ownership outlives the attempt slot: teardown re-offers.
        this.#leakedHandles.set(handle, identity);
      }
      return result;
    })();
    this.#releaseWork.set(handle, work);
    return work;
  }

  /**
   * An event-driven failure — a rejected prepare outcome, a refused
   * play, a mid-play 'failed' status — gets one re-attempt inside
   * the attempt's original deadline before the queue marks the item
   * unplayable. The budget includes retries, so a transient hiccup
   * should not stop the queue; a non-retryable verdict or a spent
   * budget still fails straight through. Playback stays published as
   * preparing throughout — no failed flicker while recovery is
   * still possible — and a supersede or dispose during the backoff
   * abandons the retry.
   */
  async #failOrRetryAttempt(
    attempt: ActiveAttempt,
    error: AppError,
  ): Promise<void> {
    const now = this.#host.safeNow();
    const remaining = now === null ? 0 : attempt.deadlineMs - now;
    // retryAfterMs is the provider's floor — squeezing it to fit the
    // budget would re-attempt sooner than permitted, so a wait that
    // leaves too little room fails with the original verdict.
    const wait = Math.max(
      error.retryAfterMs ?? 0,
      AUTO_RETRY_BACKOFF_MS,
    );
    if (
      !error.retryable ||
      attempt.autoRetried === true ||
      attempt.preparesUsed >= PREPARE_CALL_BUDGET ||
      this.#host.disposed() ||
      this.#isStale(attempt) ||
      wait + AUTO_RETRY_MIN_BUDGET_MS > remaining
    ) {
      await this.#failAttempt(attempt, error);
      return;
    }
    attempt.autoRetried = true;
    attempt.terminalError ??= error;
    // Kill the attempt's own source now: a still-pending prepare or
    // resolve unwinds at its cancelled checkpoints with the real
    // verdict instead of racing the retry.
    attempt.source.cancel();
    // Stop advertising the dead stream: while the backoff runs the
    // occurrence republishes as preparing — a live playing/paused
    // state would keep offering a handle that no longer exists, and
    // controls (pause/seek) would spend calls on it.
    const ready = this.#host.ready();
    if (
      ready !== null &&
      this.#active === attempt &&
      (ready.playback.type === 'playing' ||
        ready.playback.type === 'paused' ||
        ready.playback.type === 'buffering') &&
      attemptEq(ready.playback.identity, attempt.identity)
    ) {
      ready.playback = {
        type: 'preparing',
        recordingId: attempt.recordingId,
        occurrenceId: attempt.occurrenceId,
        identity: attempt.identity,
        ...(attempt.ref !== undefined ? { ref: attempt.ref } : {}),
      };
      this.#host.publish();
    }
    // The dead stream's handle goes now — the retry prepares a fresh
    // one — and with it gone, stray status events for this attempt
    // are rejected instead of republishing mid-backoff.
    if (attempt.handle !== undefined) {
      const handle = attempt.handle;
      // exactOptionalPropertyTypes: cleared slots get `delete`, not
      // an explicit undefined.
      delete attempt.handle;
      await this.#releaseHandle(handle, attempt.identity);
    }
    // The backoff rides attempt.timer — startAttempt's supersede
    // (new play intent, teardown) cancels it and kills the retry.
    // A leftover timer (e.g. the armed prepare timeout) is cancelled
    // first so it can't fire a duplicate failure mid-backoff.
    attempt.timer?.cancel();
    const timer = new CancellationSource();
    attempt.timer = timer;
    // Backoff and the re-attempt run as owned work, not on the event
    // tail — a re-prepare that blocks must not stall every player
    // event queued behind it.
    this.#host.own(this.#retryAfter(attempt, timer, wait));
  }

  async #retryAfter(
    attempt: ActiveAttempt,
    timer: CancellationSource,
    wait: number,
  ): Promise<void> {
    const slept = await this.#host.call(() =>
      this.#clock.sleep(wait, timer.signal),
    );
    if (
      this.#host.disposed() ||
      this.#isStale(attempt) ||
      timer.signal.cancelled
    ) {
      // Superseded or torn down mid-backoff — the superseder owns
      // playback state now.
      return;
    }
    if (!slept.ok) {
      if (slept.error.kind === 'internal') {
        await this.#failAttempt(attempt, slept.error);
      }
      // A cancelled sleep means a supersede already ran — leave the
      // state it published alone.
      return;
    }
    // A returned err is already published by #failAttempt inside
    // startAttempt — the Result is for the original caller chain
    // that no longer exists here. Validated listening time carries
    // across the retry so a mid-play failure doesn't zero the play
    // threshold's progress.
    await this.startAttempt(attempt.occurrenceId, {
      deadlineMs: attempt.deadlineMs,
      listenedMsAccum: attempt.listenedMsAccum,
      preparesUsed: attempt.preparesUsed,
    });
  }

  async #failAttempt(
    attempt: ActiveAttempt,
    error: AppError,
  ): Promise<void> {
    attempt.terminalError ??= error;
    attempt.source.cancel();
    attempt.timer?.cancel();
    if (attempt.handle !== undefined) {
      await this.#releaseHandle(attempt.handle, attempt.identity);
    }
    if (this.#active !== attempt) {
      // A stale failure only releases its own handle; it must never
      // overwrite a newer attempt's playback or queue state.
      return;
    }
    this.#active = null;
    const r = this.#host.ready();
    if (r === null) {
      return;
    }
    const before = r.queue.snapshot();
    const beforeMarks = r.queue.unplayableIds;
    if (before.currentOccurrenceId === attempt.occurrenceId) {
      try {
        r.queue.markUnplayable(error);
      } catch {
        // Revision overflow: still publish the failure.
      }
    }
    r.playback = {
      type: 'failed',
      recordingId: attempt.recordingId,
      occurrenceId: attempt.occurrenceId,
      identity: attempt.identity,
      error,
    };
    this.#host.publish();
    await this.#host.persistQueue(r, before, beforeMarks);
    this.#host.derived();
  }

  /** Fail the attempt, propagating the verdict as the result. */
  async #failWith(
    attempt: ActiveAttempt,
    error: AppError,
  ): Promise<Result<never>> {
    await this.#failAttempt(attempt, error);
    return err(error);
  }

  /**
   * A settled call's failure fails the attempt — unless a seal owns
   * the verdict already (a retry handoff or supersede cancelled the
   * source; the early wake is bookkeeping, not a fresh failure).
   */
  async #failUnlessSealed(
    attempt: ActiveAttempt,
    settled: { readonly ok: false; readonly error: AppError },
  ): Promise<Result<never>> {
    if (attempt.terminalError !== undefined) {
      return err(attempt.terminalError);
    }
    await this.#failAttempt(attempt, settled.error);
    return settled;
  }

  /** cancelPrepare on an issued request slot. */
  async #cancelPrepare(
    requestId: string,
    identity: PlaybackIdentity,
  ): Promise<void> {
    await this.#host.bounded(() =>
      this.#player.cancelPrepare({ requestId, identity }),
    );
  }

  /** Re-key the attempt to the live queue revision. */
  #rekeyIdentity(
    attempt: ActiveAttempt,
    queueRev: number,
  ): PlaybackIdentity {
    const identity: PlaybackIdentity = {
      attemptId: attempt.identity.attemptId,
      queueRev,
    };
    attempt.identity = identity;
    return identity;
  }

  #setPlaybackFromStatus(
    attempt: ActiveAttempt,
    state: 'buffering' | 'playing' | 'paused',
    durationMs?: number,
  ): void {
    const r = this.#host.ready();
    if (r === null || attempt.handle === undefined) {
      return;
    }
    // A control-path publish (seek/pause/resume) reaches here without
    // a fresh duration: carry the duration the same attempt last
    // published so the interim state never reports `null` — the seek
    // bar disables itself when duration is null, which is what broke
    // mid-drag scrubs (the seek's own re-key publish killed it). The
    // carry is attempt-scoped, not recording-scoped: a new attempt —
    // re-prepare after a source change — reports only the duration
    // its own player surfaces, so a stale range can't ride forward.
    const prior = r.playback;
    const carried =
      durationMs ??
      (prior !== undefined &&
        (prior.type === 'buffering' ||
          prior.type === 'playing' ||
          prior.type === 'paused') &&
        prior.recordingId === attempt.recordingId &&
        prior.identity.attemptId === attempt.identity.attemptId
        ? prior.durationMs
        : undefined);
    r.playback = {
      type: state,
      recordingId: attempt.recordingId,
      occurrenceId: attempt.occurrenceId,
      identity: attempt.identity,
      handle: attempt.handle,
      positionMs: r.queue.snapshot().positionMs,
      ...(attempt.ref === undefined ? {} : { ref: attempt.ref }),
      ...(carried === undefined ? {} : { durationMs: carried }),
    };
    this.#host.publish();
  }

  // ---- player events ------------------------------------------------

  onPlayerEvent(event: PlayerEvent): void {
    // Serialized chain: no fire-and-forget, drainable, errors mapped.
    // The catch is part of the lane's work so drain() also awaits the
    // error callback — not just the handler that rejected.
    this.#eventSerial.run(() =>
      this.#handleEvent(event).catch(() => {
        this.#host.logWarn('player event handling failed');
      }),
    );
  }

  async #handleEvent(event: PlayerEvent): Promise<void> {
    const r = this.#host.ready();
    if (r === null || this.#host.disposed()) {
      return;
    }
    if (event.type === 'phase') {
      // Diagnostics only: fixed sanitized message, never raw payload.
      this.#host.logWarn('player phase observed');
      return;
    }
    if (event.type === 'prepare') {
      // Advisory warms carry their own `warm-*` attemptId — their
      // outcomes never reach the attempt pipeline: a dropped warm's
      // stale outcome lands in the generic path, which releases a
      // 'prepared' handle idempotently.
      const warm = this.#streamWarm;
      if (warm !== null && warm.attemptId === event.identity.attemptId) {
        await this.#handleWarmOutcome(event, warm);
        return;
      }
      await this.#handlePrepareEvent(event);
      return;
    }
    if (event.type === 'queue-transition') {
      await this.#handleTransition(event);
      return;
    }
    // status events
    const active = this.#active;
    if (
      active === null ||
      !attemptEq(event.identity, active.identity) ||
      active.handle === undefined ||
      event.handle !== active.handle ||
      !isSafeNonNegative(event.positionMs) ||
      (event.durationMs !== undefined &&
        !isSafeNonNegative(event.durationMs))
    ) {
      if (event.state !== 'idle') {
        this.#host.logWarn('player status rejected');
      }
      return;
    }
    // Listened time accumulates real deltas between status ticks —
    // a seek forward must not mint a play for a span that never
    // played, and a position regression must not subtract. Anything
    // above the cap is a jump, not playback: no credit, just a new
    // baseline. 'ended' joins the same accumulator — its absolute
    // end position after a tail seek would otherwise mint unplayed
    // time through the threshold.
    if (event.state === 'playing' || event.state === 'ended') {
      const lastPos = active.lastStatusPositionMs;
      if (lastPos !== undefined && event.positionMs > lastPos) {
        const delta = event.positionMs - lastPos;
        if (delta <= MAX_TICK_DELTA_MS) {
          active.listenedMsAccum += delta;
        }
      }
      active.lastStatusPositionMs = event.positionMs;
    }
    await this.#maybeRecordPlay(
      active.occurrenceId,
      active.recordingId,
      active.listenedMsAccum,
      event.durationMs ??
      r.recordings.find((rec) => rec.id === active.recordingId)
        ?.durationMs ??
      null,
    );
    if (event.state === 'failed') {
      const error = event.error ?? appError('transient', 'player failed');
      if (DEAD_STREAM_KINDS.has(error.kind) && !this.#isStale(active)) {
        // The stream's death can arrive async too — a paused seek
        // past the registry TTL makes the element refetch a dead
        // URL, which surfaces here, not on a transport call. The
        // queue holds the committed position; re-prepare.
        await this.startAttempt(active.occurrenceId);
        return;
      }
      await this.#failOrRetryAttempt(active, error);
      return;
    }
    if (event.state === 'ended') {
      if (active.endedHandled) {
        return;
      }
      let marker = this.#projection;
      while (marker !== null && marker.status === 'pending') {
        await marker.done;
        marker = this.#projection;
      }
      if (
        marker !== null &&
        marker.status === 'installed' &&
        marker.currentOccurrenceId === active.occurrenceId
      ) {
        // The service owns the advance inside the installed
        // projection; the queue-transition event reconciles it. JS
        // must not advance a second time.
        active.endedHandled = true;
        return;
      }
      active.endedHandled = true;
      if (active.handle !== undefined) {
        await this.#releaseHandle(active.handle, event.identity);
      }
      if (this.#isStale(active)) {
        return;
      }
      active.source.cancel();
      active.timer?.cancel();
      this.#active = null;
      const before = r.queue.snapshot();
      const beforeMarks = r.queue.unplayableIds;
      const dealt = this.#host.dealtOrder(r);
      try {
        // repeat=one replays the cursor item; repeat=all wraps a tail
        // end back to the head — the same rules the service follows.
        if (r.repeat === 'one' && before.currentOccurrenceId !== null) {
          r.queue.select(before.currentOccurrenceId, true);
          bumpListenCycle(r, before.currentOccurrenceId);
        } else if (dealt === null) {
          r.queue.next();
          if (r.repeat === 'all') {
            const tail = r.queue.snapshot();
            const head =
              tail.currentOccurrenceId === null
                ? tail.occurrences.find(
                    (o) => !r.queue.isUnplayable(o.occurrenceId),
                  )
                : undefined;
            if (head !== undefined) {
              r.queue.select(head.occurrenceId, true);
              bumpListenCycle(r, head.occurrenceId);
            }
          }
        } else {
          // Under shuffle the fallback walks the dealt order with the
          // same mark-skips advance() applies: dealt successor, first
          // unmarked dealt head under repeat=all, else run off.
          const pos =
            before.currentOccurrenceId === null
              ? -1
              : dealt.indexOf(before.currentOccurrenceId);
          const nextId =
            pos >= 0
              ? dealt.slice(pos + 1).find((id) => !r.queue.isUnplayable(id))
              : undefined;
          if (nextId !== undefined) {
            r.queue.select(nextId, true);
          } else if (r.repeat === 'all' && dealt.length > 0) {
            const head = dealt.find((id) => !r.queue.isUnplayable(id));
            if (head !== undefined) {
              r.queue.select(head, true);
              bumpListenCycle(r, head);
            }
          } else {
            r.queue.stop();
          }
        }
      } catch {
        return;
      }
      const advanced = await this.#host.persistQueue(r, before, beforeMarks);
      this.#host.derived();
      const snap = r.queue.snapshot();
      // A failed advance rolls the queue back onto the ended item —
      // never replay it; go idle instead.
      if (
        !advanced.ok ||
        snap.currentOccurrenceId === null ||
        snap.mode !== 'playing'
      ) {
        r.playback = { type: 'idle' };
        this.#host.publish();
        return;
      }
      await this.startAttempt(snap.currentOccurrenceId);
      return;
    }
    // Remote pause/play reconciles queue intent with the service.
    const remoteMode =
      event.state === 'paused'
        ? 'playing'
        : event.state === 'playing'
          ? 'paused'
          : null;
    if (remoteMode !== null) {
      const before = r.queue.snapshot();
      if (before.mode === remoteMode) {
        const beforeMarks = r.queue.unplayableIds;
        try {
          if (event.state === 'paused') {
            r.queue.pause();
          } else {
            r.queue.play();
          }
        } catch {
          return;
        }
        const priorIdentity = active.identity;
        this.#rekeyIdentity(active, r.queue.snapshot().revision);
        const synced = await this.#host.persistQueue(r, before, beforeMarks);
        if (!synced.ok && this.#active === active) {
          // Rolled back — the live engine is at `before`'s revision.
          active.identity = priorIdentity;
        }
        this.#host.derived();
      }
    }
    if (this.#isStale(active)) {
      return;
    }
    r.queue.observePosition(event.positionMs);
    const mapped =
      event.state === 'idle' ||
        event.state === 'buffering' ||
        event.state === 'ready'
        ? 'buffering'
        : event.state;
    if (mapped === 'buffering' || mapped === 'playing' || mapped === 'paused') {
      const prev = r.playback;
      r.playback = {
        type: mapped,
        recordingId: active.recordingId,
        occurrenceId: active.occurrenceId,
        identity: active.identity,
        handle: active.handle,
        positionMs: event.positionMs,
        ...(active.ref === undefined ? {} : { ref: active.ref }),
        ...(event.durationMs === undefined
          ? {}
          : { durationMs: event.durationMs }),
      };
      // A status tick that moved only the position takes the light
      // channel — whole-state subscribers aren't woken for it.
      if (
        (prev.type === 'buffering' ||
          prev.type === 'playing' ||
          prev.type === 'paused') &&
        prev.type === mapped &&
        prev.recordingId === active.recordingId &&
        prev.occurrenceId === active.occurrenceId &&
        prev.identity === active.identity &&
        prev.handle === active.handle &&
        prev.ref === active.ref &&
        prev.durationMs === event.durationMs
      ) {
        this.#host.publishPosition();
      } else {
        this.#host.publish();
      }
      if (mapped === 'playing') {
        // The deal/queue rev is settled by now — the dealt
        // successor's advisory warm may (re)issue.
        this.#maybeWarmStream();
      }
    }
  }

  async #handlePrepareEvent(
    event: Extract<PlayerEvent, { type: 'prepare' }>,
  ): Promise<void> {
    const active = this.#active;
    const r = this.#host.ready();
    if (
      active === null ||
      r === null ||
      !attemptEq(event.identity, active.identity) ||
      this.#isStale(active)
    ) {
      // Stale identity: release the handle idempotently, never play —
      // unless it is the live handle of the current active attempt.
      if (event.outcome.type === 'prepared') {
        const handle = event.outcome.stream.handle;
        if (this.#active?.handle !== handle) {
          await this.#releaseHandle(handle, event.identity);
        }
      }
      return;
    }
    if (active.preparedHandled) {
      // A duplicate prepared carrying the adopted handle is ignored;
      // only a different duplicate handle is released.
      if (
        event.outcome.type === 'prepared' &&
        event.outcome.stream.handle !== active.handle
      ) {
        await this.#releaseHandle(
          event.outcome.stream.handle,
          event.identity,
        );
      }
      return;
    }
    active.preparedHandled = true;
    active.timer?.cancel();
    if (event.outcome.type === 'failed') {
      const attempts = [event.outcome.attempt];
      await this.#failOrRetryAttempt(active, event.outcome.error);
      await this.#host.persist({ attempts });
      return;
    }
    // The prepare may have coalesced onto the warm's session — the
    // attempt owns the handle now; only the warm's request slot
    // needs freeing.
    const warm = this.#streamWarm;
    if (
      warm !== null &&
      warm.stream?.handle === event.outcome.stream.handle
    ) {
      this.#streamWarm = null;
      this.#freeWarmRequest(warm);
    }
    await this.#adoptPrepared(
      active,
      event.outcome.stream,
      event.outcome.attempt,
      // A prepared handle can already be dead (seam coalescing onto
      // an aged session, TTL expiry between mint and attach) —
      // re-prepare instead of marking the occurrence unplayable.
      true,
    );
  }

  /**
   * The shared tail of a 'prepared' outcome: record the handle, hold
   * autostart under a paused queue, else issue `player.play`.
   * `reprepareOnDeadHandle` re-runs the whole attempt when the handle
   * died between mint and attach (dead-resource kinds only) — a warm
   * or coalesced session can outdate while a fresh mint cannot.
   */
  async #adoptPrepared(
    active: ActiveAttempt,
    stream: PreparedStream,
    attempt: AttemptTrace | null,
    reprepareOnDeadHandle: boolean,
  ): Promise<Result<void>> {
    const r = this.#host.ready();
    if (r === null) {
      return err(internalError());
    }
    active.handle = stream.handle;
    if (r.queue.snapshot().mode === 'paused') {
      // Paused while the prepare was in flight — user intent wins:
      // hold the handle and report paused, never autostart.
      this.#setPlaybackFromStatus(active, 'paused');
      if (attempt !== null) {
        await this.#host.persist({ attempts: [attempt] });
      }
      this.maybeMapSuccessor();
      return ok(undefined);
    }
    const playResult = await this.#host.bounded(() =>
      this.#player.play({
        handle: stream.handle,
        identity: active.identity,
        positionMs: r.queue.snapshot().positionMs,
      }),
    );
    if (this.#isStale(active)) {
      return err(sealedOrSuperseded(active.terminalError));
    }
    if (!playResult.ok) {
      if (
        reprepareOnDeadHandle &&
        DEAD_STREAM_KINDS.has(playResult.error.kind)
      ) {
        // Same recovery as a dead-handle 'failed' status: the queue
        // still holds the intent — a fresh prepare resolves honestly.
        return this.startAttempt(active.occurrenceId);
      }
      await this.#failOrRetryAttempt(active, playResult.error);
      // The trace survives the transport failure, same contract as
      // the prepare-failure branch above.
      if (attempt !== null) {
        await this.#host.persist({ attempts: [attempt] });
      }
      // An armed retry keeps this attempt as the live one — the
      // intent still holds, so the call is not a failure. A straight
      // `#failAttempt` cleared `#active`: propagate the verdict.
      return this.#active === active
        ? ok(undefined)
        : err(active.terminalError ?? playResult.error);
    }
    this.#setPlaybackFromStatus(active, 'buffering');
    if (attempt !== null) {
      await this.#host.persist({ attempts: [attempt] });
    }
    this.maybeMapSuccessor();
    return ok(undefined);
  }

  // ---- queue projection ----------------------------------------------

  #buildProjection(): QueueProjection | null {
    const r = this.#host.ready();
    if (r === null) {
      return null;
    }
    const snap = r.queue.snapshot();
    // Offline honesty: items without local bytes project null refs so
    // the native cursor can't attempt a network attach for them.
    const online = this.#host.isOnline();
    const items: QueueProjectionItem[] = snap.occurrences.map(
      (occurrence) => {
        const recording = r.recordings.find(
          (rec) => rec.id === occurrence.recordingId,
        );
        const picked =
          recording === undefined
            ? null
            : this.#host.pickRef(recording, occurrence.selectedRef);
        const selected =
          !online && picked !== null && picked.provider !== LOCAL_PROVIDER
            ? null
            : picked;
        const artwork = recording?.artwork.find(
          (a) => typeof a.url === 'string' && a.url.startsWith('https://'),
        );
        return {
          occurrenceId: occurrence.occurrenceId,
          provider: selected?.provider ?? null,
          sourceRef: selected?.id ?? null,
          title: recording?.title ?? 'Unknown',
          artist: recording?.artist ?? null,
          artworkUrl: artwork?.url ?? null,
          skipsForward: r.queue.isUnplayable(occurrence.occurrenceId)
            ? true
            : undefined,
        };
      },
    );
    // The walk the cursor steps through: the dealt order under shuffle,
    // the identity otherwise — `items` itself stays canonical. Rows the
    // engine marked failed stay IN the walk flagged `skipsForward`:
    // forward moves (ended / remote-next / repeat wrap) must step over
    // them the way next() does, while media-control previous still
    // reaches them the way previous() does. A single order carries both
    // rules — dropping them would silently strand backward moves.
    const dealt = this.#host.dealtOrder(r);
    const indexOfId = new Map(
      snap.occurrences.map((o, i) => [o.occurrenceId, i] as const),
    );
    const order =
      dealt === null
        ? snap.occurrences.map((_, i) => i)
        : dealt
            .map((id) => indexOfId.get(id))
            .filter((i): i is number => i !== undefined);
    return {
      projectionId: this.#ids.next('projection'),
      queueRev: snap.revision,
      currentOccurrenceId: snap.currentOccurrenceId,
      positionMs: snap.positionMs,
      mode: snap.mode,
      repeat: r.repeat,
      order,
      items,
    };
  }

  /** Sends the latest projection; failures never undo queue intent. */
  async projectQueue(): Promise<void> {
    const projection = this.#buildProjection();
    if (projection === null) {
      return;
    }
    const active = this.#active;
    if (active !== null && active.occurrenceId === projection.currentOccurrenceId) {
      this.#rekeyIdentity(active, projection.queueRev);
    }
    const marker: ProjectionMarker = {
      projection,
      currentOccurrenceId: projection.currentOccurrenceId,
      reconciledQueueRev: projection.queueRev,
      status: 'pending',
      done: Promise.resolve(),
    };
    const displaced = this.#projection;
    if (displaced !== null && displaced.status === 'pending') {
      // The awaited `done` still resolves, but the marker stops
      // pretending to be the latest word — readers checking
      // `status` after the wait see 'superseded', not 'installed'.
      displaced.status = 'superseded';
    }
    this.#projection = marker;
    this.#installedProjections.set(projection.projectionId, projection);
    // Bound the lookup — projections mint one id per install.
    while (this.#installedProjections.size > 8) {
      const oldest = this.#installedProjections.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#installedProjections.delete(oldest);
    }
    marker.done = (async () => {
      const result = await this.#host.bounded(() =>
        this.#player.setQueueProjection(projection),
      );
      // A newer projection already superseded this call's marker.
      if (this.#projection !== marker) {
        return;
      }
      marker.status = result.ok ? 'installed' : 'failed';
      if (!result.ok) {
        const r = this.#host.ready();
        if (r !== null) {
          // Fixed shell error: port details never surface raw.
          r.persistenceError = internalError();
          this.#host.publish();
        }
        this.#host.logWarn('queue projection failed');
      }
    })();
    await marker.done;
  }

  /**
   * Reconciles a native cursor transition inside the projected queue.
   * The service executes a cursor, not arbitrary queue edits: `from`
   * must be the last reconciled current, `ended`/`remote-next` may only
   * reach the immediate successor (or null at the tail), and
   * `remote-previous` may only restart the current or step to the
   * immediate predecessor.
   */
  async #handleTransition(
    event: Extract<PlayerEvent, { type: 'queue-transition' }>,
  ): Promise<void> {
    const r = this.#host.ready();
    if (r === null) {
      return;
    }
    let marker = this.#projection;
    while (marker !== null && marker.status === 'pending') {
      await marker.done;
      marker = this.#projection;
    }
    const projection =
      marker !== null && marker.status === 'installed'
        ? marker.projection
        : null;
    const items = projection?.items ?? [];
    const cursorIndex =
      projection === null
        ? -1
        : items.findIndex(
          (i) => i.occurrenceId === marker?.currentOccurrenceId,
        );
    // Legal edges live in walk space — the dealt order under the
    // projection the service actually executed. A superseding install
    // (e.g. a shuffle toggle mid-flight) must not re-judge the edge
    // under the new deal — the player already attached its target —
    // so resolve the event's own projection when it is still known,
    // else fall back to the installed one, else the canonical order.
    const recorded = this.#installedProjections.get(event.projectionId);
    const executed = recorded ?? projection;
    // The lookup is bounded (8 installs): a projection evicted before
    // its move events land CANNOT be re-judged — a wrap that was legal
    // under the executed order reads illegal under a re-shuffled one,
    // and rejecting diverges the cursor from what the service is
    // playing. An unknown id therefore skips only the walk-space
    // legality below; the identity/revision checks still apply.
    const edgeUnverifiable = recorded === undefined;
    const execItems = executed?.items ?? [];
    // The walk is a subsequence — failed rows drop out while `items`
    // keeps them, so a shorter order is the intended skip, not
    // malformation; only an absent walk falls back to identity.
    const execOrder =
      executed === null || executed.order.length === 0
        ? execItems.map((_, i) => i)
        : executed.order;
    const execCursor =
      marker === null || marker.currentOccurrenceId === null
        ? -1
        : execItems.findIndex(
          (i) => i.occurrenceId === marker.currentOccurrenceId,
        );
    const orderPos = execCursor < 0 ? -1 : execOrder.indexOf(execCursor);
    const atWalk = (pos: number): string | null =>
      execItems[execOrder[pos] ?? -1]?.occurrenceId ?? null;
    // Forward moves step over `skipsForward` rows — the same skip the
    // cursors and engine next() apply. The wrap target is the first
    // unflagged entry from the walk's head; a flagged row behind the
    // cursor stays legal only for backward moves.
    const forwardAt = (fromPos: number): string | null => {
      for (let i = fromPos + 1; i < execOrder.length; i += 1) {
        const item = execItems[execOrder[i] ?? -1];
        if (item !== undefined && item.skipsForward !== true) {
          return item.occurrenceId;
        }
      }
      return null;
    };
    const firstUnflagged = (): string | null => forwardAt(-1);
    // A service move emits the projection it captured at move-start,
    // which can lag one JS install. Its identity echoes that captured
    // rev (a fresh attach keys to proj.queueRev) while a same-item
    // restart echoes the live re-keyed attach rev — either proves the
    // event; only a revision newer than the install is impossible.
    const currentProjection =
      projection !== null &&
      event.projectionId === projection.projectionId &&
      event.projectedQueueRev === projection.queueRev;
    const staleReconcilable =
      !currentProjection &&
      projection !== null &&
      event.projectedQueueRev <= projection.queueRev;
    const identityOk =
      event.toOccurrenceId === null
        ? event.identity === null && event.handle === null
        : event.identity !== null &&
        event.handle !== null &&
        event.handle.length > 0 &&
        event.identity.attemptId.length > 0 &&
        (event.identity.queueRev === projection?.queueRev ||
          event.identity.queueRev === event.projectedQueueRev);
    let legal = false;
    // The edge was legal only because of a repeat rule — the target
    // starts a fresh listen, which the play dedup counts as a new loop.
    let repeatEdge = false;
    if (event.reason === 'ended' || event.reason === 'remote-next') {
      const successor = orderPos >= 0 ? forwardAt(orderPos) : null;
      legal = edgeUnverifiable || event.toOccurrenceId === successor;
      // repeat=one replays the cursor item on `ended` — a same-item
      // edge is legal only there (remote-next still advances). The
      // executed projection's rule governs — it is what the service
      // ran, and may lag the live install by a toggle.
      if (
        !legal &&
        executed?.repeat === 'one' &&
        event.reason === 'ended' &&
        event.toOccurrenceId !== null &&
        event.toOccurrenceId === event.fromOccurrenceId
      ) {
        legal = true;
        repeatEdge = true;
      }
      // repeat=all wraps a stalled walk back to its first unflagged
      // entry — the cursor wraps wherever forward skipping ran out,
      // not only at the literal tail.
      if (
        !legal &&
        executed?.repeat === 'all' &&
        orderPos >= 0 &&
        successor === null &&
        event.toOccurrenceId !== null &&
        event.toOccurrenceId === firstUnflagged()
      ) {
        legal = true;
        repeatEdge = true;
      }
    } else if (event.reason === 'remote-previous') {
      const predecessor = orderPos > 0 ? atWalk(orderPos - 1) : null;
      legal =
        edgeUnverifiable ||
        (event.toOccurrenceId !== null &&
          event.toOccurrenceId === event.fromOccurrenceId) ||
        (predecessor !== null &&
          event.toOccurrenceId === predecessor);
      // repeat=all wraps a dealt-head move to the dealt tail.
      if (
        !legal &&
        executed?.repeat === 'all' &&
        orderPos === 0 &&
        execOrder.length > 1 &&
        event.toOccurrenceId === atWalk(execOrder.length - 1)
      ) {
        legal = true;
        repeatEdge = true;
      }
    }
    if (
      projection === null ||
      marker === null ||
      cursorIndex < 0 ||
      r.queue.snapshot().revision !== marker.reconciledQueueRev ||
      event.fromOccurrenceId !== marker.currentOccurrenceId ||
      !legal ||
      !identityOk ||
      !isSafeNonNegative(event.positionMs) ||
      (!currentProjection && !staleReconcilable)
    ) {
      this.#host.logWarn('queue transition rejected');
      return;
    }
    if (edgeUnverifiable) {
      // The executed projection aged out of the lookup — the edge was
      // accepted on identity alone, so say so for postmortems.
      this.#host.logWarn(
        'queue transition on evicted projection — legality unverified',
      );
    } else if (!currentProjection) {
      // The event's edge was already proven legal against the
      // INSTALLED projection above, so a stale-but-past revision is
      // safe to reconcile.
      this.#host.logWarn('queue transition on superseded projection — reconciled');
    }
    if (event.reason === 'ended' && event.fromOccurrenceId !== null) {
      // The service completed the occurrence without a JS 'ended':
      // it crossed the threshold by definition. Duration is the
      // recording's own; otherwise the last observed position
      // decides under the 120 s rule.
      const from = r.queue
        .snapshot()
        .occurrences.find((o) => o.occurrenceId === event.fromOccurrenceId);
      const rec = r.recordings.find((x) => x.id === from?.recordingId);
      if (from !== undefined) {
        await this.#maybeRecordPlay(
          event.fromOccurrenceId,
          from.recordingId,
          rec?.durationMs ?? r.queue.snapshot().positionMs,
          rec?.durationMs ?? null,
        );
      }
    }
    const toId = event.toOccurrenceId;
    if (repeatEdge && toId !== null) {
      bumpListenCycle(r, toId);
    }
    const wasPlaying = r.queue.snapshot().mode === 'playing';
    try {
      // A null target means the cursor ran off the end: stopped.
      r.queue.reconcileNativeCurrent(
        toId,
        toId === null ? 0 : event.positionMs,
        toId !== null,
      );
    } catch {
      this.#host.logWarn('queue transition rejected');
      return;
    }
    marker.currentOccurrenceId = toId;
    marker.reconciledQueueRev = r.queue.snapshot().revision;
    // The drain authorization belongs to the tail armed at reconcile
    // time — a reseed during the write below swaps in a fresh record
    // whose own flag already reflects its queue state.
    const radioAtTransition = r.radio;
    // Adopt the service-reported attempt, superseding the current one.
    const prev = this.#active;
    this.#active = null;
    if (prev !== null) {
      prev.source.cancel();
      prev.timer?.cancel();
    }
    if (event.identity !== null && event.handle !== null && toId !== null) {
      const snap2 = r.queue.snapshot();
      const occurrence = snap2.occurrences.find(
        (o) => o.occurrenceId === toId,
      );
      // The service resolved this item's ref under the projection it
      // executed — carry that projection's ref verbatim into the
      // adopted attempt so the playing mark reflects what was actually
      // attached. The latest install may map the same item to a new ref.
      const projected = executed?.items.find(
        (item) => item.occurrenceId === toId,
      );
      const projProvider = projected?.provider ?? null;
      const projRefId = projected?.sourceRef ?? null;
      const toRecording = r.recordings.find(
        (rec) => rec.id === occurrence?.recordingId,
      );
      const adoptedRef: SourceRef | undefined =
        projProvider === null || projRefId === null
          ? undefined
          : toRecording?.sourceRefs.find(
            (s) => s.provider === projProvider && s.id === projRefId,
          ) ?? { provider: projProvider, kind: 'track', id: projRefId };
      // Statuses continue to echo the immutable service projection until
      // app intent installs a new one; reconciliation alone must not re-key it.
      const identity = event.identity;
      const attempt: ActiveAttempt = {
        identity,
        recordingId: occurrence?.recordingId ?? '',
        occurrenceId: toId,
        ...(adoptedRef === undefined ? {} : { ref: adoptedRef }),
        source: new CancellationSource(),
        deadlineMs: this.#host.deadline(),
        handle: event.handle,
        preparedHandled: true,
        endedHandled: false,
        // The adopted attempt's prior play span is unknown — count
        // from the adopted position so threshold math stays honest.
        listenedMsAccum: event.positionMs,
        lastStatusPositionMs: event.positionMs,
        // The adopted stream was attached outside this intent's
        // attempt chain — its own prepare budget starts fresh.
        preparesUsed: 0,
      };
      this.#active = attempt;
      // The service's armed move may have adopted the warm's session —
      // the attach owns it now; free the warm's request slot without
      // releasing a live handle.
      const warm = this.#streamWarm;
      if (warm !== null && warm.stream?.handle === event.handle) {
        this.#streamWarm = null;
        this.#freeWarmRequest(warm);
      }
      r.playback = {
        type: 'buffering',
        recordingId: attempt.recordingId,
        occurrenceId: toId,
        identity,
        handle: event.handle,
        positionMs: event.positionMs,
        ...(adoptedRef === undefined ? {} : { ref: adoptedRef }),
      };
    } else {
      r.playback = { type: 'idle' };
    }
    this.#host.publish();
    // Capture and enqueue the transition's own snapshot before any
    // cleanup await can admit a later queue command: its segment then
    // precedes theirs, so a later command's rollback cannot invalidate
    // the transition its `before` retained. The epoch guard still drops
    // the write when an earlier pending commit rolls the lineage back
    // over it, and the committed-revision guard keeps a staler capture
    // from regressing a staged commit.
    const queueSnap = r.queue.snapshot();
    const queueEpoch = r.queueEpoch;
    const queueWrite = this.#host.persist(() =>
      r.queueEpoch === queueEpoch &&
        queueSnap.revision > r.queueCommittedRev
        ? { queue: queueSnap }
        : {},
    );
    if (prev !== null) {
      prev.source.cancel();
      prev.timer?.cancel();
      // The service may reuse the same handle for the new cursor
      // position — releasing it would kill the live stream.
      if (prev.handle !== undefined && prev.handle !== event.handle) {
        await this.#releaseHandle(prev.handle, prev.identity);
      }
      if (prev.requestId !== undefined && !prev.preparedHandled) {
        await this.#cancelPrepare(prev.requestId, prev.identity);
      }
    }
    const queueWritten = await queueWrite;
    {
      // Service-side drain with a tail armed — same authorization as
      // the app-driven drain in advance: a committed drain while
      // playing earns the resume; a stale transition landing on an
      // already-paused queue, a non-drain, or a failed write revokes
      // it. The flag marks only when the drain committed — a failed
      // write must not authorize a later paused drain to resume.
      const rec = radioAtTransition;
      if (rec !== null && r.radio === rec && rec.status === 'growing') {
        rec.resumeOnDrain =
          toId === null && wasPlaying && queueWritten.ok;
      }
      // A native drain bypasses host.derived: chase the armed tail's
      // continuation here too, or a drained queue strands forever.
      if (toId === null && wasPlaying && rec !== null && r.radio === rec) {
        this.#host.resumeDrainedQueue(r, rec, undefined);
      }
    }
    // Native may already be several moves ahead. Re-projecting this
    // intermediate cursor would stop its live stream and reject queued moves.
    this.#mappingSource?.cancel();
    this.#mappingSource = null;
    this.maybeMapSuccessor();
    // The cursor moved inside the projection — the radio tail's
    // fetch-ahead window may have opened, and landing on the last
    // item arms it.
    this.#host.maybeGrowRadio();
    this.#host.maybeArmRadio();
  }

  // ---- successor mapping ----------------------------------------------

  /**
   * At most one mapping-only task: after a successful prepare with
   * prefetch enabled, resolves the immediate successor's ref so the
   * service can freshly attach it while JS is constrained. Never
   * touches current playback; failures leave a null ref (honest
   * unavailable) and a fixed diagnostic.
   */
  maybeMapSuccessor(): void {
    // eslint-disable-next-line no-console
    const r = this.#host.ready();
    if (
      r === null ||
      !r.settings.prefetch ||
      this.#host.disposed() ||
      // Only when the current prepare has succeeded — the service
      // needs refs it can freshly attach for the immediate successor.
      this.#active?.preparedHandled !== true
    ) {
      return;
    }
    const snap = r.queue.snapshot();
    // The cursor's real successor is the dealt one under shuffle —
    // prefetch what the service will actually attach next.
    const dealt = this.#host.dealtOrder(r);
    const walk = dealt ?? snap.occurrences.map((o) => o.occurrenceId);
    const pos =
      snap.currentOccurrenceId === null
        ? -1
        : walk.indexOf(snap.currentOccurrenceId);
    const successorId = pos >= 0 ? walk[pos + 1] : undefined;
    const successor = snap.occurrences.find(
      (o) => o.occurrenceId === successorId,
    );
    if (successor === undefined) {
      return;
    }
    const recording = r.recordings.find(
      (rec) => rec.id === successor.recordingId,
    );
    if (recording === undefined) {
      return;
    }
    // A resolved ref — occurrence pin, user-confirmed mapping, or
    // unvetoed source ref — is already projected; no mapping task is
    // needed.
    if (this.#host.pickRef(recording, successor.selectedRef) !== null) {
      return;
    }
    // Speculative work spends the network too — skip when offline or
    // on a metered link, the same gate the warm passes run under.
    if (!this.#host.isOnline() || this.#host.isMetered()) {

      return;
    }
    const routed = this.#router.providerFor(
      'playback.candidates',
      selectionFromSettings(r.settings),
    );
    if (!routed.ok) {
      return;
    }
    const provider = routed.value;
    const source = new CancellationSource();
    this.#mappingSource = source;
    const occurrenceId = successor.occurrenceId;
    const recordingId = recording.id;
    // The dealt-window warm dedupes against this in-flight call too —
    // the row stays suppressed while its mapping resolves.
    this.#noteWarmSeen(recordingId);
    const work = (async () => {
      const deadlineMs = this.#host.deadline();
      const query = recordingQuery(recording);
      const result = await boundedOp(
        this.#host,
        source,
        'map',
        (ctx) => provider.candidates({ query, limit: CANDIDATE_LIMIT }, ctx),
        undefined,
        deadlineMs,
      );
      if (
        source.signal.cancelled ||
        this.#mappingSource !== source ||
        !result.ok
      ) {
        if (!source.signal.cancelled && result.ok === false) {
          this.#host.logWarn('successor mapping failed');
        }
        return;
      }
      const ready2 = this.#host.ready();
      if (ready2 === null) {
        return;
      }
      const rec = ready2.recordings.find((x) => x.id === recordingId);
      if (rec === undefined) {
        return;
      }
      const automatic = this.#warmMatch(
        rec,
        result.value,
        'successor mapping threw on malformed candidates',
        'successor mapping unresolved',
      );
      if (automatic === null) {
        return;
      }
      const ref = automatic.ref;
      const updated = adoptAutomaticMapping(rec, ref, automatic);
      // Recheck it is still the immediate successor of the same
      // current under the same playback provider, and that the
      // resolved ref actually wins selection precedence. Successor
      // means walk space — the dealt position under shuffle.
      const snapNow = ready2.queue.snapshot();
      const walkNow =
        this.#host.dealtOrder(ready2) ??
        snapNow.occurrences.map((o) => o.occurrenceId);
      const posNow =
        snapNow.currentOccurrenceId === null
          ? -1
          : walkNow.indexOf(snapNow.currentOccurrenceId);
      const immediateId = posNow >= 0 ? walkNow[posNow + 1] : undefined;
      const immediate = snapNow.occurrences.find(
        (o) => o.occurrenceId === immediateId,
      );
      if (
        immediate === undefined ||
        immediate.occurrenceId !== occurrenceId ||
        ready2.settings.playbackProvider !== provider.id ||
        !sameRef(this.#host.pickRef(updated, immediate.selectedRef), ref)
      ) {
        return;
      }
      // Stage the adoption inside the storage segment against the
      // freshest mirror — the queue engine swaps in only after a
      // successful commit, so a rolled-back write can never leave a
      // resurrected pin in memory.
      const staged = await this.#host.commitStaged((ready3) => {
        const current = ready3.recordings.find((x) => x.id === recordingId);
        if (current === undefined) {
          return err(internalError());
        }
        const adopted = adoptAutomaticMapping(current, ref, automatic);
        const draft = ready3.queue.fork();
        try {
          draft.setSelectedRef(occurrenceId, ref);
        } catch {
          return err(internalError());
        }
        const recordings = ready3.recordings.map((x) =>
          x.id === adopted.id ? adopted : x,
        );
        return ok<PlaybackStage<SourceRef>>({
          batch: { recordings, queue: draft.snapshot() },
          apply: (rr) => {
            rr.recordings = recordings;
            rr.queue = draft;
            return ref;
          },
        });
      });
      if (!staged.ok) {
        return;
      }
      this.#host.derived();
      this.#host.own(this.projectQueue());
    })();
    this.#host.own(work);
  }

  /**
   * Advisory warm kick — the dealt-window map pass and the idle
   * stream warm both re-evaluate after queue/settings churn.
   */
  maybeWarm(): void {
    this.#maybeWarmWindow();
    this.#maybeWarmStream();
  }

  prewarm(input: {
    readonly recordingIds?: readonly string[];
    readonly sourceRefs?: readonly SourceRef[];
    readonly tracks?: readonly TrackMetadata[];
  }): void {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return;
    }
    const r = ready.value;
    const refs = input.sourceRefs ?? [];
    for (const s of refs.slice(0, PREWARM_INPUT_LIMIT)) {
      if (
        isTrackRef(s) &&
        s.provider === r.settings.playbackProvider &&
        s.provider !== LOCAL_PROVIDER
      ) {
        const now = this.#host.safeNow();
        if (now !== null) {
          this.#surfaceWarm = {
            provider: s.provider,
            sourceRef: s.id,
            atMs: now,
          };
        }
        break;
      }
    }
    const ids = input.recordingIds ?? [];
    for (const id of ids.slice(0, PREWARM_INPUT_LIMIT)) {
      if (isString(id, 256) && this.#warmPending.size < WARM_SEEN_CAP) {
        this.#warmPending.add(id);
      }
    }
    const tracks = input.tracks ?? [];
    if (input.tracks !== undefined) {
      // The visible page just changed: queued and resolved intents
      // from the old one are dropped — a stale match must never mint
      // over the rows now under the user's finger.
      this.#surfaceKeys = new Set(
        tracks
          .slice(0, PREWARM_INPUT_LIMIT)
          .filter(
            (meta) =>
              isTrackMetadata(meta) &&
              meta.sourceRef.provider !== r.settings.playbackProvider &&
              meta.sourceRef.provider !== LOCAL_PROVIDER,
          )
          .map((meta) => `q:${meta.sourceRef.provider}:${meta.sourceRef.id}`),
      );
      this.#warmPendingQueries = this.#warmPendingQueries.filter((t) =>
        this.#surfaceKeys.has(t.key),
      );
      this.#surfaceBacklog = this.#surfaceBacklog.filter((e) => {
        if (this.#surfaceKeys.has(e.key)) {
          return true;
        }
        // Never offered, so the row's seen mark is undone — a page
        // that shows it again resolves it fresh.
        this.#warmSeen.delete(e.key);
        return false;
      });
    }
    for (const meta of tracks.slice(0, PREWARM_INPUT_LIMIT)) {
      // Rows already carrying a playback-provider ref are covered by
      // the sourceRefs hand; everything else needs a candidates
      // resolve before anything can be minted.
      if (
        !isTrackMetadata(meta) ||
        meta.sourceRef.provider === r.settings.playbackProvider ||
        meta.sourceRef.provider === LOCAL_PROVIDER
      ) {
        continue;
      }
      const key = `q:${meta.sourceRef.provider}:${meta.sourceRef.id}`;
      if (
        this.#warmPendingQueries.length < WARM_SEEN_CAP &&
        !this.#warmPendingQueries.some((t) => t.key === key)
      ) {
        this.#warmPendingQueries.push({
          key,
          query: {
            title: meta.title,
            artist: meta.artist,
            album: meta.album,
            durationMs: meta.durationMs,
            // Same derivation `recordingFromMetadata` runs — dropping
            // the catalog row's labels would hard-conflict every
            // labeled candidate (live, remix, explicit) and skip the
            // warm a real tap resolves fine.
            versionLabels: extractVersionLabels(meta.title, meta.explicit),
            isrc: meta.isrc ?? null,
          },
        });
      }
    }
    this.#maybeWarmWindow();
    this.#maybeWarmStream();
  }

  /** Speculative gates — playback-intent paths never consult these. */
  #warmGatesOk(r: Ready): boolean {
    return (
      r.settings.prefetch && this.#host.isOnline() && !this.#host.isMetered()
    );
  }

  /**
   * The match → automatic-mapping tail a warm resolve runs: a match
   * earns the mapping; malformed candidates, a non-match, or a dead
   * clock return null. The caller supplies its warn wording.
   */
  #warmMatch(
    rec: Recording,
    candidates: readonly MatchCandidate[],
    throwLabel: string,
    unmatchedLabel: string | null,
  ): SourceMapping | null {
    let outcome: MatchOutcome;
    try {
      outcome = MatchingEngine.match(rec, candidates, rec.mappings);
    } catch {
      this.#host.logWarn(throwLabel);
      return null;
    }
    if (outcome.type !== 'matched') {
      if (unmatchedLabel !== null) {
        this.#host.logWarn(unmatchedLabel);
      }
      return null;
    }
    const matchedAt = this.#host.safeNow();
    if (matchedAt === null) {
      return null;
    }
    return {
      ref: outcome.candidate.sourceRef,
      status: 'automatic',
      matchedAtMs: matchedAt,
      evidence: outcome.evidence,
    };
  }

  /** A row counts as attempted recently — suppresses re-warm. */
  #warmSeenFresh(recordingId: string): boolean {
    // LRU touch — a hot row keeps its slot.
    return lruFresh(
      this.#warmSeen,
      recordingId,
      WARM_ROW_TTL_MS,
      this.#host.safeNow(),
      true,
    );
  }

  #noteWarmSeen(recordingId: string): void {
    lruSet(this.#warmSeen, recordingId, this.#host.safeNow() ?? 0, WARM_SEEN_CAP);
  }

  /**
   * A row torn down mid-flight never got its attempt — undo the seen
   * mark and requeue the surface hand so the restarted pass retries
   * it (provider switches and transient gate flips own the teardown).
   * Rows that completed — settled or failed — keep their suppression.
   */
  #unseeWarmTarget(target: {
    recordingId: string;
    occurrenceId: string | null;
  }): void {
    this.#warmSeen.delete(target.recordingId);
    if (target.occurrenceId === null) {
      this.#warmPending.add(target.recordingId);
    }
  }

  /** A failed stream warm is denied briefly — bounded list. */
  #denyStreamWarm(key: string): void {
    lruSet(this.#streamWarmDenied, key, this.#host.safeNow() ?? 0, STREAM_DENY_CAP);
  }

  #streamWarmDeniedFresh(key: string): boolean {
    return lruFresh(
      this.#streamWarmDenied,
      key,
      WARM_ROW_TTL_MS,
      this.#host.safeNow(),
      false,
    );
  }

  /**
   * Frees an adopted warm's request bookkeeping — its session is
   * attached now, so the host-side cancel is a bookkeeping no-op on
   * the stream and only releases the request-id slot.
   */
  #freeWarmRequest(warm: StreamWarm): void {
    const requestId = warm.requestId;
    if (requestId === null) {
      return;
    }
    this.#host.own(this.#cancelPrepare(requestId, warmIdentity(warm)));
  }

  /**
   * The serial visible-window pass: rows the cursor could reach
   * (dealt order, `WARM_WINDOW` past the cursor) plus surface-handed
   * ids, each getting the candidates→match→automatic-mapping tail a
   * real resolve would run. One pass at a time; a `#derived` tick
   * with work pending is a no-op.
   */
  #maybeWarmWindow(): void {
    const r = this.#host.ready();
    if (r === null || this.#host.disposed() || !this.#warmGatesOk(r)) {
      // Gates flipped mid-pass — unwind it; the loop's finally frees
      // the slot only once its current step actually exits.
      this.#warmBatchSource?.cancel();
      return;
    }
    if (this.#warmBatchSource !== null) {
      // A provider switch mid-pass leaves the in-flight row resolving
      // under the old provider — unwind it; the loop's exit finally
      // restarts the pass routed through the new selection.
      const want = this.#router.providerFor(
        'playback.candidates',
        selectionFromSettings(r.settings),
      );
      if (
        want.ok &&
        this.#warmBatchProvider !== null &&
        want.value.id !== this.#warmBatchProvider
      ) {
        this.#warmBatchSource.cancel();
      }
      return;
    }
    const source = new CancellationSource();
    this.#warmBatchSource = source;
    const work = (async () => {
      try {
        await this.#warmWindowLoop(source);
      } finally {
        if (this.#warmBatchSource === source) {
          this.#warmBatchSource = null;
          // A pass torn down mid-flight (provider switch, a transient
          // gate flip) leaves its remaining rows unwarmed and nothing
          // else retriggers it — restart under the current selection.
          // A pass that ran to completion stays stopped.
          if (source.signal.cancelled) {
            this.#maybeWarmWindow();
          }
        }
      }
    })();
    this.#host.own(work);
  }

  async #warmWindowLoop(source: CancellationSource): Promise<void> {
    for (; ;) {
      const r = this.#host.ready();
      if (
        r === null ||
        this.#host.disposed() ||
        source.signal.cancelled ||
        !this.#warmGatesOk(r)
      ) {
        return;
      }
      const next = this.#nextWarmTarget(r);
      if (next === null) {
        return;
      }
      this.#warmBatchTarget =
        next.kind === 'query' ? next.key : next.recordingId;
      this.#warmBatchDone = (async () => {
        try {
          if (next.kind === 'query') {
            await this.#warmOneQuery(next, source);
          } else {
            await this.#warmOne(next, source);
          }
        } finally {
          this.#warmBatchTarget = null;
          this.#warmBatchDone = null;
          this.#warmBatchProvider = null;
        }
      })();
      await this.#warmBatchDone;
    }
  }

  /**
   * The next row still needing a ref: surface-handed ids first (the
   * viewport is the freshest intent), then the dealt window past the
   * cursor. A row with any `#pickRef` hit — occurrence pin, owned
   * bytes, mapping, unvetoed source ref — is already resolved.
   */
  #nextWarmTarget(r: Ready):
    | { kind: 'row'; recordingId: string; occurrenceId: string | null }
    | { kind: 'query'; query: RecordingQuery; key: string }
    | null {
    // Only the row the active attempt is itself resolving stays out
    // of the pass: the attempt's candidates call and mapping commit
    // are the truth for it, and a racing warm would duplicate both.
    // Once the attempt holds its handle (`preparedHandled`) — e.g.
    // during playback — it owns nothing speculative, so the window
    // behind the cursor warms as designed.
    const resolvingId =
      this.#active !== null && !this.#active.preparedHandled
        ? this.#active.recordingId
        : null;
    for (const id of [...this.#warmPending]) {
      this.#warmPending.delete(id);
      const rec = r.recordings.find((x) => x.id === id);
      if (
        rec !== undefined &&
        id !== resolvingId &&
        this.#host.pickRef(rec, null) === null &&
        !this.#warmSeenFresh(id)
      ) {
        return { kind: 'row', recordingId: id, occurrenceId: null };
      }
    }
    while (this.#warmPendingQueries.length > 0) {
      const next = this.#warmPendingQueries.shift();
      if (next === undefined) {
        break;
      }
      if (!this.#warmSeenFresh(next.key)) {
        return { kind: 'query', query: next.query, key: next.key };
      }
    }
    // The dealt window is a while-playing warm: a session exists and
    // the rows behind the cursor are the ones a finger could reach.
    // 'idle'/'preparing' never speculate past the surface hand-off.
    const ptype = r.playback.type;
    if (ptype === 'idle' || ptype === 'preparing') {
      return null;
    }
    const snap = r.queue.snapshot();
    if (snap.currentOccurrenceId === null) {
      // No cursor: 'beyond the cursor' is empty — a queue with nothing
      // selected warms only what surfaces hand in via prewarm().
      return null;
    }
    const dealt = this.#host.dealtOrder(r);
    const walk = dealt ?? snap.occurrences.map((o) => o.occurrenceId);
    const pos = walk.indexOf(snap.currentOccurrenceId);
    for (let i = pos + 1; i < walk.length && i <= pos + WARM_WINDOW; i++) {
      const occurrence = snap.occurrences.find(
        (o) => o.occurrenceId === walk[i],
      );
      const rec =
        occurrence === undefined
          ? undefined
          : r.recordings.find((x) => x.id === occurrence.recordingId);
      if (
        occurrence !== undefined &&
        rec !== undefined &&
        rec.id !== resolvingId &&
        this.#host.pickRef(rec, occurrence.selectedRef) === null &&
        !this.#warmSeenFresh(rec.id)
      ) {
        return {
          kind: 'row',
          recordingId: rec.id,
          occurrenceId: occurrence.occurrenceId,
        };
      }
    }
    return null;
  }

  /**
   * Candidates-resolve one window row: identical contract to
   * `#maybeMapSuccessor` — a matched ref commits as an `automatic`
   * mapping and pins the occurrence when it is still unmapped;
   * 'ambiguous'/'unavailable' resolve to honest skips — speculative
   * work never enqueues a review.
   */
  async #warmOne(
    target: { recordingId: string; occurrenceId: string | null },
    source: CancellationSource,
  ): Promise<void> {
    const r = this.#host.ready();
    if (r === null) {
      return;
    }
    this.#noteWarmSeen(target.recordingId);
    const recording = r.recordings.find((x) => x.id === target.recordingId);
    if (recording === undefined) {
      return;
    }
    const routed = this.#router.providerFor(
      'playback.candidates',
      selectionFromSettings(r.settings),
    );
    if (!routed.ok) {
      return;
    }
    const provider = routed.value;
    if (this.#warmBatchTarget === target.recordingId) {
      this.#warmBatchProvider = provider.id;
    }
    const deadlineMs = this.#host.deadline();
    const query = recordingQuery(recording);
    const result = await boundedOp(
      this.#host,
      source,
      'warm',
      (ctx) => provider.candidates({ query, limit: CANDIDATE_LIMIT }, ctx),
      undefined,
      deadlineMs,
    );
    if (
      source.signal.cancelled ||
      this.#host.disposed() ||
      this.#warmBatchSource !== source
    ) {
      this.#unseeWarmTarget(target);
      return;
    }
    if (!result.ok) {
      this.#host.logWarn('row warm failed');
      return;
    }
    const ready2 = this.#host.ready();
    if (ready2 === null || this.#host.disposed() || this.#warmBatchSource !== source) {
      this.#unseeWarmTarget(target);
      return;
    }
    const rec = ready2.recordings.find((x) => x.id === target.recordingId);
    if (rec === undefined) {
      return;
    }
    // 'ambiguous' parks on the row, not in a review — the tap's own
    // resolve produces the review honestly.
    const automatic = this.#warmMatch(
      rec,
      result.value,
      'row warm threw on malformed candidates',
      null,
    );
    if (automatic === null) {
      return;
    }
    const ref = automatic.ref;
    const occurrenceId = target.occurrenceId;
    const staged = await this.#host.commitStaged((ready3) => {
      // The storage tail can queue this write behind another one —
      // recheck at commit time: a warm cancelled while it waited
      // (connectivity flip, provider switch, dispose) must not still
      // land a mapping or pin a queue row.
      if (
        source.signal.cancelled ||
        this.#host.disposed() ||
        this.#warmBatchSource !== source ||
        !this.#warmGatesOk(ready3) ||
        ready3.settings.playbackProvider !== provider.id
      ) {
        return err(appError('cancelled', 'warm pass cancelled'));
      }
      const current = ready3.recordings.find(
        (x) => x.id === target.recordingId,
      );
      if (current === undefined) {
        return err(internalError());
      }
      const adopted = adoptAutomaticMapping(current, ref, automatic);
      const snapNow = ready3.queue.snapshot();
      const occurrence =
        occurrenceId === null
          ? undefined
          : snapNow.occurrences.find((o) => o.occurrenceId === occurrenceId);
      // The row may have moved or gained a pin while the candidates
      // call was in flight — the warm's ref must still win the pick;
      // a same-provider pin that arrived since is the fresher truth.
      const picked = this.#host.pickRef(adopted, occurrence?.selectedRef ?? null);
      if (!sameRef(picked, ref)) {
        return err(appError('superseded', 'warm ref lost the pick'));
      }
      const shouldPin =
        occurrence !== undefined &&
        occurrence.recordingId === adopted.id &&
        occurrence.selectedRef === null &&
        ready3.settings.playbackProvider === provider.id;
      const draft = shouldPin ? ready3.queue.fork() : null;
      if (draft !== null) {
        try {
          draft.setSelectedRef(occurrenceId ?? '', ref);
        } catch (thrown) {
          return err(fromUnknown(thrown));
        }
      }
      const recordings = ready3.recordings.map((x) =>
        x.id === adopted.id ? adopted : x,
      );
      return ok<PlaybackStage<SourceRef>>({
        batch:
          draft === null
            ? { recordings }
            : { recordings, queue: draft.snapshot() },
        apply: (rr) => {
          rr.recordings = recordings;
          if (draft !== null) {
            rr.queue = draft;
          }
          return ref;
        },
      });
    });
    if (!staged.ok) {
      if (source.signal.cancelled || this.#warmBatchSource !== source) {
        this.#unseeWarmTarget(target);
      }
      return;
    }
    this.#host.derived();
    if (occurrenceId !== null) {
      // A new pin changes what a service move would attach — the
      // projection must carry it.
      this.#host.own(this.projectQueue());
    }
  }

  /**
   * Candidates-resolve one surface-handed track row: catalog-only
   * metadata never becomes a recording, so a match parks its resolved
   * `(provider, ref)` in `#surfaceBacklog` — no mapping or pin
   * commits (there is nothing to land them on). The backlog drains
   * through `#surfaceWant`, so the one speculative slot offers every
   * visible row in turn; a match for a page that left view is
   * discarded against `#surfaceKeys`.
   */
  async #warmOneQuery(
    target: { query: RecordingQuery; key: string },
    source: CancellationSource,
  ): Promise<void> {
    const r = this.#host.ready();
    if (r === null) {
      return;
    }
    this.#noteWarmSeen(target.key);
    const routed = this.#router.providerFor(
      'playback.candidates',
      selectionFromSettings(r.settings),
    );
    if (!routed.ok) {
      return;
    }
    const provider = routed.value;
    if (this.#warmBatchTarget === target.key) {
      this.#warmBatchProvider = provider.id;
    }
    const deadlineMs = this.#host.deadline();
    const context = this.#host.newContext('warm', deadlineMs, source.signal);
    const result = await this.#host.withDeadline(
      () =>
        provider.candidates(
          { query: target.query, limit: CANDIDATE_LIMIT },
          context,
        ),
      deadlineMs,
      source,
    );
    if (
      source.signal.cancelled ||
      this.#host.disposed() ||
      this.#warmBatchSource !== source
    ) {
      this.#warmSeen.delete(target.key);
      this.#warmPendingQueries.unshift(target);
      return;
    }
    if (!result.ok) {
      this.#host.logWarn('row warm failed');
      return;
    }
    // The match needs a recording's fields — the query itself is the
    // probe; nothing here persists.
    const probe: Recording = {
      id: '',
      title: target.query.title,
      artist: target.query.artist,
      album: target.query.album,
      durationMs: target.query.durationMs,
      releaseYear: null,
      artwork: [],
      explicit: null,
      genre: null,
      isrc: target.query.isrc,
      versionLabels: target.query.versionLabels,
      sourceRefs: [],
      mappings: [],
      provenance: 'provider',
    };
    let outcome: MatchOutcome;
    try {
      outcome = MatchingEngine.match(probe, result.value, []);
    } catch {
      this.#host.logWarn('row warm threw on malformed candidates');
      return;
    }
    if (outcome.type !== 'matched') {
      // 'ambiguous' parks on the row, not in a review — the tap's own
      // resolve produces the review honestly.
      return;
    }
    const ref = outcome.candidate.sourceRef;
    if (
      ref.provider !== provider.id ||
      !isTrackRef(ref) ||
      ref.provider === LOCAL_PROVIDER
    ) {
      return;
    }
    const now = this.#host.safeNow();
    if (now === null) {
      return;
    }
    if (!this.#surfaceKeys.has(target.key)) {
      // The page that showed this row changed while it resolved —
      // discard the match: it must never mint over the page now
      // visible, and unseeing lets a re-shown page resolve it fresh.
      this.#warmSeen.delete(target.key);
      return;
    }
    // Resolved, not yet minted: park the ref in arrival order so the
    // backlog can offer each visible row to the stream warm in turn —
    // the seen mark stays honest because the tap's resolve is already
    // spent and the minted session arrives before the gesture would.
    if (
      this.#surfaceBacklog.length < WARM_SEEN_CAP &&
      !this.#surfaceBacklog.some((e) => e.key === target.key)
    ) {
      this.#surfaceBacklog.push({
        key: target.key,
        provider: ref.provider,
        sourceRef: ref.id,
        atMs: now,
      });
    }
    this.#maybeWarmStream();
  }

  /**
   * The freshest live surface intent: an explicit `sourceRefs` hand or
   * a resolved track row, fresh within `SURFACE_WARM_TTL_MS` and on
   * the playback provider. Backlog entries whose page left view — or
   * that aged out — are evicted (and unseen: they were never offered)
   * as they surface; a denied ref waits out its suppression instead
   * of being offered again.
   */
  #surfaceWant(
    r: Ready,
  ): { provider: string; sourceRef: string; backlogKey: string | null } | null {
    const now = this.#host.safeNow();
    if (now === null) {
      return null;
    }
    const hand = this.#surfaceWarm;
    const live =
      hand !== null &&
      now - hand.atMs < SURFACE_WARM_TTL_MS &&
      hand.provider === r.settings.playbackProvider
        ? hand
        : null;
    if (hand !== null && live === null) {
      this.#surfaceWarm = null;
    }
    let back: {
      key: string;
      provider: string;
      sourceRef: string;
      atMs: number;
    } | null = null;
    for (let i = this.#surfaceBacklog.length - 1; i >= 0; i -= 1) {
      const e = this.#surfaceBacklog[i];
      if (e === undefined) {
        continue;
      }
      if (
        !this.#surfaceKeys.has(e.key) ||
        now - e.atMs >= SURFACE_WARM_TTL_MS ||
        e.provider !== r.settings.playbackProvider
      ) {
        this.#surfaceBacklog.splice(i, 1);
        this.#warmSeen.delete(e.key);
        continue;
      }
      if (this.#streamWarmDeniedFresh(`${e.provider} ${e.sourceRef}`)) {
        continue;
      }
      back = e;
      break;
    }
    if (back !== null && (live === null || back.atMs >= live.atMs)) {
      return {
        provider: back.provider,
        sourceRef: back.sourceRef,
        backlogKey: back.key,
      };
    }
    if (live !== null) {
      return {
        provider: live.provider,
        sourceRef: live.sourceRef,
        backlogKey: null,
      };
    }
    return null;
  }

  /** The advisory stream warm's current want — see `StreamWarm`. */
  #warmWant(
    r: Ready,
  ): {
    provider: string;
    sourceRef: string;
    origin: 'queue' | 'surface';
    backlogKey: string | null;
  } | null {
    const type = r.playback.type;
    const surface = this.#surfaceWant(r);
    if (type === 'playing') {
      // A fresh surface row outranks the dealt successor — the user
      // is looking at it right now, so its tap is the likelier next
      // play. Without one the successor is what the service would
      // attach next — warm only an already-resolved remote ref;
      // candidate-less rows are the window pass's job, not a stream
      // mint.
      if (surface !== null) {
        return { ...surface, origin: 'surface' };
      }
      const snap = r.queue.snapshot();
      const dealt = this.#host.dealtOrder(r);
      const walk = dealt ?? snap.occurrences.map((o) => o.occurrenceId);
      const pos =
        snap.currentOccurrenceId === null
          ? -1
          : walk.indexOf(snap.currentOccurrenceId);
      const successorId = pos >= 0 ? walk[pos + 1] : undefined;
      const successor = snap.occurrences.find(
        (o) => o.occurrenceId === successorId,
      );
      const recording =
        successor === undefined
          ? undefined
          : r.recordings.find((rec) => rec.id === successor.recordingId);
      if (successor === undefined || recording === undefined) {
        return null;
      }
      const ref = this.#host.pickRef(recording, successor.selectedRef);
      if (
        ref === null ||
        ref.provider === LOCAL_PROVIDER ||
        ref.provider !== r.settings.playbackProvider
      ) {
        return null;
      }
      return {
        provider: ref.provider,
        sourceRef: ref.id,
        origin: 'queue',
        backlogKey: null,
      };
    }
    if (type === 'idle' || type === 'failed') {
      return surface === null ? null : { ...surface, origin: 'surface' };
    }
    // 'preparing' parks the warm for the in-flight attempt; under
    // 'buffering'/'paused' a surfaced row is still the freshest
    // intent, so it arbitrates the same way as while playing.
    return surface === null || type === 'preparing'
      ? null
      : { ...surface, origin: 'surface' };
  }

  /**
   * Reconcile the one warm slot against `#warmWant`: same key keeps,
   * different key swaps (cancel/release first, then re-issue), none
   * drops — except under 'preparing'/'buffering'/'paused', where the
   * warm may still be adopted and stays parked.
   */
  #maybeWarmStream(): void {
    const r = this.#host.ready();
    if (r === null || this.#host.disposed()) {
      return;
    }
    const warm = this.#streamWarm;
    if (!this.#warmGatesOk(r)) {
      if (warm !== null) {
        this.#dropStreamWarm(warm);
      }
      return;
    }
    const want = this.#warmWant(r);
    const type = r.playback.type;
    if (want === null) {
      if (warm === null) {
        return;
      }
      // 'preparing'/'buffering'/'paused' keep the warm — the attempt
      // may still adopt it or the tick that ends the transition will
      // re-evaluate. While 'playing' the same rule applies to a warm
      // that IS the current row: the select that just landed moves
      // the cursor one tick before the attempt starts, so the want
      // flips to null early — the warm must survive to be adopted.
      if (type === 'idle' || type === 'failed') {
        this.#dropStreamWarm(warm);
        return;
      }
      if (type === 'playing' && !this.#warmIsCurrentRow(r, warm)) {
        this.#dropStreamWarm(warm);
      }
      return;
    }
    if (
      warm !== null &&
      warm.provider === want.provider &&
      warm.sourceRef === want.sourceRef
    ) {
      return;
    }
    if (warm !== null) {
      // The cursor may have just landed ON the warmed row — a Next /
      // advance re-evaluates with the following row as want while the
      // just-selected row's attempt is still one tick out. Dropping
      // the warm here would force that attempt to resolve and mint
      // again; park it for the attempt to claim, same as the
      // want-null 'playing' rule.
      if (type === 'playing' && this.#warmIsCurrentRow(r, warm)) {
        return;
      }
      // The drop's owned tail re-evaluates — the new warm issues only
      // after the old request's cancel/release actually landed.
      this.#dropStreamWarm(warm);
      return;
    }
    this.#issueStreamWarm(want);
  }

  /** True when the warm's key resolves as the cursor row's own ref —
   *  the row was tapped/advanced-to and the attempt adopts the warm. */
  #warmIsCurrentRow(r: Ready, warm: StreamWarm): boolean {
    const snap = r.queue.snapshot();
    const current = snap.occurrences.find(
      (o) => o.occurrenceId === snap.currentOccurrenceId,
    );
    const rec =
      current === undefined
        ? undefined
        : r.recordings.find((x) => x.id === current.recordingId);
    if (current === undefined || rec === undefined) {
      return false;
    }
    const ref = this.#host.pickRef(rec, current.selectedRef);
    return (
      ref !== null &&
      ref.provider === warm.provider &&
      ref.id === warm.sourceRef
    );
  }

  #issueStreamWarm(want: {
    provider: string;
    sourceRef: string;
    origin: 'queue' | 'surface';
    backlogKey: string | null;
  }): void {
    const r = this.#host.ready();
    if (
      r === null ||
      this.#streamWarm !== null ||
      !this.#warmGatesOk(r)
    ) {
      return;
    }
    const key = `${want.provider} ${want.sourceRef}`;
    if (this.#streamWarmDeniedFresh(key)) {
      return;
    }
    const record: StreamWarm = {
      origin: want.origin,
      provider: want.provider,
      sourceRef: want.sourceRef,
      attemptId: this.#ids.next('warm'),
      queueRev: r.queue.snapshot().revision,
      requestId: null,
      stream: null,
      attempt: null,
      adoptedAttempt: null,
      backlogKey: want.backlogKey,
    };
    this.#streamWarm = record;
    const issueSource = new CancellationSource();
    const work = (async () => {
      const issued = await this.#host.withDeadline(
        () =>
          this.#player.prewarm({
            provider: want.provider,
            sourceRef: want.sourceRef,
            identity: warmIdentity(record),
          }),
        this.#host.deadline(),
        issueSource,
      );
      if (this.#streamWarm !== record) {
        // The record was dropped while the port request was in
        // flight — a request id arriving now has no owner unless an
        // attempt already adopted the warm's session: then the id
        // joins that attempt's bookkeeping (identical to the
        // early-arrival case — `preparedHandled` guards every later
        // cancelPrepare for it, so it persists as the host-side owner
        // the attach needs). No owner at all means a true drop:
        // cancel or the native prepare (and the session it mints)
        // idles unowned until the seam's reaper collects it.
        if (issued.ok) {
          const requestId = issued.value;
          if (record.adoptedAttempt !== null) {
            record.adoptedAttempt.requestId = requestId;
          } else {
            await this.#cancelPrepare(requestId, warmIdentity(record));
          }
        }
        return;
      }
      if (!issued.ok) {
        this.#streamWarm = null;
        this.#denyStreamWarm(key);
        this.#host.logWarn('stream warm failed');
        this.#maybeWarmStream();
        return;
      }
      record.requestId = issued.value;
    })();
    this.#host.own(work);
  }

  /**
   * End a warm that was never adopted: cancel the in-flight request
   * or release the delivered session. The record clears FIRST — an
   * adoption path claims the session only through `#streamWarm`, so
   * a null here can never release a handle an attempt now owns.
   */
  #dropStreamWarm(warm: StreamWarm): void {
    if (this.#streamWarm === warm) {
      this.#streamWarm = null;
    }
    const work = (async () => {
      if (warm.stream !== null) {
        await this.#releaseHandle(warm.stream.handle, warmIdentity(warm));
      } else if (warm.requestId !== null) {
        await this.#cancelPrepare(warm.requestId, warmIdentity(warm));
      }
      this.#maybeWarmStream();
    })();
    this.#host.own(work);
  }

  /**
   * The warm's own prepare outcome — keyed by its `warm-*` attemptId,
   * intercepted before the attempt handler sees it. A delivered
   * session stores for adoption; a failure denies the row briefly.
   */
  async #handleWarmOutcome(
    event: Extract<PlayerEvent, { type: 'prepare' }>,
    warm: StreamWarm,
  ): Promise<void> {
    if (event.outcome.type === 'failed') {
      this.#streamWarm = null;
      this.#denyStreamWarm(`${warm.provider} ${warm.sourceRef}`);
      this.#host.logWarn('stream warm failed');
      this.#maybeWarmStream();
      return;
    }
    const stream = event.outcome.stream;
    warm.stream = stream;
    warm.attempt = event.outcome.attempt;
    if (warm.backlogKey !== null) {
      // Minted = offered: the resolved row's backlog entry is spent.
      this.#surfaceBacklog = this.#surfaceBacklog.filter(
        (e) => e.key !== warm.backlogKey,
      );
    }
    if (this.#active?.handle === stream.handle) {
      // An attempt or a service move already attached this session —
      // ownership moved; the request slot is freed, never released.
      this.#streamWarm = null;
      this.#freeWarmRequest(warm);
      return;
    }
    const now = this.#host.safeNow();
    if (
      now === null ||
      (stream.expiresAtMs !== undefined &&
        saturatingAdd(now, WARM_EXPIRY_MARGIN_MS) >= stream.expiresAtMs)
    ) {
      // Minted inside the expiry margin — useless to a later tap:
      // release it and suppress the re-warm this row would earn.
      this.#streamWarm = null;
      this.#denyStreamWarm(`${warm.provider} ${warm.sourceRef}`);
      await this.#releaseHandle(stream.handle, warmIdentity(warm));
    }
  }
}
