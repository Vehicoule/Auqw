import { CancellationSource } from '../cancellation.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { LogPort } from '../ports/log.ts';
import { isSafeNonNegative } from '../domain.ts';
import type {
  SyncClient,
  SyncClientStatus,
  SyncRoundOutcome,
} from './sync-client.ts';

/**
 * Application-level sync scheduling (docs/specs/sync.md): the client
 * owns one round's wire work; this owns *when* rounds happen —
 *   - on-launch: one round per known peer at start()
 *   - on-change: a debounced round after committed local writes
 *   - reconnect: capped exponential backoff after a dropped session
 *   - connectivity: pending rounds cancel offline, reschedule on edge
 *
 * Rounds never overlap per peer: a nudge arriving mid-round marks
 * the peer dirty and a follow-up runs after the round lands. All
 * timers ride ClockPort.sleep through per-peer cancel sources, so
 * stop() and unpairing abandon scheduled work immediately.
 */
export type SyncSchedulerDeps = {
  readonly client: SyncClient;
  readonly clock: ClockPort;
  readonly log: LogPort;
  /**
   * Live connectivity read; when absent the scheduler assumes the
   * network is up (the desktop's caller has no such port — its
   * sync transport is the server it hosts, and kicks fan out at
   * session accept instead).
   */
  readonly isOnline?: () => boolean;
  /** Trailing-edge debounce for on-change rounds. Default 750 ms. */
  readonly debounceMs?: number;
  /** First reconnect delay after a dropped session. Default 2 s. */
  readonly reconnectBaseMs?: number;
  /** Reconnect backoff cap. Default 60 s. */
  readonly reconnectMaxMs?: number;
};

export interface SyncScheduler {
  /** On-launch sync: fan out one round per known peer, then stay live. */
  start(): void;
  /** Local writes committed to the engine log — converge soon. */
  notifyLocalWrites(): void;
  /** Connectivity edge: false cancels pending rounds, true reschedules. */
  notifyConnectivity(online: boolean): void;
  stop(): void;
}

const DEFAULT_DEBOUNCE_MS = 750;
const DEFAULT_RECONNECT_BASE_MS = 2_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;

type PeerTrack = {
  /** Pending scheduled round — cancelled when rescheduled or stopped. */
  timer: CancellationSource | null;
  /**
   * The pending wake is a write-debounce: a later write re-arms it
   * (trailing edge). Reconnect and one-shot wakes stand — a write
   * must not pull a backoff round earlier than the ladder set it.
   */
  debouncing: boolean;
  /** A nudge arrived while a round was in flight. */
  dirty: boolean;
  /** Current reconnect delay; doubles on each failed round. */
  backoffMs: number;
  /**
   * Absolute epoch-ms a rate-limited peer asked us to wait until —
   * every wake path clamps behind it so a connectivity flap or a
   * local write can't fire a round inside the floor.
   */
  notBeforeMs?: number;
  /** A scheduler-owned round is in flight. */
  running: boolean;
  /**
   * The last completed-round counters this track already consumed.
   * The client publishes a round's counters and verdict atomically
   * with its op's drain emission, so a `lastRound` on the view was
   * always emitted exactly once — a new object identity is a landing,
   * the same object a republish, whatever the surrounding flags.
   */
  seenRound?: SyncRoundOutcome;
  /**
   * Cancels the in-flight round when the peer is unpaired or the
   * scheduler stops — an orphaned exchange must not run to
   * completion against a removed peer.
   */
  round: CancellationSource | null;
};

export function createSyncScheduler(deps: SyncSchedulerDeps): SyncScheduler {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const reconnectBaseMs = deps.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const reconnectMaxMs = deps.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  /** Last status() emission — peer list and live views. */
  let views: SyncClientStatus | null = null;
  const tracks = new Map<string, PeerTrack>();
  /** Cancels every scheduled timer and in-flight round on stop(). */
  let lifecycle = new CancellationSource();
  const owned = new Set<Promise<unknown>>();
  let unsubscribe: (() => void) | null = null;
  let running = false;

  function safeNow(): number | null {
    let now: number;
    try {
      now = deps.clock.nowMs();
    } catch {
      return null;
    }
    return isSafeNonNegative(now) ? now : null;
  }

  function online(): boolean {
    try {
      return deps.isOnline?.() ?? true;
    } catch {
      return false;
    }
  }

  function own(work: Promise<unknown>): void {
    owned.add(work);
    void work.then(
      () => {
        owned.delete(work);
      },
      () => {
        owned.delete(work);
      },
    );
  }

  /** Bounded, nonfatal, sanitized logging: never peer endpoints. */
  function warn(message: string): void {
    const atMs = safeNow();
    if (atMs === null) {
      return;
    }
    own(deps.log.write({ level: 'warn', message, atMs }));
  }

  function trackFor(fp: string): PeerTrack {
    let track = tracks.get(fp);
    if (track === undefined) {
      track = {
        timer: null,
        debouncing: false,
        dirty: false,
        backoffMs: reconnectBaseMs,
        running: false,
        round: null,
      };
      tracks.set(fp, track);
    }
    return track;
  }

  /**
   * Did the peer's last completed round move entries in either
   * direction? `lastRound` records the exchange even when the round
   * failed — the custody cursor alone can't see a phone-only upload.
   */
  function lastRoundMoved(fp: string): boolean {
    const view = views?.peers.find((v) => v.peer.fp === fp);
    const round = view?.lastRound;
    return (
      round !== undefined && round.remoteEntries + round.sentEntries > 0
    );
  }

  /**
   * Arms the peer's next round at `delayMs` — the only timer-placing
   * path. 'stand' keeps a pending wake (it fires soon and a round
   * exports everything pending at fire time); 'replace' cancels it
   * (backoff and recovery move the wake); 'debounce' is the
   * trailing-edge write wake — it re-arms a pending debounce so a
   * write burst fires once when it goes quiet, but stands behind a
   * reconnect or one-shot wake. Nudges during an in-flight round or
   * while offline mark dirty so a follow-up still runs.
   */
  function schedule(
    fp: string,
    delayMs: number,
    mode: 'stand' | 'replace' | 'debounce',
  ): void {
    if (!running || lifecycle.signal.cancelled) {
      return;
    }
    const track = trackFor(fp);
    if (track.running || !online()) {
      track.dirty = true;
      return;
    }
    if (track.timer !== null) {
      const rearm =
        mode === 'replace' ||
        (mode === 'debounce' && track.debouncing);
      if (!rearm) {
        return;
      }
      track.timer.cancel();
      track.timer = null;
      track.debouncing = false;
    }
    // A live retry-after floor rewrites the wake, whichever path
    // armed it — recovery edges and write debounces stand behind the
    // peer's asked-for wait instead of firing early.
    const floor = track.notBeforeMs;
    let wakeMs = delayMs;
    if (floor !== undefined) {
      const now = safeNow();
      if (now !== null && now < floor) {
        wakeMs = Math.max(wakeMs, floor - now);
      }
    }
    const timer = new CancellationSource();
    track.timer = timer;
    track.debouncing = mode === 'debounce';
    const work = (async () => {
      const slept = await deps.clock.sleep(wakeMs, timer.signal);
      // Only OUR sleep clears the slot — a replacement armed while
      // this one was in flight must stay cancelable.
      if (track.timer === timer) {
        track.timer = null;
        track.debouncing = false;
      }
      if (!slept.ok || lifecycle.signal.cancelled) {
        return;
      }
      // The peer may have been unpaired while the wake slept — an
      // orphaned timer never fires a round on a removed track.
      if (tracks.get(fp) !== track) {
        return;
      }
      await runRound(fp);
    })();
    own(work);
  }

  async function runRound(fp: string): Promise<void> {
    // Look up — never create — the track: a peer unpaired while its
    // wake slept must not be resurrected by the orphaned timer.
    const track = tracks.get(fp);
    if (track === undefined) {
      return;
    }
    if (track.running || lifecycle.signal.cancelled || !online()) {
      track.dirty = true;
      return;
    }
    // A timer armed before a rate-limit floor landed still defers to
    // it — reschedule at the floor instead of firing inside it.
    const floor = track.notBeforeMs;
    const floorNow = safeNow();
    if (floor !== undefined && floorNow !== null && floorNow < floor) {
      schedule(fp, floor - floorNow, 'replace');
      return;
    }
    track.running = true;
    // The round runs on its own source subscribed to the lifecycle —
    // an unpair mid-round cancels the exchange instead of letting it
    // finish and schedule a follow-up for a peer that's gone.
    const round = new CancellationSource();
    const unsubscribeLifecycle = lifecycle.signal.subscribe(() => {
      round.cancel();
    });
    track.round = round;
    /** Reconnect delay when the round failed retryably. */
    let reconnectMs: number | null = null;
    /** A page-capped round that still moved entries continues once. */
    let progressed = false;
    try {
      const result = await deps.client.syncNow(fp, round.signal);
      if (result.ok) {
        track.backoffMs = reconnectBaseMs;
        // A landed round proves the peer takes traffic — any floor a
        // prior verdict set is spent.
        delete track.notBeforeMs;
      } else if (result.error.kind === 'cancelled') {
        // Our own lifecycle cancel — no verdict to schedule on.
      } else {
        warn(`sync round failed: ${result.error.kind}`);
        // 'unavailable' is non-retryable in the taxonomy, but at this
        // boundary a dial landing on nobody listening is a temporarily
        // unreachable peer, not a dead route — it earns the same
        // bounded ladder as a retryable drop.
        if (
          result.error.retryable ||
          result.error.kind === 'unavailable'
        ) {
          // Reconnect backoff: double per consecutive failure, capped.
          // A peer's retryAfterMs (rate-limit) floors the wait — the
          // ladder never schedules under what the peer asked for.
          const hint = result.error.retryAfterMs;
          reconnectMs =
            hint !== undefined && isSafeNonNegative(hint)
              ? Math.max(track.backoffMs, hint)
              : track.backoffMs;
          const hintedAt = safeNow();
          if (
            hint !== undefined &&
            isSafeNonNegative(hint) &&
            hintedAt !== null
          ) {
            track.notBeforeMs = hintedAt + hint;
          }
          track.backoffMs = Math.min(track.backoffMs * 2, reconnectMaxMs);
        } else if (
          result.error.kind === 'budget-exceeded' &&
          lastRoundMoved(fp)
        ) {
          // The page cap cut a still-moving exchange: custody persists
          // per page, so the follow-up resumes where this round left
          // off in both directions. A stalled round moved nothing —
          // no continuation, and the chain can never spin.
          progressed = true;
        }
      }
    } finally {
      unsubscribeLifecycle();
      track.round = null;
      track.running = false;
    }
    // Follow-ups only land while this very track is still installed —
    // an unpair during the round must not resurrect a schedule for
    // the removed peer.
    const stillInstalled = tracks.get(fp) === track;
    if (reconnectMs !== null) {
      // The reconnect round exports whatever accumulated, so pending
      // writes are covered by it rather than a second debounced wake.
      if (stillInstalled) {
        schedule(fp, reconnectMs, 'replace');
      }
      return;
    }
    if (progressed) {
      // The continuation drains the rest of the backlog AND whatever
      // landed mid-round — consume the flag so no third wake books.
      track.dirty = false;
      if (stillInstalled) {
        schedule(fp, debounceMs, 'replace');
      }
      return;
    }
    if (track.dirty) {
      track.dirty = false;
      if (stillInstalled) {
        schedule(fp, debounceMs, 'replace');
      }
    }
  }

  function onStatus(status: SyncClientStatus): void {
    const prevViews = views;
    views = status;
    const seen = new Set<string>();
    for (const view of status.peers) {
      seen.add(view.peer.fp);
      // A peer absent from the tracks appeared after start() — a
      // fresh pairing — and the launch fan-out never covered it;
      // its first round converges edits that predate the pair. The
      // wake rides debounce semantics: a write during the wait
      // re-arms it, and the launch fan-out preempts debounce timers
      // alone, so an armed reconnect ladder keeps standing.
      const isNew = !tracks.has(view.peer.fp);
      const track = trackFor(view.peer.fp);
      if (isNew) {
        schedule(view.peer.fp, debounceMs, 'debounce');
      }
      // Shared look-back for the verdict-freshness checks below.
      const prevPeer = prevViews?.peers.find(
        (v) => v.peer.fp === view.peer.fp,
      );
      // A completed round publishes counters and verdict together
      // on the op's drain emission, exactly once — consume that
      // identity at the first drained emission carrying it so later
      // republishes (another op's drain, a status fan-out) can
      // never re-fire it.
      const roundLanded =
        !view.syncing &&
        view.lastRound !== undefined &&
        view.lastRound !== track.seenRound;
      if (roundLanded) {
        track.seenRound = view.lastRound;
      }
      if (view.state === 'open') {
        // 'open' during a scheduler-owned round is that round's
        // intermediate dial status — syncNow publishes it before
        // the exchange resolves — so the round's own result decides
        // the ladder. Resetting here would pin every live-but-
        // failing peer to the base delay forever.
        if (!track.running) {
          if (roundLanded && view.lastError === undefined) {
            // The only 'open' that retires the floor is a drained,
            // clean completion: the client also publishes 'open' at
            // dial time, before the exchange's outcome is known, so
            // the status alone is not proof the rate-limit wait is
            // obsolete. The pending wake it armed dies with it; a
            // write debounce stands.
            track.backoffMs = reconnectBaseMs;
            if (track.notBeforeMs !== undefined) {
              delete track.notBeforeMs;
              if (track.timer !== null && !track.debouncing) {
                track.timer.cancel();
                track.timer = null;
              }
            }
          } else if (roundLanded && view.lastError !== undefined) {
            // The landed round FAILED — its verdict may carry a
            // rate-limit. It landed once (consumed above), so a
            // republished status cannot slide the floor it sets.
            const hint = view.lastError.retryAfterMs;
            const now = safeNow();
            if (
              hint !== undefined &&
              isSafeNonNegative(hint) &&
              now !== null
            ) {
              track.notBeforeMs = now + hint;
            }
            // A page-capped landing that still moved entries has
            // more to exchange. Scheduler-owned rounds chain the
            // continuation in runRound; a kicked or manual one
            // surfaces only here. A stalled cap moved nothing —
            // no continuation, and the chain can never spin.
            if (
              view.lastError.kind === 'budget-exceeded' &&
              lastRoundMoved(view.peer.fp)
            ) {
              schedule(view.peer.fp, debounceMs, 'replace');
            }
          }
        }
        if (track.dirty && !track.running) {
          track.dirty = false;
          schedule(view.peer.fp, debounceMs, 'replace');
        }
      } else if (
        view.state === 'offline' &&
        view.lastError !== undefined &&
        (view.lastError.retryable ||
          view.lastError.kind === 'unavailable') &&
        !track.running &&
        track.timer === null
      ) {
        // A session the client dropped (dead socket, keepalive miss)
        // or a dial that found nobody listening reconnects on the
        // backoff ladder — a carried retryAfterMs floors the wait,
        // while non-transport verdicts (auth-required, peer revoked)
        // wait for the peer list to change instead of hammering a
        // dead route.
        const hint = view.lastError.retryAfterMs;
        // The floor is absolute and set only by a FRESH verdict — an
        // unchanged offline lastError republished by some other
        // peer's status emission must not slide it later. Republish
        // re-arms wait out the floor's remainder, not a new hint.
        const prevOffline =
          prevPeer !== undefined && prevPeer.state === 'offline'
            ? prevPeer.lastError
            : undefined;
        const now = safeNow();
        if (
          hint !== undefined &&
          isSafeNonNegative(hint) &&
          now !== null &&
          (prevOffline === undefined ||
            prevOffline.kind !== view.lastError.kind ||
            prevOffline.retryAfterMs !== hint)
        ) {
          track.notBeforeMs = now + hint;
        }
        const floorWait =
          track.notBeforeMs !== undefined &&
            now !== null &&
            track.notBeforeMs > now
            ? track.notBeforeMs - now
            : 0;
        const wait = Math.max(track.backoffMs, floorWait);
        track.backoffMs = Math.min(track.backoffMs * 2, reconnectMaxMs);
        schedule(view.peer.fp, wait, 'stand');
      } else if (
        view.state === 'offline' &&
        view.lastError === undefined &&
        !track.running &&
        track.timer === null &&
        prevViews?.peers.find((v) => v.peer.fp === view.peer.fp)
          ?.state === 'open'
      ) {
        // A clean socket close publishes offline with no verdict at
        // all — the peer was live a moment ago, so it earns the same
        // bounded ladder instead of waiting silently for the next
        // local write or connectivity flap.
        const wait = track.backoffMs;
        track.backoffMs = Math.min(track.backoffMs * 2, reconnectMaxMs);
        schedule(view.peer.fp, wait, 'stand');
      }
    }
    // An unpaired peer drops its track — pending timers and any
    // in-flight round die with it.
    for (const [fp, track] of [...tracks]) {
      if (!seen.has(fp)) {
        track.timer?.cancel();
        track.round?.cancel();
        tracks.delete(fp);
      }
    }
  }

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      // A fresh source: start() after stop() re-arms instead of
      // inheriting a cancelled lifecycle that dead-arms schedule().
      lifecycle = new CancellationSource();
      unsubscribe = deps.client.subscribe(onStatus);
      views = deps.client.status();
      for (const view of views.peers) {
        const track = trackFor(view.peer.fp);
        // Any lastRound already on the view was published by its
        // landing emission — which fired before this subscription
        // existed — so it's already-consumed history. Seeding keeps
        // a republished status from re-firing its verdict (an old
        // rate-limit would otherwise slide its floor to now+hint on
        // the first unrelated emission). A round still in flight is
        // unaffected: its counters publish only at drain, so the
        // snapshot can't see them and the landing still counts.
        if (track.seenRound === undefined && view.lastRound !== undefined) {
          track.seenRound = view.lastRound;
        }
      }
      // On-launch round per known peer — the custody read is the
      // source of truth for devices that predate this status view.
      own(
        deps.client
          .peers(lifecycle.signal)
          .then((peers) => {
            if (!peers.ok || lifecycle.signal.cancelled) {
              return;
            }
            for (const peer of peers.value) {
              // Preempt only hydration debounces: while peers() was
              // resolving, a refresh emit may already have armed this
              // peer's first-round write wake — the launch round
              // supersedes it. A reconnect ladder or other one-shot
              // wake armed in the same window keeps standing (and
              // schedule()'s clamp still honors a live rate-limit).
              const track = trackFor(peer.fp);
              schedule(
                peer.fp,
                0,
                track.debouncing ? 'replace' : 'stand',
              );
            }
          })
          .then(
            () => undefined,
            () => undefined,
          ),
      );
    },

    notifyLocalWrites(): void {
      if (views === null) {
        return;
      }
      for (const view of views.peers) {
        // Trailing edge: each write re-arms the wake — a burst
        // converges in one round once it goes quiet.
        schedule(view.peer.fp, debounceMs, 'debounce');
      }
    },

    notifyConnectivity(isOnline: boolean): void {
      if (isOnline) {
        // Recovery edge: reset every ladder and converge now —
        // peers with pending work fire immediately, the rest get a
        // round anyway since a dropped session's last writes may
        // never have landed.
        for (const [fp, track] of tracks) {
          track.backoffMs = reconnectBaseMs;
          if (!track.running) {
            // The immediate round exports everything the flag stood
            // for — consume it so a successful round doesn't book a
            // redundant second pass. schedule() re-marks dirty if
            // the online read races back down.
            track.dirty = false;
            schedule(fp, 0, 'replace');
          } else {
            track.dirty = true;
          }
        }
        return;
      }
      // Offline: pending rounds would only fail against a dead
      // network — cancel the timers; the dirty flags stay so the
      // recovery edge still converges.
      for (const track of tracks.values()) {
        if (track.timer !== null) {
          track.timer.cancel();
          track.timer = null;
          track.debouncing = false;
          track.dirty = true;
        }
      }
    },

    stop(): void {
      running = false;
      unsubscribe?.();
      unsubscribe = null;
      lifecycle.cancel();
      for (const track of tracks.values()) {
        track.timer?.cancel();
        track.timer = null;
        track.debouncing = false;
      }
    },
  };
}
